// lib/scoring/risk.js
// Risk + trade plan logic for Main Funnel (supports bull/long and bear/short)
//
// Exports:
// - getTierForMcap
// - depthFloorUsd
// - computeMoonRisk   (kept name for compatibility with your existing scanner)
// - buildTradePlan
//
// Notes:
// - computeMoonRisk returns { sl, tp, tp3, slPct, tpPct } where
//   tp3 mirrors tp to keep older code paths stable.
// - buildTradePlan converts risk output into an executable trade plan.
// - For bear mode (short): tradePlan returns tp/sl on the correct side of entry.

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normMode(mode) {
  return String(mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
}

/**
 * Market-cap tiering (used for depth floors + risk multipliers).
 */
export function getTierForMcap(mcap) {
  const mc = n(mcap, 0);
  if (mc < 50_000_000) return { name: "micro", factor: 1.2 };
  if (mc < 200_000_000) return { name: "small", factor: 1.0 };
  if (mc < 500_000_000) return { name: "mid", factor: 0.8 };
  return { name: "large", factor: 0.6 };
}

/**
 * Depth floor in USD (1% depth, min of bid/ask) based on market cap + tier.
 * depthHist is optional and can be used later for adaptive floors (kept param for compat).
 */
export function depthFloorUsd(mcap, tier, depthHist) {
  const mc = n(mcap, 0);
  const base = mc / 1000;

  const t = tier?.name || getTierForMcap(mc)?.name || "small";

  if (t === "micro") return Math.max(8000, base * 0.20);
  if (t === "small") return Math.max(15000, base * 0.15);
  if (t === "mid") return Math.max(25000, base * 0.10);
  return Math.max(40000, base * 0.05);
}

/**
 * computeMoonRisk (name kept for compatibility)
 *
 * Inputs:
 * - mode: "bull" | "bear"
 * - price: current price (entry)
 * - range24: 24h range % (vol proxy)
 * - confidence: 0-100 (entryQuality or moveScore)
 * - depthOk: boolean (meets depth floor)
 * - tier: {name,factor}
 * - regime: "EXPANSION"|"TREND"|"HEADWIND"|"CONTRACTION"
 * - persistenceScore: 0-100
 * - performance: {winRate, drawdown} optional
 *
 * Output:
 * - sl / tp are absolute price levels (tp3 mirrors tp)
 * - slPct / tpPct are percentages (positive numbers)
 *
 * Bear mode note:
 * - sl is above entry, tp is below entry (short)
 */
export function computeMoonRisk({
  mode,
  price,
  range24,
  confidence,
  depthOk,
  tier,
  regime,
  persistenceScore,
  performance,
}) {
  const m = normMode(mode);
  const p = n(price, 0);
  const r24 = n(range24, 0);

  // if missing essentials, return null so callers can skip tradePlan
  if (!(p > 0) || !(r24 > 0)) return null;

  const conf = clamp(n(confidence, 50), 0, 100);
  const pers = clamp(n(persistenceScore, 50), 0, 100);
  const winRate = n(performance?.winRate, 50);

  const volFactor = r24 / 100;          // e.g. 6% range -> 0.06
  const confFactor = conf / 100;
  const persFactor = pers / 100;

  // Base stop: you can tune this; keep symmetric as your current logic.
  const baseSlPct = 1.2;

  // Volatility widens SL. DepthOk tightens slightly.
  let slPct = baseSlPct + (volFactor * 2.0); // range24=6 => +0.12 => 1.32
  if (depthOk) slPct *= 0.90;

  // Tier risk: micro is sloppier; large is tighter via factor if desired
  const tName = tier?.name || "small";
  if (tName === "micro") slPct *= 1.20;
  if (tName === "mid") slPct *= 0.95;
  if (tName === "large") slPct *= 0.90;

  // Regime risk: headwind -> wider SL (more noise / less follow-through)
  const reg = String(regime || "TREND").toUpperCase();
  if (reg === "HEADWIND") slPct *= 1.15;
  if (reg === "CONTRACTION") slPct *= 1.10;

  // Performance feedback: if you're underperforming, be more conservative
  if (winRate < 45) slPct *= 1.10;
  if (winRate < 35) slPct *= 1.08;

  // Hard clamps
  slPct = clamp(slPct, 1.2, 8);

  // TP multiple: confidence + persistence push RR higher
  // Tune: base 1.5R plus up to ~0.8R for confidence and ~0.5R for persistence
  const tpMult = 1.5 + (confFactor * 0.8) + (persFactor * 0.5);
  const tpPct = clamp(slPct * tpMult, slPct * 1.2, 25); // cap at 25% by default

  // Convert to absolute levels (bear flips direction)
  let sl = 0;
  let tp = 0;

  if (m === "bear") {
    // short: SL above entry, TP below entry
    sl = p * (1 + slPct / 100);
    tp = p * (1 - tpPct / 100);
  } else {
    // long: SL below entry, TP above entry
    sl = p * (1 - slPct / 100);
    tp = p * (1 + tpPct / 100);
  }

  return { sl, tp, tp3: tp, slPct, tpPct };
}

/**
 * buildTradePlan
 * Convenience wrapper that outputs a stable "tradePlan" object used by the scanner.
 *
 * Output:
 * - entry, sl, tp (absolute)
 * - rr: tpPct/slPct (approx)
 * - slPct, tpPct (%)
 */
export function buildTradePlan({
  price,
  mode,
  confidence,
  range24,
  depthOk,
  tier,
  regime,
  persistenceScore,
  performance,
}) {
  const risk = computeMoonRisk({
    mode,
    price,
    range24,
    confidence,
    depthOk,
    tier,
    regime,
    persistenceScore,
    performance,
  });
  if (!risk) return null;

  const entry = n(price, 0);
  const sl = n(risk.sl, 0);
  const tp = n(risk.tp3, 0);

  const slPct = n(risk.slPct, 0);
  const tpPct = n(risk.tpPct, 0);

  // RR as ratio of percent moves (works for both long/short)
  const rr = tpPct / Math.max(slPct, 1e-6);

  return {
    entry: Number(entry.toFixed(8)),
    sl: Number(sl.toFixed(8)),
    tp: Number(tp.toFixed(8)),
    rr: Number(rr.toFixed(2)),
    slPct: Number(slPct.toFixed(2)),
    tpPct: Number(tpPct.toFixed(2)),
  };
}