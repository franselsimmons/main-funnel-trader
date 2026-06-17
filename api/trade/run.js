// ================= FILE: api/trade/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';
import { sideToTradeSide } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';
const DEFAULT_LOCK_TTL_SEC = 75;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const RUN_SCOPE = 'TRADE_FAST_SCANNER_PRELOAD_OPTIONAL';
const WRITE_SCOPE = 'TRADE_AND_ANALYZE_PARTIAL_ONLY';
const READ_SCOPE = 'READ_SHORT_SCANNER_AND_MARKET_WEATHER';

const MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const SHORT_MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const SHORT_MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;

const MAX_DEBUG_ROWS = 75;

const SHORT_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const SHORT_FIXED_REGIME_BUCKETS = new Set([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const SHORT_FIXED_CONFIRMATION_PROFILES = new Set([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

function now() {
  return Date.now();
}

function callMaybeKey(value, fallback = null) {
  if (typeof value === 'function') {
    try {
      return value();
    } catch {
      return fallback;
    }
  }

  return value || fallback;
}

function namespacedShortKey(key, fallback = null) {
  let raw = String(callMaybeKey(key, fallback) || '').trim();

  if (!raw) return null;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) raw = raw.slice('LONG:'.length);

  return `${SHORT_KEY_PREFIX}${raw}`;
}

const SHORT_KEYS = {
  scan: {
    latest: namespacedShortKey(
      KEYS.short?.scan?.latest ||
        KEYS.scan?.shortLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    )
  },

  trade: {
    lock: namespacedShortKey(
      KEYS.short?.trade?.lock ||
        KEYS.trade?.shortLock ||
        KEYS.trade?.lock,
      'TRADE:LOCK'
    ),

    runMeta: namespacedShortKey(
      KEYS.short?.trade?.runMeta ||
        KEYS.trade?.shortRunMeta ||
        KEYS.trade?.runMeta,
      'TRADE:RUN_META'
    ),

    lastProcessedSnapshot: namespacedShortKey(
      KEYS.short?.trade?.lastProcessedSnapshot ||
        KEYS.trade?.shortLastProcessedSnapshot ||
        KEYS.trade?.lastProcessedSnapshot,
      'TRADE:LAST_PROCESSED_SNAPSHOT'
    )
  },

  market: {
    universeLatest: MARKET_UNIVERSE_KEY,
    shortUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
    weatherLatest: MARKET_WEATHER_KEY,
    shortWeatherLatest: SHORT_MARKET_WEATHER_KEY
  }
};

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(safeNumber(value, 0).toFixed(decimals));
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function getPositionTimeStopMin() {
  const value = Number(
    CONFIG.short?.trade?.positionTimeStopMin ??
      CONFIG.trade?.shortPositionTimeStopMin ??
      CONFIG.trade?.positionTimeStopMin ??
      DEFAULT_POSITION_TIME_STOP_MIN
  );

  if (!Number.isFinite(value) || value <= 0) return DEFAULT_POSITION_TIME_STOP_MIN;

  return Math.floor(value);
}

function getLockTtlSec() {
  const ttl = Number(
    CONFIG.short?.trade?.lockTtlSec ??
      CONFIG.trade?.shortLockTtlSec ??
      CONFIG.trade?.lockTtlSec ??
      DEFAULT_LOCK_TTL_SEC
  );

  if (!Number.isFinite(ttl) || ttl <= 0) return DEFAULT_LOCK_TTL_SEC;

  return Math.max(10, Math.floor(ttl));
}

function isolationFlags() {
  return {
    runScope: RUN_SCOPE,
    writeScope: WRITE_SCOPE,
    readScope: READ_SCOPE,

    adminPageIsolation: true,
    doesNotOverwriteOtherAdminPages: true,

    scannerPreloadOptional: true,
    scannerPreloadDefaultDisabled: true,
    scannerPreloadBeforeTrade: false,
    scannerPreloadRequiredForMarketWeather: false,

    readsScannerLatest: true,
    scannerLatestReadOnlyInsideTradeSystem: true,
    preserveScannerLatest: true,
    preserveScannerSnapshot: true,
    preserveScannerHistory: true,

    scannerRunAllowed: false,
    scannerRunAllowedByExplicitFlag: true,
    scannerRunBeforeTrade: false,
    scannerRunDisabledInsideTradeSystem: true,
    noInternalScannerRunInsideTradeSystem: true,

    writesScanner: false,
    writesScannerLatest: false,
    writesScannerSnapshot: false,
    writesScannerHistory: false,

    writesMarketUniverse: false,
    writesMarketWeather: false,
    writesMarketWeatherInput: false,

    writesTrade: true,
    writesTradeRunMeta: true,
    writesTradePositions: true,

    writesAnalyze: true,
    writesAnalyzePartial: true,
    writesMicroFamilies: true,
    microFamiliesAppendOnly: true,
    microFamiliesAntiWipe: true,
    analyzePartialOnly: true,
    analyzeFullOverwriteDisabled: true,

    writesRotation: false,
    writesDiscordSelection: false,
    writesManualSelection: false,

    preserveRotation: true,
    preserveManualSelection: true,
    preserveDiscordSelection: true,

    noResetCron: true,
    resetCronDisabled: true,
    noActivateCron: true,
    activateCronDisabled: true,
    noFreezeCron: true,
    freezeCronDisabled: true,
    autoRotationActivationDisabled: true,

    ignoreGlobalMaxOpenPositions: true,
    noGlobalMaxOpenPositionsBlock: true,
    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true
  };
}

function baseFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,

    learningOnly: true,
    microFamilyLearning: true,

    observationFirst: true,
    observationFirstAnalyze: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsHiddenFromLearning: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: true,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,
    selectableMicroFamilyCount: 75,
    parentMicroFamilyCount: 15,
    selectionGranularity: 'EXACT_75_CHILD',
    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    positionTimeStopMin: getPositionTimeStopMin(),

    shortRiskShape: 'tp < entry < sl',
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    learningRemainsBroad: true,

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionRequires75ChildTrueMicroFamilyId: true,
    parentMacroMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    ...isolationFlags()
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...baseFlags()
  });
}

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
}

function parseJson(text) {
  const raw = String(text || '').trim();

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.method === 'GET') return {};

  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}

function shouldForceProcessSnapshot(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(firstValue(req.query?.force_process_snapshot, false)) ||
    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot)
  );
}

function shouldMonitorOnly(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.monitorOnly, false)) ||
    isTrue(firstValue(req.query?.monitor_only, false)) ||
    isTrue(body.monitorOnly) ||
    isTrue(body.monitor_only)
  );
}

function shouldDebug(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.debug, false)) ||
    isTrue(firstValue(req.query?.details, false)) ||
    isTrue(firstValue(req.query?.full, false)) ||
    isTrue(body.debug) ||
    isTrue(body.details) ||
    isTrue(body.full)
  );
}

function shouldRunScannerPreload(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.scannerPreload, false)) ||
    isTrue(firstValue(req.query?.scanner_preload, false)) ||
    isTrue(firstValue(req.query?.preloadScanner, false)) ||
    isTrue(firstValue(req.query?.runScanner, false)) ||
    isTrue(body.scannerPreload) ||
    isTrue(body.scanner_preload) ||
    isTrue(body.preloadScanner) ||
    isTrue(body.runScanner)
  );
}

