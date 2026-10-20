'use strict';
const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { ShoobCardScraper } = require('./cards.js');
const { ShoobEventScraper, groupCardsByEvent } = require('./events.js');
const logger = require('./logger.js');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONITOR_MS = 10_000;
const SHOOB_CHECK_MS = 8 * 60 * 60 * 1000;
const LOG_TABLE = 'system_logs';
app.disable('x-powered-by');
app.set('json spaces', 2);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let supabase = null;
let supabaseConfigured = false;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  supabaseConfigured = true;
} else logger.log('WARN', 'startup', 'Supabase environment variables are not configured');

const state = {
  startedAt: new Date().toISOString(), lastMonitorAt: null, lastMonitorOk: null, supabaseReachable: false, supabaseConfigured, supabaseError: null,
  nextSourceCheckAt: null, lastSourceCheckAt: null,
  cards: { isScraping: false, startedAt: null, finishedAt: null, count: 0, expected: null, sourceTotal: null, countsMatch: null, lastDelta: 0, error: null, lastSyncAt: null, storage: 'unknown' },
  events: { isScraping: false, startedAt: null, finishedAt: null, count: 0, expected: null, sourceTotal: null, countsMatch: null, lastDelta: 0, error: null, lastSyncAt: null, storage: 'unknown', menuChecked: null, menuError: null, unknownEvents: [] },
};
let memoryCards = null, memoryEventCards = null;
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
  return req.get('x-admin-key') || (auth.startsWith('Bearer ') ? auth.slice(7) : '') || req.body?.adminKey || '';
}
function isAdmin(req) {
  const configured = process.env.ADMIN_KEY;
  if (!configured) return false;
  return safeEqual(suppliedAdminKey(req), configured);
}
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ ok: false, error: 'Admin access is not configured. Set ADMIN_KEY in Render environment variables.' });
  if (!isAdmin(req)) { logger.log('WARN', 'security', 'Rejected unauthenticated admin request', { path: req.path, ip: req.ip }); return res.status(401).json({ ok: false, error: 'Admin authentication required' }); }
  next();
}
function requireInternalOrAdmin(req, res, next) {
  const internal = process.env.INTERNAL_API_KEY;
  if (internal && safeEqual(req.get('x-internal-key') || '', internal)) return next();
  return requireAdmin(req, res, next);
}
function rowsForCards(cards) {
  return cards.map(c => ({ id: String(c.id), name: String(c.name || 'Unknown'), tier: c.tier == null ? null : String(c.tier), series: c.series || '', image_url: c.image_url || null, author: c.author || 'Anonymous', author_link: c.author_link || 'Hidden', synced_at: new Date().toISOString() }));
}
function rowsForEvents(cards) {
  return cards.map(c => ({ ...rowsForCards([c])[0], event_slug: String(c.event || c.event_slug || 'unknown') }));
}
async function upsertBatches(table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + size), { onConflict: 'id' });
    if (error) throw error;
    logger.log('INFO', 'supabase', 'Database batch upserted', { table, batch: Math.floor(i / size) + 1, batchSize: Math.min(size, rows.length - i) });
  }
}
async function saveStorage(filename, value) {
  const body = JSON.stringify(value, null, 2) + '\n';
  const { error } = await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || 'shoob-catalogs').upload(filename, encoder.encode(body), { contentType: 'application/json; charset=utf-8', upsert: true, cacheControl: '60' });
  if (error) throw error;
}
async function saveCatalogState(catalog, count, status, error = null, metadata = {}) {
  const storagePath = catalog === 'cards' ? 'cards.json' : 'events.json';
  const row = { catalog, record_count: count, storage_path: storagePath, last_checked_at: new Date().toISOString(), last_synced_at: status === 'ready' ? new Date().toISOString() : undefined, last_error: error ? String(error).slice(0, 1000) : null, status, metadata };
  const { error: dbError } = await supabase.from('catalog_state').upsert(row, { onConflict: 'catalog' });
  if (dbError) throw dbError;
}
async function recordLog(entry) {
  if (!supabase) return;
  const { error } = await supabase.from(LOG_TABLE).upsert({ id: entry.id, timestamp: entry.timestamp, level: entry.level, component: entry.component, message: entry.message, details: entry.details }, { onConflict: 'id' });
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
  const all = [], pageSize = 1000;
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
    catalog, trigger, status: 'success', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    records_found: sourceTotal, records_added: 0,
    metadata: { mode: 'count-match-noop', databaseCount: dbCount, sourceCount: sourceTotal, ...metadata }
  });
  if (error) throw error;
}
async function rebuildMainStorage() {
  const rows = await readAllRows('cards');
  await saveStorage('cards.json', rows.map(r => ({ id: String(r.id), name: r.name, tier: r.tier, series: r.series || '', image_url: r.image_url, author: r.author, author_link: r.author_link })));
  state.cards.storage = 'available';
}
async function rebuildEventStorage() {
  const rows = await readAllRows('event_cards');
  const grouped = {};
  for (const row of rows) {
    const slug = String(row.event_slug || 'unknown');
    if (!grouped[slug]) grouped[slug] = [];
    grouped[slug].push({ id: String(row.id), name: row.name, tier: row.tier, series: row.series || '', event: slug, image_url: row.image_url, author: row.author, author_link: row.author_link });
  }
  await saveStorage('events.json', grouped);
  state.events.storage = 'available';
}

