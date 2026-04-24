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


// ================= GENERIC HELPERS =================
function safeArray(value){
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCounterMap(map){
  const out = {};

  for(const [key, value] of Object.entries(map || {})){
    const n = Math.round(Number(value || 0));

    if(n > 0){
      out[String(key)] = n;
    }
  }

  return out;
}

function emptyDashboardStats(now = Date.now()){
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

function normalizeDashboardStats(stats, now = Date.now()){
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
function normalizeScanSide(side){
  const s = String(side || "both").toLowerCase();

  if(s === "bull") return "bull";
  if(s === "bear") return "bear";

  return "both";
}


// ================= NOTIFY NORMALIZER =================
function normalizeNotify(value){
  const v = String(value || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}


// ================= STORE NORMALIZER =================
function normalizeStore(value, fallback = true){
  if(value === undefined || value === null){
    return fallback;
  }

  const v = String(value || "").toLowerCase();

  if(v === "false" || v === "0" || v === "no"){
    return false;
  }

  if(v === "true" || v === "1" || v === "yes"){
    return true;
  }

  return fallback;
}


// ================= STAGE SAFETY =================
function safeStage(stage){
  return STAGES.includes(stage)
    ? stage
    : "radar";
}


// ================= DISPLAY LOGIC FOR UI/FUNNEL =================
function displayDirectionAllowed(c, side){
  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);
  const vm = Number(c.vm || 0);

  if(side === "bull"){
    return (
      ch24 > 0.15 ||
      ch1 > 0.02 ||
      (vm > 0.03 && ch24 > 0)
    );
  }

  if(side === "bear"){
    return (
      ch24 < -0.15 ||
      ch1 < -0.02 ||
      (vm > 0.03 && ch24 < 0)
    );
  }

  return false;
}


// ================= FLOW =================
function detectFlow(c){
  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));

  if(ch1 > 0.55 && ch24 > 2.2) return "TREND";
  if(ch1 > 0.18 || ch24 > 0.9) return "BUILDING";
  if(ch24 > 0.6) return "EARLY";

  return "NEUTRAL";
}


// ================= FRESHNESS =================
function calculateFreshness(c, side){
  const dir = side === "bear" ? -1 : 1;

  const ch24 = Math.max(0, Number(c.change24 || 0) * dir);
  const ch1 = Math.max(0, Number(c.change1h || 0) * dir);

  let freshness = 0;

  if(ch1 > 1.5) freshness += 18;
  else if(ch1 > 0.9) freshness += 13;
  else if(ch1 > 0.45) freshness += 9;
  else if(ch1 > 0.2) freshness += 5;

  if(ch24 > 0){
    const ratio = ch1 / Math.max(ch24, 0.01);

    if(ratio > 0.45) freshness += 8;
    else if(ratio > 0.25) freshness += 5;
    else if(ratio > 0.12) freshness += 2;
  }

  if(ch24 > 8 && ch1 < 0.25) freshness -= 8;
  if(ch24 > 12 && ch1 < 0.10) freshness -= 10;

  return Math.max(0, Math.min(freshness, 30));
}


// ================= DIRECTIONAL SCORE =================
function calculateScore(c, regime, side){
  let score = 0;

  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(c.change24 || 0) * dir;
  const ch1 = Number(c.change1h || 0) * dir;
  const vm = Number(c.vm || 0);
  const freshness = calculateFreshness(c, side);

  if(ch24 > 10) score += 22;
  else if(ch24 > 6) score += 16;
  else if(ch24 > 3) score += 10;
  else if(ch24 > 1) score += 5;
  else if(ch24 > 0.25) score += 2;

  if(ch1 > 2) score += 32;
  else if(ch1 > 1.1) score += 24;
  else if(ch1 > 0.55) score += 15;
  else if(ch1 > 0.2) score += 7;
  else if(ch1 > 0.03) score += 3;

  if(vm > 0.40) score += 20;
  else if(vm > 0.20) score += 12;
  else if(vm > 0.10) score += 7;
  else if(vm > 0.04) score += 3;

  score += freshness;

  if(regime === "LOW_VOL") score -= 8;
  if(regime === "HIGH_VOL") score += 4;

  return Math.max(0, Math.min(score, 100));
}


// ================= UI FALLBACK STAGE =================
function fallbackStage(score, flow, freshness = 0){
  if(flow === "TREND" && score >= 74) return "entry";
  if(flow === "TREND" && score >= 60) return "almost";
  if(flow === "TREND" && score >= 44) return "buildup";
  if(flow === "BUILDING" && score >= 28) return "buildup";
  if(flow === "BUILDING" && freshness >= 6) return "radar";
  if(flow === "EARLY" && score >= 18) return "radar";

  return "radar";
}


// ================= STAGE MERGE =================
function mergeStage(prevStage, filterStage){
  const order = ["radar", "buildup", "almost", "entry"];

  const prevIndex = order.indexOf(prevStage || "radar");
  const newIndex = order.indexOf(filterStage || "radar");

  if(newIndex >= prevIndex){
    return filterStage;
  }

  return order[Math.max(0, prevIndex - 1)];
}


// ================= SYMBOL NORMALIZER =================
function normalizeBitgetKey(symbolKey){
  return String(symbolKey || "")
    .toUpperCase()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "");
}

