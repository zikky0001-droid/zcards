'use strict';

const MAX_LOGS = 5000;
const entries = [];
let persistLog = null;

function setLogPersistence(fn) { persistLog = typeof fn === 'function' ? fn : null; }
function log(level, component, message, details = {}) {
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    level: String(level || 'INFO').toUpperCase(),
    component: String(component || 'app').slice(0, 80),
    message: sanitizeString(String(message || '')).slice(0, 2000),
    details: sanitize(details),
  };
  entries.push(entry);
  if (entries.length > MAX_LOGS) entries.splice(0, entries.length - MAX_LOGS);
  const line = JSON.stringify(entry);
  if (entry.level === 'ERROR') console.error(line);
  else if (entry.level === 'WARN') console.warn(line);
  else console.log(line);
  if (persistLog) Promise.resolve().then(() => persistLog(entry)).catch(() => {});
  return entry;
}
function sanitizeString(input) {
  return String(input)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/(service[_-]?role[_-]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
function sanitize(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value === null || ['string','number','boolean'].includes(typeof value)) return typeof value === 'string' ? sanitizeString(value).slice(0, 1000) : value;
  if (Array.isArray(value)) return value.slice(0, 30).map(v => sanitize(v, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 200);
  const out = {};
  for (const [k,v] of Object.entries(value).slice(0, 40)) {
    if (/key|secret|password|token|authorization|cookie|service.?role/i.test(k)) out[k] = '[redacted]';
    else out[k] = sanitize(v, depth + 1);
  }
  return out;
}
function list({ limit = 500, level, search, before } = {}) {
  let result = entries;
  if (level && level !== 'ALL') result = result.filter(x => x.level === String(level).toUpperCase());
  if (search) { const q = String(search).toLowerCase(); result = result.filter(x => `${x.message} ${x.component} ${JSON.stringify(x.details)}`.toLowerCase().includes(q)); }
  if (before) { const i = result.findIndex(x => x.id === before); if (i >= 0) result = result.slice(0, i); }
  return result.slice(-Math.max(1, Math.min(Number(limit) || 500, MAX_LOGS))).reverse();
}
function clear() { entries.length = 0; }
module.exports = { MAX_LOGS, log, list, clear, setLogPersistence };
