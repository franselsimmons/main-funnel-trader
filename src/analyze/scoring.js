// ================= FILE: src/analyze/scoring.js =================
//
// Wilson bounds, Bayesian winrate, BalancedScore calculation
// CRITICAL: BalancedScore must include ALL penalties (directSL, gaveBack, etc)
//

import { clamp, safeNumber } from '../utils.js';

const DEFAULT_WILSON_Z = 1.96;
const DEFAULT_PRIOR_TRADES = 24;
const DEFAULT_PRIOR_WINRATE = 0.5;
const DEFAULT_SAMPLE_CAP = 50;
const DEFAULT_AVG_R_CAP = 5;
const DEFAULT_AVG_R_SAMPLE_EXPONENT = 1.35;

function positive(value) {
  return Math.max(0, safeNumber(value, 0));
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Wilson Score Lower Bound
 * Gives conservative confidence interval for winrate
 */
export function wilsonLowerBound(wins = 0, completed = 0, z = DEFAULT_WILSON_Z) {
  const w = positive(wins);
  const n = positive(completed);
  
  if (n <= 0) return 0;
  
  const phat = w / n;
  const zz = z * z;
  
  const numerator = phat + (zz / (2 * n)) - z * Math.sqrt((phat * (1 - phat)) / n + (zz / (4 * n * n)));
  const denominator = 1 + (zz / n);
  
  return clamp(numerator / denominator, 0, 1);
}

/**
 * Bayesian Winrate with Beta prior
 * Alpha=1, Beta=1 = uniform prior
 */
export function bayesianWinrate(wins = 0, completed = 0) {
  const w = positive(wins);
  const n = positive(completed);
  const alpha = 1; // Prior successes
  const beta = 1;  // Prior failures
  
  return (w + alpha) / (n + alpha + beta);
}

/**
 * Sample reliability: how confident are we in the stats?
 * 0 = no data, 1 = fully confident (50+ trades)
 */
export function sampleReliability(completed = 0) {
  const cap = DEFAULT_SAMPLE_CAP; // 50
  const n = positive(completed);
  return clamp(n / cap, 0, 1);
}

/**
 * Build BalancedScore - THE RANKING METRIC
 * 
 * Higher = Better
 * Used for:
 *  - Ranking families for rotation
 *  - Automatic selection (top 42)
 *  - Dashboard display
 * 
 * FORMULA (CRITICAL - must match exactly):
 *   fair*100 
 *   + sampleRel*25 
 *   + log1p(totalR)*12 
 *   + log1p(avgR)*8 
 *   + profitFactor*8 
 *   + nearTpPct*4 
 *   + reachedOneRPct*4
 *   - directSLPct*35       ← Penalize hitting SL directly
 *   - nearTpThenLossPct*15 ← Penalize reaching TP then losing
 *   - gaveBackAfterOneRPct*10 ← Penalize giving back profits
 *   - avgCostR*8           ← Penalize high costs
 */
export function buildBalancedScore({
  fair = 0,
  avgR = 0,
  totalR = 0,
  sampleRel = 0,
  profitFactor = 0,
  nearTpPct = 0,
  reachedOneRPct = 0,
  directSLPct = 0,
  nearTpThenLossPct = 0,
  gaveBackAfterOneRPct = 0,
  avgCostR = 0
} = {}) {
  
  const fairComponent = positive(fair) * 100;
  const sampleComponent = positive(sampleRel) * 25;
  const totalRComponent = Math.log1p(positive(totalR)) * 12;
  const avgRComponent = Math.log1p(positive(avgR)) * 8;
  const pfNorm = clamp(positive(profitFactor), 0, 10) / 10;
  const pfComponent = pfNorm * 8;
  const nearTpComponent = positive(nearTpPct) * 4;
  const oneRComponent = positive(reachedOneRPct) * 4;
  
  // PENALTIES (subtract)
  const directSLPenalty = positive(directSLPct) * 35;
  const nearTpThenLossPenalty = positive(nearTpThenLossPct) * 15;
  const gaveBackPenalty = positive(gaveBackAfterOneRPct) * 10;
  const costPenalty = positive(avgCostR) * 8;
  
  return (
    fairComponent
    + sampleComponent
    + totalRComponent
    + avgRComponent
    + pfComponent
    + nearTpComponent
    + oneRComponent
    - directSLPenalty
    - nearTpThenLossPenalty
    - gaveBackPenalty
    - costPenalty
  );
}

/**
 * Create empty micro-family stats object
 */
export function createMicroStats(options = {}) {
  return {
    microFamilyId: options.microFamilyId || null,
    parentMicroFamilyId: options.parentMicroFamilyId || null,
    
    seen: 0,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    
    totalR: 0,
    totalPnlPct: 0,
    totalCostR: 0,
    
    avgR: 0,
    avgPnlPct: 0,
    avgCostR: 0,
    
    grossWinR: 0,
    grossLossR: 0,
    
    winrate: 0,
    fairWinrate: 0,
    sampleReliability: 0,
    profitFactor: 0,
    
    directSLCount: 0,
    nearTpCount: 0,
    gaveBackAfterOneRCount: 0,
    nearTpThenLossCount: 0,
    
    directSLPct: 0,
    nearTpPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,
    
    balancedScore: 0,
    
    updatedAt: Date.now(),
    ...options
  };
}

/**
 * Update stats with observation (position created)
 */
export function updateObservation(stats, row = {}) {
  if (!stats) return null;
  
  stats.seen = positive(stats.seen) + 1;
  stats.updatedAt = Date.now();
  
  return stats;
}

/**
 * Update stats with outcome (position closed)
 * CRITICAL: Use netR (after costs), not grossR
 */
export function updateOutcome(stats, row = {}) {
  if (!stats) return null;
  
  const netR = safeNumber(row.netR, 0);
  const costR = safeNumber(row.costR, 0);
  const directSL = row.directSL === true || row.hitSLDirectly === true;
  const nearTp = row.nearTP === true || row.nearTp === true;
  const gaveBack = row.gaveBackAfterOneR === true;
  const nearTpThenLoss = row.nearTpThenLoss === true;
  
  // Increment completed
  stats.completed = positive(stats.completed) + 1;
  
  // Count win/loss/flat based on NET-R
  if (netR > 0) {
    stats.wins = positive(stats.wins) + 1;
  } else if (netR < 0) {
    stats.losses = positive(stats.losses) + 1;
  } else {
    stats.flats = positive(stats.flats) + 1;
  }
  
  // Add to totals (using NET-R!)
  stats.totalR = positive(stats.totalR) + netR;
  stats.totalCostR = positive(stats.totalCostR) + costR;
  
  // Track quality metrics
  if (directSL) {
    stats.directSLCount = positive(stats.directSLCount) + 1;
  }
  if (nearTp) {
    stats.nearTpCount = positive(stats.nearTpCount) + 1;
  }
  if (gaveBack) {
    stats.gaveBackAfterOneRCount = positive(stats.gaveBackAfterOneRCount) + 1;
  }
  if (nearTpThenLoss) {
    stats.nearTpThenLossCount = positive(stats.nearTpThenLossCount) + 1;
  }
  
  stats.updatedAt = Date.now();
  
  return stats;
}

/**
 * Refresh all calculated metrics from raw stats
 * Called after every update to recalculate scores
 * CRITICAL: Must be mathematically correct
 */
export function refreshStats(stats) {
  if (!stats) return null;
  
  const completed = positive(stats.completed);
  const wins = positive(stats.wins);
  const totalR = safeNumber(stats.totalR, 0);
  const totalCostR = positive(stats.totalCostR);
  
  // Basic calculations
  const winrate = completed > 0 ? wins / completed : 0;
  const bayes = bayesianWinrate(wins, completed);
  const wilson = wilsonLowerBound(wins, completed);
  const fair = completed > 0
    ? (wilson * 0.8 + bayes * 0.15 + winrate * 0.05)
    : 0;
  
  const sampleRel = sampleReliability(completed);
  const avgR = completed > 0 ? totalR / completed : 0;
  const avgCostR = completed > 0 ? totalCostR / completed : 0;
  
  const losses = positive(stats.losses);
  const grossWinR = positive(stats.grossWinR || (totalR > 0 && wins > 0 ? totalR : 0));
  const grossLossR = positive(stats.grossLossR || (totalR < 0 && losses > 0 ? Math.abs(totalR) : 0));
  const profitFactor = grossLossR > 0 ? grossWinR / grossLossR : (grossWinR > 0 ? 99 : 0);
  
  // Percentages
  const directSLPct = completed > 0 ? positive(stats.directSLCount) / completed : 0;
  const nearTpPct = completed > 0 ? positive(stats.nearTpCount) / completed : 0;
  const gaveBackAfterOneRPct = completed > 0 ? positive(stats.gaveBackAfterOneRCount) / completed : 0;
  const nearTpThenLossPct = completed > 0 ? positive(stats.nearTpThenLossCount) / completed : 0;
  
  // Calculate balanced score
  const balancedScore = buildBalancedScore({
    fair,
    avgR,
    totalR,
    sampleRel,
    profitFactor,
    nearTpPct,
    reachedOneRPct: nearTpPct, // Use nearTpPct as proxy for 1R reached
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
  });
  
  // Update stats object
  Object.assign(stats, {
    winrate: Number(winrate.toFixed(4)),
    fairWinrate: Number(fair.toFixed(4)),
    sampleReliability: Number(sampleRel.toFixed(4)),
    avgR: Number(avgR.toFixed(4)),
    avgCostR: Number(avgCostR.toFixed(4)),
    profitFactor: Number(profitFactor.toFixed(2)),
    directSLPct: Number(directSLPct.toFixed(4)),
    nearTpPct: Number(nearTpPct.toFixed(4)),
    gaveBackAfterOneRPct: Number(gaveBackAfterOneRPct.toFixed(4)),
    nearTpThenLossPct: Number(nearTpThenLossPct.toFixed(4)),
    balancedScore: Number(balancedScore.toFixed(2)),
    updatedAt: Date.now()
  });
  
  return stats;
}

/**
 * Rank multiple families by balancedScore
 * Used for rotation selection
 */
export function rankMicros(micros = {}, mode = 'balanced') {
  const entries = Object.entries(micros);
  
  if (mode === 'balanced') {
    return entries.sort((a, b) => {
      const scoreA = safeNumber(b[1].balancedScore, 0);
      const scoreB = safeNumber(a[1].balancedScore, 0);
      return scoreA - scoreB;
    }).map(([id, stats]) => ({ id, ...stats }));
  }
  
  // Default to balanced
  return rankMicros(micros, 'balanced');
}

export default {
  wilsonLowerBound,
  bayesianWinrate,
  sampleReliability,
  buildBalancedScore,
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats,
  rankMicros
};
