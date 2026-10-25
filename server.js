// server.js
'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { ShoobCardScraper } = require('./cards.js');
const { ShoobEventScraper, groupCardsByEvent } = require('./events.js');
const logger = require('./logger.js');
const { createStatsTracker } = require('./stats.js');

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

// Initialize the stats tracker with a live getter for the supabase client
const stats = createStatsTracker({ getSupabase: () => supabase, logger });

// Mount the stats middleware immediately after static files
app.use(stats.middleware);

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
    isScraping: false, startedAt: null, finishedAt: null, count: 0, expected: null,
    sourceTotal: null, countsMatch: null, lastDelta: 0, error: null, lastSyncAt: null, storage: 'unknown',
  },
  events: {
    isScraping: false, startedAt: null, finishedAt: null, count: 0, expected: null,
    sourceTotal: null, countsMatch: null, lastDelta: 0, error: null, lastSyncAt: null,
    storage: 'unknown', menuChecked: null, menuError: null, unknownEvents: [],
  },
  scheduler: {
    timeZone: LAGOS_TIME_ZONE, lastSlotAttempted: null, lastSlotSucceeded: null,
    lastCheckStatus: 'waiting', lastCheckError: null, retryAt: null,
  },
  selfPing: { lastAttemptAt: null, lastSuccessAt: null, lastError: null },
  retention: {
    lastRunAt: null, lastSuccessAt: null, lastError: null, systemLogsDeleted: 0, syncRunsDeleted: 0,
  },
  previewLinkBackfill: {
    cards: { status: 'waiting', completed: false, processed: 0, succeeded: 0, failed: 0, cursor: null, startedAt: null, finishedAt: null, lastError: null },
    events: { status: 'waiting', completed: false, processed: 0, succeeded: 0, failed: 0, cursor: null, startedAt: null, finishedAt: null, lastError: null },
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
      timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }) + ' WAT'
  };
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function cleanSearchTerm(value, maxLength = 80) {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/[,()*!]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength).trim();
}

function getSearchFilters(req) {
  return {
    tier: req.query.tier ? String(req.query.tier).trim().slice(0, 30) : '',
    series: cleanSearchTerm(req.query.series || req.query.anime, 100),
    search: cleanSearchTerm(req.query.search || req.query.q, 80),
  };
}

function applyCardFilters(query, filters) {
  if (filters.tier) query = query.eq('tier', filters.tier);
  if (filters.series) query = query.ilike('series', `%${filters.series}%`);
  if (filters.search) {
    const safeSearch = filters.search.replace(/%/g, '\\%');
    query = query.or(`name.ilike.%${safeSearch}%,series.ilike.%${safeSearch}%`);
  }
  return query;
}

function applySort(query, rawSort, rawOrder, allowedColumns) {
  const sort = allowedColumns.includes(String(rawSort)) ? String(rawSort) : 'name';
  const order = String(rawOrder || 'asc').toLowerCase();
  const ascending = order !== 'desc';
  return query.order(sort, { ascending }).order('id', { ascending: true });
}

async function getUniqueCounts(table, column, applyFilters, includeBreakdown) {
  const { count, error: countError } = await applyFilters(
    supabase.from(table).select(column, { count: 'exact', head: true })
  );
  if (countError) throw countError;
  if (count === 0) return { uniqueCount: 0, breakdown: includeBreakdown ? {} : null };

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
      if (includeBreakdown) breakdown[value] = (breakdown[value] || 0) + 1;
    }
    if (rows.length < batchSize) break;
  }
  return { uniqueCount: uniqueSet.size, breakdown };
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ ok: false, error: 'Admin access is not configured.' });
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

// --- API Key Protection Middleware ---
function requireApiKey(req, res, next) {
  // Key may come from ?key=..., or from the x-api-key / x-admin-key headers (keeps it out of URLs/logs).
  const providedKey = req.query.key
    ? String(req.query.key)
    : String(req.get('x-api-key') || req.get('x-admin-key') || '');

  if (!providedKey) {
    req.skipStatsTracking = true;
    return res.status(401).json({
      ok: false,
      error: 'Your API key is required. add  &key=YOUR_KEY to the URL.'
    });
  }

  const validApiKeys = process.env.API_KEYS
    ? process.env.API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
    : [];
  
  const adminKey = process.env.ADMIN_KEY;
  const isValidApiKey = validApiKeys.some(k => safeEqual(providedKey, k));
  const isAdminKey = adminKey ? safeEqual(providedKey, adminKey) : false;

  if (isValidApiKey || isAdminKey) {
    return next();
  }

  req.skipStatsTracking = true;
  return res.status(403).json({
    ok: false,
    error: 'Invalid API key.'
  });
}

function rowsForCards(cards) {
  return cards.map(c => ({
    id: String(c.id), name: String(c.name || 'Unknown'), tier: c.tier == null ? null : String(c.tier),
    series: c.series || '', image_url: c.image_url || null, preview_link: c.preview_link || null, author: c.author || 'Anonymous',
    author_link: c.author_link || 'Hidden', synced_at: new Date().toISOString(),
  }));
}

function rowsForEvents(cards) {
  return cards.map(c => ({ ...rowsForCards([c])[0], event_slug: String(c.event || c.event_slug || 'unknown') }));
}

async function upsertBatches(table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + size), { onConflict: 'id' });
    if (error) throw error;
  }
}

async function saveStorage(filename, value) {
  const body = JSON.stringify(value, null, 2) + '\n';
  const { error } = await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || 'shoob-catalogs').upload(filename, encoder.encode(body), {
    contentType: 'application/json; charset=utf-8', upsert: true, cacheControl: '60',
  });
  if (error) throw error;
}

async function readCatalogMetadata(catalog) {
  const { data, error } = await supabase.from('catalog_state').select('metadata').eq('catalog', catalog).maybeSingle();
  if (error) throw error;
  return data?.metadata && typeof data.metadata === 'object' ? data.metadata : {};
}

async function updateCatalogState(catalog, patch, metadataPatch = null) {
  const update = { ...patch };
  if (metadataPatch) update.metadata = { ...(await readCatalogMetadata(catalog)), ...metadataPatch };
  const { error } = await supabase.from('catalog_state').update(update).eq('catalog', catalog);
  if (error) throw error;
}

async function saveCatalogState(catalog, count, status, error = null, metadata = {}) {
  const storagePath = catalog === 'cards' ? 'cards.json' : 'events.json';
  const mergedMetadata = { ...(await readCatalogMetadata(catalog)), ...metadata };
  const row = {
    catalog, record_count: count, storage_path: storagePath, last_checked_at: new Date().toISOString(),
    last_synced_at: status === 'ready' ? new Date().toISOString() : undefined,
    last_error: error ? String(error).slice(0, 1000) : null, status, metadata: mergedMetadata,
  };
  const { error: dbError } = await supabase.from('catalog_state').upsert(row, { onConflict: 'catalog' });
  if (dbError) throw dbError;
}

async function recordLog(entry) {
  if (!supabase) return;
  const { error } = await supabase.from(LOG_TABLE).upsert({
    id: entry.id, timestamp: entry.timestamp, level: entry.level, component: entry.component,
    message: entry.message, details: entry.details,
  }, { onConflict: 'id' });
  if (error && !/does not exist|schema cache/i.test(error.message || '')) console.warn('[logger persistence]', error.message);
}
logger.setLogPersistence(recordLog);

