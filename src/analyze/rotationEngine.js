// ================= FILE: src/analyze/rotationEngine.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { getWeekMicros, saveWeekMicros } from './analyzeEngine.js';
import { rankMicros, refreshStats } from './scoring.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';

function now() {
  return Date.now();
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function minWeightedCompleted() {
  return safeNumber(CONFIG.rotation?.minWeightedCompleted, 5);
}

function topNPerSide() {
  const n = Number(CONFIG.rotation?.topNPerSide || 10);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 10;
}

function defaultRotationMode() {
  return CONFIG.rotation?.mode || 'balanced';
}

function microSide(row = {}) {
  const direct = sideToTradeSide(row.side);

  if (direct !== 'UNKNOWN') return direct;

  const familyId = String(row.familyId || '').toUpperCase();

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  const microId = String(row.microFamilyId || '').toUpperCase();

  if (microId.includes('MICRO_LONG_')) return 'LONG';
  if (microId.includes('MICRO_SHORT_')) return 'SHORT';

  return 'UNKNOWN';
}

function isEligible(row = {}) {
  return safeNumber(row.completed, 0) >= minWeightedCompleted();
}

function compactRotationRow(row = {}, rank = 0) {
  const refreshed = refreshStats(row);
  const side = refreshed.side || (
    microSide(refreshed) === 'LONG'
      ? 'bull'
      : microSide(refreshed) === 'SHORT'
        ? 'bear'
        : 'unknown'
  );

  return {
    rank,

    microFamilyId: refreshed.microFamilyId,
    familyId: refreshed.familyId,
    side,

    seen: safeNumber(refreshed.seen, 0),
    completed: safeNumber(refreshed.completed, 0),
    realCompleted: safeNumber(refreshed.realCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    winrate: safeNumber(refreshed.winrate, 0),
    bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
    wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
    fairWinrate: safeNumber(refreshed.fairWinrate, 0),

    avgR: safeNumber(refreshed.avgR, 0),
    totalR: safeNumber(refreshed.totalR, 0),
    avgWinR: safeNumber(refreshed.avgWinR, 0),
    avgLossR: safeNumber(refreshed.avgLossR, 0),

    profitFactor: safeNumber(refreshed.profitFactor, 0),
    directSLPct: safeNumber(refreshed.directSLPct, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),

    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),

    avgCostR: safeNumber(refreshed.avgCostR, 0),
    balancedScore: safeNumber(refreshed.balancedScore, 0),

    definitionParts: Array.isArray(refreshed.definitionParts)
      ? refreshed.definitionParts
      : [],

    definition: refreshed.definition || ''
  };
}

function selectTopPerSide(ranked, topN) {
  const safeTopN = Math.max(1, Number(topN) || 10);

  const longs = ranked
    .filter((row) => microSide(row) === 'LONG')
    .slice(0, safeTopN);

  const shorts = ranked
    .filter((row) => microSide(row) === 'SHORT')
    .slice(0, safeTopN);

  return [...longs, ...shorts];
}

function buildRankings(micros) {
  return {
    balanced: rankMicros(micros, 'balanced').slice(0, 50),
    winrate: rankMicros(micros, 'winrate').slice(0, 50),
    totalR: rankMicros(micros, 'totalR').slice(0, 50),
    avgR: rankMicros(micros, 'avgR').slice(0, 50),
    directSL: rankMicros(micros, 'directSL').slice(0, 50),
    observed: rankMicros(micros, 'observed').slice(0, 50)
  };
}

function buildEmptyRotation({
  weekKey,
  activeWeekKey,
  mode,
  micros,
  ranked
}) {
  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}`),
    source: 'ANALYZE_WEEKLY_RANKING',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),

    eligibleCount: 0,
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,

    empty: true,
    emptyReason: 'NO_MICRO_FAMILIES_MET_MIN_WEIGHTED_COMPLETED',

    microFamilyIds: [],
    microFamilies: [],

    rankings: buildRankings(micros)
  };
}

export async function buildRotationFromWeek({
  weekKey = getIsoWeekKey(),
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const micros = await getWeekMicros(weekKey);

  const ranked = rankMicros(micros, mode);
  const eligible = ranked.filter(isEligible);
  const selected = selectTopPerSide(eligible, topNPerSide());

  if (selected.length === 0) {
    return buildEmptyRotation({
      weekKey,
      activeWeekKey,
      mode,
      micros,
      ranked
    });
  }

  const microFamilies = selected.map((row, index) => (
    compactRotationRow(row, index + 1)
  ));

  const microFamilyIds = uniqueStrings(
    microFamilies.map((row) => row.microFamilyId)
  );

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}`),
    source: 'ANALYZE_WEEKLY_RANKING',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),

    eligibleCount: eligible.length,
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,

    empty: false,
    emptyReason: null,

    microFamilyIds,
    microFamilies,

    rankings: buildRankings(micros)
  };
}

