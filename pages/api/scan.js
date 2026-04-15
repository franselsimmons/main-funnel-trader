import { kv } from "@vercel/kv";
import { computeBtcRegime } from "../../lib/regimeEngine";
import { adaptiveThresholds } from "../../lib/adaptiveEngine";
import { computeAiScore } from "../../lib/aiEngine";
import { progressiveStage } from "../../lib/funnelEngine";
import { fetchOrderbook, orderbookPass } from "../../lib/orderbookEngine";
import { buildTradePlan } from "../../lib/tradePlanEngine";
import { executeTrade } from "../../lib/tradeEngine";

export const config = { runtime: "nodejs" };

/* ================= HELPERS ================= */

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

async function fetchJsonSafe(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    const text = await r.text();
    const json = JSON.parse(text);

    if (!r.ok) throw new Error(`HTTP_${r.status}`);
    return json;
  } finally {
    clearTimeout(id);
  }
}

async function acquireLock(key) {
  return await kv.set(key, { ts: Date.now() }, { nx: true, ex: 60 });
}

/* ================= FETCH UNIVERSE ================= */

async function fetchUniverse() {
  const pages = 3; // 🔥 ~300 coins
  const perPage = 100;

  const results = [];

  for (let page = 1; page <= pages; page++) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd` +
      `&order=market_cap_desc` +
      `&per_page=${perPage}` +
      `&page=${page}` +
      `&sparkline=false` +
      `&price_change_percentage=24h`;

    try {
      const data = await fetchJsonSafe(url);
      if (Array.isArray(data)) {
        results.push(...data);
      }
    } catch (e) {
      console.warn("fetch page failed:", page);
    }
  }

  return results;
}

/* ================= KV KEYS ================= */

const keyAuto = (m) => `scan:auto:${m}`;
const keyLock = (m) => `scan:lock:${m}`;
const keyProgress = (m) => `progress:${m}`;
const keyState = (m) => `state:${m}`;

/* ================= MAIN ================= */

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
  const MAX_PROCESS = 250; // 🔥 safety cap

  try {
    const auto = (await kv.get(keyAuto(mode))) || {};

    // 🔥 FAILSAFE (no stuck scans)
    if (auto?.nextDue && now < auto.nextDue) {
      const stuck = now - n(auto.lastRun, 0) > MAX_DELAY;
      if (!stuck) {
        return res.json({ ok: true, skipped: true });
      }
      console.warn("FORCE SCAN:", mode);
    }

    const lock = await acquireLock(keyLock(mode));
    if (!lock) return res.json({ ok: true, skipped: true });

    /* ===== FETCH ===== */

    const universe = await fetchUniverse();

    if (!universe.length) {
      throw new Error("empty_universe");
    }

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

    const prev = (await kv.get(keyProgress(mode))) || {};
    const next = {};

    const funnel = {
      radar: [],
      warmup: [],
      setup: [],
      entry_ready: [],
    };

    let count = 0;

    /* ===== LOOP ===== */

    for (const coin of universe) {
      if (count++ > MAX_PROCESS) break;

      const symbol = up(coin.symbol);
      if (!symbol || symbol.includes("USD")) continue;

      // 🔥 FILTER (voorkomt troep)
      if (n(coin.market_cap) < 5_000_000) continue;
      if (n(coin.total_volume) < 1_000_000) continue;

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
        ob,
        updatedAt: now,
      };

      next[symbol] = obj;

      if (prog.stage === 0) funnel.radar.push(obj);
      if (prog.stage === 1) funnel.warmup.push(obj);
      if (prog.stage === 2) funnel.setup.push(obj);
      if (prog.stage === 3 && tradePlan) funnel.entry_ready.push(obj);
    }

    /* ===== SORT ===== */

    funnel.entry_ready.sort((a, b) => b.aiScore - a.aiScore);

    /* ===== EXECUTE ===== */

    let executed = 0;

    for (const coin of funnel.entry_ready) {
      if (executed >= 3) break;

      const result = await executeTrade(mode, coin, {
        ob: coin.ob,
      });

      if (result?.opened) {
        executed++;
      }
    }

    /* ===== SAVE ===== */

    const payload = {
      ok: true,
      mode,
      ts: now,
      regime,
      funnel,
      autoExecuted: executed,
      scanIntervalMinutes: 15,
      ms: Date.now() - t0,
    };

    await kv.set(keyProgress(mode), next, { ex: 86400 });
    await kv.set(keyState(mode), payload, { ex: 21600 });

    await kv.set(keyAuto(mode), {
      lastRun: now,
      nextDue: now + SCAN_INTERVAL_MS,
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