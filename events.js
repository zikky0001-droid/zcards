/**
 * Download Shoob event cards into events.json (grouped by event).
 * Usage:
 *     node events.js
 *     node events.js --event summer
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { io } = require("socket.io-client");

const SHOOB_URL = process.env.SHOOB_URL || "https://shoob.gg";
const REQUEST_TIMEOUT = 60000; // 60 seconds for page requests
const PREFLIGHT_TIMEOUT = 30000; // 30 seconds for initial connection

// Public Cryptr secret derived by Shoob's browser bundle (AES-256-CTR)
const SHOOB_ENCRYPTION_SECRET =
  "GaTSqvlqTrrWyTFTH2vcbRb7IJq9auX1hVjzN77pvBPp5fxH7OrIfos89P5zDHy82" +
  "K6R2MeraytWhlT6FHP0dzn4ihL87fRkYrl65036H4hSKCXNtOKqoNLoE8xl2oOcs" +
  "SZyIAkCIa6Q6LqrOQo2K0Bs3FJRrYoMTb6KkwAawwKF1QOjooFARbpefvv4ADaPW" +
  "nQQrx5S5rItE5HT76bqJeNpQ1Wgvw3dhWCjmkha939kqzIOnQA9b9DnnYj6aeLdV" +
  "VAviHzvq8iQZludOBwKknbOnJNOATdKQHmsbF8NmNcq";

// FIXED: Removed all trailing spaces from event names
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

/**
 * Decrypt one value using Shoob's browser client Cryptr-compatible format (AES-256-CTR).
 */
function decryptShoobValue(hexValue) {
  const raw = Buffer.from(hexValue, "hex");
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const key = crypto.createHash("sha256").update(SHOOB_ENCRYPTION_SECRET, "utf-8").digest();
  const cipher = crypto.createDecipheriv("aes-256-ctr", key, iv);
  const decrypted = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
  return JSON.parse(decrypted.toString("utf-8"));
}

/**
 * Extract and decrypt page data from the unified Shoob socket response.
 */
function extractPage(payload) {
  let dataPayload = payload;

  if (dataPayload && Array.isArray(dataPayload.encrypted)) {
    if (dataPayload.encrypted.length === 0) {
      return { docs: [], totalPages: null, totalDocs: null };
    }
    try {
      dataPayload = decryptShoobValue(dataPayload.encrypted[0]);
    } catch (exc) {
      throw new Error(`Could not decrypt Shoob response: ${exc.message}`);
    }
  }

  if (!dataPayload || typeof dataPayload !== "object") {
    return { docs: [], totalPages: null, totalDocs: null };
  }

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

  let totalPages = pagination.pages ?? pagination.totalPages ?? pagination.total_pages ?? null;
  let totalDocs = pagination.total ?? pagination.totalDocs ?? pagination.total_docs ?? pagination.dataTotal ?? null;
  const perPage = pagination.perPage ?? pagination.per_page ?? pagination.limit ?? null;

  if (totalPages === null && totalDocs !== null && perPage) {
    const docsNum = parseInt(totalDocs, 10);
    const limitNum = parseInt(perPage, 10);
    if (!isNaN(docsNum) && !isNaN(limitNum) && limitNum > 0) {
      totalPages = Math.ceil(docsNum / limitNum);
    }
  }

  totalPages = totalPages !== null ? parseInt(totalPages, 10) : null;
  totalDocs = totalDocs !== null ? parseInt(totalDocs, 10) : null;

  const validDocs = docs.filter((item) => item && typeof item === "object");
  return { docs: validDocs, totalPages, totalDocs };
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
  
  return { id, name, tier, series, event: eventSlug, image_url, author, author_link };
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
  console.log(`[Writer] ✅ Successfully saved ${cards.length} event cards to ${output}`);
}

