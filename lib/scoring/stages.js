// lib/scoring/stages.js
// Main Funnel stage engine (V6)
//
// Exports:
// - isMainEliteStage(stage)
// - hasEliteFollowThrough(prevState, currentStage)
// - decideMainStageV6({ mode, coin, obx, priceHist, volHist, btc, prev, whaleFlow, regime, cfgOverride })
// - helpers: computeVelocity, computeCompression, computeBreakoutPressure, computePersistenceScore
//
// Notes:
// - This file is pure logic (no KV, no fetch).
// - Designed to be deterministic + defensive.
// - "mode" is "bull" or "bear".
// - Stages: RADAR, BUILDUP, ALMOST, ELITE_IGNITION, ELITE_EXPANSION, ELITE_CASCADE

import { MAIN_V2, adjustMoonConfigForRegime } from "../core/settings.js";

// ------------------ utils ------------------
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

// ------------------ public helpers ------------------

export function isMainEliteStage(stage) {
  const s = up(stage);
  return s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE";
}

/**
 * Follow-through logic:
 * - If current is EXPANSION/CASCADE => yes
 * - If current is IGNITION and previous was ALMOST/BUILDUP => yes
 * - If last 2 stages in history include any elite-like => yes
 */
export function hasEliteFollowThrough(prevState, currentStage) {
  const curr = up(currentStage);

  if (curr === "ELITE_EXPANSION" || curr === "ELITE_CASCADE") return true;

  const prevStage = up(prevState?.stage || "");
  if (curr === "ELITE_IGNITION" && (prevStage === "ALMOST" || prevStage === "BUILDUP")) return true;

  const hist = Array.isArray(prevState?.stageHist) ? prevState.stageHist : [];
  const tail = hist.slice(-2);
  const eliteLike = tail.filter((s) => {
    const x = up(s);
    return x === "ELITE_IGNITION" || x === "ELITE_EXPANSION" || x === "ELITE_CASCADE";
  }).length;

  return eliteLike >= 1;
}

// ------------------ core indicators ------------------

export function computeVelocity(ch1, ch24) {
  return (Math.abs(n(ch1, 0)) * 0.4) + (Math.abs(n(ch24, 0)) * 0.6);
}

export function computeCompression(priceHist) {
  const arr = Array.isArray(priceHist) ? priceHist.map((x) => n(x, 0)).filter((x) => x > 0) : [];
  if (arr.length < 5) return { isCompressed: false, flatPct: 100 };

  const slice = arr.slice(-5);
  const max = Math.max(...slice);
  const min = Math.min(...slice);
  if (!(min > 0)) return { isCompressed: false, flatPct: 100 };

  const flatPct = ((max - min) / min) * 100;
  return { isCompressed: flatPct < 3, flatPct };
}

export function computeBreakoutPressure(priceHist) {
  const arr = Array.isArray(priceHist) ? priceHist.map((x) => n(x, 0)).filter((x) => x > 0) : [];
  if (arr.length < 10) return { ready: false, pressure: 0, breakoutPct: 0 };

  const recent = arr.slice(-5);
  const older = arr.slice(-10, -5);

  const recentAvg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  const olderAvg = older.reduce((a, b) => a + b, 0) / Math.max(1, older.length);

  if (!(olderAvg > 0)) return { ready: false, pressure: 0, breakoutPct: 0 };

  const pressure = ((recentAvg - olderAvg) / olderAvg) * 100;
  return { ready: pressure > 2.5, pressure, breakoutPct: pressure };
}

/**
 * Persistence score: detects "stickiness" of price+volume trend.
 * - compares last 5 vs previous 5 for price average (10-long window)
 * - compares last 5 vol vs previous 5 vol (if available)
 * returns 0..100
 */
