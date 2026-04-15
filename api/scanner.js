import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  fetchFuturesTickers,
  generateShallowOb
} from "../lib/_main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import { processTrades } from "../lib/tradeSystem.js";
import { generateSignals } from "../lib/signalEngine.js";

import {
  getVolatilityRegime,
  getMarketBreadth
} from "../lib/marketContext.js";

// ================= SCORE =================

function calculateScore(c, volatility){

  let score = 0;

  // 🔥 adaptive momentum
  if (volatility === "HIGH") {
    if (c.change24 > 10) score += 30;
    else if (c.change24 > 6) score += 20;
  } else {
    if (c.change24 > 6) score += 30;
    else if (c.change24 > 3) score += 20;
  }

  // short term momentum
  if (c.change1h > 1) score += 20;
  else if (c.change1h > 0.5) score += 10;

  // volume strength
  if (c.vm > 0.5) score += 25;
  else if (c.vm > 0.3) score += 15;

  // liquidity
  if (c.ob?.score > 0.08) score += 15;
  else if (c.ob?.score > 0.04) score += 10;

  return Math.min(score, 100);
}

// ================= STAGE =================

function getStage(score){
  if(score >= 80) return "ENTRY";
  if(score >= 65) return "ALMOST";
  if(score >= 50) return "BUILDUP";
  return "RADAR";
}

// ================= MAIN =================

export default async function handler(req, res){

  try{

    const mode = (req.query.mode || "bull").toLowerCase();

    // ================= DATA =================
    const btc = await fetchBTCGateFromUniverse();
    const rawCoins = await fetchCoinGeckoTopCached();
    const tickers = await fetchFuturesTickers();

    // ================= CONTEXT =================
    const volatility = getVolatilityRegime(rawCoins);
    const breadth = getMarketBreadth(rawCoins);

    const context = {
      volatility,
      breadth
    };

    // ================= FUNNEL =================
    const funnel = {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    };

    const allCoins = [];

    // ================= LOOP =================
    for(const raw of rawCoins){

      const symbol = (raw.symbol || "").toUpperCase() + "USDT";

      const ob = generateShallowOb(tickers.get(symbol));

      const coin = {
        symbol: raw.symbol?.toUpperCase(),
        name: raw.name,
        price: raw.current_price,
        change24: raw.price_change_percentage_24h,
        change1h: raw.price_change_percentage_1h,
        volume: raw.total_volume,
        marketCap: raw.market_cap,
        vm: raw.total_volume / raw.market_cap,
        ob
      };

      // ================= FILTER =================
      const pass = mode === "bull"
        ? bullFilter(coin)
        : bearFilter(coin);

      if(!pass) continue;

      // ================= SCORE =================
      const score = calculateScore(coin, volatility);
      coin.moveScore = score;

      // ================= STAGE =================
      const stage = getStage(score);
      coin.stage = stage;

      allCoins.push(coin);

      // ================= FUNNEL PUSH =================
      if(stage === "ENTRY") funnel.entry.push(coin);
      else if(stage === "ALMOST") funnel.almost.push(coin);
      else if(stage === "BUILDUP") funnel.buildup.push(coin);
      else funnel.radar.push(coin);
    }

    // ================= SORT =================
    for(const key of Object.keys(funnel)){
      funnel[key].sort((a,b)=>b.moveScore - a.moveScore);
    }

    // ================= TRADE ENGINE =================
    const tradeActions = processTrades(
      allCoins,
      btc,
      mode,
      context
    );

    // ================= SIGNAL ENGINE =================
    const signals = generateSignals(allCoins);

    // ================= RESPONSE =================
    return res.status(200).json({
      scannedAt: Date.now(),
      mode,
      btc,
      context,
      funnel,
      tradeActions,
      signals
    });

  }catch(err){

    return res.status(500).json({
      error: err.message
    });

  }
}