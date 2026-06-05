// ================= FILE: api/admin/micro-families.js =================

import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  sideToTradeSide,
  safeNumber
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';

const VALID_MODES = new Set([
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

const WINRATE_Z = 1.96;
const WINRATE_BAYES_ALPHA = 1;
const WINRATE_BAYES_BETA = 1;
const SAMPLE_RELIABILITY_CAP = 50;
const TRADABLE_SAMPLE_MIN = 5;

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 160;
const DEFAULT_SIDE_ENSURE_LIMIT = 0;
const MAX_SIDE_ENSURE_LIMIT = 40;

const RANK_CACHE_TTL_MS = 20_000;
const RANK_CACHE_MAX_KEYS = 12;

const FAST_SUMMARY_LIMIT = 1200;
const HARD_ROUTE_BUDGET_MS = 52_000;

const globalCache = globalThis.__ADMIN_MICRO_FAMILIES_RANK_CACHE__ ||= new Map();

function now() {
  return Date.now();
}

function elapsed(startedAt) {
  return now() - startedAt;
}

function routeBudgetExceeded(startedAt, maxMs = HARD_ROUTE_BUDGET_MS) {
  return elapsed(startedAt) >= maxMs;
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function toSafeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return fallback;

  return Math.min(Math.floor(n), max);
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1' ||
    value === 'yes' ||
    value === 'YES'
  );
}

function isFalse(value) {
  return (
    value === false ||
    value === 'false' ||
    value === 'FALSE' ||
    value === 0 ||
    value === '0' ||
    value === 'no' ||
    value === 'NO'
  );
}

function num(value, fallback = 0) {
  return safeNumber(value, fallback);
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function clamp(value, min = 0, max = 1) {
  const n = num(value, min);

  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => {
        if (Array.isArray(value)) return value;

        return String(value || '')
          .split(/[\s,]+/g)
          .map((part) => part.trim());
      })
      .filter(Boolean)
  )];
}

function normalizeSideToken(value) {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === 'LONG' || converted === 'SHORT') return converted;

  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function getDefinitionParts(row = {}) {
  if (Array.isArray(row.definitionParts)) return row.definitionParts;
  if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;

  return [];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
  if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;

  return [];
}

function collectSideText(input = {}) {
  return [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.entrySide,
    input.bias,
    input.marketBias,

    input.familyId,
    input.family,
    input.baseFamilyId,

    input.macroFamilyId,
    input.parentMacroFamilyId,
    input.parentMicroFamilyId,
    input.parentFamilyId,
    input.macroId,

    input.microFamilyId,
    input.trueMicroFamilyId,
    input.id,
    input.key,

    input.definition,
    input.microDefinition,
    input.macroDefinition,
    input.parentDefinition,

    ...getArray(input.definitionParts),
    ...getArray(input.microDefinitionParts),
    ...getArray(input.macroDefinitionParts),
    ...getArray(input.parentDefinitionParts)
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join(' | ');
}

function hasLongSignal(text = '') {
  const raw = ` ${upper(text)} `;

  return (
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY') ||

    raw.includes('MICRO_LONG_') ||
    raw.includes('LONG_') ||
    raw.includes('_LONG') ||
    raw.includes('|LONG|') ||
    raw.includes(':LONG') ||
    raw.includes('=LONG') ||

    raw.includes(' BULL ') ||
    raw.includes('_BULL') ||
    raw.includes('BULL_') ||
    raw.includes('|BULL|') ||
    raw.includes(':BULL') ||
    raw.includes('=BULL') ||

    raw.includes(' BUY ') ||
    raw.includes('_BUY') ||
    raw.includes('BUY_') ||
    raw.includes('|BUY|') ||
    raw.includes(':BUY') ||
    raw.includes('=BUY')
  );
}

function hasShortSignal(text = '') {
  const raw = ` ${upper(text)} `;

  return (
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('SIDE=SELL') ||
    raw.includes('DIRECTION=SELL') ||

    raw.includes('MICRO_SHORT_') ||
    raw.includes('SHORT_') ||
    raw.includes('_SHORT') ||
    raw.includes('|SHORT|') ||
    raw.includes(':SHORT') ||
    raw.includes('=SHORT') ||

    raw.includes(' BEAR ') ||
    raw.includes('_BEAR') ||
    raw.includes('BEAR_') ||
    raw.includes('|BEAR|') ||
    raw.includes(':BEAR') ||
    raw.includes('=BEAR') ||

    raw.includes(' SELL ') ||
    raw.includes('_SELL') ||
    raw.includes('SELL_') ||
    raw.includes('|SELL|') ||
    raw.includes(':SELL') ||
    raw.includes('=SELL')
  );
}

function inferTradeSide(input = {}) {
  const directSources = [
    input.tradeSide,
    input.side,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.entrySide,
    input.bias,
    input.marketBias
  ];

  for (const source of directSources) {
    const normalized = normalizeSideToken(source);

    if (normalized === 'LONG' || normalized === 'SHORT') return normalized;
  }

  const familyId = upper(input.familyId || input.family || input.baseFamilyId);
  const macroFamilyId = upper(
    input.parentMacroFamilyId ||
    input.macroFamilyId ||
    input.parentMicroFamilyId ||
    input.parentFamilyId ||
    input.macroId
  );
  const microFamilyId = upper(
    input.microFamilyId ||
    input.trueMicroFamilyId ||
    input.id ||
    input.key
  );

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('LONG')) return 'LONG';
  if (macroFamilyId.includes('SHORT')) return 'SHORT';

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

  const text = collectSideText(input);
  const longSignal = hasLongSignal(text);
  const shortSignal = hasShortSignal(text);

  if (longSignal && !shortSignal) return 'LONG';
  if (shortSignal && !longSignal) return 'SHORT';

  if (microFamilyId.includes('LONG')) return 'LONG';
  if (microFamilyId.includes('SHORT')) return 'SHORT';

  return 'UNKNOWN';
}

