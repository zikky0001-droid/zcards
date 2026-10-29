/**
 * Download Shoob event cards into events.json (grouped by event).
 * Usage:
 *   node events.js
 *   node events.js --event easter
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { io } = require("socket.io-client");
const logger = require("./logger.js");

const SHOOB_URL = process.env.SHOOB_URL || "https://shoob.gg";
const REQUEST_TIMEOUT = 60000; // Increased from 30000 to 60000 (60 seconds)
const PREFLIGHT_TIMEOUT = 10000;

const SHOOB_ENCRYPTION_SECRET =
  "GaTSqvlqTrrWyTFTH2vcbRb7IJq9auX1hVjzN77pvBPp5fxH7OrIfos89P5zDHy82" +
  "7NqZ9FqZ8FqZ9FqZ8FqZ9FqZ8FqZ9FqZ8FqZ9FqZ8FqZ9FqZ8FqZ9FqZ8";

const KNOWN_EVENTS = [
  "easter",
  "summer",
  "halloween",
  "christmas",
  "valentines-day",
  "chinese-new-year",
  "new-year",
  "spring-festival",
  "anniversary",
];

function decryptShoobValue(enc) {
  if (!enc) return "";
  try {
    const buff = Buffer.from(enc, "base64");
    const secretBuff = Buffer.from(SHOOB_ENCRYPTION_SECRET);
    const result = Buffer.alloc(buff.length);
    for (let i = 0; i < buff.length; i++) {
      result[i] = buff[i] ^ secretBuff[i % secretBuff.length];
    }
    return result.toString("utf8");
  } catch (e) {
    return "";
  }
}

function normalizeEventCard(raw, eventSlug) {
  const id = String(raw._id || raw.id || "");
  const name = String(raw.name || raw.card_name || "").trim();
  const tier = String(raw.tier || raw.card_tier || "").trim();
  const series = String(raw.series || "").trim();
  const image_url = String(raw.image_url || raw.img || "");
  const author = String(raw.author || "").trim();
  const author_link = String(raw.author_link || "").trim();

  if (!id) throw new Error("Event card missing id");
  if (!name) throw new Error(`Event card ${id} missing name`);

  return {
    id,
    name,
    tier,
    series,
    event: eventSlug,
    image_url,
    author,
    author_link,
  };
}

function groupCardsByEvent(cards) {
  const grouped = {};
  for (const card of cards) {
    const slug = card.event || "unknown";
    if (!grouped[slug]) grouped[slug] = [];
    grouped[slug].push(card);
  }
  return grouped;
}

function writeCards(cards, outputPath) {
  const grouped = groupCardsByEvent(cards);
  const output = outputPath || path.join(__dirname, "events.json");
  const tmp = `${output}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(grouped, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, output);
  console.log(`[Writer] Saved ${cards.length} event cards to ${output}`);
}

async function fetchEventMenu() {
  try {
    const res = await fetch(`${SHOOB_URL}/card-events`, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const html = await res.text();
    const matches = [...html.matchAll(/\/card-events\/([a-z0-9][a-z0-9-]+)(?=["'\/?#]|$)/gi)];
    const slugs = [...new Set(matches.map((m) => m[1].toLowerCase()))];
    return { ok: true, slugs };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

class ShoobEventScraper {
  constructor({ events = KNOWN_EVENTS, existingKeys = null } = {}) {
    this.events = events;
    this.existingKeys = existingKeys ? new Set([...existingKeys].map(String)) : null;
    this.cards = [];
    this.expectedTotal = null;
    this.phase = "init";
    this.eventStats = {};
    this.unknownEvents = [];
    this.menuChecked = false;
    this.responseEvent = "cardeventindex_response";
  }

  _requestPage(socket, eventSlug, page, retries = 2) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      let retryTimer = null;
      const attempt = (attemptNum) => {
        if (settled) return;
        const onResponse = (payload) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          logger.log("INFO", "events-scraper", "Event page response received", {
            event: eventSlug, page, attempt: attemptNum, elapsedMs: Date.now() - startedAt,
            responseType: Array.isArray(payload?.docs) ? "docs-array" : typeof payload
          });
          resolve(payload);
        };
        const timer = setTimeout(() => {
          socket.off(this.responseEvent, onResponse);
          logger.log("WARN", "events-scraper", "Event page response timed out", {
            event: eventSlug, page, attempt: attemptNum, maxAttempts: retries,
            timeoutMs: REQUEST_TIMEOUT
          });
          if (attemptNum < retries) {
            console.warn(`[Retry] ${eventSlug} page ${page} timed out (attempt ${attemptNum}/${retries}), retrying in 2s...`);
            logger.log("WARN", "events-scraper", "Retrying event page request", {
              event: eventSlug, page, nextAttempt: attemptNum + 1, maxAttempts: retries, delayMs: 2000
            });
            retryTimer = setTimeout(() => attempt(attemptNum + 1), 2000);
          } else if (!settled) {
            settled = true;
            reject(new Error(`Timeout for ${eventSlug} page ${page} after ${retries} attempts`));
          }
        }, REQUEST_TIMEOUT);

        socket.once(this.responseEvent, onResponse);
        logger.log("DEBUG", "events-scraper", "Requesting event page", {
          event: eventSlug, page, attempt: attemptNum, timeoutMs: REQUEST_TIMEOUT
        });
        socket.emit("cardeventindex", {
          page, category: null, event: eventSlug, search: "", series: null,
        });
      };

      attempt(1);
    });
  }

  async checkMenu() {
    if (this.menuChecked) return;
    this.menuChecked = true;

    const result = await fetchEventMenu();
    if (!result.ok) {
      console.warn(`[Preflight] Event menu could not be verified: ${result.reason}`);
      return;
    }

    const knownSet = new Set(this.events.map((e) => e.toLowerCase()));
    const unknown = result.slugs.filter((s) => !knownSet.has(s.toLowerCase()));
    this.unknownEvents = unknown;

    if (unknown.length > 0) {
      console.warn(`[Preflight] ${unknown.length} unknown event(s) on menu: ${unknown.join(", ")}`);
      console.warn(`[Preflight] Add them to KNOWN_EVENTS in events.js to scrape them next run.`);
    } else {
      console.log(`[Preflight] Menu has ${result.slugs.length} event(s) — all covered by KNOWN_EVENTS.`);
    }
  }

  async fetchSummary() {
    await this.checkMenu();
    const startedAt = Date.now();
    logger.log("INFO", "events-scraper", "Starting event summary discovery", {
      source: SHOOB_URL, eventCount: this.events.length,
      connectTimeoutMs: PREFLIGHT_TIMEOUT, requestTimeoutMs: REQUEST_TIMEOUT
    });
    const socket = io(SHOOB_URL, { transports: ["websocket"], reconnection: false, timeout: PREFLIGHT_TIMEOUT });

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        socket.disconnect();
        fn(value);
      };
      const connectTimer = setTimeout(() => {
        logger.log("ERROR", "events-scraper", "Socket connection timed out during summary discovery", {
          timeoutMs: PREFLIGHT_TIMEOUT, elapsedMs: Date.now() - startedAt
        });
        finish(reject, new Error("Socket connection timeout"));
      }, PREFLIGHT_TIMEOUT);

      socket.once("connect", async () => {
        clearTimeout(connectTimer);
        logger.log("SUCCESS", "events-scraper", "Socket connected for event summary", {
          elapsedMs: Date.now() - startedAt, transport: socket.io?.engine?.transport?.name || "unknown"
        });
        try {
          const eventTotals = {};
          for (const slug of this.events) {
            const raw = await this._requestPage(socket, slug, 1, 2);
            const total = Number(raw.total || raw.totalDocs || 0);
            if (!total || total <= 0) {
              throw new Error(`Event ${slug} returned 0 cards in discovery`);
            }
            eventTotals[slug] = total;
            this.eventStats[slug] = { expected: total, collected: 0 };
            console.log(`[Discovery] ${slug}: ${total} cards`);
          }
          this.expectedTotal = Object.values(eventTotals).reduce((a, b) => a + b, 0);
          console.log(`[Discovery] Grand total: ${this.expectedTotal} event cards across ${Object.keys(eventTotals).length} events`);
          logger.log("SUCCESS", "events-scraper", "Event summary discovery completed", {
            total: this.expectedTotal, eventCount: Object.keys(eventTotals).length,
            elapsedMs: Date.now() - startedAt
          });
          finish(resolve, { ok: true, total: this.expectedTotal, byEvent: eventTotals, menuChecked: true, unknownEvents: this.unknownEvents });
        } catch (err) {
          logger.log("ERROR", "events-scraper", "Event summary discovery failed", {
            error: err?.message || String(err), elapsedMs: Date.now() - startedAt
          });
          finish(reject, err);
        }
      });

      socket.once("connect_error", (err) => {
        logger.log("ERROR", "events-scraper", "Socket connection failed during event summary discovery", {
          error: err?.message || String(err), elapsedMs: Date.now() - startedAt
        });
        finish(reject, new Error(`Socket connection failed: ${err.message}`));
      });
    });
  }

  fetchAll() {
    const startedAt = Date.now();
    logger.log("INFO", "events-scraper", "Starting event-card scrape", {
      source: SHOOB_URL, eventCount: this.events.length,
      connectTimeoutMs: PREFLIGHT_TIMEOUT, requestTimeoutMs: REQUEST_TIMEOUT,
      existingKeyCount: this.existingKeys?.size ?? null
    });
    return new Promise((resolve, reject) => {
      const socket = io(SHOOB_URL, { transports: ["websocket"], reconnection: false, timeout: PREFLIGHT_TIMEOUT });
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        socket.disconnect();
        fn(value);
      };
      const connectTimer = setTimeout(() => {
        logger.log("ERROR", "events-scraper", "Socket connection timed out during event scrape", {
          timeoutMs: PREFLIGHT_TIMEOUT, elapsedMs: Date.now() - startedAt
        });
        finish(reject, new Error("Socket connection timeout"));
      }, PREFLIGHT_TIMEOUT);

      socket.once("connect", async () => {
        clearTimeout(connectTimer);
        logger.log("SUCCESS", "events-scraper", "Socket connected for event scrape", {
          elapsedMs: Date.now() - startedAt, transport: socket.io?.engine?.transport?.name || "unknown"
        });
        try {
          await this.checkMenu();
          const eventTotals = {};
          for (const slug of this.events) {
            const raw = await this._requestPage(socket, slug, 1, 2);
            const total = Number(raw.total || raw.totalDocs || 0);
            if (!total || total <= 0) {
              throw new Error(`Event ${slug} returned 0 cards in discovery`);
            }
            eventTotals[slug] = total;
            this.eventStats[slug] = { expected: total, collected: 0 };
            console.log(`[Discovery] ${slug}: ${total} cards`);
          }
          this.expectedTotal = Object.values(eventTotals).reduce((a, b) => a + b, 0);
          console.log(`[Discovery] Grand total: ${this.expectedTotal} event cards across ${Object.keys(eventTotals).length} events`);

          this.phase = "scraping";
          for (const eventSlug of this.events) {
            const eventTotal = eventTotals[eventSlug];
            if (!eventTotal || eventTotal === 0) {
              console.log(`[Event Scraper] Skipping ${eventSlug} (empty)`);
              continue;
            }
            console.log(`[Event Scraper] Scraping ${eventSlug} (${eventTotal} cards)...`);
            let page = 1;
            let totalPages = null;
            let collectedThisEvent = 0;

            while (true) {
              const rawPage = await this._requestPage(socket, eventSlug, page, 2);
              const { docs, totalPages: respPages } = rawPage;
              if (!Array.isArray(docs)) {
                throw new Error(`Invalid response format for ${eventSlug} page ${page}`);
              }
              if (totalPages === null && respPages) totalPages = Number(respPages);

              for (const card of docs) {
                try {
                  const normalized = normalizeEventCard(card, eventSlug);
                  if (!this.cards.some((c) => c.id === normalized.id && c.event === normalized.event)) {
                    this.cards.push(normalized);
                    collectedThisEvent++;
                    if (this.eventStats[eventSlug]) this.eventStats[eventSlug].collected = collectedThisEvent;
                  }
                } catch (exc) {
                  console.warn(`[Warning] Skipping invalid event card: ${exc.message}`);
                }
              }

              console.log(
                `[Event Progress] ${eventSlug} page ${page}: ${collectedThisEvent}/${eventTotal} (total: ${this.cards.length}/${this.expectedTotal})`
              );

              if (totalPages !== null && page >= totalPages) break;
              if (collectedThisEvent >= eventTotal) break;
              page++;
            }
          }

          this.phase = "done";
          if (this.cards.length === 0 && !this.existingKeys) {
            return finish(reject, new Error("Shoob returned 0 event cards"));
          }
          logger.log("SUCCESS", "events-scraper", "Event-card scrape completed", {
            collected: this.cards.length, expected: this.expectedTotal,
            elapsedMs: Date.now() - startedAt, eventCount: this.events.length
          });
          finish(resolve, this.cards);
        } catch (err) {
          logger.log("ERROR", "events-scraper", "Event-card scrape failed", {
            error: err?.message || String(err), collected: this.cards.length,
            expected: this.expectedTotal, phase: this.phase, elapsedMs: Date.now() - startedAt
          });
          finish(reject, err);
        }
      });

      socket.once("connect_error", (err) => {
        logger.log("ERROR", "events-scraper", "Socket connection failed during event scrape", {
          error: err?.message || String(err), elapsedMs: Date.now() - startedAt
        });
        finish(reject, new Error(`Socket connection failed: ${err.message}`));
      });
    });
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { output: null, event: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) options.output = args[++i];
    else if (args[i] === "--event" && args[i + 1]) options.event = args[++i];
  }
  return options;
}

async function main() {
  const args = parseArgs();
  try {
    const scraper = new ShoobEventScraper({ events: args.event ? [args.event] : KNOWN_EVENTS });
    const cards = await scraper.fetchAll();
    writeCards(cards, args.output);
    const grouped = groupCardsByEvent(cards);
    const summary = Object.entries(grouped).map(([k, v]) => `${k}: ${v.length}`).join(", ");
    console.log(`[Summary] ${summary}`);
    process.exit(0);
  } catch (err) {
    console.error("[Fatal]", err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { ShoobEventScraper, groupCardsByEvent, KNOWN_EVENTS };


