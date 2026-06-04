// ================= FILE: src/trade/positionEngine.js =================

import { KEYS } from '../keys.js';
import { CONFIG } from '../config.js';
import {
  getDurableRedis,
  getJson,
  setJson,
  getKeys
} from '../redis.js';
import {
  safeNumber,
  randomId,
  sideToTradeSide,
  normalizeBaseSymbol,
  mapConcurrent
} from '../utils.js';
import {
  buildOutcomeFromPosition,
  recordOutcome
} from '../analyze/analyzeEngine.js';
import { sendExitAlert } from '../discord/discord.js';

function now() {
  return Date.now();
}

function tradeConfig() {
  return {
    dataConcurrency: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.dataConcurrency, 5))
    ),
    positionTimeStopMin: safeNumber(CONFIG.trade?.positionTimeStopMin, 12 * 60)
  };
}

function manageConfig() {
  return {
    applyLive: CONFIG.manage?.applyLive === true,
    beArmR: safeNumber(CONFIG.manage?.beArmR, 0.70),
    beLockR: safeNumber(CONFIG.manage?.beLockR, 0.05),
    trailArmR: safeNumber(CONFIG.manage?.trailArmR, 1.00),
    trailLockR: safeNumber(CONFIG.manage?.trailLockR, 0.35)
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

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function roundPrice(value) {
  const n = safeNumber(value, 0);

  if (n >= 1000) return Number(n.toFixed(2));
  if (n >= 1) return Number(n.toFixed(6));

  return Number(n.toFixed(10));
}

function storageSymbol(input) {
  const raw = typeof input === 'object'
    ? input?.symbol || input?.baseSymbol || input?.contractSymbol
    : input;

  const base = normalizeBaseSymbol(raw);

  return base || String(raw || '').toUpperCase().trim();
}

function isLong(side) {
  return sideToTradeSide(side) === 'LONG';
}

function isShort(side) {
  return sideToTradeSide(side) === 'SHORT';
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

function normalizeMicroIdentity(row = {}) {
  const { currentSchema, microSchema, macroSchema } = schemaConfig();

  const microFamilyId = rowMicroId(row);
  const macroId = parentMacroFamilyId(row);
  const trueMicro = isTrueMicroFamilyRow(row);

  return {
    microFamilyId,
    familyId: row.familyId || null,

    parentMacroFamilyId: macroId || null,
    macroFamilyId: macroId || null,

    microFamilySchema: row.microFamilySchema || (
      trueMicro
        ? microSchema
        : macroSchema
    ),

    analyzeSchema: row.analyzeSchema || currentSchema,

    isTrueMicro: trueMicro,
    isLegacyMacro: !trueMicro,

    trueMicroOnly: row.trueMicroOnly !== false
  };
}

function assertEntryTradeable(entry = {}) {
  if (!entry.microFamilyId) {
    throw new Error('OPEN_POSITION_MICRO_FAMILY_ID_MISSING');
  }

  if (!entry.familyId) {
    throw new Error('OPEN_POSITION_FAMILY_ID_MISSING');
  }

  if (!entry.entry || !entry.sl || !entry.tp) {
    throw new Error('OPEN_POSITION_RISK_GEOMETRY_MISSING');
  }

  if (!entry.liveEligible) {
    throw new Error('OPEN_POSITION_NOT_LIVE_ELIGIBLE');
  }

  if (!allowLegacyMacroLiveEntries() && !isTrueMicroFamilyRow(entry)) {
    throw new Error('OPEN_POSITION_REQUIRES_TRUE_MICRO_FAMILY');
  }
}

function calcStopFromR({
  entry,
  initialSl,
  side,
  stopR
} = {}) {
  const e = safeNumber(entry, 0);
  const sl = safeNumber(initialSl, 0);
  const r = safeNumber(stopR, 0);

  if (e <= 0 || sl <= 0) return 0;

  const riskDist = Math.abs(e - sl);

  if (riskDist <= 0) return 0;

  if (isLong(side)) return e + riskDist * r;
  if (isShort(side)) return e - riskDist * r;

  return 0;
}

function shouldTightenStop({
  side,
  currentSl,
  nextSl
} = {}) {
  const current = safeNumber(currentSl, 0);
  const next = safeNumber(nextSl, 0);

  if (current <= 0 || next <= 0) return false;

  if (isLong(side)) return next > current;
  if (isShort(side)) return next < current;

  return false;
}

function applyLiveStopManagement(position) {
  const cfg = manageConfig();

  if (!cfg.applyLive) return position;

  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const currentSl = safeNumber(position.sl, 0);
  const currentR = safeNumber(position.currentR, 0);

  if (entry <= 0 || initialSl <= 0 || currentSl <= 0) return position;

  let nextStopR = null;
  let source = null;

  if (currentR >= cfg.beArmR) {
    nextStopR = cfg.beLockR;
    source = 'BE';
  }

  if (currentR >= cfg.trailArmR) {
    nextStopR = Math.max(
      safeNumber(nextStopR, cfg.beLockR),
      cfg.trailLockR
    );
    source = 'TRAIL';
  }

  if (nextStopR === null) return position;

  const nextSl = calcStopFromR({
    entry,
    initialSl,
    side: position.side,
    stopR: nextStopR
  });

  if (!shouldTightenStop({
    side: position.side,
    currentSl,
    nextSl
  })) {
    return position;
  }

  position.sl = roundPrice(nextSl);
  position.slManagementSource = source;
  position.slMovedAt = now();
  position.liveManaged = true;

  if (source === 'BE') {
    position.beLiveApplied = true;
  }

  if (source === 'TRAIL') {
    position.trailLiveApplied = true;
  }

  return position;
}

function detectExit({
  position,
  price,
  timestamp
} = {}) {
  const cfg = tradeConfig();

  const current = safeNumber(price, 0);
  const tp = safeNumber(position.tp, 0);
  const sl = safeNumber(position.sl, 0);
  const openedAt = safeNumber(position.openedAt || position.createdAt, 0);

  if (current <= 0 || tp <= 0 || sl <= 0) {
    return {
      shouldExit: false,
      reason: null
    };
  }

  const long = isLong(position.side);
  const short = isShort(position.side);

  if (!long && !short) {
    return {
      shouldExit: false,
      reason: 'UNKNOWN_SIDE'
    };
  }

  const hitTP = long
    ? current >= tp
    : current <= tp;

  const hitSL = long
    ? current <= sl
    : current >= sl;

  const expired =
    openedAt > 0 &&
    timestamp - openedAt >= cfg.positionTimeStopMin * 60 * 1000;

  if (hitTP) {
    return {
      shouldExit: true,
      reason: 'TP'
    };
  }

  if (hitSL) {
    const source = String(position.slManagementSource || '').toUpperCase();

    if (source === 'TRAIL') {
      return {
        shouldExit: true,
        reason: 'TRAIL_SL'
      };
    }

    if (source === 'BE') {
      return {
        shouldExit: true,
        reason: 'BE_SL'
      };
    }

    return {
      shouldExit: true,
      reason: 'SL'
    };
  }

  if (expired) {
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

export async function getOpenPositions() {
  const redis = getDurableRedis();
  const keys = await getKeys(redis, KEYS.trade.openPattern, 1000);

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map((key) => getJson(redis, key, null))
  );

  return rows
    .filter(Boolean)
    .sort((a, b) => {
      return safeNumber(a.openedAt || a.createdAt, 0) -
        safeNumber(b.openedAt || b.createdAt, 0);
    });
}

export async function getOpenPosition(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return null;

  return getJson(
    getDurableRedis(),
    KEYS.trade.open(keySymbol),
    null
  );
}

export async function saveOpenPosition(position) {
  const keySymbol = storageSymbol(position);

  if (!keySymbol) {
    throw new Error('OPEN_POSITION_SYMBOL_MISSING');
  }

  const identity = normalizeMicroIdentity(position);

  const row = {
    ...position,
    ...identity,

    symbol: position.symbol || keySymbol,
    baseSymbol: position.baseSymbol || keySymbol,

    status: position.status || 'OPEN',

    strategyVersion: position.strategyVersion || CONFIG.strategyVersion,

    updatedAt: now()
  };

  await setJson(
    getDurableRedis(),
    KEYS.trade.open(keySymbol),
    row
  );

  return row;
}

export async function deleteOpenPosition(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return 0;

  return getDurableRedis().del(KEYS.trade.open(keySymbol));
}

export function updatePathMetrics(position, price) {
  const cfg = manageConfig();

  const current = safeNumber(price, 0);
  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const tp = safeNumber(position.tp, 0);

  if (entry <= 0 || initialSl <= 0 || tp <= 0 || current <= 0) {
    return position;
  }

  const long = isLong(position.side);
  const short = isShort(position.side);

  if (!long && !short) {
    return position;
  }

  const riskDist = Math.abs(entry - initialSl);
  const rewardDist = Math.abs(tp - entry);

  if (riskDist <= 0 || rewardDist <= 0) {
    return position;
  }

  const directionalMove = long
    ? current - entry
    : entry - current;

  const currentR = directionalMove / riskDist;
  const tpProgress = directionalMove / rewardDist;

  position.lastPrice = current;
  position.currentR = round4(currentR);

  position.mfeR = round4(Math.max(
    safeNumber(position.mfeR, 0),
    position.currentR
  ));

  position.maeR = round4(Math.min(
    safeNumber(position.maeR, 0),
    position.currentR
  ));

  position.maxTpProgress = round4(Math.max(
    safeNumber(position.maxTpProgress, 0),
    tpProgress
  ));

  position.ticksObserved = safeNumber(position.ticksObserved, 0) + 1;

  if (currentR > 0) {
    position.favorableTicks = safeNumber(position.favorableTicks, 0) + 1;
  }

  if (currentR < 0) {
    position.adverseTicks = safeNumber(position.adverseTicks, 0) + 1;
  }

  if (position.mfeR >= 0.5) position.reachedHalfR = true;
  if (position.mfeR >= 1.0) position.reachedOneR = true;
  if (tpProgress >= 0.8) position.nearTpSeen = true;

  // Counterfactual BE logic. Always measured, even when live management is off.
  if (position.mfeR >= cfg.beArmR) {
    position.beArmed = true;

    if (currentR <= cfg.beLockR && !position.beWouldExit) {
      position.beWouldExit = true;
      position.beExitR = cfg.beLockR;
      position.beWouldExitAt = now();
    }
  }

  // Giveback diagnostics.
  if (position.reachedHalfR && currentR < 0) {
    position.gaveBackAfterHalfR = true;
  }

  if (position.reachedOneR && currentR < cfg.trailLockR) {
    position.gaveBackAfterOneR = true;
  }

  if (position.nearTpSeen && currentR < 0) {
    position.nearTpThenLoss = true;
  }

  applyLiveStopManagement(position);

  position.updatedAt = now();

  return position;
}

export function buildOpenPositionFromEntry(entry) {
  assertEntryTradeable(entry);

  const keySymbol = storageSymbol(entry);
  const openedAt = now();
  const identity = normalizeMicroIdentity(entry);

  return {
    ...entry,
    ...identity,

    tradeId: entry.tradeId || randomId('trade'),

    symbol: entry.symbol || keySymbol,
    baseSymbol: entry.baseSymbol || keySymbol,
    contractSymbol: entry.contractSymbol || null,

    status: 'OPEN',

    strategyVersion: entry.strategyVersion || CONFIG.strategyVersion,

    openedAt,
    createdAt: openedAt,
    updatedAt: openedAt,

    initialSl: entry.initialSl || entry.sl,

    currentR: 0,
    mfeR: 0,
    maeR: 0,
    maxTpProgress: 0,

    ticksObserved: 0,
    favorableTicks: 0,
    adverseTicks: 0,

    priceFetchFailures: 0,
    lastPriceFetchFailedAt: null,

    reachedHalfR: false,
    reachedOneR: false,
    nearTpSeen: false,

    beArmed: false,
    beWouldExit: false,
    beExitR: 0,

    gaveBackAfterHalfR: false,
    gaveBackAfterOneR: false,
    nearTpThenLoss: false,

    liveManaged: false,
    beLiveApplied: false,
    trailLiveApplied: false,
    slManagementSource: null
  };
}

async function markPriceFetchFailed(position) {
  position.priceFetchFailures = safeNumber(position.priceFetchFailures, 0) + 1;
  position.lastPriceFetchFailedAt = now();
  position.updatedAt = now();

  await saveOpenPosition(position);

  return position;
}

function enrichOutcomeIdentity(outcome = {}, position = {}) {
  const identity = normalizeMicroIdentity(position);

  return {
    ...outcome,
    ...identity,

    activeRotationId: position.activeRotationId || null,
    activeMacroFamilyId:
      position.activeMacroFamilyId ||
      identity.parentMacroFamilyId ||
      null,

    weeklyStats: position.weeklyStats || null,

    isTrueMicro: identity.isTrueMicro,
    isLegacyMacro: identity.isLegacyMacro,
    trueMicroOnly: identity.trueMicroOnly
  };
}

async function monitorOnePosition({
  position,
  priceFetcher,
  timestamp
}) {
  const fetchSymbol = position.contractSymbol || position.symbol;
  const price = await priceFetcher(fetchSymbol).catch(() => 0);

  if (!price) {
    await markPriceFetchFailed(position);

    return {
      type: 'NO_PRICE',
      position,
      outcome: null
    };
  }

  position.priceFetchFailures = 0;
  position.lastPriceFetchFailedAt = null;

  updatePathMetrics(position, price);

  const exit = detectExit({
    position,
    price,
    timestamp
  });

  if (!exit.shouldExit) {
    await saveOpenPosition(position);

    return {
      type: 'UPDATED',
      position,
      outcome: null
    };
  }

  const baseOutcome = buildOutcomeFromPosition({
    position,
    exitPrice: price,
    exitReason: exit.reason,
    source: 'REAL'
  });

  const outcome = enrichOutcomeIdentity(baseOutcome, position);

  await recordOutcome(outcome, {
    source: 'REAL'
  });

  await sendExitAlert(outcome).catch(() => null);

  await deleteOpenPosition(position.symbol || position.contractSymbol);

  return {
    type: 'EXIT',
    position,
    outcome
  };
}

export async function monitorOpenPositions({ priceFetcher }) {
  if (typeof priceFetcher !== 'function') {
    throw new Error('PRICE_FETCHER_REQUIRED');
  }

  const positions = await getOpenPositions();

  if (!positions.length) return [];

  const cfg = tradeConfig();
  const timestamp = now();

  const results = await mapConcurrent(
    positions,
    cfg.dataConcurrency,
    async (position) => monitorOnePosition({
      position,
      priceFetcher,
      timestamp
    })
  );

  return results
    .filter((row) => row?.type === 'EXIT' && row.outcome)
    .map((row) => row.outcome);
}