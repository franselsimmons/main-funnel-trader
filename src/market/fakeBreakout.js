// ================= FILE: src/market/fakeBreakout.js =================
//
// Fake breakout detection and validation
// Prevents trading trap moves
//

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now } from '../utils.js';

/**
 * Detect if a breakout is likely fake
 */
export function isFakeBreakout(closes = [], entryPrice = 0, lookbackPeriod = 20) {
  if (!closes || closes.length < lookbackPeriod + 5) {
    return false;
  }

  const recentClosures = closes.slice(-(lookbackPeriod + 5)).map(c => parseFloat(c));
  const support = Math.min(...recentClosures.slice(0, lookbackPeriod));
  const breakPrice = parseFloat(entryPrice);

  // If entry breaks well below support
  if (breakPrice < support * 0.99) {
    // Check if already bounced back up
    const afterBreak = recentClosures.slice(-5);
    const highAfterBreak = Math.max(...afterBreak);

    if (highAfterBreak > breakPrice * 1.01) {
      return true; // Fake breakout detected
    }
  }

  return false;
}

/**
 * Validate breakout quality
 */
export function validateBreakout(closes = [], setup = '', regime = '') {
  if (!closes || closes.length < 20) {
    return {
      valid: false,
      confidence: 0,
      reason: 'INSUFFICIENT_DATA'
    };
  }

  let confidence = 0;
  let reason = '';

  if (setup === 'BREAKOUT') {
    // BREAKOUT requires strong momentum
    const recent5 = closes.slice(-5).map(c => parseFloat(c));
    const avg5 = recent5.reduce((a, b) => a + b, 0) / 5;
    
    const prev5 = closes.slice(-10, -5).map(c => parseFloat(c));
    const avgPrev5 = prev5.length > 0 ? prev5.reduce((a, b) => a + b, 0) / 5 : avg5;

    if (avg5 < avgPrev5 * 0.99) {
      confidence = 0.85;
      reason = 'STRONG_MOMENTUM';
    } else if (avg5 < avgPrev5) {
      confidence = 0.65;
      reason = 'WEAK_MOMENTUM';
    } else {
      confidence = 0.25;
      reason = 'NO_MOMENTUM';
    }
  } else if (setup === 'RETEST') {
    // RETEST must touch support level
    const support = Math.min(...closes.slice(-20));
    const lastClose = closes[closes.length - 1];
    
    if (lastClose > support && lastClose < support * 1.02) {
      confidence = 0.75;
      reason = 'VALID_RETEST';
    } else {
      confidence = 0.55;
      reason = 'WEAK_RETEST';
    }
  } else if (setup === 'SWEEP_REVERSAL') {
    // SWEEP_REVERSAL needs reversal after sweep
    const recent10 = closes.slice(-10).map(c => parseFloat(c));
    const low10 = Math.min(...recent10);
    const lastClose = closes[closes.length - 1];
    
    if (lastClose > low10 * 1.005) {
      confidence = 0.7;
      reason = 'VALID_SWEEP';
    } else {
      confidence = 0.4;
      reason = 'INCOMPLETE_SWEEP';
    }
  } else if (setup === 'CONTINUATION') {
    // CONTINUATION needs momentum
    const recent3 = closes.slice(-3).map(c => parseFloat(c));
    const allDown = recent3[0] > recent3[1] && recent3[1] > recent3[2];
    
    if (allDown) {
      confidence = 0.75;
      reason = 'STRONG_CONTINUATION';
    } else {
      confidence = 0.45;
      reason = 'WEAK_CONTINUATION';
    }
  } else if (setup === 'COMPRESSION') {
    // COMPRESSION needs to break out of range
    const recent5 = closes.slice(-5).map(c => parseFloat(c));
    const range = Math.max(...recent5) - Math.min(...recent5);
    const avg5 = recent5.reduce((a, b) => a + b, 0) / 5;
    
    if (range / avg5 < 0.005) {
      confidence = 0.7;
      reason = 'TIGHT_COMPRESSION';
    } else {
      confidence = 0.5;
      reason = 'LOOSE_COMPRESSION';
    }
  } else {
    confidence = 0.5;
    reason = 'UNKNOWN_SETUP';
  }

  return {
    valid: confidence > 0.5,
    confidence,
    reason,
    setup,
    regime
  };
}

/**
 * Check for reversal risk (likely to reverse)
 */
