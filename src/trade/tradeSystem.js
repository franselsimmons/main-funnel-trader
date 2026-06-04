// ================= FILE: src/trade/tradeSystem.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  setJson,
  getKeys
} from '../redis.js';
import {
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  fetchCandles,
  fetchFunding,
  fetchOrderBook,
  analyzeOrderBook
} from '../market/bitgetClient.js';
import {
  analyzeCandidatesBatch,
  createShadowPosition,
  buildOutcomeFromPosition,
  recordOutcome
} from '../analyze/analyzeEngine.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import {
  buildLiveMetrics,
  buildRiskGeometry,
  isValidRiskGeometry
} from './riskEngine.js';
import {
  buildOpenPositionFromEntry,
  getOpenPositions,
  getOpenPosition,
  saveOpenPosition,
  monitorOpenPositions,
  updatePathMetrics
} from './positionEngine.js';
import {
  riskFractionForEntry,
  checkRiskCaps
} from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';

function now() {
  return Date.now();
}

function tradeConfig() {
  return {
    maxCandidatesPerSnapshot: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.maxCandidatesPerSnapshot, 80))
    ),
    maxSnapshotAgeSec: safeNumber(CONFIG.trade?.maxSnapshotAgeSec, 8 * 60),
    dataConcurrency: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.dataConcurrency, 5))
    ),
    maxOpenPositions: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.maxOpenPositions, 30))
    ),
    maxOpenSameSide: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.maxOpenSameSide, 15))
    ),
    maxSpreadPct: safeNumber(CONFIG.trade?.maxSpreadPct, 0.015),
    candleTtlSec: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.candleTtlSec, 90))
    ),
    orderbookTtlSec: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.orderbookTtlSec, 12))
    ),
    fundingTtlSec: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.fundingTtlSec, 120))
    )
  };
}

function analyzeConfig() {
  return {
    shadowEnabled: CONFIG.analyze?.shadowEnabled !== false,
    shadowHorizonMin: safeNumber(CONFIG.analyze?.shadowHorizonMin, 6 * 60),
    maxShadowMonitorsPerRun: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.analyze?.maxShadowMonitorsPerRun, 80))
    )
  };
}

function sizingConfig() {
  return {
    enabled: CONFIG.sizing?.enabled !== false,
    baseRiskPct: safeNumber(CONFIG.sizing?.baseRiskPct, 0.0025)
  };
}

function schemaConfig() {
  const macroSchema = String(
    CONFIG.analyze?.macroSchema ||
    CONFIG.analyze?.legacySchema ||
    'MF_V1'
  ).toUpperCase();

  const microSchema = String(
    CONFIG.analyze?.microSchema ||
    'MF_V2'
  ).toUpperCase();

  const currentSchema = String(
    CONFIG.analyze?.schema ||
    microSchema
  ).toUpperCase();

  return {
    currentSchema,
    macroSchema,
    microSchema
  };
}

function allowLegacyMacroLiveEntries() {
  return Boolean(CONFIG.trade?.allowLegacyMacroLiveEntries);
}

function actionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function normalizeCandidate(candidate = {}) {
  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
    candidate.symbol
  );

  const symbol =
    normalizeBaseSymbol(candidate.symbol || contractSymbol) ||
    normalizeBaseSymbol(contractSymbol);

  return {
    ...candidate,
    symbol,
    baseSymbol: symbol,
    contractSymbol
  };
}

function isLong(side) {
  return sideToTradeSide(side) === 'LONG';
}

function isShort(side) {
  return sideToTradeSide(side) === 'SHORT';
}

function waitAction(candidate, reason, extra = {}) {
  return {
    action: 'WAIT',
    reason,
    symbol: candidate?.symbol || null,
    contractSymbol: candidate?.contractSymbol || null,
    side: candidate?.side || null,
    snapshotId: candidate?.snapshotId || null,
    scannerScore: candidate?.scannerScore ?? candidate?.moveScore ?? null,
    liveEligible: false,
    ...extra
  };
}

function idHasSchema(id, schema) {
  const value = String(id || '').toUpperCase();
  const target = String(schema || '').toUpperCase();

  if (!value || !target) return false;

  return value.includes(`_${target}_`) ||
    value.endsWith(`_${target}`) ||
    value.includes(`|SCHEMA=${target}`);
}

