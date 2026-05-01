// tradeSystem.js - Balanced Sniper Version
// - Geen C_ENTRY
// - Geen max coins cap in tradeSystem
// - Open posities worden altijd gemonitord
// - Position management vóór cooldown / entry guards
// - Confluence vóór sniper
// - A/B entries aangescherpt maar niet doodgeslagen
// - RSI MID toegestaan alleen bij sterke trend
// - Shorts in LOWER_2 geblokkeerd
// - Scaling uit: maxEntries = 1

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
  getMTFRSI,
  getRSISignal
} from "./rsiEngine.js";

import {
  sendEntry,
  sendExit
} from "./discordNotifier.js";

import { updateOrderbookMemory } from "./orderbookMemory.js";

// ================= CACHE LAYER =================
const apiCache = new Map();

async function cachedFetch(key, fn, ttl = 30000) {
  const cached = apiCache.get(key);

  if (cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }

  const data = await fn();
  apiCache.set(key, { data, ts: Date.now() });

  return data;
}

// ================= CONSTANTEN =================
const COOLDOWN_MS = 45 * 60 * 1000;
const SYMBOL_REENTRY_COOLDOWN_MS = 60 * 60 * 1000;

const MAX_SPREAD_PCT = 0.0025;
const HARD_MAX_SPREAD_PCT = 0.0060;

const MIN_DEPTH_USD_1P = 200000;
const HARD_MIN_DEPTH_USD_1P = 75000;

const MIN_RR_FLOOR = 1.0;
const GRADE_A_MIN_RR_FLOOR = 1.0;
const GRADE_B_MIN_RR_FLOOR = 1.00;
const GRADE_C_MIN_RR_FLOOR = 1.05;
const COUNTERTREND_MIN_RR_FLOOR = 1.40;
const BUILDUP_MIN_RR_FLOOR = 1.20;

const A_MIN_SNIPER = 70;
const A_MIN_CONF = 75;
const A_MIN_RR = 1.10;

const B_MIN_SNIPER = 60;
const B_MIN_CONF = 68;
const B_MIN_RR = 1.05;

const GOD_MIN_SNIPER = 85;
const GOD_MIN_CONF = 85;
const GOD_MIN_RR = 1.20;

const BUILDUP_ELITE_MIN_TF = 2;

const MAX_ENTRIES_PER_POSITION = 1;

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
const lastSignalMap = new Map();

// ================= NORMALIZERS =================
function normalizeBitgetSymbol(raw) {
  let s = String(raw || "").toUpperCase().trim();

  s = s
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  if (!s.endsWith("USDT") && !s.endsWith("USDC")) {
    s = `${s}USDT`;
  }

  return s;
}

function normalizeBaseSymbol(raw) {
  return String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/USDT$/, "")
    .replace(/USDC$/, "")
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");
}

function normalizeSide(side) {
  const s = String(side || "").toLowerCase();
  if (s === "bull" || s === "long") return "bull";
  if (s === "bear" || s === "short") return "bear";
  return "";
}

// ================= CANDLE FETCH =================
async function fetchCandles(symbol, timeframe = "1h", limit = 100) {
  const tfMap = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1H",
    "4h": "4H"
  };

  const granularity = tfMap[timeframe] || "1H";
  const clean = normalizeBitgetSymbol(symbol);

  const url =
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${clean}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);

      if (res.status === 429 || res.status === 400) {
        console.warn(`⚠️ BITGET candle limit (${res.status}) voor ${clean}, attempt ${attempt + 1}`);
        await sleep(250);
        continue;
      }

      const json = await res.json();

      if (!Array.isArray(json?.data)) {
        return [];
      }

      return json.data.map(c => ({
        openTime: Number(c[0]),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5] || 0)
      }));
    } catch (e) {
      console.error(`Candle fetch error voor ${clean}:`, e.message);
      return [];
    }
  }

  return [];
}

// ================= HELPERS =================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);

  if (!Number.isFinite(s) || s < 0) {
    return 0.001;
  }

  if (s > 0.05) {
    s = s / 100;
  }

  return s;
}

