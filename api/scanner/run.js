// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getVolatileRedis,
  getDurableRedis,
  setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';
import { sideToTradeSide } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1';
const MARKET_WEATHER_CAPTURE_VERSION = 'SHORT_SCANNER_MARKET_WEATHER_CAPTURE_V2_CONFIRMED_ENTRY_KEY';
const MARKET_WEATHER_SELECTOR_VERSION = 'SHORT_CURRENT_MARKET_PLAYBOOK_SELECTOR_V1_OBSERVE';
const MARKET_WEATHER_FDR_VERSION = 'SHORT_MARKET_WEATHER_PLAYBOOK_FDR_FINAL_SLOTS_V1_OBSERVE';

const DEFAULT_LOCK_TTL_SEC = 540;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

// ===== NIEUW: Snapshot TTL (15 minuten) =====
const SNAPSHOT_TTL_SEC = 900;

const SHORT_SETUP_TYPES = [
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
];

const SHORT_REGIME_BUCKETS = [
  'TREND',
  'CHOP',
  'SQUEEZE'
];

const SHORT_CONFIRMATION_PROFILES = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

function now() {
  return Date.now();
}

function namespacedShortKey(key, fallback = null) {
  let raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) raw = raw.slice('LONG:'.length);

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function callMaybe(fn, arg, fallback) {
  try {
    if (typeof fn === 'function') return fn(arg);
  } catch {
    return fallback;
  }

  return fallback;
}

const SHORT_KEYS = {
  scan: {
    lock: namespacedShortKey(
      KEYS.short?.scan?.lock ||
        KEYS.scan?.shortLock ||
        KEYS.scan?.lock,
      'SCAN:LOCK'
    ),

    latest: namespacedShortKey(
      KEYS.short?.scan?.latest ||
        KEYS.scan?.shortLatest ||
        KEYS.scan?.latest,
      'SCAN:LATEST'
    ),

    snapshotPattern: namespacedShortKey(
      callMaybe(KEYS.short?.scan?.snapshot, '*', null) ||
        callMaybe(KEYS.scan?.shortSnapshot, '*', null) ||
        callMaybe(KEYS.scan?.snapshot, '*', null),
      'SCAN:SNAPSHOT:*'
    ),

    snapshot: (snapshotId) => namespacedShortKey(
      callMaybe(KEYS.short?.scan?.snapshot, snapshotId, null) ||
        callMaybe(KEYS.scan?.shortSnapshot, snapshotId, null) ||
        callMaybe(KEYS.scan?.snapshot, snapshotId, null),
      `SCAN:SNAPSHOT:${snapshotId}`
    )
  }
};

function baseFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    scannerOnly: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotOpenPositions: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    scannerHashesMetadataOnly: true,
    coinNameMetadataOnly: true,

    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    outcomeSource: 'VIRTUAL',

    observationFirst: true,
    observationFirstAnalyze: true,
    netOutcomesOnly: true,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

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

    marketWeatherCaptureEnabled: true,
    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    scannerCapturesConfirmedWeatherAtSnapshot: true,
    scannerCandidatesReceiveEntryMarketWeatherKey: true,
    unknownWeatherDoesNotOverrideKnownWeather: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsNotLearningIdentitySource: true,
    scannerIdentitySource: 'SCANNER_METADATA_ONLY',
    symbolExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    selectableMicroFamilyCount: 75,
    parentMicroFamilyCount: 15,
    taxonomySetups: SHORT_SETUP_TYPES,
    taxonomyRegimes: SHORT_REGIME_BUCKETS,
    taxonomyConfirmationProfiles: SHORT_CONFIRMATION_PROFILES,

    parentTrueMicroFamilyExample: 'MICRO_SHORT_BREAKOUT_TREND',
    selectableTrueMicroFamilyExample: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionRequires75ChildTrueMicroFamilyId: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordMatchSource: 'MANUAL_SELECTED_75_CHILD_TRUE_MICRO_FAMILY_ID',

    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    scannerTradeRedisBridgeEnabled: true,
    scannerWritesVolatileRedis: true,
    scannerWritesDurableRedis: true,
    tradeReadsSameScannerLatest: true,
    scanLatestSharedKey: SHORT_KEYS.scan.latest
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

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (!hasValue(value)) return fallback;

  return value;
}

function firstKnownValue(...values) {
  for (const value of values) {
    if (!hasValue(value)) continue;

    const raw = String(Array.isArray(value) ? value[0] : value).trim();

    if (!raw) continue;
    if (upper(raw) === 'UNKNOWN') continue;
    if (upper(raw) === 'UNKNOWN|UNKNOWN') continue;
    if (upper(raw).endsWith('|UNKNOWN')) continue;
    if (upper(raw).startsWith('UNKNOWN|')) continue;

    return raw;
  }

  return null;
}

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}

function getLockTtlSec() {
  const ttl = Number(
    CONFIG.short?.scanner?.lockTtlSec ||
      CONFIG.scanner?.shortLockTtlSec ||
      CONFIG.scanner?.lockTtlSec ||
      DEFAULT_LOCK_TTL_SEC
  );

  if (!Number.isFinite(ttl)) return DEFAULT_LOCK_TTL_SEC;
  if (ttl <= 0) return DEFAULT_LOCK_TTL_SEC;

  return Math.floor(ttl);
}

function shouldForce(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(body.force) ||
    isTrue(body.forced)
  );
}

function sourceLabel(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forced)
  );

  return manual
    ? 'ADMIN_MANUAL_SHORT_SCANNER_RUN'
    : 'CRON_OR_API_SHORT_SCANNER_RUN';
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
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

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return n;
}

function round(value, decimals = 4) {
  return Number(safeNumber(value, 0).toFixed(decimals));
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

  return 'UNKNOWN';
}

