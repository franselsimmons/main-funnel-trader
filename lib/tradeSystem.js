// tradeSystem.js - Aangepast met versoepelingen + fixes
// - MID filter na confluence
// - sniper?.score veilig
// - earlyRSI drempel 75 (optioneel)
// - RSI smoothing 14 in rsiEngine.js

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
  getRSISignal,
  isType1RSIEntry
} from "./rsiEngine.js";

import { getStructureState } from "./structureEngine.js";

import {
  sendEntry,
  sendExit
} from "./discordNotifier.js";

import { updateOrderbookMemory } from "./orderbookMemory.js";

// ================= CACHE LAYER =================
const apiCache = new Map();

async function cachedFetch(key, fn, ttl = 30000) {
  const cached = apiCache.get(key);
  if (cached && (Date.now() - cached.ts < ttl)) {
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
const GRADE_B_MIN_RR_FLOOR = 1.10;
const GRADE_C_MIN_RR_FLOOR = 1.20;
const COUNTERTREND_MIN_RR_FLOOR = 1.40;
const BUILDUP_MIN_RR_FLOOR = 1.2;

const NEUTRAL_OB_ENTRY_A_MIN_CONF = 77;
const NEUTRAL_OB_ENTRY_A_MIN_SNIPER = 75;
const NEUTRAL_OB_ENTRY_A_MIN_RR = 1.0;

const NEUTRAL_OB_ENTRY_B_MIN_CONF = 82;
const NEUTRAL_OB_ENTRY_B_MIN_SNIPER = 80;
const NEUTRAL_OB_ENTRY_B_MIN_SCORE = 82;
const NEUTRAL_OB_ENTRY_B_MIN_RR = 1.1;

const NEUTRAL_OB_ALMOST_A_MIN_CONF = 86;
const NEUTRAL_OB_ALMOST_A_MIN_SNIPER = 84;
const NEUTRAL_OB_ALMOST_MIN_RR = 1.1;

const BUILDUP_ELITE_MIN_CONF = 90;
const BUILDUP_ELITE_MIN_SNIPER = 80;
const BUILDUP_ELITE_MIN_SCORE = 78;
const BUILDUP_ELITE_MIN_RR = 1.1;
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

// ================= BITGET SYMBOL NORMALIZER =================
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
    s = s + "USDT";
  }
  return s;
}

// ================= CANDLE FETCH =================
async function fetchCandles(symbol, timeframe = "1h", limit = 100) {
  const tfMap = { "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H" };
  const granularity = tfMap[timeframe] || "1H";
  const clean = normalizeBitgetSymbol(symbol);
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${clean}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 400) {
        console.warn(`⚠️ BITGET limit (${res.status}) voor ${clean}, attempt ${attempt + 1}`);
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
    } catch (e) {
      console.error(`Candle fetch error voor ${clean}:`, e.message);
      return [];
    }
  }
  return [];
}

// ================= HELPERS =================
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);
  if (!Number.isFinite(s) || s < 0) return 0.001;
  if (s > 0.05) s = s / 100;
  return s;
}
function calculateFallbackRR(c, risk, isBull) {
  const price = Number(c.price || 0);
  const sl = Number(risk?.sl || 0);
  const tp = Number(risk?.tp || 0);
  if (!price || !sl || !tp) return 0;
  const raw = isBull ? (tp - price) / (price - sl) : (price - tp) / (sl - price);
  return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}
function cleanExpiredGuards() {
  const now = Date.now();
  for (const [key, until] of cooldownMap) if (now >= until) cooldownMap.delete(key);
  for (const [symbol, until] of symbolCooldownMap) if (now >= until) symbolCooldownMap.delete(symbol);
  for (const [symbol, until] of lastSignalMap) if (now >= until) lastSignalMap.delete(symbol);
}
function hasAnyOpenPositionForSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  for (const key of memory.keys()) if (key.startsWith(`${s}_`)) return true;
  return false;
}
function getOpenPositionSideForSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  for (const key of memory.keys()) if (key.startsWith(`${s}_`)) return key.split("_")[1] || "unknown";
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
function getTimeframeMeta(c) {
  let ctx = null;
  let tfScore = 0;
  try { ctx = buildTimeframeContext(c) || {}; } catch { ctx = {}; }
  if (Number.isFinite(Number(ctx?.score))) tfScore = Number(ctx.score);
  else if (Number.isFinite(Number(c?.tfScore))) tfScore = Number(c.tfScore);
  else tfScore = Number(multiTFScore(c) || 0);
  const tfStrength = Math.abs(tfScore);
  return { ctx, tfScore, tfStrength, tfAlignment: String(ctx?.alignment || c?.tfAlignment || "UNKNOWN") };
}
function isObWithSide(ob, isBull) {
  return (isBull && ob?.bias === "BULLISH") || (!isBull && ob?.bias === "BEARISH");
}
function isObAgainstSide(ob, isBull) {
  return (isBull && ob?.bias === "BEARISH") || (!isBull && ob?.bias === "BULLISH");
}
function getRegimeValueForConfluence(regime, scannerRegime) {
  return regime?.level || regime || scannerRegime || "NORMAL";
}
function buildCommonPayload(c, flow, sniper, funding, ob) {
  return {
    symbol: c.symbol, side: c.side, stage: c.stage, stageSource: c.stageSource || "unknown",
    uiOnly: Boolean(c.uiOnly), score: c.moveScore, price: c.price,
    flow: flow?.type || "NEUTRAL", sniper: sniper?.type || "NONE", sniperScore: sniper?.score || 0,
    funding: funding?.rate || 0, obBias: ob?.bias || "NEUTRAL", spreadPct: ob?.spreadPct ?? null,
    depthMinUsd1p: ob?.depthMinUsd1p ?? null, tfScore: Number(c?.tfScore || 0),
    tfStrength: Number(c?.tfStrength || 0), tfAlignment: c?.tfAlignment || "UNKNOWN",
    minRrRequired: Number(c?.minRrFloor || 0), ts: Date.now()
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
    const symbol = String(raw.symbol).toUpperCase();
    const side = String(raw.side).toLowerCase();
    if (side !== "bull" && side !== "bear") continue;
    const normalized = { ...raw, symbol, side };
    const key = `${symbol}_${side}`;
    const prev = map.get(key);
    if (!prev) { map.set(key, normalized); continue; }
    const prevStage = stageRank(prev.stage);
    const newStage = stageRank(normalized.stage);
    const prevScore = Number(prev.moveScore || 0);
    const newScore = Number(normalized.moveScore || 0);
    if (newStage > prevStage || (newStage === prevStage && newScore > prevScore)) map.set(key, normalized);
  }
  return Array.from(map.values()).sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));
}

