import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  generateShallowOb
} from "../lib/__main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import { processTrades } from "../lib/tradeSystem.js";
import { generateSignals } from "../lib/signalEngine.js";

import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";

function score(c) {
  let s = 0;

  if (Math.abs(c.change24) > 8) s += 30;
  else if (Math.abs(c.change24) > 5) s += 20;

  if (Math.abs(c.change1h) > 1) s += 20;

  if (c.vm > 0.5) s += 25;
  else if (c.vm > 0.3) s += 15;

  if (c.ob.score > 0.05) s += 15;

  return Math.min(s, 100);
}

function stage(s) {
  if (s >= 80) return "ENTRY";
  if (s >= 65) return "ALMOST";
  if (s >= 50) return "BUILDUP";
  return "RADAR";
}

export default async function handler(req, res) {
  try {
    const mode = (req.query.mode || "bull").toLowerCase();

    const btc = await fetchBTCGateFromUniverse();
    const raw = await fetchCoinGeckoTopCached();

    const regime = detectRegime(raw);

    const funnel = {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    };

    const coins = [];

    for (const r of raw) {
      const c = {
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

      const pass =
        mode === "bull"
          ? bullFilter(c)
          : bearFilter(c);

      if (!pass) continue;

      c.moveScore = score(c);
      c.stage = stage(c.moveScore);
      c.edge = calculateEdge(c, regime);

      coins.push(c);

      funnel[c.stage.toLowerCase()].push(c);
    }

    for (const k of Object.keys(funnel)) {
      funnel[k].sort((a, b) => b.moveScore - a.moveScore);
    }

    const trades = processTrades(coins, btc, mode);
    const signals = generateSignals(coins);

    return res.status(200).json({
      scannedAt: Date.now(),
      btc,
      regime,
      funnel,
      signals,
      trades,
      total: raw.length
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}