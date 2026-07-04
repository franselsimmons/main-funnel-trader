// ================= FILE: src/trade/positionEngine.js =================

import { createHash } from 'crypto';
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
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';

const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MICRO_MICRO_VERSION = 'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V1';
const RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const COST_MODEL_VERSION = 'POSITION_ENGINE_SHORT_NET_COST_V12_HARD_TIME_STOP';
const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V1';
const OBSERVATION_DEDUPE_VERSION = 'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V2';
const OUTCOME_DEDUPE_VERSION = 'SHORT_OUTCOME_DEDUPE_CLOSED_POSITION_V4_HARD_TIME_STOP';

const HARD_TIME_STOP_CLEANUP_VERSION = 'SHORT_POSITION_ENGINE_HARD_TIME_STOP_PRE_PRICE_EXIT_V1';

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const POSITION_SOURCE = 'VIRTUAL';
const OUTCOME_SOURCE = 'VIRTUAL';

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const DEFAULT_OPEN_POSITION_SCAN_LIMIT = 300;
const DEFAULT_OPEN_POSITION_HYDRATE_LIMIT = 300;
const DEFAULT_OPEN_POSITION_READ_CONCURRENCY = 4;
const DEFAULT_OPEN_POSITION_KEYS_TIMEOUT_MS = 900;
const DEFAULT_OPEN_POSITION_READ_TIMEOUT_MS = 1800;

const DEFAULT_MONITOR_POSITION_LIMIT = 150;
const DEFAULT_MONITOR_BATCH_SIZE = 100;
const DEFAULT_MONITOR_CONCURRENCY = 3;
const DEFAULT_MONITOR_RUNTIME_MS = 12000;
const DEFAULT_MONITOR_ONE_POSITION_TIMEOUT_MS = 2500;
const DEFAULT_PRICE_FETCH_TIMEOUT_MS = 350;
const DEFAULT_CANDLE_FETCH_TIMEOUT_MS = 1200;
const DEFAULT_RECORD_OUTCOME_TIMEOUT_MS = 1500;
const DEFAULT_DISCORD_EXIT_TIMEOUT_MS = 1200;

const BITGET_BASE_URL = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const BITGET_CANDLE_GRANULARITY = '1m';
const BITGET_CANDLE_MS = 60 * 1000;

const DEFAULT_RANGE_LOOKBACK_MS = 15 * 60 * 1000;
const DEFAULT_MAX_RANGE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RANGE_OVERLAP_MS = 15 * 1000;
const DEFAULT_CANDLE_FIRST_TOUCH_MIN_AGE_MS = 2 * 60 * 1000;

const SHORT_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_ORDER = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const SHORT_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

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

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(safeNumber(value, fallback));
  return Math.max(min, Math.min(max, n));
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

function hashText(value, length = MICRO_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, length);
}

function elapsedMs(startedAt) {
  return Math.max(0, now() - safeNumber(startedAt, now()));
}

function runtimeExceeded(startedAt, maxRuntimeMs, reserveMs = 150) {
  return elapsedMs(startedAt) >= Math.max(
    100,
    safeNumber(maxRuntimeMs, DEFAULT_MONITOR_RUNTIME_MS) - reserveMs
  );
}

function timeoutResult(label, timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        __timeout: true,
        label,
        timeoutMs
      });
    }, Math.max(1, Math.floor(safeNumber(timeoutMs, 1))));
  });
}

async function withTimeout(promise, timeoutMs, label, fallback = null) {
  const result = await Promise.race([
    Promise.resolve(promise).catch((error) => ({
      __error: true,
      label,
      error: error?.message || String(error)
    })),
    timeoutResult(label, timeoutMs)
  ]);

  if (result?.__timeout || result?.__error) {
    return fallback ?? result;
  }

  return result;
}

function clonePlainObject(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value ?? null));
}

