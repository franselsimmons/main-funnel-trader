// pages/api/analyze-all.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../../lib/core/settings.js";
import {
  keyMainLatest,
  keyMainPositions,
  keyMainPerformance,
} from "../../lib/keys.js";
import { THRESHOLDS, buildAdaptiveThresholds } from "../../lib/thresholds.js";
import { n, safeArr } from "../../lib/utils/numbers.js";

export const config = RUNTIME_CONFIG;

// -----------------------------
// Helpers
// -----------------------------
function flattenLatest(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeArr(f.radar),
    ...safeArr(f.buildup),
    ...safeArr(f.almost),
    ...safeArr(f.elite_ignition),
    ...safeArr(f.elite_expansion),
    ...safeArr(f.hold),
    ...safeArr(f.sell),
    ...(safeArr(f.entry) || []),
  ];
}

function analyzeCoin(coin, adaptive) {
  const bottlenecks = [];

  const timingScore = n(coin?.timingScore, 0);
  const liquidityScore = n(coin?.liquidityScore, 0);
  const qualityScore = n(coin?.qualityScore, 0);
  const marketScore = n(coin?.marketScore, 0);

  const timingThr = n(adaptive?.timing, THRESHOLDS.timing.current);
  const qualityThr = n(adaptive?.quality, THRESHOLDS.quality.current);
  const marketThr = n(adaptive?.market, THRESHOLDS.market.current);

  if (timingScore < timingThr) bottlenecks.push({ key: "timing", label: "Timing", severity: (timingThr - timingScore) / 10 });
  if (qualityScore < qualityThr) bottlenecks.push({ key: "quality", label: "Quality", severity: (qualityThr - qualityScore) / 10 });
  if (marketScore < marketThr) bottlenecks.push({ key: "market", label: "Market", severity: (marketThr - marketScore) / 10 });
  if (liquidityScore < 60) bottlenecks.push({ key: "liquidity", label: "Liquidity", severity: (60 - liquidityScore) / 10 });

  // Extra (nice-to-have) hints
  const breakoutReady = !!coin?.breakout?.ready;
  const breakoutPressure = n(coin?.breakout?.pressure, 0);
  if (!breakoutReady && breakoutPressure < 52) bottlenecks.push({ key: "breakout", label: "Breakout", severity: (52 - breakoutPressure) / 15 });

  const obScoreAbs = Math.abs(n(coin?.ob?.score, 0));
  const obMin = n(THRESHOLDS.main?.filters?.obScore, 0.008);
  if (obScoreAbs < obMin) bottlenecks.push({ key: "orderbook", label: "Orderbook", severity: (obMin - obScoreAbs) / 0.01 });

  return { bottlenecks };
}

function summarize(coins, name, adaptive) {
  const map = {};
  const arr = safeArr(coins);

  for (const c of arr) {
    const r = analyzeCoin(c, adaptive);
    for (const b of r.bottlenecks) {
      if (!map[b.key]) map[b.key] = { key: b.key, label: b.label, hits: 0, impact: 0 };
      map[b.key].hits += 1;
      map[b.key].impact += n(b.severity, 0);
    }
  }

  const table = Object.values(map)
    .map((x) => ({
      filter: x.label,
      hits: x.hits,
      impact: Number(n(x.impact, 0).toFixed(2)),
      expectedGainPct: Math.min(40, Math.round(n(x.impact, 0) * 12 + x.hits * 0.8)),
    }))
    .sort((a, b) => b.expectedGainPct - a.expectedGainPct);

  return {
    name,
    totalCoins: arr.length,
    topFix: table[0] || null,
    table,
  };
}

function computePerformance(closedTrades) {
  const tradesArr = safeArr(closedTrades);

  if (!tradesArr.length) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 50,
      avgRR: 0,
      drawdown: 0,
      updatedAt: Date.now(),
    };
  }

  let wins = 0;
  let totalRR = 0;

  let equity = 1000;
  let peakEquity = equity;
  let maxDrawdownPct = 0;

  for (const t of tradesArr) {
    const pnlPct = n(t?.pnlPct, 0);
    const rr = n(t?.rr, 0);

    if (pnlPct > 0) wins += 1;
    totalRR += rr;

    equity = equity * (1 + pnlPct / 100);
    peakEquity = Math.max(peakEquity, equity);

    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);
  }

  const trades = tradesArr.length;
  const winRate = trades ? (wins / trades) * 100 : 50;
  const avgRR = trades ? totalRR / trades : 0;

  return {
    trades,
    wins,
    losses: trades - wins,
    winRate: Number(winRate.toFixed(1)),
    avgRR: Number(avgRR.toFixed(2)),
    drawdown: Number(maxDrawdownPct.toFixed(1)),
    updatedAt: Date.now(),
  };
}