async function countRows(table, filters = []) {
  let q = supabase.from(table).select('id', { count: 'exact', head: true });
  for (const [column, value] of filters) q = q.eq(column, value);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

async function readAllRows(table, columns = '*') {
  const all = []; const pageSize = 1000;
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await supabase.from(table).select(columns).range(start, start + pageSize - 1);
    if (error) throw error;
    const rows = data || []; all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function recordNoopRun(catalog, trigger, sourceTotal, dbCount, metadata = {}) {
  const { error } = await supabase.from('sync_runs').insert({
    catalog, trigger, status: 'success', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    records_found: sourceTotal, records_added: 0, metadata: { mode: 'count-match-noop', databaseCount: dbCount, sourceCount: sourceTotal, ...metadata },
  });
  if (error) throw error;
}

async function rebuildMainStorage() {
  const rows = await readAllRows('cards');
  await saveStorage('cards.json', rows.map(r => ({
    id: String(r.id), name: r.name, tier: r.tier, series: r.series || '', image_url: r.image_url, preview_link: r.preview_link || null, author: r.author, author_link: r.author_link,
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
      id: String(row.id), name: row.name, tier: row.tier, series: row.series || '', event: slug, image_url: row.image_url, preview_link: row.preview_link || null, author: row.author, author_link: row.author_link,
    });
  }
  await saveStorage('events.json', grouped);
  state.events.storage = 'available';
}

async function syncMain(cards, trigger, sourceTotal = null) {
  if (!supabase) throw new Error('Supabase is not configured');
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('No missing main cards were discovered; refusing an empty write');
  const unique = new Map(cards.map(c => [String(c.id), c]));
  const clean = [...unique.values()];
  const run = await supabase.from('sync_runs').insert({
    catalog: 'cards', trigger, status: 'running', records_found: sourceTotal ?? clean.length, records_added: clean.length, metadata: { mode: 'incremental', missingFound: clean.length },
  }).select('id').single();
  if (run.error) throw run.error;
  try {
    await upsertBatches('cards', rowsForCards(clean));
    await mapWithConcurrency(clean, PREVIEW_BACKFILL_CONCURRENCY, card => resolveAndSavePreview('cards', card));
    const dbCount = await countRows('cards');
    await rebuildMainStorage();
    await saveCatalogState('cards', dbCount, 'ready', null, { trigger, sourceTotal, mode: 'incremental', recordsAdded: clean.length });
    await supabase.from('sync_runs').update({
      status: 'success', finished_at: new Date().toISOString(), records_found: sourceTotal ?? dbCount, records_added: clean.length,
      metadata: { mode: 'incremental', databaseCount: dbCount, sourceCount: sourceTotal, missingAdded: clean.length },
    }).eq('id', run.data.id);
    state.cards.count = dbCount; state.cards.lastSyncAt = new Date().toISOString(); state.cards.storage = 'available';
    state.cards.error = null; state.cards.lastDelta = clean.length; state.cards.sourceTotal = sourceTotal;
    state.cards.countsMatch = sourceTotal == null ? null : dbCount === sourceTotal;
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
    const { error: upsertError } = await supabase.from('event_cards').upsert(eventRows, { onConflict: 'id' });
    if (upsertError) throw upsertError;
    await mapWithConcurrency(clean, PREVIEW_BACKFILL_CONCURRENCY, card => resolveAndSavePreview('events', { ...card, event_slug: card.event || card.event_slug || 'unknown' }));
    const dbRows = await readAllRows('event_cards', 'id,event_slug');
    const dbCount = dbRows.length;
    await rebuildEventStorage();
    await saveCatalogState('events', dbCount, 'ready', null, {
      trigger, sourceTotal, mode: 'incremental', eventCount: new Set(dbRows.map(r => r.event_slug)).size, recordsAdded: clean.length, unknownEvents: scraper?.unknownEvents || [],
    });
    await supabase.from('sync_runs').update({
      status: 'success', finished_at: new Date().toISOString(), records_found: sourceTotal ?? dbCount, records_added: clean.length,
      metadata: { mode: 'incremental', databaseCount: dbCount, sourceCount: sourceTotal, missingAdded: clean.length, eventCount: Object.keys(grouped).length },
    }).eq('id', run.data.id);
    state.events.count = dbCount; state.events.lastSyncAt = new Date().toISOString(); state.events.storage = 'available';
    state.events.error = null; state.events.lastDelta = clean.length; state.events.sourceTotal = sourceTotal;
    const actualByEvent = new Map();
    for (const row of dbRows) actualByEvent.set(String(row.event_slug), (actualByEvent.get(String(row.event_slug)) || 0) + 1);
    state.events.countsMatch = scraper?.eventStats
      ? Object.entries(scraper.eventStats).every(([slug, stats]) => (actualByEvent.get(slug) || 0) === stats.expected) &&
        [...actualByEvent.keys()].every(slug => Object.prototype.hasOwnProperty.call(scraper.eventStats, slug))
      : null;
    state.events.menuChecked = scraper?.menuChecked ?? state.events.menuChecked;
    state.events.unknownEvents = scraper?.unknownEvents || [];
  } catch (e) {
    await supabase.from('sync_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: String(e.message || e) }).eq('id', run.data.id);
    throw e;
  }
}

async function scrapeMainAndSync(trigger) {
  if (state.cards.isScraping) return { skipped: true, reason: 'main sync already running' };
  state.cards.isScraping = true; state.cards.startedAt = new Date().toISOString(); state.cards.error = null; state.cards.lastDelta = 0; state.lastSourceCheckAt = new Date().toISOString();
  try {
    const dbCount = await countRows('cards');
    const summaryScraper = new ShoobCardScraper({ category: null });
    const summary = await summaryScraper.fetchSummary();
    state.cards.expected = summary.total; state.cards.sourceTotal = summary.total;
    if (summary.total === dbCount) {
      if (state.cards.storage !== 'available') await rebuildMainStorage();
      await recordNoopRun('cards', trigger, summary.total, dbCount);
      await updateCatalogState('cards', { last_checked_at: new Date().toISOString(), status: 'ready', last_error: null }, { trigger, mode: 'count-match-noop', sourceTotal: summary.total });
      state.cards.count = dbCount; state.cards.error = null; state.cards.countsMatch = true;
    } else {
      const existingRows = await readAllRows('cards', 'id');
      const existingIds = new Set(existingRows.map(r => String(r.id)));
      const scraper = new ShoobCardScraper({ category: null, existingIds });
      const missing = await scraper.fetchAll();
      state.cards.expected = summary.total;
      if (!missing.length) {
        const note = `ZCard total ${summary.total} differs from Supabase ${dbCount}, but no missing IDs were found.`;
        await recordNoopRun('cards', trigger, summary.total, dbCount, { mode: 'count-mismatch-no-missing-ids', warning: note });
        await updateCatalogState('cards', { last_checked_at: new Date().toISOString(), status: 'ready', last_error: note }, { trigger, sourceTotal: summary.total, databaseCount: dbCount, warning: note });
        state.cards.count = dbCount; state.cards.countsMatch = false;
      } else {
        if (dbCount > 0 && missing.length > Math.max(5000, summary.total * 0.35)) throw new Error(`Safety stop: ${missing.length} missing cards is an unexpectedly large delta`);
        await syncMain(missing, trigger, summary.total);
      }
    }
    state.cards.finishedAt = new Date().toISOString();
  } catch (e) {
    state.cards.error = e.message || String(e);
  } finally {
    state.cards.isScraping = false;
  }
}

async function scrapeEventsAndSync(trigger) {
  if (state.events.isScraping) return { skipped: true, reason: 'event sync already running' };
  state.events.isScraping = true; state.events.startedAt = new Date().toISOString(); state.events.error = null; state.events.lastDelta = 0; state.lastSourceCheckAt = new Date().toISOString();
  try {
    const summaryScraper = new ShoobEventScraper();
    const summary = await summaryScraper.fetchSummary();
    state.events.expected = summary.total; state.events.sourceTotal = summary.total;
    const dbRows = await readAllRows('event_cards', 'id,event_slug');
    const dbByEvent = new Map(); const existingKeys = new Set();
    for (const row of dbRows) {
      const slug = String(row.event_slug);
      dbByEvent.set(slug, (dbByEvent.get(slug) || 0) + 1);
      existingKeys.add(`${slug}:${String(row.id)}`);
    }
    const allMatch = Object.entries(summary.byEvent).every(([slug, total]) => (dbByEvent.get(slug) || 0) === total) &&
      Object.keys(Object.fromEntries(dbByEvent)).every(slug => Object.prototype.hasOwnProperty.call(summary.byEvent, slug));
    if (allMatch) {
      if (state.events.storage !== 'available') await rebuildEventStorage();
      await recordNoopRun('events', trigger, summary.total, dbRows.length, { byEvent: summary.byEvent });
      await updateCatalogState('events', { last_checked_at: new Date().toISOString(), status: 'ready', last_error: null }, { trigger, mode: 'per-event-count-match', sourceTotal: summary.total, byEvent: summary.byEvent });
      state.events.count = dbRows.length; state.events.error = null; state.events.countsMatch = true;
    } else {
      const scraper = new ShoobEventScraper({ existingKeys });
      const missing = await scraper.fetchAll();
      state.events.expected = summary.total;
      if (!missing.length) {
        const note = 'Per-event source and database counts differ, but no missing event/card pairs were found.';
        await recordNoopRun('events', trigger, summary.total, dbRows.length, { mode: 'count-mismatch-no-missing-ids', warning: note, byEvent: summary.byEvent });
        await updateCatalogState('events', { last_checked_at: new Date().toISOString(), status: 'ready', last_error: note }, { trigger, sourceTotal: summary.total, databaseCount: dbRows.length, warning: note, byEvent: summary.byEvent });
        state.events.count = dbRows.length; state.events.countsMatch = false;
      } else {
        if (dbRows.length > 0 && missing.length > Math.max(2000, summary.total * 0.5)) throw new Error(`Safety stop: ${missing.length} missing event-card pairs is an unexpectedly large delta`);
        await syncEvents(missing, trigger, scraper, summary.total);
      }
    }
    state.events.menuChecked = summary.menuChecked;
    state.events.unknownEvents = summary.unknownEvents || [];
    state.events.finishedAt = new Date().toISOString();
  } catch (e) {
    state.events.error = e.message || String(e);
    const unknownMatch = state.events.error.match(/New (?:Shoob|ZCard) event\(s\) need to be added before syncing: (.+)$/);
    if (unknownMatch) {
      state.events.menuChecked = true;
      state.events.unknownEvents = unknownMatch[1].split(',').map(x => x.trim()).filter(Boolean);
    } else if (/event menu could not be verified/i.test(state.events.error)) {
      state.events.menuChecked = false; state.events.menuError = state.events.error;
    }
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
  if (!supabase) { state.supabaseReachable = false; state.supabaseError = 'Missing env vars'; state.lastMonitorOk = false; return; }
  try {
    const { error } = await supabase.from('catalog_state').select('catalog').limit(1);
    if (error) throw error;
    state.supabaseReachable = true; state.supabaseError = null; state.lastMonitorOk = true;
    const [main, events] = await Promise.all([hasCatalog('cards', 'cards'), hasCatalog('events', 'event_cards')]);
    state.cards.count = main.dbCount; state.cards.storage = main.storageExists ? 'available' : 'missing';
    state.cards.lastSyncAt = main.stateRow?.last_synced_at || state.cards.lastSyncAt;
    state.cards.sourceTotal = main.stateRow?.metadata?.sourceTotal ?? state.cards.sourceTotal;
    state.events.count = events.dbCount; state.events.storage = events.storageExists ? 'available' : 'missing';
    state.events.lastSyncAt = events.stateRow?.last_synced_at || state.events.lastSyncAt;
    state.events.sourceTotal = events.stateRow?.metadata?.sourceTotal ?? state.events.sourceTotal;
    void startPreviewBackfillIfNeeded();
    if (!main.present && !state.cards.isScraping) void scrapeMainAndSync('startup-recovery');
    if (!events.present && !state.events.isScraping) void scrapeEventsAndSync('startup-recovery');
  } catch (e) {
    state.supabaseReachable = false; state.supabaseError = e.message || String(e); state.lastMonitorOk = false;
  }
}

function lagosClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LAGOS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function lagosHourSlot(date = new Date()) { const p = lagosClockParts(date); return `${p.year}-${p.month}-${p.day} ${p.hour}:00`; }
function nextLagosHourIso(date = new Date()) { const p = lagosClockParts(date); return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), 0, 0, 0)).toISOString(); }

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
  if (!supabase) throw new Error('Supabase is not configured');
  if (retentionPromise) return retentionPromise;
  retentionPromise = (async () => {
    const startedAt = new Date().toISOString(); const cutoffIso = new Date(Date.now() - RETENTION_MS).toISOString();
    state.retention.lastRunAt = startedAt;
    try {
      const systemLogsDeleted = await deleteOldRowsInBatches('system_logs', 'timestamp', cutoffIso);
      const syncRunsDeleted = await deleteOldRowsInBatches('sync_runs', 'started_at', cutoffIso);
      state.retention.systemLogsDeleted = systemLogsDeleted; state.retention.syncRunsDeleted = syncRunsDeleted;
      state.retention.lastSuccessAt = new Date().toISOString(); state.retention.lastError = null;
      return { systemLogsDeleted, syncRunsDeleted };
    } catch (error) {
      state.retention.lastError = error?.message || String(error); throw error;
    }
  })().finally(() => { retentionPromise = null; });
  return retentionPromise;
}

let selfPingPromise = null; let selfPingHasWarned = false;
async function selfPingOnce() {
  const baseUrl = String(process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) { if (!selfPingHasWarned) { selfPingHasWarned = true; } return; }
  if (selfPingPromise) return selfPingPromise;
  selfPingPromise = (async () => {
    const url = /\/ping$/i.test(baseUrl) ? baseUrl : `${baseUrl}/ping`;
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000);
    state.selfPing.lastAttemptAt = new Date().toISOString();
    try {
      const response = await fetch(url, { method: 'GET', signal: controller.signal, headers: { 'user-agent': 'ZCard-Control-Room-self-ping' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.selfPing.lastSuccessAt = new Date().toISOString(); state.selfPing.lastError = null;
    } catch (error) {
      state.selfPing.lastError = error?.message || String(error);
    } finally { clearTimeout(timeout); selfPingPromise = null; }
  })();
  return selfPingPromise;
}

let schedulerPromise = null;
async function schedulerTick() {
  if (schedulerPromise) return schedulerPromise;
  const slot = lagosHourSlot(); state.nextSourceCheckAt = nextLagosHourIso();
  if (state.scheduler.lastSlotSucceeded === slot) return;
  const retryAt = state.scheduler.retryAt ? Date.parse(state.scheduler.retryAt) : 0;
  if (state.scheduler.lastSlotAttempted === slot && retryAt > Date.now()) return;
  if (syncPromise || state.cards.isScraping || state.events.isScraping) return;
  schedulerPromise = (async () => {
    state.scheduler.lastSlotAttempted = slot; state.scheduler.lastCheckStatus = 'running'; state.scheduler.lastCheckError = null;
    try {
      await sourceCheck(`scheduled-hourly-${slot}`);
      const failures = [state.cards.error && `cards: ${state.cards.error}`, state.events.error && `events: ${state.events.error}`].filter(Boolean);
      if (failures.length) throw new Error(failures.join(' | '));
      state.scheduler.lastSlotSucceeded = slot; state.scheduler.lastCheckStatus = 'success'; state.scheduler.retryAt = null;
    } catch (error) {
      state.scheduler.lastCheckStatus = 'failed'; state.scheduler.lastCheckError = error?.message || String(error);
      state.scheduler.retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    }
  })().finally(() => { schedulerPromise = null; });
  return schedulerPromise;
}

async function sourceCheck(trigger = 'scheduled-hourly') {
  if (syncPromise) return syncPromise;
  if (state.cards.isScraping || state.events.isScraping) throw new Error('Source check deferred');
  syncPromise = (async () => {
    state.lastSourceCheckAt = new Date().toISOString(); state.nextSourceCheckAt = nextLagosHourIso();
    await Promise.all([scrapeMainAndSync(trigger), scrapeEventsAndSync(trigger)]);
    const failures = [state.cards.error && `cards: ${state.cards.error}`, state.events.error && `events: ${state.events.error}`].filter(Boolean);
    if (failures.length) throw new Error(failures.join(' | '));
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

// -----------------------------------------------------------------------------
// Public health and status endpoints
// -----------------------------------------------------------------------------

app.get(['/api/health', '/ping'], (req, res) => {
  const healthy = !!supabase && state.supabaseReachable;
  res.status(healthy ? 200 : 503).json({
    ok: healthy, service: 'ZCard Control Room', supabaseConfigured, supabaseReachable: state.supabaseReachable,
    activeJobs: { cards: state.cards.isScraping, events: state.events.isScraping }, uptime: formatUptime(Math.floor(process.uptime())),
    node: process.version, timestamps: getTimestamps(),
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true, uptime: formatUptime(Math.floor(process.uptime())), timestamps: getTimestamps(), ...state,
    memory: { rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1), heapMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) },
    logBuffer: { max: logger.MAX_LOGS, current: logger.list({ limit: logger.MAX_LOGS }).length },
    monitorIntervalMs: MONITOR_MS, schedulerPollIntervalMs: SCHEDULER_POLL_MS, sourceCheckIntervalMs: SHOOB_CHECK_MS,
    selfPingIntervalMs: SELF_PING_MS, retentionDays: 7, retentionCleanupIntervalMs: RETENTION_CLEANUP_MS, stats: stats.snapshot(),
  });
});

app.post('/api/admin/login', (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ ok: false, error: 'ADMIN_KEY is not configured' });
  if (!safeEqual(String(req.body?.key || ''), process.env.ADMIN_KEY)) return res.status(401).json({ ok: false, error: 'Invalid admin key' });
  return res.json({ ok: true, message: 'Authenticated.' });
});

app.get('/api/admin/status', requireAdmin, (req, res) => {
  res.json({
    ok: true, uptime: formatUptime(Math.floor(process.uptime())), timestamps: getTimestamps(), ...state,
    memory: { rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1), heapMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) },
    logBuffer: { max: logger.MAX_LOGS, current: logger.list({ limit: logger.MAX_LOGS }).length },
  });
});

