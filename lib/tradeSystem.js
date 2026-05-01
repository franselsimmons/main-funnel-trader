// tradeSystem.js - Definitief met alle kernfixes
// - Geen C_ENTRY meer
// - Geen harde MAX_DEEP/MAX_LIGHT cap meer
// - Geen scaling / bijkopen meer
// - Open posities worden altijd opnieuw meegenomen voor TP/SL tracking
// - Position management vóór alle entry-blocks
// - Confluence vóór sniper
// - Liquidation price meegegeven
// - BTC/regime uit options
// - Scanner-entry blijft alleen candidate, geen echte entry

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
const MIN_DEPTH_USD_1P = 200000;

const MIN_RR_FLOOR = 1.0;
const GRADE_A_MIN_RR_FLOOR = 1.0;
const GRADE_B_MIN_RR_FLOOR = 1.05;
const GRADE_C_MIN_RR_FLOOR = 1.10;
const COUNTERTREND_MIN_RR_FLOOR = 1.40;
const BUILDUP_MIN_RR_FLOOR = 1.20;

const BUILDUP_ELITE_MIN_TF = 2;

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

// ================= HELPERS =================
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

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
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);

  if (!Number.isFinite(s) || s < 0) return 0.001;
  if (s > 0.05) s = s / 100;

  return s;
}

