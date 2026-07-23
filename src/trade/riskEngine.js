// ================= FILE: src/trade/riskEngine.js =================
//
// Risk management engine
// Validates risk/reward geometry, drawdown limits, position sizing
//

/**
 * Calculate and validate risk geometry for a trade
 */
export function calculateRiskGeometry({
  entryPrice = 0,
  stopLoss = 0,
  takeProfit = 0,
  side = 'SHORT'
} = {}) {
  const entry = parseFloat(entryPrice);
  const sl = parseFloat(stopLoss);
  const tp = parseFloat(takeProfit);

  if (entry <= 0) {
    return {
      ok: false,
      reason: 'INVALID_ENTRY'
    };
  }

  // Validate SHORT geometry
  if (side === 'SHORT') {
    if (sl <= entry) {
      return {
        ok: false,
        reason: 'INVALID_GEOMETRY_SHORT_SL_TOO_LOW'
      };
    }
    if (tp >= entry) {
      return {
        ok: false,
        reason: 'INVALID_GEOMETRY_SHORT_TP_TOO_HIGH'
      };
    }
  }
  // Validate LONG geometry
  else if (side === 'LONG') {
    if (sl >= entry) {
      return {
        ok: false,
        reason: 'INVALID_GEOMETRY_LONG_SL_TOO_HIGH'
      };
    }
    if (tp <= entry) {
      return {
        ok: false,
        reason: 'INVALID_GEOMETRY_LONG_TP_TOO_LOW'
      };
    }
  }

  // Calculate risk and reward
  const risk = Math.abs(sl - entry) / entry;
  const reward = Math.abs(entry - tp) / entry;
  const rrRatio = risk > 0 ? reward / risk : 0;

  return {
    ok: true,
    risk: risk,
    reward: reward,
    rrRatio: rrRatio,
    riskAmount: risk * 100, // as percentage
    rewardAmount: reward * 100, // as percentage
    riskRewardRatio: rrRatio,
    entry: entry,
    stopLoss: sl,
    takeProfit: tp,
    side: side
  };
}

/**
 * Validate if risk/reward ratio is acceptable
 */
export function validateRiskReward(rrRatio = 1, minRatio = 1.5) {
  const ratio = parseFloat(rrRatio);
  const min = parseFloat(minRatio);

  if (ratio <= 0 || min <= 0) {
    return {
      valid: false,
      reason: 'INVALID_VALUES'
    };
  }

  return {
    valid: ratio >= min,
    ratio: ratio,
    minRequired: min,
    message: ratio >= min ? 'Valid R/R ratio' : `Minimum R/R is ${min}:1`,
    shortfall: Math.max(0, min - ratio)
  };
}

/**
 * Calculate maximum risk allowed per trade
 */
export function calculateMaxRiskPerTrade(
  accountSize = 100000,
  riskPercent = 0.01,
  maxDrawdown = 0.10
) {
  const acct = parseFloat(accountSize);
  const risk = parseFloat(riskPercent);
  const dd = parseFloat(maxDrawdown);

  if (acct <= 0 || risk <= 0 || dd <= 0) {
    return {
      ok: false,
      reason: 'INVALID_VALUES'
    };
  }

  const riskPerTrade = acct * risk;
  const maxRiskAllowed = acct * dd;
  const maxTradesBeforeDD = Math.floor(maxRiskAllowed / Math.max(1, riskPerTrade));

  return {
    ok: true,
    riskPerTrade: riskPerTrade,
    maxRiskAllowed: maxRiskAllowed,
    tradesBeforeDrawdown: maxTradesBeforeDD,
    drawdownPercent: dd * 100,
    riskPercent: risk * 100
  };
}

/**
 * Calculate optimal risk fraction using Kelly Criterion
 */
export function calculateRiskFraction(stats = {}) {
  const winrate = parseFloat(stats.winrate || 0.5);
  const avgWinR = parseFloat(stats.avgWinR || 1);
  const avgLossR = parseFloat(stats.avgLossR || 1);
  const completed = parseInt(stats.completed || 0);
  const sampleCap = 50;

  // Validate inputs
  if (winrate <= 0 || winrate >= 1 || avgWinR <= 0 || avgLossR <= 0) {
    return {
      fraction: 0.1,
      confidence: 0,
      reason: 'INVALID_STATS'
    };
  }

  // Adjust confidence based on sample size
  const sampleConfidence = Math.min(completed / sampleCap, 1);

  // Calculate base Kelly fraction
  // Kelly = (win rate * avg win - (1 - win rate) * avg loss) / avg win
  const kelly = (winrate * avgWinR - (1 - winrate) * avgLossR) / avgWinR;

  // Use fractional Kelly (25%) for safety
  let fraction = Math.max(0, kelly) * 0.25;

  // Reduce further if low sample confidence
  fraction *= sampleConfidence;

  return {
    fraction: Math.min(fraction, 0.25),
    baseKelly: Math.max(0, kelly),
    confidence: sampleConfidence,
    stats: {
      winrate: winrate,
      avgWinR: avgWinR,
      avgLossR: avgLossR,
      completed: completed
    }
  };
}