app.get('/api/admin/logs', requireAdmin, (req, res) => res.json({ ok: true, max: logger.MAX_LOGS, logs: logger.list({ limit: req.query.limit, level: req.query.level, search: req.query.search }) }));

app.get('/api/admin/logs/download', requireAdmin, (req, res) => {
  const format = ['json', 'txt', 'html'].includes(String(req.query.format)) ? String(req.query.format) : 'json';
  const logs = logger.list({ limit: logger.MAX_LOGS, level: req.query.level, search: req.query.search });
  let body, type;
  if (format === 'txt') {
    type = 'text/plain; charset=utf-8';
    body = logs.map(x => `${x.timestamp} [${x.level}] [${x.component}] ${x.message} ${JSON.stringify(x.details)}`).join('\n');
  } else if (format === 'html') {
    type = 'text/html; charset=utf-8';
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    body = `<!doctype html><meta charset="utf-8"><title>ZCard Logs</title><style>body{font:14px system-ui;background:#0b1020;color:#e8edff;padding:24px}article{padding:12px;margin:8px 0;border:1px solid #29334e;border-radius:10px}small{color:#9ba8c7}pre{white-space:pre-wrap}</style><h1>ZCard logs (${logs.length})</h1>` +
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
  if ((target === 'cards' || target === 'both') && state.cards.isScraping) return res.status(409).json({ ok: false, error: 'Main-card check is already running.' });
  if ((target === 'events' || target === 'both') && state.events.isScraping) return res.status(409).json({ ok: false, error: 'Event check is already running.' });
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase is not configured.' });
  if (target === 'cards' || target === 'both') void scrapeMainAndSync('manual-admin');
  if (target === 'events' || target === 'both') void scrapeEventsAndSync('manual-admin');
  res.status(202).json({ ok: true, message: 'Incremental check queued.', catalog: target, mode: 'incremental' });
});

const MAX_DELETE_IDS = 500; const DELETE_CHUNK_SIZE = 100;
function cleanDeleteIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = new Set();
  for (const value of raw) {
    if (typeof value === 'number' && Number.isFinite(value)) out.add(String(value));
    else if (typeof value === 'string' && value.length > 0 && value.length <= 100) out.add(value);
  }
  return [...out];
}
function isMissingTableError(error) { return /does not exist|schema cache/i.test(error?.message || ''); }
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
  } catch (error) { error.partialDeleted = deleted; throw error; }
  return deleted;
}
async function deleteFromDatabase(table, options) {
  if (!supabase) return { status: 'skipped', deleted: 0, reason: 'Supabase is not configured' };
  try { return { status: 'ok', deleted: await deleteRows(table, options) }; }
  catch (error) {
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
  if (reportSkipped && !all && dbResult?.status === 'ok' && requested > dbResult.deleted) parts.push(`${requested - dbResult.deleted} kept`);
  const message = failed.length ? `Delete finished with errors: ${parts.join(' · ')}` : `Deleted ${scope}: ${parts.join(' · ')}`;
  logger.log(everythingFailed ? 'ERROR' : failed.length ? 'WARN' : 'SUCCESS', component, message, { requested: all ? 'all' : requested, results, actorIp: req.ip || null });
  return res.status(everythingFailed ? 502 : failed.length ? 207 : 200).json({
    ok: failed.length === 0, partial: failed.length > 0 && !everythingFailed, message,
    error: failed.length ? message : undefined, requested: all ? 'all' : requested, results,
  });
}

app.post('/api/admin/logs/delete', requireAdmin, async (req, res) => {
  const all = req.body?.all === true;
  const ids = all ? null : cleanDeleteIds(req.body?.ids);
  if (!all && !ids.length) return res.status(400).json({ ok: false, error: 'Send ids or all: true' });
  if (!all && ids.length > MAX_DELETE_IDS) return res.status(400).json({ ok: false, error: `Select at most ${MAX_DELETE_IDS} logs` });
  let memory;
  try { memory = { status: 'ok', deleted: all ? logger.clear() : logger.removeByIds(ids) }; }
  catch (error) { memory = { status: 'failed', deleted: 0, error: error?.message || String(error) }; }
  const database = await deleteFromDatabase(LOG_TABLE, { ids });
  return finishDeletion(req, res, { noun: 'log', component: 'log-admin', all, requested: all ? null : ids.length, results: { memory, database } });
});

app.post('/api/admin/sync-runs/delete', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  const all = req.body?.all === true;
  const ids = all ? null : cleanDeleteIds(req.body?.ids);
  if (!all && !ids.length) return res.status(400).json({ ok: false, error: 'Send ids or all: true' });
  if (!all && ids.length > MAX_DELETE_IDS) return res.status(400).json({ ok: false, error: `Select at most ${MAX_DELETE_IDS} sync runs` });
  const database = await deleteFromDatabase('sync_runs', { ids, protectRunning: true });
  return finishDeletion(req, res, { noun: 'sync run', component: 'sync-admin', all, requested: all ? null : ids.length, results: { database }, reportSkipped: true });
});