async function syncMain(cards, trigger, sourceTotal = null) {
  if (!supabase) throw new Error('Supabase is not configured');
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('No missing main cards were discovered; refusing an empty write');
  const unique = new Map(cards.map(c => [String(c.id), c]));
  if (unique.size !== cards.length) logger.log('WARN', 'sync', 'Duplicate IDs found in missing-card scan; deduplicated', { input: cards.length, unique: unique.size });
  const clean = [...unique.values()];
  const run = await supabase.from('sync_runs').insert({ catalog: 'cards', trigger, status: 'running', records_found: sourceTotal ?? clean.length, records_added: clean.length, metadata: { mode: 'incremental', missingFound: clean.length } }).select('id').single();
  if (run.error) throw run.error;
  try {
    await upsertBatches('cards', rowsForCards(clean));
    const dbCount = await countRows('cards');
    await rebuildMainStorage();
    await saveCatalogState('cards', dbCount, 'ready', null, { trigger, sourceTotal, mode: 'incremental', recordsAdded: clean.length });
    const { error: runError } = await supabase.from('sync_runs').update({ status: 'success', finished_at: new Date().toISOString(), records_found: sourceTotal ?? dbCount, records_added: clean.length, metadata: { mode: 'incremental', databaseCount: dbCount, sourceCount: sourceTotal, missingAdded: clean.length } }).eq('id', run.data.id);
    if (runError) throw runError;
    state.cards.count = dbCount; state.cards.lastSyncAt = new Date().toISOString(); state.cards.storage = 'available'; state.cards.error = null; state.cards.lastDelta = clean.length; state.cards.sourceTotal = sourceTotal; state.cards.countsMatch = sourceTotal == null ? null : dbCount === sourceTotal;
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
  const run = await supabase.from('sync_runs').insert({ catalog: 'events', trigger, status: 'running', records_found: sourceTotal ?? clean.length, records_added: clean.length, metadata: { mode: 'incremental', eventCount: Object.keys(grouped).length } }).select('id').single();
  if (run.error) throw run.error;
  try {
    const eventRows = rowsForEvents(clean);
    const { error: upsertError } = await supabase.from('event_cards').upsert(eventRows, { onConflict: 'id,event_slug' });
    if (upsertError) throw upsertError;
    const dbRows = await readAllRows('event_cards', 'id,event_slug');
    const dbCount = dbRows.length;
    await rebuildEventStorage();
    await saveCatalogState('events', dbCount, 'ready', null, { trigger, sourceTotal, mode: 'incremental', eventCount: new Set(dbRows.map(r => r.event_slug)).size, recordsAdded: clean.length, unknownEvents: scraper?.unknownEvents || [] });
    const { error: runError } = await supabase.from('sync_runs').update({ status: 'success', finished_at: new Date().toISOString(), records_found: sourceTotal ?? dbCount, records_added: clean.length, metadata: { mode: 'incremental', databaseCount: dbCount, sourceCount: sourceTotal, missingAdded: clean.length, eventCount: Object.keys(grouped).length } }).eq('id', run.data.id);
    if (runError) throw runError;
    state.events.count = dbCount; state.events.lastSyncAt = new Date().toISOString(); state.events.storage = 'available'; state.events.error = null; state.events.lastDelta = clean.length; state.events.sourceTotal = sourceTotal;
    const actualByEvent = new Map(); for (const row of dbRows) actualByEvent.set(String(row.event_slug), (actualByEvent.get(String(row.event_slug)) || 0) + 1);
    state.events.countsMatch = scraper?.eventStats ? Object.entries(scraper.eventStats).every(([slug, stats]) => (actualByEvent.get(slug) || 0) === stats.expected) && [...actualByEvent.keys()].every(slug => Object.prototype.hasOwnProperty.call(scraper.eventStats, slug)) : null;
    state.events.menuChecked = scraper?.menuChecked ?? state.events.menuChecked; state.events.unknownEvents = scraper?.unknownEvents || [];
    logger.log('SUCCESS', 'sync', 'Incremental event catalog repair completed', { databaseCount: dbCount, sourceTotal, added: clean.length, trigger });
  } catch (e) {
    await supabase.from('sync_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: String(e.message || e) }).eq('id', run.data.id);
    throw e;
  }
}
async function scrapeMainAndSync(trigger) {
  if (state.cards.isScraping) return { skipped: true, reason: 'main sync already running' };
  state.cards.isScraping = true; state.cards.startedAt = new Date().toISOString(); state.cards.error = null; state.cards.lastDelta = 0; state.lastSourceCheckAt = new Date().toISOString();
  logger.log('INFO', 'scraper-main', 'Checking Shoob published total before any card scan', { trigger });
  try {
    const dbCount = await countRows('cards');
    const summaryScraper = new ShoobCardScraper({ category: null });
    const summary = await summaryScraper.fetchSummary();
    state.cards.expected = summary.total; state.cards.sourceTotal = summary.total;
    if (summary.total === dbCount) {
      if (state.cards.storage !== 'available') await rebuildMainStorage();
      await recordNoopRun('cards', trigger, summary.total, dbCount);
      await supabase.from('catalog_state').update({ last_checked_at: new Date().toISOString(), status: 'ready', last_error: null, metadata: { trigger, mode: 'count-match-noop', sourceTotal: summary.total } }).eq('catalog', 'cards');
      state.cards.count = dbCount; state.cards.error = null; state.cards.countsMatch = true;
      logger.log('SUCCESS', 'scraper-main', 'Counts match; skipped card scan and database writes', { sourceTotal: summary.total, databaseCount: dbCount, trigger });
    } else {
      logger.log('WARN', 'scraper-main', 'Published total differs; scanning IDs only for missing cards', { sourceTotal: summary.total, databaseCount: dbCount, trigger });
      const existingRows = await readAllRows('cards', 'id');
      const existingIds = new Set(existingRows.map(r => String(r.id)));
      const scraper = new ShoobCardScraper({ category: null, existingIds });
      const missing = await scraper.fetchAll();
      state.cards.expected = summary.total;
      if (!missing.length) {
        const note = `Shoob total ${summary.total} differs from Supabase ${dbCount}, but no missing IDs were found. No records were deleted.`;
        logger.log('WARN', 'scraper-main', note, { sourceTotal: summary.total, databaseCount: dbCount, trigger });
        await recordNoopRun('cards', trigger, summary.total, dbCount, { mode: 'count-mismatch-no-missing-ids', warning: note });
        await supabase.from('catalog_state').update({ last_checked_at: new Date().toISOString(), status: 'ready', last_error: note, metadata: { trigger, sourceTotal: summary.total, databaseCount: dbCount, warning: note } }).eq('catalog', 'cards');
        state.cards.count = dbCount; state.cards.countsMatch = false;
      } else {
        if (dbCount > 0 && missing.length > Math.max(5000, summary.total * 0.35)) throw new Error(`Safety stop: ${missing.length} missing cards is an unexpectedly large delta for source total ${summary.total}`);
        await syncMain(missing, trigger, summary.total);
      }
    }
    state.cards.finishedAt = new Date().toISOString();
  } catch (e) { state.cards.error = e.message || String(e); logger.log('ERROR', 'scraper-main', 'Main incremental check failed; retaining last known-good catalog', { error: state.cards.error }); }
  finally { state.cards.isScraping = false; }
}
async function scrapeEventsAndSync(trigger) {
  if (state.events.isScraping) return { skipped: true, reason: 'event sync already running' };
  state.events.isScraping = true; state.events.startedAt = new Date().toISOString(); state.events.error = null; state.events.lastDelta = 0; state.lastSourceCheckAt = new Date().toISOString();
  logger.log('INFO', 'scraper-events', 'Checking Shoob event menu and per-event totals before scanning cards', { trigger });
  try {
    const summaryScraper = new ShoobEventScraper();
    const summary = await summaryScraper.fetchSummary();
    state.events.expected = summary.total; state.events.sourceTotal = summary.total;
    const dbRows = await readAllRows('event_cards', 'id,event_slug');
    const dbByEvent = new Map();
    const existingKeys = new Set();
    for (const row of dbRows) { const slug = String(row.event_slug); dbByEvent.set(slug, (dbByEvent.get(slug) || 0) + 1); existingKeys.add(`${slug}:${String(row.id)}`); }
    const allMatch = Object.entries(summary.byEvent).every(([slug, total]) => (dbByEvent.get(slug) || 0) === total) && Object.keys(Object.fromEntries(dbByEvent)).every(slug => Object.prototype.hasOwnProperty.call(summary.byEvent, slug));
    if (allMatch) {
      if (state.events.storage !== 'available') await rebuildEventStorage();
      await recordNoopRun('events', trigger, summary.total, dbRows.length, { byEvent: summary.byEvent });
      await supabase.from('catalog_state').update({ last_checked_at: new Date().toISOString(), status: 'ready', last_error: null, metadata: { trigger, mode: 'per-event-count-match', sourceTotal: summary.total, byEvent: summary.byEvent } }).eq('catalog', 'events');
      state.events.count = dbRows.length; state.events.error = null; state.events.countsMatch = true;
      logger.log('SUCCESS', 'scraper-events', 'Every event count matches; skipped event-card scan and writes', { sourceTotal: summary.total, databaseCount: dbRows.length, byEvent: summary.byEvent, trigger });
    } else {
      logger.log('WARN', 'scraper-events', 'At least one event count differs; scanning only for missing event/card pairs', { sourceTotal: summary.total, databaseCount: dbRows.length, byEvent: summary.byEvent, databaseByEvent: Object.fromEntries(dbByEvent), trigger });
      const scraper = new ShoobEventScraper({ existingKeys });
      const missing = await scraper.fetchAll();
      state.events.expected = summary.total;
      if (!missing.length) {
        const note = 'Per-event source and database counts differ, but no missing event/card pairs were found. No records were deleted.';
        logger.log('WARN', 'scraper-events', note, { sourceTotal: summary.total, databaseCount: dbRows.length, trigger });
        await recordNoopRun('events', trigger, summary.total, dbRows.length, { mode: 'count-mismatch-no-missing-ids', warning: note, byEvent: summary.byEvent });
        await supabase.from('catalog_state').update({ last_checked_at: new Date().toISOString(), status: 'ready', last_error: note, metadata: { trigger, sourceTotal: summary.total, databaseCount: dbRows.length, warning: note, byEvent: summary.byEvent } }).eq('catalog', 'events');
        state.events.count = dbRows.length; state.events.countsMatch = false;
      } else {
        if (dbRows.length > 0 && missing.length > Math.max(2000, summary.total * 0.5)) throw new Error(`Safety stop: ${missing.length} missing event-card pairs is an unexpectedly large delta`);
        await syncEvents(missing, trigger, scraper, summary.total);
      }
    }
    state.events.menuChecked = summary.menuChecked; state.events.unknownEvents = summary.unknownEvents || [];
    state.events.finishedAt = new Date().toISOString();
  } catch (e) { state.events.error = e.message || String(e); const unknownMatch = state.events.error.match(/New Shoob event\(s\) need to be added before syncing: (.+)$/); if (unknownMatch) { state.events.menuChecked = true; state.events.unknownEvents = unknownMatch[1].split(',').map(x => x.trim()).filter(Boolean); } else if (/event menu could not be verified/i.test(state.events.error)) { state.events.menuChecked = false; state.events.menuError = state.events.error; } logger.log('ERROR', 'scraper-events', 'Event incremental check failed; retaining last known-good catalog', { error: state.events.error, unknownEvents: state.events.unknownEvents }); }
  finally { state.events.isScraping = false; }
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
  if (!supabase) { state.supabaseReachable = false; state.supabaseError = 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'; state.lastMonitorOk = false; return; }
  try {
    const { error } = await supabase.from('catalog_state').select('catalog').limit(1);
    if (error) throw error;
    state.supabaseReachable = true; state.supabaseError = null; state.lastMonitorOk = true;
    const [main, events] = await Promise.all([hasCatalog('cards', 'cards'), hasCatalog('events', 'event_cards')]);
    state.cards.count = main.dbCount; state.cards.storage = main.storageExists ? 'available' : 'missing'; state.cards.lastSyncAt = main.stateRow?.last_synced_at || state.cards.lastSyncAt; state.cards.sourceTotal = main.stateRow?.metadata?.sourceTotal ?? state.cards.sourceTotal;
    state.events.count = events.dbCount; state.events.storage = events.storageExists ? 'available' : 'missing'; state.events.lastSyncAt = events.stateRow?.last_synced_at || state.events.lastSyncAt; state.events.sourceTotal = events.stateRow?.metadata?.sourceTotal ?? state.events.sourceTotal;
    if (!main.present && !state.cards.isScraping) { logger.log('WARN', 'monitor', 'Main catalog missing/incomplete; starting recovery', main); void scrapeMainAndSync('startup-recovery'); }
    if (!events.present && !state.events.isScraping) { logger.log('WARN', 'monitor', 'Event catalog missing/incomplete; starting recovery', events); void scrapeEventsAndSync('startup-recovery'); }
  } catch (e) {
    state.supabaseReachable = false; state.supabaseError = e.message || String(e); state.lastMonitorOk = false;
    logger.log('ERROR', 'monitor', 'Supabase monitor check failed; will retry', { error: state.supabaseError });
  }
}
async function sourceCheck() {
  if (syncPromise) return syncPromise;
  if (state.cards.isScraping || state.events.isScraping) {
    logger.log('INFO', 'scheduler', 'Source check deferred because recovery scrape is already running');
    setTimeout(() => void sourceCheck().catch(e => logger.log('ERROR','scheduler','Deferred source check failed',{error:e.message})), 60_000).unref();
    return;
  }
  syncPromise = (async () => {
    state.lastSourceCheckAt = new Date().toISOString();
    state.nextSourceCheckAt = new Date(Date.now() + SHOOB_CHECK_MS).toISOString();
    logger.log('INFO', 'scheduler', 'Eight-hour Shoob refresh started');
    await Promise.all([scrapeMainAndSync('scheduled-8h'), scrapeEventsAndSync('scheduled-8h')]);
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

app.get(['/api/health', '/ping'], (req, res) => { const healthy = !!supabase && state.supabaseReachable; res.status(healthy ? 200 : 503).json({ ok: healthy, service: 'Shoob Control Room', supabaseConfigured, supabaseReachable: state.supabaseReachable, activeJobs: { cards: state.cards.isScraping, events: state.events.isScraping }, uptimeSeconds: Math.floor(process.uptime()), node: process.version, timestamp: new Date().toISOString() }); });
app.get('/api/status', (req, res) => res.json({ ok: true, uptimeSeconds: Math.floor(process.uptime()), ...state, memory: { rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1), heapMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) }, logBuffer: { max: logger.MAX_LOGS, current: logger.list({ limit: logger.MAX_LOGS }).length }, monitorIntervalMs: MONITOR_MS, sourceCheckIntervalMs: SHOOB_CHECK_MS }));
app.post('/api/admin/login', (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ ok: false, error: 'ADMIN_KEY is not configured on Render' });
  if (!safeEqual(String(req.body?.key || ''), process.env.ADMIN_KEY)) { logger.log('WARN', 'security', 'Failed admin login attempt', { ip: req.ip }); return res.status(401).json({ ok: false, error: 'Invalid admin key' }); }
  logger.log('SUCCESS', 'security', 'Admin login accepted', { ip: req.ip });
  res.json({ ok: true, message: 'Authenticated for this browser session. Keep the key private.' });
});
app.get('/api/admin/status', requireAdmin, (req, res) => res.json({ ok: true, ...state, logBuffer: { max: logger.MAX_LOGS, current: logger.list({ limit: logger.MAX_LOGS }).length } }));
app.get('/api/admin/logs', requireAdmin, (req, res) => res.json({ ok: true, max: logger.MAX_LOGS, logs: logger.list({ limit: req.query.limit, level: req.query.level, search: req.query.search }) }));
app.get('/api/admin/logs/download', requireAdmin, (req, res) => {
  const format = ['json','txt','html'].includes(String(req.query.format)) ? String(req.query.format) : 'json';
  const logs = logger.list({ limit: logger.MAX_LOGS, level: req.query.level, search: req.query.search });
  let body, type;
  if (format === 'txt') { type = 'text/plain; charset=utf-8'; body = logs.map(x => `${x.timestamp} [${x.level}] [${x.component}] ${x.message} ${JSON.stringify(x.details)}`).join('\n'); }
  else if (format === 'html') { type = 'text/html; charset=utf-8'; const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); body = `<!doctype html><meta charset="utf-8"><title>Shoob Logs</title><style>body{font:14px system-ui;background:#0b1020;color:#e8edff;padding:24px}article{padding:12px;margin:8px 0;border:1px solid #29334e;border-radius:10px}small{color:#9ba8c7}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Shoob system logs (${logs.length})</h1>${logs.map(x=>`<article><small>${esc(x.timestamp)} · ${esc(x.level)} · ${esc(x.component)}</small><p>${esc(x.message)}</p><pre>${esc(JSON.stringify(x.details,null,2))}</pre></article>`).join('')}`; }
  else { type = 'application/json; charset=utf-8'; body = JSON.stringify({ exportedAt: new Date().toISOString(), count: logs.length, logs }, null, 2); }
  res.setHeader('Content-Type', type); res.setHeader('Content-Disposition', `attachment; filename="shoob-logs-${new Date().toISOString().slice(0,10)}.${format}"`); res.send(body);
});
app.get('/api/admin/sync-runs', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  const { data, error } = await supabase.from('sync_runs').select('*').order('started_at', { ascending: false }).limit(100);
  if (error) return res.status(502).json({ ok: false, error: error.message });
  res.json({ ok: true, runs: data || [] });
});
app.post('/api/admin/sync', requireAdmin, async (req, res) => {
  const target = req.body?.catalog;
  if (!['cards','events','both'].includes(target)) return res.status(400).json({ ok: false, error: 'catalog must be cards, events, or both' });
  if ((target === 'cards' || target === 'both') && state.cards.isScraping) return res.status(409).json({ ok: false, error: 'Main-card check is already running. Refresh status instead of starting another.' });
  if ((target === 'events' || target === 'both') && state.events.isScraping) return res.status(409).json({ ok: false, error: 'Event check is already running. Refresh status instead of starting another.' });
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase is not configured; sync was not started.' });
  if (target === 'cards' || target === 'both') void scrapeMainAndSync('manual-admin');
  if (target === 'events' || target === 'both') void scrapeEventsAndSync('manual-admin');
  res.status(202).json({ ok: true, message: 'Incremental check queued: published counts are checked first; a card scan runs only if counts differ.', catalog: target, mode: 'incremental' });
});
app.post('/api/internal/logs', requireInternalOrAdmin, (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [req.body];
  for (const item of events) logger.log(item?.level || 'INFO', `vercel:${item?.component || 'app'}`, item?.message || 'Vercel application event', item?.details || {});
  res.json({ ok: true, accepted: events.length });
});
app.get('/api/cards', async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20)); const page = Math.max(1, Number(req.query.page) || 1);
  let q = supabase.from('cards').select('*', { count: 'exact' });
  if (req.query.tier) q = q.eq('tier', String(req.query.tier));
  if (req.query.series || req.query.anime) q = q.ilike('series', `%${String(req.query.series || req.query.anime).slice(0,100)}%`);
  if (req.query.search) q = q.or(`name.ilike.%${String(req.query.search).replace(/[,%()]/g,'').slice(0,80)}%,series.ilike.%${String(req.query.search).replace(/[,%()]/g,'').slice(0,80)}%`);
  const { data, error, count } = await q.order('name').range((page-1)*limit, page*limit-1);
  if (error) return res.status(502).json({ ok: false, error: 'Catalog query failed' });
  res.json({ ok: true, count: count || 0, page, limit, pages: Math.ceil((count || 0)/limit), data: data || [] });
});
app.get('/api/events', async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20)); const page = Math.max(1, Number(req.query.page) || 1);
  let q = supabase.from('event_cards').select('*', { count: 'exact' }); if (req.query.event) q = q.eq('event_slug', String(req.query.event));
  const { data, error, count } = await q.order('name').range((page-1)*limit, page*limit-1);
  if (error) return res.status(502).json({ ok: false, error: 'Event query failed' });
  res.json({ ok: true, count: count || 0, page, limit, pages: Math.ceil((count || 0)/limit), data: data || [] });
});
app.get('/api/random', async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Catalog database unavailable' });
  const { count, error: countError } = await supabase.from('cards').select('id', { count: 'exact', head: true });
  if (countError || !count) return res.status(404).json({ ok: false, error: 'No cards available' });
  const offset = crypto.randomInt(0, count); const { data, error } = await supabase.from('cards').select('*').range(offset, offset).maybeSingle();
  if (error || !data) return res.status(502).json({ ok: false, error: 'Random card query failed' }); res.json({ ok: true, data });
});
app.get('/api/admin/catalog', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  const { data, error } = await supabase.from('catalog_state').select('*').order('catalog');
  if (error) return res.status(502).json({ ok: false, error: error.message }); res.json({ ok: true, catalogs: data || [] });
});
app.use((req, res) => res.status(404).json({ ok: false, error: 'Endpoint not found', path: req.path }));

const server = app.listen(PORT, () => {
  logger.log('SUCCESS', 'startup', 'Shoob scraper service listening', { port: PORT, node: process.version, supabaseConfigured });
  state.nextSourceCheckAt = new Date(Date.now() + SHOOB_CHECK_MS).toISOString();
  void monitorOnce(); // immediate startup check
  setInterval(() => void monitorOnce(), MONITOR_MS).unref();
  setInterval(() => void sourceCheck().catch(e => logger.log('ERROR','scheduler','Scheduled source check failed',{error:e.message})), SHOOB_CHECK_MS).unref();
  // Run one initial source check after recovery monitor has had a chance to inspect the catalogs.
  setTimeout(() => void sourceCheck().catch(e => logger.log('ERROR','scheduler','Initial source check failed',{error:e.message})), 30_000).unref();
});
const shutdown = signal => { logger.log('WARN','shutdown',`${signal} received; closing HTTP server`); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
process.once('SIGTERM', () => shutdown('SIGTERM')); process.once('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => logger.log('ERROR','process','Uncaught exception',{error:e?.message || String(e)}));
process.on('unhandledRejection', e => logger.log('ERROR','process','Unhandled rejection',{error:e?.message || String(e)}));
