// ================= FILE: src/analyze/analyzeEngine.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { classifyMicroFamily } from './microFamilies.js';
import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats
} from './scoring.js';
import { applyCosts } from '../trade/costModel.js';

function now() {
  return Date.now();
}

function normalizeSource(source) {
  return String(source || 'REAL').toUpperCase();
}

function isLongSide(side) {
  return sideToTradeSide(side) === 'LONG';
}

function getOrCreateMicro(micros, classified, side) {
  const microFamilyId = classified.microFamilyId;
  const familyId = classified.familyId;

  if (!microFamilyId) {
    throw new Error('MICRO_FAMILY_ID_MISSING');
  }

  if (!familyId) {
    throw new Error('FAMILY_ID_MISSING');
  }

  if (!micros[microFamilyId]) {
    micros[microFamilyId] = createMicroStats({
      microFamilyId,
      familyId,
      side,
      definitionParts: classified.definitionParts || []
    });
  }

  const micro = micros[microFamilyId];

  micro.microFamilyId ||= microFamilyId;
  micro.familyId ||= familyId;
  micro.side ||= side;
  micro.definitionParts ||= classified.definitionParts || [];
  micro.definition ||= micro.definitionParts.join(' | ');

  return micro;
}

function normalizeMicros(micros = {}) {
  return Object.fromEntries(
    Object.entries(micros || {})
      .filter(([id, row]) => id && row)
      .map(([id, row]) => [id, refreshStats(row)])
  );
}

export async function getWeekMicros(weekKey = getIsoWeekKey()) {
  const redis = getDurableRedis();
  return await getJson(redis, KEYS.analyze.weekMicros(weekKey), {});
}

export async function saveWeekMicros(weekKey, micros) {
  if (!weekKey) {
    throw new Error('WEEK_KEY_MISSING');
  }

  const redis = getDurableRedis();
  const clean = normalizeMicros(micros);

  await setJson(redis, KEYS.analyze.weekMicros(weekKey), clean);

  await setJson(redis, KEYS.analyze.weekMeta(weekKey), {
    weekKey,
    updatedAt: now(),
    microFamilies: Object.keys(clean).length,
    schema: CONFIG.analyze.schema,
    strategyVersion: CONFIG.strategyVersion
  });

  return clean;
}

export async function analyzeCandidatesBatch(
  metricsRows = [],
  { weekKey = getIsoWeekKey() } = {}
) {
  const rows = Array.isArray(metricsRows) ? metricsRows.filter(Boolean) : [];

  if (rows.length === 0) {
    return [];
  }

  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);
  const analyzed = [];

  for (const metrics of rows) {
    const classified = classifyMicroFamily(metrics);

    const obsKey = KEYS.analyze.obsLast(
      metrics.snapshotId || 'NO_SNAPSHOT',
      metrics.symbol || metrics.contractSymbol || 'UNKNOWN',
      classified.microFamilyId
    );

    const firstObservation = await redis.set(obsKey, '1', {
      nx: true,
      ex: CONFIG.analyze.obsDedupeTtlSec
    });

    const micro = getOrCreateMicro(micros, classified, metrics.side);

    if (firstObservation) {
      updateObservation(micro, {
        ...metrics,
        ...classified,
        weekKey,
        strategyVersion: CONFIG.strategyVersion,
        createdAt: metrics.createdAt || now()
      });
    }

    analyzed.push({
      ...metrics,
      ...classified,
      analysisType: 'OBSERVATION',
      observationRecorded: Boolean(firstObservation),
      weekKey,
      strategyVersion: CONFIG.strategyVersion
    });
  }

  await saveWeekMicros(weekKey, micros);

  return analyzed;
}

export async function recordOutcome(
  outcome = {},
  {
    source = outcome.source || 'REAL',
    weekKey = getIsoWeekKey(outcome.closedAt || outcome.completedAt || now())
  } = {}
) {
  const src = normalizeSource(source);

  let row = {
    ...outcome,
    source: src,
    weekKey,
    strategyVersion: CONFIG.strategyVersion
  };

  if (!row.microFamilyId || !row.familyId) {
    const classified = classifyMicroFamily(row);

    row = {
      ...row,
      familyId: row.familyId || classified.familyId,
      microFamilyId: row.microFamilyId || classified.microFamilyId,
      definitionParts: row.definitionParts || classified.definitionParts,
      definition: row.definition || classified.definition,
      obRelation: row.obRelation || classified.obRelation
    };
  }

  const micros = await getWeekMicros(weekKey);

  const micro = getOrCreateMicro(
    micros,
    {
      microFamilyId: row.microFamilyId,
      familyId: row.familyId,
      definitionParts: row.definitionParts || []
    },
    row.side
  );

  updateOutcome(micro, row, src);

  await saveWeekMicros(weekKey, micros);

  return {
    ...row,
    source: src,
    weekKey,
    recordedAt: now()
  };
}