app.post('/api/internal/logs', requireInternalOrAdmin, (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [req.body];
  for (const item of events) logger.log(item?.level || 'INFO', `vercel:${item?.component || 'app'}`, item?.message || 'Vercel event', item?.details || {});
  res.json({ ok: true, accepted: events.length });
});

// -----------------------------------------------------------------------------
// PROTECTED PUBLIC ENDPOINTS (API Key Required)
// -----------------------------------------------------------------------------

app.get('/api/stats', requireApiKey, stats.handler);
app.get('/api/stats/recent', requireApiKey, stats.recentHandler);

// Full catalogue downloads. Only the two documented names are accepted.
app.get('/api/download', requireApiKey, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog storage unavailable' });
  const file = String(req.query.file || '').toLowerCase();
  if (!['cards', 'events'].includes(file)) {
    return res.status(400).json({ ok: false, error: 'Invalid file parameter. Use file=cards or file=events.', usage: '/api/download?file=cards&key=YOUR_KEY' });
  }
  const filename = `${file}.json`;
  try {
    const bucket = supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || 'shoob-catalogs');
    const { data, error } = await bucket.download(filename);
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: `${filename} is not available yet.` });
    const buffer = Buffer.from(await data.arrayBuffer());
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(200).send(buffer);
  } catch (error) {
    logger.log('ERROR', 'download', 'Full catalogue download failed', { file, error: String(error?.message || error).slice(0, 300) });
    return res.status(502).json({ ok: false, error: `Could not download ${filename} from catalogue storage.` });
  }
});

app.get('/api/cards', requireApiKey, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });
  const limit = Math.min(100, parsePositiveInt(req.query.limit, 20));
  const page = parsePositiveInt(req.query.page, 1);
  const filters = getSearchFilters(req);
  const includeBreakdown = req.query.byseries === 'true' || req.query.byseries === '1';
  const buildFilteredQuery = query => applyCardFilters(query, filters);
  const startTime = Date.now();
  const filtersEcho = {
    tier: filters.tier || null, series: filters.series || null, search: filters.search || null,
    sort: ['name', 'tier', 'series'].includes(String(req.query.sort)) ? String(req.query.sort) : 'name',
    order: String(req.query.order).toLowerCase() === 'desc' ? 'desc' : 'asc',
  };
  try {
    const { count, error: countErr } = await buildFilteredQuery(supabase.from('cards').select('id', { count: 'exact', head: true }));
    if (countErr) throw countErr;
    const safeCount = count || 0; const pages = Math.ceil(safeCount / limit); const safeStart = (page - 1) * limit;
    if (safeCount === 0 || safeStart >= safeCount) {
      const uniqueData = safeCount === 0 ? { uniqueCount: 0, breakdown: includeBreakdown ? {} : null } : await getUniqueCounts('cards', 'series', buildFilteredQuery, includeBreakdown);
      const emptyResponse = { ok: true, count: safeCount, series_count: uniqueData.uniqueCount, page, limit, pages, filters: filtersEcho, durationMs: Date.now() - startTime, timestamps: getTimestamps(), data: [] };
      if (includeBreakdown) emptyResponse.bySeries = uniqueData.breakdown;
      return res.json(emptyResponse);
    }
    const safeEnd = Math.min(page * limit - 1, safeCount - 1);
    const sortedQuery = applySort(buildFilteredQuery(supabase.from('cards').select('*')), req.query.sort, req.query.order, ['name', 'tier', 'series']);
    const [result, uniqueData] = await Promise.all([sortedQuery.range(safeStart, safeEnd), getUniqueCounts('cards', 'series', buildFilteredQuery, includeBreakdown)]);
    if (result.error) throw result.error;
    const response = { ok: true, count: safeCount, series_count: uniqueData.uniqueCount, page, limit, pages, filters: filtersEcho, durationMs: Date.now() - startTime, timestamps: getTimestamps(), data: result.data || [] };
    if (includeBreakdown) response.bySeries = uniqueData.breakdown;
    return res.json(response);
  } catch (error) {
    return res.status(502).json({ ok: false, error: 'Catalog query failed', details: error?.details || error?.hint || error?.message });
  }
});

