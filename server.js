// server.js
'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { ShoobCardScraper } = require('./cards.js');
const { ShoobEventScraper, groupCardsByEvent } = require('./events.js');
const logger = require('./logger.js');

const app = express();

app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const MONITOR_MS = 10_000;
const SCHEDULER_POLL_MS = 10_000;
const SHOOB_CHECK_MS = 60 * 60 * 1000;
const SELF_PING_MS = 14 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_CLEANUP_MS = 6 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 500;
const LAGOS_TIME_ZONE = 'Africa/Lagos';
const LOG_TABLE = 'system_logs';

app.disable('x-powered-by');
app.set('json spaces', 2);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let supabase = null;
let supabaseConfigured = false;

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
  supabaseConfigured = true;
} else {
  logger.log('WARN', 'startup', 'Supabase environment variables are not configured');
}

const state = {
  startedAt: new Date().toISOString(),
  lastMonitorAt: null,
  lastMonitorOk: null,
  supabaseReachable: false,
  supabaseConfigured,
  supabaseError: null,
  nextSourceCheckAt: null,
  lastSourceCheckAt: null,
  cards: {
    isScraping: false,
    startedAt: null,
    finishedAt: null,
    count: 0,
    expected: null,
    sourceTotal: null,
    countsMatch: null,
    lastDelta: 0,
    error: null,
    lastSyncAt: null,
    storage: 'unknown',
  },
  events: {
    isScraping: false,
    startedAt: null,
    finishedAt: null,
    count: 0,
    expected: null,
    sourceTotal: null,
    countsMatch: null,
    lastDelta: 0,
    error: null,
    lastSyncAt: null,
    storage: 'unknown',
    menuChecked: null,
    menuError: null,
    unknownEvents: [],
  },
  scheduler: {
    timeZone: LAGOS_TIME_ZONE,
    lastSlotAttempted: null,
    lastSlotSucceeded: null,
    lastCheckStatus: 'waiting',
    lastCheckError: null,
    retryAt: null,
  },
  selfPing: {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  },
  retention: {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    systemLogsDeleted: 0,
    syncRunsDeleted: 0,
  },
};

let memoryCards = null;
let memoryEventCards = null;
let syncPromise = null;
const encoder = new TextEncoder();

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function suppliedAdminKey(req) {
  const auth = req.get('authorization') || '';
  return (
    req.get('x-admin-key') ||
    (auth.startsWith('Bearer ') ? auth.slice(7) : '') ||
    req.body?.adminKey ||
    ''
  );
}

function isAdmin(req) {
  const configured = process.env.ADMIN_KEY;
  if (!configured) return false;
  return safeEqual(suppliedAdminKey(req), configured);
}

function getIpDiagnostics(req) {
  const rawForwardedFor = req.get('x-forwarded-for');
  const forwardedChain =
    typeof rawForwardedFor === 'string'
      ? rawForwardedFor.split(',').map(ip => ip.trim()).filter(Boolean)
      : [];

  return {
    expressIp: req.ip || null,
    socketAddress: req.socket?.remoteAddress || null,
    forwardedFor: forwardedChain.length ? forwardedChain.join(', ') : null,
    User_Ip_Address: forwardedChain[0] || null,
    cloudflareConnectingIp: req.get('cf-connecting-ip') || null,
  };
}

// ============================================================================
// HELPER FUNCTIONS FOR UPTIME & TIMESTAMPS
// ============================================================================

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const daysStr = (d === 0 || d === 1) ? 'day' : 'days';
  const hoursStr = (h === 0 || h === 1) ? 'hour' : 'hours';
  const minsStr = (m === 0 || m === 1) ? 'min' : 'mins';
  const secsStr = (s === 0 || s === 1) ? 'sec' : 'secs';

  return `${d} ${daysStr} ${h} ${hoursStr} ${m} ${minsStr} ${s} ${secsStr}`;
}

function getTimestamps(date = new Date()) {
  return {
    utc: date.toISOString(),
    lagos: date.toLocaleString('en-GB', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }) + ' WAT'
  };
}

// ============================================================================
// PUBLIC CATALOG HELPER FUNCTIONS
// ============================================================================

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function cleanSearchTerm(value, maxLength = 80) {
  if (value === undefined || value === null) return '';
  return String(value)
    .trim()
    .replace(/[,()*!]/g, '') // Remove PostgREST reserved operators
    .replace(/[\u0000-\u001f\u007f]/g, '') // Remove control characters
    .slice(0, maxLength)
    .trim();
}

function getSearchFilters(req) {
  return {
    tier: req.query.tier ? String(req.query.tier).trim().slice(0, 30) : '',
    series: cleanSearchTerm(req.query.series || req.query.anime, 100),
    search: cleanSearchTerm(req.query.search || req.query.q, 80), // 'search' and 'q' are aliases
  };
}

function applyCardFilters(query, filters) {
  if (filters.tier) {
    query = query.eq('tier', filters.tier);
  }
  if (filters.series) {
    query = query.ilike('series', `%${filters.series}%`);
  }
  if (filters.search) {
    // Escape literal % characters to prevent PostgREST syntax errors
    const safeSearch = filters.search.replace(/%/g, '\\%');
    query = query.or(`name.ilike.%${safeSearch}%,series.ilike.%${safeSearch}%`);
  }
  return query;
}

function applySort(query, rawSort, rawOrder, allowedColumns) {
  const sort = allowedColumns.includes(String(rawSort)) ? String(rawSort) : 'name';
  const order = String(rawOrder || 'asc').toLowerCase();
  const ascending = order !== 'desc';

  // Primary sort + stable secondary sort by id to prevent page shifting
  return query.order(sort, { ascending }).order('id', { ascending: true });
}

async function getUniqueCounts(table, column, applyFilters, includeBreakdown) {
  // Exact filtered count first (head query, no rows transferred)
  const { count, error: countError } = await applyFilters(
    supabase.from(table).select(column, { count: 'exact', head: true })
  );
  if (countError) throw countError;

  // Zero matches: correct data, not an error. Never call .range() on empty sets.
  if (count === 0) {
    return {
      uniqueCount: 0,
      breakdown: includeBreakdown ? {} : null
    };
  }

  const batchSize = 1000;
  const uniqueSet = new Set();
  const breakdown = includeBreakdown ? Object.create(null) : null;

  for (let start = 0; ; start += batchSize) {
    let query = supabase.from(table).select(column);
    query = applyFilters(query);
    const { data, error } = await query.range(start, start + batchSize - 1);
    if (error) throw error;

    const rows = data || [];
    for (const row of rows) {
      const value = String(row[column] || 'Unknown');
      uniqueSet.add(value);
      if (includeBreakdown) {
        breakdown[value] = (breakdown[value] || 0) + 1;
      }
    }
    if (rows.length < batchSize) break;
  }

  return {
    uniqueCount: uniqueSet.size,
    breakdown
  };
}

// ============================================================================

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY) {
    return res.status(503).json({ ok: false, error: 'Admin access is not configured. Set ADMIN_KEY in Render environment variables.' });
  }
  if (!isAdmin(req)) {
    logger.log('WARN', 'security', 'Rejected unauthenticated admin request', { path: req.path, ...getIpDiagnostics(req) });
    return res.status(401).json({ ok: false, error: 'Admin authentication required' });
  }
  next();
}

