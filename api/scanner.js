import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  fetchFuturesTickers,
  fetchContractConfigs,
  generateShallowOb
} from "../lib/_main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

// ================= SCORE =================
function calculateScore(c) {
  let score = 0;

  // momentum
  if (c.change24 > 8) score += 30;
  else if (c.change24 > 5) score += 20;
  else if (c.change24 > 2) score += 10;

  // short term
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

// ================= NORMALIZE =================
function normalizeCoin(c, ob) {
  return {
    symbol: c.symbol?.toUpperCase(),
    name: c.name,
    price: c.current_price,
    change24: c.price_change_percentage_24h,
    change1h: c.price_change_percentage_1h,
    volume: c.total_volume,
    marketCap: c.market_cap,
    vm: c.total_volume / c.market_cap,
    ob
  };
}

// ================= MAIN =================
export default async function handler(req, res) {
  try {
    const mode = (req.query.mode || "bull").toLowerCase();

    const btc = await fetchBTCGateFromUniverse();
    const coins = await fetchCoinGeckoTopCached();
    const tickers = await fetchFuturesTickers();
    const configs = await fetchContractConfigs();

    const funnel = {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    };

    for (const raw of coins) {
      const symbol = (raw.symbol || "").toUpperCase() + "USDT";
      const ob = generateShallowOb(tickers.get(symbol));

      const coin = normalizeCoin(raw, ob);

      // ================= FILTER (STAGE BASED) =================
      let stage = false;

      if (mode === "bull") {
        stage = bullFilter(coin);
      } else {
        stage = bearFilter(coin);
      }

      if (!stage) continue;

      // ================= SCORE =================
      const score = calculateScore(coin);
      coin.moveScore = score;

      // 🔥 BELANGRIJK: filter stage vs score combineren
      // (voorkomt dat zwakke coins ENTRY worden)
      if (stage === "ENTRY" && score < 70) stage = "ALMOST";
      if (stage === "ALMOST" && score < 55) stage = "BUILDUP";

      coin.stage = stage;

      // ================= PUSH =================
      if (stage === "ENTRY") funnel.entry.push(coin);
      else if (stage === "ALMOST") funnel.almost.push(coin);
      else if (stage === "BUILDUP") funnel.buildup.push(coin);
      else funnel.radar.push(coin);
    }

    // 🔥 SORT (BELANGRIJK)
    for (const key of Object.keys(funnel)) {
      funnel[key].sort((a, b) => b.moveScore - a.moveScore);
    }

    return res.status(200).json({
      scannedAt: Date.now(),
      btc,
      funnel,
      whaleFlow: Math.random() * 100
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}