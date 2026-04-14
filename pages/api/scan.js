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
function up(x) {
  return String(x || "").toUpperCase();
}
function arr(x) {
  return Array.isArray(x) ? x : [];
}

async function fetchJsonWithTimeout(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
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
      out[i] = await fn(list[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
  await Promise.all(workers);
  return out;
}

/**
 * AUTO-SCAN / SELF-SCHEDULING
 * - nextDue: wanneer een nieuwe scan mag draaien
 * - lock: voorkomt dubbele runs
 */
function keyAuto(mode) {
  return `scan:auto:${mode}`;
}
function keyLock(mode) {
  return `scan:lock:${mode}`;
}
function keyProgress(mode) {
  return `progress:${mode}`;
}
function keyState(mode) {
  return `state:${mode}`;
}
function keyLatest(mode) {
  return `latest:${mode}`;
}

export default async function handler(req, res) {
  const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const side = mode === "bear" ? "SHORT" : "LONG";
  const now = Date.now();

  // tuning
  const SCAN_INTERVAL_MS = 60_000; // elke 60s (self schedule)
  const LOCK_TTL_SEC = 55; // lock blijft max 55s
  const force = String(req.query?.force || "") === "1";

  try {
    // ======================
    // 0) SELF-SCHEDULE GATE
    // ======================
    const auto = (await kv.get(keyAuto(mode))) || {};
    const nextDue = n(auto?.nextDue, 0);

    if (!force && nextDue && now < nextDue) {
      // nog niet due -> snelle response
      return res.json({
        ok: true,
        skipped: true,
        reason: "not_due",
        mode,
        now,
        nextDue,
        waitMs: Math.max(0, nextDue - now),
      });
    }

    // ======================
    // 0b) ACQUIRE LOCK
    // ======================
    const lockOk = await kv.set(
      keyLock(mode),
      { ts: now, mode },
      { nx: true, ex: LOCK_TTL_SEC }
    );

    if (!lockOk) {
      const cur = await kv.get(keyLock(mode));
      return res.json({
        ok: true,
        skipped: true,
        reason: "locked",
        mode,
        lock: cur || null,
      });
    }

    // ensure lock released by TTL anyway, but we also try to clean up at end.
    // ======================
    // PERFORMANCE / LIMITS
    // ======================
    const MAX_COINS = 200;
    const OB_CANDIDATES = 60;
    const OB_CONCURRENCY = 8;

    const KV_EX_PROGRESS_SEC = 60 * 60 * 24 * 3; // 3 dagen
    const KV_EX_STATE_SEC = 60 * 60 * 6; // 6 uur
    const KV_EX_LATEST_SEC = 60 * 60; // 1 uur

    // ======================
    // 1) FETCH UNIVERSE (CG)
    // ======================
    const universeUrl =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=${Math.min(MAX_COINS, 250)}&page=1` +
      `&sparkline=false&price_change_percentage=1h,24h`;

    const universe = await fetchJsonWithTimeout(universeUrl, 12000);
    if (!Array.isArray(universe)) throw new Error("universe_not_array");

    // BTC row
    let btcRow = universe.find((c) => String(c?.id || "") === "bitcoin");

    if (!btcRow) {
      const btcUrl =
        `https://api.coingecko.com/api/v3/coins/markets` +
        `?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1` +
        `&sparkline=false&price_change_percentage=1h,24h`;
      const btcArr = await fetchJsonWithTimeout(btcUrl, 9000);
      btcRow = Array.isArray(btcArr) && btcArr[0] ? btcArr[0] : null;
    }

    const btcData = {
      price: n(btcRow?.current_price, 0),
      change24: n(
        btcRow?.price_change_percentage_24h_in_currency ??
          btcRow?.price_change_percentage_24h,
        0
      ),
      change1h: n(
        btcRow?.price_change_percentage_1h_in_currency ??
          btcRow?.price_change_percentage_1h,
        0
      ),
      range24:
        n(btcRow?.low_24h, 0) > 0 && n(btcRow?.high_24h, 0) > 0
          ? ((n(btcRow.high_24h) - n(btcRow.low_24h)) / n(btcRow.low_24h)) * 100
          : 0,
    };

    const regimeData = computeBtcRegime(btcData);
    const thresholds = adaptiveThresholds(regimeData?.regime);

    // ======================
    // 2) LOAD PREVIOUS STATE
    // ======================
    const prevState = (await kv.get(keyProgress(mode))) || {};
    const nextState = {};

    // ======================
    // 3) PRE-SCORE (NO OB)
    // ======================
    const preRows = [];

    for (const coin of universe) {
      const symbol = up(coin?.symbol);
      if (!symbol) continue;

      // filter stablecoins (veel noise)
      const isStableLike =
        symbol.includes("USD") ||
        ["USDT", "USDC", "DAI", "TUSD", "FDUSD", "USDE", "PYUSD", "USDS", "USD1"].includes(symbol);

      if (isStableLike) continue;

      const price = n(coin?.current_price, 0);
      if (!(price > 0)) continue;

      const momentum24 = n(
        coin?.price_change_percentage_24h_in_currency ??
          coin?.price_change_percentage_24h,
        0
      );

      const momentum1h = n(
        coin?.price_change_percentage_1h_in_currency ??
          coin?.price_change_percentage_1h,
        0
      );

      const volume = n(coin?.total_volume, 0);
      const marketCap = n(coin?.market_cap, 0);

      // volume acceleration proxy
      const volAcc = volume / 1_000_000;

      // compression proxy
      const compression = Math.abs(momentum24) < n(thresholds?.compressionMaxAbs24 ?? 4, 4);

      // direction per mode
      const directional = mode === "bull" ? momentum24 > 0 : momentum24 < 0;

      // not too strict — streak decides growth
      const passes =
        directional &&
        Math.abs(momentum24) >= n(thresholds?.momMinAbs24 ?? 2, 2) &&
        volAcc >= n(thresholds?.volAccMin ?? 2, 2) &&
        marketCap >= n(thresholds?.mcapMin ?? 5_000_000, 5_000_000);

      const prev = prevState?.[symbol];

      const prog = progressiveStage({
        prev,
        passes,
        now,
        mode,
        regime: regimeData?.regime,
      });

      preRows.push({
        symbol,
        price,
        momentum24,
        momentum1h,
        volume,
        marketCap,
        volAcc,
        compression,
        passes,
        prog,
        prev,
        coin,
      });
    }

    // ======================
    // 4) SELECT OB CANDIDATES
    // ======================
    const obCandidates = preRows
      .filter((r) => n(r.prog?.stage, 0) >= 2) // setup+
      .sort((a, b) => {
        const sd = n(b.prog?.stage) - n(a.prog?.stage);
        if (sd) return sd;
        const st = n(b.prog?.streak) - n(a.prog?.streak);
        if (st) return st;
        const md = Math.abs(n(b.momentum24)) - Math.abs(n(a.momentum24));
        if (md) return md;
        return n(b.volume) - n(a.volume);
      })
      .slice(0, OB_CANDIDATES);

    const obMap = new Map();

    await mapLimit(obCandidates, OB_CONCURRENCY, async (row) => {
      const ob = await fetchOrderbook(row.symbol);
      obMap.set(row.symbol, ob);
    });

    // ======================
    // 5) FINALIZE STATE (OB+PLAN at stage 3)
    // ======================
    for (const row of preRows) {
      const { symbol, coin, price, momentum24, momentum1h, volume, marketCap, volAcc, compression } =
        row;

      let prog = row.prog || { stage: 0, streak: 0 };

      let ob = null;
      let tradePlan = null;

      if (n(prog.stage) >= 3) {
        ob = obMap.get(symbol) || null;

        const pass = orderbookPass(ob, thresholds);

        if (pass) {
          tradePlan = buildTradePlan({
            price,
            range24: n(btcData.range24, 0),
            regime: regimeData?.regime,
            side,
            mode,
            thresholds,
          });
        } else {
          // fail liquidity -> demote
          prog = { ...prog, stage: 2 };
        }
      }

      const aiScore = computeAiScore({
        mode,
        regime: regimeData?.regime,
        momentum24,
        momentum1h,
        volAcc,
        compression,
        obScore: n(ob?.imbalance ?? ob?.score ?? 0, 0),
        spreadPct: n(ob?.spreadPct ?? ob?.spread ?? 999, 999),
        depth: n(ob?.depthMin ?? ob?.depthMinUsd ?? ob?.depthMinUsd1p ?? 0, 0),
        rr: n(tradePlan?.rr, 1),
        marketCap,
        volume,
      });

      nextState[symbol] = {
        symbol,
        name: String(coin?.name || ""),
        image: String(coin?.image || ""),
        side,

        price: n(price, 0),
        change24: n(momentum24, 0),
        change1h: n(momentum1h, 0),
        volume: n(volume, 0),
        marketCap: n(marketCap, 0),

        vm: marketCap > 0 ? volume / marketCap : 0,

        // funnel metrics
        volAcc: n(volAcc, 0),
        compression: !!compression,

        // scores
        aiScore: n(aiScore, 0),

        // progressive state
        stage: n(prog.stage, 0),
        streak: n(prog.streak, 0),
        passes: !!row.passes,

        // execution artifacts
        tradePlan: tradePlan || null,
        ob: ob || null,

        updatedAt: now,
      };
    }

    // ======================
    // 6) BUILD FUNNEL
    // ======================
    const funnel = { radar: [], warmup: [], setup: [], entry_ready: [] };

    for (const c of Object.values(nextState)) {
      if (c.stage === 0) funnel.radar.push(c);
      else if (c.stage === 1) funnel.warmup.push(c);
      else if (c.stage === 2) funnel.setup.push(c);
      else if (c.stage === 3) funnel.entry_ready.push(c);
    }

    for (const k of Object.keys(funnel)) {
      funnel[k].sort((a, b) => n(b.aiScore) - n(a.aiScore));
    }

    const limits = {
      radar: n(thresholds?.uiRadarLimit ?? 120, 120),
      warmup: n(thresholds?.uiWarmupLimit ?? 80, 80),
      setup: n(thresholds?.uiSetupLimit ?? 60, 60),
      entry_ready: n(thresholds?.uiEntryLimit ?? 30, 30),
    };

    funnel.radar = funnel.radar.slice(0, limits.radar);
    funnel.warmup = funnel.warmup.slice(0, limits.warmup);
    funnel.setup = funnel.setup.slice(0, limits.setup);
    funnel.entry_ready = funnel.entry_ready.slice(0, limits.entry_ready);

    // ======================
    // 7) PERSIST
    // ======================
    await kv.set(keyProgress(mode), nextState, { ex: KV_EX_PROGRESS_SEC });

    const statePayload = {
      ok: true,
      mode,
      side,
      ts: now,
      scannedAt: now,
      btc: btcData,
      regime: regimeData,
      thresholds,
      funnel,
      counts: {
        radar: funnel.radar.length,
        warmup: funnel.warmup.length,
        setup: funnel.setup.length,
        entry_ready: funnel.entry_ready.length,
      },
    };

    await kv.set(keyState(mode), statePayload, { ex: KV_EX_STATE_SEC });

    await kv.set(
      keyLatest(mode),
      {
        ok: true,
        mode,
        ts: now,
        regime: regimeData,
        counts: statePayload.counts,
      },
      { ex: KV_EX_LATEST_SEC }
    );

    // ======================
    // 8) UPDATE AUTO SCHEDULE
    // ======================
    await kv.set(
      keyAuto(mode),
      {
        mode,
        lastRun: now,
        nextDue: now + SCAN_INTERVAL_MS,
        intervalMs: SCAN_INTERVAL_MS,
      },
      { ex: 60 * 60 * 24 } // 1 day
    );

    // ======================
    // RESPONSE
    // ======================
    res.json({
      ok: true,
      mode,
      ts: now,
      regime: regimeData,
      counts: statePayload.counts,
      limits,
      auto: {
        nextDue: now + SCAN_INTERVAL_MS,
        intervalMs: SCAN_INTERVAL_MS,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    // best-effort unlock (TTL also exists)
    try {
      await kv.del(keyLock(mode));
    } catch {}
  }
}