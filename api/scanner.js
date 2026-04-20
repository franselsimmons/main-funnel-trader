import {
  fetchCoinGeckoTopCached,
  generateShallowOb
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


// 🔥 FIXED BTC LOGIC
function decideDirection(c, btc, regime){

  const ch24 = c.change24 || 0;
  const ch1 = c.change1h || 0;

  // BEAR MARKET → ONLY SHORTS (plus elite longs)
  if(btc.state === "BEARISH"){

    if(ch24 < -3 && ch1 < -0.5) return "bear";

    // alleen extreme longs
    if(ch24 > 8 && ch1 > 1.5) return "bull";

    return "none";
  }

  // BULL MARKET
  if(btc.state === "BULLISH"){

    if(ch24 > 3 && ch1 > 0.5) return "bull";
    if(ch24 < -5 && ch1 < -1) return "bear";

    return "none";
  }

  return "none";
}


// ================= CORE =================
export async function buildScanPayload(){

  initDefaultFilters();
  resetAnalytics();

  const rawCoins = await fetchCoinGeckoTopCached();

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
      vm: raw.total_volume / raw.market_cap,
      ob: generateShallowOb()
    };

    if(!base.symbol || base.price <= 0) continue;

    activeSymbols.push(base.symbol);

    const direction = decideDirection(base, btc, regime);
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

    if(filterStage === "entry" && score > 75 && flow === "TREND"){
      tradeCandidates.push(coin);
    }
  }

  memory = cleanMemory(memory, activeSymbols);
  await saveStageMemory(memory);

  const trades = await processTrades(tradeCandidates, btc, "auto", regime);

  const payload = {
    ok:true,
    btc,
    regime,
    market,
    funnel,
    trades,
    total: rawCoins.length,
    candidates: tradeCandidates.length
  };

  setLatestScan(payload);

  return payload;
}

export default async function handler(req,res){
  try{
    const data = await buildScanPayload();
    return res.status(200).json(data);
  }catch(e){
    return res.status(500).json({ ok:false, error:e.message });
  }
}