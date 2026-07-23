// ================= FILE: src/market/fakeBreakout.js =================
// Fake breakout detection

import { getRedis } from '../redis.js';
import { now } from '../utils.js';

export function isFakeBreakout(closes = [], entryPrice = 0, lookback = 20) {
  if (!closes || closes.length < lookback + 5) return false;
  
  const recent = closes.slice(-(lookback + 5)).map(c => parseFloat(c));
  const support = Math.min(...recent.slice(0, lookback));
  const breakPrice = parseFloat(entryPrice);
  
  if (breakPrice < support * 0.99) {
    const afterBreak = recent.slice(-5);
    const high = Math.max(...afterBreak);
    return high > breakPrice * 1.01;
  }
  return false;
}

export function validateBreakout(closes = [], setup = '', regime = '') {
  if (!closes || closes.length < 20) return { valid: false, confidence: 0, reason: 'INSUFFICIENT_DATA' };
  
  let confidence = 0;
  if (setup === 'BREAKOUT') {
    const recent = closes.slice(-5).map(c => parseFloat(c)).reduce((a, b) => a + b, 0) / 5;
    const prev = closes.slice(-10, -5).map(c => parseFloat(c)).reduce((a, b) => a + b, 0) / 5;
    confidence = recent < prev * 0.99 ? 0.85 : (recent < prev ? 0.65 : 0.25);
  } else if (setup === 'RETEST') {
    confidence = 0.75;
  } else if (setup === 'CONTINUATION') {
    const recent = closes.slice(-3).map(c => parseFloat(c));
    confidence = recent[0] > recent[1] && recent[1] > recent[2] ? 0.75 : 0.45;
  } else {
    confidence = 0.5;
  }
  return { valid: confidence > 0.5, confidence };
}

export function checkReversalRisk(closes = [], rsi = 50, bb = null, regime = '') {
  let score = 0;
  const reasons = [];
  
  if (rsi > 80) { score += 30; reasons.push('OVERBOUGHT'); }
  else if (rsi > 70) { score += 15; reasons.push('EXTENDED'); }
  
  if (regime === 'CHOP') { score += 20; reasons.push('CHOPPY'); }
  
  let level = 'LOW';
  if (score > 70) level = 'CRITICAL';
  else if (score > 50) level = 'HIGH';
  else if (score > 30) level = 'MEDIUM';
  
  return { riskLevel: level, score, reasons };
}

export function detectTrapMove(highs = [], lows = [], closes = []) {
  if (!highs || !lows || closes.length < 15) return { isTrap: false, confidence: 0 };
  
  const recent = closes.slice(-10).map(c => parseFloat(c));
  const high = Math.max(...highs.slice(-10).map(h => parseFloat(h)));
  const low = Math.min(...lows.slice(-10).map(l => parseFloat(l)));
  
  let isTrap = false;
  let confidence = 0;
  
  if (recent[0] < high && recent[recent.length - 1] > high * 0.99) {
    if (Math.min(...recent.slice(0, 7)) < recent[0]) {
      isTrap = true;
      confidence = 0.75;
    }
  }
  
  return { isTrap, confidence, pattern: isTrap ? 'TRAP_MOVE' : 'NORMAL', highestHigh: high, lowestLow: low };
}

export async function recordFakeBreakoutAlert(symbol = '', entryPrice = 0) {
  try {
    const redis = await import('../redis.js').then(m => m.getRedis());
    const key = `FAKE_BREAKOUT:${symbol}`;
    await redis.set(key, { symbol, entryPrice, timestamp: now(), detected: true, expires: now() + (24 * 60 * 60 * 1000) });
    return { ok: true };
  } catch (err) {
    console.error('recordFakeBreakoutAlert error:', err);
    return { ok: false, error: err.message };
  }
}

export default { isFakeBreakout, validateBreakout, checkReversalRisk, detectTrapMove, recordFakeBreakoutAlert };
