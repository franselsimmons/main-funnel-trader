import { kv } from "@vercel/kv";
import { computeBtcRegime } from "../../lib/regimeEngine";
import { adaptiveThresholds } from "../../lib/adaptiveEngine";
import { computeAiScore } from "../../lib/aiEngine";
import { progressiveStage } from "../../lib/funnelEngine";
import { fetchOrderbook, orderbookPass } from "../../lib/orderbookEngine";
import { buildTradePlan } from "../../lib/tradePlanEngine";
import { executeTrade } from "../../lib/tradeengine";

export const config = { runtime: "nodejs" };

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

async function fetchJsonSafe(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "CryptoCrocScanner/3.0",
      },
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

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let idx = 0;

  async function worker() {
    while (idx < list.length) {
      const i = idx++;
      try {
        out[i] = await fn(list[i], i);
      } catch {
        out[i] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
  await Promise.all(workers);
  return out;
}

function safeObSymbol(symbol) {
  const s = up(symbol);
  if (s.endsWith("USDT")) return s;
  return `${s}USDT`;
}

const keyAuto = (m) => `scan:auto:${m}`;
const keyLock = (m) => `scan:lock:${m}`;
const keyProgress = (m) => `progress:${m}`;
const keyState = (m) => `state:${m}`;
const keyLatest = (m) => `latest:${m}`;

export default async function handler(req, res) {
  const t0 = Date.now();

  const mode =
    String(req.query?.mode || "bull").toLowerCase() === "bear"
      ? "bear"
      : "bull";

  const side = mode === "bear" ? "SHORT" : "LONG";
  const now = Date.now();

  const SCAN_INTERVAL_MS = 120000;
  const LOCK_TTL_SEC = 55;

  const MAX_COINS = 120;
  const OB_CANDIDATES = 20;
  const OB_CONCURRENCY = 5;
  const SOFT_TIME_BUDGET_MS = 8000;

  const AUTO_MAX_PER_SCAN = 3;

  try {
    const auto = (await kv.get(keyAuto(mode))) || {};
    if (auto?.nextDue && now < auto.nextDue) {
      return res.json({
        ok: true,
        skipped: true,
        reason: "not_due",
      });
    }

    const lock = await kv.set(
      keyLock(mode),
      { ts: now },
      { nx: true, ex: LOCK_TTL_SEC }
    );

    if (!lock) {
      return res.json({ ok: true, skipped: true, reason: "locked" });
    }

    /* ================= FETCH UNIVERSE ================= */

    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=${MAX_COINS}` +
      `&page=1&sparkline=false&price_change_percentage=1h,24h`;

    const universe = await fetchJsonSafe(url, 11000);

    const btcRow = universe.find((c) => c?.id === "bitcoin");
    if (!btcRow) throw new Error("btc_missing");

    const btcData = {
      price: n(btcRow.current_price),
      change24: n(btcRow.price_change_percentage_24h),
      range24:
        n(btcRow.low_24h) > 0 && n(btcRow.high_24h) > 0
          ? ((btcRow.high_24h - btcRow.low_24h) / btcRow.low_24h) * 100
          : 0,
    };

    const regimeData = computeBtcRegime(btcData);
    const thresholds = adaptiveThresholds(regimeData?.regime);

    const prevState = (await kv.get(keyProgress(mode))) || {};
    const nextState = {};
    const preRows = [];

    /* ================= PRE-SCORE ================= */

    for (const coin of universe) {
      const symbol = up(coin?.symbol);
      if (!symbol || symbol.includes("USD")) continue;

      const price = n(coin.current_price);
      if (!price) continue;

      const mom24 = n(coin.price_change_percentage_24h);
      const volume = n(coin.total_volume);
      const mcap = n(coin.market_cap);

      const volAcc = volume / 1_000_000;
      const directional =
        mode === "bull" ? mom24 > 0 : mom24 < 0;

      const passes =
        directional &&
        Math.abs(mom24) >= 2 &&
        volAcc >= 2 &&
        mcap >= 5_000_000;

      const prog = progressiveStage({
        prev: prevState[symbol],
        passes,
        now,
        mode,
        regime: regimeData?.regime,
      });

      preRows.push({
        symbol,
        coin,
        price,
        mom24,
        volume,
        mcap,
        volAcc,
        prog,
      });
    }

    /* ================= ORDERBOOK ================= */

    const obCandidates = preRows
      .filter((r) => n(r.prog?.stage) >= 2)
      .slice(0, OB_CANDIDATES);

    const obMap = new Map();

    await mapLimit(obCandidates, OB_CONCURRENCY, async (row) => {
      if (Date.now() - t0 > SOFT_TIME_BUDGET_MS) {
        obMap.set(row.symbol, null);
        return;
      }

      const ob = await fetchOrderbook(
        safeObSymbol(row.symbol)
      );
      obMap.set(row.symbol, ob || null);
    });

    /* ================= FINALIZE ================= */

    for (const row of preRows) {
      let prog = row.prog;
      let ob = null;
      let tradePlan = null;

      if (n(prog.stage) >= 3) {
        ob = obMap.get(row.symbol) || null;

        if (orderbookPass(ob, thresholds)) {
          tradePlan = buildTradePlan({
            price: row.price,
            range24: btcData.range24,
            regime: regimeData?.regime,
            side,
          });
        } else {
          prog = { ...prog, stage: 2 };
        }
      }

      const aiScore = computeAiScore({
        momentum24: row.mom24,
        volAcc: row.volAcc,
        rr: n(tradePlan?.rr, 1),
        marketCap: row.mcap,
        volume: row.volume,
      });

      nextState[row.symbol] = {
        symbol: row.symbol,
        name: row.coin?.name || "",
        image: row.coin?.image || "",
        side,
        price: row.price,
        change24: row.mom24,
        volume: row.volume,
        marketCap: row.mcap,
        volAcc: row.volAcc,
        aiScore,
        stage: prog.stage,
        streak: prog.streak,
        tradePlan,
        ob,
        updatedAt: now,
      };
    }

    /* ================= BUILD FUNNEL ================= */

    const funnel = { radar: [], warmup: [], setup: [], entry_ready: [] };

    for (const c of Object.values(nextState)) {
      if (c.stage === 0) funnel.radar.push(c);
      else if (c.stage === 1) funnel.warmup.push(c);
      else if (c.stage === 2) funnel.setup.push(c);
      else if (c.stage === 3) funnel.entry_ready.push(c);
    }

    /* ================= AUTO EXECUTION ================= */

    let executed = 0;

    for (const coin of funnel.entry_ready) {
      if (executed >= AUTO_MAX_PER_SCAN) break;
      if (!coin.tradePlan) continue;

      const result = await executeTrade(mode, coin, {
        maxOpen: 3,
        entryTolerancePct: 4,
        maxSpreadPct: 1.8,
        minDepthUsd1p: 800,
      });

      if (result?.opened) executed++;
    }

    /* ================= SAVE ================= */

    await kv.set(keyProgress(mode), nextState, { ex: 259200 });

    const statePayload = {
      ok: true,
      mode,
      ts: now,
      regime: regimeData,
      funnel,
      counts: {
        radar: funnel.radar.length,
        warmup: funnel.warmup.length,
        setup: funnel.setup.length,
        entry_ready: funnel.entry_ready.length,
      },
      autoExecuted: executed,
      ms: Date.now() - t0,
    };

    await kv.set(keyState(mode), statePayload, { ex: 21600 });
    await kv.set(keyLatest(mode), statePayload, { ex: 3600 });

    await kv.set(
      keyAuto(mode),
      { lastRun: now, nextDue: now + SCAN_INTERVAL_MS },
      { ex: 86400 }
    );

    return res.json(statePayload);
  } catch (e) {
    console.error("SCAN_FATAL:", e);
    return res.json({ ok: false, error: String(e?.message || e) });
  } finally {
    try {
      await kv.del(keyLock(mode));
    } catch {}
  }
}