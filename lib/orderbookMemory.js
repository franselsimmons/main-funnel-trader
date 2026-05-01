// orderbookMemory.js
// Bewaart raw orderbook snapshots per symbool voor:
// - wall persistence
// - absorption
// - spoof detectie
// - sniperEntry institutionele scoring
//
// Belangrijk:
// updateOrderbookMemory(symbol, rawOrderbook, analyzedOrderbook)
// Dus in tradeSystem.js:
// updateOrderbookMemory(symbol, raw, analyzed);

const memory = new Map();

const MAX_SNAPSHOTS_PER_SYMBOL = 40;
const MAX_MEMORY_AGE_MS = 10 * 60 * 1000;
const MAX_LEVELS = 25;

// ================= HELPERS =================
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBaseSymbol(raw) {
  return String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map(row => {
      if (Array.isArray(row)) {
        const price = safeNumber(row[0]);
        const qty = safeNumber(row[1]);

        return {
          price,
          qty,
          usd: price * qty
        };
      }

      const price = safeNumber(row?.price || row?.p);
      const qty = safeNumber(row?.qty || row?.size || row?.amount || row?.q);
      const usd = safeNumber(row?.usd, price * qty);

      return {
        price,
        qty,
        usd
      };
    })
    .filter(row => row.price > 0 && row.qty > 0)
    .sort((a, b) => b.usd - a.usd);
}

function toLegacyRows(rows, side = "bid") {
  const normalized = normalizeRows(rows);

  const sorted = [...normalized].sort((a, b) => {
    if (side === "bid") return b.price - a.price;
    return a.price - b.price;
  });

  // Legacy format blijft [price, qty], zodat bestaande institutional.js niet breekt.
  return sorted
    .slice(0, MAX_LEVELS)
    .map(row => [row.price, row.qty]);
}

function levelsToLegacyRows(levels, side = "bid") {
  if (!Array.isArray(levels)) return [];

  const rows = levels
    .map(level => {
      const price = safeNumber(level?.price);
      const usd = safeNumber(level?.usd);
      const qty = price > 0 ? usd / price : safeNumber(level?.qty);

      return {
        price,
        qty
      };
    })
    .filter(row => row.price > 0 && row.qty > 0);

  rows.sort((a, b) => {
    if (side === "bid") return b.price - a.price;
    return a.price - b.price;
  });

  return rows
    .slice(0, MAX_LEVELS)
    .map(row => [row.price, row.qty]);
}

function calculateMidFromRows(bids, asks) {
  const bestBid = Array.isArray(bids?.[0])
    ? safeNumber(bids[0][0])
    : safeNumber(bids?.[0]?.price);

  const bestAsk = Array.isArray(asks?.[0])
    ? safeNumber(asks[0][0])
    : safeNumber(asks?.[0]?.price);

  if (!bestBid || !bestAsk || bestAsk <= bestBid) return 0;

  return (bestBid + bestAsk) / 2;
}

function buildSnapshot(rawOb = {}, analyzedOb = {}) {
  let bids = toLegacyRows(rawOb?.bids || [], "bid");
  let asks = toLegacyRows(rawOb?.asks || [], "ask");

  // Fallback: als per ongeluk analyzed wordt meegegeven zonder raw bids/asks.
  if (!bids.length && Array.isArray(analyzedOb?.supportLevels)) {
    bids = levelsToLegacyRows(analyzedOb.supportLevels, "bid");
  }

  if (!asks.length && Array.isArray(analyzedOb?.resistanceLevels)) {
    asks = levelsToLegacyRows(analyzedOb.resistanceLevels, "ask");
  }

  if (!bids.length || !asks.length) {
    return null;
  }

  const bidRows = normalizeRows(bids);
  const askRows = normalizeRows(asks);

  const mid =
    safeNumber(analyzedOb?.mid) ||
    safeNumber(rawOb?.mid) ||
    calculateMidFromRows(bids, asks);

  return {
    ts: Date.now(),

    // Legacy fields voor bestaande institutional.js.
    bids,
    asks,
    mid,

    // Extra normalized fields voor betere toekomstige detectie.
    bidRows,
    askRows,

    spreadPct: safeNumber(analyzedOb?.spreadPct),
    depthMinUsd1p: safeNumber(analyzedOb?.depthMinUsd1p),
    bidDepthUsd1p: safeNumber(analyzedOb?.bidDepthUsd1p),
    askDepthUsd1p: safeNumber(analyzedOb?.askDepthUsd1p),

    bias: analyzedOb?.bias || "NEUTRAL",
    spoof: Boolean(analyzedOb?.spoof),
    spoofSide: analyzedOb?.spoofSide || "NONE",
    spoofUsd: safeNumber(analyzedOb?.spoofUsd),

    nearestBidWallPrice: analyzedOb?.nearestBidWallPrice || null,
    nearestAskWallPrice: analyzedOb?.nearestAskWallPrice || null,
    nearestBidWallUsd: safeNumber(analyzedOb?.nearestBidWallUsd),
    nearestAskWallUsd: safeNumber(analyzedOb?.nearestAskWallUsd),

    marketQuality: analyzedOb?.marketQuality || "UNKNOWN",
    qualityScore: safeNumber(analyzedOb?.qualityScore)
  };
}

function pruneHistory(history) {
  const now = Date.now();

  return history
    .filter(item => item && now - safeNumber(item.ts) <= MAX_MEMORY_AGE_MS)
    .slice(-MAX_SNAPSHOTS_PER_SYMBOL);
}

// ================= PUBLIC API =================
export function updateOrderbookMemory(symbol, rawOb, analyzedOb = {}) {
  const key = normalizeBaseSymbol(symbol);

  if (!key) return false;

  const snapshot = buildSnapshot(rawOb, analyzedOb);

  if (!snapshot) return false;

  const prev = memory.get(key) || [];
  const next = pruneHistory([...prev, snapshot]);

  memory.set(key, next);

  return true;
}

export function getOrderbookHistory(symbol) {
  const key = normalizeBaseSymbol(symbol);

  if (!key) return [];

  const history = memory.get(key) || [];
  const cleaned = pruneHistory(history);

  if (cleaned.length !== history.length) {
    memory.set(key, cleaned);
  }

  return cleaned;
}

export function clearOrderbookMemory(symbol = null) {
  if (!symbol) {
    memory.clear();
    return true;
  }

  const key = normalizeBaseSymbol(symbol);
  memory.delete(key);

  return true;
}

export function getOrderbookMemoryStats() {
  const out = [];

  for (const [symbol, history] of memory.entries()) {
    const cleaned = pruneHistory(history);

    out.push({
      symbol,
      snapshots: cleaned.length,
      oldestTs: cleaned[0]?.ts || null,
      newestTs: cleaned[cleaned.length - 1]?.ts || null
    });
  }

  return out.sort((a, b) => b.snapshots - a.snapshots);
}