function normalizeMarketWeatherRegimeFallback(value) {
  const raw = upper(value);

  if (raw.includes('SQUEEZE')) return 'SQUEEZE';
  if (raw.includes('COMPRESSION')) return 'SQUEEZE';
  if (raw.includes('COMPRESS')) return 'SQUEEZE';
  if (raw.includes('COIL')) return 'SQUEEZE';
  if (raw.includes('LOW_VOL')) return 'SQUEEZE';

  if (raw.includes('CHOP')) return 'CHOP';
  if (raw.includes('RANGE')) return 'CHOP';
  if (raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('MIXED')) return 'CHOP';

  if (raw.includes('TREND')) return 'TREND';
  if (raw.includes('FLOW')) return 'TREND';
  if (raw.includes('MOMENTUM')) return 'TREND';
  if (raw.includes('DIRECTION')) return 'TREND';

  return raw || 'UNKNOWN';
}

function normalizeMarketWeatherTrendSideFallback(value) {
  const raw = upper(value);

  if (raw.includes('BEAR')) return 'BEARISH';
  if (raw.includes('SHORT')) return 'BEARISH';
  if (raw.includes('SELL')) return 'BEARISH';
  if (raw.includes('DOWN')) return 'BEARISH';
  if (raw.includes('DOWNSIDE')) return 'BEARISH';
  if (raw.includes('RISK_OFF')) return 'BEARISH';

  if (raw.includes('BULL')) return 'BULLISH';
  if (raw.includes('LONG')) return 'BULLISH';
  if (raw.includes('BUY')) return 'BULLISH';
  if (raw.includes('UP')) return 'BULLISH';
  if (raw.includes('UPSIDE')) return 'BULLISH';
  if (raw.includes('RISK_ON')) return 'BULLISH';

  if (raw.includes('NEUTRAL')) return 'NEUTRAL';
  if (raw.includes('MIXED')) return 'NEUTRAL';
  if (raw.includes('FLAT')) return 'NEUTRAL';

  return raw || 'UNKNOWN';
}

function buildMarketWeatherKeyFallback(input = {}) {
  if (typeof input === 'string') {
    const raw = upper(input);

    if (!raw.includes('|')) return 'UNKNOWN|UNKNOWN';

    const [regimeRaw, trendRaw] = raw.split('|');

    return `${normalizeMarketWeatherRegimeFallback(regimeRaw)}|${normalizeMarketWeatherTrendSideFallback(trendRaw)}`;
  }

  const directKey = firstKnownValue(
    input.entryMarketWeatherKey,
    input.confirmedMarketWeatherKey,
    input.currentMarketWeatherKey,
    input.marketWeatherKey
  );

  if (directKey && String(directKey).includes('|')) {
    return buildMarketWeatherKeyFallback(directKey);
  }

  const regime = normalizeMarketWeatherRegimeFallback(firstKnownValue(
    input.entryMarketWeatherRegime,
    input.confirmedMarketWeatherRegime,
    input.currentMarketWeatherRegime,
    input.marketWeatherRegime,
    input.currentRegime,
    input.regime,
    input.marketRegime,
    input.breadthRegime
  ));

  const trendSide = normalizeMarketWeatherTrendSideFallback(firstKnownValue(
    input.entryMarketWeatherTrendSide,
    input.confirmedMarketWeatherTrendSide,
    input.currentMarketWeatherTrendSide,
    input.marketWeatherTrendSide,
    input.currentTrendSide,
    input.trendSide,
    input.marketTrendSide,
    input.marketSide,
    input.side,
    input.direction,
    input.bias,
    input.marketBias
  ));

  return `${regime}|${trendSide}`;
}

function parseMarketWeatherKey(key = '') {
  const normalized = buildMarketWeatherKeyFallback(key);
  const [regimeRaw, trendRaw] = normalized.split('|');

  const regime = normalizeMarketWeatherRegimeFallback(regimeRaw);
  const trendSide = normalizeMarketWeatherTrendSideFallback(trendRaw);

  return {
    key: `${regime}|${trendSide}`,
    regime,
    trendSide,
    known: regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN'
  };
}

function isKnownMarketWeatherKey(key = '') {
  return parseMarketWeatherKey(key).known;
}

function makeUnknownMarketWeather(reason = 'MARKET_WEATHER_UNKNOWN') {
  const key = 'UNKNOWN|UNKNOWN';

  return {
    ok: false,
    available: false,
    known: false,
    reason,
    source: reason,

    currentMarketWeatherKey: key,
    confirmedMarketWeatherKey: key,
    entryMarketWeatherKey: key,

    currentMarketWeatherRegime: 'UNKNOWN',
    currentMarketWeatherTrendSide: 'UNKNOWN',
    confirmedMarketWeatherRegime: 'UNKNOWN',
    confirmedMarketWeatherTrendSide: 'UNKNOWN',
    entryMarketWeatherRegime: 'UNKNOWN',
    entryMarketWeatherTrendSide: 'UNKNOWN',

    currentMarketWeatherKnown: false,
    confirmedMarketWeatherKnown: false,
    entryMarketWeatherKnown: false,

    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,

    capturedAt: now()
  };
}

