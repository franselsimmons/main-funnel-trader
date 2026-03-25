// lib/data/bitgetPublic.js
// Bitget Public data layer for Main Funnel
// - Cached USDT spot symbols
// - Orderbook snapshot (depth/spread/imbalance + freshness flags)
// - Small, defensive helpers (timeouts, normalization)

import { kv } from "@vercel/kv";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

const BASE = "https://api.bitget.com";
const ENDPOINTS = {
  spotSymbols: "/api/v2/spot/public/symbols",
  orderbook: "/api/v2/spot/market/orderbook",
};

// ==================== SYMBOL UNIVERSE (USDT spot) ====================

const BITGET_SYMBOLS_CACHE_KEY = "bitget:symbols:spot:usdt:v1";
const BITGET_SYMBOLS_TTL_SEC = 60 * 60; // 1 hour

/**
 * Returns Set(["BTCUSDT", "ETHUSDT", ...]) for Bitget spot USDT symbols.
 * Cached in KV.
 */
export async function getBitgetSpotUsdtSymbols({ ttlSec = BITGET_SYMBOLS_TTL_SEC } = {}) {
  try {
    const cached = await kv.get(BITGET_SYMBOLS_CACHE_KEY);
    if (Array.isArray(cached) && cached.length) return new Set(cached);

    const url = `${BASE}${ENDPOINTS.spotSymbols}`;
    const json = await fetchJsonWithTimeout(url, { headers: { accept: "application/json" } }, 12000);

    if (String(json?.code) !== "00000") throw new Error(`Bitget error: ${json?.msg || "unknown"}`);
    const rows = Array.isArray(json?.data) ? json.data : [];

    const symbols = rows
      .filter((s) => up(s?.quoteCoin) === "USDT")
      .map((s) => up(s?.symbol))
      .filter(Boolean);

    // Persist as array (KV cannot store Set)
    await kv.set(BITGET_SYMBOLS_CACHE_KEY, symbols, { ex: ttlSec });
    return new Set(symbols);
  } catch (e) {
    console.error("getBitgetSpotUsdtSymbols error:", e?.message || e);
    return new Set();
  }
}

// ==================== ORDERBOOK ====================

/**
 * We use step0 for tight spreads; limit 20 is enough for depth metrics.
 * Docs field names sometimes vary; we handle both shapes.
 */
export const BITGET_OB_DEFAULTS = {
  type: "step0",
  limit: 20,
  timeoutMs: 7000,
};

function parseOrderbookPayload(json) {
  // Standard response:
  // { code:"00000", data:{ asks:[[price, size],...], bids:[[price, size],...], ts:"..." } }
  if (String(json?.code) !== "00000") return null;
  const data = json?.data || {};
  const bids = Array.isArray(data?.bids) ? data.bids : [];
  const asks = Array.isArray(data?.asks) ? data.asks : [];

  if (!bids.length || !asks.length) return null;

  const bestBid = n(bids?.[0]?.[0], 0);
  const bestAsk = n(asks?.[0]?.[0], 0);
  if (!(bestBid > 0 && bestAsk > 0)) return null;

  // some payloads include ts as string/number
  const ts = n(data?.ts, 0);

  return { bids, asks, bestBid, bestAsk, ts };
}

function computeDepthUsd(levels, takeN = 8) {
  const slice = levels.slice(0, takeN);
  return slice.reduce((sum, lvl) => sum + n(lvl?.[0], 0) * n(lvl?.[1], 0), 0);
}

function computeLargestOrderUsd(levels, takeN = 8) {
  const slice = levels.slice(0, takeN);
  let best = 0;
  for (const lvl of slice) {
    const v = n(lvl?.[0], 0) * n(lvl?.[1], 0);
    if (v > best) best = v;
  }
  return best;
}

/**
 * Fetch Bitget spot orderbook for e.g. "BTCUSDT".
 * Returns a normalized snapshot used by scoring.
 */
export async function fetchBitgetOrderbook(symbol, opts = {}) {
  const { type, limit, timeoutMs } = { ...BITGET_OB_DEFAULTS, ...opts };

  const sym = up(symbol);
  if (!sym.endsWith("USDT")) {
    // we expect the caller to pass <BASE>USDT, but don't crash
    console.warn("fetchBitgetOrderbook: symbol does not end with USDT:", sym);
  }

  try {
    const url = `${BASE}${ENDPOINTS.orderbook}?symbol=${encodeURIComponent(sym)}&type=${encodeURIComponent(
      type
    )}&limit=${encodeURIComponent(limit)}`;

    const json = await fetchJsonWithTimeout(url, { headers: { accept: "application/json" } }, timeoutMs);
    const parsed = parseOrderbookPayload(json);

    if (!parsed) {
      return {
        status: "none",
        valid: false,
        fresh: false,
        stale: true,
        reason: "invalid_payload",
        bestBid: 0,
        bestAsk: 0,
        spreadPct: 999,
        depthBidUsd: 0,
        depthAskUsd: 0,
        depthMinUsd1p: 0,
        score: 0,
        lor: 1,
        ts: 0,
      };
    }

    const { bids, asks, bestBid, bestAsk, ts } = parsed;

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;

    const depthBidUsd = computeDepthUsd(bids, 8);
    const depthAskUsd = computeDepthUsd(asks, 8);
    const totalDepth = depthBidUsd + depthAskUsd;

    // imbalance score in [-1, 1] where + means bid-heavy
    const score = totalDepth > 0 ? (depthBidUsd - depthAskUsd) / totalDepth : 0;

    // largest order ratio (largest order / total depth)
    const largestBidUsd = computeLargestOrderUsd(bids, 8);
    const largestAskUsd = computeLargestOrderUsd(asks, 8);
    const lor = totalDepth > 0 ? Math.max(largestBidUsd, largestAskUsd) / totalDepth : 0;

    // freshness: Bitget ts is exchange-side; we still mark fresh if we got valid data
    return {
      status: "ok",
      valid: true,
      fresh: true,
      stale: false,
      reason: "",
      bestBid,
      bestAsk,
      spreadPct,
      depthBidUsd,
      depthAskUsd,
      depthMinUsd1p: Math.min(depthBidUsd, depthAskUsd),
      score,
      lor,
      ts,
    };
  } catch (e) {
    // Timeout or network error -> safe object
    return {
      status: "error",
      valid: false,
      fresh: false,
      stale: true,
      reason: String(e?.message || "fetch_failed"),
      bestBid: 0,
      bestAsk: 0,
      spreadPct: 999,
      depthBidUsd: 0,
      depthAskUsd: 0,
      depthMinUsd1p: 0,
      score: 0,
      lor: 1,
      ts: 0,
    };
  }
}

/**
 * Convenience: computes the OB symbol from a coin symbol e.g. "BTC" -> "BTCUSDT".
 */
export function toBitgetUsdtSymbol(baseSymbol) {
  const s = up(baseSymbol);
  return s.endsWith("USDT") ? s : `${s}USDT`;
}