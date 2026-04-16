import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  generateShallowOb
} from "../lib/_main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";
import { getLifecycleStage } from "../lib/lifecycle.js";

import { processTrades } from "../lib/tradeSystem.js";


// ================= SCORE =================
function calculateScore(c, regime, side){

  try{

    let score = 0;

    const dir = side === "bull" ? 1 : -1;

    const ch24 = (c.change24 || 0) * dir;
    const ch1  = (c.change1h || 0) * dir;

    // momentum
    if(ch24 > 10) score += 30;
    else if(ch24 > 6) score += 20;
    else if(ch24 > 3) score += 10;

    // 1h confirmatie
    if(ch1 > 1.2) score += 20;
    else if(ch1 > 0.5) score += 10;

    // volume
    if(c.vm > 0.6) score += 25;
    else if(c.vm > 0.35) score += 15;

    // liquidity
    if(c.ob?.score > 0.07) score += 15;
    else if(c.ob?.score > 0.04) score += 10;

    // regime penalty
    if(regime === "LOW_VOL") score -= 10;

    return Math.max(0, Math.min(score, 100));

  }catch(e){
    return 0;
  }
}


// ================= FLOW =================
function detectFlow(c){

  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));

  if(ch1 > 1.2 && ch24 > 6) return "TREND";
  if(ch1 < 0.2 && ch24 > 8) return "EXHAUSTION";
  if(ch1 > 0.5) return "BUILDING";

  return "NEUTRAL";
}


// ================= STAGE =================
function getStage(score, flow){

  if(score >= 85 && flow === "TREND") return "ENTRY";
  if(score >= 70) return "ALMOST";
  if(score >= 55) return "BUILDUP";
  return "RADAR";
}


// ================= NORMALIZE =================
function normalize(raw){

  return {
    symbol: (raw.symbol || "").toUpperCase(),
    name: raw.name || "",
    price: Number(raw.current_price || 0),
    change24: Number(raw.price_change_percentage_24h || 0),
    change1h: Number(raw.price_change_percentage_1h || 0),
    volume: Number(raw.total_volume || 0),
    marketCap: Number(raw.market_cap || 0),
    vm: raw.market_cap ? raw.total_volume / raw.market_cap : 0,
    ob: generateShallowOb()
  };
}


// ================= MAIN =================
export default async function handler(req, res){

  try{

    const btc = await fetchBTCGateFromUniverse();
    const rawCoins = await fetchCoinGeckoTopCached();

    if(!rawCoins || !Array.isArray(rawCoins)){
      throw new Error("No coin data");
    }

    const regime = detectRegime(rawCoins);

    const funnel = {
      bull:{ entry:[], almost:[], buildup:[], radar:[] },
      bear:{ entry:[], almost:[], buildup:[], radar:[] }
    };

    const coins = [];

    for(const r of rawCoins){

      const base = normalize(r);

      const flow = detectFlow(base);

      // ===== BULL =====
      if(bullFilter(base)){

        const c = {...base, side:"bull"};

        c.flow = flow;
        c.moveScore = calculateScore(c, regime, "bull");

        c.stage = getLifecycleStage(
          getStage(c.moveScore, flow)
        ) || "RADAR";

        c.edge = calculateEdge(c, regime) || 0;

        if(c.moveScore >= 55 && flow !== "NEUTRAL"){
          funnel.bull[c.stage.toLowerCase()].push(c);
          coins.push(c);
        }
      }

      // ===== BEAR =====
      if(bearFilter(base)){

        const c = {...base, side:"bear"};

        c.flow = flow;
        c.moveScore = calculateScore(c, regime, "bear");

        c.stage = getLifecycleStage(
          getStage(c.moveScore, flow)
        ) || "RADAR";

        c.edge = calculateEdge(c, regime) || 0;

        if(c.moveScore >= 55 && flow !== "NEUTRAL"){
          funnel.bear[c.stage.toLowerCase()].push(c);
          coins.push(c);
        }
      }
    }

    // ===== SORT =====
    for(const side of ["bull","bear"]){
      for(const k of Object.keys(funnel[side])){
        funnel[side][k].sort((a,b)=>b.moveScore-a.moveScore);
      }
    }

    // ===== TRADE SYSTEM =====
    const trades = processTrades(coins, btc, "auto", regime) || [];

    return res.status(200).json({
      scannedAt: Date.now(),
      btc,
      regime,
      funnel,
      trades,
      total: rawCoins.length
    });

  }catch(err){

    console.error("SCANNER ERROR:", err);

    return res.status(500).json({
      error: err.message
    });
  }
}