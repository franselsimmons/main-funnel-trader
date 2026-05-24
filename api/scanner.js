import {
  fetchCoinGeckoTopCached,
  generateShallowOb,
  fetchFuturesTickers
} from "../lib/_main_shared.js";

import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";
import { setLatestScan, getLatestScan } from "../lib/scanStore.js";

import {
  resetAnalytics,
  logAnalytics,
  getAnalytics
} from "../lib/analyticsEngine.js";

import { generateAdvice } from "../lib/analysisAdvisor.js";
import { classifyMarket } from "../lib/marketClassifier.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import {
  loadStageMemory,
  saveStageMemory,
  cleanMemory
} from "../lib/stageMemory.js";

import { initDefaultFilters } from "../lib/filterState.js";
import { buildTimeframeContext } from "../lib/timeframe.js";

const STAGES = ["entry", "almost", "buildup", "radar"];

// ================= DATA COLLECTION CONFIG =================
// Default AAN: doel is nu maximaal analyse-data verzamelen.
// Zet SCANNER_COLLECTION_MODE=false als je later weer strenger wilt.
const DATA_COLLECTION_MODE = process.env.SCANNER_COLLECTION_MODE !== "false";

const COLLECTION_TARGET_PER_SIDE = Number(
  process.env.SCANNER_COLLECTION_TARGET_PER_SIDE || 55
);

const COLLECTION_MAX_PER_SIDE = Number(
  process.env.SCANNER_COLLECTION_MAX_PER_SIDE || 80
);

// Moet >= tradeFunnel gate zijn, anders wordt alles alsnog rejected.
const COLLECTION_MIN_TRADE_SCORE = Number(
  process.env.SCANNER_COLLECTION_MIN_TRADE_SCORE || 45
);

const COLLECTION_ENTRY_SCORE = Number(
  process.env.SCANNER_COLLECTION_ENTRY_SCORE || 62
);

// ================= ADAPTIVE SCANNER CONFIG =================
// Versoepeld voor dataverzameling: meer coins bereiken bullFilter/bearFilter.
// Als filters niets teruggeven, krijgt coin FILTER_RELAXED i.p.v. uiOnly fallback.
function getAdaptiveScannerConfig(regime, market) {
  const trend = String(market?.trend || market?.state || "").toUpperCase();
  const r = String(regime || "NORMAL").toUpperCase();

  const cfg = {
    vmMin: DATA_COLLECTION_MODE ? 0.0015 : 0.008,
    hardChange24: DATA_COLLECTION_MODE ? 0 : 0.20,
    hardChange1h: DATA_COLLECTION_MODE ? 0 : 0.03,
    targetMinimum: DATA_COLLECTION_MODE ? COLLECTION_TARGET_PER_SIDE : 35,
    fallbackMax: DATA_COLLECTION_MODE ? COLLECTION_MAX_PER_SIDE : 45,
    scoreBoost: DATA_COLLECTION_MODE ? 10 : 0,
    allowNeutralDirection: true,
    collectionMode: DATA_COLLECTION_MODE
  };

  if (r === "LOW_VOL") {
    cfg.vmMin = DATA_COLLECTION_MODE ? 0.001 : 0.006;
    cfg.hardChange24 = DATA_COLLECTION_MODE ? 0 : 0.12;
    cfg.hardChange1h = DATA_COLLECTION_MODE ? 0 : 0.02;
    cfg.targetMinimum = DATA_COLLECTION_MODE ? COLLECTION_TARGET_PER_SIDE : 45;
    cfg.fallbackMax = DATA_COLLECTION_MODE ? COLLECTION_MAX_PER_SIDE : 60;
    cfg.scoreBoost = DATA_COLLECTION_MODE ? 12 : 4;
  }

  if (r === "HIGH_VOL") {
    cfg.vmMin = DATA_COLLECTION_MODE ? 0.0025 : 0.015;
    cfg.hardChange24 = DATA_COLLECTION_MODE ? 0 : 0.45;
    cfg.hardChange1h = DATA_COLLECTION_MODE ? 0 : 0.07;
    cfg.targetMinimum = DATA_COLLECTION_MODE ? COLLECTION_TARGET_PER_SIDE : 25;
    cfg.fallbackMax = DATA_COLLECTION_MODE ? COLLECTION_MAX_PER_SIDE : 35;
    cfg.scoreBoost = DATA_COLLECTION_MODE ? 7 : -2;
  }

  if (trend === "BEARISH" || trend === "BULLISH") {
    cfg.targetMinimum += DATA_COLLECTION_MODE ? 0 : 5;
    cfg.fallbackMax += DATA_COLLECTION_MODE ? 0 : 8;
    cfg.scoreBoost += DATA_COLLECTION_MODE ? 2 : 0;
  }

  return cfg;
}

