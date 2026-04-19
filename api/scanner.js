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


// ================= STAGES =================
const STAGES = ["radar","buildup","almost","candidate"];

function nextStage(stage){
  const i = STAGES.indexOf(stage);
  return STAGES[i + 1] || "candidate";
}

function resetStage(){
  return "radar";
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

  // 🔥 LOAD MEMORY
  let memory = await loadStageMemory();

  const activeSymbols = [];

  for(const raw of rawCoins){

    const base = normalize(raw);
    if(!base.symbol || base.price <= 0) continue;

    activeSymbols.push(base.symbol);

    const edge = calculateEdge(base, regime) || 0;

    // ================= BULL =================
    const bull = {
      ...base,
      side:"bull",
      edge
    };

    const keyBull = base.symbol + "_bull";
    const prevBull = memory[keyBull];

    const passesBull = bullFilter(bull);

    let stageBull;

    if(!prevBull){
      stageBull = "radar";
    }
    else if(passesBull){
      stageBull = nextStage(prevBull);
    }
    else{
      stageBull = resetStage();
    }

    memory[keyBull] = stageBull;

    bull.stage = stageBull;
    funnel.bull[stageBull].push(bull);
    logAnalytics(bull);

    if(stageBull === "candidate"){
      tradeCandidates.push(bull);
    }


    // ================= BEAR =================
    const bear = {
      ...base,
      side:"bear",
      edge
    };

    const keyBear = base.symbol + "_bear";
    const prevBear = memory[keyBear];

    const passesBear = bearFilter(bear);

    let stageBear;

    if(!prevBear){
      stageBear = "radar";
    }
    else if(passesBear){
      stageBear = nextStage(prevBear);
    }
    else{
      stageBear = resetStage();
    }

    memory[keyBear] = stageBear;

    bear.stage = stageBear;
    funnel.bear[stageBear].push(bear);
    logAnalytics(bear);

    if(stageBear === "candidate"){
      tradeCandidates.push(bear);
    }
  }

  // 🔥 CLEAN MEMORY (BELANGRIJK)
  memory = cleanMemory(memory, activeSymbols);

  // 🔥 SAVE MEMORY
  await saveStageMemory(memory);

  // SORT
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