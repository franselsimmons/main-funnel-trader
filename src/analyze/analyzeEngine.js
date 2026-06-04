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
import {
  classifyMicroFamily,
  classifyMacroFamily,
  isMicroFamilyV1Id,
  isMicroFamilyV2Id
} from './microFamilies.js';
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

function getAnalyzeSchemaMeta() {
  return {
    schema: CONFIG?.analyze?.schema,
    macroSchema: CONFIG?.analyze?.macroSchema || CONFIG?.analyze?.schema || 'MF_V1',
    microSchema: CONFIG?.analyze?.microSchema || 'MF_V2',
    strategyVersion: CONFIG.strategyVersion
  };
}

function normalizeStatsSide(side, classified = {}) {
  if (classified.side) return classified.side;

  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return String(side || 'unknown').toLowerCase();
}

function hasUsableDefinitionParts(value) {
  return Array.isArray(value) && value.length > 0;
}

function shouldReclassifyAsTrueMicro(row = {}) {
  if (!row.microFamilyId || !row.familyId) return true;

  if (isMicroFamilyV1Id(row.microFamilyId)) return true;

  if (isMicroFamilyV2Id(row.microFamilyId)) return false;

  return !row.parentMacroFamilyId && !row.macroFamilyId;
}

function enrichWithMicroFamily(row = {}) {
  const classified = classifyMicroFamily(row);
  const macro = classifyMacroFamily(row);

  if (shouldReclassifyAsTrueMicro(row)) {
    return {
      ...row,

      familyId: classified.familyId,
      microFamilyId: classified.microFamilyId,

      macroFamilyId: classified.macroFamilyId || macro.microFamilyId,
      parentMacroFamilyId: classified.parentMacroFamilyId || macro.microFamilyId,
      parentMicroFamilyId: classified.parentMicroFamilyId || macro.microFamilyId,

      definitionParts: hasUsableDefinitionParts(row.definitionParts)
        ? row.definitionParts
        : classified.definitionParts,

      definition: row.definition || classified.definition,

      parentDefinition: row.parentDefinition || classified.parentDefinition || macro.definition,
      parentDefinitionParts: hasUsableDefinitionParts(row.parentDefinitionParts)
        ? row.parentDefinitionParts
        : classified.parentDefinitionParts || macro.definitionParts,

      schema: classified.schema,
      microFamilySchema: classified.schema,
      version: classified.version,

      side: classified.side || row.side,
      tradeSide: classified.tradeSide || sideToTradeSide(row.side),

      assetClass: classified.assetClass || row.assetClass,

      obRelation: classified.obRelation || row.obRelation,
      btcRelation: classified.btcRelation || row.btcRelation,
      btcState: classified.btcState || row.btcState,

      flow: classified.flow || row.flow,
      flowCoarse: classified.flowCoarse || row.flowCoarse,

      regime: classified.regime || row.regime,
      regimeCoarse: classified.regimeCoarse || row.regimeCoarse,

      scannerReason: classified.scannerReason || row.scannerReason,
      scannerReasonCoarse: classified.scannerReasonCoarse || row.scannerReasonCoarse,

      rsiZone: classified.rsiZone || row.rsiZone,
      rsiCoarse: classified.rsiCoarse || row.rsiCoarse,

      spreadBps: classified.spreadBps ?? row.spreadBps
    };
  }

  return {
    ...row,

    familyId: row.familyId || classified.familyId,

    macroFamilyId: row.macroFamilyId || row.parentMacroFamilyId || classified.macroFamilyId || macro.microFamilyId,
    parentMacroFamilyId: row.parentMacroFamilyId || row.macroFamilyId || classified.parentMacroFamilyId || macro.microFamilyId,
    parentMicroFamilyId: row.parentMicroFamilyId || row.parentMacroFamilyId || row.macroFamilyId || classified.parentMicroFamilyId || macro.microFamilyId,

    definitionParts: hasUsableDefinitionParts(row.definitionParts)
      ? row.definitionParts
      : classified.definitionParts,

    definition: row.definition || classified.definition,

    parentDefinition: row.parentDefinition || classified.parentDefinition || macro.definition,
    parentDefinitionParts: hasUsableDefinitionParts(row.parentDefinitionParts)
      ? row.parentDefinitionParts
      : classified.parentDefinitionParts || macro.definitionParts,

    schema: row.schema || classified.schema,
    microFamilySchema: row.microFamilySchema || row.schema || classified.schema,
    version: row.version || classified.version,

    side: row.side || classified.side,
    tradeSide: row.tradeSide || classified.tradeSide || sideToTradeSide(row.side),

    assetClass: row.assetClass || classified.assetClass,

    obRelation: row.obRelation || classified.obRelation,
    btcRelation: row.btcRelation || classified.btcRelation,
    btcState: row.btcState || classified.btcState,

    flow: row.flow || classified.flow,
    flowCoarse: row.flowCoarse || classified.flowCoarse,

    regime: row.regime || classified.regime,
    regimeCoarse: row.regimeCoarse || classified.regimeCoarse,

    scannerReason: row.scannerReason || classified.scannerReason,
    scannerReasonCoarse: row.scannerReasonCoarse || classified.scannerReasonCoarse,

    rsiZone: row.rsiZone || classified.rsiZone,
    rsiCoarse: row.rsiCoarse || classified.rsiCoarse,

    spreadBps: row.spreadBps ?? classified.spreadBps
  };
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

  const normalizedSide = normalizeStatsSide(side, classified);

  if (!micros[microFamilyId]) {
    micros[microFamilyId] = createMicroStats({
      microFamilyId,
      familyId,
      side: normalizedSide,
      definitionParts: classified.definitionParts || []
    });
  }

  const micro = micros[microFamilyId];

  micro.microFamilyId ||= microFamilyId;
  micro.familyId ||= familyId;
  micro.side ||= normalizedSide;
  micro.tradeSide ||= classified.tradeSide || sideToTradeSide(side);

  micro.schema ||= classified.schema || classified.microFamilySchema || getAnalyzeSchemaMeta().microSchema;
  micro.microFamilySchema ||= classified.microFamilySchema || classified.schema || getAnalyzeSchemaMeta().microSchema;
  micro.version ||= classified.version || 'micro';

  micro.macroFamilyId ||= classified.macroFamilyId || classified.parentMacroFamilyId || null;
  micro.parentMacroFamilyId ||= classified.parentMacroFamilyId || classified.macroFamilyId || null;
  micro.parentMicroFamilyId ||= classified.parentMicroFamilyId || classified.parentMacroFamilyId || classified.macroFamilyId || null;

  micro.parentDefinition ||= classified.parentDefinition || '';
  micro.parentDefinitionParts ||= classified.parentDefinitionParts || [];

  micro.definitionParts ||= classified.definitionParts || [];
  micro.definition ||= classified.definition || micro.definitionParts.join(' | ');

  micro.assetClass ||= classified.assetClass || null;

  micro.obRelation ||= classified.obRelation || null;
  micro.btcRelation ||= classified.btcRelation || null;
  micro.btcState ||= classified.btcState || null;

  micro.flow ||= classified.flow || null;
  micro.flowCoarse ||= classified.flowCoarse || null;

  micro.regime ||= classified.regime || null;
  micro.regimeCoarse ||= classified.regimeCoarse || null;

  micro.scannerReason ||= classified.scannerReason || null;
  micro.scannerReasonCoarse ||= classified.scannerReasonCoarse || null;

  micro.rsiZone ||= classified.rsiZone || null;
  micro.rsiCoarse ||= classified.rsiCoarse || null;

  if (classified.spreadBps !== undefined && micro.spreadBps === undefined) {
    micro.spreadBps = classified.spreadBps;
  }

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

  return await getJson(
    redis,
    KEYS.analyze.weekMicros(weekKey),
    {}
  );
}