function normalizeMarketWeatherSnapshot(input = {}, source = 'UNKNOWN') {
  if (!input || typeof input !== 'object') {
    return makeUnknownMarketWeather('INVALID_MARKET_WEATHER_INPUT');
  }

  const key = buildMarketWeatherKeyFallback({
    entryMarketWeatherKey: input.entryMarketWeatherKey,
    confirmedMarketWeatherKey: input.confirmedMarketWeatherKey,
    currentMarketWeatherKey: input.currentMarketWeatherKey,
    marketWeatherKey: input.marketWeatherKey,

    entryMarketWeatherRegime: input.entryMarketWeatherRegime,
    confirmedMarketWeatherRegime: input.confirmedMarketWeatherRegime,
    currentMarketWeatherRegime: input.currentMarketWeatherRegime,
    marketWeatherRegime: input.marketWeatherRegime,
    currentRegime: input.currentRegime,
    regime: input.regime,
    marketRegime: input.marketRegime,
    breadthRegime: input.breadthRegime,

    entryMarketWeatherTrendSide: input.entryMarketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: input.confirmedMarketWeatherTrendSide,
    currentMarketWeatherTrendSide: input.currentMarketWeatherTrendSide,
    marketWeatherTrendSide: input.marketWeatherTrendSide,
    currentTrendSide: input.currentTrendSide,
    trendSide: input.trendSide,
    marketTrendSide: input.marketTrendSide,
    marketSide: input.marketSide,
    side: input.side,
    direction: input.direction,
    bias: input.bias,
    marketBias: input.marketBias
  });

  const parsed = parseMarketWeatherKey(key);
  const updatedAt = firstFiniteNumber([
    input.confirmedMarketWeatherUpdatedAt,
    input.currentMarketWeatherUpdatedAt,
    input.updatedAt,
    input.savedAt,
    input.generatedAt,
    input.createdAt,
    input.ts
  ]);

  return {
    ...input,

    ok: input.ok !== false && parsed.known,
    available: input.available !== false && parsed.known,
    known: parsed.known,
    reason: parsed.known ? null : 'MARKET_WEATHER_UNKNOWN',
    source: input.source || source,

    currentMarketWeatherKey: parsed.key,
    confirmedMarketWeatherKey: parsed.key,
    entryMarketWeatherKey: parsed.key,

    currentMarketWeatherRegime: parsed.regime,
    currentMarketWeatherTrendSide: parsed.trendSide,
    confirmedMarketWeatherRegime: parsed.regime,
    confirmedMarketWeatherTrendSide: parsed.trendSide,
    entryMarketWeatherRegime: parsed.regime,
    entryMarketWeatherTrendSide: parsed.trendSide,

    currentMarketWeatherKnown: parsed.known,
    confirmedMarketWeatherKnown: parsed.known,
    entryMarketWeatherKnown: parsed.known,

    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,

    capturedAt: input.capturedAt || input.entryMarketWeatherCapturedAt || updatedAt || now(),
    updatedAt: updatedAt || input.updatedAt || null
  };
}

function marketWeatherFields(snapshot = {}, prefix = '') {
  const weather = normalizeMarketWeatherSnapshot(snapshot, snapshot.source || 'MARKET_WEATHER_FIELDS');

  if (prefix === 'entry') {
    return {
      entryMarketWeatherKey: weather.entryMarketWeatherKey,
      entryMarketWeatherRegime: weather.entryMarketWeatherRegime,
      entryMarketWeatherTrendSide: weather.entryMarketWeatherTrendSide,
      entryMarketWeatherKnown: weather.entryMarketWeatherKnown,
      entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
      entryMarketWeatherCapturedAt: weather.capturedAt || now(),
      entryMarketWeatherSource: weather.source || 'SCANNER_CONFIRMED_MARKET_WEATHER'
    };
  }

  return {
    currentMarketWeatherKey: weather.currentMarketWeatherKey,
    confirmedMarketWeatherKey: weather.confirmedMarketWeatherKey,
    currentMarketWeatherRegime: weather.currentMarketWeatherRegime,
    currentMarketWeatherTrendSide: weather.currentMarketWeatherTrendSide,
    confirmedMarketWeatherRegime: weather.confirmedMarketWeatherRegime,
    confirmedMarketWeatherTrendSide: weather.confirmedMarketWeatherTrendSide,
    currentMarketWeatherKnown: weather.currentMarketWeatherKnown,
    confirmedMarketWeatherKnown: weather.confirmedMarketWeatherKnown,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    marketWeatherCapturedAt: weather.capturedAt || now(),
    marketWeatherSource: weather.source || 'SCANNER_CONFIRMED_MARKET_WEATHER'
  };
}

function resolveRequestMarketWeather(req = {}, body = {}) {
  const query = req.query || {};

  const key = firstKnownValue(
    body.entryMarketWeatherKey,
    body.confirmedMarketWeatherKey,
    body.currentMarketWeatherKey,
    query.entryMarketWeatherKey,
    query.confirmedMarketWeatherKey,
    query.currentMarketWeatherKey
  );

  const regime = firstKnownValue(
    body.entryMarketWeatherRegime,
    body.confirmedMarketWeatherRegime,
    body.currentMarketWeatherRegime,
    query.entryMarketWeatherRegime,
    query.confirmedMarketWeatherRegime,
    query.currentMarketWeatherRegime
  );

  const trendSide = firstKnownValue(
    body.entryMarketWeatherTrendSide,
    body.confirmedMarketWeatherTrendSide,
    body.currentMarketWeatherTrendSide,
    query.entryMarketWeatherTrendSide,
    query.confirmedMarketWeatherTrendSide,
    query.currentMarketWeatherTrendSide
  );

  if (!key && (!regime || !trendSide)) {
    return makeUnknownMarketWeather('NO_REQUEST_MARKET_WEATHER');
  }

  const weather = normalizeMarketWeatherSnapshot({
    currentMarketWeatherKey: key,
    confirmedMarketWeatherKey: key,
    entryMarketWeatherKey: key,
    currentMarketWeatherRegime: regime,
    confirmedMarketWeatherRegime: regime,
    entryMarketWeatherRegime: regime,
    currentMarketWeatherTrendSide: trendSide,
    confirmedMarketWeatherTrendSide: trendSide,
    entryMarketWeatherTrendSide: trendSide,
    source: 'REQUEST_CONFIRMED_MARKET_WEATHER',
    capturedAt: now()
  }, 'REQUEST_CONFIRMED_MARKET_WEATHER');

  if (!weather.known) {
    return makeUnknownMarketWeather('REQUEST_MARKET_WEATHER_UNKNOWN_IGNORED');
  }

  return weather;
}