app.get('/api/events', requireApiKey, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });
  const limit = Math.min(100, parsePositiveInt(req.query.limit, 20));
  const page = parsePositiveInt(req.query.page, 1);
  const filters = getSearchFilters(req);
  const eventSlug = req.query.event ? String(req.query.event).trim().slice(0, 80) : '';
  const includeBreakdown = req.query.byevent === 'true' || req.query.byevent === '1' || req.query.byseries === 'true' || req.query.byseries === '1';
  const buildFilteredQuery = query => { query = applyCardFilters(query, filters); if (eventSlug) query = query.eq('event_slug', eventSlug); return query; };
  const startTime = Date.now();
  const filtersEcho = {
    event: eventSlug || null, tier: filters.tier || null, series: filters.series || null, search: filters.search || null,
    sort: ['name', 'tier', 'series', 'event_slug'].includes(String(req.query.sort)) ? String(req.query.sort) : 'name',
    order: String(req.query.order).toLowerCase() === 'desc' ? 'desc' : 'asc',
  };
  try {
    const { count, error: countErr } = await buildFilteredQuery(supabase.from('event_cards').select('id', { count: 'exact', head: true }));
    if (countErr) throw countErr;
    const safeCount = count || 0; const pages = Math.ceil(safeCount / limit); const safeStart = (page - 1) * limit;
    if (safeCount === 0 || safeStart >= safeCount) {
      const uniqueData = safeCount === 0 ? { uniqueCount: 0, breakdown: includeBreakdown ? {} : null } : await getUniqueCounts('event_cards', 'event_slug', buildFilteredQuery, includeBreakdown);
      const emptyResponse = { ok: true, count: safeCount, event_count: uniqueData.uniqueCount, page, limit, pages, filters: filtersEcho, durationMs: Date.now() - startTime, timestamps: getTimestamps(), data: [] };
      if (includeBreakdown) emptyResponse.byEvent = uniqueData.breakdown;
      return res.json(emptyResponse);
    }
    const safeEnd = Math.min(page * limit - 1, safeCount - 1);
    const sortedQuery = applySort(buildFilteredQuery(supabase.from('event_cards').select('*')), req.query.sort, req.query.order, ['name', 'tier', 'series', 'event_slug']);
    const [result, uniqueData] = await Promise.all([sortedQuery.range(safeStart, safeEnd), getUniqueCounts('event_cards', 'event_slug', buildFilteredQuery, includeBreakdown)]);
    if (result.error) throw result.error;
    const response = { ok: true, count: safeCount, event_count: uniqueData.uniqueCount, page, limit, pages, filters: filtersEcho, durationMs: Date.now() - startTime, timestamps: getTimestamps(), data: result.data || [] };
    if (includeBreakdown) response.byEvent = uniqueData.breakdown;
    return res.json(response);
  } catch (error) {
    return res.status(502).json({ ok: false, error: 'Event query failed', details: error?.details || error?.hint || error?.message });
  }
});

app.get('/api/random', requireApiKey, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });
  const filters = getSearchFilters(req);
  const buildFilteredQuery = query => applyCardFilters(query, filters);
  const startTime = Date.now();
  const filtersEcho = { tier: filters.tier || null, series: filters.series || null, search: filters.search || null };
  try {
    const { count, error: countError } = await buildFilteredQuery(supabase.from('cards').select('id', { count: 'exact', head: true }));
    if (countError) throw countError;
    const safeCount = count || 0;
    if (safeCount === 0) return res.status(404).json({ ok: false, error: 'No cards match the provided filters', filters: filtersEcho, durationMs: Date.now() - startTime, timestamps: getTimestamps() });
    const offset = crypto.randomInt(0, safeCount);
    const { data, error } = await buildFilteredQuery(supabase.from('cards').select('*')).range(offset, offset).maybeSingle();
    if (error || !data) throw error || new Error('No data returned');
    res.json({ ok: true, pool_size: safeCount, filters: filtersEcho, durationMs: Date.now() - startTime, timestamps: getTimestamps(), data });
  } catch (error) {
    return res.status(502).json({ ok: false, error: 'Random card query failed', details: error?.details || error?.hint || error?.message });
  }
});

app.get('/api/series', requireApiKey, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });
  const eventSlug = req.query.event ? String(req.query.event).trim().slice(0, 80) : '';
  const startTime = Date.now();
  const table = eventSlug ? 'event_cards' : 'cards';
  const column = 'series';
  const applyFilters = (query) => { if (eventSlug) query = query.eq('event_slug', eventSlug); return query; };
  try {
    const { uniqueCount, breakdown } = await getUniqueCounts(table, column, applyFilters, true);
    res.json({ ok: true, total_series: uniqueCount, event: eventSlug || null, source_table: table, series: breakdown || {}, durationMs: Date.now() - startTime, timestamps: getTimestamps() });
  } catch (error) {
    return res.status(502).json({ ok: false, error: 'Series query failed', details: error?.details || error?.hint || error?.message });
  }
});

// -----------------------------------------------------------------------------
// GET /api/link — resolve a Shoob card link to its final CDN media URL
// BEGIN /api/link
// -----------------------------------------------------------------------------

const SHOOB_API_HOST = 'api.shoob.gg';
const SHOOB_PAGE_HOSTS = new Set(['shoob.gg', 'www.shoob.gg']);
const SHOOB_MEDIA_HOSTS = new Set(['cdn.shoob.gg']); // hosts we accept as the final file location
const SHOOB_CARD_ID_RE = /^[0-9a-f]{24}$/i;
const SHOOB_CARDR_PATH_RE = /^\/site\/api\/cardr\/([0-9a-f]{24})\/?$/i;
const LINK_TIMEOUT_MS = 10_000;
const LINK_CACHE_TTL_MS = 10 * 60 * 1000;
const LINK_CACHE_MAX = 500;
const LINK_RATE_WINDOW_MS = 60_000;
const LINK_RATE_MAX = 30; // uncached lookups per IP per minute (protects your server's IP with Shoob)
const LINK_USER_AGENT = 'Mozilla/5.0 (compatible; ZCard-Control-Room/1.0)';

const LINK_MEDIA_TYPES = {
  mp4: { media: 'video', mime: 'video/mp4' },
  webm: { media: 'video', mime: 'video/webm' },
  gif: { media: 'image', mime: 'image/gif' },
  png: { media: 'image', mime: 'image/png' },
  jpg: { media: 'image', mime: 'image/jpeg' },
  jpeg: { media: 'image', mime: 'image/jpeg' },
  webp: { media: 'image', mime: 'image/webp' },
};

const linkCache = new Map(); // "<id>|<size>" -> { value, expires }
const linkRate = new Map();  // ip -> { count, resetAt }

function linkError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Strictly parse a user-supplied Shoob URL. Returns null when it is not one.
// The host is compared EXACTLY after URL parsing, so lookalikes such as
// https://shoob.gg.evil.com, https://evil.com/?shoob.gg or https://shoob.gg@evil.com all fail.
// The outgoing request is always rebuilt from the validated pieces, never from the raw input.
function parseShoobUrl(raw) {
  if (typeof raw !== 'string') return null;
  const input = raw.trim();
  if (!input || input.length > 2048) return null;
  let u;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();

  if (host === SHOOB_API_HOST) {
    const m = SHOOB_CARDR_PATH_RE.exec(u.pathname);
    if (!m) return null;
    const sizeRaw = u.searchParams.get('size');
    const size = sizeRaw && /^\d{1,4}$/.test(sizeRaw) && Number(sizeRaw) > 0 ? Number(sizeRaw) : null;
    return { kind: 'card', id: m[1].toLowerCase(), size };
  }
  if (SHOOB_PAGE_HOSTS.has(host)) {
    const id = u.pathname.split('/').find(seg => SHOOB_CARD_ID_RE.test(seg));
    if (!id) return null;
    return { kind: 'card', id: id.toLowerCase(), size: null };
  }
  if (SHOOB_MEDIA_HOSTS.has(host)) {
    return { kind: 'media', url: `https://${host}${u.pathname}${u.search}` };
  }
  return null;
}

