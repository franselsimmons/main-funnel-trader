// lib/scoring/scores.js
// Main Funnel scoring helpers (quality/liquidity/timing/market/btcAlignment/perfectCandidate)
//
// Exports:
// - computeQualityScore
// - computeLiquidityScore
// - computeTimingScore
// - computeMarketScore
// - computeBtcAlignmentScore
// - computePerfectCandidateScore
//
// Notes:
// - Pure functions (no IO).
// - Defensive numeric handling.
// - Works for both bull/bear modes.

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

/**
 * QualityScore: mix of moveScore, entryQuality, persistence and velocity.
 * Adds small bonuses for compression + breakout readiness.
 */
export function computeQualityScore({
  moveScore,
  entryQuality,
  persistenceScore,
  velocity,
  compression,
  breakout,
}) {
  const ms = n(moveScore, 0);
  const eq = n(entryQuality, 0);
  const ps = n(persistenceScore, 50);
  const vel = n(velocity, 0);

  let score =
    (ms * 0.25) +
    (eq * 0.25) +
    (ps * 0.20) +
    ((vel * 100) * 0.15);

  if (compression?.isCompressed) score += 5;
  if (breakout?.ready) score += 8;

  return Math.min(100, Math.max(0, Math.round(score)));
}

/**
 * LiquidityScore: depth + snapshot validity/freshness + spread + absolute depth.
 */
export function computeLiquidityScore({ ob, depthOk, spreadPct, depthMinUsd1p }) {
  const sp = n(spreadPct, 999);
  const depth = n(depthMinUsd1p, 0);
  const valid = !!ob?.valid;
  const fresh = !!ob?.fresh;

  let score = 0;

  if (depthOk) score += 25;
  if (valid && fresh) score += 25;

  if (sp < 0.8) score += 25;
  else if (sp < 1.2) score += 15;
  else if (sp < 1.8) score += 5;

  if (depth > 50_000) score += 25;
  else if (depth > 20_000) score += 15;
  else if (depth > 10_000) score += 5;

  return Math.min(100, Math.max(0, score));
}

/**
 * TimingScore: stage bias + breakout + volume acceleration + scan streaks.
 * Penalizes late entry/exhaustion/bounce trap.
 */
export function computeTimingScore({
  stage,
  breakout,
  volAcc,
  strongScans,
  eliteScans,
  lateEntry,
  exhausted,
  bounceTrap,
}) {
  const s = up(stage);
  const vShort = n(volAcc?.short, 1);
  const vMed = n(volAcc?.medium, 1);

  let score = 50;

  if (s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE") score += 20;
  else if (s === "ALMOST") score += 10;
  else if (s === "BUILDUP") score += 5;

  if (breakout?.ready) score += 15;

  if (vShort > 1.2 && vMed > 1.1) score += 10;

  if (n(strongScans, 0) >= 3) score += 5;
  if (n(eliteScans, 0) >= 2) score += 8;

  if (lateEntry || exhausted || bounceTrap) score -= 20;

  return Math.min(100, Math.max(0, score));
}

/**
 * MarketScore: BTC alignment to mode + regime + whaleFlow.
 */
export function computeMarketScore({ btc, mode, regime, whaleFlow }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const m = String(mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const reg = up(regime || "TREND");
  const wf = n(whaleFlow, 0);

  let score = 50;

  // mode vs btc state
  if (m === "bull" && btcState === "BULL") score += 25;
  else if (m === "bull" && btcState === "NEUTRAL") score += 10;
  else if (m === "bear" && btcState === "BEAR") score += 25;
  else if (m === "bear" && btcState === "NEUTRAL") score += 10;
  else score -= 20;

  // regime adjustments
  if (reg === "EXPANSION") score += 15;
  else if (reg === "CONTRACTION") score -= 15;
  else if (reg === "HEADWIND") score -= 10;

  // whale flow heuristic
  if (wf > 12) score += 10;
  else if (wf < 5) score -= 10;

  return Math.min(100, Math.max(0, score));
}

/**
 * BTC Alignment Score: stronger gating score than marketScore,
 * emphasizes state + regime compatibility.
 */
export function computeBtcAlignmentScore({ btc, mode, regime }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const m = String(mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const reg = up(regime || "TREND");

  let score = 50;

  if (m === "bull" && btcState === "BULL") score += 30;
  else if (m === "bull" && btcState === "NEUTRAL") score += 10;
  else if (m === "bear" && btcState === "BEAR") score += 30;
  else if (m === "bear" && btcState === "NEUTRAL") score += 10;
  else score -= 25;

  if (reg === "EXPANSION") score += 15;
  else if (reg === "CONTRACTION") score -= 15;

  return Math.min(100, Math.max(0, score));
}

/**
 * PerfectCandidateScore: weighted blend of the four primary scores.
 */
export function computePerfectCandidateScore({
  qualityScore,
  liquidityScore,
  timingScore,
  marketScore,
}) {
  const q = n(qualityScore, 0);
  const l = n(liquidityScore, 0);
  const t = n(timingScore, 0);
  const m = n(marketScore, 0);

  return Math.round((q * 0.30) + (l * 0.25) + (t * 0.25) + (m * 0.20));
}