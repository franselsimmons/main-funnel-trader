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
import { autoAdjustV4 } from "../lib/autoAdjustV4.js";
import { classifyMarket } from "../lib/marketClassifier.js";


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
  else if(c.vm > 0.15) score += 8;

  // ❌ GEEN fake OB score meer

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


// ================= MAIN =================
export default async function handler(req,res){

  try{

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

      const bullCoin = {
        ...base,
        side:"bull",
        flow,
        moveScore: calculateScore(base, regime, "bull")
      };

      const bearCoin = {
        ...base,
        side:"bear",
        flow,
        moveScore: calculateScore(base, regime, "bear")
      };

      const bs = bullFilter(bullCoin);

      if(bs){
        const c = {
          ...bullCoin,
          edge: calculateEdge(bullCoin, regime) || 0,
          stage: bs
        };

        logAnalytics(c);
        funnel.bull[bs.toLowerCase()].push(c);

        if(bs === "ALMOST" || bs === "CANDIDATE"){
          tradeCandidates.push(c);
        }
      }

      const br = bearFilter(bearCoin);

      if(br){
        const c = {
          ...bearCoin,
          edge: calculateEdge(bearCoin, regime) || 0,
          stage: br
        };

        logAnalytics(c);
        funnel.bear[br.toLowerCase()].push(c);

        if(br === "ALMOST" || br === "CANDIDATE"){
          tradeCandidates.push(c);
        }
      }
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

    let ai = null;
    if(process.env.AUTO_AI === "true"){
      ai = autoAdjustV4(advice, market);
    }

    const payload = {
      ok:true,
      btc,
      regime,
      market,
      funnel,
      trades,
      analytics,
      advice,
      ai,
      total: rawCoins.length,
      candidates: tradeCandidates.length
    };

    setLatestScan(payload);

    return res.status(200).json(payload);

  }catch(e){

    console.error("SCAN ERROR:", e);

    return res.status(500).json({
      ok:false,
      error:e.message
    });
  }
}