export async function createShadowPosition(metrics = {}) {
  if (!CONFIG.analyze.shadowEnabled) {
    return {
      ok: false,
      skipped: true,
      reason: 'SHADOW_DISABLED'
    };
  }

  if (!metrics.microFamilyId) {
    return {
      ok: false,
      skipped: true,
      reason: 'MICRO_MISSING'
    };
  }

  if (!metrics.entry || !metrics.sl || !metrics.tp) {
    return {
      ok: false,
      skipped: true,
      reason: 'RISK_MISSING'
    };
  }

  const redis = getDurableRedis();

  const dedupeKey = KEYS.analyze.shadowLast(
    metrics.symbol || metrics.contractSymbol || 'UNKNOWN',
    metrics.microFamilyId
  );

  const first = await redis.set(dedupeKey, '1', {
    nx: true,
    ex: CONFIG.analyze.shadowDedupeTtlSec
  });

  if (!first) {
    return {
      ok: false,
      skipped: true,
      reason: 'SHADOW_DEDUPED'
    };
  }

  const id = randomId('shadow');
  const createdAt = now();

  const row = {
    ...metrics,

    id,
    source: 'SHADOW',
    status: 'OPEN',

    strategyVersion: CONFIG.strategyVersion,

    createdAt,
    monitorUntil: createdAt + CONFIG.analyze.shadowHorizonMin * 60 * 1000,

    ticks: 0,
    maxPnlPct: 0,
    minPnlPct: 0,
    mfeR: 0,
    maeR: 0,

    beArmed: false,
    beWouldExit: false,
    beExitR: 0,
    gaveBackAfterHalfR: false,
    gaveBackAfterOneR: false,
    nearTpThenLoss: false
  };

  await setJson(
    redis,
    KEYS.analyze.shadowOpen(id),
    row,
    {
      ex: Math.ceil(CONFIG.analyze.shadowHorizonMin * 60 * 1.2)
    }
  );

  return {
    ok: true,
    shadowId: id
  };
}

function calcGrossMovePct({ side, entry, exit }) {
  if (entry <= 0 || exit <= 0) return 0;

  return isLongSide(side)
    ? (exit - entry) / entry
    : (entry - exit) / entry;
}

function calcRiskPct({ entry, sl }) {
  if (entry <= 0 || sl <= 0) return 0;

  return Math.abs(entry - sl) / entry;
}

function inferDirectToSL({ position, exitReason }) {
  const reason = String(exitReason || '').toUpperCase();

  const mfeR = safeNumber(position.mfeR, 0);
  const maeR = safeNumber(position.maeR, 0);

  return Boolean(position.directToSL) ||
    (
      reason === 'SL' &&
      mfeR < 0.25 &&
      maeR <= -0.8
    );
}

export function buildOutcomeFromPosition({
  position,
  exitPrice,
  exitReason,
  source = 'REAL'
}) {
  if (!position) {
    throw new Error('POSITION_REQUIRED_FOR_OUTCOME');
  }

  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const exit = safeNumber(exitPrice, 0);

  const riskPct =
    safeNumber(position.riskPct, 0) ||
    calcRiskPct({
      entry,
      sl: initialSl
    });

  const grossMovePct = calcGrossMovePct({
    side: position.side,
    entry,
    exit
  });

  const cost = applyCosts({
    grossMovePct,
    riskPct,
    entrySpreadPct: safeNumber(position.spreadPct, 0),
    exitSpreadPct: safeNumber(position.exitSpreadPct ?? position.spreadPct, 0)
  });

  const closedAt = now();

  return {
    type: 'OUTCOME',
    source: normalizeSource(source),
    strategyVersion: CONFIG.strategyVersion,

    tradeId: position.tradeId,
    symbol: position.symbol,
    contractSymbol: position.contractSymbol,
    side: position.side,

    familyId: position.familyId,
    microFamilyId: position.microFamilyId,
    definitionParts: position.definitionParts || [],

    entry,
    exit,
    sl: safeNumber(position.sl, 0),
    initialSl,
    tp: safeNumber(position.tp, 0),
    rr: safeNumber(position.rr, 0),
    riskPct,

    exitReason,

    grossR: cost.grossR,
    grossPnlPct: cost.grossPnlPct,

    exitR: cost.netR,
    pnlPct: cost.netPnlPct,
    netR: cost.netR,
    netPnlPct: cost.netPnlPct,

    costR: cost.costR,
    costPct: cost.costPct,
    feePct: cost.feePct,
    slippagePct: cost.slippagePct,

    mfeR: safeNumber(position.mfeR, 0),
    maeR: safeNumber(position.maeR, 0),

    directToSL: inferDirectToSL({
      position,
      exitReason
    }),

    nearTpSeen: Boolean(position.nearTpSeen),
    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: safeNumber(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    openedAt: position.openedAt || position.createdAt || null,
    closedAt
  };
}