function calculateFallbackRR(c, risk, isBull) {
  const price = Number(c.price || 0);
  const sl = Number(risk?.sl || 0);
  const tp = Number(risk?.tp || 0);

  if (!price || !sl || !tp) {
    return 0;
  }

  const raw = isBull
    ? (tp - price) / (price - sl)
    : (price - tp) / (sl - price);

  return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

function cleanExpiredGuards() {
  const now = Date.now();

  for (const [key, until] of cooldownMap) {
    if (now >= until) cooldownMap.delete(key);
  }

  for (const [symbol, until] of symbolCooldownMap) {
    if (now >= until) symbolCooldownMap.delete(symbol);
  }

  for (const [symbol, until] of lastSignalMap) {
    if (now >= until) lastSignalMap.delete(symbol);
  }
}

function hasAnyOpenPositionForSymbol(symbol) {
  const s = normalizeBaseSymbol(symbol);

  for (const key of memory.keys()) {
    if (key.startsWith(`${s}_`)) {
      return true;
    }
  }

  return false;
}

function getOpenPositionSideForSymbol(symbol) {
  const s = normalizeBaseSymbol(symbol);

  for (const key of memory.keys()) {
    if (key.startsWith(`${s}_`)) {
      return key.split("_")[1] || "unknown";
    }
  }

  return null;
}

function stageRank(stage) {
  if (stage === "entry") return 4;
  if (stage === "almost") return 3;
  if (stage === "buildup") return 2;
  if (stage === "radar") return 1;
  return 0;
}

function getSniperScore(sniper) {
  return Number(sniper?.score || 0);
}

function getRegimeKey(regimeObj, scannerRegime) {
  const raw = regimeObj?.level || regimeObj || scannerRegime || "NORMAL";
  return String(raw).toUpperCase();
}

function getRegimeValueForConfluence(regime, scannerRegime) {
  return regime?.level || regime || scannerRegime || "NORMAL";
}

function getTimeframeMeta(c) {
  let ctx = {};
  let tfScore = 0;

  try {
    ctx = buildTimeframeContext(c) || {};
  } catch {
    ctx = {};
  }

  if (Number.isFinite(Number(ctx?.score))) {
    tfScore = Number(ctx.score);
  } else if (Number.isFinite(Number(c?.tfScore))) {
    tfScore = Number(c.tfScore);
  } else {
    tfScore = Number(multiTFScore(c) || 0);
  }

  return {
    ctx,
    tfScore,
    tfStrength: Math.abs(tfScore),
    tfAlignment: String(ctx?.alignment || c?.tfAlignment || "UNKNOWN")
  };
}

function isObWithSide(ob, isBull) {
  return (
    (isBull && ob?.bias === "BULLISH") ||
    (!isBull && ob?.bias === "BEARISH")
  );
}

function isObAgainstSide(ob, isBull) {
  return (
    (isBull && ob?.bias === "BEARISH") ||
    (!isBull && ob?.bias === "BULLISH")
  );
}

function buildCommonPayload(c, flow, sniper, funding, ob) {
  return {
    symbol: c.symbol,
    side: c.side,
    stage: c.stage,
    stageSource: c.stageSource || "unknown",
    uiOnly: Boolean(c.uiOnly),
    score: Number(c.moveScore || 0),
    price: Number(c.price || 0),

    flow: flow?.type || "NEUTRAL",
    sniper: sniper?.type || "NONE",
    sniperScore: sniper?.score || 0,

    funding: funding?.rate || 0,
    obBias: ob?.bias || "NEUTRAL",
    spreadPct: ob?.spreadPct ?? null,
    depthMinUsd1p: ob?.depthMinUsd1p ?? null,

    tfScore: Number(c?.tfScore || 0),
    tfStrength: Number(c?.tfStrength || 0),
    tfAlignment: c?.tfAlignment || "UNKNOWN",

    minRrRequired: Number(c?.minRrFloor || 0),
    ts: Date.now()
  };
}

function getDynamicBreakoutBufferPct(c, regimeObj, vol, ob) {
  const ch1Abs = Math.abs(Number(c.change1h || 0));
  const ch24Abs = Math.abs(Number(c.change24 || 0));
  const spread = normalizeSpread(ob?.spreadPct);
  const regimeKey = getRegimeKey(regimeObj, null);

  let pct = 0.0025;

  pct += clamp((ch1Abs / 100) * 0.70, 0, 0.0050);
  pct += clamp((ch24Abs / 100) * 0.10, 0, 0.0030);
  pct += clamp(spread * 0.60, 0, 0.0015);

  if (vol === "HIGH") pct += 0.0010;
  if (regimeKey === "HIGH_VOL" || regimeKey === "HIGH") pct += 0.0010;
  if (regimeKey === "LOW_VOL" || regimeKey === "LOW") pct -= 0.0005;

  return clamp(pct, 0.0025, 0.0120);
}

function getRsiZone(rsiSignal) {
  const rsi = Number(rsiSignal?.rsi);
  const zones = rsiSignal?.zones;

  if (!Number.isFinite(rsi) || !zones) {
    return "MID";
  }

  if (rsi >= zones.U3) return "UPPER_3";
  if (rsi >= zones.U2) return "UPPER_2";
  if (rsi >= zones.U1) return "UPPER_1";

  if (rsi <= zones.L3) return "LOWER_3";
  if (rsi <= zones.L2) return "LOWER_2";
  if (rsi <= zones.L1) return "LOWER_1";

  return "MID";
}

function getDirectionalChange(c, isBull, field) {
  const raw = Number(c?.[field] || 0);
  return raw * (isBull ? 1 : -1);
}

function isStaleExtendedMove(c) {
  const ch24Abs = Math.abs(Number(c.change24 || 0));
  const ch1Abs = Math.abs(Number(c.change1h || 0));

  return ch24Abs > 8 && ch1Abs < 0.10;
}

function isMarketQualityHardBlocked(ob) {
  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);

  if (spread > HARD_MAX_SPREAD_PCT) return true;
  if (depth > 0 && depth < HARD_MIN_DEPTH_USD_1P) return true;

  return false;
}

function dedupeCandidates(coins) {
  const map = new Map();

  for (const raw of Array.isArray(coins) ? coins : []) {
    if (!raw?.symbol || !raw?.side) continue;

    const symbol = normalizeBaseSymbol(raw.symbol);
    const side = normalizeSide(raw.side);

    if (!symbol || !side) continue;

    const moveScore = Number(raw.moveScore ?? raw.score ?? 0);

    const normalized = {
      ...raw,
      symbol,
      side,
      moveScore,
      stage: raw.stage || "radar"
    };

    const key = `${symbol}_${side}`;
    const prev = map.get(key);

    if (!prev) {
      map.set(key, normalized);
      continue;
    }

    const prevStage = stageRank(prev.stage);
    const newStage = stageRank(normalized.stage);
    const prevScore = Number(prev.moveScore || 0);
    const newScore = Number(normalized.moveScore || 0);

    if (newStage > prevStage || (newStage === prevStage && newScore > prevScore)) {
      map.set(key, normalized);
    }
  }

  return Array.from(map.values())
    .sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));
}

function addOpenPositionsToCandidates(candidates) {
  const map = new Map();

  for (const c of candidates) {
    map.set(`${c.symbol}_${c.side}`, c);
  }

  for (const [key, pos] of memory.entries()) {
    const [symbol, side] = key.split("_");

    if (!symbol || !side) continue;
    if (map.has(key)) continue;

    map.set(key, {
      symbol,
      side,
      stage: "entry",
      stageSource: "position_memory",
      analysisType: "POSITION_MONITOR",
      moveScore: Number(pos.score || 100),
      price: Number(pos.entry || 0),
      rawBitgetSymbol: pos.rawBitgetSymbol || `${symbol}USDT`,
      tfStrength: Number(pos.tfStrength || 1),
      tfScore: Number(pos.tfScore || 0),
      tfAlignment: pos.tfAlignment || "UNKNOWN"
    });
  }

  return Array.from(map.values());
}