function requireInternalOrAdmin(req, res, next) {
  const internal = process.env.INTERNAL_API_KEY;
  if (internal && safeEqual(req.get('x-internal-key') || '', internal)) return next();
  return requireAdmin(req, res, next);
}

function rowsForCards(cards) {
  return cards.map(c => ({
    id: String(c.id),
    name: String(c.name || 'Unknown'),
    tier: c.tier == null ? null : String(c.tier),
    series: c.series || '',
    image_url: c.image_url || null,
    author: c.author || 'Anonymous',
    author_link: c.author_link || 'Hidden',
    synced_at: new Date().toISOString(),
  }));
}

function rowsForEvents(cards) {
  return cards.map(c => ({
    ...rowsForCards([c])[0],
    event_slug: String(c.event || c.event_slug || 'unknown'),
  }));
}

async function upsertBatches(table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + size), { onConflict: 'id' });
    if (error) throw error;
    logger.log('INFO', 'supabase', 'Database batch upserted', {
      table,
      batch: Math.floor(i / size) + 1,
      batchSize: Math.min(size, rows.length - i),
    });
  }
}

async function saveStorage(filename, value) {
  const body = JSON.stringify(value, null, 2) + '\n';
  const { error } = await supabase.storage
    .from(process.env.SUPABASE_STORAGE_BUCKET || 'shoob-catalogs')
    .upload(filename, encoder.encode(body), {
      contentType: 'application/json; charset=utf-8',
      upsert: true,
      cacheControl: '60',
    });
  if (error) throw error;
}

async function saveCatalogState(catalog, count, status, error = null, metadata = {}) {
  const storagePath = catalog === 'cards' ? 'cards.json' : 'events.json';
  const row = {
    catalog,
    record_count: count,
    storage_path: storagePath,
    last_checked_at: new Date().toISOString(),
    last_synced_at: status === 'ready' ? new Date().toISOString() : undefined,
    last_error: error ? String(error).slice(0, 1000) : null,
    status,
    metadata,
  };
  const { error: dbError } = await supabase.from('catalog_state').upsert(row, { onConflict: 'catalog' });
  if (dbError) throw dbError;
}

async function recordLog(entry) {
  if (!supabase) return;
  const { error } = await supabase.from(LOG_TABLE).upsert(
    {
      id: entry.id,
      timestamp: entry.timestamp,
      level: entry.level,
      component: entry.component,
      message: entry.message,
      details: entry.details,
    },
    { onConflict: 'id' }
  );
  if (error && !/does not exist|schema cache/i.test(error.message || '')) {
    console.warn('[logger persistence]', error.message);
  }
}

logger.setLogPersistence(recordLog);

