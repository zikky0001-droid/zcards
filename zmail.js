'use strict';

// ZMAIL daily digest for ZCard's existing in-memory logs.
// Load this file from server.js with: require('./zmail');
// No Supabase dependency or SQL setup is used.

const fs = require('node:fs');
const path = require('node:path');

// ======================== ZMAIL CONFIG ========================
const TIME_ZONE = 'Africa/Lagos';
const SEND_TIMES = ['08:00', '20:00']; // Lagos local time, 24-hour format
const GRACE_PERIOD_MINUTES = 10;
const CHECK_INTERVAL_SECONDS = 15;

const ERRORS_MAX = 40;
const OTHER_LOGS_MAX = 20; // Non-error logs only
const EMAIL_TO = 'zikkystar0001@gmail.com';
const EMAIL_SUBJECT_PREFIX = 'ZMAIL — ZCard System Digest';

const ZCARD_BASE_URL = process.env.ZCARD_BASE_URL || 'https://zshcards.onrender.com';
const ZCARD_LOGS_PATH = '/api/admin/logs?limit=5000';
const ZMAIL_SEND_URL = 'https://zmail.zone.id/api/v1/send';

// Local state prevents repeat sends during normal operation. On Render's
// ephemeral filesystem this file may be lost on a new deploy/restart.
const STATE_FILE = process.env.ZMAIL_STATE_FILE || path.join(__dirname, '.zmail-digest-state.json');

for (const key of ['ZCARD_ADMIN_KEY', 'ZMAIL_API_KEY']) {
  if (!process.env[key]) {
    console.error(`[ZMAIL] Missing required environment variable: ${key}`);
    // Don't terminate the ZCard web server if this module is required by it.
    module.exports = { start: () => console.error(`[ZMAIL] Cannot start: missing ${key}`) };
    return;
  }
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

function getLagosParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function currentSlot(now = new Date()) {
  const p = getLagosParts(now);
  const nowMins = Number(p.hour) * 60 + Number(p.minute);
  const slotTime = SEND_TIMES.find(t => {
    const [h, m] = t.split(':').map(Number);
    const target = h * 60 + m;
    return nowMins >= target && nowMins < target + GRACE_PERIOD_MINUTES;
  });
  if (!slotTime) return null;
  const dateKey = `${p.year}-${p.month}-${p.day}`;
  return { slotKey: `${dateKey}_${slotTime.replace(':', '')}`, dateKey, slotTime };
}

function prettyTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || 'Unknown time');
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'medium',
  }).format(d);
}

function classifyLogs(logs) {
  const sorted = [...logs].sort((a, b) => {
    const ta = Date.parse(a.timestamp || '') || 0;
    const tb = Date.parse(b.timestamp || '') || 0;
    return tb - ta;
  });
  const allErrors = sorted.filter(x => String(x.level || '').toUpperCase() === 'ERROR');
  const allOther = sorted.filter(x => String(x.level || '').toUpperCase() !== 'ERROR');
  return {
    errors: allErrors.slice(0, ERRORS_MAX),
    other: allOther.slice(0, OTHER_LOGS_MAX),
    allErrorCount: allErrors.length,
    allOtherCount: allOther.length,
  };
}