function chunkArray(arr, size) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
}

// ================= GRADE =================
function getSetupGrade({
  c,
  ob,
  flow,
  sniper,
  confluence,
  rr,
  hasLiquidationData,
  isBull
}) {
  let points = 0;

  const tfStrength = Number(c?.tfStrength || 0);
  const sniperScore = getSniperScore(sniper);

  if (confluence >= 85) points += 4;
  else if (confluence >= 75) points += 3;
  else if (confluence >= 65) points += 2;
  else if (confluence >= 55) points += 1;

  if (flow.type === "TREND") points += 2;
  else if (flow.type === "BUILDING") points += 1;

  if (sniper?.valid) points += 2;
  if (sniperScore >= 75) points += 1;

  if (tfStrength >= 2) points += 2;
  else if (tfStrength >= 1) points += 1;

  if (isObWithSide(ob, isBull)) points += 2;
  if (isObAgainstSide(ob, isBull)) points -= 2;

  if (hasLiquidationData) points += 1;

  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);

  if (spread <= MAX_SPREAD_PCT && depth >= MIN_DEPTH_USD_1P) {
    points += 1;
  }

  if (spread > MAX_SPREAD_PCT || depth < MIN_DEPTH_USD_1P) {
    points -= 2;
  }

  if (c.stage === "entry") {
    points += 1;
  } else if (c.stage === "buildup" && flow.type === "TREND" && tfStrength >= 2) {
    points += 1;
  }

  if (rr >= 1.4) points += 1;
  else if (rr < 0.8) points -= 1;

  let grade = "C";
  let recommendedRisk = "watch";

  if (points >= 9) {
    grade = "A";
    recommendedRisk = "normal";
  } else if (points >= 7) {
    grade = "B";
    recommendedRisk = "small";
  }

  if (grade === "A" && confluence < 70) {
    grade = "B";
    recommendedRisk = "small";
  }

  return { grade, points, recommendedRisk };
}

function buildWait(
  c,
  reason,
  flow,
  sniper,
  confluence,
  rr,
  funding,
  ob,
  risk,
  setupGrade,
  requiredConfluence,
  requiredRR
) {
  const base = {
    ...buildCommonPayload(c, flow, sniper, funding, ob),
    action: "WAIT",
    reason,
    grade: setupGrade?.grade || "C",
    gradePoints: setupGrade?.points || 0,
    recommendedRisk: setupGrade?.recommendedRisk || "watch",
    confluence,
    rr: Number(rr || 0).toFixed(2),
    entry: risk?.entry ?? c.price ?? null,
    sl: risk?.sl ?? null,
    tp: risk?.tp ?? null,
    slSource: risk?.slSource || "liquidity/orderbook",
    tpSource: risk?.tpSource || "liquidity/liquidation",
    requiredConfluence: requiredConfluence ?? null,
    requiredRR: requiredRR ?? null
  };

  let reasonScore = null;

  if (reason === "LOW_CONFLUENCE" && requiredConfluence !== null && confluence !== null) {
    reasonScore = confluence - requiredConfluence;
  }

  if (reason === "LOW_RR" && requiredRR !== null && rr !== null) {
    reasonScore = rr - requiredRR;
  }

  base.reasonScore = reasonScore;

  console.log(
    `🚫 BLOCK: ${c.symbol} | ${reason} | rsiZone=${c._debugRsiZone || "?"} | sniper=${sniper?.score || 0} | conf=${confluence} | rr=${Number(rr || 0).toFixed(2)} | fake=${c._debugFakeBreakout} | flow=${flow?.type}`
  );

  return base;
}

function getDynamicMinRrFloor({
  c,
  setupGrade,
  flow,
  sniper,
  confluence,
  counterTrend
}) {
  let floor = MIN_RR_FLOOR;

  if (setupGrade?.grade === "A") {
    floor = GRADE_A_MIN_RR_FLOOR;
  } else if (setupGrade?.grade === "B") {
    floor = GRADE_B_MIN_RR_FLOOR;
  } else {
    floor = GRADE_C_MIN_RR_FLOOR;
  }

  if (c.stage === "buildup") {
    floor = Math.max(floor, BUILDUP_MIN_RR_FLOOR);
  }

  if (counterTrend) {
    floor = Math.max(floor, COUNTERTREND_MIN_RR_FLOOR);
  }

  if (
    c.stage === "entry" &&
    flow?.type === "TREND" &&
    !counterTrend &&
    setupGrade?.grade === "A" &&
    confluence >= 88 &&
    sniper?.valid &&
    getSniperScore(sniper) >= 80
  ) {
    floor = Math.min(floor, 0.95);
  }

  return clamp(floor, 0.8, 1.50);
}

function getSniperAdjustedRR(sniper, baseRR) {
  const score = Number(sniper?.score || 0);

  if (score >= 90) return Math.max(0.90, baseRR - 0.20);
  if (score >= 80) return Math.max(0.95, baseRR - 0.10);
  if (score >= 70) return Math.max(1.00, baseRR - 0.05);

  return baseRR + 0.05;
}

async function logAction(actionPayload, regimeLevel, btcState, shouldLog) {
  if (!shouldLog || !actionPayload) return;

  await logSystemEvent({
    ...actionPayload,
    regime: regimeLevel,
    btcState
  });
}

