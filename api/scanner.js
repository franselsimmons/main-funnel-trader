import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  fetchFuturesTickers,
  fetchContractConfigs,
  generateShallowOb
} from "../lib/_main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

// ================= SCORE =================
function calculateScore(c) {
  let score = 0;

  // 24h momentum
  if (c.change24 > 8) score += 30;
  else if (c.change24 > 5) score += 20;
  else if (c.change24 > 2) score += 10;
  else if (c.change24 < -8) score += 30;
  else if (c.change24 < -5) score += 20;
  else if (c.change24 < -2) score += 10;

  // 1h momentum
  if (c.change1h > 1) score += 20;
  else if (c.change1h > 0.5) score += 10;
  else if (c.change1h < -1) score += 20;
  else if (c.change1h < -0.5) score += 10;

  // volume / market cap
  if (c.vm > 0.5) score += 25;
  else if (c.vm > 0.3) score += 15;
  else if (c.vm > 0.2) score += 8;

  // liquidity / orderbook
  if (n(c.ob?.score) > 0.08) score += 15;
  else if (n(c.ob?.score) > 0.04) score += 10;

  if (n(c.ob?.depthMinUsd1p) > 500000) score += 10;
  else if (n(c.ob?.depthMinUsd1p) > 100000) score += 5;

  if (n(c.ob?.spreadPct) > 0 && n(c.ob?.spreadPct) < 0.1) score += 5;

  return Math.min(score, 100);
}

// ================= NORMALIZE =================
function normalizeCoin(raw, ob, contractConfig) {
  const marketCap = n(raw?.market_cap);
  const volume = n(raw?.total_volume);

  return {
    symbol: String(raw?.symbol || "").toUpperCase(),
    name: raw?.name || "",
    price: n(raw?.current_price),
    change24: n(raw?.price_change_percentage_24h),
    change1h: n(raw?.price_change_percentage_1h),
    volume,
    marketCap,
    vm: marketCap > 0 ? volume / marketCap : 0,
    ob,
    contractConfig: contractConfig || null,
  };
}

// ================= MAIN =================
export default async function handler(req, res) {
  try {
    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear"
        ? "bear"
        : "bull";

    const btc = await fetchBTCGateFromUniverse();
    const coins = await fetchCoinGeckoTopCached();
    const tickers = await fetchFuturesTickers();
    const configs = await fetchContractConfigs();

    const funnel = {
      entry: [],
      almost: [],
      buildup: [],
      radar: [],
    };

    for (const raw of coins) {
      const symbolUpper = String(raw?.symbol || "").toUpperCase();
      if (!symbolUpper) continue;

      const symbolUsdt = `${symbolUpper}USDT`;
      const ob = generateShallowOb(tickers.get(symbolUsdt));
      const contractConfig = configs.get(symbolUsdt);

      const coin = normalizeCoin(raw, ob, contractConfig);

      // ================= FILTER (RETURNS STAGE OR FALSE) =================
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

      // combine filter-stage + score sanity
      if (stage === "ENTRY" && score < 70) stage = "ALMOST";
      if (stage === "ALMOST" && score < 55) stage = "BUILDUP";
      if (stage === "BUILDUP" && score < 40) stage = "RADAR";

      coin.stage = stage;

      // ================= PUSH =================
      if (stage === "ENTRY") funnel.entry.push(coin);
      else if (stage === "ALMOST") funnel.almost.push(coin);
      else if (stage === "BUILDUP") funnel.buildup.push(coin);
      else funnel.radar.push(coin);
    }

    // sort strongest first
    for (const key of Object.keys(funnel)) {
      funnel[key].sort((a, b) => n(b.moveScore) - n(a.moveScore));
    }

    return res.status(200).json({
      scannedAt: Date.now(),
      mode,
      btc,
      funnel,
      whaleFlow: Math.random() * 100,
    });
  } catch (err) {
    return res.status(500).json({
      error: String(err?.message || err),
    });
  }
}