// ================= GENERIC HELPERS =================
function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickNumber(object, keys, fallback = 0) {
  for (const key of keys) {
    const n = Number(object?.[key]);
    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function normalizeCounterMap(map) {
  const out = {};

  for (const [key, value] of Object.entries(map || {})) {
    const n = Math.round(Number(value || 0));
    if (n > 0) out[String(key)] = n;
  }

  return out;
}

function emptyDashboardStats(now = Date.now()) {
  return {
    startedAt: now,
    lastResetAt: now,
    lastScanAt: 0,
    totalScans: 0,
    totalEntries: 0,
    totalRejected: 0,
    totalOtherTrades: 0,
    totalFunnelCoins: 0,
    totalCandidates: 0,
    lastEntries: 0,
    lastRejected: 0,
    lastOtherTrades: 0,
    lastFunnelCoins: 0,
    lastCandidates: 0,
    rejectReasonCounts: {},
    actionCounts: {},
    entryRows: [],
    rejectedRows: [],
    tradeRows: []
  };
}

function normalizeDashboardStats(stats, now = Date.now()) {
  const base = stats ? { ...stats } : emptyDashboardStats(now);

  return {
    startedAt: safeNumber(base?.startedAt, now),
    lastResetAt: safeNumber(base?.lastResetAt, safeNumber(base?.startedAt, now)),
    lastScanAt: safeNumber(base?.lastScanAt, 0),
    totalScans: safeNumber(base?.totalScans, 0),
    totalEntries: safeNumber(base?.totalEntries, 0),
    totalRejected: safeNumber(base?.totalRejected, 0),
    totalOtherTrades: safeNumber(base?.totalOtherTrades, 0),
    totalFunnelCoins: safeNumber(base?.totalFunnelCoins, 0),
    totalCandidates: safeNumber(base?.totalCandidates, 0),
    lastEntries: safeNumber(base?.lastEntries, 0),
    lastRejected: safeNumber(base?.lastRejected, 0),
    lastOtherTrades: safeNumber(base?.lastOtherTrades, 0),
    lastFunnelCoins: safeNumber(base?.lastFunnelCoins, 0),
    lastCandidates: safeNumber(base?.lastCandidates, 0),
    rejectReasonCounts: normalizeCounterMap(base?.rejectReasonCounts),
    actionCounts: normalizeCounterMap(base?.actionCounts),
    entryRows: safeArray(base?.entryRows),
    rejectedRows: safeArray(base?.rejectedRows),
    tradeRows: safeArray(base?.tradeRows)
  };
}

// ================= SIDE NORMALIZER =================
function normalizeScanSide(side) {
  const s = String(side || "both").toLowerCase();

  if (s === "bull") return "bull";
  if (s === "bear") return "bear";

  return "both";
}

// ================= NOTIFY NORMALIZER =================
function normalizeNotify(value) {
  const v = String(value || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

// ================= STORE NORMALIZER =================
function normalizeStore(value, fallback = true) {
  if (value === undefined || value === null) return fallback;

  const v = String(value || "").toLowerCase();

  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;

  return fallback;
}

// ================= STAGE SAFETY =================
function safeStage(stage) {
  return STAGES.includes(stage) ? stage : "radar";
}

// ================= DIRECTIONAL PRESSURE =================
function getDirectionalPressure(c) {
  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);

  return (ch1 * 0.70) + (ch24 * 0.30);
}

// ================= DIRECTION ALLOWANCE =================
// Collection mode: neutrale coins mogen door.
// Anders krijg je bij change1h/change24 = 0 weer funnelCount 0.
function displayDirectionAllowed(c, side, adaptive = {}) {
  const pressure = getDirectionalPressure(c);
  const vm = Number(c.vm || 0);

  if (adaptive.collectionMode && vm >= Number(adaptive.vmMin || 0)) {
    if (side === "bull" && pressure >= -0.35) return true;
    if (side === "bear" && pressure <= 0.35) return true;
    return true;
  }

  const minPressure = adaptive.scoreBoost > 0 ? 0.012 : 0.02;

  if (side === "bull") {
    if (pressure > minPressure) return true;

    return (
      adaptive.allowNeutralDirection &&
      vm >= Number(adaptive.vmMin || 0) * 1.35 &&
      Number(c.change1h || 0) >= -0.035
    );
  }

  if (side === "bear") {
    if (pressure < -minPressure) return true;

    return (
      adaptive.allowNeutralDirection &&
      vm >= Number(adaptive.vmMin || 0) * 1.35 &&
      Number(c.change1h || 0) <= 0.035
    );
  }

  return false;
}

// ================= FLOW =================
// Collection mode: bij ontbrekende change-data kan VM alsnog BUILDING opleveren.
function detectFlow(c, adaptive = {}) {
  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));
  const vm = Number(c.vm || 0);
  const boost = Number(adaptive.scoreBoost || 0);

  if (ch1 > (boost > 0 ? 0.22 : 0.30) && ch24 > (boost > 0 ? 0.85 : 1.15)) {
    return "TREND";
  }

  if (ch1 > (boost > 0 ? 0.035 : 0.06) || ch24 > (boost > 0 ? 0.20 : 0.32)) {
    return "BUILDING";
  }

  if (adaptive.collectionMode) {
    if (vm >= Number(adaptive.vmMin || 0) * 2.0) return "BUILDING";
    if (vm >= Number(adaptive.vmMin || 0)) return "BUILDING";
  }

  if (ch24 > 0.12 || ch1 > 0.015) {
    return "EARLY";
  }

  return "NEUTRAL";
}

// ================= FRESHNESS =================
function calculateFreshness(c, side) {
  const dir = side === "bear" ? -1 : 1;
  const ch24 = Math.max(0, Number(c.change24 || 0) * dir);
  const ch1 = Math.max(0, Number(c.change1h || 0) * dir);

  let freshness = 0;

  if (ch1 > 1.5) freshness += 18;
  else if (ch1 > 0.9) freshness += 13;
  else if (ch1 > 0.45) freshness += 9;
  else if (ch1 > 0.2) freshness += 5;

  if (ch24 > 0) {
    const ratio = ch1 / Math.max(ch24, 0.01);

    if (ratio > 0.45) freshness += 8;
    else if (ratio > 0.25) freshness += 5;
    else if (ratio > 0.12) freshness += 2;
  }

  if (ch24 > 8 && ch1 < 0.25) freshness -= 8;
  if (ch24 > 12 && ch1 < 0.10) freshness -= 10;

  return Math.max(0, Math.min(freshness, 30));
}

// ================= DIRECTIONAL SCORE =================
function calculateScore(c, regime, side, adaptive = {}) {
  let score = 0;
  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(c.change24 || 0) * dir;
  const ch1 = Number(c.change1h || 0) * dir;
  const vm = Number(c.vm || 0);
  const freshness = calculateFreshness(c, side);

  if (ch24 > 10) score += 22;
  else if (ch24 > 6) score += 16;
  else if (ch24 > 3) score += 10;
  else if (ch24 > 2.0) score += 10;
  else if (ch24 > 1) score += 5;
  else if (ch24 > 0.25) score += 2;

  if (ch1 > 2) score += 32;
  else if (ch1 > 1.1) score += 24;
  else if (ch1 > 0.55) score += 15;
  else if (ch1 > 0.35) score += 15;
  else if (ch1 > 0.2) score += 7;
  else if (ch1 > 0.03) score += 3;

  if (vm > 0.40) score += 20;
  else if (vm > 0.20) score += 12;
  else if (vm > 0.10) score += 7;
  else if (vm > 0.04) score += 3;
  else if (adaptive.collectionMode && vm >= Number(adaptive.vmMin || 0) * 2.0) score += 4;
  else if (adaptive.collectionMode && vm >= Number(adaptive.vmMin || 0)) score += 2;

  score += freshness;

  const pressure = getDirectionalPressure(c);
  const alignedPressure = side === "bear" ? -pressure : pressure;

  if (adaptive.collectionMode) {
    if (alignedPressure < -0.35) score -= 8;
  } else {
    if (alignedPressure < 0.012) score -= 4;
    if (alignedPressure < -0.035) score -= 10;
  }

  if (regime === "LOW_VOL") score -= adaptive.collectionMode ? 0 : 2;
  if (regime === "HIGH_VOL") score += 6;

  score += Number(adaptive.scoreBoost || 0);

  if (adaptive.collectionMode && vm >= Number(adaptive.vmMin || 0)) {
    score = Math.max(score, COLLECTION_MIN_TRADE_SCORE);
  }

  return Math.max(0, Math.min(score, 100));
}

// ================= FALLBACK STAGE =================
function fallbackStage(score, flow, freshness = 0) {
  if (flow === "TREND" && score >= 64) return "entry";
  if (flow === "TREND" && score >= 48) return "almost";
  if (flow === "TREND" && score >= 32) return "buildup";

  if (flow === "BUILDING" && score >= 52) return "almost";
  if (flow === "BUILDING" && score >= 24) return "buildup";
  if (flow === "BUILDING" && freshness >= 3) return "buildup";

  if (flow === "EARLY" && score >= 12) return "buildup";

  return "radar";
}

// ================= RELAXED TRADE STAGE =================
// Dit is de kernfix.
// Geen uiOnly. Hierdoor kan tradeFunnel deze coins gebruiken.
function relaxedTradeStage(score, flow, adaptive = {}) {
  if (!adaptive.collectionMode) return "";

  if (score >= COLLECTION_ENTRY_SCORE && flow === "TREND") return "entry";
  if (score >= COLLECTION_ENTRY_SCORE + 5) return "entry";

  if (score >= COLLECTION_MIN_TRADE_SCORE) return "almost";

  return "";
}

// ================= STAGE MERGE =================
function mergeStage(prevStage, filterStage) {
  const order = ["radar", "buildup", "almost", "entry"];
  const prevIndex = order.indexOf(prevStage || "radar");
  const newIndex = order.indexOf(filterStage || "radar");

  if (newIndex >= prevIndex) return filterStage;

  return order[Math.max(0, prevIndex - 1)];
}

// ================= BITGET SYMBOL NORMALIZERS =================
function normalizeBitgetContractSymbol(symbolKey) {
  return String(symbolKey || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");
}

function normalizeBaseSymbol(symbolKey) {
  return String(symbolKey || "")
    .toUpperCase()
    .trim()
    .replace(/[-_]?USDT$/, "")
    .replace(/[-_]?USDC$/, "")
    .replace(/[-_]?USD$/, "");
}

function normalizeBitgetKey(symbolKey) {
  return normalizeBaseSymbol(normalizeBitgetContractSymbol(symbolKey));
}

function normalizeBitgetProductType(productType, rawSymbol = "") {
  const p = String(productType || "").toUpperCase();
  const raw = String(rawSymbol || "").toUpperCase();

  if (p === "USDT-FUTURES" || p === "COIN-FUTURES" || p === "USDC-FUTURES") return p;
  if (raw.includes("_UMCBL") || raw.includes("-UMCBL") || raw.endsWith("USDT")) return "USDT-FUTURES";
  if (raw.includes("_DMCBL") || raw.includes("-DMCBL")) return "COIN-FUTURES";
  if (raw.includes("_CMCBL") || raw.includes("-CMCBL") || raw.endsWith("USDC")) return "USDC-FUTURES";

  return "USDT-FUTURES";
}

function getFuturesEntries(futures) {
  if (futures instanceof Map) return Array.from(futures.entries());

  if (Array.isArray(futures)) {
    return futures.map((value, index) => [
      value?.symbol || value?.instId || value?.tickerId || index,
      value
    ]);
  }

  if (Array.isArray(futures?.data)) {
    return futures.data.map((value, index) => [
      value?.symbol || value?.instId || value?.tickerId || index,
      value
    ]);
  }

  if (futures && typeof futures === "object") {
    return Object.entries(futures);
  }

  return [];
}

function buildTradableSymbolMap(futures) {
  const out = new Map();

  for (const [key, value] of getFuturesEntries(futures)) {
    const rawBitgetSymbol = String(
      value?.symbol ||
        value?.instId ||
        value?.tickerId ||
        value?.symbolName ||
        key ||
        ""
    ).toUpperCase().trim();

    if (!rawBitgetSymbol) continue;

    const bitgetSymbol = normalizeBitgetContractSymbol(rawBitgetSymbol);
    const baseSymbol = normalizeBitgetKey(rawBitgetSymbol);
    const productType = normalizeBitgetProductType(value?.productType, rawBitgetSymbol);

    if (!bitgetSymbol || !baseSymbol) continue;

    const candidate = {
      baseSymbol,
      bitgetSymbol,
      productType,
      rawBitgetSymbol
    };

    const prev = out.get(baseSymbol);

    if (!prev) {
      out.set(baseSymbol, candidate);
      continue;
    }

    if (prev.productType !== "USDT-FUTURES" && candidate.productType === "USDT-FUTURES") {
      out.set(baseSymbol, candidate);
    }
  }

  return out;
}

// ================= NORMALIZE COIN =================
function estimateVm(marketCap, totalVolume) {
  if (marketCap > 0 && totalVolume > 0) {
    return totalVolume / marketCap;
  }

  if (totalVolume > 0) {
    return Math.max(0.002, Math.min(totalVolume / 1_000_000_000, 0.08));
  }

  // Belangrijk: als CoinGecko-cache volume/marketCap mist,
  // dan mag scanner niet leeg eindigen tijdens collection mode.
  return DATA_COLLECTION_MODE ? 0.006 : 0;
}

function normalize(raw) {
  const marketCap = pickNumber(raw, [
    "market_cap",
    "marketCap",
    "mc"
  ], 0);

  const totalVolume = pickNumber(raw, [
    "total_volume",
    "totalVolume",
    "volume",
    "quoteVolume",
    "turnover24h",
    "usdtVolume"
  ], 0);

  const change24 = pickNumber(raw, [
    "price_change_percentage_24h",
    "price_change_percentage_24h_in_currency",
    "change24",
    "change24h",
    "priceChange24h",
    "priceChangePercent24h",
    "priceChangePercentage24h"
  ], 0);

  const change1h = pickNumber(raw, [
    "price_change_percentage_1h_in_currency",
    "price_change_percentage_1h",
    "change1h",
    "priceChange1h",
    "priceChangePercent1h",
    "priceChangePercentage1h"
  ], 0);

  const symbol = normalizeBaseSymbol(
    raw?.symbol ||
      raw?.baseSymbol ||
      raw?.base ||
      raw?.coin ||
      ""
  );

  return {
    symbol,
    name: raw?.name || symbol,
    price: pickNumber(raw, [
      "current_price",
      "price",
      "last",
      "lastPr",
      "close",
      "markPrice"
    ], 0),
    change24,
    change1h,
    volume: totalVolume,
    marketCap,
    vm: estimateVm(marketCap, totalVolume),
    ob: generateShallowOb()
  };
}

function buildCoinTimeframeMeta(coin) {
  try {
    const ctx = buildTimeframeContext(coin) || {};
    const score = Number.isFinite(Number(ctx?.score)) ? Number(ctx.score) : 0;

    return {
      tfContext: ctx,
      tfScore: score,
      tfStrength: Math.abs(score),
      tfAlignment: String(ctx?.alignment || "UNKNOWN")
    };
  } catch {
    return {
      tfContext: {},
      tfScore: 0,
      tfStrength: 0,
      tfAlignment: "UNKNOWN"
    };
  }
}

// ================= EMPTY FUNNEL =================
function emptyFunnel() {
  return {
    bull: {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    },
    bear: {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    }
  };
}

// ================= COUNT HELPERS =================
function countSide(funnel, side) {
  if (!funnel?.[side]) return 0;

  let total = 0;

  for (const stage of STAGES) {
    total += Array.isArray(funnel[side][stage])
      ? funnel[side][stage].length
      : 0;
  }

  return total;
}

function countFunnel(funnel) {
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}

function hasSymbolInSide(funnel, side, symbol) {
  for (const stage of STAGES) {
    const rows = funnel?.[side]?.[stage];

    if (Array.isArray(rows) && rows.some(c => c.symbol === symbol)) {
      return true;
    }
  }

  return false;
}

function sortFunnel(funnel) {
  for (const side of ["bull", "bear"]) {
    for (const stageKey of STAGES) {
      funnel[side][stageKey].sort(
        (a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0)
      );
    }
  }
}

// ================= COLLECTION FILL =================
// Geen UI fallback. Dit vult tradebare analyse-candidates aan.
// uiOnly=false zodat tradeFunnel ze niet weggooit.
function fillCollectionCandidates({
  rawCoins,
  regime,
  funnel,
  side,
  tradableSymbolMap,
  max = COLLECTION_MAX_PER_SIDE,
  adaptive = {}
}) {
  if (!adaptive.collectionMode) return;

  const targetMinimum = adaptive.targetMinimum || COLLECTION_TARGET_PER_SIDE;
  if (countSide(funnel, side) >= targetMinimum) return;

  const list = [];

  for (const raw of rawCoins) {
    const base = normalize(raw);

    if (!base.symbol || base.price <= 0) continue;
    if (hasSymbolInSide(funnel, side, base.symbol)) continue;
    if (base.vm < Number(adaptive.vmMin || 0)) continue;

    const contractMeta = tradableSymbolMap.get(base.symbol);
    if (!contractMeta) continue;

    const flow = detectFlow(base, adaptive);
    const score = calculateScore(base, regime, side, adaptive);
    const relaxedStage = relaxedTradeStage(score, flow, adaptive);

    if (!relaxedStage) continue;

    const edge = calculateEdge(base, regime) || 0;
    const freshness = calculateFreshness(base, side);

    const tfMeta = buildCoinTimeframeMeta({
      ...base,
      side,
      flow,
      freshness,
      moveScore: score,
      edge
    });

    list.push({
      ...base,
      side,
      flow,
      freshness,
      moveScore: score,
      edge,

      stage: relaxedStage,
      stageSource: "filter_relaxed_fill",
      uiOnly: false,
      scannerQuality: "FILTER_RELAXED",

      symbolTradable: true,
      bitgetSymbol: contractMeta.bitgetSymbol,
      productType: contractMeta.productType,
      rawBitgetSymbol: contractMeta.rawBitgetSymbol,

      tfContext: tfMeta.tfContext,
      tfScore: tfMeta.tfScore,
      tfStrength: tfMeta.tfStrength,
      tfAlignment: tfMeta.tfAlignment
    });
  }

  list.sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));

  let added = 0;

  for (const coin of list) {
    if (added >= max) break;
    if (countSide(funnel, side) >= targetMinimum) break;

    funnel[side][safeStage(coin.stage)].push(coin);
    logAnalytics(coin);
    added++;
  }
}

