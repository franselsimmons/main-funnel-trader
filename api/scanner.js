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


// ================= SCORE =================
function calculateScore(c, regime){

  let score = 0;

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);

  if(ch24 > 8) score += 30;
  else if(ch24 > 4) score += 20;
  else if(ch24 > 2) score += 10;

  if(ch1 > 1) score += 20;
  else if(ch1 > 0.5) score += 10;

  if(c.vm > 0.5) score += 25;
  else if(c.vm > 0.3) score += 15;
  else if(c.vm > 0.15) score += 8;

  if(regime === "LOW_VOL") score -= 10;
  if(regime === "HIGH_VOL") score += 5;

  return Math.max(0, Math.min(score, 100));
}


// ================= FLOW =================
function detectFlow(c){

  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));

  if(ch1 > 1.2 && ch24 > 6) return "TREND";
  if(ch1 > 0.6) return "BUILDING";
  if(ch24 > 2) return "EARLY";

  return "NEUTRAL";
}


// ================= NORMALIZE =================
function normalize(raw){

  const mc = Number(raw?.market_cap || 0);
  const vol = Number(raw?.total_volume || 0);

  return {
    symbol: String(raw?.symbol || "").toUpperCase(),
    name: raw?.name || "",
    price: Number(raw?.current_price || 0),
    change24: Number(raw?.price_change_percentage_24h || 0),
    change1h: Number(raw?.price_change_percentage_1h_in_currency || 0),
    volume: vol,
    marketCap: mc,
    vm: mc > 0 ? vol / mc : 0,
    ob: generateShallowOb()
  };
}


// ================= CORE BUILDER =================
export async function buildScanPayload(){

  resetAnalytics();

  const rawCoins = await fetchCoinGeckoTopCached();
  if(!Array.isArray(rawCoins)) throw new Error("API error");

  const btc = {
    state: rawCoins[0]?.price_change_percentage_24h > 0 ? "BULLISH" : "BEARISH"
  };

  const regime = detectRegime(rawCoins) || "NORMAL";
  const market = classifyMarket(rawCoins);

  const funnel = {
    bull:{ candidate:[], almost:[], buildup:[], radar:[] },
    bear:{ candidate:[], almost:[], buildup:[], radar:[] }
  };

  const tradeCandidates = [];

  for(const raw of rawCoins){

    const base = normalize(raw);
    if(!base.symbol || base.price <= 0) continue;

    const flow = detectFlow(base);
    const score = calculateScore(base, regime);

    const edge = calculateEdge(base, regime) || 0;

    // ===== BULL =====
    const bull = {
      ...base,
      side:"bull",
      flow,
      moveScore: score,
      edge
    };

    if(score > 80){
      bull.stage = "candidate";
      funnel.bull.candidate.push(bull);
      tradeCandidates.push(bull);
    }
    else if(score > 65){
      bull.stage = "almost";
      funnel.bull.almost.push(bull);
    }
    else if(score > 50){
      bull.stage = "buildup";
      funnel.bull.buildup.push(bull);
    }
    else{
      bull.stage = "radar";
      funnel.bull.radar.push(bull);
    }

    logAnalytics(bull);

    // ===== BEAR =====
    const bear = {
      ...base,
      side:"bear",
      flow,
      moveScore: score,
      edge
    };

    if(score > 80){
      bear.stage = "candidate";
      funnel.bear.candidate.push(bear);
      tradeCandidates.push(bear);
    }
    else if(score > 65){
      bear.stage = "almost";
      funnel.bear.almost.push(bear);
    }
    else if(score > 50){
      bear.stage = "buildup";
      funnel.bear.buildup.push(bear);
    }
    else{
      bear.stage = "radar";
      funnel.bear.radar.push(bear);
    }

    logAnalytics(bear);
  }

  // SORT
  for(const side of ["bull","bear"]){
    for(const k in funnel[side]){
      funnel[side][k].sort((a,b)=>b.moveScore-a.moveScore);
    }
  }

  const trades = await processTrades(tradeCandidates, btc, "auto", regime);

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


// ================= API HANDLER =================
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