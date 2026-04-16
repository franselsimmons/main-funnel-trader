import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  generateShallowOb
} from "../lib/__main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import { multiTFScore } from "../lib/timeframe.js";
import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";
import { getLifecycleStage } from "../lib/lifecycle.js";


// ================= SCORE =================
function calculateScore(c, regime){

  let score = 0;

  // momentum 24h
  if(Math.abs(c.change24) > 10) score += 30;
  else if(Math.abs(c.change24) > 6) score += 20;
  else if(Math.abs(c.change24) > 3) score += 10;

  // momentum 1h (confirmatie)
  if(Math.abs(c.change1h) > 1.2) score += 20;
  else if(Math.abs(c.change1h) > 0.5) score += 10;

  // volume quality
  if(c.vm > 0.6) score += 25;
  else if(c.vm > 0.35) score += 15;

  // liquidity
  if(c.ob.score > 0.07) score += 15;
  else if(c.ob.score > 0.04) score += 10;

  // regime penalty
  if(regime === "LOW_VOL") score -= 10;

  return Math.max(0, Math.min(score, 100));
}


// ================= FLOW =================
function detectFlow(c){

  if(Math.abs(c.change1h) > 1.2 && Math.abs(c.change24) > 6){
    return "TREND";
  }

  if(Math.abs(c.change1h) < 0.2 && Math.abs(c.change24) > 8){
    return "EXHAUSTION";
  }

  if(Math.abs(c.change1h) > 0.5){
    return "BUILDING";
  }

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
    symbol: raw.symbol.toUpperCase(),
    name: raw.name,
    price: raw.current_price,
    change24: raw.price_change_percentage_24h,
    change1h: raw.price_change_percentage_1h,
    volume: raw.total_volume,
    marketCap: raw.market_cap,
    vm: raw.total_volume / raw.market_cap,
    ob: generateShallowOb()
  };
}


// ================= MAIN =================
export default async function handler(req, res){

  try{

    const mode = (req.query.mode || "bull").toLowerCase();

    const btc = await fetchBTCGateFromUniverse();
    const rawCoins = await fetchCoinGeckoTopCached();

    const regime = detectRegime(rawCoins);

    // 🔥 DRIE FUNNELS
    const funnel = {
      bull: { entry:[], almost:[], buildup:[], radar:[] },
      bear: { entry:[], almost:[], buildup:[], radar:[] },
      trade: { entry:[], hold:[], exit:[] }
    };

    const coins = [];

    for(const r of rawCoins){

      const c = normalize(r);

      // ===== FLOW =====
      const flow = detectFlow(c);
      c.flow = flow;

      // ===== SCORE =====
      c.moveScore = calculateScore(c, regime);

      // ===== STAGE =====
      c.stage = getLifecycleStage(
        getStage(c.moveScore, flow)
      );

      // ===== EDGE =====
      c.edge = calculateEdge(c, regime);

      // ===== FILTERS =====
      const bull = bullFilter(c);
      const bear = bearFilter(c);

      if(bull){
        funnel.bull[c.stage.toLowerCase()].push(c);
      }

      if(bear){
        funnel.bear[c.stage.toLowerCase()].push(c);
      }

      // trade candidates
      if(bull || bear){
        coins.push(c);
      }
    }

    // ===== SORT =====
    for(const side of ["bull","bear"]){
      for(const k of Object.keys(funnel[side])){
        funnel[side][k].sort((a,b)=>b.moveScore-a.moveScore);
      }
    }

    return res.status(200).json({
      scannedAt: Date.now(),
      btc,
      regime,
      funnel,
      total: rawCoins.length
    });

  }catch(err){
    return res.status(500).json({ error: err.message });
  }
}