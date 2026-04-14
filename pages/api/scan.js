import { kv } from "@vercel/kv";
import { computeBtcRegime } from "../../lib/regimeEngine";
import { adaptiveThresholds } from "../../lib/adaptiveEngine";
import { computeAiScore } from "../../lib/aiEngine";
import { progressiveStage } from "../../lib/funnelEngine";
import { fetchOrderbook, orderbookPass } from "../../lib/orderbookEngine";
import { buildTradePlan } from "../../lib/tradePlanEngine";
import { executeTrade } from "../../lib/tradeEngine";

export const config = { runtime: "nodejs" };

/* ================= SECURITY ================= */

function isAuthorized(req) {
  const token = process.env.CRON_SECRET;
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

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

async function acquireLock(key, ttl = 60) {
  return await kv.set(key, { ts: Date.now() }, { nx: true, ex: ttl });
}

/* ================= KV KEYS ================= */

const keyAuto = (m) => `scan:auto:${m}`;
const keyLock = (m) => `scan:lock:${m}`;
const keyProgress = (m) => `progress:${m}`;
const keyState = (m) => `state:${m}`;
const keyLatest = (m) => `latest:${m}`;

/* ================= MAIN ================= */

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false });
  }

  const t0 = Date.now();

  const mode =
    String(req.query?.mode || "bull").toLowerCase() === "bear"
      ? "bear"
      : "bull";

  const side = mode === "bear" ? "SHORT" : "LONG";
  const now = Date.now();

  const SCAN_INTERVAL_MS = 900000;
  const MAX_COINS = 120;
  const AUTO_MAX_PER_SCAN = 3;

  try {
    const auto = (await kv.get(keyAuto(mode))) || {};

    if (auto?.nextDue && now < auto.nextDue) {
      return res.json({ ok: true, skipped: true });
    }

    const lock = await acquireLock(keyLock(mode));
    if (!lock) return res.json({ ok: true, skipped: true });

    /* ===== FETCH MARKET ===== */

    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=${MAX_COINS}` +
      `&sparkline=false&price_change_percentage=24h`;

    const universe = await fetchJsonSafe(url);

    const btcRow = universe.find((c) => c.id === "bitcoin");

    const btcData = {
      price: n(btcRow.current_price),
      change24: n(btcRow.price_change_percentage_24h),
      range24:
        n(btcRow.low_24h) > 0
          ? ((btcRow.high_24h - btcRow.low_24h) / btcRow.low_24h) * 100
          : 0,
    };

    const regimeData = computeBtcRegime(btcData);
    const thresholds = adaptiveThresholds(regimeData?.regime);

    const prevState = (await kv.get(keyProgress(mode))) || {};
    const nextState = {};

    const funnel = {
      radar: [],
      warmup: [],
      setup: [],
      entry_ready: [],
    };

    /* ===== SCAN LOOP ===== */

    for (const coin of universe) {
      const symbol = up(coin.symbol);
      if (!symbol || symbol.includes("USD")) continue;

      const price = n(coin.current_price);
      const mom24 = n(coin.price_change_percentage_24h);

      const passes =
        (mode === "bull" ? mom24 > 0 : mom24 < 0) &&
        Math.abs(mom24) >= 2 &&
        n(coin.total_volume) > 2_000_000;

      const prog = progressiveStage({
        prev: prevState[symbol],
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
            regime: regimeData?.regime,
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
        updatedAt: now,
      };

      nextState[symbol] = obj;

      if (prog.stage === 0) funnel.radar.push(obj);
      if (prog.stage === 1) funnel.warmup.push(obj);
      if (prog.stage === 2) funnel.setup.push(obj);
      if (prog.stage === 3 && tradePlan) funnel.entry_ready.push(obj);
    }

    funnel.entry_ready.sort((a, b) => b.aiScore - a.aiScore);

    /* ===== EXECUTION (NU CORRECT BINNEN HANDLER) ===== */

    let executed = 0;

    for (const coin of funnel.entry_ready) {
      if (executed >= AUTO_MAX_PER_SCAN) break;

      const result = await executeTrade(mode, coin, {
        maxOpen: 5,
        maxSpreadPct: thresholds?.spreadMaxPct ?? 2,
        minDepthUsd1p: thresholds?.depthMinUsd ?? 800,
      });

      if (result?.opened) {
        executed++;
      }
    }

    /* ===== SAVE ===== */

    await kv.set(keyProgress(mode), nextState, { ex: 86400 });

    const payload = {
      ok: true,
      mode,
      ts: now,
      regime: regimeData,
      funnel,
      autoExecuted: executed,
      scanIntervalMinutes: 15,
      ms: Date.now() - t0,
    };

    await kv.set(keyState(mode), payload, { ex: 21600 });
    await kv.set(keyLatest(mode), payload, { ex: 3600 });

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