async function resolveBackendMarketWeather(redis, refresh = false) {
  try {
    const marketModule = await import('../../src/market/marketWeather.js');

    const options = {
      redis,
      save: false,
      refresh,
      allowStale: true,

      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      scannerSide: TARGET_SCANNER_SIDE,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      redisNamespace: SHORT_NAMESPACE,
      redisKeyPrefix: SHORT_KEY_PREFIX,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      weekKey: PERSISTENT_LEARNING_KEY,

      entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
      currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
      confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,

      shortOnly: true,
      longDisabled: true,
      virtualLearning: true,
      realOrdersDisabled: true
    };

    let rawWeather;

    if (refresh && typeof marketModule.buildMarketWeather === 'function') {
      rawWeather = await marketModule.buildMarketWeather(options);
    } else if (typeof marketModule.getMarketWeather === 'function') {
      rawWeather = await marketModule.getMarketWeather(options);
    } else if (typeof marketModule.loadMarketWeather === 'function') {
      rawWeather = await marketModule.loadMarketWeather(options);
    } else if (typeof marketModule.default === 'function') {
      rawWeather = await marketModule.default(options);
    }

    const weather = normalizeMarketWeatherSnapshot(rawWeather || {}, 'BACKEND_MARKET_WEATHER');

    if (!weather.known) {
      return {
        ...weather,
        reason: weather.reason || 'BACKEND_MARKET_WEATHER_UNKNOWN'
      };
    }

    return weather;
  } catch (error) {
    return {
      ...makeUnknownMarketWeather('BACKEND_MARKET_WEATHER_IMPORT_OR_READ_FAILED'),
      importError: error?.message || String(error)
    };
  }
}

async function resolveScannerMarketWeather(req, body = {}, redis) {
  const force = shouldForce(req, body);
  const requestWeather = resolveRequestMarketWeather(req, body);

  if (requestWeather.known) {
    return {
      ...requestWeather,
      selectedSource: 'REQUEST_CONFIRMED_MARKET_WEATHER',
      backendReadSkipped: false
    };
  }

  const backendWeather = await resolveBackendMarketWeather(redis, force);

  if (backendWeather.known) {
    return {
      ...backendWeather,
      selectedSource: 'BACKEND_MARKET_WEATHER',
      requestUnknownIgnored: true
    };
  }

  return {
    ...makeUnknownMarketWeather('NO_KNOWN_MARKET_WEATHER_FOR_SCANNER'),
    requestWeather,
    backendWeather,
    requestUnknownIgnored: true
  };
}

function candidateEntryMarketWeather(candidate = {}, scannerMarketWeather = {}) {
  const directCandidateWeather = normalizeMarketWeatherSnapshot({
    entryMarketWeatherKey: candidate.entryMarketWeatherKey,
    currentMarketWeatherKey: candidate.currentMarketWeatherKey,
    confirmedMarketWeatherKey: candidate.confirmedMarketWeatherKey,
    marketWeatherKey: candidate.marketWeatherKey,

    entryMarketWeatherRegime: candidate.entryMarketWeatherRegime,
    currentMarketWeatherRegime: candidate.currentMarketWeatherRegime,
    confirmedMarketWeatherRegime: candidate.confirmedMarketWeatherRegime,
    marketWeatherRegime: candidate.marketWeatherRegime,
    currentRegime: candidate.currentRegime,
    regime: candidate.regime,

    entryMarketWeatherTrendSide: candidate.entryMarketWeatherTrendSide,
    currentMarketWeatherTrendSide: candidate.currentMarketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: candidate.confirmedMarketWeatherTrendSide,
    marketWeatherTrendSide: candidate.marketWeatherTrendSide,
    currentTrendSide: candidate.currentTrendSide,
    trendSide: candidate.trendSide,
    marketTrendSide: candidate.marketTrendSide
  }, 'CANDIDATE_EXISTING_MARKET_WEATHER');

  if (directCandidateWeather.known) {
    return {
      ...directCandidateWeather,
      source: 'CANDIDATE_EXISTING_MARKET_WEATHER'
    };
  }

  const scannerWeather = normalizeMarketWeatherSnapshot(
    scannerMarketWeather,
    scannerMarketWeather?.source || 'SCANNER_CONFIRMED_MARKET_WEATHER'
  );

  if (scannerWeather.known) {
    return {
      ...scannerWeather,
      source: scannerWeather.source || 'SCANNER_CONFIRMED_MARKET_WEATHER',
      candidatePartialWeatherIgnored: directCandidateWeather.entryMarketWeatherKey !== 'UNKNOWN|UNKNOWN'
        ? directCandidateWeather.entryMarketWeatherKey
        : null
    };
  }

  return makeUnknownMarketWeather('CANDIDATE_AND_SCANNER_MARKET_WEATHER_UNKNOWN');
}