export async function saveWeekMicros(weekKey, micros) {
  if (!weekKey) {
    throw new Error('WEEK_KEY_MISSING');
  }

  const redis = getDurableRedis();
  const clean = normalizeMicros(micros);
  const schemaMeta = getAnalyzeSchemaMeta();

  await setJson(
    redis,
    KEYS.analyze.weekMicros(weekKey),
    clean
  );

  await setJson(
    redis,
    KEYS.analyze.weekMeta(weekKey),
    {
      weekKey,
      updatedAt: now(),
      microFamilies: Object.keys(clean).length,
      schema: schemaMeta.schema,
      macroSchema: schemaMeta.macroSchema,
      microSchema: schemaMeta.microSchema,
      strategyVersion: schemaMeta.strategyVersion
    }
  );

  return clean;
}

export async function analyzeCandidatesBatch(
  metricsRows = [],
  { weekKey = getIsoWeekKey() } = {}
) {
  const rows = Array.isArray(metricsRows)
    ? metricsRows.filter(Boolean)
    : [];

  if (rows.length === 0) {
    return [];
  }

  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);
  const analyzed = [];

  for (const metrics of rows) {
    const classified = enrichWithMicroFamily(metrics);

    const obsKey = KEYS.analyze.obsLast(
      metrics.snapshotId || 'NO_SNAPSHOT',
      metrics.symbol || metrics.contractSymbol || 'UNKNOWN',
      classified.microFamilyId
    );

    const firstObservation = await redis.set(obsKey, '1', {
      nx: true,
      ex: CONFIG.analyze.obsDedupeTtlSec
    });

    const micro = getOrCreateMicro(
      micros,
      classified,
      classified.side || metrics.side
    );

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

  const row = enrichWithMicroFamily({
    ...outcome,
    source: src,
    weekKey,
    strategyVersion: CONFIG.strategyVersion
  });

  const micros = await getWeekMicros(weekKey);

  const micro = getOrCreateMicro(
    micros,
    row,
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

  const classified = enrichWithMicroFamily(metrics);

  if (!classified.microFamilyId) {
    return {
      ok: false,
      skipped: true,
      reason: 'MICRO_MISSING'
    };
  }

  if (!classified.entry || !classified.sl || !classified.tp) {
    return {
      ok: false,
      skipped: true,
      reason: 'RISK_MISSING'
    };
  }

  const redis = getDurableRedis();

  const dedupeKey = KEYS.analyze.shadowLast(
    classified.symbol || classified.contractSymbol || 'UNKNOWN',
    classified.microFamilyId
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
    ...classified,

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
    shadowId: id,
    microFamilyId: row.microFamilyId,
    macroFamilyId: row.parentMacroFamilyId || row.macroFamilyId || null
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

  const stoppedOut = [
    'SL',
    'HIT_SL',
    'STOP',
    'STOP_LOSS',
    'STOPLOSS'
  ].includes(reason);

  return Boolean(position.directToSL) ||
    (
      stoppedOut &&
      mfeR < 0.25 &&
      maeR <= -0.8
    );
}

function copyMicroClassificationFields(position = {}) {
  return {
    familyId: position.familyId,
    microFamilyId: position.microFamilyId,

    macroFamilyId: position.macroFamilyId,
    parentMacroFamilyId: position.parentMacroFamilyId,
    parentMicroFamilyId: position.parentMicroFamilyId,

    definitionParts: position.definitionParts || [],
    definition: position.definition || null,

    parentDefinition: position.parentDefinition || null,
    parentDefinitionParts: position.parentDefinitionParts || [],

    schema: position.schema || position.microFamilySchema || null,
    microFamilySchema: position.microFamilySchema || position.schema || null,
    version: position.version || null,

    assetClass: position.assetClass || null,

    rsiZone: position.rsiZone || null,
    rsiCoarse: position.rsiCoarse || null,
    rsiSlope: position.rsiSlope ?? null,
    rsiVelocity: position.rsiVelocity ?? null,
    rsiDelta: position.rsiDelta ?? null,
    rsiMomentum: position.rsiMomentum ?? null,

    obRelation: position.obRelation || null,
    obBias: position.obBias ?? null,
    obImbalance: position.obImbalance ?? null,
    orderbookImbalance: position.orderbookImbalance ?? null,
    bookImbalance: position.bookImbalance ?? null,
    bidAskImbalance: position.bidAskImbalance ?? null,

    spoofScore: position.spoofScore ?? null,
    orderbookSpoofScore: position.orderbookSpoofScore ?? null,
    obSpoofScore: position.obSpoofScore ?? null,
    fakeLiquidityScore: position.fakeLiquidityScore ?? null,

    btcState: position.btcState || null,
    btcRelation: position.btcRelation || null,

    flow: position.flow || null,
    flowCoarse: position.flowCoarse || null,

    regime: position.regime || null,
    regimeCoarse: position.regimeCoarse || null,

    confluence: position.confluence ?? null,
    sniperScore: position.sniperScore ?? null,

    scannerReason: position.scannerReason || null,
    scannerReasonCoarse: position.scannerReasonCoarse || null,

    spreadPct: position.spreadPct ?? null,
    exitSpreadPct: position.exitSpreadPct ?? null,
    spreadBps: position.spreadBps ?? null,

    depthMinUsd1p: position.depthMinUsd1p ?? null,
    fundingRate: position.fundingRate ?? null,

    entryQuality: position.entryQuality || null,
    retestConfirmed: Boolean(position.retestConfirmed),
    pullbackConfirmed: Boolean(position.pullbackConfirmed),
    sweepConfirmed: Boolean(position.sweepConfirmed),
    fakeBreakout: Boolean(position.fakeBreakout),

    entryDistancePct: position.entryDistancePct ?? null,
    entryDistanceToMidPct: position.entryDistanceToMidPct ?? null,
    pullbackDistancePct: position.pullbackDistancePct ?? null,
    distanceToEntryPct: position.distanceToEntryPct ?? null,
    distancePct: position.distancePct ?? null,

    slDistancePct: position.slDistancePct ?? null,
    stopDistancePct: position.stopDistancePct ?? null,
    stopLossDistancePct: position.stopLossDistancePct ?? null,

    tpDistancePct: position.tpDistancePct ?? null,
    takeProfitDistancePct: position.takeProfitDistancePct ?? null,

    liqDistancePct: position.liqDistancePct ?? null,
    liquidationDistancePct: position.liquidationDistancePct ?? null,
    distanceToLiquidationPct: position.distanceToLiquidationPct ?? null,
    nearestLiqDistancePct: position.nearestLiqDistancePct ?? null,

    atrPct: position.atrPct ?? null,
    volatilityPct: position.volatilityPct ?? null,
    rangePct: position.rangePct ?? null,
    realizedVolPct: position.realizedVolPct ?? null,

    costR: position.costR ?? position.estimatedCostR ?? null,
    avgCostR: position.avgCostR ?? null,
    estimatedCostR: position.estimatedCostR ?? null
  };
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
    shadowId: position.shadowId || position.id || null,

    symbol: position.symbol,
    contractSymbol: position.contractSymbol,
    side: position.side,
    tradeSide: position.tradeSide || sideToTradeSide(position.side),

    ...copyMicroClassificationFields(position),

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