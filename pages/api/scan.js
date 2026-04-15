import { kv } from "@vercel/kv";
import { computeBtcRegime } from "../../lib/regimeEngine";
import { adaptiveThresholds } from "../../lib/adaptiveEngine";
import { computeAiScore } from "../../lib/aiEngine";
import { progressiveStage } from "../../lib/funnelEngine";
import { fetchOrderbook, orderbookPass } from "../../lib/orderbookEngine";
import { buildTradePlan } from "../../lib/tradePlanEngine";
import { executeTrade } from "../../lib/tradeEngine";

export const config = { runtime: "nodejs" };

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function safeObSymbol(symbol) {
  const s = up(symbol);
  return s.endsWith("USDT") ? s : `${s}USDT`;
}

async function fetchJsonSafe(url) {
  const r = await fetch(url, { cache: "no-store" });
  return await r.json();
}

async function acquireLock(key) {
  return await kv.set(key, { ts: Date.now() }, { nx: true, ex: 60 });
}

const keyAuto = (m) => `scan:auto:${m}`;
const keyLock = (m) => `scan:lock:${m}`;
const keyProgress = (m) => `progress:${m}`;
const keyState = (m) => `state:${m}`;

export default async function handler(req, res) {
  const t0 = Date.now();

  const mode =
    String(req.query?.mode || "bull").toLowerCase() === "bear"
      ? "bear"
      : "bull";

  const side = mode === "bear" ? "SHORT" : "LONG";
  const now = Date.now();

  const SCAN_INTERVAL_MS = 900000;
  const MAX_DELAY = 20 * 60 * 1000;

  try {
    const auto = (await kv.get(keyAuto(mode))) || {};

    if (auto?.nextDue && now < auto.nextDue) {
      const stuck = now - n(auto.lastRun, 0) > MAX_DELAY;
      if (!stuck) return res.json({ ok: true, skipped: true });
    }

    const lock = await acquireLock(keyLock(mode));
    if (!lock) return res.json({ ok: true, skipped: true });

    const universe = await fetchJsonSafe(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=120&page=1"
    );

    const btc = universe.find((c) => c.id === "bitcoin");

    const btcData = {
      price: n(btc.current_price),
      change24: n(btc.price_change_percentage_24h),
      range24:
        n(btc.low_24h) > 0
          ? ((btc.high_24h - btc.low_24h) / btc.low_24h) * 100
          : 0,
    };

    const regime = computeBtcRegime(btcData);
    const thresholds = adaptiveThresholds(regime?.regime);

    const prev = (await kv.get(keyProgress(mode))) || {};
    const next = {};

    const funnel = {
      radar: [],
      warmup: [],
      setup: [],
      entry_ready: [],
    };

    for (const coin of universe) {
      const symbol = up(coin.symbol);
      if (!symbol || symbol.includes("USD")) continue;

      const price = n(coin.current_price);
      const mom24 = n(coin.price_change_percentage_24h);

      const passes =
        (mode === "bull" ? mom24 > 0 : mom24 < 0) &&
        Math.abs(mom24) >= 2;

      const prog = progressiveStage({
        prev: prev[symbol],
        passes,
        now,
      });

      let tradePlan = null;
      let ob = null;

      if (prog.stage >= 3) {
        ob = await fetchOrderbook(safeObSymbol(symbol));

        if (orderbookPass(ob, thresholds)) {
          tradePlan = buildTradePlan({
            price,
            range24: btcData.range24,
            regime: regime?.regime,
            side,
          });
        }
      }

      const aiScore = computeAiScore({
        momentum24: mom24,
        volume: coin.total_volume,
        marketCap: coin.market_cap,
        rr: n(tradePlan?.rr, 1),
      });

      const obj = {
        symbol,
        name: coin.name,
        price,
        aiScore,
        stage: prog.stage,
        tradePlan,
        ob, // 🔥 IMPORTANT
      };

      next[symbol] = obj;

      if (prog.stage === 0) funnel.radar.push(obj);
      if (prog.stage === 1) funnel.warmup.push(obj);
      if (prog.stage === 2) funnel.setup.push(obj);
      if (prog.stage === 3 && tradePlan) funnel.entry_ready.push(obj);
    }

    let executed = 0;

    for (const coin of funnel.entry_ready) {
      if (executed >= 3) break;

      const result = await executeTrade(mode, coin, {
        ob: coin.ob, // 🔥 FIX
      });

      if (result?.opened) executed++;
    }

    const payload = {
      ok: true,
      mode,
      ts: now,
      regime,
      funnel,
      autoExecuted: executed,
    };

    await kv.set(keyProgress(mode), next);
    await kv.set(keyState(mode), payload);

    await kv.set(keyAuto(mode), {
      lastRun: now,
      nextDue: now + SCAN_INTERVAL_MS,
    });

    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await kv.del(keyLock(mode));
  }
}