function normalizeDashboardSide(row = {}) {
  const tradeSide = inferTradeSide(row);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
}

function getMacroFamilyId(row = {}) {
  return (
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.familyId ||
    null
  );
}

function getFamilyId(row = {}) {
  return (
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    null
  );
}

function getCompletedSample(row = {}) {
  const realCompleted = num(row.realCompleted, 0);
  const shadowCompleted = num(row.shadowCompleted, 0);
  const explicitCompleted = realCompleted + shadowCompleted;

  const weightedCompleted = num(row.completed, 0);

  const outcomeCompleted =
    num(row.realWins, 0) +
    num(row.realLosses, 0) +
    num(row.realFlats, 0) +
    num(row.shadowWins, 0) +
    num(row.shadowLosses, 0) +
    num(row.shadowFlats, 0);

  const weightedOutcomes =
    num(row.wins, 0) +
    num(row.losses, 0) +
    num(row.flats, 0);

  return Math.max(
    explicitCompleted,
    weightedCompleted,
    outcomeCompleted,
    weightedOutcomes,
    0
  );
}

function getOutcomeCounts(row = {}) {
  const realWins = num(row.realWins, 0);
  const realLosses = num(row.realLosses, 0);
  const realFlats = num(row.realFlats, 0);

  const shadowWins = num(row.shadowWins, 0);
  const shadowLosses = num(row.shadowLosses, 0);
  const shadowFlats = num(row.shadowFlats, 0);

  const actualWins = realWins + shadowWins;
  const actualLosses = realLosses + shadowLosses;
  const actualFlats = realFlats + shadowFlats;
  const actualTotal = actualWins + actualLosses + actualFlats;

  if (actualTotal > 0) {
    return {
      wins: actualWins,
      losses: actualLosses,
      flats: actualFlats,
      total: actualTotal
    };
  }

  const weightedWins = num(row.wins, 0);
  const weightedLosses = num(row.losses, 0);
  const weightedFlats = num(row.flats, 0);
  const weightedTotal = weightedWins + weightedLosses + weightedFlats;

  if (weightedTotal > 0) {
    return {
      wins: weightedWins,
      losses: weightedLosses,
      flats: weightedFlats,
      total: weightedTotal
    };
  }

  const sample = getCompletedSample(row);
  const rawWinrate = clamp(row.winrate, 0, 1);

  if (sample <= 0) {
    return {
      wins: 0,
      losses: 0,
      flats: 0,
      total: 0
    };
  }

  return {
    wins: rawWinrate * sample,
    losses: (1 - rawWinrate) * sample,
    flats: 0,
    total: sample
  };
}

function wilsonLowerBound(successes, trials, z = WINRATE_Z) {
  const n = num(trials, 0);

  if (n <= 0) return 0;

  const p = clamp(successes / n, 0, 1);
  const z2 = z * z;

  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function sampleReliability(sample, cap = SAMPLE_RELIABILITY_CAP) {
  const n = num(sample, 0);

  if (n <= 0) return 0;

  return clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1);
}

function getSampleAdjustedWinrate(row = {}) {
  const counts = getOutcomeCounts(row);
  const sample = counts.total;

  if (sample <= 0) {
    return {
      sample: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      rawWinrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      reliability: 0,
      score: 0
    };
  }

  const successes = counts.wins + counts.flats * 0.5;
  const rawWinrate = clamp(successes / sample, 0, 1);

  const bayesianWinrate = clamp(
    (successes + WINRATE_BAYES_ALPHA) /
      (sample + WINRATE_BAYES_ALPHA + WINRATE_BAYES_BETA),
    0,
    1
  );

  const wilson = wilsonLowerBound(successes, sample);
  const reliability = sampleReliability(sample);

  const score = clamp(
    wilson * 0.8 +
      bayesianWinrate * 0.15 +
      rawWinrate * 0.05,
    0,
    1
  );

  return {
    sample,
    wins: counts.wins,
    losses: counts.losses,
    flats: counts.flats,
    rawWinrate,
    bayesianWinrate,
    wilsonLowerBound: wilson,
    reliability,
    score
  };
}

function getDashboardBalancedScore(row = {}, winrateMeta = null) {
  const meta = winrateMeta || getSampleAdjustedWinrate(row);

  const totalR = Math.max(0, num(row.totalR, 0));
  const avgR = Math.max(0, num(row.avgR, 0));
  const profitFactor = Math.min(Math.max(0, num(row.profitFactor, 0)), 20);

  const directSLPct = clamp(row.directSLPct, 0, 1);
  const nearTpThenLossPct = clamp(row.nearTpThenLossPct, 0, 1);
  const gaveBackAfterOneRPct = clamp(row.gaveBackAfterOneRPct, 0, 1);
  const avgCostR = Math.max(0, num(row.avgCostR, 0));

  const winrateComponent = meta.score * 100;
  const reliabilityComponent = meta.reliability * 20;
  const totalRComponent = Math.log1p(totalR) * 12;
  const avgRComponent = Math.log1p(avgR) * 8;
  const pfComponent = Math.log1p(profitFactor) * 3;

  const riskPenalty =
    directSLPct * 60 +
    nearTpThenLossPct * 45 +
    gaveBackAfterOneRPct * 20 +
    avgCostR * 3;

  return (
    winrateComponent +
    reliabilityComponent +
    totalRComponent +
    avgRComponent +
    pfComponent -
    riskPenalty
  );
}

