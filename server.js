const express = require("express");
const path = require("node:path");
const { ShoobCardScraper } = require("./cards.js");

const app = express();
const PORT = process.env.PORT || 3000;

let currentCards = null;
let activeScraper = null;
let scrapeState = {
  isScraping: false,
  startedAt: null,
  finishedAt: null,
  error: null,
};

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/start", (req, res) => {
  if (scrapeState.isScraping) {
    return res.status(409).json({ error: "Scrape already in progress" });
  }

  scrapeState = {
    isScraping: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  currentCards = null;

  res.json({ message: "Scrape started" });

  // Run scrape in the background — do not block the HTTP response
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
  const cardCount = activeScraper
    ? activeScraper.cards.length
    : currentCards
      ? currentCards.length
      : 0;

  res.json({
    ...scrapeState,
    cardCount,
    ready: !scrapeState.isScraping && cardCount > 0,
  });
});

app.get("/api/download", (req, res) => {
  if (!currentCards || currentCards.length === 0) {
    return res.status(404).send("No data yet. Run a scrape first.");
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", 'attachment; filename="cards.json"');
  res.send(JSON.stringify(currentCards, null, 2));
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// --- 13-minute self-ping to keep Render's free tier awake ---
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  const PING_MS = 13 * 60 * 1000;
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/api/health`);
      console.log(`[keep-alive] pinged ${SELF_URL}/api/health`);
    } catch (e) {
      console.warn("[keep-alive] failed:", e.message);
    }
  }, PING_MS);
  console.log(`[keep-alive] self-ping every 13 min → ${SELF_URL}/api/health`);
}

app.listen(PORT, () => console.log(`Server listening on :${PORT}`));

