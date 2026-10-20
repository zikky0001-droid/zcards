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
  cards: { isScraping: false, startedAt: null, finishedAt: null, count: 0, expected: null, error: null, lastSyncAt: null, storage: 'unknown' },
  events: { isScraping: false, startedAt: null, finishedAt: null, count: 0, expected: null, error: null, lastSyncAt: null, storage: 'unknown', menuChecked: null, unknownEvents: [] },
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

async function syncMain(cards, trigger) {
  if (!supabase) throw new Error('Supabase is not configured');
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('Refusing to publish an empty main catalog');
  const unique = new Map(cards.map(c => [String(c.id), c]));
  if (unique.size !== cards.length) logger.log('WARN', 'sync', 'Duplicate IDs were found in main scrape; deduplicated before sync', { input: cards.length, unique: unique.size });
  const clean = [...unique.values()];
  const run = await supabase.from('sync_runs').insert({ catalog: 'cards', trigger, status: 'running', records_found: clean.length }).select('id').single();
  if (run.error) throw run.error;
  try {
    await upsertBatches('cards', rowsForCards(clean));
    await saveStorage('cards.json', clean);
    await saveCatalogState('cards', clean.length, 'ready', null, { trigger });
    await supabase.from('sync_runs').update({ status: 'success', finished_at: new Date().toISOString(), records_found: clean.length }).eq('id', run.data.id);
    memoryCards = clean; state.cards.count = clean.length; state.cards.lastSyncAt = new Date().toISOString(); state.cards.storage = 'available'; state.cards.error = null;
    logger.log('SUCCESS', 'sync', 'Main catalog synchronized', { count: clean.length, trigger });
  } catch (e) {
    await supabase.from('sync_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: String(e.message || e) }).eq('id', run.data.id);
    throw e;
  }
}
async function syncEvents(cards, trigger, scraper = null) {
  if (!supabase) throw new Error('Supabase is not configured');
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('Refusing to publish an empty event catalog');
  if (scraper && scraper.menuChecked === false) throw new Error(`Event menu preflight failed: ${scraper.menuError || 'unknown error'}`);
  const unique = new Map(cards.map(c => [String(c.id), c]));
  if (unique.size !== cards.length) logger.log('WARN', 'sync', 'Duplicate IDs were found in event scrape; deduplicated before sync', { input: cards.length, unique: unique.size });
  const clean = [...unique.values()];
  const grouped = groupCardsByEvent(clean);
  const run = await supabase.from('sync_runs').insert({ catalog: 'events', trigger, status: 'running', records_found: clean.length, metadata: { eventCount: Object.keys(grouped).length } }).select('id').single();
  if (run.error) throw run.error;
  try {
    await upsertBatches('event_cards', rowsForEvents(clean));
    await saveStorage('events.json', grouped);
    await saveCatalogState('events', clean.length, 'ready', null, { trigger, eventCount: Object.keys(grouped).length, unknownEvents: scraper?.unknownEvents || [] });
    await supabase.from('sync_runs').update({ status: 'success', finished_at: new Date().toISOString(), records_found: clean.length }).eq('id', run.data.id);
    memoryEventCards = clean; state.events.count = clean.length; state.events.lastSyncAt = new Date().toISOString(); state.events.storage = 'available'; state.events.error = null;
    state.events.menuChecked = scraper?.menuChecked ?? state.events.menuChecked; state.events.unknownEvents = scraper?.unknownEvents || [];
    logger.log('SUCCESS', 'sync', 'Event catalog synchronized', { count: clean.length, eventCount: Object.keys(grouped).length, trigger });
  } catch (e) {
    await supabase.from('sync_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: String(e.message || e) }).eq('id', run.data.id);
    throw e;
  }
}
async function scrapeMainAndSync(trigger) {
  if (state.cards.isScraping) return;
  state.cards.isScraping = true; state.cards.startedAt = new Date().toISOString(); state.cards.error = null;
  logger.log('INFO', 'scraper-main', 'Main catalog scrape started', { trigger });
  try {
    const scraper = new ShoobCardScraper({ category: null });
    const cards = await scraper.fetchAll();
    state.cards.expected = scraper.expectedTotal || cards.length;
    await syncMain(cards, trigger);
    state.cards.finishedAt = new Date().toISOString();
  } catch (e) { state.cards.error = e.message || String(e); logger.log('ERROR', 'scraper-main', 'Main scrape/sync failed; retaining last known-good catalog', { error: state.cards.error }); }
  finally { state.cards.isScraping = false; }
}
async function scrapeEventsAndSync(trigger) {
  if (state.events.isScraping) return;
  state.events.isScraping = true; state.events.startedAt = new Date().toISOString(); state.events.error = null;
  logger.log('INFO', 'scraper-events', 'Event catalog scrape started', { trigger });
  try {
    const scraper = new ShoobEventScraper();
    const cards = await scraper.fetchAll();
    state.events.expected = scraper.expectedTotal || cards.length;
    state.events.menuChecked = scraper.menuChecked; state.events.unknownEvents = scraper.unknownEvents || [];
    await syncEvents(cards, trigger, scraper);
    state.events.finishedAt = new Date().toISOString();
  } catch (e) { state.events.error = e.message || String(e); logger.log('ERROR', 'scraper-events', 'Event scrape/sync failed; retaining last known-good catalog', { error: state.events.error }); }
  finally { state.events.isScraping = false; }
}
async function hasCatalog(catalog, table) {
  const { data: stateRow, error: stateErr } = await supabase.from('catalog_state').select('record_count,status,storage_path,last_synced_at').eq('catalog', catalog).maybeSingle();
  if (stateErr) throw stateErr;
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true });
  if (error) throw error;
  const storagePath = catalog === 'cards' ? 'cards.json' : 'events.json';
  const { data: objects, error: storageErr } = await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || 'shoob-catalogs').list('', { search: storagePath, limit: 10 });
  if (storageErr) throw storageErr;
  const storageExists = (objects || []).some(o => o.name === storagePath);
  const dbExists = (count || 0) > 0 && stateRow?.status === 'ready';
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
    state.cards.count = main.dbCount; state.cards.storage = main.storageExists ? 'available' : 'missing';
    state.events.count = events.dbCount; state.events.storage = events.storageExists ? 'available' : 'missing';
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

app.get(['/api/health', '/ping'], (req, res) => res.json({ ok: true, service: 'Shoob scraper', uptimeSeconds: Math.floor(process.uptime()), node: process.version, timestamp: new Date().toISOString() }));
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
  if (target === 'cards' || target === 'both') void scrapeMainAndSync('manual-admin');
  if (target === 'events' || target === 'both') void scrapeEventsAndSync('manual-admin');
  res.status(202).json({ ok: true, message: 'Requested sync queued', catalog: target });
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