export function computePersistenceScore({ priceHist, volHist }) {
  const p = Array.isArray(priceHist) ? priceHist.map((x) => n(x, 0)).filter((x) => x > 0) : [];
  if (p.length < 10) return 50;

  const v = Array.isArray(volHist) ? volHist.map((x) => n(x, 0)).filter((x) => x >= 0) : [];

  const recentPrice = p.slice(-5);
  const olderPrice = p.slice(-10, -5);

  const rp = recentPrice.reduce((a, b) => a + b, 0) / 5;
  const op = olderPrice.reduce((a, b) => a + b, 0) / 5;

  if (!(op > 0)) return 50;

  const priceChange = (rp / op) - 1; // fraction

  // volume ratio: if we have enough, use last 5 vs previous 5 of same span
  let volChange = 1;
  if (v.length >= 10) {
    const recentVol = v.slice(-5);
    const olderVol = v.slice(-10, -5);
    const rv = recentVol.reduce((a, b) => a + b, 0) / 5;
    const ov = olderVol.reduce((a, b) => a + b, 0) / 5;
    volChange = rv / Math.max(ov, 1e-9);
  } else if (v.length >= 5) {
    // weak fallback: last vs avg
    const rv = v.slice(-5).reduce((a, b) => a + b, 0) / Math.max(1, v.slice(-5).length);
    volChange = rv / Math.max(rv, 1e-9);
  }

  let score = 50 + (priceChange * 50) + ((volChange - 1) * 30);
  score = Math.min(100, Math.max(0, Math.round(score)));
  return score;
}

// ------------------ micro filters ------------------

export function isBullExhausted(coin) {
  // classic: 24h huge, 1h red, vm low
  return n(coin?.change1h, 0) < 0 && n(coin?.change24, 0) > 20 && n(coin?.vm, 0) < 0.1;
}
export function isBearBounceTrap(coin) {
  // classic bounce: 24h very negative, 1h green, vm low
  return n(coin?.change1h, 0) > 0 && n(coin?.change24, 0) < -20 && n(coin?.vm, 0) < 0.1;
}
export function isLateBullEntry(coin) {
  return n(coin?.change24, 0) > 35;
}
export function isLateBearEntry(coin) {
  return n(coin?.change24, 0) < -35;
}

// ------------------ entry quality (elite quality) ------------------

export function computeEliteQuality({
  moveScore,
  velocity,
  vm,
  obScore,
  compression,
  volAcc,
  persistenceScore,
  regime,
  breakoutReady,
}) {
  const vShort = n(volAcc?.short, 1);
  let score =
    (n(moveScore, 0) * 0.2) +
    (n(velocity, 0) * 100 * 0.2) +
    (n(vm, 0) * 100 * 0.2) +
    (n(obScore, 0) * 100 * 0.1) +
    (n(persistenceScore, 50) * 0.2);

  if (compression?.isCompressed) score += 5;
  if (vShort > 1.2) score += 5;
  if (breakoutReady) score += 8;

  const reg = up(regime);
  if (reg === "EXPANSION") score += 8;

  return Math.min(100, Math.max(0, Math.round(score)));
}

// Move score helpers (kept here for stage decision symmetry)
export function computeBullMoveScore(coin, obx) {
  // coin.change1h and coin.change24 are % values
  const s =
    (n(coin?.change1h, 0) * 15) +
    (n(coin?.change24, 0) * 5) +
    (n(coin?.vm, 0) * 100) +
    (n(obx?.score, 0) * 50);
  return Math.min(100, Math.max(0, s));
}
export function computeBearMoveScore(coin, obx) {
  const s =
    (Math.abs(n(coin?.change1h, 0)) * 15) +
    (Math.abs(n(coin?.change24, 0)) * 5) +
    (n(coin?.vm, 0) * 100) +
    (Math.abs(n(obx?.score, 0)) * 50);
  return Math.min(100, Math.max(0, s));
}

// ------------------ main stage decision ------------------

/**
 * decideMainStageV6
 * Determines stage + supporting indicators.
 *
 * Inputs:
 * - mode: "bull" | "bear"
 * - coin: { change1h, change24, vm, ... }
 * - obx: { score } normalized orderbook score (+ bid-heavy, - ask-heavy)
 * - priceHist, volHist arrays
 * - btc: { chg24, range24, state }
 * - prev: { stage, stageHist, volAcc } (optional)
 * - whaleFlow: numeric
 * - regime: "EXPANSION" | "CONTRACTION" | "HEADWIND" | "TREND"
 * - cfgOverride: optional config object for MAIN_V2[mode]
 */