const PERF_STALE_MS = 6 * 60 * 60 * 1000; // 6h
const PERF_LOCK_TTL_SEC = 60;

async function maybeUpdatePerformanceOnce() {
  const lockKey = "main:analyzeAll:perf:updateLock";
  const got = await kv.set(lockKey, { ts: Date.now() }, { nx: true, ex: PERF_LOCK_TTL_SEC });
  if (!got) return;

  for (const mode of ["bull", "bear"]) {
    const perfKey = keyMainPerformance(mode) || `main:performance:${mode}`;
    const perf = await kv.get(perfKey);
    const stale = !perf || Date.now() - n(perf.updatedAt, 0) > PERF_STALE_MS;

    if (stale) {
      const positions = (await kv.get(keyMainPositions(mode))) || { open: [], closed: [] };
      const computed = computePerformance(positions?.closed);
      await kv.set(perfKey, computed, { ex: 60 * 60 * 24 * 7 });
    }
  }
}

function pickMeta(latest) {
  const m = latest?.meta || {};
  return {
    regime: latest?.regime || null,
    mode: latest?.mode || null,
    scannedAt: latest?.scannedAt || latest?.ts || null,
    performance: m.performance || null,
    adaptiveThresholds: m.adaptiveThresholds || null,
    positionSizeUsd: m.positionSizeUsd || null,
    scanLock: m.scanLock || null,
  };
}

function explainAdaptive(performance, regime) {
  const adaptive = buildAdaptiveThresholds({ performance, regime });
  return {
    adaptive,
    meaning: {
      timing: `TimingScore moet >= ${adaptive.timing}`,
      quality: `QualityScore moet >= ${adaptive.quality}`,
      market: `MarketScore moet >= ${adaptive.market} (HEADWIND is extra streng)`,
    },
    why: {
      winRate: n(performance?.winRate, 50),
      drawdown: n(performance?.drawdown, 0),
      regime: String(regime || "TREND").toUpperCase(),
    },
  };
}

// -----------------------------
// Handler
// -----------------------------
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");

    await maybeUpdatePerformanceOnce();

    const [mainBull, mainBear] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMainLatest("bear")),
    ]);

    const [perfMainBull, perfMainBear] = await Promise.all([
      kv.get(keyMainPerformance("bull") || "main:performance:bull"),
      kv.get(keyMainPerformance("bear") || "main:performance:bear"),
    ]);

    const adaptiveMainBull = buildAdaptiveThresholds({ performance: perfMainBull, regime: mainBull?.regime });
    const adaptiveMainBear = buildAdaptiveThresholds({ performance: perfMainBear, regime: mainBear?.regime });

    const payload = {
      ok: true,
      thresholds: THRESHOLDS,
      main: {
        bull: {
          ...summarize(flattenLatest(mainBull), "Main Bull", adaptiveMainBull),
          meta: pickMeta(mainBull),
          explain: explainAdaptive(perfMainBull, mainBull?.regime),
        },
        bear: {
          ...summarize(flattenLatest(mainBear), "Main Bear", adaptiveMainBear),
          meta: pickMeta(mainBear),
          explain: explainAdaptive(perfMainBear, mainBear?.regime),
        },
      },

      // In deze MAIN-repo is er geen Moon scanner; we leveren wel consistente keys terug
      moon: {
        bull: { name: "Moon Bull", totalCoins: 0, topFix: null, table: [], meta: null, explain: null },
        bear: { name: "Moon Bear", totalCoins: 0, topFix: null, table: [], meta: null, explain: null },
      },

      performance: {
        main: {
          bull: perfMainBull || { winRate: 50, drawdown: 0, trades: 0, updatedAt: 0 },
          bear: perfMainBear || { winRate: 50, drawdown: 0, trades: 0, updatedAt: 0 },
        },
        moon: {
          bull: { winRate: 50, drawdown: 0, trades: 0, updatedAt: 0 },
          bear: { winRate: 50, drawdown: 0, trades: 0, updatedAt: 0 },
        },
      },

      updatedAt: Date.now(),
    };

    return res.status(200).json(payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("api/analyze-all error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}