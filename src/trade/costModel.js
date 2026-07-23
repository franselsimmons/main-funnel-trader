// ================= FILE: src/trade/costModel.js =================
//
// Calculate Net-R after costs
// CRITICAL: All outcomes must use NET-R, not GROSS-R
//
// Bitget perpetuals costs:
//  - Maker fee: 0.02% (limit orders)
//  - Taker fee: 0.05% → but API docs show 0.15% (check!)
//  - We'll use 0.15% as conservative
//

const BITGET_TAKER_FEE_PCT = 0.0015; // 0.15%
const BITGET_MAKER_FEE_PCT = 0.0002; // 0.02%
const ENTRY_SLIPPAGE_PCT = 0.0005;   // 0.05% (market entry)
const EXIT_SLIPPAGE_PCT = 0.0010;    // 0.10% (market exit)
const FUNDING_RATE_AVG_PCT = 0.0001; // 0.01% per 8hr avg (negligible)

/**
 * Calculate costs for a position
 * 
 * Returns: { entryFee, entrySlippage, exitFee, exitSlippage, fundingCost, totalCostPct }
 */
export function calculatePositionCosts({
  side = 'SHORT',
  entryPrice = 0,
  exitPrice = 0,
  riskPct = 0.01,
  durationHours = 24,
  executionMode = 'market' // market or limit
} = {}) {
  
  const entry = Math.abs(entryPrice || 0);
  const exit = Math.abs(exitPrice || 0);
  const risk = Math.abs(riskPct || 0);
  
  if (entry <= 0) {
    return {
      ok: false,
      reason: 'INVALID_ENTRY_PRICE',
      entryFee: 0,
      entrySlippage: 0,
      exitFee: 0,
      exitSlippage: 0,
      fundingCost: 0,
      totalCostPct: 0,
      totalCostR: 0
    };
  }
  
  // Entry costs
  const takerFee = executionMode === 'limit' ? BITGET_MAKER_FEE_PCT : BITGET_TAKER_FEE_PCT;
  const entryFee = entry * takerFee;
  const entrySlippage = entry * ENTRY_SLIPPAGE_PCT;
  const totalEntryCost = entryFee + entrySlippage;
  
  // Exit costs
  const exitFee = exit * BITGET_TAKER_FEE_PCT;
  const exitSlippage = exit * EXIT_SLIPPAGE_PCT;
  const totalExitCost = exitFee + exitSlippage;
  
  // Funding (conservative estimate)
  const fundingCost = entry * FUNDING_RATE_AVG_PCT * (durationHours / 8);
  
  // Total cost as percentage of entry
  const totalCostPct = (totalEntryCost + totalExitCost + fundingCost) / entry;
  
  // Total cost in R units
  const totalCostR = risk > 0 ? totalCostPct / risk : 0;
  
  return {
    ok: true,
    entryFee: Number(entryFee.toFixed(8)),
    entrySlippage: Number(entrySlippage.toFixed(8)),
    exitFee: Number(exitFee.toFixed(8)),
    exitSlippage: Number(exitSlippage.toFixed(8)),
    fundingCost: Number(fundingCost.toFixed(8)),
    totalCostPct: Number(totalCostPct.toFixed(6)),
    totalCostR: Number(totalCostR.toFixed(4)),
    durationHours,
    executionMode
  };
}

/**
 * Apply costs to an outcome
 * 
 * Input: outcome with grossR (before costs)
 * Output: outcome with netR (after costs)
 */
export function applyCosts({
  grossR = 0,
  riskPct = 0.01,
  entryPrice = 0,
  exitPrice = 0,
  side = 'SHORT',
  durationHours = 24,
  executionMode = 'market'
} = {}) {
  
  const costs = calculatePositionCosts({
    side,
    entryPrice,
    exitPrice,
    riskPct,
    durationHours,
    executionMode
  });
  
  if (!costs.ok) {
    return {
      ok: false,
      reason: costs.reason,
      grossR: Number(grossR.toFixed(4)),
      costR: 0,
      netR: Number(grossR.toFixed(4))
    };
  }
  
  // Net-R = Gross-R - Cost-R
  const netR = grossR - costs.totalCostR;
  
  return {
    ok: true,
    grossR: Number(grossR.toFixed(4)),
    costR: Number(costs.totalCostR.toFixed(4)),
    netR: Number(netR.toFixed(4)),
    costPct: Number(costs.totalCostPct.toFixed(6)),
    breakdown: {
      entryFee: costs.entryFee,
      entrySlippage: costs.entrySlippage,
      exitFee: costs.exitFee,
      exitSlippage: costs.exitSlippage,
      fundingCost: costs.fundingCost
    }
  };
}

