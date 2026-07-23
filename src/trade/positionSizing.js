// ================= FILE: src/trade/positionSizing.js =================
//
// Position sizing using Kelly Criterion and family confidence
// Calculates optimal contract size for each trade
//

/**
 * Calculate Kelly Fraction from win statistics
 */
export function calculateKellyFraction(winrate = 0.5, avgWinR = 1, avgLossR = 1) {
  if (winrate <= 0 || winrate >= 1) {
    return 0.1; // Default 10% if invalid
  }

  const w = parseFloat(winrate);
  const win = parseFloat(avgWinR);
  const loss = parseFloat(avgLossR);

  if (win <= 0 || loss <= 0) {
    return 0.1;
  }

  // Kelly Criterion formula: f = (p * b - q) / b
  // where p = win rate, q = loss rate (1-p), b = ratio of win to loss
  const f = (w * win - (1 - w) * loss) / win;

  return Math.max(0, Math.min(f, 1));
}

/**
 * Calculate fractional Kelly (safer approach)
 */
export function calculateFractionalKelly(
  winrate = 0.5,
  avgWinR = 1,
  avgLossR = 1,
  fraction = 0.25
) {
  const kelly = calculateKellyFraction(winrate, avgWinR, avgLossR);
  const fractionalKelly = kelly * parseFloat(fraction);

  return Math.max(0, Math.min(fractionalKelly, 0.5));
}

/**
 * Calculate position size as % of account using Kelly
 */
export function calculatePositionSizeByKelly(
  accountRisk = 0.01,
  winrate = 0.5,
  avgWinR = 1,
  avgLossR = 1,
  maxFraction = 0.25
) {
  const risk = parseFloat(accountRisk);
  const kelly = calculateKellyFraction(winrate, avgWinR, avgLossR);
  const fractionalKelly = kelly * parseFloat(maxFraction);

  // Position size as % of account
  return Math.min(fractionalKelly, risk);
}

/**
 * Calculate position size by fixed risk amount
 */
export function calculatePositionSizeByRisk(
  accountSize = 100000,
  riskAmount = 1000,
  contractValue = 1
) {
  const acct = parseFloat(accountSize);
  const risk = parseFloat(riskAmount);
  const value = parseFloat(contractValue);

  if (acct <= 0 || risk <= 0 || value <= 0) {
    return 0;
  }

  // How many contracts to risk exactly $risk?
  return Math.floor(risk / value);
}

/**
 * Calculate contract size from risk/reward geometry
 */
export function calculateContractSize(
  accountSize = 100000,
  riskPct = 0.01,
  entryPrice = 50000,
  stopLoss = 51000
) {
  const entry = parseFloat(entryPrice);
  const stop = parseFloat(stopLoss);
  const acct = parseFloat(accountSize);
  const risk = parseFloat(riskPct);

  if (acct <= 0 || entry <= 0 || stop <= entry) {
    return 0;
  }

  const riskPerContract = Math.abs(stop - entry);
  const riskAmount = acct * risk;

  if (riskPerContract <= 0) {
    return 0;
  }

  return Math.floor(riskAmount / riskPerContract);
}

/**
 * Adjust position size based on family confidence
 */
export function adjustForFamilyConfidence(baseSize = 1, familyConfidence = 0.5) {
  const base = parseFloat(baseSize);
  const confidence = parseFloat(familyConfidence);

  if (base <= 0 || confidence <= 0) {
    return 0;
  }

  // Low confidence (< 0.5): reduced size
  if (confidence < 0.5) {
    return base * confidence * 0.5;
  }

  // Normal confidence (0.5-1): scale up gradually
  // At 0.5 = 0.5x, at 1.0 = 1.5x
  return base * (0.5 + (confidence - 0.5) * 1.5);
}

/**
 * Adjust for sample size (higher confidence with more trades)
 */
export function adjustForSampleSize(baseSize = 1, sampleCount = 0, minSample = 20) {
  const base = parseFloat(baseSize);
  const sample = parseInt(sampleCount);
  const min = parseInt(minSample);

  if (base <= 0) {
    return 0;
  }

  // Confidence ramps up as we get more samples
  const sampleConfidence = Math.min(sample / min, 1);

  return base * sampleConfidence;
}

/**
 * Calculate risk per trade in dollars
 */
export function calculateRiskPerTrade(accountSize = 100000, riskPercent = 0.01) {
  const acct = parseFloat(accountSize);
  const risk = parseFloat(riskPercent);

  if (acct <= 0 || risk <= 0) {
    return 0;
  }

  return acct * risk;
}

/**
 * Calculate max position size to stay within account limits
 */
export function calculateMaxPositionSize(
  accountSize = 100000,
  maxAccountRiskPct = 0.05
) {
  const acct = parseFloat(accountSize);
  const maxRisk = parseFloat(maxAccountRiskPct);

  if (acct <= 0 || maxRisk <= 0) {
    return 0;
  }

  // Max position can be 5% of account at risk
  return acct * maxRisk;
}

/**
 * Multi-factor position sizing
 * Combines Kelly, confidence, sample size, and risk limits
 */
export function calculateOptimalPositionSize({
  accountSize = 100000,
  riskPct = 0.01,
  entryPrice = 0,
  stopLoss = 0,
  winrate = 0.5,
  avgWinR = 1,
  avgLossR = 1,
  familyConfidence = 0.5,
  sampleCount = 0,
  minSample = 20,
  maxAccountRiskPct = 0.05
} = {}) {
  
  // Base size from Kelly
  const baseSize = calculatePositionSizeByKelly(
    riskPct,
    winrate,
    avgWinR,
    avgLossR,
    0.25
  );

  // Apply confidence adjustment
  const confidenceAdjusted = adjustForFamilyConfidence(baseSize, familyConfidence);

  // Apply sample size adjustment
  const sampleAdjusted = adjustForSampleSize(confidenceAdjusted, sampleCount, minSample);

  // Apply account size limits
  const maxSize = calculateMaxPositionSize(accountSize, maxAccountRiskPct);
  const finalSize = Math.min(sampleAdjusted, maxSize);

  // Calculate actual contract size from risk geometry
  const contracts = calculateContractSize(accountSize, riskPct, entryPrice, stopLoss);

  return {
    positionSizePercent: finalSize,
    baseSize,
    confidenceAdjusted,
    sampleAdjusted,
    contracts: Math.max(0, contracts),
    riskAmount: calculateRiskPerTrade(accountSize, riskPct),
    maxAllowed: maxSize,
    factors: {
      kelly: calculateKellyFraction(winrate, avgWinR, avgLossR),
      confidence: parseFloat(familyConfidence),
      sampleConfidence: Math.min(sampleCount / minSample, 1),
      accountRiskLimit: maxAccountRiskPct
    }
  };
}

export default {
  calculateKellyFraction,
  calculateFractionalKelly,
  calculatePositionSizeByKelly,
  calculatePositionSizeByRisk,
  calculateContractSize,
  adjustForFamilyConfidence,
  adjustForSampleSize,
  calculateRiskPerTrade,
  calculateMaxPositionSize,
  calculateOptimalPositionSize
};
