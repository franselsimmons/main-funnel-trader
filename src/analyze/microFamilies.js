// ================= FILE: src/analyze/microFamilies.js =================

import { CONFIG } from '../config.js';
import {
  bucketDepth,
  bucketFunding,
  bucketSpread,
  bucketStep,
  getObRelation,
  sideToTradeSide,
  stableHash,
  safeNumber
} from '../utils.js';

function normalizeSide(side) {
  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
}

function coarseRsi(zone) {
  const z = String(zone || 'MID').toUpperCase();

  if (z.startsWith('LOWER')) return 'LOWER';
  if (z.startsWith('UPPER')) return 'UPPER';

  return 'MID';
}

function tier(score) {
  const s = safeNumber(score, NaN);

  if (!Number.isFinite(s)) return 'NA';
  if (s >= 70) return 'HI';
  if (s >= 45) return 'MID';

  return 'LO';
}

function entryQuality(metrics = {}) {
  if (metrics.retestConfirmed) return 'RETEST';
  if (metrics.pullbackConfirmed) return 'PULLBACK';
  if (metrics.sweepConfirmed) return 'SWEEP';

  return 'RAW';
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

function coarseBtcState(side, btcState) {
  return btcRelation(side, btcState);
}

function coarseRegime(regime) {
  const r = String(regime || 'NORMAL_VOL').toUpperCase();

  if (r.includes('HIGH') || r.includes('EXTREME')) return 'HIGH_VOL';
  if (r.includes('LOW')) return 'LOW_VOL';

  return 'NORMAL_VOL';
}

function coarseFlow(flow) {
  const f = String(flow || 'NEUTRAL').toUpperCase();

  if (['TREND', 'IMPULSE'].includes(f)) return 'TREND';
  if (f === 'BUILDING') return 'BUILDING';

  return 'NEUTRAL';
}

function coarseScannerReason(reason) {
  const r = String(reason || 'UNKNOWN').toUpperCase();

  if (r.includes('RETEST')) return 'RETEST';
  if (r.includes('PULLBACK')) return 'PULLBACK';
  if (r.includes('BREAKOUT')) return 'BREAKOUT';
  if (r.includes('VOLUME')) return 'VOLUME';
  if (r.includes('MOMENTUM')) return 'MOMENTUM';

  return 'UNKNOWN';
}

function normalizeObRelation(metrics = {}) {
  return String(
    metrics.obRelation ||
    getObRelation(metrics.side, metrics.obBias) ||
    'UNKNOWN'
  ).toUpperCase();
}

export function classifyFamily(metrics = {}) {
  const tradeSide = sideToTradeSide(metrics.side);

  const seedParts = [
    tradeSide,
    coarseFlow(metrics.flow),
    coarseRsi(metrics.rsiZone),
    normalizeObRelation(metrics),
    coarseBtcState(metrics.side, metrics.btcState),
    coarseRegime(metrics.regime)
  ];

  const bucket = (parseInt(stableHash(seedParts.join('|'), 6), 16) % 50) + 1;

  return `${tradeSide}_${bucket}`;
}

export function classifyMicroFamily(metrics = {}) {
  const familyId = metrics.familyId || classifyFamily(metrics);
  const tradeSide = sideToTradeSide(metrics.side);
  const normalizedSide = normalizeSide(metrics.side);
  const obRelation = normalizeObRelation(metrics);
  const btcRel = btcRelation(metrics.side, metrics.btcState);
  const regime = coarseRegime(metrics.regime);
  const flow = coarseFlow(metrics.flow);
  const scannerReason = coarseScannerReason(metrics.scannerReason);

  const definitionParts = [
    `schema=${CONFIG.analyze.schema}`,
    `side=${normalizedSide}`,
    `family=${familyId}`,

    `rsiZone=${String(metrics.rsiZone || 'UNKNOWN').toUpperCase()}`,

    `flow=${flow}`,
    `obRelation=${obRelation}`,
    `btcRelation=${btcRel}`,
    `regime=${regime}`,

    `confluenceTier=${tier(metrics.confluence)}`,
    `sniperTier=${tier(metrics.sniperScore)}`,

    `rrBucket=${bucketStep(metrics.rr, 0.5, 'RR', 1)}`,
    `spreadBucket=${bucketSpread(metrics.spreadPct)}`,
    `depthBucket=${bucketDepth(metrics.depthMinUsd1p)}`,
    `fundingBucket=${bucketFunding(metrics.fundingRate)}`,

    `entryQuality=${entryQuality(metrics)}`,
    `fakeBreakout=${Boolean(metrics.fakeBreakout)}`,
    `scannerReason=${scannerReason}`
  ];

  const hash = stableHash(definitionParts.join('|'), 8);

  const microFamilyId = `MICRO_${tradeSide}_${familyId}_${CONFIG.analyze.schema}_${hash}`;

  return {
    familyId,
    microFamilyId,

    definition: definitionParts.join(' | '),
    definitionParts,

    side: normalizedSide,
    tradeSide,

    obRelation,
    btcRelation: btcRel,
    regime,
    flow,
    scannerReason,

    spreadBps: Number((safeNumber(metrics.spreadPct, 0) * 10000).toFixed(3))
  };
}