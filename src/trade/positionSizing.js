// ================= FILE: src/trade/positionSizing.js =================
//
// Decides how much risk a new entry may take, and whether portfolio-level risk
// caps allow it at all. The single biggest hidden danger in this system is
// correlation: nearly every candidate is BTC-correlated (btcRelation is even part
// of the family identity), so 30 "independent" positions can all lose together on
// one BTC candle. These caps bound that.
//
// All caps are expressed as fractions of equity, in R-independent terms: a position's
// "risk contribution" = baseRiskPct (what you lose if it hits its stop).

import { CONFIG } from '../config.js';
import { clamp, safeNumber } from '../utils.js';

// How much equity a single new position should risk, scaled by how trustworthy the
// micro-family is. Strong + well-sampled family -> up to maxMult; thin sample -> minMult.
export function riskFractionForEntry({ weeklyStats } = {}) {
  const base = CONFIG.sizing.baseRiskPct;
  const completed = safeNumber(weeklyStats?.completed);
  const balanced = safeNumber(weeklyStats?.balancedScore);

  // Sample confidence: ramps 0 -> 1 as completed approaches the rotation prior.
  const sampleConf = clamp(completed / Math.max(1, CONFIG.rotation.priorTrades), 0, 1);
  // Quality factor: balancedScore is roughly 0-120 in practice; normalise softly.
  const qualityConf = clamp(balanced / 100, 0, 1);

  const mult = clamp(
    CONFIG.sizing.minMult + (CONFIG.sizing.maxMult - CONFIG.sizing.minMult) * (0.5 * sampleConf + 0.5 * qualityConf),
    CONFIG.sizing.minMult,
    CONFIG.sizing.maxMult
  );

  return Number((base * mult).toFixed(6));
}

// Sum the risk already committed across open positions, split by side and BTC-relation.
export function summarizeOpenRisk(openPositions = []) {
  let total = 0;
  let longRisk = 0;
  let shortRisk = 0;
  let counterBtcRisk = 0;

  for (const p of openPositions) {
    const r = safeNumber(p.riskFraction, CONFIG.sizing.baseRiskPct);
    total += r;
    if (String(p.side).toLowerCase() === 'bull') longRisk += r; else shortRisk += r;
    // btcRelation is stored on the row from classification; AGAINST = fighting BTC.
    if (String(p.btcRelation || '').toUpperCase() === 'BTC_AGAINST') counterBtcRisk += r;
  }

  return { total, longRisk, shortRisk, counterBtcRisk };
}

// Gate a prospective entry against portfolio caps. Returns the allowed risk fraction,
// or ok:false with the binding cap. This is enforced (a real safety feature), unlike
// the BE/trailing logic which is measure-only until proven per family.
export function checkRiskCaps({ openPositions = [], side, btcRelation, riskFraction }) {
  const want = safeNumber(riskFraction, CONFIG.sizing.baseRiskPct);
  const open = summarizeOpenRisk(openPositions);
  const isBull = String(side).toLowerCase() === 'bull';
  const isCounterBtc = String(btcRelation || '').toUpperCase() === 'BTC_AGAINST';

  if (open.total + want > CONFIG.sizing.maxTotalRiskPct) {
    return { ok: false, reason: 'MAX_TOTAL_RISK', open: open.total, want, cap: CONFIG.sizing.maxTotalRiskPct };
  }
  const sideRisk = isBull ? open.longRisk : open.shortRisk;
  if (sideRisk + want > CONFIG.sizing.maxSameSideRiskPct) {
    return { ok: false, reason: 'MAX_SAME_SIDE_RISK', open: sideRisk, want, cap: CONFIG.sizing.maxSameSideRiskPct };
  }
  if (isCounterBtc && open.counterBtcRisk + want > CONFIG.sizing.maxCounterBtcRiskPct) {
    return { ok: false, reason: 'MAX_COUNTER_BTC_RISK', open: open.counterBtcRisk, want, cap: CONFIG.sizing.maxCounterBtcRiskPct };
  }

  return { ok: true, riskFraction: want, openRiskAfter: Number((open.total + want).toFixed(6)) };
}