// ================= MERGE PARTIAL SIDE SCAN =================
async function mergeWithPreviousSideScan(currentPayload, scanSide) {
  if (scanSide === "both") return currentPayload;

  const previous = await getLatestScan();

  if (!previous?.ok) return currentPayload;

  const mergedFunnel = emptyFunnel();
  const otherSide = scanSide === "bull" ? "bear" : "bull";

  mergedFunnel[scanSide] = currentPayload.funnel?.[scanSide] || mergedFunnel[scanSide];
  mergedFunnel[otherSide] = previous.funnel?.[otherSide] || mergedFunnel[otherSide];

  const mergedAnalytics = {
    ...(previous.analytics || {}),
    [scanSide]: currentPayload.analytics?.[scanSide]
  };

  const mergedAdvice = {
    ...(previous.advice || {}),
    [scanSide]: currentPayload.advice?.[scanSide]
  };

  const candidatesBull = scanSide === "bull"
    ? currentPayload.candidatesBull
    : previous.candidatesBull || 0;

  const candidatesBear = scanSide === "bear"
    ? currentPayload.candidatesBear
    : previous.candidatesBear || 0;

  sortFunnel(mergedFunnel);

  return {
    ...previous,
    ...currentPayload,
    funnel: mergedFunnel,
    funnelCount: countFunnel(mergedFunnel),
    bullCount: countSide(mergedFunnel, "bull"),
    bearCount: countSide(mergedFunnel, "bear"),
    analytics: mergedAnalytics,
    advice: mergedAdvice,
    trades: safeArray(currentPayload.trades),
    dashboardStats: currentPayload.dashboardStats || previous.dashboardStats || emptyDashboardStats(Date.now()),
    tradeSystemAnalysis: currentPayload.tradeSystemAnalysis || previous.tradeSystemAnalysis || null,
    candidatesBull,
    candidatesBear,
    candidates: candidatesBull + candidatesBear,
    lastBullScan: scanSide === "bull" ? Date.now() : previous.lastBullScan || null,
    lastBearScan: scanSide === "bear" ? Date.now() : previous.lastBearScan || null,
    lastSideScan: scanSide,
    scanMode: "merged",
    updatedAt: Date.now()
  };
}

