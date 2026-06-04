// ================= FILE: src/trade/costModel.js =================
//
// Turns gross price moves into fee+slippage-adjusted NET outcomes.
// Everything Analyze learns from must pass through here, otherwise the system
// ranks micro-families on paper profit and trades on net loss.
//
// Execution model: TAKER on both sides (conservative). A family that survives
// taker costs is robust; if we later get maker entries, real net R only improves.

import { CONFIG } from '../config.js';
import { safeNumber } from '../utils.js';

// Realistic fill price given the side, the leg (entry/exit), and the spread.
// LONG  enters at the ask (mid + half spread), exits at the bid (mid - half spread).
// SHORT enters at the bid (mid - half spread), exits at the ask (mid + half spread).
// When the book is missing we fall back to a conservative spread estimate.
export function modelFillPrice({ midPrice, side, leg, spreadPct }) {
  const mid = safeNumber(midPrice);
  if (!mid) return 0;
  const halfSpread = Math.max(safeNumber(spreadPct), CONFIG.cost.fallbackSpreadPct) / 2;
  const impact = CONFIG.cost.marketImpactPct; // extra adverse fill beyond the quoted spread
  const adverse = halfSpread + impact;
  const isBull = String(side).toLowerCase() === 'bull';

  // Buying legs pay UP, selling legs receive DOWN — always against us.
  const buying = (isBull && leg === 'entry') || (!isBull && leg === 'exit');
  return buying ? mid * (1 + adverse) : mid * (1 - adverse);
}

// Total round-trip cost expressed as a fraction of notional (fees both sides + slippage both sides).
export function roundTripCostPct(entrySpreadPct, exitSpreadPct) {
  const feeRT = CONFIG.cost.takerFeePct * 2;
  const slipEntry = Math.max(safeNumber(entrySpreadPct), CONFIG.cost.fallbackSpreadPct) / 2 + CONFIG.cost.marketImpactPct;
  const slipExit = Math.max(safeNumber(exitSpreadPct), CONFIG.cost.fallbackSpreadPct) / 2 + CONFIG.cost.marketImpactPct;
  return feeRT + slipEntry + slipExit;
}

// Convert a gross outcome into a net outcome.
// grossMovePct = directional price move as a fraction of entry (already side-adjusted, positive = favourable).
// riskPct = the |entry - SL| distance as a fraction of entry; this is what 1R is worth.
export function applyCosts({ grossMovePct, riskPct, entrySpreadPct, exitSpreadPct }) {
  const move = safeNumber(grossMovePct);
  const risk = safeNumber(riskPct);
  const costPct = roundTripCostPct(entrySpreadPct, exitSpreadPct);

  const grossPnlPct = move * 100;
  const netPnlPct = (move - costPct) * 100;

  // 1R = riskPct of price. Costs eat into R proportionally to how tight the stop is —
  // this is exactly why tight-stop scalps that look great gross can be net negative.
  const grossR = risk > 0 ? move / risk : 0;
  const costR = risk > 0 ? costPct / risk : 0;
  const netR = grossR - costR;

  return {
    feePct: Number((CONFIG.cost.takerFeePct * 2 * 100).toFixed(4)),
    slippagePct: Number(((costPct - CONFIG.cost.takerFeePct * 2) * 100).toFixed(4)),
    costPct: Number((costPct * 100).toFixed(4)),
    costR: Number(costR.toFixed(4)),
    grossPnlPct: Number(grossPnlPct.toFixed(4)),
    netPnlPct: Number(netPnlPct.toFixed(4)),
    grossR: Number(grossR.toFixed(4)),
    netR: Number(netR.toFixed(4))
  };
}
