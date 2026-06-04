// ================= FILE: src/market/fakeBreakout.js =================

import { getRecentRange, calcVolumeExpansion } from './indicators.js';
import { safeNumber } from '../utils.js';

export function detectFakeBreakout({ side, candles15m, btcState = 'NEUTRAL', lookback = 24 }) {
  const rows = Array.isArray(candles15m) ? candles15m : [];
  const last = rows.at(-1);
  if (!last || rows.length < lookback + 2) {
    return {
      fakeBreakout: false,
      fakeBreakoutRisk: false,
      fakeBreakoutReason: null,
      breakoutType: 'UNKNOWN',
      pullbackConfirmed: false,
      sweepConfirmed: false,
      retestConfirmed: false
    };
  }

  const prior = rows.slice(-(lookback + 1), -1);
  const { recentHigh, recentLow } = getRecentRange(prior, lookback);
  const close = safeNumber(last.close);
  const high = safeNumber(last.high);
  const low = safeNumber(last.low);
  const open = safeNumber(last.open);
  const range = Math.max(high - low, 0);
  const volumeExpansion = calcVolumeExpansion(rows, lookback);

  const upperWickPct = range > 0 ? (high - Math.max(open, close)) / range : 0;
  const lowerWickPct = range > 0 ? (Math.min(open, close) - low) / range : 0;
  const btc = String(btcState || 'NEUTRAL').toUpperCase();
  const s = String(side || '').toLowerCase();

  if (s === 'bull') {
    const sweptHigh = high > recentHigh && close < recentHigh;
    const noBtcConfirm = ['BEARISH', 'STRONG_BEAR'].includes(btc);
    const wickReject = upperWickPct >= 0.45;
    const fake = sweptHigh && wickReject && (volumeExpansion >= 1.4 || noBtcConfirm);
    return {
      fakeBreakout: fake,
      fakeBreakoutRisk: !fake && sweptHigh,
      fakeBreakoutReason: fake ? 'HIGH_SWEEP_CLOSE_BACK_IN_RANGE' : null,
      breakoutType: fake ? 'FAKE_BREAKOUT' : high > recentHigh ? 'VALID_BREAKOUT_RISK' : 'NONE',
      pullbackConfirmed: close < recentHigh && close > recentLow,
      sweepConfirmed: sweptHigh,
      retestConfirmed: Math.abs(close - recentHigh) / Math.max(close, 1) <= 0.004
    };
  }

  const sweptLow = low < recentLow && close > recentLow;
  const noBtcConfirm = ['BULLISH', 'STRONG_BULL'].includes(btc);
  const wickReject = lowerWickPct >= 0.45;
  const fake = sweptLow && wickReject && (volumeExpansion >= 1.4 || noBtcConfirm);
  return {
    fakeBreakout: fake,
    fakeBreakoutRisk: !fake && sweptLow,
    fakeBreakoutReason: fake ? 'LOW_SWEEP_CLOSE_BACK_IN_RANGE' : null,
    breakoutType: fake ? 'FAKE_BREAKOUT' : low < recentLow ? 'VALID_BREAKOUT_RISK' : 'NONE',
    pullbackConfirmed: close > recentLow && close < recentHigh,
    sweepConfirmed: sweptLow,
    retestConfirmed: Math.abs(close - recentLow) / Math.max(close, 1) <= 0.004
  };
}
