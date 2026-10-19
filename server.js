// server.js file


const express = require("express");
const path = require("node:path");
const { ShoobCardScraper } = require("./cards.js");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// ── Pretty-print ALL JSON responses (same as your /ping reference) ──
app.set("json spaces", 2);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Scrape state (module-level, shared by all endpoints) ──
let currentCards = null;
let activeScraper = null;
let scrapeState = {
  isScraping: false,
  startedAt: null,
  finishedAt: null,
  error: null,
};

// ── Endpoints advertised in /api/health and 404 responses ──
const AVAILABLE_ENDPOINTS = [
  "/",
  "/api/start",
  "/api/status",
  "/api/download",
  "/api/health",
  "/ping",
];

// ── Helpers ────────────────────────────────────────────────────────
function getTimeInfo() {
  const now = new Date();

  // UTC
  const utcDate = now.toISOString().split("T")[0];
  const utcTime = now.toISOString().split("T")[1].replace("Z", " UTC");

  // Africa/Lagos (WAT = UTC+1, no DST)
  const lagosDate = now.toLocaleDateString("en-NG", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const lagosTime = now.toLocaleTimeString("en-NG", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const lagosISO = now.toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return {
    unix: Math.floor(now.getTime() / 1000),
    iso: now.toISOString(),
    utc: {
      date: utcDate,
      time: utcTime,
      full: now.toUTCString(),
    },
    lagos: {
      timezone: "Africa/Lagos (WAT, UTC+1)",
      date: lagosDate,
      time: lagosTime,
      full: `${lagosDate} ${lagosTime} WAT`,
      iso_like: lagosISO,
    },
  };
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function currentCardCount() {
  if (activeScraper) return activeScraper.cards.length;
  if (currentCards) return currentCards.length;
  return 0;
}

// ── Rich health / ping ────────────────────────────────────────────
app.get(["/api/health", "/ping"], (req, res) => {
  const uptimeSec = process.uptime();
  const mem = process.memoryUsage();

  res.json({
    status: true,
    service: "ZCard Scraper",
    message: "PONG — server is alive 🟢",
    timestamp: getTimeInfo(),
    server: {
      uptime_seconds: Math.floor(uptimeSec),
      uptime_human: formatUptime(uptimeSec),
      node: process.version,
      port: PORT,
      memory_mb: {
        rss: +(mem.rss / 1024 / 1024).toFixed(2),
        heap_used: +(mem.heapUsed / 1024 / 1024).toFixed(2),
      },
    },
    scraper: {
      isScraping: scrapeState.isScraping,
      startedAt: scrapeState.startedAt,
      finishedAt: scrapeState.finishedAt,
      error: scrapeState.error,
      cardCount: currentCardCount(),
      ready: !scrapeState.isScraping && currentCardCount() > 0,
    },
    available_endpoints: AVAILABLE_ENDPOINTS,
    quick_test: {
      start: "POST /api/start",
      status: "GET /api/status",
      download: "GET /api/download",
      health: "GET /api/health",
      ping: "GET /ping",
    },
  });
});

// ── Scrape control ─────────────────────────────────────────────────
app.post("/api/start", (req, res) => {
  if (scrapeState.isScraping) {
    return res.status(409).json({
      status: false,
      error: "Scrape already in progress",
      timestamp: getTimeInfo(),
      scraper: {
        isScraping: true,
        startedAt: scrapeState.startedAt,
        cardCount: currentCardCount(),
      },
    });
  }

  scrapeState = {
    isScraping: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  currentCards = null;

  res.json({
    status: true,
    message: "Scrape started",
    timestamp: getTimeInfo(),
    scraper: { isScraping: true, startedAt: scrapeState.startedAt },
  });

  // Run in background — do not block the HTTP response
  (async () => {
    try {
      activeScraper = new ShoobCardScraper({ category: null });
      currentCards = await activeScraper.fetchAll();
      console.log(`[done] ${currentCards.length} cards collected`);
    } catch (err) {
      scrapeState.error = err.message;
      console.error("[scrape failed]", err);
    } finally {
      scrapeState.isScraping = false;
      scrapeState.finishedAt = new Date().toISOString();
      activeScraper = null;
    }
  })();
});

app.get("/api/status", (req, res) => {
  const count = currentCardCount();
  res.json({
    status: true,
    timestamp: getTimeInfo(),
    ...scrapeState,
    cardCount: count,
    ready: !scrapeState.isScraping && count > 0,
  });
});

app.get("/api/download", (req, res) => {
  if (!currentCards || currentCards.length === 0) {
    return res.status(404).json({
      status: false,
      error: "No data yet. Run a scrape first.",
      timestamp: getTimeInfo(),
    });
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", 'attachment; filename="cards.json"');
  res.send(JSON.stringify(currentCards, null, 2));
});

// ── 404 handler (pretty-printed JSON) ─────────────────────────────
app.use((req, res) => {
  const wantsHtml =
    req.accepts("html") &&
    !req.path.startsWith("/api") &&
    !req.path.startsWith("/ping") &&
    !req.path.endsWith(".js") &&
    !req.path.endsWith(".css");

  if (wantsHtml) {
    return res
      .status(404)
      .sendFile(path.join(__dirname, "public", "index.html"));
  }

  return res.status(404).json({
    status: false,
    message: "Endpoint not found",
    path: req.path,
    timestamp: getTimeInfo(),
    available_endpoints: AVAILABLE_ENDPOINTS,
  });
});

// ── Boot ───────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(
    `\n╔══════════════════════════════════════════════╗\n` +
      `║           SHOOB CARD SCRAPER                 ║\n` +
      `╚══════════════════════════════════════════════╝\n\n` +
      `🌐 Server:    http://localhost:${PORT}/\n` +
      `💓 Health:    http://localhost:${PORT}/api/health\n` +
      `📊 Status:    http://localhost:${PORT}/api/status\n` +
      `⬇️  Download:  http://localhost:${PORT}/api/download\n`
  );
});

// ── 13-min self-ping (5s initial delay, like your /ping reference) ──
const SELF_URL = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
if (SELF_URL) {
  const PING_MS = 14.2 * 60 * 1000;
  const ping = async () => {
    const t0 = Date.now();
    try {
      const res = await fetch(`${SELF_URL}/api/health`);
      const ms = Date.now() - t0;
      console.log(`[keep-alive] ${res.status} ${ms}ms → ${SELF_URL}/api/health`);
    } catch (e) {
      console.warn(`[keep-alive] failed: ${e.message}`);
    }
  };
  setTimeout(ping, 5000);
  setInterval(ping, PING_MS);
  console.log(`[keep-alive] self-ping every 13 min → ${SELF_URL}/api/health`);
}

// ── Graceful shutdown ──────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`\n🛑 ${signal} received. Closing HTTP server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) =>
  console.error("[uncaughtException]", e?.message || String(e))
);
process.on("unhandledRejection", (e) =>
  console.error("[unhandledRejection]", e?.message || String(e))
);