function describeMedia(mediaUrl) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(mediaUrl).pathname);
  const ext = m ? m[1].toLowerCase() : null;
  const info = ext ? LINK_MEDIA_TYPES[ext] : null;
  return { type: ext || 'unknown', media: info ? info.media : 'unknown', mime: info ? info.mime : null };
}

function linkCacheGet(key) {
  const hit = linkCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) { linkCache.delete(key); return null; }
  return hit.value;
}

function linkCacheSet(key, value) {
  if (linkCache.size >= LINK_CACHE_MAX) linkCache.delete(linkCache.keys().next().value);
  linkCache.set(key, { value, expires: Date.now() + LINK_CACHE_TTL_MS });
}

// Returns 0 when allowed, otherwise the number of seconds to wait.
function linkRateCheck(ip) {
  const now = Date.now();
  if (linkRate.size > 2000) {
    for (const [k, v] of linkRate) if (v.resetAt <= now) linkRate.delete(k);
  }
  const entry = linkRate.get(ip);
  if (!entry || entry.resetAt <= now) {
    linkRate.set(ip, { count: 1, resetAt: now + LINK_RATE_WINDOW_MS });
    return 0;
  }
  if (entry.count >= LINK_RATE_MAX) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  entry.count += 1;
  return 0;
}

// Ask Shoob where a card image lives. Redirects are NOT followed: we only read the
// Location header (like `curl` without -L) and never download the image.
async function resolveShoobCard(id, size) {
  const target = `https://${SHOOB_API_HOST}/site/api/cardr/${id}${size ? `?size=${size}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': LINK_USER_AGENT, accept: '*/*' },
    });
    try { await response.body?.cancel(); } catch { /* ignore */ }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw linkError(502, 'Shoob redirected without a target');
      let finalUrl;
      try { finalUrl = new URL(location, target); } catch { throw linkError(502, 'Shoob returned an invalid redirect'); }
      if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password || finalUrl.port ||
          !SHOOB_MEDIA_HOSTS.has(finalUrl.hostname.toLowerCase())) {
        throw linkError(502, 'Shoob redirected to an unexpected host');
      }
      return finalUrl.toString();
    }
    if (response.status === 404) throw linkError(404, 'Card not found on Shoob');
    if (response.status === 200) throw linkError(502, 'Shoob did not return a redirect');
    throw linkError(502, `Shoob responded with HTTP ${response.status}`);
  } catch (error) {
    if (error && error.status) throw error;
    if (error && error.name === 'AbortError') throw linkError(504, 'Shoob request timed out');
    throw linkError(502, 'Could not reach Shoob');
  } finally {
    clearTimeout(timer);
  }
}

// Persistent preview-link backfill. Progress lives in catalog_state.metadata so it survives Render restarts.
const PREVIEW_BACKFILL_BATCH = 100;
const PREVIEW_BACKFILL_CONCURRENCY = 3;
let previewBackfillPromise = null;
let previewBackfillStartedThisProcess = false;

async function mapWithConcurrency(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function sourceCardUrl(row) {
  const candidate = row?.image_url;
  const parsed = parseShoobUrl(candidate);
  if (parsed?.kind === 'card') return { id: parsed.id, size: parsed.size || 700 };
  if (parsed?.kind === 'media') return { directUrl: parsed.url };
  if (SHOOB_CARD_ID_RE.test(String(row?.id || ''))) return { id: String(row.id), size: 700 };
  return null;
}

async function resolveAndSavePreview(catalog, row, { backfill = false } = {}) {
  const table = catalog === 'cards' ? 'cards' : 'event_cards';
  const label = catalog === 'events' ? { event: row.event_slug || 'unknown' } : {};
  const already = typeof row.preview_link === 'string' && row.preview_link.startsWith('https://cdn.shoob.gg/');
  if (already) return { ok: true, cached: true, skipped: true };
  const source = sourceCardUrl(row);
  if (!source) {
    logger.log('WARN', 'preview-link', 'Preview link skipped: no valid Shoob source URL or card ID', { catalog, cardId: row.id, ...label, backfill });
    return { ok: false, reason: 'invalid_source_url' };
  }
  try {
    const url = source.directUrl || await resolveShoobCard(source.id, source.size || 700);
    const info = describeMedia(url);
    if (!info.mime) throw new Error('Resolved URL has an unsupported media extension');
    const { error } = await supabase.from(table).update({ preview_link: url }).eq('id', String(row.id));
    if (error) throw error;
    logger.log('SUCCESS', 'preview-link', 'Preview link resolved and saved', {
      catalog, cardId: String(row.id), ...label, type: info.type, media: info.media, cached: false, backfill,
    });
    return { ok: true, url, type: info.type };
  } catch (error) {
    logger.log('WARN', 'preview-link', 'Preview link resolution failed; card retained and may be retried', {
      catalog, cardId: String(row.id), ...label, reason: String(error?.message || error).slice(0, 300), retryable: true, backfill,
    });
    return { ok: false, reason: String(error?.message || error) };
  }
}

async function persistBackfillState(catalog, patch) {
  const current = await readCatalogMetadata(catalog);
  const prior = current.preview_link_backfill && typeof current.preview_link_backfill === 'object' ? current.preview_link_backfill : {};
  const next = { ...prior, ...patch, updated_at: new Date().toISOString() };
  await updateCatalogState(catalog, {}, { preview_link_backfill: next });
  state.previewLinkBackfill[catalog] = {
    status: next.status || 'waiting', completed: next.completed === true,
    processed: Number(next.processed || 0), succeeded: Number(next.succeeded || 0), failed: Number(next.failed || 0),
    cursor: next.cursor || null, startedAt: next.started_at || null, finishedAt: next.finished_at || null, lastError: next.last_error || null,
  };
  return next;
}

async function runPreviewBackfillForCatalog(catalog) {
  const table = catalog === 'cards' ? 'cards' : 'event_cards';
  let metadata = await readCatalogMetadata(catalog);
  let job = metadata.preview_link_backfill || {};
  if (job.completed === true) {
    state.previewLinkBackfill[catalog] = {
      status: 'completed', completed: true, processed: Number(job.processed || 0), succeeded: Number(job.succeeded || 0),
      failed: Number(job.failed || 0), cursor: job.cursor || null, startedAt: job.started_at || null, finishedAt: job.finished_at || null, lastError: null,
    };
    logger.log('INFO', 'preview-link', 'One-time preview-link backfill already completed; skipping', { catalog, processed: Number(job.processed || 0), failed: Number(job.failed || 0) });
    return;
  }

  const startedAt = job.started_at || new Date().toISOString();
  let processed = Number(job.processed || 0);
  let succeeded = Number(job.succeeded || 0);
  let failed = Number(job.failed || 0);
  let cursor = job.cursor || null;
  await persistBackfillState(catalog, { status: 'running', completed: false, started_at: startedAt, finished_at: null, processed, succeeded, failed, cursor, last_error: null });
  logger.log('INFO', 'preview-link', 'One-time preview-link backfill started/resumed', { catalog, processed, succeeded, failed, cursor, batchSize: PREVIEW_BACKFILL_BATCH, concurrency: PREVIEW_BACKFILL_CONCURRENCY });

  try {
    for (;;) {
      const columns = catalog === 'events' ? 'id,image_url,preview_link,event_slug' : 'id,image_url,preview_link';
      let query = supabase.from(table).select(columns).order('id', { ascending: true }).limit(PREVIEW_BACKFILL_BATCH);
      if (cursor) query = query.gt('id', cursor);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data || [];
      if (!rows.length) break;
      let batchSucceeded = 0;
      let batchFailed = 0;
      await mapWithConcurrency(rows, PREVIEW_BACKFILL_CONCURRENCY, async row => {
        if (typeof row.preview_link === 'string' && row.preview_link.startsWith('https://cdn.shoob.gg/')) {
          batchSucceeded++;
          return;
        }
        const result = await resolveAndSavePreview(catalog, row, { backfill: true });
        if (result.ok) batchSucceeded++;
        else batchFailed++;
      });
      processed += rows.length;
      succeeded += batchSucceeded;
      failed += batchFailed;
      cursor = String(rows[rows.length - 1].id);
      await persistBackfillState(catalog, { status: 'running', completed: false, started_at: startedAt, processed, succeeded, failed, cursor, last_error: null });
      logger.log('INFO', 'preview-link', 'Preview-link backfill progress', { catalog, processed, succeeded, failed, lastCardId: cursor, batchSize: rows.length });
    }

    // Publish the populated preview_link values into the downloadable JSON snapshot before marking done.
    if (catalog === 'cards') await rebuildMainStorage();
    else await rebuildEventStorage();
    const finishedAt = new Date().toISOString();
    await persistBackfillState(catalog, { status: failed ? 'completed_with_failures' : 'completed', completed: true, started_at: startedAt, finished_at: finishedAt, processed, succeeded, failed, cursor, last_error: null });
    logger.log(failed ? 'WARN' : 'SUCCESS', 'preview-link', 'One-time preview-link backfill finished', {
      catalog, completed: true, processed, succeeded, failed, startedAt, finishedAt,
      note: failed ? 'Scan completed; unresolved records remain blank and are not automatically rescanned by this one-time job.' : 'All scanned records have a saved preview link or were already resolved.',
    });
  } catch (error) {
    await persistBackfillState(catalog, { status: 'failed', completed: false, started_at: startedAt, processed, succeeded, failed, cursor, last_error: String(error?.message || error).slice(0, 500) }).catch(() => {});
    logger.log('ERROR', 'preview-link', 'Preview-link backfill interrupted; it will resume after restart', { catalog, processed, succeeded, failed, cursor, error: String(error?.message || error).slice(0, 300) });
    throw error;
  }
}

async function startPreviewBackfillIfNeeded() {
  if (!supabase || !state.supabaseReachable || previewBackfillPromise || previewBackfillStartedThisProcess) return;
  previewBackfillStartedThisProcess = true;
  previewBackfillPromise = (async () => {
    for (const catalog of ['cards', 'events']) {
      await runPreviewBackfillForCatalog(catalog);
    }
  })().catch(error => {
    logger.log('ERROR', 'preview-link', 'Preview-link backfill runner stopped; a later restart will resume it', { error: String(error?.message || error).slice(0, 300) });
    // Keep this process from repeatedly restarting a failed job every monitor tick. A Render restart resumes it.
  }).finally(() => { previewBackfillPromise = null; });
  return previewBackfillPromise;
}

// Admin-only repair endpoint for records whose preview_link is null, empty, or whitespace.
// Dry-run is the default. Mutations require { confirm: true } in the POST body.
let previewRepairRunning = false;
const PREVIEW_REPAIR_CONCURRENCY = 3;
const PREVIEW_REPAIR_SCAN_BATCH = 1000;

async function findMissingPreviewRows(catalog, limit = 100) {
  const table = catalog === 'events' ? 'event_cards' : 'cards';
  const columns = catalog === 'events' ? 'id,name,image_url,preview_link,event_slug' : 'id,name,image_url,preview_link';
  const matches = [];
  let offset = 0;
  for (;;) {
    let query = supabase.from(table).select(columns).order('id', { ascending: true }).range(offset, offset + PREVIEW_REPAIR_SCAN_BATCH - 1);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      if (typeof row.preview_link !== 'string' || !row.preview_link.trim()) {
        matches.push(row);
        if (matches.length >= limit) return { rows: matches, scanned: offset + rows.length, capped: true };
      }
    }
    offset += rows.length;
    if (rows.length < PREVIEW_REPAIR_SCAN_BATCH) break;
  }
  return { rows: matches, scanned: offset, capped: false };
}