function getRunSource(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(firstValue(req.query?.forceProcessSnapshot, false)) ||
    isTrue(firstValue(req.query?.force_process_snapshot, false)) ||
    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(body.forceProcessSnapshot) ||
    isTrue(body.force_process_snapshot)
  );

  return manual
    ? 'ADMIN_MANUAL_SHORT_TRADE_RUN_FAST'
    : 'CRON_OR_API_SHORT_TRADE_RUN_FAST';
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('BLOCK_LONG_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('BLOCK_LONG', 'SHORT')
    .replaceAll('LONG_DISABLED', 'SHORT')
    .replaceAll('LONGDISABLED', 'SHORT')
    .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
    .replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
    .replaceAll('BLOCK_SHORT', 'LONG')
    .replaceAll('SHORT_DISABLED', 'LONG')
    .replaceAll('SHORTDISABLED', 'LONG')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeSignalText(value = '') {
  return cleanSideText(value)
    .replace(/[^A-Z0-9=:_|]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasSignalPattern(value = '', patterns = []) {
  const text = normalizeSignalText(value);

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`) ||
    text.includes(`=${pattern}`) ||
    text.includes(`:${pattern}`) ||
    text.includes(`|${pattern}|`)
  ));
}

function hasShortSignal(value = '') {
  return hasSignalPattern(value, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'DOWN',
    'DOWNSIDE',
    'MICRO_SHORT',
    'SIDE_SHORT',
    'SIDE_BEAR',
    'SIDE_SELL',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'DIRECTION_BEAR',
    'DIRECTION_SELL'
  ]);
}

function hasLongSignal(value = '') {
  return hasSignalPattern(value, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'UP',
    'UPSIDE',
    'MICRO_LONG',
    'SIDE_LONG',
    'SIDE_BULL',
    'SIDE_BUY',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'DIRECTION_BULL',
    'DIRECTION_BUY'
  ]);
}

function parseShortFixedTaxonomyId(id = '') {
  const value = upper(id);
  const match = /^MICRO_SHORT_([A-Z_]+)_(TREND|CHOP|SQUEEZE)(?:_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA))?$/.exec(value);

  if (!match) return null;

  const setup = match[1];
  const regime = match[2];
  const confirmation = match[3] || null;

  if (!SHORT_FIXED_SETUP_TYPES.has(setup)) return null;
  if (!SHORT_FIXED_REGIME_BUCKETS.has(regime)) return null;
  if (confirmation && !SHORT_FIXED_CONFIRMATION_PROFILES.has(confirmation)) return null;

  const parentTrueMicroFamilyId = `MICRO_SHORT_${setup}_${regime}`;
  const childTrueMicroFamilyId = confirmation
    ? `${parentTrueMicroFamilyId}_${confirmation}`
    : null;

  return {
    setup,
    regime,
    confirmation,
    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    isParent: !confirmation,
    isChild: Boolean(confirmation)
  };
}

function isFixedShortTaxonomyParentId(id = '') {
  return parseShortFixedTaxonomyId(id)?.isParent === true;
}

function isFixedShortTaxonomyChildId(id = '') {
  return parseShortFixedTaxonomyId(id)?.isChild === true;
}

function parentFromChildTrueMicroFamilyId(id = '') {
  const parsed = parseShortFixedTaxonomyId(id);

  if (!parsed?.isChild) return null;

  return parsed.parentTrueMicroFamilyId;
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

function idLooksLikeShortFamily(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;

  return hasShortSignal(value);
}

function idLooksLikeLongFamily(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;

  return hasLongSignal(value);
}

function isSelectableTrueMicroId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;
  if (!isFixedShortTaxonomyChildId(value)) return false;
  if (idLooksLikeLongFamily(value) && !idLooksLikeShortFamily(value)) return false;

  return true;
}

function isSelectableParentTrueMicroId(id = '') {
  const value = String(id || '').trim();

  if (!validLearningId(value)) return false;
  if (!isFixedShortTaxonomyParentId(value)) return false;
  if (idLooksLikeLongFamily(value) && !idLooksLikeShortFamily(value)) return false;

  return true;
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

function stripSymbolTokensFromFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return raw;

  if (isFixedShortTaxonomyParentId(raw) || isFixedShortTaxonomyChildId(raw)) {
    return upper(raw);
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

function cleanLearningFamilyId(id = '', row = {}) {
  const raw = String(id || '').trim();

  if (!raw) return '';
  if (isScannerFingerprintId(raw)) return '';
  if (isExecutionFingerprintId(raw)) return '';

  const clean = stripSymbolTokensFromFamilyId(raw, row);

  if (!clean) return '';
  if (isScannerFingerprintId(clean)) return '';
  if (isExecutionFingerprintId(clean)) return '';

  return clean;
}

function scannerMicroFamilyIdFrom(row = {}) {
  return (
    row.scannerMicroFamilyId ||
    (isScannerFingerprintId(row.microFamilyId) ? row.microFamilyId : null) ||
    (isScannerFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null) ||
    (isScannerFingerprintId(row.id) ? row.id : null) ||
    (isScannerFingerprintId(row.key) ? row.key : null) ||
    null
  );
}

function scannerFamilyIdFrom(row = {}) {
  return (
    row.scannerFamilyId ||
    (isScannerFingerprintId(row.familyId) ? row.familyId : null) ||
    (isScannerFingerprintId(row.baseFamilyId) ? row.baseFamilyId : null) ||
    null
  );
}

function executionMicroFamilyIdFrom(row = {}) {
  return (
    row.executionMicroFamilyId ||
    (isExecutionFingerprintId(row.microFamilyId) ? row.microFamilyId : null) ||
    (isExecutionFingerprintId(row.trueMicroFamilyId) ? row.trueMicroFamilyId : null) ||
    (isExecutionFingerprintId(row.analyzeMicroFamilyId) ? row.analyzeMicroFamilyId : null) ||
    (isExecutionFingerprintId(row.id) ? row.id : null) ||
    (isExecutionFingerprintId(row.key) ? row.key : null) ||
    null
  );
}

function scannerMetadataFrom(row = {}) {
  const scannerMicroFamilyId = scannerMicroFamilyIdFrom(row);
  const scannerFamilyId = scannerFamilyIdFrom(row);
  const executionMicroFamilyId = executionMicroFamilyIdFrom(row);

  return {
    scannerMicroFamilyId: scannerMicroFamilyId || null,
    scannerFamilyId: scannerFamilyId || null,
    scannerDefinition: row.scannerDefinition || (
      scannerMicroFamilyId
        ? row.definition || row.microDefinition || null
        : null
    ),
    scannerDefinitionParts: Array.isArray(row.scannerDefinitionParts)
      ? row.scannerDefinitionParts
      : scannerMicroFamilyId && Array.isArray(row.definitionParts)
        ? row.definitionParts
        : [],

    scannerBucket: row.scannerBucket || row.bucket || null,
    scannerBucket25: row.scannerBucket25 || row.legacyBucket25 || null,
    scannerFingerprintHash: row.scannerFingerprintHash || row.fingerprintHash || null,
    scannerFingerprintParts: Array.isArray(row.scannerFingerprintParts)
      ? row.scannerFingerprintParts
      : [],

    executionMicroFamilyId,
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: Boolean(executionMicroFamilyId),
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true
  };
}

function firstCleanId(values = [], row = {}) {
  for (const value of values) {
    const id = cleanLearningFamilyId(value, row);

    if (id && validLearningId(id)) return id;
  }

  return '';
}

function normalizeLearningIdentity(row = {}) {
  const childCandidate = firstCleanId([
    row.trueMicroFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.childTrueMicroFamilyId
  ], row);

  const childTrueMicroFamilyId = isSelectableTrueMicroId(childCandidate)
    ? upper(childCandidate)
    : null;

  const parentCandidate = firstCleanId([
    row.parentTrueMicroFamilyId,
    row.parentMicroFamilyId,
    row.parentMacroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    parentFromChildTrueMicroFamilyId(childTrueMicroFamilyId)
  ], row);

  const parentTrueMicroFamilyId = isSelectableParentTrueMicroId(parentCandidate)
    ? upper(parentCandidate)
    : parentFromChildTrueMicroFamilyId(childTrueMicroFamilyId);

  return {
    microFamilyId: childTrueMicroFamilyId,
    trueMicroFamilyId: childTrueMicroFamilyId,
    analyzeMicroFamilyId: childTrueMicroFamilyId,
    learningMicroFamilyId: childTrueMicroFamilyId,

    childTrueMicroFamilyId,
    parentTrueMicroFamilyId,

    coarseMicroFamilyId: parentTrueMicroFamilyId,
    baseMicroFamilyId: parentTrueMicroFamilyId,
    legacyMicroFamilyId: parentTrueMicroFamilyId,

    parentMicroFamilyId: parentTrueMicroFamilyId,
    parentMacroFamilyId: parentTrueMicroFamilyId,
    macroFamilyId: parentTrueMicroFamilyId,

    fixedTaxonomyLearningId: Boolean(childTrueMicroFamilyId),
    fixedTaxonomyParentId: Boolean(parentTrueMicroFamilyId),
    trueMicroFamilySchema: childTrueMicroFamilyId ? TRUE_MICRO_SCHEMA : null,
    parentTrueMicroFamilySchema: parentTrueMicroFamilyId ? PARENT_TRUE_MICRO_SCHEMA : null,
    broadTrueMicroFamilySchema: childTrueMicroFamilyId ? TRUE_MICRO_SCHEMA : null,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromText(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const direct = normalizeTradeSide(text);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const shortHit = hasShortSignal(text);
  const longHit = hasLongSignal(text);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferActionTradeSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.entrySide,
    row.side,
    row.bias,
    row.marketBias
  ];

  for (const value of directSources) {
    const direct = normalizeTradeSide(value);

    if (direct !== 'UNKNOWN') return direct;
  }

  const reasonSide = inferTradeSideFromText(
    row.scannerReason ||
      row.reason ||
      row.signalReason ||
      row.actionReason ||
      row.exitReason ||
      row.rejectionReason ||
      ''
  );

  if (reasonSide !== 'UNKNOWN') return reasonSide;

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
    row.coarseMicroFamilyId,
    row.baseMicroFamilyId,
    row.legacyMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

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
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('|');

  const side = inferTradeSideFromText(haystack);

  if (side !== 'UNKNOWN') return side;

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortAction(row = {}) {
  return inferActionTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isLongAction(row = {}) {
  return inferActionTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const output = [];

  while (stack.length > 0) {
    const value = stack.shift();

    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }

    output.push(value);
  }

  return output;
}

function firstFiniteNumber(values = []) {
  for (const value of flattenValues(values)) {
    if (value === undefined || value === null || value === '') continue;

    const n = Number(value);

    if (Number.isFinite(n)) return n;
  }

  return null;
}

function currentFitLabel(score = 0, fallback = 'UNKNOWN') {
  if (!Number.isFinite(score)) return fallback || 'UNKNOWN';
  if (score >= 45) return 'FIT';
  if (score >= 20) return 'OK';
  if (score <= -20) return 'MISFIT';

  return 'NEUTRAL';
}

function marketBiasHaystack(row = {}) {
  return [
    row.currentMarketTrendSide,
    row.marketTrendSide,
    row.trendSide,
    row.dashboardSide,
    row.marketSide,
    row.marketBias,
    row.bias,
    row.direction,
    row.currentRegime,
    row.marketRegime,
    row.regime,
    row.scannerReason,
    row.reason,
    row.currentFitReason,
    ...(Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [])
  ]
    .map((value) => upper(value))
    .join(' | ');
}

function moveMetricValues(row = {}) {
  return [
    row.change1m,
    row.change3m,
    row.change5m,
    row.change15m,
    row.change30m,
    row.change1h,
    row.change2h,
    row.change4h,
    row.change24h,

    row.priceChange1m,
    row.priceChange3m,
    row.priceChange5m,
    row.priceChange15m,
    row.priceChange30m,
    row.priceChange1h,
    row.priceChange2h,
    row.priceChange4h,
    row.priceChange24h,

    row.priceChange1mPct,
    row.priceChange3mPct,
    row.priceChange5mPct,
    row.priceChange15mPct,
    row.priceChange30mPct,
    row.priceChange1hPct,
    row.priceChange2hPct,
    row.priceChange4hPct,
    row.priceChange24hPct,

    row.percentChange,
    row.changePct,
    row.movePct,
    row.pctMove,
    row.scoreMovePct
  ]
    .map((value) => Number(value))
    .filter(Number.isFinite);
}

function directionalMoveScore(row = {}) {
  const values = moveMetricValues(row).filter((value) => value !== 0);

  if (!values.length) return 0;

  return values.reduce((total, value) => total + Math.sign(value), 0);
}

function getShortCurrentFit(row = {}) {
  const explicitShort = firstFiniteNumber([
    row.shortCurrentFit,
    row.bearCurrentFit,
    row.currentFitShort,
    row.currentFitBear,
    row.shortFitScore,
    row.bearFitScore
  ]);

  if (explicitShort !== null) {
    return {
      score: explicitShort,
      label: currentFitLabel(explicitShort, row.currentFit || 'UNKNOWN'),
      source: 'EXPLICIT_SHORT_OR_BEAR_CURRENT_FIT'
    };
  }

  const explicitLong = firstFiniteNumber([
    row.longCurrentFit,
    row.bullCurrentFit,
    row.bullishCurrentFit,
    row.currentFitLong,
    row.currentFitBull,
    row.longFitScore,
    row.bullFitScore
  ]);

  if (explicitLong !== null) {
    const score = -Math.abs(explicitLong);

    return {
      score,
      label: currentFitLabel(score, row.currentFit || 'UNKNOWN'),
      source: 'INVERTED_LONG_OR_BULL_CURRENT_FIT'
    };
  }

  const rawFit = firstFiniteNumber([
    row.currentFitScore,
    row.fitScore,
    row.marketFitScore,
    row.marketFit,
    row.currentFitNumeric,
    row.scannerScore,
    row.moveScore
  ]);

  if (rawFit === null) {
    const moveScore = directionalMoveScore(row);
    const score = moveScore < 0
      ? Math.abs(moveScore)
      : moveScore > 0
        ? -Math.abs(moveScore)
        : 0;

    return {
      score,
      label: currentFitLabel(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
      source: 'SHORT_MIRRORED_MOVE_SCORE'
    };
  }

  const haystack = marketBiasHaystack(row);
  let score;

  if (
    haystack.includes('BEAR') ||
    haystack.includes('BEARISH') ||
    haystack.includes('SHORT') ||
    haystack.includes('SELL') ||
    haystack.includes('DOWNSIDE')
  ) {
    score = Math.abs(rawFit);
  } else if (
    haystack.includes('BULL') ||
    haystack.includes('BULLISH') ||
    haystack.includes('LONG') ||
    haystack.includes('BUY') ||
    haystack.includes('UPSIDE')
  ) {
    score = -Math.abs(rawFit);
  } else {
    score = -rawFit;
  }

  return {
    score,
    label: currentFitLabel(score, row.currentFit || row.currentFitLabel || 'UNKNOWN'),
    source: 'SHORT_MIRRORED_GENERIC_CURRENT_FIT'
  };
}

function forceShortVirtualRow(row = {}) {
  const inferredTradeSide = inferActionTradeSide(row);
  const identity = normalizeLearningIdentity(row);
  const scannerMetadata = scannerMetadataFrom(row);
  const currentFit = getShortCurrentFit(row);

  const hasLearningMicroId = Boolean(identity.trueMicroFamilyId);

  return {
    ...row,

    ...identity,
    ...scannerMetadata,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    source: row.source || 'VIRTUAL',
    outcomeSource: row.outcomeSource || row.source || 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    microFamilyLearning: true,
    hasAnalyzeMicroFamilyId: hasLearningMicroId,
    scannerFingerprintCanOpenPosition: false,
    scannerFingerprintCanBeLearningFamily: false,
    scannerFingerprintCanTriggerDiscord: false,
    executionFingerprintCanBeLearningFamily: false,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentFit: currentFit.label,
    currentFitLabel: currentFit.label,
    currentFitScore: round(currentFit.score, 4),
    fitScore: round(currentFit.score, 4),
    currentFitSource: currentFit.source,
    shortCurrentFit: round(currentFit.score, 4),
    bearCurrentFit: round(currentFit.score, 4),
    bullishCurrentFit: round(-Math.abs(currentFit.score), 4),
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    selectedMicroFamilyAlert: Boolean(
      row.selectedMicroFamilyAlert &&
        hasLearningMicroId
    ),

    discordAlertEligible: Boolean(
      row.discordAlertEligible &&
        row.selectedMicroFamilyAlert &&
        hasLearningMicroId
    ),

    inferredTradeSide: inferredTradeSide === 'UNKNOWN'
      ? TARGET_TRADE_SIDE
      : inferredTradeSide,

    inferredFromShortOnlyMode: inferredTradeSide === 'UNKNOWN',

    ...isolationFlags()
  };
}

function countActionsByType(actions = []) {
  return actions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function mergeActionCounts(...counts) {
  return counts.reduce((acc, row) => {
    for (const [key, value] of Object.entries(row || {})) {
      acc[key] = safeNumber(acc[key], 0) + safeNumber(value, 0);
    }

    return acc;
  }, {});
}

function unwrapLockResult(lockResult) {
  if (!lockResult) return null;

  if (lockResult.result?.result?.result) return lockResult.result.result.result;
  if (lockResult.result?.result) return lockResult.result.result;
  if (lockResult.result) return lockResult.result;

  return lockResult;
}

function lockSignalText(value = null) {
  const payload = unwrapLockResult(value);

  return [
    value?.reason,
    value?.error,
    value?.message,
    value?.code,
    payload?.reason,
    payload?.error,
    payload?.message,
    payload?.code,
    typeof value === 'string' ? value : '',
    value instanceof Error ? value.message : ''
  ]
    .filter(Boolean)
    .map((part) => String(part).toUpperCase())
    .join('|');
}

function isLockNotAcquiredSignal(value = null) {
  const text = lockSignalText(value);

  return (
    text.includes('LOCK_NOT_ACQUIRED') ||
    text.includes('TRADE_RUN_LOCK_ACTIVE') ||
    text.includes('LOCK_ACTIVE') ||
    text.includes('ALREADY_RUNNING') ||
    text.includes('CONFLICT_LOCK') ||
    text.includes('LOCKED')
  );
}

function isLockNotAcquiredResult(lockResult = null) {
  if (!lockResult || typeof lockResult !== 'object') return false;

  const payload = unwrapLockResult(lockResult);

  return Boolean(
    isLockNotAcquiredSignal(lockResult) ||
    isLockNotAcquiredSignal(payload) ||
    (
      lockResult.ok === false &&
      String(lockResult.reason || '').toUpperCase().includes('LOCK')
    ) ||
    (
      payload?.ok === false &&
      String(payload.reason || payload.error || '').toUpperCase().includes('LOCK')
    )
  );
}

function buildLockSkippedResponse({
  req,
  body = {},
  startedAt,
  lockKey,
  lockTtlSec,
  rawResult = null,
  error = null,
  debug = false
}) {
  const reason = 'TRADE_RUN_LOCK_ACTIVE';

  return {
    ok: true,
    tradeOk: true,
    scannerPreloadOk: null,

    skipped: true,
    skippedNewEntries: true,
    reason,
    skipReason: reason,
    message: 'Trade run overgeslagen: vorige SHORT trade-run is nog actief.',

    statusWas409Before: true,
    httpStatusPolicy: 'LOCK_CONFLICT_RETURNS_200_SKIPPED',

    ...baseFlags(),

    runSource: getRunSource(req, body),

    lock: {
      key: lockKey,
      ttlSec: lockTtlSec,
      active: true,
      reason
    },

    runId: null,
    snapshotId: null,

    entryRows: 0,
    waitRows: 0,
    virtualCreatedRows: 0,
    virtualExitRows: 0,
    shadowExitRows: 0,

    entryRowsList: [],
    waitRowsList: [],
    virtualCreatedRowsList: [],
    virtualExits: [],
    shadowExits: [],
    realExits: [],

    actionCounts: {
      ...baseFlags()
    },

    counts: {
      ...baseFlags(),
      candidates: 0,
      processed: 0,
      entries: 0,
      waits: 0,
      observations: 0,
      virtualExits: 0,
      virtualExitRows: 0,
      shadowExits: 0,
      shadowExitRows: 0,
      realExits: 0,
      realExitRows: 0
    },

    activeMicroFamilyIds: [],
    activeMacroFamilyIds: [],
    selectedMicroFamilyIds: [],
    selectedMacroFamilyIds: [],

    scannerPreloadBeforeTrade: false,
    scannerPreloadOptional: true,
    scannerPreloadDefaultDisabled: true,
    scannerLatestPreserved: true,
    scannerSnapshotPreserved: true,
    scannerHistoryPreserved: true,

    microFamiliesAppendOnly: true,
    analyzePartialOnly: true,
    analyzeFullOverwriteDisabled: true,

    rotationPreserved: true,
    manualSelectionPreserved: true,
    discordSelectionPreserved: true,

    shortKeys: {
      namespace: SHORT_NAMESPACE,
      prefix: SHORT_KEY_PREFIX,
      scanLatest: SHORT_KEYS.scan.latest,
      tradeLock: SHORT_KEYS.trade.lock,
      tradeRunMeta: SHORT_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: SHORT_KEYS.trade.lastProcessedSnapshot,
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY,
      shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
    },

    warnings: [
      'TRADE_RUN_SKIPPED_BECAUSE_LOCK_ACTIVE',
      'NO_ERROR_FOR_CRON',
      'PREVIOUS_RUN_PROBABLY_STILL_ACTIVE_OR_LOCK_TTL_NOT_EXPIRED'
    ],

    rawLockResult: debug ? rawResult || undefined : undefined,
    rawError: debug && error
      ? {
          message: error?.message || String(error),
          reason: error?.reason || null,
          code: error?.code || null
        }
      : undefined,

    durationMs: now() - startedAt,
    completedAt: now(),

    run: debug
      ? {
          ok: true,
          skipped: true,
          reason,
          actions: [],
          virtualExits: [],
          shadowExits: [],
          realExits: [],
          ...baseFlags()
        }
      : undefined,

    result: debug
      ? {
          ok: true,
          skipped: true,
          reason,
          ...baseFlags()
        }
      : undefined
  };
}

function responseOk(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return (
    lockResult?.ok !== false &&
    payload?.ok !== false
  );
}

function responseSkipped(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return Boolean(
    lockResult?.skipped ||
    payload?.skippedNewEntries ||
    payload?.skipped ||
    false
  );
}

function responseReason(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return (
    lockResult?.reason ||
    payload?.reason ||
    payload?.skipReason ||
    null
  );
}

function responseRunId(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return payload?.runId || null;
}

function responseSnapshotId(lockResult) {
  const payload = unwrapLockResult(lockResult);

  return payload?.snapshotId || null;
}

function sanitizeArray(rows = [], limit = MAX_DEBUG_ROWS) {
  const sliced = (Array.isArray(rows) ? rows : [])
    .filter(isShortAction)
    .slice(0, limit);

  return sliced.map(forceShortVirtualRow);
}

function sanitizeParentIds(ids = []) {
  return [...new Set(
    flattenValues(Array.isArray(ids) ? ids : [ids])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter(validLearningId)
      .map((id) => cleanLearningFamilyId(id, {}))
      .filter(Boolean)
      .filter(isSelectableParentTrueMicroId)
  )];
}

function sanitizeTrueMicroIds(ids = []) {
  return [...new Set(
    flattenValues(Array.isArray(ids) ? ids : [ids])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter(validLearningId)
      .map((id) => cleanLearningFamilyId(id, {}))
      .filter(Boolean)
      .filter(isSelectableTrueMicroId)
  )];
}

function selectRawExitRows(payload = {}) {
  if (Array.isArray(payload.virtualExits)) return payload.virtualExits;
  if (Array.isArray(payload.shadowExits)) return payload.shadowExits;
  if (Array.isArray(payload.exits)) return payload.exits;
  if (Array.isArray(payload.closedPositions)) return payload.closedPositions;
  if (Array.isArray(payload.outcomes)) return payload.outcomes;

  return [];
}

function selectRawEntryRows(payload = {}, actions = []) {
  if (Array.isArray(payload.entryRows)) return payload.entryRows;
  if (Array.isArray(payload.entries)) return payload.entries;
  if (Array.isArray(payload.virtualCreatedRows)) return payload.virtualCreatedRows;
  if (Array.isArray(payload.shadowCreatedRows)) return payload.shadowCreatedRows;

  return actions.filter((row) => row?.action === 'VIRTUAL_ENTRY' || row?.action === 'ENTRY');
}

function selectRawWaitRows(payload = {}, actions = []) {
  if (Array.isArray(payload.waitRows)) return payload.waitRows;
  if (Array.isArray(payload.waits)) return payload.waits;

  return actions.filter((row) => row?.action === 'WAIT');
}

function normalizeExitMath(row = {}) {
  const entry = safeNumber(row.entry ?? row.entryPrice, 0);
  const initialSl = safeNumber(row.initialSl ?? row.initialStopLoss ?? row.sl ?? row.stopLoss, 0);
  const exitPrice = safeNumber(row.exitPrice ?? row.currentPrice ?? row.lastPrice ?? row.price, 0);
  const currentPrice = safeNumber(row.currentPrice ?? row.lastPrice ?? row.price ?? exitPrice, 0);
  const tp = safeNumber(row.tp ?? row.takeProfit, 0);

  const riskDistance = entry > 0 && initialSl > 0 && initialSl > entry
    ? initialSl - entry
    : 0;

  const grossR = riskDistance > 0
    ? (entry - exitPrice) / riskDistance
    : safeNumber(row.shortGrossR ?? row.grossR, 0);

  const currentR = riskDistance > 0
    ? (entry - currentPrice) / riskDistance
    : safeNumber(row.shortCurrentR ?? row.currentR, 0);

  const netR = safeNumber(
    row.shortNetR ??
      row.netShortR ??
      row.netR ??
      row.r ??
      row.realizedNetR ??
      row.realizedR ??
      grossR,
    grossR
  );

  return {
    entry: round(entry, 10),
    initialSl: round(initialSl, 10),
    sl: round(row.sl ?? row.stopLoss ?? initialSl, 10),
    tp: round(tp, 10),
    exitPrice: round(exitPrice, 10),
    currentPrice: round(currentPrice, 10),

    validShortGeometry: tp > 0 && entry > 0 && initialSl > 0 && tp < entry && entry < initialSl,
    shortValidGeometry: tp > 0 && entry > 0 && initialSl > 0 && tp < entry && entry < initialSl,
    shortTpHit: exitPrice > 0 && tp > 0 && exitPrice <= tp,
    shortSlHit: exitPrice > 0 && initialSl > 0 && exitPrice >= initialSl,

    grossR: round(grossR, 4),
    shortGrossR: round(grossR, 4),
    currentR: round(currentR, 4),
    shortCurrentR: round(currentR, 4),
    netR: round(netR, 4),
    r: round(netR, 4),
    realizedR: round(row.realizedR ?? netR, 4),
    costR: round(row.costR ?? row.totalCostR, 4),
    avgCostR: round(row.avgCostR ?? row.costR ?? row.totalCostR, 4),

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)'
  };
}

function buildExitAction(exit = {}) {
  return forceShortVirtualRow({
    ...exit,
    ...normalizeExitMath(exit),
    action: 'VIRTUAL_EXIT',
    reason: exit.exitReason || exit.reason || 'VIRTUAL_POSITION_CLOSED',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL'
  });
}

function sanitizeExitRows(rows = [], limit = MAX_DEBUG_ROWS) {
  return sanitizeArray(rows, limit).map((row) => ({
    ...row,
    ...normalizeExitMath(row),
    action: 'VIRTUAL_EXIT',
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    ...isolationFlags()
  }));
}

function countExitActions(rows = []) {
  const shortRows = (Array.isArray(rows) ? rows : []).filter(isShortAction);

  return shortRows.length > 0
    ? { VIRTUAL_EXIT: shortRows.length }
    : {};
}

function buildMergedActionCounts(actions = [], virtualExits = [], payloadActionCounts = {}) {
  const shortActions = (Array.isArray(actions) ? actions : []).filter(isShortAction);

  return mergeActionCounts(
    payloadActionCounts || {},
    countActionsByType(shortActions),
    countExitActions(virtualExits)
  );
}

function sanitizedCount(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter(isShortAction).length;
}

function sanitizeRunPayload(payload, { debug = false } = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const rawActions = Array.isArray(payload.actions) ? payload.actions : [];
  const rawExitRows = selectRawExitRows(payload);

  const actions = debug ? sanitizeArray(rawActions) : [];
  const virtualExits = debug ? sanitizeExitRows(rawExitRows) : [];
  const shadowExits = virtualExits;

  const rawEntryRows = selectRawEntryRows(payload, rawActions);
  const rawWaitRows = selectRawWaitRows(payload, rawActions);

  const entryRowsList = debug ? sanitizeArray(rawEntryRows) : [];
  const waitRowsList = debug ? sanitizeArray(rawWaitRows) : [];

  const ignoredLongActions = rawActions.filter(isLongAction).length;
  const ignoredUnknownSideActions = rawActions.filter((row) => inferActionTradeSide(row) === 'UNKNOWN').length;

  const ignoredLongExitRows = rawExitRows.filter(isLongAction).length;
  const ignoredUnknownSideExitRows = rawExitRows.filter((row) => inferActionTradeSide(row) === 'UNKNOWN').length;

  const scannerFingerprintActions = rawActions.filter((row) => (
    isScannerFingerprintId(row?.microFamilyId) ||
    isScannerFingerprintId(row?.trueMicroFamilyId) ||
    isScannerFingerprintId(row?.id) ||
    isScannerFingerprintId(row?.key)
  )).length;

  const scannerFingerprintExitRows = rawExitRows.filter((row) => (
    isScannerFingerprintId(row?.microFamilyId) ||
    isScannerFingerprintId(row?.trueMicroFamilyId) ||
    isScannerFingerprintId(row?.id) ||
    isScannerFingerprintId(row?.key)
  )).length;

  const executionFingerprintActions = rawActions.filter((row) => (
    isExecutionFingerprintId(row?.microFamilyId) ||
    isExecutionFingerprintId(row?.trueMicroFamilyId) ||
    isExecutionFingerprintId(row?.analyzeMicroFamilyId) ||
    isExecutionFingerprintId(row?.id) ||
    isExecutionFingerprintId(row?.key)
  )).length;

  const executionFingerprintExitRows = rawExitRows.filter((row) => (
    isExecutionFingerprintId(row?.microFamilyId) ||
    isExecutionFingerprintId(row?.trueMicroFamilyId) ||
    isExecutionFingerprintId(row?.analyzeMicroFamilyId) ||
    isExecutionFingerprintId(row?.id) ||
    isExecutionFingerprintId(row?.key)
  )).length;

  const activeMicroFamilyIds = sanitizeTrueMicroIds(
    payload.activeMicroFamilyIds ||
      payload.selectedMicroFamilyIds ||
      payload.trueMicroFamilyIds ||
      payload.microFamilyIds ||
      []
  );

  const selectedMicroFamilyIds = sanitizeTrueMicroIds(
    payload.selectedMicroFamilyIds ||
      payload.activeMicroFamilyIds ||
      payload.trueMicroFamilyIds ||
      payload.microFamilyIds ||
      []
  );

  const activeMacroFamilyIds = sanitizeParentIds(
    payload.activeMacroFamilyIds ||
      payload.selectedMacroFamilyIds ||
      payload.macroFamilyIds ||
      []
  );

  const selectedMacroFamilyIds = sanitizeParentIds(
    payload.selectedMacroFamilyIds ||
      payload.activeMacroFamilyIds ||
      payload.macroFamilyIds ||
      []
  );

  const actionCounts = buildMergedActionCounts(
    rawActions,
    rawExitRows,
    payload.actionCounts
  );

  const entryRows = safeNumber(
    Array.isArray(payload.entryRows)
      ? sanitizedCount(rawEntryRows)
      : payload.entryRows ??
        sanitizedCount(rawEntryRows),
    sanitizedCount(rawEntryRows)
  );

  const waitRows = safeNumber(
    Array.isArray(payload.waitRows)
      ? sanitizedCount(rawWaitRows)
      : payload.waitRows ??
        sanitizedCount(rawWaitRows),
    sanitizedCount(rawWaitRows)
  );

  const virtualCreatedRows = safeNumber(
    Array.isArray(payload.virtualCreatedRows)
      ? sanitizedCount(payload.virtualCreatedRows)
      : payload.virtualCreatedRows ??
        payload.shadowCreatedRows ??
        entryRows,
    entryRows
  );

  const virtualExitRows = safeNumber(
    payload.virtualExitRows ??
      payload.shadowExitRows ??
      sanitizedCount(rawExitRows),
    sanitizedCount(rawExitRows)
  );

  return {
    ...payload,

    ...baseFlags(),

    ok: payload.ok !== false,
    runId: payload.runId || null,

    actions,
    virtualActions: actions,

    entryRows,
    waitRows,
    virtualCreatedRows,

    entryRowsList,
    waitRowsList,
    virtualCreatedRowsList: debug ? entryRowsList : [],

    actionCounts,

    actionsCount: safeNumber(payload.actionsCount, sanitizedCount(rawActions)),
    virtualActionsCount: safeNumber(payload.virtualActionsCount, sanitizedCount(rawActions)),

    virtualSkippedRows: safeNumber(payload.virtualSkippedRows ?? payload.shadowSkippedRows, 0),
    virtualFailedRows: safeNumber(payload.virtualFailedRows ?? payload.shadowFailedRows, 0),

    shadowCreatedRows: safeNumber(payload.shadowCreatedRows ?? virtualCreatedRows, virtualCreatedRows),
    shadowSkippedRows: safeNumber(payload.shadowSkippedRows ?? payload.virtualSkippedRows, 0),
    shadowFailedRows: safeNumber(payload.shadowFailedRows ?? payload.virtualFailedRows, 0),

    realExits: [],
    realExitsCount: 0,
    realExitRows: 0,

    shadowExits,
    shadowExitsCount: virtualExitRows,
    shadowExitRows: virtualExitRows,

    virtualExits,
    virtualExitsCount: virtualExitRows,
    virtualExitRows,

    exits: debug ? virtualExits : [],
    exitsCount: virtualExitRows,

    rawActionsCount: rawActions.length,
    rawExitRowsCount: rawExitRows.length,

    ignoredLongActions,
    ignoredUnknownSideActions,
    ignoredLongExitRows,
    ignoredUnknownSideExitRows,

    longActionsBlockedOrIgnored: ignoredLongActions,
    longExitsBlockedOrIgnored: ignoredLongExitRows,

    scannerFingerprintActions,
    scannerFingerprintExitRows,
    scannerFingerprintsUsedAsLearningFamily: 0,

    executionFingerprintActions,
    executionFingerprintExitRows,
    executionFingerprintsUsedAsLearningFamily: 0,

    activeMicroFamilyIds,
    activeMacroFamilyIds,

    selectedMicroFamilyIds,
    selectedMacroFamilyIds,

    trueMicroFamilyIds: activeMicroFamilyIds,
    activeTrueMicroFamilyIds: activeMicroFamilyIds,
    selectedTrueMicroFamilyIds: selectedMicroFamilyIds,

    activeMicroFamilies: activeMicroFamilyIds.length,
    activeMacroFamilies: activeMacroFamilyIds.length,

    selectedOppositeCandidateCount: 0,

    skippedNewEntries: Boolean(payload.skippedNewEntries),
    skipReason: payload.skipReason || payload.reason || null,
    reason: payload.reason || payload.skipReason || null,

    realTradesOnly: false,
    virtualLearningOnly: true,
    shadowDataMode: 'VIRTUAL_LEARNING_OUTCOMES_COUNTED',

    scannerPreloadBeforeTrade: Boolean(payload.scannerPreloadBeforeTrade),
    scannerSnapshotPreserved: true,
    scannerLatestPreserved: true,
    microFamiliesAppendOnly: true,
    analyzePartialOnly: true,

    shortExitRules: {
      validRiskShape: 'entry > 0 && tp < entry && sl > entry',
      tp: 'currentPrice <= tp',
      sl: 'currentPrice >= sl',
      timeStop: `age >= ${getPositionTimeStopMin()} minutes`,
      grossR: '(entry - exitPrice) / (initialSl - entry)',
      currentR: '(entry - currentPrice) / (initialSl - entry)',
      outcomeSource: 'VIRTUAL'
    },

    ...isolationFlags()
  };
}

function sanitizeLockResult(lockResult, payload = null) {
  if (!lockResult || typeof lockResult !== 'object') {
    return lockResult;
  }

  const sanitizedPayload = payload || sanitizeRunPayload(unwrapLockResult(lockResult));

  return {
    ok: lockResult.ok !== false && sanitizedPayload?.ok !== false,
    skipped: Boolean(lockResult.skipped || sanitizedPayload?.skipped || sanitizedPayload?.skippedNewEntries),
    reason: lockResult.reason || sanitizedPayload?.reason || sanitizedPayload?.skipReason || null,

    ...baseFlags(),

    result: sanitizedPayload
  };
}

function responseActionCountsFromPayload(payload = {}) {
  return {
    ...baseFlags(),
    ...(payload?.actionCounts || {})
  };
}

function responseCountsFromPayload(payload = {}) {
  const actionsCount = safeNumber(payload.actionsCount, 0);
  const virtualExitRows = safeNumber(payload.virtualExitRows, 0);

  return {
    ...baseFlags(),

    candidates: safeNumber(payload.candidates || payload.candidatesCount, 0),
    shortCandidateCount: safeNumber(
      payload.shortCandidateCount ||
        payload.targetCandidateCount ||
        payload.shortCandidatesCount,
      0
    ),
    nonShortCandidateCount: safeNumber(
      payload.nonShortCandidateCount ||
        payload.nonTargetCandidateCount,
      0
    ),

    processed: safeNumber(payload.processed, 0),
    earlyActions: safeNumber(payload.earlyActions, 0),

    liveRows: safeNumber(payload.liveRows, 0),
    analyzeInputRows: safeNumber(payload.analyzeInputRows, 0),
    actualLiveRows: safeNumber(payload.actualLiveRows, 0),

    observationOnlyRows: safeNumber(payload.observationOnlyRows, 0),
    learningOnlyRows: safeNumber(payload.learningOnlyRows, 0),

    riskValidRows: safeNumber(payload.riskValidRows || payload.analyzedRiskValidRows, 0),
    riskInvalidRows: safeNumber(payload.riskInvalidRows, 0),

    analyzedRowsRaw: safeNumber(payload.analyzedRowsRaw, 0),
    analyzedRows: safeNumber(payload.analyzedRows, 0),
    analyzedActualRows: safeNumber(payload.analyzedActualRows, 0),
    analyzedRiskValidRows: safeNumber(payload.analyzedRiskValidRows, 0),

    entryRows: safeNumber(payload.entryRows, 0),
    waitRows: safeNumber(payload.waitRows, 0),

    virtualCreatedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualOpenedRows: safeNumber(payload.virtualCreatedRows, 0),
    virtualSkippedRows: safeNumber(payload.virtualSkippedRows, 0),
    virtualFailedRows: safeNumber(payload.virtualFailedRows, 0),

    shadowCreatedRows: safeNumber(payload.shadowCreatedRows, 0),
    shadowSkippedRows: safeNumber(payload.shadowSkippedRows, 0),
    shadowFailedRows: safeNumber(payload.shadowFailedRows, 0),

    actions: actionsCount,
    shortActions: actionsCount,

    entries: safeNumber(payload.entryRows, 0),
    waits: safeNumber(payload.waitRows, 0),
    observations: safeNumber(payload.observationOnlyRows, 0),

    realExits: 0,
    realExitRows: 0,

    shadowExits: virtualExitRows,
    shadowExitRows: virtualExitRows,

    virtualExits: virtualExitRows,
    virtualExitRows,

    activeMicroFamilies: safeNumber(payload.activeMicroFamilies, 0),
    activeMacroFamilies: safeNumber(payload.activeMacroFamilies, 0),

    selectedTargetCandidateCount: safeNumber(payload.selectedTargetCandidateCount, 0),
    selectedOppositeCandidateCount: 0,

    discordEligibleEntries: safeNumber(
      payload.discordAlertEligibleRows ||
        payload.discordEligibleEntries,
      0
    ),

    discordSkippedNotSelected: safeNumber(
      payload.discordAlertsSkippedNoSelectedMicro ||
        payload.discordSkippedNotSelected,
      0
    ),

    ignoredLongActions: safeNumber(payload.ignoredLongActions, 0),
    ignoredUnknownSideActions: safeNumber(payload.ignoredUnknownSideActions, 0),
    ignoredLongExitRows: safeNumber(payload.ignoredLongExitRows, 0),
    ignoredUnknownSideExitRows: safeNumber(payload.ignoredUnknownSideExitRows, 0),

    longActionsBlockedOrIgnored: safeNumber(payload.longActionsBlockedOrIgnored, 0),
    longExitsBlockedOrIgnored: safeNumber(payload.longExitsBlockedOrIgnored, 0),

    scannerFingerprintActions: safeNumber(payload.scannerFingerprintActions, 0),
    scannerFingerprintExitRows: safeNumber(payload.scannerFingerprintExitRows, 0),
    scannerFingerprintsUsedAsLearningFamily: 0,

    executionFingerprintActions: safeNumber(payload.executionFingerprintActions, 0),
    executionFingerprintExitRows: safeNumber(payload.executionFingerprintExitRows, 0),
    executionFingerprintsUsedAsLearningFamily: 0,

    scannerPreloadBeforeTrade: Boolean(payload.scannerPreloadBeforeTrade),
    scannerSnapshotPreserved: true,
    microFamiliesAppendOnly: true
  };
}

function resolveStatus(error) {
  if (Number.isFinite(error?.statusCode)) return error.statusCode;

  return 500;
}

function buildRunOptions(req, body = {}) {
  const forceProcessSnapshot = shouldForceProcessSnapshot(req, body);
  const monitorOnly = shouldMonitorOnly(req, body);

  return {
    force: forceProcessSnapshot,
    forceProcessSnapshot,
    monitorOnly,

    monitorOpenPositionsFirst: true,
    monitorOpenPositions: true,
    processOpenPositions: true,
    closeVirtualPositions: true,
    processScannerSnapshot: !monitorOnly,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true,

    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,
    noRealOrders: true,

    learningOnly: true,
    microFamilyLearning: true,

    observationFirst: true,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintOnlyMetadata: true,
    scannerFingerprintsHiddenFromLearning: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintOnlyMetadata: true,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    symbolExcludedFromFamilyId: true,
    selectionGranularity: 'EXACT_75_CHILD',

    allowLearningWithoutActiveRotation: true,
    ignoreMaxOpenPositionsForLearning: true,
    ignoreGlobalMaxOpenPositions: true,
    ignoreRiskCapsForLearning: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,

    positionTimeStopMin: getPositionTimeStopMin(),

    shortRiskShape: {
      entryPositive: true,
      tpBelowEntry: true,
      slAboveEntry: true,
      expression: 'tp < entry < sl'
    },

    shortExitRules: {
      validRiskShape: 'entry > 0 && tp < entry && sl > entry',
      tp: 'currentPrice <= tp',
      sl: 'currentPrice >= sl',
      timeStop: `age >= ${getPositionTimeStopMin()} minutes`,
      tpSlIndependentFromTimeStop: true,
      grossR: '(entry - exitPrice) / (initialSl - entry)',
      currentR: '(entry - currentPrice) / (initialSl - entry)',
      outcomeSource: 'VIRTUAL'
    },

    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForManualSelection: true,
    discordOnlyForExactTrueMicroMatch: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionRequires75ChildTrueMicroFamilyId: true,
    macroMatchDoesNotTriggerDiscord: true,
    parentMacroMatchDoesNotTriggerDiscord: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    runScope: RUN_SCOPE,
    writeScope: WRITE_SCOPE,
    readScope: READ_SCOPE,

    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekKey: PERSISTENT_LEARNING_KEY,

    keys: {
      scannerLatest: SHORT_KEYS.scan.latest,
      tradeLock: SHORT_KEYS.trade.lock,
      tradeRunMeta: SHORT_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: SHORT_KEYS.trade.lastProcessedSnapshot,
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY,
      shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
    },

    scannerPreloadBeforeTrade: false,
    marketWeatherPreloadBeforeTrade: false,

    scannerRunAllowed: false,
    scannerRunDisabledInsideTradeSystem: true,
    preventScannerRun: true,
    doNotRunScanner: true,
    noInternalScannerRun: true,

    scannerLatestReadOnly: true,
    readScannerLatestOnly: true,

    allowTradeWrite: true,
    allowAnalyzePartialWrite: true,
    allowScannerWrite: false,
    allowRotationWrite: false,
    allowDiscordSelectionWrite: false,

    analyzePartialOnly: true,
    microFamiliesAppendOnly: true,
    analyzeFullOverwriteDisabled: true,
    microFamiliesAntiWipe: true,

    preserveRotation: true,
    preserveManualSelection: true,
    preserveDiscordSelection: true,

    adminPageIsolation: true,
    doesNotOverwriteOtherAdminPages: true
  };
}

function buildScannerPreloadOptions(req, body = {}) {
  return {
    force: true,
    forced: true,

    source: 'TRADE_RUN_SCANNER_PRELOAD_EXPLICIT',
    trigger: 'api/trade/run.js',
    runSource: getRunSource(req, body),

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    disableLong: true,

    keys: {
      scanLatest: SHORT_KEYS.scan.latest,
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY,
      shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
    },

    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,

    scannerPreloadBeforeTrade: true,
    marketWeatherPreloadBeforeTrade: true,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    learningRemainsBroad: true
  };
}

function summarizeScannerPreload(scannerResult = null) {
  if (!scannerResult || typeof scannerResult !== 'object') {
    return {
      ok: false,
      reason: 'NO_SCANNER_RESULT'
    };
  }

  return {
    ok: scannerResult.ok !== false,
    snapshotId: scannerResult.snapshotId || null,
    createdAt: scannerResult.createdAt || null,
    completedAt: scannerResult.completedAt || null,
    durationMs: scannerResult.durationMs || null,

    rawCount: safeNumber(scannerResult.rawCount, 0),
    filteredUniverse: safeNumber(scannerResult.filteredUniverse, 0),

    candidatesCount: safeNumber(scannerResult.candidatesCount, 0),
    scannerGateCandidatesCount: safeNumber(scannerResult.scannerGateCandidatesCount, 0),
    analyzeOnlyCandidatesCount: safeNumber(scannerResult.analyzeOnlyCandidatesCount, 0),

    marketUniverseCount: safeNumber(scannerResult.marketUniverseCount, 0),
    marketUniverseSaved: Boolean(scannerResult.marketUniverseSaved),
    marketUniverseKeys: Array.isArray(scannerResult.marketUniverseKeys)
      ? scannerResult.marketUniverseKeys
      : [],

    marketWeatherCount: safeNumber(scannerResult.marketWeatherCount, scannerResult.marketUniverseCount || 0),
    marketWeatherSaved: Boolean(scannerResult.marketWeatherSaved),
    marketWeatherKeys: Array.isArray(scannerResult.marketWeatherKeys)
      ? scannerResult.marketWeatherKeys
      : [],

    btcState: scannerResult.btcState || null,
    regime: scannerResult.regime || null,

    topSymbols: Array.isArray(scannerResult.topSymbols)
      ? scannerResult.topSymbols.slice(0, 20)
      : [],

    scannerPreloadBeforeTrade: true
  };
}

async function mirrorOneMarketKey({
  volatileRedis,
  durableRedis,
  key
}) {
  const payload = await getJson(volatileRedis, key, null).catch(() => null);

  if (!payload) {
    return {
      key,
      ok: false,
      reason: 'SOURCE_KEY_EMPTY'
    };
  }

  await setJson(
    durableRedis,
    key,
    {
      ...payload,
      mirroredFromVolatile: true,
      mirroredToDurable: true,
      mirroredAt: now(),
      mirrorSourceKey: key,
      scannerPreloadBeforeTrade: true,
      marketWeatherPreloadBeforeTrade: true,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
      currentFitSoftOnly: true,
      currentFitBlocksLearning: false,
      learningRemainsBroad: true,
      ...baseFlags()
    }
  );

  return {
    key,
    ok: true
  };
}

async function mirrorMarketCacheFromVolatileToDurable({
  volatileRedis,
  durableRedis
}) {
  const keys = [
    MARKET_UNIVERSE_KEY,
    SHORT_MARKET_UNIVERSE_KEY,
    MARKET_WEATHER_KEY,
    SHORT_MARKET_WEATHER_KEY
  ];

  const uniqueKeys = [...new Set(keys)];
  const results = [];

  for (const key of uniqueKeys) {
    results.push(await mirrorOneMarketKey({
      volatileRedis,
      durableRedis,
      key
    }));
  }

  const okKeys = results
    .filter((row) => row.ok)
    .map((row) => row.key);

  return {
    ok: okKeys.length > 0,
    okKeys,
    results,
    marketWeatherMirrored: okKeys.includes(MARKET_WEATHER_KEY) || okKeys.includes(SHORT_MARKET_WEATHER_KEY),
    marketUniverseMirrored: okKeys.includes(MARKET_UNIVERSE_KEY) || okKeys.includes(SHORT_MARKET_UNIVERSE_KEY)
  };
}

async function runScannerPreload({
  req,
  body,
  volatileRedis,
  durableRedis
}) {
  const startedAt = now();

  try {
    const scannerResult = await runScanner(buildScannerPreloadOptions(req, body));

    const mirror = await mirrorMarketCacheFromVolatileToDurable({
      volatileRedis,
      durableRedis
    });

    return {
      ok: scannerResult?.ok !== false,
      skipped: false,
      scanner: summarizeScannerPreload(scannerResult),
      mirror,
      durationMs: now() - startedAt,
      scannerPreloadBeforeTrade: true
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error?.message || String(error),
      durationMs: now() - startedAt,
      scannerPreloadBeforeTrade: true
    };
  }
}

function skippedScannerPreload() {
  return {
    ok: true,
    skipped: true,
    reason: 'SCANNER_PRELOAD_DISABLED_FOR_FAST_TRADE_RUN',
    scannerPreloadBeforeTrade: false,
    scannerPreloadOptional: true,
    scannerPreloadDefaultDisabled: true,
    mirror: {
      ok: false,
      skipped: true,
      marketWeatherMirrored: false,
      marketUniverseMirrored: false
    }
  };
}

function compactRunMetaPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

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
    ...rest
  } = payload;

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

    compactedForVercelRuntime: true,
    detailsAvailableWithDebugParam: true
  };
}

async function persistShortRunMeta(redis, payload = {}, result = {}, scannerPreload = null) {
  if (!payload || typeof payload !== 'object') {
    return {
      persistedShortRunMeta: false,
      persistedShortLastProcessedSnapshot: false,
      reason: 'NO_PAYLOAD'
    };
  }

  const compactPayload = compactRunMetaPayload(payload);

  const runMeta = {
    ...compactPayload,

    ...baseFlags(),

    scannerPreload,

    persistedAt: now(),
    persistedBy: 'api/trade/run.js',
    persistedNamespace: SHORT_NAMESPACE,

    shortKeys: {
      namespace: SHORT_NAMESPACE,
      prefix: SHORT_KEY_PREFIX,
      tradeRunMeta: SHORT_KEYS.trade.runMeta,
      tradeLastProcessedSnapshot: SHORT_KEYS.trade.lastProcessedSnapshot,
      scannerLatest: SHORT_KEYS.scan.latest,
      marketUniverseLatest: MARKET_UNIVERSE_KEY,
      shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
      marketWeatherLatest: MARKET_WEATHER_KEY,
      shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
    },

    rawResultOk: result?.ok !== false
  };

  await setJson(redis, SHORT_KEYS.trade.runMeta, runMeta).catch(() => null);

  if (payload.snapshotId) {
    await setJson(
      redis,
      SHORT_KEYS.trade.lastProcessedSnapshot,
      {
        snapshotId: payload.snapshotId,
        runId: payload.runId || null,
        processedAt: now(),
        scannerPreload,
        ...baseFlags()
      }
    ).catch(() => null);
  }

  return {
    persistedShortRunMeta: true,
    persistedShortLastProcessedSnapshot: Boolean(payload.snapshotId),
    tradeRunMeta: SHORT_KEYS.trade.runMeta,
    tradeLastProcessedSnapshot: SHORT_KEYS.trade.lastProcessedSnapshot,
    compactedForVercelRuntime: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Trade-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Exchange-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-No-Real-Orders', 'true');
  res.setHeader('X-Scanner-Fingerprint-Role', 'METADATA_ONLY');
  res.setHeader('X-Execution-Fingerprint-Role', 'METADATA_ONLY');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
  res.setHeader('X-Exact-True-Micro-Match', 'true');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Parent-Learning-Granularity', PARENT_LEARNING_GRANULARITY);
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Run-Scope', RUN_SCOPE);
  res.setHeader('X-Write-Scope', WRITE_SCOPE);
  res.setHeader('X-Scanner-Write', 'false');
  res.setHeader('X-Scanner-Run-Allowed', 'explicit-only');
  res.setHeader('X-Scanner-Preload-Before-Trade', 'optional');
  res.setHeader('X-Scanner-Preload-Default', 'disabled');
  res.setHeader('X-MarketWeather-Preload-Before-Trade', 'optional');
  res.setHeader('X-MicroFamilies-Append-Only', 'true');
  res.setHeader('X-Admin-Page-Isolation', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');

  const startedAt = now();
  let body = {};

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    body = await readBody(req);

    const debug = shouldDebug(req, body);
    const scannerPreloadEnabled = shouldRunScannerPreload(req, body);
    const runOptions = buildRunOptions(req, body);

    const durableRedis = getDurableRedis();

    const lockKey = SHORT_KEYS.trade.lock;
    const lockTtlSec = getLockTtlSec();

    let scannerPreload = null;

    const rawResult = await withRedisLock(
      durableRedis,
      lockKey,
      lockTtlSec,
      async () => {
        if (scannerPreloadEnabled && !runOptions.monitorOnly) {
          const volatileRedis = getVolatileRedis();

          scannerPreload = await runScannerPreload({
            req,
            body,
            volatileRedis,
            durableRedis
          });
        } else {
          scannerPreload = skippedScannerPreload();
        }

        return runTradeSystem({
          ...runOptions,
          scannerPreloadBeforeTrade: scannerPreloadEnabled,
          marketWeatherPreloadBeforeTrade: scannerPreloadEnabled,
          scannerPreloadOk: scannerPreload?.ok !== false,
          marketWeatherMirroredToDurable: scannerPreload?.mirror?.marketWeatherMirrored === true,
          marketUniverseMirroredToDurable: scannerPreload?.mirror?.marketUniverseMirrored === true
        });
      }
    );

    if (isLockNotAcquiredResult(rawResult)) {
      return res.status(200).json(buildLockSkippedResponse({
        req,
        body,
        startedAt,
        lockKey,
        lockTtlSec,
        rawResult,
        debug
      }));
    }

    const payload = sanitizeRunPayload(unwrapLockResult(rawResult), { debug });
    const result = sanitizeLockResult(rawResult, payload);

    const persistence = await persistShortRunMeta(
      durableRedis,
      payload,
      result,
      scannerPreload
    );

    const actionCounts = responseActionCountsFromPayload(payload);
    const counts = responseCountsFromPayload(payload);

    const scannerOk = scannerPreload?.ok !== false;
    const scannerSkipped = scannerPreload?.skipped === true;
    const tradeOk = responseOk(rawResult);

    return res.status(200).json({
      ok: tradeOk && scannerOk,
      tradeOk,
      scannerPreloadOk: scannerOk,
      scannerPreloadSkipped: scannerSkipped,
      scannerPreloadEnabled,

      skipped: responseSkipped(rawResult),
      reason: !scannerOk
        ? 'SCANNER_PRELOAD_FAILED'
        : responseReason(rawResult),
      skipReason: payload?.skipReason || responseReason(rawResult),

      ...baseFlags(),

      runSource: getRunSource(req, body),

      force: runOptions.force,
      forceProcessSnapshot: runOptions.forceProcessSnapshot,
      monitorOnly: runOptions.monitorOnly,
      monitorOpenPositionsFirst: runOptions.monitorOpenPositionsFirst,
      monitorOpenPositions: runOptions.monitorOpenPositions,
      processScannerSnapshot: runOptions.processScannerSnapshot,

      scannerPreload: debug
        ? scannerPreload
        : {
            ok: scannerPreload?.ok !== false,
            skipped: scannerSkipped,
            reason: scannerPreload?.reason || null,
            durationMs: scannerPreload?.durationMs || null,
            scanner: scannerPreload?.scanner || null,
            mirror: scannerPreload?.mirror
              ? {
                  ok: scannerPreload.mirror.ok,
                  marketWeatherMirrored: scannerPreload.mirror.marketWeatherMirrored,
                  marketUniverseMirrored: scannerPreload.mirror.marketUniverseMirrored
                }
              : null
          },

      marketWeatherAvailableAfterRun: scannerPreload?.mirror?.marketWeatherMirrored === true,
      marketUniverseAvailableAfterRun: scannerPreload?.mirror?.marketUniverseMirrored === true,

      runId: responseRunId(rawResult),
      snapshotId: responseSnapshotId(rawResult),

      entryRows: safeNumber(payload?.entryRows, 0),
      waitRows: safeNumber(payload?.waitRows, 0),
      virtualCreatedRows: safeNumber(payload?.virtualCreatedRows, 0),

      entryRowsList: debug && Array.isArray(payload?.entryRowsList)
        ? payload.entryRowsList
        : [],

      waitRowsList: debug && Array.isArray(payload?.waitRowsList)
        ? payload.waitRowsList
        : [],

      virtualCreatedRowsList: debug && Array.isArray(payload?.virtualCreatedRowsList)
        ? payload.virtualCreatedRowsList
        : [],

      virtualExitRows: safeNumber(payload?.virtualExitRows, 0),
      shadowExitRows: safeNumber(payload?.shadowExitRows, 0),

      virtualExits: debug && Array.isArray(payload?.virtualExits)
        ? payload.virtualExits
        : [],

      shadowExits: debug && Array.isArray(payload?.shadowExits)
        ? payload.shadowExits
        : [],

      realExits: [],

      actionCounts,
      counts,

      activeRotationId: payload?.activeRotationId || null,
      selectedRotationId: payload?.selectedRotationId || payload?.activeRotationId || null,

      activeMicroFamilies: safeNumber(payload?.activeMicroFamilies, 0),
      activeMacroFamilies: safeNumber(payload?.activeMacroFamilies, 0),

      activeMicroFamilyIds: Array.isArray(payload?.activeMicroFamilyIds)
        ? payload.activeMicroFamilyIds
        : [],

      activeMacroFamilyIds: Array.isArray(payload?.activeMacroFamilyIds)
        ? payload.activeMacroFamilyIds
        : [],

      selectedMicroFamilyIds: Array.isArray(payload?.selectedMicroFamilyIds)
        ? payload.selectedMicroFamilyIds
        : [],

      selectedMacroFamilyIds: Array.isArray(payload?.selectedMacroFamilyIds)
        ? payload.selectedMacroFamilyIds
        : [],

      selectedSnapshotSource: payload?.selectedSnapshotSource || null,
      selectedSnapshotReason: payload?.selectedSnapshotReason || null,
      selectedTargetCandidateCount: safeNumber(payload?.selectedTargetCandidateCount, 0),
      selectedOppositeCandidateCount: 0,

      scannerPreloadBeforeTrade: scannerPreloadEnabled,
      scannerLatestPreserved: true,
      scannerSnapshotPreserved: true,
      scannerHistoryPreserved: true,
      scannerRunBlockedInsideTradeRun: true,
      scannerRunDisabledInsideTradeSystem: true,

      microFamiliesAppendOnly: true,
      analyzePartialOnly: true,
      analyzeFullOverwriteDisabled: true,

      rotationPreserved: true,
      manualSelectionPreserved: true,
      discordSelectionPreserved: true,

      shortPersistence: persistence,

      shortKeys: {
        namespace: SHORT_NAMESPACE,
        prefix: SHORT_KEY_PREFIX,
        scanLatest: SHORT_KEYS.scan.latest,
        tradeLock: SHORT_KEYS.trade.lock,
        tradeRunMeta: SHORT_KEYS.trade.runMeta,
        tradeLastProcessedSnapshot: SHORT_KEYS.trade.lastProcessedSnapshot,
        marketUniverseLatest: MARKET_UNIVERSE_KEY,
        shortMarketUniverseLatest: SHORT_MARKET_UNIVERSE_KEY,
        marketWeatherLatest: MARKET_WEATHER_KEY,
        shortMarketWeatherLatest: SHORT_MARKET_WEATHER_KEY
      },

      warnings: [
        !scannerPreloadEnabled
          ? 'SCANNER_PRELOAD_DISABLED_FAST_TRADE_RUN_USE_API_SCANNER_RUN_SEPARATELY_OR_QUERY_SCANNERPRELOAD_TRUE'
          : null,
        scannerPreload?.ok === false
          ? `SCANNER_PRELOAD_FAILED:${scannerPreload.error || 'UNKNOWN'}`
          : null,
        scannerPreloadEnabled && scannerPreload?.mirror?.marketWeatherMirrored !== true
          ? 'MARKET_WEATHER_NOT_MIRRORED_TO_DURABLE'
          : null,
        payload?.ignoredLongActions > 0
          ? `LONG_ACTIONS_IGNORED:${payload.ignoredLongActions}`
          : null,
        payload?.ignoredLongExitRows > 0
          ? `LONG_EXIT_ROWS_IGNORED:${payload.ignoredLongExitRows}`
          : null,
        payload?.ignoredUnknownSideActions > 0
          ? `UNKNOWN_SIDE_ACTIONS_FORCED_SHORT:${payload.ignoredUnknownSideActions}`
          : null,
        payload?.ignoredUnknownSideExitRows > 0
          ? `UNKNOWN_SIDE_EXIT_ROWS_FORCED_SHORT:${payload.ignoredUnknownSideExitRows}`
          : null,
        payload?.scannerFingerprintActions > 0
          ? `SCANNER_FINGERPRINT_ACTIONS_METADATA_ONLY:${payload.scannerFingerprintActions}`
          : null,
        payload?.scannerFingerprintExitRows > 0
          ? `SCANNER_FINGERPRINT_EXITS_METADATA_ONLY:${payload.scannerFingerprintExitRows}`
          : null,
        payload?.executionFingerprintActions > 0
          ? `EXECUTION_FINGERPRINT_ACTIONS_METADATA_ONLY:${payload.executionFingerprintActions}`
          : null,
        payload?.executionFingerprintExitRows > 0
          ? `EXECUTION_FINGERPRINT_EXITS_METADATA_ONLY:${payload.executionFingerprintExitRows}`
          : null,
        (payload?.activeMicroFamilyIds || []).some((id) => !isSelectableTrueMicroId(id))
          ? 'NON_75_CHILD_ACTIVE_MICRO_IDS_REMOVED'
          : null
      ].filter(Boolean),

      durationMs: now() - startedAt,

      debug,
      run: debug ? payload : undefined,
      result: debug ? result : undefined
    });
  } catch (error) {
    const lockKey = SHORT_KEYS.trade.lock;
    const lockTtlSec = getLockTtlSec();
    const debug = shouldDebug(req, body);

    if (isLockNotAcquiredSignal(error)) {
      return res.status(200).json(buildLockSkippedResponse({
        req,
        body,
        startedAt,
        lockKey,
        lockTtlSec,
        error,
        debug
      }));
    }

    return res.status(resolveStatus(error)).json({
      ok: false,

      ...baseFlags(),

      error: error?.message || String(error),
      durationMs: now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}