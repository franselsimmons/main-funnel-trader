// ================= FILE: src/trade/tradeSystem.js =================

import { createHash } from 'crypto';
import { CONFIG } from '../config.js';
import { KEYS, assertKeyAllowedForWriteScope } from '../keys.js';
import { getDurableRedis, getVolatileRedis, getJson, setJson, getKeys } from '../redis.js';
import {
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { analyzeCandidatesBatch } from '../analyze/analyzeEngine.js';
import { getActiveRotation } from '../analyze/rotationEngine.js';
import {
  buildOpenPositionFromEntry,
  getOpenPositions,
  saveOpenPosition,
  monitorOpenPositions
} from './positionEngine.js';
import { riskFractionForEntry } from './positionSizing.js';
import { sendEntryAlert } from '../discord/discord.js';
const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';
const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_75_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';
const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;
const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;
const LAYER_MICRO_MICRO = 'MICRO_MICRO';
const SELECTION_EXACT_MICRO_MICRO = 'EXACT_MICRO_MICRO';
const ENTRY_RELAXATION_PROFILE = 'SHORT_SCANNER_WIDE_VIRTUAL_LEARNING_V2';
const QUALITY_MEASUREMENT_PROFILE = 'SHORT_MICRO_MICRO_RR_GRID_TP_SL_LEARNING_V1';
const SHORT_RISK_PLAN_VERSION = 'SHORT_COST_AWARE_RR_SHADOW_GRID_V1';
const RR_SHADOW_GRID_VERSION = 'SHORT_RR_SHADOW_GRID_1_125_15_175_2_V1';
const MICRO_MICRO_VERSION = 'SHORT_PARENT_MICRO_MICRO_LAYERING_V2';
const DEFAULT_RR_VARIANTS = Object.freeze([1.0, 1.25, 1.5, 1.75, 2.0]);
const DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT = 8;
const DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT = 10;
const DEFAULT_DATA_CONCURRENCY = 2;
const DEFAULT_MAX_SNAPSHOT_AGE_SEC = 8 * 60;
const DEFAULT_MIN_RISK_PCT = 0.0045;
const DEFAULT_MAX_RISK_PCT = 0.035;
const DEFAULT_FALLBACK_RISK_PCT = 0.0065;
const DEFAULT_RR = 1.5;
const DEFAULT_MIN_RR = 1.0;
const DEFAULT_MAX_RR = 2.0;
const DEFAULT_MIN_REWARD_PCT = 0.0075;
const DEFAULT_MIN_DISCORD_REWARD_PCT = 0.01;
const DEFAULT_MAX_RISK_TO_REWARD_DISTANCE_RATIO = 1.05;
const DEFAULT_MAX_ESTIMATED_COST_R = 0.35;
const DEFAULT_HARD_MAX_ESTIMATED_COST_R = 0.55;
const DEFAULT_ROUND_TRIP_FEE_PCT = 0.0012;
const DEFAULT_ROUND_TRIP_SLIPPAGE_PCT = 0.0004;
const DEFAULT_FALLBACK_SPREAD_PCT = 0.0008;
const DEFAULT_SPREAD_COST_MULT = 1;
const DEFAULT_DISCORD_REQUIRE_CURRENT_FIT = true;
const DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE = 35;
const DEFAULT_CURRENT_FIT_MAX_WEATHER_AGE_SEC = 15 * 60;
const DEFAULT_MONITOR_TIMEOUT_MS = 2500;
const DEFAULT_MONITOR_PRICE_FETCH_TIMEOUT_MS = 800;
const DEFAULT_CANDIDATE_TIMEOUT_MS = 1800;
const DEFAULT_ANALYZE_TIMEOUT_MS = 3500;
const DEFAULT_ROTATION_TIMEOUT_MS = 800;
const DEFAULT_MARKET_CONTEXT_TIMEOUT_MS = 800;
const DEFAULT_MAX_RUNTIME_MS = 24000;
const DEFAULT_OPEN_POSITION_LOAD_TIMEOUT_MS = 900;
const DEFAULT_SAVE_POSITION_TIMEOUT_MS = 1200;
const DEFAULT_MONITOR_BATCH_SIZE = 40;
const DEFAULT_OPEN_POSITION_MONITOR_LIMIT = 80;
const DEFAULT_MIN_ENTRY_LOOP_ATTEMPTS = 3;
const DEFAULT_ENTRY_LOOP_RESERVE_MS = 900;
const BITGET_BASE_URL = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const LIVE_PRICE_CACHE_TTL_MS = 2500;
const livePriceCache = new Map();
const MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const SETUP_ORDER = Object.freeze(['BREAKOUT', 'RETEST', 'SWEEP_REVERSAL', 'CONTINUATION', 'COMPRESSION']);
const REGIME_ORDER = Object.freeze(['TREND', 'CHOP', 'SQUEEZE']);
const CONFIRMATION_PROFILE_ORDER = Object.freeze(['A_STRONG_ALIGN', 'B_FLOW_ALIGN', 'C_VOLUME_ALIGN', 'D_MIXED_OK', 'E_WEAK_CONTRA']);
const SHORT_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const SHORT_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);
const SHORT_TOKENS = new Set(['SHORT', 'BEAR', 'BEARISH', 'SELL', 'ASK', 'DOWN', 'DOWNSIDE', 'RED']);
const LONG_TOKENS = new Set(['LONG', 'BULL', 'BULLISH', 'BUY', 'BID', 'UP', 'UPSIDE', 'GREEN']);
const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);
let ACTIVE_RUN_OPTIONS = {};
function now() { return Date.now(); }
function upper(value, fallback = '') { const s = String(value ?? '').trim(); return s ? s.toUpperCase() : fallback; }
function n(value, fallback = 0) { const x = safeNumber(value, fallback); return Number.isFinite(x) ? x : fallback; }
function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  return fallback;
}
function first(...values) { return values.find((v) => v !== undefined && v !== null && v !== ''); }
function int(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) { return Math.max(min, Math.min(max, Math.floor(n(value, fallback)))); }
function clamp(value, min, max) { const x = Number(value); return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : min; }
function round(value, d = 8) { return Number(n(value, 0).toFixed(d)); }
function roundPrice(value) { const x = n(value, 0); if (x >= 1000) return Number(x.toFixed(2)); if (x >= 1) return Number(x.toFixed(6)); return Number(x.toFixed(10)); }
function pct(part, total) { const t = n(total, 0); return t > 0 ? Number(((n(part, 0) / t) * 100).toFixed(2)) : 0; }
function timeoutPayload(label, ms) { return new Promise((resolve) => setTimeout(() => resolve({ __timeout: true, label, timeoutMs: ms }), Math.max(1, int(ms, 1)))); }
async function withTimeout(promise, ms, label) { return Promise.race([promise, timeoutPayload(label, ms)]); }
function isTimeoutResult(value) { return Boolean(value && typeof value === 'object' && value.__timeout === true); }
function runtimeExceeded(startedAt, cfg, reserveMs = 1000) { return now() - n(startedAt, now()) >= Math.max(1000, n(cfg.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS) - reserveMs); }
function namespacedShortKey(key, fallback = 'UNKNOWN') {
  const raw = String(key || fallback || '').trim();
  if (!raw) return `${SHORT_KEY_PREFIX}${fallback}`;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;
  return `${SHORT_KEY_PREFIX}${raw}`;
}
function keyFromMaybeFunction(fn, arg, fallback) { try { return typeof fn === 'function' ? fn(arg) : fallback; } catch { return fallback; } }
function shortScanSnapshotKey(id) {
  return namespacedShortKey(
    keyFromMaybeFunction(KEYS.short?.scan?.snapshot, id, null) ||
    keyFromMaybeFunction(KEYS.scan?.shortSnapshot, id, null) ||
    keyFromMaybeFunction(KEYS.scan?.snapshot, id, null),
    `SCAN:SNAPSHOT:${id}`
  );
}
const SHORT_KEYS = {
  scan: { latest: namespacedShortKey(KEYS.short?.scan?.latest || KEYS.scan?.shortLatest || KEYS.scan?.latest, 'SCAN:LATEST'), snapshot: shortScanSnapshotKey },
  trade: {
    runMeta: namespacedShortKey(KEYS.short?.trade?.runMeta || KEYS.trade?.shortRunMeta || KEYS.trade?.runMeta, 'TRADE:RUN_META'),
    lastProcessedSnapshot: namespacedShortKey(KEYS.short?.trade?.lastProcessedSnapshot || KEYS.trade?.shortLastProcessedSnapshot || KEYS.trade?.lastProcessedSnapshot, 'TRADE:LAST_PROCESSED_SNAPSHOT')
  }
};
function sideFlags() {
  return {
    sideMode: 'SHORT_ONLY', targetTradeSide: TARGET_TRADE_SIDE, targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE, oppositeTradeSide: OPPOSITE_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE, tradeSide: TARGET_TRADE_SIDE, positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE, signalSide: TARGET_TRADE_SIDE, entrySide: TARGET_TRADE_SIDE,
    scannerSide: TARGET_SCANNER_SIDE, actualScannerSide: TARGET_SCANNER_SIDE, analysisSide: TARGET_TRADE_SIDE,
    shortOnly: true, longDisabled: true, longOnly: false, shortDisabled: false
  };
}
function isolationFlags() {
  return {
    namespace: SHORT_NAMESPACE, redisNamespace: SHORT_NAMESPACE, keyPrefix: SHORT_KEY_PREFIX, redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY, redisKeysSeparatedFromLongRoot: true, longRootTouched: false,
    scannerRunAllowed: false, noScannerRun: true, writesScanner: false, writesTrade: true, writesAnalyze: true,
    analyzePartialOnly: true, analyzeFullOverwriteDisabled: true, writesRotation: false, writesManualSelection: false,
    writesDiscordSelection: false, preserveRotation: true, preserveManualSelection: true, preserveDiscordSelection: true,
    realOrdersDisabled: true, exchangeCallsDisabled: true, exchangeOrdersDisabled: true, bitgetOrdersDisabled: true,
    noRealOrders: true, noExchangeOrders: true, globalMaxOpenPositionsBlockDisabled: true, oneOpenPositionPerSymbol: true,
    monitorOpenPositionsBeforeEntries: true, monitorTimeoutDoesNotBlockEntries: true
  };
}
function virtualFlags(row = {}) {
  return {
    virtualOnly: true, virtualTracked: true, virtualLearning: true, source: 'VIRTUAL', outcomeSource: 'VIRTUAL',
    paperTrade: true, paperPosition: true, realTrade: false, realOrder: false, exchangeOrder: false,
    bitgetOrderPlaced: false, noRealOrders: true, noExchangeOrders: true,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION, rrShadowGridEnabled: true, rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    rrVariants: row.rrVariants || DEFAULT_RR_VARIANTS,
    scannerFingerprintRole: 'METADATA_ONLY', scannerFingerprintsMetadataOnly: true, scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true, legacy25BucketsMetadataOnly: true,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE', executionFingerprintsMetadataOnly: false, executionFingerprintsUsedAsLearningFamily: true,
    analyzeMicroFamiliesOnly: true, learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED', symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true, hashesExcludedFromFamilyId: true,
    currentFitSoftOnly: true, currentFitBlocksLearning: false, currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE', currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    discordOnlyForExactMicroMicroMatch: true, discordOnlyForExactTrueMicroMatch: false, manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ONLY',
    parentMatchDoesNotTriggerDiscord: true, child75MatchDoesNotTriggerDiscord: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES', scoringRSource: 'netR', winsLossesFlatsSource: 'netR', winrateDefinition: 'netR > 0',
    avgRSource: 'netR', totalRSource: 'netR', avgCostRShown: true,
    riskTradeSide: TARGET_TRADE_SIDE, validShortRiskShape: true, shortRiskShape: 'tp < entry < sl', riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp', slHitRule: 'SHORT: price >= sl', grossRFormula: '(entry - exitPrice) / (initialSl - entry)', currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA, parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA, childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA, trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY, parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY, microMicroVersion: MICRO_MICRO_VERSION,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY'
  };
}
function cleanSideText(value = '') {
  return upper(value, '')
    .replaceAll('LONG_DISABLED_TRUE', 'SHORT').replaceAll('LONGDISABLED_TRUE', 'SHORT').replaceAll('BLOCK_LONG_TRUE', 'SHORT')
    .replaceAll('LONG_DISABLED_FALSE', '').replaceAll('LONGDISABLED_FALSE', '').replaceAll('BLOCK_LONG_FALSE', '')
    .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG').replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG').replaceAll('BLOCK_SHORT', 'LONG')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT').replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT').replaceAll('BLOCK_LONG', 'SHORT')
    .replaceAll('LONG_DISABLED', 'SHORT').replaceAll('LONGDISABLED', 'SHORT')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT').replaceAll('SHORT_ONLY', 'SHORT').replaceAll('SHORT-ONLY', 'SHORT')
    .replaceAll('LONG_ONLY_MODE', 'LONG').replaceAll('LONG_ONLY', 'LONG').replaceAll('LONG-ONLY', 'LONG');
}