app.post('/api/admin/preview-links/repair', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase is not configured.' });
  if (previewRepairRunning) return res.status(409).json({ ok: false, error: 'A preview-link repair is already running.' });

  const requested = String(req.body?.catalog || 'both').toLowerCase();
  if (!['cards', 'events', 'both'].includes(requested)) {
    return res.status(400).json({ ok: false, error: 'catalog must be cards, events, or both.' });
  }
  const rawLimit = Number(req.body?.limit ?? 100);
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
  const dryRun = req.body?.confirm !== true;
  const catalogs = requested === 'both' ? ['cards', 'events'] : [requested];
  previewRepairRunning = true;

  try {
    const plan = {};
    for (const catalog of catalogs) {
      const found = await findMissingPreviewRows(catalog, limit);
      plan[catalog] = { rows: found.rows, scanned: found.scanned, capped: found.capped };
    }

    const summary = {};
    for (const catalog of catalogs) {
      const { rows, scanned, capped } = plan[catalog];
      summary[catalog] = {
        scanned,
        missingFound: rows.length,
        capped,
        dryRun,
        ...(dryRun ? { sample: rows.slice(0, 25).map(row => ({ id: String(row.id), name: String(row.name || ''), ...(catalog === 'events' ? { event_slug: String(row.event_slug || 'unknown') } : {}) })) } : {})
      };
    }

    if (dryRun) {
      return res.json({
        ok: true,
        mode: 'dry-run',
        message: 'No records changed. Send confirm: true to resolve and save missing preview links.',
        limitPerCatalog: limit,
        results: summary,
        timestamps: getTimestamps(),
      });
    }

    const results = {};
    for (const catalog of catalogs) {
      const rows = plan[catalog].rows;
      let succeeded = 0;
      let failed = 0;
      const failures = [];
      await mapWithConcurrency(rows, PREVIEW_REPAIR_CONCURRENCY, async row => {
        const result = await resolveAndSavePreview(catalog, row, { backfill: true });
        if (result.ok) succeeded++;
        else {
          failed++;
          if (failures.length < 25) failures.push({ id: String(row.id), reason: String(result.reason || 'resolution_failed').slice(0, 200) });
        }
      });
      if (succeeded > 0) {
        if (catalog === 'cards') await rebuildMainStorage();
        else await rebuildEventStorage();
      }
      results[catalog] = {
        scanned: plan[catalog].scanned,
        attempted: rows.length,
        succeeded,
        failed,
        capped: plan[catalog].capped,
        failures,
      };
    }

    const hasFailures = Object.values(results).some(item => item.failed > 0);
    logger.log(hasFailures ? 'WARN' : 'SUCCESS', 'preview-link', 'Admin preview-link repair finished', {
      catalogs, limitPerCatalog: limit, results: Object.fromEntries(Object.entries(results).map(([name, value]) => [name, { attempted: value.attempted, succeeded: value.succeeded, failed: value.failed, capped: value.capped }]))
    });
    return res.status(hasFailures ? 207 : 200).json({
      ok: !hasFailures,
      mode: 'repair',
      message: 'Repair pass finished. If capped is true, run another pass to process additional missing records.',
      limitPerCatalog: limit,
      results,
      timestamps: getTimestamps(),
    });
  } catch (error) {
    logger.log('ERROR', 'preview-link', 'Admin preview-link repair failed', { error: String(error?.message || error).slice(0, 300) });
    return res.status(502).json({ ok: false, error: 'Preview-link repair failed.', detail: String(error?.message || error).slice(0, 300), timestamps: getTimestamps() });
  } finally {
    previewRepairRunning = false;
  }
});

