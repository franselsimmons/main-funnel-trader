// ================= FILE: api/admin/micro-families.js =================

import { getIsoWeekKey, getPreviousIsoWeekKey } from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/src/analyzeEngine.js';
import { rankMicros } from '../../src/analyze/src/scoring.js';
import { getActiveRotation } from '../../src/analyze/src/rotationEngine.js';

const VALID_MODES = new Set([
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

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

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSide(side) {
  const value = String(side || '').toLowerCase();

  if (value === 'bull' || value === 'long' || value === 'buy') return 'bull';
  if (value === 'bear' || value === 'short' || value === 'sell') return 'bear';

  return value || 'unknown';
}

function normalizeMicroRow(row, index, activeSet) {
  const microFamilyId = row.microFamilyId || row.id || row.key || null;

  return {
    ...row,

    rank: row.rank ?? index + 1,

    microFamilyId,
    familyId: row.familyId || row.family || null,
    side: normalizeSide(row.side),

    active: microFamilyId ? activeSet.has(microFamilyId) : false,

    seen: toNumber(row.seen),
    completed: toNumber(row.completed),
    realCompleted: toNumber(row.realCompleted),
    shadowCompleted: toNumber(row.shadowCompleted),

    wins: toNumber(row.wins),
    losses: toNumber(row.losses),
    flats: toNumber(row.flats),

    winrate: toNumber(row.winrate),
    bayesianWinrate: toNumber(row.bayesianWinrate),
    wilsonLowerBound: toNumber(row.wilsonLowerBound),
    fairWinrate: toNumber(
      row.fairWinrate ??
      row.bayesianWinrate ??
      row.wilsonLowerBound
    ),

    totalR: toNumber(row.totalR),
    avgR: toNumber(row.avgR),
    avgWinR: toNumber(row.avgWinR),
    avgLossR: toNumber(row.avgLossR),

    totalPnlPct: toNumber(row.totalPnlPct),
    avgPnlPct: toNumber(row.avgPnlPct),

    profitFactor: toNumber(row.profitFactor),
    directSLPct: toNumber(row.directSLPct),
    nearTpPct: toNumber(row.nearTpPct),

    avgCostR: toNumber(row.avgCostR),
    balancedScore: toNumber(row.balancedScore),

    definition: row.definition || null,
    definitionParts: Array.isArray(row.definitionParts) ? row.definitionParts : []
  };
}

function buildSummary(rows, activeSet) {
  const completedRows = rows.filter((row) => toNumber(row.completed) > 0);
  const tradableRows = rows.filter((row) => toNumber(row.completed) >= 5);
  const activeRows = rows.filter((row) => activeSet.has(row.microFamilyId));

  const totalR = rows.reduce((sum, row) => sum + toNumber(row.totalR), 0);
  const totalSeen = rows.reduce((sum, row) => sum + toNumber(row.seen), 0);
  const totalCompleted = rows.reduce((sum, row) => sum + toNumber(row.completed), 0);

  const bestBalanced = [...rows].sort((a, b) => {
    return toNumber(b.balancedScore) - toNumber(a.balancedScore);
  })[0] || null;

  const bestTotalR = [...rows].sort((a, b) => {
    return toNumber(b.totalR) - toNumber(a.totalR);
  })[0] || null;

  const bestWinrate = [...rows].sort((a, b) => {
    return toNumber(b.fairWinrate) - toNumber(a.fairWinrate);
  })[0] || null;

  return {
    rows: rows.length,
    activeRows: activeRows.length,
    activeIds: activeSet.size,

    seen: totalSeen,
    completed: totalCompleted,

    completedMicroFamilies: completedRows.length,
    tradableMicroFamilies: tradableRows.length,

    totalR,

    bestBalanced: bestBalanced
      ? {
          microFamilyId: bestBalanced.microFamilyId,
          familyId: bestBalanced.familyId,
          side: bestBalanced.side,
          balancedScore: bestBalanced.balancedScore,
          completed: bestBalanced.completed,
          fairWinrate: bestBalanced.fairWinrate,
          avgR: bestBalanced.avgR,
          totalR: bestBalanced.totalR
        }
      : null,

    bestTotalR: bestTotalR
      ? {
          microFamilyId: bestTotalR.microFamilyId,
          familyId: bestTotalR.familyId,
          side: bestTotalR.side,
          totalR: bestTotalR.totalR,
          completed: bestTotalR.completed,
          fairWinrate: bestTotalR.fairWinrate,
          avgR: bestTotalR.avgR,
          balancedScore: bestTotalR.balancedScore
        }
      : null,

    bestWinrate: bestWinrate
      ? {
          microFamilyId: bestWinrate.microFamilyId,
          familyId: bestWinrate.familyId,
          side: bestWinrate.side,
          fairWinrate: bestWinrate.fairWinrate,
          completed: bestWinrate.completed,
          avgR: bestWinrate.avgR,
          totalR: bestWinrate.totalR,
          balancedScore: bestWinrate.balancedScore
        }
      : null
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

  return [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      allowed: ['GET']
    });
  }

  try {
    const currentWeekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    const requestedWeekKey = firstQueryValue(req.query?.weekKey, currentWeekKey);
    const requestedMode = firstQueryValue(req.query?.mode, 'balanced');
    const mode = VALID_MODES.has(requestedMode) ? requestedMode : 'balanced';
    const limit = toSafeLimit(firstQueryValue(req.query?.limit, 200), 200);

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
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}