#!/usr/bin/env node

/**
 * Download the current Shoob card catalog into cards.json.
 *
 * Usage (standalone):
 *     node cards.js
 *     node cards.js --output cards.json
 *     node cards.js --category 5
 *
 * Usage (as a module):
 *     const { ShoobCardScraper } = require("./cards.js");
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { io } = require("socket.io-client");

const SHOOB_URL = process.env.SHOOB_URL || "https://shoob.gg";
const REQUEST_TIMEOUT = 30000; // milliseconds

// Public Cryptr secret derived from Shoob's browser bundle
const SHOOB_ENCRYPTION_SECRET =
  "GaTSqvlqTrrWyTFTH2vcbRb7IJq9auX1hVjzN77pvBPp5fxH7OrIfos89P5zDHy82" +
  "K6R2MeraytWhlT6FHP0dzn4ihL87fRkYrl65036H4hSKCXNtOKqoNLoE8xl2oOcs" +
  "SZyIAkCIa6Q6LqrOQo2K0Bs3FJRrYoMTb6KkwAawwKF1QOjooFARbpefvv4ADaPW" +
  "nQQrx5S5rItE5HT76bqJeNpQ1Wgvw3dhWCjmkha939kqzIOnQA9b9DnnYj6aeLdV" +
  "VAviHzvq8iQZludOBwKknbOnJNOATdKQHmsbF8NmNcq";

/**
 * Return the first non-empty value from an object key list.
 */
function first(obj, ...keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function extractSeries(card) {
  const value = first(card, "series", "anime", "franchise", "category") ?? "";
  if (Array.isArray(value)) {
    return String(value[0] ?? "");
  }
  return String(value);
}

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

function normalizeCard(card) {
  const cardId = first(card, "_id", "id", "cardid");
  const name = first(card, "name", "card_name") ?? "Unknown";
  let tier = first(card, "tier", "category") ?? "1";

  if (Array.isArray(tier)) {
    tier = tier[0] ?? "1";
  }

  if (!cardId) {
    throw new Error(`Card has no ID: ${JSON.stringify(card)}`);
  }

  const strId = String(cardId);
  return {
    id: strId,
    name: String(name),
    tier: String(tier),
    series: extractSeries(card),
    image_url: `https://api.shoob.gg/site/api/cardr/${strId}?size=700`,
  };
}

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

  let totalPages = first(pagination, "pages", "totalPages", "total_pages");
  let totalDocs = first(pagination, "total", "totalDocs", "total_docs", "dataTotal");
  const perPage = first(pagination, "perPage", "per_page", "limit");

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

class ShoobCardScraper {
  constructor({ category = null } = {}) {
    this.category = category;
    this.cards = [];
    this.responseEvent = "cardindexres";
  }

  async fetchAll() {
    console.log(`[Shoob Scraper] Connecting to ${SHOOB_URL}...`);

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
        console.log("[Shoob Scraper] Connected. Fetching cards...");
        try {
          let page = 1;
          let totalPages = null;
          let totalDocs = null;

          while (true) {
            const rawPage = await new Promise((resPage, rejPage) => {
              const timer = setTimeout(() => {
                socket.off(this.responseEvent);
                rejPage(new Error(`No cardindexres response received for page ${page}`));
              }, REQUEST_TIMEOUT);

              socket.once(this.responseEvent, (payload) => {
                clearTimeout(timer);
                resPage(payload);
              });

              socket.emit("cardindex", {
                page,
                category: this.category,
                search: "",
                series: null,
              });
            });

            const { docs, totalPages: respPages, totalDocs: respTotal } = extractPage(rawPage);
            if (respPages !== null) totalPages = respPages;
            if (respTotal !== null) totalDocs = respTotal;

            if (docs.length === 0) break;

            let newCardsAdded = 0;
            for (const card of docs) {
              try {
                const normalized = normalizeCard(card);
                if (!this.cards.some((c) => c.id === normalized.id)) {
                  this.cards.push(normalized);
                  newCardsAdded++;
                }
              } catch (exc) {
                console.warn(`[Warning] Skipping invalid card: ${exc.message}`);
              }
            }

            const targetTotalStr = totalDocs !== null ? ` / ${totalDocs}` : "";
            console.log(
              `[Progress] Downloaded page ${page}: +${newCardsAdded} cards (Total cards collected: ${this.cards.length}${targetTotalStr})`
            );

            if (totalPages !== null && page >= totalPages) break;
            if (totalDocs !== null && this.cards.length >= totalDocs) break;

            page++;
          }

          socket.disconnect();

          if (this.cards.length === 0) {
            return reject(new Error("Shoob returned 0 cards; output file was not changed"));
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

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  if (fs.existsSync(absolutePath)) {
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 15);
    const backupPath = `${absolutePath}.${timestamp}.bak`;
    fs.copyFileSync(absolutePath, backupPath);
    console.log(`[Backup] Created backup file: ${backupPath}`);
  }

  const tempPath = path.join(dirPath, `.${path.basename(absolutePath)}.${Date.now()}.tmp`);

  const fd = fs.openSync(tempPath, "w");
  fs.writeFileSync(fd, JSON.stringify(cards, null, 2) + "\n", "utf-8");
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  fs.renameSync(tempPath, absolutePath);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    output: path.join(__dirname, "cards.json"),
    category: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      options.output = args[++i];
    } else if (args[i] === "--category" && args[i + 1]) {
      options.category = args[++i];
    }
  }

  return options;
}

async function main() {
  const args = parseArgs();
  try {
    const scraper = new ShoobCardScraper({
      category: args.category,
    });
    const cards = await scraper.fetchAll();
    writeCards(cards, args.output);
    console.log(`\n[Success] Finished! Total downloaded cards saved to ${args.output}: ${cards.length}`);
  } catch (error) {
    console.error(`[Error] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  first,
  extractSeries,
  decryptShoobValue,
  normalizeCard,
  extractPage,
  writeCards,
  parseArgs,
  ShoobCardScraper,
  SHOOB_URL,
  SHOOB_ENCRYPTION_SECRET,
};

if (require.main === module) main();

