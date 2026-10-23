// stats.js 

'use strict';

const LAGOS_TZ = 'Africa/Lagos';

// Whitelisted params per documented route.
// - keys: params we ever record for this route (others are ignored).
// - enumVals: params whose VALUES we keep (tier, event, sort, order, byseries, byevent).
//   The rest are recorded as KEY-ONLY so free-text like "search=naruto" doesn't explode cardinality.
const ROUTE_PARAMS = {
  '/api/random':    { keys: ['tier', 'search', 'q', 'series', 'anime'],
                      enumVals: ['tier'] },
  '/api/series':    { keys: ['event'],
                      enumVals: ['event'] },
  '/api/cards':     { keys: ['page', 'limit', 'tier', 'search', 'q', 'series', 'anime',
                              'sort', 'order', 'byseries'],
                      enumVals: ['tier', 'sort', 'order', 'byseries'] },
  '/api/events':    { keys: ['page', 'limit', 'event', 'tier', 'search', 'q', 'series', 'anime',
                              'sort', 'order', 'byevent'],
                      enumVals: ['event', 'tier', 'sort', 'order', 'byevent'] },
  '/api/stats':     { keys: ['daily', 'weekly', 'monthly', 'endpoint', 'method', 'from', 'to',
                              'success', 'failed', 'top'],
                      enumVals: ['method'] },
  '/api/stats/recent': { keys: ['limit'], enumVals: [] },
  '/api/status':    { keys: [], enumVals: [] },
  '/api/endpoints': { keys: [], enumVals: [] },
  '/api/endpoint':  { keys: [], enumVals: [] },
};

const SKIP_PATHS = new Set(['/api/health', '/ping']);
const MAX_PENDING_BUCKETS = 2000;
const FLUSH_MS = 60_000;
const PRUNE_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------- Lagos-time helpers (independent copy, no circular dep) ----------

function lagosCalendar(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LAGOS_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const o = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const day = `${o.year}-${o.month}-${o.day}`;
  const month = `${o.year}-${o.month}`;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[o.weekday] ?? 0;
  const sundayUtc = new Date(Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day) - dow));
  const week = sundayUtc.toISOString().slice(0, 10);
  return { day, week, month };
}

// ---------- Param signature builder ----------

function buildParamSig(query, routeInfo) {
  if (!routeInfo) return '';
  const parts = [];
  const sortedKeys = Object.keys(query || {}).sort();
  for (const key of sortedKeys) {
    if (!routeInfo.keys.includes(key)) continue;
    if (routeInfo.enumVals.includes(key)) {
      parts.push(`${key}=${String(query[key]).slice(0, 50)}`);
    } else {
      parts.push(key);
    }
  }
  return parts.join(',');
}

// ---------- Stored-data safety helpers ----------

// Never store or return credential-like query parameters. Historical rows may
// contain a URL accidentally stored as a path by an older deployment, so scrub
// those too before returning analytics to clients.
const SENSITIVE_QUERY_KEYS = new Set([
  'key', 'api_key', 'apikey', 'token', 'access_token', 'refresh_token',
  'authorization', 'auth', 'secret', 'password', 'client_secret',
]);

function safePath(value) {
  const raw = String(value || '');
  const sensitiveSuffix = /[?&](?:key|api_key|apikey|token|access_token|refresh_token|authorization|auth|secret|password|client_secret)=/i;
  const match = sensitiveSuffix.exec(raw);
  if (match) return raw.slice(0, match.index);
  return raw.split('?', 1)[0];
}

function safeParamSig(value) {
  return String(value || '')
    .split(',')
    .filter(Boolean)
    .filter(part => {
      const key = part.split('=', 1)[0].trim().toLowerCase();
      return key && !SENSITIVE_QUERY_KEYS.has(key);
    })
    .join(',');
}

function sanitizeStatsRow(row) {
  return { ...row, path: safePath(row.path), param_sig: safeParamSig(row.param_sig) };
}

function isExcludedAnalyticsPath(path) {
  return path === '/api/health' || path === '/ping' ||
    path === '/api/admin' || path.startsWith('/api/admin/') ||
    path === '/api/internal' || path.startsWith('/api/internal/');
}

// ---------- Main factory ----------