// ================= NIEUWE HELPER: EXCHANGE SYMBOL MAP =================
function buildExchangeSymbolMap(futures){
  const out = new Map();

  for(const key of Array.from(futures.keys())){
    const normalized = normalizeBitgetKey(key);

    if(!normalized) continue;
    if(!out.has(normalized)){
      out.set(normalized, String(key));
    }
  }

  return out;
}

// ================= NORMALIZE =================
function normalize(raw){
  const marketCap = Number(raw?.market_cap || 0);
  const totalVolume = Number(raw?.total_volume || 0);

  return {
    symbol: String(raw?.symbol || "").toUpperCase(),
    name: raw?.name || "",
    price: Number(raw?.current_price || 0),
    change24: Number(raw?.price_change_percentage_24h || 0),
    change1h: Number(raw?.price_change_percentage_1h_in_currency || 0),
    volume: totalVolume,
    marketCap,
    vm: marketCap > 0 ? totalVolume / marketCap : 0,
    ob: generateShallowOb()
  };
}

function buildCoinTimeframeMeta(coin){
  try{
    const ctx = buildTimeframeContext(coin) || {};
    const score = Number.isFinite(Number(ctx?.score))
      ? Number(ctx.score)
      : 0;

    return {
      tfContext: ctx,
      tfScore: score,
      tfStrength: Math.abs(score),
      tfAlignment: String(ctx?.alignment || "UNKNOWN")
    };
  }catch{
    return {
      tfContext: {},
      tfScore: 0,
      tfStrength: 0,
      tfAlignment: "UNKNOWN"
    };
  }
}


// ================= EMPTY FUNNEL =================
function emptyFunnel(){
  return {
    bull: { entry: [], almost: [], buildup: [], radar: [] },
    bear: { entry: [], almost: [], buildup: [], radar: [] }
  };
}


// ================= COUNT HELPERS =================
function countSide(funnel, side){
  if(!funnel?.[side]) return 0;

  let total = 0;

  for(const stage of STAGES){
    total += Array.isArray(funnel[side][stage])
      ? funnel[side][stage].length
      : 0;
  }

  return total;
}

function countFunnel(funnel){
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}

function hasSymbolInSide(funnel, side, symbol){
  for(const stage of STAGES){
    if(
      Array.isArray(funnel?.[side]?.[stage]) &&
      funnel[side][stage].some(c => c.symbol === symbol)
    ){
      return true;
    }
  }

  return false;
}

function sortFunnel(funnel){
  for(const side of ["bull", "bear"]){
    for(const stageKey of STAGES){
      funnel[side][stageKey].sort((a, b) => {
        return Number(b.moveScore || 0) - Number(a.moveScore || 0);
      });
    }
  }
}