function hasShortSignal(value = '') {
  const text = ` ${cleanSideText(value)} `;

  return (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('POSITION_SIDE=SHORT') ||
    text.includes('POSITIONSIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('DIRECTION=SELL') ||
    text.includes(' SHORT_') ||
    text.includes('_SHORT ') ||
    text.includes('_SHORT_') ||
    text.includes('|SHORT|') ||
    text.includes(':SHORT') ||
    text.includes('=SHORT') ||
    text.includes(' BEAR ') ||
    text.includes('_BEAR') ||
    text.includes('BEAR_') ||
    text.includes('|BEAR|') ||
    text.includes(':BEAR') ||
    text.includes('=BEAR') ||
    text.includes(' SELL ') ||
    text.includes('_SELL') ||
    text.includes('SELL_') ||
    text.includes('|SELL|') ||
    text.includes(':SELL') ||
    text.includes('=SELL')
  );
}

function hasLongSignal(value = '') {
  const text = ` ${cleanSideText(value)} `;

  return (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('POSITION_SIDE=LONG') ||
    text.includes('POSITIONSIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('DIRECTION=BUY') ||
    text.includes(' LONG_') ||
    text.includes('_LONG ') ||
    text.includes('_LONG_') ||
    text.includes('|LONG|') ||
    text.includes(':LONG') ||
    text.includes('=LONG') ||
    text.includes(' BULL ') ||
    text.includes('_BULL') ||
    text.includes('BULL_') ||
    text.includes('|BULL|') ||
    text.includes(':BULL') ||
    text.includes('=BULL') ||
    text.includes(' BUY ') ||
    text.includes('_BUY') ||
    text.includes('BUY_') ||
    text.includes('|BUY|') ||
    text.includes(':BUY') ||
    text.includes('=BUY')
  );
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

function hasBearishMove(row = {}) {
  const values = moveMetricValues(row);

  if (!values.length) return false;

  return values.some((value) => value < 0);
}

function hasOnlyBullishMove(row = {}) {
  const values = moveMetricValues(row);

  if (!values.length) return false;

  return values.every((value) => value > 0);
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
    ...(Array.isArray(row.currentFitReasons) ? row.currentFitReasons : [])
  ]
    .map((value) => upper(value))
    .join(' | ');
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

function rowSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.signalSide ||
    row.entrySide ||
    row.side ||
    row.bias ||
    row.marketBias
  );

  if (direct !== 'UNKNOWN') return direct;

  const reasonSide = inferTradeSideFromText(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason ||
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
    row.parentTrueMicroFamilyId,
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
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('|');

  const textSide = inferTradeSideFromText(haystack);

  if (textSide !== 'UNKNOWN') return textSide;

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (hasBearishMove(row)) return TARGET_TRADE_SIDE;
  if (hasOnlyBullishMove(row)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortCandidate(row = {}) {
  return rowSide(row) === TARGET_TRADE_SIDE;
}

function isLongCandidate(row = {}) {
  return rowSide(row) === OPPOSITE_TRADE_SIDE;
}

function normalizeSymbol(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/_?USDT$/i, '');
}

function normalizeContractSymbol(value = '') {
  const raw = String(value || '').trim().toUpperCase();

  if (!raw) return '';

  if (raw.endsWith('USDT')) return raw;

  return `${normalizeSymbol(raw)}USDT`;
}

function normalizeScannerMetadata(candidate = {}) {
  return {
    scannerMicroFamilyId:
      candidate.scannerMicroFamilyId ||
      candidate.scannerFamilyId ||
      candidate.scannerBucket ||
      candidate.bucket ||
      null,

    scannerFamilyId:
      candidate.scannerFamilyId ||
      candidate.scannerMicroFamilyId ||
      candidate.scannerBucket ||
      candidate.bucket ||
      null,

    scannerBucket: candidate.scannerBucket || candidate.bucket || null,
    scannerBucket25: candidate.scannerBucket25 || candidate.legacyBucket25 || null,
    scannerReason: candidate.scannerReason || candidate.reason || 'SHORT_SCANNER_CANDIDATE',
    scannerReasonCoarse: candidate.scannerReasonCoarse || null,
    scannerDefinition: candidate.scannerDefinition || null,
    scannerDefinitionParts: Array.isArray(candidate.scannerDefinitionParts)
      ? candidate.scannerDefinitionParts
      : [],

    scannerFingerprintHash: candidate.scannerFingerprintHash || candidate.fingerprintHash || null,
    scannerFingerprintParts: Array.isArray(candidate.scannerFingerprintParts)
      ? candidate.scannerFingerprintParts
      : [],

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    analyzeTrueMicroFamilyId: null,
    trueMicroFamilyId: null,
    parentTrueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
    microFamilyId: null,
    learningMicroFamilyId: null,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsLearningIdentitySource: false,
    scannerDoesNotSelectMicroFamilies: true
  };
}

function normalizeShortCandidate(candidate = {}, scannerMarketWeather = {}) {
  const symbol = normalizeSymbol(
    candidate.symbol ||
    candidate.baseSymbol ||
    candidate.contractSymbol ||
    candidate.instId ||
    candidate.instrumentId
  );

  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
    candidate.symbol ||
    candidate.instId ||
    candidate.instrumentId ||
    symbol
  );

  const createdAt = safeNumber(
    candidate.createdAt ||
      candidate.ts ||
      candidate.scannerTs ||
      Date.now(),
    Date.now()
  );

  const currentFit = getShortCurrentFit(candidate);
  const entryWeather = candidateEntryMarketWeather(candidate, scannerMarketWeather);

  return {
    ...candidate,

    symbol,
    baseSymbol: symbol,
    contractSymbol,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    directionalSide: TARGET_DASHBOARD_SIDE,
    inferredDirectionalSide: TARGET_DASHBOARD_SIDE,
    marketSide: TARGET_DASHBOARD_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    scannerOnly: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotOpenPositions: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

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

    ...marketWeatherFields(entryWeather, 'entry'),
    ...marketWeatherFields(entryWeather),

    scannerMarketWeatherCaptured: true,
    scannerMarketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    scannerCandidateMarketWeatherCaptureRule: entryWeather.known
      ? 'USE_CONFIRMED_SCANNER_MARKET_WEATHER_IF_CANDIDATE_WEATHER_UNKNOWN_OR_PARTIAL'
      : 'UNKNOWN_WEATHER_OBSERVE_ONLY',
    scannerCandidatePartialWeatherIgnored: entryWeather.candidatePartialWeatherIgnored || null,

    ...normalizeScannerMetadata(candidate),

    scannerScore: safeNumber(candidate.scannerScore ?? candidate.moveScore, 0),
    moveScore: safeNumber(candidate.moveScore ?? candidate.scannerScore, 0),

    change1h: safeNumber(candidate.change1h ?? candidate.priceChange1hPct, 0),
    change24h: safeNumber(candidate.change24h ?? candidate.priceChange24hPct, 0),
    volume24h: safeNumber(candidate.volume24h ?? candidate.quoteVolume24h ?? candidate.quoteVolume, 0),

    btcState: candidate.btcState || null,
    regime: candidate.regime || null,

    fakeBreakout: Boolean(candidate.fakeBreakout),
    fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),

    createdAt,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false
  };
}

function scannerGatePassed(row = {}) {
  if (row.scannerGatePassed === undefined || row.scannerGatePassed === null) {
    return false;
  }

  return Boolean(row.scannerGatePassed);
}

function isAnalyzeOnly(row = {}) {
  return Boolean(
    row.tradeDiscoveryOnly ||
    row.discoveryOnly ||
    row.analyzeOnly ||
    !scannerGatePassed(row)
  );
}

function unwrapPayload(result) {
  if (!result) return null;

  if (result.result?.result?.result?.candidates) return result.result.result.result;
  if (result.result?.result?.candidates) return result.result.result;
  if (result.result?.candidates) return result.result;
  if (result.candidates) return result;

  if (result.result?.result?.result) return result.result.result.result;
  if (result.result?.result) return result.result;
  if (result.result) return result.result;

  return result;
}

function normalizePayload(payload = {}, scannerMarketWeather = {}) {
  const marketWeather = normalizeMarketWeatherSnapshot(
    scannerMarketWeather?.known
      ? scannerMarketWeather
      : payload?.marketWeather || payload?.currentMarketWeather || payload?.weather || scannerMarketWeather,
    scannerMarketWeather?.source || 'NORMALIZE_PAYLOAD_MARKET_WEATHER'
  );

  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      reason: 'EMPTY_SCANNER_PAYLOAD',
      ...baseFlags(),
      ...marketWeatherFields(marketWeather),
      marketWeather,
      candidates: [],
      candidatesCount: 0,
      shortCandidatesCount: 0,
      longCandidatesCount: 0,
      rawCandidatesCount: 0,
      rawLongCandidatesIgnored: 0,
      rawUnknownSideCandidatesIgnored: 0
    };
  }

  const rawCandidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];

  const candidates = rawCandidates
    .filter(isShortCandidate)
    .map((candidate) => normalizeShortCandidate(candidate, marketWeather))
    .filter((candidate) => candidate.symbol && candidate.contractSymbol);

  const scannerGateCandidates = candidates.filter(scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);

  const rawLongCandidatesIgnored = rawCandidates.filter(isLongCandidate).length;
  const rawUnknownSideCandidatesIgnored = rawCandidates.filter((row) => rowSide(row) === 'UNKNOWN').length;

  const analyze = payload.analyze && typeof payload.analyze === 'object'
    ? {
        ...payload.analyze,
        ...baseFlags(),
        ...marketWeatherFields(marketWeather),
        marketWeather,
        scannerOutputOnly: true,
        scannerDoesNotWriteLearning: true,
        analyzeMustAssignTrueMicroFamily: true
      }
    : payload.analyze || null;

  return {
    ...payload,
    ...baseFlags(),
    ...marketWeatherFields(marketWeather),

    marketWeather,
    currentMarketWeather: marketWeather,
    confirmedMarketWeather: marketWeather,
    scannerMarketWeather: marketWeather,

    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    scannerMarketWeatherCaptured: marketWeather.known,
    scannerMarketWeatherCaptureSource: marketWeather.source,
    scannerCandidatesReceiveEntryMarketWeatherKey: true,
    unknownWeatherDoesNotOverrideKnownWeather: true,

    sideMode: 'SHORT_ONLY',
    payloadRole: 'SHORT_SCANNER_DISCOVERY_ONLY',

    candidates,
    candidatesCount: candidates.length,

    shortCandidatesCount: candidates.length,
    longCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    rawCandidatesCount: rawCandidates.length,
    rawLongCandidatesIgnored,
    rawUnknownSideCandidatesIgnored,

    bearCandidates: candidates.length,
    bullCandidates: 0,

    topSymbols: candidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    analyzeOnlySymbols: analyzeOnlyCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    analyze
  };
}