function definitionHasSchema(row = {}, schema) {
  const target = String(schema || '').toUpperCase();

  if (!target) return false;

  const parts = Array.isArray(row.definitionParts)
    ? row.definitionParts
    : [];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${target}`)) {
    return true;
  }

  return String(row.definition || '').toUpperCase().includes(`SCHEMA=${target}`);
}

function rowSchema(row = {}) {
  return String(
    row.microFamilySchema ||
    row.schema ||
    row.versionSchema ||
    ''
  ).toUpperCase();
}

function rowMicroId(row = {}) {
  return String(row.microFamilyId || row.id || '').trim();
}

function parentMacroFamilyId(row = {}) {
  return String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    ''
  ).trim();
}

function isTrueMicroFamilyRow(row = {}) {
  const { microSchema, macroSchema } = schemaConfig();

  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (version.includes('MACRO')) return false;

  if (row.isTrueMicro === true) return true;
  if (schema === microSchema) return true;
  if (idHasSchema(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

  if (row.isLegacyMacro === true) return false;
  if (schema === macroSchema) return false;
  if (idHasSchema(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  return Boolean(parentMacroFamilyId(row));
}

function isLegacyMacroFamilyRow(row = {}) {
  const { macroSchema } = schemaConfig();

  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isTrueMicroFamilyRow(row)) return false;

  if (row.isLegacyMacro === true) return true;
  if (version.includes('MACRO')) return true;
  if (schema === macroSchema) return true;
  if (idHasSchema(id, macroSchema)) return true;
  if (definitionHasSchema(row, macroSchema)) return true;

  return !parentMacroFamilyId(row);
}

function isKnownTrueMicroFamilyId(id = '') {
  const { microSchema, macroSchema } = schemaConfig();

  if (!id) return false;
  if (idHasSchema(id, macroSchema)) return false;

  return idHasSchema(id, microSchema);
}

function getTradeSideFromRow(row = {}) {
  const direct = sideToTradeSide(row.tradeSide || row.side);

  if (direct !== 'UNKNOWN') return direct;

  const familyId = String(row.familyId || '').toUpperCase();

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  const microId = String(row.microFamilyId || '').toUpperCase();

  if (microId.includes('MICRO_LONG_')) return 'LONG';
  if (microId.includes('MICRO_SHORT_')) return 'SHORT';

  return 'UNKNOWN';
}

function buildActiveRotationContext(activeRotation) {
  const rows = Array.isArray(activeRotation?.microFamilies)
    ? activeRotation.microFamilies
    : [];

  const rowByMicroId = new Map();

  for (const row of rows) {
    const id = rowMicroId(row);

    if (!id) continue;

    rowByMicroId.set(id, row);
  }

  const configuredIds = uniqueStrings(activeRotation?.microFamilyIds || []);

  const activeMicroFamilyIds = configuredIds.filter((id) => {
    const row = rowByMicroId.get(id);

    if (allowLegacyMacroLiveEntries()) return true;
    if (row && isTrueMicroFamilyRow(row)) return true;

    return isKnownTrueMicroFamilyId(id);
  });

  const activeMicroSet = new Set(activeMicroFamilyIds);

  const activeMacroFamilyIds = uniqueStrings([
    ...(activeRotation?.macroFamilyIds || []),
    ...(activeRotation?.activeMacroFamilyIds || []),
    ...rows.map(parentMacroFamilyId)
  ]);

  const activeMacroSet = new Set(activeMacroFamilyIds);

  const macroToMicroFamilyIds = {
    ...(activeRotation?.macroToMicroFamilyIds || {})
  };

  const microToMacroFamilyId = {
    ...(activeRotation?.microToMacroFamilyId || {})
  };

  for (const row of rows) {
    const microId = rowMicroId(row);
    const macroId = parentMacroFamilyId(row);

    if (!microId || !macroId) continue;

    microToMacroFamilyId[microId] ||= macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(
      macroToMicroFamilyIds[macroId]
    );
  }

  return {
    rotationId: activeRotation?.rotationId || null,
    activeRotation: activeRotation || null,

    activeMicroFamilyIds,
    activeMicroSet,

    activeMacroFamilyIds,
    activeMacroSet,

    rowByMicroId,

    microToMacroFamilyId,
    macroToMicroFamilyIds,

    trueMicroOnly: activeRotation?.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation?.usedLegacyFallback),

    empty: !activeMicroFamilyIds.length
  };
}

function getWeeklyStats(activeContext, microFamilyId) {
  if (!activeContext || !microFamilyId) return null;

  return activeContext.rowByMicroId.get(microFamilyId) || null;
}

function hasActiveParentMacro(activeContext, row = {}) {
  const macroId = parentMacroFamilyId(row);

  if (!macroId) return false;

  return activeContext?.activeMacroSet?.has(macroId) || false;
}

function buildRotationWaitReason(activeContext, row = {}) {
  if (!activeContext || activeContext.empty) {
    return 'ACTIVE_ROTATION_EMPTY';
  }

  if (!allowLegacyMacroLiveEntries() && !isTrueMicroFamilyRow(row)) {
    return isLegacyMacroFamilyRow(row)
      ? 'LEGACY_MACRO_FAMILY_NOT_TRADEABLE'
      : 'LIVE_ROW_NOT_TRUE_MICRO_FAMILY';
  }

  if (hasActiveParentMacro(activeContext, row)) {
    return 'PARENT_MACRO_ACTIVE_BUT_TRUE_MICRO_NOT_ACTIVE';
  }

  return 'MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION';
}

async function cachedVolatile(key, ttlSec, fn) {
  const redis = getVolatileRedis();

  const cached = await getJson(redis, key, null).catch(() => null);

  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const value = await fn();

  if (value !== undefined) {
    const ttl = Math.max(1, Number(ttlSec) || 1);
    await setJson(redis, key, value, { ex: ttl }).catch(() => null);
  }

  return value;
}

async function fetchLiveCandidateData(candidate) {
  const cfg = tradeConfig();

  const normalized = normalizeCandidate(candidate);
  const symbol = normalized.contractSymbol;

  if (!symbol) {
    return {
      symbol,
      ob: {
        fetchFailed: true,
        mid: 0,
        bias: 'NEUTRAL',
        spreadPct: CONFIG.cost?.fallbackSpreadPct || 0.0008,
        depthMinUsd1p: 0
      },
      funding: { rate: 0, fetchFailed: true },
      candles15m: [],
      candles1h: []
    };
  }

  const [rawOrderBook, funding, candles15m, candles1h] = await Promise.all([
    cachedVolatile(
      KEYS.live.cache(symbol, 'ob'),
      cfg.orderbookTtlSec,
      () => fetchOrderBook(symbol)
    ).catch(() => null),

    cachedVolatile(
      KEYS.live.cache(symbol, 'funding'),
      cfg.fundingTtlSec,
      () => fetchFunding(symbol)
    ).catch(() => ({ rate: 0, fetchFailed: true })),

    cachedVolatile(
      KEYS.live.cache(symbol, 'c15'),
      cfg.candleTtlSec,
      () => fetchCandles(symbol, '15m', 100)
    ).catch(() => []),

    cachedVolatile(
      KEYS.live.cache(symbol, 'c1h'),
      cfg.candleTtlSec,
      () => fetchCandles(symbol, '1h', 100)
    ).catch(() => [])
  ]);

  const ob = analyzeOrderBook(rawOrderBook);

  return {
    symbol,
    ob,
    funding,
    candles15m: Array.isArray(candles15m) ? candles15m : [],
    candles1h: Array.isArray(candles1h) ? candles1h : []
  };
}

async function fetchMidPrice(symbol) {
  const cfg = tradeConfig();
  const contractSymbol = normalizeContractSymbol(symbol);

  if (!contractSymbol) return 0;

  const rawOrderBook = await cachedVolatile(
    KEYS.live.cache(contractSymbol, 'ob'),
    cfg.orderbookTtlSec,
    () => fetchOrderBook(contractSymbol)
  ).catch(() => null);

  const ob = analyzeOrderBook(rawOrderBook);

  return safeNumber(ob?.mid, 0);
}

async function getLatestSnapshot() {
  const volatileRedis = getVolatileRedis();
  const latest = await getJson(volatileRedis, KEYS.scan.latest, null);

  if (!latest?.snapshotId) return null;

  return getJson(
    volatileRedis,
    KEYS.scan.snapshot(latest.snapshotId),
    null
  );
}

function validateExposure(openPositions, side) {
  const cfg = tradeConfig();

  const rows = Array.isArray(openPositions) ? openPositions : [];
  const tradeSide = sideToTradeSide(side);

  if (rows.length >= cfg.maxOpenPositions) {
    return {
      ok: false,
      reason: 'MAX_OPEN_POSITIONS',
      count: rows.length,
      cap: cfg.maxOpenPositions
    };
  }

  const sameSide = rows.filter((position) => (
    sideToTradeSide(position.side) === tradeSide
  )).length;

  if (sameSide >= cfg.maxOpenSameSide) {
    return {
      ok: false,
      reason: 'MAX_OPEN_SAME_SIDE',
      side: tradeSide,
      count: sameSide,
      cap: cfg.maxOpenSameSide
    };
  }

  return {
    ok: true
  };
}

function detectShadowExit(shadow, price) {
  const current = safeNumber(price, 0);
  const tp = safeNumber(shadow.tp, 0);
  const sl = safeNumber(shadow.sl, 0);

  if (current <= 0 || tp <= 0 || sl <= 0) {
    return {
      shouldExit: false,
      reason: null
    };
  }

  if (isLong(shadow.side)) {
    if (current >= tp) return { shouldExit: true, reason: 'TP' };
    if (current <= sl) return { shouldExit: true, reason: 'SL' };
  }

  if (isShort(shadow.side)) {
    if (current <= tp) return { shouldExit: true, reason: 'TP' };
    if (current >= sl) return { shouldExit: true, reason: 'SL' };
  }

  if (now() >= safeNumber(shadow.monitorUntil, 0)) {
    return {
      shouldExit: true,
      reason: 'TIME_STOP'
    };
  }

  return {
    shouldExit: false,
    reason: null
  };
}

async function monitorOneShadowPosition(redis, key) {
  const cfg = analyzeConfig();

  const shadow = await getJson(redis, key, null);

  if (!shadow || shadow.status !== 'OPEN') {
    return null;
  }

  const price = await fetchMidPrice(
    shadow.contractSymbol ||
    shadow.symbol
  ).catch(() => 0);

  if (!price) return null;

  updatePathMetrics(shadow, price);

  const exit = detectShadowExit(shadow, price);

  if (!exit.shouldExit) {
    await setJson(
      redis,
      key,
      shadow,
      {
        ex: Math.ceil(cfg.shadowHorizonMin * 60 * 1.2)
      }
    );

    return null;
  }

  const outcome = buildOutcomeFromPosition({
    position: shadow,
    exitPrice: price,
    exitReason: exit.reason,
    source: 'SHADOW'
  });

  await recordOutcome(outcome, {
    source: 'SHADOW'
  });

  await redis.del(key);

  return outcome;
}

async function monitorShadowPositions() {
  const cfg = analyzeConfig();

  if (!cfg.shadowEnabled) return [];

  const redis = getDurableRedis();

  const keys = await getKeys(
    redis,
    KEYS.analyze.shadowOpenPattern,
    cfg.maxShadowMonitorsPerRun
  );

  if (!keys.length) return [];

  const results = await mapConcurrent(
    keys,
    tradeConfig().dataConcurrency,
    (key) => monitorOneShadowPosition(redis, key)
  );

  return results.filter(Boolean);
}

async function processCandidate(candidate) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);

  if (!normalized.symbol || !normalized.contractSymbol) {
    return {
      action: waitAction(normalized, 'INVALID_SYMBOL'),
      metrics: null
    };
  }

  const data = await fetchLiveCandidateData(normalized)
    .catch((error) => ({ error }));

  if (data.error || data.ob?.fetchFailed) {
    return {
      action: waitAction(normalized, 'LIVE_DATA_FAILED', {
        error: data.error?.message || null
      }),
      metrics: null
    };
  }

  if (safeNumber(data.ob.spreadPct, 0) > cfg.maxSpreadPct) {
    return {
      action: waitAction(normalized, 'SPREAD_TOO_WIDE', {
        spreadPct: data.ob.spreadPct,
        maxSpreadPct: cfg.maxSpreadPct
      }),
      metrics: null
    };
  }

  if (!Array.isArray(data.candles15m) || data.candles15m.length < 30) {
    return {
      action: waitAction(normalized, 'INSUFFICIENT_LIVE_CANDLES_15M', {
        candleCount: data.candles15m?.length || 0
      }),
      metrics: null
    };
  }

  const risk = buildRiskGeometry({
    candidate: normalized,
    ob: data.ob,
    candles15m: data.candles15m
  });

  if (!isValidRiskGeometry(risk, normalized.side)) {
    return {
      action: waitAction(normalized, 'RISK_INVALID'),
      metrics: null
    };
  }

  const metrics = buildLiveMetrics({
    candidate: normalized,
    ob: data.ob,
    funding: data.funding,
    candles15m: data.candles15m,
    candles1h: data.candles1h,
    btcState: normalized.btcState || candidate.btcState,
    regime: normalized.regime || candidate.regime,
    risk
  });

  if (!metrics) {
    return {
      action: waitAction(normalized, 'LIVE_METRICS_FAILED'),
      metrics: null
    };
  }

  return {
    action: null,
    metrics
  };
}

async function safeProcessCandidate(candidate) {
  try {
    return await processCandidate(candidate);
  } catch (error) {
    const normalized = normalizeCandidate(candidate);

    return {
      action: waitAction(normalized, 'CANDIDATE_PROCESS_ERROR', {
        error: error?.message || String(error)
      }),
      metrics: null
    };
  }
}

function buildEntryAction({
  row,
  activeContext,
  weeklyStats,
  riskFraction,
  riskCaps
}) {
  const activeMacroFamilyId =
    parentMacroFamilyId(row) ||
    activeContext.microToMacroFamilyId[row.microFamilyId] ||
    null;

  return {
    ...row,

    action: 'ENTRY',
    reason: 'ACTIVE_TRUE_MICRO_FAMILY_ENTRY',

    activeRotationId: activeContext.rotationId,
    activeMacroFamilyId,

    weeklyStats,

    riskFraction,
    riskCaps,

    btcRelation: row.btcRelation,

    liveEligible: true,
    shadowOnly: false,

    entryCreatedAt: now()
  };
}

async function saveRunMeta(result) {
  const durableRedis = getDurableRedis();

  const completedAt = now();

  const finalResult = {
    ok: true,
    ...result,
    completedAt,
    durationMs: completedAt - safeNumber(result.startedAt, completedAt),
    actionCounts: result.actionCounts || actionCounts(result.actions || [])
  };

  await setJson(
    durableRedis,
    KEYS.trade.runMeta,
    finalResult
  );

  return finalResult;
}

export async function runTradeSystem(options = {}) {
  const cfg = tradeConfig();
  const sizing = sizingConfig();

  const durableRedis = getDurableRedis();

  const runId = randomId('trade_run');
  const startedAt = now();

  const forceProcessSnapshot = Boolean(options.forceProcessSnapshot);

  const priceFetcher = async (symbol) => fetchMidPrice(symbol);

  const realExits = await monitorOpenPositions({ priceFetcher });
  const shadowExits = await monitorShadowPositions();

  const snapshot = await getLatestSnapshot();

  if (!snapshot?.snapshotId) {
    return saveRunMeta({
      runId,
      startedAt,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'NO_SCANNER_SNAPSHOT'
    });
  }

  const snapshotAgeSec = (now() - safeNumber(snapshot.createdAt, 0)) / 1000;

  if (snapshotAgeSec > cfg.maxSnapshotAgeSec) {
    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_TOO_STALE'
    });
  }

  const lastProcessed = await getJson(
    durableRedis,
    KEYS.trade.lastProcessedSnapshot,
    null
  );

  const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;

  if (sameSnapshot && !forceProcessSnapshot) {
    return saveRunMeta({
      runId,
      startedAt,
      snapshotId: snapshot.snapshotId,
      actions: [],
      realExits,
      shadowExits,
      skippedNewEntries: true,
      reason: 'SNAPSHOT_ALREADY_PROCESSED'
    });
  }

  const activeRotation = await getActiveRotation();
  const activeContext = buildActiveRotationContext(activeRotation);

  const candidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
    .slice(0, cfg.maxCandidatesPerSnapshot)
    .map((candidate) => ({
      ...candidate,
      btcState: snapshot.btcState,
      regime: snapshot.regime
    }));

  const processed = await mapConcurrent(
    candidates,
    cfg.dataConcurrency,
    safeProcessCandidate
  );

  const earlyActions = processed
    .map((row) => row?.action)
    .filter(Boolean);

  const liveRows = processed
    .map((row) => row?.metrics)
    .filter(Boolean);

  const analyzedRows = await analyzeCandidatesBatch(liveRows);

  const openPositions = await getOpenPositions();
  const actions = [...earlyActions];

  for (const row of analyzedRows) {
    await createShadowPosition(row).catch(() => null);

    const microFamilyId = row.microFamilyId;
    const trueMicroRow = isTrueMicroFamilyRow(row);
    const activeExactMicro = activeContext.activeMicroSet.has(microFamilyId);

    if (!activeExactMicro || (!allowLegacyMacroLiveEntries() && !trueMicroRow)) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: buildRotationWaitReason(activeContext, row),
        activeRotationId: activeContext.rotationId,
        activeMacroFamilyId: parentMacroFamilyId(row) || null,
        activeMicroFamilies: activeContext.activeMicroFamilyIds.length,
        activeMacroFamilies: activeContext.activeMacroFamilyIds.length,
        liveEligible: false,
        shadowOnly: true
      });

      continue;
    }

    const alreadyOpen = await getOpenPosition(row.symbol);

    if (alreadyOpen) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: 'SYMBOL_ALREADY_OPEN',
        activeRotationId: activeContext.rotationId,
        liveEligible: false
      });

      continue;
    }

    const exposure = validateExposure(openPositions, row.side);

    if (!exposure.ok) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: exposure.reason,
        activeRotationId: activeContext.rotationId,
        exposure,
        liveEligible: false
      });

      continue;
    }

    const weeklyStats = getWeeklyStats(
      activeContext,
      microFamilyId
    );

    const riskFraction = sizing.enabled
      ? riskFractionForEntry({ weeklyStats })
      : sizing.baseRiskPct;

    const riskCaps = checkRiskCaps({
      openPositions,
      side: row.side,
      btcRelation: row.btcRelation,
      riskFraction
    });

    if (!riskCaps.ok) {
      actions.push({
        ...row,
        action: 'WAIT',
        reason: riskCaps.reason,
        activeRotationId: activeContext.rotationId,
        riskCaps,
        liveEligible: false
      });

      continue;
    }

    const entry = buildEntryAction({
      row,
      activeContext,
      weeklyStats,
      riskFraction,
      riskCaps
    });

    const position = buildOpenPositionFromEntry(entry);

    await saveOpenPosition(position);

    openPositions.push(position);

    await sendEntryAlert(entry).catch(() => null);

    actions.push(entry);
  }

  await setJson(
    durableRedis,
    KEYS.trade.lastProcessedSnapshot,
    {
      snapshotId: snapshot.snapshotId,
      processedAt: now(),
      forceProcessSnapshot,
      candidates: candidates.length,
      liveRows: liveRows.length,
      analyzedRows: analyzedRows.length,
      actions: actions.length,

      activeRotationId: activeContext.rotationId,
      activeMicroFamilies: activeContext.activeMicroFamilyIds.length,
      activeMacroFamilies: activeContext.activeMacroFamilyIds.length,
      trueMicroOnly: activeContext.trueMicroOnly,
      usedLegacyFallback: activeContext.usedLegacyFallback
    }
  );

  return saveRunMeta({
    runId,
    startedAt,

    snapshotId: snapshot.snapshotId,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotAgeSec: Math.round(snapshotAgeSec),

    candidates: candidates.length,
    liveRows: liveRows.length,
    analyzedRows: analyzedRows.length,

    actions,
    actionCounts: actionCounts(actions),

    realExits,
    shadowExits,

    activeRotationId: activeContext.rotationId,
    activeMicroFamilies: activeContext.activeMicroFamilyIds.length,
    activeMacroFamilies: activeContext.activeMacroFamilyIds.length,
    activeMicroFamilyIds: activeContext.activeMicroFamilyIds,
    activeMacroFamilyIds: activeContext.activeMacroFamilyIds,
    trueMicroOnly: activeContext.trueMicroOnly,
    usedLegacyFallback: activeContext.usedLegacyFallback,

    skippedNewEntries: false
  });
}