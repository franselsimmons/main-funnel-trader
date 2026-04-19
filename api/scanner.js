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

const STAGES = ["radar","buildup","almost","candidate"];

function normalizeStage(stage){
  if(!stage) return "radar";
  if(stage === "ENTRY") return "candidate";
  return stage.toLowerCase();
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

    const edge = calculateEdge(base, regime) || 0;

    // ================= BULL =================
    const bull = {
      ...base,
      side:"bull",
      edge
    };

    const keyBull = base.symbol + "_bull";
    const prev = memory.get(keyBull) || "radar";

    const maxStageRaw = bullFilter(bull);
    const maxStage = normalizeStage(maxStageRaw);

    const currentIndex = STAGES.indexOf(prev);
    const maxIndex = STAGES.indexOf(maxStage);

    let nextIndex = Math.min(currentIndex + 1, maxIndex);

    // reset als coin volledig zwak is
    if(!maxStageRaw){
      nextIndex = 0;
    }

    const stage = STAGES[nextIndex];

    memory.set(keyBull, stage);

    bull.stage = stage;

    funnel.bull[stage].push(bull);
    logAnalytics(bull);

    if(stage === "candidate"){
      tradeCandidates.push(bull);
    }


    // ================= BEAR =================
    const bear = {
      ...base,
      side:"bear",
      edge
    };

    const keyBear = base.symbol + "_bear";
    const prevBear = memory.get(keyBear) || "radar";

    const maxStageRawBear = bearFilter(bear);
    const maxStageBear = normalizeStage(maxStageRawBear);

    const currentIndexBear = STAGES.indexOf(prevBear);
    const maxIndexBear = STAGES.indexOf(maxStageBear);

    let nextIndexBear = Math.min(currentIndexBear + 1, maxIndexBear);

    if(!maxStageRawBear){
      nextIndexBear = 0;
    }

    const stageBear = STAGES[nextIndexBear];

    memory.set(keyBear, stageBear);

    bear.stage = stageBear;

    funnel.bear[stageBear].push(bear);
    logAnalytics(bear);

    if(stageBear === "candidate"){
      tradeCandidates.push(bear);
    }
  }

  // ================= SORT =================
  for(const side of ["bull","bear"]){
    for(const k in funnel[side]){
      funnel[side][k].sort((a,b)=>b.vm-a.vm);
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