app.get('/api/link', requireApiKey, async (req, res) => {
  const startTime = Date.now();
  const base = () => ({ durationMs: Date.now() - startTime, timestamps: getTimestamps() });

  if (req.query.url === undefined || req.query.url === '') {
    return res.status(400).json({ ok: false, error: 'Missing url parameter', usage: '/api/link?url=SHOOB_URL&key=YOUR_KEY', ...base() });
  }
  const parsed = parseShoobUrl(req.query.url);
  if (!parsed) {
    return res.status(400).json({ ok: false, error: 'Invalid Shoob URL', ...base() });
  }

  try {
    let mediaUrl;
    let cardId = null;
    let cached = false;

    if (parsed.kind === 'media') {
      mediaUrl = parsed.url; // already the final CDN file
    } else {
      cardId = parsed.id;
      const cacheKey = `${parsed.id}|${parsed.size || ''}`;
      let savedRow = null;
      if (supabase) {
        for (const table of ['cards', 'event_cards']) {
          const { data, error } = await supabase.from(table).select('id,preview_link').eq('id', parsed.id).maybeSingle();
          if (error) {
            logger.log('WARN', 'preview-link', 'Persistent preview lookup failed; falling back to direct Shoob resolution', { cardId: parsed.id, catalog: table === 'cards' ? 'cards' : 'events', error: String(error.message || error).slice(0, 250) });
            savedRow = null;
            break;
          }
          if (data) { savedRow = { ...data, table }; break; }
        }
      }
      // Use durable catalogue storage for the default/standard preview size. A custom size must resolve directly.
      if (savedRow?.preview_link && (!parsed.size || parsed.size === 700) && /^https:\/\/cdn\.shoob\.gg\//i.test(savedRow.preview_link)) {
        mediaUrl = savedRow.preview_link;
        cached = true;
        linkCacheSet(cacheKey, mediaUrl);
      } else {
        const hit = linkCacheGet(cacheKey);
        if (hit) {
          mediaUrl = hit;
          cached = true;
        } else {
          const wait = linkRateCheck(req.ip || 'unknown');
          if (wait) {
            res.set('Retry-After', String(wait));
            return res.status(429).json({ ok: false, error: 'Too many link lookups. Try again shortly.', retry_after_seconds: wait, cached: false, ...base() });
          }
          mediaUrl = await resolveShoobCard(parsed.id, parsed.size || 700);
          linkCacheSet(cacheKey, mediaUrl);
          if (savedRow && (!parsed.size || parsed.size === 700)) {
            const { error } = await supabase.from(savedRow.table).update({ preview_link: mediaUrl }).eq('id', parsed.id);
            if (error) logger.log('WARN', 'preview-link', 'Resolved URL returned but could not be persisted', { cardId: parsed.id, catalog: savedRow.table === 'cards' ? 'cards' : 'events', error: error.message });
            else logger.log('SUCCESS', 'preview-link', 'Preview link resolved and saved by /api/link', { cardId: parsed.id, catalog: savedRow.table === 'cards' ? 'cards' : 'events', cached: false });
          }
        }
      }
    }

    const info = describeMedia(mediaUrl);
    return res.json({ ok: true, card_id: cardId, type: info.type, media: info.media, mime: info.mime, url: mediaUrl, cached, ...base() });
  } catch (error) {
    const status = error && error.status ? error.status : 502;
    const message = error && error.status ? error.message : 'Link lookup failed';
    return res.status(status).json({ ok: false, error: message, error_code: status === 404 ? 'CARD_NOT_FOUND' : status === 504 ? 'PREVIEW_TIMEOUT' : 'PREVIEW_RESOLUTION_FAILED', retryable: status !== 400 && status !== 404, cached: false, ...base() });
  }
});

// END /api/link

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
      'Endpoints ( /api/cards, /api/events, /api/random, /api/series, /api/link, /api/download, /api/stats, /api/stats/recent ) require a valid API key.',
      'Add your key to the end of the URL e.g  ?key=YOUR_API_KEY',
      'Use "?" before the first query parameter.',
      'Use & between additional query parameters.',
      'Query parameter names are case-sensitive.',
      'Analytics never records API keys, tokens, passwords, or other credential-like query parameters. Admin and internal endpoints are excluded from request analytics.',
      'For /api/cards and /api/events, limit defaults to 20 and cannot exceed 100. For /api/stats/recent, limit defaults to 50 and must be an integer from 1 to 500.',
      'page defaults to "1"',
      'search and q are the same parameter',
      'series and anime are aliases.',
      'event is an exact event slug filter (e.g., summer, gala).',
      'tier is an exact tier filter.',
      'sort must be an allowed column for that endpoint.',
      'order accepts "asc" or "desc" (default asc).',
      'Requesting a page beyond the last page returns ok:true with an empty data array, not an error.',
      'For /api/link, url must be a Shoob link (api.shoob.gg card link, a shoob.gg card page link containing the card id, or a cdn.shoob.gg file link). Anything else returns \"Invalid Shoob URL\".'
    ],
  },
  endpoints: [
    { method: 'GET', path: '/', description: 'Static frontend.' },
    { method: 'GET', path: '/api/health', description: 'Health and Supabase availability.' },
    { method: 'GET', path: '/ping', description: 'Health-check alias.' },
    { method: 'GET', path: '/api/status', description: 'Public runtime and catalog status.' },
    { 
      method: 'GET', path: '/api/random', description: 'Returns one random main-catalog card.', 
      parameters: { key: 'Required API key (or Admin key).', tier: 'Exact tier match.', search: 'Partial search.', series: 'Partial series match.' }, 
      examples: ['/api/random?key=YOUR_KEY', '/api/random?tier=S&key=YOUR_KEY'] 
    },
    { 
      method: 'GET', path: '/api/series', description: 'Dictionary of all anime series and counts.', 
      parameters: { key: 'Required API key (or Admin key).', event: 'Optional event slug.' }, 
      examples: ['/api/series?key=YOUR_KEY', '/api/series?event=summer&key=YOUR_KEY'] 
    },
    {
      method: 'GET', path: '/api/link', description: 'Resolves a Shoob card link to its final media file URL (mp4, gif, jpg, png, webp).',
      parameters: { key: 'Required API key (or Admin key).', url: 'Required. Shoob link, e.g. https://api.shoob.gg/site/api/cardr/CARD_ID?size=700' },
      examples: ['/api/link?url=https://api.shoob.gg/site/api/cardr/CARD_ID?size=700&key=YOUR_KEY']
    },
    { 
      method: 'GET', path: '/api/stats', description: 'API usage analytics.', 
      parameters: { key: 'Required API key (or Admin key).', daily: 'true', weekly: 'true', monthly: 'true' }, 
      examples: ['/api/stats?key=YOUR_KEY', '/api/stats?daily=true&key=YOUR_KEY'] 
    },
    {
      method: 'GET',
      path: '/api/stats/recent',
      description: 'Returns recent daily aggregate rows from endpoint_stats, newest day first and then highest total. This is not an individual request log.',
      parameters: {
        key: 'Required API key (or Admin key).',
        limit: 'Optional integer from 1 to 500. Defaults to 50.',
      },
      examples: [
        '/api/stats/recent?key=YOUR_KEY',
        '/api/stats/recent?limit=100&key=YOUR_KEY',
        '/api/stats/recent?limit=500&key=YOUR_KEY',
      ],
    },
    { 
      method: 'GET', path: '/api/cards', description: 'Search and paginate main-catalog cards.', 
      parameters: { key: 'Required API key (or Admin key).', page: '1', limit: '20', tier: 'Exact match', search: 'Partial match', series: 'Partial match', sort: 'name, tier, series', order: 'asc, desc' }, 
      examples: ['/api/cards?key=YOUR_KEY', '/api/cards?tier=S&key=YOUR_KEY'] 
    },
    { 
      method: 'GET', path: '/api/events', description: 'Search and paginate event cards.', 
      parameters: { key: 'Required API key (or Admin key).', event: 'Exact slug', tier: 'Exact match', search: 'Partial match', series: 'Partial match' }, 
      examples: ['/api/events?event=summer&key=YOUR_KEY'] 
    },
    { method: 'GET', path: '/api/download', description: 'Downloads a full generated catalogue JSON file. Requires API key; file must be cards or events.', parameters: { file: 'Required: cards or events.', key: 'Required API key (query parameter or x-api-key header).' }, examples: ['/api/download?file=cards&key=YOUR_KEY', '/api/download?file=events&key=YOUR_KEY'] },
    { method: 'GET', path: '/api/endpoints', description: 'This directory.' },
  ],
};

app.get(['/api/endpoints', '/api/endpoint'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ...PUBLIC_ENDPOINT_DIRECTORY, requestedPath: req.path, generatedAt: new Date().toISOString() });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Endpoint not found', path: req.path }));

const server = app.listen(PORT, () => {
  logger.log('SUCCESS', 'startup', 'ZCard scraper service listening', { port: PORT, node: process.version, supabaseConfigured, timeZone: LAGOS_TIME_ZONE });
  stats.start();
  state.nextSourceCheckAt = nextLagosHourIso();
  void monitorOnce();
  setInterval(() => void monitorOnce(), MONITOR_MS).unref();
  setInterval(() => void schedulerTick().catch(error => logger.log('ERROR', 'scheduler', 'Tick failed', { error: error?.message })), SCHEDULER_POLL_MS).unref();
  setInterval(() => void selfPingOnce(), SELF_PING_MS).unref();
  setTimeout(() => void schedulerTick().catch(() => {}), 30_000).unref();
  setTimeout(() => void runRetentionCleanup('startup').catch(() => {}), 60_000).unref();
  setInterval(() => void runRetentionCleanup('scheduled').catch(() => {}), RETENTION_CLEANUP_MS).unref();
  setTimeout(() => void selfPingOnce(), 90_000).unref();
});

const shutdown = async signal => {
  logger.log('WARN', 'shutdown', `${signal} received`);
  try { await stats.stop(); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => logger.log('ERROR', 'process', 'Uncaught exception', { error: e?.message || String(e) }));
process.on('unhandledRejection', e => logger.log('ERROR', 'process', 'Unhandled rejection', { error: e?.message || String(e) }));

// end of server.js

