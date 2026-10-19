/**
 * Download Shoob event cards into events.json (grouped by event).
 *
 * Usage:
 *     node events.js
 *     node events.js --event easter
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { io } = require("socket.io-client");

const SHOOB_URL = process.env.SHOOB_URL || "https://shoob.gg";
const REQUEST_TIMEOUT = 30000;
const PREFLIGHT_TIMEOUT = 10000;

const SHOOB_ENCRYPTION_SECRET =
  "GaTSqvlqTrrWyTFTH2vcbRb7IJq9auX1hVjzN77pvBPp5fxH7OrIfos89P5zDHy82" +
  "K6R2MeraytWhlT6FHP0dzn4ihL87fRkYrl65036H4hSKCXNtOKqoNLoE8xl2oOcs" +
  "SZyIAkCIa6Q6LqrOQo2K0Bs3FJRrYoMTb6KkwAawwKF1QOjooFARbpefvv4ADaPW" +
  "nQQrx5S5rItE5HT76bqJeNpQ1Wgvw3dhWCjmkha939kqzIOnQA9b9DnnYj6aeLdV" +
  "VAviHzvq8iQZludOBwKknbOnJNOATdKQHmsbF8NmNcq";

// Event slugs. "summer-gala" was wrong — use "summer" and "gala" separately.
const KNOWN_EVENTS = [
  "easter",
  "chinese-new-year",
  "valentines-day",
  "halloween",
  "christmas",
  "my-hero-academia-ccg",
  "maid-day",
  "summer",
  "gala",
  "sworn",
  "olympics",
];

function first(obj, ...keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function extractSeries(card) {
  const value = first(card, "series", "anime", "franchise", "category") ?? "";
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value);
}

function decryptShoobValue(hexValue) {
  const raw = Buffer.from(hexValue, "hex");
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const key = crypto.createHash("sha256").update(SHOOB_ENCRYPTION_SECRET, "utf-8").digest();
  const cipher = crypto.createDecipheriv("aes-256-ctr", key, iv);
  const decrypted = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
  return JSON.parse(decrypted.toString("utf-8"));
}

function normalizeEventCard(card, eventSlug) {
  const cardId = first(card, "_id", "id", "cardid");
  const name = first(card, "name", "card_name") ?? "Unknown";
  let tier = first(card, "tier", "category") ?? "1";
  if (Array.isArray(tier)) tier = tier[0] ?? "1";
  if (!cardId) throw new Error(`Card has no ID: ${JSON.stringify(card)}`);

  const strId = String(cardId);
  const author = Array.isArray(card.authors) && card.authors[0] ? card.authors[0] : null;

  return {
    id: strId,
    name: String(name),
    tier: String(tier),
    series: extractSeries(card),
    event: eventSlug,
    image_url: `https://api.shoob.gg/site/api/cardr/${strId}?size=700`,
    author: author?.name ? String(author.name) : "Anonymous",
    author_link: author?.link ? String(author.link) : "Hidden",
  };
}

function extractPage(payload) {
  let dataPayload = payload;
  if (dataPayload && Array.isArray(dataPayload.encrypted)) {
    if (dataPayload.encrypted.length === 0) return { docs: [], totalPages: null, totalDocs: null };
    try {
      dataPayload = decryptShoobValue(dataPayload.encrypted[0]);
    } catch (exc) {
      throw new Error(`Could not decrypt Shoob response: ${exc.message}`);
    }
  }

  if (!dataPayload || typeof dataPayload !== "object") return { docs: [], totalPages: null, totalDocs: null };

  const data = dataPayload.data ?? dataPayload;
  let docs = [];
  let pagination = {};

  if (data && typeof data === "object" && !Array.isArray(data)) {
    docs = data.docs ?? data.cards ?? [];
    pagination = data.pagination ?? dataPayload.pagination ?? {};
  } else if (Array.isArray(data)) {
    docs = data;
    pagination = dataPayload.pagination ?? {};
  }

  if (!Array.isArray(docs)) docs = [];
  if (typeof pagination !== "object" || pagination === null) pagination = {};

  let totalPages = first(pagination, "pages", "totalPages", "total_pages");
  let totalDocs = first(pagination, "total", "totalDocs", "total_docs", "dataTotal");
  const perPage = first(pagination, "perPage", "per_page", "limit");

  if (totalPages === null && totalDocs !== null && perPage) {
    const docsNum = parseInt(totalDocs, 10);
    const limitNum = parseInt(perPage, 10);
    if (!isNaN(docsNum) && !isNaN(limitNum) && limitNum > 0) totalPages = Math.ceil(docsNum / limitNum);
  }

  totalPages = totalPages !== null ? parseInt(totalPages, 10) : null;
  totalDocs = totalDocs !== null ? parseInt(totalDocs, 10) : null;

  return { docs: docs.filter((item) => item && typeof item === "object"), totalPages, totalDocs };
}

/**
 * Group a flat card array into { [eventSlug]: [cards...] }.
 */
