import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import {
  fetchOrderBook,
  analyzeOrderBookAdvanced
} from "./orderbook.js";
import { calculateRisk } from "./riskManager.js";
import { logTrade, logSystemEvent } from "./logger.js";
import { getVolatility, getVolatilityRegime } from "./volatility.js";
import { getMarketContext } from "./marketContext.js";
import { buildTimeframeContext, multiTFScore } from "./timeframe.js";

import { getLiquidityZones } from "./liquidityEngine.js";
import { getLiquidationZones } from "./liquidationEngine.js";
import { calculateConfluence } from "./confluenceEngine.js";
import { fetchFunding } from "./funding.js";

import {
  getAdvancedRSIContext
} from "./rsiEngine.js";

import { getStructureState } from "./structureEngine.js";

import {
  sendEntry,
  sendHold,
  sendExit
} from "./discordNotifier.js";


// ================= CONSTANTEN =================
const COOLDOWN_MS = 45 * 60 * 1000;
const SYMBOL_REENTRY_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_SPREAD_PCT = 0.0025;
const MIN_DEPTH_USD_1P = 200000;
const MIN_RR_FLOOR = 1.0;

const DEFAULT_OB = {
  mid: 0,
  spreadPct: 0.05,
  depthMinUsd1p: 0,
  bias: "NEUTRAL",
  spoof: false,
  fetchFailed: true
};


// ================= STATE =================
const memory = new Map();
const notifyState = new Map();
const cooldownMap = new Map();
const symbolCooldownMap = new Map();
const processingLocks = new Set();
const apiCache = new Map();


// ================= CACHE =================
async function cachedFetch(key, fn, ttl = 30000) {
  const cached = apiCache.get(key);
  if (cached && Date.now() - cached.ts < ttl) return cached.data;

  const data = await fn();
  apiCache.set(key, { data, ts: Date.now() });
  return data;
}


// ================= BITGET =================
function normalizeBitgetSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.endsWith("_UMCBL")) return s;
  if (s.endsWith("USDT")) return s + "_UMCBL";
  return s + "USDT_UMCBL";
}


// 🔥 FIX: retry + rate limit protection
async function fetchCandles(symbol, timeframe = "1h", limit = 150) {
  const tfMap = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1H"
  };

  const clean = normalizeBitgetSymbol(symbol);
  const granularity = tfMap[timeframe] || "1H";

  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${clean}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);

      if (res.status === 429 || res.status === 400) {
        await new Promise(r => setTimeout(r, 250));
        continue;
      }

      const json = await res.json();

      if (!Array.isArray(json?.data)) return [];

      return json.data.map(c => ({
        openTime: Number(c[0]),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5] || 0)
      }));

    } catch {
      return [];
    }
  }

  return [];
}


// ================= HELPERS =================
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeSpread(s) {
  s = Number(s || 0);
  if (!Number.isFinite(s)) return 0.001;
  if (s > 0.05) s = s / 100;
  return s;
}


// ================= CORE =================
export async function processTrades(coins, btc = null, mode = "auto", scannerRegime = null, options = {}) {

  // 🔥 FIX: SAFE MARKET CONTEXT
  let market = {};
  try {
    market = await getMarketContext("BTCUSDT", 0);
  } catch {
    market = { trend: "NEUTRAL" };
  }

  const actions = [];

  const candidates = (coins || [])
    .slice(0, 6)
    .map(c => ({
      ...c,
      symbol: c.symbol.toUpperCase(),
      side: c.side.toLowerCase()
    }));


  for (const c of candidates) {

    const symbol = c.symbol;

    const [candles5m, candles15m, candles1h, obRaw, funding] = await Promise.all([
      cachedFetch(`c5_${symbol}`, () => fetchCandles(symbol, "5m")),
      cachedFetch(`c15_${symbol}`, () => fetchCandles(symbol, "15m")),
      cachedFetch(`c1h_${symbol}`, () => fetchCandles(symbol, "1h")),
      cachedFetch(`ob_${symbol}`, async () => {
        const raw = await fetchOrderBook(symbol + "USDT");
        return analyzeOrderBookAdvanced(raw);
      }),
      cachedFetch(`fund_${symbol}`, () => fetchFunding(symbol + "USDT"))
    ]);

    const ob = { ...DEFAULT_OB, ...(obRaw || {}) };

    // 🔥 FIX: RSI SAFE
    const rsiM15 = candles15m.length
      ? getAdvancedRSIContext(candles15m)
      : { rsi: 50 };

    const rsiH1 = candles1h.length
      ? getAdvancedRSIContext(candles1h)
      : { rsi: 50 };

    const structure = getStructureState(candles5m);

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c, ob);

    const price = ob.mid || c.price;

    const result = {
      symbol,
      side: c.side,
      price,
      flow: flow.type,
      sniper: sniper?.score || 0,
      rsi: rsiM15.rsi,
      structure: structure?.trend || "UNKNOWN",
      obBias: ob.bias,
      funding: funding?.rate || 0
    };

    actions.push(result);
  }

  return actions;
}