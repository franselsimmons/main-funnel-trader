import { kv } from "@vercel/kv";
import { computeBtcRegime } from "../../lib/regimeEngine";
import { adaptiveThresholds } from "../../lib/adaptiveEngine";
import { computeAiScore } from "../../lib/aiEngine";
import { progressiveStage } from "../../lib/funnelEngine";
import { fetchOrderbook, orderbookPass } from "../../lib/orderbookEngine";
import { buildTradePlan } from "../../lib/tradePlanEngine";

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

async function fetchUniverse() {
  const results = [];
  for (let page = 1; page <= 3; page++) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=100&page=${page}`;
    const data = await fetchJsonSafe(url);
    if (Array.isArray(data)) results.push(...data);
  }
  return results;
}

const keyState = (m) => `state:${m}`;
const keyFlow = (m) => `flow:${m}`;
const keyAuto = (m) => `scan:auto:${m}`;
const keyLock = (m) => `scan:lock:${m}`;

export default async function handler(req, res) {
  const mode =
    String(req.query?.mode || "bull").toLowerCase() === "bear"
      ? "bear"
      : "bull";

  const now = Date.now();
  const baseUrl =
    (req.headers["x-forwarded-proto"] || "https") +
    "://" +
    (req.headers["x-forwarded-host"] || req.headers.host);

  try {
    const lock = await acquireLock(keyLock(mode));
    if (!lock) return res.json({ ok: true, skipped: true });

    const universe = await fetchUniverse();
    const btc = universe.find((c) => c.id === "bitcoin");

    const btcData = {
      price: n(btc?.current_price),
      change24: n(btc?.price_change_percentage_24h),
      range24:
        n(btc?.low_24h) > 0
          ? ((btc.high_24h - btc.low_24h) / btc.low_24h) * 100
          : 0,
    };

    const regime = computeBtcRegime(btcData);
    const thresholds = adaptiveThresholds(regime?.regime);

    const funnel = {
      radar: [],
      warmup: [],
      setup: [],
      entry_ready: [],
    };

    let count = 0;

    for (const coin of universe) {
      if (count++ > 250) break;

      const symbol = up(coin.symbol);
      if (!symbol || symbol.includes("USD")) continue;

      if (n(coin.market_cap) < 5_000_000) continue;
      if (n(coin.total_volume) < 1_000_000) continue;

      const price = n(coin.current_price);
      const mom24 = n(coin.price_change_percentage_24h);

      const stage =
        Math.abs(mom24) > 4
          ? 3
          : Math.abs(mom24) > 2
          ? 2
          : Math.abs(mom24) > 1
          ? 1
          : 0;

      let tradePlan = null;
      let ob = null;

      if (stage >= 3) {
        ob = await fetchOrderbook(safeObSymbol(symbol));

        if (orderbookPass(ob, thresholds)) {
          tradePlan = buildTradePlan({
            price,
            range24: btcData.range24,
            regime: regime?.regime,
            side: mode === "bear" ? "SHORT" : "LONG",
          });
        }
      }

      const aiScore = computeAiScore({
        momentum24: mom24,
        volume: coin.total_volume,
        marketCap: coin.market_cap,
      });

      const obj = {
        symbol,
        name: coin.name,
        price,
        aiScore,
        stage,
        tradePlan,
        ob,
      };

      if (stage === 0) funnel.radar.push(obj);
      if (stage === 1) funnel.warmup.push(obj);
      if (stage === 2) funnel.setup.push(obj);
      if (stage === 3 && tradePlan) funnel.entry_ready.push(obj);
    }

    funnel.entry_ready.sort((a, b) => b.aiScore - a.aiScore);

    const payload = {
      ok: true,
      mode,
      ts: now,
      regime,
      funnel,
    };

    await kv.set(keyState(mode), payload);

    // ✅ FLOW TRACKING
    await kv.set(keyFlow(mode), {
      ts: now,
      radar: funnel.radar.length,
      warmup: funnel.warmup.length,
      setup: funnel.setup.length,
      entry: funnel.entry_ready.length,
    });

    await kv.set(keyAuto(mode), {
      lastRun: now,
      nextDue: now + 900000,
    });

    // ✅ TRIGGER TRADE ENGINE
    await fetch(`${baseUrl}/api/trade?mode=${mode}`, { cache: "no-store" });

    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await kv.del(keyLock(mode));
  }
}