export async function freezeWeeklyRotation({
  weekKey = getIsoWeekKey(),
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const redis = getDurableRedis();

  const micros = await getWeekMicros(weekKey);

  // Force refresh current week stats before building next rotation.
  await saveWeekMicros(weekKey, micros);

  const rotation = await buildRotationFromWeek({
    weekKey,
    activeWeekKey,
    mode
  });

  await setJson(
    redis,
    KEYS.analyze.nextRotation,
    rotation
  );

  await setJson(
    redis,
    KEYS.analyze.rotationValidFrom,
    {
      validFrom: `${activeWeekKey}_MONDAY_00_UTC`,
      ts: now(),
      sourceWeekKey: weekKey,
      activeWeekKey,
      rotationId: rotation.rotationId
    }
  );

  await sendWeeklyRotationReport(
    rotation,
    'NEXT_ROTATION_READY'
  ).catch(() => null);

  return {
    ok: true,
    type: 'NEXT_ROTATION_READY',
    weekKey,
    activeWeekKey,
    mode,
    rotationId: rotation.rotationId,
    selectedMicroFamilies: rotation.microFamilyIds.length,
    rotation
  };
}

export async function activateNextRotation() {
  const redis = getDurableRedis();

  const next = await getJson(
    redis,
    KEYS.analyze.nextRotation,
    null
  );

  if (!next) {
    return {
      ok: false,
      reason: 'NEXT_ROTATION_MISSING'
    };
  }

  const active = {
    ...next,
    source: 'ANALYZE_NEXT_ROTATION_ACTIVATED',
    activatedAt: now()
  };

  await setJson(
    redis,
    KEYS.analyze.activeRotation,
    active
  );

  await sendWeeklyRotationReport(
    active,
    'ACTIVE_ROTATION_ACTIVATED'
  ).catch(() => null);

  return {
    ok: true,
    activeRotation: active,
    rotationId: active.rotationId,
    activatedCount: active.microFamilyIds?.length || 0
  };
}

export async function getActiveRotation() {
  const redis = getDurableRedis();

  return await getJson(
    redis,
    KEYS.analyze.activeRotation,
    null
  );
}

export async function getActiveRotationSet() {
  const active = await getActiveRotation();

  return new Set(active?.microFamilyIds || []);
}

export async function activateSelectedMicroFamilies({
  microFamilyIds = [],
  weekKey = getIsoWeekKey(),
  mode = 'manual'
} = {}) {
  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);

  const ids = uniqueStrings(microFamilyIds);

  const microFamilies = ids.map((id, index) => {
    const row = micros[id];

    if (row) {
      return compactRotationRow(row, index + 1);
    }

    return {
      rank: index + 1,
      microFamilyId: id,
      familyId: null,
      side: null,

      seen: 0,
      completed: 0,
      realCompleted: 0,
      shadowCompleted: 0,

      winrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      fairWinrate: 0,

      avgR: 0,
      totalR: 0,
      avgWinR: 0,
      avgLossR: 0,

      profitFactor: 0,
      directSLPct: 0,
      nearTpPct: 0,
      reachedOneRPct: 0,
      avgCostR: 0,

      balancedScore: 0,

      definitionParts: [],
      definition: '',

      manualOnly: true
    };
  });

  const active = {
    rotationId: randomId(`ROT_${weekKey}_manual`),
    source: 'ADMIN_MANUAL_SELECTION',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey: getIsoWeekKey(),

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    empty: ids.length === 0,
    emptyReason: ids.length === 0 ? 'NO_MANUAL_IDS_SELECTED' : null,

    microFamilyIds: ids,
    microFamilies
  };

  await setJson(
    redis,
    KEYS.analyze.activeRotation,
    active
  );

  return active;
}

export async function getRotationDashboard() {
  const redis = getDurableRedis();

  const [active, next, validFrom] = await Promise.all([
    getJson(redis, KEYS.analyze.activeRotation, null),
    getJson(redis, KEYS.analyze.nextRotation, null),
    getJson(redis, KEYS.analyze.rotationValidFrom, null)
  ]);

  return {
    active,
    next,
    validFrom,

    activeRows: active?.microFamilies || [],
    nextRows: next?.microFamilies || [],

    activeCount: active?.microFamilyIds?.length || 0,
    nextCount: next?.microFamilyIds?.length || 0
  };
}