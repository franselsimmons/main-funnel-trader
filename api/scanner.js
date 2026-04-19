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
const STAGES = ["radar","buildup","almost","entry"];


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


// ================= STAGE RESOLVER =================
function resolveStage(prev, next){

  if(!next) return "radar";

  next = next.toLowerCase();

  if(!prev) return "radar";

  const prevIndex = STAGES.indexOf(prev);
  const nextIndex = STAGES.indexOf(next);

  if(nextIndex === -1) return prev;

  // 🚀 max 1 stap omhoog per scan
  if(nextIndex > prevIndex){
    return STAGES[Math.min(prevIndex + 1, nextIndex)];
  }

  // 🔻 direct terugvallen
  return next;
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
    bull:{ entry:[], almost:[], buildup:[], radar:[] },
    bear:{ entry:[], almost:[], buildup:[], radar:[] }
  };

  const tradeCandidates = [];

  // 🔥 LOAD MEMORY (KV)
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

    const filterStageBull = bullFilter(bull); // geeft "RADAR" etc

    const stageBull = resolveStage(prevBull, filterStageBull);

    memory[keyBull] = stageBull;

    bull.stage = stageBull;

    funnel.bull[stageBull].push(bull);
    logAnalytics(bull);

    if(stageBull === "entry"){
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

    const filterStageBear = bearFilter(bear);

    const stageBear = resolveStage(prevBear, filterStageBear);

    memory[keyBear] = stageBear;

    bear.stage = stageBear;

    funnel.bear[stageBear].push(bear);
    logAnalytics(bear);

    if(stageBear === "entry"){
      tradeCandidates.push(bear);
    }
  }

  // 🔥 CLEAN MEMORY (verwijder oude coins)
  memory = cleanMemory(memory, activeSymbols);

  // 🔥 SAVE MEMORY
  await saveStageMemory(memory);


  // ================= SORT =================
  for(const side of ["bull","bear"]){
    for(const k in funnel[side]){
      funnel[side][k].sort((a,b)=>b.vm-a.vm);
    }
  }


  // 🔍 DEBUG LOGS (belangrijk)
  console.log("TOTAL:", rawCoins.length);
  console.log("RADAR:", funnel.bull.radar.length);
  console.log("BUILDUP:", funnel.bull.buildup.length);
  console.log("ALMOST:", funnel.bull.almost.length);
  console.log("ENTRY:", funnel.bull.entry.length);


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