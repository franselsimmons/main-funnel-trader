import { kv } from "@vercel/kv";
import { computeBtcRegime } from "../../lib/regimeEngine";
import { adaptiveThresholds } from "../../lib/adaptiveEngine";
import { computeAiScore } from "../../lib/aiEngine";
import { progressiveStage } from "../../lib/funnelEngine";
import { fetchOrderbook, orderbookPass } from "../../lib/orderbookEngine";
import { buildTradePlan } from "../../lib/tradePlanEngine";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export default async function handler(req, res) {
  const mode = req.query.mode === "bear" ? "bear" : "bull";
  const side = mode === "bear" ? "SHORT" : "LONG";
  const now = Date.now();

  try {

    // ======================
    // 1️⃣ FETCH UNIVERSE
    // ======================

    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=120&page=1&sparkline=false"
    );
    const universe = await r.json();

    const btc = universe.find(c => c.id === "bitcoin");

    const btcData = {
      change24: btc?.price_change_percentage_24h,
      range24: btc?.high_24h && btc?.low_24h
        ? ((btc.high_24h - btc.low_24h) / btc.low_24h) * 100
        : 0
    };

    const regimeData = computeBtcRegime(btcData);
    const thresholds = adaptiveThresholds(regimeData.regime);

    // ======================
    // 2️⃣ LOAD PREVIOUS STATE
    // ======================

    const prevState = (await kv.get(`progress:${mode}`)) || {};
    const nextState = {};

    // ======================
    // 3️⃣ PROCESS COINS
    // ======================

    for (const coin of universe) {

      const symbol = coin.symbol.toUpperCase();
      const momentum = n(coin.price_change_percentage_24h, 0);
      const volume = n(coin.total_volume, 0);

      const volAcc = volume / 1_000_000;
      const compression = Math.abs(momentum) < 4;

      const directional =
        mode === "bull"
          ? momentum > 0
          : momentum < 0;

      const passes =
        directional &&
        Math.abs(momentum) > thresholds.confMin / 12 &&
        volAcc > thresholds.volAccMin;

      // ======================
      // PROGRESSIVE FUNNEL
      // ======================

      const prog = progressiveStage({
        prev: prevState[symbol],
        passes,
        now
      });

      // ======================
      // ORDERBOOK LAYER
      // ======================

      let tradePlan = null;
      let ob = null;

      if (prog.stage === 3) {
        ob = await fetchOrderbook(symbol);

        if (orderbookPass(ob, thresholds)) {

          tradePlan = buildTradePlan({
            price: coin.current_price,
            range24: btcData.range24,
            regime: regimeData.regime,
            side
          });

        } else {
          // demote if liquidity fails
          prog.stage = 2;
        }
      }

      // ======================
      // AI SCORE
      // ======================

      const aiScore = computeAiScore({
        momentum,
        volAcc,
        compression,
        obScore: ob?.imbalance || 0,
        rr: tradePlan?.rr || 1
      });

      nextState[symbol] = {
        symbol,
        price: coin.current_price,
        momentum,
        volAcc,
        compression,
        aiScore,
        stage: prog.stage,
        streak: prog.streak,
        tradePlan,
        orderbook: ob,
        updatedAt: now
      };
    }

    // ======================
    // 4️⃣ BUILD FUNNEL
    // ======================

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

    // rank by AI score
    Object.keys(funnel).forEach(k => {
      funnel[k].sort((a, b) => b.aiScore - a.aiScore);
    });

    await kv.set(`progress:${mode}`, nextState);
    await kv.set(`funnel:${mode}`, {
      funnel,
      regime: regimeData,
      ts: now
    });

    res.json({
      ok: true,
      mode,
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