// ========== AANGEPASTE GRADE ==========
function getSetupGrade({ c, ob, flow, sniper, confluence, rr, hasLiquidationData, isBull }) {
  let points = 0;
  const tfStrength = Number(c?.tfStrength || 0);
  if (confluence >= 85) points += 4; else if (confluence >= 75) points += 3; else if (confluence >= 65) points += 2; else if (confluence >= 55) points += 1;
  if (flow.type === "TREND") points += 2; else if (flow.type === "BUILDING") points += 1;
  if (sniper?.valid) points += 2;
  if (getSniperScore(sniper) >= 75) points += 1;
  if (tfStrength >= 2) points += 2; else if (tfStrength >= 1) points += 1;
  const obWith = isObWithSide(ob, isBull);
  const obAgainst = isObAgainstSide(ob, isBull);
  if (obWith) points += 2; if (obAgainst) points -= 2;
  if (hasLiquidationData) points += 1;
  const spread = normalizeSpread(ob?.spreadPct);
  const depth = Number(ob?.depthMinUsd1p || 0);
  if (spread <= 0.0025 && depth >= 200000) points += 1;
  if (spread > MAX_SPREAD_PCT || depth < MIN_DEPTH_USD_1P) points -= 2;
  if (c.stage === "entry") points += 1;
  else if (c.stage === "buildup" && flow.type === "TREND" && tfStrength >= 2) points += 1;
  if (rr >= 1.4) points += 1; else if (rr < 0.8) points -= 1;
  let grade = "C", recommendedRisk = "watch";
  if (points >= 9) { grade = "A"; recommendedRisk = "normal"; }
  else if (points >= 7) { grade = "B"; recommendedRisk = "small"; }
  if (grade === "A" && confluence < 70) { grade = "B"; recommendedRisk = "small"; }
  return { grade, points, recommendedRisk };
}

function buildWait(c, reason, flow, sniper, confluence, rr, funding, ob, risk, setupGrade, requiredConfluence, requiredRR) {
  const base = {
    ...buildCommonPayload(c, flow, sniper, funding, ob),
    action: "WAIT", reason, grade: setupGrade?.grade || "C", gradePoints: setupGrade?.points || 0,
    recommendedRisk: setupGrade?.recommendedRisk || "watch", confluence,
    rr: Number(rr || 0).toFixed(2), entry: risk?.entry ?? c.price ?? null, sl: risk?.sl ?? null, tp: risk?.tp ?? null,
    slSource: risk?.slSource || "liquidity/orderbook", tpSource: risk?.tpSource || "liquidity/liquidation",
    requiredConfluence: requiredConfluence ?? null, requiredRR: requiredRR ?? null
  };
  let reasonScore = null;
  if (reason === "LOW_CONFLUENCE" && requiredConfluence !== null && confluence !== null) reasonScore = confluence - requiredConfluence;
  if (reason === "LOW_RR" && requiredRR !== null && rr !== null) reasonScore = rr - requiredRR;
  base.reasonScore = reasonScore;
  return base;
}

function getDynamicMinConf({ c, ob, flow, vol, isBull }) {
  let minConf = 42;
  if (ob.bias === "NEUTRAL") minConf += 1;
  if (flow.type === "BUILDING") minConf += 1;
  if (flow.type === "TREND" && isObWithSide(ob, isBull) && (c.sniper?.valid ?? false) && getSniperScore(c.sniper) >= 80) minConf -= 8;
  return Math.max(45, minConf);
}

function isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend }) {
  const sniperScore = getSniperScore(sniper);
  if (c.stage !== "entry") return false;
  if (flow.type !== "TREND") return false;
  if (counterTrend) return false;
  if (setupGrade.grade === "A" && confluence >= NEUTRAL_OB_ENTRY_A_MIN_CONF && rr >= NEUTRAL_OB_ENTRY_A_MIN_RR && sniper?.valid && sniperScore >= NEUTRAL_OB_ENTRY_A_MIN_SNIPER) return true;
  if (setupGrade.grade === "B" && confluence >= NEUTRAL_OB_ENTRY_B_MIN_CONF && rr >= NEUTRAL_OB_ENTRY_B_MIN_RR && sniper?.valid && sniperScore >= NEUTRAL_OB_ENTRY_B_MIN_SNIPER && Number(c.moveScore || 0) >= NEUTRAL_OB_ENTRY_B_MIN_SCORE) return true;
  return false;
}
function isNeutralObAlmostException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend }) {
  const sniperScore = getSniperScore(sniper);
  return (c.stage === "almost" && flow.type === "TREND" && !counterTrend && rr >= NEUTRAL_OB_ALMOST_MIN_RR && setupGrade.grade === "A" && confluence >= NEUTRAL_OB_ALMOST_A_MIN_CONF && sniper?.valid && sniperScore >= NEUTRAL_OB_ALMOST_A_MIN_SNIPER);
}

function getDynamicMinRrFloor({ c, setupGrade, flow, sniper, confluence, counterTrend }) {
  let floor = MIN_RR_FLOOR;
  if (setupGrade?.grade === "A") floor = GRADE_A_MIN_RR_FLOOR;
  else if (setupGrade?.grade === "B") floor = GRADE_B_MIN_RR_FLOOR;
  else floor = GRADE_C_MIN_RR_FLOOR;
  if (c.stage === "buildup") floor = Math.max(floor, BUILDUP_MIN_RR_FLOOR);
  if (counterTrend) floor = Math.max(floor, COUNTERTREND_MIN_RR_FLOOR);
  if (c.stage === "entry" && flow?.type === "TREND" && !counterTrend && setupGrade?.grade === "A" && confluence >= 88 && sniper?.valid && getSniperScore(sniper) >= 80) floor = Math.min(floor, 0.85);
  return clamp(floor, 0.8, 1.50);
}

async function logAction(actionPayload, regimeLevel, btcState, shouldLog) {
  if (!shouldLog || !actionPayload) return;
  await logSystemEvent({ ...actionPayload, regime: regimeLevel, btcState });
}

