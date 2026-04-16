import {
  fetchBTCGateFromUniverse,
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


// ================= SCORE =================
function calculateScore(c, regime, side){

  let score = 0;

  const dir = side === "bull" ? 1 : -1;

  const ch24 = Number(c.change24 || 0) * dir;
  const ch1 = Number(c.change1h || 0) * dir;

  if(ch24 > 10) score += 30;
  else if(ch24 > 6) score += 20;
  else if(ch24 > 3) score += 10;

  if(ch1 > 1.2) score += 20;
  else if(ch1 > 0.5) score += 10;

  if(c.vm > 0.6) score += 25;
  else if(c.vm > 0.35) score += 15;

  if(c.ob?.score > 0.07) score += 15;
  else if(c.ob?.score > 0.04) score += 10;

  if(regime === "LOW_VOL") score -= 10;

  return Math.max(0, Math.min(score, 100));
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


// ================= NORMALIZE =================
function normalize(raw){

  const mc = Number(raw?.market_cap || 0);
  const vol = Number(raw?.total_volume || 0);

  return {
    symbol: String(raw?.symbol || "").toUpperCase(),
    name: raw?.name || "",
    price: Number(raw?.current_price || 0),
    change24: Number(raw?.price_change_percentage_24h || 0),
    change1h: Number(raw?.price_change_percentage_1h || 0),
    volume: vol,
    marketCap: mc,
    vm: mc > 0 ? vol/mc : 0,
    ob: generateShallowOb()
  };
}


// ================= MAIN =================
export default async function handler(req,res){

  try{

    resetAnalytics(); // 🔥 altijd reset → geen oude data

    const btc = await fetchBTCGateFromUniverse();
    const rawCoins = await fetchCoinGeckoTopCached();

    if(!Array.isArray(rawCoins)){
      throw new Error("Invalid API response");
    }

    const regime = detectRegime(rawCoins);

    const funnel = {
      bull:{ entry:[], almost:[], buildup:[], radar:[] },
      bear:{ entry:[], almost:[], buildup:[], radar:[] }
    };

    const tradeCandidates = [];

    for(const raw of rawCoins){

      const base = normalize(raw);

      if(!base.symbol || base.price <= 0) continue;

      const flow = detectFlow(base);

      // ===== BULL =====
      const bullStage = bullFilter(base);

      if(bullStage){

        const c = {...base, side:"bull"};

        c.flow = flow;
        c.moveScore = calculateScore(c, regime, "bull");
        c.stage = bullStage;
        c.edge = calculateEdge(c, regime) || 0;

        logAnalytics(c); // 🔥 analyse log

        funnel.bull[bullStage.toLowerCase()].push(c);

        if(
          bullStage !== "RADAR" &&
          c.moveScore >= 50
        ){
          tradeCandidates.push(c);
        }
      }

      // ===== BEAR =====
      const bearStage = bearFilter(base);

      if(bearStage){

        const c = {...base, side:"bear"};

        c.flow = flow;
        c.moveScore = calculateScore(c, regime, "bear");
        c.stage = bearStage;
        c.edge = calculateEdge(c, regime) || 0;

        logAnalytics(c);

        funnel.bear[bearStage.toLowerCase()].push(c);

        if(
          bearStage !== "RADAR" &&
          c.moveScore >= 50
        ){
          tradeCandidates.push(c);
        }
      }
    }

    // ===== SORT =====
    for(const side of ["bull","bear"]){
      for(const key of Object.keys(funnel[side])){
        funnel[side][key].sort((a,b)=>b.moveScore-a.moveScore);
      }
    }

    // ===== TRADE SYSTEM =====
    const trades = await processTrades(
      tradeCandidates,
      btc,
      "auto",
      regime
    );

    // ===== ANALYTICS =====
    const analytics = getAnalytics();

    // 🔥 HIER KOMT JE "LERAAR"
    const advice = generateAdvice(analytics);

    const payload = {
      ok:true,
      scannedAt:Date.now(),
      btc,
      regime,
      funnel,
      trades,
      analytics,
      advice, // 🔥 BELANGRIJK
      total:rawCoins.length,
      candidates:tradeCandidates.length
    };

    setLatestScan(payload);

    console.log("SCAN:",{
      total:rawCoins.length,
      candidates:tradeCandidates.length,
      entry:
        analytics.bull.entry.total +
        analytics.bear.entry.total
    });

    return res.status(200).json(payload);

  }catch(err){

    console.error("SCANNER ERROR:", err);

    return res.status(500).json({
      ok:false,
      error:err.message
    });
  }
}