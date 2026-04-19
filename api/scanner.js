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


// ================= DIRECTION =================
function decideDirection(c){

  if(c.change24 > 3 && c.change1h > 0.5) return "bull";
  if(c.change24 < -3 && c.change1h < -0.5) return "bear";

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


// ================= STAGE MERGE =================
function mergeStage(prevStage, filterStage){

  const order = ["radar","buildup","almost","entry"];

  const prevIndex = order.indexOf(prevStage || "radar");
  const newIndex = order.indexOf(filterStage);

  // 🔥 alleen omhoog of klein beetje omlaag
  if(newIndex >= prevIndex){
    return filterStage;
  }

  // zachte decay
  return order[Math.max(0, prevIndex - 1)];
}


// ================= NORMALIZE =================
function normalize(raw){

  const mc = Number(raw.market_cap || 0);
  const vol = Number(raw.total_volume || 0);

  return {
    symbol: raw.symbol.toUpperCase(),
    name: raw.name,
    price: Number(raw.current_price || 0),
    change24: Number(raw.price_change_percentage_24h || 0),
    change1h: Number(raw.price_change_percentage_1h_in_currency || 0),
    volume: vol,
    marketCap: mc,
    vm: mc > 0 ? vol / mc : 0,
    ob: generateShallowOb()
  };
}


// ================= CORE =================
export async function buildScanPayload(){

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

    const base = normalize(raw);
    if(!base.symbol || base.price <= 0) continue;

    activeSymbols.push(base.symbol);

    const direction = decideDirection(base);
    if(direction === "none") continue;

    // 🔥 pre filter
    if(base.vm < 0.1) continue;
    if(Math.abs(base.change24) < 2) continue;

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

    const newStage = mergeStage(prev.stage, filterStage);

    memory[key] = { stage:newStage };

    coin.stage = newStage;

    funnel[direction][newStage].push(coin);
    logAnalytics(coin);

    if(newStage === "entry" && score > 70 && flow === "TREND"){
      tradeCandidates.push(coin);
    }
  }

  memory = cleanMemory(memory, activeSymbols);
  await saveStageMemory(memory);

  for(const side of ["bull","bear"]){
    for(const k in funnel[side]){
      funnel[side][k].sort((a,b)=>b.moveScore-a.moveScore);
    }
  }

  const trades = await processTrades(tradeCandidates, btc, "auto", regime);

  const payload = {
    ok:true,
    btc,
    regime,
    market,
    funnel,
    trades,
    analytics: getAnalytics(),
    advice: generateAdvice(getAnalytics()),
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
    return res.status(500).json({ ok:false, error:e.message });
  }
}