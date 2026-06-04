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

function normalizeDashboardSide(side) {
  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
}

function normalizeMicroRow(row = {}, index = 0, activeSet = new Set()) {
  const microFamilyId = row.microFamilyId || row.id || row.key || null;
  const fairWinrate = num(
    row.fairWinrate ??
    row.bayesianWinrate ??
    row.wilsonLowerBound,
    0
  );

  return {
    ...row,

    rank: row.rank ?? index + 1,

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
    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),

    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(fairWinrate, 4),

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

    sampleReliability: round(row.sampleReliability, 4),
    balancedScore: round(row.balancedScore, 4),

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

    fairWinrate: row.fairWinrate,
    winrate: row.winrate,

    avgR: row.avgR,
    totalR: row.totalR,
    profitFactor: row.profitFactor,

    directSLPct: row.directSLPct,
    avgCostR: row.avgCostR,

    balancedScore: row.balancedScore
  };
}

function buildSummary(rows, activeSet) {
  const completedRows = rows.filter((row) => num(row.completed, 0) > 0);
  const tradableRows = rows.filter((row) => num(row.completed, 0) >= 5);
  const activeRows = rows.filter((row) => activeSet.has(row.microFamilyId));

  const totalR = rows.reduce((sum, row) => sum + num(row.totalR, 0), 0);
  const totalSeen = rows.reduce((sum, row) => sum + num(row.seen, 0), 0);
  const totalCompleted = rows.reduce((sum, row) => sum + num(row.completed, 0), 0);
  const totalCostR = rows.reduce((sum, row) => sum + num(row.totalCostR, 0), 0);

  const bestBalanced = [...rows].sort((a, b) => {
    return num(b.balancedScore, 0) - num(a.balancedScore, 0);
  })[0] || null;

  const bestTotalR = [...rows].sort((a, b) => {
    return num(b.totalR, 0) - num(a.totalR, 0);
  })[0] || null;

  const bestWinrate = [...rows].sort((a, b) => {
    return (
      num(b.fairWinrate, 0) - num(a.fairWinrate, 0) ||
      num(b.completed, 0) - num(a.completed, 0)
    );
  })[0] || null;

  const lowestDirectSL = [...rows].sort((a, b) => {
    return (
      num(a.directSLPct, 0) - num(b.directSLPct, 0) ||
      num(b.completed, 0) - num(a.completed, 0)
    );
  })[0] || null;

  return {
    rows: rows.length,
    activeRows: activeRows.length,
    activeIds: activeSet.size,

    seen: round(totalSeen, 4),
    completed: round(totalCompleted, 4),

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

    const rankedRows = rankMicros(micros || {}, mode);

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