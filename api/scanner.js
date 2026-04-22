import {
  fetchCoinGeckoTopCached,
  generateShallowOb,
  fetchFuturesTickers
} from "../lib/_main_shared.js";

import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";
import { processTrades } from "../lib/tradeSystem.js";
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


// ================= SIDE LOGIC =================
function directionAllowed(c, btc, side){

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);

  // ================= BULL SCAN =================
  if(side === "bull"){

    // BTC bullish → normale longs
    if(btc.state === "BULLISH"){
      return ch24 > 3 && ch1 > 0.5;
    }

    // BTC bearish → alleen sterke longs tegen trend
    if(btc.state === "BEARISH"){
      return ch24 > 8 && ch1 > 1.5;
    }

    return false;
  }

  // ================= BEAR SCAN =================
  if(side === "bear"){

    // BTC bearish → normale shorts
    if(btc.state === "BEARISH"){
      return ch24 < -3 && ch1 < -0.5;
    }

    // BTC bullish → alleen sterke shorts tegen trend
    if(btc.state === "BULLISH"){
      return ch24 < -5 && ch1 < -1;
    }

    return false;
  }

  return false;
}


// ================= FLOW =================
function detectFlow(c){

  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));

  if(ch1 > 1 && ch24 > 5) return "TREND";
  if(ch1 > 0.6) return "BUILDING";
  if(ch24 > 3) return "EARLY";

  return "NEUTRAL";
}


// ================= DIRECTIONAL SCORE =================
function calculateScore(c, regime, side){

  let score = 0;

  const dir = side === "bear" ? -1 : 1;

  const ch24 = Number(c.change24 || 0) * dir;
  const ch1 = Number(c.change1h || 0) * dir;
  const vm = Number(c.vm || 0);

  // momentum richting trade
  if(ch24 > 8) score += 35;
  else if(ch24 > 5) score += 25;
  else if(ch24 > 2) score += 15;

  if(ch1 > 1.2) score += 25;
  else if(ch1 > 0.5) score += 15;

  // volume / marketcap
  if(vm > 0.5) score += 25;
  else if(vm > 0.3) score += 15;
  else if(vm > 0.15) score += 8;

  if(regime === "LOW_VOL") score -= 15;
  if(regime === "HIGH_VOL") score += 5;

  return Math.max(0, Math.min(score, 100));
}


