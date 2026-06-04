// ================= FILE: src/analyze/microFamilies.js =================

import { CONFIG } from '../config.js';
import { bucketDepth, bucketFunding, bucketSpread, bucketStep, getObRelation, sideToTradeSide, stableHash, safeNumber } from '../utils.js';

function coarseRsi(zone) {
  const z = String(zone || 'MID').toUpperCase();
  if (z.startsWith('LOWER')) return 'LOWER';
  if (z.startsWith('UPPER')) return 'UPPER';
  return 'MID';
}

// Coarse 3-tier bucket for continuous 0-100 scores. Categories, not gradations.
function tier(score) {
  const s = safeNumber(score);
  if (s >= 70) return 'HI';
  if (s >= 45) return 'MID';
  return 'LO';
}

// Fold the 3 confirmation booleans into one ordinal entry-quality signal.
// CONFIRMED (retest is strongest) > PULLBACK/SWEEP > NONE.
function entryQuality(metrics = {}) {
  if (metrics.retestConfirmed) return 'RETEST';
  if (metrics.pullbackConfirmed || metrics.sweepConfirmed) return 'PULLBACK';
  return 'RAW';
}

function btcRelation(side, btcState) {
  const s = String(side || '').toLowerCase();
  const btc = String(btcState || 'NEUTRAL').toUpperCase();
  if (btc === 'NEUTRAL' || btc === 'UNKNOWN') return 'BTC_NEUTRAL';
  if (s === 'bull' && ['BULLISH', 'STRONG_BULL'].includes(btc)) return 'BTC_WITH';
  if (s === 'bear' && ['BEARISH', 'STRONG_BEAR'].includes(btc)) return 'BTC_WITH';
  return 'BTC_AGAINST';
}

export function classifyFamily(metrics = {}) {
  const tradeSide = sideToTradeSide(metrics.side);
  const seedParts = [
    tradeSide,
    String(metrics.flow || 'NEUTRAL').toUpperCase(),
    coarseRsi(metrics.rsiZone),
    String(metrics.obRelation || getObRelation(metrics.side, metrics.obBias)).toUpperCase(),
    btcRelation(metrics.side, metrics.btcState),
    String(metrics.regime || 'NORMAL').toUpperCase()
  ];
  const bucket = (parseInt(stableHash(seedParts.join('|'), 6), 16) % 50) + 1;
  return `${tradeSide}_${bucket}`;
}

export function classifyMicroFamily(metrics = {}) {
  const familyId = metrics.familyId || classifyFamily(metrics);
  const tradeSide = sideToTradeSide(metrics.side);
  const obRelation = metrics.obRelation || getObRelation(metrics.side, metrics.obBias);

  const definitionParts = [
    `schema=${CONFIG.analyze.schema}`,
    `side=${String(metrics.side || '').toLowerCase()}`,
    `family=${familyId}`,
    `rsiZone=${String(metrics.rsiZone || 'UNKNOWN').toUpperCase()}`,
    `flow=${String(metrics.flow || 'UNKNOWN').toUpperCase()}`,
    `obRelation=${String(obRelation || 'UNKNOWN').toUpperCase()}`,
    `btcState=${String(metrics.btcState || 'UNKNOWN').toUpperCase()}`,
    `regime=${String(metrics.regime || 'UNKNOWN').toUpperCase()}`,
    // confluence/sniper are continuous *gradations*, not categories. Keeping them in the
    // identity (20 buckets each) exploded the micro-family space into billions, so no family
    // ever reached minWeightedCompleted and weekly learning stayed empty. Coarsened to 3 tiers
    // (LO/MID/HI) so families actually accumulate samples. Fine score still rides on the row.
    `confluenceTier=${tier(metrics.confluence)}`,
    `sniperTier=${tier(metrics.sniperScore)}`,
    `rrBucket=${bucketStep(metrics.rr, 0.5, 'RR', 1)}`,
    `spreadBucket=${bucketSpread(metrics.spreadPct)}`,
    `depthBucket=${bucketDepth(metrics.depthMinUsd1p)}`,
    `fundingBucket=${bucketFunding(metrics.fundingRate)}`,
    // The three confirmation flags rarely vary independently; collapse to one quality signal.
    // fakeBreakoutRisk is implied by fakeBreakout, so it no longer needs its own dimension.
    `entryQuality=${entryQuality(metrics)}`,
    `fakeBreakout=${Boolean(metrics.fakeBreakout)}`,
    `scannerReason=${String(metrics.scannerReason || 'UNKNOWN').toUpperCase()}`
  ];

  const hash = stableHash(definitionParts.join('|'), 8);
  const microFamilyId = `MICRO_${tradeSide}_${familyId}_${CONFIG.analyze.schema}_${hash}`;

  return {
    familyId,
    microFamilyId,
    definition: definitionParts.join(' | '),
    definitionParts,
    obRelation,
    spreadBps: Number((safeNumber(metrics.spreadPct) * 10000).toFixed(3))
  };
}