function namespacedShortKey(key, fallback) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${SHORT_KEY_PREFIX}MISSING_KEY`;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function storageSymbol(input) {
  const raw = typeof input === 'object'
    ? input?.symbol || input?.baseSymbol || input?.contractSymbol
    : input;

  const base = normalizeBaseSymbol(raw);

  return base || String(raw || '').toUpperCase().trim();
}

function symbolFromOpenKey(key = '') {
  const raw = String(key || '').trim();
  const part = raw.split(':').pop();

  return storageSymbol(part);
}

function resolveOpenPatternKey() {
  const configured =
    KEYS.short?.trade?.openPattern ||
    KEYS.trade?.shortOpenPattern ||
    KEYS.trade?.openPattern;

  return namespacedShortKey(configured, 'TRADE:OPEN:*');
}

function resolveOpenKey(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return null;

  if (typeof KEYS.short?.trade?.open === 'function') {
    return namespacedShortKey(
      KEYS.short.trade.open(keySymbol),
      `TRADE:OPEN:${keySymbol}`
    );
  }

  if (typeof KEYS.trade?.shortOpen === 'function') {
    return namespacedShortKey(
      KEYS.trade.shortOpen(keySymbol),
      `TRADE:OPEN:${keySymbol}`
    );
  }

  if (typeof KEYS.trade?.open === 'function') {
    return namespacedShortKey(
      KEYS.trade.open(keySymbol),
      `TRADE:OPEN:${keySymbol}`
    );
  }

  return namespacedShortKey(null, `TRADE:OPEN:${keySymbol}`);
}

const SHORT_KEYS = {
  trade: {
    openPattern: resolveOpenPatternKey(),
    open: resolveOpenKey
  }
};

function tradeConfig(options = {}) {
  return {
    dataConcurrency: clampInt(
      options.dataConcurrency ??
        CONFIG.short?.trade?.dataConcurrency ??
        CONFIG.trade?.dataConcurrency,
      DEFAULT_MONITOR_CONCURRENCY,
      1,
      5
    ),

    positionTimeStopMin: Math.max(
      1,
      safeNumber(
        options.positionTimeStopMin ??
          CONFIG.short?.trade?.positionTimeStopMin ??
          CONFIG.trade?.positionTimeStopMin,
        DEFAULT_POSITION_TIME_STOP_MIN
      )
    ),

    hardTimeStopNoPriceExit:
      options.hardTimeStopNoPriceExit !== false &&
      CONFIG.short?.trade?.hardTimeStopNoPriceExit !== false &&
      CONFIG.trade?.hardTimeStopNoPriceExit !== false,

    closeExpiredBeforePriceFetch:
      options.closeExpiredBeforePriceFetch !== false &&
      CONFIG.short?.trade?.closeExpiredBeforePriceFetch !== false &&
      CONFIG.trade?.closeExpiredBeforePriceFetch !== false,

    openPositionScanLimit: clampInt(
      options.limit ??
        options.openPositionLimit ??
        options.maxOpenPositionsToRead ??
        CONFIG.short?.trade?.openPositionScanLimit ??
        CONFIG.trade?.openPositionScanLimit,
      DEFAULT_OPEN_POSITION_SCAN_LIMIT,
      1,
      1000
    ),

    hydrateLimit: clampInt(
      options.hydrateLimit ??
        options.openPositionHydrateLimit ??
        CONFIG.short?.trade?.openPositionHydrateLimit ??
        CONFIG.trade?.openPositionHydrateLimit,
      DEFAULT_OPEN_POSITION_HYDRATE_LIMIT,
      0,
      1000
    ),

    readConcurrency: clampInt(
      options.openPositionReadConcurrency ??
        CONFIG.short?.trade?.openPositionReadConcurrency ??
        CONFIG.trade?.openPositionReadConcurrency,
      DEFAULT_OPEN_POSITION_READ_CONCURRENCY,
      1,
      8
    ),

    keysTimeoutMs: clampInt(
      options.openPositionKeysTimeoutMs ??
        CONFIG.short?.trade?.openPositionKeysTimeoutMs ??
        CONFIG.trade?.openPositionKeysTimeoutMs,
      DEFAULT_OPEN_POSITION_KEYS_TIMEOUT_MS,
      100,
      5000
    ),

    readTimeoutMs: clampInt(
      options.openPositionReadTimeoutMs ??
        CONFIG.short?.trade?.openPositionReadTimeoutMs ??
        CONFIG.trade?.openPositionReadTimeoutMs,
      DEFAULT_OPEN_POSITION_READ_TIMEOUT_MS,
      100,
      8000
    ),

    monitorPositionLimit: clampInt(
      options.maxOpenPositionsToMonitor ??
        options.openPositionMonitorLimit ??
        CONFIG.short?.trade?.openPositionMonitorLimit ??
        CONFIG.trade?.openPositionMonitorLimit,
      DEFAULT_MONITOR_POSITION_LIMIT,
      1,
      500
    ),

    monitorBatchSize: clampInt(
      options.monitorBatchSize ??
        CONFIG.short?.trade?.monitorBatchSize ??
        CONFIG.trade?.monitorBatchSize,
      DEFAULT_MONITOR_BATCH_SIZE,
      1,
      300
    ),

    monitorRuntimeMs: clampInt(
      options.maxRuntimeMs ??
        options.monitorTimeoutMs ??
        CONFIG.short?.trade?.monitorTimeoutMs ??
        CONFIG.trade?.monitorTimeoutMs,
      DEFAULT_MONITOR_RUNTIME_MS,
      1000,
      30000
    ),

    monitorOnePositionTimeoutMs: clampInt(
      options.monitorOnePositionTimeoutMs ??
        CONFIG.short?.trade?.monitorOnePositionTimeoutMs ??
        CONFIG.trade?.monitorOnePositionTimeoutMs,
      DEFAULT_MONITOR_ONE_POSITION_TIMEOUT_MS,
      250,
      8000
    ),

    priceFetchTimeoutMs: clampInt(
      options.monitorPriceFetchTimeoutMs ??
        options.priceFetchTimeoutMs ??
        CONFIG.short?.trade?.monitorPriceFetchTimeoutMs ??
        CONFIG.trade?.monitorPriceFetchTimeoutMs,
      DEFAULT_PRICE_FETCH_TIMEOUT_MS,
      50,
      2500
    ),

    candleFetchTimeoutMs: clampInt(
      options.candleFetchTimeoutMs ??
        options.monitorCandleFetchTimeoutMs ??
        CONFIG.short?.trade?.candleFetchTimeoutMs ??
        CONFIG.short?.trade?.monitorCandleFetchTimeoutMs ??
        CONFIG.trade?.candleFetchTimeoutMs ??
        CONFIG.trade?.monitorCandleFetchTimeoutMs,
      DEFAULT_CANDLE_FETCH_TIMEOUT_MS,
      150,
      8000
    ),

    monitorCandleRangeEnabled:
      options.monitorCandleRangeEnabled !== false &&
      CONFIG.short?.trade?.monitorCandleRangeEnabled !== false &&
      CONFIG.trade?.monitorCandleRangeEnabled !== false,

    rangeLookbackMs: clampInt(
      options.rangeLookbackMs ??
        options.monitorRangeLookbackMs ??
        CONFIG.short?.trade?.rangeLookbackMs ??
        CONFIG.short?.trade?.monitorRangeLookbackMs ??
        CONFIG.trade?.rangeLookbackMs ??
        CONFIG.trade?.monitorRangeLookbackMs,
      DEFAULT_RANGE_LOOKBACK_MS,
      60 * 1000,
      DEFAULT_MAX_RANGE_LOOKBACK_MS
    ),

    maxRangeLookbackMs: clampInt(
      options.maxRangeLookbackMs ??
        options.monitorMaxRangeLookbackMs ??
        CONFIG.short?.trade?.maxRangeLookbackMs ??
        CONFIG.short?.trade?.monitorMaxRangeLookbackMs ??
        CONFIG.trade?.maxRangeLookbackMs ??
        CONFIG.trade?.monitorMaxRangeLookbackMs,
      DEFAULT_MAX_RANGE_LOOKBACK_MS,
      5 * 60 * 1000,
      24 * 60 * 60 * 1000
    ),

    rangeOverlapMs: clampInt(
      options.rangeOverlapMs ??
        options.monitorRangeOverlapMs ??
        CONFIG.short?.trade?.rangeOverlapMs ??
        CONFIG.short?.trade?.monitorRangeOverlapMs ??
        CONFIG.trade?.rangeOverlapMs ??
        CONFIG.trade?.monitorRangeOverlapMs,
      DEFAULT_RANGE_OVERLAP_MS,
      0,
      60 * 1000
    ),

    candleFirstTouchMinAgeMs: clampInt(
      options.candleFirstTouchMinAgeMs ??
        options.monitorCandleFirstTouchMinAgeMs ??
        CONFIG.short?.trade?.candleFirstTouchMinAgeMs ??
        CONFIG.short?.trade?.monitorCandleFirstTouchMinAgeMs ??
        CONFIG.trade?.candleFirstTouchMinAgeMs ??
        CONFIG.trade?.monitorCandleFirstTouchMinAgeMs,
      DEFAULT_CANDLE_FIRST_TOUCH_MIN_AGE_MS,
      0,
      10 * 60 * 1000
    ),

    persistNoPriceFailures: options.persistNoPriceFailures === true
  };
}

function manageConfig() {
  return {
    applyLive: CONFIG.short?.manage?.applyLive === true || CONFIG.manage?.applyLive === true,
    beArmR: safeNumber(CONFIG.short?.manage?.beArmR ?? CONFIG.manage?.beArmR, 0.70),
    beLockR: safeNumber(CONFIG.short?.manage?.beLockR ?? CONFIG.manage?.beLockR, 0.05),
    trailArmR: safeNumber(CONFIG.short?.manage?.trailArmR ?? CONFIG.manage?.trailArmR, 1.00),
    trailLockR: safeNumber(CONFIG.short?.manage?.trailLockR ?? CONFIG.manage?.trailLockR, 0.35)
  };
}

function normalizeSymbolToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/USDT|USDC|USD|PERP|SWAP|FUTURES|SPOT/g, '')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function symbolTokensFromRow(row = {}) {
  return [
    row.symbol,
    row.baseSymbol,
    row.contractSymbol
  ]
    .map(normalizeSymbolToken)
    .filter(Boolean)
    .filter((token) => token.length >= 2);
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
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function validLearningId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFingerprintId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return true;
}

function parseMicroShortFormat(value = '', rawId = '') {
  let baseValue = value;
  let microMicroHash = null;
  let microMicroFamilyId = null;

  const microMicroMatch = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,64})$/u.exec(value);

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

  if (validChild && microMicroHash && microMicroHash.length >= 6) {
    microMicroFamilyId = `${childId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`;
  }

  const isMicroMicro = Boolean(microMicroFamilyId);
  const isChild = validChild && !isMicroMicro;
  const isParent = validParent && !validChild && !isMicroMicro;
  const learningLayer = isMicroMicro
    ? LAYER_MICRO_MICRO
    : isChild
      ? LAYER_MICRO_75
      : isParent
        ? LAYER_PARENT_15
        : 'UNKNOWN';

  return {
    valid: validParent || validChild || isMicroMicro,
    selectable: isMicroMicro,
    isParent,
    isChild,
    isMicroMicro,
    rawId,
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    microMicroFamilyId,
    microMicroHash,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningLayer,
    learningGranularity: isMicroMicro ? MICRO_MICRO_LEARNING_GRANULARITY : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    selectionGranularity: isMicroMicro
      ? 'EXACT_MICRO_MICRO_ONLY'
      : isChild
        ? 'MICRO_75_CONTEXT_ONLY'
        : 'PARENT_15_CONTEXT_ONLY'
  };
}

function parseMmShortFormat(value = '', rawId = '') {
  if (!value.startsWith('MM_SHORT_')) return null;

  const body = value.slice('MM_SHORT_'.length);

  for (const setup of SHORT_FIXED_SETUP_TYPES) {
    for (const regime of REGIME_ORDER) {
      for (const profile of CONFIRMATION_PROFILE_ORDER) {
        const prefix = `${setup}_${regime}_${profile}`;

        if (body === prefix || body.startsWith(`${prefix}_`)) {
          const context = body === prefix ? 'DEFAULT' : body.slice(prefix.length + 1);
          const hash = hashText(`MM_SHORT|${setup}|${regime}|${profile}|${context}`, MICRO_MICRO_HASH_LEN);
          const childId = `MICRO_SHORT_${setup}_${regime}_${profile}`;
          const canonical = `${childId}_${MICRO_MICRO_SUFFIX}_${hash}`;

          return parseMicroShortFormat(canonical, rawId);
        }
      }
    }
  }

  return {
    valid: false,
    selectable: false,
    isParent: false,
    isChild: false,
    isMicroMicro: false,
    rawId
  };
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (value.startsWith('MM_SHORT_')) {
    return parseMmShortFormat(value, rawId);
  }

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

  return parseMicroShortFormat(value, rawId);
}

function isExactShortChildTrueMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return Boolean(parsed.valid && parsed.isChild);
}

function isExactShortMicroMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return Boolean(parsed.valid && parsed.isMicroMicro && parsed.microMicroFamilyId);
}

function isParentShortTrueMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return Boolean(parsed.valid && parsed.isParent);
}

function rowMicroMicroId(row = {}) {
  const candidates = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.selectedTrueMicroMicroFamilyId,
    row.selectedExactMicroMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId
  ];

  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();

    if (!raw) continue;
    if (isScannerFingerprintId(raw)) continue;
    if (isExecutionFingerprintId(raw)) continue;

    const parsed = parseShortTaxonomyMicroId(raw);

    if (parsed.isMicroMicro && parsed.microMicroFamilyId) {
      return parsed.microMicroFamilyId;
    }
  }

  return '';
}

function stripSymbolTokensFromLearningId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;

  if (
    isExactShortChildTrueMicroId(raw) ||
    isExactShortMicroMicroId(raw) ||
    isParentShortTrueMicroId(raw)
  ) {
    const parsed = parseShortTaxonomyMicroId(raw);
    return parsed.microMicroFamilyId ||
      parsed.childTrueMicroFamilyId ||
      parsed.parentTrueMicroFamilyId ||
      raw.toUpperCase();
  }

  const tokens = symbolTokensFromRow(row);

  if (!tokens.length) return raw;

  let next = raw;

  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    next = next
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDT([_|:=\\-]|$)`, 'gi'), '$1ASSET$2')
      .replace(new RegExp(`(^|[_|:=\\-])${escaped}USDC([_|:=\\-]|$)`, 'gi'), '$1ASSET$2');
  }

  return next
    .replace(/_{2,}/g, '_')
    .replace(/\|{2,}/g, '|')
    .replace(/^[_|:=\-\s]+|[_|:=\-\s]+$/g, '') || raw;
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replaceAll('LONG_DISABLED_TRUE', 'SHORT')
    .replaceAll('LONGDISABLED_TRUE', 'SHORT')
    .replaceAll('BLOCK_LONG_TRUE', 'SHORT')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('BLOCK_LONG_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('BLOCK_LONG', 'SHORT')
    .replaceAll('LONG_DISABLED', 'SHORT')
    .replaceAll('LONGDISABLED', 'SHORT')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
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

  if (shortHit && longHit) {
    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) {
      return TARGET_TRADE_SIDE;
    }

    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (normalized.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

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

    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId,

    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,

    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,

    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.executionMicroFamilyId,

    row.parentTrueMicroFamilyId,
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
    raw.includes('MM_SHORT_') ||
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
    haystack.includes('DIRECTION=SELL') ||
    haystack.includes('MICRO_SHORT_') ||
    haystack.includes('MM_SHORT_')
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
    haystack.includes('DIRECTION=BUY') ||
    haystack.includes('MICRO_LONG_')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = idText(row);

  if (!haystack) return 'UNKNOWN';

  if (hasShortIdSignal(haystack) && !hasLongIdSignal(haystack)) return TARGET_TRADE_SIDE;
  if (hasLongIdSignal(haystack) && !hasShortIdSignal(haystack)) return OPPOSITE_TRADE_SIDE;

  if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
  if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  if (haystack.includes('MICRO_SHORT_') || haystack.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
  if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferTradeSideFromDefinitions(row = {}) {
  const parts = normalizedTextParts(row);

  if (!parts.length) return 'UNKNOWN';

  if (hasShortDefinitionSignal(parts) && !hasLongDefinitionSignal(parts)) return TARGET_TRADE_SIDE;
  if (hasLongDefinitionSignal(parts) && !hasShortDefinitionSignal(parts)) return OPPOSITE_TRADE_SIDE;

  const haystack = parts.join('|');

  if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
  if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  if (haystack.includes('MICRO_SHORT_') || haystack.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
  if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

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

  if (fromIds === TARGET_TRADE_SIDE || fromIds === OPPOSITE_TRADE_SIDE) {
    return fromIds;
  }

  const fromDefinitions = inferTradeSideFromDefinitions(row);

  if (fromDefinitions === TARGET_TRADE_SIDE || fromDefinitions === OPPOSITE_TRADE_SIDE) {
    return fromDefinitions;
  }

  if (row.shortOnly === true && row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortPosition(row = {}) {
  return inferPositionTradeSide(row) === TARGET_TRADE_SIDE;
}

function firstValidLearningId(row = {}, candidates = []) {
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();

    if (!raw) continue;
    if (isScannerFingerprintId(raw)) continue;
    if (isExecutionFingerprintId(raw)) continue;

    const clean = stripSymbolTokensFromLearningId(raw, row);

    if (!clean) continue;
    if (isScannerFingerprintId(clean)) continue;
    if (isExecutionFingerprintId(clean)) continue;

    const parsed = parseShortTaxonomyMicroId(clean);

    if (parsed.isMicroMicro && parsed.childTrueMicroFamilyId) {
      return parsed.childTrueMicroFamilyId;
    }

    if (parsed.isChild && parsed.childTrueMicroFamilyId) {
      return parsed.childTrueMicroFamilyId;
    }

    if (parsed.isParent && parsed.parentTrueMicroFamilyId) {
      return parsed.parentTrueMicroFamilyId;
    }

    return clean.toUpperCase();
  }

  return '';
}

function rowMicroId(row = {}) {
  return firstValidLearningId(row, [
    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId
  ]);
}

function rowParentMicroId(row = {}) {
  const direct = firstValidLearningId(row, [
    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.macroFamilyId
  ]);

  if (isParentShortTrueMicroId(direct)) return direct;

  const child = rowMicroId(row);
  const parsed = parseShortTaxonomyMicroId(child);

  return parsed.parentTrueMicroFamilyId || '';
}

function scannerMicroId(row = {}) {
  const candidates = [
    row.scannerMicroFamilyId,
    isScannerFingerprintId(row.microFamilyId) ? row.microFamilyId : null,
    isScannerFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null,
    isScannerFingerprintId(row.id) ? row.id : null,
    isScannerFingerprintId(row.key) ? row.key : null
  ];

  return candidates.find(Boolean) || null;
}

function executionMicroId(row = {}) {
  const candidates = [
    row.executionMicroFamilyId,
    isExecutionFingerprintId(row.microFamilyId) ? row.microFamilyId : null,
    isExecutionFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null,
    isExecutionFingerprintId(row.analyzeMicroFamilyId) ? row.analyzeMicroFamilyId : null,
    isExecutionFingerprintId(row.id) ? row.id : null,
    isExecutionFingerprintId(row.key) ? row.key : null
  ];

  return candidates.find(Boolean) || null;
}

function isScannerFamilyRow(row = {}) {
  return Boolean(
    isScannerFingerprintId(row.microFamilyId) ||
    isScannerFingerprintId(row.trueMicroFamilyId) ||
    isScannerFingerprintId(row.childTrueMicroFamilyId) ||
    isScannerFingerprintId(row.coarseMicroFamilyId) ||
    isScannerFingerprintId(row.id) ||
    isScannerFingerprintId(row.key)
  );
}

function isTrueMicroFamilyRow(row = {}) {
  const id = rowMicroId(row);
  const parsed = parseShortTaxonomyMicroId(id);

  if (!row || !id) return false;
  if (!validLearningId(id)) return false;
  if (isScannerFamilyRow(row)) return false;
  if (!isShortPosition(row) && !hasShortIdSignal(id)) return false;

  return Boolean(parsed.isChild);
}

function isCleanMicroMicroRow(row = {}) {
  const childId = rowMicroId(row);
  const microMicroId = rowMicroMicroId(row);

  return Boolean(
    isShortPosition(row) &&
      isExactShortChildTrueMicroId(childId) &&
      isExactShortMicroMicroId(microMicroId) &&
      !isScannerFamilyRow(row)
  );
}

function fallbackFamilyId(row = {}) {
  const parentId = rowParentMicroId(row);

  if (parentId) return parentId;

  const direct = String(
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    ''
  ).trim();

  if (direct && !isScannerFingerprintId(direct) && !isExecutionFingerprintId(direct)) {
    return stripSymbolTokensFromLearningId(direct, row);
  }

  return rowMicroId(row) || 'MICRO_SHORT_UNKNOWN_PARENT';
}

function normalizeMicroIdentity(row = {}) {
  const microFamilyId = rowMicroId(row);
  const microMicroId = rowMicroMicroId(row);
  const parsed = parseShortTaxonomyMicroId(microFamilyId);

  if (!microFamilyId) {
    throw new Error('ANALYZE_TRUE_MICRO_FAMILY_ID_REQUIRED');
  }

  if (isScannerFingerprintId(microFamilyId)) {
    throw new Error('SCANNER_FINGERPRINT_CANNOT_BE_LEARNING_FAMILY_ID');
  }

  if (isExecutionFingerprintId(microFamilyId)) {
    throw new Error('EXECUTION_FINGERPRINT_CANNOT_BE_LEARNING_FAMILY_ID');
  }

  if (!parsed.isChild) {
    throw new Error('EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_REQUIRED');
  }

  if (!microMicroId || !isExactShortMicroMicroId(microMicroId)) {
    throw new Error('EXACT_MICRO_MICRO_FAMILY_ID_REQUIRED');
  }

  const parentId = parsed.parentTrueMicroFamilyId;
  const scannerId = scannerMicroId(row);
  const executionId = executionMicroId(row);
  const microMicroParsed = parseShortTaxonomyMicroId(microMicroId);

  return {
    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    childTrueMicroFamilyId: microFamilyId,
    analyzeMicroFamilyId: microFamilyId,
    learningMicroFamilyId: microFamilyId,
    fixedTaxonomyMicroFamilyId: microFamilyId,

    microMicroFamilyId: microMicroId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,
    microMicroHash: microMicroParsed.microMicroHash || null,

    parentTrueMicroFamilyId: parentId,
    coarseMicroFamilyId: parentId,
    baseMicroFamilyId: parentId,
    legacyMicroFamilyId: parentId,

    familyId: microMicroId,

    parentMacroFamilyId: parentId,
    parentMicroFamilyId: parentId,
    macroFamilyId: parentId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    scannerMicroFamilyId: scannerId,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerDefinition: row.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts.slice(0, 40)
      : [],

    executionMicroFamilyId: executionId,
    executionFingerprintRole: executionId ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: Boolean(executionId),
    executionFingerprintsMetadataOnly: Boolean(!executionId),
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: Boolean(scannerId),
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    fixedTaxonomyLearningId: true,
    fixedTaxonomyPreferred: true,

    schema: MICRO_MICRO_SCHEMA,
    microFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    child75LearningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    microMicroLearningEnabled: true,
    layeredLearningEnabled: true,

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',

    microMicroVersion: MICRO_MICRO_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,

    isTrueMicro: true,
    trueMicro: true,
    isMicroMicro: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactMicroMicroOnly: true,
    isLegacyMacro: false
  };
}

function validShortRiskGeometry(row = {}) {
  const entryPrice = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl, 0);
  const tp = safeNumber(row.tp, 0);

  return entryPrice > 0 && sl > 0 && tp > 0 && tp < entryPrice && entryPrice < sl;
}

function assertShortRiskGeometry(row = {}) {
  if (!validShortRiskGeometry(row)) {
    throw new Error('OPEN_POSITION_SHORT_RISK_GEOMETRY_INVALID_TP_LT_ENTRY_LT_SL_REQUIRED');
  }
}

function assertLearningFamilyIdentity(row = {}) {
  const microFamilyId = rowMicroId(row);
  const microMicroId = rowMicroMicroId(row);

  if (!microFamilyId) {
    throw new Error('OPEN_POSITION_TRUE_MICRO_FAMILY_ID_MISSING');
  }

  if (isScannerFingerprintId(microFamilyId) || isScannerFamilyRow(row)) {
    throw new Error('OPEN_POSITION_SCANNER_FINGERPRINT_METADATA_ONLY');
  }

  if (isExecutionFingerprintId(microFamilyId)) {
    throw new Error('OPEN_POSITION_EXECUTION_FINGERPRINT_METADATA_ONLY');
  }

  if (!isExactShortChildTrueMicroId(microFamilyId)) {
    throw new Error('OPEN_POSITION_REQUIRES_EXACT_75_CHILD_TRUE_MICRO_FAMILY');
  }

  if (!microMicroId || !isExactShortMicroMicroId(microMicroId)) {
    throw new Error('OPEN_POSITION_REQUIRES_EXACT_MICRO_MICRO_FAMILY');
  }

  if (!isTrueMicroFamilyRow(row)) {
    throw new Error('OPEN_POSITION_REQUIRES_ANALYZE_TRUE_MICRO_FAMILY');
  }
}

function assertBasePositionFields(row = {}) {
  if (inferPositionTradeSide(row) !== TARGET_TRADE_SIDE) {
    throw new Error('OPEN_POSITION_SHORT_ONLY_SYSTEM_REJECTED_NON_SHORT_ENTRY');
  }

  if (!row.entry || !row.sl || !row.tp) {
    throw new Error('OPEN_POSITION_RISK_GEOMETRY_MISSING');
  }

  assertLearningFamilyIdentity(row);
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

function identityFlags() {
  return {
    virtualLearning: true,
    virtualOnly: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    exactMicroMicroOnly: true,
    fixedTaxonomyPreferred: true,

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    child75MatchTriggersDiscord: false,
    parent15MatchTriggersDiscord: false,
    scannerMatchTriggersDiscord: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    rawWinrateRankingDisabled: true,
    noBareWinrateRanking: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,

    directSLDefinition: 'SL_EXIT_WITHOUT_MEANINGFUL_MFE',
    directSLMfeThresholdR: 0.25,
    seenDefinition: 'DEDUPED_UNIQUE_OBSERVATION_KEY',
    completedOnlyClosedVirtualOrShadow: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    riskPlanVersion: RISK_PLAN_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    riskTradeSide: TARGET_TRADE_SIDE,
    validShortRiskShape: 'tp < entry < sl',
    shortRiskShape: 'tp < entry < sl',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    monitorRule: 'hard time-stop pre-price; 1m candle range after; range result wins over current price',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    child75TrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    microMicroLearningEnabled: true,
    learningGranularity: LEARNING_GRANULARITY,
    child75LearningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroVersion: MICRO_MICRO_VERSION,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
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
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualTracked: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    ...identityFlags()
  };
}

function buildVirtualFlags(row = {}) {
  return {
    source: POSITION_SOURCE,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: POSITION_SOURCE,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    bitgetOrderPlaced: false,

    liveEligible: false,
    discordAlertEligible: Boolean(row.discordAlertEligible),
    selectedMicroFamilyAlert: Boolean(row.selectedMicroFamilyAlert),
    selectedForDiscord: Boolean(row.selectedForDiscord || row.discordAlertEligible || row.selectedMicroFamilyAlert),

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true
  };
}

function compactMarketWeather(value = null) {
  if (!value || typeof value !== 'object') return null;

  return {
    ok: value.ok ?? null,
    available: value.available ?? null,
    version: value.version || null,
    snapshotId: value.snapshotId || null,
    createdAt: value.createdAt || null,
    completedAt: value.completedAt || null,
    updatedAt: value.updatedAt || null,
    currentRegime: value.currentRegime || value.regime || null,
    regime: value.regime || value.currentRegime || null,
    currentTrendSide: value.currentTrendSide || value.trendSide || null,
    trendSide: value.trendSide || value.currentTrendSide || null,
    confidence: value.confidence ?? null,
    bullishPct: value.bullishPct ?? null,
    bearishPct: value.bearishPct ?? null,
    squeezePct: value.squeezePct ?? null,
    btcState: value.btcState || null,
    btcChange1h: value.btcChange1h ?? null,
    btcChange24h: value.btcChange24h ?? null,
    compactedForRedis: true
  };
}

function compactWeeklyStats(value = null) {
  if (!value || typeof value !== 'object') return null;

  return {
    id: value.id || value.microMicroFamilyId || value.microFamilyId || value.trueMicroFamilyId || null,
    microFamilyId: value.microFamilyId || value.trueMicroFamilyId || null,
    trueMicroFamilyId: value.trueMicroFamilyId || value.microFamilyId || null,
    microMicroFamilyId: value.microMicroFamilyId || value.trueMicroMicroFamilyId || null,
    trueMicroMicroFamilyId: value.trueMicroMicroFamilyId || value.microMicroFamilyId || null,
    completed: safeNumber(value.completed ?? value.outcomeSample, 0),
    wins: safeNumber(value.wins, 0),
    losses: safeNumber(value.losses, 0),
    flats: safeNumber(value.flats, 0),
    winrate: value.winrate ?? value.winRate ?? null,
    fairWinrate: value.fairWinrate ?? null,
    avgR: value.avgR ?? null,
    totalR: value.totalR ?? null,
    avgCostR: value.avgCostR ?? null,
    directSLPct: value.directSLPct ?? null,
    balancedScore: value.balancedScore ?? value.dashboardBalancedScore ?? null,
    compactedForRedis: true
  };
}

function compactOpenPositionRow(row = {}) {
  const compacted = {
    ...row,

    currentMarketWeather: compactMarketWeather(row.currentMarketWeather),
    entryMarketWeather: compactMarketWeather(row.entryMarketWeather),

    currentMarketUniverse: null,
    entryMarketUniverse: null,

    weeklyStats: compactWeeklyStats(row.weeklyStats),
    selectedWeeklyStats: compactWeeklyStats(row.selectedWeeklyStats),

    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts.slice(0, 40)
      : [],

    definitionParts: Array.isArray(row.definitionParts)
      ? row.definitionParts.slice(0, 40)
      : undefined,

    microDefinitionParts: Array.isArray(row.microDefinitionParts)
      ? row.microDefinitionParts.slice(0, 40)
      : undefined,

    executionFingerprintParts: Array.isArray(row.executionFingerprintParts)
      ? row.executionFingerprintParts.slice(0, 40)
      : undefined,

    actions: undefined,
    virtualActions: undefined,
    candidates: undefined,
    scannerSnapshot: undefined,
    rawSnapshot: undefined,
    rawCandidate: undefined,
    marketUniverseRows: undefined,
    universeRows: undefined,
    candles15m: undefined,
    candles1h: undefined,
    orderBook: undefined,
    rawOrderBook: undefined,
    selectedRotation: undefined,

    compactedForRedis: true,
    compactedBy: 'src/trade/positionEngine.js',
    compactedAt: now()
  };

  for (const key of Object.keys(compacted)) {
    if (compacted[key] === undefined) delete compacted[key];
  }

  return compacted;
}

function buildKeyOnlyOpenPosition(key = '') {
  const symbol = symbolFromOpenKey(key);

  return forceShortPositionFields({
    symbol,
    baseSymbol: symbol,
    contractSymbol: null,
    status: 'OPEN',
    openedAt: 0,
    createdAt: 0,
    updatedAt: now(),

    openPositionKey: key,
    openPositionKeyOnly: true,
    monitorEligible: false,
    learningIdentityMissingForKeyOnly: true,

    source: POSITION_SOURCE,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: POSITION_SOURCE
  });
}

function calcStopFromR({
  entry,
  initialSl,
  stopR
} = {}) {
  const e = safeNumber(entry, 0);
  const sl = safeNumber(initialSl, 0);
  const r = safeNumber(stopR, 0);

  if (e <= 0 || sl <= 0 || sl <= e) return 0;

  const riskDist = sl - e;

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

  if (entry <= 0 || initialSl <= 0 || currentSl <= 0 || initialSl <= entry) return position;

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

function positionAgeMs(position = {}, timestamp = now()) {
  const openedAt = safeNumber(position.openedAt || position.createdAt, 0);

  if (openedAt <= 0) return 0;

  return Math.max(0, timestamp - openedAt);
}

function isTimeStopExpired(position = {}, timestamp = now(), options = {}) {
  const cfg = tradeConfig(options);
  const ageMs = positionAgeMs(position, timestamp);

  return ageMs >= cfg.positionTimeStopMin * 60 * 1000;
}

function fallbackExitPrice(position = {}) {
  const price = safeNumber(
    position.currentPrice ??
      position.lastPrice ??
      position.markPrice ??
      position.price ??
      position.entry,
    0
  );

  return price > 0 ? price : safeNumber(position.entry, 0);
}

function buildHardTimeStopExit(position = {}, timestamp = now(), options = {}) {
  const cfg = tradeConfig(options);

  if (!cfg.hardTimeStopNoPriceExit) {
    return {
      shouldExit: false,
      reason: null,
      trigger: null,
      exitPrice: 0
    };
  }

  if (!isTimeStopExpired(position, timestamp, options)) {
    return {
      shouldExit: false,
      reason: null,
      trigger: null,
      exitPrice: 0
    };
  }

  const exitPrice = fallbackExitPrice(position);

  return {
    shouldExit: exitPrice > 0,
    reason: 'TIME_STOP',
    trigger: 'HARD_TIME_STOP_PRE_PRICE_FALLBACK_EXIT',
    exitPrice,
    priceSource: 'POSITION_FALLBACK_PRICE_PRE_PRICE_HARD_TIME_STOP',
    rangeStart: null,
    rangeEnd: null,
    firstTouch: null,
    conservativeExit: false,
    hardTimeStop: true,
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION
  };
}

function bitgetSymbol(position = {}) {
  const raw = String(
    position.contractSymbol ||
      position.symbol ||
      position.baseSymbol ||
      ''
  )
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (!raw) return '';

  return raw.endsWith('USDT') ? raw : `${raw}USDT`;
}

function normalizePriceProbe(value, fallbackSource = 'UNKNOWN') {
  if (typeof value === 'number') {
    const n = safeNumber(value, 0);

    return {
      ok: n > 0,
      last: n,
      high: n,
      low: n,
      source: fallbackSource,
      firstTouch: null,
      rangeStart: null,
      rangeEnd: null,
      candles: 0
    };
  }

  if (!value || typeof value !== 'object') {
    return {
      ok: false,
      last: 0,
      high: 0,
      low: 0,
      source: fallbackSource,
      firstTouch: null,
      rangeStart: null,
      rangeEnd: null,
      candles: 0
    };
  }

  const last = safeNumber(
    value.last ??
      value.price ??
      value.currentPrice ??
      value.close ??
      value.markPrice,
    0
  );

  const high = safeNumber(
    value.high ??
      value.highPrice ??
      value.max ??
      last,
    last
  );

  const low = safeNumber(
    value.low ??
      value.lowPrice ??
      value.min ??
      last,
    last
  );

  return {
    ok: last > 0 || high > 0 || low > 0,
    last,
    high: high > 0 ? high : last,
    low: low > 0 ? low : last,
    source: value.source || fallbackSource,
    firstTouch: value.firstTouch || null,
    rangeStart: value.rangeStart || null,
    rangeEnd: value.rangeEnd || null,
    candles: safeNumber(value.candles, 0),
    raw: value.raw || null,
    error: value.error || null,
    externalLast: value.externalLast || null,
    externalSource: value.externalSource || null,
    candleRangeFreshPositionSuppressed: Boolean(value.candleRangeFreshPositionSuppressed),
    candleRangeSuppressedReason: value.candleRangeSuppressedReason || null,
    candleRangeFailed: Boolean(value.candleRangeFailed),
    candleRangeFailureReason: value.candleRangeFailureReason || null,
    candleRangeError: value.candleRangeError || null,
    candlesExcludedBeforeOpen: safeNumber(value.candlesExcludedBeforeOpen, 0),
    firstFullCandleTs: value.firstFullCandleTs || null
  };
}

function candleNumber(row, index) {
  if (!Array.isArray(row)) return 0;
  return safeNumber(row[index], 0);
}

function candleTs(row) {
  return candleNumber(row, 0);
}

function normalizeBitgetCandles(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => Array.isArray(row) && row.length >= 5)
    .map((row) => ({
      ts: candleTs(row),
      open: candleNumber(row, 1),
      high: candleNumber(row, 2),
      low: candleNumber(row, 3),
      close: candleNumber(row, 4),
      raw: row
    }))
    .filter((row) => (
      row.ts > 0 &&
      row.open > 0 &&
      row.high > 0 &&
      row.low > 0 &&
      row.close > 0
    ))
    .sort((a, b) => a.ts - b.ts);
}

function firstFullCandleStartAfter(timestamp = 0) {
  const ts = safeNumber(timestamp, 0);

  if (ts <= 0) return 0;
  if (ts % BITGET_CANDLE_MS === 0) return ts;

  return Math.floor(ts / BITGET_CANDLE_MS) * BITGET_CANDLE_MS + BITGET_CANDLE_MS;
}

function filterCandlesAfterPositionOpen(candles = [], position = {}) {
  const openedAt = safeNumber(position.openedAt || position.createdAt, 0);

  if (openedAt <= 0) {
    return {
      candles,
      excluded: 0,
      firstFullCandleTs: null
    };
  }

  const firstFullCandleTs = firstFullCandleStartAfter(openedAt);
  const filtered = candles.filter((candle) => safeNumber(candle.ts, 0) >= firstFullCandleTs);

  return {
    candles: filtered,
    excluded: Math.max(0, candles.length - filtered.length),
    firstFullCandleTs
  };
}

function findShortFirstTouchFromCandles({
  candles = [],
  tp,
  sl
} = {}) {
  const target = safeNumber(tp, 0);
  const stop = safeNumber(sl, 0);

  if (target <= 0 || stop <= 0) return null;

  for (const candle of candles) {
    const tpTouched = candle.low <= target;
    const slTouched = candle.high >= stop;

    if (tpTouched && slTouched) {
      return {
        reason: 'SL',
        conservative: true,
        sameCandleBothTouched: true,
        ts: candle.ts,
        candle
      };
    }

    if (slTouched) {
      return {
        reason: 'SL',
        conservative: false,
        sameCandleBothTouched: false,
        ts: candle.ts,
        candle
      };
    }

    if (tpTouched) {
      return {
        reason: 'TP',
        conservative: false,
        sameCandleBothTouched: false,
        ts: candle.ts,
        candle
      };
    }
  }

  return null;
}

function monitorRangeStart(position = {}, timestamp = now(), options = {}) {
  const cfg = tradeConfig(options);

  const lastMonitorAt = safeNumber(
    position.lastMonitorAt ??
      position.lastCheckedAt ??
      position.updatedAt,
    0
  );

  const openedAt = safeNumber(position.openedAt || position.createdAt, 0);

  const rawStart =
    lastMonitorAt > 0
      ? lastMonitorAt - cfg.rangeOverlapMs
      : openedAt > 0
        ? openedAt
        : timestamp - cfg.rangeLookbackMs;

  const clampedToOpen = openedAt > 0
    ? Math.max(openedAt, rawStart)
    : rawStart;

  return Math.max(
    timestamp - cfg.maxRangeLookbackMs,
    clampedToOpen
  );
}

function isFreshPositionForCandleRange(position = {}, timestamp = now(), options = {}) {
  const cfg = tradeConfig(options);
  const openedAt = safeNumber(position.openedAt || position.createdAt, 0);

  if (openedAt <= 0) return false;

  return timestamp - openedAt < cfg.candleFirstTouchMinAgeMs;
}

async function fetchBitgetCandleRange(position = {}, timestamp = now(), options = {}) {
  const symbol = bitgetSymbol(position);

  if (!symbol) {
    return normalizePriceProbe(null, 'BITGET_CANDLES_NO_SYMBOL');
  }

  const startTime = monitorRangeStart(position, timestamp, options);
  const endTime = timestamp;

  const params = new URLSearchParams({
    symbol,
    productType: BITGET_PRODUCT_TYPE,
    granularity: BITGET_CANDLE_GRANULARITY,
    startTime: String(Math.floor(startTime)),
    endTime: String(Math.floor(endTime)),
    limit: '200'
  });

  const url = `${BITGET_BASE_URL}/api/v2/mix/market/candles?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        last: 0,
        high: 0,
        low: 0,
        source: `BITGET_CANDLES_HTTP_${response.status}`,
        firstTouch: null,
        rangeStart: startTime,
        rangeEnd: endTime,
        candles: 0
      };
    }

    const json = await response.json().catch(() => null);
    const rows = Array.isArray(json?.data) ? json.data : [];
    const rawCandles = normalizeBitgetCandles(rows);
    const filtered = filterCandlesAfterPositionOpen(rawCandles, position);
    const candles = filtered.candles;

    if (!candles.length) {
      return {
        ok: false,
        last: 0,
        high: 0,
        low: 0,
        source: rawCandles.length
          ? 'BITGET_CANDLES_ONLY_PRE_ENTRY_OR_ENTRY_CANDLE'
          : 'BITGET_CANDLES_EMPTY',
        firstTouch: null,
        rangeStart: startTime,
        rangeEnd: endTime,
        candles: 0,
        candlesExcludedBeforeOpen: filtered.excluded,
        firstFullCandleTs: filtered.firstFullCandleTs
      };
    }

    const highs = candles.map((row) => row.high).filter((value) => value > 0);
    const lows = candles.map((row) => row.low).filter((value) => value > 0);
    const lastCandle = candles[candles.length - 1];

    const high = Math.max(...highs);
    const low = Math.min(...lows);
    const last = lastCandle.close;

    const firstTouch = findShortFirstTouchFromCandles({
      candles,
      tp: position.tp,
      sl: position.sl
    });

    return {
      ok: true,
      last,
      high,
      low,
      source: 'BITGET_1M_CANDLE_RANGE_FULL_CANDLES_AFTER_ENTRY_ONLY',
      firstTouch,
      rangeStart: startTime,
      rangeEnd: endTime,
      candles: candles.length,
      candlesExcludedBeforeOpen: filtered.excluded,
      firstFullCandleTs: filtered.firstFullCandleTs
    };
  } catch (error) {
    return {
      ok: false,
      last: 0,
      high: 0,
      low: 0,
      source: 'BITGET_CANDLES_ERROR',
      error: error?.message || String(error),
      firstTouch: null,
      rangeStart: startTime,
      rangeEnd: endTime,
      candles: 0
    };
  }
}

async function resolveMonitorPriceProbe({
  position,
  priceFetcher,
  timestamp,
  options = {}
} = {}) {
  const cfg = tradeConfig(options);

  const externalRaw = await withTimeout(
    Promise.resolve(priceFetcher(position.contractSymbol || position.symbol)).catch(() => 0),
    cfg.priceFetchTimeoutMs,
    'POSITION_PRICE_FETCH_TIMEOUT',
    0
  );

  const externalProbe = normalizePriceProbe(externalRaw, 'EXTERNAL_PRICE_FETCHER');

  if (!cfg.monitorCandleRangeEnabled) {
    return externalProbe;
  }

  const candleProbe = await withTimeout(
    fetchBitgetCandleRange(position, timestamp, options),
    cfg.candleFetchTimeoutMs,
    'BITGET_CANDLE_RANGE_TIMEOUT',
    normalizePriceProbe(null, 'BITGET_CANDLE_RANGE_TIMEOUT')
  );

  const freshPosition = isFreshPositionForCandleRange(position, timestamp, options);

  if (freshPosition) {
    const last = safeNumber(externalProbe.last || candleProbe?.last, 0);

    return {
      ok: last > 0,
      last,
      high: last,
      low: last,
      source: externalProbe.ok
        ? `FRESH_POSITION_LAST_ONLY_${externalProbe.source}`
        : candleProbe?.ok
          ? 'FRESH_POSITION_LAST_ONLY_BITGET_CANDLE_CLOSE'
          : candleProbe?.source || 'FRESH_POSITION_NO_PRICE',
      firstTouch: null,
      rangeStart: candleProbe?.rangeStart || null,
      rangeEnd: candleProbe?.rangeEnd || null,
      candles: candleProbe?.candles || 0,
      externalLast: externalProbe.last || null,
      externalSource: externalProbe.source || null,
      candleRangeFreshPositionSuppressed: true,
      candleRangeSuppressedReason: 'AVOID_PRE_ENTRY_1M_CANDLE_CONTAMINATION',
      candleRangeFailed: !candleProbe?.ok,
      candleRangeFailureReason: candleProbe?.ok ? null : candleProbe?.source || null,
      candleRangeError: candleProbe?.error || null,
      candlesExcludedBeforeOpen: candleProbe?.candlesExcludedBeforeOpen || 0,
      firstFullCandleTs: candleProbe?.firstFullCandleTs || null
    };
  }

  if (candleProbe?.ok) {
    return {
      ...candleProbe,
      externalLast: externalProbe.last || null,
      externalSource: externalProbe.source || null
    };
  }

  return {
    ...externalProbe,
    source: externalProbe.ok
      ? `FALLBACK_${externalProbe.source}`
      : candleProbe?.source || externalProbe.source || 'NO_PRICE',
    candleRangeFailed: true,
    candleRangeFailureReason: candleProbe?.source || null,
    candleRangeError: candleProbe?.error || null,
    candlesExcludedBeforeOpen: candleProbe?.candlesExcludedBeforeOpen || 0,
    firstFullCandleTs: candleProbe?.firstFullCandleTs || null
  };
}

function updatePathMetricsWithProbe(position, probe = {}) {
  const normalized = normalizePriceProbe(probe, 'PATH_METRICS_PROBE');

  if (!normalized.ok) return position;

  updatePathMetrics(position, normalized.last);

  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const tp = safeNumber(position.tp, 0);
  const high = safeNumber(normalized.high, 0);
  const low = safeNumber(normalized.low, 0);

  if (entry <= 0 || initialSl <= entry || tp <= 0 || tp >= entry) {
    return position;
  }

  const riskDist = initialSl - entry;
  const rewardDist = entry - tp;

  if (low > 0) {
    const favorableR = (entry - low) / riskDist;
    const tpProgress = (entry - low) / rewardDist;

    position.mfeR = round4(Math.max(
      safeNumber(position.mfeR, 0),
      favorableR
    ));

    position.maxTpProgress = round4(Math.max(
      safeNumber(position.maxTpProgress, 0),
      tpProgress
    ));

    if (position.mfeR >= 0.5) position.reachedHalfR = true;
    if (position.mfeR >= 1.0) position.reachedOneR = true;
    if (tpProgress >= 0.8) position.nearTpSeen = true;
  }

  if (high > 0) {
    const adverseR = (entry - high) / riskDist;

    position.maeR = round4(Math.min(
      safeNumber(position.maeR, 0),
      adverseR
    ));
  }

  position.lastMonitorAt = now();
  position.lastCheckedAt = position.lastMonitorAt;
  position.lastMonitorPriceSource = normalized.source;
  position.lastMonitorRangeStart = normalized.rangeStart || null;
  position.lastMonitorRangeEnd = normalized.rangeEnd || null;
  position.lastMonitorCandles = normalized.candles || 0;
  position.lastMonitorHigh = normalized.high || null;
  position.lastMonitorLow = normalized.low || null;
  position.lastMonitorCandlesExcludedBeforeOpen = normalized.candlesExcludedBeforeOpen || 0;
  position.lastMonitorFirstFullCandleTs = normalized.firstFullCandleTs || null;
  position.lastMonitorFreshPositionSuppressed = Boolean(normalized.candleRangeFreshPositionSuppressed);

  return position;
}

function detectExit({
  position,
  price,
  priceProbe,
  timestamp,
  options = {}
} = {}) {
  const probe = normalizePriceProbe(
    priceProbe ?? price,
    priceProbe ? 'PRICE_PROBE' : 'LEGACY_PRICE'
  );

  const current = safeNumber(probe.last, 0);
  const high = safeNumber(probe.high, current);
  const low = safeNumber(probe.low, current);

  const tp = safeNumber(position.tp, 0);
  const sl = safeNumber(position.sl, 0);
  const expired = isTimeStopExpired(position, timestamp, options);

  if (!isShortPosition(position)) {
    return {
      shouldExit: false,
      reason: 'NON_SHORT_POSITION_IGNORED',
      trigger: null,
      exitPrice: 0
    };
  }

  const tpTouched = low > 0 && tp > 0 && low <= tp;
  const slTouched = high > 0 && sl > 0 && high >= sl;

  if (probe.firstTouch?.reason === 'SL') {
    return {
      shouldExit: true,
      reason: 'SL',
      trigger: probe.firstTouch.sameCandleBothTouched
        ? 'SHORT_RANGE_BOTH_TOUCHED_CONSERVATIVE_SL'
        : 'SHORT_RANGE_FIRST_TOUCH_SL',
      exitPrice: sl,
      priceSource: probe.source,
      firstTouch: probe.firstTouch,
      rangeStart: probe.rangeStart,
      rangeEnd: probe.rangeEnd,
      conservativeExit: Boolean(probe.firstTouch.conservative)
    };
  }

  if (probe.firstTouch?.reason === 'TP') {
    return {
      shouldExit: true,
      reason: 'TP',
      trigger: 'SHORT_RANGE_FIRST_TOUCH_TP',
      exitPrice: tp,
      priceSource: probe.source,
      firstTouch: probe.firstTouch,
      rangeStart: probe.rangeStart,
      rangeEnd: probe.rangeEnd,
      conservativeExit: false
    };
  }

  if (slTouched && tpTouched) {
    return {
      shouldExit: true,
      reason: 'SL',
      trigger: 'SHORT_RANGE_BOTH_TOUCHED_UNKNOWN_ORDER_CONSERVATIVE_SL',
      exitPrice: sl,
      priceSource: probe.source,
      rangeStart: probe.rangeStart,
      rangeEnd: probe.rangeEnd,
      conservativeExit: true
    };
  }

  if (slTouched) {
    return {
      shouldExit: true,
      reason: 'SL',
      trigger: 'SHORT_RANGE_HIGH >= sl',
      exitPrice: sl,
      priceSource: probe.source,
      rangeStart: probe.rangeStart,
      rangeEnd: probe.rangeEnd,
      conservativeExit: false
    };
  }

  if (tpTouched) {
    return {
      shouldExit: true,
      reason: 'TP',
      trigger: 'SHORT_RANGE_LOW <= tp',
      exitPrice: tp,
      priceSource: probe.source,
      rangeStart: probe.rangeStart,
      rangeEnd: probe.rangeEnd,
      conservativeExit: false
    };
  }

  if (expired) {
    const fallback = current > 0 ? current : fallbackExitPrice(position);

    return {
      shouldExit: fallback > 0,
      reason: 'TIME_STOP',
      trigger: current > 0
        ? 'TIME_STOP_WITH_LIVE_OR_RANGE_PRICE'
        : 'TIME_STOP_WITH_POSITION_PRICE_FALLBACK',
      exitPrice: fallback,
      priceSource: current > 0 ? probe.source : 'POSITION_FALLBACK_PRICE',
      rangeStart: probe.rangeStart,
      rangeEnd: probe.rangeEnd,
      hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION
    };
  }

  if (current <= 0 || tp <= 0 || sl <= 0) {
    return {
      shouldExit: false,
      reason: null,
      trigger: null,
      exitPrice: 0,
      priceSource: probe.source
    };
  }

  return {
    shouldExit: false,
    reason: null,
    trigger: null,
    exitPrice: current,
    priceSource: probe.source,
    rangeStart: probe.rangeStart,
    rangeEnd: probe.rangeEnd
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

  const riskDistance = initialSl - entry;

  if (riskDistance <= 0) return 0;

  return (entry - exit) / riskDistance;
}

function calcRiskPctFromPosition(position = {}) {
  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);

  if (entry <= 0 || initialSl <= 0 || initialSl <= entry) return 0;

  return (initialSl - entry) / entry;
}

function calcRewardPctFromPosition(position = {}) {
  const entry = safeNumber(position.entry, 0);
  const tp = safeNumber(position.tp, 0);

  if (entry <= 0 || tp >= entry || tp <= 0) return 0;

  return (entry - tp) / entry;
}

function calcNetCostOutcome({
  position,
  exitPrice
} = {}) {
  const riskPct = calcRiskPctFromPosition(position);
  const grossMovePct = calcGrossMovePctFromPosition({
    position,
    exitPrice
  });

  const grossR = calcGrossRFromPosition({
    position,
    exitPrice
  });

  const entrySpreadPct = safeNumber(
    position.spreadPct ??
      position.liveSpreadPct ??
      position.orderbookSpreadPct ??
      CONFIG.short?.cost?.fallbackSpreadPct ??
      CONFIG.cost?.fallbackSpreadPct,
    0
  );

  const exitSpreadPct = safeNumber(
    position.exitSpreadPct ??
      position.spreadPct ??
      position.liveSpreadPct ??
      position.orderbookSpreadPct ??
      CONFIG.short?.cost?.fallbackSpreadPct ??
      CONFIG.cost?.fallbackSpreadPct,
    0
  );

  const cost = applyCosts({
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    source: OUTCOME_SOURCE,
    grossMovePct,
    riskPct,
    entrySpreadPct,
    exitSpreadPct
  }) || {};

  const appliedGrossR = Number.isFinite(safeNumber(cost.grossR, null))
    ? safeNumber(cost.grossR, grossR)
    : grossR;

  const costR = Math.max(
    0,
    safeNumber(
      cost.costR ??
        position.costR ??
        position.estimatedCostR ??
        position.avgCostR,
      0
    )
  );

  const netR = appliedGrossR - costR;

  return {
    cost,

    riskPct,
    rewardPct: calcRewardPctFromPosition(position),
    grossMovePct,

    grossR: appliedGrossR,
    costR,
    netR,

    feeR: Math.max(0, safeNumber(cost.feeR, 0)),
    slippageR: Math.max(0, safeNumber(cost.slippageR, 0)),
    marketImpactR: Math.max(0, safeNumber(cost.marketImpactR, 0)),
    spreadCostR: Math.max(0, safeNumber(cost.spreadCostR, 0)),

    feePct: safeNumber(cost.feePct, 0),
    slippagePct: safeNumber(cost.slippagePct, 0),
    costPct: safeNumber(cost.costPct, 0),
    grossPnlPct: safeNumber(cost.grossPnlPct, grossMovePct * 100),
    netPnlPct: safeNumber(cost.netPnlPct, (grossMovePct - safeNumber(cost.costRatio, 0)) * 100)
  };
}

function applyNetCostModelToOutcome({
  outcome,
  position,
  exitPrice
} = {}) {
  if (!outcome || typeof outcome !== 'object') return outcome;

  const outcomeSide = inferPositionTradeSide(outcome);

  if (!isShortPosition(position) || outcomeSide === OPPOSITE_TRADE_SIDE) {
    return {
      ...outcome,
      skipped: true,
      reason: 'NON_SHORT_OUTCOME_COST_MODEL_REJECTED',
      source: OUTCOME_SOURCE,
      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,
      realTrade: false,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true
    };
  }

  const net = calcNetCostOutcome({
    position,
    exitPrice
  });

  return forceShortPositionFields({
    ...outcome,

    source: OUTCOME_SOURCE,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: position.source || POSITION_SOURCE,

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    riskPct: round6(net.riskPct),
    rewardPct: round6(net.rewardPct),
    grossMovePct: round6(net.grossMovePct),

    grossR: round6(net.grossR),
    rawR: round6(net.grossR),
    realizedGrossR: round6(net.grossR),
    shortGrossR: round6(net.grossR),

    costR: round6(net.costR),
    avgCostR: round6(net.costR),
    totalCostR: round6(net.costR),
    feeR: round6(net.feeR),
    slippageR: round6(net.slippageR),
    marketImpactR: round6(net.marketImpactR),
    spreadCostR: round6(net.spreadCostR),

    feePct: round6(net.feePct),
    slippagePct: round6(net.slippagePct),
    costPct: round6(net.costPct),
    grossPnlPct: round6(net.grossPnlPct),
    netPnlPct: round6(net.netPnlPct),
    pnlPct: round6(net.netPnlPct),

    netR: round6(net.netR),
    shortNetR: round6(net.netR),
    exitR: round6(net.netR),
    realizedNetR: round6(net.netR),
    realizedR: round6(net.netR),
    r: round6(net.netR),

    win: net.netR > 0,
    loss: net.netR < 0,
    flat: net.netR === 0,
    isWin: net.netR > 0,

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: COST_MODEL_VERSION,
    costModelVersion: COST_MODEL_VERSION,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    monitorRule: 'hard time-stop pre-price; 1m candle range after; range result wins over current price',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)'
  });
}

function sortOpenPositions(a, b) {
  const aExpired = isTimeStopExpired(a, now(), {}) ? 1 : 0;
  const bExpired = isTimeStopExpired(b, now(), {}) ? 1 : 0;

  if (aExpired !== bExpired) return bExpired - aExpired;

  const aOpened = safeNumber(a.openedAt || a.createdAt, 0);
  const bOpened = safeNumber(b.openedAt || b.createdAt, 0);

  if (aOpened !== bOpened) return aOpened - bOpened;

  return String(a.symbol || '').localeCompare(String(b.symbol || ''));
}

async function readOpenPositionRows(redis, keys = [], options = {}) {
  const cfg = tradeConfig(options);
  const startedAt = now();
  const readTimeoutMs = cfg.readTimeoutMs;

  const rows = await mapConcurrent(
    keys,
    cfg.readConcurrency,
    async (key) => {
      if (runtimeExceeded(startedAt, readTimeoutMs, 75)) {
        return {
          key,
          row: null,
          timedOutByBudget: true
        };
      }

      const row = await withTimeout(
        getJson(redis, key, null),
        Math.max(100, readTimeoutMs),
        'OPEN_POSITION_READ_TIMEOUT',
        null
      );

      return {
        key,
        row
      };
    }
  );

  return rows;
}

export async function getOpenPositions(options = {}) {
  const redis = getDurableRedis();
  const cfg = tradeConfig(options);

  const requireFullRows =
    options.requireFullRows === true ||
    options.monitorMode === true ||
    options.forMonitor === true;

  const includeKeyOnly =
    requireFullRows
      ? false
      : options.includeKeyOnly !== false;

  const keys = await withTimeout(
    getKeys(redis, SHORT_KEYS.trade.openPattern, cfg.openPositionScanLimit),
    cfg.keysTimeoutMs,
    'GET_OPEN_POSITION_KEYS_TIMEOUT',
    []
  );

  const safeKeys = Array.isArray(keys)
    ? [...new Set(keys)].filter(Boolean)
    : [];

  if (!safeKeys.length) return [];

  const hydrateLimit = requireFullRows
    ? Math.min(safeKeys.length, cfg.openPositionScanLimit)
    : Math.min(safeKeys.length, cfg.hydrateLimit);

  const hydrateKeys = hydrateLimit > 0
    ? safeKeys.slice(0, hydrateLimit)
    : [];

  const readRows = hydrateKeys.length
    ? await readOpenPositionRows(redis, hydrateKeys, options)
    : [];

  const hydratedKeySet = new Set(readRows.map((row) => row.key));

  const validHydratedRows = readRows
    .map((item) => item.row)
    .filter(Boolean)
    .filter((row) => String(row.status || 'OPEN').toUpperCase() === 'OPEN')
    .filter(isShortPosition)
    .filter((row) => !isScannerFamilyRow(row))
    .filter((row) => isExactShortChildTrueMicroId(rowMicroId(row)))
    .filter((row) => isExactShortMicroMicroId(rowMicroMicroId(row)))
    .map((row) => forceShortPositionFields({
      ...row,
      openPositionKeyOnly: false,
      monitorEligible: true,
      cleanMicroMicroPosition: true
    }));

  if (!includeKeyOnly) {
    return validHydratedRows.sort(sortOpenPositions);
  }

  const hydratedSymbols = new Set(
    validHydratedRows
      .map((row) => storageSymbol(row))
      .filter(Boolean)
  );

  const keyOnlyRows = safeKeys
    .filter((key) => !hydratedKeySet.has(key))
    .map((key) => buildKeyOnlyOpenPosition(key))
    .filter((row) => row.symbol)
    .filter((row) => !hydratedSymbols.has(storageSymbol(row)));

  return [
    ...validHydratedRows,
    ...keyOnlyRows
  ].sort(sortOpenPositions);
}

export async function getOpenPosition(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return null;

  const row = await getJson(
    getDurableRedis(),
    SHORT_KEYS.trade.open(keySymbol),
    null
  ).catch(() => null);

  if (!row) return null;
  if (String(row.status || 'OPEN').toUpperCase() !== 'OPEN') return null;
  if (!isShortPosition(row)) return null;
  if (isScannerFamilyRow(row)) return null;
  if (!isExactShortChildTrueMicroId(rowMicroId(row))) return null;
  if (!isExactShortMicroMicroId(rowMicroMicroId(row))) return null;

  return row;
}

export async function saveOpenPosition(position) {
  assertShortInput(position, 'SAVE_OPEN_POSITION');

  const keySymbol = storageSymbol(position);

  if (!keySymbol) {
    throw new Error('OPEN_POSITION_SYMBOL_MISSING');
  }

  const existing = await getOpenPosition(keySymbol);

  if (
    existing &&
    existing.tradeId &&
    position.tradeId &&
    existing.tradeId !== position.tradeId
  ) {
    return forceShortPositionFields({
      ...existing,
      alreadyOpen: true,
      duplicateOpenPositionSkipped: true,
      skippedByExistingSymbol: true,
      attemptedTradeId: position.tradeId,
      attemptedAt: now(),
      reason: 'OPEN_POSITION_SYMBOL_ALREADY_OPEN_SHORT_ONLY'
    });
  }

  const normalized = forceShortPositionFields(position);
  const identity = normalizeMicroIdentity(normalized);

  const row = compactOpenPositionRow(forceShortPositionFields({
    ...normalized,
    ...identity,
    ...buildVirtualFlags(normalized),

    symbol: normalized.symbol || keySymbol,
    baseSymbol: normalized.baseSymbol || keySymbol,
    contractSymbol: normalized.contractSymbol || null,

    status: normalized.status || 'OPEN',

    strategyVersion: normalized.strategyVersion || CONFIG.strategyVersion,

    updatedAt: now()
  }));

  assertPositionPersistable(row);

  await setJson(
    getDurableRedis(),
    SHORT_KEYS.trade.open(keySymbol),
    row
  );

  return row;
}

export async function deleteOpenPosition(symbol) {
  const keySymbol = storageSymbol(symbol);

  if (!keySymbol) return 0;

  const key = SHORT_KEYS.trade.open(keySymbol);

  if (!key) return 0;

  const redis = getDurableRedis();

  return redis.del(key);
}

export function updatePathMetrics(position, price) {
  const cfg = manageConfig();

  if (!isShortPosition(position)) {
    position.updatedAt = now();
    position.shortOnly = true;
    position.longDisabled = true;
    position.longOnly = false;
    position.shortDisabled = false;
    position.liveManagementSkippedReason = 'NON_SHORT_POSITION_IGNORED';

    return position;
  }

  const current = safeNumber(price, 0);
  const entry = safeNumber(position.entry, 0);
  const initialSl = safeNumber(position.initialSl || position.sl, 0);
  const tp = safeNumber(position.tp, 0);

  if (entry <= 0 || initialSl <= 0 || tp <= 0 || current <= 0 || initialSl <= entry || tp >= entry) {
    return forceShortPositionFields({
      ...position,
      updatedAt: now()
    });
  }

  const riskDist = initialSl - entry;
  const rewardDist = entry - tp;

  const directionalMove = entry - current;
  const currentR = directionalMove / riskDist;
  const tpProgress = directionalMove / rewardDist;

  position.lastPrice = current;
  position.currentPrice = current;
  position.currentR = round4(currentR);
  position.shortCurrentR = round4(currentR);

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

  position.riskGeometryRule = 'SHORT: tp < entry < sl';
  position.tpHitRule = 'SHORT: candle.low <= tp';
  position.slHitRule = 'SHORT: candle.high >= sl';
  position.sameCandleBothHitRule = 'CONSERVATIVE_SL_FIRST';
  position.monitorRule = 'hard time-stop pre-price; 1m candle range after; range result wins over current price';
  position.grossRFormula = '(entry - exitPrice) / (initialSl - entry)';
  position.currentRFormula = '(entry - currentPrice) / (initialSl - entry)';
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

    tradeId: normalizedEntry.tradeId || randomId('trade_short'),

    symbol: normalizedEntry.symbol || keySymbol,
    baseSymbol: normalizedEntry.baseSymbol || keySymbol,
    contractSymbol: normalizedEntry.contractSymbol || null,

    status: 'OPEN',

    strategyVersion: normalizedEntry.strategyVersion || CONFIG.strategyVersion,

    openedAt,
    createdAt: openedAt,
    updatedAt: openedAt,

    initialSl: normalizedEntry.initialSl || normalizedEntry.sl,

    currentPrice: safeNumber(
      normalizedEntry.currentPrice ??
        normalizedEntry.price ??
        normalizedEntry.entry,
      0
    ),

    lastPrice: safeNumber(
      normalizedEntry.lastPrice ??
        normalizedEntry.currentPrice ??
        normalizedEntry.price ??
        normalizedEntry.entry,
      0
    ),

    currentR: 0,
    shortCurrentR: 0,
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

    directToSL: false,
    directSL: false,

    beArmed: false,
    beWouldExit: false,
    beExitR: 0,

    gaveBackAfterHalfR: false,
    gaveBackAfterOneR: false,
    nearTpThenLoss: false,

    liveManaged: false,
    beLiveApplied: false,
    trailLiveApplied: false,
    slManagementSource: null,

    lastMonitorAt: openedAt,
    lastCheckedAt: openedAt,
    lastMonitorPriceSource: null,
    lastMonitorRangeStart: null,
    lastMonitorRangeEnd: null,
    lastMonitorCandles: 0,
    lastMonitorHigh: null,
    lastMonitorLow: null,
    lastMonitorCandlesExcludedBeforeOpen: 0,
    lastMonitorFirstFullCandleTs: null,
    lastMonitorFreshPositionSuppressed: false,

    entryMarketWeather: normalizedEntry.entryMarketWeather || normalizedEntry.currentMarketWeather || null,
    entryCurrentRegime: normalizedEntry.entryCurrentRegime || normalizedEntry.currentRegime || null,
    entryCurrentTrendSide: normalizedEntry.entryCurrentTrendSide || normalizedEntry.currentTrendSide || null,
    entryCurrentFit: normalizedEntry.entryCurrentFit ?? normalizedEntry.currentFit ?? null,
    entryCurrentFitConfidence:
      normalizedEntry.entryCurrentFitConfidence ??
      normalizedEntry.currentMarketFitConfidence ??
      normalizedEntry.currentFitConfidence ??
      null,
    entryWeatherFitMatchedFamily: normalizedEntry.entryWeatherFitMatchedFamily ?? null,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,

    validShortRiskShape: validShortRiskGeometry(normalizedEntry),
    shortRiskFormula: 'tp < entry < sl',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    monitorRule: 'hard time-stop pre-price; 1m candle range after; range result wins over current price',
    shortExitRules: {
      tp: 'candle.low <= tp',
      sl: 'candle.high >= sl',
      sameCandleBothHit: 'CONSERVATIVE_SL_FIRST',
      timeStop: 'TIME_STOP',
      hardTimeStopPrePrice: true
    },
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION
  });

  assertPositionPersistable(position);

  return position;
}

async function markPriceFetchFailed(position, { persist = false } = {}) {
  position.priceFetchFailures = safeNumber(position.priceFetchFailures, 0) + 1;
  position.lastPriceFetchFailedAt = now();
  position.updatedAt = now();

  if (persist) {
    await saveOpenPosition(forceShortPositionFields(position)).catch(() => null);
  }

  return position;
}

function isDirectSLExit({
  position,
  exitReason
} = {}) {
  const reason = upper(exitReason);

  const stoppedOut =
    reason === 'SL' ||
    reason === 'HIT_SL' ||
    reason === 'STOP' ||
    reason === 'STOP_LOSS' ||
    reason === 'STOPLOSS' ||
    reason === 'HARD_SL' ||
    reason === 'DIRECT_SL';

  if (!stoppedOut) return false;

  if (
    Boolean(position.nearTpSeen) ||
    Boolean(position.reachedHalfR) ||
    Boolean(position.reachedOneR)
  ) {
    return false;
  }

  const mfeR = safeNumber(position.mfeR, 0);
  const maeR = safeNumber(position.maeR, 0);

  return Boolean(position.directToSL || position.directSL) ||
    mfeR < 0.25 ||
    maeR <= -0.8;
}

function enrichOutcomeIdentity(outcome = {}, position = {}) {
  const identity = normalizeMicroIdentity(position);

  const openedAt = safeNumber(position.openedAt || position.createdAt, 0);
  const closedAt = safeNumber(outcome.closedAt || outcome.completedAt, now());
  const ageSec = openedAt > 0 && closedAt > 0
    ? Math.max(0, Math.floor((closedAt - openedAt) / 1000))
    : 0;

  const exitReason = String(outcome.exitReason || '').toUpperCase();
  const directSL = isDirectSLExit({
    position,
    exitReason
  });

  const outcomeIdentity = [
    TARGET_TRADE_SIDE,
    position.tradeId || outcome.tradeId || '',
    position.symbol || position.contractSymbol || outcome.symbol || '',
    openedAt || '',
    closedAt || '',
    exitReason || '',
    safeNumber(outcome.exitPrice || outcome.exit, 0),
    identity.microMicroFamilyId
  ].join('|');

  return forceShortPositionFields({
    ...outcome,
    ...identity,

    source: OUTCOME_SOURCE,
    outcomeSource: OUTCOME_SOURCE,
    positionSource: position.source || POSITION_SOURCE,

    tradeId: position.tradeId || outcome.tradeId || null,
    outcomeId: outcome.outcomeId || `outcome_${randomId('short')}`,
    outcomeIdentity,
    outcomeIdentityHashSource: 'TRADE_ID_SYMBOL_OPEN_CLOSE_REASON_EXIT_MICRO_MICRO',

    activeRotationId: position.activeRotationId || outcome.activeRotationId || null,
    selectedRotationId: position.selectedRotationId || position.activeRotationId || outcome.selectedRotationId || outcome.activeRotationId || null,

    activeMacroFamilyId:
      position.activeMacroFamilyId ||
      identity.parentTrueMicroFamilyId ||
      null,

    selectedMacroFamilyId:
      position.selectedMacroFamilyId ||
      position.activeMacroFamilyId ||
      identity.parentTrueMicroFamilyId ||
      null,

    selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
    discordAlertEligible: Boolean(position.discordAlertEligible),
    selectedForDiscord: Boolean(
      position.selectedForDiscord ||
      position.discordAlertEligible ||
      position.selectedMicroFamilyAlert
    ),
    rotationMatchType: position.rotationMatchType || outcome.rotationMatchType || 'EXACT_MICRO_MICRO',
    matchType: position.matchType || outcome.matchType || 'EXACT_MICRO_MICRO',

    selectedTrueMicroFamilyId: identity.microFamilyId,
    selectedMicroFamilyId: identity.microFamilyId,
    activeTrueMicroFamilyId: identity.microFamilyId,
    activeMicroFamilyId: identity.microFamilyId,

    selectedMicroMicroFamilyId: identity.microMicroFamilyId,
    selectedTrueMicroMicroFamilyId: identity.microMicroFamilyId,
    selectedExactMicroMicroFamilyId: identity.microMicroFamilyId,
    activeMicroMicroFamilyId: identity.microMicroFamilyId,
    activeTrueMicroMicroFamilyId: identity.microMicroFamilyId,
    activeExactMicroMicroFamilyId: identity.microMicroFamilyId,

    selectedTrueMicroFamilyIds: [identity.microFamilyId],
    selectedMicroFamilyIds: [identity.microFamilyId],
    activeTrueMicroFamilyIds: [identity.microFamilyId],
    activeMicroFamilyIds: [identity.microFamilyId],
    trueMicroFamilyIds: [identity.microFamilyId],
    childTrueMicroFamilyIds: [identity.microFamilyId],
    microFamilyIds: [identity.microFamilyId],

    selectedMicroMicroFamilyIds: [identity.microMicroFamilyId],
    selectedTrueMicroMicroFamilyIds: [identity.microMicroFamilyId],
    selectedExactMicroMicroFamilyIds: [identity.microMicroFamilyId],
    activeMicroMicroFamilyIds: [identity.microMicroFamilyId],
    activeTrueMicroMicroFamilyIds: [identity.microMicroFamilyId],
    activeExactMicroMicroFamilyIds: [identity.microMicroFamilyId],
    microMicroFamilyIds: [identity.microMicroFamilyId],
    trueMicroMicroFamilyIds: [identity.microMicroFamilyId],

    weeklyStats: compactWeeklyStats(position.weeklyStats),

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: false,

    realTrade: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    scannerMicroFamilyId: position.scannerMicroFamilyId || identity.scannerMicroFamilyId || null,
    scannerFamilyId: position.scannerFamilyId || identity.scannerFamilyId || null,
    scannerDefinition: position.scannerDefinition || identity.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(position.scannerDefinitionParts)
      ? position.scannerDefinitionParts.slice(0, 40)
      : identity.scannerDefinitionParts || [],

    executionMicroFamilyId: position.executionMicroFamilyId || identity.executionMicroFamilyId || null,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintOnlyMetadata: Boolean(position.executionMicroFamilyId || identity.executionMicroFamilyId),
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: Boolean(position.scannerMicroFamilyId || identity.scannerMicroFamilyId),
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    outcomeIdentityLocked: true,
    outcomeIdentitySource: 'POSITION_MICRO_MICRO_IDENTITY',
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    exactMicroMicroOnly: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    isTrueMicro: true,
    trueMicro: true,
    isMicroMicro: true,
    isLegacyMacro: false,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,

    currentPrice: safeNumber(position.currentPrice ?? position.lastPrice ?? outcome.exitPrice, 0),
    lastPrice: safeNumber(position.lastPrice ?? position.currentPrice ?? outcome.exitPrice, 0),
    entry: safeNumber(position.entry ?? outcome.entry, 0),
    sl: safeNumber(position.sl ?? outcome.sl, 0),
    tp: safeNumber(position.tp ?? outcome.tp, 0),
    initialSl: safeNumber(position.initialSl ?? outcome.initialSl ?? position.sl, 0),

    ageSec,
    currentR: safeNumber(position.currentR ?? outcome.currentR, 0),
    shortCurrentR: safeNumber(position.shortCurrentR ?? position.currentR ?? outcome.shortCurrentR ?? outcome.currentR, 0),
    mfeR: safeNumber(position.mfeR ?? outcome.mfeR, 0),
    maeR: safeNumber(position.maeR ?? outcome.maeR, 0),

    reachedHalfR: Boolean(position.reachedHalfR || outcome.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR || outcome.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen || outcome.nearTpSeen),

    directToSL: directSL,
    directSL,

    tpExitTriggered: exitReason === 'TP',
    slExitTriggered: exitReason === 'SL',
    timeStopExitTriggered: exitReason === 'TIME_STOP',

    exitRuleMatched:
      exitReason === 'TP'
        ? 'candle.low <= tp'
        : exitReason === 'SL'
          ? 'candle.high >= sl'
          : exitReason === 'TIME_STOP'
            ? 'TIME_STOP'
            : null,

    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,

    validShortRiskShape: validShortRiskGeometry(position),
    shortRiskFormula: 'tp < entry < sl',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    monitorRule: 'hard time-stop pre-price; 1m candle range after; range result wins over current price',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    entryMarketWeather: compactMarketWeather(position.entryMarketWeather || outcome.entryMarketWeather),
    entryCurrentRegime: position.entryCurrentRegime || position.currentRegime || outcome.entryCurrentRegime || outcome.currentRegime || null,
    entryCurrentTrendSide: position.entryCurrentTrendSide || position.currentTrendSide || outcome.entryCurrentTrendSide || outcome.currentTrendSide || null,
    entryCurrentFit: position.entryCurrentFit ?? position.currentFit ?? outcome.entryCurrentFit ?? outcome.currentFit ?? null,
    entryCurrentFitConfidence:
      position.entryCurrentFitConfidence ??
      position.currentMarketFitConfidence ??
      outcome.entryCurrentFitConfidence ??
      outcome.currentMarketFitConfidence ??
      null,
    entryWeatherFitMatchedFamily: position.entryWeatherFitMatchedFamily ?? outcome.entryWeatherFitMatchedFamily ?? null,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    directSLDefinition: 'SL_EXIT_WITHOUT_MEANINGFUL_MFE',
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true
  });
}

async function maybeSendExitAlert(position, outcome, options = {}) {
  if (!position.discordAlertEligible && !position.selectedMicroFamilyAlert && !position.selectedForDiscord) {
    return {
      sent: false,
      skipped: true,
      reason: 'POSITION_NOT_SELECTED_FOR_DISCORD_EXIT_ALERT'
    };
  }

  if (!isExactShortMicroMicroId(outcome.microMicroFamilyId || outcome.trueMicroMicroFamilyId || outcome.exactMicroMicroFamilyId)) {
    return {
      sent: false,
      skipped: true,
      reason: 'EXIT_ALERT_REQUIRES_EXACT_MICRO_MICRO_FAMILY'
    };
  }

  return withTimeout(
    sendExitAlert(outcome).then((result) => {
      if (result?.skipped) {
        return {
          sent: false,
          skipped: true,
          reason: result.reason || 'DISCORD_EXIT_ALERT_SKIPPED_BY_DISCORD_FILTER',
          result
        };
      }

      if (result?.ok) {
        return {
          sent: true,
          skipped: false,
          reason: 'DISCORD_EXIT_ALERT_SENT',
          result
        };
      }

      return {
        sent: false,
        skipped: false,
        failed: true,
        reason: result?.error || result?.reason || 'DISCORD_EXIT_ALERT_FAILED',
        result
      };
    }),
    options.discordExitTimeoutMs || DEFAULT_DISCORD_EXIT_TIMEOUT_MS,
    'DISCORD_EXIT_ALERT_TIMEOUT',
    {
      sent: false,
      skipped: false,
      failed: true,
      timeout: true,
      reason: 'DISCORD_EXIT_ALERT_TIMEOUT'
    }
  );
}

async function persistOutcomeNonBlocking(outcome, options = {}) {
  return withTimeout(
    recordOutcome(clonePlainObject(outcome), {
      source: OUTCOME_SOURCE,
      weekKey: PERSISTENT_LEARNING_KEY,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      virtualOnly: true,
      realOrdersDisabled: true,
      bitgetOrdersDisabled: true,
      exchangeCallsDisabled: true,
      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      microMicroLearningEnabled: true,
      selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
      learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
      trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,
      learningGranularity: LEARNING_GRANULARITY,
      parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
      microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
      hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION
    }),
    options.recordOutcomeTimeoutMs || DEFAULT_RECORD_OUTCOME_TIMEOUT_MS,
    'RECORD_OUTCOME_TIMEOUT',
    {
      ok: false,
      timeout: true,
      reason: 'RECORD_OUTCOME_TIMEOUT'
    }
  );
}

async function closePosition({
  position,
  exit,
  timestamp,
  options = {}
}) {
  const closedAt = timestamp;
  const exitPrice = roundPrice(exit.exitPrice || fallbackExitPrice(position));
  const directSL = isDirectSLExit({
    position,
    exitReason: exit.reason
  });

  const closedPosition = forceShortPositionFields({
    ...position,
    status: 'CLOSED',
    closedAt,
    completedAt: closedAt,
    exitPrice,
    exitReason: exit.reason,
    exitTrigger: exit.trigger,
    exitPriceSource: exit.priceSource || null,
    exitRangeStart: exit.rangeStart || null,
    exitRangeEnd: exit.rangeEnd || null,
    firstTouch: exit.firstTouch || null,
    conservativeExit: Boolean(exit.conservativeExit),
    hardTimeStop: Boolean(exit.hardTimeStop),
    hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
    outcomeSource: OUTCOME_SOURCE,
    source: POSITION_SOURCE,
    directToSL: directSL,
    directSL
  });

  const baseOutcome = buildOutcomeFromPosition({
    position: closedPosition,
    exitPrice,
    exitReason: exit.reason,
    source: OUTCOME_SOURCE
  });

  const netOutcome = applyNetCostModelToOutcome({
    outcome: {
      ...baseOutcome,
      status: 'CLOSED',
      closedAt,
      completedAt: closedAt,
      exitPrice,
      exitReason: exit.reason,
      exitTrigger: exit.trigger,
      exitPriceSource: exit.priceSource || null,
      exitRangeStart: exit.rangeStart || null,
      exitRangeEnd: exit.rangeEnd || null,
      firstTouch: exit.firstTouch || null,
      conservativeExit: Boolean(exit.conservativeExit),
      hardTimeStop: Boolean(exit.hardTimeStop),
      hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION,
      source: OUTCOME_SOURCE,
      outcomeSource: OUTCOME_SOURCE,
      directToSL: directSL,
      directSL
    },
    position: closedPosition,
    exitPrice
  });

  const outcome = enrichOutcomeIdentity(netOutcome, closedPosition);

  const recordResult = await persistOutcomeNonBlocking(outcome, options);
  const discordResult = await maybeSendExitAlert(closedPosition, clonePlainObject(outcome), options);
  const deleteResult = await deleteOpenPosition(closedPosition.symbol || closedPosition.contractSymbol)
    .catch((error) => ({
      deleted: false,
      error: error?.message || String(error)
    }));

  return {
    type: 'EXIT',
    position: closedPosition,
    outcome: {
      ...outcome,
      recordOutcomeResult: recordResult,
      openPositionDeleteResult: deleteResult,
      discordExitAlertResult: discordResult,
      discordExitAlertSent: Boolean(discordResult.sent)
    }
  };
}

async function monitorOnePosition({
  position,
  priceFetcher,
  timestamp,
  startedAt,
  options = {}
}) {
  try {
    const cfg = tradeConfig(options);

    if (runtimeExceeded(startedAt, cfg.monitorRuntimeMs, 200)) {
      return {
        type: 'SKIPPED_RUNTIME_BUDGET',
        position,
        outcome: null
      };
    }

    if (!isShortPosition(position)) {
      return {
        type: 'IGNORED_NON_SHORT',
        position,
        outcome: null
      };
    }

    if (isScannerFamilyRow(position)) {
      return {
        type: 'IGNORED_SCANNER_FINGERPRINT_POSITION',
        position,
        outcome: null
      };
    }

    if (!isExactShortChildTrueMicroId(rowMicroId(position))) {
      return {
        type: 'IGNORED_NON_EXACT_75_CHILD_POSITION',
        position,
        outcome: null
      };
    }

    if (!isExactShortMicroMicroId(rowMicroMicroId(position))) {
      return {
        type: 'IGNORED_NON_EXACT_MICRO_MICRO_POSITION',
        position,
        outcome: null
      };
    }

    if (cfg.closeExpiredBeforePriceFetch) {
      const hardTimeStopExit = buildHardTimeStopExit(position, timestamp, options);

      if (hardTimeStopExit.shouldExit) {
        return closePosition({
          position: forceShortPositionFields({
            ...position,
            hardTimeStopPrePriceExit: true,
            hardTimeStopCleanupVersion: HARD_TIME_STOP_CLEANUP_VERSION
          }),
          exit: hardTimeStopExit,
          timestamp,
          options
        });
      }
    }

    const priceProbe = await resolveMonitorPriceProbe({
      position,
      priceFetcher,
      timestamp,
      options
    });

    const currentPrice = safeNumber(priceProbe.last, 0);

    if (priceProbe.ok && currentPrice > 0) {
      position.priceFetchFailures = 0;
      position.lastPriceFetchFailedAt = null;

      updatePathMetricsWithProbe(position, priceProbe);
    }

    const exit = detectExit({
      position,
      priceProbe,
      timestamp,
      options
    });

    if (exit.shouldExit) {
      return closePosition({
        position,
        exit,
        timestamp,
        options
      });
    }

    if (!priceProbe.ok || currentPrice <= 0) {
      await markPriceFetchFailed(position, {
        persist: cfg.persistNoPriceFailures
      });

      return {
        type: 'NO_PRICE',
        position,
        outcome: null,
        priceProbe
      };
    }

    await saveOpenPosition(position).catch((error) => ({
      ok: false,
      error: error?.message || String(error)
    }));

    return {
      type: 'UPDATED',
      position,
      outcome: null,
      priceProbe
    };
  } catch (error) {
    return {
      type: 'POSITION_MONITOR_ERROR',
      position,
      outcome: null,
      error: error?.message || String(error)
    };
  }
}

export async function monitorOpenPositions(options = {}) {
  const {
    priceFetcher
  } = options;

  if (typeof priceFetcher !== 'function') {
    throw new Error('PRICE_FETCHER_REQUIRED');
  }

  const cfg = tradeConfig(options);
  const startedAt = now();
  const timestamp = now();

  const openPositions = await withTimeout(
    getOpenPositions({
      ...options,
      requireFullRows: true,
      includeKeyOnly: false,
      monitorMode: true,
      limit: Math.min(
        cfg.openPositionScanLimit,
        Math.max(cfg.monitorPositionLimit, cfg.monitorBatchSize)
      ),
      hydrateLimit: Math.min(
        cfg.monitorPositionLimit,
        cfg.monitorBatchSize
      )
    }),
    Math.min(2500, cfg.monitorRuntimeMs),
    'GET_OPEN_POSITIONS_TIMEOUT',
    []
  );

  const allPositions = (Array.isArray(openPositions) ? openPositions : [])
    .filter((row) => row?.openPositionKeyOnly !== true)
    .filter(isCleanMicroMicroRow)
    .sort(sortOpenPositions);

  if (!allPositions.length) return [];

  const expired = allPositions.filter((row) => isTimeStopExpired(row, timestamp, options));
  const fresh = allPositions.filter((row) => !isTimeStopExpired(row, timestamp, options));

  const positions = [
    ...expired,
    ...fresh
  ].slice(0, Math.min(cfg.monitorPositionLimit, cfg.monitorBatchSize));

  const results = await mapConcurrent(
    positions,
    cfg.dataConcurrency,
    async (position) => {
      if (runtimeExceeded(startedAt, cfg.monitorRuntimeMs, 250)) {
        return {
          type: 'SKIPPED_RUNTIME_BUDGET',
          position,
          outcome: null
        };
      }

      return withTimeout(
        monitorOnePosition({
          position,
          priceFetcher,
          timestamp,
          startedAt,
          options
        }),
        cfg.monitorOnePositionTimeoutMs,
        'MONITOR_ONE_POSITION_TIMEOUT',
        {
          type: 'POSITION_MONITOR_TIMEOUT',
          position,
          outcome: null
        }
      );
    }
  );

  return results
    .filter((row) => row?.type === 'EXIT' && row.outcome)
    .map((row) => row.outcome);
}