function createStatsTracker({ getSupabase, logger }) {
  const deltas = new Map();       // key -> bucket
  let flushTimer = null;
  let pruneTimer = null;
  let flushing = false;

  const state = {
    pendingBuckets: 0,
    lastFlushAt: null,
    lastFlushOk: null,
    lastFlushError: null,
    lastFlushCount: 0,
    prune: {
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastDeleted: 0,
    },
  };

  function bucketKey(b) {
    return `${b.day}|${b.method}|${b.path}|${b.param_sig}`;
  }

  // ---------- Middleware: records after response finishes ----------

  function middleware(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    if (SKIP_PATHS.has(req.path)) return next();
    // Administrative and internal endpoints can contain sensitive operational data.
    if (req.path === '/api/admin' || req.path.startsWith('/api/admin/') ||
        req.path === '/api/internal' || req.path.startsWith('/api/internal/')) return next();
    const ua = req.get('user-agent') || '';
    if (/ZCard-Control-Room-self-ping/i.test(ua)) return next();

    const start = Date.now();
    res.on('finish', () => {
      try { record(req, res, Date.now() - start); }
      catch (e) { /* never break the response */ }
    });
    next();
  }

  function record(req, res, ms) {
    const routeInfo = ROUTE_PARAMS[req.path];
    const path = req.path;
    const paramSig = routeInfo ? buildParamSig(req.query || {}, routeInfo) : '';
    const cal = lagosCalendar();
    const method = req.method;
    const status = res.statusCode;
    const okN = status < 400 ? 1 : 0;
    const errN = status >= 400 ? 1 : 0;

    const key = `${cal.day}|${method}|${path}|${paramSig}`;
    const existing = deltas.get(key);
    if (existing) {
      existing.total += 1;
      existing.ok += okN;
      existing.err += errN;
      existing.ms_sum += ms;
      existing.ms_max = Math.max(existing.ms_max, ms);
      existing.day = cal.day;
      existing.week = cal.week;
      existing.month = cal.month;
    } else {
      if (deltas.size >= MAX_PENDING_BUCKETS) {
        const oldest = deltas.keys().next().value;
        deltas.delete(oldest);
        if (logger) logger.log('WARN', 'stats', 'Delta buffer overflow; oldest bucket evicted');
      }
      deltas.set(key, {
        day: cal.day, week: cal.week, month: cal.month,
        method, path, param_sig: paramSig,
        total: 1, ok: okN, err: errN,
        ms_sum: ms, ms_max: ms,
      });
    }
    state.pendingBuckets = deltas.size;
  }

  // ---------- Flush deltas into Supabase (atomic via RPC) ----------

  async function flush() {
    if (flushing || deltas.size === 0) return;
    const sb = getSupabase();
    if (!sb) return;

    flushing = true;
    const batch = Array.from(deltas.values());
    const size = deltas.size;
    deltas.clear();

    try {
      const { error } = await sb.rpc('bump_endpoint_stats', { batch });
      if (error) throw error;
      state.lastFlushAt = new Date().toISOString();
      state.lastFlushOk = true;
      state.lastFlushError = null;
      state.lastFlushCount = size;
      state.pendingBuckets = deltas.size;
      if (logger) logger.log('INFO', 'stats', 'Flushed stats buckets', { count: size });
    } catch (e) {
      // Re-merge batch back into deltas so counts aren't lost
      for (const row of batch) {
        const k = bucketKey(row);
        const ex = deltas.get(k);
        if (ex) {
          ex.total += row.total; ex.ok += row.ok; ex.err += row.err;
          ex.ms_sum += row.ms_sum; ex.ms_max = Math.max(ex.ms_max, row.ms_max);
          ex.day = row.day; ex.week = row.week; ex.month = row.month;
        } else {
          deltas.set(k, row);
        }
      }
      state.lastFlushAt = new Date().toISOString();
      state.lastFlushOk = false;
      state.lastFlushError = e?.message || String(e);
      state.pendingBuckets = deltas.size;
      if (logger) logger.log('WARN', 'stats', 'Flush failed; will retry next cycle',
        { error: state.lastFlushError, restored: batch.length });
    } finally {
      flushing = false;
    }
  }

  // ---------- 3-month rolling prune (Lagos calendar months) ----------

  async function prune() {
    const sb = getSupabase();
    if (!sb) return;
    state.prune.lastRunAt = new Date().toISOString();

    const cal = lagosCalendar();
    const [yStr, mStr] = cal.month.split('-');
    let year = Number(yStr);
    let monthNum = Number(mStr) - 2;
    while (monthNum <= 0) { monthNum += 12; year -= 1; }
    const cutoffDay = `${year}-${String(monthNum).padStart(2, '0')}-01`;

    try {
      const { error, count } = await sb
        .from('endpoint_stats')
        .delete()
        .lt('day', cutoffDay);
      if (error) throw error;
      state.prune.lastSuccessAt = new Date().toISOString();
      state.prune.lastError = null;
      state.prune.lastDeleted = count || 0;
      if (logger) logger.log('INFO', 'stats', 'Pruned old stats rows',
        { cutoff: cutoffDay, deleted: count || 0 });
    } catch (e) {
      state.prune.lastError = e?.message || String(e);
      if (logger) logger.log('WARN', 'stats', 'Prune failed', { error: state.prune.lastError });
    }
  }

  // ---------- Public /api/stats read handler ----------

  async function handler(req, res) {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ ok: false, error: 'Stats unavailable' });

    const q = req.query || {};
    const wantDaily   = q.daily   === 'true' || q.daily   === '1';
    const wantWeekly  = q.weekly  === 'true' || q.weekly  === '1';
    const wantMonthly = q.monthly === 'true' || q.monthly === '1';
    const wantAll = !wantDaily && !wantWeekly && !wantMonthly;

    const endpoint = q.endpoint ? String(q.endpoint) : null;
    const method   = q.method   ? String(q.method).toUpperCase() : null;
    const successOnly = q.success === 'true' || q.success === '1';
    const failedOnly  = q.failed  === 'true' || q.failed  === '1';
    const topN = q.top ? Math.min(500, Math.max(1, Number(q.top) || 0)) : null;

    try {
      const PAGE_SIZE = 1000;
      const data = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        let pageQuery = sb.from('endpoint_stats').select(
          'day, week, month, method, path, param_sig, total, ok, err, ms_sum, ms_max'
        ).range(offset, offset + PAGE_SIZE - 1);
        if (method) pageQuery = pageQuery.eq('method', method);
        // If endpoint is just a path (no '?'), filter in the database.
        if (endpoint && !endpoint.includes('?')) pageQuery = pageQuery.eq('path', endpoint);
        const { data: page, error } = await pageQuery;
        if (error) throw error;
        data.push(...(page || []));
        if (!page || page.length < PAGE_SIZE) break;
      }

      let rows = (data || []).map(sanitizeStatsRow).filter(row => !isExcludedAnalyticsPath(row.path));

      // Post-filter if endpoint contained a query string
      if (endpoint && endpoint.includes('?')) {
        const [pathPart, queryPart] = endpoint.split('?');
        const targetParams = new URLSearchParams(queryPart);
        const routeInfo = ROUTE_PARAMS[pathPart];
        if (routeInfo) {
          rows = rows.filter(row => {
            if (row.path !== pathPart) return false;
            const sigParts = row.param_sig ? row.param_sig.split(',').filter(Boolean) : [];
            const sigMap = {}; const sigKeys = new Set();
            for (const part of sigParts) {
              const eq = part.indexOf('=');
              if (eq >= 0) sigMap[part.slice(0, eq)] = part.slice(eq + 1);
              else sigKeys.add(part);
            }
            for (const [k, v] of targetParams.entries()) {
              if (!routeInfo.keys.includes(k)) continue;
              if (routeInfo.enumVals.includes(k)) {
                if (sigMap[k] !== v) return false;
              } else {
                if (!sigKeys.has(k)) return false;
              }
            }
            return true;
          });
        } else {
          rows = rows.filter(r => r.path === pathPart);
        }
      }

      function aggregate(grainKey) {
        const buckets = new Map();
        for (const row of rows) {
          const g = row[grainKey];
          const fullKey = `${g}::${row.method}::${row.path}::${row.param_sig}`;
          const ex = buckets.get(fullKey);
          if (ex) {
            ex.total += row.total; ex.ok += row.ok; ex.err += row.err;
            ex.ms_sum += row.ms_sum; ex.ms_max = Math.max(ex.ms_max, row.ms_max);
          } else {
            buckets.set(fullKey, {
              grain: g,
              method: row.method,
              path: row.path,
              param_sig: row.param_sig,
              total: row.total, ok: row.ok, err: row.err,
              ms_sum: row.ms_sum, ms_max: row.ms_max,
            });
          }
        }
        let arr = Array.from(buckets.values()).map(b => ({
          grain: b.grain,
          method: b.method,
          path: b.path,
          param_sig: b.param_sig,
          total: b.total,
          ok: b.ok,
          err: b.err,
          avg_time: b.total > 0 ? `${Math.round(b.ms_sum / b.total)} ms` : '0 ms',
          max_time: `${b.ms_max} ms`,
        }));
        if (successOnly) arr = arr.map(b => ({ ...b, total: b.ok }));
        else if (failedOnly) arr = arr.map(b => ({ ...b, total: b.err }));
        arr.sort((a, b) => b.total - a.total);
        if (topN) arr = arr.slice(0, topN);
        return arr;
      }

      // Calculate summary totals
      const today = lagosCalendar().day;
      const currentWeek = lagosCalendar().week;
      const currentMonth = lagosCalendar().month;

      const totalToday = rows.filter(r => r.day === today).reduce((sum, r) => sum + r.total, 0);
      const totalThisWeek = rows.filter(r => r.week === currentWeek).reduce((sum, r) => sum + r.total, 0);
      const totalThisMonth = rows.filter(r => r.month === currentMonth).reduce((sum, r) => sum + r.total, 0);

      // Calculate last N weeks/months totals
      const getLastNWeeksTotal = (n) => {
        const d = new Date();
        d.setDate(d.getDate() - (n * 7));
        const cal = lagosCalendar(d);
        return rows.filter(r => r.week === cal.week).reduce((sum, r) => sum + r.total, 0);
      };

      const getLastNMonthsTotal = (n) => {
        const d = new Date();
        d.setMonth(d.getMonth() - n);
        const cal = lagosCalendar(d);
        return rows.filter(r => r.month === cal.month).reduce((sum, r) => sum + r.total, 0);
      };

      const result = {
        ok: true,
        summary: {
          today: totalToday,
          this_week: totalThisWeek,
          last_2_weeks: getLastNWeeksTotal(2),
          last_3_weeks: getLastNWeeksTotal(3),
          this_month: totalThisMonth,
          last_month: getLastNMonthsTotal(1),
          last_2_months: getLastNMonthsTotal(2),
          last_3_months: getLastNMonthsTotal(3),
        },
        window: { months: 3, timezone: LAGOS_TZ },
        filters: {
          endpoint: endpoint ? safePath(endpoint) : null,
          method: method || null,
          success: successOnly,
          failed: failedOnly,
          top: topN || null,
        },
        generatedAt: new Date().toISOString(),
        details_below: 'Use daily, weekly, or monthly params to see detailed breakdown',
      };
      if (wantAll || wantDaily)   result.daily   = aggregate('day');
      if (wantAll || wantWeekly)  result.weekly  = aggregate('week');
      if (wantAll || wantMonthly) result.monthly = aggregate('month');

      return res.json(result);
    } catch (e) {
      const msg = e?.message || String(e);
      if (logger) logger.log('ERROR', 'stats', 'Stats query failed', { error: msg });
      return res.status(502).json({ ok: false, error: 'Stats query failed', details: msg });
    }
  }


  // ---------- GET /api/stats/recent ----------
  // Returns recent daily aggregate rows, not individual request-by-request logs.

  async function recentHandler(req, res) {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ ok: false, error: 'Stats unavailable' });

    let limit = 50;
    if (req.query?.limit !== undefined) {
      const parsedLimit = Number(req.query.limit);
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
        return res.status(400).json({
          ok: false,
          error: 'limit must be an integer between 1 and 500',
        });
      }
      limit = parsedLimit;
    }

    try {
      const { data, error } = await sb
        .from('endpoint_stats')
        .select('day, week, month, method, path, param_sig, total, ok, err, ms_sum, ms_max')
        .not('path', 'like', '/api/admin%')
        .not('path', 'like', '/api/internal%')
        .order('day', { ascending: false })
        .order('total', { ascending: false })
        .limit(limit + 1);

      if (error) throw error;

      const rows = (data || []).map(sanitizeStatsRow).filter(row => !isExcludedAnalyticsPath(row.path));
      const hasMore = rows.length > limit;
      const recent = rows.slice(0, limit).map(row => ({
        ...row,
        avg_time: row.total > 0 ? `${Math.round(row.ms_sum / row.total)} ms` : '0 ms',
        max_time: `${row.ms_max} ms`,
      }));

      return res.json({
        ok: true,
        limit,
        count: recent.length,
        hasMore,
        window: { months: 3, timezone: LAGOS_TZ },
        generatedAt: new Date().toISOString(),
        recent,
      });
    } catch (error) {
      const msg = error?.message || String(error);
      if (logger) logger.log('ERROR', 'stats', 'Recent stats query failed', { error: msg });
      return res.status(502).json({
        ok: false,
        error: 'Recent stats query failed',
        details: msg,
      });
    }
  }

  // ---------- Lifecycle ----------

  function start() {
    flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
    pruneTimer = setInterval(() => { prune().catch(() => {}); }, PRUNE_MS);
    if (pruneTimer.unref) pruneTimer.unref();
    setImmediate(() => { prune().catch(() => {}); });
    setTimeout(() => { flush().catch(() => {}); }, 10_000);
  }

  async function stop() {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
    try { await flush(); } catch (e) { /* best-effort */ }
  }

  function snapshot() {
    return {
      pendingBuckets: deltas.size,
      flush: {
        intervalMs: FLUSH_MS,
        lastAt: state.lastFlushAt,
        lastOk: state.lastFlushOk,
        lastCount: state.lastFlushCount,
        lastError: state.lastFlushError,
      },
      prune: {
        intervalMs: PRUNE_MS,
        windowMonths: 3,
        lastRunAt: state.prune.lastRunAt,
        lastSuccessAt: state.prune.lastSuccessAt,
        lastError: state.prune.lastError,
        lastDeleted: state.prune.lastDeleted,
      },
    };
  }

  return {
    middleware,
    handler,
    recentHandler,
    start,
    stop,
    flushNow: flush,
    snapshot,
  };
}

module.exports = { createStatsTracker };


