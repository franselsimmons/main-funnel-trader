// ================= FILE: api/admin/micro-families.js =================

import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  sideToTradeSide,
  safeNumber
} from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { rankMicros } from '../../src/analyze/scoring.js';
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

function toSafeLimit(value, fallback = 200) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return fallback;

  return Math.min(Math.floor(n), 1000);
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

function normalizeDashboardSide(side) {
  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
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

  // Kern: Wilson > Bayesian > raw.
  // Hierdoor ranked 50 trades met 95% boven 3 trades met 100%.
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

function getDashboardBalancedScore(row = {}) {
  const winrateMeta = getSampleAdjustedWinrate(row);

  const totalR = Math.max(0, num(row.totalR, 0));
  const avgR = Math.max(0, num(row.avgR, 0));
  const profitFactor = Math.min(Math.max(0, num(row.profitFactor, 0)), 20);

  const directSLPct = clamp(row.directSLPct, 0, 1);
  const nearTpThenLossPct = clamp(row.nearTpThenLossPct, 0, 1);
  const gaveBackAfterOneRPct = clamp(row.gaveBackAfterOneRPct, 0, 1);
  const avgCostR = Math.max(0, num(row.avgCostR, 0));

  const winrateComponent = winrateMeta.score * 100;
  const reliabilityComponent = winrateMeta.reliability * 20;
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
    compareNumberDesc(a.winrate.score, b.winrate.score) ||
    compareNumberDesc(a.row.totalR, b.row.totalR) ||
    a.index - b.index
  );
}

function decorateRowsForDashboard(rows = []) {
  return rows.map((row, index) => {
    const winrate = getSampleAdjustedWinrate(row);
    const dashboardBalancedScore = getDashboardBalancedScore(row);

    return {
      row,
      index,
      winrate,
      dashboardBalancedScore
    };
  });
}