async function countRows(table, filters = []) {
  let q = supabase.from(table).select('id', { count: 'exact', head: true });
  for (const [column, value] of filters) {
    q = q.eq(column, value);
  }
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

async function readAllRows(table, columns = '*') {
  const all = [];
  const pageSize = 1000;
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await supabase.from(table).select(columns).range(start, start + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function recordNoopRun(catalog, trigger, sourceTotal, dbCount, metadata = {}) {
  const { error } = await supabase.from('sync_runs').insert({
    catalog,
    trigger,
    status: 'success',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    records_found: sourceTotal,
    records_added: 0,
    metadata: { mode: 'count-match-noop', databaseCount: dbCount, sourceCount: sourceTotal, ...metadata },
  });
  if (error) throw error;
}

async function rebuildMainStorage() {
  const rows = await readAllRows('cards');
  await saveStorage('cards.json', rows.map(r => ({
    id: String(r.id), name: r.name, tier: r.tier, series: r.series || '', image_url: r.image_url, author: r.author, author_link: r.author_link,
  })));
  state.cards.storage = 'available';
}

async function rebuildEventStorage() {
  const rows = await readAllRows('event_cards');
  const grouped = {};
  for (const row of rows) {
    const slug = String(row.event_slug || 'unknown');
    if (!grouped[slug]) grouped[slug] = [];
    grouped[slug].push({
      id: String(row.id), name: row.name, tier: row.tier, series: row.series || '', event: slug, image_url: row.image_url, author: row.author, author_link: row.author_link,
    });
  }
  await saveStorage('events.json', grouped);
  state.events.storage = 'available';
}

async function syncMain(cards, trigger, sourceTotal = null) {
  if (!supabase) throw new Error('Supabase is not configured');
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('No missing main cards were discovered; refusing an empty write');

  const unique = new Map(cards.map(c => [String(c.id), c]));
  if (unique.size !== cards.length) {
    logger.log('WARN', 'sync', 'Duplicate IDs found in missing-card scan; deduplicated', { input: cards.length, unique: unique.size });
  }
  const clean = [...unique.values()];

  const run = await supabase.from('sync_runs').insert({
    catalog: 'cards', trigger, status: 'running', records_found: sourceTotal ?? clean.length, records_added: clean.length, metadata: { mode: 'incremental', missingFound: clean.length },
  }).select('id').single();

  if (run.error) throw run.error;

  try {
    await upsertBatches('cards', rowsForCards(clean));
    const dbCount = await countRows('cards');
    await rebuildMainStorage();
    await saveCatalogState('cards', dbCount, 'ready', null, { trigger, sourceTotal, mode: 'incremental', recordsAdded: clean.length });

    const { error: runError } = await supabase.from('sync_runs').update({
      status: 'success', finished_at: new Date().toISOString(), records_found: sourceTotal ?? dbCount, records_added: clean.length,
      metadata: { mode: 'incremental', databaseCount: dbCount, sourceCount: sourceTotal, missingAdded: clean.length },
    }).eq('id', run.data.id);

    if (runError) throw runError;

    state.cards.count = dbCount;
    state.cards.lastSyncAt = new Date().toISOString();
    state.cards.storage = 'available';
    state.cards.error = null;
    state.cards.lastDelta = clean.length;
    state.cards.sourceTotal = sourceTotal;
    state.cards.countsMatch = sourceTotal == null ? null : dbCount === sourceTotal;

    logger.log('SUCCESS', 'sync', 'Incremental main catalog repair completed', { databaseCount: dbCount, sourceTotal, added: clean.length, trigger });
  } catch (e) {
    await supabase.from('sync_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: String(e.message || e) }).eq('id', run.data.id);
    throw e;
  }
}

async function syncEvents(cards, trigger, scraper = null, sourceTotal = null) {
  if (!supabase) throw new Error('Supabase is not configured');
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('No missing event cards were discovered; refusing an empty write');
  if (scraper && scraper.menuChecked === false) throw new Error(`Event menu preflight failed: ${scraper.menuError || 'unknown error'}`);

  const unique = new Map(cards.map(c => [`${String(c.event || c.event_slug)}:${String(c.id)}`, c]));
  const clean = [...unique.values()];
  const grouped = groupCardsByEvent(clean);

  const run = await supabase.from('sync_runs').insert({
    catalog: 'events', trigger, status: 'running', records_found: sourceTotal ?? clean.length, records_added: clean.length, metadata: { mode: 'incremental', eventCount: Object.keys(grouped).length },
  }).select('id').single();

  if (run.error) throw run.error;

  try {
    const eventRows = rowsForEvents(clean);
    const { error: upsertError } = await supabase.from('event_cards').upsert(eventRows, { onConflict: 'id,event_slug' });
    if (upsertError) throw upsertError;

    const dbRows = await readAllRows('event_cards', 'id,event_slug');
    const dbCount = dbRows.length;

    await rebuildEventStorage();
    await saveCatalogState('events', dbCount, 'ready', null, {
      trigger, sourceTotal, mode: 'incremental', eventCount: new Set(dbRows.map(r => r.event_slug)).size, recordsAdded: clean.length, unknownEvents: scraper?.unknownEvents || [],
    });

    const { error: runError } = await supabase.from('sync_runs').update({
      status: 'success', finished_at: new Date().toISOString(), records_found: sourceTotal ?? dbCount, records_added: clean.length,
      metadata: { mode: 'incremental', databaseCount: dbCount, sourceCount: sourceTotal, missingAdded: clean.length, eventCount: Object.keys(grouped).length },
    }).eq('id', run.data.id);

    if (runError) throw runError;

    state.events.count = dbCount;
    state.events.lastSyncAt = new Date().toISOString();
    state.events.storage = 'available';
    state.events.error = null;
    state.events.lastDelta = clean.length;
    state.events.sourceTotal = sourceTotal;

    const actualByEvent = new Map();
    for (const row of dbRows) {
      actualByEvent.set(String(row.event_slug), (actualByEvent.get(String(row.event_slug)) || 0) + 1);
    }

    state.events.countsMatch = scraper?.eventStats
      ? Object.entries(scraper.eventStats).every(([slug, stats]) => (actualByEvent.get(slug) || 0) === stats.expected) &&
        [...actualByEvent.keys()].every(slug => Object.prototype.hasOwnProperty.call(scraper.eventStats, slug))
      : null;

    state.events.menuChecked = scraper?.menuChecked ?? state.events.menuChecked;
    state.events.unknownEvents = scraper?.unknownEvents || [];

    logger.log('SUCCESS', 'sync', 'Incremental event catalog repair completed', { databaseCount: dbCount, sourceTotal, added: clean.length, trigger });
  } catch (e) {
    await supabase.from('sync_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: String(e.message || e) }).eq('id', run.data.id);
    throw e;
  }
}

async function scrapeMainAndSync(trigger) {
  if (state.cards.isScraping) return { skipped: true, reason: 'main sync already running' };

  state.cards.isScraping = true;
  state.cards.startedAt = new Date().toISOString();
  state.cards.error = null;
  state.cards.lastDelta = 0;
  state.lastSourceCheckAt = new Date().toISOString();

  logger.log('INFO', 'scraper-main', 'Checking ZCard published total before any card scan', { trigger });

  try {
    const dbCount = await countRows('cards');
    const summaryScraper = new ShoobCardScraper({ category: null });
    const summary = await summaryScraper.fetchSummary();

    state.cards.expected = summary.total;
    state.cards.sourceTotal = summary.total;

    if (summary.total === dbCount) {
      if (state.cards.storage !== 'available') await rebuildMainStorage();
      await recordNoopRun('cards', trigger, summary.total, dbCount);
      await supabase.from('catalog_state').update({
        last_checked_at: new Date().toISOString(), status: 'ready', last_error: null, metadata: { trigger, mode: 'count-match-noop', sourceTotal: summary.total },
      }).eq('catalog', 'cards');

      state.cards.count = dbCount;
      state.cards.error = null;
      state.cards.countsMatch = true;

      logger.log('SUCCESS', 'scraper-main', 'Counts match; skipped card scan and database writes', { sourceTotal: summary.total, databaseCount: dbCount, trigger });
    } else {
      logger.log('WARN', 'scraper-main', 'Published total differs; scanning IDs only for missing cards', { sourceTotal: summary.total, databaseCount: dbCount, trigger });

      const existingRows = await readAllRows('cards', 'id');
      const existingIds = new Set(existingRows.map(r => String(r.id)));
      const scraper = new ShoobCardScraper({ category: null, existingIds });
      const missing = await scraper.fetchAll();
      state.cards.expected = summary.total;

      if (!missing.length) {
        const note = `ZCard total ${summary.total} differs from Supabase ${dbCount}, but no missing IDs were found. No records were deleted.`;
        logger.log('WARN', 'scraper-main', note, { sourceTotal: summary.total, databaseCount: dbCount, trigger });
        await recordNoopRun('cards', trigger, summary.total, dbCount, { mode: 'count-mismatch-no-missing-ids', warning: note });
        await supabase.from('catalog_state').update({
          last_checked_at: new Date().toISOString(), status: 'ready', last_error: note, metadata: { trigger, sourceTotal: summary.total, databaseCount: dbCount, warning: note },
        }).eq('catalog', 'cards');
        state.cards.count = dbCount;
        state.cards.countsMatch = false;
      } else {
        if (dbCount > 0 && missing.length > Math.max(5000, summary.total * 0.35)) {
          throw new Error(`Safety stop: ${missing.length} missing cards is an unexpectedly large delta for source total ${summary.total}`);
        }
        await syncMain(missing, trigger, summary.total);
      }
    }
    state.cards.finishedAt = new Date().toISOString();
  } catch (e) {
    state.cards.error = e.message || String(e);
    logger.log('ERROR', 'scraper-main', 'Main incremental check failed; retaining last known-good catalog', { error: state.cards.error });
  } finally {
    state.cards.isScraping = false;
  }
}

async function scrapeEventsAndSync(trigger) {
  if (state.events.isScraping) return { skipped: true, reason: 'event sync already running' };

  state.events.isScraping = true;
  state.events.startedAt = new Date().toISOString();
  state.events.error = null;
  state.events.lastDelta = 0;
  state.lastSourceCheckAt = new Date().toISOString();

  logger.log('INFO', 'scraper-events', 'Checking ZCard event menu and per-event totals before scanning cards', { trigger });

  try {
    const summaryScraper = new ShoobEventScraper();
    const summary = await summaryScraper.fetchSummary();

    state.events.expected = summary.total;
    state.events.sourceTotal = summary.total;

    const dbRows = await readAllRows('event_cards', 'id,event_slug');
    const dbByEvent = new Map();
    const existingKeys = new Set();

    for (const row of dbRows) {
      const slug = String(row.event_slug);
      dbByEvent.set(slug, (dbByEvent.get(slug) || 0) + 1);
      existingKeys.add(`${slug}:${String(row.id)}`);
    }

    const allMatch =
      Object.entries(summary.byEvent).every(([slug, total]) => (dbByEvent.get(slug) || 0) === total) &&
      Object.keys(Object.fromEntries(dbByEvent)).every(slug => Object.prototype.hasOwnProperty.call(summary.byEvent, slug));

    if (allMatch) {
      if (state.events.storage !== 'available') await rebuildEventStorage();
      await recordNoopRun('events', trigger, summary.total, dbRows.length, { byEvent: summary.byEvent });
      await supabase.from('catalog_state').update({
        last_checked_at: new Date().toISOString(), status: 'ready', last_error: null, metadata: { trigger, mode: 'per-event-count-match', sourceTotal: summary.total, byEvent: summary.byEvent },
      }).eq('catalog', 'events');

      state.events.count = dbRows.length;
      state.events.error = null;
      state.events.countsMatch = true;

      logger.log('SUCCESS', 'scraper-events', 'Every event count matches; skipped event-card scan and writes', { sourceTotal: summary.total, databaseCount: dbRows.length, byEvent: summary.byEvent, trigger });
    } else {
      logger.log('WARN', 'scraper-events', 'At least one event count differs; scanning only for missing event/card pairs', {
        sourceTotal: summary.total, databaseCount: dbRows.length, byEvent: summary.byEvent, databaseByEvent: Object.fromEntries(dbByEvent), trigger,
      });

      const scraper = new ShoobEventScraper({ existingKeys });
      const missing = await scraper.fetchAll();
      state.events.expected = summary.total;

      if (!missing.length) {
        const note = 'Per-event source and database counts differ, but no missing event/card pairs were found. No records were deleted.';
        logger.log('WARN', 'scraper-events', note, { sourceTotal: summary.total, databaseCount: dbRows.length, trigger });
        await recordNoopRun('events', trigger, summary.total, dbRows.length, { mode: 'count-mismatch-no-missing-ids', warning: note, byEvent: summary.byEvent });
        await supabase.from('catalog_state').update({
          last_checked_at: new Date().toISOString(), status: 'ready', last_error: note, metadata: { trigger, sourceTotal: summary.total, databaseCount: dbRows.length, warning: note, byEvent: summary.byEvent },
        }).eq('catalog', 'events');
        state.events.count = dbRows.length;
        state.events.countsMatch = false;
      } else {
        if (dbRows.length > 0 && missing.length > Math.max(2000, summary.total * 0.5)) {
          throw new Error(`Safety stop: ${missing.length} missing event-card pairs is an unexpectedly large delta`);
        }
        await syncEvents(missing, trigger, scraper, summary.total);
      }
    }
    state.events.menuChecked = summary.menuChecked;
    state.events.unknownEvents = summary.unknownEvents || [];
    state.events.finishedAt = new Date().toISOString();
  } catch (e) {
    state.events.error = e.message || String(e);
    // Matches the scraper module's message regardless of brand wording
    const unknownMatch = state.events.error.match(/New (?:Shoob|ZCard) event\(s\) need to be added before syncing: (.+)$/);
    if (unknownMatch) {
      state.events.menuChecked = true;
      state.events.unknownEvents = unknownMatch[1].split(',').map(x => x.trim()).filter(Boolean);
    } else if (/event menu could not be verified/i.test(state.events.error)) {
      state.events.menuChecked = false;
      state.events.menuError = state.events.error;
    }
    logger.log('ERROR', 'scraper-events', 'Event incremental check failed; retaining last known-good catalog', { error: state.events.error, unknownEvents: state.events.unknownEvents });
  } finally {
    state.events.isScraping = false;
  }
}

async function hasCatalog(catalog, table) {
  const { data: stateRow, error: stateErr } = await supabase.from('catalog_state').select('record_count,status,storage_path,last_synced_at,metadata').eq('catalog', catalog).maybeSingle();
  if (stateErr) throw stateErr;

  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true });
  if (error) throw error;

  const storagePath = catalog === 'cards' ? 'cards.json' : 'events.json';
  const { data: objects, error: storageErr } = await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || 'shoob-catalogs').list('', { search: storagePath, limit: 10 });
  if (storageErr) throw storageErr;

  const storageExists = (objects || []).some(o => o.name === storagePath);
  const dbExists = stateRow?.status === 'ready' && ((count || 0) > 0 || stateRow?.metadata?.sourceTotal === 0);

  return { present: dbExists && storageExists, dbCount: count || 0, stateRow, storageExists };
}

async function monitorOnce() {
  state.lastMonitorAt = new Date().toISOString();
  if (!supabase) {
    state.supabaseReachable = false;
    state.supabaseError = 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY';
    state.lastMonitorOk = false;
    return;
  }

  try {
    const { error } = await supabase.from('catalog_state').select('catalog').limit(1);
    if (error) throw error;

    state.supabaseReachable = true;
    state.supabaseError = null;
    state.lastMonitorOk = true;

    const [main, events] = await Promise.all([hasCatalog('cards', 'cards'), hasCatalog('events', 'event_cards')]);

    state.cards.count = main.dbCount;
    state.cards.storage = main.storageExists ? 'available' : 'missing';
    state.cards.lastSyncAt = main.stateRow?.last_synced_at || state.cards.lastSyncAt;
    state.cards.sourceTotal = main.stateRow?.metadata?.sourceTotal ?? state.cards.sourceTotal;

    state.events.count = events.dbCount;
    state.events.storage = events.storageExists ? 'available' : 'missing';
    state.events.lastSyncAt = events.stateRow?.last_synced_at || state.events.lastSyncAt;
    state.events.sourceTotal = events.stateRow?.metadata?.sourceTotal ?? state.events.sourceTotal;

    if (!main.present && !state.cards.isScraping) {
      logger.log('WARN', 'monitor', 'Main catalog missing/incomplete; starting recovery', main);
      void scrapeMainAndSync('startup-recovery');
    }
    if (!events.present && !state.events.isScraping) {
      logger.log('WARN', 'monitor', 'Event catalog missing/incomplete; starting recovery', events);
      void scrapeEventsAndSync('startup-recovery');
    }
  } catch (e) {
    state.supabaseReachable = false;
    state.supabaseError = e.message || String(e);
    state.lastMonitorOk = false;
    logger.log('ERROR', 'monitor', 'Supabase monitor check failed; will retry', { error: state.supabaseError });
  }
}

function lagosClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LAGOS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function lagosHourSlot(date = new Date()) {
  const p = lagosClockParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:00`;
}

function nextLagosHourIso(date = new Date()) {
  const p = lagosClockParts(date);
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), 0, 0, 0)).toISOString();
}

async function deleteOldRowsInBatches(table, timestampColumn, cutoffIso) {
  let totalDeleted = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select('id').lt(timestampColumn, cutoffIso).limit(RETENTION_BATCH_SIZE);
    if (error) throw error;

    const ids = (data || []).map(row => row.id).filter(id => id !== null && id !== undefined);
    if (!ids.length) break;

    const { error: deleteError } = await supabase.from(table).delete().in('id', ids);
    if (deleteError) throw deleteError;

    totalDeleted += ids.length;
    if (ids.length < RETENTION_BATCH_SIZE) break;
  }
  return totalDeleted;
}

let retentionPromise = null;
async function runRetentionCleanup(trigger = 'scheduled') {
  if (!supabase) throw new Error('Supabase is not configured; retention cleanup cannot run');
  if (retentionPromise) return retentionPromise;

  retentionPromise = (async () => {
    const startedAt = new Date().toISOString();
    const cutoffIso = new Date(Date.now() - RETENTION_MS).toISOString();
    state.retention.lastRunAt = startedAt;

    logger.log('INFO', 'retention', 'Seven-day temporary-data cleanup started', { trigger, cutoff: cutoffIso });

    try {
      const systemLogsDeleted = await deleteOldRowsInBatches('system_logs', 'timestamp', cutoffIso);
      const syncRunsDeleted = await deleteOldRowsInBatches('sync_runs', 'started_at', cutoffIso);

      state.retention.systemLogsDeleted = systemLogsDeleted;
      state.retention.syncRunsDeleted = syncRunsDeleted;
      state.retention.lastSuccessAt = new Date().toISOString();
      state.retention.lastError = null;

      logger.log('SUCCESS', 'retention', 'Seven-day temporary-data cleanup completed', {
        trigger, cutoff: cutoffIso, systemLogsDeleted, syncRunsDeleted, protectedTables: ['cards', 'event_cards'], protectedStorageFiles: ['cards.json', 'events.json'],
      });
      return { systemLogsDeleted, syncRunsDeleted };
    } catch (error) {
      state.retention.lastError = error?.message || String(error);
      logger.log('ERROR', 'retention', 'Seven-day cleanup failed; it will be retried', { trigger, error: state.retention.lastError });
      throw error;
    }
  })().finally(() => {
    retentionPromise = null;
  });

  return retentionPromise;
}

let selfPingPromise = null;
let selfPingHasWarned = false;
async function selfPingOnce() {
  const baseUrl = String(process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    if (!selfPingHasWarned) {
      selfPingHasWarned = true;
      logger.log('WARN', 'self-ping', 'Self-ping is not configured; set SELF_PING_URL or ensure RENDER_EXTERNAL_URL is available');
    }
    return;
  }
  if (selfPingPromise) return selfPingPromise;

  selfPingPromise = (async () => {
    const url = /\/ping$/i.test(baseUrl) ? baseUrl : `${baseUrl}/ping`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    state.selfPing.lastAttemptAt = new Date().toISOString();

    try {
      const response = await fetch(url, { method: 'GET', signal: controller.signal, headers: { 'user-agent': 'ZCard-Control-Room-self-ping' } });
      if (!response.ok) throw new Error(`Self-ping returned HTTP ${response.status}`);

      const wasFailing = !!state.selfPing.lastError;
      state.selfPing.lastSuccessAt = new Date().toISOString();
      state.selfPing.lastError = null;

      if (wasFailing) {
        logger.log('SUCCESS', 'self-ping', 'Self-ping recovered', { url, status: response.status });
      }
    } catch (error) {
      state.selfPing.lastError = error?.message || String(error);
      logger.log('WARN', 'self-ping', 'Self-ping failed; the next scheduled ping will retry', { url, error: state.selfPing.lastError });
    } finally {
      clearTimeout(timeout);
      selfPingPromise = null;
    }
  })();

  return selfPingPromise;
}

let schedulerPromise = null;
async function schedulerTick() {
  if (schedulerPromise) return schedulerPromise;
  const slot = lagosHourSlot();
  state.nextSourceCheckAt = nextLagosHourIso();

  if (state.scheduler.lastSlotSucceeded === slot) return;
  const retryAt = state.scheduler.retryAt ? Date.parse(state.scheduler.retryAt) : 0;
  if (state.scheduler.lastSlotAttempted === slot && retryAt > Date.now()) return;
  if (syncPromise || state.cards.isScraping || state.events.isScraping) return;

  schedulerPromise = (async () => {
    state.scheduler.lastSlotAttempted = slot;
    state.scheduler.lastCheckStatus = 'running';
    state.scheduler.lastCheckError = null;

    logger.log('INFO', 'scheduler', 'Hourly ZCard cards and events check started', { slot, timeZone: LAGOS_TIME_ZONE });

    try {
      await sourceCheck(`scheduled-hourly-${slot}`);
      const failures = [state.cards.error && `cards: ${state.cards.error}`, state.events.error && `events: ${state.events.error}`].filter(Boolean);
      if (failures.length) throw new Error(failures.join(' | '));

      state.scheduler.lastSlotSucceeded = slot;
      state.scheduler.lastCheckStatus = 'success';
      state.scheduler.lastCheckError = null;
      state.scheduler.retryAt = null;

      logger.log('SUCCESS', 'scheduler', 'Hourly ZCard cards and events check completed', { slot, timeZone: LAGOS_TIME_ZONE });
    } catch (error) {
      state.scheduler.lastCheckStatus = 'failed';
      state.scheduler.lastCheckError = error?.message || String(error);
      state.scheduler.retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      logger.log('ERROR', 'scheduler', 'Hourly check failed; retry scheduled in five minutes', { slot, retryAt: state.scheduler.retryAt, error: state.scheduler.lastCheckError });
    }
  })().finally(() => {
    schedulerPromise = null;
  });

  return schedulerPromise;
}

async function sourceCheck(trigger = 'scheduled-hourly') {
  if (syncPromise) return syncPromise;
  if (state.cards.isScraping || state.events.isScraping) {
    throw new Error('Source check deferred because a cards/events recovery scrape is already running');
  }

  syncPromise = (async () => {
    state.lastSourceCheckAt = new Date().toISOString();
    state.nextSourceCheckAt = nextLagosHourIso();
    await Promise.all([scrapeMainAndSync(trigger), scrapeEventsAndSync(trigger)]);
    const failures = [state.cards.error && `cards: ${state.cards.error}`, state.events.error && `events: ${state.events.error}`].filter(Boolean);
    if (failures.length) throw new Error(failures.join(' | '));
  })().finally(() => {
    syncPromise = null;
  });

  return syncPromise;
}

// -----------------------------------------------------------------------------
// Public health and status endpoints
// -----------------------------------------------------------------------------

app.get(['/api/health', '/ping'], (req, res) => {
  const healthy = !!supabase && state.supabaseReachable;
  const uptimeSec = Math.floor(process.uptime());

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    service: 'ZCard Control Room',
    supabaseConfigured,
    supabaseReachable: state.supabaseReachable,
    activeJobs: { cards: state.cards.isScraping, events: state.events.isScraping },
    uptime: formatUptime(uptimeSec),
    node: process.version,
    timestamps: getTimestamps(),
  });
});

app.get('/api/status', (req, res) => {
  const uptimeSec = Math.floor(process.uptime());

  res.json({
    ok: true,
    uptime: formatUptime(uptimeSec),
    timestamps: getTimestamps(),
    ...state,
    memory: {
      rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
      heapMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    },
    logBuffer: { max: logger.MAX_LOGS, current: logger.list({ limit: logger.MAX_LOGS }).length },
    monitorIntervalMs: MONITOR_MS,
    schedulerPollIntervalMs: SCHEDULER_POLL_MS,
    sourceCheckIntervalMs: SHOOB_CHECK_MS,
    selfPingIntervalMs: SELF_PING_MS,
    retentionDays: 7,
    retentionCleanupIntervalMs: RETENTION_CLEANUP_MS,
  });
});

// -----------------------------------------------------------------------------
// Admin login
// -----------------------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ ok: false, error: 'ADMIN_KEY is not configured on Render' });
  if (!safeEqual(String(req.body?.key || ''), process.env.ADMIN_KEY)) {
    logger.log('WARN', 'security', 'Failed admin login attempt', { ...getIpDiagnostics(req) });
    return res.status(401).json({ ok: false, error: 'Invalid admin key' });
  }
  logger.log('SUCCESS', 'security', 'Admin login accepted', { ...getIpDiagnostics(req) });
  return res.json({ ok: true, message: 'Authenticated for this browser session. Keep the key private.' });
});

app.get('/api/admin/status', requireAdmin, (req, res) => {
  const uptimeSec = Math.floor(process.uptime());
  res.json({
    ok: true,
    uptime: formatUptime(uptimeSec),
    timestamps: getTimestamps(),
    ...state,
    memory: {
      rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
      heapMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    },
    logBuffer: { max: logger.MAX_LOGS, current: logger.list({ limit: logger.MAX_LOGS }).length },
  });
});

app.get('/api/admin/logs', requireAdmin, (req, res) =>
  res.json({
    ok: true,
    max: logger.MAX_LOGS,
    logs: logger.list({ limit: req.query.limit, level: req.query.level, search: req.query.search }),
  })
);

app.get('/api/admin/logs/download', requireAdmin, (req, res) => {
  const format = ['json', 'txt', 'html'].includes(String(req.query.format)) ? String(req.query.format) : 'json';
  const logs = logger.list({ limit: logger.MAX_LOGS, level: req.query.level, search: req.query.search });

  let body;
  let type;

  if (format === 'txt') {
    type = 'text/plain; charset=utf-8';
    body = logs.map(x => `${x.timestamp} [${x.level}] [${x.component}] ${x.message} ${JSON.stringify(x.details)}`).join('\n');
  } else if (format === 'html') {
    type = 'text/html; charset=utf-8';
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    body =
      `<!doctype html><meta charset="utf-8">` +
      `<title>ZCard Logs</title>` +
      `<style>body{font:14px system-ui;background:#0b1020;color:#e8edff;padding:24px}article{padding:12px;margin:8px 0;border:1px solid #29334e;border-radius:10px}small{color:#9ba8c7}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>` +
      `<h1>ZCard system logs (${logs.length})</h1>` +
      logs.map(x => `<article><small>${esc(x.timestamp)} · ${esc(x.level)} · ${esc(x.component)}</small><p>${esc(x.message)}</p><pre>${esc(JSON.stringify(x.details, null, 2))}</pre></article>`).join('');
  } else {
    type = 'application/json; charset=utf-8';
    body = JSON.stringify({ exportedAt: new Date().toISOString(), count: logs.length, logs }, null, 2);
  }

  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="zcard-logs-${new Date().toISOString().slice(0, 10)}.${format}"`);
  res.send(body);
});

app.get('/api/admin/sync-runs', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  const { data, error } = await supabase.from('sync_runs').select('*').order('started_at', { ascending: false }).limit(100);
  if (error) return res.status(502).json({ ok: false, error: error.message });
  res.json({ ok: true, runs: data || [] });
});

app.post('/api/admin/sync', requireAdmin, async (req, res) => {
  const target = req.body?.catalog;
  if (!['cards', 'events', 'both'].includes(target)) return res.status(400).json({ ok: false, error: 'catalog must be cards, events, or both' });
  if ((target === 'cards' || target === 'both') && state.cards.isScraping) return res.status(409).json({ ok: false, error: 'Main-card check is already running. Refresh status instead of starting another.' });
  if ((target === 'events' || target === 'both') && state.events.isScraping) return res.status(409).json({ ok: false, error: 'Event check is already running. Refresh status instead of starting another.' });
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase is not configured; sync was not started.' });

  if (target === 'cards' || target === 'both') void scrapeMainAndSync('manual-admin');
  if (target === 'events' || target === 'both') void scrapeEventsAndSync('manual-admin');

  res.status(202).json({ ok: true, message: 'Incremental check queued: published counts are checked first; a card scan runs only if counts differ.', catalog: target, mode: 'incremental' });
});

// -----------------------------------------------------------------------------
// Admin: delete logs and sync history
// -----------------------------------------------------------------------------
const MAX_DELETE_IDS = 500;
const DELETE_CHUNK_SIZE = 100;

function cleanDeleteIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = new Set();
  for (const value of raw) {
    if (typeof value === 'number' && Number.isFinite(value)) out.add(String(value));
    else if (typeof value === 'string' && value.length > 0 && value.length <= 100) out.add(value);
  }
  return [...out];
}

function isMissingTableError(error) {
  return /does not exist|schema cache/i.test(error?.message || '');
}

async function deleteRows(table, { ids = null, protectRunning = false } = {}) {
  const chunks = ids ? Array.from({ length: Math.ceil(ids.length / DELETE_CHUNK_SIZE) }, (_, i) => ids.slice(i * DELETE_CHUNK_SIZE, (i + 1) * DELETE_CHUNK_SIZE)) : [null];
  let deleted = 0;

  try {
    for (const chunk of chunks) {
      let query = supabase.from(table).delete({ count: 'exact' });
      query = chunk ? query.in('id', chunk) : query.not('id', 'is', null);
      if (protectRunning) query = query.or('status.is.null,status.neq.running');
      const { error, count } = await query;
      if (error) throw error;
      deleted += count || 0;
    }
  } catch (error) {
    error.partialDeleted = deleted;
    throw error;
  }
  return deleted;
}

async function deleteFromDatabase(table, options) {
  if (!supabase) return { status: 'skipped', deleted: 0, reason: 'Supabase is not configured' };
  try {
    return { status: 'ok', deleted: await deleteRows(table, options) };
  } catch (error) {
    if (isMissingTableError(error)) return { status: 'skipped', deleted: 0, reason: `Table ${table} does not exist` };
    return { status: 'failed', deleted: error.partialDeleted || 0, error: error?.message || String(error) };
  }
}

const DELETE_TARGET_LABELS = { memory: 'live buffer', database: 'Supabase' };

function finishDeletion(req, res, { noun, component, all, requested, results, reportSkipped = false }) {
  const entries = Object.entries(results);
  const failed = entries.filter(([, r]) => r.status === 'failed');
  const attempted = entries.filter(([, r]) => r.status !== 'skipped');
  const everythingFailed = failed.length > 0 && failed.length === attempted.length;
  const scope = all ? `all ${noun}s` : `${requested} ${noun}${requested === 1 ? '' : 's'}`;

  const parts = entries.map(([key, r]) => {
    const label = DELETE_TARGET_LABELS[key] || key;
    if (r.status === 'ok') return `${label} ${r.deleted}`;
    if (r.status === 'skipped') return `${label} skipped (${r.reason})`;
    return `${label} FAILED (${r.error})`;
  });

  const dbResult = results.database;
  if (reportSkipped && !all && dbResult?.status === 'ok' && requested > dbResult.deleted) {
    parts.push(`${requested - dbResult.deleted} kept (still running or already gone)`);
  }

  const message = failed.length ? `Delete finished with errors: ${parts.join(' · ')}` : `Deleted ${scope}: ${parts.join(' · ')}`;

  logger.log(everythingFailed ? 'ERROR' : failed.length ? 'WARN' : 'SUCCESS', component, failed.length ? `Admin delete of ${scope} finished with errors` : `Admin deleted ${scope}`, {
    requested: all ? 'all' : requested,
    results,
    actorIp: req.ip || null,
  });

  return res.status(everythingFailed ? 502 : failed.length ? 207 : 200).json({
    ok: failed.length === 0,
    partial: failed.length > 0 && !everythingFailed,
    message,
    error: failed.length ? message : undefined,
    requested: all ? 'all' : requested,
    results,
  });
}

app.post('/api/admin/logs/delete', requireAdmin, async (req, res) => {
  const all = req.body?.all === true;
  const ids = all ? null : cleanDeleteIds(req.body?.ids);
  if (!all && !ids.length) return res.status(400).json({ ok: false, error: 'Send ids (array of log ids) or all: true' });
  if (!all && ids.length > MAX_DELETE_IDS) return res.status(400).json({ ok: false, error: `Select at most ${MAX_DELETE_IDS} logs per request` });

  let memory;
  try {
    memory = { status: 'ok', deleted: all ? logger.clear() : logger.removeByIds(ids) };
  } catch (error) {
    memory = { status: 'failed', deleted: 0, error: error?.message || String(error) };
  }
  const database = await deleteFromDatabase(LOG_TABLE, { ids });

  return finishDeletion(req, res, { noun: 'log', component: 'log-admin', all, requested: all ? null : ids.length, results: { memory, database } });
});

app.post('/api/admin/sync-runs/delete', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  const all = req.body?.all === true;
  const ids = all ? null : cleanDeleteIds(req.body?.ids);
  if (!all && !ids.length) return res.status(400).json({ ok: false, error: 'Send ids (array of sync run ids) or all: true' });
  if (!all && ids.length > MAX_DELETE_IDS) return res.status(400).json({ ok: false, error: `Select at most ${MAX_DELETE_IDS} sync runs per request` });

  const database = await deleteFromDatabase('sync_runs', { ids, protectRunning: true });
  return finishDeletion(req, res, { noun: 'sync run', component: 'sync-admin', all, requested: all ? null : ids.length, results: { database }, reportSkipped: true });
});

app.post('/api/internal/logs', requireInternalOrAdmin, (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [req.body];
  for (const item of events) {
    logger.log(item?.level || 'INFO', `vercel:${item?.component || 'app'}`, item?.message || 'Vercel application event', item?.details || {});
  }
  res.json({ ok: true, accepted: events.length });
});

// -----------------------------------------------
// Public catalog endpoints (SAFE-RANGE PAGINATION)
// -----------------------------------------------

app.get('/api/cards', async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });

  const limit = Math.min(100, parsePositiveInt(req.query.limit, 20));
  const page = parsePositiveInt(req.query.page, 1);
  const filters = getSearchFilters(req);
  const includeBreakdown = req.query.byseries === 'true' || req.query.byseries === '1';

  const buildFilteredQuery = query => applyCardFilters(query, filters);
  const startTime = Date.now();

  const filtersEcho = {
    tier: filters.tier || null,
    series: filters.series || null,
    search: filters.search || null,
    sort: ['name', 'tier', 'series'].includes(String(req.query.sort)) ? String(req.query.sort) : 'name',
    order: String(req.query.order).toLowerCase() === 'desc' ? 'desc' : 'asc',
  };

  try {
    // 1) Exact filtered count first (head query, no rows transferred)
    const { count, error: countErr } = await buildFilteredQuery(
      supabase.from('cards').select('id', { count: 'exact', head: true })
    );
    if (countErr) throw countErr;

    const safeCount = count || 0;
    const pages = Math.ceil(safeCount / limit);
    const safeStart = (page - 1) * limit;

    // 2) Requested page lies beyond the data → graceful empty page, never a range error
    if (safeCount === 0 || safeStart >= safeCount) {
      const uniqueData = safeCount === 0
        ? { uniqueCount: 0, breakdown: includeBreakdown ? {} : null }
        : await getUniqueCounts('cards', 'series', buildFilteredQuery, includeBreakdown);

      const emptyResponse = {
        ok: true,
        count: safeCount,
        series_count: uniqueData.uniqueCount,
        page,
        limit,
        pages,
        filters: filtersEcho,
        durationMs: Date.now() - startTime,
        timestamps: getTimestamps(),
        data: [],
      };
      if (includeBreakdown) emptyResponse.bySeries = uniqueData.breakdown;
      return res.json(emptyResponse);
    }

    // 3) Clamp the range so it can never exceed the last existing row
    const safeEnd = Math.min(page * limit - 1, safeCount - 1);

    const sortedQuery = applySort(
      buildFilteredQuery(supabase.from('cards').select('*')),
      req.query.sort,
      req.query.order,
      ['name', 'tier', 'series']
    );

    const [result, uniqueData] = await Promise.all([
      sortedQuery.range(safeStart, safeEnd),
      getUniqueCounts('cards', 'series', buildFilteredQuery, includeBreakdown),
    ]);

    if (result.error) throw result.error;

    const response = {
      ok: true,
      count: safeCount,
      series_count: uniqueData.uniqueCount,
      page,
      limit,
      pages,
      filters: filtersEcho,
      durationMs: Date.now() - startTime,
      timestamps: getTimestamps(),
      data: result.data || [],
    };

    if (includeBreakdown) response.bySeries = uniqueData.breakdown;
    return res.json(response);
  } catch (error) {
    const errMsg = error?.message || String(error);
    const errDetails = error?.details || error?.hint || 'No additional details provided by database.';
    console.error(`[API CARDS ERROR] ${errMsg}`, errDetails);
    logger.log('ERROR', 'api-cards', 'Card endpoint failed', { error: errMsg, details: errDetails });
    return res.status(502).json({ ok: false, error: 'Catalog query failed', details: errDetails });
  }
});

app.get('/api/events', async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });

  const limit = Math.min(100, parsePositiveInt(req.query.limit, 20));
  const page = parsePositiveInt(req.query.page, 1);
  const filters = getSearchFilters(req);
  const eventSlug = req.query.event ? String(req.query.event).trim().slice(0, 80) : '';
  const includeBreakdown = req.query.byevent === 'true' || req.query.byevent === '1' || req.query.byseries === 'true' || req.query.byseries === '1';

  const buildFilteredQuery = query => {
    query = applyCardFilters(query, filters);
    if (eventSlug) query = query.eq('event_slug', eventSlug);
    return query;
  };

  const startTime = Date.now();

  const filtersEcho = {
    event: eventSlug || null,
    tier: filters.tier || null,
    series: filters.series || null,
    search: filters.search || null,
    sort: ['name', 'tier', 'series', 'event_slug'].includes(String(req.query.sort)) ? String(req.query.sort) : 'name',
    order: String(req.query.order).toLowerCase() === 'desc' ? 'desc' : 'asc',
  };

  try {
    // 1) Exact filtered count first (head query, no rows transferred)
    const { count, error: countErr } = await buildFilteredQuery(
      supabase.from('event_cards').select('id', { count: 'exact', head: true })
    );
    if (countErr) throw countErr;

    const safeCount = count || 0;
    const pages = Math.ceil(safeCount / limit);
    const safeStart = (page - 1) * limit;

    // 2) Requested page lies beyond the data → graceful empty page, never a range error
    if (safeCount === 0 || safeStart >= safeCount) {
      const uniqueData = safeCount === 0
        ? { uniqueCount: 0, breakdown: includeBreakdown ? {} : null }
        : await getUniqueCounts('event_cards', 'event_slug', buildFilteredQuery, includeBreakdown);

      const emptyResponse = {
        ok: true,
        count: safeCount,
        event_count: uniqueData.uniqueCount,
        page,
        limit,
        pages,
        filters: filtersEcho,
        durationMs: Date.now() - startTime,
        timestamps: getTimestamps(),
        data: [],
      };
      if (includeBreakdown) emptyResponse.byEvent = uniqueData.breakdown;
      return res.json(emptyResponse);
    }

    // 3) Clamp the range so it can never exceed the last existing row
    const safeEnd = Math.min(page * limit - 1, safeCount - 1);

    const sortedQuery = applySort(
      buildFilteredQuery(supabase.from('event_cards').select('*')),
      req.query.sort,
      req.query.order,
      ['name', 'tier', 'series', 'event_slug']
    );

    const [result, uniqueData] = await Promise.all([
      sortedQuery.range(safeStart, safeEnd),
      getUniqueCounts('event_cards', 'event_slug', buildFilteredQuery, includeBreakdown),
    ]);

    if (result.error) throw result.error;

    const response = {
      ok: true,
      count: safeCount,
      event_count: uniqueData.uniqueCount,
      page,
      limit,
      pages,
      filters: filtersEcho,
      durationMs: Date.now() - startTime,
      timestamps: getTimestamps(),
      data: result.data || [],
    };

    if (includeBreakdown) response.byEvent = uniqueData.breakdown;
    return res.json(response);
  } catch (error) {
    const errMsg = error?.message || String(error);
    const errDetails = error?.details || error?.hint || 'No additional details provided by database.';
    console.error(`[API EVENTS ERROR] ${errMsg}`, errDetails);
    logger.log('ERROR', 'api-events', 'Event endpoint failed', { error: errMsg, details: errDetails });
    return res.status(502).json({ ok: false, error: 'Event query failed', details: errDetails });
  }
});

app.get('/api/random', async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });
  const { count, error: countError } = await supabase.from('cards').select('id', { count: 'exact', head: true });
  if (countError || !count) return res.status(404).json({ ok: false, error: 'No cards available' });

  const offset = crypto.randomInt(0, count);
  const { data, error } = await supabase.from('cards').select('*').range(offset, offset).maybeSingle();
  if (error || !data) return res.status(502).json({ ok: false, error: 'Random card query failed' });

  res.json({ ok: true, data });
});

app.get('/api/admin/catalog', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  const { data, error } = await supabase.from('catalog_state').select('*').order('catalog');
  if (error) return res.status(502).json({ ok: false, error: error.message });
  res.json({ ok: true, catalogs: data || [] });
});

// -----------------------------------------------------------------------------
// Public Endpoint Directory
// -----------------------------------------------------------------------------

const PUBLIC_ENDPOINT_DIRECTORY = {
  ok: true,
  service: 'ZCard Control Room',
  documentation: {
    queryRules: [
      'Use ? before the first query parameter.',
      'Use & between additional query parameters.',
      'Query parameter names are case-sensitive.',
      'Filters combine using AND logic.',
      'limit defaults to 20 and cannot exceed 100.',
      'page defaults to 1.',
      'search and q are aliases.',
      'series and anime are aliases.',
      'event is an exact event slug filter (e.g., summer, gala).',
      'tier is an exact tier filter.',
      'sort must be an allowed column for that endpoint.',
      'order accepts asc or desc (default asc).',
      'Sorting includes a stable secondary sort by id to prevent page shifting.',
      'series_count and event_count return the total number of unique matches.',
      'Add &byseries=true or &byevent=true to include the full 1-by-1 breakdown dictionary.',
      'Requesting a page beyond the last page returns ok:true with an empty data array, not an error.'
    ],
  },
  endpoints: [
    {
      method: 'GET',
      path: '/',
      description: 'Static frontend, if public/index.html is present.',
    },
    {
      method: 'GET',
      path: '/api/health',
      description: 'Health and Supabase availability.',
    },
    {
      method: 'GET',
      path: '/ping',
      description: 'Health-check alias.',
    },
    {
      method: 'GET',
      path: '/api/status',
      description: 'Public runtime, monitoring, scheduler and catalog status.',
    },
    {
      method: 'GET',
      path: '/api/random',
      description: 'Returns one random main-catalog card.',
    },
    {
      method: 'GET',
      path: '/api/cards',
      description: 'Search, filter, sort and paginate main-catalog cards.',
      parameters: {
        page: 'Positive integer; default 1.',
        limit: 'Positive integer; default 20; maximum 100.',
        tier: 'Exact tier match.',
        search: 'Partial search across name and series.',
        q: 'Alias for search.',
        series: 'Partial series match.',
        anime: 'Alias for series.',
        sort: 'name, tier, or series.',
        order: 'asc or desc; default asc.',
        byseries: 'Set to true to include the full 1-by-1 series breakdown dictionary.',
      },
      examples: [
        '/api/cards?limit=50',
        '/api/cards?page=2&limit=50',
        '/api/cards?tier=S&limit=50',
        '/api/cards?search=one%20piece&limit=50',
        '/api/cards?q=goku&page=1&limit=50',
        '/api/cards?anime=naruto&tier=S&limit=50',
        '/api/cards?series=one%20piece&sort=tier&order=desc',
        '/api/cards?search=uta&page=2&limit=25',
        '/api/cards?tier=S&search=naruto&sort=name&order=asc&page=3&limit=25',
        '/api/cards?tier=S&byseries=true'
      ],
    },
    {
      method: 'GET',
      path: '/api/events',
      description: 'Search, filter, sort and paginate event-card records.',
      parameters: {
        page: 'Positive integer; default 1.',
        limit: 'Positive integer; default 20; maximum 100.',
        event: 'Exact event slug, e.g. summer or gala.',
        tier: 'Exact tier match.',
        search: 'Partial search across name and series.',
        q: 'Alias for search.',
        series: 'Partial series match.',
        anime: 'Alias for series.',
        sort: 'name, tier, series, or event_slug.',
        order: 'asc or desc; default asc.',
        byevent: 'Set to true to include the full 1-by-1 event breakdown dictionary.',
      },
      examples: [
        '/api/events?event=summer&limit=50',
        '/api/events?page=4&event=gala&limit=50',
        '/api/events?event=summer&tier=S&limit=50',
        '/api/events?event=summer&search=naruto&limit=50',
        '/api/events?event=summer&anime=one%20piece&limit=50',
        '/api/events?tier=S&search=goku&page=1&limit=25',
        '/api/events?event=gala&sort=tier&order=desc',
        '/api/events?event=christmas&tier=S&series=naruto&sort=name&order=asc&page=2&limit=10',
        '/api/events?event=summer&byevent=true'
      ],
    },
    {
      method: 'GET',
      path: '/api/endpoints',
      description: 'This public endpoint directory.',
    },
    {
      method: 'GET',
      path: '/api/endpoint',
      description: 'Alias for /api/endpoints.',
    },
  ],
};

app.get(['/api/endpoints', '/api/endpoint'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ...PUBLIC_ENDPOINT_DIRECTORY,
    requestedPath: req.path,
    generatedAt: new Date().toISOString(),
  });
});

// -----------------------------------------------------------------------------
// 404 handler
// -----------------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ ok: false, error: 'Endpoint not found', path: req.path }));

// -----------------------------------------------------------------------------
// Server startup and scheduled tasks
// -----------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  logger.log('SUCCESS', 'startup', 'ZCard scraper service listening', {
    port: PORT,
    node: process.version,
    supabaseConfigured,
    timeZone: LAGOS_TIME_ZONE,
    hourlySlots: 24,
  });

  state.nextSourceCheckAt = nextLagosHourIso();
  void monitorOnce();

  setInterval(() => void monitorOnce(), MONITOR_MS).unref();
  setInterval(() => void schedulerTick().catch(error => logger.log('ERROR', 'scheduler', 'Scheduler tick failed', { error: error?.message || String(error) })), SCHEDULER_POLL_MS).unref();
  setInterval(() => void selfPingOnce(), SELF_PING_MS).unref();

  setTimeout(() => void schedulerTick().catch(error => logger.log('ERROR', 'scheduler', 'Initial scheduler check failed', { error: error?.message || String(error) })), 30_000).unref();
  setTimeout(() => void runRetentionCleanup('startup').catch(() => {}), 60_000).unref();
  setInterval(() => void runRetentionCleanup('scheduled').catch(() => {}), RETENTION_CLEANUP_MS).unref();
  setTimeout(() => void selfPingOnce(), 90_000).unref();
});

const shutdown = signal => {
  logger.log('WARN', 'shutdown', `${signal} received; closing HTTP server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', e => logger.log('ERROR', 'process', 'Uncaught exception', { error: e?.message || String(e) }));
process.on('unhandledRejection', e => logger.log('ERROR', 'process', 'Unhandled rejection', { error: e?.message || String(e) }));

// end of server.js



