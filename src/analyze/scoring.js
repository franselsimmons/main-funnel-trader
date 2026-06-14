// ================= FILE: src/analyze/scoring.js =================

import { CONFIG } from '../config.js';
import { clamp, safeNumber, sideToTradeSide } from '../utils.js';

const DEFAULT_WILSON_Z = 1.96;
const DEFAULT_PRIOR_TRADES = 24;
const DEFAULT_PRIOR_WINRATE = 0.5;
const DEFAULT_SAMPLE_CAP = 50;
const DEFAULT_AVG_R_CAP = 5;
const DEFAULT_AVG_R_SAMPLE_EXPONENT = 1.35;

const MIN_COMPLETED_ACTIVE = 20;

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SOURCE_VIRTUAL = 'VIRTUAL';
const SOURCE_REAL = 'REAL';
const SOURCE_SHADOW = 'SHADOW';

const FIXED_TAXONOMY_SETUP_TYPES = new Set([
  'BREAKDOWN',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const FIXED_TAXONOMY_REGIME_BUCKETS = new Set([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

function now() {
  return Date.now();
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function rotationNumber(key, fallback) {
  return safeNumber(CONFIG.rotation?.[key], fallback);
}

function analyzeNumber(key, fallback) {
  return safeNumber(CONFIG.analyze?.[key], fallback);
}

function shadowWeight() {
  return clamp(analyzeNumber('shadowWeight', 0.35), 0, 1);
}

function allowLegacyCompletedFallback() {
  return CONFIG.analyze?.allowLegacyCompletedFallback === true;
}

function priorTrades() {
  return Math.max(0, rotationNumber('priorTrades', DEFAULT_PRIOR_TRADES));
}

function priorWinrate() {
  return clamp(rotationNumber('priorWinrate', DEFAULT_PRIOR_WINRATE), 0, 1);
}

function wilsonZ() {
  return Math.max(0.1, rotationNumber('wilsonZ', DEFAULT_WILSON_Z));
}

function sampleCap() {
  return Math.max(1, rotationNumber('sampleReliabilityCap', DEFAULT_SAMPLE_CAP));
}

function avgRCap() {
  return Math.max(0.5, rotationNumber('avgRCap', DEFAULT_AVG_R_CAP));
}

function avgRSampleExponent() {
  return clamp(
    rotationNumber('avgRSampleExponent', DEFAULT_AVG_R_SAMPLE_EXPONENT),
    0.5,
    3
  );
}

function positive(value) {
  return Math.max(0, safeNumber(value, 0));
}

function inc(obj, key, amount = 1) {
  const k = String(key || 'UNKNOWN').toUpperCase();

  obj[k] = safeNumber(obj[k], 0) + amount;
}

function makeCounters() {
  return {
    rsiZone: {},
    flow: {},
    obRelation: {},
    btcState: {},
    regime: {},
    scannerReason: {}
  };
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizedSignalText(value = '') {
  return cleanSideText(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasSignalPattern(value = '', patterns = []) {
  const text = normalizedSignalText(value);

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`)
  ));
}

function hasShortSignal(value = '') {
  return hasSignalPattern(value, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'SIDE_SHORT',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'SIDE_BEAR',
    'TRADE_SIDE_BEAR',
    'DIRECTION_BEAR',
    'SIDE_SELL',
    'DIRECTION_SELL',
    'MICRO_SHORT',
    'FAMILY_SHORT'
  ]);
}

function hasLongSignal(value = '') {
  return hasSignalPattern(value, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'SIDE_LONG',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'SIDE_BULL',
    'TRADE_SIDE_BULL',
    'DIRECTION_BULL',
    'SIDE_BUY',
    'DIRECTION_BUY',
    'MICRO_LONG',
    'FAMILY_LONG'
  ]);
}

function isScannerFamilyId(id = '') {
  const value = String(id || '').toUpperCase();

  return (
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('SHORT_SCANNER_') ||
    value.startsWith('MICRO_LONG_SCANNER__') ||
    value.includes('MICRO_LONG_SCANNER__') ||
    value.startsWith('LONG_SCANNER_') ||
    value.includes('LONG_SCANNER_') ||
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}

function isFixedTaxonomyMicroId(id = '') {
  const value = String(id || '').toUpperCase();

  if (!value) return false;
  if (isScannerFamilyId(value)) return false;
  if (!value.startsWith(`MICRO_${TARGET_TRADE_SIDE}_`)) return false;

  if (
    value.includes('_MF_V1_') ||
    value.includes('_MF_V2_') ||
    value.includes('_MF_V3_') ||
    value.includes('_XR_')
  ) {
    return false;
  }

  const rest = value.slice(`MICRO_${TARGET_TRADE_SIDE}_`.length);

  for (const regime of FIXED_TAXONOMY_REGIME_BUCKETS) {
    const suffix = `_${regime}`;

    if (rest.endsWith(suffix)) {
      const setup = rest.slice(0, rest.length - suffix.length);

      if (FIXED_TAXONOMY_SETUP_TYPES.has(setup)) return true;
    }
  }

  return false;
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function directSide(row = {}) {
  const values = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.intentSide,
    row.entrySide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.side
  ];

  for (const value of values) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  return 'UNKNOWN';
}

function definitionSide(row = {}) {
  const values = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ];

  let shortHit = false;
  let longHit = false;

  for (const value of values) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE) shortHit = true;
    if (side === OPPOSITE_TRADE_SIDE) longHit = true;
  }

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    const text = values
      .map((value) => cleanSideText(value))
      .filter(Boolean)
      .join('|');

    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') return normalizeTradeSide(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const direct = directSide(row);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const fromDefinition = definitionSide(row);

  if (fromDefinition === TARGET_TRADE_SIDE || fromDefinition === OPPOSITE_TRADE_SIDE) {
    return fromDefinition;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isRealAnalyzeMicroRow(row = {}) {
  const id = row.trueMicroFamilyId || row.microFamilyId || row.id || row.key || '';

  return isShortRow(row) && !isScannerFamilyId(id);
}

function dashboardSideFromTradeSide(side, fallback = 'unknown') {
  const tradeSide = normalizeTradeSide(side);

  if (tradeSide === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return String(fallback || 'unknown').toLowerCase();
}

function normalizeSource(source = SOURCE_VIRTUAL) {
  const src = String(source || SOURCE_VIRTUAL).trim().toUpperCase();

  if (src === SOURCE_REAL) return SOURCE_REAL;
  if (src === SOURCE_SHADOW) return SOURCE_SHADOW;
  if (src === SOURCE_VIRTUAL) return SOURCE_VIRTUAL;

  return SOURCE_VIRTUAL;
}

function sourceWeight(source) {
  return normalizeSource(source) === SOURCE_SHADOW
    ? shadowWeight()
    : 1;
}

function applySideIdentity(stats = {}, row = {}) {
  const tradeSide = inferTradeSide({
    ...stats,
    ...row
  });

  stats.shortOnly = true;
  stats.longDisabled = true;
  stats.longOnly = false;
  stats.shortDisabled = false;

  if (tradeSide !== TARGET_TRADE_SIDE) {
    stats.tradeSide = null;
    stats.side = 'unknown';
    return stats;
  }

  stats.tradeSide = TARGET_TRADE_SIDE;
  stats.side = TARGET_DASHBOARD_SIDE;
  stats.positionSide = TARGET_TRADE_SIDE;
  stats.direction = TARGET_TRADE_SIDE;
  stats.targetTradeSide = TARGET_TRADE_SIDE;
  stats.dashboardSide = TARGET_DASHBOARD_SIDE;

  return stats;
}

function hasSourceBuckets(stats = {}) {
  return (
    safeNumber(stats.virtualCompleted, 0) > 0 ||
    safeNumber(stats.shadowCompleted, 0) > 0 ||
    safeNumber(stats.virtualWins, 0) > 0 ||
    safeNumber(stats.virtualLosses, 0) > 0 ||
    safeNumber(stats.virtualFlats, 0) > 0 ||
    safeNumber(stats.shadowWins, 0) > 0 ||
    safeNumber(stats.shadowLosses, 0) > 0 ||
    safeNumber(stats.shadowFlats, 0) > 0 ||
    safeNumber(stats.virtualTotalR, 0) !== 0 ||
    safeNumber(stats.shadowTotalR, 0) !== 0
  );
}

function closedCompletedCount(stats = {}) {
  return (
    safeNumber(stats.virtualCompleted, 0) +
    safeNumber(stats.shadowCompleted, 0)
  );
}

function zeroOutcomeCounts() {
  return {
    wins: 0,
    losses: 0,
    flats: 0,
    completed: 0
  };
}

function actualOutcomeCounts(stats = {}) {
  if (hasSourceBuckets(stats)) {
    const virtualCompleted = safeNumber(stats.virtualCompleted, 0);
    const shadowCompleted = safeNumber(stats.shadowCompleted, 0);

    const virtualWins = safeNumber(stats.virtualWins, 0);
    const virtualLosses = safeNumber(stats.virtualLosses, 0);
    const virtualFlats = safeNumber(stats.virtualFlats, 0);

    const shadowWins = safeNumber(stats.shadowWins, 0);
    const shadowLosses = safeNumber(stats.shadowLosses, 0);
    const shadowFlats = safeNumber(stats.shadowFlats, 0);

    const completed = virtualCompleted + shadowCompleted;
    const bucketCompleted =
      virtualWins +
      virtualLosses +
      virtualFlats +
      shadowWins +
      shadowLosses +
      shadowFlats;

    const inferredFlats = Math.max(0, completed - bucketCompleted);

    return {
      wins: virtualWins + shadowWins,
      losses: virtualLosses + shadowLosses,
      flats: virtualFlats + shadowFlats + inferredFlats,
      completed: Math.max(completed, bucketCompleted)
    };
  }

  if (!allowLegacyCompletedFallback()) {
    return zeroOutcomeCounts();
  }

  const completedFallback = safeNumber(stats.completed, 0);
  const winsFallback = safeNumber(stats.wins, 0);
  const lossesFallback = safeNumber(stats.losses, 0);
  const flatsFallback = safeNumber(stats.flats, 0);
  const bucketCompleted = winsFallback + lossesFallback + flatsFallback;

  if (bucketCompleted > 0) {
    return {
      wins: winsFallback,
      losses: lossesFallback,
      flats: flatsFallback,
      completed: Math.max(completedFallback, bucketCompleted)
    };
  }

  if (completedFallback <= 0) {
    return zeroOutcomeCounts();
  }

  return {
    wins: 0,
    losses: 0,
    flats: completedFallback,
    completed: completedFallback
  };
}

function weightedCompletedCount(stats = {}) {
  if (hasSourceBuckets(stats)) {
    return (
      safeNumber(stats.virtualCompleted, 0) +
      safeNumber(stats.shadowCompleted, 0) * shadowWeight()
    );
  }

  return allowLegacyCompletedFallback()
    ? safeNumber(stats.completed, 0)
    : 0;
}

function weightedSourceCounts(stats = {}) {
  if (!hasSourceBuckets(stats)) {
    return {
      wins: 0,
      losses: 0,
      flats: 0,
      completed: 0
    };
  }

  const w = shadowWeight();

  const wins =
    safeNumber(stats.virtualWins, 0) +
    safeNumber(stats.shadowWins, 0) * w;

  const losses =
    safeNumber(stats.virtualLosses, 0) +
    safeNumber(stats.shadowLosses, 0) * w;

  const flats =
    safeNumber(stats.virtualFlats, 0) +
    safeNumber(stats.shadowFlats, 0) * w;

  return {
    wins,
    losses,
    flats,
    completed: wins + losses + flats
  };
}

function weightedSourceTotals(stats = {}) {
  if (!hasSourceBuckets(stats)) {
    return {
      totalR: 0,
      totalPnlPct: 0,
      totalCostR: 0,
      grossWinR: 0,
      grossLossR: 0
    };
  }

  const w = shadowWeight();

  return {
    totalR:
      safeNumber(stats.virtualTotalR, 0) +
      safeNumber(stats.shadowTotalR, 0) * w,

    totalPnlPct:
      safeNumber(stats.virtualTotalPnlPct, 0) +
      safeNumber(stats.shadowTotalPnlPct, 0) * w,

    totalCostR:
      safeNumber(stats.virtualTotalCostR, 0) +
      safeNumber(stats.shadowTotalCostR, 0) * w,

    grossWinR:
      safeNumber(stats.virtualGrossWinR, 0) +
      safeNumber(stats.shadowGrossWinR, 0) * w,

    grossLossR:
      safeNumber(stats.virtualGrossLossR, 0) +
      safeNumber(stats.shadowGrossLossR, 0) * w
  };
}

function aggregateRecentOutcomes(stats = {}) {
  const outcomes = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.filter(isShortRow)
    : [];

  return outcomes.reduce(
    (acc, row) => {
      const src = normalizeSource(row.source);

      if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
        return acc;
      }

      const weight = sourceWeight(src);

      const exitR = safeNumber(row.netR ?? row.exitR ?? row.realizedNetR ?? row.realizedR ?? row.r, 0);
      const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
      const costR = safeNumber(row.costR ?? row.avgCostR, 0);

      const win = exitR > 0;
      const loss = exitR < 0;
      const flat = !win && !loss;

      acc.completed += weight;
      acc.actualCompleted += 1;

      if (win) {
        acc.wins += weight;
        acc.actualWins += 1;
        acc.grossWinR += exitR * weight;
      }

      if (loss) {
        acc.losses += weight;
        acc.actualLosses += 1;
        acc.grossLossR += Math.abs(exitR) * weight;
      }

      if (flat) {
        acc.flats += weight;
        acc.actualFlats += 1;
      }

      acc.totalR += exitR * weight;
      acc.totalPnlPct += pnlPct * weight;
      acc.totalCostR += costR * weight;

      if (row.directToSL) acc.directSLCount += weight;
      if (row.nearTpSeen) acc.nearTpCount += weight;
      if (row.reachedHalfR) acc.reachedHalfRCount += weight;
      if (row.reachedOneR) acc.reachedOneRCount += weight;

      if (row.beWouldExit) acc.beWouldExitCount += weight;
      if (row.gaveBackAfterHalfR) acc.gaveBackAfterHalfRCount += weight;
      if (row.gaveBackAfterOneR) acc.gaveBackAfterOneRCount += weight;
      if (row.nearTpThenLoss) acc.nearTpThenLossCount += weight;

      return acc;
    },
    {
      completed: 0,
      wins: 0,
      losses: 0,
      flats: 0,

      actualCompleted: 0,
      actualWins: 0,
      actualLosses: 0,
      actualFlats: 0,

      totalR: 0,
      totalPnlPct: 0,
      totalCostR: 0,
      grossWinR: 0,
      grossLossR: 0,

      directSLCount: 0,
      nearTpCount: 0,
      reachedHalfRCount: 0,
      reachedOneRCount: 0,

      beWouldExitCount: 0,
      gaveBackAfterHalfRCount: 0,
      gaveBackAfterOneRCount: 0,
      nearTpThenLossCount: 0
    }
  );
}

function pickWeightedValue({
  stats,
  sourceValue,
  recentValue,
  legacyValue = 0,
  recentCompleted = 0
}) {
  if (hasSourceBuckets(stats)) return safeNumber(sourceValue, 0);
  if (safeNumber(recentCompleted, 0) > 0) return safeNumber(recentValue, 0);

  return allowLegacyCompletedFallback()
    ? safeNumber(legacyValue, 0)
    : 0;
}

function sampleReliability(completed) {
  const n = safeNumber(completed, 0);

  if (n <= 0) return 0;

  return clamp(Math.sqrt(Math.min(n, sampleCap()) / sampleCap()), 0, 1);
}

function sampleAdjustedAvgR(avgR, reliability) {
  const cappedAvgR = clamp(
    safeNumber(avgR, 0),
    -avgRCap(),
    avgRCap()
  );

  const samplePenalty = Math.pow(
    clamp(reliability, 0, 1),
    avgRSampleExponent()
  );

  return cappedAvgR * samplePenalty;
}

function learningStatus(stats = {}) {
  const completed = safeNumber(stats.completed, 0);

  if (completed <= 0) return 'OBSERVING';
  if (completed < MIN_COMPLETED_ACTIVE) return 'EARLY_OUTCOMES';

  return 'ACTIVE_LEARNING';
}

export function createMicroStats({
  microFamilyId,
  familyId,
  side = TARGET_DASHBOARD_SIDE,
  tradeSide = TARGET_TRADE_SIDE,
  definitionParts = []
} = {}) {
  const ts = now();

  const inferredTradeSide = inferTradeSide({
    microFamilyId,
    familyId,
    side,
    tradeSide,
    definitionParts
  });

  const cleanTradeSide = inferredTradeSide === TARGET_TRADE_SIDE
    ? TARGET_TRADE_SIDE
    : normalizeTradeSide(tradeSide || side);

  const isShort = cleanTradeSide === TARGET_TRADE_SIDE;
  const fixedTaxonomyLearningId = isFixedTaxonomyMicroId(microFamilyId);

  return {
    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    familyId,

    side: isShort ? TARGET_DASHBOARD_SIDE : 'unknown',
    tradeSide: isShort ? TARGET_TRADE_SIDE : null,
    positionSide: isShort ? TARGET_TRADE_SIDE : null,
    direction: isShort ? TARGET_TRADE_SIDE : null,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    source: SOURCE_VIRTUAL,

    fixedTaxonomyLearningId,
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    symbolExcludedFromFamilyId: true,

    definitionParts,
    definition: definitionParts.join(' | '),

    seen: 0,
    observations: 0,

    virtualCompleted: 0,
    realCompleted: 0,
    shadowCompleted: 0,
    completed: 0,
    winrateSample: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    virtualWins: 0,
    virtualLosses: 0,
    virtualFlats: 0,

    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    shadowWins: 0,
    shadowLosses: 0,
    shadowFlats: 0,

    totalR: 0,
    virtualTotalR: 0,
    realTotalR: 0,
    shadowTotalR: 0,

    totalPnlPct: 0,
    virtualTotalPnlPct: 0,
    realTotalPnlPct: 0,
    shadowTotalPnlPct: 0,

    totalCostR: 0,
    virtualTotalCostR: 0,
    realTotalCostR: 0,
    shadowTotalCostR: 0,

    grossWinR: 0,
    grossLossR: 0,

    virtualGrossWinR: 0,
    virtualGrossLossR: 0,
    realGrossWinR: 0,
    realGrossLossR: 0,
    shadowGrossWinR: 0,
    shadowGrossLossR: 0,

    avgR: 0,
    avgWinR: 0,
    avgLossR: 0,
    sampleAdjustedAvgR: 0,
    avgRScore: 0,

    avgPnlPct: 0,

    directSLCount: 0,
    nearTpCount: 0,
    reachedHalfRCount: 0,
    reachedOneRCount: 0,

    beWouldExitCount: 0,
    gaveBackAfterHalfRCount: 0,
    gaveBackAfterOneRCount: 0,
    nearTpThenLossCount: 0,

    avgCostR: 0,

    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,

    sampleRawWinrate: 0,
    sampleBayesianWinrate: 0,
    sampleWilsonLowerBound: 0,
    sampleReliabilityOld: 0,

    profitFactor: 0,
    sampleReliability: 0,
    balancedScore: 0,
    dashboardBalancedScore: 0,

    directSLPct: 0,
    nearTpPct: 0,
    reachedHalfRPct: 0,
    reachedOneRPct: 0,

    beWouldExitPct: 0,
    gaveBackAfterHalfRPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,

    learningStatus: 'OBSERVING',
    status: 'OBSERVING',
    awaitingOutcomes: true,
    tooEarly: true,
    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE,

    counters: makeCounters(),

    examples: [],
    recentOutcomes: [],

    createdAt: ts,
    updatedAt: ts
  };
}

function ensureStatsShape(stats = {}) {
  stats.counters ||= makeCounters();
  stats.counters.rsiZone ||= {};
  stats.counters.flow ||= {};
  stats.counters.obRelation ||= {};
  stats.counters.btcState ||= {};
  stats.counters.regime ||= {};
  stats.counters.scannerReason ||= {};

  stats.examples = Array.isArray(stats.examples) ? stats.examples.filter(isShortRow) : [];
  stats.recentOutcomes = Array.isArray(stats.recentOutcomes)
    ? stats.recentOutcomes.filter(isShortRow)
    : [];

  stats.definitionParts = Array.isArray(stats.definitionParts)
    ? stats.definitionParts
    : [];

  stats.definition ||= stats.definitionParts.join(' | ');

  stats.shortOnly = true;
  stats.longDisabled = true;
  stats.longOnly = false;
  stats.shortDisabled = false;
  stats.source ||= SOURCE_VIRTUAL;

  stats.learningIdentitySource ||= 'ANALYZE_MICRO_FAMILY';
  stats.scannerFingerprintRole ||= 'METADATA_ONLY';
  stats.scannerFingerprintsMetadataOnly = true;
  stats.scannerFingerprintsUsedAsLearningFamily = false;
  stats.symbolExcludedFromFamilyId = true;

  stats.fixedTaxonomyLearningId =
    Boolean(stats.fixedTaxonomyLearningId) ||
    isFixedTaxonomyMicroId(stats.trueMicroFamilyId || stats.microFamilyId);

  stats.minCompletedForActiveLearning = MIN_COMPLETED_ACTIVE;

  applySideIdentity(stats);

  const numericFields = [
    'seen',
    'observations',

    'virtualCompleted',
    'realCompleted',
    'shadowCompleted',
    'completed',
    'winrateSample',

    'wins',
    'losses',
    'flats',

    'virtualWins',
    'virtualLosses',
    'virtualFlats',

    'realWins',
    'realLosses',
    'realFlats',

    'shadowWins',
    'shadowLosses',
    'shadowFlats',

    'totalR',
    'virtualTotalR',
    'realTotalR',
    'shadowTotalR',

    'totalPnlPct',
    'virtualTotalPnlPct',
    'realTotalPnlPct',
    'shadowTotalPnlPct',

    'totalCostR',
    'virtualTotalCostR',
    'realTotalCostR',
    'shadowTotalCostR',

    'grossWinR',
    'grossLossR',

    'virtualGrossWinR',
    'virtualGrossLossR',
    'realGrossWinR',
    'realGrossLossR',
    'shadowGrossWinR',
    'shadowGrossLossR',

    'avgR',
    'avgWinR',
    'avgLossR',
    'sampleAdjustedAvgR',
    'avgRScore',

    'avgPnlPct',
    'avgCostR',

    'directSLCount',
    'nearTpCount',
    'reachedHalfRCount',
    'reachedOneRCount',

    'beWouldExitCount',
    'gaveBackAfterHalfRCount',
    'gaveBackAfterOneRCount',
    'nearTpThenLossCount',

    'winrate',
    'bayesianWinrate',
    'wilsonLowerBound',
    'fairWinrate',
    'sampleAdjustedWinrate',

    'sampleRawWinrate',
    'sampleBayesianWinrate',
    'sampleWilsonLowerBound',
    'sampleReliabilityOld',

    'profitFactor',
    'sampleReliability',
    'balancedScore',
    'dashboardBalancedScore',

    'directSLPct',
    'nearTpPct',
    'reachedHalfRPct',
    'reachedOneRPct',

    'beWouldExitPct',
    'gaveBackAfterHalfRPct',
    'gaveBackAfterOneRPct',
    'nearTpThenLossPct'
  ];

  for (const field of numericFields) {
    stats[field] = safeNumber(stats[field], 0);
  }

  stats.realCompleted = 0;
  stats.realWins = 0;
  stats.realLosses = 0;
  stats.realFlats = 0;
  stats.realTotalR = 0;
  stats.realTotalPnlPct = 0;
  stats.realTotalCostR = 0;
  stats.realGrossWinR = 0;
  stats.realGrossLossR = 0;

  stats.createdAt ||= now();
  stats.updatedAt ||= now();

  return stats;
}

export function updateObservation(stats, row = {}) {
  ensureStatsShape(stats);

  if (!isShortRow({ ...stats, ...row })) {
    return stats;
  }

  applySideIdentity(stats, row);

  stats.seen = safeNumber(stats.seen, 0) + 1;
  stats.observations = safeNumber(stats.observations, 0) + 1;

  inc(stats.counters.rsiZone, row.rsiZone);
  inc(stats.counters.flow, row.flow);
  inc(stats.counters.obRelation, row.obRelation);
  inc(stats.counters.btcState, row.btcState ?? row.btcRelation);
  inc(stats.counters.regime, row.regime);
  inc(stats.counters.scannerReason, row.scannerReason);

  if (stats.examples.length < 20) {
    stats.examples.push({
      symbol: row.symbol || null,
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      source: row.source || SOURCE_VIRTUAL,

      microFamilyId: row.microFamilyId || row.trueMicroFamilyId || null,
      trueMicroFamilyId: row.trueMicroFamilyId || row.microFamilyId || null,
      coarseMicroFamilyId: row.coarseMicroFamilyId || null,

      setupType: row.setupType || null,
      regimeBucket: row.regimeBucket || null,

      scannerMicroFamilyId: row.scannerMicroFamilyId || null,
      scannerFingerprintRole: row.scannerFingerprintRole || 'METADATA_ONLY',

      rsiZone: row.rsiZone || null,
      flow: row.flow || null,
      obRelation: row.obRelation || null,
      scannerReason: row.scannerReason || null,

      isMirrorMicroFamily: false,
      observationMirror: false,
      mirrorOfSide: null,

      ts: row.createdAt || row.ts || now()
    });
  }

  stats.learningStatus = learningStatus(stats);
  stats.status = stats.learningStatus;
  stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 && safeNumber(stats.seen, 0) > 0;
  stats.tooEarly = safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE;

  stats.updatedAt = now();

  return stats;
}

export function updateOutcome(stats, row = {}, source = SOURCE_VIRTUAL) {
  ensureStatsShape(stats);

  if (!isShortRow({ ...stats, ...row })) {
    return refreshStats(stats);
  }

  applySideIdentity(stats, row);

  const src = normalizeSource(source || row.source || SOURCE_VIRTUAL);

  if (src !== SOURCE_VIRTUAL && src !== SOURCE_SHADOW) {
    return refreshStats(stats);
  }

  const weight = sourceWeight(src);

  const exitR = safeNumber(
    row.netR ??
    row.exitR ??
    row.realizedNetR ??
    row.realizedR ??
    row.r,
    0
  );

  const pnlPct = safeNumber(row.netPnlPct ?? row.pnlPct, 0);
  const costR = safeNumber(row.costR ?? row.avgCostR, 0);

  const win = exitR > 0;
  const loss = exitR < 0;
  const flat = !win && !loss;

  if (src === SOURCE_SHADOW) {
    stats.shadowCompleted += 1;
    stats.shadowTotalR += exitR;
    stats.shadowTotalPnlPct += pnlPct;
    stats.shadowTotalCostR += costR;

    if (win) {
      stats.shadowWins += 1;
      stats.shadowGrossWinR += exitR;
    }

    if (loss) {
      stats.shadowLosses += 1;
      stats.shadowGrossLossR += Math.abs(exitR);
    }

    if (flat) stats.shadowFlats += 1;
  } else {
    stats.virtualCompleted += 1;
    stats.virtualTotalR += exitR;
    stats.virtualTotalPnlPct += pnlPct;
    stats.virtualTotalCostR += costR;

    if (win) {
      stats.virtualWins += 1;
      stats.virtualGrossWinR += exitR;
    }

    if (loss) {
      stats.virtualLosses += 1;
      stats.virtualGrossLossR += Math.abs(exitR);
    }

    if (flat) stats.virtualFlats += 1;
  }

  stats.completed = closedCompletedCount(stats);

  stats.wins += win ? weight : 0;
  stats.losses += loss ? weight : 0;
  stats.flats += flat ? weight : 0;

  stats.totalR += exitR * weight;
  stats.totalPnlPct += pnlPct * weight;
  stats.totalCostR += costR * weight;

  if (win) stats.grossWinR += exitR * weight;
  if (loss) stats.grossLossR += Math.abs(exitR) * weight;

  if (row.directToSL) stats.directSLCount += weight;
  if (row.nearTpSeen) stats.nearTpCount += weight;
  if (row.reachedHalfR) stats.reachedHalfRCount += weight;
  if (row.reachedOneR) stats.reachedOneRCount += weight;

  if (row.beWouldExit) stats.beWouldExitCount += weight;
  if (row.gaveBackAfterHalfR) stats.gaveBackAfterHalfRCount += weight;
  if (row.gaveBackAfterOneR) stats.gaveBackAfterOneRCount += weight;
  if (row.nearTpThenLoss) stats.nearTpThenLossCount += weight;

  stats.recentOutcomes.push({
    source: src,
    symbol: row.symbol || null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    microFamilyId: row.microFamilyId || row.trueMicroFamilyId || stats.microFamilyId || null,
    trueMicroFamilyId: row.trueMicroFamilyId || row.microFamilyId || stats.trueMicroFamilyId || null,
    coarseMicroFamilyId: row.coarseMicroFamilyId || stats.coarseMicroFamilyId || null,

    setupType: row.setupType || stats.setupType || null,
    regimeBucket: row.regimeBucket || stats.regimeBucket || null,

    exitReason: row.exitReason || null,

    exitR,
    netR: safeNumber(row.netR ?? exitR, exitR),
    grossR: safeNumber(row.grossR, 0),

    pnlPct,
    netPnlPct: safeNumber(row.netPnlPct ?? pnlPct, pnlPct),
    grossPnlPct: safeNumber(row.grossPnlPct, 0),

    costR,
    costPct: safeNumber(row.costPct, 0),
    feePct: safeNumber(row.feePct, 0),
    slippagePct: safeNumber(row.slippagePct, 0),

    mfeR: safeNumber(row.mfeR, 0),
    maeR: safeNumber(row.maeR, 0),

    directToSL: Boolean(row.directToSL),
    nearTpSeen: Boolean(row.nearTpSeen),
    reachedHalfR: Boolean(row.reachedHalfR),
    reachedOneR: Boolean(row.reachedOneR),

    beArmed: Boolean(row.beArmed),
    beWouldExit: Boolean(row.beWouldExit),
    beExitR: safeNumber(row.beExitR, 0),

    gaveBackAfterHalfR: Boolean(row.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(row.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(row.nearTpThenLoss),

    costModelApplied: Boolean(row.costModelApplied),
    netCostModelApplied: Boolean(row.netCostModelApplied),
    costModel: row.costModel || null,

    isMirrorMicroFamily: false,
    outcomeMirror: false,
    mirrorOfSide: null,

    ts: row.closedAt || row.completedAt || now()
  });

  stats.recentOutcomes = stats.recentOutcomes.slice(-30);
  stats.updatedAt = now();

  return refreshStats(stats);
}

export function wilsonLowerBound(wins, completed, z = wilsonZ()) {
  const n = safeNumber(completed, 0);
  const w = clamp(safeNumber(wins, 0), 0, n);

  if (n <= 0) return 0;

  const p = w / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  return clamp((centre - margin) / denominator, 0, 1);
}

export function bayesianWinrate(wins, completed) {
  const n = safeNumber(completed, 0);
  const w = safeNumber(wins, 0);

  const priorN = priorTrades();
  const priorW = priorN * priorWinrate();

  const denominator = n + priorN;

  return denominator > 0
    ? clamp((w + priorW) / denominator, 0, 1)
    : 0;
}

function buildBalancedScore({
  fair,
  avgR,
  totalR,
  sampleRel,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;

  const totalRComponent = Math.log1p(positive(totalR)) * 12;
  const avgRComponent = Math.log1p(positive(avgR)) * 8;

  return (
    fair * 100 +
    sampleRel * 25 +
    totalRComponent +
    avgRComponent +
    pfNorm * 8 +
    nearTpPct * 4 +
    reachedOneRPct * 4 -
    directSLPct * 35 -
    nearTpThenLossPct * 15 -
    gaveBackAfterOneRPct * 10 -
    Math.max(0, avgCostR) * 8
  );
}

function buildAvgRScore({
  sampleAdjustedAvgRValue,
  fair,
  totalR,
  sampleRel,
  profitFactor,
  nearTpPct,
  reachedOneRPct,
  directSLPct,
  nearTpThenLossPct,
  gaveBackAfterOneRPct,
  avgCostR
}) {
  const pfNorm = clamp(profitFactor, 0, 10) / 10;
  const totalRComponent = Math.log1p(positive(totalR)) * 8;

  return (
    sampleAdjustedAvgRValue * 100 +
    fair * 35 +
    sampleRel * 25 +
    totalRComponent +
    pfNorm * 8 +
    nearTpPct * 3 +
    reachedOneRPct * 3 -
    directSLPct * 35 -
    nearTpThenLossPct * 15 -
    gaveBackAfterOneRPct * 10 -
    Math.max(0, avgCostR) * 8
  );
}

export function refreshStats(stats) {
  ensureStatsShape(stats);

  const sourceBucketsPresent = hasSourceBuckets(stats);
  const sourceCounts = weightedSourceCounts(stats);
  const sourceTotals = weightedSourceTotals(stats);
  const recent = aggregateRecentOutcomes(stats);

  const actualCounts = sourceBucketsPresent
    ? actualOutcomeCounts(stats)
    : recent.actualCompleted > 0
      ? {
        wins: recent.actualWins,
        losses: recent.actualLosses,
        flats: recent.actualFlats,
        completed: recent.actualCompleted
      }
      : actualOutcomeCounts(stats);

  const sourceClosedCompleted = closedCompletedCount(stats);

  const closedCompleted = sourceBucketsPresent
    ? sourceClosedCompleted
    : recent.actualCompleted > 0
      ? recent.actualCompleted
      : allowLegacyCompletedFallback()
        ? safeNumber(actualCounts.completed, 0)
        : 0;

  const weightedCompletedForR = sourceBucketsPresent
    ? weightedCompletedCount(stats)
    : recent.completed > 0
      ? recent.completed
      : allowLegacyCompletedFallback()
        ? safeNumber(actualCounts.completed, 0)
        : 0;

  const weightedWins = pickWeightedValue({
    stats,
    sourceValue: sourceCounts.wins,
    recentValue: recent.wins,
    legacyValue: stats.wins,
    recentCompleted: recent.completed
  });

  const weightedLosses = pickWeightedValue({
    stats,
    sourceValue: sourceCounts.losses,
    recentValue: recent.losses,
    legacyValue: stats.losses,
    recentCompleted: recent.completed
  });

  const weightedFlats = pickWeightedValue({
    stats,
    sourceValue: sourceCounts.flats,
    recentValue: recent.flats,
    legacyValue: stats.flats,
    recentCompleted: recent.completed
  });

  const totalR = pickWeightedValue({
    stats,
    sourceValue: sourceTotals.totalR,
    recentValue: recent.totalR,
    legacyValue: stats.totalR,
    recentCompleted: recent.completed
  });

  const totalPnlPct = pickWeightedValue({
    stats,
    sourceValue: sourceTotals.totalPnlPct,
    recentValue: recent.totalPnlPct,
    legacyValue: stats.totalPnlPct,
    recentCompleted: recent.completed
  });

  const totalCostR = pickWeightedValue({
    stats,
    sourceValue: sourceTotals.totalCostR,
    recentValue: recent.totalCostR,
    legacyValue: stats.totalCostR,
    recentCompleted: recent.completed
  });

  const grossWinR = pickWeightedValue({
    stats,
    sourceValue: sourceTotals.grossWinR,
    recentValue: recent.grossWinR,
    legacyValue: stats.grossWinR,
    recentCompleted: recent.completed
  });

  const grossLossR = pickWeightedValue({
    stats,
    sourceValue: sourceTotals.grossLossR,
    recentValue: recent.grossLossR,
    legacyValue: stats.grossLossR,
    recentCompleted: recent.completed
  });

  const directSLCount = pickWeightedValue({
    stats,
    sourceValue: stats.directSLCount,
    recentValue: recent.directSLCount,
    legacyValue: stats.directSLCount,
    recentCompleted: recent.completed
  });

  const nearTpCount = pickWeightedValue({
    stats,
    sourceValue: stats.nearTpCount,
    recentValue: recent.nearTpCount,
    legacyValue: stats.nearTpCount,
    recentCompleted: recent.completed
  });

  const reachedHalfRCount = pickWeightedValue({
    stats,
    sourceValue: stats.reachedHalfRCount,
    recentValue: recent.reachedHalfRCount,
    legacyValue: stats.reachedHalfRCount,
    recentCompleted: recent.completed
  });

  const reachedOneRCount = pickWeightedValue({
    stats,
    sourceValue: stats.reachedOneRCount,
    recentValue: recent.reachedOneRCount,
    legacyValue: stats.reachedOneRCount,
    recentCompleted: recent.completed
  });

  const beWouldExitCount = pickWeightedValue({
    stats,
    sourceValue: stats.beWouldExitCount,
    recentValue: recent.beWouldExitCount,
    legacyValue: stats.beWouldExitCount,
    recentCompleted: recent.completed
  });

  const gaveBackAfterHalfRCount = pickWeightedValue({
    stats,
    sourceValue: stats.gaveBackAfterHalfRCount,
    recentValue: recent.gaveBackAfterHalfRCount,
    legacyValue: stats.gaveBackAfterHalfRCount,
    recentCompleted: recent.completed
  });

  const gaveBackAfterOneRCount = pickWeightedValue({
    stats,
    sourceValue: stats.gaveBackAfterOneRCount,
    recentValue: recent.gaveBackAfterOneRCount,
    legacyValue: stats.gaveBackAfterOneRCount,
    recentCompleted: recent.completed
  });

  const nearTpThenLossCount = pickWeightedValue({
    stats,
    sourceValue: stats.nearTpThenLossCount,
    recentValue: recent.nearTpThenLossCount,
    legacyValue: stats.nearTpThenLossCount,
    recentCompleted: recent.completed
  });

  const winrateSample = safeNumber(actualCounts.completed, 0);
  const winrateWins = safeNumber(actualCounts.wins, 0);

  const rawWinrate = winrateSample > 0
    ? winrateWins / winrateSample
    : 0;

  const bayes = bayesianWinrate(winrateWins, winrateSample);
  const wilson = wilsonLowerBound(winrateWins, winrateSample);

  const fair = winrateSample > 0
    ? wilson * 0.8 + bayes * 0.15 + rawWinrate * 0.05
    : 0;

  const reliability = sampleReliability(winrateSample);

  const avgR = weightedCompletedForR > 0
    ? totalR / weightedCompletedForR
    : 0;

  const avgPnlPct = weightedCompletedForR > 0
    ? totalPnlPct / weightedCompletedForR
    : 0;

  const avgWinR = weightedWins > 0
    ? grossWinR / weightedWins
    : 0;

  const avgLossR = weightedLosses > 0
    ? -grossLossR / weightedLosses
    : 0;

  const profitFactor =
    grossLossR > 0 ? grossWinR / grossLossR :
    grossWinR > 0 ? 99 :
    0;

  const directSLPct = weightedCompletedForR > 0
    ? directSLCount / weightedCompletedForR
    : 0;

  const nearTpPct = weightedCompletedForR > 0
    ? nearTpCount / weightedCompletedForR
    : 0;

  const reachedHalfRPct = weightedCompletedForR > 0
    ? reachedHalfRCount / weightedCompletedForR
    : 0;

  const reachedOneRPct = weightedCompletedForR > 0
    ? reachedOneRCount / weightedCompletedForR
    : 0;

  const beWouldExitPct = weightedCompletedForR > 0
    ? beWouldExitCount / weightedCompletedForR
    : 0;

  const gaveBackAfterHalfRPct = weightedCompletedForR > 0
    ? gaveBackAfterHalfRCount / weightedCompletedForR
    : 0;

  const gaveBackAfterOneRPct = weightedCompletedForR > 0
    ? gaveBackAfterOneRCount / weightedCompletedForR
    : 0;

  const nearTpThenLossPct = weightedCompletedForR > 0
    ? nearTpThenLossCount / weightedCompletedForR
    : 0;

  const avgCostR = weightedCompletedForR > 0
    ? totalCostR / weightedCompletedForR
    : 0;

  const sampleAdjustedAvgRValue = sampleAdjustedAvgR(avgR, reliability);

  const balancedScore = buildBalancedScore({
    fair,
    avgR,
    totalR,
    sampleRel: reliability,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
  });

  const avgRScore = buildAvgRScore({
    sampleAdjustedAvgRValue,
    fair,
    totalR,
    sampleRel: reliability,
    profitFactor,
    nearTpPct,
    reachedOneRPct,
    directSLPct,
    nearTpThenLossPct,
    gaveBackAfterOneRPct,
    avgCostR
  });

  Object.assign(stats, {
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    source: stats.source || SOURCE_VIRTUAL,

    completed: round4(closedCompleted),
    winrateSample: round4(winrateSample),

    wins: round4(weightedWins),
    losses: round4(weightedLosses),
    flats: round4(weightedFlats),

    totalR: round4(totalR),
    totalPnlPct: round4(totalPnlPct),
    totalCostR: round4(totalCostR),

    virtualTotalR: round4(stats.virtualTotalR),
    realTotalR: 0,
    shadowTotalR: round4(stats.shadowTotalR),

    virtualTotalPnlPct: round4(stats.virtualTotalPnlPct),
    realTotalPnlPct: 0,
    shadowTotalPnlPct: round4(stats.shadowTotalPnlPct),

    virtualTotalCostR: round4(stats.virtualTotalCostR),
    realTotalCostR: 0,
    shadowTotalCostR: round4(stats.shadowTotalCostR),

    virtualGrossWinR: round4(stats.virtualGrossWinR),
    virtualGrossLossR: round4(stats.virtualGrossLossR),
    realGrossWinR: 0,
    realGrossLossR: 0,
    shadowGrossWinR: round4(stats.shadowGrossWinR),
    shadowGrossLossR: round4(stats.shadowGrossLossR),

    realCompleted: 0,
    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    grossWinR: round4(grossWinR),
    grossLossR: round4(grossLossR),

    winrate: round4(rawWinrate),
    bayesianWinrate: round4(bayes),
    wilsonLowerBound: round4(wilson),
    fairWinrate: round4(fair),

    sampleRawWinrate: round4(rawWinrate),
    sampleBayesianWinrate: round4(bayes),
    sampleWilsonLowerBound: round4(wilson),
    sampleAdjustedWinrate: round4(fair),
    sampleReliabilityOld: round4(reliability),

    sampleReliability: round4(reliability),

    avgR: round4(avgR),
    avgPnlPct: round4(avgPnlPct),
    avgWinR: round4(avgWinR),
    avgLossR: round4(avgLossR),
    sampleAdjustedAvgR: round4(sampleAdjustedAvgRValue),
    avgRScore: round4(avgRScore),

    profitFactor: round4(profitFactor),

    directSLCount: round4(directSLCount),
    nearTpCount: round4(nearTpCount),
    reachedHalfRCount: round4(reachedHalfRCount),
    reachedOneRCount: round4(reachedOneRCount),

    beWouldExitCount: round4(beWouldExitCount),
    gaveBackAfterHalfRCount: round4(gaveBackAfterHalfRCount),
    gaveBackAfterOneRCount: round4(gaveBackAfterOneRCount),
    nearTpThenLossCount: round4(nearTpThenLossCount),

    directSLPct: round4(directSLPct),
    nearTpPct: round4(nearTpPct),
    reachedHalfRPct: round4(reachedHalfRPct),
    reachedOneRPct: round4(reachedOneRPct),

    beWouldExitPct: round4(beWouldExitPct),
    gaveBackAfterHalfRPct: round4(gaveBackAfterHalfRPct),
    gaveBackAfterOneRPct: round4(gaveBackAfterOneRPct),
    nearTpThenLossPct: round4(nearTpThenLossPct),

    avgCostR: round4(avgCostR),
    balancedScore: round4(balancedScore),
    dashboardBalancedScore: round4(balancedScore),

    tooEarly: closedCompleted < MIN_COMPLETED_ACTIVE,
    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE,

    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    symbolExcludedFromFamilyId: true,

    fixedTaxonomyLearningId:
      Boolean(stats.fixedTaxonomyLearningId) ||
      isFixedTaxonomyMicroId(stats.trueMicroFamilyId || stats.microFamilyId),

    updatedAt: now()
  });

  applySideIdentity(stats);

  stats.learningStatus = learningStatus(stats);
  stats.status = stats.learningStatus;
  stats.awaitingOutcomes = safeNumber(stats.completed, 0) <= 0 && safeNumber(stats.seen, 0) > 0;

  return stats;
}

export function normalizeDashboardMicro(row = {}, rank = null) {
  const stats = refreshStats(row);

  const normalized = {
    ...stats,

    sampleRawWinrate: stats.winrate,
    sampleBayesianWinrate: stats.bayesianWinrate,
    sampleWilsonLowerBound: stats.wilsonLowerBound,
    sampleAdjustedWinrate: stats.fairWinrate,
    sampleReliabilityOld: stats.sampleReliability,

    dashboardBalancedScore: stats.balancedScore,

    tooEarly: safeNumber(stats.completed, 0) < MIN_COMPLETED_ACTIVE,
    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE
  };

  applySideIdentity(normalized);

  if (rank !== null && rank !== undefined) {
    normalized.rank = rank;
  }

  return normalized;
}

export function normalizeDashboardSummary(summary = {}) {
  const out = { ...summary };

  for (const key of ['bestBalanced', 'bestTotalR', 'bestWinrate', 'lowestDirectSL']) {
    if (out[key] && typeof out[key] === 'object' && isRealAnalyzeMicroRow(out[key])) {
      out[key] = normalizeDashboardMicro(out[key]);
    } else {
      out[key] = null;
    }
  }

  return out;
}

function sortById(a, b) {
  return String(a.microFamilyId || '').localeCompare(String(b.microFamilyId || ''));
}

function compareWinrate(a, b) {
  return (
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.wilsonLowerBound, 0) - safeNumber(a.wilsonLowerBound, 0) ||
    safeNumber(b.bayesianWinrate, 0) - safeNumber(a.bayesianWinrate, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    safeNumber(b.winrate, 0) - safeNumber(a.winrate, 0) ||
    sortById(a, b)
  );
}

function compareAvgR(a, b) {
  return (
    safeNumber(b.avgRScore, 0) - safeNumber(a.avgRScore, 0) ||
    safeNumber(b.sampleAdjustedAvgR, 0) - safeNumber(a.sampleAdjustedAvgR, 0) ||
    safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
    safeNumber(b.sampleReliability, 0) - safeNumber(a.sampleReliability, 0) ||
    safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
    sortById(a, b)
  );
}

function compareBalanced(a, b) {
  return (
    safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
      safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
    safeNumber(b.balancedScore, 0) - safeNumber(a.balancedScore, 0) ||
    compareWinrate(a, b)
  );
}

export function rankMicros(micros = {}, mode = 'balanced') {
  const safeMode = mode === 'winrate'
    ? 'balanced'
    : String(mode || 'balanced');

  const rows = Object.values(micros || {})
    .filter(Boolean)
    .filter(isRealAnalyzeMicroRow)
    .map((row) => refreshStats(row))
    .filter((row) => row.tradeSide === TARGET_TRADE_SIDE)
    .filter((row) => !isScannerFamilyId(row.microFamilyId))
    .filter((row) => !isScannerFamilyId(row.trueMicroFamilyId));

  const sorted = [...rows].sort((a, b) => {
    if (safeMode === 'totalR') {
      return (
        safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
          safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
        safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
        safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
        safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0) ||
        sortById(a, b)
      );
    }

    if (safeMode === 'avgR') {
      return compareAvgR(a, b);
    }

    if (safeMode === 'directSL') {
      return (
        safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
        safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
          safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
        safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
        safeNumber(b.winrateSample, 0) - safeNumber(a.winrateSample, 0) ||
        sortById(a, b)
      );
    }

    if (safeMode === 'observed') {
      return (
        safeNumber(b.seen, 0) - safeNumber(a.seen, 0) ||
        safeNumber(b.observations, 0) - safeNumber(a.observations, 0) ||
        safeNumber(b.dashboardBalancedScore ?? b.balancedScore, 0) -
          safeNumber(a.dashboardBalancedScore ?? a.balancedScore, 0) ||
        safeNumber(b.fairWinrate, 0) - safeNumber(a.fairWinrate, 0) ||
        sortById(a, b)
      );
    }

    return compareBalanced(a, b);
  });

  return sorted.map((row, index) => normalizeDashboardMicro(row, index + 1));
}

export {
  dashboardSideFromTradeSide
};