function normalizedSignalText(value = '') {
  return cleanSideText(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function hasSignalPattern(value = '', patterns = []) {
  const text = normalizedSignalText(value);
  if (!text) return false;
  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`) ||
    text.includes(`=${pattern}`) ||
    text.includes(`:${pattern}`)
  ));
}
function hasShortSignal(value = '') {
  const raw = normalizedSignalText(value);
  if (!raw) return false;
  if (SHORT_TOKENS.has(raw)) return true;
  return hasSignalPattern(raw, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'SIDE_SHORT',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'SIDE_BEAR',
    'TRADE_SIDE_BEAR',
    'DIRECTION_BEAR',
    'SIDE_SELL',
    'DIRECTION_SELL',
    'MICRO_SHORT',
    'FAMILY_SHORT'
  ]);
}
function hasLongSignal(value = '') {
  const raw = normalizedSignalText(value);
  if (!raw) return false;
  if (LONG_TOKENS.has(raw)) return true;
  return hasSignalPattern(raw, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'SIDE_LONG',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'SIDE_BULL',
    'TRADE_SIDE_BULL',
    'DIRECTION_BULL',
    'SIDE_BUY',
    'DIRECTION_BUY',
    'MICRO_LONG',
    'FAMILY_LONG'
  ]);
}
function isScannerFingerprintId(id = '') {
  const value = upper(id);
  return (
    value.startsWith('MICRO_SHORT_SCANNER__') ||
    value.includes('MICRO_SHORT_SCANNER__') ||
    value.startsWith('SHORT_SCANNER_') ||
    value.includes('SHORT_SCANNER_') ||
    value.startsWith('MICRO_LONG_SCANNER__') ||
    value.includes('MICRO_LONG_SCANNER__') ||
    value.startsWith('LONG_SCANNER_') ||
    value.includes('LONG_SCANNER_') ||
    value.includes('__SCANNER__') ||
    value.includes('SCANNER_GATE_PASS') ||
    value.includes('SCANNER_GATE_FAIL')
  );
}
function isExecutionFingerprintId(id = '') {
  const value = upper(id);
  return (
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
    value.includes(`__${EXECUTION_MICRO_SUFFIX}__`) ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}
function normalizeTradeSide(side) {
  const raw = cleanSideText(side);
  if (!raw) return 'UNKNOWN';
  const direct = sideToTradeSide(raw);
  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && longHit) {
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('TRADESIDE=SHORT') || raw.includes('TRADE_SIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADESIDE=LONG') || raw.includes('TRADE_SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  }
  return 'UNKNOWN';
}
function inferRowTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) return normalizeTradeSide(row);
  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.signalSide,
    row.entrySide,
    row.side
  ];
  for (const value of directSources) {
    const side = normalizeTradeSide(value);
    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }
  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.executionMicroFamilyId,
    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.parentTrueMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.id,
    row.key,
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');
  const shortHit = hasShortSignal(haystack);
  const longHit = hasLongSignal(haystack);
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && longHit) {
    if (haystack.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('TRADESIDE=SHORT') || haystack.includes('TRADE_SIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADESIDE=LONG') || haystack.includes('TRADE_SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  }
  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;
  return 'UNKNOWN';
}
function isTargetRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}
function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);
  if (!value.startsWith('MICRO_SHORT_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId
    };
  }
  let baseValue = value;
  let microMicroHash = null;
  let microMicroFamilyId = null;
  const microMicroMatch = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,24})$/u.exec(value);
  if (microMicroMatch) {
    baseValue = microMicroMatch[1];
    microMicroHash = microMicroMatch[2].slice(0, MICRO_MICRO_HASH_LEN);
  }
  let body = baseValue.slice('MICRO_SHORT_'.length);
  let confirmationProfile = null;
  for (const profile of CONFIRMATION_PROFILE_ORDER) {
    const suffix = `_${profile}`;
    if (body.endsWith(suffix)) {
      confirmationProfile = profile;
      body = body.slice(0, -suffix.length);
      break;
    }
  }
  let setup = null;
  let regime = null;
  for (const candidateRegime of REGIME_ORDER) {
    const suffix = `_${candidateRegime}`;
    if (body.endsWith(suffix)) {
      regime = candidateRegime;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }
  const parentId = setup && regime ? `MICRO_SHORT_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;
  const validParent =
    Boolean(parentId) &&
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime);
  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmationProfile);
  if (validChild && microMicroHash) {
    microMicroFamilyId = `${childId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`;
  }
  const isMicroMicro = Boolean(microMicroFamilyId);
  const isChild = validChild && !isMicroMicro;
  const isParent = validParent && !validChild && !isMicroMicro;
  return {
    valid: validParent || validChild || isMicroMicro,
    selectable: isChild || isMicroMicro,
    isParent,
    isChild,
    isMicroMicro,
    rawId,
    id: microMicroFamilyId || childId || parentId || value,
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    trueMicroFamilyId: isMicroMicro ? microMicroFamilyId : validChild ? childId : validParent ? parentId : null,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,
    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningGranularity: isMicroMicro ? MICRO_MICRO_LEARNING_GRANULARITY : isParent ? PARENT_LEARNING_GRANULARITY : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
  };
}
function isSelectableTrueMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild === true;
}
function isSelectableMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}
function isParentTrueMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}
function parentIdFromChild(id = '') {
  return parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId || '';
}
function childIdFromAnyLearningId(id = '') {
  return parseShortTaxonomyMicroId(id).childTrueMicroFamilyId || '';
}
function microMicroHashFromId(id = '') {
  return parseShortTaxonomyMicroId(id).microMicroHash || '';
}
function hashText(value, length = EXECUTION_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, length);
}
function normalizeBucketText(value, fallback = 'NA') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || fallback;
}
function normalizeSymbolToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function symbolTokensFromAnySymbol(symbol = '') {
  const contract = normalizeContractSymbol(symbol);
  const base = normalizeBaseSymbol(symbol || contract);
  return [
    symbol,
    contract,
    base,
    normalizeSymbolToken(symbol),
    normalizeSymbolToken(contract),
    normalizeSymbolToken(base)
  ]
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);
}
function symbolKey(value = '') {
  const base = normalizeBaseSymbol(value);
  const contract = normalizeContractSymbol(value);
  const token = normalizeSymbolToken(value);
  return normalizeSymbolToken(base || contract || token);
}
function rowSymbolKeys(row = {}) {
  return [
    row.symbol,
    row.baseSymbol,
    row.contractSymbol
  ]
    .flatMap((value) => symbolTokensFromAnySymbol(value))
    .map(symbolKey)
    .filter(Boolean);
}
function cleanLearningFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim().toUpperCase();
  if (!raw) return '';
  if (isScannerFingerprintId(raw)) return '';
  if (isExecutionFingerprintId(raw)) return '';
  const tokens = [
    row.symbol,
    row.baseSymbol,
    row.contractSymbol
  ]
    .map(normalizeSymbolToken)
    .filter(Boolean)
    .filter((token) => token.length >= 2);
  let clean = raw;
  if (!isSelectableTrueMicroId(clean) && !isSelectableMicroMicroId(clean) && !isParentTrueMicroId(clean)) {
    for (const token of tokens) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      clean = clean
        .replace(new RegExp(`(^|[_|:=\\-])${escaped}([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
        .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDT([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
        .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDC([_|:=\\-]|$)`, 'gi'), '$1ASSET$2');
    }
  }
  clean = clean
    .replace(/_{2,}/g, '_')
    .replace(/\|{2,}/g, '|')
    .replace(/^[_|:=\-\s]+|[_|:=\-\s]+$/g, '');
  if (!clean) return '';
  if (isScannerFingerprintId(clean)) return '';
  if (isExecutionFingerprintId(clean)) return '';
  return clean.toUpperCase();
}
function buildExecutionFingerprintParts(row = {}, childTrueMicroFamilyId = '') {
  const parsed = parseShortTaxonomyMicroId(childTrueMicroFamilyId);
  const parentId = parsed.parentTrueMicroFamilyId || row.parentTrueMicroFamilyId || parentIdFromChild(childTrueMicroFamilyId);
  return [
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${childTrueMicroFamilyId || 'NO_TRUE_MICRO'}`,
    `PARENT_TRUE_MICRO=${parentId || 'NO_PARENT_TRUE_MICRO'}`,
    `SETUP=${parsed.setup || row.setupType || 'NA'}`,
    `REGIME_BUCKET=${parsed.regime || row.regimeBucket || 'NA'}`,
    `CONFIRMATION_PROFILE=${parsed.confirmationProfile || row.confirmationProfile || 'NA'}`,
    `RSI=${normalizeBucketText(row.rsiZone || row.rsiCoarse || 'NA')}`,
    `FLOW=${normalizeBucketText(row.flowCoarse || row.flow || 'NA')}`,
    `OB_REL=${normalizeBucketText(row.obRelation || 'NA')}`,
    `BTC_STATE=${normalizeBucketText(row.btcState || 'NA')}`,
    `BTC_REL=${normalizeBucketText(row.btcRelation || 'NA')}`,
    `REGIME=${normalizeBucketText(row.regimeCoarse || row.regime || row.regimeBucket || 'NA')}`,
    `SCANNER=${normalizeBucketText(row.scannerReasonCoarse || row.scannerReason || row.reason || 'NA')}`,
    `SPREAD_BPS=${normalizeBucketText(row.spreadBps ?? row.spreadPct ?? 'NA')}`,
    `DEPTH=${normalizeBucketText(row.depthMinUsd1p ?? 'NA')}`,
    `RR=${normalizeBucketText(row.rr ?? row.riskReward ?? 'NA')}`,
    `CONFLUENCE=${normalizeBucketText(row.confluence ?? row.sniperScore ?? row.scannerScore ?? 'NA')}`,
    `ENTRY_QUALITY=${normalizeBucketText(row.entryQuality || 'NA')}`,
    `ENTRY_DIST=${normalizeBucketText(row.entryDistancePct ?? row.entryDistanceBps ?? 'NA')}`,
    `RISK_PCT=${normalizeBucketText(row.riskPct ?? row.slDistancePct ?? 'NA')}`,
    `REWARD_PCT=${normalizeBucketText(row.rewardPct ?? row.tpDistancePct ?? 'NA')}`,
    `RISK_REWARD_RATIO=${normalizeBucketText(row.riskToRewardDistanceRatio ?? 'NA')}`,
    `FAKE_BREAKOUT=${row.fakeBreakout === true ? 'YES' : 'NO'}`,
    `FAKE_RISK=${row.fakeBreakoutRisk === true ? 'YES' : 'NO'}`,
    `RISK_PLAN=${row.riskPlanVersion || SHORT_RISK_PLAN_VERSION}`,
    'EXECUTION_FINGERPRINT_ROLE=MICRO_MICRO_HASH_SOURCE'
  ];
}
function executionHashFromRow(row = {}, childTrueMicroFamilyId = '') {
  const direct = String(
    row.microMicroHash ||
    row.executionFingerprintHash ||
    row.executionHash ||
    ''
  ).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
  if (direct.length >= 6) return direct.slice(0, MICRO_MICRO_HASH_LEN);
  const executionId = String(
    row.executionMicroFamilyId ||
    row.executionFingerprintMicroFamilyId ||
    row.refinedExecutionMicroFamilyId ||
    ''
  ).trim().toUpperCase();
  const xrMatch = /^(MICRO_SHORT_.+)_XR_([A-Z0-9]{6,24})$/u.exec(executionId);
  if (xrMatch) return xrMatch[2].slice(0, MICRO_MICRO_HASH_LEN);
  return hashText(buildExecutionFingerprintParts(row, childTrueMicroFamilyId).join('|'), EXECUTION_MICRO_HASH_LEN);
}
function buildMicroMicroFamilyIdFromExecution(childTrueMicroFamilyId, executionFingerprintHash) {
  const childId = childIdFromAnyLearningId(childTrueMicroFamilyId) || (
    isSelectableTrueMicroId(childTrueMicroFamilyId)
      ? upper(childTrueMicroFamilyId)
      : ''
  );
  const hash = String(executionFingerprintHash || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, MICRO_MICRO_HASH_LEN);
  if (!childId || hash.length < 6) return '';
  return `${childId}_${MICRO_MICRO_SUFFIX}_${hash}`;
}
function getTrueMicroFamilyId(row = {}) {
  const candidates = [
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId
  ].map((id) => cleanLearningFamilyId(id, row));
  for (const candidate of candidates) {
    const parsed = parseShortTaxonomyMicroId(candidate);
    if (parsed.isChild && parsed.childTrueMicroFamilyId) return parsed.childTrueMicroFamilyId;
    if (parsed.isMicroMicro && parsed.childTrueMicroFamilyId) return parsed.childTrueMicroFamilyId;
  }
  return '';
}
function getMicroMicroFamilyId(row = {}) {
  const direct = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.learningMicroFamilyId
  ]
    .map((id) => cleanLearningFamilyId(id, row))
    .find((id) => isSelectableMicroMicroId(id));
  if (direct) return direct;
  const child = getTrueMicroFamilyId(row);
  if (!child) return '';
  const executionHash = executionHashFromRow(row, child);
  const microMicroId = buildMicroMicroFamilyIdFromExecution(child, executionHash);
  return isSelectableMicroMicroId(microMicroId) ? microMicroId : '';
}
function getParentTrueMicroFamilyId(row = {}) {
  const child = getTrueMicroFamilyId(row);
  if (child) return parentIdFromChild(child);
  return [
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.parentMicroFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId
  ]
    .map((id) => cleanLearningFamilyId(id, row))
    .find((id) => isParentTrueMicroId(id)) || '';
}
function normalizeCandidate(candidate = {}) {
  const contractSymbol = normalizeContractSymbol(candidate.contractSymbol || candidate.symbol);
  const symbol = normalizeBaseSymbol(candidate.symbol || contractSymbol) || normalizeBaseSymbol(contractSymbol);
  return {
    ...candidate,
    symbol,
    baseSymbol: symbol,
    contractSymbol
  };
}
function scannerMetadataFrom(...rows) {
  const merged = Object.assign({}, ...rows.filter(Boolean));
  const childTrueMicroFamilyId = getTrueMicroFamilyId(merged);
  const microMicroFamilyId = getMicroMicroFamilyId({ ...merged, childTrueMicroFamilyId });
  const microMicroHash = microMicroHashFromId(microMicroFamilyId) || executionHashFromRow(merged, childTrueMicroFamilyId);
  return {
    scannerMicroFamilyId: merged.scannerMicroFamilyId || null,
    scannerFamilyId: merged.scannerFamilyId || null,
    scannerDefinition: merged.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(merged.scannerDefinitionParts) ? merged.scannerDefinitionParts : [],
    executionFingerprintHash: microMicroHash || merged.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(merged.executionFingerprintParts)
      ? merged.executionFingerprintParts
      : childTrueMicroFamilyId
        ? buildExecutionFingerprintParts(merged, childTrueMicroFamilyId)
        : [],
    executionMicroFamilyId: childTrueMicroFamilyId && microMicroHash
      ? `${childTrueMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${microMicroHash}`
      : merged.executionMicroFamilyId || null,
    executionFingerprintRole: microMicroFamilyId ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: !microMicroFamilyId,
    executionFingerprintsMetadataOnly: !microMicroFamilyId,
    executionFingerprintsUsedAsLearningFamily: Boolean(microMicroFamilyId),
    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,
    microMicroHash: microMicroHash || null,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroVersion: MICRO_MICRO_VERSION,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true
  };
}
function setupFromRow(row = {}) {
  const existing = parseShortTaxonomyMicroId(
    row.trueMicroFamilyId ||
    row.childTrueMicroFamilyId ||
    row.microFamilyId ||
    row.microMicroFamilyId ||
    ''
  );
  if (existing.setup && SHORT_FIXED_SETUP_TYPES.has(existing.setup)) return existing.setup;
  const text = upper([
    row.scannerReason,
    row.reason,
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : [])
  ].filter(Boolean).join('|'));
  if (text.includes('BREAKOUT') || text.includes('BREAKDOWN')) return 'BREAKOUT';
  if (text.includes('SWEEP')) return 'SWEEP_REVERSAL';
  if (text.includes('RETEST') || text.includes('PULLBACK')) return 'RETEST';
  if (text.includes('SQUEEZE') || text.includes('COMPRESSION')) return 'COMPRESSION';
  return 'CONTINUATION';
}
function normalizeMarketRegime(value = '') {
  const text = upper(value);
  if (text.includes('SQUEEZE') || text.includes('COMPRESS')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAY')) return 'CHOP';
  if (text.includes('TREND') || text.includes('MOMENTUM') || text.includes('DIRECTION')) return 'TREND';
  return 'UNKNOWN';
}
function normalizeMarketTrendSide(value = '') {
  const side = normalizeTradeSide(value);
  if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  const text = upper(value);
  if (text.includes('NEUTRAL') || text.includes('MIXED') || text.includes('FLAT')) return 'NEUTRAL';
  if (text.includes('BEAR') || text.includes('RISK_OFF')) return TARGET_TRADE_SIDE;
  if (text.includes('BULL') || text.includes('RISK_ON')) return OPPOSITE_TRADE_SIDE;
  return 'UNKNOWN';
}
function regimeFromRow(row = {}, marketContext = {}) {
  const existing = parseShortTaxonomyMicroId(
    row.trueMicroFamilyId ||
    row.childTrueMicroFamilyId ||
    row.microFamilyId ||
    row.microMicroFamilyId ||
    ''
  );
  if (existing.regime && SHORT_FIXED_REGIME_BUCKETS.has(existing.regime)) return existing.regime;
  const direct = normalizeMarketRegime(
    row.regimeBucket ||
    row.currentRegime ||
    row.regime ||
    row.btcRegime ||
    marketContext.regime
  );
  return direct !== 'UNKNOWN' ? direct : 'TREND';
}
function confirmationFromRow(row = {}, marketContext = {}) {
  const existing = parseShortTaxonomyMicroId(
    row.trueMicroFamilyId ||
    row.childTrueMicroFamilyId ||
    row.microFamilyId ||
    row.microMicroFamilyId ||
    ''
  );
  if (existing.confirmationProfile && SHORT_CONFIRMATION_PROFILES.has(existing.confirmationProfile)) {
    return existing.confirmationProfile;
  }
  const text = upper([
    row.scannerReason,
    row.reason,
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : [])
  ].filter(Boolean).join('|'));
  const fitScore = n(row.currentFitScore ?? row.entryCurrentFitScore, 0);
  const fitConfidence = n(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0);
  const scannerScore = n(row.scannerScore ?? row.moveScore, 0);
  const volumeExpansion = n(row.volumeExpansion, 0);
  if (text.includes('FAKE_RISK') || row.fakeBreakoutRisk === true || fitScore < -20) return 'E_WEAK_CONTRA';
  if (fitScore >= 45 && fitConfidence >= 50 && scannerScore >= 70) return 'A_STRONG_ALIGN';
  if (fitScore >= 20 || marketContext?.trendSide === TARGET_TRADE_SIDE) return 'B_FLOW_ALIGN';
  if (volumeExpansion >= 1.4 || text.includes('VOL_EXP')) return 'C_VOLUME_ALIGN';
  if (text.includes('WEAK') || text.includes('CONTRA')) return 'E_WEAK_CONTRA';
  return 'D_MIXED_OK';
}
function fallbackExact75Id(row = {}, marketContext = {}) {
  const existing = getTrueMicroFamilyId(row);
  if (existing) return existing;
  const setup = setupFromRow(row);
  const regime = regimeFromRow(row, marketContext);
  const confirmation = confirmationFromRow(row, marketContext);
  return `MICRO_SHORT_${setup}_${regime}_${confirmation}`;
}
function normalizeExactTrueMicroRow(row = {}, marketContext = {}) {
  const trueMicroFamilyId = fallbackExact75Id(row, marketContext);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);
  if (!parsed.isChild) {
    return {
      ...row,
      exact75ChildTrueMicro: false,
      trueMicroFamilyId: null,
      microFamilyId: null,
      childTrueMicroFamilyId: null,
      microMicroFamilyId: null,
      trueMicroMicroFamilyId: null,
      exactMicroMicroFamilyId: null,
      parentTrueMicroFamilyId: getParentTrueMicroFamilyId(row) || null,
      exactTrueMicroMissingReason: 'EXACT_75_CHILD_TRUE_MICRO_REQUIRED'
    };
  }
  const executionHash = executionHashFromRow(
    {
      ...row,
      childTrueMicroFamilyId: trueMicroFamilyId
    },
    trueMicroFamilyId
  );
  const microMicroFamilyId = getMicroMicroFamilyId({
    ...row,
    childTrueMicroFamilyId: trueMicroFamilyId,
    executionFingerprintHash: executionHash
  });
  return {
    ...row,
    ...sideFlags(),
    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,
    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,
    microMicroHash: microMicroHashFromId(microMicroFamilyId) || executionHash || null,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: trueMicroFamilyId,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    exact75ChildTrueMicro: true,
    exactMicroMicro: Boolean(microMicroFamilyId),
    fixedTaxonomyLearningId: true,
    executionFingerprintHash: executionHash || row.executionFingerprintHash || null,
    executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
      ? row.executionFingerprintParts
      : buildExecutionFingerprintParts(row, trueMicroFamilyId),
    executionMicroFamilyId: executionHash
      ? `${trueMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionHash}`
      : row.executionMicroFamilyId || null,
    executionFingerprintRole: microMicroFamilyId ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: !microMicroFamilyId,
    executionFingerprintsUsedAsLearningFamily: Boolean(microMicroFamilyId),
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroVersion: MICRO_MICRO_VERSION
  };
}
function uniqueStrings(values = []) {
  const output = [];
  const stack = Array.isArray(values) ? [...values] : [values];
  while (stack.length) {
    const value = stack.shift();
    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }
    if (typeof value === 'string') {
      for (const part of value.split(/[\s,;\n\r]+/g)) {
        const clean = part.trim();
        if (clean && !output.includes(clean)) output.push(clean);
      }
      continue;
    }
    const clean = String(value || '').trim();
    if (clean && !output.includes(clean)) output.push(clean);
  }
  return output;
}
function buildShortTpSlPlan({
  entry,
  riskPct,
  rr,
  cfg = tradeConfig()
} = {}) {
  const entryPrice = n(entry, 0);
  const cleanRR = clamp(
    rr,
    Math.max(n(cfg.minRR, DEFAULT_MIN_RR), DEFAULT_MIN_RR),
    n(cfg.maxRR, DEFAULT_MAX_RR)
  );
  const cleanRiskPct = clamp(
    riskPct,
    Math.max(0.0005, n(cfg.minRiskPct, DEFAULT_MIN_RISK_PCT)),
    Math.max(n(cfg.minRiskPct, DEFAULT_MIN_RISK_PCT), n(cfg.maxRiskPct, DEFAULT_MAX_RISK_PCT))
  );
  const rewardPct = cleanRiskPct * cleanRR;
  const sl = entryPrice * (1 + cleanRiskPct);
  const tp = Math.max(entryPrice * (1 - rewardPct), entryPrice * 0.0001);
  const actualRiskPct = entryPrice > 0 ? (sl - entryPrice) / entryPrice : 0;
  const actualRewardPct = entryPrice > 0 ? (entryPrice - tp) / entryPrice : 0;
  const actualRR = actualRiskPct > 0 ? actualRewardPct / actualRiskPct : 0;
  return {
    entry: roundPrice(entryPrice),
    sl: roundPrice(sl),
    initialSl: roundPrice(sl),
    tp: roundPrice(tp),
    rr: round(actualRR, 4),
    riskPct: round(actualRiskPct, 8),
    rewardPct: round(actualRewardPct, 8),
    riskDistance: sl - entryPrice,
    rewardDistance: entryPrice - tp,
    riskToRewardDistanceRatio: actualRewardPct > 0
      ? round(actualRiskPct / actualRewardPct, 6)
      : 999,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION
  };
}
function tradeConfig() {
  const options = ACTIVE_RUN_OPTIONS || {};
  const minRiskPct = n(first(
    options.minRiskPct,
    CONFIG.short?.trade?.minRiskPct,
    CONFIG.trade?.shortMinRiskPct,
    CONFIG.trade?.minRiskPct
  ), DEFAULT_MIN_RISK_PCT);
  const maxRiskPct = n(first(
    options.maxRiskPct,
    CONFIG.short?.trade?.maxRiskPct,
    CONFIG.trade?.shortMaxRiskPct,
    CONFIG.trade?.maxRiskPct
  ), DEFAULT_MAX_RISK_PCT);
  const maxEstimatedCostR = n(first(
    options.maxEstimatedCostR,
    CONFIG.short?.trade?.maxEstimatedCostR,
    CONFIG.trade?.shortMaxEstimatedCostR,
    CONFIG.trade?.maxEstimatedCostR
  ), DEFAULT_MAX_ESTIMATED_COST_R);
  return {
    maxCandidatesPerSnapshot: int(first(options.maxCandidatesPerSnapshot, CONFIG.short?.trade?.maxCandidatesPerSnapshot, CONFIG.trade?.maxCandidatesPerSnapshot), DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT, 1, DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT),
    analyzeMaxCandidatesPerSnapshot: int(first(options.analyzeMaxCandidatesPerSnapshot, CONFIG.short?.trade?.analyzeMaxCandidatesPerSnapshot, CONFIG.trade?.analyzeMaxCandidatesPerSnapshot), DEFAULT_MAX_CANDIDATES_PER_SNAPSHOT, 1, DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT),
    hardMaxCandidatesPerSnapshot: DEFAULT_HARD_MAX_CANDIDATES_PER_SNAPSHOT,
    maxSnapshotAgeSec: n(first(options.maxSnapshotAgeSec, CONFIG.short?.trade?.maxSnapshotAgeSec, CONFIG.trade?.maxSnapshotAgeSec), DEFAULT_MAX_SNAPSHOT_AGE_SEC),
    dataConcurrency: int(first(options.dataConcurrency, CONFIG.short?.trade?.dataConcurrency, CONFIG.trade?.dataConcurrency), DEFAULT_DATA_CONCURRENCY, 1, 3),
    minRiskPct,
    maxRiskPct,
    fallbackRiskPct: n(first(options.fallbackRiskPct, CONFIG.short?.trade?.fallbackRiskPct, CONFIG.trade?.fallbackRiskPct), DEFAULT_FALLBACK_RISK_PCT),
    defaultRR: n(first(options.defaultRR, CONFIG.short?.trade?.defaultRR, CONFIG.trade?.defaultRR), DEFAULT_RR),
    minRR: n(first(options.minRR, CONFIG.short?.trade?.minRR, CONFIG.trade?.minRR), DEFAULT_MIN_RR),
    maxRR: n(first(options.maxRR, CONFIG.short?.trade?.maxRR, CONFIG.trade?.maxRR), DEFAULT_MAX_RR),
    minRewardPct: n(first(options.minRewardPct, CONFIG.short?.trade?.minRewardPct, CONFIG.trade?.minRewardPct), DEFAULT_MIN_REWARD_PCT),
    minDiscordRewardPct: n(first(options.minDiscordRewardPct, CONFIG.short?.trade?.minDiscordRewardPct, CONFIG.trade?.minDiscordRewardPct), DEFAULT_MIN_DISCORD_REWARD_PCT),
    maxRiskToRewardDistanceRatio: n(first(options.maxRiskToRewardDistanceRatio, CONFIG.short?.trade?.maxRiskToRewardDistanceRatio, CONFIG.trade?.maxRiskToRewardDistanceRatio), DEFAULT_MAX_RISK_TO_REWARD_DISTANCE_RATIO),
    maxEstimatedCostR,
    hardMaxEstimatedCostR: n(first(options.hardMaxEstimatedCostR, CONFIG.short?.trade?.hardMaxEstimatedCostR, CONFIG.trade?.hardMaxEstimatedCostR), DEFAULT_HARD_MAX_ESTIMATED_COST_R),
    roundTripFeePct: n(first(options.roundTripFeePct, CONFIG.short?.cost?.roundTripFeePct, CONFIG.cost?.roundTripFeePct), DEFAULT_ROUND_TRIP_FEE_PCT),
    roundTripSlippagePct: n(first(options.roundTripSlippagePct, CONFIG.short?.cost?.roundTripSlippagePct, CONFIG.cost?.roundTripSlippagePct), DEFAULT_ROUND_TRIP_SLIPPAGE_PCT),
    fallbackSpreadPct: n(first(options.fallbackSpreadPct, CONFIG.short?.cost?.fallbackSpreadPct, CONFIG.cost?.fallbackSpreadPct), DEFAULT_FALLBACK_SPREAD_PCT),
    spreadCostMult: n(first(options.spreadCostMult, CONFIG.short?.cost?.spreadCostMult, CONFIG.cost?.spreadCostMult), DEFAULT_SPREAD_COST_MULT),
    rrVariants: Array.isArray(options.rrVariants) && options.rrVariants.length
      ? options.rrVariants.map((x) => n(x, 0)).filter((x) => x > 0)
      : DEFAULT_RR_VARIANTS,
    candidateTimeoutMs: int(first(options.candidateTimeoutMs, CONFIG.short?.trade?.candidateTimeoutMs, CONFIG.trade?.candidateTimeoutMs), DEFAULT_CANDIDATE_TIMEOUT_MS, 300, 2500),
    analyzeTimeoutMs: int(first(options.analyzeTimeoutMs, CONFIG.short?.trade?.analyzeTimeoutMs, CONFIG.trade?.analyzeTimeoutMs), DEFAULT_ANALYZE_TIMEOUT_MS, 500, 4500),
    rotationTimeoutMs: int(first(options.rotationTimeoutMs, CONFIG.short?.trade?.rotationTimeoutMs, CONFIG.trade?.rotationTimeoutMs), DEFAULT_ROTATION_TIMEOUT_MS, 150, 1200),
    marketContextTimeoutMs: int(first(options.marketContextTimeoutMs, CONFIG.short?.trade?.marketContextTimeoutMs, CONFIG.trade?.marketContextTimeoutMs), DEFAULT_MARKET_CONTEXT_TIMEOUT_MS, 200, 1500),
    monitorTimeoutMs: int(first(options.monitorTimeoutMs, CONFIG.short?.trade?.monitorTimeoutMs, CONFIG.trade?.monitorTimeoutMs), DEFAULT_MONITOR_TIMEOUT_MS, 500, 3500),
    monitorPriceFetchTimeoutMs: int(first(options.monitorPriceFetchTimeoutMs, CONFIG.short?.trade?.monitorPriceFetchTimeoutMs, CONFIG.trade?.monitorPriceFetchTimeoutMs), DEFAULT_MONITOR_PRICE_FETCH_TIMEOUT_MS, 100, 1200),
    monitorBatchSize: int(first(options.monitorBatchSize, CONFIG.short?.trade?.monitorBatchSize, CONFIG.trade?.monitorBatchSize), DEFAULT_MONITOR_BATCH_SIZE, 5, 80),
    openPositionMonitorLimit: int(first(options.openPositionMonitorLimit, CONFIG.short?.trade?.openPositionMonitorLimit, CONFIG.trade?.openPositionMonitorLimit), DEFAULT_OPEN_POSITION_MONITOR_LIMIT, 10, 150),
    openPositionLoadTimeoutMs: int(first(options.openPositionLoadTimeoutMs, CONFIG.short?.trade?.openPositionLoadTimeoutMs, CONFIG.trade?.openPositionLoadTimeoutMs), DEFAULT_OPEN_POSITION_LOAD_TIMEOUT_MS, 250, 1500),
    savePositionTimeoutMs: int(first(options.savePositionTimeoutMs, CONFIG.short?.trade?.savePositionTimeoutMs, CONFIG.trade?.savePositionTimeoutMs), DEFAULT_SAVE_POSITION_TIMEOUT_MS, 250, 2500),
    minEntryLoopAttempts: int(first(options.minEntryLoopAttempts, CONFIG.short?.trade?.minEntryLoopAttempts, CONFIG.trade?.minEntryLoopAttempts), DEFAULT_MIN_ENTRY_LOOP_ATTEMPTS, 1, 8),
    entryLoopReserveMs: int(first(options.entryLoopReserveMs, CONFIG.short?.trade?.entryLoopReserveMs, CONFIG.trade?.entryLoopReserveMs), DEFAULT_ENTRY_LOOP_RESERVE_MS, 250, 2500),
    maxRuntimeMs: int(first(options.maxRuntimeMs, CONFIG.short?.trade?.maxRuntimeMs, CONFIG.trade?.maxRuntimeMs), DEFAULT_MAX_RUNTIME_MS, 8000, 26000),
    positionTimeStopMin: n(first(options.positionTimeStopMin, CONFIG.short?.trade?.positionTimeStopMin, CONFIG.trade?.positionTimeStopMin), 720),
    monitorLivePriceFetchEnabled: bool(first(options.monitorLivePriceFetchEnabled, CONFIG.short?.trade?.monitorLivePriceFetchEnabled, CONFIG.trade?.monitorLivePriceFetchEnabled), true)
  };
}
function sizingConfig() {
  const options = ACTIVE_RUN_OPTIONS || {};
  const enabled = bool(first(
    options.sizingEnabled,
    options.positionSizingEnabled,
    options.usePositionSizing,
    CONFIG.short?.sizing?.enabled,
    CONFIG.short?.trade?.sizingEnabled,
    CONFIG.sizing?.shortEnabled,
    CONFIG.sizing?.enabled,
    CONFIG.trade?.sizingEnabled
  ), true);
  const baseRiskPct = clamp(
    first(
      options.baseRiskPct,
      options.defaultRiskFraction,
      options.riskFraction,
      CONFIG.short?.sizing?.baseRiskPct,
      CONFIG.short?.sizing?.defaultRiskFraction,
      CONFIG.short?.trade?.baseRiskPct,
      CONFIG.sizing?.shortBaseRiskPct,
      CONFIG.sizing?.baseRiskPct,
      CONFIG.trade?.baseRiskPct
    ) ?? 0.0025,
    0,
    0.05
  );
  const minRiskPct = clamp(
    first(
      options.minPositionRiskPct,
      options.minRiskFraction,
      CONFIG.short?.sizing?.minRiskPct,
      CONFIG.short?.sizing?.minRiskFraction,
      CONFIG.sizing?.shortMinRiskPct,
      CONFIG.sizing?.minRiskPct
    ) ?? 0.0005,
    0,
    0.05
  );
  const maxRiskPct = clamp(
    first(
      options.maxPositionRiskPct,
      options.maxRiskFraction,
      CONFIG.short?.sizing?.maxRiskPct,
      CONFIG.short?.sizing?.maxRiskFraction,
      CONFIG.sizing?.shortMaxRiskPct,
      CONFIG.sizing?.maxRiskPct
    ) ?? 0.01,
    0,
    0.05
  );
  const minMult = clamp(
    first(
      options.sizingMinMult,
      CONFIG.short?.sizing?.minMult,
      CONFIG.sizing?.shortMinMult,
      CONFIG.sizing?.minMult
    ) ?? 0.35,
    0,
    5
  );
  const maxMult = clamp(
    first(
      options.sizingMaxMult,
      CONFIG.short?.sizing?.maxMult,
      CONFIG.sizing?.shortMaxMult,
      CONFIG.sizing?.maxMult
    ) ?? 1.25,
    0,
    5
  );
  const fallbackRiskPct = clamp(
    first(
      options.sizingFallbackRiskPct,
      CONFIG.short?.sizing?.fallbackRiskPct,
      CONFIG.sizing?.shortFallbackRiskPct,
      CONFIG.sizing?.fallbackRiskPct
    ) ?? baseRiskPct,
    0,
    0.05
  );
  return {
    enabled,
    baseRiskPct,
    fallbackRiskPct,
    minRiskPct,
    maxRiskPct,
    minMult,
    maxMult,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true,
    source: 'LOCAL_TRADE_SYSTEM_SIZING_CONFIG',
    reason: 'PREVENT_SIZING_CONFIG_REFERENCE_ERROR'
  };
}
function estimatedCostRForRiskPct(row = {}, riskPct = 0, cfg = tradeConfig()) {
  const spreadPct = n(row.spreadPct, cfg.fallbackSpreadPct);
  const totalCostPct =
    n(cfg.roundTripFeePct, DEFAULT_ROUND_TRIP_FEE_PCT) +
    n(cfg.roundTripSlippagePct, DEFAULT_ROUND_TRIP_SLIPPAGE_PCT) +
    Math.max(0, spreadPct) * n(cfg.spreadCostMult, DEFAULT_SPREAD_COST_MULT);
  if (riskPct <= 0) return 999;
  return round(totalCostPct / riskPct, 6);
}
function candidateFallbackPrice(row = {}, fallback = 0) {
  return n(
    row.price ??
    row.markPrice ??
    row.currentPrice ??
    row.lastPrice ??
    row.close ??
    row.entry,
    fallback
  );
}
function adaptiveShortRr(row = {}, cfg = tradeConfig()) {
  const setup = setupFromRow(row);
  const regime = regimeFromRow(row);
  const confirmation = confirmationFromRow(row);
  let rr = n(cfg.defaultRR, DEFAULT_RR);
  if (setup === 'BREAKOUT' && regime === 'TREND') rr = 1.75;
  else if (setup === 'CONTINUATION' && regime === 'TREND') rr = 1.75;
  else if (setup === 'RETEST' && regime === 'TREND') rr = 1.5;
  else if (setup === 'SWEEP_REVERSAL') rr = 1.25;
  else if (setup === 'COMPRESSION' && regime === 'SQUEEZE') rr = 1.5;
  else if (regime === 'CHOP') rr = 1.25;
  if (confirmation === 'A_STRONG_ALIGN') rr += 0.25;
  if (confirmation === 'E_WEAK_CONTRA') rr -= 0.25;
  return Number(clamp(rr, n(cfg.minRR, DEFAULT_MIN_RR), n(cfg.maxRR, DEFAULT_MAX_RR)).toFixed(2));
}
function adaptiveShortRiskPct(row = {}, cfg = tradeConfig()) {
  const setup = setupFromRow(row);
  const regime = regimeFromRow(row);
  const confirmation = confirmationFromRow(row);
  const spreadPct = n(row.spreadPct, cfg.fallbackSpreadPct);
  let riskPct = n(cfg.fallbackRiskPct, DEFAULT_FALLBACK_RISK_PCT);
  if (setup === 'BREAKOUT') riskPct += 0.0007;
  if (setup === 'SWEEP_REVERSAL') riskPct += 0.001;
  if (setup === 'COMPRESSION') riskPct += 0.0008;
  if (setup === 'RETEST') riskPct += 0.0004;
  if (regime === 'CHOP') riskPct += 0.0008;
  if (regime === 'SQUEEZE') riskPct += 0.0006;
  if (confirmation === 'E_WEAK_CONTRA') riskPct -= 0.0004;
  if (spreadPct > 0.0012) riskPct += 0.0007;
  let cleanRiskPct = clamp(riskPct, Math.max(0.0005, cfg.minRiskPct), Math.max(cfg.minRiskPct, cfg.maxRiskPct));
  while (
    cleanRiskPct < cfg.maxRiskPct &&
    estimatedCostRForRiskPct(row, cleanRiskPct, cfg) > cfg.maxEstimatedCostR
  ) {
    cleanRiskPct += 0.00025;
  }
  return Number(clamp(cleanRiskPct, Math.max(0.0005, cfg.minRiskPct), Math.max(cfg.minRiskPct, cfg.maxRiskPct)).toFixed(8));
}
function buildRrShadowPlans({ entry, riskPct, cfg = tradeConfig() } = {}) {
  const variants = uniqueStrings(cfg.rrVariants || DEFAULT_RR_VARIANTS)
    .map((value) => n(value, 0))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  return variants.map((rr) => {
    const plan = buildShortTpSlPlan({ entry, riskPct, rr, cfg });
    return {
      id: `RR_${String(rr).replace('.', '_')}`,
      rr,
      entry: plan.entry,
      sl: plan.sl,
      initialSl: plan.initialSl,
      tp: plan.tp,
      riskPct: plan.riskPct,
      rewardPct: plan.rewardPct,
      riskDistance: plan.riskDistance,
      rewardDistance: plan.rewardDistance,
      riskToRewardDistanceRatio: plan.riskToRewardDistanceRatio,
      version: RR_SHADOW_GRID_VERSION
    };
  });
}
function applyAdaptiveShortRisk(row = {}, reason = 'ADAPTIVE_SHORT_RR_TP_SL') {
  const cfg = tradeConfig();
  const entry = candidateFallbackPrice(row, 0);
  if (entry <= 0) {
    return {
      ...row,
      ...sideFlags(),
      ...virtualFlags(row),
      entry: 0,
      sl: 0,
      tp: 0,
      rr: 0,
      riskPct: 0,
      rewardPct: 0,
      liveRiskValid: false,
      liveEntryBlockedReason: 'ADAPTIVE_SHORT_RISK_NO_PRICE'
    };
  }
  const rr = adaptiveShortRr(row, cfg);
  const riskPct = adaptiveShortRiskPct(row, cfg);
  const plan = buildShortTpSlPlan({ entry, riskPct, rr, cfg });
  const rrShadowPlans = buildRrShadowPlans({ entry, riskPct: plan.riskPct, cfg });
  const estimatedCostR = estimatedCostRForRiskPct(row, plan.riskPct, cfg);
  const riskQualityOk =
    plan.entry > 0 &&
    plan.tp > 0 &&
    plan.sl > 0 &&
    plan.tp < plan.entry &&
    plan.entry < plan.sl &&
    plan.rr >= cfg.minRR &&
    plan.rewardPct >= cfg.minRewardPct &&
    plan.riskToRewardDistanceRatio <= cfg.maxRiskToRewardDistanceRatio &&
    estimatedCostR <= cfg.hardMaxEstimatedCostR;
  return {
    ...row,
    ...sideFlags(),
    ...virtualFlags(row),
    price: plan.entry,
    currentPrice: row.currentPrice ?? plan.entry,
    lastPrice: row.lastPrice ?? row.currentPrice ?? plan.entry,
    entry: plan.entry,
    entryPrice: plan.entry,
    sl: plan.sl,
    initialSl: plan.sl,
    stopLoss: plan.sl,
    stop: plan.sl,
    stopPrice: plan.sl,
    tp: plan.tp,
    takeProfit: plan.tp,
    target: plan.tp,
    targetPrice: plan.tp,
    rr: plan.rr,
    riskPct: plan.riskPct,
    rewardPct: plan.rewardPct,
    riskDistance: plan.riskDistance,
    rewardDistance: plan.rewardDistance,
    riskToRewardDistanceRatio: plan.riskToRewardDistanceRatio,
    rrShadowGridEnabled: true,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    rrShadowPlans,
    rrVariantPlans: rrShadowPlans,
    rrVariants: rrShadowPlans.map((item) => item.rr),
    primaryRr: plan.rr,
    estimatedCostR,
    maxEstimatedCostR: cfg.maxEstimatedCostR,
    hardMaxEstimatedCostR: cfg.hardMaxEstimatedCostR,
    costAwareRisk: true,
    adaptiveShortRisk: true,
    adaptiveShortRiskReason: reason,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    riskSource: row.riskSource || 'COST_AWARE_ADAPTIVE_STANDARDIZED_SHORT_TP_SL',
    rrQualityOk: plan.rr >= cfg.minRR,
    rewardQualityOk: plan.rewardPct >= cfg.minRewardPct,
    discordRewardQualityOk: plan.rewardPct >= cfg.minDiscordRewardPct,
    riskToRewardDistanceQualityOk: plan.riskToRewardDistanceRatio <= cfg.maxRiskToRewardDistanceRatio,
    costQualityOk: estimatedCostR <= cfg.maxEstimatedCostR,
    hardCostQualityOk: estimatedCostR <= cfg.hardMaxEstimatedCostR,
    liveRiskValid: riskQualityOk,
    liveEntryBlockedReason: riskQualityOk ? null : 'ADAPTIVE_SHORT_RISK_QUALITY_FAILED',
    validShortRiskShape: riskQualityOk,
    shortRiskRule: 'tp < entry < sl',
    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortTimeStopExitRule: 'TIME_STOP',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)'
  };
}
function standardizedRiskMetrics(candidate = {}, reason = 'STANDARDIZED_SHORT_LEARNING_TP_SL') {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);
  const mid = candidateFallbackPrice(normalized, 0);
  if (mid <= 0) {
    return {
      ...normalized,
      ...scannerMetadataFrom(normalized),
      ...sideFlags(),
      ...virtualFlags(normalized),
      entry: 0,
      sl: 0,
      tp: 0,
      rr: 0,
      riskPct: 0,
      rewardPct: 0,
      observationOnly: true,
      analysisInputOnly: true,
      learningOnly: true,
      liveRiskValid: false,
      liveEntryBlockedReason: 'STANDARDIZED_SHORT_RISK_NO_PRICE'
    };
  }
  const baseRow = {
    ...normalized,
    ...scannerMetadataFrom(normalized),
    ...sideFlags(),
    ...virtualFlags(normalized),
    price: mid,
    currentPrice: mid,
    lastPrice: mid,
    spreadPct: n(normalized.spreadPct, cfg.fallbackSpreadPct),
    depthMinUsd1p: n(normalized.depthMinUsd1p, 0),
    fundingRate: n(normalized.fundingRate, 0),
    confluence: n(normalized.scannerScore ?? normalized.moveScore, 0),
    sniperScore: n(normalized.scannerScore ?? normalized.moveScore, 0),
    scannerScore: n(normalized.scannerScore ?? normalized.moveScore, 0),
    moveScore: n(normalized.moveScore ?? normalized.scannerScore, 0),
    riskSource: 'COST_AWARE_ADAPTIVE_STANDARDIZED_SHORT_TP_SL',
    standardizedLearningRisk: true,
    standardizedLearningRiskReason: reason,
    observationOnly: false,
    analysisInputOnly: false,
    learningOnly: false,
    positionTimeStopMin: cfg.positionTimeStopMin,
    liveDataTs: now()
  };
  const row = applyAdaptiveShortRisk(baseRow, reason);
  return {
    ...row,
    liveRiskValid: hasValidRiskShape(row) && row.liveRiskValid !== false
  };
}
async function safeProcessCandidate(candidate) {
  const cfg = tradeConfig();
  const normalized = normalizeCandidate(candidate);
  try {
    const result = await withTimeout(
      Promise.resolve({
        actions: [],
        metrics: [standardizedRiskMetrics(normalized, 'VERCEL_SAFE_COST_AWARE_RR_GRID_SHORT_LEARNING_TP_SL')]
      }),
      cfg.candidateTimeoutMs,
      'CANDIDATE_PROCESS_TIMEOUT'
    );
    if (!isTimeoutResult(result)) return result;
    return {
      actions: [],
      metrics: [standardizedRiskMetrics(normalized, 'CANDIDATE_TIMEOUT_COST_AWARE_RR_GRID_SHORT_LEARNING_TP_SL')],
      timedOut: true
    };
  } catch (error) {
    return {
      actions: [waitAction(normalized, 'CANDIDATE_PROCESS_ERROR', { error: error?.message || String(error) })],
      metrics: [standardizedRiskMetrics(normalized, 'CANDIDATE_ERROR_COST_AWARE_RR_GRID_SHORT_LEARNING_TP_SL')]
    };
  }
}
function hasValidRiskShape(row = {}) {
  const entry = n(row.entry, 0);
  const sl = n(row.sl, 0);
  const tp = n(row.tp, 0);
  const rr = n(row.rr, 0);
  if (row.learningOnly === true) return false;
  if (row.liveRiskValid === false) return false;
  if (inferRowTradeSide(row) !== TARGET_TRADE_SIDE) return false;
  if (entry <= 0 || sl <= 0 || tp <= 0 || rr <= 0) return false;
  return tp < entry && entry < sl;
}
function validateVirtualEntry(row = {}) {
  const cfg = tradeConfig();
  const tradeSide = inferRowTradeSide(row);
  const trueMicroFamilyId = getTrueMicroFamilyId(row);
  const microMicroFamilyId = getMicroMicroFamilyId(row);
  if (tradeSide !== TARGET_TRADE_SIDE) {
    return { ok: false, reason: 'LONG_DISABLED_SHORT_ONLY_SYSTEM', tradeSide };
  }
  if (!trueMicroFamilyId || !isSelectableTrueMicroId(trueMicroFamilyId)) {
    return { ok: false, reason: 'ENTRY_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY' };
  }
  if (!microMicroFamilyId || !isSelectableMicroMicroId(microMicroFamilyId)) {
    return { ok: false, reason: 'ENTRY_REQUIRES_EXACT_MICRO_MICRO_FAMILY_ID' };
  }
  if (!hasValidRiskShape(row)) {
    return { ok: false, reason: row.liveEntryBlockedReason || 'SHORT_RISK_INVALID' };
  }
  if (n(row.estimatedCostR, 0) > cfg.hardMaxEstimatedCostR) {
    return {
      ok: false,
      reason: 'SHORT_ESTIMATED_COST_R_TOO_HIGH',
      estimatedCostR: n(row.estimatedCostR, 0),
      hardMaxEstimatedCostR: cfg.hardMaxEstimatedCostR
    };
  }
  return {
    ok: true,
    reason: 'SHORT_VIRTUAL_LEARNING_COST_AWARE_RR_GRID',
    rr: n(row.rr, 0),
    riskPct: n(row.riskPct, 0),
    rewardPct: n(row.rewardPct, 0),
    estimatedCostR: n(row.estimatedCostR, 0),
    rrShadowGridEnabled: true,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION
  };
}
function waitAction(candidate, reason, extra = {}) {
  return {
    ...candidate,
    action: 'WAIT',
    reason,
    virtualTracked: false,
    liveEligible: false,
    discordAlertEligible: false,
    ...sideFlags(),
    ...virtualFlags(candidate),
    ...isolationFlags(),
    ...extra
  };
}
function discordRequiresCurrentFit() {
  return bool(first(CONFIG.short?.trade?.discordRequiresCurrentFit, CONFIG.trade?.discordRequiresCurrentFit), DEFAULT_DISCORD_REQUIRE_CURRENT_FIT);
}
function discordMinCurrentFitConfidence() {
  return clamp(first(CONFIG.short?.trade?.discordMinCurrentFitConfidence, CONFIG.trade?.discordMinCurrentFitConfidence) ?? DEFAULT_DISCORD_MIN_CURRENT_FIT_CONFIDENCE, 0, 100);
}
function currentFitMaxWeatherAgeSec() {
  return int(first(CONFIG.short?.trade?.currentFitMaxWeatherAgeSec, CONFIG.trade?.currentFitMaxWeatherAgeSec), DEFAULT_CURRENT_FIT_MAX_WEATHER_AGE_SEC, 30, 24 * 3600);
}
function extractMarketWeatherShape(weather = {}, universe = {}) {
  const source = weather && typeof weather === 'object' ? weather : {};
  const universeSource = universe && typeof universe === 'object' ? universe : {};
  const createdAt = n(first(source.createdAt, source.completedAt, source.updatedAt, source.ts, universeSource.createdAt, universeSource.completedAt, universeSource.updatedAt, universeSource.ts), 0);
  const regime = normalizeMarketRegime(first(source.currentRegime, source.regime, source.marketRegime, source.breadthRegime, source.volatilityRegime, universeSource.currentRegime, universeSource.regime));
  const trendSide = normalizeMarketTrendSide(first(source.currentTrendSide, source.trendSide, source.marketSide, source.side, source.direction, source.breadthSide, source.btcTrendSide, universeSource.currentTrendSide, universeSource.trendSide, universeSource.marketSide));
  return {
    ok: Boolean(source && Object.keys(source).length),
    source,
    universe: universeSource,
    createdAt,
    ageSec: createdAt > 0 ? Math.round((now() - createdAt) / 1000) : null,
    stale: createdAt > 0 ? (now() - createdAt) / 1000 > currentFitMaxWeatherAgeSec() : true,
    regime,
    trendSide,
    bullishPct: first(source.bullishPct, source.longPct, source.upPct, universeSource.bullishPct, universeSource.longPct, universeSource.upPct) ?? null,
    bearishPct: first(source.bearishPct, source.shortPct, source.downPct, universeSource.bearishPct, universeSource.shortPct, universeSource.downPct) ?? null,
    squeezePct: first(source.squeezePct, source.compressionPct, universeSource.squeezePct, universeSource.compressionPct) ?? null,
    confidence: clamp(first(source.confidence, source.weatherConfidence, source.currentTrendConfidence, universeSource.confidence) ?? 50, 0, 100),
    key: MARKET_WEATHER_KEY,
    universeKey: MARKET_UNIVERSE_KEY
  };
}
async function readJsonFromAnyRedis(key, fallback = null) {
  const volatileRedis = getVolatileRedis();
  const durableRedis = getDurableRedis();
  const fromVolatile = await getJson(volatileRedis, key, null).catch(() => null);
  if (fromVolatile) return { value: fromVolatile, source: `VOLATILE:${key}` };
  const fromDurable = await getJson(durableRedis, key, null).catch(() => null);
  if (fromDurable) return { value: fromDurable, source: `DURABLE:${key}` };
  return { value: fallback, source: null };
}
async function loadMarketContext() {
  const [weather, universe] = await Promise.all([
    readJsonFromAnyRedis(MARKET_WEATHER_KEY, null),
    readJsonFromAnyRedis(MARKET_UNIVERSE_KEY, null)
  ]);
  return extractMarketWeatherShape(weather.value || {}, universe.value || {});
}
function scoreMarketFit(row = {}, marketContext = {}) {
  if (!marketContext?.ok || marketContext.stale) {
    return {
      currentFit: 'UNKNOWN',
      currentFitScore: 0,
      currentFitConfidence: 0,
      currentFitReason: !marketContext?.ok ? 'MARKET_WEATHER_UNAVAILABLE' : 'MARKET_WEATHER_STALE',
      currentFitSoftOnly: true,
      currentFitBlocksLearning: false,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
    };
  }
  const familyRegime = normalizeMarketRegime(row.regimeBucket || row.regime || row.regimeCoarse);
  const confirmation = upper(row.confirmationProfile);
  const marketRegime = marketContext.regime;
  const trendSide = marketContext.trendSide;
  let score = 0;
  const reasons = [];
  if (trendSide === TARGET_TRADE_SIDE) {
    score += 35;
    reasons.push('MARKET_TREND_SHORT');
  } else if (trendSide === 'NEUTRAL' || trendSide === 'UNKNOWN') {
    score += 4;
    reasons.push('MARKET_TREND_NEUTRAL_OR_UNKNOWN');
  } else {
    score -= 45;
    reasons.push('MARKET_TREND_AGAINST_SHORT');
  }
  if (familyRegime !== 'UNKNOWN' && marketRegime !== 'UNKNOWN') {
    if (familyRegime === marketRegime) {
      score += 25;
      reasons.push('FAMILY_REGIME_MATCH');
    } else {
      score -= 15;
      reasons.push('FAMILY_REGIME_MISMATCH');
    }
  }
  const bearishPct = n(marketContext.bearishPct, NaN);
  const bullishPct = n(marketContext.bullishPct, NaN);
  if (Number.isFinite(bearishPct)) {
    if (bearishPct >= 70) score += 20;
    else if (bearishPct >= 60) score += 15;
    else if (bearishPct >= 50) score += 8;
    else if (bearishPct < 40) score -= 12;
  }
  if (Number.isFinite(bullishPct) && bullishPct >= 60) score -= 20;
  if (confirmation === 'A_STRONG_ALIGN') score += 8;
  if (confirmation === 'B_FLOW_ALIGN') score += 5;
  if (confirmation === 'C_VOLUME_ALIGN') score += 3;
  if (confirmation === 'E_WEAK_CONTRA') score -= 18;
  const finalScore = clamp(score, -100, 100);
  const confidence = clamp(n(marketContext.confidence, 50) + Math.min(20, Math.abs(finalScore) / 2), 0, 100);
  let currentFit = 'NEUTRAL';
  if (finalScore >= 45) currentFit = 'MATCH';
  else if (finalScore >= 18) currentFit = 'WEAK_MATCH';
  else if (finalScore <= -25) currentFit = 'MISFIT';
  return {
    currentFit,
    currentFitScore: round(finalScore, 4),
    currentFitConfidence: round(confidence, 2),
    currentFitReason: reasons.join('|') || 'NO_CURRENT_FIT_REASON',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
  };
}
function attachCurrentFitContext(row = {}, marketContext = {}) {
  const fit = scoreMarketFit(row, marketContext);
  return {
    ...row,
    currentMarketWeather: marketContext?.source || null,
    currentMarketUniverse: marketContext?.universe || null,
    currentMarketWeatherKey: MARKET_WEATHER_KEY,
    currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
    currentMarketWeatherAgeSec: marketContext?.ageSec ?? null,
    currentMarketWeatherStale: Boolean(marketContext?.stale),
    currentRegime: marketContext?.regime || 'UNKNOWN',
    currentTrendSide: marketContext?.trendSide || 'UNKNOWN',
    currentBullishPct: marketContext?.bullishPct ?? null,
    currentBearishPct: marketContext?.bearishPct ?? null,
    currentSqueezePct: marketContext?.squeezePct ?? null,
    entryMarketWeather: marketContext?.source || null,
    entryCurrentRegime: marketContext?.regime || 'UNKNOWN',
    entryCurrentTrendSide: marketContext?.trendSide || 'UNKNOWN',
    entryCurrentFit: fit.currentFit,
    entryCurrentFitConfidence: fit.currentFitConfidence,
    entryWeatherFitMatchedFamily: fit.currentFit === 'MATCH' || fit.currentFit === 'WEAK_MATCH',
    ...fit
  };
}
function discordCurrentFitGate(row = {}) {
  if (!discordRequiresCurrentFit()) {
    return {
      ok: true,
      reason: 'CURRENT_FIT_NOT_REQUIRED_BY_CONFIG',
      currentFit: row.currentFit || row.entryCurrentFit || 'NOT_REQUIRED',
      currentFitConfidence: n(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0)
    };
  }
  const fit = upper(row.currentFit || row.entryCurrentFit);
  const confidence = n(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0);
  if (!fit || fit === 'UNKNOWN') {
    return { ok: false, reason: 'DISCORD_BLOCKED_CURRENT_FIT_UNKNOWN', currentFit: fit || 'UNKNOWN', currentFitConfidence: confidence };
  }
  if (confidence < discordMinCurrentFitConfidence()) {
    return { ok: false, reason: 'DISCORD_BLOCKED_CURRENT_FIT_CONFIDENCE_TOO_LOW', currentFit: fit, currentFitConfidence: confidence };
  }
  if (fit === 'MATCH' || fit === 'WEAK_MATCH') {
    return { ok: true, reason: 'DISCORD_CURRENT_FIT_OK', currentFit: fit, currentFitConfidence: confidence };
  }
  return {
    ok: false,
    reason: `DISCORD_BLOCKED_CURRENT_FIT_${fit}`,
    currentFit: fit,
    currentFitConfidence: confidence
  };
}
function buildSelectedAlertContext(activeRotation) {
  const rawRows = Array.isArray(activeRotation?.microFamilies) ? activeRotation.microFamilies : [];
  const rowByLearningId = new Map();
  for (const row of rawRows) {
    const normalized = normalizeExactTrueMicroRow(row);
    const microMicroId = getMicroMicroFamilyId(normalized);
    if (microMicroId) rowByLearningId.set(microMicroId, normalized);
  }
  const configuredMicroMicroIds = uniqueStrings([
    activeRotation?.microMicroFamilyIds || [],
    activeRotation?.activeMicroMicroFamilyIds || [],
    activeRotation?.trueMicroMicroFamilyIds || [],
    activeRotation?.activeTrueMicroMicroFamilyIds || [],
    activeRotation?.exactMicroMicroFamilyIds || [],
    activeRotation?.selectedMicroMicroFamilyIds || [],
    rawRows.map(getMicroMicroFamilyId)
  ]);
  const selectedMicroMicroFamilyIds = uniqueStrings(
    configuredMicroMicroIds
      .map((id) => cleanLearningFamilyId(id, {}))
      .filter((id) => isSelectableMicroMicroId(id))
  );
  const selectedMicroMicroSet = new Set(selectedMicroMicroFamilyIds);
  return {
    rotationId: activeRotation?.rotationId || null,
    selectedRotation: activeRotation || null,
    selectedMicroFamilyIds: [],
    selectedTrueMicroFamilyIds: [],
    selectedChildTrueMicroFamilyIds: [],
    selectedMicroSet: new Set(),
    selectedMicroMicroFamilyIds,
    selectedTrueMicroMicroFamilyIds: selectedMicroMicroFamilyIds,
    selectedExactMicroMicroFamilyIds: selectedMicroMicroFamilyIds,
    selectedMicroMicroSet,
    selectedParentTrueMicroFamilyIds: uniqueStrings(selectedMicroMicroFamilyIds.map(parentIdFromChild)),
    rowByLearningId,
    empty: selectedMicroMicroFamilyIds.length === 0,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    selectionPurpose: 'DISCORD_ALERT_ONLY',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ONLY',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordRequiresCurrentFit: discordRequiresCurrentFit(),
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags()
  };
}
function selectedAlertMatchInfo(alertContext, row = {}) {
  if (!alertContext || alertContext.empty) {
    return {
      ok: false,
      reason: 'NO_MANUAL_MICRO_MICRO_SELECTED',
      granularity: null,
      matchType: null,
      selectedId: null
    };
  }
  const microMicroId = getMicroMicroFamilyId(row);
  const exactTrueMicroId = getTrueMicroFamilyId(row);
  if (
    microMicroId &&
    isSelectableMicroMicroId(microMicroId) &&
    alertContext.selectedMicroMicroSet.has(microMicroId)
  ) {
    return {
      ok: true,
      reason: 'SELECTED_SHORT_MICRO_MICRO_EXACT_MATCH',
      granularity: LAYER_MICRO_MICRO,
      matchType: SELECTION_EXACT_MICRO_MICRO,
      selectedId: microMicroId,
      selectedMicroMicroFamilyId: microMicroId,
      selectedMicroFamilyId: exactTrueMicroId || childIdFromAnyLearningId(microMicroId)
    };
  }
  return {
    ok: false,
    reason: microMicroId
      ? 'MICRO_MICRO_NOT_SELECTED_FOR_DISCORD_ALERT'
      : 'NO_MICRO_MICRO_ON_ROW_FOR_DISCORD_ALERT',
    granularity: null,
    matchType: null,
    selectedId: null,
    selectedMicroMicroFamilyId: microMicroId || null,
    selectedMicroFamilyId: exactTrueMicroId || null
  };
}
function getSelectedWeeklyStats(alertContext, microMicroFamilyId) {
  if (!alertContext || !microMicroFamilyId) return null;
  return alertContext.rowByLearningId.get(microMicroFamilyId) || null;
}
function buildOpenSymbolSet(openPositions = []) {
  const set = new Set();
  for (const position of Array.isArray(openPositions) ? openPositions : []) {
    for (const key of rowSymbolKeys(position)) {
      if (key) set.add(key);
    }
  }
  return set;
}
function hasOpenSymbol(openSymbolSet, row = {}) {
  for (const key of rowSymbolKeys(row)) {
    if (openSymbolSet.has(key)) return true;
  }
  return false;
}
function rememberOpenSymbol(openSymbolSet, row = {}) {
  for (const key of rowSymbolKeys(row)) {
    if (key) openSymbolSet.add(key);
  }
}
function buildVirtualEntryAction({
  row,
  alertContext,
  selectedWeeklyStats,
  riskFraction,
  virtualGate,
  selectedAlertMatch,
  discordAlertEligible
}) {
  const normalized = normalizeExactTrueMicroRow(row);
  const trueMicroFamilyId = getTrueMicroFamilyId(normalized);
  const microMicroFamilyId = getMicroMicroFamilyId(normalized);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(normalized);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);
  const currentFitGate = discordCurrentFitGate(row);
  const finalDiscordAlertEligible = Boolean(
    discordAlertEligible &&
    currentFitGate.ok &&
    selectedAlertMatch?.granularity === LAYER_MICRO_MICRO &&
    microMicroFamilyId &&
    selectedAlertMatch?.selectedMicroMicroFamilyId === microMicroFamilyId
  );
  return {
    ...normalized,
    ...scannerMetadataFrom(row, normalized),
    ...sideFlags(),
    ...virtualFlags({
      ...row,
      trueMicroFamilyId,
      microMicroFamilyId
    }),
    ...isolationFlags(),
    action: 'VIRTUAL_ENTRY',
    reason: virtualGate.reason || 'SHORT_VIRTUAL_LEARNING_COST_AWARE_RR_GRID',
    shadowOnly: false,
    trueMicroFamilyId,
    microFamilyId: trueMicroFamilyId,
    analyzeMicroFamilyId: trueMicroFamilyId,
    learningMicroFamilyId: trueMicroFamilyId,
    childTrueMicroFamilyId: trueMicroFamilyId,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash: microMicroHashFromId(microMicroFamilyId) || normalized.microMicroHash || null,
    parentTrueMicroFamilyId,
    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,
    familyId: trueMicroFamilyId,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    selectedRotationId: alertContext.rotationId,
    activeRotationId: alertContext.rotationId,
    selectedMicroFamilyAlert: Boolean(finalDiscordAlertEligible),
    selectedExactMicroMatch: false,
    selectedExact75ChildMatch: false,
    selectedExactMicroMicroMatch: Boolean(finalDiscordAlertEligible),
    rotationMatchType: finalDiscordAlertEligible ? SELECTION_EXACT_MICRO_MICRO : null,
    matchType: finalDiscordAlertEligible ? SELECTION_EXACT_MICRO_MICRO : null,
    selectedLearningFamilyId: finalDiscordAlertEligible ? microMicroFamilyId : null,
    selectedLearningGranularity: finalDiscordAlertEligible ? SELECTION_EXACT_MICRO_MICRO : null,
    discordAlertEligible: Boolean(finalDiscordAlertEligible),
    discordCurrentFitGate: currentFitGate,
    discordAlertReason: finalDiscordAlertEligible
      ? 'SELECTED_SHORT_MICRO_MICRO_EXACT_MATCH_AND_CURRENT_FIT_OK'
      : !selectedAlertMatch?.ok
        ? selectedAlertMatch?.reason || 'MICRO_MICRO_NOT_SELECTED_FOR_DISCORD_ALERT'
        : currentFitGate.reason || 'CURRENT_FIT_BLOCKED_DISCORD_ALERT',
    selectedMicroFamilyId: finalDiscordAlertEligible ? trueMicroFamilyId : null,
    selectedTrueMicroFamilyId: finalDiscordAlertEligible ? trueMicroFamilyId : null,
    selectedChildTrueMicroFamilyId: finalDiscordAlertEligible ? trueMicroFamilyId : null,
    selectedMicroMicroFamilyId: finalDiscordAlertEligible ? microMicroFamilyId : null,
    selectedTrueMicroMicroFamilyId: finalDiscordAlertEligible ? microMicroFamilyId : null,
    selectedExactMicroMicroFamilyId: finalDiscordAlertEligible ? microMicroFamilyId : null,
    selectedMicroMicroFamilyIds: alertContext.selectedMicroMicroFamilyIds,
    selectedTrueMicroMicroFamilyIds: alertContext.selectedTrueMicroMicroFamilyIds,
    selectedExactMicroMicroFamilyIds: alertContext.selectedExactMicroMicroFamilyIds,
    selectedWeeklyStats,
    weeklyStats: selectedWeeklyStats,
    riskFraction,
    virtualGate,
    liveEligible: Boolean(finalDiscordAlertEligible),
    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    entryMarketWeather: row.entryMarketWeather || row.currentMarketWeather || null,
    entryCurrentRegime: row.entryCurrentRegime || row.currentRegime || null,
    entryCurrentTrendSide: row.entryCurrentTrendSide || row.currentTrendSide || null,
    entryCurrentFit: row.entryCurrentFit || row.currentFit || null,
    entryCurrentFitConfidence: row.entryCurrentFitConfidence ?? row.currentFitConfidence ?? null,
    entryCreatedAt: now()
  };
}

function buildDiscordEntryAlertPayload(entry = {}) {
  const microId = upper(
    getTrueMicroFamilyId(entry) ||
    entry.trueMicroFamilyId ||
    entry.childTrueMicroFamilyId ||
    entry.microFamilyId ||
    entry.analyzeMicroFamilyId ||
    entry.learningMicroFamilyId
  );
  const microMicroId = upper(
    getMicroMicroFamilyId(entry) ||
    entry.microMicroFamilyId ||
    entry.trueMicroMicroFamilyId ||
    entry.exactMicroMicroFamilyId
  );
  const rotationId =
    entry.activeRotationId ||
    entry.rotationId ||
    entry.selectedRotationId ||
    `manual_${PERSISTENT_LEARNING_KEY}`;
  return {
    ...entry,
    action: 'ENTRY',
    source: 'VIRTUAL',
    sourceMode: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    positionSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    paperTrade: true,
    paperPosition: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    liveOrder: false,
    orderPlaced: false,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    signalSide: TARGET_TRADE_SIDE,
    entrySide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    entry: entry.entry,
    entryPrice: entry.entry,
    tp: entry.tp,
    takeProfit: entry.tp,
    target: entry.tp,
    targetPrice: entry.tp,
    sl: entry.sl ?? entry.initialSl,
    initialSl: entry.sl ?? entry.initialSl,
    stopLoss: entry.sl ?? entry.initialSl,
    stop: entry.sl ?? entry.initialSl,
    stopPrice: entry.sl ?? entry.initialSl,
    trueMicroFamilyId: microId,
    childTrueMicroFamilyId: microId,
    microFamilyId: microId,
    analyzeMicroFamilyId: microId,
    learningMicroFamilyId: microId,
    microMicroFamilyId: microMicroId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,
    microMicroHash: microMicroHashFromId(microMicroId) || entry.microMicroHash || null,
    rotationId,
    activeRotationId: rotationId,
    selectedRotationId: rotationId,
    rotationMatchType: SELECTION_EXACT_MICRO_MICRO,
    matchType: SELECTION_EXACT_MICRO_MICRO,
    discordAlertEligible: true,
    selectedForDiscord: true,
    liveEligible: true,
    selectedTrueMicroFamilyId: microId,
    selectedMicroFamilyId: microId,
    selectedChildTrueMicroFamilyId: microId,
    selectedMicroMicroFamilyId: microMicroId,
    selectedTrueMicroMicroFamilyId: microMicroId,
    selectedExactMicroMicroFamilyId: microMicroId,
    selectedTrueMicroFamilyIds: [microId],
    selectedMicroFamilyIds: [microId],
    selectedChildTrueMicroFamilyIds: [microId],
    trueMicroFamilyIds: [microId],
    childTrueMicroFamilyIds: [microId],
    microFamilyIds: [microId],
    selectedMicroMicroFamilyIds: [microMicroId],
    selectedTrueMicroMicroFamilyIds: [microMicroId],
    selectedExactMicroMicroFamilyIds: [microMicroId],
    activeMicroMicroFamilyIds: [microMicroId],
    activeTrueMicroMicroFamilyIds: [microMicroId],
    activeExactMicroMicroFamilyIds: [microMicroId],
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroVersion: MICRO_MICRO_VERSION,
    riskPlanVersion: entry.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    rr: entry.rr,
    riskPct: entry.riskPct,
    rewardPct: entry.rewardPct,
    estimatedCostR: entry.estimatedCostR,
    riskToRewardDistanceRatio: entry.riskToRewardDistanceRatio,
    rrShadowGridEnabled: Boolean(entry.rrShadowGridEnabled),
    rrShadowGridVersion: entry.rrShadowGridVersion || RR_SHADOW_GRID_VERSION,
    rrShadowPlans: Array.isArray(entry.rrShadowPlans) ? entry.rrShadowPlans : [],
    discordPayloadSanitizedForEntryAlert: true
  };
}
async function maybeSendDiscordEntryAlert(entry = {}, cfg = tradeConfig()) {
  if (!entry.discordAlertEligible) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: false,
      fireAndForget: false,
      reason: entry.discordAlertReason || 'MICRO_MICRO_NOT_SELECTED_OR_CURRENT_FIT_BLOCKED'
    };
  }
  const microMicroId = getMicroMicroFamilyId(entry);
  if (!microMicroId || !isSelectableMicroMicroId(microMicroId)) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: false,
      fireAndForget: false,
      reason: 'DISCORD_REQUIRES_EXACT_MICRO_MICRO_ID'
    };
  }
  const discordPayload = buildDiscordEntryAlertPayload(entry);
  const timeoutMs = Math.min(
    Math.max(cfg.savePositionTimeoutMs || DEFAULT_SAVE_POSITION_TIMEOUT_MS, 500),
    2500
  );
  const result = await withTimeout(
    sendEntryAlert(discordPayload),
    timeoutMs,
    'DISCORD_ENTRY_ALERT_TIMEOUT'
  );
  if (isTimeoutResult(result)) {
    return {
      sent: false,
      skipped: false,
      failed: true,
      queued: false,
      awaited: true,
      fireAndForget: false,
      reason: 'DISCORD_ENTRY_ALERT_TIMEOUT',
      result
    };
  }
  if (result?.skipped) {
    return {
      sent: false,
      skipped: true,
      queued: false,
      awaited: true,
      fireAndForget: false,
      reason: result.reason || 'DISCORD_ENTRY_ALERT_SKIPPED_BY_DISCORD_FILTER',
      result
    };
  }
  if (result?.ok) {
    return {
      sent: true,
      skipped: false,
      queued: false,
      awaited: true,
      fireAndForget: false,
      reason: 'DISCORD_ENTRY_ALERT_SENT',
      result
    };
  }
  return {
    sent: false,
    skipped: false,
    failed: true,
    queued: false,
    awaited: true,
    fireAndForget: false,
    reason: result?.error || result?.reason || 'DISCORD_ENTRY_ALERT_FAILED',
    result
  };
}
function buildVirtualExitAction(outcome = {}) {
  const trueMicroFamilyId = getTrueMicroFamilyId(outcome);
  const microMicroFamilyId = getMicroMicroFamilyId(outcome);
  const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(outcome);
  const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);
  return {
    action: 'VIRTUAL_EXIT',
    reason: outcome.exitReason || outcome.reason || 'VIRTUAL_POSITION_CLOSED',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,
    symbol: outcome.symbol || null,
    contractSymbol: outcome.contractSymbol || null,
    microFamilyId: trueMicroFamilyId || null,
    trueMicroFamilyId: trueMicroFamilyId || null,
    childTrueMicroFamilyId: trueMicroFamilyId || null,
    microMicroFamilyId: microMicroFamilyId || null,
    trueMicroMicroFamilyId: microMicroFamilyId || null,
    exactMicroMicroFamilyId: microMicroFamilyId || null,
    microMicroHash: microMicroHashFromId(microMicroFamilyId) || outcome.microMicroHash || null,
    parentTrueMicroFamilyId: parentTrueMicroFamilyId || null,
    coarseMicroFamilyId: parentTrueMicroFamilyId || null,
    setupType: parsed.setup || outcome.setupType || null,
    regimeBucket: parsed.regime || outcome.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || outcome.confirmationProfile || null,
    exact75ChildTrueMicro: Boolean(trueMicroFamilyId),
    exactMicroMicro: Boolean(microMicroFamilyId),
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroVersion: MICRO_MICRO_VERSION,
    exitReason: outcome.exitReason || null,
    exitPrice: outcome.exitPrice ?? null,
    grossR: outcome.grossR ?? outcome.realizedGrossR ?? outcome.shortGrossR ?? null,
    netR: outcome.netR ?? outcome.realizedR ?? outcome.r ?? null,
    realizedR: outcome.realizedR ?? outcome.netR ?? outcome.r ?? null,
    costR: outcome.costR ?? null,
    avgCostR: outcome.avgCostR ?? outcome.costR ?? null,
    rrVariantOutcomes: Array.isArray(outcome.rrVariantOutcomes) ? outcome.rrVariantOutcomes : [],
    rrVariantSummary: outcome.rrVariantSummary || null,
    rrVariantBestRrByNetR: outcome.rrVariantBestRrByNetR ?? null,
    rrVariantBestRrByBalance: outcome.rrVariantBestRrByBalance ?? null,
    rrShadowGridVersion: outcome.rrShadowGridVersion || RR_SHADOW_GRID_VERSION,
    currentPrice: outcome.currentPrice ?? outcome.lastPrice ?? outcome.exitPrice ?? null,
    lastPrice: outcome.lastPrice ?? outcome.currentPrice ?? outcome.exitPrice ?? null,
    entry: outcome.entry ?? null,
    sl: outcome.sl ?? null,
    tp: outcome.tp ?? null,
    ageSec: outcome.ageSec ?? null,
    currentR: outcome.currentR ?? outcome.shortCurrentR ?? null,
    tpHitNow: Boolean(outcome.tpHitNow || outcome.shortTpHit || outcome.exitReason === 'TP'),
    slHitNow: Boolean(outcome.slHitNow || outcome.shortSlHit || outcome.exitReason === 'SL'),
    timeStopHitNow: Boolean(outcome.timeStopHitNow || outcome.exitReason === 'TIME_STOP'),
    riskPlanVersion: outcome.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    discordExitAlertSent: Boolean(outcome.discordExitAlertSent),
    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    ...sideFlags(),
    ...virtualFlags(outcome),
    ...isolationFlags()
  };
}
function buildVirtualExitActions(exits = []) {
  return (Array.isArray(exits) ? exits : [])
    .filter(Boolean)
    .map(buildVirtualExitAction);
}
function actionCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
function buildRunActionCounts(actions = [], virtualExits = []) {
  return actionCounts([
    ...(Array.isArray(actions) ? actions : []),
    ...buildVirtualExitActions(virtualExits)
  ]);
}
function reasonCounts(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.reason || row?.liveEntryBlockedReason || 'UNKNOWN_REASON';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
function topReasonCounts(actions = [], limit = 12) {
  return Object.entries(reasonCounts(actions))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}
function inferPrimaryBottleneck({
  candidates,
  processed,
  liveRows,
  riskValidRows,
  analyzedRows,
  analyzedRiskValidRows,
  analyzedExact75Rows,
  analyzedMicroMicroRows,
  virtualCreatedRows,
  virtualExitRows,
  waitRows,
  skippedByExistingSymbol,
  openPositionCountAfterEntries
}) {
  if (candidates <= 0) return 'NO_SHORT_CANDIDATES';
  if (processed <= 0) return 'NO_CANDIDATES_PROCESSED';
  if (liveRows <= 0) return 'NO_LIVE_ROWS_OR_NO_FALLBACK_PRICE';
  if (riskValidRows <= 0) return 'NO_COST_AWARE_TP_SL_AVAILABLE';
  if (analyzedRows <= 0) return 'ANALYZE_RETURNED_NO_SHORT_ROWS';
  if (analyzedRiskValidRows <= 0) return 'ANALYZE_DID_NOT_RETURN_RISK_VALID_ROWS';
  if (analyzedExact75Rows <= 0) return 'ANALYZE_DID_NOT_ASSIGN_EXACT_75_CHILD_TRUE_MICRO_FAMILY';
  if (analyzedMicroMicroRows <= 0) return 'ANALYZE_DID_NOT_ASSIGN_EXACT_MICRO_MICRO_FAMILY';
  if (virtualCreatedRows <= 0 && skippedByExistingSymbol > 0) return 'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION';
  if (virtualCreatedRows <= 0 && waitRows > 0) return 'VIRTUAL_ENTRY_GATE_WAIT_REASONS';
  if (virtualCreatedRows <= 0) return 'VIRTUAL_ENTRY_GATE_OR_SYMBOL_ALREADY_OPEN';
  if (virtualCreatedRows > 0 && virtualExitRows <= 0 && openPositionCountAfterEntries > 0) return 'POSITIONS_OPEN_WAITING_FOR_TP_SL_OR_TIME_STOP';
  if (virtualCreatedRows > 0 && virtualExitRows > 0) return 'HEALTHY_SHORT_MICRO_MICRO_LEARNING_PIPELINE';
  return 'PIPELINE_ACTIVE_MONITOR_REQUIRED';
}
function buildQualityAudit({
  snapshot,
  candidates,
  processed,
  liveRows,
  analyzedRowsRaw,
  analyzedRows,
  actions,
  virtualExits,
  counts,
  openPositionCountBeforeEntries,
  openPositionCountAfterEntries,
  marketContext,
  runtimeWarnings = []
}) {
  const candidateCount = candidates.length;
  const processedCount = processed.length;
  const liveRowsCount = liveRows.length;
  const analyzedRowsRawCount = analyzedRowsRaw.length;
  const analyzedRowsCount = analyzedRows.length;
  const virtualExitRows = virtualExits.length;
  const riskValidRows = counts.riskValidRows;
  const analyzedRiskValidRows = counts.analyzedRiskValidRows;
  const analyzedExact75Rows = counts.analyzedExact75Rows;
  const analyzedMicroMicroRows = counts.analyzedMicroMicroRows || 0;
  const entryRows = counts.entryRows;
  const virtualCreatedRows = counts.virtualCreatedRows;
  const waitRows = counts.waitRows;
  const skippedByExistingSymbol = counts.skippedByExistingSymbol || 0;
  const primaryBottleneck = inferPrimaryBottleneck({
    candidates: candidateCount,
    processed: processedCount,
    liveRows: liveRowsCount,
    riskValidRows,
    analyzedRows: analyzedRowsCount,
    analyzedRiskValidRows,
    analyzedExact75Rows,
    analyzedMicroMicroRows,
    virtualCreatedRows,
    virtualExitRows,
    waitRows,
    skippedByExistingSymbol,
    openPositionCountAfterEntries
  });
  return {
    profile: QUALITY_MEASUREMENT_PROFILE,
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    trueMicroSchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroSchema: TRUE_MICRO_SCHEMA,
    microMicroSchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroSchema: TRUE_MICRO_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroVersion: MICRO_MICRO_VERSION,
    microMicroRequiredForVirtualEntry: true,
    micro75ContextOnlyForDiscord: true,
    parent15ContextOnlyForDiscord: true,
    scannerWideVirtualLearning: true,
    tradeEveryScannerCandidateVirtual: true,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    discordOnlyForExactMicroMicroMatch: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordRequiresCurrentFit: discordRequiresCurrentFit(),
    discordMinCurrentFitConfidence: discordMinCurrentFitConfidence(),
    completedIsPureClosedVirtualOutcome: true,
    completedComesOnlyFrom: 'TP_SL_OR_TIME_STOP',
    scoringRSource: 'netR',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    marketWeather: {
      available: Boolean(marketContext?.ok),
      key: MARKET_WEATHER_KEY,
      universeKey: MARKET_UNIVERSE_KEY,
      ageSec: marketContext?.ageSec ?? null,
      stale: Boolean(marketContext?.stale),
      regime: marketContext?.regime || 'UNKNOWN',
      trendSide: marketContext?.trendSide || 'UNKNOWN',
      bullishPct: marketContext?.bullishPct ?? null,
      bearishPct: marketContext?.bearishPct ?? null,
      squeezePct: marketContext?.squeezePct ?? null,
      confidence: marketContext?.confidence ?? null
    },
    snapshot: {
      snapshotId: snapshot?.snapshotId || null,
      selectedSnapshotSource: snapshot?.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot?.selectedTargetCandidateCount || 0,
      selectedShortCandidateCount: snapshot?.selectedShortCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot?.selectedOppositeCandidateCount || 0,
      selectedLongCandidateCount: snapshot?.selectedLongCandidateCount || 0
    },
    pipelineCounts: {
      candidates: candidateCount,
      processed: processedCount,
      liveRows: liveRowsCount,
      riskValidRows,
      analyzedRowsRaw: analyzedRowsRawCount,
      analyzedRows: analyzedRowsCount,
      analyzedRiskValidRows,
      analyzedExact75Rows,
      analyzedMicroMicroRows,
      fallbackExact75Rows: counts.fallbackExact75Rows || 0,
      entryRows,
      virtualCreatedRows,
      virtualExitRows,
      waitRows,
      skippedByExistingSymbol,
      selectedAlertMicroMicroMatches: counts.selectedAlertMicroMicroMatches || 0,
      discordCurrentFitBlockedRows: counts.discordCurrentFitBlockedRows || 0,
      openPositionCountBeforeEntries,
      openPositionCountAfterEntries
    },
    conversionRatesPct: {
      processedPerCandidate: pct(processedCount, candidateCount),
      liveRowsPerCandidate: pct(liveRowsCount, candidateCount),
      riskValidPerLiveRow: pct(riskValidRows, liveRowsCount),
      analyzedPerLiveRow: pct(analyzedRowsCount, liveRowsCount),
      analyzedRiskValidPerAnalyzed: pct(analyzedRiskValidRows, analyzedRowsCount),
      analyzedExact75PerAnalyzedRiskValid: pct(analyzedExact75Rows, analyzedRiskValidRows),
      analyzedMicroMicroPerAnalyzedExact75: pct(analyzedMicroMicroRows, analyzedExact75Rows),
      virtualCreatedPerMicroMicro: pct(virtualCreatedRows, analyzedMicroMicroRows),
      virtualExitPerCreatedThisRun: pct(virtualExitRows, virtualCreatedRows)
    },
    runtimeWarnings,
    primaryBottleneck,
    topWaitReasons: topReasonCounts(actions, 12),
    measurementPrinciple: 'Alles SHORT virtueel laten leren; Discord alleen voor exact geselecteerde micro-micro met geldige CurrentFit en cost-aware RR/TP/SL-grid.'
  };
}
async function scopedSetJson(redis, key, value, options = {}) {
  try {
    assertKeyAllowedForWriteScope(KEYS.scopes?.TRADE_RUN || 'TRADE_RUN', key);
  } catch (error) {
    if (!String(key || '').startsWith(SHORT_KEY_PREFIX)) throw error;
  }
  return setJson(redis, key, value, options);
}
function compactMarketWeather(value) {
  if (!value || typeof value !== 'object') return value;
  const {
    rows,
    universe,
    symbols,
    tickers,
    candidates,
    ...rest
  } = value;
  return {
    ...rest,
    rowsOmittedForRedis: Array.isArray(rows),
    symbolsOmittedForRedis: Array.isArray(symbols),
    compactedForRedis: true
  };
}
function compactRunForRedis(result = {}) {
  if (!result || typeof result !== 'object') return result;
  const {
    actions,
    virtualActions,
    entryRowsList,
    waitRowsList,
    virtualCreatedRowsList,
    virtualExits,
    shadowExits,
    exits,
    realExits,
    currentMarketUniverse,
    currentMarketWeather,
    marketContext,
    ...rest
  } = result;
  return {
    ...rest,
    actions: [],
    virtualActions: [],
    entryRowsList: [],
    waitRowsList: [],
    virtualCreatedRowsList: [],
    virtualExits: [],
    shadowExits: [],
    exits: [],
    realExits: [],
    currentMarketUniverse: null,
    currentMarketWeather: compactMarketWeather(currentMarketWeather),
    marketContext: marketContext
      ? {
          ...marketContext,
          source: compactMarketWeather(marketContext.source),
          universe: null,
          compactedForRedis: true
        }
      : null,
    compactedForVercelRuntime: true,
    detailsAvailableWithDebugParam: true
  };
}
async function saveRunMeta(result) {
  const durableRedis = getDurableRedis();
  const completedAt = now();
  const virtualExits = Array.isArray(result.virtualExits)
    ? result.virtualExits
    : Array.isArray(result.shadowExits)
      ? result.shadowExits
      : [];
  const finalResult = {
    ok: true,
    ...result,
    entryRelaxationProfile: ENTRY_RELAXATION_PROFILE,
    qualityMeasurementProfile: QUALITY_MEASUREMENT_PROFILE,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    virtualExits,
    shadowExits: Array.isArray(result.shadowExits) ? result.shadowExits : virtualExits,
    realExits: [],
    virtualExitRows: virtualExits.length,
    shadowExitRows: virtualExits.length,
    realExitRows: 0,
    skipReason: result.skipReason || result.reason || null,
    completedAt,
    durationMs: completedAt - n(result.startedAt, completedAt),
    actionCounts: result.actionCounts || buildRunActionCounts(result.actions || [], virtualExits),
    rawResultOk: true,
    persistedAt: completedAt,
    persistedBy: 'src/trade/tradeSystem.js',
    persistedNamespace: SHORT_NAMESPACE
  };
  await scopedSetJson(durableRedis, SHORT_KEYS.trade.runMeta, compactRunForRedis(finalResult)).catch(() => null);
  if (finalResult.snapshotId) {
    await scopedSetJson(durableRedis, SHORT_KEYS.trade.lastProcessedSnapshot, {
      snapshotId: finalResult.snapshotId,
      runId: finalResult.runId || null,
      processedAt: completedAt,
      snapshotCreatedAt: finalResult.snapshotCreatedAt || null,
      selectedSnapshotSource: finalResult.selectedSnapshotSource || null,
      selectedTargetCandidateCount: finalResult.selectedTargetCandidateCount || 0,
      entryRows: finalResult.entryRows || 0,
      waitRows: finalResult.waitRows || 0,
      virtualCreatedRows: finalResult.virtualCreatedRows || 0,
      virtualExitRows: finalResult.virtualExitRows || 0,
      discordAlertsSent: finalResult.discordAlertsSent || 0,
      discordAlertsFailed: finalResult.discordAlertsFailed || 0,
      selectedMicroMicroMatchRows: finalResult.selectedMicroMicroMatchRows || 0,
      reason: finalResult.reason || null,
      runtimeWarnings: Array.isArray(finalResult.runtimeWarnings) ? finalResult.runtimeWarnings : [],
      compactedForRedis: true,
      riskPlanVersion: SHORT_RISK_PLAN_VERSION,
      rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
      microMicroVersion: MICRO_MICRO_VERSION,
      ...sideFlags(),
      ...virtualFlags(),
      ...isolationFlags()
    }).catch(() => null);
  }
  return finalResult;
}
function baseEarlyReturnPayload({
  runId,
  startedAt,
  snapshot,
  actions = [],
  realExits = [],
  virtualExits = [],
  shadowExits = [],
  reason,
  runtimeWarnings = [],
  marketContext = {},
  processScannerSnapshot = false,
  priceHints = new Map(),
  extra = {}
}) {
  const cfg = tradeConfig();
  return {
    runId,
    startedAt,
    snapshotId: snapshot?.snapshotId || null,
    selectedSnapshotSource: snapshot?.selectedSnapshotSource || null,
    selectedSnapshotReason: snapshot?.selectedSnapshotReason || null,
    selectedTargetCandidateCount: snapshot?.selectedTargetCandidateCount || 0,
    selectedShortCandidateCount: snapshot?.selectedShortCandidateCount || 0,
    selectedOppositeCandidateCount: snapshot?.selectedOppositeCandidateCount || 0,
    selectedLongCandidateCount: snapshot?.selectedLongCandidateCount || 0,
    blockedNonShortCandidatesCount: snapshot?.blockedNonShortCandidatesCount || 0,
    actions,
    virtualActions: actions,
    realExits,
    virtualExits,
    shadowExits,
    entryRows: 0,
    waitRows: actions.length,
    virtualCreatedRows: 0,
    skippedNewEntries: true,
    reason,
    runtimeWarnings,
    actionCounts: buildRunActionCounts(actions, virtualExits),
    marketContext,
    currentMarketWeather: marketContext?.source || null,
    currentMarketUniverse: null,
    monitorOpenPositions: true,
    monitorOpenPositionsFirst: true,
    processScannerSnapshot,
    monitorPriceHintCount: priceHints.size,
    monitorLivePriceFetchEnabled: cfg.monitorLivePriceFetchEnabled,
    monitorPriceSource: cfg.monitorLivePriceFetchEnabled
      ? 'LIVE_BITGET_TICKER_FIRST_THEN_SCANNER_SNAPSHOT_HINTS'
      : 'SCANNER_SNAPSHOT_HINTS_ONLY_NO_LIVE_FETCH',
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    ...sideFlags(),
    ...virtualFlags(),
    ...isolationFlags(),
    ...extra
  };
}
function hasFullSnapshotShape(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.candidates));
}
function snapshotCreatedAt(snapshot = {}) {
  return n(snapshot.createdAt || snapshot.completedAt || snapshot.ts || snapshot.scannerTs, 0);
}
function extractSnapshotId(latest) {
  if (!latest) return null;
  if (typeof latest === 'string') return latest;
  if (typeof latest === 'object') {
    return latest.snapshotId || latest.id || latest.latestSnapshotId || latest.scanId || null;
  }
  return null;
}
function countTargetCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  return rows.filter((candidate) => inferRowTradeSide(candidate) === TARGET_TRADE_SIDE).length;
}
function countOppositeCandidates(snapshot = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  return rows.filter((candidate) => inferRowTradeSide(candidate) === OPPOSITE_TRADE_SIDE).length;
}
async function safeGetSnapshotJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}
function normalizeSelectedSnapshot(snapshot = {}, meta = {}) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  const targetRows = rows
    .filter((candidate) => inferRowTradeSide(candidate) === TARGET_TRADE_SIDE)
    .map((candidate) => ({
      ...candidate,
      ...scannerMetadataFrom(candidate),
      ...sideFlags(),
      ...isolationFlags(),
      ...virtualFlags(candidate)
    }));
  const blockedNonShortCandidates = rows
    .filter((candidate) => inferRowTradeSide(candidate) !== TARGET_TRADE_SIDE)
    .slice(0, 50)
    .map((candidate) => waitAction(
      normalizeCandidate(candidate),
      'LONG_DISABLED_SHORT_ONLY_SYSTEM',
      {
        skippedBeforeAnalyze: true,
        skippedBeforeLiveFetch: true,
        detectedScannerSide: inferRowTradeSide(candidate)
      }
    ));
  return {
    ...snapshot,
    selectedSnapshotSource: meta.source || null,
    selectedSnapshotReason: meta.reason || null,
    selectedTargetCandidateCount: targetRows.length,
    selectedShortCandidateCount: targetRows.length,
    selectedOppositeCandidateCount: countOppositeCandidates(snapshot),
    selectedLongCandidateCount: countOppositeCandidates(snapshot),
    blockedNonShortCandidates,
    blockedNonShortCandidatesCount: rows.length - targetRows.length,
    ...sideFlags(),
    ...isolationFlags(),
    ...virtualFlags(),
    candidates: targetRows,
    candidatesCount: targetRows.length,
    shortCandidatesCount: targetRows.length,
    longCandidatesCount: 0,
    topSymbols: targetRows.slice(0, 20).map((row) => row.symbol).filter(Boolean)
  };
}
async function loadRecentTargetSnapshotsFromRedis(redis, label, limit = 8) {
  const pattern = namespacedShortKey(
    keyFromMaybeFunction(
      KEYS.short?.scan?.snapshot || KEYS.scan?.shortSnapshot || KEYS.scan?.snapshot,
      '*',
      'SCAN:SNAPSHOT:*'
    ),
    'SCAN:SNAPSHOT:*'
  );
  const keys = await getKeys(redis, pattern, limit).catch(() => []);
  if (!keys.length) return [];
  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetSnapshotJson(redis, key, null);
      if (!hasFullSnapshotShape(snapshot)) return null;
      return {
        key,
        label,
        snapshot,
        targetCount: countTargetCandidates(snapshot),
        oppositeCount: countOppositeCandidates(snapshot),
        createdAt: snapshotCreatedAt(snapshot)
      };
    })
  );
  return rows.filter(Boolean).sort((a, b) => {
    if (b.targetCount !== a.targetCount) return b.targetCount - a.targetCount;
    return b.createdAt - a.createdAt;
  });
}
async function getLatestSnapshot() {
  const volatileRedis = getVolatileRedis();
  const durableRedis = getDurableRedis();
  const stores = [
    { redis: volatileRedis, label: 'VOLATILE' },
    { redis: durableRedis, label: 'DURABLE' }
  ];
  for (const store of stores) {
    const latest = await safeGetSnapshotJson(store.redis, SHORT_KEYS.scan.latest, null);
    const latestSnapshotId = extractSnapshotId(latest);
    if (hasFullSnapshotShape(latest) && countTargetCandidates(latest) > 0) {
      return normalizeSelectedSnapshot(latest, {
        source: `${store.label}:SHORT:SCAN:LATEST_FULL_SNAPSHOT`,
        reason: 'LATEST_SHORT_SCANNER_SNAPSHOT'
      });
    }
    if (latestSnapshotId) {
      const byId = await safeGetSnapshotJson(store.redis, SHORT_KEYS.scan.snapshot(latestSnapshotId), null);
      if (hasFullSnapshotShape(byId) && countTargetCandidates(byId) > 0) {
        return normalizeSelectedSnapshot(byId, {
          source: `${store.label}:SHORT:SCAN:SNAPSHOT_BY_LATEST_ID`,
          reason: 'LATEST_SHORT_SCANNER_SNAPSHOT'
        });
      }
    }
  }
  const recentRows = [
    ...(await loadRecentTargetSnapshotsFromRedis(volatileRedis, 'VOLATILE', 8)),
    ...(await loadRecentTargetSnapshotsFromRedis(durableRedis, 'DURABLE', 8))
  ].sort((a, b) => {
    if (b.targetCount !== a.targetCount) return b.targetCount - a.targetCount;
    return b.createdAt - a.createdAt;
  });
  const best = recentRows.find((row) => row.targetCount > 0) || recentRows[0] || null;
  if (!best?.snapshot) return null;
  return normalizeSelectedSnapshot(best.snapshot, {
    source: `${best.label}:SHORT:SCAN:RECENT_SEARCH:${best.key}`,
    reason: best.targetCount > 0
      ? 'LATEST_SHORT_SCANNER_SNAPSHOT'
      : 'LATEST_SHORT_SCANNER_SNAPSHOT_WITH_NO_SHORT_CANDIDATES'
  });
}
function priceFromSnapshotRow(row = {}) {
  return n(row.currentPrice ?? row.markPrice ?? row.lastPrice ?? row.price ?? row.close ?? row.entry, 0);
}
function buildSnapshotPriceHints(snapshot = {}) {
  const hints = new Map();
  const rows = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];
  for (const row of rows) {
    const price = priceFromSnapshotRow(row);
    if (price <= 0) continue;
    const keys = [
      ...symbolTokensFromAnySymbol(row.symbol),
      ...symbolTokensFromAnySymbol(row.baseSymbol),
      ...symbolTokensFromAnySymbol(row.contractSymbol)
    ];
    for (const key of keys) {
      if (key && !hints.has(key)) hints.set(key, price);
    }
  }
  return hints;
}
function priceHintForSymbol(symbol, priceHints = new Map()) {
  for (const key of symbolTokensFromAnySymbol(symbol)) {
    const value = n(priceHints.get(key), 0);
    if (value > 0) return value;
  }
  return 0;
}
function normalizeBitgetSymbol(symbol = '') {
  const contract = normalizeContractSymbol(symbol);
  const base = normalizeBaseSymbol(symbol || contract);
  const raw = String(contract || symbol || base || '').trim().toUpperCase();
  if (!raw) return '';
  const cleaned = raw
    .replace(/[^A-Z0-9]/g, '')
    .replace(/USDTM$/u, 'USDT')
    .replace(/PERP$/u, '')
    .replace(/SWAP$/u, '');
  if (cleaned.endsWith('USDT')) return cleaned;
  return `${base || cleaned}USDT`;
}
function livePriceCacheKey(symbol = '') {
  return normalizeBitgetSymbol(symbol);
}
function getCachedLivePrice(symbol = '') {
  const key = livePriceCacheKey(symbol);
  if (!key) return 0;
  const cached = livePriceCache.get(key);
  if (!cached) return 0;
  if (now() - n(cached.ts, 0) > LIVE_PRICE_CACHE_TTL_MS) {
    livePriceCache.delete(key);
    return 0;
  }
  return n(cached.price, 0);
}
function setCachedLivePrice(symbol = '', price = 0) {
  const key = livePriceCacheKey(symbol);
  const value = n(price, 0);
  if (!key || value <= 0) return;
  livePriceCache.set(key, {
    price: value,
    ts: now()
  });
}
async function fetchBitgetTickerPrice(symbol = '') {
  const bitgetSymbol = normalizeBitgetSymbol(symbol);
  if (!bitgetSymbol) return 0;
  const cached = getCachedLivePrice(bitgetSymbol);
  if (cached > 0) return cached;
  const url = `${BITGET_BASE_URL}/api/v2/mix/market/ticker?symbol=${encodeURIComponent(bitgetSymbol)}&productType=${encodeURIComponent(BITGET_PRODUCT_TYPE)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' }
  });
  if (!response.ok) return 0;
  const json = await response.json().catch(() => null);
  const data = Array.isArray(json?.data) ? json.data[0] : json?.data;
  const price = n(
    data?.lastPr ??
    data?.last ??
    data?.markPrice ??
    data?.indexPrice ??
    data?.bidPr ??
    data?.askPr,
    0
  );
  if (price > 0) {
    setCachedLivePrice(bitgetSymbol, price);
    return price;
  }
  return 0;
}
async function fetchMidPriceFast(symbol, priceHints = new Map()) {
  const cfg = tradeConfig();
  if (cfg.monitorLivePriceFetchEnabled) {
    const liveResult = await withTimeout(
      fetchBitgetTickerPrice(symbol).catch(() => 0),
      cfg.monitorPriceFetchTimeoutMs,
      'LIVE_PRICE_FETCH_TIMEOUT'
    );
    if (!isTimeoutResult(liveResult)) {
      const livePrice = n(liveResult, 0);
      if (livePrice > 0) return livePrice;
    }
  }
  const hinted = priceHintForSymbol(symbol, priceHints);
  if (hinted > 0) return hinted;
  return 0;
}
function mergeAnalyzeRowsWithLiveRows(analyzedRowsRaw = [], liveRows = []) {
  const liveBySymbol = new Map();
  for (const row of liveRows) {
    const key = symbolKey(row.symbol || row.baseSymbol || row.contractSymbol);
    if (key && !liveBySymbol.has(key)) liveBySymbol.set(key, row);
  }
  const raw = Array.isArray(analyzedRowsRaw) && analyzedRowsRaw.length
    ? analyzedRowsRaw
    : liveRows;
  return raw.map((row) => {
    const key = symbolKey(row.symbol || row.baseSymbol || row.contractSymbol);
    const live = liveBySymbol.get(key) || {};
    return {
      ...live,
      ...row
    };
  });
}
function normalizeAnalyzedRows({
  analyzedRowsRaw,
  liveRows,
  marketContext
}) {
  return mergeAnalyzeRowsWithLiveRows(analyzedRowsRaw, liveRows)
    .filter(Boolean)
    .filter(isTargetRow)
    .map((row) => {
      const exactRow = normalizeExactTrueMicroRow(row, marketContext);
      const contextualRow = attachCurrentFitContext({
        ...exactRow,
        ...scannerMetadataFrom(row, exactRow),
        ...sideFlags(),
        ...virtualFlags(row),
        ...isolationFlags()
      }, marketContext);
      return applyAdaptiveShortRisk(
        normalizeExactTrueMicroRow(contextualRow, marketContext),
        'ADAPTIVE_SHORT_RR_AFTER_ANALYZE_OR_FALLBACK_EXACT_75'
      );
    })
    .filter((row) => Boolean(getTrueMicroFamilyId(row)))
    .filter((row) => Boolean(getMicroMicroFamilyId(row)));
}
async function loadOpenPositionsFast(cfg, runtimeWarnings) {
  const result = await withTimeout(
    getOpenPositions({
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      virtualOnly: true
    }).catch((error) => ({
      __openPositionError: true,
      error: error?.message || String(error)
    })),
    cfg.openPositionLoadTimeoutMs,
    'GET_OPEN_POSITIONS_TIMEOUT'
  );
  if (isTimeoutResult(result)) {
    runtimeWarnings.push('GET_OPEN_POSITIONS_TIMEOUT_USING_EMPTY_SET_FOR_ENTRY_BUDGET');
    return [];
  }
  if (result?.__openPositionError) {
    runtimeWarnings.push(`GET_OPEN_POSITIONS_ERROR_USING_EMPTY_SET:${result.error}`);
    return [];
  }
  return Array.isArray(result) ? result : [];
}
async function saveVirtualPositionFast(entry, cfg) {
  const position = buildOpenPositionFromEntry(entry);
  const result = await withTimeout(
    saveOpenPosition({
      ...position,
      ...isolationFlags()
    }).then(() => ({ ok: true, position })),
    cfg.savePositionTimeoutMs,
    'SAVE_OPEN_POSITION_TIMEOUT'
  );
  if (isTimeoutResult(result)) {
    return {
      ok: false,
      reason: 'SAVE_OPEN_POSITION_TIMEOUT'
    };
  }
  return result?.ok
    ? result
    : {
        ok: false,
        reason: 'SAVE_OPEN_POSITION_FAILED'
      };
}
export async function runTradeSystem(options = {}) {
  const previousOptions = ACTIVE_RUN_OPTIONS;
  ACTIVE_RUN_OPTIONS = options || {};
  try {
    const cfg = tradeConfig();
    const sizing = sizingConfig();
    const durableRedis = getDurableRedis();
    const runId = randomId('trade_run_short');
    const startedAt = now();
    const runtimeWarnings = [];
    const forceProcessSnapshot = Boolean(options.forceProcessSnapshot || options.force);
    const monitorOnly = Boolean(options.monitorOnly);
    const marketContextResult = await withTimeout(
      loadMarketContext().catch(() => extractMarketWeatherShape({}, {})),
      cfg.marketContextTimeoutMs,
      'MARKET_CONTEXT_TIMEOUT'
    );
    const marketContext = isTimeoutResult(marketContextResult)
      ? extractMarketWeatherShape({}, {})
      : marketContextResult;
    if (isTimeoutResult(marketContextResult)) {
      runtimeWarnings.push('MARKET_CONTEXT_TIMEOUT_USING_EMPTY_CONTEXT');
    }
    const snapshot = await getLatestSnapshot();
    const priceHints = buildSnapshotPriceHints(snapshot);
    const monitorResult = await withTimeout(
      monitorOpenPositions({
        priceFetcher: async (symbol) => fetchMidPriceFast(symbol, priceHints),
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        namespace: SHORT_NAMESPACE,
        keyPrefix: SHORT_KEY_PREFIX,
        weekKey: PERSISTENT_LEARNING_KEY,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        virtualOnly: true,
        realOrdersDisabled: true,
        bitgetOrdersDisabled: true,
        exchangeCallsDisabled: true,
        monitorTimeoutMs: cfg.monitorTimeoutMs,
        timeoutMs: cfg.monitorTimeoutMs,
        monitorBatchSize: cfg.monitorBatchSize,
        openPositionMonitorLimit: cfg.openPositionMonitorLimit,
        maxOpenPositionsToMonitor: cfg.openPositionMonitorLimit,
        monitorLivePriceFetchEnabled: cfg.monitorLivePriceFetchEnabled
      }).catch((error) => ({
        __monitorError: true,
        error: error?.message || String(error)
      })),
      cfg.monitorTimeoutMs,
      'MONITOR_OPEN_POSITIONS_TIMEOUT'
    );
    const virtualExits = Array.isArray(monitorResult) ? monitorResult : [];
    if (isTimeoutResult(monitorResult)) {
      runtimeWarnings.push('MONITOR_OPEN_POSITIONS_TIMEOUT_CONTINUING_TO_ENTRY_LOOP');
    } else if (monitorResult?.__monitorError) {
      runtimeWarnings.push(`MONITOR_OPEN_POSITIONS_ERROR_CONTINUING_TO_ENTRY_LOOP:${monitorResult.error}`);
    }
    const shadowExits = virtualExits;
    const realExits = [];
    if (monitorOnly) {
      return saveRunMeta(baseEarlyReturnPayload({
        runId,
        startedAt,
        snapshot,
        actions: [],
        realExits,
        virtualExits,
        shadowExits,
        reason: 'MONITOR_ONLY',
        runtimeWarnings,
        marketContext,
        processScannerSnapshot: false,
        priceHints
      }));
    }
    if (!snapshot?.snapshotId) {
      return saveRunMeta(baseEarlyReturnPayload({
        runId,
        startedAt,
        snapshot,
        actions: [],
        realExits,
        virtualExits,
        shadowExits,
        reason: 'NO_SHORT_SCANNER_SNAPSHOT',
        runtimeWarnings,
        marketContext,
        processScannerSnapshot: true,
        priceHints
      }));
    }
    const snapshotAgeSec = (now() - n(snapshot.createdAt, 0)) / 1000;
    if (snapshotAgeSec > cfg.maxSnapshotAgeSec) {
      const actions = Array.isArray(snapshot.blockedNonShortCandidates)
        ? snapshot.blockedNonShortCandidates
        : [];
      return saveRunMeta(baseEarlyReturnPayload({
        runId,
        startedAt,
        snapshot,
        actions,
        realExits,
        virtualExits,
        shadowExits,
        reason: 'SNAPSHOT_TOO_STALE',
        runtimeWarnings,
        marketContext,
        processScannerSnapshot: false,
        priceHints,
        extra: {
          snapshotAgeSec: Math.round(snapshotAgeSec)
        }
      }));
    }
    const lastProcessed = await getJson(durableRedis, SHORT_KEYS.trade.lastProcessedSnapshot, null).catch(() => null);
    const sameSnapshot = lastProcessed?.snapshotId === snapshot.snapshotId;
    if (sameSnapshot && !forceProcessSnapshot) {
      const actions = Array.isArray(snapshot.blockedNonShortCandidates)
        ? snapshot.blockedNonShortCandidates
        : [];
      return saveRunMeta(baseEarlyReturnPayload({
        runId,
        startedAt,
        snapshot,
        actions,
        realExits,
        virtualExits,
        shadowExits,
        reason: 'SNAPSHOT_ALREADY_PROCESSED',
        runtimeWarnings,
        marketContext,
        processScannerSnapshot: false,
        priceHints
      }));
    }
    const activeRotationResult = await withTimeout(
      getActiveRotation({
        weekKey: PERSISTENT_LEARNING_KEY,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        targetTradeSide: TARGET_TRADE_SIDE,
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        namespace: SHORT_NAMESPACE,
        keyPrefix: SHORT_KEY_PREFIX,
        redisNamespace: SHORT_NAMESPACE,
        redisKeyPrefix: SHORT_KEY_PREFIX,
        shortOnly: true,
        longDisabled: true,
        exactTrueMicroOnly: true,
        selectionGranularity: SELECTION_EXACT_MICRO_MICRO,
        trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        microMicroFamilySchema: MICRO_MICRO_SCHEMA,
        trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
        learningGranularity: LEARNING_GRANULARITY,
        parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
        microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
        microMicroVersion: MICRO_MICRO_VERSION
      }).catch(() => null),
      cfg.rotationTimeoutMs,
      'ACTIVE_ROTATION_TIMEOUT'
    );
    const activeRotation = isTimeoutResult(activeRotationResult) ? null : activeRotationResult;
    if (isTimeoutResult(activeRotationResult)) {
      runtimeWarnings.push('ACTIVE_ROTATION_TIMEOUT_DISCORD_SELECTION_EMPTY');
    }
    const alertContext = buildSelectedAlertContext(activeRotation);
    const preAnalyzeBlockedActions = Array.isArray(snapshot.blockedNonShortCandidates)
      ? snapshot.blockedNonShortCandidates
      : [];
    const allTargetCandidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
      .filter((candidate) => inferRowTradeSide(candidate) === TARGET_TRADE_SIDE);
    const candidates = allTargetCandidates
      .slice(0, cfg.maxCandidatesPerSnapshot)
      .map((candidate) => attachCurrentFitContext({
        ...candidate,
        ...scannerMetadataFrom(candidate),
        ...sideFlags(),
        ...isolationFlags(),
        ...virtualFlags(candidate),
        btcState: snapshot.btcState,
        regime: snapshot.regime
      }, marketContext));
    const cappedCandidateCount = Math.max(0, allTargetCandidates.length - candidates.length);
    if (cappedCandidateCount > 0) {
      runtimeWarnings.push(`SHORT_CANDIDATES_CAPPED_FOR_ENTRY_BUDGET:${cappedCandidateCount}`);
    }
    const processed = await mapConcurrent(candidates, cfg.dataConcurrency, safeProcessCandidate);
    const candidateTimeoutRows = processed.filter((row) => row?.timedOut).length;
    if (candidateTimeoutRows > 0) {
      runtimeWarnings.push(`CANDIDATE_TIMEOUT_ROWS:${candidateTimeoutRows}`);
    }
    const earlyActions = [
      ...preAnalyzeBlockedActions,
      ...processed.flatMap((row) => Array.isArray(row?.actions) ? row.actions : []).filter(Boolean)
    ];
    const liveRows = processed
      .flatMap((row) => Array.isArray(row?.metrics) ? row.metrics : [])
      .filter(Boolean)
      .filter(isTargetRow)
      .map((row) => attachCurrentFitContext({
        ...row,
        ...sideFlags(),
        ...isolationFlags(),
        ...virtualFlags(row)
      }, marketContext))
      .slice(0, cfg.analyzeMaxCandidatesPerSnapshot);
    const actualLiveRows = liveRows.length;
    const observationOnlyRows = liveRows.filter((row) => row.observationOnly || row.analysisInputOnly).length;
    const standardizedLearningRiskRows = liveRows.filter((row) => row.standardizedLearningRisk).length;
    const learningOnlyRows = liveRows.filter((row) => row.learningOnly).length;
    const riskValidRows = liveRows.filter(hasValidRiskShape).length;
    let analyzedRowsRaw = [];
    let analyzeError = null;
    let analyzeFallbackUsed = false;
    try {
      const analyzeResult = await withTimeout(
        analyzeCandidatesBatch(liveRows, {
          weekKey: PERSISTENT_LEARNING_KEY,
          persistentLearningKey: PERSISTENT_LEARNING_KEY,
          targetTradeSide: TARGET_TRADE_SIDE,
          tradeSide: TARGET_TRADE_SIDE,
          positionSide: TARGET_TRADE_SIDE,
          direction: TARGET_TRADE_SIDE,
          side: TARGET_DASHBOARD_SIDE,
          scannerSide: TARGET_SCANNER_SIDE,
          actualScannerSide: TARGET_SCANNER_SIDE,
          dashboardSide: TARGET_DASHBOARD_SIDE,
          shortOnly: true,
          longDisabled: true,
          longOnly: false,
          shortDisabled: false,
          virtualOnly: true,
          virtualLearning: true,
          realOrdersDisabled: true,
          bitgetOrdersDisabled: true,
          exchangeCallsDisabled: true,
          observationAlwaysCounted: false,
          observationDedupeRequired: true,
          observationDedupeEnabled: true,
          seenDefinition: 'UNIQUE_SNAPSHOT_SYMBOL_TRUE_MICRO_OBSERVATION_ONLY',
          scannerFingerprintsMetadataOnly: true,
          scannerFingerprintsUsedAsLearningFamily: false,
          executionFingerprintsMetadataOnly: false,
          executionFingerprintsUsedAsLearningFamily: true,
          executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
          analyzeMicroFamiliesOnly: true,
          learningIdentitySource: 'ANALYZE_PARENT_MICRO_MICRO_LAYERED',
          symbolExcludedFromFamilyId: true,
          coinNameExcludedFromFamilyId: true,
          hashesExcludedFromFamilyId: true,
          trueMicroOnly: true,
          exactTrueMicroOnly: true,
          exactTrueMicroFamilyRequired: true,
          fixedTaxonomyPreferred: true,
          trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
          parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
          microMicroFamilySchema: MICRO_MICRO_SCHEMA,
          trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
          learningGranularity: LEARNING_GRANULARITY,
          parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
          microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
          parentLearningEnabled: true,
          childLearningEnabled: true,
          microMicroLearningEnabled: true,
          layeredLearningEnabled: true,
          selectionGranularity: SELECTION_EXACT_MICRO_MICRO,
          fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',
          currentMarketWeather: marketContext.source || null,
          currentMarketUniverse: marketContext.universe || null,
          currentMarketWeatherKey: MARKET_WEATHER_KEY,
          currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
          currentRegime: marketContext.regime,
          currentTrendSide: marketContext.trendSide,
          currentFitSoftOnly: true,
          currentFitBlocksLearning: false,
          currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
          currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
          riskPlanVersion: SHORT_RISK_PLAN_VERSION,
          rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
          riskGeometryRule: 'SHORT: tp < entry < sl',
          tpHitRule: 'SHORT: price <= tp',
          slHitRule: 'SHORT: price >= sl',
          grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
          currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
          microMicroVersion: MICRO_MICRO_VERSION
        }),
        cfg.analyzeTimeoutMs,
        'ANALYZE_CANDIDATES_TIMEOUT'
      );
      if (isTimeoutResult(analyzeResult)) {
        analyzeError = 'ANALYZE_CANDIDATES_TIMEOUT';
        analyzeFallbackUsed = true;
        runtimeWarnings.push('ANALYZE_CANDIDATES_TIMEOUT_USING_FALLBACK_EXACT_75_AND_MICRO_MICRO_ROWS');
        analyzedRowsRaw = liveRows;
      } else {
        analyzedRowsRaw = Array.isArray(analyzeResult) ? analyzeResult : [];
        if (!analyzedRowsRaw.length) {
          analyzeFallbackUsed = true;
          runtimeWarnings.push('ANALYZE_RETURNED_EMPTY_USING_FALLBACK_EXACT_75_AND_MICRO_MICRO_ROWS');
          analyzedRowsRaw = liveRows;
        }
      }
    } catch (error) {
      analyzeError = error?.message || String(error);
      analyzeFallbackUsed = true;
      runtimeWarnings.push(`ANALYZE_CANDIDATES_ERROR_USING_FALLBACK_EXACT_75_AND_MICRO_MICRO_ROWS:${analyzeError}`);
      analyzedRowsRaw = liveRows;
    }
    const analyzedRows = normalizeAnalyzedRows({
      analyzedRowsRaw,
      liveRows,
      marketContext
    });
    const analyzedActualRows = analyzedRows.length;
    const analyzedRiskValidRows = analyzedRows.filter(hasValidRiskShape).length;
    const analyzedExact75Rows = analyzedRows.filter((row) => Boolean(getTrueMicroFamilyId(row))).length;
    const analyzedMicroMicroRows = analyzedRows.filter((row) => Boolean(getMicroMicroFamilyId(row))).length;
    const fallbackExact75Rows = analyzedRows.filter((row) => row.fallbackExact75).length;
    const analyzedStandardizedLearningRiskRows = analyzedRows.filter((row) => row.standardizedLearningRisk).length;
    const openPositions = await loadOpenPositionsFast(cfg, runtimeWarnings);
    const openSymbolSet = buildOpenSymbolSet(openPositions);
    const openPositionCountBeforeEntries = openPositions.length;
    const actions = [...earlyActions];
    let entryRows = 0;
    let waitRows = earlyActions.length;
    let virtualCreatedRows = 0;
    let virtualSkippedRows = 0;
    let virtualFailedRows = 0;
    let skippedByExistingSymbol = 0;
    let discordAlertEligibleRows = 0;
    let discordAlertsQueued = 0;
    let discordAlertsSent = 0;
    let discordAlertsFailed = 0;
    let discordAlertsSkippedNoSelectedMicro = 0;
    let discordAlertsSkippedCurrentFit = 0;
    let selectedMicroMicroMatchRows = 0;
    let unselectedMicroEntryRows = 0;
    let entryLoopAttempts = 0;
    let entryLoopRuntimeBreak = false;
    for (const row of analyzedRows) {
      entryLoopAttempts += 1;
      const minimumAttemptsStillRequired = entryLoopAttempts <= cfg.minEntryLoopAttempts;
      if (!minimumAttemptsStillRequired && runtimeExceeded(startedAt, cfg, cfg.entryLoopReserveMs)) {
        runtimeWarnings.push(`MAX_RUNTIME_REACHED_ENTRY_LOOP_STOPPED_AFTER_MIN_ATTEMPTS:${entryLoopAttempts - 1}`);
        entryLoopRuntimeBreak = true;
        break;
      }
      const trueMicroFamilyId = getTrueMicroFamilyId(row);
      const microMicroFamilyId = getMicroMicroFamilyId(row);
      const virtualGate = validateVirtualEntry(row);
      if (!virtualGate.ok) {
        waitRows += 1;
        virtualSkippedRows += 1;
        actions.push({
          ...row,
          action: 'WAIT',
          reason: virtualGate.reason,
          selectedRotationId: alertContext.rotationId,
          activeRotationId: alertContext.rotationId,
          activeParentTrueMicroFamilyId: getParentTrueMicroFamilyId(row) || null,
          microMicroFamilyId: microMicroFamilyId || null,
          trueMicroMicroFamilyId: microMicroFamilyId || null,
          exactMicroMicroFamilyId: microMicroFamilyId || null,
          virtualGate,
          virtualTracked: false,
          liveEligible: false,
          ...sideFlags(),
          ...virtualFlags(row),
          ...isolationFlags()
        });
        continue;
      }
      if (hasOpenSymbol(openSymbolSet, row)) {
        waitRows += 1;
        virtualSkippedRows += 1;
        skippedByExistingSymbol += 1;
        actions.push({
          ...row,
          action: 'WAIT',
          reason: 'SYMBOL_ALREADY_OPEN_VIRTUAL_POSITION',
          selectedRotationId: alertContext.rotationId,
          activeRotationId: alertContext.rotationId,
          virtualTracked: true,
          liveEligible: false,
          oneOpenPositionPerSymbol: true,
          globalMaxOpenPositionsBlockDisabled: true,
          existingSymbolCheckedFromMemorySet: true,
          microMicroFamilyId: microMicroFamilyId || null,
          trueMicroMicroFamilyId: microMicroFamilyId || null,
          exactMicroMicroFamilyId: microMicroFamilyId || null,
          ...sideFlags(),
          ...virtualFlags(row),
          ...isolationFlags()
        });
        continue;
      }
      const selectedAlertMatch = selectedAlertMatchInfo(alertContext, row);
      const selectedWeeklyStats = getSelectedWeeklyStats(
        alertContext,
        selectedAlertMatch.selectedMicroMicroFamilyId || microMicroFamilyId
      );
      const sizingStats = selectedWeeklyStats || row;
      const riskFraction = sizing.enabled
        ? riskFractionForEntry({
            weeklyStats: sizingStats,
            side: TARGET_DASHBOARD_SIDE,
            tradeSide: TARGET_TRADE_SIDE
          })
        : sizing.baseRiskPct;
      const currentFitGate = discordCurrentFitGate(row);
      const discordAlertEligible =
        selectedAlertMatch.ok &&
        selectedAlertMatch.granularity === LAYER_MICRO_MICRO &&
        currentFitGate.ok;
      if (selectedAlertMatch.ok && selectedAlertMatch.granularity === LAYER_MICRO_MICRO) {
        selectedMicroMicroMatchRows += 1;
      } else {
        discordAlertsSkippedNoSelectedMicro += 1;
        unselectedMicroEntryRows += 1;
      }
      if (selectedAlertMatch.ok && !currentFitGate.ok) {
        discordAlertsSkippedCurrentFit += 1;
      }
      if (discordAlertEligible) {
        discordAlertEligibleRows += 1;
      }
      const entry = buildVirtualEntryAction({
        row,
        alertContext,
        selectedWeeklyStats,
        riskFraction,
        virtualGate,
        selectedAlertMatch,
        discordAlertEligible
      });
      try {
        const saveResult = await saveVirtualPositionFast(entry, cfg);
        if (!saveResult.ok) {
          throw new Error(saveResult.reason || 'SAVE_OPEN_POSITION_FAILED');
        }
        rememberOpenSymbol(openSymbolSet, entry);
        openPositions.push(saveResult.position || entry);
        entryRows += 1;
        virtualCreatedRows += 1;
        const discordResult = await maybeSendDiscordEntryAlert(entry, cfg);
        if (discordResult.queued) discordAlertsQueued += 1;
        if (discordResult.sent) discordAlertsSent += 1;
        if (discordResult.failed) discordAlertsFailed += 1;
        actions.push({
          ...entry,
          discordAlertResult: discordResult,
          discordAlertQueued: Boolean(discordResult.queued),
          discordAlertSent: Boolean(discordResult.sent),
          discordAlertFailed: Boolean(discordResult.failed),
          ...isolationFlags()
        });
      } catch (error) {
        waitRows += 1;
        virtualFailedRows += 1;
        actions.push({
          ...row,
          action: 'WAIT',
          reason: 'VIRTUAL_POSITION_CREATE_FAILED',
          error: error?.message || String(error),
          selectedRotationId: alertContext.rotationId,
          activeRotationId: alertContext.rotationId,
          virtualTracked: false,
          liveEligible: false,
          microMicroFamilyId: microMicroFamilyId || null,
          trueMicroMicroFamilyId: microMicroFamilyId || null,
          exactMicroMicroFamilyId: microMicroFamilyId || null,
          ...sideFlags(),
          ...virtualFlags(row),
          ...isolationFlags()
        });
      }
    }
    if (entryLoopAttempts > 0 && !entryLoopRuntimeBreak) {
      runtimeWarnings.push(`ENTRY_LOOP_COMPLETED_ATTEMPTS:${entryLoopAttempts}`);
    }
    const counts = buildRunActionCounts(actions, virtualExits);
    const qualityAudit = buildQualityAudit({
      snapshot,
      candidates,
      processed,
      liveRows,
      analyzedRowsRaw,
      analyzedRows,
      actions,
      virtualExits,
      counts: {
        riskValidRows,
        analyzedRiskValidRows,
        analyzedExact75Rows,
        analyzedMicroMicroRows,
        fallbackExact75Rows,
        entryRows,
        virtualCreatedRows,
        waitRows,
        skippedByExistingSymbol,
        selectedAlertMicroMicroMatches: selectedMicroMicroMatchRows,
        discordCurrentFitBlockedRows: discordAlertsSkippedCurrentFit
      },
      openPositionCountBeforeEntries,
      openPositionCountAfterEntries: openPositions.length,
      marketContext,
      runtimeWarnings
    });
    const baseResult = {
      runId,
      runPhase: options.runPhase || options.tradeRunPhase || null,
      startedAt,
      snapshotId: snapshot.snapshotId,
      snapshotCreatedAt: snapshot.createdAt,
      snapshotAgeSec: Math.round(snapshotAgeSec),
      forceProcessSnapshot,
      selectedSnapshotSource: snapshot.selectedSnapshotSource || null,
      selectedSnapshotReason: snapshot.selectedSnapshotReason || null,
      selectedTargetCandidateCount: snapshot.selectedTargetCandidateCount || 0,
      selectedShortCandidateCount: snapshot.selectedShortCandidateCount || 0,
      selectedOppositeCandidateCount: snapshot.selectedOppositeCandidateCount || 0,
      selectedLongCandidateCount: snapshot.selectedLongCandidateCount || 0,
      blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0,
      entryRelaxationProfile: cfg.entryRelaxationProfile,
      qualityMeasurementProfile: cfg.qualityMeasurementProfile,
      scannerWideVirtualLearning: true,
      tradeEveryScannerCandidateVirtual: true,
      riskPlanVersion: SHORT_RISK_PLAN_VERSION,
      rrShadowGridVersion: RR_SHADOW_GRID_VERSION,
      microMicroVersion: MICRO_MICRO_VERSION,
      defaultRR: cfg.defaultRR,
      minRR: cfg.minRR,
      maxRR: cfg.maxRR,
      minRewardPct: cfg.minRewardPct,
      minDiscordRewardPct: cfg.minDiscordRewardPct,
      minRiskPct: cfg.minRiskPct,
      maxRiskPct: cfg.maxRiskPct,
      fallbackRiskPct: cfg.fallbackRiskPct,
      maxRiskToRewardDistanceRatio: cfg.maxRiskToRewardDistanceRatio,
      maxEstimatedCostR: cfg.maxEstimatedCostR,
      hardMaxEstimatedCostR: cfg.hardMaxEstimatedCostR,
      maxCandidatesPerSnapshot: cfg.maxCandidatesPerSnapshot,
      analyzeMaxCandidatesPerSnapshot: cfg.analyzeMaxCandidatesPerSnapshot,
      hardMaxCandidatesPerSnapshot: cfg.hardMaxCandidatesPerSnapshot,
      dataConcurrency: cfg.dataConcurrency,
      candidateTimeoutMs: cfg.candidateTimeoutMs,
      analyzeTimeoutMs: cfg.analyzeTimeoutMs,
      monitorTimeoutMs: cfg.monitorTimeoutMs,
      monitorPriceFetchTimeoutMs: cfg.monitorPriceFetchTimeoutMs,
      monitorLivePriceFetchEnabled: cfg.monitorLivePriceFetchEnabled,
      monitorBatchSize: cfg.monitorBatchSize,
      openPositionMonitorLimit: cfg.openPositionMonitorLimit,
      minEntryLoopAttempts: cfg.minEntryLoopAttempts,
      entryLoopReserveMs: cfg.entryLoopReserveMs,
      marketContextTimeoutMs: cfg.marketContextTimeoutMs,
      maxRuntimeMs: cfg.maxRuntimeMs,
      ...sideFlags(),
      ...virtualFlags(),
      ...isolationFlags(),
      currentMarketWeather: compactMarketWeather(marketContext.source || null),
      currentMarketUniverse: null,
      currentMarketWeatherKey: MARKET_WEATHER_KEY,
      currentMarketUniverseKey: MARKET_UNIVERSE_KEY,
      currentMarketWeatherAgeSec: marketContext.ageSec,
      currentMarketWeatherStale: marketContext.stale,
      currentRegime: marketContext.regime,
      currentTrendSide: marketContext.trendSide,
      currentBullishPct: marketContext.bullishPct,
      currentBearishPct: marketContext.bearishPct,
      currentSqueezePct: marketContext.squeezePct,
      marketContext: {
        ...marketContext,
        source: compactMarketWeather(marketContext.source || null),
        universe: null,
        compactedForRedis: true
      },
      candidates: candidates.length,
      allShortCandidatesBeforeCap: allTargetCandidates.length,
      cappedCandidateCount,
      shortCandidateCount: candidates.length,
      longCandidateCount: 0,
      nonShortCandidateCount: snapshot.blockedNonShortCandidatesCount || 0,
      processed: processed.length,
      earlyActions: earlyActions.length,
      liveRows: liveRows.length,
      analyzeInputRows: liveRows.length,
      actualLiveRows,
      observationOnlyRows,
      standardizedLearningRiskRows,
      learningOnlyRows,
      riskValidRows,
      analyzedRows: analyzedRows.length,
      analyzedRowsRaw: analyzedRowsRaw.length,
      analyzedActualRows,
      analyzedRiskValidRows,
      analyzedExact75Rows,
      analyzedMicroMicroRows,
      fallbackExact75Rows,
      analyzedStandardizedLearningRiskRows,
      analyzeError,
      analyzeFallbackUsed,
      analyzeWeekKey: PERSISTENT_LEARNING_KEY,
      entryRows,
      waitRows,
      virtualCreatedRows,
      virtualSkippedRows,
      virtualFailedRows,
      skippedByExistingSymbol,
      shadowCreatedRows: virtualCreatedRows,
      shadowSkippedRows: virtualSkippedRows,
      shadowFailedRows: virtualFailedRows,
      shadowDisabled: false,
      virtualExits,
      shadowExits,
      realExits: [],
      virtualExitRows: virtualExits.length,
      shadowExitRows: virtualExits.length,
      realExitRows: 0,
      discordRequiresCurrentFit: discordRequiresCurrentFit(),
      discordMinCurrentFitConfidence: discordMinCurrentFitConfidence(),
      discordAlertEligibleRows,
      discordAlertsQueued,
      discordAlertsSent,
      discordAlertsFailed,
      discordAlertsSkippedNoSelectedMicro,
      discordAlertsSkippedCurrentFit,
      selectedMicroMatchRows: selectedMicroMicroMatchRows,
      selectedAlertMicroMatches: selectedMicroMicroMatchRows,
      selectedMicroMicroMatchRows,
      selectedAlertMicroMicroMatches: selectedMicroMicroMatchRows,
      selected75ChildMatchRows: 0,
      selectedAlert75ChildMatches: 0,
      unselectedMicroEntryRows,
      openPositionCountBeforeEntries,
      openPositionCountAfterEntries: openPositions.length,
      entryLoopAttempts,
      entryLoopRuntimeBreak,
      actions,
      virtualActions: actions,
      actionCounts: counts,
      actionsCount: actions.length,
      rawActionsCount: actions.length,
      rawExitRowsCount: virtualExits.length,
      qualityAudit,
      runtimeWarnings,
      selectedRotationId: alertContext.rotationId,
      activeRotationId: alertContext.rotationId,
      selectedMicroFamilies: 0,
      selectedTrueMicroFamilies: 0,
      selectedChildTrueMicroFamilies: 0,
      selectedMicroFamilyIds: [],
      selectedTrueMicroFamilyIds: [],
      selectedChildTrueMicroFamilyIds: [],
      selectedMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      selectedTrueMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      selectedExactMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      selectedMicroMicroFamilyIds: alertContext.selectedMicroMicroFamilyIds,
      selectedTrueMicroMicroFamilyIds: alertContext.selectedTrueMicroMicroFamilyIds,
      selectedExactMicroMicroFamilyIds: alertContext.selectedExactMicroMicroFamilyIds,
      activeMicroFamilies: 0,
      activeTrueMicroFamilies: 0,
      activeChildTrueMicroFamilies: 0,
      activeMicroFamilyIds: [],
      activeTrueMicroFamilyIds: [],
      activeChildTrueMicroFamilyIds: [],
      activeMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      activeTrueMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      activeExactMicroMicroFamilies: alertContext.selectedMicroMicroFamilyIds.length,
      activeMicroMicroFamilyIds: alertContext.selectedMicroMicroFamilyIds,
      activeTrueMicroMicroFamilyIds: alertContext.selectedTrueMicroMicroFamilyIds,
      activeExactMicroMicroFamilyIds: alertContext.selectedExactMicroMicroFamilyIds,
      activeMacroFamilyIds: [],
      selectedMacroFamilyIds: [],
      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      exactTrueMicroFamilyRequired: true,
      microMicroSelectionEnabled: true,
      microMicroRequiredForVirtualEntry: true,
      allowCoarseMicroAliasLiveEntries: false,
      allowCoarseMicroAliasForDiscord: false,
      selectionPurpose: 'DISCORD_ALERT_ONLY',
      manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ONLY',
      discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
      scannerSnapshotStats: {
        candidatesCount: snapshot.candidatesCount || candidates.length,
        scannerGateCandidatesCount: snapshot.scannerGateCandidatesCount || null,
        analyzeOnlyCandidatesCount: snapshot.analyzeOnlyCandidatesCount || null,
        filteredUniverse: snapshot.filteredUniverse || null,
        rawCount: snapshot.rawCount || null,
        blockedNonShortCandidatesCount: snapshot.blockedNonShortCandidatesCount || 0
      },
      scannerLatestPreserved: true,
      scannerSnapshotPreserved: true,
      scannerHistoryPreserved: true,
      microFamiliesAppendOnly: true,
      analyzePartialOnly: true,
      analyzeFullOverwriteDisabled: true,
      rotationPreserved: true,
      manualSelectionPreserved: true,
      discordSelectionPreserved: true,
      monitorOpenPositions: true,
      monitorOpenPositionsFirst: true,
      monitorPriceHintCount: priceHints.size,
      monitorPriceSource: cfg.monitorLivePriceFetchEnabled
        ? 'LIVE_BITGET_TICKER_FIRST_THEN_SCANNER_SNAPSHOT_HINTS'
        : 'SCANNER_SNAPSHOT_HINTS_ONLY_NO_LIVE_FETCH',
      processScannerSnapshot: true,
      skipped: false,
      skippedNewEntries: false,
      reason: null,
      skipReason: null
    };
    return saveRunMeta(baseResult);
  } finally {
    ACTIVE_RUN_OPTIONS = previousOptions;
  }
}