// ================= DATA FETCH =================
async function fetchCoinData(c) {
  const symbol = normalizeBaseSymbol(c.symbol);
  const cleanPair = normalizeBitgetSymbol(c.rawBitgetSymbol || c.bitgetSymbol || c.symbol);

  let ob = { ...DEFAULT_OB };

  try {
    const raw = await cachedFetch(
      `ob_${symbol}`,
      async () => {
        let data = null;

        for (let i = 0; i < 2; i++) {
          try {
            data = await fetchOrderBook(cleanPair);
            if (data) break;
          } catch {}

          await sleep(200);
        }

        return data;
      },
      15000
    );

    if (raw) {
      const analyzed = analyzeOrderBookAdvanced(raw);
      ob = {
        ...DEFAULT_OB,
        ...(analyzed || {}),
        fetchFailed: false
      };

      updateOrderbookMemory(symbol, analyzed);
    }
  } catch {
    ob = { ...DEFAULT_OB };
  }

  let funding = { rate: 0 };

  try {
    funding = await cachedFetch(
      `fund_${symbol}`,
      () => fetchFunding(cleanPair),
      120000
    );
  } catch {}

  const [candles15m, candles1h] = await Promise.all([
    cachedFetch(`c15_${cleanPair}`, () => fetchCandles(cleanPair, "15m", 100), 20000),
    cachedFetch(`c1h_${cleanPair}`, () => fetchCandles(cleanPair, "1h", 100), 20000)
  ]);

  let candles4h = null;

  if (Number(c.tfStrength || 0) >= 2) {
    candles4h = await cachedFetch(
      `c4h_${cleanPair}`,
      () => fetchCandles(cleanPair, "4h", 100),
      30000
    ).catch(() => null);
  }

  const mtfRsi = getMTFRSI({
    m15: candles15m,
    h1: candles1h,
    h4: candles4h
  });

  const rsiData = {
    mtf: mtfRsi,
    structure: { trend: "NEUTRAL" },
    candles15m,
    candles1h
  };

  let liquidation = null;

  try {
    const liqPrice = Number(ob?.mid || c.price || c.lastPrice || 0);
    liquidation = await getLiquidationZones(cleanPair, liqPrice);
  } catch (e) {
    console.warn(`Liquidation fetch failed for ${symbol}:`, e.message);
  }

  return {
    symbol,
    ob,
    funding,
    rsiData,
    liquidation
  };
}

// ================= POSITION MANAGEMENT =================
async function handleExistingPosition({
  c,
  key,
  pos,
  flow,
  sniper,
  funding,
  ob,
  confluence,
  regimeLevel,
  btcState,
  notify,
  shouldLog
}) {
  const isBull = c.side === "bull";
  const price = Number(c.price || 0);

  if (!price) {
    return {
      handled: true,
      action: {
        ...buildCommonPayload(c, flow, sniper, funding, ob),
        action: "HOLD",
        reason: "NO_PRICE_FOR_EXIT_CHECK",
        grade: pos.grade || "N/A",
        gradePoints: pos.gradePoints || 0,
        recommendedRisk: pos.recommendedRisk || "N/A",
        confluence,
        rr: Number(pos.rr || 0).toFixed(2),
        entry: pos.entry,
        sl: pos.sl,
        tp: pos.tp
      }
    };
  }

  const hitTP = isBull
    ? price >= Number(pos.tp || 0)
    : price <= Number(pos.tp || 0);

  const hitSL = isBull
    ? price <= Number(pos.sl || 0)
    : price >= Number(pos.sl || 0);

  if (hitTP || hitSL) {
    const reason = hitTP ? "TP" : "SL";

    const exitPayload = {
      ...buildCommonPayload(c, flow, sniper, funding, ob),
      action: "EXIT",
      reason,
      grade: pos.grade || "N/A",
      gradePoints: pos.gradePoints || 0,
      recommendedRisk: pos.recommendedRisk || "N/A",
      confluence,
      rr: Number(pos.rr || 0).toFixed(2),
      entry: pos.entry,
      sl: pos.sl,
      tp: pos.tp,
      slSource: pos.slSource || "N/A",
      tpSource: pos.tpSource || "N/A",
      rsi: pos.rsi,
      rsiHTF: pos.rsiHTF,
      rsiZone: pos.rsiZone
    };

    if (shouldLog) {
      await logTrade({
        symbol: c.symbol,
        side: c.side,
        entry: pos.entry,
        exit: price,
        sl: pos.sl,
        tp: pos.tp,
        result: hitTP ? "WIN" : "LOSS",
        reason,
        rr: pos.rr,
        grade: pos.grade || "N/A",
        gradePoints: pos.gradePoints || 0,
        recommendedRisk: pos.recommendedRisk || "N/A",
        confluence,
        score: c.moveScore,
        flow: flow.type,
        sniper: sniper?.type || "NONE",
        sniperScore: getSniperScore(sniper),
        obBias: ob.bias,
        funding: funding.rate || 0,
        slSource: pos.slSource || "N/A",
        tpSource: pos.tpSource || "N/A",
        regime: regimeLevel,
        btcState,
        rsi: pos.rsi,
        rsiHTF: pos.rsiHTF,
        rsiZone: pos.rsiZone
      });
    }

    const exitKey = `${key}_exit`;

    if (notify && !notifyState.get(exitKey)) {
      await sendExit({
        symbol: c.symbol,
        side: c.side,
        reason,
        rr: pos.rr,
        grade: pos.grade,
        entry: pos.entry,
        sl: pos.sl,
        tp: pos.tp
      });

      notifyState.set(exitKey, true);
    }

    memory.delete(key);
    notifyState.delete(key);
    notifyState.delete(`${key}_hold`);
    notifyState.delete(`${key}_exit`);

    cooldownMap.set(key, Date.now() + COOLDOWN_MS);
    symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
    lastSignalMap.delete(c.symbol);

    return {
      handled: true,
      action: exitPayload
    };
  }

  const holdPayload = {
    ...buildCommonPayload(c, flow, sniper, funding, ob),
    action: "HOLD",
    reason: "RUNNING",
    grade: pos.grade || "N/A",
    gradePoints: pos.gradePoints || 0,
    recommendedRisk: pos.recommendedRisk || "N/A",
    confluence,
    rr: Number(pos.rr || 0).toFixed(2),
    entry: pos.entry,
    sl: pos.sl,
    tp: pos.tp,
    slSource: pos.slSource || "N/A",
    tpSource: pos.tpSource || "N/A",
    rsi: pos.rsi,
    rsiHTF: pos.rsiHTF,
    rsiZone: pos.rsiZone
  };

  await logAction(holdPayload, regimeLevel, btcState, shouldLog);

  return {
    handled: true,
    action: holdPayload
  };
}