function formatRR(rr) {
  const n = Number(rr || 0);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${clean}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;

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

function calculateFallbackRR(c, risk, isBull) {
  const price = Number(c.price || 0);
  const sl = Number(risk?.sl || 0);
  const tp = Number(risk?.tp || 0);

  if (!price || !sl || !tp) return 0;

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
    if (key.startsWith(`${s}_`)) return true;
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
    scannerStage: c.scannerStage || c.stage,
    stageSource: c.stageSource || "unknown",
    uiOnly: Boolean(c.uiOnly),
    score: c.moveScore,
    price: c.price,
    flow: flow?.type || c.flow || "NEUTRAL",
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

function dedupeCandidates(coins) {
  const map = new Map();

  for (const raw of Array.isArray(coins) ? coins : []) {
    if (!raw?.symbol || !raw?.side) continue;

    const symbol = normalizeBaseSymbol(raw.symbol);
    const side = String(raw.side).toLowerCase();

    if (side !== "bull" && side !== "bear") continue;

    const normalized = {
      ...raw,
      symbol,
      side,
      stage: String(raw.stage || "radar").toLowerCase()
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

  return Array.from(map.values()).sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));
}

function buildTradeCandidates(candidatesRaw) {
  const raw = Array.isArray(candidatesRaw) ? candidatesRaw : [];

  const filtered = raw.filter(c => {
    if (!c?.symbol || !c?.side) return false;
    if (Boolean(c.uiOnly)) return false;

    const stage = String(c.stage || "").toLowerCase();
    const score = Number(c.moveScore || 0);

    if (stage !== "entry" && stage !== "almost") return false;
    if (score < 50) return false;

    return true;
  });

  const map = new Map();

  for (const c of dedupeCandidates(filtered)) {
    const key = `${normalizeBaseSymbol(c.symbol)}_${String(c.side).toLowerCase()}`;

    map.set(key, {
      ...c,
      analysisType: "DEEP",
      fromOpenPosition: false
    });
  }

  // Open posities altijd blijven checken voor TP/SL.
  for (const [key, pos] of memory.entries()) {
    if (map.has(key)) continue;

    map.set(key, {
      symbol: pos.symbol,
      side: pos.side,
      stage: "entry",
      scannerStage: "open_position",
      stageSource: "memory",
      uiOnly: false,
      moveScore: Number(pos.score || 100),
      price: pos.entry,
      rawBitgetSymbol: pos.rawBitgetSymbol || pos.symbol,
      analysisType: "DEEP",
      fromOpenPosition: true
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.fromOpenPosition !== b.fromOpenPosition) {
      return a.fromOpenPosition ? -1 : 1;
    }

    return Number(b.moveScore || 0) - Number(a.moveScore || 0);
  });
}

// ================= GRADE =================
function getSetupGrade({ c, ob, flow, sniper, confluence, rr, hasLiquidationData, isBull }) {
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

  const obWith = isObWithSide(ob, isBull);
  const obAgainst = isObAgainstSide(ob, isBull);

  if (obWith) points += 2;
  if (obAgainst) points -= 2;

  if (hasLiquidationData) points += 1;

  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);

  if (spread <= MAX_SPREAD_PCT && depth >= MIN_DEPTH_USD_1P) points += 1;
  if (spread > MAX_SPREAD_PCT || depth < MIN_DEPTH_USD_1P) points -= 2;

  if (c.stage === "entry") points += 1;
  if (rr >= 1.4) points += 1;
  if (rr < 0.8) points -= 1;

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

  return {
    grade,
    points,
    recommendedRisk
  };
}

function buildWait(c, reason, flow, sniper, confluence, rr, funding, ob, risk, setupGrade, requiredConfluence, requiredRR) {
  const base = {
    ...buildCommonPayload(c, flow, sniper, funding, ob),
    action: "WAIT",
    reason,
    grade: setupGrade?.grade || "C",
    gradePoints: setupGrade?.points || 0,
    recommendedRisk: setupGrade?.recommendedRisk || "watch",
    confluence,
    rr: formatRR(rr),
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
    `🚫 BLOCK: ${c.symbol} | ${reason} | rsiZone=${c._debugRsiZone || "?"} | sniper=${sniper?.score || 0} | conf=${confluence} | rr=${formatRR(rr)} | fake=${c._debugFakeBreakout} | flow=${flow?.type}`
  );

  return base;
}

function getDynamicMinRrFloor({ c, setupGrade, flow, sniper, confluence, counterTrend }) {
  let floor = MIN_RR_FLOOR;

  if (setupGrade?.grade === "A") floor = GRADE_A_MIN_RR_FLOOR;
  else if (setupGrade?.grade === "B") floor = GRADE_B_MIN_RR_FLOOR;
  else floor = GRADE_C_MIN_RR_FLOOR;

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

  return clamp(floor, 0.95, 1.50);
}

function getSniperAdjustedRR(sniper, baseRR) {
  const score = Number(sniper?.score || 0);

  if (score >= 90) return Math.max(1.00, baseRR - 0.15);
  if (score >= 80) return Math.max(1.02, baseRR - 0.08);
  if (score >= 70) return Math.max(1.05, baseRR - 0.03);

  return baseRR + 0.10;
}

function isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend }) {
  const sniperScore = getSniperScore(sniper);

  if (c.stage !== "entry") return false;
  if (flow.type !== "TREND") return false;
  if (counterTrend) return false;

  if (
    setupGrade.grade === "A" &&
    confluence >= 80 &&
    rr >= 1.10 &&
    sniper?.valid &&
    sniperScore >= 75
  ) {
    return true;
  }

  if (
    setupGrade.grade === "B" &&
    confluence >= 84 &&
    rr >= 1.15 &&
    sniper?.valid &&
    sniperScore >= 80 &&
    Number(c.moveScore || 0) >= 82
  ) {
    return true;
  }

  return false;
}

async function logAction(actionPayload, regimeLevel, btcState, shouldLog) {
  if (!shouldLog || !actionPayload) return;

  await logSystemEvent({
    ...actionPayload,
    regime: regimeLevel,
    btcState
  });
}

function chunkArray(arr, size) {
  const chunks = [];

  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }

  return chunks;
}

function getRsiZone(rsiSignal) {
  const rsi = Number(rsiSignal?.rsi);
  const zones = rsiSignal?.zones;

  if (!Number.isFinite(rsi) || !zones) return "MID";

  if (rsi <= zones.L3) return "LOWER_3";
  if (rsi <= zones.L2) return "LOWER_2";
  if (rsi <= zones.L1) return "LOWER_1";

  if (rsi >= zones.U3) return "UPPER_3";
  if (rsi >= zones.U2) return "UPPER_2";
  if (rsi >= zones.U1) return "UPPER_1";

  return "MID";
}