function normalizeLockResult(rawResult = {}, scannerMarketWeather = {}) {
  if (!rawResult || typeof rawResult !== 'object') {
    return {
      ok: false,
      reason: 'EMPTY_LOCK_RESULT',
      ...baseFlags(),
      ...marketWeatherFields(scannerMarketWeather),
      marketWeather: normalizeMarketWeatherSnapshot(scannerMarketWeather)
    };
  }

  const payload = normalizePayload(unwrapPayload(rawResult), scannerMarketWeather);

  if (rawResult.result?.result?.result?.candidates) {
    return {
      ...rawResult,
      ...baseFlags(),
      ...marketWeatherFields(scannerMarketWeather),
      marketWeather: normalizeMarketWeatherSnapshot(scannerMarketWeather),
      result: {
        ...rawResult.result,
        result: {
          ...rawResult.result.result,
          result: payload
        }
      }
    };
  }

  if (rawResult.result?.result?.candidates) {
    return {
      ...rawResult,
      ...baseFlags(),
      ...marketWeatherFields(scannerMarketWeather),
      marketWeather: normalizeMarketWeatherSnapshot(scannerMarketWeather),
      result: {
        ...rawResult.result,
        result: payload
      }
    };
  }

  if (rawResult.result?.candidates) {
    return {
      ...rawResult,
      ...baseFlags(),
      ...marketWeatherFields(scannerMarketWeather),
      marketWeather: normalizeMarketWeatherSnapshot(scannerMarketWeather),
      result: payload
    };
  }

  if (rawResult.candidates) {
    return payload;
  }

  return {
    ...rawResult,
    ...baseFlags(),
    ...marketWeatherFields(scannerMarketWeather),
    marketWeather: normalizeMarketWeatherSnapshot(scannerMarketWeather),
    result: payload
  };
}

function resolveStatus(error) {
  if (Number.isFinite(error?.statusCode)) return error.statusCode;

  if (
    error?.reason === 'LOCK_NOT_ACQUIRED' ||
    error?.message === 'LOCK_NOT_ACQUIRED' ||
    String(error?.message || '').includes('LOCK')
  ) {
    return 409;
  }

  return 500;
}

function buildScannerOptions(req, body = {}, scannerMarketWeather = {}) {
  const force = shouldForce(req, body);
  const marketWeather = normalizeMarketWeatherSnapshot(scannerMarketWeather, scannerMarketWeather?.source || 'SCANNER_OPTIONS');

  return {
    force,
    forced: force,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    actualScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true,

    longOnly: false,
    shortDisabled: false,

    scannerOnly: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotOpenPositions: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    scannerHashesMetadataOnly: true,
    coinNameMetadataOnly: true,

    noTradeExecution: true,
    noDiscord: true,
    noMicroFamilySelection: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOnly: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsNotLearningIdentitySource: true,
    symbolExcludedFromFamilyId: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    ...marketWeatherFields(marketWeather),

    marketWeather,
    currentMarketWeather: marketWeather,
    confirmedMarketWeather: marketWeather,
    scannerMarketWeather: marketWeather,
    scannerMarketWeatherCaptureEnabled: true,
    scannerMarketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    scannerCapturesConfirmedWeatherAtSnapshot: true,
    scannerCandidatesReceiveEntryMarketWeatherKey: true,
    unknownWeatherDoesNotOverrideKnownWeather: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,

    scannerTradeRedisBridgeEnabled: true,
    scannerWritesVolatileRedis: true,
    scannerWritesDurableRedis: true,

    keys: {
      scanLock: SHORT_KEYS.scan.lock,
      scanLatest: SHORT_KEYS.scan.latest,
      scanSnapshotPattern: SHORT_KEYS.scan.snapshotPattern
    }
  };
}