// ================= CORE =================
export async function processTrades(input, options = {}) {
  const notify = options.notify !== false;
  const shouldLog = options.log !== false;
  const certaintyMode = options.certaintyMode || "balanced";

  let candidatesRaw = [];
  let scanRegime = options.regime || null;
  let scanBtc = options.btc || null;

  if (Array.isArray(input)) {
    candidatesRaw = input;
  } else {
    candidatesRaw = [
      ...(input?.funnel?.bull?.entry || []),
      ...(input?.funnel?.bear?.entry || []),
      ...(input?.funnel?.bull?.almost || []),
      ...(input?.funnel?.bear?.almost || []),
      ...(input?.funnel?.bull?.buildup || []),
      ...(input?.funnel?.bear?.buildup || [])
    ];

    scanRegime = input?.regime || scanRegime;
    scanBtc = input?.btc || scanBtc;
  }

  let candidates = dedupeCandidates(candidatesRaw)
    .filter(c => {
      const score = Number(c.moveScore || 0);
      const stage = String(c.stage || "");

      if (c.analysisType === "POSITION_MONITOR") return true;
      if (stage === "entry" || stage === "almost") return score >= 45;
      if (stage === "buildup") return score >= 60;

      return false;
    });

  candidates = addOpenPositionsToCandidates(candidates);

  for (const c of candidates) {
    if (c.analysisType) continue;

    const score = Number(c.moveScore || 0);
    const stage = String(c.stage || "");

    c.analysisType =
      stage === "entry" || score >= 70
        ? "DEEP"
        : "LIGHT";
  }

  if (candidates.length === 0) {
    return {
      actions: [],
      candidatesCount: 0
    };
  }

  cleanExpiredGuards();

  const actions = [];

  let market = { trend: "NEUTRAL" };

  try {
    market = await getMarketContext("BTCUSDT", 0);
  } catch (e) {
    console.warn("Market context fallback:", e.message);
  }

  const btcState = scanBtc?.state || market?.trend || "NEUTRAL";

  // ================= DATA FETCH =================
  const dataMap = new Map();
  const uniqueBySymbol = new Map();

  for (const c of candidates) {
    uniqueBySymbol.set(c.symbol, c);
  }

  const dataChunks = chunkArray(Array.from(uniqueBySymbol.values()), 4);

  for (const chunk of dataChunks) {
    const rows = await Promise.all(chunk.map(fetchCoinData));

    for (const row of rows) {
      dataMap.set(row.symbol, row);
    }
  }

  // ================= PROCESS COINS =================
  for (const originalCoin of candidates) {
    const c = {
      ...originalCoin,
      symbol: normalizeBaseSymbol(originalCoin.symbol),
      side: normalizeSide(originalCoin.side)
    };

    if (!c.symbol || !c.side) continue;

    const key = `${c.symbol}_${c.side}`;
    const symbolLockKey = `LOCK_${c.symbol}`;
    const prev = memory.get(key);

    const row = dataMap.get(c.symbol) || {
      ob: { ...DEFAULT_OB },
      funding: { rate: 0 },
      rsiData: null,
      liquidation: null
    };

    const ob = row.ob || { ...DEFAULT_OB };
    const funding = row.funding || { rate: 0 };
    const rsiData = row.rsiData || null;
    const liquidation = row.liquidation || null;

    if (ob?.mid > 0) {
      c.price = ob.mid;
    } else if (!c.price || c.price === 0) {
      c.price = Number(c.lastPrice || 0);
    }

    const isBull = c.side === "bull";

    const tfMeta = getTimeframeMeta(c);
    c.tfStrength = tfMeta.tfStrength;
    c.tfScore = tfMeta.tfScore;
    c.tfAlignment = tfMeta.tfAlignment;
    c.atrPct15m = Number(tfMeta.ctx?.atrPct15m || 0);
    c.atrPct1h = Number(tfMeta.ctx?.atrPct1h || 0);
    c.atrPct4h = Number(tfMeta.ctx?.atrPct4h || 0);
    c.atrPct24h = Number(tfMeta.ctx?.atrPct24h || 0);

    if (!isBull && btcState === "BEARISH") {
      c.tfStrength += 0.5;
      c.moveScore = Number(c.moveScore || 0) + 2;
    }

    const flow = analyzeFlow(c);
    c.flow = flow.type;

    const vol = getVolatility(c);
    const regime = getVolatilityRegime(c);
    const regimeLevel = getRegimeKey(regime, scanRegime);
    const regimeForConfluence = getRegimeValueForConfluence(regime, scanRegime);

    const liquidity = getLiquidityZones(c, ob);
    const hasLiquidationData =
      Array.isArray(liquidation?.clusters) &&
      liquidation.clusters.length > 0;

    const rsiSignal = rsiData?.mtf
      ? getRSISignal(rsiData.mtf, c.side)
      : { valid: false, strength: 0 };

    const rsi = Number.isFinite(rsiSignal?.rsi)
      ? Number(rsiSignal.rsi)
      : null;

    const rsiZone = getRsiZone(rsiSignal);
    c._debugRsiZone = rsiZone;

    const rawRsiCtx = rsiData?.mtf?.m15;

    const rsiContext =
      rawRsiCtx &&
      Number.isFinite(rawRsiCtx.rsi) &&
      rawRsiCtx.zones
        ? {
            valid: true,
            rsi: rawRsiCtx.rsi,
            zones: rawRsiCtx.zones
          }
        : null;

    const confluence = calculateConfluence(
      c,
      ob,
      liquidity,
      funding,
      regimeForConfluence,
      hasLiquidationData ? liquidation : null,
      rsiContext
    );

    c.confluence = confluence;

    const sniper = getSniperEntry(c, ob, rsiSignal);
    const sniperScore = getSniperScore(sniper);

    // ========== POSITION MANAGEMENT EERST ==========
    if (prev) {
      const positionResult = await handleExistingPosition({
        c,
        key,
        pos: prev,
        flow,
        sniper,
        funding,
        ob,
        confluence,
        regimeLevel,
        btcState,
        notify,
        shouldLog
      });

      if (positionResult?.action) {
        actions.push(positionResult.action);
      }

      continue;
    }

    // ========== ENTRY GUARDS NA POSITION MANAGEMENT ==========
    if (lastSignalMap.has(c.symbol) && Date.now() < lastSignalMap.get(c.symbol)) {
      actions.push(buildWait(c, "SYMBOL_SIGNAL_COOLDOWN", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    if (symbolCooldownMap.has(c.symbol) && Date.now() < symbolCooldownMap.get(c.symbol)) {
      actions.push(buildWait(c, "SYMBOL_REENTRY_COOLDOWN", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    if (hasAnyOpenPositionForSymbol(c.symbol)) {
      actions.push(
        buildWait(
          c,
          `SYMBOL_ALREADY_OPEN_${getOpenPositionSideForSymbol(c.symbol)}`,
          flow,
          sniper,
          confluence,
          0,
          funding,
          ob,
          null,
          null,
          null,
          null
        )
      );
      continue;
    }

    if (processingLocks.has(symbolLockKey)) {
      actions.push(buildWait(c, "DUPLICATE_PROCESSING_LOCK", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    if (Date.now() < (cooldownMap.get(key) || 0)) {
      actions.push(buildWait(c, "COOLDOWN", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    // ========== BTC DIRECTION FILTER ==========
    if (btcState === "STRONG_BULL" && !isBull) {
      actions.push(buildWait(c, "BTC_STRONG_BULL_BLOCK_SHORT", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    if (btcState === "STRONG_BEAR" && isBull) {
      actions.push(buildWait(c, "BTC_STRONG_BEAR_BLOCK_LONG", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    if (btcState === "BULLISH" && !isBull && Number(c.moveScore || 0) < 75) {
      actions.push(buildWait(c, "BTC_BULLISH_WEAK_SHORT", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    if (btcState === "BEARISH" && isBull && Number(c.moveScore || 0) < 75) {
      actions.push(buildWait(c, "BTC_BEARISH_WEAK_LONG", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    if (btcState === "NEUTRAL" && Number(c.moveScore || 0) < 65 && confluence < 75) {
      actions.push(buildWait(c, "BTC_NEUTRAL_LOW_SCORE", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    // ========== DATA QUALITY ==========
    if (ob.fetchFailed) {
      actions.push(buildWait(c, "ORDERBOOK_FETCH_FAILED", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    if (rsi === null) {
      actions.push(buildWait(c, "RSI_DATA_INVALID", flow, sniper, confluence, 0, funding, ob, null, null, null, null));
      continue;
    }

    const marketCtx = {
      candles15m: rsiData?.candles15m || [],
      candles1h: rsiData?.candles1h || []
    };

    const riskBase = await calculateRisk(
      c,
      ob,
      liquidity,
      hasLiquidationData ? liquidation : null,
      marketCtx
    );

    const rr = Number.isFinite(Number(riskBase?.rr))
      ? Math.max(0, Number(riskBase.rr))
      : calculateFallbackRR(c, riskBase, isBull);

    // ========== FAKE BREAKOUT =================
    let fakeBreakout = false;

    const breakoutBufferPct = getDynamicBreakoutBufferPct(c, regime, vol, ob);

    if (hasLiquidationData && liquidation) {
      if (
        isBull &&
        liquidation.nearestAbove &&
        c.price > liquidation.nearestAbove * (1 + breakoutBufferPct)
      ) {
        fakeBreakout = true;
      }

      if (
        !isBull &&
        liquidation.nearestBelow &&
        c.price < liquidation.nearestBelow * (1 - breakoutBufferPct)
      ) {
        fakeBreakout = true;
      }
    }

    const candles15m = rsiData?.candles15m || [];
    let candleFakeBreakout = false;

    if (candles15m.length >= 20) {
      const recentHigh = Math.max(...candles15m.slice(-20).map(x => Number(x.high || 0)));
      const recentLow = Math.min(...candles15m.slice(-20).map(x => Number(x.low || 0)));

      if (isBull && c.price > recentLow && c.price < recentLow * 1.01) {
        candleFakeBreakout = true;
      }

      if (!isBull && c.price < recentHigh && c.price > recentHigh * 0.99) {
        candleFakeBreakout = true;
      }
    }

    const isValidFakeBreakout = fakeBreakout || candleFakeBreakout;
    c._debugFakeBreakout = isValidFakeBreakout;

    console.log(
      `📊 DATA: ${c.symbol} | hasRSI=${!!rsiContext} | conf=${confluence} | sniper=${sniperScore} | rr=${rr.toFixed(2)} | fake=${isValidFakeBreakout}`
    );

    // ========== HARD MARKET QUALITY ==========
    if (isMarketQualityHardBlocked(ob)) {
      actions.push(buildWait(c, "HARD_BAD_MARKET_QUALITY", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    if (ob.spoof) {
      actions.push(buildWait(c, "OB_SPOOF", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    const spread = normalizeSpread(ob.spreadPct);
    const depth = Number(ob.depthMinUsd1p || 0);
    const badSpread = spread > MAX_SPREAD_PCT;
    const badDepth = depth < MIN_DEPTH_USD_1P;

    if ((badSpread || badDepth) && confluence < 78) {
      actions.push(buildWait(c, "BAD_MARKET_QUALITY", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    // ========== RSI BALANCE ==========
    const trendContinuationRSI =
      flow.type === "TREND" &&
      confluence >= 70 &&
      sniperScore >= 60 &&
      rr >= 1.0 &&
      (
        (isBull && ["MID", "LOWER_1"].includes(rsiZone)) ||
        (!isBull && ["MID", "UPPER_1"].includes(rsiZone))
      );

    const strongTrendSetup =
      flow.type === "TREND" &&
      confluence >= 72 &&
      sniperScore >= 60 &&
      rr >= 1.05;

    if (isBull) {
      const rsiOK =
        ["LOWER_2", "LOWER_3"].includes(rsiZone) ||
        (rsiZone === "LOWER_1" && sniperScore >= 60) ||
        trendContinuationRSI ||
        (
          rsiZone === "UPPER_1" &&
          flow.type === "TREND" &&
          confluence >= 82 &&
          sniperScore >= 75 &&
          rr >= 1.15
        );

      if (!rsiOK && !strongTrendSetup) {
        actions.push(buildWait(c, "RSI_LONG_NO_EDGE", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
        continue;
      }

      if (["UPPER_2", "UPPER_3"].includes(rsiZone)) {
        actions.push(buildWait(c, "RSI_LONG_TOO_HIGH", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
        continue;
      }
    }

    if (!isBull) {
      const rsiOK =
        ["UPPER_2", "UPPER_3"].includes(rsiZone) ||
        (rsiZone === "UPPER_1" && sniperScore >= 60) ||
        trendContinuationRSI ||
        (
          rsiZone === "LOWER_1" &&
          flow.type === "TREND" &&
          confluence >= 82 &&
          sniperScore >= 75 &&
          rr >= 1.15
        );

      if (!rsiOK && !strongTrendSetup) {
        actions.push(buildWait(c, "RSI_SHORT_NO_EDGE", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
        continue;
      }

      if (["LOWER_2", "LOWER_3"].includes(rsiZone)) {
        actions.push(buildWait(c, "RSI_SHORT_TOO_LOW", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
        continue;
      }
    }

    if (rsiZone === "MID" && !trendContinuationRSI && confluence < 72) {
      actions.push(buildWait(c, "RSI_MID_NO_EDGE", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    // ========== STRUCTURE ==========
    const structure = rsiData?.structure || { trend: "NEUTRAL" };
    c.structure = structure.trend;

    if ((isBull && c.structure === "BEARISH") || (!isBull && c.structure === "BULLISH")) {
      actions.push(buildWait(c, "STRUCTURE_AGAINST", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    // ========== MOMENTUM / STALENESS ==========
    const directional1h = getDirectionalChange(c, isBull, "change1h");
    const directional24h = getDirectionalChange(c, isBull, "change24");

    const hasMomentum =
      flow.type === "TREND" ||
      Math.abs(Number(c.change1h || 0)) > 0.20 ||
      Math.abs(Number(c.change24 || 0)) > 1.50 ||
      Number(c.moveScore || 0) >= 75;

    if (!hasMomentum && confluence < 72) {
      actions.push(buildWait(c, "NO_MOMENTUM", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    if (isStaleExtendedMove(c) && confluence < 82 && sniperScore < 75) {
      actions.push(buildWait(c, "STALE_EXTENDED_MOVE", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    if (directional24h > 8 && directional1h < -0.15 && confluence < 82) {
      actions.push(buildWait(c, "PULLBACK_AGAINST_ENTRY", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    // ========== FAKE BREAKOUT ==========
    if (!isValidFakeBreakout && flow.type !== "TREND" && confluence < 78) {
      actions.push(buildWait(c, "NO_FAKE_BREAKOUT", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    // ========== SETUP GRADE / RR ==========
    const counterTrend =
      (btcState === "BULLISH" && !isBull) ||
      (btcState === "BEARISH" && isBull);

    const setupGrade = getSetupGrade({
      c,
      ob,
      flow,
      sniper,
      confluence,
      rr,
      hasLiquidationData,
      isBull
    });

    let minRrFloorBase = getDynamicMinRrFloor({
      c,
      setupGrade,
      flow,
      sniper,
      confluence,
      counterTrend
    });

    let minRrFloor = getSniperAdjustedRR(sniper, minRrFloorBase);

    if (!isBull && btcState === "BEARISH") {
      minRrFloor = Math.max(0.8, minRrFloor - 0.05);
    }

    c.minRrFloor = minRrFloor;

    const rrOverride =
      confluence >= 88 &&
      sniperScore >= 80 &&
      flow.type === "TREND";

    if (rr < minRrFloor && !rrOverride) {
      actions.push(buildWait(c, "LOW_RR", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, minRrFloor));
      continue;
    }

    const allowedStages = certaintyMode === "safe"
      ? ["entry"]
      : ["entry", "almost"];

    const stageOK = allowedStages.includes(c.stage);

    if (!stageOK) {
      actions.push(buildWait(c, "STAGE_NOT_READY", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }

    if (c.tfStrength < 1) {
      actions.push(buildWait(c, "TF_TOO_WEAK", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }

    if (flow.type === "NEUTRAL" && confluence < 72) {
      actions.push(buildWait(c, "NO_FLOW", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }

    if (confluence < 60) {
      actions.push(buildWait(c, "LOW_CONFLUENCE", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, 60, null));
      continue;
    }

    const obAgainst = isObAgainstSide(ob, isBull);

    if (obAgainst && confluence < 82) {
      actions.push(buildWait(c, "OB_AGAINST", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }

    if (ob.bias === "NEUTRAL" && confluence < 72 && sniperScore < 70) {
      actions.push(buildWait(c, "OB_NEUTRAL_NOT_STRONG", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }

    const fundingRate = Number(funding?.rate || 0);

    if (Math.abs(fundingRate) > 0.015 && confluence < 85) {
      actions.push(buildWait(c, "EXTREME_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }

    if (isBull && fundingRate > 0.012 && confluence < 85) {
      actions.push(buildWait(c, "BULL_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }

    if (!isBull && fundingRate < -0.012 && confluence < 85) {
      actions.push(buildWait(c, "BEAR_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }

    // ========== A / B ENTRY ==========
    const finalSniperOK =
      sniperScore >= B_MIN_SNIPER ||
      (sniper?.valid && sniperScore >= B_MIN_SNIPER) ||
      (confluence >= 88 && flow.type === "TREND");

    const aSetupValid =
      stageOK &&
      finalSniperOK &&
      setupGrade.grade === "A" &&
      !ob.spoof &&
      rr >= Math.max(A_MIN_RR, minRrFloor);

    const eliteEntry =
      aSetupValid &&
      sniperScore >= A_MIN_SNIPER &&
      confluence >= A_MIN_CONF &&
      rr >= A_MIN_RR &&
      c.tfStrength >= 1;

    const bSetupValid =
      stageOK &&
      finalSniperOK &&
      ["A", "B"].includes(setupGrade.grade) &&
      !ob.spoof &&
      rr >= Math.max(B_MIN_RR, minRrFloor);

    const neutralObBAllowed =
      ob.bias !== "NEUTRAL" ||
      (
        confluence >= 75 &&
        sniperScore >= 65 &&
        flow.type === "TREND"
      );

    const bEntry =
      !eliteEntry &&
      bSetupValid &&
      neutralObBAllowed &&
      sniperScore >= B_MIN_SNIPER &&
      confluence >= B_MIN_CONF &&
      rr >= B_MIN_RR &&
      c.tfStrength >= 1 &&
      flow.type !== "NEUTRAL";

    const godModeEntry =
      eliteEntry &&
      sniperScore >= GOD_MIN_SNIPER &&
      confluence >= GOD_MIN_CONF &&
      rr >= GOD_MIN_RR;

    const shouldEnter = eliteEntry || bEntry;

    const reasonEntry = godModeEntry
      ? "GOD_MODE"
      : eliteEntry
        ? "ELITE_ENTRY"
        : bEntry
          ? "B_ENTRY"
          : "NONE";

    console.log(
      `🔍 ${c.symbol} (${c.analysisType || "DEEP"}): sniper=${sniperScore}, conf=${confluence}, rr=${rr.toFixed(2)}, grade=${setupGrade.grade}, elite=${eliteEntry}, b=${bEntry}, godmode=${godModeEntry}, rsiZone=${rsiZone}, fakeBreakout=${isValidFakeBreakout}`
    );

    // ========== DIRECT ENTRY ==========
    if (shouldEnter && !hasAnyOpenPositionForSymbol(c.symbol)) {
      let finalTp = Number(riskBase.tp || 0);

      if (certaintyMode === "safe") {
        finalTp = isBull
          ? c.price + Math.abs(finalTp - c.price) * 0.95
          : c.price - Math.abs(finalTp - c.price) * 0.95;
      } else {
        const tpDist = Math.abs(finalTp - c.price);

        if (isBull) {
          if (rsi < 30) finalTp = c.price + tpDist * 1.08;
          else if (rsi < 45) finalTp = c.price + tpDist * 1.04;
        } else {
          if (rsi > 70) finalTp = c.price - tpDist * 1.08;
          else if (rsi > 55) finalTp = c.price - tpDist * 1.04;
        }
      }

      const position = {
        symbol: c.symbol,
        side: c.side,
        stage: c.stage,
        stageSource: c.stageSource || "unknown",
        uiOnly: Boolean(c.uiOnly),

        entry: c.price,
        entries: [c.price],
        maxEntries: MAX_ENTRIES_PER_POSITION,
        lastEntryAt: Date.now(),

        sl: riskBase.sl,
        initialSl: riskBase.sl,
        tp: finalTp,
        rr,

        grade: setupGrade.grade,
        gradePoints: setupGrade.points,
        recommendedRisk: setupGrade.recommendedRisk,

        slSource: riskBase.slSource || "liquidity/orderbook",
        tpSource: riskBase.tpSource || "liquidity/liquidation",

        score: c.moveScore,
        rawBitgetSymbol: c.rawBitgetSymbol || `${c.symbol}USDT`,

        tfScore: c.tfScore,
        tfStrength: c.tfStrength,
        tfAlignment: c.tfAlignment,

        atrPct15m: c.atrPct15m,
        atrPct1h: c.atrPct1h,
        atrPct4h: c.atrPct4h,
        atrPct24h: c.atrPct24h,

        createdAt: Date.now(),

        rsi,
        rsiHTF: rsiSignal.mean1h || null,
        rsiZone
      };

      const entryPayload = {
        ...buildCommonPayload(c, flow, sniper, funding, ob),
        action: "ENTRY",
        reason: reasonEntry,
        grade: position.grade,
        gradePoints: position.gradePoints,
        recommendedRisk: position.recommendedRisk,
        confluence,
        rr: Number(rr).toFixed(2),
        entry: position.entry,
        sl: position.sl,
        tp: position.tp,
        slSource: position.slSource,
        tpSource: position.tpSource,
        rsi: position.rsi,
        rsiHTF: position.rsiHTF,
        rsiZone: position.rsiZone
      };

      processingLocks.add(symbolLockKey);

      try {
        memory.set(key, position);

        symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
        cooldownMap.set(key, Date.now() + COOLDOWN_MS);
        lastSignalMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);

        await logAction(entryPayload, regimeLevel, btcState, shouldLog);

        if (notify && !notifyState.get(key)) {
          await sendEntry({
            symbol: c.symbol,
            side: c.side,
            entry: position.entry,
            sl: position.sl,
            tp: position.tp,
            rr: position.rr,
            grade: position.grade,
            gradePoints: position.gradePoints,
            recommendedRisk: position.recommendedRisk,
            slSource: position.slSource,
            tpSource: position.tpSource,
            confluence,
            obBias: ob.bias,
            rsi: position.rsi,
            rsiHTF: position.rsiHTF,
            rsiZone: position.rsiZone,
            sniperScore
          });

          notifyState.set(key, true);
        }
      } finally {
        processingLocks.delete(symbolLockKey);
      }

      actions.push(entryPayload);
      continue;
    }

    if (c.analysisType !== "DEEP" && !shouldEnter) {
      actions.push(buildWait(c, "LIGHT_MONITORING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }

    actions.push(buildWait(c, "SETUP_NOT_READY", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
  }

  if (actions.length === 0 && candidates.length > 0) {
    console.warn("⚠️ NO ACTIONS from tradeSystem – fallback WAIT generated");

    return {
      actions: candidates.map(c => ({
        symbol: c.symbol,
        side: c.side,
        action: "WAIT",
        reason: "NO_VALID_SETUPS",
        score: c.moveScore || 0,
        ts: Date.now(),
        analysisType: c.analysisType || "DEEP"
      })),
      candidatesCount: candidates.length
    };
  }

  return {
    actions: actions.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)),
    candidatesCount: candidates.length
  };
}