import { kv } from "@vercel/kv";
import { computeBtcRegime } from "../../lib/regimeEngine";
import { adaptiveThresholds } from "../../lib/adaptiveEngine";
import { computeAiScore } from "../../lib/aiEngine";
import { progressiveStage } from "../../lib/funnelEngine";
import { fetchOrderbook, orderbookPass } from "../../lib/orderbookEngine";
import { buildTradePlan } from "../../lib/tradePlanEngine";

export const config = { runtime: "nodejs" };

/* ================= HELPERS ================= */

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ================= SAFE FETCH ================= */

async function fetchJsonSafe(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });

      if (!r.ok) throw new Error(`HTTP_${r.status}`);

      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(500 * (i + 1)); // backoff
    }
  }
}

/* ================= FETCH UNIVERSE ================= */

async function fetchUniverse() {
  const results = [];

  for (let page = 1; page <= 3; page++) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd` +
      `&order=market_cap_desc` +
      `&per_page=100` +
      `&page=${page}` +
      `&sparkline=false` +
      `&price_change_percentage=24h`;

    try {
      const data = await fetchJsonSafe(url);

      if (Array.isArray(data)) {
        results.push(...data);
      } else {
        console.warn("bad data page:", page);
      }

      await sleep(300); // 🔥 rate limit protection
    } catch (e) {
      console.warn("fetch page failed:", page);
    }
  }

  return results;
}

/* ================= KV KEYS ================= */

const keyState = (m) => `state:${m}`;
const keyAuto = (m) => `scan:auto:${m}`;
const keyLock = (m) => `scan:lock:${m}`;

/* ================= LOCK ================= */

async function acquireLock(key) {
  return await kv.set(key, { ts: Date.now() }, { nx: true, ex: 60 });
}

/* ================= MAIN ================= */

export default async function handler(req, res) {
  const mode =
    String(req.query?.mode || "bull").toLowerCase() === "bear"
      ? "bear"
      : "bull";

  const now = Date.now();

  try {
    const lock = await acquireLock(keyLock(mode));
    if (!lock) return res.json({ ok: true, skipped: true });

    /* ===== FETCH ===== */

    let universe = await fetchUniverse();

    // 🔥 HARD FAILSAFE: gebruik oude state als API faalt
    if (!universe.length) {
      console.error("⚠️ FALLBACK: using previous state");

      const prev = await kv.get(keyState(mode));

      if (prev) {
        return res.json({
          ok: true,
          fallback: true,
          ...prev,
        });
      }

      // als niks bestaat → return lege maar geen crash
      return res.json({
        ok: true,
        fallback: true,
        funnel: { radar: [], warmup: [], setup: [], entry_ready: [] },
      });
    }

    /* ===== BTC ===== */

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

    /* ===== FUNNEL ===== */

    const funnel = {
      radar: [],
      warmup: [],
      setup: [],
      entry_ready: [],
    };

    let processed = 0;

    for (const coin of universe) {
      if (processed++ > 250) break;

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

      if (stage >= 3) {
        try {
          const ob = await fetchOrderbook(symbol + "USDT");

          if (orderbookPass(ob, thresholds)) {
            tradePlan = buildTradePlan({
              price,
              range24: btcData.range24,
              regime: regime?.regime,
              side: mode === "bear" ? "SHORT" : "LONG",
            });
          }
        } catch {
          // ignore OB failure
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

    await kv.set(keyState(mode), payload, { ex: 21600 });

    await kv.set(keyAuto(mode), {
      lastRun: now,
      nextDue: now + 900000,
    });

    return res.json(payload);
  } catch (e) {
    console.error("SCAN_FATAL:", e);

    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  } finally {
    await kv.del(keyLock(mode));
  }
}