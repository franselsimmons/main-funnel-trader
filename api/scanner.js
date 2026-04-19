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


// ================= MEMORY =================
const memory = new Map();

const STAGE_SCORE = {
  RADAR: 1,
  BUILDUP: 2,
  ALMOST: 3,
  CANDIDATE: 4
};

function normalizeStage(stage){
  if(!stage) return "RADAR";
  if(stage === "ENTRY") return "CANDIDATE";
  return stage;
}

function resolveStage(prev, next){

  if(!prev) return "RADAR";

  const p = STAGE_SCORE[prev] || 1;
  const n = STAGE_SCORE[next] || 1;

  // alleen omhoog
  if(n > p) return next;

  // reset bij zwakte
  if(n < p) return "RADAR";

  return prev;
}


// ================= SCORE =================
function calculateScore(c, regime){

  let score = 0;

  const ch24 = Number(c.change24 || 0);
  const ch1 = Number(c.change1h || 0);

  if(ch24 > 6) score += 30;
  else if(ch24 > 3) score += 20;
  else if(ch24 > 1) score += 10;

  if(ch1 > 1) score += 20;
  else if(ch1 > 0.3) score += 10;

  if(c.vm > 0.4) score += 25;
  else if(c.vm > 0.2) score += 15;
  else if(c.vm > 0.1) score += 8;

  if(regime === "LOW_VOL") score -= 10;
  if(regime === "HIGH_VOL") score += 5;

  return Math.max(0, Math.min(score, 100));
}


// ================= FLOW =================
function detectFlow(c){

  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));

  if(ch1 > 1 && ch24 > 4) return "TREND";
  if(ch1 > 0.5) return "BUILDING";
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


// ================= CORE =================
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
    const bullBase = {
      ...base,
      side:"bull",
      flow,
      moveScore: score,
      edge
    };

    let bullStageRaw = normalizeStage(bullFilter(bullBase));
    const bullKey = base.symbol + "_bull";

    const bullStage = resolveStage(
      memory.get(bullKey),
      bullStageRaw
    );

    memory.set(bullKey, bullStage);

    const bull = { ...bullBase, stage: bullStage };

    funnel.bull[bullStage.toLowerCase()].push(bull);
    logAnalytics(bull);

    if(bullStage === "candidate" || bullStage === "almost"){
      tradeCandidates.push(bull);
    }


    // ===== BEAR =====
    const bearBase = {
      ...base,
      side:"bear",
      flow,
      moveScore: score,
      edge
    };

    let bearStageRaw = normalizeStage(bearFilter(bearBase));
    const bearKey = base.symbol + "_bear";

    const bearStage = resolveStage(
      memory.get(bearKey),
      bearStageRaw
    );

    memory.set(bearKey, bearStage);

    const bear = { ...bearBase, stage: bearStage };

    funnel.bear[bearStage.toLowerCase()].push(bear);
    logAnalytics(bear);

    if(bearStage === "candidate" || bearStage === "almost"){
      tradeCandidates.push(bear);
    }
  }

  // SORT
  for(const side of ["bull","bear"]){
    for(const k in funnel[side]){
      funnel[side][k].sort((a,b)=>b.moveScore-a.moveScore);
    }
  }

  console.log("TOTAL:", rawCoins.length);
  console.log("CANDIDATES:", tradeCandidates.length);

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