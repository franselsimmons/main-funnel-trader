// ================= FILE: src/market/fakeBreakout.js =================

import {
  getRecentRange,
  calcVolumeExpansion,
  candleBodyPct,
  upperWickPct,
  lowerWickPct
} from './indicators.js';
import {
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const DEFAULT_LOOKBACK = 24;
const RETEST_TOLERANCE_PCT = 0.004;
const BREAKOUT_BUFFER_PCT = 0.0015;
const WICK_REJECT_THRESHOLD = 0.45;
const WEAK_BODY_THRESHOLD = 0.35;
const EXHAUSTION_VOLUME_EXPANSION = 1.4;

function normalizeSide(side) {
  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
}

function normalizeBtcState(btcState) {
  return String(btcState || 'NEUTRAL').toUpperCase();
}

function emptyResult(reason = 'INSUFFICIENT_DATA') {
  return {
    fakeBreakout: false,
    fakeBreakoutRisk: false,
    fakeBreakoutReason: null,
    breakoutType: 'UNKNOWN',
    pullbackConfirmed: false,
    sweepConfirmed: false,
    retestConfirmed: false,
    reason
  };
}

function pctDistance(a, b) {
  const x = safeNumber(a, 0);
  const y = safeNumber(b, 0);

  if (x <= 0 || y <= 0) return Infinity;

  return Math.abs(x - y) / Math.max(x, y);
}

function isBtcAgainst(side, btcState) {
  if (side === 'bull') {
    return ['BEARISH', 'STRONG_BEAR'].includes(btcState);
  }

  if (side === 'bear') {
    return ['BULLISH', 'STRONG_BULL'].includes(btcState);
  }

  return false;
}

function isBtcWith(side, btcState) {
  if (side === 'bull') {
    return ['BULLISH', 'STRONG_BULL'].includes(btcState);
  }

  if (side === 'bear') {
    return ['BEARISH', 'STRONG_BEAR'].includes(btcState);
  }

  return false;
}

function analyzeBullBreakout({
  last,
  recentHigh,
  recentLow,
  volumeExpansion,
  btcState
}) {
  const close = safeNumber(last.close, 0);
  const high = safeNumber(last.high, 0);
  const low = safeNumber(last.low, 0);

  const upperWick = upperWickPct(last);
  const body = candleBodyPct(last);

  const sweptHigh = high > recentHigh && close < recentHigh;
  const closedAboveRange = close > recentHigh * (1 + BREAKOUT_BUFFER_PCT);

  const btcAgainst = isBtcAgainst('bull', btcState);
  const btcWith = isBtcWith('bull', btcState);

  const wickReject = upperWick >= WICK_REJECT_THRESHOLD;
  const weakBody = body <= WEAK_BODY_THRESHOLD;
  const volumeExhaustion = volumeExpansion >= EXHAUSTION_VOLUME_EXPANSION;

  const fake =
    sweptHigh &&
    wickReject &&
    (
      volumeExhaustion ||
      btcAgainst ||
      weakBody
    );

  const retestConfirmed =
    pctDistance(close, recentHigh) <= RETEST_TOLERANCE_PCT ||
    pctDistance(low, recentHigh) <= RETEST_TOLERANCE_PCT;

  const pullbackConfirmed =
    close < recentHigh &&
    close > recentLow;

  const validBreakout =
    closedAboveRange &&
    !wickReject &&
    (
      btcWith ||
      volumeExpansion >= 1.15
    );

  return {
    fakeBreakout: fake,
    fakeBreakoutRisk: !fake && (sweptHigh || (closedAboveRange && !btcWith)),
    fakeBreakoutReason: fake ? 'HIGH_SWEEP_CLOSE_BACK_IN_RANGE' : null,
    breakoutType: fake ? 'FAKE_BREAKOUT' : validBreakout ? 'VALID_BREAKOUT' : 'NONE',
    pullbackConfirmed,
    sweepConfirmed: sweptHigh,
    retestConfirmed,
    details: {
      recentHigh,
      recentLow,
      close,
      high,
      low,
      upperWick,
      body,
      volumeExpansion,
      btcState,
      btcAgainst,
      btcWith,
      sweptHigh,
      closedAboveRange,
      wickReject,
      weakBody,
      volumeExhaustion,
      validBreakout
    }
  };
}

function analyzeBearBreakout({
  last,
  recentHigh,
  recentLow,
  volumeExpansion,
  btcState
}) {
  const close = safeNumber(last.close, 0);
  const high = safeNumber(last.high, 0);
  const low = safeNumber(last.low, 0);

  const lowerWick = lowerWickPct(last);
  const body = candleBodyPct(last);

  const sweptLow = low < recentLow && close > recentLow;
  const closedBelowRange = close < recentLow * (1 - BREAKOUT_BUFFER_PCT);

  const btcAgainst = isBtcAgainst('bear', btcState);
  const btcWith = isBtcWith('bear', btcState);

  const wickReject = lowerWick >= WICK_REJECT_THRESHOLD;
  const weakBody = body <= WEAK_BODY_THRESHOLD;
  const volumeExhaustion = volumeExpansion >= EXHAUSTION_VOLUME_EXPANSION;

  const fake =
    sweptLow &&
    wickReject &&
    (
      volumeExhaustion ||
      btcAgainst ||
      weakBody
    );

  const retestConfirmed =
    pctDistance(close, recentLow) <= RETEST_TOLERANCE_PCT ||
    pctDistance(high, recentLow) <= RETEST_TOLERANCE_PCT;

  const pullbackConfirmed =
    close > recentLow &&
    close < recentHigh;

  const validBreakout =
    closedBelowRange &&
    !wickReject &&
    (
      btcWith ||
      volumeExpansion >= 1.15
    );

  return {
    fakeBreakout: fake,
    fakeBreakoutRisk: !fake && (sweptLow || (closedBelowRange && !btcWith)),
    fakeBreakoutReason: fake ? 'LOW_SWEEP_CLOSE_BACK_IN_RANGE' : null,
    breakoutType: fake ? 'FAKE_BREAKOUT' : validBreakout ? 'VALID_BREAKOUT' : 'NONE',
    pullbackConfirmed,
    sweepConfirmed: sweptLow,
    retestConfirmed,
    details: {
      recentHigh,
      recentLow,
      close,
      high,
      low,
      lowerWick,
      body,
      volumeExpansion,
      btcState,
      btcAgainst,
      btcWith,
      sweptLow,
      closedBelowRange,
      wickReject,
      weakBody,
      volumeExhaustion,
      validBreakout
    }
  };
}

export function detectFakeBreakout({
  side,
  candles15m,
  btcState = 'NEUTRAL',
  lookback = DEFAULT_LOOKBACK
} = {}) {
  const rows = Array.isArray(candles15m)
    ? candles15m.filter(Boolean)
    : [];

  const lb = Math.max(
    5,
    Math.floor(Number(lookback) || DEFAULT_LOOKBACK)
  );

  if (rows.length < lb + 2) {
    return emptyResult('INSUFFICIENT_CANDLES');
  }

  const normalizedSide = normalizeSide(side);

  if (normalizedSide === 'unknown') {
    return emptyResult('UNKNOWN_SIDE');
  }

  const last = rows.at(-1);
  const prior = rows.slice(-(lb + 1), -1);
  const { recentHigh, recentLow } = getRecentRange(prior, lb);

  if (
    !last ||
    recentHigh <= 0 ||
    recentLow <= 0 ||
    recentHigh <= recentLow
  ) {
    return emptyResult('INVALID_RANGE');
  }

  const normalizedBtcState = normalizeBtcState(btcState);
  const volumeExpansion = calcVolumeExpansion(rows, lb);

  if (normalizedSide === 'bull') {
    return analyzeBullBreakout({
      last,
      recentHigh,
      recentLow,
      volumeExpansion,
      btcState: normalizedBtcState
    });
  }

  return analyzeBearBreakout({
    last,
    recentHigh,
    recentLow,
    volumeExpansion,
    btcState: normalizedBtcState
  });
}