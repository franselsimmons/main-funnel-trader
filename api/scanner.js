import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  fetchFuturesTickers,
  generateShallowOb
} from "../lib/_main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import { updateLifecycle } from "../lib/lifecycle.js";
import { handleTrade, getAllTrades } from "../lib/tradeSystem.js";

// ================= SCORE =================
function calculateScore(c) {
  let score = 0;

  if (c.change24 > 8) score += 30;
  else if (c.change24 > 5) score += 20;
  else if (c.change24 > 2) score += 10;

  if (c.change1h > 1) score += 20;
  else if (c.change1h > 0.5) score += 10;

  if (c.vm > 0.5) score += 25;
  else if (c.vm > 0.3) score += 15;

  if (c.ob?.score > 0.08) score += 15;
  else if (c.ob?.score > 0.04) score += 10;

  return Math.min(score, 100);
}

// ================= MAIN =================
export default async function handler(req, res) {
  try {
    const mode = (req.query.mode || "bull").toLowerCase();

    const btc = await fetchBTCGateFromUniverse();
    const coins = await fetchCoinGeckoTopCached();
    const tickers = await fetchFuturesTickers();

    const funnel = {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    };

    for (const raw of coins) {
      const symbol = raw.symbol.toUpperCase() + "USDT";
      const ob = generateShallowOb(tickers.get(symbol));

      const coin = {
        symbol: raw.symbol.toUpperCase(),
        name: raw.name,
        price: raw.current_price,
        change24: raw.price_change_percentage_24h,
        change1h: raw.price_change_percentage_1h,
        volume: raw.total_volume,
        marketCap: raw.market_cap,
        vm: raw.total_volume / raw.market_cap,
        ob
      };

      const stageRaw =
        mode === "bull"
          ? bullFilter(coin)
          : bearFilter(coin);

      const score = calculateScore(coin);

      const stage = updateLifecycle(
        coin.symbol,
        stageRaw,
        score
      );

      coin.stage = stage;
      coin.moveScore = score;

      coin.trade = handleTrade(coin);

      funnel[stage.toLowerCase()].push(coin);
    }

    // sort
    for (const key in funnel) {
      funnel[key].sort((a, b) => b.moveScore - a.moveScore);
    }

    // fallback
    const total =
      funnel.entry.length +
      funnel.almost.length +
      funnel.buildup.length +
      funnel.radar.length;

    if (total === 0) {
      funnel.radar = coins.slice(0, 10).map(c => ({
        symbol: c.symbol.toUpperCase(),
        price: c.current_price,
        change24: c.price_change_percentage_24h,
        moveScore: 10,
        stage: "RADAR"
      }));
    }

    return res.status(200).json({
      scannedAt: Date.now(),
      btc,
      funnel,
      trades: getAllTrades(),
      whaleFlow: Math.random() * 100
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}