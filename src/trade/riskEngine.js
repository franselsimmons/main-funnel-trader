// ================= FILE: src/trade/riskEngine.js =================

import { CONFIG } from '../config.js';
import {
  calculateAtrPct,
  calculateRsi,
  getRsiSlope,
  getRsiZone,
  classifyFlow
} from '../market/indicators.js';
import {
  clamp,
  getObRelation,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

function now() {
  return Date.now();
}

function tradeConfig() {
  return {
    minRR: safeNumber(CONFIG.trade?.minRR, 0.5),
    defaultRR: safeNumber(CONFIG.trade?.defaultRR, 1.5),
    maxSpreadPct: safeNumber(CONFIG.trade?.maxSpreadPct, 0.015)
  };
}

function fallbackSpreadPct() {
  return safeNumber(CONFIG.cost?.fallbackSpreadPct, 0.0008);
}

function scoreInput(candidate = {}) {
  return safeNumber(
    candidate.scannerScore ?? candidate.moveScore,
    0
  );
}

function roundPrice(value) {
  const n = safeNumber(value, 0);

  if (n >= 1000) return Number(n.toFixed(2));
  if (n >= 1) return Number(n.toFixed(6));

  return Number(n.toFixed(10));
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function isLong(side) {
  return sideToTradeSide(side) === 'LONG';
}

function isShort(side) {
  return sideToTradeSide(side) === 'SHORT';
}

function btcRelation(side, btcState) {
  const tradeSide = sideToTradeSide(side);
  const btc = String(btcState || 'NEUTRAL').toUpperCase();

  if (btc === 'NEUTRAL' || btc === 'UNKNOWN') return 'BTC_NEUTRAL';

  if (tradeSide === 'LONG' && ['BULLISH', 'STRONG_BULL'].includes(btc)) {
    return 'BTC_WITH';
  }

  if (tradeSide === 'SHORT' && ['BEARISH', 'STRONG_BEAR'].includes(btc)) {
    return 'BTC_WITH';
  }

  if (tradeSide === 'UNKNOWN') return 'BTC_UNKNOWN';

  return 'BTC_AGAINST';
}

function directionalReward({
  entry,
  tp,
  side
} = {}) {
  if (isLong(side)) return tp - entry;
  if (isShort(side)) return entry - tp;

  return 0;
}

function directionalMoveScore({
  side,
  rsiZone,
  rsiSlope,
  rsiHTF
} = {}) {
  const zone = String(rsiZone || 'MID').toUpperCase();
  const slope = safeNumber(rsiSlope, 0);
  const htf = safeNumber(rsiHTF, 50);

  let score = 0;

  if (isLong(side)) {
    if (zone.startsWith('LOWER')) score += 10;
    if (zone === 'MID') score += 5;
    if (slope > 0) score += 5;
    if (htf >= 45 && htf <= 68) score += 5;
    if (htf > 74) score -= 6;
  }

  if (isShort(side)) {
    if (zone.startsWith('UPPER')) score += 10;
    if (zone === 'MID') score += 5;
    if (slope < 0) score += 5;
    if (htf >= 32 && htf <= 55) score += 5;
    if (htf < 26) score -= 6;
  }

  return score;
}

function spreadQualityScore(spreadPct) {
  const cfg = tradeConfig();
  const spread = safeNumber(spreadPct, 0);

  if (spread <= 0) return -4;
  if (spread <= 0.0004) return 8;
  if (spread <= 0.0008) return 5;
  if (spread <= 0.0015) return 1;
  if (spread <= cfg.maxSpreadPct) return -4;

  return -12;
}

function depthQualityScore(depthUsd) {
  const depth = safeNumber(depthUsd, 0);

  if (depth >= 500_000) return 8;
  if (depth >= 250_000) return 6;
  if (depth >= 100_000) return 4;
  if (depth >= 50_000) return 1;
  if (depth > 0) return -4;

  return -8;
}

function rrScore(rr) {
  const cfg = tradeConfig();
  const r = safeNumber(rr, 0);

  if (r >= 2.0) return 12;
  if (r >= 1.5) return 10;
  if (r >= 1.0) return 6;
  if (r >= cfg.minRR) return 2;

  return -12;
}

export function calculateRR({
  entry,
  sl,
  tp,
  side
} = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);
  const t = safeNumber(tp, 0);

  if (e <= 0 || s <= 0 || t <= 0) return 0;

  const risk = Math.abs(e - s);

  if (risk <= 0) return 0;

  const reward = directionalReward({
    entry: e,
    tp: t,
    side
  });

  return reward > 0
    ? reward / risk
    : 0;
}

export function buildRiskGeometry({
  candidate,
  ob,
  candles15m
} = {}) {
  const cfg = tradeConfig();
  const tradeSide = sideToTradeSide(candidate?.side);

  if (tradeSide === 'UNKNOWN') return null;

  const entry = safeNumber(ob?.mid || candidate?.price, 0);

  if (entry <= 0) return null;

  const atrPct = calculateAtrPct(candles15m, 14);
  const spreadPct = safeNumber(ob?.spreadPct, fallbackSpreadPct());

  const rawRiskPct = Math.max(
    0.005,
    atrPct * 1.2,
    spreadPct * 5
  );

  const riskPct = clamp(rawRiskPct, 0.004, 0.025);
  const rewardPct = riskPct * cfg.defaultRR;

  const sl = tradeSide === 'LONG'
    ? entry * (1 - riskPct)
    : entry * (1 + riskPct);

  const tp = tradeSide === 'LONG'
    ? entry * (1 + rewardPct)
    : entry * (1 - rewardPct);

  const rr = calculateRR({
    entry,
    sl,
    tp,
    side: tradeSide
  });

  if (rr <= 0) return null;

  return {
    entry: roundPrice(entry),
    sl: roundPrice(sl),
    tp: roundPrice(tp),

    rr: round4(rr),

    slSource: 'ATR_SPREAD_FALLBACK',
    tpSource: 'DEFAULT_RR_TARGET',
    riskRewardSource: 'ATR_SPREAD_DEFAULT_RR',

    atrPct: round6(atrPct),
    spreadPct: round6(spreadPct),
    riskPct: round6(riskPct),
    rewardPct: round6(rewardPct)
  };
}

export function buildLiveMetrics({
  candidate,
  ob,
  funding,
  candles15m,
  candles1h,
  btcState,
  regime,
  risk
} = {}) {
  if (!candidate || !risk) {
    return null;
  }

  const rsi = calculateRsi(candles15m, 14) ?? 50;
  const rsiHTF = calculateRsi(candles1h, 14) ?? rsi;
  const rsiZone = getRsiZone(rsi);
  const rsiSlope = getRsiSlope(candles15m);

  const flow = classifyFlow({
    side: candidate?.side,
    change1h: candidate?.change1h,
    change24h: candidate?.change24h,
    candles15m
  });

  const obRelation = getObRelation(candidate?.side, ob?.bias);
  const relationToBtc = btcRelation(candidate?.side, btcState);

  const baseScore = scoreInput(candidate);

  let confluence = 0;

  confluence += clamp(baseScore, 0, 100) * 0.30;
  confluence += flow === 'TREND' ? 18 : flow === 'IMPULSE' ? 15 : flow === 'BUILDING' ? 10 : 2;
  confluence += obRelation === 'WITH' ? 15 : obRelation === 'NEUTRAL' ? 4 : -12;
  confluence += relationToBtc === 'BTC_WITH' ? 8 : relationToBtc === 'BTC_NEUTRAL' ? 2 : -8;
  confluence += rrScore(risk?.rr);
  confluence += spreadQualityScore(ob?.spreadPct);
  confluence += depthQualityScore(ob?.depthMinUsd1p);
  confluence += candidate?.pullbackConfirmed ? 7 : 0;
  confluence += candidate?.retestConfirmed ? 5 : 0;
  confluence += candidate?.fakeBreakoutRisk ? -10 : 0;
  confluence += Math.abs(rsiSlope) > 2 ? 3 : 0;

  confluence = Math.round(clamp(confluence, 0, 100));

  let sniperScore = 0;

  sniperScore += clamp(baseScore, 0, 100) * 0.32;
  sniperScore += obRelation === 'WITH' ? 18 : obRelation === 'NEUTRAL' ? 6 : -15;
  sniperScore += relationToBtc === 'BTC_WITH' ? 8 : relationToBtc === 'BTC_NEUTRAL' ? 2 : -8;
  sniperScore += flow === 'TREND' ? 18 : flow === 'IMPULSE' ? 15 : flow === 'BUILDING' ? 10 : 2;
  sniperScore += rrScore(risk?.rr);
  sniperScore += directionalMoveScore({
    side: candidate?.side,
    rsiZone,
    rsiSlope,
    rsiHTF
  });
  sniperScore += spreadQualityScore(ob?.spreadPct);
  sniperScore += candidate?.fakeBreakoutRisk ? -10 : 0;

  sniperScore = Math.round(clamp(sniperScore, 0, 100));

  return {
    ...candidate,

    confluence,
    sniperScore,

    rr: safeNumber(risk?.rr, 0),

    rsi: Number(safeNumber(rsi, 50).toFixed(2)),
    rsiHTF: Number(safeNumber(rsiHTF, 50).toFixed(2)),
    rsiZone,
    rsiSlope,
    rsiContinuationScore: Math.abs(safeNumber(rsiSlope, 0)),

    flow,

    obBias: ob?.bias || 'NEUTRAL',
    obRelation,

    spreadPct: safeNumber(ob?.spreadPct, 0),
    depthMinUsd1p: safeNumber(ob?.depthMinUsd1p, 0),

    fundingRate: safeNumber(funding?.rate, 0),

    btcState,
    btcRelation: relationToBtc,
    regime,

    entry: risk.entry,
    sl: risk.sl,
    tp: risk.tp,

    atrPct: risk.atrPct,
    riskPct: risk.riskPct,
    rewardPct: risk.rewardPct,

    slSource: risk.slSource,
    tpSource: risk.tpSource,
    riskRewardSource: risk.riskRewardSource,

    ts: now()
  };
}

export function isValidRiskGeometry(risk, side) {
  if (!risk) return false;

  const cfg = tradeConfig();
  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'UNKNOWN') return false;

  const entry = safeNumber(risk.entry, 0);
  const sl = safeNumber(risk.sl, 0);
  const tp = safeNumber(risk.tp, 0);

  if (entry <= 0 || sl <= 0 || tp <= 0) return false;

  if (tradeSide === 'LONG' && !(sl < entry && tp > entry)) return false;
  if (tradeSide === 'SHORT' && !(sl > entry && tp < entry)) return false;

  const rr = calculateRR({
    entry,
    sl,
    tp,
    side: tradeSide
  });

  if (rr < cfg.minRR) return false;

  if (safeNumber(risk.riskPct, 0) <= 0) return false;

  return true;
}