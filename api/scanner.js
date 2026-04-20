import {
  fetchCoinGeckoTopCached,
  generateShallowOb,
  fetchFuturesTickers
} from "../lib/_main_shared.js";

import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";
import { processTrades } from "../lib/tradeSystem.js";
import { setLatestScan } from "../lib/scanStore.js";

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


// ================= BTC LOGIC =================
function decideDirection(c, btc){

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);

  if(btc.state === "BEARISH"){

    if(ch24 < -3 && ch1 < -0.5) return "bear";

    if(ch24 > 8 && ch1 > 1.5) return "bull";

    return "none";
  }

  if(btc.state === "BULLISH"){

    if(ch24 > 3 && ch1 > 0.5) return "bull";

    if(ch24 < -5 && ch1 < -1) return "bear";

    return "none";
  }

  return "none";
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


// ================= SCORE =================
function calculateScore(c, regime){

  let score = 0;

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);
  const vm = Number(c.vm || 0);

  if(ch24 > 8) score += 35;
  else if(ch24 > 5) score += 25;
  else if(ch24 > 2) score += 15;

  if(ch1 > 1.2) score += 25;
  else if(ch1 > 0.5) score += 15;

  if(vm > 0.5) score += 25;
  else if(vm > 0.3) score += 15;
  else if(vm > 0.15) score += 8;

  if(regime === "LOW_VOL") score -= 15;
  if(regime === "HIGH_VOL") score += 5;

  return Math.max(0, Math.min(score, 100));
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


// ================= CORE =================
export async function buildScanPayload(){

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

  const btc = {
    state: rawCoins[0]?.price_change_percentage_24h > 0
      ? "BULLISH"
      : "BEARISH"
  };

  const regime = detectRegime(rawCoins) || "NORMAL";
  const market = classifyMarket(rawCoins);

  const funnel = {
    bull: { entry: [], almost: [], buildup: [], radar: [] },
    bear: { entry: [], almost: [], buildup: [], radar: [] }
  };

  const tradeCandidates = [];

  let memory = await loadStageMemory();
  const activeSymbols = [];

  for(const raw of rawCoins){

    const symbol = String(raw?.symbol || "").toUpperCase();
    const marketCap = Number(raw?.market_cap || 0);
    const totalVolume = Number(raw?.total_volume || 0);

    const base = {
      symbol,
      price: Number(raw?.current_price || 0),
      change24: Number(raw?.price_change_percentage_24h || 0),
      change1h: Number(raw?.price_change_percentage_1h_in_currency || 0),
      vm: marketCap > 0 ? totalVolume / marketCap : 0,
      ob: generateShallowOb()
    };

    if(!base.symbol || base.price <= 0) continue;

    if(validSymbols.size > 0 && !validSymbols.has(base.symbol)) continue;

    activeSymbols.push(base.symbol);

    const direction = decideDirection(base, btc);
    if(direction === "none") continue;

    if(base.vm < 0.12) continue;
    if(Math.abs(base.change24) < 3) continue;

    const flow = detectFlow(base);
    const score = calculateScore(base, regime);
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

    coin.stage = filterStage;

    funnel[direction][filterStage].push(coin);
    logAnalytics(coin);

    if(
      filterStage === "entry" &&
      score > 75 &&
      flow === "TREND"
    ){
      tradeCandidates.push(coin);
    }

    memory[key] = {
      stage: filterStage,
      prevStage: prev.stage || "radar"
    };
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
    regime
  );

  const analytics = getAnalytics();
  const advice = generateAdvice(analytics);

  const payload = {
    ok: true,
    btc,
    regime,
    market,
    funnel,
    trades,
    analytics,
    advice,
    total: rawCoins.length,
    candidates: tradeCandidates.length,
    bitgetSymbols: validSymbols.size
  };

  setLatestScan(payload);

  return payload;
}


// ================= HANDLER =================
export default async function handler(req,res){
  try{
    const data = await buildScanPayload();
    return res.status(200).json(data);
  }catch(e){
    console.error("SCAN ERROR:", e);
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}