function renderLog(log, isError = false) {
  const level = String(log.level || 'INFO').toUpperCase();
  const color = isError ? '#b91c1c' : level === 'WARN' || level === 'WARNING' ? '#b45309' : level === 'SUCCESS' ? '#047857' : '#475569';
  const details = log.details && typeof log.details === 'object'
    ? JSON.stringify(log.details, null, 2)
    : String(log.details || '');
  return `<article style="margin:0 0 12px;padding:16px;border:1px solid #e2e8f0;border-left:4px solid ${color};border-radius:12px;background:#fff;">
    <div style="font-size:11px;color:#64748b;margin-bottom:7px;">${esc(prettyTime(log.timestamp))} · ${esc(log.component || 'system')}</div>
    <div style="font-size:12px;font-weight:800;letter-spacing:.4px;color:${color};margin-bottom:6px;">${esc(level)}</div>
    <div style="font-size:14px;font-weight:700;color:#0f172a;line-height:1.45;">${esc(log.message || 'No message')}</div>
    ${details && details !== '{}' ? `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#475569;background:#f8fafc;padding:10px;border-radius:8px;margin:10px 0 0;">${esc(details)}</pre>` : ''}
  </article>`;
}

function buildEmail(slot, data) {
  const { errors, other, allErrorCount, allOtherCount } = data;
  const stamp = prettyTime(new Date().toISOString());
  const isMorning = slot.slotTime === '08:00';
  const errorsHtml = errors.length
    ? errors.map(x => renderLog(x, true)).join('')
    : '<div style="padding:18px;border:1px solid #a7f3d0;background:#ecfdf5;color:#047857;border-radius:12px;font-weight:700;">✓ No error-level logs found in the available in-memory log buffer.</div>';
  const otherHtml = other.length
    ? other.map(x => renderLog(x)).join('')
    : '<div style="padding:18px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;border-radius:12px;">No non-error logs available for this digest.</div>';
  const subject = `${EMAIL_SUBJECT_PREFIX} — ${isMorning ? 'Morning' : 'Evening'} — ${slot.dateKey}`;
  const html = `<!doctype html><html><body style="margin:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
  <div style="max-width:760px;margin:24px auto;padding:0 12px;">
    <header style="background:#111827;color:#fff;padding:28px 24px;border-radius:18px 18px 0 0;">
      <div style="font-size:12px;font-weight:800;letter-spacing:2px;color:#a7f3d0;">ZMAIL · ZCARD IN-MEMORY LOGS</div>
      <h1 style="margin:10px 0 6px;font-size:26px;">${isMorning ? 'Morning' : 'Evening'} System Digest</h1>
      <p style="margin:0;color:#cbd5e1;font-size:13px;">${esc(stamp)} · ${TIME_ZONE}</p>
    </header>
    <main style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 18px 18px;">
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:26px;">
        <div style="flex:1;min-width:145px;padding:16px;border-radius:12px;background:#fef2f2;border:1px solid #fecaca;"><div style="font-size:12px;color:#991b1b;">Errors included</div><div style="font-size:27px;font-weight:800;color:#991b1b;">${errors.length}/${ERRORS_MAX}</div><div style="font-size:11px;color:#991b1b;">${allErrorCount} error(s) available</div></div>
        <div style="flex:1;min-width:145px;padding:16px;border-radius:12px;background:#eff6ff;border:1px solid #bfdbfe;"><div style="font-size:12px;color:#1d4ed8;">Other logs included</div><div style="font-size:27px;font-weight:800;color:#1d4ed8;">${other.length}/${OTHER_LOGS_MAX}</div><div style="font-size:11px;color:#1d4ed8;">${allOtherCount} non-error log(s) available</div></div>
      </div>
      <h2 style="font-size:18px;margin:0 0 14px;color:#991b1b;">① Errors · up to ${ERRORS_MAX}</h2>
      ${errorsHtml}
      <div style="height:1px;background:#e2e8f0;margin:28px 0;"></div>
      <h2 style="font-size:18px;margin:0 0 14px;color:#1d4ed8;">② Other system logs · up to ${OTHER_LOGS_MAX}</h2>
      <p style="font-size:12px;color:#64748b;margin:-4px 0 14px;">ERROR entries are excluded from this section.</p>
      ${otherHtml}
      <footer style="margin-top:28px;padding-top:18px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:11px;line-height:1.6;">Automated ZMAIL digest · ${esc(slot.slotKey)}<br>Source: ZCard's current in-memory log buffer. Logs lost during a process restart cannot be included.</footer>
    </main>
  </div></body></html>`;
  return { subject, html };
}

async function fetchLogs() {
  const url = new URL(ZCARD_LOGS_PATH, ZCARD_BASE_URL);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.ZCARD_ADMIN_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`ZCard logs request failed (HTTP ${response.status}): ${responseText.slice(0, 300)}`);
  let payload;
  try { payload = JSON.parse(responseText); } catch { throw new Error('ZCard logs endpoint returned invalid JSON'); }
  if (payload.ok === false) throw new Error('ZCard logs endpoint reported ok=false');
  if (!Array.isArray(payload.logs)) throw new Error('ZCard logs response has no logs array');
  return payload.logs;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeState(state) {
  try {
    const temp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, STATE_FILE);
  } catch (err) {
    console.error(`[ZMAIL] Could not save local delivery state: ${err.message}`);
  }
}

async function sendDigest(slot) {
  const logs = await fetchLogs();
  const data = classifyLogs(logs);
  const email = buildEmail(slot, data);
  const payload = { to: EMAIL_TO, subject: email.subject, body: email.html };
  const response = await fetch(ZMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ZMAIL_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': `zmail-digest-${slot.slotKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const responseText = await response.text();
  let responseJson = null;
  try { responseJson = responseText ? JSON.parse(responseText) : null; } catch { /* allow plain-text response */ }
  if (!response.ok || responseJson?.success === false || responseJson?.ok === false) {
    throw new Error(`ZMAIL send failed (HTTP ${response.status}): ${responseText.slice(0, 500)}`);
  }
  console.log(`[ZMAIL] Sent ${slot.slotKey}: ${data.errors.length}/${ERRORS_MAX} errors, ${data.other.length}/${OTHER_LOGS_MAX} other logs (HTTP ${response.status}).`);
  return { subject: email.subject, errors: data.errors.length, other: data.other.length };
}

function start() {
  if (global.__zmailDigestStarted) {
    console.log('[ZMAIL] Scheduler already started in this process; skipping duplicate start.');
    return;
  }
  global.__zmailDigestStarted = true;
  const state = readState();
  const inFlight = new Set();
  console.log(`[ZMAIL] Scheduler started. Zone=${TIME_ZONE}; times=${SEND_TIMES.join(', ')}; grace=${GRACE_PERIOD_MINUTES}m; source=in-memory logs.`);

  async function tick() {
    const slot = currentSlot();
    if (!slot || state[slot.slotKey]?.status === 'sent' || inFlight.has(slot.slotKey)) return;
    inFlight.add(slot.slotKey);
    state[slot.slotKey] = { status: 'sending', attemptedAt: new Date().toISOString() };
    writeState(state);
    try {
      const result = await sendDigest(slot);
      state[slot.slotKey] = { status: 'sent', sentAt: new Date().toISOString(), ...result };
      writeState(state);
    } catch (err) {
      console.error(`[ZMAIL] ${slot.slotKey} failed: ${err.message}`);
      // Keep failed slots retryable during the 10-minute grace window.
      delete state[slot.slotKey];
      writeState(state);
    } finally {
      inFlight.delete(slot.slotKey);
    }
  }

  void tick();
  setInterval(() => { void tick(); }, CHECK_INTERVAL_SECONDS * 1000);
}

module.exports = { start };
start();
