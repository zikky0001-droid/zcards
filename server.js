// server.js 

const express = require("express");
const path = require("node:path");
const { ShoobCardScraper } = require("./cards.js");
const { ShoobEventScraper, groupCardsByEvent } = require("./events.js");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("json spaces", 2);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

let currentCards = null;
let activeScraper = null;
let scrapeState = { isScraping: false, startedAt: null, finishedAt: null, error: null };

let currentEventCards = null;
let activeEventScraper = null;
let eventScrapeState = { isScraping: false, startedAt: null, finishedAt: null, error: null };

const AVAILABLE_ENDPOINTS = [
  "/", "/api/start", "/api/status", "/api/download",
  "/api/start-events", "/api/status-events", "/api/download-events",
  "/api/health", "/ping",
];

function getTimeInfo() {
  const now = new Date();
  const utcDate = now.toISOString().split("T")[0];
  const utcTime = now.toISOString().split("T")[1].replace("Z", " UTC");
  const lagosDate = now.toLocaleDateString("en-NG", { timeZone: "Africa/Lagos", year: "numeric", month: "long", day: "numeric" });
  const lagosTime = now.toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  const lagosISO = now.toLocaleString("en-GB", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return {
    unix: Math.floor(now.getTime() / 1000),
    iso: now.toISOString(),
    utc: { date: utcDate, time: utcTime, full: now.toUTCString() },
    lagos: { timezone: "Africa/Lagos (WAT, UTC+1)", date: lagosDate, time: lagosTime, full: `${lagosDate} ${lagosTime} WAT`, iso_like: lagosISO },
  };
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function currentCardCount() { return activeScraper ? activeScraper.cards.length : currentCards ? currentCards.length : 0; }
function currentEventCardCount() { return activeEventScraper ? activeEventScraper.cards.length : currentEventCards ? currentEventCards.length : 0; }

app.get(["/api/health", "/ping"], (req, res) => {
  const uptimeSec = process.uptime();
  const mem = process.memoryUsage();
  res.json({
    status: true,
    service: "Shoob Card Scraper",
    message: "PONG — server is alive 🟢",
    timestamp: getTimeInfo(),
    server: { uptime_seconds: Math.floor(uptimeSec), uptime_human: formatUptime(uptimeSec), node: process.version, port: PORT, memory_mb: { rss: +(mem.rss / 1024 / 1024).toFixed(2), heap_used: +(mem.heapUsed / 1024 / 1024).toFixed(2) } },
    mainScraper: { isScraping: scrapeState.isScraping, startedAt: scrapeState.startedAt, finishedAt: scrapeState.finishedAt, error: scrapeState.error, cardCount: currentCardCount(), downloadable: currentCardCount() > 0, downloadStatus: currentCardCount() === 0 ? "empty" : scrapeState.isScraping ? "partial" : "complete" },
    eventScraper: { isScraping: eventScrapeState.isScraping, startedAt: eventScrapeState.startedAt, finishedAt: eventScrapeState.finishedAt, error: eventScrapeState.error, cardCount: currentEventCardCount(), phase: activeEventScraper?.phase || (eventScrapeState.finishedAt ? "done" : "idle"), downloadable: currentEventCardCount() > 0, downloadStatus: currentEventCardCount() === 0 ? "empty" : eventScrapeState.isScraping ? "partial" : "complete" },
    available_endpoints: AVAILABLE_ENDPOINTS,
  });
});

// ── Main scrape control ──
app.post("/api/start", (req, res) => {
  if (scrapeState.isScraping) return res.status(409).json({ status: false, error: "Main scrape already in progress", timestamp: getTimeInfo() });
  scrapeState = { isScraping: true, startedAt: new Date().toISOString(), finishedAt: null, error: null };
  currentCards = null;
  res.json({ status: true, message: "Main scrape started", timestamp: getTimeInfo(), scraper: { isScraping: true, startedAt: scrapeState.startedAt } });
  (async () => {
    try {
      activeScraper = new ShoobCardScraper({ category: null });
      currentCards = await activeScraper.fetchAll();
      console.log(`[done] ${currentCards.length} main cards collected`);
    } catch (err) {
      scrapeState.error = err.message;
      console.error("[main scrape failed]", err);
    } finally {
      scrapeState.isScraping = false;
      scrapeState.finishedAt = new Date().toISOString();
      activeScraper = null;
    }
  })();
});

app.get("/api/status", (req, res) => {
  const count = currentCardCount();
  const expected = activeScraper?.expectedTotal ?? (scrapeState.finishedAt && count > 0 ? count : null);
  const progress = expected && expected > 0 ? Math.min(100, (count / expected) * 100) : null;
  res.json({ status: true, timestamp: getTimeInfo(), ...scrapeState, cardCount: count, expectedTotal: expected, progress, ready: !scrapeState.isScraping && count > 0 });
});

app.get("/api/download", (req, res) => {
  const cards = activeScraper ? activeScraper.cards : currentCards;
  const isPartial = scrapeState.isScraping;
  if (!cards || cards.length === 0) return res.status(404).json({ status: false, error: "No main data yet", timestamp: getTimeInfo() });
  const body = JSON.stringify(cards, null, 2);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${isPartial ? "cards-partial.json" : "cards.json"}"`);
  res.setHeader("X-Scrape-Status", isPartial ? "in-progress" : "complete");
  res.setHeader("X-Card-Count", String(cards.length));
  res.send(body);
});

// ── Event scrape control ──
app.post("/api/start-events", (req, res) => {
  if (eventScrapeState.isScraping) return res.status(409).json({ status: false, error: "Event scrape already in progress", timestamp: getTimeInfo() });
  eventScrapeState = { isScraping: true, startedAt: new Date().toISOString(), finishedAt: null, error: null };
  currentEventCards = null;
  res.json({ status: true, message: "Event scrape started", timestamp: getTimeInfo(), scraper: { isScraping: true, startedAt: eventScrapeState.startedAt } });
  (async () => {
    try {
      activeEventScraper = new ShoobEventScraper();
      currentEventCards = await activeEventScraper.fetchAll();
      console.log(`[done] ${currentEventCards.length} event cards collected`);
    } catch (err) {
      eventScrapeState.error = err.message;
      console.error("[event scrape failed]", err);
    } finally {
      eventScrapeState.isScraping = false;
      eventScrapeState.finishedAt = new Date().toISOString();
      activeEventScraper = null;
    }
  })();
});

app.get("/api/status-events", (req, res) => {
  const count = currentEventCardCount();
  const expected = activeEventScraper?.expectedTotal ?? (eventScrapeState.finishedAt && count > 0 ? count : null);
  const progress = expected && expected > 0 ? Math.min(100, (count / expected) * 100) : null;
  const phase = activeEventScraper?.phase || (eventScrapeState.finishedAt ? "done" : "idle");
  res.json({ status: true, timestamp: getTimeInfo(), ...eventScrapeState, phase, cardCount: count, expectedTotal: expected, progress, ready: !eventScrapeState.isScraping && count > 0 });
});

app.get("/api/download-events", (req, res) => {
  const cards = activeEventScraper ? activeEventScraper.cards : currentEventCards;
  const isPartial = eventScrapeState.isScraping;
  if (!cards || cards.length === 0) return res.status(404).json({ status: false, error: "No event data yet", timestamp: getTimeInfo() });
  // Grouped output: { "easter": [...], "halloween": [...] }
  const grouped = groupCardsByEvent(cards);
  const body = JSON.stringify(grouped, null, 2);
  const groupCount = Object.keys(grouped).length;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${isPartial ? "events-partial.json" : "events.json"}"`);
  res.setHeader("X-Scrape-Status", isPartial ? "in-progress" : "complete");
  res.setHeader("X-Card-Count", String(cards.length));
  res.setHeader("X-Event-Count", String(groupCount));
  res.send(body);
});

// ── 404 ──
app.use((req, res) => {
  if (req.accepts("html") && !req.path.startsWith("/api") && !req.path.startsWith("/ping") && !req.path.endsWith(".js") && !req.path.endsWith(".css")) {
    return res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
  }
  return res.status(404).json({ status: false, message: "Endpoint not found", path: req.path, timestamp: getTimeInfo(), available_endpoints: AVAILABLE_ENDPOINTS });
});

const server = app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗\n║           SHOOB CARD SCRAPER                 ║\n╚══════════════════════════════════════════════╝\n\n🌐 Server: http://localhost:${PORT}/\n💓 Health: http://localhost:${PORT}/api/health\n📊 Status: http://localhost:${PORT}/api/status\n🎉 Events: http://localhost:${PORT}/api/status-events\n`);
});

const SELF_URL = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
if (SELF_URL) {
  const PING_MS = 14 * 60 * 1000;
  const ping = async () => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${SELF_URL}/api/health`);
      console.log(`[keep-alive] ${r.status} ${Date.now() - t0}ms`);
    } catch (e) { console.warn(`[keep-alive] failed: ${e.message}`); }
  };
  setTimeout(ping, 5000);
  setInterval(ping, PING_MS);
  console.log(`[keep-alive] self-ping every 13 min`);
}

const shutdown = (signal) => {
  console.log(`\n🛑 ${signal} received. Closing HTTP server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message || String(e)));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || String(e)));


