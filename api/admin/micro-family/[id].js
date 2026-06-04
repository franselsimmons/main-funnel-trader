// ================= FILE: api/admin/micro-family/[id].js =================

import { getIsoWeekKey, getPreviousIsoWeekKey } from '../../../src/utils.js';
import { getWeekMicros } from '../../../src/analyze/src/analyzeEngine.js';
import { getActiveRotation } from '../../../src/analyze/src/rotationEngine.js';

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;
  return value;
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

function normalizeMicroRow(id, row, activeSet) {
  const microFamilyId = row?.microFamilyId || row?.id || row?.key || id;

  return {
    ...row,

    microFamilyId,
    familyId: row?.familyId || row?.family || null,
    side: normalizeSide(row?.side),

    active: activeSet.has(microFamilyId),

    seen: toNumber(row?.seen),
    completed: toNumber(row?.completed),
    realCompleted: toNumber(row?.realCompleted),
    shadowCompleted: toNumber(row?.shadowCompleted),

    wins: toNumber(row?.wins),
    losses: toNumber(row?.losses),
    flats: toNumber(row?.flats),

    winrate: toNumber(row?.winrate),
    bayesianWinrate: toNumber(row?.bayesianWinrate),
    wilsonLowerBound: toNumber(row?.wilsonLowerBound),
    fairWinrate: toNumber(
      row?.fairWinrate ??
      row?.bayesianWinrate ??
      row?.wilsonLowerBound
    ),

    totalR: toNumber(row?.totalR),
    avgR: toNumber(row?.avgR),
    avgWinR: toNumber(row?.avgWinR),
    avgLossR: toNumber(row?.avgLossR),

    totalPnlPct: toNumber(row?.totalPnlPct),
    avgPnlPct: toNumber(row?.avgPnlPct),

    profitFactor: toNumber(row?.profitFactor),
    directSLPct: toNumber(row?.directSLPct),
    nearTpPct: toNumber(row?.nearTpPct),

    directSLCount: toNumber(row?.directSLCount),
    nearTpCount: toNumber(row?.nearTpCount),

    reachedHalfRCount: toNumber(row?.reachedHalfRCount),
    reachedOneRCount: toNumber(row?.reachedOneRCount),

    avgCostR: toNumber(row?.avgCostR),
    balancedScore: toNumber(row?.balancedScore),

    definition: row?.definition || null,
    definitionParts: Array.isArray(row?.definitionParts)
      ? row.definitionParts
      : Array.isArray(row?.definition)
        ? row.definition
        : []
  };
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
        availableCount: Object.keys(micros || {}).length
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

      row,

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