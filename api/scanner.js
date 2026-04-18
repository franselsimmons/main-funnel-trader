import {
  fetchCoinGeckoTopCached,
  generateShallowOb
} from "../lib/_main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";
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
import { selectEliteSignals } from "../lib/eliteSignals.js";


// ================= SCORE =================
function calculateScore(c, regime, side){

  let score = 0;
  const dir = side === "bull" ? 1 : -1;

  const ch24 = Number(c.change24 || 0) * dir;
  const ch1 = Number(c.change1h || 0) * dir;

  if(ch24 > 8) score += 30;
  else if(ch24 > 4) score += 20;
  else if(ch24 > 2) score += 10;

  if(ch1 > 1) score += 20;
  else if(ch1 > 0.5) score += 10;

  if(c.vm > 0.5) score += 25;
  else if(c.vm > 0.3) score += 15;

  if(c.ob?.score > 0.06) score += 15;

  if(regime === "LOW_VOL") score -= 10;

  return Math.max(0, Math.min(score, 100));
}


// ================= FLOW =================
function detectFlow(c){

  const ch1 = Math.abs(c.change1h);
  const ch24 = Math.abs(c.change24);

  if(ch1 > 1.2 && ch24 > 6) return "TREND";
  if(ch1 > 0.6) return "BUILDING";
  if(ch24 > 2) return "EARLY";

  return "NEUTRAL";
}


// ================= STAGE =================
function getStage(base, c){

  if(c.flow === "TREND" && c.moveScore > 80 && c.vm > 0.3){
    return "ENTRY";
  }

  if(c.moveScore > 65){
    return "ALMOST";
  }

  if(c.moveScore > 50){
    return "BUILDUP";
  }

  return base;
}


// ================= NORMALIZE =================
function normalize(raw){

  const mc = Number(raw.market_cap || 0);
  const vol = Number(raw.total_volume || 0);

  return {
    symbol: raw.symbol.toUpperCase(),
    price: Number(raw.current_price),
    change24: Number(raw.price_change_percentage_24h || 0),
    change1h: Number(raw.price_change_percentage_1h_in_currency || 0),
    volume: vol,
    marketCap: mc,
    vm: mc > 0 ? vol / mc : 0,
    ob: generateShallowOb()
  };
}


// ================= MAIN =================
export async function buildScanPayload(){

  resetAnalytics();

  const rawCoins = await fetchCoinGeckoTopCached();
  const regime = detectRegime(rawCoins);
  const market = classifyMarket(rawCoins);

  const funnel = {
    bull:{ entry:[], almost:[], buildup:[], radar:[] },
    bear:{ entry:[], almost:[], buildup:[], radar:[] }
  };

  const candidates = [];

  for(const raw of rawCoins){

    const base = normalize(raw);
    const flow = detectFlow(base);

    // ===== BULL =====
    const bs = bullFilter(base);
    if(bs){

      const c = {...base, side:"bull"};
      c.flow = flow;
      c.moveScore = calculateScore(c, regime, "bull");
      c.stage = getStage(bs, c);

      logAnalytics(c);
      funnel.bull[c.stage.toLowerCase()].push(c);

      if(c.stage === "ALMOST" || c.stage === "ENTRY"){
        candidates.push(c);
      }
    }

    // ===== BEAR =====
    const br = bearFilter(base);
    if(br){

      const c = {...base, side:"bear"};
      c.flow = flow;
      c.moveScore = calculateScore(c, regime, "bear");
      c.stage = getStage(br, c);

      logAnalytics(c);
      funnel.bear[c.stage.toLowerCase()].push(c);

      if(c.stage === "ALMOST" || c.stage === "ENTRY"){
        candidates.push(c);
      }
    }
  }

  const trades = await processTrades(candidates, {}, "auto", regime);

  const eliteSignals = selectEliteSignals(trades);

  const payload = {
    ok:true,
    funnel,
    trades,
    eliteSignals,
    analytics:getAnalytics(),
    advice:generateAdvice(getAnalytics()),
    market,
    regime
  };

  setLatestScan(payload);

  return payload;
}


// ================= API =================
export default async function handler(req,res){
  try{
    const data = await buildScanPayload();
    return res.status(200).json(data);
  }catch(e){
    return res.status(500).json({ok:false,error:e.message});
  }
}