function getSniperAdjustedRR(sniper, baseRR) {
  const score = Number(sniper?.score || 0);
  if (score >= 90) return Math.max(0.85, baseRR - 0.25);
  if (score >= 80) return Math.max(0.95, baseRR - 0.15);
  if (score >= 70) return Math.max(1.05, baseRR - 0.05);
  return baseRR + 0.1;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ================= CORE =================
export async function processTrades(input, options = {}) {
  const notify = options.notify !== false;
  const shouldLog = options.log !== false;
  const certaintyMode = options.certaintyMode || "aggressive";

  let candidatesRaw = [];
  let scanRegime = null;
  let scanBtc = null;

  if (Array.isArray(input)) {
    candidatesRaw = input;
  } else {
    candidatesRaw = [
      ...(input?.funnel?.bull?.entry || []),
      ...(input?.funnel?.bear?.entry || []),
      ...(input?.funnel?.bull?.almost || []),
      ...(input?.funnel?.bear?.almost || [])
    ];
    scanRegime = input?.regime;
    scanBtc = input?.btc;
  }

  let candidates;
  if (Array.isArray(input)) {
    let preFiltered = candidatesRaw.filter(c => {
      const score = Number(c.moveScore || 0);
      const stage = c.stage;
      return score >= 50 && (stage === "entry" || stage === "almost");
    });
    preFiltered.sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));
    const MAX_DEEP = 10, MAX_LIGHT = 15;
    const deepCandidates = preFiltered.slice(0, MAX_DEEP);
    const lightCandidates = preFiltered.slice(MAX_DEEP, MAX_DEEP + MAX_LIGHT);
    candidates = [...deepCandidates, ...lightCandidates];
    for (const c of candidates) c.analysisType = deepCandidates.includes(c) ? "DEEP" : "LIGHT";
    if (candidates.length === 0) {
      const fallbackActions = candidatesRaw.slice(0, 12).map(c => ({
        symbol: c.symbol, side: c.side, action: "WAIT", reason: "NO_PREFILTER_MATCH",
        score: c.moveScore || 0, ts: Date.now(), analysisType: "FALLBACK"
      }));
      return { actions: fallbackActions, candidatesCount: candidatesRaw.length };
    }
  } else {
    candidates = candidatesRaw.sort((a,b)=>Number(b.moveScore||0)-Number(a.moveScore||0)).slice(0,8);
    if (candidates.length === 0) return { actions: [], candidatesCount: 0 };
    for (const c of candidates) c.analysisType = "DEEP";
  }

  cleanExpiredGuards();
  const actions = [];

  let market = { trend: "NEUTRAL" };
  try { market = await getMarketContext("BTCUSDT", 0); } catch(e) { console.warn("Market context fallback:", e.message); }
  const btcState = scanBtc?.state || market?.trend || "NEUTRAL";

  // ========== DATA FETCH ==========
  const dataMap = new Map();
  const fetchCoinData = async (c) => {
    const symbol = c.symbol.toUpperCase();
    const pair = c.rawBitgetSymbol || symbol;
    const cleanPair = normalizeBitgetSymbol(pair);
    let ob = { ...DEFAULT_OB };
    try {
      const raw = await cachedFetch(`ob_${symbol}`, async () => {
        let data = null;
        for (let i=0;i<2;i++) { try { data = await fetchOrderBook(symbol+"USDT"); if(data) break; } catch {} await new Promise(r=>setTimeout(r,200)); }
        return data;
      }, 15000);
      if(raw) { const analyzed = analyzeOrderBookAdvanced(raw); ob = { ...DEFAULT_OB, ...(analyzed||{}), fetchFailed: false }; updateOrderbookMemory(symbol, analyzed); }
    } catch { ob = { ...DEFAULT_OB }; }
    let funding = { rate: 0 };
    try { funding = await cachedFetch(`fund_${symbol}`, () => fetchFunding(symbol+"USDT"), 120000); } catch {}
    const candles15m = await cachedFetch(`c15_${cleanPair}`, () => fetchCandles(cleanPair, "15m", 100), 20000);
    const candles1h = await cachedFetch(`c1h_${cleanPair}`, () => fetchCandles(cleanPair, "1h", 100), 20000);
    let candles4h = null;
    if (c.tfStrength >= 2) candles4h = await cachedFetch(`c4h_${cleanPair}`, () => fetchCandles(cleanPair, "4h", 100), 30000).catch(()=>null);
    const mtfRsi = getMTFRSI({ m15: candles15m, h1: candles1h, h4: candles4h });
    const structureState = { trend: "NEUTRAL" };
    const rsiData = { mtf: mtfRsi, structure: structureState, candles15m, candles1h };
    let liquidation = null;
    try { liquidation = await getLiquidationZones(symbol); } catch(e) { console.warn(`Liquidation fetch failed for ${symbol}:`, e.message); }
    dataMap.set(symbol, { ob, funding, rsiData, liquidation });
  };
  const chunks = chunkArray(candidates, 3);
  for (const chunk of chunks) await Promise.all(chunk.map(fetchCoinData));

  // ========== VERWERK COINS ==========
  for (const originalCoin of candidates) {
    const c = { ...originalCoin, symbol: originalCoin.symbol.toUpperCase(), side: originalCoin.side.toLowerCase() };
    const key = `${c.symbol}_${c.side}`;
    if (lastSignalMap.has(c.symbol) && Date.now() < lastSignalMap.get(c.symbol)) continue;
    if (symbolCooldownMap.has(c.symbol) && Date.now() < symbolCooldownMap.get(c.symbol)) continue;
    if (memory.has(key)) continue;
    if (memory.has(`${c.symbol}_bull`) || memory.has(`${c.symbol}_bear`)) continue;
    const symbolLockKey = `LOCK_${c.symbol}`;
    const prev = memory.get(key);
    const { ob, funding, rsiData, liquidation } = dataMap.get(c.symbol) || { ob: DEFAULT_OB, funding: { rate: 0 }, rsiData: null, liquidation: null };
    const isDeep = c.analysisType === "DEEP";
    if (ob?.mid > 0) c.price = ob.mid;
    else if (!c.price || c.price === 0) c.price = Number(c.lastPrice || 0);
    const isBull = c.side === "bull";

    // BTC dominance filters
    if (btcState === "STRONG_BULL" && !isBull) continue;
    if (btcState === "STRONG_BEAR" && isBull) continue;
    if (btcState === "BULLISH" && !isBull && c.moveScore < 75) continue;
    if (btcState === "BEARISH" && isBull && c.moveScore < 75) continue;
    if (btcState === "NEUTRAL" && c.moveScore < 80) continue;

    const tfMeta = getTimeframeMeta(c);
    c.tfStrength = tfMeta.tfStrength; c.tfScore = tfMeta.tfScore; c.tfAlignment = tfMeta.tfAlignment;
    c.atrPct15m = Number(tfMeta.ctx?.atrPct15m||0); c.atrPct1h = Number(tfMeta.ctx?.atrPct1h||0);
    c.atrPct4h = Number(tfMeta.ctx?.atrPct4h||0); c.atrPct24h = Number(tfMeta.ctx?.atrPct24h||0);
    if (!isBull && btcState === "BEARISH") { c.tfStrength += 0.5; c.moveScore += 2; }

    const flow = analyzeFlow(c);
    c.flow = flow.type;
    const rsiSignal = rsiData?.mtf ? getRSISignal(rsiData.mtf, c.side) : { valid: false, strength: 0 };
    const rsi = Number.isFinite(rsiSignal?.rsi) ? rsiSignal.rsi : null;
    if (rsi === null) {
      actions.push(buildWait(c, "RSI_DATA_INVALID", flow, null, 0, 0, funding, ob, null, { grade:"C", points:0, recommendedRisk:"watch" }, null, null));
      continue;
    }
    const rsiZone = rsiSignal?.zones ? (rsi <= rsiSignal.zones.L3 ? "LOWER_3" : rsi <= rsiSignal.zones.L2 ? "LOWER_2" : rsi <= rsiSignal.zones.L1 ? "LOWER_1" : rsi >= rsiSignal.zones.U3 ? "UPPER_3" : rsi >= rsiSignal.zones.U2 ? "UPPER_2" : rsi >= rsiSignal.zones.U1 ? "UPPER_1" : "MID") : "MID";

    // ✅ Sniper vóór earlyRSI
    const sniper = getSniperEntry(c, ob, rsiSignal);
    const sniperScore = sniper?.score || 0;

    // ✅ earlyRSI met drempel 75 (i.p.v. 80)
    const earlyRSI = (isBull && rsiZone === "LOWER_1" && sniperScore >= 75) || (!isBull && rsiZone === "UPPER_1" && sniperScore >= 75);

    if (isBull && !["LOWER_2","LOWER_3"].includes(rsiZone) && !earlyRSI) {
      actions.push(buildWait(c, "RSI_NOT_OVERSOLD_ENOUGH", flow, sniper, 0, 0, funding, ob, null, { grade:"C", points:0, recommendedRisk:"watch" }, null, null));
      continue;
    }
    if (isBull && rsiZone === "LOWER_2" && c.change1h > -0.2) {
      actions.push(buildWait(c, "RSI_NOT_DEEP_ENOUGH", flow, sniper, 0, 0, funding, ob, null, { grade:"C", points:0, recommendedRisk:"watch" }, null, null));
      continue;
    }
    if (!isBull && !["UPPER_2","UPPER_3"].includes(rsiZone) && !earlyRSI) {
      actions.push(buildWait(c, "RSI_NOT_OVERBOUGHT_ENOUGH", flow, sniper, 0, 0, funding, ob, null, { grade:"C", points:0, recommendedRisk:"watch" }, null, null));
      continue;
    }
    if (!isBull && rsiZone === "UPPER_2" && c.change1h < 0.2) {
      actions.push(buildWait(c, "RSI_NOT_HIGH_ENOUGH", flow, sniper, 0, 0, funding, ob, null, { grade:"C", points:0, recommendedRisk:"watch" }, null, null));
      continue;
    }

    const vol = getVolatility(c);
    const regime = getVolatilityRegime(c);
    const regimeLevel = getRegimeKey(regime, scanRegime);
    const regimeForConfluence = getRegimeValueForConfluence(regime, scanRegime);
    const liquidity = getLiquidityZones(c, ob);
    const hasLiquidationData = !!liquidation;

    // ✅ Confluence berekenen (nu beschikbaar)
    const confluence = calculateConfluence(c, ob, liquidity, funding, regimeForConfluence, hasLiquidationData ? liquidation : null, null);
    c.confluence = confluence;

    // ✅ MID filter: nu na confluence
    if (rsiZone === "MID" && confluence < 80) {
      actions.push(buildWait(c, "RSI_MID_NO_EDGE", flow, sniper, confluence, 0, funding, ob, null, { grade:"C", points:0, recommendedRisk:"watch" }, null, null));
      continue;
    }

    if (ob.fetchFailed) {
      actions.push(buildWait(c, "ORDERBOOK_FETCH_FAILED", flow, sniper, confluence, 0, funding, ob, null, { grade:"C", points:0, recommendedRisk:"watch" }, null, null));
      continue;
    }

    const marketCtx = { candles15m: rsiData?.candles15m || [], candles1h: rsiData?.candles1h || [] };
    const riskBase = await calculateRisk(c, ob, liquidity, hasLiquidationData ? liquidation : null, marketCtx);
    const rr = Number.isFinite(Number(riskBase?.rr)) ? Math.max(0, Number(riskBase.rr)) : calculateFallbackRR(c, riskBase, isBull);
    const structure = rsiData?.structure || { trend: "NEUTRAL" };
    c.structure = structure.trend;
    if ((isBull && c.structure === "BEARISH") || (!isBull && c.structure === "BULLISH")) {
      actions.push(buildWait(c, "STRUCTURE_AGAINST", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    // Momentum
    const strongMomentum = Math.abs(Number(c.change1h||0)) > 0.35 && Math.abs(Number(c.change24||0)) > 3 && (flow.type === "TREND" || flow.type === "BUILDING");
    const softMomentum = Math.abs(Number(c.change1h||0)) > 0.25 && Math.abs(Number(c.change24||0)) > 2 && (flow.type === "TREND" || flow.type === "BUILDING");
    if (!strongMomentum && !softMomentum) {
      actions.push(buildWait(c, "NO_MOMENTUM", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    // Fake breakout
    let fakeBreakout = false;
    const breakoutBufferPct = getDynamicBreakoutBufferPct(c, regime, vol, ob);
    if (hasLiquidationData && liquidation) {
      if (isBull && liquidation.nearestAbove && c.price > liquidation.nearestAbove * (1 + breakoutBufferPct)) fakeBreakout = true;
      if (!isBull && liquidation.nearestBelow && c.price < liquidation.nearestBelow * (1 - breakoutBufferPct)) fakeBreakout = true;
    }
    const candles15m = rsiData?.candles15m || [];
    let candleFakeBreakout = false;
    if (candles15m.length >= 20) {
      const recentHigh = Math.max(...candles15m.slice(-20).map(c => c.high));
      const recentLow = Math.min(...candles15m.slice(-20).map(c => c.low));
      if (isBull && c.price > recentLow && c.price < recentLow * 1.01) candleFakeBreakout = true;
      if (!isBull && c.price < recentHigh && c.price > recentHigh * 0.99) candleFakeBreakout = true;
    }
    const isValidFakeBreakout = fakeBreakout || candleFakeBreakout;
    const allowWithoutFakeBreakout = confluence >= 80 && sniperScore >= 75 && flow.type === "TREND";
    if (!isValidFakeBreakout && !allowWithoutFakeBreakout) {
      actions.push(buildWait(c, "NO_FAKE_BREAKOUT", flow, sniper, confluence, rr, funding, ob, riskBase, null, null, null));
      continue;
    }

    let allowedStages = ["entry"];
    if (certaintyMode !== "safe") allowedStages = ["entry", "almost"];
    const stageOK = allowedStages.includes(c.stage);
    const sniperOK = sniperScore >= 71;
    const sniperOK_legacy = (sniper?.valid && sniperScore >= 55) || confluence >= 85;
    const finalSniperOK = sniperOK || sniperOK_legacy;

    const setupGrade = getSetupGrade({ c, ob, flow, sniper, confluence, rr, hasLiquidationData, isBull });
    let minRrFloorBase = getDynamicMinRrFloor({ c, setupGrade, flow, sniper, confluence, counterTrend: (btcState === "BULLISH" && !isBull) || (btcState === "BEARISH" && isBull) });
    let minRrFloor = getSniperAdjustedRR(sniper, minRrFloorBase);
    if (!isBull && btcState === "BEARISH") minRrFloor = Math.max(0.8, minRrFloor - 0.05);
    c.minRrFloor = minRrFloor;

    const aSetupValid = isDeep && stageOK && finalSniperOK && setupGrade.grade === "A" && !ob.spoof && rr >= minRrFloor;
    const eliteEntry = aSetupValid && sniperScore >= 70 && confluence >= 79 && rr >= 1.2 && c.tfStrength >= 1;
    const bSetupValid = stageOK && setupGrade.grade === "B" && !ob.spoof && rr >= 1.05;
    const bEntry = !eliteEntry && bSetupValid && sniperScore >= 62 && confluence >= 66 && rr >= 1.05 && c.tfStrength >= 1;
    const godModeEntry = eliteEntry && sniperScore >= 85 && confluence >= 85 && rr >= 1.2;
    const shouldEnter = eliteEntry || bEntry;
    const reasonEntry = godModeEntry ? "GOD_MODE" : eliteEntry ? "ELITE_ENTRY" : bEntry ? "B_ENTRY" : "NONE";

    console.log(`🔍 ${c.symbol} (${isDeep?"DEEP":"LIGHT"}): sniper=${sniperScore}, conf=${confluence}, rr=${rr.toFixed(2)}, grade=${setupGrade.grade}, elite=${eliteEntry}, b=${bEntry}, godmode=${godModeEntry}, rsiZone=${rsiZone}, fakeBreakout=${isValidFakeBreakout}`);

    // Position management...
    if (prev) {
      const pos = { ...prev };
      const hitTP = (isBull && c.price >= pos.tp) || (!isBull && c.price <= pos.tp);
      const hitSL = (isBull && c.price <= pos.sl) || (!isBull && c.price >= pos.sl);
      if (hitTP || hitSL) {
        const reason = hitTP ? "TP" : "SL";
        const exitPayload = { ...buildCommonPayload(c, flow, sniper, funding, ob), action: "EXIT", reason, grade: pos.grade || "N/A", gradePoints: pos.gradePoints || 0, recommendedRisk: pos.recommendedRisk || "N/A", confluence, rr: Number(pos.rr || 0).toFixed(2), entry: pos.entry, sl: pos.sl, tp: pos.tp, slSource: pos.slSource || "N/A", tpSource: pos.tpSource || "N/A", rsi: pos.rsi, rsiHTF: pos.rsiHTF, rsiZone: pos.rsiZone };
        if (shouldLog) await logTrade({ symbol: c.symbol, side: c.side, entry: pos.entry, exit: c.price, sl: pos.sl, tp: pos.tp, result: hitTP ? "WIN" : "LOSS", reason, rr: pos.rr, grade: pos.grade || "N/A", gradePoints: pos.gradePoints || 0, recommendedRisk: pos.recommendedRisk || "N/A", confluence, score: c.moveScore, flow: flow.type, sniper: sniper?.type || "NONE", sniperScore, obBias: ob.bias, funding: funding.rate || 0, slSource: pos.slSource || "N/A", tpSource: pos.tpSource || "N/A", regime: regimeLevel, btcState, rsi: pos.rsi, rsiHTF: pos.rsiHTF, rsiZone: pos.rsiZone });
        const exitKey = `${key}_exit`;
        if (notify && !notifyState.get(exitKey)) {
          await sendExit({ symbol: c.symbol, side: c.side, reason, rr: pos.rr, grade: pos.grade, entry: pos.entry, sl: pos.sl, tp: pos.tp });
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
      const now = Date.now();
      const timeSinceLastEntry = now - (pos.lastEntryAt || pos.createdAt || 0);
      if (pos.entries && pos.entries.length < pos.maxEntries && timeSinceLastEntry > 5 * 60 * 1000) {
        const betterPrice = (isBull && c.price < pos.entry) || (!isBull && c.price > pos.entry);
        if (betterPrice) {
          pos.entries.push(c.price);
          pos.lastEntryAt = now;
          pos.entry = pos.entries.reduce((a,b)=>a+b,0) / pos.entries.length;
          memory.set(key, pos);
          console.log(`📈 SCALE ${c.symbol} (${pos.entries.length}/${pos.maxEntries}) @ ${c.price} -> avg ${pos.entry}`);
          continue;
        }
      }
      memory.set(key, pos);
      const runningPayload = { ...buildCommonPayload(c, flow, sniper, funding, ob), action: "HOLD", reason: "RUNNING", grade: pos.grade || "N/A", gradePoints: pos.gradePoints || 0, recommendedRisk: pos.recommendedRisk || "N/A", confluence, rr: Number(pos.rr || 0).toFixed(2), entry: pos.entry, sl: pos.sl, tp: pos.tp, slSource: pos.slSource || "N/A", tpSource: pos.tpSource || "N/A", rsi: pos.rsi, rsiHTF: pos.rsiHTF, rsiZone: pos.rsiZone };
      await logAction(runningPayload, regimeLevel, btcState, shouldLog);
      actions.push(runningPayload);
      continue;
    }

    // ========== ENTRY FILTERS ==========
    if (hasAnyOpenPositionForSymbol(c.symbol)) { actions.push(buildWait(c, `SYMBOL_ALREADY_OPEN_${getOpenPositionSideForSymbol(c.symbol)}`, flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    if (processingLocks.has(symbolLockKey)) { actions.push(buildWait(c, "DUPLICATE_PROCESSING_LOCK", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    if (Date.now() < (cooldownMap.get(key) || 0)) { actions.push(buildWait(c, "COOLDOWN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    if (memory.has(`${c.symbol}_${isBull ? "bear" : "bull"}`)) { actions.push(buildWait(c, "OPPOSITE_POSITION_OPEN", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }

    let lowVolConfluenceLimit = certaintyMode === "safe" ? 60 : 55;
    if (vol === "LOW" && confluence < lowVolConfluenceLimit && isDeep) { actions.push(buildWait(c, "LOW_VOL", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    if (flow.type === "NEUTRAL" && confluence < 58 && isDeep) { actions.push(buildWait(c, "NO_FLOW", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    const rrOverride = confluence >= 85 && sniperScore >= 80;
    if (rr < minRrFloor && !rrOverride && isDeep) { actions.push(buildWait(c, "LOW_RR", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, minRrFloor)); continue; }
    if ((c.stage === "entry" && c.tfStrength < 1) || (c.stage === "almost" && c.tfStrength < 1) || (c.stage === "buildup" && c.tfStrength < BUILDUP_ELITE_MIN_TF)) {
      if (isDeep) actions.push(buildWait(c, "ENTRY_FILTERED", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      else actions.push(buildWait(c, "LIGHT_NO_ENTRY", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
      continue;
    }
    const minConfDynamic = getDynamicMinConf({ c, ob, flow, vol, isBull });
    const minConf = Math.max(45, minConfDynamic);
    if (confluence < minConf && isDeep) { actions.push(buildWait(c, "LOW_CONFLUENCE", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, minConf, null)); continue; }
    const obAgainst = isObAgainstSide(ob, isBull);
    if (obAgainst && confluence < 75 && isDeep) { actions.push(buildWait(c, "OB_AGAINST", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    const hasLiquidationRoom = true;
    if (!hasLiquidationRoom && confluence < 75 && isDeep) { actions.push(buildWait(c, "NO_LIQUIDATION_ROOM", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    const spread = normalizeSpread(ob.spreadPct);
    const badSpread = spread > MAX_SPREAD_PCT;
    const badDepth = Number(ob.depthMinUsd1p || 0) < MIN_DEPTH_USD_1P;
    let marketQualityConfluenceLimit = certaintyMode === "safe" ? 75 : 65;
    if ((badSpread || badDepth) && confluence < marketQualityConfluenceLimit && isDeep) { actions.push(buildWait(c, "BAD_MARKET_QUALITY", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    if (ob.bias === "NEUTRAL" && confluence < 50 && !isNeutralObEntryException({ c, flow, sniper, confluence, rr, setupGrade, counterTrend: (btcState === "BULLISH" && !isBull) || (btcState === "BEARISH" && isBull) }) && isDeep) { actions.push(buildWait(c, "OB_NEUTRAL_LOW_CONF", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    const fundingRate = Number(funding?.rate || 0);
    if (Math.abs(fundingRate) > 0.015 && confluence < 85 && isDeep) { actions.push(buildWait(c, "EXTREME_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    if (isBull && fundingRate > 0.012 && confluence < 85 && isDeep) { actions.push(buildWait(c, "BULL_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }
    if (!isBull && fundingRate < -0.012 && confluence < 85 && isDeep) { actions.push(buildWait(c, "BEAR_CROWDED_FUNDING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null)); continue; }

    // ========== DIRECT ENTRY ==========
    if (shouldEnter && !hasAnyOpenPositionForSymbol(c.symbol)) {
      let finalTp = riskBase.tp;
      if (certaintyMode === "safe") finalTp *= 0.95;
      else {
        if (sniperScore >= 90) finalTp *= 0.9;
        else if (sniperScore >= 80) finalTp *= 0.95;
        if (isBull) { if (rsi < 30) finalTp *= 1.12; else if (rsi < 45) finalTp *= 1.06; }
        else { if (rsi > 70) finalTp *= 0.88; else if (rsi > 55) finalTp *= 0.94; }
      }
      const position = {
        symbol: c.symbol, side: c.side, stage: c.stage, stageSource: c.stageSource || "unknown", uiOnly: Boolean(c.uiOnly),
        entry: c.price, entries: [c.price], maxEntries: 3, lastEntryAt: Date.now(),
        sl: riskBase.sl, initialSl: riskBase.sl, tp: finalTp, rr,
        grade: setupGrade.grade, gradePoints: setupGrade.points, recommendedRisk: setupGrade.recommendedRisk,
        slSource: riskBase.slSource || "liquidity/orderbook", tpSource: riskBase.tpSource || "liquidity/liquidation",
        tfScore: c.tfScore, tfStrength: c.tfStrength, tfAlignment: c.tfAlignment,
        atrPct15m: c.atrPct15m, atrPct1h: c.atrPct1h, atrPct4h: c.atrPct4h, atrPct24h: c.atrPct24h,
        createdAt: Date.now(), rsi, rsiHTF: rsiSignal.mean1h || null, rsiZone
      };
      const entryPayload = { ...buildCommonPayload(c, flow, sniper, funding, ob), action: "ENTRY", reason: reasonEntry, grade: position.grade, gradePoints: position.gradePoints, recommendedRisk: position.recommendedRisk, confluence, rr: Number(rr).toFixed(2), entry: position.entry, sl: position.sl, tp: position.tp, slSource: position.slSource, tpSource: position.tpSource, rsi: position.rsi, rsiHTF: position.rsiHTF, rsiZone: position.rsiZone };
      processingLocks.add(symbolLockKey);
      try {
        memory.set(key, position);
        symbolCooldownMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
        cooldownMap.set(key, Date.now() + COOLDOWN_MS);
        lastSignalMap.set(c.symbol, Date.now() + SYMBOL_REENTRY_COOLDOWN_MS);
        await logAction(entryPayload, regimeLevel, btcState, shouldLog);
        if (notify && !notifyState.get(key)) {
          await sendEntry({ symbol: c.symbol, side: c.side, entry: position.entry, sl: position.sl, tp: position.tp, rr: position.rr, grade: position.grade, gradePoints: position.gradePoints, recommendedRisk: position.recommendedRisk, slSource: position.slSource, tpSource: position.tpSource, confluence, obBias: ob.bias, rsi: position.rsi, rsiHTF: position.rsiHTF, rsiZone: position.rsiZone, sniperScore });
          notifyState.set(key, true);
        }
      } finally { processingLocks.delete(symbolLockKey); }
      actions.push(entryPayload);
      continue;
    }

    if (!isDeep) actions.push(buildWait(c, "LIGHT_MONITORING", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
    else actions.push(buildWait(c, "SETUP_NOT_READY", flow, sniper, confluence, rr, funding, ob, riskBase, setupGrade, null, null));
  }

  if (actions.length === 0 && candidates.length > 0) {
    console.warn("⚠️ NO ACTIONS from tradeSystem – fallback WAIT generated");
    const fallbackActions = candidates.map(c => ({ symbol: c.symbol, side: c.side, action: "WAIT", reason: "NO_VALID_SETUPS", score: c.moveScore || 0, ts: Date.now(), analysisType: c.analysisType || "DEEP" }));
    return { actions: fallbackActions, candidatesCount: candidates.length };
  }
  return { actions: actions.sort((a,b)=>Number(b.score||0)-Number(a.score||0)), candidatesCount: candidates.length };
}