// ================= UI FALLBACK FILL =================
function fillUiFallback({
  rawCoins,
  regime,
  funnel,
  side,
  validSymbols,
  max = 30
}){
  const targetMinimum = 12;

  if(countSide(funnel, side) >= targetMinimum) return;

  const list = [];

  for(const raw of rawCoins){
    const base = normalize(raw);

    if(!base.symbol || base.price <= 0) continue;
    if(!validSymbols.has(base.symbol)) continue;
    if(hasSymbolInSide(funnel, side, base.symbol)) continue;
    if(base.vm < 0.02) continue;

    const ch24 = Number(base.change24 || 0);
    const ch1 = Number(base.change1h || 0);

    if(side === "bull" && ch24 <= 0 && ch1 <= 0) continue;
    if(side === "bear" && ch24 >= 0 && ch1 >= 0) continue;

    const flow = detectFlow(base);
    const score = calculateScore(base, regime, side);
    const edge = calculateEdge(base, regime) || 0;
    const freshness = calculateFreshness(base, side);
    const tfMeta = buildCoinTimeframeMeta({
      ...base,
      side,
      flow,
      moveScore: score,
      freshness,
      edge
    });

    if(score < 6) continue;

    list.push({
      ...base,
      side,
      flow,
      freshness,
      moveScore: score,
      edge,
      stage: fallbackStage(score, flow, freshness),
      stageSource: "ui_fallback",
      uiOnly: true,
      symbolTradable: true,
      tfContext: tfMeta.tfContext,
      tfScore: tfMeta.tfScore,
      tfStrength: tfMeta.tfStrength,
      tfAlignment: tfMeta.tfAlignment
    });
  }

  list.sort((a, b) => Number(b.moveScore || 0) - Number(a.moveScore || 0));

  let added = 0;
  let entrySeeded = funnel[side].entry.length > 0;

  for(const coin of list){
    if(added >= max) break;
    if(countSide(funnel, side) >= targetMinimum) break;

    let stage = safeStage(coin.stage);

    if(!entrySeeded){
      stage = "entry";
      entrySeeded = true;
    }

    funnel[side][stage].push({
      ...coin,
      stage
    });

    added++;
  }
}


// ================= MERGE PARTIAL SIDE SCAN =================
async function mergeWithPreviousSideScan(currentPayload, scanSide){
  if(scanSide === "both"){
    return currentPayload;
  }

  const previous = await getLatestScan();

  if(!previous?.ok){
    return currentPayload;
  }

  const mergedFunnel = emptyFunnel();

  mergedFunnel[scanSide] =
    currentPayload.funnel?.[scanSide] || mergedFunnel[scanSide];

  const otherSide = scanSide === "bull" ? "bear" : "bull";

  mergedFunnel[otherSide] =
    previous.funnel?.[otherSide] || mergedFunnel[otherSide];

  const mergedAnalytics = {
    ...(previous.analytics || {}),
    [scanSide]: currentPayload.analytics?.[scanSide]
  };

  const mergedAdvice = {
    ...(previous.advice || {}),
    [scanSide]: currentPayload.advice?.[scanSide]
  };

  const candidatesBull =
    scanSide === "bull"
      ? currentPayload.candidatesBull
      : previous.candidatesBull || 0;

  const candidatesBear =
    scanSide === "bear"
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
    lastBullScan:
      scanSide === "bull"
        ? Date.now()
        : previous.lastBullScan || null,
    lastBearScan:
      scanSide === "bear"
        ? Date.now()
        : previous.lastBearScan || null,
    lastSideScan: scanSide,
    scanMode: "merged",
    updatedAt: Date.now()
  };
}


