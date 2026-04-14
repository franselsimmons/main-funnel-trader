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
 * Stage mapping (progressief):
 * 0 = RADAR
 * 1 = WARMUP
 * 2 = SETUP
 * 3 = ENTRY_READY
 *
 * Belangrijk:
 * - Stage stijgt alleen als coin "passes" meerdere scans achter elkaar.
 * - Stage kan zakken als "passes" faalt of (bij stage 3) orderbook faalt.
 *
 * progressiveStage(...) is jouw centrale state machine.
 * Je funnelEngine bepaalt streak regels (bv. 2x = warmup, 3x = setup, 4x = entry_ready).
 */

export default async function handler(req, res) {
  const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const side = mode === "bear" ? "SHORT" : "LONG";
  const now = Date.now();

  try {
    // ======================
    // PERFORMANCE / LIMITS
    // ======================
    const MAX_COINS = 200;            // meer coins = meer kansen, maar houd runtimes in de gaten
    const OB_CANDIDATES = 60;         // alleen top setup coins krijgen orderbook check
    const OB_CONCURRENCY = 8;         // parallel OB calls
    const KV_EX_PROGRESS_SEC = 60 * 60 * 24 * 3;  // 3 dagen
    const KV_EX_STATE_SEC = 60 * 60 * 6;          // 6 uur
    const KV_EX_LATEST_SEC = 60 * 60;             // 1 uur

    // ======================
    // 1️⃣ FETCH UNIVERSE (CG)
    // ======================
    // Let op: CoinGecko kan 250 max per page.
    // We nemen market_cap_desc omdat je “beste coins” wil, maar wel veel.
    const universeUrl =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=${Math.min(MAX_COINS, 250)}&page=1` +
      `&sparkline=false&price_change_percentage=1h,24h`;

    const universe = await fetchJsonWithTimeout(universeUrl, 12000);
    if (!Array.isArray(universe)) throw new Error("universe_not_array");

    // BTC regime: haal bitcoin row uit universe (of fallback)
    let btcRow = universe.find((c) => String(c?.id || "") === "bitcoin");

    // Fallback: aparte BTC call als BTC ontbreekt in lijst (komt zelden voor, maar safe)
    if (!btcRow) {
      const btcUrl =
        `https://api.coingecko.com/api/v3/coins/markets` +
        `?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1` +
        `&sparkline=false&price_change_percentage=1h,24h`;
      const btcArr = await fetchJsonWithTimeout(btcUrl, 9000);
      btcRow = Array.isArray(btcArr) && btcArr[0] ? btcArr[0] : null;
    }

    const btcData = {
      change24: n(
        btcRow?.price_change_percentage_24h_in_currency ??
          btcRow?.price_change_percentage_24h,
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
    // 2️⃣ LOAD PREVIOUS STATE
    // ======================
    // progress:${mode} bevat per symbol de stage + streak + context
    const prevState = (await kv.get(`progress:${mode}`)) || {};
    const nextState = {};

    // ======================
    // 3️⃣ PRE-SCORE COINS (zonder OB)
    // ======================
    // Doel: snel bepalen wie in aanmerking komt om te groeien.
    // Je wil niet direct alles in setup/entry_ready:
    // -> progressiveStage regelt dat op basis van streak.
    const preRows = [];

    for (const coin of universe) {
      const symbol = up(coin?.symbol);
      if (!symbol) continue;

      // filter stablecoins uit (anders vullen ze radar)
      const isStableLike =
        symbol.includes("USD") ||
        ["USDT", "USDC", "DAI", "TUSD", "FDUSD", "USDE", "PYUSD", "USDS"].includes(symbol);

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

      // simpele “vol acc” proxy voor progressive funnel
      // (beter: rolling vol hist — maar jij wilt nu met huidige bestanden)
      const volAcc = volume / 1_000_000; // schaalbaar; thresholds.volAccMin moet hierop afgestemd zijn

      // compressie proxy (hier kun je later echte flat60Pct in bouwen)
      const compression = Math.abs(momentum24) < n(thresholds?.compressionMaxAbs24 ?? 4, 4);

      // directioneel per mode
      const directional = mode === "bull" ? momentum24 > 0 : momentum24 < 0;

      // basis pass: direction + min momentum + volacc
      // LET OP: dit is expres NIET “super streng”, want growth wordt door streak geregeld.
      const passes =
        directional &&
        Math.abs(momentum24) >= n(thresholds?.momMinAbs24 ?? (n(thresholds?.confMin, 24) / 12), 2) &&
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

      // NOTE: prog.stage is 0..3
      // We gaan nu nog geen orderbook doen; dat pas bij stage 3 candidates selectie.
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
    // 4️⃣ SELECT OB CANDIDATES (alleen setup->entry_ready/entry_ready)
    // ======================
    // We willen OB calls beperken:
    // - Alleen coins die al “hoog” zitten of dichtbij entry_ready zijn.
    // - Rank op (stage, streak, ai/quality proxy)
    const obCandidates = preRows
      .filter((r) => r.prog?.stage >= 2) // setup of hoger
      .sort((a, b) => {
        // eerst stage, dan streak, dan momentum/volume
        const sd = n(b.prog?.stage) - n(a.prog?.stage);
        if (sd) return sd;
        const st = n(b.prog?.streak) - n(a.prog?.streak);
        if (st) return st;
        const md = Math.abs(n(b.momentum24)) - Math.abs(n(a.momentum24));
        if (md) return md;
        return n(b.volume) - n(a.volume);
      })
      .slice(0, OB_CANDIDATES);

    // fetch orderbooks parallel (maar gecontroleerd)
    const obMap = new Map();

    await mapLimit(obCandidates, OB_CONCURRENCY, async (row) => {
      // jouw orderbookEngine verwacht symbol (soms "BTCUSDT" of "BTC")
      // we gebruiken symbol als basis (jij gebruikt fetchOrderbook(symbol))
      const ob = await fetchOrderbook(row.symbol);
      obMap.set(row.symbol, ob);
    });

    // ======================
    // 5️⃣ BUILD FINAL STATE (met OB + trade plan alleen bij ENTRY_READY)
    // ======================
    for (const row of preRows) {
      const {
        symbol,
        coin,
        price,
        momentum24,
        momentum1h,
        volume,
        marketCap,
        volAcc,
        compression,
      } = row;

      let prog = row.prog || { stage: 0, streak: 0 };

      let ob = null;
      let tradePlan = null;

      // Alleen stage 3 = ENTRY_READY wil OB hard gate + tradeplan
      // Maar: als prog.stage == 3 en OB faalt -> demote naar 2
      if (n(prog.stage) >= 3) {
        ob = obMap.get(symbol) || null;

        const pass = orderbookPass(ob, thresholds);

        if (pass) {
          tradePlan = buildTradePlan({
            price,
            // jij gebruikte btcData.range24, maar dat is BTC range.
            // Voor SL/TP adaptief is coin-range beter.
            // We hebben coin-range niet in universeUrl; daarom:
            // -> gebruik BTC range + momentum als proxy (later kun je coin high/low toevoegen).
            range24: n(btcData.range24, 0),
            regime: regimeData?.regime,
            side,
            mode,
            thresholds,
          });
        } else {
          // OB faalt => terug naar SETUP
          prog = { ...prog, stage: 2 };
        }
      }

      // AI ranking: combineer momentum/volAcc/compression + ob + rr
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
        momentum24: n(momentum24, 0),
        momentum1h: n(momentum1h, 0),
        volume: n(volume, 0),
        marketCap: n(marketCap, 0),

        // funnel metrics
        volAcc: n(volAcc, 0),
        compression: !!compression,

        // scores
        aiScore: n(aiScore, 0),

        // progressive funnel state
        stage: n(prog.stage, 0),       // 0..3
        streak: n(prog.streak, 0),
        passes: !!row.passes,

        // execution artifacts
        tradePlan: tradePlan || null,
        ob: ob || null,

        // meta
        updatedAt: now,
      };
    }

    // ======================
    // 6️⃣ BUILD FUNNEL ARRAYS
    // ======================
    const funnel = {
      radar: [],
      warmup: [],
      setup: [],
      entry_ready: [],
    };

    for (const c of Object.values(nextState)) {
      if (c.stage === 0) funnel.radar.push(c);
      else if (c.stage === 1) funnel.warmup.push(c);
      else if (c.stage === 2) funnel.setup.push(c);
      else if (c.stage === 3) funnel.entry_ready.push(c);
    }

    // rank per bucket
    for (const k of Object.keys(funnel)) {
      funnel[k].sort((a, b) => n(b.aiScore) - n(a.aiScore));
    }

    // hard caps (zodat UI niet overloaded wordt)
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
    // 7️⃣ PERSIST (belangrijk!)
    // ======================
    // progress:${mode} = volledige map voor progressiveStage
    // state:${mode} = funnel snapshot voor UI + trade engine
    await kv.set(`progress:${mode}`, nextState, { ex: KV_EX_PROGRESS_SEC });

    await kv.set(
      `state:${mode}`,
      {
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
      },
      { ex: KV_EX_STATE_SEC }
    );

    // optional "latest" key voor simpele frontend calls
    await kv.set(
      `latest:${mode}`,
      {
        ok: true,
        mode,
        ts: now,
        regime: regimeData,
        counts: {
          radar: funnel.radar.length,
          warmup: funnel.warmup.length,
          setup: funnel.setup.length,
          entry_ready: funnel.entry_ready.length,
        },
      },
      { ex: KV_EX_LATEST_SEC }
    );

    // ======================
    // RESPONSE
    // ======================
    res.json({
      ok: true,
      mode,
      regime: regimeData,
      ts: now,
      counts: {
        radar: funnel.radar.length,
        warmup: funnel.warmup.length,
        setup: funnel.setup.length,
        entry_ready: funnel.entry_ready.length,
      },
      limits,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}