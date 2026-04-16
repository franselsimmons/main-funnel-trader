import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  generateShallowOb
} from "../lib/__main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import { analyzeFlow } from "../lib/flowEngine.js";
import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";
import { getLifecycleStage } from "../lib/lifecycle.js";

import { processTrades } from "../lib/tradeSystem.js";
import { generateSignals } from "../lib/signalEngine.js";


// 🔥 SCORE (SLIMMER)
function calculateScore(c, regime) {
  let score = 0;

  // momentum
  if (Math.abs(c.change24) > 10) score += 30;
  else if (Math.abs(c.change24) > 6) score += 20;
  else if (Math.abs(c.change24) > 3) score += 10;

  // 1h confirmatie
  if (Math.abs(c.change1h) > 1.2) score += 20;
  else if (Math.abs(c.change1h) > 0.5) score += 10;

  // volume kwaliteit
  if (c.vm > 0.6) score += 25;
  else if (c.vm > 0.35) score += 15;

  // liquidity
  if (c.ob.score > 0.07) score += 15;
  else if (c.ob.score > 0.04) score += 10;

  // 🔥 regime penalty (belangrijk)
  if (regime === "LOW_VOL") score -= 10;

  return Math.max(0, Math.min(score, 100));
}


// 🔥 STAGE LOGICA (STRIKTER)
function getStage(score, flow) {
  if (score >= 85 && flow.type === "TREND_CONTINUATION") return "ENTRY";
  if (score >= 70) return "ALMOST";
  if (score >= 55) return "BUILDUP";
  return "RADAR";
}


export default async function handler(req, res) {
  try {

    const mode = (req.query.mode || "bull").toLowerCase();

    const btc = await fetchBTCGateFromUniverse();
    const rawCoins = await fetchCoinGeckoTopCached();

    const regime = detectRegime(rawCoins);

    const funnel = {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    };

    const coins = [];

    for (const r of rawCoins) {

      const coin = {
        symbol: r.symbol.toUpperCase(),
        name: r.name,
        price: r.current_price,
        change24: r.price_change_percentage_24h,
        change1h: r.price_change_percentage_1h,
        volume: r.total_volume,
        marketCap: r.market_cap,
        vm: r.total_volume / r.market_cap,
        ob: generateShallowOb()
      };

      // 🔥 FILTER (STRIKT)
      const pass =
        mode === "bull"
          ? bullFilter(coin)
          : bearFilter(coin);

      if (!pass) continue;

      // 🔥 FLOW
      const flow = analyzeFlow(coin);
      coin.flow = flow.type;

      // 🔥 SCORE
      coin.moveScore = calculateScore(coin, regime);

      // 🔥 STAGE + LIFECYCLE
      coin.stage = getLifecycleStage(
        getStage(coin.moveScore, flow)
      );

      // 🔥 EDGE
      coin.edge = calculateEdge(coin, regime);

      coins.push(coin);

      funnel[coin.stage.toLowerCase()].push(coin);
    }

    // 🔥 SORT
    for (const key of Object.keys(funnel)) {
      funnel[key].sort((a, b) => b.moveScore - a.moveScore);
    }

    // 🔥 TRADE ENGINE
    const trades = processTrades(coins, btc, mode, regime);

    // 🔥 SIGNALS
    const signals = generateSignals(coins);

    return res.status(200).json({
      scannedAt: Date.now(),
      btc,
      regime,
      funnel,
      trades,
      signals,
      total: rawCoins.length
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
}