// ================= CORE =================
export async function processTrades(input, options = {}) {
  const notify = options.notify !== false;
  const shouldLog = options.log !== false;
  const certaintyMode = options.certaintyMode || "aggressive";

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
      ...(input?.funnel?.bear?.almost || [])
    ];

    scanRegime = input?.regime || scanRegime;
    scanBtc = input?.btc || scanBtc;
  }

  cleanExpiredGuards();

  const candidates = buildTradeCandidates(candidatesRaw);
  const actions = [];

  if (candidates.length === 0) {
    return {
      actions: [],
      candidatesCount: 0
    };
  }

  let market = { trend: "NEUTRAL" };

  try {
    market = await getMarketContext("BTCUSDT", 0);
  } catch (e) {
    console.warn("Market context fallback:", e.message);
  }

  const btcState = scanBtc?.state || market?.trend || "NEUTRAL";

  // ================= DATA FETCH =================
  const dataMap = new Map();

  const fetchCoinData = async c => {
    const symbol = normalizeBaseSymbol(c.symbol);
    const contractSymbol = normalizeBitgetSymbol(c.rawBitgetSymbol || symbol);

    let ob = { ...DEFAULT_OB };

    try {
      const raw = await cachedFetch(`ob_${contractSymbol}`, async () => {
        let data = null;

        for (let i = 0; i < 2; i++) {
          try {
            data = await fetchOrderBook(contractSymbol);
            if (data) break;
          } catch {}

          await sleep(200);
        }

        return data;
      }, 15000);

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
      funding = await cachedFetch(`fund_${contractSymbol}`, () => fetchFunding(contractSymbol), 120000);
    } catch {}

    const candles15m = await cachedFetch(`c15_${contractSymbol}`, () => fetchCandles(contractSymbol, "15m", 100), 20000);
    const candles1h = await cachedFetch(`c1h_${contractSymbol}`, () => fetchCandles(contractSymbol, "1h", 100), 20000);

    let candles4h = null;

    if (Number(c.tfStrength || 0) >= 2) {
      candles4h = await cachedFetch(`c4h_${contractSymbol}`, () => fetchCandles(contractSymbol, "4h", 100), 30000).catch(() => null);
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
      const liqPrice = Number(c.price || c.lastPrice || ob.mid || 0);
      liquidation = await getLiquidationZones(contractSymbol, liqPrice);
    } catch (e) {
      console.warn(`Liquidation fetch failed for ${symbol}:`, e.message);
    }

    dataMap.set(symbol, {
      ob,
      funding,
      rsiData,
      liquidation,
      contractSymbol
    });
  };

  const chunks = chunkArray(candidates, 3);

  for (const chunk of chunks) {
    await Promise.all(chunk.map(fetchCoinData));
  }

  // ================= PROCESS COINS =================
  for (const originalCoin of candidates) {
    const c = {
      ...originalCoin,
      symbol: normalizeBaseSymbol(originalCoin.symbol),
      side: String(originalCoin.side).toLowerCase()
    };

    const key = `${c.symbol}_${c.side}`;
    const symbolLockKey = `LOCK_${c.symbol}`;

    const data = dataMap.get(c.symbol) || {
      ob: DEFAULT_OB,
      funding: { rate: 0 },
      rsiData: null,
      liquidation: null,
      contractSymbol: normalizeBitgetSymbol(c.symbol)
    };

    const {
      ob: obData,
      funding,
      rsiData,
      liquidation,
      contractSymbol
    } = data;

    if (obData?.mid > 0) {
      c.price = obData.mid;
    } else if (!c.price || c.price === 0) {
      c.price = Number(c.lastPrice || 0);
    }

    const isBull = c.side === "bull";
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    c.flow = flow.type;

    // ================= POSITION MANAGEMENT FIRST =================
    if (prev) {
      const pos = { ...prev };

      if (!Number(c.price || 0)) {
        const holdPayload = {
          ...buildCommonPayload(c, flow, null, funding, obData),
          action: "HOLD",
          reason: "PRICE_INVALID_OPEN_POSITION",
          grade: pos.grade || "N/A",
          gradePoints: pos.gradePoints || 0,
          recommendedRisk: pos.recommendedRisk || "N/A",
          confluence: pos.confluence || 0,
          rr: formatRR(pos.rr),
          entry: pos.entry,
          sl: pos.sl,
          tp: pos.tp,
          slSource: pos.slSource || "N/A",
          tpSource: pos.tpSource || "N/A",
          rsi: pos.rsi,
          rsiHTF: pos.rsiHTF,
          rsiZone: pos.rsiZone
        };

        actions.push(holdPayload);
        continue;
      }

      const hitTP = isBull
        ? c.price >= pos.tp
        : c.price <= pos.tp;

      const hitSL = isBull
        ? c.price <= pos.sl
        : c.price >= pos.sl;

      if (hitTP || hitSL) {
        const reason = hitTP ? "TP" : "SL";

        const exitPayload = {
          ...buildCommonPayload(c, flow, null, funding, obData),
          action: "EXIT",
          reason,
          grade: pos.grade || "N/A",
          gradePoints: pos.gradePoints || 0,
          recommendedRisk: pos.recommendedRisk || "N/A",
          confluence: pos.confluence || 0,
          rr: formatRR(pos.rr),
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
            exit: c.price,
            sl: pos.sl,
            tp: pos.tp,
            result: hitTP ? "WIN" : "LOSS",
            reason,
            rr: pos.rr,
            grade: pos.grade || "N/A",
            gradePoints: pos.gradePoints || 0,
            recommendedRisk: pos.recommendedRisk || "N/A",
            confluence: pos.confluence || 0,
            score: c.moveScore,
            flow: flow.type,
            sniper: pos.sniper || "N/A",
            sniperScore: pos.sniperScore || 0,
            obBias: obData.bias,
            funding: funding.rate || 0,
            slSource: pos.slSource || "N/A",
            tpSource: pos.tpSource || "N/A",
            regime: pos.regime || "N/A",
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

        actions.push(exitPayload);
        continue;
      }

      // Geen scaling. Alleen hold.
      memory.set(key, pos);

      const runningPayload = {
        ...buildCommonPayload(c, flow, null, funding, obData),
        action: "HOLD",
        reason: "RUNNING",
        grade: pos.grade || "N/A",
        gradePoints: pos.gradePoints || 0,
        recommendedRisk: pos.recommendedRisk || "N/A",
        confluence: pos.confluence || 0,
        rr: formatRR(pos.rr),
        entry: pos.entry,
        sl: pos.sl,
        tp: pos.tp,
        slSource: pos.slSource || "N/A",
        tpSource: pos.tpSource || "N/A",
        rsi: pos.rsi,
        rsiHTF: pos.rsiHTF,
        rsiZone: pos.rsiZone
      };

      await logAction(runningPayload, pos.regime || "N/A", btcState, shouldLog);

      actions.push(runningPayload);
      continue;
    }

    // ================= NEW ENTRY ONLY BELOW =================
    if (!Number(c.price || 0)) {
      actions.push(buildWait(c, "PRICE_INVALID", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (btcState === "STRONG_BULL" && !isBull) {
      actions.push(buildWait(c, "BTC_STRONG_BULL_BLOCK_SHORT", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (btcState === "STRONG_BEAR" && isBull) {
      actions.push(buildWait(c, "BTC_STRONG_BEAR_BLOCK_LONG", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (btcState === "BULLISH" && !isBull && Number(c.moveScore || 0) < 75) {
      actions.push(buildWait(c, "BTC_BULLISH_WEAK_SHORT", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (btcState === "BEARISH" && isBull && Number(c.moveScore || 0) < 75) {
      actions.push(buildWait(c, "BTC_BEARISH_WEAK_LONG", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    if (btcState === "NEUTRAL" && Number(c.moveScore || 0) < 70) {
      actions.push(buildWait(c, "BTC_NEUTRAL_LOW_SCORE", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

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

    const rsiSignal = rsiData?.mtf
      ? getRSISignal(rsiData.mtf, c.side)
      : { valid: false, strength: 0 };

    const rsi = Number.isFinite(rsiSignal?.rsi)
      ? rsiSignal.rsi
      : null;

    if (rsi === null) {
      actions.push(buildWait(c, "RSI_DATA_INVALID", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    const rsiZone = getRsiZone(rsiSignal);
    c._debugRsiZone = rsiZone;

    if (isBull && ["UPPER_1", "UPPER_2", "UPPER_3"].includes(rsiZone)) {
      actions.push(buildWait(c, "RSI_LONG_TOO_HIGH", flow, null, 0, 0, funding, obData, null, null, null, null));
      continue;
    }

    const vol = getVolatility(c);
    const regime = getVolatilityRegime(c);
    const regimeLevel = getRegimeKey(regime, scanRegime);
    const regimeForConfluence = getRegimeValueForConfluence(regime, scanRegime);
    const liquidity = getLiquidityZones(c, obData);

    const hasLiquidationData = Array.isArray(liquidation?.clusters) && liquidation.clusters.length > 0;

    const rawRsiCtx = rsiData?.mtf?.m15;
    const rsiContext = rawRsiCtx && Number.isFinite(rawRsiCtx.rsi) && rawRsiCtx.zones
      ? {
          valid: true,
          rsi: rawRsiCtx.rsi,
          zones: rawRsiCtx.zones
        }
      : null;

    const confluence = calculateConfluence(
      c,
      obData,
      liquidity,
      funding,
      regimeForConfluence,
      hasLiquidationData ? liquidation : null,
      rsiContext
    );

    c.confluence = confluence;

    const sniper = getSniperEntry(c, obData, rsiSignal);
    const sniperScore = getSniperScore(sniper);

    if (obData.fetchFailed) {
      actions.push(buildWait(c, "ORDERBOOK_FETCH_FAILED", flow, sniper, confluence, 0, funding, obData, null, null, null, null));
      continue;
    }

    const riskBase = await calculateRisk(
      c,
      obData,
      liquidity,
      hasLiquidationData ? liquidation : null
    );

    const rr = Number.isFinite(Number(riskBase?.rr))
      ? Math.max(0, Number(riskBase.rr))
      : calculateFallbackRR(c, riskBase, isBull);

    // ================= FAKE BREAKOUT =================
    let fakeBreakout = false;
    const breakoutBufferPct = getDynamicBreakoutBufferPct(c, regime, vol, obData);

    if (hasLiquidationData && liquidation) {
      if (isBull && liquidation.nearestAbove && c.price > liquidation.nearestAbove * (1 + breakoutBufferPct)) {
        fakeBreakout = true;
      }

      if (!isBull && liquidation.nearestBelow && c.price < liquidation.nearestBelow * (1 - breakoutBufferPct)) {
        fakeBreakout = true;
      }
    }

    const candles15m = rsiData?.candles15m || [];
    let candleFakeBreakout = false;

    if (candles15m.length >= 20) {
      const recentHigh = Math.max(...candles15m.slice(-20).map(x => x.high));
      const recentLow = Math.min(...candles15m.slice(-20).map(x => x.low));

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
      `📊 DATA: ${c.symbol} | hasRSI=${!!rsiContext} | conf=${confluence} | sniper=${sniperScore} | rr=${formatRR(rr)} | fake=${isValidFakeBreakout}`
    );

    // ================= RSI LOGIC =================
    const trendContinuationRSI =
      flow.type === "TREND" &&
      confluence >= 65 &&
      rr >= 1.0 &&
      sniperScore >= 55 &&
      (
        (isBull && ["MID", "LOWER_1"].includes(rsiZone)) ||
        (!isBull && ["MID", "UPPER_1"].includes(rsiZone))
      );

    const earlyRSI =
      (isBull && rsiZone === "LOWER_1" && sniperScore >= 75) ||
      (!isBull && rsiZone === "UPPER_1" && sniperScore >= 75);

    if (isBull) {
      const rsiOK =
        ["LOWER_2", "LOWER_3"].includes(rsiZone) ||
        earlyRSI ||
        trendContinuationRSI;

      if (!rsiOK) {
        actions.push(buildWait(c, "RSI_LONG_NO_EDGE", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
        continue;
      }
    }

    if (!isBull) {
      const rsiOK =
        ["UPPER_2", "UPPER_3"].includes(rsiZone) ||
        earlyRSI ||
        trendContinuationRSI ||
        (rsiZone === "LOWER_1" && flow.type === "TREND" && confluence >= 75);

      if (!rsiOK) {
        actions.push(buildWait(c, "RSI_SHORT_NO_EDGE", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
        continue;
      }
    }

    if (isBull && rsiZone === "LOWER_2" && Number(c.change1h || 0) > -0.05) {
      actions.push(buildWait(c, "RSI_NOT_DEEP_ENOUGH", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (!isBull && rsiZone === "UPPER_2" && Number(c.change1h || 0) < 0.2) {
      actions.push(buildWait(c, "RSI_NOT_HIGH_ENOUGH", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (rsiZone === "MID" && !trendContinuationRSI && confluence < 72) {
      actions.push(buildWait(c, "RSI_MID_NO_EDGE", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    // ================= STRUCTURE =================
    const structure = rsiData?.structure || { trend: "NEUTRAL" };
    c.structure = structure.trend;

    if ((isBull && c.structure === "BEARISH") || (!isBull && c.structure === "BULLISH")) {
      actions.push(buildWait(c, "STRUCTURE_AGAINST", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    // ================= MOMENTUM =================
    const strongMomentum =
      Math.abs(Number(c.change1h || 0)) > 0.25 &&
      Math.abs(Number(c.change24 || 0)) > 2 &&
      (flow.type === "TREND" || flow.type === "BUILDING");

    const softMomentum =
      Math.abs(Number(c.change1h || 0)) > 0.15 &&
      Math.abs(Number(c.change24 || 0)) > 1.5 &&
      flow.type === "TREND";

    if (!strongMomentum && !softMomentum) {
      actions.push(buildWait(c, "NO_MOMENTUM", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (!isValidFakeBreakout && flow.type !== "TREND") {
      actions.push(buildWait(c, "NO_FAKE_BREAKOUT", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    // ================= ENTRY GUARDS =================
    if (hasAnyOpenPositionForSymbol(c.symbol)) {
      actions.push(buildWait(c, `SYMBOL_ALREADY_OPEN_${getOpenPositionSideForSymbol(c.symbol)}`, flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (processingLocks.has(symbolLockKey)) {
      actions.push(buildWait(c, "DUPLICATE_PROCESSING_LOCK", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (Date.now() < (cooldownMap.get(key) || 0)) {
      actions.push(buildWait(c, "COOLDOWN", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    if (Date.now() < (symbolCooldownMap.get(c.symbol) || 0)) {
      actions.push(buildWait(c, "SYMBOL_COOLDOWN", flow, sniper, confluence, rr, funding, obData, riskBase, null, null, null));
      continue;
    }

    const allowedStages = certaintyMode === "safe"
      ? ["entry"]
      : ["entry", "almost"];

    const stageOK = allowedStages.includes(c.stage);

    const setupGrade = getSetupGrade({
      c,
      ob: obData,
      flow,
      sniper,
      confluence,
      rr,
      hasLiquidationData,
      isBull
    });

    const counterTrend =
      (btcState === "BULLISH" && !isBull) ||
      (btcState === "BEARISH" && isBull);

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
      minRrFloor = Math.max(1.0, minRrFloor - 0.05);
    }

    c.minRrFloor = minRrFloor;

    const rrOverride = confluence >= 88 && sniperScore >= 82;

    if (rr < minRrFloor && !rrOverride) {
      actions.push(buildWait(c, "LOW_RR", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, minRrFloor));
      continue;
    }

    if (vol === "LOW" && confluence < 60) {
      actions.push(buildWait(c, "LOW_VOL", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (flow.type === "NEUTRAL" && confluence < 68) {
      actions.push(buildWait(c, "NO_FLOW", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (c.tfStrength < 1) {
      actions.push(buildWait(c, "ENTRY_FILTERED_TF_WEAK", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (confluence < 62) {
      actions.push(buildWait(c, "LOW_CONFLUENCE", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, 62, null));
      continue;
    }

    const obAgainst = isObAgainstSide(obData, isBull);

    if (obAgainst && confluence < 78) {
      actions.push(buildWait(c, "OB_AGAINST", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    const spread = normalizeSpread(obData.spreadPct);
    const badSpread = spread > MAX_SPREAD_PCT;
    const badDepth = Number(obData.depthMinUsd1p || 0) < MIN_DEPTH_USD_1P;

    if ((badSpread || badDepth) && confluence < 75) {
      actions.push(buildWait(c, "BAD_MARKET_QUALITY", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (
      obData.bias === "NEUTRAL" &&
      confluence < 55 &&
      !isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend })
    ) {
      actions.push(buildWait(c, "OB_NEUTRAL_LOW_CONF", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    const fundingRate = Number(funding?.rate || 0);

    if (Math.abs(fundingRate) > 0.015 && confluence < 85) {
      actions.push(buildWait(c, "EXTREME_FUNDING", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (isBull && fundingRate > 0.012 && confluence < 85) {
      actions.push(buildWait(c, "BULL_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    if (!isBull && fundingRate < -0.012 && confluence < 85) {
      actions.push(buildWait(c, "BEAR_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    // ================= A/B ENTRY ONLY =================
    const aSetupValid =
      stageOK &&
      setupGrade.grade === "A" &&
      !obData.spoof &&
      rr >= minRrFloor;

    const eliteEntry =
      aSetupValid &&
      sniper?.valid &&
      sniperScore >= 70 &&
      confluence >= 75 &&
      rr >= 1.10 &&
      c.tfStrength >= 1;

    const bSetupValid =
      stageOK &&
      setupGrade.grade === "B" &&
      !obData.spoof &&
      rr >= 1.05;

    const bEntry =
      !eliteEntry &&
      bSetupValid &&
      sniper?.valid &&
      sniperScore >= 62 &&
      confluence >= 68 &&
      rr >= 1.05 &&
      c.tfStrength >= 1;

    const godModeEntry =
      eliteEntry &&
      sniperScore >= 85 &&
      confluence >= 85 &&
      rr >= 1.20;

    const shouldEnter = eliteEntry || bEntry;

    const reasonEntry = godModeEntry
      ? "GOD_MODE"
      : eliteEntry
        ? "ELITE_ENTRY"
        : bEntry
          ? "B_ENTRY"
          : "NONE";

    console.log(
      `🔍 ${c.symbol} (${c.analysisType || "DEEP"}): sniper=${sniperScore}, conf=${confluence}, rr=${formatRR(rr)}, grade=${setupGrade.grade}, elite=${eliteEntry}, b=${bEntry}, godmode=${godModeEntry}, rsiZone=${rsiZone}, fakeBreakout=${isValidFakeBreakout}`
    );

    if (!shouldEnter) {
      actions.push(buildWait(c, "SETUP_NOT_READY", flow, sniper, confluence, rr, funding, obData, riskBase, setupGrade, null, null));
      continue;
    }

    // ================= DIRECT ENTRY =================
    let finalTp = riskBase.tp;

    if (certaintyMode === "safe") {
      finalTp *= 0.95;
    } else {
      if (sniperScore >= 90) finalTp *= 0.92;
      else if (sniperScore >= 80) finalTp *= 0.96;

      if (isBull) {
        if (rsi < 30) finalTp *= 1.10;
        else if (rsi < 45) finalTp *= 1.04;
      } else {
        if (rsi > 70) finalTp *= 0.90;
        else if (rsi > 55) finalTp *= 0.96;
      }
    }

    const position = {
      symbol: c.symbol,
      side: c.side,
      stage: c.stage,
      scannerStage: c.scannerStage || c.stage,
      stageSource: c.stageSource || "unknown",
      uiOnly: Boolean(c.uiOnly),
      rawBitgetSymbol: contractSymbol,

      entry: c.price,
      entries: [c.price],
      maxEntries: 1,
      lastEntryAt: Date.now(),

      sl: riskBase.sl,
      initialSl: riskBase.sl,
      tp: finalTp,
      rr,

      grade: setupGrade.grade,
      gradePoints: setupGrade.points,
      recommendedRisk: setupGrade.recommendedRisk,

      confluence,
      sniper: sniper?.type || "NONE",
      sniperScore,

      slSource: riskBase.slSource || "liquidity/orderbook",
      tpSource: riskBase.tpSource || "liquidity/liquidation",

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
      rsiZone,

      regime: regimeLevel,
      btcState
    };

    const entryPayload = {
      ...buildCommonPayload(c, flow, sniper, funding, obData),
      action: "ENTRY",
      reason: reasonEntry,
      grade: position.grade,
      gradePoints: position.gradePoints,
      recommendedRisk: position.recommendedRisk,
      confluence,
      rr: formatRR(rr),
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
          obBias: obData.bias,
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