// ================= BITGET FAILURE HANDLER =================
async function handleBitgetUniverseUnavailable(scanSide){
  const previous = await getLatestScan();

  if(previous?.ok){
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


// ================= CORE =================
export async function buildScanPayload(options = {}){
  const scanSide = normalizeScanSide(options.side);
  const notify = options.notify !== false;
  const store = options.store !== false;

  initDefaultFilters(true);
  resetAnalytics();

  const previousLatest = await getLatestScan().catch(() => null);

  const rawCoins = await fetchCoinGeckoTopCached();
  if(!Array.isArray(rawCoins)) throw new Error("API error");

  let futures = new Map();

  try{
    futures = await fetchFuturesTickers();
  }catch(e){
    console.error("BITGET FILTER ERROR:", e.message);
  }

  const validSymbols = new Set(
    Array.from(futures.keys())
      .map(normalizeBitgetKey)
      .filter(Boolean)
  );

  // NIEUW: map van genormaliseerd symbool naar exacte Bitget futures symbool
  const exchangeSymbolMap = buildExchangeSymbolMap(futures);

  const bitgetUniverseReady = validSymbols.size > 0;

  if(!bitgetUniverseReady){
    return await handleBitgetUniverseUnavailable(scanSide);
  }

  const btcRaw =
    rawCoins.find(c => String(c?.symbol || "").toUpperCase() === "BTC") ||
    rawCoins[0];

  const btc = {
    state: Number(btcRaw?.price_change_percentage_24h || 0) >= 0
      ? "BULLISH"
      : "BEARISH",
    chg24: Number(btcRaw?.price_change_percentage_24h || 0)
  };

  const regime = detectRegime(rawCoins) || "NORMAL";
  const market = classifyMarket(rawCoins);

  const funnel = emptyFunnel();

  let candidatesBull = 0;
  let candidatesBear = 0;

  let memory = await loadStageMemory();
  const activeSymbols = [];

  const sidesToScan =
    scanSide === "both"
      ? ["bull", "bear"]
      : [scanSide];

  for(const raw of rawCoins){
    const base = normalize(raw);

    if(!base.symbol || base.price <= 0) continue;

    const symbolTradable = validSymbols.has(base.symbol);

    if(!symbolTradable){
      continue;
    }

    activeSymbols.push(base.symbol);

    if(base.vm < 0.02) continue;

    if(
      Math.abs(base.change24) < 0.2 &&
      Math.abs(base.change1h) < 0.02
    ){
      continue;
    }

    for(const direction of sidesToScan){
      if(!displayDirectionAllowed(base, direction)) continue;

      const flow = detectFlow(base);
      const score = calculateScore(base, regime, direction);
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

      // NIEUW: voeg exchangeSymbol en marketSymbol toe
      const coin = {
        ...base,
        side: direction,
        flow,
        freshness,
        moveScore: score,
        edge,
        symbolTradable: true,
        exchangeSymbol: exchangeSymbolMap.get(base.symbol) || `${base.symbol}USDT`,
        marketSymbol: exchangeSymbolMap.get(base.symbol) || `${base.symbol}USDT`,
        tfContext: tfMeta.tfContext,
        tfScore: tfMeta.tfScore,
        tfStrength: tfMeta.tfStrength,
        tfAlignment: tfMeta.tfAlignment
      };

      const key = `${base.symbol}_${direction}`;
      const prev = memory[key] || { stage: "radar" };

      const realFilterStage =
        direction === "bull"
          ? bullFilter(coin)
          : bearFilter(coin);

      const uiStage = realFilterStage || fallbackStage(score, flow, freshness);

      const newStage = safeStage(
        realFilterStage
          ? mergeStage(prev.stage, realFilterStage)
          : uiStage
      );

      coin.stage = newStage;
      coin.stageSource = realFilterStage ? "filter" : "fallback";
      coin.uiOnly = !realFilterStage;

      funnel[direction][newStage].push(coin);

      if(!coin.uiOnly && coin.stageSource === "filter"){
        logAnalytics(coin);
      }

      if(realFilterStage === "entry"){
        if(direction === "bull") candidatesBull++;
        if(direction === "bear") candidatesBear++;
      }

      memory[key] = {
        stage: newStage,
        prevStage: prev.stage || "radar"
      };
    }
  }

  if(scanSide === "both" || scanSide === "bull"){
    fillUiFallback({
      rawCoins,
      regime,
      funnel,
      side: "bull",
      validSymbols,
      max: 30
    });
  }

  if(scanSide === "both" || scanSide === "bear"){
    fillUiFallback({
      rawCoins,
      regime,
      funnel,
      side: "bear",
      validSymbols,
      max: 30
    });
  }

  memory = cleanMemory(memory, activeSymbols);

  if(store){
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

    btc,
    regime,
    market,

    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),

    // scanner bewaart trade-funnel output, maar runt hem niet zelf
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

  const finalPayload = await mergeWithPreviousSideScan(
    currentPayload,
    scanSide
  );

  if(store){
    await setLatestScan(finalPayload);
  }

  return finalPayload;
}


// ================= HANDLER =================
export default async function handler(req, res){
  try{
    const side = normalizeScanSide(req?.query?.side);
    const notify = normalizeNotify(req?.query?.notify);
    const store = normalizeStore(req?.query?.store, notify);

    const data = await buildScanPayload({
      side,
      notify,
      store
    });

    return res.status(200).json(data);

  }catch(e){
    console.error("SCAN ERROR:", e);

    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}