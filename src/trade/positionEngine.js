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
import { applyCosts } from './costModel.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const POSITION_SOURCE = 'VIRTUAL';
const OUTCOME_SOURCE = 'VIRTUAL';

const COST_MODEL_VERSION = 'POSITION_ENGINE_SHORT_NET_COST_V2';

const SHORT_DIRECT = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

const LONG_DIRECT = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

function now() {
  return Date.now();
}

function tradeConfig() {
  return {
    dataConcurrency: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.trade?.dataConcurrency, 5))
    ),

    positionTimeStopMin: safeNumber(
      CONFIG.trade?.positionTimeStopMin,
      12 * 60
    )
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

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function roundPrice(value) {
  const n = safeNumber(value, 0);

  if (n >= 1000) return Number(n.toFixed(2));
  if (n >= 1) return Number(n.toFixed(6));

  return Number(n.toFixed(10));
}

function clonePlainObject(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value ?? null));
}

function storageSymbol(input) {
  const raw = typeof input === 'object'
    ? input?.symbol || input?.baseSymbol || input?.contractSymbol
    : input;

  const base = normalizeBaseSymbol(raw);

  return base || String(raw || '').toUpperCase().trim();
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (SHORT_DIRECT.has(raw)) return TARGET_TRADE_SIDE;
  if (LONG_DIRECT.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'SELL' ||
    normalized.includes('MICRO_SHORT_') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('SIDE_SELL') ||
    normalized.includes('DIRECTION_SELL') ||
    normalized.startsWith('SHORT_') ||
    normalized.includes('_SHORT_') ||
    normalized.endsWith('_SHORT') ||
    normalized.startsWith('BEAR_') ||
    normalized.includes('_BEAR_') ||
    normalized.endsWith('_BEAR') ||
    normalized.startsWith('SELL_') ||
    normalized.includes('_SELL_') ||
    normalized.endsWith('_SELL');

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BUY' ||
    normalized.includes('MICRO_LONG_') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('SIDE_BUY') ||
    normalized.includes('DIRECTION_BUY') ||
    normalized.startsWith('LONG_') ||
    normalized.includes('_LONG_') ||
    normalized.endsWith('_LONG') ||
    normalized.startsWith('BULL_') ||
    normalized.includes('_BULL_') ||
    normalized.endsWith('_BULL') ||
    normalized.startsWith('BUY_') ||
    normalized.includes('_BUY_') ||
    normalized.endsWith('_BUY');

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (longHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function normalizedTextParts(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean);
}

function idText(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.trueMicroFamilyId,
    row.microFamilyId,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,

    row.id,
    row.key
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');
}

function hasShortIdSignal(text = '') {
  const raw = String(text || '').toUpperCase();

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.includes('SHORT_') ||
    raw.includes('_SHORT_') ||
    raw.endsWith('_SHORT') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT')
  );
}

function hasLongIdSignal(text = '') {
  const raw = String(text || '').toUpperCase();

  return (
    raw.includes('MICRO_LONG_') ||
    raw.includes('LONG_') ||
    raw.includes('_LONG_') ||
    raw.endsWith('_LONG') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG')
  );
}

function hasShortDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL')
  );
}

function hasLongDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = idText(row);

  if (!haystack) return 'UNKNOWN';

  if (hasLongIdSignal(haystack)) return OPPOSITE_TRADE_SIDE;
  if (hasShortIdSignal(haystack)) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferTradeSideFromDefinitions(row = {}) {
  const parts = normalizedTextParts(row);

  if (!parts.length) return 'UNKNOWN';

  if (hasLongDefinitionSignal(parts)) return OPPOSITE_TRADE_SIDE;
  if (hasShortDefinitionSignal(parts)) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferPositionTradeSide(row = {}) {
  if (typeof row === 'string') return normalizeTradeSide(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.analysisSide,
    row.actualScannerSide,
    row.side
  ];

  for (const value of directSources) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const fromIds = inferTradeSideFromIds(row);

  if (fromIds === TARGET_TRADE_SIDE || fromIds === OPPOSITE_TRADE_SIDE) return fromIds;

  const fromDefinitions = inferTradeSideFromDefinitions(row);

  if (fromDefinitions === TARGET_TRADE_SIDE || fromDefinitions === OPPOSITE_TRADE_SIDE) {
    return fromDefinitions;
  }

  if (row.shortOnly === true && row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortPosition(row = {}) {
  return inferPositionTradeSide(row) === TARGET_TRADE_SIDE;
}

function idHasSchema(id, schema) {
  const value = String(id || '').toUpperCase();
  const target = String(schema || '').toUpperCase();

  if (!value || !target) return false;

  return (
    value.includes(`_${target}_`) ||
    value.endsWith(`_${target}`) ||
    value.includes(`|SCHEMA=${target}`) ||
    value.includes(`SCHEMA=${target}`)
  );
}

function definitionHasSchema(row = {}, schema) {
  const target = String(schema || '').toUpperCase();

  if (!target) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${target}`)) {
    return true;
  }

  return String(row.definition || row.microDefinition || '').toUpperCase().includes(`SCHEMA=${target}`);
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
  return String(
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();
}

function parentMacroFamilyId(row = {}) {
  return String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    row.familyMacroId ||
    ''
  ).trim();
}

function fallbackFamilyId(row = {}) {
  return String(
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    parentMacroFamilyId(row) ||
    rowMicroId(row) ||
    ''
  ).trim();
}

function isTrueMicroFamilyRow(row = {}) {
  const { microSchema, macroSchema } = schemaConfig();

  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (!isShortPosition(row) && !hasShortIdSignal(id)) return false;

  if (row.isLegacyMacro === true) return false;
  if (version.includes('MACRO')) return false;

  if (row.isTrueMicro === true || row.trueMicro === true) return true;

  if (schema === microSchema) return true;
  if (idHasSchema(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

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
    trueMicroFamilyId: microFamilyId,
    familyId: fallbackFamilyId(row) || microFamilyId || null,

    parentMacroFamilyId: macroId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroId || null,
    macroFamilyId: macroId || null,

    microFamilySchema: row.microFamilySchema || (
      trueMicro
        ? microSchema
        : macroSchema
    ),

    schema: row.schema || row.microFamilySchema || (
      trueMicro
        ? microSchema
        : macroSchema
    ),

    analyzeSchema: row.analyzeSchema || currentSchema,

    isTrueMicro: trueMicro,
    isLegacyMacro: !trueMicro,

    trueMicroOnly: true
  };
}

function assertShortRiskGeometry(row = {}) {
  const entryPrice = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);

  if (!(entryPrice > 0 && sl > entryPrice && tp < entryPrice)) {
    throw new Error('OPEN_POSITION_SHORT_RISK_GEOMETRY_INVALID');
  }
}

function assertBasePositionFields(row = {}) {
  if (inferPositionTradeSide(row) !== TARGET_TRADE_SIDE) {
    throw new Error('OPEN_POSITION_SHORT_ONLY_SYSTEM_REJECTED_NON_SHORT_ENTRY');
  }

  if (!row.microFamilyId) {
    throw new Error('OPEN_POSITION_MICRO_FAMILY_ID_MISSING');
  }

  if (!row.familyId) {
    throw new Error('OPEN_POSITION_FAMILY_ID_MISSING');
  }

  if (!row.entry || !row.sl || !row.tp) {
    throw new Error('OPEN_POSITION_RISK_GEOMETRY_MISSING');
  }

  if (!isTrueMicroFamilyRow(row)) {
    throw new Error('OPEN_POSITION_REQUIRES_TRUE_MICRO_FAMILY');
  }

  assertShortRiskGeometry(row);
}

function assertPositionPersistable(position = {}) {
  assertBasePositionFields(position);

  if (position.status && String(position.status).toUpperCase() !== 'OPEN') {
    throw new Error('OPEN_POSITION_STATUS_MUST_BE_OPEN');
  }
}

function assertShortInput(row = {}, context = 'POSITION') {
  const side = inferPositionTradeSide(row);

  if (side !== TARGET_TRADE_SIDE) {
    throw new Error(`${context}_SHORT_ONLY_REJECTED_${side}`);
  }
}

function calcStopFromR({
  entry,
  initialSl,
  stopR
} = {}) {
  const e = safeNumber(entry, 0);
  const sl = safeNumber(initialSl, 0);
  const r = safeNumber(stopR, 0);

  if (e <= 0 || sl <= 0) return 0;

  const riskDist = Math.abs(e - sl);

  if (riskDist <= 0) return 0;

  return e - riskDist * r;
}

function shouldTightenStop({
  currentSl,
  nextSl
} = {}) {
  const current = safeNumber(currentSl, 0);
  const next = safeNumber(nextSl, 0);

  if (current <= 0 || next <= 0) return false;

  return next < current;
}

function applyLiveStopManagement(position) {
  const cfg = manageConfig();

  if (!cfg.applyLive) return position;
  if (!isShortPosition(position)) return position;

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
    stopR: nextStopR
  });

  if (!shouldTightenStop({
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

  if (!isShortPosition(position)) {
    return {
      shouldExit: false,
      reason: 'NON_SHORT_POSITION_IGNORED'
    };
  }

  const hitTP = current <= tp;
  const hitSL = current >= sl;

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

function forceShortPositionFields(row = {}) {
  return {
    ...row,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  };
}

function buildVirtualFlags(row = {}) {
  return {
    source: POSITION_SOURCE,
    outcomeSource: OUTCOME_SOURCE,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    liveEligible: Boolean(row.liveEligible),
    discordAlertEligible: Boolean(row.discordAlertEligible),
    selectedMicroFamilyAlert: Boolean(row.selectedMicroFamilyAlert)
  };
}

function calcGrossMovePctFromPosition({
  position,
  exitPrice
} = {}) {
  const entry = safeNumber(position.entry, 0);
  const exit = safeNumber(exitPrice, 0);

  if (entry <= 0 || exit <= 0) return 0;

  return (entry - exit) / entry;
}

function calcGrossRFromPosition({
  position,
  exitPrice
} = {}) {
  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const exit = safeNumber(exitPrice, 0);

  if (entry <= 0 || initialSl <= 0 || exit <= 0) return 0;

  const riskDistance = Math.abs(entry - initialSl);

  if (riskDistance <= 0) return 0;

  return (entry - exit) / riskDistance;
}

function calcRiskPctFromPosition(position = {}) {
  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);

  if (entry <= 0 || initialSl <= 0) return 0;

  return Math.abs(entry - initialSl) / entry;
}

function calcRoundTripCostBreakdownR({
  position,
  exitPrice
} = {}) {
  const riskPct = calcRiskPctFromPosition(position);

  if (riskPct <= 0) {
    return {
      costR: 0,
      feeR: 0,
      slippageR: 0,
      marketImpactR: 0,
      spreadCostR: 0
    };
  }

  const cost = applyCosts({
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    source: OUTCOME_SOURCE,

    grossMovePct: calcGrossMovePctFromPosition({
      position,
      exitPrice
    }),

    riskPct,

    entrySpreadPct: safeNumber(
      position.spreadPct ??
      position.liveSpreadPct ??
      position.orderbookSpreadPct,
      0
    ),

    exitSpreadPct: safeNumber(
      position.exitSpreadPct ??
      position.spreadPct ??
      position.liveSpreadPct ??
      position.orderbookSpreadPct,
      0
    )
  });

  const feeR = riskPct > 0
    ? safeNumber(cost.feeRatio, 0) / riskPct
    : 0;

  const slippageR = riskPct > 0
    ? safeNumber(cost.slippageRatio, 0) / riskPct
    : 0;

  return {
    costR: round6(cost.costR),
    feeR: round6(feeR),
    slippageR: round6(slippageR),
    marketImpactR: 0,
    spreadCostR: round6(slippageR)
  };
}

function applyNetCostModelToOutcome({
  outcome,
  position,
  exitPrice
} = {}) {
  if (!outcome || typeof outcome !== 'object') return outcome;

  if (!isShortPosition(position) || !isShortPosition(outcome)) {
    return {
      ...outcome,
      skipped: true,
      reason: 'NON_SHORT_OUTCOME_COST_MODEL_REJECTED',
      source: OUTCOME_SOURCE,
      shortOnly: true,
      longDisabled: true,
      realTrade: false
    };
  }

  if (outcome.netCostModelApplied === true) {
    return forceShortPositionFields({
      ...outcome,
      source: OUTCOME_SOURCE,
      virtualOnly: true,
      virtualTracked: true,
      shadowOnly: false,
      realTrade: false,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true
    });
  }

  const grossR = safeNumber(
    outcome.grossR ??
    outcome.rawR ??
    outcome.realizedGrossR ??
    outcome.realizedR ??
    outcome.r,
    calcGrossRFromPosition({
      position,
      exitPrice
    })
  );

  const cost = calcRoundTripCostBreakdownR({
    position,
    exitPrice
  });

  const netR = grossR - cost.costR;

  return forceShortPositionFields({
    ...outcome,

    source: OUTCOME_SOURCE,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    grossR: round6(grossR),
    rawR: round6(grossR),
    realizedGrossR: round6(grossR),

    costR: cost.costR,
    avgCostR: cost.costR,
    feeR: cost.feeR,
    slippageR: cost.slippageR,
    marketImpactR: cost.marketImpactR,
    spreadCostR: cost.spreadCostR,

    netR: round6(netR),
    exitR: round6(netR),
    realizedNetR: round6(netR),
    realizedR: round6(netR),
    r: round6(netR),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,
    isWin: netR > 0,

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: COST_MODEL_VERSION
  });
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
    .filter(isShortPosition)
    .sort((a, b) => (
      safeNumber(a.openedAt || a.createdAt, 0) -
      safeNumber(b.openedAt || b.createdAt, 0)
    ));
}

export async function getOpenPosition(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return null;

  const row = await getJson(
    getDurableRedis(),
    KEYS.trade.open(keySymbol),
    null
  );

  if (!row) return null;
  if (!isShortPosition(row)) return null;

  return row;
}

export async function saveOpenPosition(position) {
  assertShortInput(position, 'SAVE_OPEN_POSITION');

  const keySymbol = storageSymbol(position);

  if (!keySymbol) {
    throw new Error('OPEN_POSITION_SYMBOL_MISSING');
  }

  const normalized = forceShortPositionFields(position);
  const identity = normalizeMicroIdentity(normalized);

  const row = forceShortPositionFields({
    ...normalized,
    ...identity,
    ...buildVirtualFlags(normalized),

    symbol: normalized.symbol || keySymbol,
    baseSymbol: normalized.baseSymbol || keySymbol,
    contractSymbol: normalized.contractSymbol || null,

    status: normalized.status || 'OPEN',

    strategyVersion: normalized.strategyVersion || CONFIG.strategyVersion,

    updatedAt: now()
  });

  assertPositionPersistable(row);

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

  if (!isShortPosition(position)) {
    position.updatedAt = now();
    position.shortOnly = true;
    position.longDisabled = true;
    position.liveManagementSkippedReason = 'NON_SHORT_POSITION_IGNORED';

    return position;
  }

  const current = safeNumber(price, 0);
  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const tp = safeNumber(position.tp, 0);

  if (entry <= 0 || initialSl <= 0 || tp <= 0 || current <= 0) {
    return forceShortPositionFields({
      ...position,
      updatedAt: now()
    });
  }

  const riskDist = Math.abs(entry - initialSl);
  const rewardDist = Math.abs(tp - entry);

  if (riskDist <= 0 || rewardDist <= 0) {
    return forceShortPositionFields({
      ...position,
      updatedAt: now()
    });
  }

  const directionalMove = entry - current;
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

  if (position.mfeR >= cfg.beArmR) {
    position.beArmed = true;

    if (currentR <= cfg.beLockR && !position.beWouldExit) {
      position.beWouldExit = true;
      position.beExitR = cfg.beLockR;
      position.beWouldExitAt = now();
    }
  }

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

  Object.assign(position, forceShortPositionFields(position));

  position.updatedAt = now();

  return position;
}

export function buildOpenPositionFromEntry(entry) {
  assertShortInput(entry, 'BUILD_OPEN_POSITION_FROM_ENTRY');

  const normalizedEntry = forceShortPositionFields(entry);
  const keySymbol = storageSymbol(normalizedEntry);
  const openedAt = now();
  const identity = normalizeMicroIdentity(normalizedEntry);

  const position = forceShortPositionFields({
    ...normalizedEntry,
    ...identity,
    ...buildVirtualFlags(normalizedEntry),

    tradeId: normalizedEntry.tradeId || randomId('trade'),

    symbol: normalizedEntry.symbol || keySymbol,
    baseSymbol: normalizedEntry.baseSymbol || keySymbol,
    contractSymbol: normalizedEntry.contractSymbol || null,

    status: 'OPEN',

    strategyVersion: normalizedEntry.strategyVersion || CONFIG.strategyVersion,

    openedAt,
    createdAt: openedAt,
    updatedAt: openedAt,

    initialSl: normalizedEntry.initialSl || normalizedEntry.sl,

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
  });

  assertPositionPersistable(position);

  return position;
}

async function markPriceFetchFailed(position) {
  position.priceFetchFailures = safeNumber(position.priceFetchFailures, 0) + 1;
  position.lastPriceFetchFailedAt = now();
  position.updatedAt = now();

  await saveOpenPosition(forceShortPositionFields(position));

  return position;
}

function enrichOutcomeIdentity(outcome = {}, position = {}) {
  const identity = normalizeMicroIdentity(position);

  return forceShortPositionFields({
    ...outcome,
    ...identity,

    source: OUTCOME_SOURCE,
    positionSource: position.source || POSITION_SOURCE,

    activeRotationId: position.activeRotationId || null,
    selectedRotationId: position.selectedRotationId || position.activeRotationId || null,

    activeMacroFamilyId:
      position.activeMacroFamilyId ||
      identity.parentMacroFamilyId ||
      null,

    selectedMacroFamilyId:
      position.selectedMacroFamilyId ||
      position.activeMacroFamilyId ||
      identity.parentMacroFamilyId ||
      null,

    selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
    discordAlertEligible: Boolean(position.discordAlertEligible),

    weeklyStats: position.weeklyStats || null,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    isTrueMicro: identity.isTrueMicro,
    isLegacyMacro: identity.isLegacyMacro,
    trueMicroOnly: true
  });
}

async function maybeSendExitAlert(position, outcome) {
  if (!position.discordAlertEligible && !position.selectedMicroFamilyAlert) {
    return {
      sent: false,
      skipped: true,
      reason: 'POSITION_NOT_SELECTED_FOR_DISCORD_EXIT_ALERT'
    };
  }

  try {
    await sendExitAlert(outcome);

    return {
      sent: true,
      skipped: false,
      reason: 'DISCORD_EXIT_ALERT_SENT'
    };
  } catch (error) {
    return {
      sent: false,
      skipped: false,
      failed: true,
      reason: 'DISCORD_EXIT_ALERT_FAILED',
      error: error?.message || String(error)
    };
  }
}

async function monitorOnePosition({
  position,
  priceFetcher,
  timestamp
}) {
  if (!isShortPosition(position)) {
    return {
      type: 'IGNORED_NON_SHORT',
      position,
      outcome: null
    };
  }

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
    position: forceShortPositionFields(position),
    exitPrice: price,
    exitReason: exit.reason,
    source: OUTCOME_SOURCE
  });

  const netOutcome = applyNetCostModelToOutcome({
    outcome: baseOutcome,
    position,
    exitPrice: price
  });

  const outcome = enrichOutcomeIdentity(netOutcome, position);

  const analyzeOutcome = clonePlainObject(outcome);
  const discordOutcome = clonePlainObject(outcome);

  await recordOutcome(analyzeOutcome, {
    source: OUTCOME_SOURCE
  });

  const discordResult = await maybeSendExitAlert(position, discordOutcome);

  await deleteOpenPosition(position.symbol || position.contractSymbol);

  return {
    type: 'EXIT',
    position,
    outcome: {
      ...discordOutcome,
      discordExitAlertResult: discordResult,
      discordExitAlertSent: Boolean(discordResult.sent)
    }
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