function compareNumberDesc(a, b) {
  return num(b, 0) - num(a, 0);
}

function compareNumberAsc(a, b) {
  return num(a, 0) - num(b, 0);
}

function compareIdAsc(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function compareWrappedWinrate(a, b) {
  return (
    compareNumberDesc(a.winrate.score, b.winrate.score) ||
    compareNumberDesc(a.winrate.wilsonLowerBound, b.winrate.wilsonLowerBound) ||
    compareNumberDesc(a.winrate.bayesianWinrate, b.winrate.bayesianWinrate) ||
    compareNumberDesc(a.winrate.rawWinrate, b.winrate.rawWinrate) ||
    compareNumberDesc(a.winrate.sample, b.winrate.sample) ||
    compareNumberDesc(a.row.totalR, b.row.totalR) ||
    compareNumberDesc(a.row.avgR, b.row.avgR) ||
    compareIdAsc(a.row.microFamilyId, b.row.microFamilyId) ||
    a.index - b.index
  );
}

function compareWrappedBalanced(a, b) {
  return (
    compareNumberDesc(a.dashboardBalancedScore, b.dashboardBalancedScore) ||
    compareWrappedWinrate(a, b)
  );
}

function compareWrappedTotalR(a, b) {
  return (
    compareNumberDesc(a.row.totalR, b.row.totalR) ||
    compareWrappedWinrate(a, b)
  );
}

function compareWrappedAvgR(a, b) {
  return (
    compareNumberDesc(a.row.avgR, b.row.avgR) ||
    compareWrappedWinrate(a, b)
  );
}

function compareWrappedDirectSL(a, b) {
  return (
    compareNumberAsc(a.row.directSLPct, b.row.directSLPct) ||
    compareNumberDesc(a.winrate.sample, b.winrate.sample) ||
    compareNumberDesc(a.winrate.score, b.winrate.score) ||
    compareNumberDesc(a.row.totalR, b.row.totalR) ||
    a.index - b.index
  );
}

function compareWrappedObserved(a, b) {
  return (
    compareNumberDesc(a.winrate.sample, b.winrate.sample) ||
    compareNumberDesc(a.row.completed, b.row.completed) ||
    compareNumberDesc(a.row.seen, b.row.seen) ||
    compareNumberDesc(a.winrate.score, b.winrate.score) ||
    compareNumberDesc(a.row.totalR, b.row.totalR) ||
    a.index - b.index
  );
}

function compareWrappedByMode(a, b, mode) {
  if (mode === 'winrate') return compareWrappedWinrate(a, b);
  if (mode === 'totalR') return compareWrappedTotalR(a, b);
  if (mode === 'avgR') return compareWrappedAvgR(a, b);
  if (mode === 'directSL') return compareWrappedDirectSL(a, b);
  if (mode === 'observed') return compareWrappedObserved(a, b);

  return compareWrappedBalanced(a, b);
}

function buildRawMicroRow(row = {}, key = '', index = 0) {
  const microFamilyId = row.microFamilyId || row.trueMicroFamilyId || row.id || key || null;
  const familyId = getFamilyId(row);
  const macroFamilyId = getMacroFamilyId({
    ...row,
    microFamilyId,
    familyId
  });

  const definitionParts = getDefinitionParts(row);
  const macroDefinitionParts = getMacroDefinitionParts(row);

  const tradeSide = inferTradeSide({
    ...row,
    microFamilyId,
    familyId,
    macroFamilyId,
    definitionParts,
    macroDefinitionParts
  });

  return {
    sourceIndex: index,

    microFamilyId,
    familyId,
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    side: tradeSide === 'LONG'
      ? 'bull'
      : tradeSide === 'SHORT'
        ? 'bear'
        : 'unknown',
    tradeSide,

    seen: num(row.seen ?? row.observations, 0),
    observations: num(row.observations ?? row.seen, 0),

    completed: round(row.completed, 4),
    realCompleted: num(row.realCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),

    wins: round(row.wins, 4),
    losses: round(row.losses, 4),
    flats: round(row.flats, 4),

    realWins: num(row.realWins, 0),
    realLosses: num(row.realLosses, 0),
    realFlats: num(row.realFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(
      row.fairWinrate ??
      row.bayesianWinrate ??
      row.wilsonLowerBound,
      4
    ),

    totalR: round(row.totalR, 4),
    realTotalR: round(row.realTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),

    avgR: round(row.avgR, 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(row.profitFactor, 4),

    directSLCount: round(row.directSLCount, 4),
    directSLPct: round(row.directSLPct, 4),

    nearTpCount: round(row.nearTpCount, 4),
    nearTpPct: round(row.nearTpPct, 4),

    reachedHalfRCount: round(row.reachedHalfRCount, 4),
    reachedOneRCount: round(row.reachedOneRCount, 4),
    reachedHalfRPct: round(row.reachedHalfRPct, 4),
    reachedOneRPct: round(row.reachedOneRPct, 4),

    beWouldExitCount: round(row.beWouldExitCount, 4),
    beWouldExitPct: round(row.beWouldExitPct, 4),

    gaveBackAfterHalfRCount: round(row.gaveBackAfterHalfRCount, 4),
    gaveBackAfterOneRCount: round(row.gaveBackAfterOneRCount, 4),
    gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
    gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),

    nearTpThenLossCount: round(row.nearTpThenLossCount, 4),
    nearTpThenLossPct: round(row.nearTpThenLossPct, 4),

    totalCostR: round(row.totalCostR, 4),
    avgCostR: round(row.avgCostR, 4),

    balancedScore: round(row.balancedScore, 4),

    definition: row.definition || row.microDefinition || null,
    definitionParts,

    macroDefinition: row.macroDefinition || row.parentDefinition || null,
    macroDefinitionParts,

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : definitionParts,

    assetClass: row.assetClass || null,
    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,
    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,
    obRelation: row.obRelation || null,
    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,
    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,
    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    selectedTier: row.selectedTier || row.rotationEligibilityTier || row.eligibilityTier || null,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || row.eligibilityTier || null,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function buildRowsFromMicros(micros = {}, options = {}) {
  const startedAt = options.startedAt || now();
  const entries = Object.entries(micros || {});
  const rows = [];

  for (let index = 0; index < entries.length; index += 1) {
    if (routeBudgetExceeded(startedAt)) break;

    const [key, row] = entries[index];
    const built = buildRawMicroRow(row || {}, key, index);

    if (built.microFamilyId) rows.push(built);
  }

  return rows;
}

function decorateRowsForDashboard(rows = [], startedAt = now()) {
  const output = [];

  for (let index = 0; index < rows.length; index += 1) {
    if (routeBudgetExceeded(startedAt)) break;

    const row = rows[index];
    const winrate = getSampleAdjustedWinrate(row);
    const dashboardBalancedScore = getDashboardBalancedScore(row, winrate);

    output.push({
      row: {
        ...row,

        winrateSample: round(winrate.sample, 4),
        sampleAdjustedWinrate: round(winrate.score, 4),
        sampleRawWinrate: round(winrate.rawWinrate, 4),
        sampleBayesianWinrate: round(winrate.bayesianWinrate, 4),
        sampleWilsonLowerBound: round(winrate.wilsonLowerBound, 4),
        sampleReliability: round(winrate.reliability, 4),

        dashboardBalancedScore: round(dashboardBalancedScore, 4)
      },
      index,
      winrate,
      dashboardBalancedScore
    });
  }

  return output;
}

function applyDashboardRanking(rows = [], mode = 'balanced', startedAt = now()) {
  return decorateRowsForDashboard(rows, startedAt)
    .sort((a, b) => compareWrappedByMode(a, b, mode))
    .map((item, index) => ({
      ...item.row,
      rank: index + 1
    }));
}

function pruneRankCache() {
  const entries = [...globalCache.entries()];

  if (entries.length <= RANK_CACHE_MAX_KEYS) return;

  entries
    .sort((a, b) => num(a[1]?.ts, 0) - num(b[1]?.ts, 0))
    .slice(0, Math.max(0, entries.length - RANK_CACHE_MAX_KEYS))
    .forEach(([key]) => globalCache.delete(key));
}

function microsSignature(micros = {}) {
  const keys = Object.keys(micros || {});
  const count = keys.length;

  if (count <= 0) return '0';

  const first = keys[0] || '';
  const middle = keys[Math.floor(count / 2)] || '';
  const last = keys[count - 1] || '';

  return `${count}:${first}:${middle}:${last}`;
}

function parseFilters(req) {
  const side = String(firstQueryValue(req.query?.side, '') || '').toUpperCase();
  const familyId = String(firstQueryValue(req.query?.familyId, '') || '').trim();
  const macroFamilyId = String(firstQueryValue(req.query?.macroFamilyId, '') || '').trim();
  const q = String(firstQueryValue(req.query?.q, '') || '').trim().toUpperCase();

  return {
    side,
    familyId,
    macroFamilyId,
    q,

    activeOnly: isTrue(firstQueryValue(req.query?.activeOnly, false)),
    macroActiveOnly: isTrue(firstQueryValue(req.query?.macroActiveOnly, false)),

    minCompleted: num(firstQueryValue(req.query?.minCompleted, 0), 0),
    minSample: num(firstQueryValue(req.query?.minSample, 0), 0),
    minSeen: num(firstQueryValue(req.query?.minSeen, 0), 0)
  };
}

function wantedTradeSide(side) {
  const raw = upper(side);

  if (['LONG', 'BULL', 'BUY'].includes(raw)) return 'LONG';
  if (['SHORT', 'BEAR', 'SELL'].includes(raw)) return 'SHORT';

  return raw || '';
}

function rowMatchesSearch(row = {}, q = '') {
  if (!q) return true;

  const haystack = [
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.id,
    row.key,
    row.familyId,
    row.family,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts)
  ]
    .map((value) => upper(value))
    .join(' | ');

  return haystack.includes(q);
}

function rowPassesFilters(row = {}, filters, activeSet, activeMacroSet) {
  if (filters.side) {
    const wantedSide = wantedTradeSide(filters.side);

    if (inferTradeSide(row) !== wantedSide) return false;
  }

  if (filters.familyId && String(row.familyId || '') !== filters.familyId) {
    return false;
  }

  if (
    filters.macroFamilyId &&
    String(getMacroFamilyId(row) || '') !== filters.macroFamilyId
  ) {
    return false;
  }

  if (filters.activeOnly && !activeSet.has(row.microFamilyId)) {
    return false;
  }

  if (filters.macroActiveOnly && !activeMacroSet.has(getMacroFamilyId(row))) {
    return false;
  }

  if (filters.minCompleted > 0 && num(row.completed, 0) < filters.minCompleted) {
    return false;
  }

  if (filters.minSample > 0 && num(row.winrateSample, 0) < filters.minSample) {
    return false;
  }

  if (filters.minSeen > 0 && num(row.seen, 0) < filters.minSeen) {
    return false;
  }

  return rowMatchesSearch(row, filters.q);
}

function filtersNeedActiveRotation(filters = {}, includeActiveRotation = false) {
  return Boolean(
    includeActiveRotation ||
    filters.activeOnly ||
    filters.macroActiveOnly
  );
}

function getRankedRowsCached({
  weekKey,
  mode,
  micros,
  filters,
  startedAt
}) {
  const signature = microsSignature(micros);
  const sideKey = filters.side ? wantedTradeSide(filters.side) : 'ALL';
  const qKey = filters.q ? `Q:${filters.q}` : 'NOQ';
  const familyKey = filters.familyId ? `F:${filters.familyId}` : 'NOF';
  const macroKey = filters.macroFamilyId ? `M:${filters.macroFamilyId}` : 'NOM';
  const minKey = [
    filters.minCompleted || 0,
    filters.minSample || 0,
    filters.minSeen || 0
  ].join(':');

  const cacheKey = `${weekKey}|${mode}|${signature}|${sideKey}|${qKey}|${familyKey}|${macroKey}|${minKey}`;
  const cached = globalCache.get(cacheKey);

  if (cached && now() - cached.ts < RANK_CACHE_TTL_MS) {
    return {
      rows: cached.rows,
      scannedRows: cached.scannedRows || cached.rows.length,
      cacheHit: true,
      cacheKey
    };
  }

  const rawRows = buildRowsFromMicros(micros, { startedAt });

  const preFilteredRows = rawRows.filter((row) => (
    rowPassesFilters(row, {
      ...filters,
      activeOnly: false,
      macroActiveOnly: false
    }, new Set(), new Set())
  ));

  const rows = applyDashboardRanking(preFilteredRows, mode, startedAt);

  globalCache.set(cacheKey, {
    ts: now(),
    rows,
    scannedRows: rawRows.length
  });

  pruneRankCache();

  return {
    rows,
    scannedRows: rawRows.length,
    cacheHit: false,
    cacheKey
  };
}

function normalizeMicroRow(
  row = {},
  index = 0,
  {
    activeSet = new Set(),
    activeMacroSet = new Set(),
    compact = true
  } = {}
) {
  const microFamilyId = row.microFamilyId || row.id || row.key || null;
  const familyId = getFamilyId(row);
  const macroFamilyId = getMacroFamilyId(row);
  const tradeSide = inferTradeSide(row);

  const active = microFamilyId
    ? activeSet.has(microFamilyId)
    : false;

  const macroActive = macroFamilyId
    ? activeMacroSet.has(macroFamilyId)
    : false;

  const base = {
    rank: row.rank || index + 1,

    microFamilyId,
    familyId,
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    side: tradeSide === 'LONG'
      ? 'bull'
      : tradeSide === 'SHORT'
        ? 'bear'
        : 'unknown',
    tradeSide,

    active,
    macroActive,

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(row.completed, 4),
    realCompleted: num(row.realCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),

    wins: round(row.wins, 4),
    losses: round(row.losses, 4),
    flats: round(row.flats, 4),

    realWins: num(row.realWins, 0),
    realLosses: num(row.realLosses, 0),
    realFlats: num(row.realFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(row.fairWinrate, 4),

    winrateSample: round(row.winrateSample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleRawWinrate: round(row.sampleRawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    totalR: round(row.totalR, 4),
    realTotalR: round(row.realTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),

    avgR: round(row.avgR, 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(row.profitFactor, 4),

    directSLCount: round(row.directSLCount, 4),
    directSLPct: round(row.directSLPct, 4),

    nearTpCount: round(row.nearTpCount, 4),
    nearTpPct: round(row.nearTpPct, 4),

    reachedHalfRCount: round(row.reachedHalfRCount, 4),
    reachedOneRCount: round(row.reachedOneRCount, 4),
    reachedHalfRPct: round(row.reachedHalfRPct, 4),
    reachedOneRPct: round(row.reachedOneRPct, 4),

    beWouldExitCount: round(row.beWouldExitCount, 4),
    beWouldExitPct: round(row.beWouldExitPct, 4),

    gaveBackAfterHalfRCount: round(row.gaveBackAfterHalfRCount, 4),
    gaveBackAfterOneRCount: round(row.gaveBackAfterOneRCount, 4),
    gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
    gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),

    nearTpThenLossCount: round(row.nearTpThenLossCount, 4),
    nearTpThenLossPct: round(row.nearTpThenLossPct, 4),

    totalCostR: round(row.totalCostR, 4),
    avgCostR: round(row.avgCostR, 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore, 4),

    definition: row.definition || null,
    definitionParts: getDefinitionParts(row),

    macroDefinition: row.macroDefinition || row.parentDefinition || null,
    macroDefinitionParts: getMacroDefinitionParts(row),

    microDefinition: row.microDefinition || row.definition || null,
    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts
      : getDefinitionParts(row),

    assetClass: row.assetClass || null,
    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,
    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,
    obRelation: row.obRelation || null,
    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,
    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,
    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    selectedTier: row.selectedTier || row.rotationEligibilityTier || row.eligibilityTier || null,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || row.eligibilityTier || null,

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };

  if (compact) return base;

  return {
    ...row,
    ...base,

    realTotalPnlPct: round(row.realTotalPnlPct, 4),
    shadowTotalPnlPct: round(row.shadowTotalPnlPct, 4),
    grossWinR: round(row.grossWinR, 4),
    grossLossR: round(row.grossLossR, 4),
    realGrossWinR: round(row.realGrossWinR, 4),
    realGrossLossR: round(row.realGrossLossR, 4),
    shadowGrossWinR: round(row.shadowGrossWinR, 4),
    shadowGrossLossR: round(row.shadowGrossLossR, 4),
    totalPnlPct: round(row.totalPnlPct, 4),
    avgPnlPct: round(row.avgPnlPct, 4),
    realTotalCostR: round(row.realTotalCostR, 4),
    shadowTotalCostR: round(row.shadowTotalCostR, 4),

    counters: row.counters || {},
    examples: Array.isArray(row.examples) ? row.examples.slice(-8) : [],
    recentOutcomes: Array.isArray(row.recentOutcomes) ? row.recentOutcomes.slice(-8) : []
  };
}

function compactBestRow(row) {
  if (!row) return null;

  return {
    microFamilyId: row.microFamilyId || row.id || row.key || null,
    familyId: getFamilyId(row),
    macroFamilyId: getMacroFamilyId(row),

    side: normalizeDashboardSide(row),
    tradeSide: inferTradeSide(row),

    active: Boolean(row.active),
    macroActive: Boolean(row.macroActive),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),
    completed: round(row.completed, 4),
    realCompleted: num(row.realCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),

    winrateSample: round(row.winrateSample, 4),
    winrate: round(row.winrate, 4),
    fairWinrate: round(row.fairWinrate, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    avgR: round(row.avgR, 4),
    totalR: round(row.totalR, 4),
    profitFactor: round(row.profitFactor, 4),

    directSLPct: round(row.directSLPct, 4),
    avgCostR: round(row.avgCostR, 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore, 4)
  };
}

function compareNormalizedWinrate(a, b) {
  return (
    compareNumberDesc(a.sampleAdjustedWinrate, b.sampleAdjustedWinrate) ||
    compareNumberDesc(a.sampleWilsonLowerBound, b.sampleWilsonLowerBound) ||
    compareNumberDesc(a.sampleBayesianWinrate, b.sampleBayesianWinrate) ||
    compareNumberDesc(a.sampleRawWinrate, b.sampleRawWinrate) ||
    compareNumberDesc(a.winrateSample, b.winrateSample) ||
    compareNumberDesc(a.totalR, b.totalR) ||
    compareNumberDesc(a.avgR, b.avgR) ||
    compareIdAsc(a.microFamilyId, b.microFamilyId)
  );
}

function compareNormalizedBalanced(a, b) {
  return (
    compareNumberDesc(a.dashboardBalancedScore, b.dashboardBalancedScore) ||
    compareNormalizedWinrate(a, b)
  );
}

function compareNormalizedTotalR(a, b) {
  return (
    compareNumberDesc(a.totalR, b.totalR) ||
    compareNormalizedWinrate(a, b)
  );
}

function compareNormalizedAvgR(a, b) {
  return (
    compareNumberDesc(a.avgR, b.avgR) ||
    compareNormalizedWinrate(a, b)
  );
}

function compareNormalizedDirectSL(a, b) {
  return (
    compareNumberAsc(a.directSLPct, b.directSLPct) ||
    compareNumberDesc(a.winrateSample, b.winrateSample) ||
    compareNormalizedWinrate(a, b)
  );
}

function bestBy(rows = [], comparator) {
  return [...rows].sort(comparator)[0] || null;
}

function buildSideSummary(rows = [], side) {
  const sideRows = rows.filter((row) => inferTradeSide(row) === side);

  return {
    rows: sideRows.length,
    bestBalanced: compactBestRow(bestBy(sideRows, compareNormalizedBalanced)),
    bestWinrate: compactBestRow(bestBy(sideRows, compareNormalizedWinrate)),
    bestTotalR: compactBestRow(bestBy(sideRows, compareNormalizedTotalR)),
    bestAvgR: compactBestRow(bestBy(sideRows, compareNormalizedAvgR)),
    lowestDirectSL: compactBestRow(bestBy(sideRows, compareNormalizedDirectSL))
  };
}

function buildSummary(rows = [], activeSet = new Set()) {
  const sourceRows = rows.length > FAST_SUMMARY_LIMIT
    ? rows.slice(0, FAST_SUMMARY_LIMIT)
    : rows;

  const completedRows = sourceRows.filter((row) => num(row.completed, 0) > 0);
  const tradableRows = sourceRows.filter((row) => num(row.winrateSample, 0) >= TRADABLE_SAMPLE_MIN);
  const activeRows = sourceRows.filter((row) => activeSet.has(row.microFamilyId || row.id || row.key));

  let totalR = 0;
  let totalSeen = 0;
  let totalCompleted = 0;
  let totalWinrateSample = 0;
  let totalCostR = 0;

  for (const row of sourceRows) {
    totalR += num(row.totalR, 0);
    totalSeen += num(row.seen, 0);
    totalCompleted += num(row.completed, 0);
    totalWinrateSample += num(row.winrateSample, 0);
    totalCostR += num(row.totalCostR, 0);
  }

  const bestBalanced = bestBy(sourceRows, compareNormalizedBalanced);
  const bestTotalR = bestBy(sourceRows, compareNormalizedTotalR);
  const bestAvgR = bestBy(sourceRows, compareNormalizedAvgR);
  const bestWinrate = bestBy(sourceRows, compareNormalizedWinrate);
  const lowestDirectSL = bestBy(sourceRows, compareNormalizedDirectSL);

  return {
    rows: rows.length,
    summaryRowsUsed: sourceRows.length,
    summaryTruncated: rows.length > sourceRows.length,

    activeRows: activeRows.length,
    activeIds: activeSet.size,

    seen: round(totalSeen, 4),
    completed: round(totalCompleted, 4),
    winrateSample: round(totalWinrateSample, 4),

    completedMicroFamilies: completedRows.length,
    tradableMicroFamilies: tradableRows.length,

    totalR: round(totalR, 4),
    totalCostR: round(totalCostR, 4),
    avgR: totalCompleted > 0 ? round(totalR / totalCompleted, 4) : 0,
    avgCostR: totalCompleted > 0 ? round(totalCostR / totalCompleted, 4) : 0,

    bestBalanced: compactBestRow(bestBalanced),
    bestTotalR: compactBestRow(bestTotalR),
    bestAvgR: compactBestRow(bestAvgR),
    bestWinrate: compactBestRow(bestWinrate),
    lowestDirectSL: compactBestRow(lowestDirectSL),

    long: buildSideSummary(sourceRows, 'LONG'),
    short: buildSideSummary(sourceRows, 'SHORT')
  };
}

function extractActiveIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    ...(Array.isArray(activeRotation.microFamilyIds) ? activeRotation.microFamilyIds : []),
    ...(Array.isArray(activeRotation.activeMicroFamilyIds) ? activeRotation.activeMicroFamilyIds : []),
    ...(Array.isArray(activeRotation.trueMicroFamilyIds) ? activeRotation.trueMicroFamilyIds : []),
    ...(Array.isArray(activeRotation.ids) ? activeRotation.ids : []),
    ...(Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => row.microFamilyId)
      : [])
  ];

  return uniqueStrings(ids);
}

function extractActiveMacroIds(activeRotation) {
  if (!activeRotation) return [];

  const ids = [
    ...(Array.isArray(activeRotation.macroFamilyIds) ? activeRotation.macroFamilyIds : []),
    ...(Array.isArray(activeRotation.activeMacroFamilyIds) ? activeRotation.activeMacroFamilyIds : []),
    ...(Array.isArray(activeRotation.microFamilies)
      ? activeRotation.microFamilies.map((row) => getMacroFamilyId(row))
      : [])
  ];

  return uniqueStrings(ids);
}

function compactActiveRotation(activeRotation) {
  if (!activeRotation) return null;

  const activeMicroFamilyIds = extractActiveIds(activeRotation);
  const activeMacroFamilyIds = extractActiveMacroIds(activeRotation);

  return {
    rotationId: activeRotation.rotationId || null,
    source: activeRotation.source || null,
    mode: activeRotation.mode || null,
    sourceWeekKey: activeRotation.sourceWeekKey || null,
    activeWeekKey: activeRotation.activeWeekKey || null,
    generatedAt: activeRotation.generatedAt || null,
    activatedAt: activeRotation.activatedAt || null,

    trueMicroOnly: activeRotation.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation.usedLegacyFallback),
    usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation.usedObservationFallback),

    selectedTier: activeRotation.selectedTier || null,
    missingSides: Array.isArray(activeRotation.missingSides)
      ? activeRotation.missingSides
      : [],

    microFamilyIds: activeMicroFamilyIds,
    activeMicroFamilyIds,
    trueMicroFamilyIds: activeMicroFamilyIds,

    macroFamilyIds: activeMacroFamilyIds,
    activeMacroFamilyIds,

    bestLong: activeRotation.bestLong
      ? compactBestRow(activeRotation.bestLong)
      : null,

    bestShort: activeRotation.bestShort
      ? compactBestRow(activeRotation.bestShort)
      : null
  };
}

function rowKey(row = {}) {
  return String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();
}

function sideCounts(rows = []) {
  return rows.reduce(
    (acc, row) => {
      const side = inferTradeSide(row);

      if (side === 'LONG') acc.long += 1;
      else if (side === 'SHORT') acc.short += 1;
      else acc.unknown += 1;

      return acc;
    },
    {
      long: 0,
      short: 0,
      unknown: 0
    }
  );
}

function ensureSideRows({
  baseRows = [],
  allRows = [],
  side,
  ensureLimit = DEFAULT_SIDE_ENSURE_LIMIT,
  seenKeys
} = {}) {
  const currentSideCount = baseRows.filter((row) => inferTradeSide(row) === side).length;
  const missing = Math.max(0, ensureLimit - currentSideCount);

  if (missing <= 0) return [];

  const additions = [];

  for (const row of allRows) {
    if (inferTradeSide(row) !== side) continue;

    const key = rowKey(row);

    if (!key || seenKeys.has(key)) continue;

    seenKeys.add(key);
    additions.push(row);

    if (additions.length >= missing) break;
  }

  return additions;
}

function selectResponseRows({
  filteredRows = [],
  limit = DEFAULT_LIMIT,
  sideEnsureLimit = DEFAULT_SIDE_ENSURE_LIMIT,
  filters = {}
} = {}) {
  const baseRows = filteredRows.slice(0, limit);

  if (filters.side || sideEnsureLimit <= 0) return baseRows;

  const seenKeys = new Set(
    baseRows
      .map((row) => rowKey(row))
      .filter(Boolean)
  );

  const longAdditions = ensureSideRows({
    baseRows,
    allRows: filteredRows,
    side: 'LONG',
    ensureLimit: sideEnsureLimit,
    seenKeys
  });

  const shortAdditions = ensureSideRows({
    baseRows,
    allRows: filteredRows,
    side: 'SHORT',
    ensureLimit: sideEnsureLimit,
    seenKeys
  });

  return [
    ...baseRows,
    ...longAdditions,
    ...shortAdditions
  ];
}

function normalizeRows(rows = [], activeSet, activeMacroSet, compact) {
  return rows.map((row, index) => normalizeMicroRow(row, index, {
    activeSet,
    activeMacroSet,
    compact
  }));
}

function shouldReturnMinimalActive(req, filters, includeActiveRotation) {
  const fast = isTrue(firstQueryValue(req.query?.fast, false));

  if (!fast) return false;
  if (includeActiveRotation) return false;
  if (filters.activeOnly || filters.macroActiveOnly) return false;

  return true;
}

async function loadActiveRotationMaybe(req, filters, includeActiveRotation) {
  if (shouldReturnMinimalActive(req, filters, includeActiveRotation)) {
    return {
      activeRotation: null,
      skipped: true
    };
  }

  return {
    activeRotation: await getActiveRotation(),
    skipped: false
  };
}

export default async function handler(req, res) {
  const requestStartedAt = now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Micro-Families-Mode', 'fast-v2');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const currentWeekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    const requestedWeekKey = firstQueryValue(req.query?.weekKey, currentWeekKey);
    const requestedMode = String(firstQueryValue(req.query?.mode, 'balanced') || 'balanced');

    const mode = VALID_MODES.has(requestedMode)
      ? requestedMode
      : 'balanced';

    const requestedLimitRaw = firstQueryValue(req.query?.limit, DEFAULT_LIMIT);
    const requestedLimitNumber = Number(requestedLimitRaw) || DEFAULT_LIMIT;
    const limit = toSafeLimit(requestedLimitRaw, DEFAULT_LIMIT, MAX_LIMIT);

    const includeActiveRotationRaw = firstQueryValue(req.query?.includeActiveRotation, false);
    const includeActiveRotation = isTrue(includeActiveRotationRaw) && !isFalse(includeActiveRotationRaw);

    const sideEnsureLimit = toSafeLimit(
      firstQueryValue(
        req.query?.sideEnsureLimit,
        firstQueryValue(req.query?.sideLimit, DEFAULT_SIDE_ENSURE_LIMIT)
      ),
      DEFAULT_SIDE_ENSURE_LIMIT,
      MAX_SIDE_ENSURE_LIMIT
    );

    const compact = !isTrue(firstQueryValue(req.query?.details, false));
    const filters = parseFilters(req);

    const micros = await getWeekMicros(requestedWeekKey);

    const { activeRotation, skipped: activeRotationSkipped } = await loadActiveRotationMaybe(
      req,
      filters,
      includeActiveRotation
    );

    const activeMicroFamilyIds = extractActiveIds(activeRotation);
    const activeMacroFamilyIds = extractActiveMacroIds(activeRotation);

    const activeSet = new Set(activeMicroFamilyIds);
    const activeMacroSet = new Set(activeMacroFamilyIds);

    const {
      rows: preFilteredRankedRows,
      scannedRows,
      cacheHit,
      cacheKey
    } = getRankedRowsCached({
      weekKey: requestedWeekKey,
      mode,
      micros: micros || {},
      filters,
      startedAt: requestStartedAt
    });

    const filteredRows = preFilteredRankedRows.filter((row) => (
      rowPassesFilters(row, filters, activeSet, activeMacroSet)
    ));

    const responseRows = selectResponseRows({
      filteredRows,
      limit,
      sideEnsureLimit,
      filters
    });

    const normalizedRows = normalizeRows(responseRows, activeSet, activeMacroSet, compact);
    const summary = buildSummary(filteredRows, activeSet);
    const activeRotationCompact = compactActiveRotation(activeRotation);

    const rawSideCounts = sideCounts(preFilteredRankedRows);
    const filteredSideCounts = sideCounts(filteredRows);
    const responseSideCounts = sideCounts(normalizedRows);

    return res.status(200).json({
      ok: true,

      weekKey: requestedWeekKey,
      currentWeekKey,
      previousWeekKey,

      mode,
      requestedMode,

      requestedLimit: requestedLimitNumber,
      limit,
      limitCapped: requestedLimitNumber > limit,

      sideEnsureLimit,
      filters,
      compact,

      count: normalizedRows.length,
      filtered: filteredRows.length,
      totalAvailable: preFilteredRankedRows.length,
      scannedRows,

      rawSideCounts,
      filteredSideCounts,
      responseSideCounts,

      activeRotationId: activeRotation?.rotationId || null,
      activeRotation: includeActiveRotation ? activeRotation : activeRotationCompact,
      activeRotationSkipped,
      activeMicroFamilyIds,
      activeMacroFamilyIds,

      summary,

      rows: normalizedRows,

      perf: {
        durationMs: elapsed(requestStartedAt),
        rankCacheHit: cacheHit,
        rankCacheKey: cacheKey,
        rankCacheTtlMs: RANK_CACHE_TTL_MS,
        rankCacheSize: globalCache.size,
        fastMode: isTrue(firstQueryValue(req.query?.fast, false)),
        activeRotationSkipped,
        hardRouteBudgetMs: HARD_ROUTE_BUDGET_MS
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}