/**
 * Calculate outcome with automatic cost application
 * 
 * Called when position closes
 * Returns: { netR, costR, grossR, pnlPct, outcome }
 */
export function calculateOutcome({
  side = 'SHORT',
  entryPrice = 0,
  exitPrice = 0,
  tp = null,
  sl = null,
  risk = 0.01,
  hitTp = false,
  hitSL = false,
  durationHours = 24,
  executionMode = 'market'
} = {}) {
  
  const entry = Math.abs(entryPrice || 0);
  const exit = Math.abs(exitPrice || 0);
  
  if (entry <= 0 || exit <= 0) {
    return {
      ok: false,
      reason: 'INVALID_PRICES'
    };
  }
  
  // Calculate move
  let pnlMove = 0;
  let pnlPct = 0;
  
  if (side === 'SHORT') {
    // SHORT: profit when price goes down
    pnlMove = entry - exit;
    pnlPct = pnlMove / entry;
  } else {
    // LONG: profit when price goes up
    pnlMove = exit - entry;
    pnlPct = pnlMove / entry;
  }
  
  // Gross R (P&L in R units)
  const riskAmt = Math.abs(risk || 0.01);
  const grossR = riskAmt > 0 ? pnlPct / riskAmt : 0;
  
  // Apply costs
  const withCosts = applyCosts({
    grossR,
    riskPct: riskAmt,
    entryPrice: entry,
    exitPrice: exit,
    side,
    durationHours,
    executionMode
  });
  
  // Determine outcome type
  let outcome = 'UNCLEAR';
  if (hitTp) outcome = 'TP_HIT';
  if (hitSL) outcome = 'SL_HIT';
  if (!hitTp && !hitSL && durationHours > 72) outcome = 'TIME_STOP';
  
  return {
    ok: true,
    pnlMove: Number(pnlMove.toFixed(8)),
    pnlPct: Number(pnlPct.toFixed(6)),
    grossR: Number(withCosts.grossR.toFixed(4)),
    costR: Number(withCosts.costR.toFixed(4)),
    netR: Number(withCosts.netR.toFixed(4)),
    outcome,
    hitTP: hitTp,
    hitSL,
    durationHours,
    costBreakdown: withCosts.breakdown
  };
}

/**
 * Check if outcome hit TP or SL
 * Returns closest metric
 */
export function checkTPSL({
  currentPrice = 0,
  tp = null,
  sl = null,
  side = 'SHORT'
} = {}) {
  
  const price = Math.abs(currentPrice || 0);
  const tpPrice = tp ? Math.abs(tp) : null;
  const slPrice = sl ? Math.abs(sl) : null;
  
  const result = {
    hitTP: false,
    hitSL: false,
    nearTP: false,
    nearSL: false,
    nearTPPct: 0,
    nearSLPct: 0
  };
  
  if (side === 'SHORT') {
    // SHORT: TP is below entry, SL is above entry
    if (tpPrice && price <= tpPrice) {
      result.hitTP = true;
    } else if (tpPrice && price > tpPrice) {
      const distanceToTP = tpPrice - price;
      const halfWay = tpPrice - (tpPrice * 0.5);
      if (price > halfWay && price <= tpPrice * 1.005) {
        result.nearTP = true;
      }
      result.nearTPPct = Math.abs(distanceToTP / tpPrice);
    }
    
    if (slPrice && price >= slPrice) {
      result.hitSL = true;
    }
  } else {
    // LONG: TP is above entry, SL is below entry
    if (tpPrice && price >= tpPrice) {
      result.hitTP = true;
    } else if (tpPrice && price < tpPrice) {
      const distanceToTP = price - tpPrice;
      const halfWay = tpPrice + (tpPrice * 0.5);
      if (price < halfWay && price >= tpPrice * 0.995) {
        result.nearTP = true;
      }
      result.nearTPPct = Math.abs(distanceToTP / tpPrice);
    }
    
    if (slPrice && price <= slPrice) {
      result.hitSL = true;
    }
  }
  
  return result;
}

export default {
  calculatePositionCosts,
  applyCosts,
  calculateOutcome,
  checkTPSL,
  BITGET_TAKER_FEE_PCT,
  BITGET_MAKER_FEE_PCT,
  ENTRY_SLIPPAGE_PCT,
  EXIT_SLIPPAGE_PCT,
  FUNDING_RATE_AVG_PCT
};
