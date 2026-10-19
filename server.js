// server.js 

const express = require("express");
const path = require("node:path");
const { ShoobCardScraper } = require("./cards.js");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("json spaces", 2);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

let currentCards = null;
let activeScraper = null;
let scrapeState = {
  isScraping: false,
  startedAt: null,
  finishedAt: null,
  error: null,
};

const AVAILABLE_ENDPOINTS = [
  "/",
  "/api/start",
  "/api/status",
  "/api/download",
  "/api/health",
  "/ping",
];

function getTimeInfo() {
  const now = new Date();
  const utcDate = now.toISOString().split("T")[0];
  const utcTime = now.toISOString().split("T")[1].replace("Z", " UTC");

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
    utc: { date: utcDate, time: utcTime, full: now.toUTCString() },
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

function getCardsSnapshot() {
  if (activeScraper) return activeScraper.cards;
  return currentCards;
}

// ── Health / ping ─────────────────────────────────────────────────
app.get(["/api/health", "/ping"], (req, res) => {
  const uptimeSec = process.uptime();
  const mem = process.memoryUsage();
  const count = currentCardCount();

  res.json({
    status: true,
    service: "Shoob Card Scraper",
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
      cardCount: count,
      downloadable: count > 0,
      downloadStatus:
        count === 0 ? "empty" : scrapeState.isScraping ? "partial" : "complete",
    },
    available_endpoints: AVAILABLE_ENDPOINTS,
    quick_test: {
      start: "POST /api/start",
      status: "GET /api/status",
      download: "GET /api/download (works during scrape — returns partial JSON)",
      health: "GET /api/health",
      ping: "GET /ping",
    },
  });
});

// ── Start scrape ──────────────────────────────────────────────────
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

// ── Status ────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  const count = currentCardCount();
  const expected =
    activeScraper?.expectedTotal ??
    (scrapeState.finishedAt && count > 0 ? count : null);
  const progress =
    expected && expected > 0 ? Math.min(1, count / expected) : null;

  res.json({
    status: true,
    timestamp: getTimeInfo(),
    ...scrapeState,
    cardCount: count,
    expectedTotal: expected,
    progress,
    ready: !scrapeState.isScraping && count > 0,
  });
});

// ── Download (works DURING a scrape — returns partial snapshot) ──
app.get("/api/download", (req, res) => {
  const cards = getCardsSnapshot();
  const isPartial = scrapeState.isScraping;

  if (!cards || cards.length === 0) {
    return res.status(404).json({
      status: false,
      error: "No data yet. Run a scrape first.",
      timestamp: getTimeInfo(),
    });
  }

  // Snapshot the array NOW — safe because Node is single-threaded and
  // JSON.stringify is synchronous (no yields to the scrape loop mid-stringify).
  const body = JSON.stringify(cards, null, 2);
  const filename = isPartial ? "cards-partial.json" : "cards.json";

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Scrape-Status", isPartial ? "in-progress" : "complete");
  res.setHeader("X-Card-Count", String(cards.length));
  res.setHeader("X-Timestamp", new Date().toISOString());
  res.send(body);
});

// ── 404 ──────────────────────────────────────────────────────────
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

// ── Boot ─────────────────────────────────────────────────────────
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

// ──  self-ping ─────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
if (SELF_URL) {
  const PING_MS = 14.2 * 60 * 1000;
  const ping = async () => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${SELF_URL}/api/health`);
      console.log(`[keep-alive] ${r.status} ${Date.now() - t0}ms → ${SELF_URL}/api/health`);
    } catch (e) {
      console.warn(`[keep-alive] failed: ${e.message}`);
    }
  };
  setTimeout(ping, 5000);
  setInterval(ping, PING_MS);
  console.log(`[keep-alive] self-ping every 13 min → ${SELF_URL}/api/health`);
}

// ── Graceful shutdown ────────────────────────────────────────────
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


