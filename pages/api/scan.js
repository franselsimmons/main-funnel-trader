import { kv } from "@vercel/kv";
import { computeBtcRegime } from "../../lib/regimeEngine";
import { adaptiveThresholds } from "../../lib/adaptiveEngine";
import { computeAiScore } from "../../lib/aiEngine";
import { progressiveStage } from "../../lib/funnelEngine";
import { n } from "../../lib/utils";

export default async function handler(req, res) {
  const mode = req.query.mode === "bear" ? "bear" : "bull";
  const now = Date.now();

  try {
    const universe = await fetchUniverse();
    const btc = universe.find(c => c.id === "bitcoin");

    const regimeData = computeBtcRegime({
      change24: btc.price_change_percentage_24h,
      range24: (btc.high_24h - btc.low_24h) / btc.low_24h * 100
    });

    const thresholds = adaptiveThresholds(regimeData.regime);
    const prevState = (await kv.get(`progress:${mode}`)) || {};
    const nextState = {};

    for (const coin of universe) {
      const momentum = n(coin.price_change_percentage_24h, 0);
      const vol = n(coin.total_volume, 0);

      const volAcc = vol / 1000000;
      const compression = Math.abs(momentum) < 5;

      const passes =
        Math.abs(momentum) > thresholds.confMin / 10 &&
        volAcc > thresholds.volAccMin;

      const prog = progressiveStage({
        prev: prevState[coin.symbol],
        passes,
        now
      });

      const aiScore = computeAiScore({
        momentum,
        volAcc,
        compression,
        obScore: 0.5,
        rr: 2
      });

      nextState[coin.symbol] = {
        symbol: coin.symbol.toUpperCase(),
        price: coin.current_price,
        momentum,
        volAcc,
        compression,
        aiScore,
        ...prog
      };
    }

    const funnel = {
      radar: [],
      warmup: [],
      setup: [],
      entry_ready: []
    };

    Object.values(nextState).forEach(c => {
      if (c.stage === 0) funnel.radar.push(c);
      if (c.stage === 1) funnel.warmup.push(c);
      if (c.stage === 2) funnel.setup.push(c);
      if (c.stage === 3) funnel.entry_ready.push(c);
    });

    await kv.set(`progress:${mode}`, nextState);
    await kv.set(`funnel:${mode}`, {
      funnel,
      regime: regimeData
    });

    res.json({
      ok: true,
      regime: regimeData,
      counts: {
        radar: funnel.radar.length,
        warmup: funnel.warmup.length,
        setup: funnel.setup.length,
        entry_ready: funnel.entry_ready.length
      }
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

async function fetchUniverse() {
  const r = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=120&page=1"
  );
  return r.json();
}