// ===== AANGEPAST: persistOneScannerPayload met TTL en fallback =====
async function persistOneScannerPayload(redis, payload = {}, storageRole = 'UNKNOWN') {
  if (!redis) {
    return {
      storageRole,
      ok: false,
      reason: 'REDIS_CLIENT_MISSING'
    };
  }

  // Zorg dat snapshotId en createdAt bestaan
  let snapshotId = payload?.snapshotId || payload?.id || payload?.scanId || null;
  if (!snapshotId) {
    // Genereer een nieuwe op basis van timestamp + hash
    const timestamp = now();
    const hash = Math.random().toString(36).substring(2, 8);
    snapshotId = `scan_short_${timestamp}_${hash}`;
  }

  const createdAt = payload?.createdAt || payload?.ts || payload?.scanTs || now();

  const snapshotKey = SHORT_KEYS.scan.snapshot(snapshotId);

  const marketWeather = normalizeMarketWeatherSnapshot(
    payload.marketWeather || payload.currentMarketWeather || payload.scannerMarketWeather || payload,
    'PERSIST_SCANNER_PAYLOAD_MARKET_WEATHER'
  );

  const latestPayload = {
    ...payload,
    ...baseFlags(),
    ...marketWeatherFields(marketWeather),

    marketWeather,
    currentMarketWeather: marketWeather,
    confirmedMarketWeather: marketWeather,
    scannerMarketWeather: marketWeather,

    snapshotId,
    createdAt,
    persistedAt: now(),
    persistedBy: 'api/scanner/run.js',
    persistedNamespace: SHORT_NAMESPACE,
    persistedStorageRole: storageRole,

    scannerPayloadRole: 'DISCOVERY_METADATA_ONLY',
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    scannerMarketWeatherCaptured: marketWeather.known,
    scannerMarketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    scannerCandidatesReceiveEntryMarketWeatherKey: true,

    scannerTradeRedisBridgeEnabled: true,
    scannerLatestSharedKey: SHORT_KEYS.scan.latest,
    scannerSnapshotSharedKey: snapshotKey,

    shortKeys: {
      namespace: SHORT_NAMESPACE,
      prefix: SHORT_KEY_PREFIX,
      scanLatest: SHORT_KEYS.scan.latest,
      snapshotKey
    }
  };

  // Schrijf met TTL
  await setJson(redis, SHORT_KEYS.scan.latest, latestPayload, { EX: SNAPSHOT_TTL_SEC });
  await setJson(redis, snapshotKey, latestPayload, { EX: SNAPSHOT_TTL_SEC });

  return {
    storageRole,
    ok: true,
    persistedLatest: true,
    persistedSnapshot: true,
    scanLatest: SHORT_KEYS.scan.latest,
    snapshotKey,
    snapshotId,
    createdAt,
    ttlSec: SNAPSHOT_TTL_SEC
  };
}