// ================= STAGE MERGE =================
function mergeStage(prevStage, filterStage){

  const order = ["radar", "buildup", "almost", "entry"];

  const prevIndex = order.indexOf(prevStage || "radar");
  const newIndex = order.indexOf(filterStage || "radar");

  if(newIndex >= prevIndex){
    return filterStage;
  }

  // zachte decay omlaag
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


// ================= EMPTY FUNNEL =================
function emptyFunnel(){
  return {
    bull: { entry: [], almost: [], buildup: [], radar: [] },
    bear: { entry: [], almost: [], buildup: [], radar: [] }
  };
}


// ================= MERGE PARTIAL SIDE SCAN =================
function mergeWithPreviousSideScan(currentPayload, scanSide){

  if(scanSide === "both"){
    return currentPayload;
  }

  const previous = getLatestScan();

  if(!previous?.ok){
    return currentPayload;
  }

  const mergedFunnel = emptyFunnel();

  // huidige kant vervangen
  mergedFunnel[scanSide] =
    currentPayload.funnel?.[scanSide] || mergedFunnel[scanSide];

  // andere kant behouden
  const otherSide = scanSide === "bull" ? "bear" : "bull";

  mergedFunnel[otherSide] =
    previous.funnel?.[otherSide] || mergedFunnel[otherSide];

  const currentTrades = Array.isArray(currentPayload.trades)
    ? currentPayload.trades
    : [];

  const previousTrades = Array.isArray(previous.trades)
    ? previous.trades
    : [];

  const otherSideTrades = previousTrades.filter(t => t.side === otherSide);

  const mergedTrades = [...currentTrades, ...otherSideTrades]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

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

  return {
    ...previous,
    ...currentPayload,
    funnel: mergedFunnel,
    trades: mergedTrades,
    analytics: mergedAnalytics,
    advice: mergedAdvice,
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


// ================= CORE =================
export async function buildScanPayload(options = {}){

  const scanSide = normalizeScanSide(options.side);

  // Standaard notify=true voor cron/backend.
  // public-latest moet expliciet notify:false meegeven.
  const notify = options.notify !== false;

  initDefaultFilters();
  resetAnalytics();

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
  const tradeCandidates = [];

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

    // Bitget only, maar fallback als Bitget fetch faalt
    if(validSymbols.size > 0 && !validSymbols.has(base.symbol)) continue;

    activeSymbols.push(base.symbol);

    // Ruim genoeg voor scanner, tradeSystem bewaakt kwaliteit.
    if(base.vm < 0.10) continue;
    if(Math.abs(base.change24) < 2.5) continue;

    for(const direction of sidesToScan){

      if(!directionAllowed(base, btc, direction)) continue;

      const flow = detectFlow(base);
      const score = calculateScore(base, regime, direction);
      const edge = calculateEdge(base, regime) || 0;

      const coin = {
        ...base,
        side: direction,
        flow,
        moveScore: score,
        edge
      };

      const key = `${base.symbol}_${direction}`;
      const prev = memory[key] || { stage: "radar" };

      const filterStage =
        direction === "bull"
          ? bullFilter(coin)
          : bearFilter(coin);

      if(!filterStage) continue;

      const newStage = mergeStage(prev.stage, filterStage);

      coin.stage = newStage;

      funnel[direction][newStage].push(coin);
      logAnalytics(coin);

      // ================= QUALITY MODE =================
      // Minder trades, hogere kwaliteit:
      // - entry vanaf score 75
      // - almost alleen elite vanaf score 88
      if(
        (
          newStage === "entry" &&
          score >= 75 &&
          flow === "TREND"
        ) ||
        (
          newStage === "almost" &&
          score >= 88 &&
          flow === "TREND"
        )
      ){
        tradeCandidates.push(coin);

        if(direction === "bull") candidatesBull++;
        if(direction === "bear") candidatesBear++;
      }

      memory[key] = {
        stage: newStage,
        prevStage: prev.stage || "radar"
      };
    }
  }

  memory = cleanMemory(memory, activeSymbols);
  await saveStageMemory(memory);

  for(const side of ["bull", "bear"]){
    for(const stageKey of Object.keys(funnel[side])){
      funnel[side][stageKey].sort((a, b) => b.moveScore - a.moveScore);
    }
  }

  const trades = await processTrades(
    tradeCandidates,
    btc,
    "auto",
    regime,
    { notify }
  );

  const analytics = getAnalytics();
  const advice = generateAdvice(analytics);

  const now = Date.now();

  const currentPayload = {
    ok: true,
    scanSide,
    scanMode: scanSide,
    notify,
    btc,
    regime,
    market,
    funnel,
    trades,
    analytics,
    advice,
    total: rawCoins.length,
    candidates: tradeCandidates.length,
    candidatesBull,
    candidatesBear,
    bitgetSymbols: validSymbols.size,
    updatedAt: now,
    lastBullScan: scanSide === "bull" || scanSide === "both" ? now : null,
    lastBearScan: scanSide === "bear" || scanSide === "both" ? now : null
  };

  const finalPayload = mergeWithPreviousSideScan(currentPayload, scanSide);

  setLatestScan(finalPayload);

  return finalPayload;
}


// ================= HANDLER =================
export default async function handler(req,res){

  try{
    const side = normalizeScanSide(req?.query?.side);

    // Direct /api/scanner is standaard STIL.
    // Alleen met ?notify=true stuurt hij Discord.
    const notify = normalizeNotify(req?.query?.notify);

    const data = await buildScanPayload({
      side,
      notify
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