/**
 * Check if position size is within risk limits
 */
export function isPositionRisky({
  riskPercent = 0.01,
  accountSize = 100000,
  position = 0,
  maxPositionPct = 0.05
} = {}) {
  const risk = parseFloat(riskPercent);
  const acct = parseFloat(accountSize);
  const pos = parseFloat(position);
  const maxPos = parseFloat(maxPositionPct);

  if (acct <= 0) {
    return {
      ok: false,
      risky: true,
      reason: 'INVALID_ACCOUNT_SIZE'
    };
  }

  const riskAmount = acct * risk;
  const maxPositionSize = acct * maxPos;

  return {
    ok: true,
    risky: pos > maxPositionSize,
    riskAmount: riskAmount,
    maxPositionSize: maxPositionSize,
    positionSize: pos,
    message: pos > maxPositionSize ? `Position ${pos} exceeds max ${maxPositionSize}` : 'Position within limits',
    percentOfAccount: (pos / acct) * 100
  };
}

/**
 * Calculate cumulative drawdown from series of returns
 */
export function calculateDrawdown(returns = []) {
  if (!returns || returns.length === 0) {
    return {
      maxDrawdown: 0,
      currentDrawdown: 0,
      peak: 0,
      trough: 0
    };
  }

  let cumulative = 1;
  let peak = 1;
  let maxDD = 0;

  const values = [];

  for (const ret of returns) {
    cumulative = cumulative * (1 + parseFloat(ret));
    values.push(cumulative);

    if (cumulative > peak) {
      peak = cumulative;
    }

    const dd = (peak - cumulative) / peak;
    maxDD = Math.max(maxDD, dd);
  }

  const currentDD = (peak - cumulative) / peak;

  return {
    maxDrawdown: maxDD,
    currentDrawdown: currentDD,
    peak: peak - 1,
    trough: Math.min(...values) - 1,
    message: maxDD > 0.20 ? 'EXTREME_DD' : (maxDD > 0.15 ? 'HIGH_DD' : 'NORMAL_DD')
  };
}

/**
 * Check if trading should halt due to risk limits
 */
export function shouldHaltTrading({
  currentDrawdown = 0,
  maxAllowedDrawdown = 0.20,
  dailyLossCount = 0,
  maxConsecutiveLosses = 5,
  openPositions = 0,
  maxOpenPositions = 5
} = {}) {
  const reasons = [];

  if (parseFloat(currentDrawdown) > parseFloat(maxAllowedDrawdown)) {
    reasons.push('DRAWDOWN_LIMIT_EXCEEDED');
  }

  if (parseInt(dailyLossCount) > parseInt(maxConsecutiveLosses)) {
    reasons.push('TOO_MANY_LOSSES');
  }

  if (parseInt(openPositions) > parseInt(maxOpenPositions)) {
    reasons.push('TOO_MANY_OPEN');
  }

  return {
    shouldHalt: reasons.length > 0,
    reasons: reasons,
    safe: reasons.length === 0,
    metrics: {
      currentDrawdown: parseFloat(currentDrawdown),
      maxAllowed: parseFloat(maxAllowedDrawdown),
      lossStreak: parseInt(dailyLossCount),
      openPositions: parseInt(openPositions)
    }
  };
}

/**
 * Validate trade request against all risk criteria
 */
export function validateTradeRequest(tradeData = {}) {
  const results = {
    valid: true,
    errors: [],
    warnings: []
  };

  // Check geometry
  const geometry = calculateRiskGeometry({
    entryPrice: tradeData.entryPrice,
    stopLoss: tradeData.stopLoss,
    takeProfit: tradeData.takeProfit,
    side: tradeData.side || 'SHORT'
  });

  if (!geometry.ok) {
    results.valid = false;
    results.errors.push(geometry.reason);
  } else {
    // Check R/R ratio
    const rrCheck = validateRiskReward(geometry.rrRatio, 1.5);
    if (!rrCheck.valid) {
      results.warnings.push('LOW_RR_RATIO');
    }
  }

  // Check position size
  const posRisk = isPositionRisky({
    riskPercent: tradeData.riskPercent || 0.01,
    accountSize: tradeData.accountSize || 100000,
    position: tradeData.position || 0
  });

  if (posRisk.risky) {
    results.warnings.push('POSITION_TOO_LARGE');
  }

  return results;
}

export default {
  calculateRiskGeometry,
  validateRiskReward,
  calculateMaxRiskPerTrade,
  calculateRiskFraction,
  isPositionRisky,
  calculateDrawdown,
  shouldHaltTrading,
  validateTradeRequest
};
