import {
  fetchCoinGeckoTopCached,
  generateShallowOb,
  fetchFuturesTickers // 🔥 BITGET
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

  const ch24 = c.change24 || 0;
  const ch1 = c.change1h || 0;

  // 🐻 BEAR → focus shorts
  if(btc.state === "BEARISH"){

    if(ch24 < -3 && ch1 < -0.5) return "bear";

    // alleen extreme longs
    if(ch24 > 8 && ch1 > 1.5) return "bull";

    return "none";
  }

  // 🐂 BULL → focus longs
  if(btc.state === "BULLISH"){

    if(ch24 > 3 && ch1 > 0.5) return "bull";

    // beperkte shorts
    if(ch24 < -5 && ch1 < -1) return "bear";

    return "none";
  }

  return "none";
}


// ================= FLOW =================
function detectFlow(c){

  const ch1 = Math.abs(c.change1h || 0);
  const ch24 = Math.abs(c.change24 || 0);

  if(ch1 > 1 && ch24 > 5) return "TREND";
  if(ch1 > 0.6) return "BUILDING";
  if(ch24 > 3) return "EARLY";

  return "NEUTRAL";
}


// ================= SCORE =================
function calculateScore(c, regime){

  let score = 0;

  if(c.change24 > 8) score += 35;
  else if(c.change24 > 5) score += 25;
  else if(c.change24 > 2) score += 15;

  if(c.change1h > 1.2) score += 25;
  else if(c.change1h > 0.5) score += 15;

  if(c.vm > 0.5) score += 25;
  else if(c.vm > 0.3) score += 15;
  else if(c.vm > 0.15) score += 8;

  if(regime === "LOW_VOL") score -= 15;
  if(regime === "HIGH_VOL") score += 5;

  return Math.max(0, Math.min(score, 100));
}


// ================= CORE =================
export async function buildScanPayload(){

  initDefaultFilters();
  resetAnalytics();

  const rawCoins = await fetchCoinGeckoTopCached();
  if(!Array.isArray(rawCoins)) throw new Error("API error");

  // 🔥 BITGET FILTER
  const futures = await fetchFuturesTickers();
  const validSymbols = new Set(
    Array.from(futures.keys()).map(s => s.replace("USDT",""))
  );

  const btc = {
    state: rawCoins[0]?.price_change_percentage_24h > 0
      ? "BULLISH"
      : "BEARISH"
  };

  const regime = detectRegime(rawCoins) || "NORMAL";
  const market = classifyMarket(rawCoins);

  const funnel = {
    bull:{ entry:[], almost:[], buildup:[], radar:[] },
    bear:{ entry:[], almost:[], buildup:[], radar:[] }
  };

  const tradeCandidates = [];

  let memory = await loadStageMemory();
  const activeSymbols = [];

  for(const raw of rawCoins){

    const base = {
      symbol: raw.symbol?.toUpperCase(),
      price: raw.current_price,
      change24: raw.price_change_percentage_24h,
      change1h: raw.price_change_percentage_1h_in_currency,
      vm: raw.market_cap > 0 ? raw.total_volume / raw.market_cap : 0,
      ob: generateShallowOb()
    };

    if(!base.symbol || base.price <= 0) continue;

    // 🔥 BITGET ONLY
    if(!validSymbols.has(base.symbol)) continue;

    activeSymbols.push(base.symbol);

    const direction = decideDirection(base, btc);
    if(direction === "none") continue;

    // 🔥 QUALITY FILTER
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

    const key = base.symbol + "_" + direction;
    const prev = memory[key] || { stage:"radar" };

    const filterStage =
      direction === "bull"
        ? bullFilter(coin)
        : bearFilter(coin);

    if(!filterStage) continue;

    coin.stage = filterStage;

    funnel[direction][filterStage].push(coin);
    logAnalytics(coin);

    // 🔥 ONLY BEST TRADES
    if(
      filterStage === "entry" &&
      score > 75 &&
      flow === "TREND"
    ){
      tradeCandidates.push(coin);
    }
  }

  // ================= MEMORY =================
  memory = cleanMemory(memory, activeSymbols);
  await saveStageMemory(memory);

  // ================= SORT =================
  for(const side of ["bull","bear"]){
    for(const k in funnel[side]){
      funnel[side][k].sort((a,b)=>b.moveScore-a.moveScore);
    }
  }

  // ================= TRADES =================
  const trades = await processTrades(
    tradeCandidates,
    btc,
    "auto",
    regime
  );

  const analytics = getAnalytics();
  const advice = generateAdvice(analytics);

  const payload = {
    ok:true,
    btc,
    regime,
    market,
    funnel,
    trades,
    analytics,
    advice,
    total: rawCoins.length,
    candidates: tradeCandidates.length
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
      ok:false,
      error:e.message
    });
  }
}