function groupCardsByEvent(cards) {
  const grouped = {};
  for (const card of cards) {
    const ev = card.event || "unknown";
    if (!grouped[ev]) grouped[ev] = [];
    grouped[ev].push(card);
  }
  const sorted = {};
  for (const key of Object.keys(grouped).sort()) {
    sorted[key] = grouped[key];
  }
  return sorted;
}

/**
 * Preflight: fetch /card-events and extract every /card-events/<slug> link.
 * Returns { ok, slugs } or { ok:false, reason } on failure.
 * Purely informational — never throws, never affects the scrape.
 */
async function fetchMenuSlugs() {
  try {
    const res = await fetch(`${SHOOB_URL}/card-events`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShoobScraper/1.0)" },
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const html = await res.text();
    const matches = [...html.matchAll(/\/card-events\/([a-z0-9][a-z0-9-]*)(?=["'/?#]|$)/gi)];
    const slugs = [...new Set(matches.map(m => m[1].toLowerCase()))];
    return { ok: true, slugs };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

class ShoobEventScraper {
  constructor({ events = KNOWN_EVENTS } = {}) {
    this.events = events;
    this.cards = [];
    this.expectedTotal = null;
    this.responseEvent = "cardeventindexres";
    this.phase = "idle"; // "idle" | "preflight" | "discovery" | "scraping" | "done"
    this.eventStats = {}; // { [slug]: { expected, collected } }
    this.unknownEvents = []; // slugs on menu but not in KNOWN_EVENTS
    this.menuChecked = false; // true if preflight succeeded
    this.menuError = null;    // reason if preflight failed
  }

  _requestPage(socket, eventSlug, page) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        socket.off(this.responseEvent);
        rej(new Error(`Timeout for ${eventSlug} page ${page}`));
      }, REQUEST_TIMEOUT);

      socket.once(this.responseEvent, (payload) => {
        clearTimeout(timer);
        res(payload);
      });

      socket.emit("cardeventindex", {
        page,
        category: null,
        event: eventSlug,
        search: "",
        series: null,
      });
    });
  }

  async _runPreflight() {
    this.phase = "preflight";
    console.log("[Preflight] Fetching menu from /card-events...");
    const result = await fetchMenuSlugs();
    if (!result.ok) {
      this.menuChecked = false;
      this.menuError = result.reason;
      console.warn(`[Preflight] skipped (${result.reason}) — proceeding with KNOWN_EVENTS only`);
      return;
    }
    this.menuChecked = true;
    this.menuError = null;
    this.unknownEvents = result.slugs.filter(s => !this.events.includes(s));
    if (this.unknownEvents.length > 0) {
      console.warn(`[Preflight] ${this.unknownEvents.length} unknown event(s) on menu: ${this.unknownEvents.join(", ")}`);
      console.warn(`[Preflight] Add them to KNOWN_EVENTS in events.js to scrape them next run.`);
    } else {
      console.log(`[Preflight] Menu has ${result.slugs.length} event(s) — all covered by KNOWN_EVENTS.`);
    }
  }

  async fetchAll() {
    console.log(`[Event Scraper] Connecting to ${SHOOB_URL}...`);

    const socket = io(SHOOB_URL, {
      transports: ["websocket"],
      reconnection: false,
      timeout: REQUEST_TIMEOUT,
    });

    return new Promise((resolve, reject) => {
      socket.on("connect_error", (err) => {
        socket.disconnect();
        reject(new Error(`Socket connection error: ${err.message}`));
      });

      socket.on("connect", async () => {
        console.log("[Event Scraper] Connected.");
        try {
          // ── PREFLIGHT (warning-only) ──
          await this._runPreflight();

          // ── DISCOVERY PASS ──
          this.phase = "discovery";
          console.log("[Event Scraper] Discovery pass — probing totals for each event...");
          const eventTotals = {};
          for (const eventSlug of this.events) {
            try {
              const raw = await this._requestPage(socket, eventSlug, 1);
              const { docs, totalDocs } = extractPage(raw);
              const total = totalDocs ?? docs.length;
              eventTotals[eventSlug] = total;
              this.eventStats[eventSlug] = { expected: total, collected: 0 };
              console.log(`[Discovery] ${eventSlug}: ${total} cards`);
            } catch (e) {
              console.warn(`[Discovery] ${eventSlug} failed: ${e.message}`);
              eventTotals[eventSlug] = 0;
              this.eventStats[eventSlug] = { expected: 0, collected: 0 };
            }
          }
          this.expectedTotal = Object.values(eventTotals).reduce((a, b) => a + b, 0);
          console.log(`[Discovery] Grand total: ${this.expectedTotal} event cards across ${Object.keys(eventTotals).length} events`);

          // ── SCRAPE PASS ──
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
              const rawPage = await this._requestPage(socket, eventSlug, page);
              const { docs, totalPages: respPages } = extractPage(rawPage);
              if (respPages !== null) totalPages = respPages;

              if (docs.length === 0) break;

              for (const card of docs) {
                try {
                  const normalized = normalizeEventCard(card, eventSlug);
                  if (!this.cards.some((c) => c.id === normalized.id)) {
                    this.cards.push(normalized);
                    collectedThisEvent++;
                    if (this.eventStats[eventSlug]) {
                      this.eventStats[eventSlug].collected = collectedThisEvent;
                    }
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
          socket.disconnect();

          if (this.cards.length === 0) {
            return reject(new Error("Shoob returned 0 event cards"));
          }

          resolve(this.cards);
        } catch (err) {
          socket.disconnect();
          reject(err);
        }
      });
    });
  }
}

function writeCards(cards, outputPath) {
  const absolutePath = path.resolve(outputPath);
  const dirPath = path.dirname(absolutePath);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

  if (fs.existsSync(absolutePath)) {
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15);
    const backupPath = `${absolutePath}.${timestamp}.bak`;
    fs.copyFileSync(absolutePath, backupPath);
    console.log(`[Backup] Created backup: ${backupPath}`);
  }

  const grouped = groupCardsByEvent(cards);
  const tempPath = path.join(dirPath, `.${path.basename(absolutePath)}.${Date.now()}.tmp`);
  const fd = fs.openSync(tempPath, "w");
  fs.writeFileSync(fd, JSON.stringify(grouped, null, 2) + "\n", "utf-8");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tempPath, absolutePath);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { output: path.join(__dirname, "events.json"), event: null };
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
    console.log(`\n[Success] Saved ${cards.length} event cards to ${args.output}`);
    console.log(`[Groups] ${summary}`);
    if (scraper.menuChecked && scraper.unknownEvents.length > 0) {
      console.log(`[Preflight] Unknown events on menu: ${scraper.unknownEvents.join(", ")}`);
    }
  } catch (error) {
    console.error(`[Error] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  first,
  extractSeries,
  decryptShoobValue,
  normalizeEventCard,
  extractPage,
  groupCardsByEvent,
  fetchMenuSlugs,
  writeCards,
  parseArgs,
  ShoobEventScraper,
  KNOWN_EVENTS,
  SHOOB_URL,
  SHOOB_ENCRYPTION_SECRET,
};

if (require.main === module) main();


