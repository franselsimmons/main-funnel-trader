// lib/data/coingecko.js
// CoinGecko data layer for Main Funnel
// - Fetch top coins (paginated) with 1h/24h change + safe range24
// - KV cached (versioned by SETTINGS.CG_TOP + vs_currency)
// - Small helpers for BTC snapshot

import { kv } from "@vercel/kv";

/**
 * @typedef {Object} CoinRow
 * @property {string} id
 * @property {string} symbol
 * @property {string} name
 * @property {string} image
 * @property {number} price
 * @property {number} marketCap
 * @property {number} volume
 * @property {number} change24
 * @property {number} change1h
 * @property {number} high24
 * @property {number} low24
 * @property {number} range24
 * @property {number} vm
 */

const DEFAULTS = {
  vsCurrency: "usd",
  order: "volume_desc",
  perPage: 250,
  sparkline: false,
  includeChange: "1h,24h",
};

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function safeRange24(low, high) {
  const l = n(low, 0);
  const h = n(high, 0);
  if (l > 0 && h > 0 && h >= l) return ((h - l) / l) * 100;
  return 0;
}

/**
 * Builds a stable cache key that changes when top size or currency changes.
 */
function cgTopCacheKey({ cgTop, vsCurrency }) {
  return `cg:top:v2:${vsCurrency}:${cgTop}`;
}

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

/**
 * Fetches paginated "coins/markets" up to cgTop.
 * Returns raw CoinGecko rows (not normalized), without caching.
 */
export async function fetchCoinGeckoTopRaw({
  cgTop = 1500,
  vsCurrency = DEFAULTS.vsCurrency,
  order = DEFAULTS.order,
  perPage = DEFAULTS.perPage,
  sparkline = DEFAULTS.sparkline,
  includeChange = DEFAULTS.includeChange,
} = {}) {
  const pages = Math.max(1, Math.ceil(n(cgTop, 1500) / n(perPage, 250)));
  const out = [];

  for (let page = 1; page <= pages; page++) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=${encodeURIComponent(vsCurrency)}` +
      `&order=${encodeURIComponent(order)}` +
      `&per_page=${encodeURIComponent(perPage)}` +
      `&page=${encodeURIComponent(page)}` +
      `&sparkline=${sparkline ? "true" : "false"}` +
      `&price_change_percentage=${encodeURIComponent(includeChange)}`;

    const data = await fetchJson(url, { timeoutMs: 12000 });
    if (!Array.isArray(data) || data.length === 0) break;

    out.push(...data);

    // break early if last page
    if (data.length < perPage) break;
    // stop if exceeded cgTop
    if (out.length >= cgTop) break;
  }

  return out.slice(0, cgTop);
}

/**
 * Normalize CoinGecko row to the app's internal format.
 * @param {any} c
 * @returns {CoinRow}
 */
export function normalizeCoinGeckoMarketRow(c) {
  const low = n(c?.low_24h, 0);
  const high = n(c?.high_24h, 0);
  const marketCap = n(c?.market_cap, 0);
  const volume = n(c?.total_volume, 0);
  const vm = marketCap > 0 ? volume / marketCap : volume / 1;

  return {
    id: String(c?.id || ""),
    symbol: up(c?.symbol || ""),
    name: String(c?.name || ""),
    image: String(c?.image || ""),
    price: n(c?.current_price, 0),
    marketCap,
    volume,
    change24: n(c?.price_change_percentage_24h, 0),
    // CoinGecko returns this field only when you pass price_change_percentage=1h
    change1h: n(c?.price_change_percentage_1h_in_currency, 0),
    high24: high,
    low24: low,
    range24: safeRange24(low, high),
    vm,
  };
}

/**
 * Fetches + normalizes top coins, with KV caching.
 * @returns {Promise<CoinRow[]>}
 */
export async function fetchCoinGeckoTopCached({
  SETTINGS,
  vsCurrency = DEFAULTS.vsCurrency,
  ttlSec = 60 * 60, // 1 hour
} = {}) {
  const cgTop = n(SETTINGS?.CG_TOP, 1500);
  const key = cgTopCacheKey({ cgTop, vsCurrency });

  try {
    const cached = await kv.get(key);
    if (Array.isArray(cached) && cached.length) return cached;

    const raw = await fetchCoinGeckoTopRaw({ cgTop, vsCurrency });
    const normalized = raw.map(normalizeCoinGeckoMarketRow);

    await kv.set(key, normalized, { ex: ttlSec });
    return normalized;
  } catch (e) {
    console.error("fetchCoinGeckoTopCached error:", e?.message || e);
    return [];
  }
}

/**
 * Returns a BTC snapshot derived from top list.
 */
export async function fetchBtcFromUniverse({
  SETTINGS,
  vsCurrency = DEFAULTS.vsCurrency,
} = {}) {
  try {
    const coins = await fetchCoinGeckoTopCached({ SETTINGS, vsCurrency });
    const btc = coins.find((c) => c.symbol === "BTC");
    if (!btc) throw new Error("BTC not found in CoinGecko top universe");

    const chg24 = n(btc.change24, 0);
    const state = chg24 >= 1.0 ? "BULL" : chg24 <= -1.0 ? "BEAR" : "NEUTRAL";

    return {
      price: n(btc.price, 0),
      chg24,
      chg1h: n(btc.change1h, 0),
      range24: n(btc.range24, 0),
      state,
    };
  } catch (e) {
    console.error("fetchBtcFromUniverse error:", e?.message || e);
    return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL" };
  }
}

/**
 * Utility: filter out blocked assets (stablecoins/wrapped).
 */
export function isBlockedAssetSymbol(symbol) {
  const blocked = new Set([
    "USDT",
    "USDC",
    "DAI",
    "BUSD",
    "TUSD",
    "UST",
    "LUNA",
    "WETH",
    "WBTC",
    "STETH",
  ]);
  return blocked.has(up(symbol));
}