export function checkReversalRisk(closes = [], rsi = 50, bb = null, regime = '') {
  if (!closes || closes.length < 10) {
    return {
      riskLevel: 'UNKNOWN',
      score: 0,
      reasons: []
    };
  }

  const reasons = [];
  let riskScore = 0;

  // Extreme RSI (over-extended)
  if (rsi > 80) {
    riskScore += 30;
    reasons.push('OVERBOUGHT_RSI');
  } else if (rsi > 70) {
    riskScore += 15;
    reasons.push('EXTENDED_RSI');
  }

  // Extreme price vs BB
  const lastClose = closes[closes.length - 1];
  if (bb && lastClose < bb.lower) {
    riskScore += 20;
    reasons.push('BELOW_BB_LOWER');
  }

  // Divergence check
  const recent5 = closes.slice(-5).map(c => parseFloat(c));
  const prev5 = closes.slice(-10, -5).map(c => parseFloat(c));
  
  if (recent5.reduce((a, b) => a + b) / 5 > prev5.reduce((a, b) => a + b) / 5 && rsi > 70) {
    riskScore += 15;
    reasons.push('BEARISH_DIVERGENCE');
  }

  // Chop regime = higher reversal risk
  if (regime === 'CHOP') {
    riskScore += 20;
    reasons.push('CHOPPY_MARKET');
  }

  // Determine level
  let riskLevel = 'LOW';
  if (riskScore > 70) {
    riskLevel = 'CRITICAL';
  } else if (riskScore > 50) {
    riskLevel = 'HIGH';
  } else if (riskScore > 30) {
    riskLevel = 'MEDIUM';
  }

  return {
    riskLevel,
    score: riskScore,
    reasons,
    maxScore: 100
  };
}

/**
 * Detect trap move / stop hunt pattern
 */
export function detectTrapMove(highs = [], lows = [], closes = []) {
  if (!highs || !lows || !closes || closes.length < 15) {
    return {
      isTrap: false,
      confidence: 0
    };
  }

  const recent10 = closes.slice(-10).map(c => parseFloat(c));
  const recent10Highs = highs.slice(-10).map(h => parseFloat(h));
  const recent10Lows = lows.slice(-10).map(l => parseFloat(l));

  // Find highest high and lowest low
  const highestHigh = Math.max(...recent10Highs);
  const lowestLow = Math.min(...recent10Lows);

  // Check pattern: high -> low -> high or low -> high -> low
  // Last close should be opposite to initial direction
  const firstClose = recent10[0];
  const lastClose = recent10[recent10.length - 1];
  const midClose = recent10[Math.floor(recent10.length / 2)];

  // Trap if: Started high, went low, came back high (or vice versa)
  let isTrap = false;
  let confidence = 0;

  // Bullish trap: price goes up, breaks down, comes back up
  if (firstClose < highestHigh && lastClose > highestHigh * 0.99) {
    const touchedLow = Math.min(...recent10Lows);
    if (touchedLow < firstClose) {
      isTrap = true;
      confidence = 0.75;
    }
  }

  // Bearish trap: price goes down, bounces up, comes back down
  if (firstClose > lowestLow && lastClose < lowestLow * 1.01) {
    const touchedHigh = Math.max(...recent10Highs);
    if (touchedHigh > firstClose) {
      isTrap = true;
      confidence = 0.75;
    }
  }

  return {
    isTrap,
    confidence,
    pattern: isTrap ? 'TRAP_MOVE' : 'NORMAL',
    highestHigh,
    lowestLow
  };
}

/**
 * Record fake breakout alert
 */
export async function recordFakeBreakoutAlert(symbol = '', entryPrice = 0) {
  try {
    const redis = getRedis();
    const key = `FAKE_BREAKOUT:${symbol}`;

    await redis.set(key, {
      symbol,
      entryPrice,
      timestamp: now(),
      detected: true,
      expires: now() + (24 * 60 * 60 * 1000) // 24 hours
    });

    return { ok: true };
  } catch (err) {
    console.error('recordFakeBreakoutAlert error:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Get fake breakout history
 */
export async function getFakeBreakoutHistory(symbol = '') {
  try {
    const redis = getRedis();
    const key = `FAKE_BREAKOUT:${symbol}`;
    const data = await redis.get(key);

    if (!data) {
      return { ok: true, found: false };
    }

    return { ok: true, found: true, alert: data };
  } catch (err) {
    console.error('getFakeBreakoutHistory error:', err);
    return { ok: false, error: err.message };
  }
}

export default {
  isFakeBreakout,
  validateBreakout,
  checkReversalRisk,
  detectTrapMove,
  recordFakeBreakoutAlert,
  getFakeBreakoutHistory
};