async function persistShortScannerPayload({
  volatileRedis,
  durableRedis,
  payload = {}
}) {
  // Zorg dat payload snapshotId en createdAt heeft
  let snapshotId = payload?.snapshotId || payload?.id || payload?.scanId || null;
  if (!snapshotId) {
    const timestamp = now();
    const hash = Math.random().toString(36).substring(2, 8);
    snapshotId = `scan_short_${timestamp}_${hash}`;
    payload.snapshotId = snapshotId;
  }
  if (!payload.createdAt) {
    payload.createdAt = now();
  }

  const volatileResult = await persistOneScannerPayload(
    volatileRedis,
    payload,
    'VOLATILE_SCANNER_PRIMARY'
  ).catch((error) => ({
    storageRole: 'VOLATILE_SCANNER_PRIMARY',
    ok: false,
    error: error?.message || String(error)
  }));

  const durableResult = await persistOneScannerPayload(
    durableRedis,
    payload,
    'DURABLE_TRADE_READ_MIRROR'
  ).catch((error) => ({
    storageRole: 'DURABLE_TRADE_READ_MIRROR',
    ok: false,
    error: error?.message || String(error)
  }));

  return {
    ok: volatileResult.ok === true || durableResult.ok === true,

    scannerTradeRedisBridgeEnabled: true,

    persistedShortLatest: volatileResult.ok === true || durableResult.ok === true,
    persistedShortSnapshot: Boolean(
      snapshotId &&
        (
          volatileResult.persistedSnapshot === true ||
          durableResult.persistedSnapshot === true
        )
    ),

    volatile: volatileResult,
    durable: durableResult,

    scanLatest: SHORT_KEYS.scan.latest,
    snapshotKey: snapshotId ? SHORT_KEYS.scan.snapshot(snapshotId) : null,
    snapshotId,

    tradeSystemReadsDurableMirror: true,
    tradeSystemScannerLatestKey: SHORT_KEYS.scan.latest,

    mismatchFixed: durableResult.ok === true,
    warning: durableResult.ok === true
      ? null
      : 'DURABLE_SCANNER_MIRROR_FAILED_TRADE_MAY_READ_STALE_SCANNER_LATEST'
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Scanner-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Scanner-Only', 'true');
  res.setHeader('X-No-Trade-Execution', 'true');
  res.setHeader('X-No-Discord', 'true');
  res.setHeader('X-No-Micro-Family-Selection', 'true');
  res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Scanner-Fingerprints-Used-As-Learning-Family', 'false');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');
  res.setHeader('X-Scanner-Writes-Volatile-Redis', 'true');
  res.setHeader('X-Scanner-Writes-Durable-Redis', 'true');
  res.setHeader('X-Scanner-Trade-Redis-Bridge', 'true');
  res.setHeader('X-Trade-Reads-Same-Scanner-Latest', 'true');
  res.setHeader('X-Market-Weather-Key-Version', MARKET_WEATHER_KEY_VERSION);
  res.setHeader('X-Market-Weather-Capture-Version', MARKET_WEATHER_CAPTURE_VERSION);
  res.setHeader('X-Scanner-Captures-Market-Weather', 'true');

  const startedAt = now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    const volatileRedis = getVolatileRedis();
    const durableRedis = getDurableRedis();

    const scannerMarketWeather = await resolveScannerMarketWeather(req, body, durableRedis);
    const scannerOptions = buildScannerOptions(req, body, scannerMarketWeather);

    const lockKey = SHORT_KEYS.scan.lock;
    const lockTtlSec = getLockTtlSec();

    const rawResult = await withRedisLock(
      volatileRedis,
      lockKey,
      lockTtlSec,
      async () => runScanner(scannerOptions)
    );

    const result = normalizeLockResult(rawResult, scannerMarketWeather);
    const payload = normalizePayload(unwrapPayload(result), scannerMarketWeather);

    // Zorg dat payload een snapshotId en createdAt heeft
    if (!payload.snapshotId) {
      const timestamp = now();
      const hash = Math.random().toString(36).substring(2, 8);
      payload.snapshotId = `scan_short_${timestamp}_${hash}`;
    }
    if (!payload.createdAt) {
      payload.createdAt = now();
    }

    const persistence = await persistShortScannerPayload({
      volatileRedis,
      durableRedis,
      payload
    });

    const ok = result?.ok !== false && payload?.ok !== false && persistence.ok === true;
    const marketWeather = normalizeMarketWeatherSnapshot(
      payload.marketWeather || scannerMarketWeather,
      'RESPONSE_MARKET_WEATHER'
    );

    return res.status(200).json({
      ok,
      skipped: Boolean(result?.skipped || payload?.skipped || false),
      reason: result?.reason || payload?.reason || persistence.warning || null,

      source: sourceLabel(req, body),

      ...baseFlags(),
      ...marketWeatherFields(marketWeather),

      marketWeather,
      currentMarketWeather: marketWeather,
      confirmedMarketWeather: marketWeather,
      scannerMarketWeather: marketWeather,

      force: scannerOptions.force,

      persisted: payload?.persisted ?? result?.persisted ?? null,
      shortPersistence: persistence,

      snapshotId: payload.snapshotId,
      createdAt: payload.createdAt,
      snapshotAgeMs: now() - payload.createdAt,

      candidatesCount: Number(payload?.candidatesCount || 0),
      shortCandidatesCount: Number(payload?.shortCandidatesCount || payload?.candidatesCount || 0),
      longCandidatesCount: 0,

      scannerGateCandidatesCount: Number(payload?.scannerGateCandidatesCount || 0),
      analyzeOnlyCandidatesCount: Number(payload?.analyzeOnlyCandidatesCount || 0),

      rawCandidatesCount: Number(payload?.rawCandidatesCount || payload?.rawCount || 0),
      rawLongCandidatesIgnored: Number(payload?.rawLongCandidatesIgnored || 0),
      rawUnknownSideCandidatesIgnored: Number(payload?.rawUnknownSideCandidatesIgnored || 0),

      topSymbols: payload?.topSymbols || [],
      scannerGateSymbols: payload?.scannerGateSymbols || [],
      analyzeOnlySymbols: payload?.analyzeOnlySymbols || [],

      analyze: payload?.analyze || null,

      scannerTradeAlignment: {
        enabled: true,
        fixed: persistence.durable?.ok === true,
        scannerWritesVolatile: persistence.volatile?.ok === true,
        scannerWritesDurable: persistence.durable?.ok === true,
        tradeReadsDurableLatest: true,
        sharedLatestKey: SHORT_KEYS.scan.latest,
        snapshotKey: payload.snapshotId ? SHORT_KEYS.scan.snapshot(payload.snapshotId) : null,
        ttlSec: SNAPSHOT_TTL_SEC
      },

      scannerMarketWeatherCapture: {
        enabled: true,
        version: MARKET_WEATHER_CAPTURE_VERSION,
        keyVersion: MARKET_WEATHER_KEY_VERSION,
        source: marketWeather.source,
        known: marketWeather.known,
        currentMarketWeatherKey: marketWeather.currentMarketWeatherKey,
        confirmedMarketWeatherKey: marketWeather.confirmedMarketWeatherKey,
        currentMarketWeatherRegime: marketWeather.currentMarketWeatherRegime,
        currentMarketWeatherTrendSide: marketWeather.currentMarketWeatherTrendSide,
        candidatesReceiveEntryMarketWeatherKey: true,
        unknownWeatherDoesNotOverrideKnownWeather: true
      },

      shortKeys: {
        namespace: SHORT_NAMESPACE,
        prefix: SHORT_KEY_PREFIX,
        scanLock: SHORT_KEYS.scan.lock,
        scanLatest: SHORT_KEYS.scan.latest,
        scanSnapshotPattern: SHORT_KEYS.scan.snapshotPattern,
        snapshotKey: payload.snapshotId ? SHORT_KEYS.scan.snapshot(payload.snapshotId) : null,

        volatileScanLatest: SHORT_KEYS.scan.latest,
        durableScanLatest: SHORT_KEYS.scan.latest,
        tradeSystemScannerLatest: SHORT_KEYS.scan.latest
      },

      warnings: [
        persistence.durable?.ok !== true
          ? 'DURABLE_SCANNER_MIRROR_FAILED_TRADE_MAY_NOT_SEE_THIS_SCAN'
          : null,
        marketWeather.known !== true
          ? 'SCANNER_MARKET_WEATHER_UNKNOWN_CANDIDATES_OBSERVE_ONLY'
          : null,
        Number(payload?.scannerGateCandidatesCount || 0) <= 0
          ? 'NO_SCANNER_GATE_CANDIDATES_TRADE_MAY_HAVE_NO_NEW_ENTRIES'
          : null,
        Number(payload?.candidatesCount || 0) <= 0
          ? 'NO_SHORT_SCANNER_CANDIDATES'
          : null
      ].filter(Boolean),

      durationMs: now() - startedAt,

      result
    });
  } catch (error) {
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