// ================= BITGET FAILURE HANDLER =================
async function handleBitgetUniverseUnavailable(scanSide) {
  const previous = await getLatestScan();

  if (previous?.ok) {
    return {
      ...previous,
      ok: true,
      stale: true,
      staleReason: "bitget_universe_unavailable",
      bitgetSymbols: 0,
      bitgetUniverseReady: false,
      scanRequestedSide: scanSide,
      servedAt: Date.now()
    };
  }

  throw new Error("bitget_universe_unavailable");
}

// ================= BTC STATE =================
function classifyBtcState({ change24, change1h }) {
  const ch24 = Number(change24 || 0);
  const ch1 = Number(change1h || 0);

  if (ch24 > 1.50 && ch1 > 0.50) return "STRONG_BULL";
  if (ch24 < -1.50 && ch1 < -0.50) return "STRONG_BEAR";

  if (ch24 > 0.60 || ch1 > 0.25) return "BULLISH";
  if (ch24 < -0.60 || ch1 < -0.25) return "BEARISH";

  return "NEUTRAL";
}

// ================= CORE =================
export async function buildScanPayload(options = {}) {
  const scanSide = normalizeScanSide(options.side);
  const notify = options.notify !== false;
  const store = options.store !== false;

  initDefaultFilters(true);
  resetAnalytics();

  const previousLatest = await getLatestScan().catch(() => null);
  const rawCoins = await fetchCoinGeckoTopCached();

  if (!Array.isArray(rawCoins)) {
    throw new Error("API error");
  }

  let futures = new Map();

  try {
    futures = await fetchFuturesTickers();
  } catch (e) {
    console.error("BITGET FILTER ERROR:", e.message);
  }

  const tradableSymbolMap = buildTradableSymbolMap(futures);
  const validSymbols = new Set(tradableSymbolMap.keys());
  const bitgetUniverseReady = tradableSymbolMap.size > 0;

  if (!bitgetUniverseReady) {
    return await handleBitgetUniverseUnavailable(scanSide);
  }

  const btcRaw =
    rawCoins.find(c => normalizeBaseSymbol(c?.symbol) === "BTC") ||
    rawCoins[0] ||
    {};

  const btcCoin = normalize(btcRaw);

  const btc = {
    state: classifyBtcState({
      change24: btcCoin.change24,
      change1h: btcCoin.change1h
    }),
    chg24: btcCoin.change24,
    chg1h: btcCoin.change1h
  };

  const regime = detectRegime(rawCoins) || "NORMAL";
  const market = classifyMarket(rawCoins);
  const adaptive = getAdaptiveScannerConfig(regime, market);

  const funnel = emptyFunnel();

  let candidatesBull = 0;
  let candidatesBear = 0;

  let memory = await loadStageMemory();
  const activeSymbols = [];

  const sidesToScan = scanSide === "both" ? ["bull", "bear"] : [scanSide];

  for (const raw of rawCoins) {
    const base = normalize(raw);

    if (!base.symbol || base.price <= 0) continue;

    const contractMeta = tradableSymbolMap.get(base.symbol);
    if (!contractMeta) continue;

    activeSymbols.push(base.symbol);

    if (base.vm < adaptive.vmMin) continue;

    if (
      !adaptive.collectionMode &&
      Math.abs(base.change24) < adaptive.hardChange24 &&
      Math.abs(base.change1h) < adaptive.hardChange1h
    ) {
      continue;
    }

    for (const direction of sidesToScan) {
      if (!displayDirectionAllowed(base, direction, adaptive)) continue;

      const flow = detectFlow(base, adaptive);
      const score = calculateScore(base, regime, direction, adaptive);
      const edge = calculateEdge(base, regime) || 0;
      const freshness = calculateFreshness(base, direction);

      const tfMeta = buildCoinTimeframeMeta({
        ...base,
        side: direction,
        flow,
        freshness,
        moveScore: score,
        edge
      });

      const coin = {
        ...base,
        side: direction,
        flow,
        freshness,
        moveScore: score,
        edge,

        symbolTradable: true,
        bitgetSymbol: contractMeta.bitgetSymbol,
        productType: contractMeta.productType,
        rawBitgetSymbol: contractMeta.rawBitgetSymbol,

        tfContext: tfMeta.tfContext,
        tfScore: tfMeta.tfScore,
        tfStrength: tfMeta.tfStrength,
        tfAlignment: tfMeta.tfAlignment
      };

      const key = `${base.symbol}_${direction}`;
      const prev = memory[key] || { stage: "radar" };

      const realFilterStage = direction === "bull"
        ? bullFilter(coin)
        : bearFilter(coin);

      const relaxedStage = !realFilterStage
        ? relaxedTradeStage(score, flow, adaptive)
        : "";

      const effectiveStage = realFilterStage || relaxedStage;
      const fallback = fallbackStage(score, flow, freshness);

      const newStage = safeStage(
        effectiveStage
          ? mergeStage(prev.stage, effectiveStage)
          : fallback
      );

      coin.stage = newStage;
      coin.stageSource = realFilterStage
        ? "filter"
        : relaxedStage
          ? "filter_relaxed"
          : "fallback";

      coin.uiOnly = !(realFilterStage || relaxedStage);

      coin.scannerQuality = realFilterStage
        ? "FILTER"
        : relaxedStage
          ? "FILTER_RELAXED"
          : "FALLBACK";

      funnel[direction][newStage].push(coin);

      if (!coin.uiOnly) {
        logAnalytics(coin);
      }

      if (!coin.uiOnly && newStage === "entry") {
        if (direction === "bull") candidatesBull++;
        if (direction === "bear") candidatesBear++;
      }

      memory[key] = {
        stage: newStage,
        prevStage: prev.stage || "radar",
        updatedAt: Date.now()
      };
    }
  }

  if (scanSide === "both" || scanSide === "bull") {
    fillCollectionCandidates({
      rawCoins,
      regime,
      funnel,
      side: "bull",
      tradableSymbolMap,
      max: adaptive.fallbackMax,
      adaptive
    });
  }

  if (scanSide === "both" || scanSide === "bear") {
    fillCollectionCandidates({
      rawCoins,
      regime,
      funnel,
      side: "bear",
      tradableSymbolMap,
      max: adaptive.fallbackMax,
      adaptive
    });
  }

  memory = cleanMemory(memory, activeSymbols);

  if (store) {
    await saveStageMemory(memory);
  }

  sortFunnel(funnel);

  const analytics = getAnalytics();
  const advice = generateAdvice(analytics);
  const now = Date.now();

  const currentPayload = {
    ok: true,
    scanSide,
    scanMode: scanSide,
    notify,
    store,

    dataCollectionMode: adaptive.collectionMode,

    btc,
    regime,
    market,

    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),

    trades: safeArray(previousLatest?.trades),
    dashboardStats: normalizeDashboardStats(previousLatest?.dashboardStats, now),
    tradeSystemAnalysis: previousLatest?.tradeSystemAnalysis || null,

    analytics,
    advice,

    total: rawCoins.length,

    candidates: candidatesBull + candidatesBear,
    candidatesBull,
    candidatesBear,

    bitgetSymbols: validSymbols.size,
    bitgetUniverseReady: true,

    scannerUpdatedAt: now,
    tradeFunnelUpdatedAt: previousLatest?.tradeFunnelUpdatedAt || null,
    updatedAt: now,

    lastBullScan: scanSide === "bull" || scanSide === "both" ? now : null,
    lastBearScan: scanSide === "bear" || scanSide === "both" ? now : null
  };

  const finalPayload = await mergeWithPreviousSideScan(currentPayload, scanSide);

  if (store) {
    await setLatestScan(finalPayload);
  }

  return finalPayload;
}

// ================= HANDLER =================
export default async function handler(req, res) {
  try {
    const side = normalizeScanSide(req?.query?.side);
    const notify = normalizeNotify(req?.query?.notify);
    const store = normalizeStore(req?.query?.store, notify);

    const data = await buildScanPayload({
      side,
      notify,
      store
    });

    return res.status(200).json(data);
  } catch (e) {
    console.error("SCAN ERROR:", e);

    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}