export function decideMainStageV6({
  mode,
  coin,
  obx,
  priceHist,
  volHist,
  btc,
  prev,
  regime,
  cfgOverride,
}) {
  const m = String(mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const baseCfg = cfgOverride || MAIN_V2?.[m] || MAIN_V2.bull;
  const cfg = adjustMoonConfigForRegime(baseCfg, regime);

  const velocity = computeVelocity(coin?.change1h, coin?.change24);
  const compression = computeCompression(priceHist);
  const breakout = computeBreakoutPressure(priceHist);

  const prevVolAcc = prev?.volAcc || { short: 1, medium: 1 };
  const volAcc = { short: n(prevVolAcc.short, 1), medium: n(prevVolAcc.medium, 1) };

  const persistenceScore = computePersistenceScore({ priceHist, volHist });

  // early disqualifiers / special routing
  if (m === "bull" && isBullExhausted(coin)) {
    return {
      stage: "RADAR",
      stageWhy: "bull_exhausted",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }
  if (m === "bear" && isBearBounceTrap(coin)) {
    return {
      stage: "RADAR",
      stageWhy: "bear_bounce_trap",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }
  if (m === "bull" && isLateBullEntry(coin)) {
    return {
      stage: "ALMOST",
      stageWhy: "late_bull_entry",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }
  if (m === "bear" && isLateBearEntry(coin)) {
    return {
      stage: "ALMOST",
      stageWhy: "late_bear_entry",
      moveScore: 0,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality: 0,
    };
  }

  const moveScore = m === "bull" ? computeBullMoveScore(coin, obx) : computeBearMoveScore(coin, obx);

  const entryQuality = computeEliteQuality({
    moveScore,
    velocity,
    vm: n(coin?.vm, 0),
    obScore: n(obx?.score, 0),
    compression,
    volAcc,
    persistenceScore,
    regime,
    breakoutReady: !!breakout?.ready,
  });

  // BTC "momentum ok" guard to reduce false elites
  const btcMomentumOk =
    m === "bull"
      ? n(btc?.chg24, 0) >= 0.8 && n(btc?.range24, 0) >= 2.8
      : n(btc?.chg24, 0) <= -0.8 && n(btc?.range24, 0) >= 2.8;

  // if volume not accelerating + not breakout + low persistence => downgrade to ALMOST
  if (
    n(volAcc.short, 1) < 1.01 &&
    n(volAcc.medium, 1) < 1.06 &&
    moveScore < 70 &&
    !breakout.ready &&
    persistenceScore < 56
  ) {
    return {
      stage: "ALMOST",
      stageWhy: "volume_not_accelerating",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  let stage = "RADAR";
  let eliteType = null;

  if (m === "bull") {
    // strongest
    if (
      n(coin?.change1h, 0) >= n(cfg.minCh1hExpansion, 0) &&
      n(coin?.change24, 0) >= n(cfg.minCh24Expansion, 0) &&
      n(coin?.vm, 0) >= n(cfg.minVmElite, 0) &&
      n(obx?.score, 0) >= n(cfg.minObStrong, 0) &&
      velocity >= n(cfg.explosiveVelocity, 0) &&
      entryQuality >= 76 &&
      persistenceScore >= n(cfg.minPersistenceExpansion, 70)
    ) {
      stage = "ELITE_EXPANSION";
      eliteType = "expansion";
    } else if (
      n(coin?.change1h, 0) >= n(cfg.minCh1hIgnition, 0) &&
      n(coin?.change24, 0) >= n(cfg.minCh24Ignition, 0) &&
      n(coin?.vm, 0) >= n(cfg.minVmElite, 0) &&
      n(obx?.score, 0) >= n(cfg.minObStrong, 0) &&
      velocity >= n(cfg.strongVelocity, 0) &&
      entryQuality >= 66 &&
      persistenceScore >= n(cfg.minPersistenceIgnition, 60)
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    } else if (
      n(coin?.change1h, 0) >= Math.max(0.7, n(cfg.minCh1hAlmost, 0) - 0.25) &&
      n(coin?.change24, 0) >= Math.max(4.8, n(cfg.minCh24Almost, 0) - 1.2) &&
      n(coin?.vm, 0) >= Math.max(0.17, n(cfg.minVmAlmost, 0) - 0.03) &&
      velocity >= Math.max(0.09, n(cfg.strongVelocity, 0) - 0.02)
    ) {
      stage = "ALMOST";
    } else if (
      n(coin?.change1h, 0) >= n(cfg.minCh1hBuildup, 0) &&
      n(coin?.change24, 0) >= n(cfg.minCh24Buildup, 0) &&
      n(coin?.vm, 0) >= n(cfg.minVmBuildup, 0) &&
      velocity >= n(cfg.minVelocity, 0)
    ) {
      stage = "BUILDUP";
    }
  } else {
    // bear-mode elites (downtrend)
    if (
      n(coin?.change1h, 0) <= n(cfg.maxCh1hCascade, 0) &&
      n(coin?.change24, 0) <= n(cfg.maxCh24Cascade, 0) &&
      n(coin?.vm, 0) >= n(cfg.minVmElite, 0) &&
      Math.abs(n(obx?.score, 0)) >= n(cfg.minObStrongAbs, 0) &&
      n(obx?.score, 0) <= 0 &&
      velocity >= n(cfg.explosiveVelocity, 0) &&
      entryQuality >= 76 &&
      persistenceScore >= n(cfg.minPersistenceExpansion, 70)
    ) {
      stage = "ELITE_CASCADE";
      eliteType = "cascade";
    } else if (
      n(coin?.change1h, 0) <= n(cfg.maxCh1hIgnition, 0) &&
      n(coin?.change24, 0) <= n(cfg.maxCh24Ignition, 0) &&
      n(coin?.vm, 0) >= n(cfg.minVmElite, 0) &&
      Math.abs(n(obx?.score, 0)) >= n(cfg.minObStrongAbs, 0) &&
      n(obx?.score, 0) <= 0 &&
      velocity >= n(cfg.strongVelocity, 0) &&
      entryQuality >= 66 &&
      persistenceScore >= n(cfg.minPersistenceIgnition, 60)
    ) {
      stage = "ELITE_IGNITION";
      eliteType = "ignition";
    } else if (
      n(coin?.change1h, 0) <= Math.min(-0.7, n(cfg.maxCh1hAlmost, 0) + 0.25) &&
      n(coin?.change24, 0) <= Math.min(-4.8, n(cfg.maxCh24Almost, 0) + 1.2) &&
      n(coin?.vm, 0) >= Math.max(0.17, n(cfg.minVmAlmost, 0) - 0.03) &&
      velocity >= Math.max(0.09, n(cfg.strongVelocity, 0) - 0.02)
    ) {
      stage = "ALMOST";
    } else if (
      n(coin?.change1h, 0) <= n(cfg.maxCh1hBuildup, 0) &&
      n(coin?.change24, 0) <= n(cfg.maxCh24Buildup, 0) &&
      n(coin?.vm, 0) >= n(cfg.minVmBuildup, 0) &&
      velocity >= n(cfg.minVelocity, 0)
    ) {
      stage = "BUILDUP";
    }
  }

  // elite guardrails: breakout + quality needed
  if (isMainEliteStage(stage) && !breakout.ready && entryQuality < 82) {
    stage = "ALMOST";
    eliteType = null;
  }

  // btc momentum gating (unless EXPANSION regime)
  if (isMainEliteStage(stage) && !btcMomentumOk && up(regime) !== "EXPANSION") {
    return {
      stage: "ALMOST",
      stageWhy: "btc_not_expanding",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  // follow-through gating
  if (isMainEliteStage(stage) && !hasEliteFollowThrough(prev, stage)) {
    return {
      stage: "ALMOST",
      stageWhy: "elite_needs_followthrough",
      moveScore,
      velocity,
      compression,
      breakout,
      eliteType: null,
      persistenceScore,
      entryQuality,
    };
  }

  return {
    stage,
    stageWhy: "ok",
    moveScore,
    velocity,
    compression,
    breakout,
    eliteType,
    persistenceScore,
    entryQuality,
  };
}