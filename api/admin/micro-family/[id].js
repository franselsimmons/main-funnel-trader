// ================= FILE: api/admin/micro-family/[id].js =================

import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  sideToTradeSide,
  safeNumber
} from '../../../src/utils.js';
import { getWeekMicros } from '../../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../../src/analyze/rotationEngine.js';

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

function normalizeMicroRow(id, row = {}, activeSet = new Set()) {
  const microFamilyId = row.microFamilyId || row.id || row.key || id;

  return {
    ...row,

    microFamilyId,
    familyId: row.familyId || row.family || null,
    side: normalizeDashboardSide(row.side),

    active: activeSet.has(microFamilyId),

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
    fairWinrate: round(
      row.fairWinrate ??
      row.bayesianWinrate ??
      row.wilsonLowerBound,
      4
    ),

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
    definitionParts: Array.isArray(row.definitionParts)
      ? row.definitionParts
      : Array.isArray(row.definition)
        ? row.definition
        : [],

    counters: row.counters || {},
    examples: Array.isArray(row.examples) ? row.examples : [],
    recentOutcomes: Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [],

    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function buildDetailSummary(row) {
  return {
    microFamilyId: row.microFamilyId,
    familyId: row.familyId,
    side: row.side,
    active: row.active,

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
    nearTpPct: row.nearTpPct,

    reachedHalfRPct: row.reachedHalfRPct,
    reachedOneRPct: row.reachedOneRPct,

    beWouldExitPct: row.beWouldExitPct,
    gaveBackAfterHalfRPct: row.gaveBackAfterHalfRPct,
    gaveBackAfterOneRPct: row.gaveBackAfterOneRPct,
    nearTpThenLossPct: row.nearTpThenLossPct,

    avgCostR: row.avgCostR,
    balancedScore: row.balancedScore
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const id = firstQueryValue(req.query?.id, null);
    const weekKey = firstQueryValue(req.query?.weekKey, getIsoWeekKey());

    const currentWeekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: 'MICRO_FAMILY_ID_REQUIRED'
      });
    }

    const [micros, activeRotation] = await Promise.all([
      getWeekMicros(weekKey),
      getActiveRotation()
    ]);

    const activeIds = extractActiveIds(activeRotation);
    const activeSet = new Set(activeIds);

    const rawRow = micros?.[id] || null;

    if (!rawRow) {
      return res.status(404).json({
        ok: false,
        reason: 'MICRO_FAMILY_NOT_FOUND',
        id,
        weekKey,
        currentWeekKey,
        previousWeekKey,
        availableCount: Object.keys(micros || {}).length,
        activeRotationId: activeRotation?.rotationId || null
      });
    }

    const row = normalizeMicroRow(id, rawRow, activeSet);

    return res.status(200).json({
      ok: true,

      id,
      weekKey,
      currentWeekKey,
      previousWeekKey,

      activeRotationId: activeRotation?.rotationId || null,
      active: row.active,

      summary: buildDetailSummary(row),
      row,

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