function applyDashboardRanking(rows = [], mode = 'balanced') {
  const wrapped = decorateRowsForDashboard(rows);

  if (mode === 'winrate') {
    wrapped.sort(compareWrappedWinrate);
  } else if (mode === 'balanced') {
    wrapped.sort(compareWrappedBalanced);
  } else if (mode === 'directSL') {
    wrapped.sort(compareWrappedDirectSL);
  } else if (mode === 'observed') {
    wrapped.sort(compareWrappedObserved);
  }

  return wrapped.map((item) => ({
    ...item.row,

    winrateSample: round(item.winrate.sample, 4),
    sampleAdjustedWinrate: round(item.winrate.score, 4),
    sampleRawWinrate: round(item.winrate.rawWinrate, 4),
    sampleBayesianWinrate: round(item.winrate.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(item.winrate.wilsonLowerBound, 4),
    sampleReliability: round(item.winrate.reliability, 4),

    dashboardBalancedScore: round(item.dashboardBalancedScore, 4)
  }));
}

function normalizeMicroRow(row = {}, index = 0, activeSet = new Set()) {
  const microFamilyId = row.microFamilyId || row.id || row.key || null;

  const fairWinrate = num(
    row.fairWinrate ??
    row.bayesianWinrate ??
    row.wilsonLowerBound,
    0
  );

  const winrateMeta = getSampleAdjustedWinrate(row);

  return {
    ...row,

    rank: index + 1,

    microFamilyId,
    familyId: row.familyId || row.family || null,
    side: normalizeDashboardSide(row.side),

    active: microFamilyId ? activeSet.has(microFamilyId) : false,

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
    fairWinrate: round(fairWinrate, 4),

    winrateSample: round(row.winrateSample ?? winrateMeta.sample, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrateMeta.score, 4),
    sampleRawWinrate: round(row.sampleRawWinrate ?? winrateMeta.rawWinrate, 4),
    sampleBayesianWinrate: round(row.sampleBayesianWinrate ?? winrateMeta.bayesianWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? winrateMeta.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability ?? winrateMeta.reliability, 4),

    totalR: round(row.totalR, 4),
    realTotalR: round(row.realTotalR, 4),
    shadowTotalR: round(row.shadowTotalR, 4),

    grossWinR: round(row.grossWinR, 4),
    grossLossR: round(row.grossLossR, 4),

    avgR: round(row.avgR, 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    totalPnlPct: round(row.totalPnlPct, 4),
    avgPnlPct: round(row.avgPnlPct, 4),

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

    sampleReliabilityOld: round(row.sampleReliability, 4),
    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? getDashboardBalancedScore(row), 4),

    definition: row.definition || null,
    definitionParts: Array.isArray(row.definitionParts) ? row.definitionParts : [],

    counters: row.counters || {},
    examples: Array.isArray(row.examples) ? row.examples : [],
    recentOutcomes: Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [],

    updatedAt: row.updatedAt || null
  };
}

function compactBestRow(row) {
  if (!row) return null;

  return {
    microFamilyId: row.microFamilyId,
    familyId: row.familyId,
    side: row.side,
    active: Boolean(row.active),

    seen: row.seen,
    completed: row.completed,
    realCompleted: row.realCompleted,
    shadowCompleted: row.shadowCompleted,

    winrateSample: row.winrateSample,
    winrate: row.winrate,
    fairWinrate: row.fairWinrate,
    sampleAdjustedWinrate: row.sampleAdjustedWinrate,
    sampleWilsonLowerBound: row.sampleWilsonLowerBound,
    sampleReliability: row.sampleReliability,

    avgR: row.avgR,
    totalR: row.totalR,
    profitFactor: row.profitFactor,

    directSLPct: row.directSLPct,
    avgCostR: row.avgCostR,

    balancedScore: row.balancedScore,
    dashboardBalancedScore: row.dashboardBalancedScore
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

function buildSummary(rows, activeSet) {
  const completedRows = rows.filter((row) => num(row.completed, 0) > 0);
  const tradableRows = rows.filter((row) => num(row.winrateSample, 0) >= 5);
  const activeRows = rows.filter((row) => activeSet.has(row.microFamilyId));

  const totalR = rows.reduce((sum, row) => sum + num(row.totalR, 0), 0);
  const totalSeen = rows.reduce((sum, row) => sum + num(row.seen, 0), 0);
  const totalCompleted = rows.reduce((sum, row) => sum + num(row.completed, 0), 0);
  const totalWinrateSample = rows.reduce((sum, row) => sum + num(row.winrateSample, 0), 0);
  const totalCostR = rows.reduce((sum, row) => sum + num(row.totalCostR, 0), 0);

  const bestBalanced = [...rows].sort(compareNormalizedBalanced)[0] || null;

  const bestTotalR = [...rows].sort((a, b) => {
    return (
      compareNumberDesc(a.totalR, b.totalR) ||
      compareNormalizedWinrate(a, b)
    );
  })[0] || null;

  const bestWinrate = [...rows].sort(compareNormalizedWinrate)[0] || null;

  const lowestDirectSL = [...rows].sort((a, b) => {
    return (
      compareNumberAsc(a.directSLPct, b.directSLPct) ||
      compareNumberDesc(a.winrateSample, b.winrateSample) ||
      compareNormalizedWinrate(a, b)
    );
  })[0] || null;

  return {
    rows: rows.length,
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
    bestWinrate: compactBestRow(bestWinrate),
    lowestDirectSL: compactBestRow(lowestDirectSL)
  };
}

function extractActiveIds(activeRotation) {
  if (!activeRotation) return [];

  if (Array.isArray(activeRotation.microFamilyIds)) {
    return activeRotation.microFamilyIds.filter(Boolean);
  }

  if (Array.isArray(activeRotation.activeMicroFamilyIds)) {
    return activeRotation.activeMicroFamilyIds.filter(Boolean);
  }

  if (Array.isArray(activeRotation.ids)) {
    return activeRotation.ids.filter(Boolean);
  }

  if (Array.isArray(activeRotation.microFamilies)) {
    return activeRotation.microFamilies
      .map((row) => row.microFamilyId)
      .filter(Boolean);
  }

  return [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const currentWeekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    const requestedWeekKey = firstQueryValue(req.query?.weekKey, currentWeekKey);
    const requestedMode = firstQueryValue(req.query?.mode, 'balanced');

    const mode = VALID_MODES.has(requestedMode)
      ? requestedMode
      : 'balanced';

    const limit = toSafeLimit(
      firstQueryValue(req.query?.limit, 200),
      200
    );

    const [micros, activeRotation] = await Promise.all([
      getWeekMicros(requestedWeekKey),
      getActiveRotation()
    ]);

    const activeMicroFamilyIds = extractActiveIds(activeRotation);
    const activeSet = new Set(activeMicroFamilyIds);

    const baseRankedRows = rankMicros(micros || {}, mode);
    const rankedRows = applyDashboardRanking(baseRankedRows, mode);

    const normalizedRows = rankedRows
      .slice(0, limit)
      .map((row, index) => normalizeMicroRow(row, index, activeSet));

    const summary = buildSummary(normalizedRows, activeSet);

    return res.status(200).json({
      ok: true,

      weekKey: requestedWeekKey,
      currentWeekKey,
      previousWeekKey,

      mode,
      requestedMode,
      limit,

      count: normalizedRows.length,
      totalAvailable: rankedRows.length,

      activeRotationId: activeRotation?.rotationId || null,
      activeRotation,
      activeMicroFamilyIds,

      summary,

      rows: normalizedRows,

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