async function fetchEventMenu() {
  try {
    console.log("[Preflight] 🌐 Fetching event menu from Shoob...");
    const res = await fetch(`${SHOOB_URL}/card-events`, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    
    const html = await res.text();
    const matches = [...html.matchAll(/\/card-events\/([a-z0-9][a-z0-9-]+)(?=["'\/?#]|$)/gi)];
    const slugs = [...new Set(matches.map((m) => m[1].toLowerCase()))];
    
    console.log(`[Preflight] ✅ Found ${slugs.length} events on menu.`);
    return { ok: true, slugs };
  } catch (e) {
    console.error(`[Preflight] ❌ Failed to fetch event menu: ${e.message}`);
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
    // FIXED: Shoob now uses the unified 'cardindex' protocol for events
    this.responseEvent = "cardindexres";
  }

  _requestPage(socket, eventSlug, page, retries = 2) {
    return new Promise((res, rej) => {
      const attempt = (attemptNum) => {
        const timer = setTimeout(() => {
          socket.off(this.responseEvent);
          if (attemptNum < retries) {
            console.warn(`[Retry] ⚠️ ${eventSlug} page ${page} failed (attempt ${attemptNum}/${retries}), retrying in 2s...`);
            setTimeout(() => attempt(attemptNum + 1), 2000);
          } else {
            rej(new Error(`Timeout for ${eventSlug} page ${page} after ${retries} retries (REQUEST_TIMEOUT=${REQUEST_TIMEOUT}ms)`));
          }
        }, REQUEST_TIMEOUT);

        socket.once(this.responseEvent, (payload) => {
          clearTimeout(timer);
          res(payload);
        });

        // FIXED: Emit 'cardindex' with the event parameter
        socket.emit("cardindex", {
          page,
          category: null,
          event: eventSlug,
          search: "",
          series: null,
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
      console.warn(`[Preflight] ⚠️ Event menu could not be verified: ${result.reason}`);
      return;
    }
    
    const knownSet = new Set(this.events.map((e) => e.toLowerCase()));
    const unknown = result.slugs.filter((s) => !knownSet.has(s.toLowerCase()));
    this.unknownEvents = unknown;
    
    if (unknown.length > 0) {
      console.warn(`[Preflight] ⚠️ ${unknown.length} unknown event(s) on menu: ${unknown.join(", ")}`);
      console.warn(`[Preflight] 💡 Add them to KNOWN_EVENTS in events.js to scrape them next run.`);
    } else {
      console.log(`[Preflight] ✅ Menu has ${result.slugs.length} event(s) — all covered by KNOWN_EVENTS.`);
    }
  }

  async fetchSummary() {
    await this.checkMenu();
    console.log("[Discovery] 🔌 Connecting to Shoob socket for summary...");
    
    const socket = io(SHOOB_URL, { 
      transports: ["websocket"],
      timeout: 20000,
      reconnection: false 
    });

    return new Promise((resolve, reject) => {
      socket.on("connect_error", (err) => {
        console.error(`[Socket] ❌ connect_error during summary: ${err.message}`);
        reject(new Error(`Socket connection failed: ${err.message}`));
      });

      socket.on("connect", async () => {
        console.log("[Socket] ✅ Connected successfully.");
        try {
          const eventTotals = {};
          for (const slug of this.events) {
            console.log(`[Discovery] 🔍 Fetching page 1 for event: '${slug}'...`);
            const rawPayload = await this._requestPage(socket, slug, 1, 2);
            const { totalDocs } = extractPage(rawPayload);
            const total = Number(totalDocs || 0);
            
            if (!total || total <= 0) {
              throw new Error(`Event '${slug}' returned 0 cards in discovery. It may be retired or empty.`);
            }
            
            eventTotals[slug] = total;
            this.eventStats[slug] = { expected: total, collected: 0 };
            console.log(`[Discovery] ✅ ${slug}: ${total} cards`);
          }
          
          this.expectedTotal = Object.values(eventTotals).reduce((a, b) => a + b, 0);
          console.log(`[Discovery] 🎉 Grand total: ${this.expectedTotal} event cards across ${Object.keys(eventTotals).length} events`);
          
          socket.disconnect();
          resolve({ ok: true, byEvent: eventTotals, menuChecked: true, unknownEvents: this.unknownEvents });
        } catch (err) {
          console.error(`[Discovery] ❌ Summary failed: ${err.message}`);
          socket.disconnect();
          reject(err);
        }
      });

      setTimeout(() => {
        if (!socket.connected) {
          socket.disconnect();
          const msg = `Socket connection timeout after ${PREFLIGHT_TIMEOUT}ms`;
          console.error(`[Socket] ❌ ${msg}`);
          reject(new Error(msg));
        }
      }, PREFLIGHT_TIMEOUT);
    });
  }

  async fetchAll() {
    await this.checkMenu();
    console.log("[Scraper] 🔌 Connecting to Shoob socket for full scrape...");
    
    const socket = io(SHOOB_URL, { 
      transports: ["websocket"],
      timeout: 20000,
      reconnection: false 
    });

    return new Promise((resolve, reject) => {
      socket.on("connect_error", (err) => {
        console.error(`[Socket] ❌ connect_error during fetchAll: ${err.message}`);
        reject(new Error(`Socket connection failed: ${err.message}`));
      });

      socket.on("connect", async () => {
        console.log("[Socket] ✅ Connected successfully.");
        try {
          // 1. Discovery Phase
          const eventTotals = {};
          for (const slug of this.events) {
            const rawPayload = await this._requestPage(socket, slug, 1, 2);
            const { totalDocs } = extractPage(rawPayload);
            const total = Number(totalDocs || 0);
            
            if (!total || total <= 0) {
              throw new Error(`Event '${slug}' returned 0 cards in discovery.`);
            }
            eventTotals[slug] = total;
            this.eventStats[slug] = { expected: total, collected: 0 };
          }
          
          this.expectedTotal = Object.values(eventTotals).reduce((a, b) => a + b, 0);
          console.log(`[Scraper] 🎯 Target: ${this.expectedTotal} event cards across ${Object.keys(eventTotals).length} events`);
          
          // 2. Scraping Phase
          this.phase = "scraping";
          for (const eventSlug of this.events) {
            const eventTotal = eventTotals[eventSlug];
            if (!eventTotal || eventTotal === 0) {
              console.log(`[Scraper] ⏭️ Skipping ${eventSlug} (empty)`);
              continue;
            }
            
            console.log(`[Scraper] 🚀 Scraping ${eventSlug} (${eventTotal} cards)...`);
            let page = 1;
            let totalPages = null;
            let collectedThisEvent = 0;
            
            while (true) {
              const rawPayload = await this._requestPage(socket, eventSlug, page, 2);
              const { docs, totalPages: respPages } = extractPage(rawPayload);
              
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
                    if (this.eventStats[eventSlug]) {
                      this.eventStats[eventSlug].collected = collectedThisEvent;
                    }
                  }
                } catch (exc) {
                  console.warn(`[Warning] ⚠️ Skipping invalid event card: ${exc.message}`);
                }
              }
              
              console.log(`[Scraper] 📊 ${eventSlug} page ${page}: +${docs.length} parsed, ${collectedThisEvent}/${eventTotal} collected (Total global: ${this.cards.length}/${this.expectedTotal})`);
              
              if (totalPages !== null && page >= totalPages) break;
              if (collectedThisEvent >= eventTotal) break;
              page++;
            }
          }
          
          this.phase = "done";
          socket.disconnect();
          
          if (this.cards.length === 0 && !this.existingKeys) {
            console.error("[Scraper] ❌ Shoob returned 0 event cards overall.");
            return reject(new Error("Shoob returned 0 event cards"));
          }
          
          console.log(`[Scraper] 🎉 Successfully collected ${this.cards.length} event cards!`);
          resolve(this.cards);
        } catch (err) {
          console.error(`[Scraper] ❌ Fatal error during scraping: ${err.message}`);
          socket.disconnect();
          reject(err);
        }
      });

      setTimeout(() => {
        if (!socket.connected) {
          socket.disconnect();
          const msg = `Socket connection timeout after ${PREFLIGHT_TIMEOUT}ms`;
          console.error(`[Socket] ❌ ${msg}`);
          reject(new Error(msg));
        }
      }, PREFLIGHT_TIMEOUT);
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
  console.log(`\n🚀 Starting ZCard Event Scraper...`);
  try {
    const scraper = new ShoobEventScraper({ events: args.event ? [args.event] : KNOWN_EVENTS });
    const cards = await scraper.fetchAll();
    writeCards(cards, args.output);
    const grouped = groupCardsByEvent(cards);
    const summary = Object.entries(grouped).map(([k, v]) => `${k}: ${v.length}`).join(", ");
    console.log(`\n✅ [Summary] ${summary}`);
    console.log(`🏁 Scraper finished successfully.\n`);
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ [Fatal] Scraper failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { ShoobEventScraper, groupCardsByEvent, KNOWN_EVENTS };

// end of events.js 
