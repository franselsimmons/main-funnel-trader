// ================= FILE: src/market/scanner.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getVolatileRedis, getDurableRedis, setJson } from '../redis.js';
import {
  classifyBtcState,
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  calculateAtrPct,
  classifyVolatilityRegime,
  calcVolumeExpansion
} from './indicators.js';
import { detectFakeBreakout } from './fakeBreakout.js';
import {
  fetchBitgetTickers,
  parseTicker,
  fetchCandles
} from './bitgetClient.js';

const DEFAULT_ANALYZE_SYMBOLS = 500;
const DEFAULT_MAX_CANDIDATES = 500;
const DEFAULT_MIN_QUOTE_VOLUME_24H = 50_000;
const DEFAULT_SOFT_MIN_QUOTE_VOLUME_24H = 10_000;

const DEFAULT_MARKET_UNIVERSE_SYMBOLS = 120;
const DEFAULT_MARKET_UNIVERSE_TTL_SEC = 180;
const DEFAULT_MARKET_UNIVERSE_MIN_VOLUME_24H = 10_000;

const DEFAULT_MARKET_WEATHER_TTL_SEC = 180;

const MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1';
const MARKET_WEATHER_CAPTURE_VERSION = 'SHORT_SCANNER_MARKET_WEATHER_CAPTURE_V2_CONFIRMED_ENTRY_WEATHER';
const MARKET_WEATHER_AGGREGATION_VERSION = 'SHORT_MARKET_WEATHER_AGGREGATION_V1_REGIME_REGIMETREND';

const UNKNOWN_MARKET_WEATHER_KEY = 'UNKNOWN|UNKNOWN';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_SCANNER_SIDE = 'bear';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const SCANNER_RUN_SCOPE = 'SCANNER_ONLY';
const SCANNER_WRITE_SCOPE = 'SHORT_SCAN_MARKET_UNIVERSE_AND_MARKET_WEATHER_KEYS_ONLY';

const MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;
const SHORT_MARKET_UNIVERSE_KEY = `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;

const MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;
const SHORT_MARKET_WEATHER_KEY = `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const BLOCKED_BASE_SYMBOLS = new Set([
  'USDT',
  'USDC',
  'USD',
  'BUSD',
  'FDUSD',
  'TUSD',
  'DAI',
  'EUR',
  'TRY',
  'BRL'
]);

function now() {
  return Date.now();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function firstKnownText(...values) {
  for (const value of values) {
    if (!hasValue(value)) continue;

    const raw = String(Array.isArray(value) ? value[0] : value).trim();

    if (!raw) continue;

    const normalized = upper(raw);

    if (normalized === 'UNKNOWN') continue;
    if (normalized === UNKNOWN_MARKET_WEATHER_KEY) continue;
    if (normalized.startsWith('UNKNOWN|')) continue;
    if (normalized.endsWith('|UNKNOWN')) continue;

    return raw;
  }

  return null;
}

function normalizeMarketWeatherRegime(value) {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  if (raw.includes('SQUEEZE')) return 'SQUEEZE';
  if (raw.includes('COMPRESSION')) return 'SQUEEZE';
  if (raw.includes('COMPRESS')) return 'SQUEEZE';
  if (raw.includes('COIL')) return 'SQUEEZE';
  if (raw.includes('LOW_VOL')) return 'SQUEEZE';
  if (raw.includes('LOWVOL')) return 'SQUEEZE';

  if (raw.includes('TREND')) return 'TREND';
  if (raw.includes('MOMENTUM')) return 'TREND';
  if (raw.includes('FLOW')) return 'TREND';
  if (raw.includes('DIRECTION')) return 'TREND';
  if (raw.includes('HIGH_VOL')) return 'TREND';
  if (raw.includes('HIGHVOL')) return 'TREND';

  if (raw.includes('CHOP')) return 'CHOP';
  if (raw.includes('RANGE')) return 'CHOP';
  if (raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('MIXED')) return 'CHOP';

  return raw || 'UNKNOWN';
}

function normalizeMarketWeatherTrendSide(value) {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  if (raw.includes('BEARISH')) return 'BEARISH';
  if (raw === 'BEAR') return 'BEARISH';
  if (raw.includes('BEAR_')) return 'BEARISH';
  if (raw.includes('_BEAR')) return 'BEARISH';
  if (raw.includes('SHORT')) return 'BEARISH';
  if (raw.includes('SELL')) return 'BEARISH';
  if (raw.includes('DOWN')) return 'BEARISH';
  if (raw.includes('DOWNSIDE')) return 'BEARISH';
  if (raw.includes('RISK_OFF')) return 'BEARISH';

  if (raw.includes('BULLISH')) return 'BULLISH';
  if (raw === 'BULL') return 'BULLISH';
  if (raw.includes('BULL_')) return 'BULLISH';
  if (raw.includes('_BULL')) return 'BULLISH';
  if (raw.includes('LONG')) return 'BULLISH';
  if (raw.includes('BUY')) return 'BULLISH';
  if (raw.includes('UP')) return 'BULLISH';
  if (raw.includes('UPSIDE')) return 'BULLISH';
  if (raw.includes('RISK_ON')) return 'BULLISH';

  if (raw.includes('NEUTRAL')) return 'NEUTRAL';
  if (raw.includes('MIXED')) return 'NEUTRAL';
  if (raw.includes('FLAT')) return 'NEUTRAL';
  if (raw.includes('QUIET')) return 'NEUTRAL';

  return raw || 'UNKNOWN';
}

function buildMarketWeatherKey({ regime, trendSide }) {
  const normalizedRegime = normalizeMarketWeatherRegime(regime);
  const normalizedTrendSide = normalizeMarketWeatherTrendSide(trendSide);

  if (
    normalizedRegime === 'UNKNOWN' ||
    normalizedTrendSide === 'UNKNOWN'
  ) {
    return UNKNOWN_MARKET_WEATHER_KEY;
  }

  return `${normalizedRegime}|${normalizedTrendSide}`;
}

function parseMarketWeatherKey(value) {
  const raw = upper(value);

  if (!raw || !raw.includes('|')) {
    return {
      key: UNKNOWN_MARKET_WEATHER_KEY,
      regime: 'UNKNOWN',
      trendSide: 'UNKNOWN',
      known: false
    };
  }

  const [regimeRaw, trendRaw] = raw.split('|');

  const regime = normalizeMarketWeatherRegime(regimeRaw);
  const trendSide = normalizeMarketWeatherTrendSide(trendRaw);
  const key = buildMarketWeatherKey({ regime, trendSide });
  const known = key !== UNKNOWN_MARKET_WEATHER_KEY;

  return {
    key,
    regime: known ? regime : 'UNKNOWN',
    trendSide: known ? trendSide : 'UNKNOWN',
    known
  };
}

function marketWeatherKnown(key) {
  return parseMarketWeatherKey(key).known;
}

function makeUnknownMarketWeather(reason = 'MARKET_WEATHER_UNKNOWN') {
  return {
    ok: false,
    available: false,
    known: false,
    currentMarketWeatherKnown: false,
    confirmedMarketWeatherKnown: false,
    entryMarketWeatherKnown: false,

    currentMarketWeatherKey: UNKNOWN_MARKET_WEATHER_KEY,
    confirmedMarketWeatherKey: UNKNOWN_MARKET_WEATHER_KEY,
    entryMarketWeatherKey: UNKNOWN_MARKET_WEATHER_KEY,
    marketWeatherKey: UNKNOWN_MARKET_WEATHER_KEY,

    currentMarketWeatherRegime: 'UNKNOWN',
    confirmedMarketWeatherRegime: 'UNKNOWN',
    entryMarketWeatherRegime: 'UNKNOWN',
    currentRegime: 'UNKNOWN',
    regime: 'UNKNOWN',

    currentMarketWeatherTrendSide: 'UNKNOWN',
    confirmedMarketWeatherTrendSide: 'UNKNOWN',
    entryMarketWeatherTrendSide: 'UNKNOWN',
    currentTrendSide: 'UNKNOWN',
    trendSide: 'UNKNOWN',

    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,

    reason,
    source: reason,
    capturedAt: now(),
    updatedAt: now()
  };
}

function normalizeMarketWeatherSnapshot(input = {}, source = 'UNKNOWN') {
  if (!input || typeof input !== 'object') {
    return makeUnknownMarketWeather('INVALID_MARKET_WEATHER_INPUT');
  }

  const directKey = firstKnownText(
    input.entryMarketWeatherKey,
    input.confirmedMarketWeatherKey,
    input.currentMarketWeatherKey,
    input.marketWeatherKey,
    input.key
  );

  let parsed = directKey
    ? parseMarketWeatherKey(directKey)
    : null;

  if (!parsed?.known) {
    const regime = firstKnownText(
      input.entryMarketWeatherRegime,
      input.confirmedMarketWeatherRegime,
      input.currentMarketWeatherRegime,
      input.currentRegime,
      input.marketWeatherRegime,
      input.regime
    );

    const trendSide = firstKnownText(
      input.entryMarketWeatherTrendSide,
      input.confirmedMarketWeatherTrendSide,
      input.currentMarketWeatherTrendSide,
      input.currentTrendSide,
      input.marketWeatherTrendSide,
      input.trendSide,
      input.marketTrendSide,
      input.currentTrend,
      input.trend,
      input.marketSide,
      input.bias
    );

    parsed = parseMarketWeatherKey(buildMarketWeatherKey({
      regime,
      trendSide
    }));
  }

  if (!parsed.known) {
    return {
      ...makeUnknownMarketWeather(input.reason || 'MARKET_WEATHER_UNKNOWN'),
      rawMarketWeather: input,
      source: input.source || source
    };
  }

  const updatedAt = firstPositiveNumber(
    input.entryMarketWeatherCapturedAt,
    input.confirmedMarketWeatherUpdatedAt,
    input.currentMarketWeatherUpdatedAt,
    input.updatedAt,
    input.generatedAt,
    input.completedAt,
    input.createdAt,
    input.ts,
    now()
  );

  return {
    ...input,

    ok: input.ok !== false,
    available: input.available !== false,
    known: true,
    currentMarketWeatherKnown: true,
    confirmedMarketWeatherKnown: true,
    entryMarketWeatherKnown: true,

    currentMarketWeatherKey: parsed.key,
    confirmedMarketWeatherKey: parsed.key,
    entryMarketWeatherKey: parsed.key,
    marketWeatherKey: parsed.key,

    currentMarketWeatherRegime: parsed.regime,
    confirmedMarketWeatherRegime: parsed.regime,
    entryMarketWeatherRegime: parsed.regime,
    currentRegime: parsed.regime,
    regime: parsed.regime,

    currentMarketWeatherTrendSide: parsed.trendSide,
    confirmedMarketWeatherTrendSide: parsed.trendSide,
    entryMarketWeatherTrendSide: parsed.trendSide,
    currentTrendSide: parsed.trendSide,
    trendSide: parsed.trendSide,

    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,

    source: input.source || source,
    reason: null,
    capturedAt: input.capturedAt || updatedAt,
    updatedAt
  };
}

function resolveRunMarketWeather(options = {}, derivedPayload = {}) {
  const fromOptions = normalizeMarketWeatherSnapshot({
    currentMarketWeatherKey: options.currentMarketWeatherKey,
    confirmedMarketWeatherKey: options.confirmedMarketWeatherKey,
    entryMarketWeatherKey: options.entryMarketWeatherKey,

    currentMarketWeatherRegime: options.currentMarketWeatherRegime,
    confirmedMarketWeatherRegime: options.confirmedMarketWeatherRegime,
    entryMarketWeatherRegime: options.entryMarketWeatherRegime,

    currentMarketWeatherTrendSide: options.currentMarketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: options.confirmedMarketWeatherTrendSide,
    entryMarketWeatherTrendSide: options.entryMarketWeatherTrendSide,

    source: 'SCANNER_OPTIONS_CONFIRMED_MARKET_WEATHER',
    capturedAt: now()
  }, 'SCANNER_OPTIONS_CONFIRMED_MARKET_WEATHER');

  if (fromOptions.known) return fromOptions;

  const fromOptionsObject = normalizeMarketWeatherSnapshot(
    options.marketWeather ||
      options.currentMarketWeather ||
      options.confirmedMarketWeather ||
      options.scannerMarketWeather ||
      {},
    'SCANNER_OPTIONS_MARKET_WEATHER_OBJECT'
  );

  if (fromOptionsObject.known) return fromOptionsObject;

  const fromDerived = normalizeMarketWeatherSnapshot(
    derivedPayload,
    'SCANNER_DERIVED_MARKET_WEATHER'
  );

  if (fromDerived.known) return fromDerived;

  return makeUnknownMarketWeather('SCANNER_MARKET_WEATHER_UNKNOWN');
}

function marketWeatherCoreFields(weather = {}) {
  const normalized = normalizeMarketWeatherSnapshot(weather, weather.source || 'MARKET_WEATHER_CORE_FIELDS');

  return {
    currentMarketWeatherKey: normalized.currentMarketWeatherKey,
    confirmedMarketWeatherKey: normalized.confirmedMarketWeatherKey,
    marketWeatherKey: normalized.marketWeatherKey,

    currentMarketWeatherRegime: normalized.currentMarketWeatherRegime,
    confirmedMarketWeatherRegime: normalized.confirmedMarketWeatherRegime,
    currentRegime: normalized.currentMarketWeatherRegime,
    regime: normalized.currentMarketWeatherRegime,

    currentMarketWeatherTrendSide: normalized.currentMarketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: normalized.confirmedMarketWeatherTrendSide,
    currentTrendSide: normalized.currentMarketWeatherTrendSide,
    trendSide: normalized.currentMarketWeatherTrendSide,

    currentMarketWeatherKnown: normalized.currentMarketWeatherKnown,
    confirmedMarketWeatherKnown: normalized.confirmedMarketWeatherKnown,

    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,

    marketWeatherSource: normalized.source,
    marketWeatherCapturedAt: normalized.capturedAt || now()
  };
}

function entryMarketWeatherFields(weather = {}) {
  const normalized = normalizeMarketWeatherSnapshot(weather, weather.source || 'ENTRY_MARKET_WEATHER_FIELDS');

  return {
    entryMarketWeatherKey: normalized.entryMarketWeatherKey,
    entryMarketWeatherRegime: normalized.entryMarketWeatherRegime,
    entryMarketWeatherTrendSide: normalized.entryMarketWeatherTrendSide,
    entryMarketWeatherKnown: normalized.entryMarketWeatherKnown,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherCapturedAt: normalized.capturedAt || now(),
    entryMarketWeatherSource: normalized.source
  };
}

function resolveCandidateEntryMarketWeather(candidate = {}, scannerMarketWeather = {}) {
  const candidateWeather = normalizeMarketWeatherSnapshot({
    entryMarketWeatherKey: candidate.entryMarketWeatherKey,
    confirmedMarketWeatherKey: candidate.confirmedMarketWeatherKey,
    currentMarketWeatherKey: candidate.currentMarketWeatherKey,
    marketWeatherKey: candidate.marketWeatherKey,

    entryMarketWeatherRegime: candidate.entryMarketWeatherRegime,
    confirmedMarketWeatherRegime: candidate.confirmedMarketWeatherRegime,
    currentMarketWeatherRegime: candidate.currentMarketWeatherRegime,
    currentRegime: candidate.currentRegime,

    entryMarketWeatherTrendSide: candidate.entryMarketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: candidate.confirmedMarketWeatherTrendSide,
    currentMarketWeatherTrendSide: candidate.currentMarketWeatherTrendSide,
    currentTrendSide: candidate.currentTrendSide,

    source: 'CANDIDATE_EXISTING_MARKET_WEATHER',
    capturedAt: candidate.entryMarketWeatherCapturedAt || candidate.createdAt || now()
  }, 'CANDIDATE_EXISTING_MARKET_WEATHER');

  if (candidateWeather.known) {
    return candidateWeather;
  }

  const scannerWeather = normalizeMarketWeatherSnapshot(
    scannerMarketWeather,
    scannerMarketWeather.source || 'SCANNER_CONFIRMED_MARKET_WEATHER'
  );

  if (scannerWeather.known) {
    return {
      ...scannerWeather,
      source: scannerWeather.source || 'SCANNER_CONFIRMED_MARKET_WEATHER',
      candidatePartialWeatherIgnored: (
        candidate.entryMarketWeatherKey &&
        !marketWeatherKnown(candidate.entryMarketWeatherKey)
      )
        ? candidate.entryMarketWeatherKey
        : null
    };
  }

  return makeUnknownMarketWeather('CANDIDATE_AND_SCANNER_MARKET_WEATHER_UNKNOWN');
}

function namespacedShortKey(key, fallback) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return `${SHORT_KEY_PREFIX}${String(fallback || '').trim()}`;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function callMaybe(fn, arg, fallback = null) {
  try {
    if (typeof fn !== 'function') return fallback;

    const value = fn(arg);

    return value || fallback;
  } catch {
    return fallback;
  }
}

function snapshotKeyFromValue(value, snapshotId) {
  if (!value) return null;

  const text = String(value).trim();

  if (!text) return null;

  return text.includes('*')
    ? text.replaceAll('*', snapshotId)
    : text;
}

function shortScanLatestKey(options = {}) {
  return namespacedShortKey(
    options.keys?.scanLatest ||
      options.scanLatest ||
      KEYS.short?.scan?.latest ||
      KEYS.scan?.shortLatest ||
      KEYS.scan?.latest,
    'SCAN:LATEST'
  );
}

function shortScanSnapshotKey(snapshotId, options = {}) {
  const fromOptions =
    snapshotKeyFromValue(options.keys?.scanSnapshot, snapshotId) ||
    snapshotKeyFromValue(options.keys?.scanSnapshotPattern, snapshotId) ||
    snapshotKeyFromValue(options.scanSnapshot, snapshotId) ||
    snapshotKeyFromValue(options.scanSnapshotPattern, snapshotId);

  const fromShortKeys =
    callMaybe(KEYS.short?.scan?.snapshot, snapshotId, null) ||
    callMaybe(KEYS.scan?.shortSnapshot, snapshotId, null);

  const fromGeneric = callMaybe(KEYS.scan?.snapshot, snapshotId, null);

  return namespacedShortKey(
    fromOptions ||
      fromShortKeys ||
      fromGeneric,
    `SCAN:SNAPSHOT:${snapshotId}`
  );
}

function marketUniverseKeys(options = {}) {
  return [
    options.keys?.marketUniverseLatest,
    options.marketUniverseLatest,
    KEYS.short?.market?.universeLatest,
    KEYS.short?.scan?.universeLatest,
    KEYS.market?.shortUniverseLatest,
    KEYS.scan?.shortUniverseLatest,
    MARKET_UNIVERSE_KEY,
    SHORT_MARKET_UNIVERSE_KEY
  ]
    .map((key) => String(key || '').trim())
    .filter(Boolean)
    .map((key) => namespacedShortKey(key, key))
    .filter((key, index, arr) => arr.indexOf(key) === index);
}

function marketWeatherKeys(options = {}) {
  return [
    options.keys?.marketWeatherLatest,
    options.marketWeatherLatest,
    KEYS.short?.market?.weatherLatest,
    KEYS.short?.scan?.weatherLatest,
    KEYS.market?.shortWeatherLatest,
    KEYS.scan?.shortWeatherLatest,
    MARKET_WEATHER_KEY,
    SHORT_MARKET_WEATHER_KEY
  ]
    .map((key) => String(key || '').trim())
    .filter(Boolean)
    .map((key) => namespacedShortKey(key, key))
    .filter((key, index, arr) => arr.indexOf(key) === index);
}

function scopeFlags() {
  return {
    runScope: SCANNER_RUN_SCOPE,
    writeScope: SCANNER_WRITE_SCOPE,

    scannerOnly: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,

    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true,

    writesScanner: true,
    writesScannerLatest: true,
    writesScannerSnapshot: true,
    writesMarketUniverse: true,
    writesMarketWeather: true,
    writesMarketWeatherInput: true,

    writesTrade: false,
    writesAnalyze: false,
    writesLearningFamilies: false,
    writesMicroFamilies: false,
    writesPositions: false,
    writesRotation: false,
    writesDiscordSelection: false,
    writesRealOrders: false,
    writesExchangeOrders: false,
    writesBitgetOrders: false,

    readOnlyForTrade: true,
    readOnlyForAnalyze: true,
    readOnlyForLearningFamilies: true,
    readOnlyForMicroFamilies: true,
    readOnlyForRotation: true,
    readOnlyForDiscordSelection: true,

    adminPageIsolation: true,
    doesNotOverwriteOtherAdminPages: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function learningFlags() {
  return {
    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noExchangeOrders: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerBucketsMetadataOnly: true,
    scannerBucketsDebugOnly: true,
    old25BucketsDebugOnly: true,

    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintRole: 'METADATA_ONLY',

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    fixedTaxonomyPreferred: true,

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,
    discordOnlyForSelectedMicroFamilies: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    marketWeatherCaptureEnabled: true,
    scannerCandidatesReceiveEntryMarketWeatherKey: true,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherExcludedFromFamilyId: true,
    marketWeatherDoesNotChangeScannerFingerprint: true,

    riskTradeSide: TARGET_TRADE_SIDE,
    shortRiskShape: 'tp < entry < sl',
    validShortRiskShape: 'entry > 0 && tp < entry && sl > entry',
    validShortGeometry: 'tp < entry < sl',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortExitRules: {
      tp: 'price <= tp',
      sl: 'price >= sl',
      timeStop: 'TIME_STOP'
    },

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

function sideFlags() {
  return {
    sideMode: 'SHORT_ONLY',
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

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    outcomeSource: 'VIRTUAL',

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    globalMaxOpenPositionsBlockDisabled: true,
    ignoreMaxOpenPositionsForLearning: true,
    oneOpenPositionPerSymbol: true,
    maxOneOpenPositionPerSymbol: true,

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,

    observationFirst: true,
    observationAlwaysCounted: false,
    observationDedupeRequired: true,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    observingStatusRule: 'completed = 0',
    earlyOutcomesStatusRule: 'completed > 0 && completed < 20',
    activeLearningStatusRule: 'completed >= 20',

    defaultRanking: 'dashboardBalancedScore/balancedScore/fairWinrate/totalR/avgR/avgCostR',
    noBareWinrateRanking: true,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    positionTimeStopMin: Math.max(
      1,
      Math.floor(safeNumber(CONFIG.short?.trade?.positionTimeStopMin ?? CONFIG.trade?.positionTimeStopMin, DEFAULT_POSITION_TIME_STOP_MIN))
    ),

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,
    bucketGranularity: 'LOW_MID_HIGH',

    marketWeatherCaptureEnabled: true,
    scannerCapturesConfirmedMarketWeather: true,
    scannerCandidatesReceiveEntryMarketWeatherKey: true,
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherExcludedFromFamilyId: true,
    marketWeatherDoesNotChangeScannerFingerprint: true,
    unknownWeatherDoesNotOverrideKnownWeather: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    ...learningFlags()
  };
}

function cfgNumber(pathValue, fallback) {
  const value = safeNumber(pathValue, fallback);

  return Number.isFinite(value) ? value : fallback;
}

function cfgBoolean(pathValue, fallback = false) {
  if (pathValue === undefined || pathValue === null || pathValue === '') {
    return fallback;
  }

  const normalized = String(pathValue).trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  return fallback;
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.floor(cfgNumber(value, fallback));

  return Math.max(min, Math.min(max, n));
}

function scannerConcurrency() {
  return positiveInt(
    CONFIG.scanner?.dataConcurrency ||
      CONFIG.trade?.dataConcurrency,
    8,
    1,
    20
  );
}

function scannerMaxSymbols() {
  const configured = cfgNumber(CONFIG.scanner?.maxSymbols, 0);
  const analyzeMax = cfgNumber(
    CONFIG.scanner?.analyzeMaxSymbols ??
      CONFIG.scanner?.maxAnalyzeSymbols ??
      CONFIG.scanner?.maxUniverseSymbols,
    DEFAULT_ANALYZE_SYMBOLS
  );

  return positiveInt(
    Math.max(configured, analyzeMax, DEFAULT_ANALYZE_SYMBOLS),
    DEFAULT_ANALYZE_SYMBOLS,
    1,
    1000
  );
}

function scannerMaxCandidates() {
  const configured = cfgNumber(CONFIG.scanner?.maxCandidates, 0);
  const analyzeMax = cfgNumber(
    CONFIG.scanner?.analyzeMaxCandidates ??
      CONFIG.scanner?.maxAnalyzeCandidates,
    DEFAULT_MAX_CANDIDATES
  );

  return positiveInt(
    Math.max(configured, analyzeMax, DEFAULT_MAX_CANDIDATES),
    DEFAULT_MAX_CANDIDATES,
    1,
    1000
  );
}

function marketUniverseMaxSymbols() {
  return positiveInt(
    CONFIG.short?.marketWeather?.universeLimit ??
      CONFIG.marketWeather?.universeLimit ??
      CONFIG.scanner?.marketUniverseSymbols ??
      CONFIG.scanner?.marketWeatherUniverseSymbols,
    DEFAULT_MARKET_UNIVERSE_SYMBOLS,
    10,
    300
  );
}

function marketUniverseTtlSec() {
  return positiveInt(
    CONFIG.short?.marketWeather?.universeTtlSec ??
      CONFIG.marketWeather?.universeTtlSec ??
      CONFIG.scanner?.marketUniverseTtlSec,
    DEFAULT_MARKET_UNIVERSE_TTL_SEC,
    30,
    3600
  );
}

function marketWeatherTtlSec() {
  return positiveInt(
    CONFIG.short?.marketWeather?.weatherTtlSec ??
      CONFIG.marketWeather?.weatherTtlSec ??
      CONFIG.scanner?.marketWeatherTtlSec,
    DEFAULT_MARKET_WEATHER_TTL_SEC,
    30,
    3600
  );
}

function marketUniverseMinVolume24h() {
  return Math.max(
    0,
    cfgNumber(
      CONFIG.short?.marketWeather?.minQuoteVolume24h ??
        CONFIG.marketWeather?.minQuoteVolume24h ??
        CONFIG.scanner?.marketUniverseMinQuoteVolume24h,
      DEFAULT_MARKET_UNIVERSE_MIN_VOLUME_24H
    )
  );
}

function minQuoteVolume24h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.minQuoteVolume24h, DEFAULT_MIN_QUOTE_VOLUME_24H)
  );
}

function softMinQuoteVolume24h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.softMinQuoteVolume24h, DEFAULT_SOFT_MIN_QUOTE_VOLUME_24H)
  );
}

function minAbsChange1h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.minAbsChange1h, 0.12)
  );
}

function minAbsChange24h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.minAbsChange24h, 0.35)
  );
}

function strictScannerFiltersEnabled() {
  return cfgBoolean(CONFIG.scanner?.strictFilters, false);
}

function blockFakeBreakoutEnabled() {
  return cfgBoolean(CONFIG.scanner?.blockFakeBreakout, false);
}

function blockNoDirectionEnabled() {
  return cfgBoolean(CONFIG.scanner?.blockNoDirection, false);
}

function blockSmallMoveEnabled() {
  return cfgBoolean(CONFIG.scanner?.blockSmallMove, false);
}

function snapshotTtlSec() {
  return positiveInt(
    CONFIG.scanner?.snapshotTtlSec,
    30 * 60,
    60,
    24 * 3600
  );
}

function candleLimit() {
  return positiveInt(
    CONFIG.scanner?.candleLimit,
    100,
    30,
    500
  );
}

function fakeBreakoutLookback() {
  return positiveInt(
    CONFIG.scanner?.fakeBreakoutLookback,
    24,
    5,
    200
  );
}

function stripUsdtQuote(symbol = '') {
  const value = String(symbol || '').trim().toUpperCase();

  if (!value.endsWith('USDT')) return value;

  return value.slice(0, -4);
}

function isBlockedBaseSymbol(baseSymbol = '') {
  const base = String(baseSymbol || '').trim().toUpperCase();

  if (!base) return true;

  return BLOCKED_BASE_SYMBOLS.has(base);
}

function isValidUsdtFuturesContractSymbol(symbol = '') {
  const value = String(symbol || '').trim().toUpperCase();

  if (!value) return false;
  if (value === 'USDT') return false;
  if (!value.endsWith('USDT')) return false;
  if (!/^[A-Z0-9]+USDT$/.test(value)) return false;

  const base = stripUsdtQuote(value);

  return !isBlockedBaseSymbol(base);
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = safeNumber(value, 0);

    if (n > 0) return n;
  }

  return 0;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = safeNumber(value, NaN);

    if (Number.isFinite(n)) return n;
  }

  return 0;
}

function normalizeScannerTicker(rawTicker = {}) {
  const parsed = parseTicker(rawTicker);

  const contractSymbol = normalizeContractSymbol(
    parsed.contractSymbol ||
      parsed.symbol ||
      rawTicker.contractSymbol ||
      rawTicker.symbol ||
      rawTicker.instId ||
      rawTicker.contractCode ||
      rawTicker.symbolName
  );

  if (!isValidUsdtFuturesContractSymbol(contractSymbol)) return null;

  const derivedBaseSymbol = stripUsdtQuote(contractSymbol);

  const parsedBaseSymbol = normalizeBaseSymbol(
    parsed.baseSymbol ||
      rawTicker.baseSymbol ||
      derivedBaseSymbol
  );

  const baseSymbol = isBlockedBaseSymbol(parsedBaseSymbol)
    ? derivedBaseSymbol
    : parsedBaseSymbol;

  if (isBlockedBaseSymbol(baseSymbol)) return null;

  const price = firstPositiveNumber(
    parsed.price,
    rawTicker.price,
    rawTicker.lastPr,
    rawTicker.last,
    rawTicker.close,
    rawTicker.markPrice,
    rawTicker.indexPrice
  );

  const baseVolume = firstPositiveNumber(
    rawTicker.baseVolume,
    rawTicker.baseVol,
    rawTicker.volume,
    rawTicker.vol,
    parsed.baseVolume
  );

  const quoteVolumeRaw = firstPositiveNumber(
    parsed.volume24h,
    rawTicker.volume24h,
    rawTicker.quoteVolume,
    rawTicker.quoteVol,
    rawTicker.usdtVolume,
    rawTicker.turnover,
    rawTicker.quoteTurnover
  );

  const volume24h = quoteVolumeRaw > 0
    ? quoteVolumeRaw
    : baseVolume * price;

  const rawChange = firstFiniteNumber(
    parsed.change24h,
    rawTicker.change24h,
    rawTicker.changeUtc24h,
    rawTicker.priceChangePercent,
    rawTicker.priceChange24h,
    rawTicker.chgUtc
  );

  const change24h = Math.abs(rawChange) <= 1
    ? rawChange * 100
    : rawChange;

  return {
    ...parsed,
    symbol: contractSymbol,
    contractSymbol,
    baseSymbol,
    price,
    volume24h,
    quoteVolume: volume24h,
    quoteVolume24h: volume24h,
    baseVolume,
    change24h,
    raw: rawTicker.raw || rawTicker,

    ...sideFlags(),
    scannerOnly: true,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true
  };
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

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE', 'RED'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE', 'GREEN'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromText(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const shortHit = (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('POSITION_SIDE=SHORT') ||
    text.includes('POSITIONSIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.startsWith('SHORT_') ||
    text.includes('_SHORT_') ||
    text.endsWith('_SHORT') ||
    text.startsWith('BEAR_') ||
    text.includes('_BEAR_') ||
    text.endsWith('_BEAR') ||
    text.startsWith('SELL_') ||
    text.includes('_SELL_') ||
    text.endsWith('_SELL')
  );

  const longHit = (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('POSITION_SIDE=LONG') ||
    text.includes('POSITIONSIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.startsWith('LONG_') ||
    text.includes('_LONG_') ||
    text.endsWith('_LONG') ||
    text.startsWith('BULL_') ||
    text.includes('_BULL_') ||
    text.endsWith('_BULL') ||
    text.startsWith('BUY_') ||
    text.includes('_BUY_') ||
    text.endsWith('_BUY')
  );

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
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
      row.side
  );

  if (direct !== 'UNKNOWN') return direct;

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
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
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');

  return inferTradeSideFromText(haystack);
}

function isTargetCandidate(candidate = {}) {
  return inferRowTradeSide(candidate) === TARGET_TRADE_SIDE;
}

function isOppositeCandidate(candidate = {}) {
  return inferRowTradeSide(candidate) === OPPOSITE_TRADE_SIDE;
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

function calcChangePct(first, last) {
  const a = safeNumber(first, 0);
  const b = safeNumber(last, 0);

  if (a <= 0 || b <= 0) return 0;

  return ((b - a) / a) * 100;
}

function calcOneHourChange(candles15m) {
  const rows = Array.isArray(candles15m) ? candles15m : [];

  if (rows.length < 5) return 0;

  const first = rows.at(-5)?.close;
  const last = rows.at(-1)?.close;

  return calcChangePct(first, last);
}

function calcRangePct(candles = []) {
  const rows = Array.isArray(candles) ? candles.slice(-24) : [];

  if (!rows.length) return 0;

  const highs = rows.map((row) => safeNumber(row.high, 0)).filter((value) => value > 0);
  const lows = rows.map((row) => safeNumber(row.low, 0)).filter((value) => value > 0);
  const last = safeNumber(rows.at(-1)?.close, 0);

  if (!highs.length || !lows.length || last <= 0) return 0;

  const high = Math.max(...highs);
  const low = Math.min(...lows);

  if (high <= 0 || low <= 0 || high <= low) return 0;

  return ((high - low) / last) * 100;
}

function calcRealizedVolPct(candles = []) {
  const rows = Array.isArray(candles) ? candles.slice(-24) : [];

  if (rows.length < 3) return 0;

  const returns = [];

  for (let i = 1; i < rows.length; i += 1) {
    const prev = safeNumber(rows[i - 1]?.close, 0);
    const cur = safeNumber(rows[i]?.close, 0);

    if (prev > 0 && cur > 0) {
      returns.push(((cur - prev) / prev) * 100);
    }
  }

  if (!returns.length) return 0;

  const avgValue = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - avgValue) ** 2, 0) / returns.length;

  return Math.sqrt(variance);
}

function isRisingMove({ change1h, change24h }) {
  return safeNumber(change1h, 0) > 0 || safeNumber(change24h, 0) > 0;
}

function isFallingMove({ change1h, change24h }) {
  return safeNumber(change1h, 0) < 0 || safeNumber(change24h, 0) < 0;
}

function inferSide({ change1h, change24h, btcState }) {
  const ch1 = safeNumber(change1h, 0);
  const ch24 = safeNumber(change24h, 0);

  if (isRisingMove({ change1h: ch1, change24h: ch24 })) {
    return 'neutral';
  }

  const min1 = minAbsChange1h();
  const min24 = minAbsChange24h();

  if (ch1 <= -min1) return TARGET_SCANNER_SIDE;
  if (ch24 <= -min24) return TARGET_SCANNER_SIDE;

  if (ch1 < 0 && ch24 <= 0) return TARGET_SCANNER_SIDE;
  if (ch24 < 0 && ch1 <= 0) return TARGET_SCANNER_SIDE;

  const state = String(btcState || '').toUpperCase();

  if (state.includes('BEAR') && (ch1 < 0 || ch24 < 0)) {
    return TARGET_SCANNER_SIDE;
  }

  return 'neutral';
}

function sideConfidence({ side, change1h, change24h }) {
  if (side !== TARGET_SCANNER_SIDE) return 'LOW';

  const down1h = Math.max(0, -safeNumber(change1h, 0));
  const down24h = Math.max(0, -safeNumber(change24h, 0));

  if (down1h >= minAbsChange1h() * 2 || down24h >= minAbsChange24h() * 2) return 'HIGH';
  if (down1h >= minAbsChange1h() || down24h >= minAbsChange24h()) return 'MID';

  return 'LOW';
}

function safeToken(value, fallback = 'NA') {
  const token = String(value || fallback)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return token || fallback;
}

function bucketSignedChange(value, prefix = 'MOVE') {
  const n = safeNumber(value, 0);
  const abs = Math.abs(n);
  const direction = n < 0 ? 'DOWN' : n > 0 ? 'UP' : 'FLAT';

  if (abs >= 5) return `${prefix}_${direction}_XL`;
  if (abs >= 2.5) return `${prefix}_${direction}_L`;
  if (abs >= 1) return `${prefix}_${direction}_M`;
  if (abs >= 0.35) return `${prefix}_${direction}_S`;

  return `${prefix}_${direction}_XS`;
}

function bucketVolumeExpansion(value) {
  const n = safeNumber(value, 1);

  if (n >= 2) return 'VOL_EXP_XL';
  if (n >= 1.5) return 'VOL_EXP_L';
  if (n >= 1.25) return 'VOL_EXP_M';
  if (n >= 1.15) return 'VOL_EXP_S';

  return 'VOL_EXP_LOW';
}

function buildScannerFingerprint({
  baseSymbol,
  scannerReason,
  sideConfidenceLevel,
  change1h,
  change24h,
  volumeExpansion,
  btcState,
  regime,
  fakeBreakout,
  fakeBreakoutRisk,
  breakoutType,
  pullbackConfirmed,
  retestConfirmed,
  sweepConfirmed,
  scannerGatePassed,
  analyzeEligible,
  tradeDiscoveryOnly
}) {
  const symbol = safeToken(baseSymbol, 'COIN');
  const reason = safeToken(scannerReason, 'SHORT_ANALYZE_DISCOVERY');
  const confidence = safeToken(sideConfidenceLevel, 'LOW');
  const btc = safeToken(btcState, 'BTC_NEUTRAL');
  const volRegime = safeToken(regime, 'NORMAL_VOL');

  const move1h = bucketSignedChange(change1h, 'M1H');
  const move24h = bucketSignedChange(change24h, 'M24H');
  const vol = bucketVolumeExpansion(volumeExpansion);

  const fakeState = fakeBreakout
    ? 'FAKE_BREAKDOWN'
    : fakeBreakoutRisk
      ? 'FAKE_RISK'
      : 'FAKE_CLEAN';

  const breakout = safeToken(breakoutType, 'NO_BREAKDOWN');
  const pullback = pullbackConfirmed ? 'PULLBACK' : 'NO_PULLBACK';
  const retest = retestConfirmed ? 'RETEST' : 'NO_RETEST';
  const sweep = sweepConfirmed ? 'SWEEP' : 'NO_SWEEP';

  const gate = scannerGatePassed
    ? 'SCANNER_GATE_PASS'
    : analyzeEligible
      ? 'ANALYZE_ONLY'
      : 'DISCOVERY_ONLY';

  const scannerFamilyId = `SHORT_SCANNER_${reason}`;

  const scannerMacroFamilyId = [
    'MICRO_SHORT_SCANNER',
    reason,
    confidence,
    btc,
    volRegime
  ].join('__');

  const scannerMicroFamilyId = [
    scannerMacroFamilyId,
    move1h,
    move24h,
    vol,
    fakeState,
    breakout,
    pullback,
    retest,
    sweep,
    gate
  ].join('__');

  const scannerMacroDefinitionParts = [
    'tradeSide=SHORT',
    'side=SHORT',
    'scannerSide=bear',
    `scannerReason=${reason}`,
    `sideConfidence=${confidence}`,
    `btcState=${btc}`,
    `regime=${volRegime}`
  ];

  const scannerMicroDefinitionParts = [
    ...scannerMacroDefinitionParts,
    `symbol=${symbol}`,
    `change1hBucket=${move1h}`,
    `change24hBucket=${move24h}`,
    `volumeExpansionBucket=${vol}`,
    `fakeState=${fakeState}`,
    `breakout=${breakout}`,
    pullback,
    retest,
    sweep,
    gate,
    tradeDiscoveryOnly ? 'tradeDiscoveryOnly=true' : 'tradeDiscoveryOnly=false',
    'scannerFingerprintRole=METADATA_ONLY',
    'scannerFingerprintsUsedAsLearningFamily=false',
    'analyzeAssignsTrueMicroFamily=true'
  ];

  return {
    familyId: null,
    baseFamilyId: null,

    microFamilyId: null,
    trueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
    parentTrueMicroFamilyId: null,
    coarseMicroFamilyId: null,

    analyzeMicroFamilyId: null,
    learningMicroFamilyId: null,
    fixedTaxonomyMicroFamilyId: null,
    broadTrueMicroFamilyId: null,

    scannerFamilyId,
    scannerMacroFamilyId,
    scannerMicroFamilyId,

    scannerDefinition: scannerMicroFamilyId,
    scannerDefinitionParts: scannerMicroDefinitionParts,
    scannerMacroDefinition: scannerMacroFamilyId,
    scannerMacroDefinitionParts,

    scannerBucketId: scannerMicroFamilyId,
    scannerMacroBucketId: scannerMacroFamilyId,
    scannerFamilySource: 'SCANNER_DISCOVERY',
    scannerFingerprintVersion: 'short_scanner_v6_metadata_only_market_weather_safe',
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerDiscoveryOnly: true,

    legacyScannerFamilyId: scannerFamilyId,
    legacyScannerMacroFamilyId: scannerMacroFamilyId,
    legacyScannerMicroFamilyId: scannerMicroFamilyId,
    old25BucketId: null,
    old25BucketRole: 'DEBUG_METADATA_ONLY',

    definition: scannerMicroFamilyId,
    microDefinition: scannerMicroFamilyId,
    macroDefinition: scannerMacroFamilyId,
    parentDefinition: scannerMacroFamilyId,
    definitionParts: scannerMicroDefinitionParts,
    microDefinitionParts: scannerMicroDefinitionParts,
    macroDefinitionParts: scannerMacroDefinitionParts,
    parentDefinitionParts: scannerMacroDefinitionParts,

    executionFingerprintParts: [],
    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analysisNeedsTrueMicroFamily: true,
    analyzeWillAssignExact75Child: true,
    trueMicroFamilyAssignedBy: 'ANALYZE_ENGINE',
    scannerHashExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    symbolExcludedFromFamilyId: true,
    marketWeatherExcludedFromFamilyId: true,
    marketWeatherDoesNotChangeScannerFingerprint: true,

    ...learningFlags()
  };
}

function calcScannerScore({
  change1h,
  change24h,
  volume24h,
  volumeExpansion,
  fakeBreakoutRisk,
  fakeBreakout,
  pullbackConfirmed,
  sweepConfirmed,
  retestConfirmed,
  breakoutType,
  sideConfidenceLevel
}) {
  let score = 0;

  const down1h = Math.max(0, -safeNumber(change1h, 0));
  const down24h = Math.max(0, -safeNumber(change24h, 0));

  score += Math.min(35, down1h * 12);
  score += Math.min(22, down24h * 2.7);
  score += Math.min(20, Math.log10(Math.max(10, safeNumber(volume24h, 0))) * 2.0);

  if (safeNumber(volumeExpansion, 1) >= 1.15) score += 3;
  if (safeNumber(volumeExpansion, 1) >= 1.25) score += 6;
  if (safeNumber(volumeExpansion, 1) >= 1.75) score += 4;

  if (pullbackConfirmed) score += 7;
  if (retestConfirmed) score += 5;
  if (sweepConfirmed) score += 3;
  if (breakoutType === 'VALID_BREAKOUT' || breakoutType === 'VALID_BREAKDOWN') score += 4;

  if (sideConfidenceLevel === 'HIGH') score += 5;
  if (sideConfidenceLevel === 'MID') score += 2;
  if (sideConfidenceLevel === 'LOW') score -= 2;

  if (fakeBreakoutRisk) score -= 8;
  if (fakeBreakout) score -= 7;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scannerReasonFrom({
  fake,
  volumeExpansion,
  passesMoveFilter,
  sideConfidenceLevel
}) {
  if (fake?.pullbackConfirmed && fake?.retestConfirmed) return 'SHORT_MOMENTUM_PULLBACK_RETEST';
  if (fake?.pullbackConfirmed) return 'SHORT_MOMENTUM_PULLBACK';
  if (fake?.breakoutType === 'VALID_BREAKOUT' || fake?.breakoutType === 'VALID_BREAKDOWN') return 'SHORT_VALID_BREAKDOWN';
  if (volumeExpansion >= 1.5) return 'SHORT_VOLUME_EXPANSION';
  if (passesMoveFilter) return 'SHORT_MOMENTUM_EXPANSION';
  if (sideConfidenceLevel === 'LOW') return 'SHORT_WEAK_DIRECTION_ANALYZE_ONLY';

  return 'SHORT_ANALYZE_DISCOVERY';
}

function cleanFakeResult(fake = {}) {
  return {
    fakeBreakout: Boolean(fake.fakeBreakout),
    fakeBreakoutRisk: Boolean(fake.fakeBreakoutRisk),
    fakeBreakoutReason: fake.fakeBreakoutReason || null,
    breakoutType: fake.breakoutType || 'UNKNOWN',
    pullbackConfirmed: Boolean(fake.pullbackConfirmed),
    sweepConfirmed: Boolean(fake.sweepConfirmed),
    retestConfirmed: Boolean(fake.retestConfirmed)
  };
}

function isTradableTicker(ticker) {
  if (!ticker?.symbol) return false;
  if (!ticker?.contractSymbol) return false;
  if (!ticker?.baseSymbol) return false;

  if (!isValidUsdtFuturesContractSymbol(ticker.contractSymbol)) return false;
  if (isBlockedBaseSymbol(ticker.baseSymbol)) return false;

  if (safeNumber(ticker.price, 0) <= 0) return false;

  const volume24h = safeNumber(ticker.volume24h, 0);
  const hardMinVolume = strictScannerFiltersEnabled()
    ? minQuoteVolume24h()
    : softMinQuoteVolume24h();

  return volume24h >= hardMinVolume;
}

function isMarketUniverseTicker(ticker) {
  if (!ticker?.symbol) return false;
  if (!ticker?.contractSymbol) return false;
  if (!ticker?.baseSymbol) return false;

  if (!isValidUsdtFuturesContractSymbol(ticker.contractSymbol)) return false;
  if (isBlockedBaseSymbol(ticker.baseSymbol)) return false;
  if (safeNumber(ticker.price, 0) <= 0) return false;

  return safeNumber(ticker.volume24h, 0) >= marketUniverseMinVolume24h();
}

function dedupeByBaseSymbol(tickers) {
  const byBase = new Map();

  for (const ticker of tickers) {
    const normalized = normalizeScannerTicker(ticker);

    if (!normalized) continue;

    const baseSymbol = normalized.baseSymbol;
    const contractSymbol = normalized.contractSymbol;

    if (!baseSymbol || !contractSymbol) continue;
    if (isBlockedBaseSymbol(baseSymbol)) continue;
    if (!isValidUsdtFuturesContractSymbol(contractSymbol)) continue;

    const existing = byBase.get(baseSymbol);

    if (!existing || safeNumber(normalized.volume24h, 0) > safeNumber(existing.volume24h, 0)) {
      byBase.set(baseSymbol, normalized);
    }
  }

  return [...byBase.values()];
}

function shortUniverseScore(ticker = {}) {
  const change24h = safeNumber(ticker.change24h, 0);
  const volume24h = safeNumber(ticker.volume24h, 0);

  if (change24h > 0) return -1_000_000 - change24h;

  const bearishPressure = Math.abs(change24h) * 120;
  const volumeScore = Math.log10(Math.max(10, volume24h)) * 4;

  return bearishPressure + volumeScore;
}

function sortShortUniverse(a, b) {
  const scoreDelta = shortUniverseScore(b) - shortUniverseScore(a);

  if (scoreDelta !== 0) return scoreDelta;

  return safeNumber(b.volume24h, 0) - safeNumber(a.volume24h, 0);
}

function sortMarketUniverse(a, b) {
  return (
    safeNumber(b.volume24h, 0) - safeNumber(a.volume24h, 0) ||
    Math.abs(safeNumber(b.change24h, 0)) - Math.abs(safeNumber(a.change24h, 0)) ||
    String(a.symbol || '').localeCompare(String(b.symbol || ''))
  );
}

function buildTickerUniverse(rawTickers) {
  return dedupeByBaseSymbol(
    (Array.isArray(rawTickers) ? rawTickers : [])
      .map(normalizeScannerTicker)
      .filter(Boolean)
      .filter(isTradableTicker)
      .filter((ticker) => safeNumber(ticker.change24h, 0) <= 0)
  )
    .sort(sortShortUniverse)
    .slice(0, scannerMaxSymbols());
}

function buildRawMarketUniverse(rawTickers) {
  return dedupeByBaseSymbol(
    (Array.isArray(rawTickers) ? rawTickers : [])
      .map(normalizeScannerTicker)
      .filter(Boolean)
      .filter(isMarketUniverseTicker)
  )
    .sort(sortMarketUniverse)
    .slice(0, marketUniverseMaxSymbols());
}

function createCandleCache() {
  const cache = new Map();

  return async function getCandles(symbol, timeframe = '15m', limit = candleLimit()) {
    const contractSymbol = normalizeContractSymbol(symbol);
    const requestedLimit = Math.max(30, Math.floor(safeNumber(limit, candleLimit())));

    if (!isValidUsdtFuturesContractSymbol(contractSymbol)) {
      return [];
    }

    const key = `${contractSymbol}:${timeframe}:${requestedLimit}`;

    if (cache.has(key)) return cache.get(key);

    const promise = fetchCandles(contractSymbol, timeframe, requestedLimit).catch(() => []);
    cache.set(key, promise);

    return promise;
  };
}

async function buildMarketUniverseRows({
  rawTickers,
  getCandles,
  snapshotId,
  startedAt
}) {
  const baseUniverse = buildRawMarketUniverse(rawTickers);

  const rows = await mapConcurrent(
    baseUniverse,
    scannerConcurrency(),
    async (ticker) => {
      const candles15m = await getCandles(
        ticker.contractSymbol,
        '15m',
        Math.max(30, candleLimit())
      );

      const change1h = candles15m.length >= 5
        ? calcOneHourChange(candles15m)
        : 0;

      const atrPct = calculateAtrPct(candles15m, 14);
      const rangePct = calcRangePct(candles15m);
      const realizedVolPct = calcRealizedVolPct(candles15m);
      const volumeExpansion = calcVolumeExpansion(candles15m, 20);

      return {
        symbol: ticker.symbol,
        contractSymbol: ticker.contractSymbol,
        baseSymbol: ticker.baseSymbol,

        price: safeNumber(ticker.price, 0),

        change1h: Number(change1h.toFixed(4)),
        change24h: Number(safeNumber(ticker.change24h, 0).toFixed(4)),

        quoteVolume: safeNumber(ticker.volume24h, 0),
        quoteVolume24h: safeNumber(ticker.volume24h, 0),
        volume24h: safeNumber(ticker.volume24h, 0),
        baseVolume: safeNumber(ticker.baseVolume, 0),

        atrPct: Number(safeNumber(atrPct, 0).toFixed(6)),
        rangePct: Number(safeNumber(rangePct, 0).toFixed(6)),
        realizedVolPct: Number(safeNumber(realizedVolPct, 0).toFixed(6)),
        volumeExpansion: Number(safeNumber(volumeExpansion, 1).toFixed(4)),

        scannerSide: 'market',
        actualScannerSide: 'market',
        marketUniverseRole: 'MARKET_WEATHER_INPUT',
        marketWeatherInput: true,
        usedForMarketWeather: true,

        source: 'SCANNER_MARKET_UNIVERSE',
        snapshotId,
        ts: startedAt,
        updatedAt: now()
      };
    }
  );

  return rows.filter(Boolean);
}

async function buildBtcContext({ universe, getCandles }) {
  const btcTicker =
    universe.find((row) => row.baseSymbol === 'BTC') ||
    normalizeScannerTicker({
      symbol: 'BTCUSDT',
      last: 0,
      quoteVolume: 0,
      change24h: 0
    }) ||
    {
      symbol: 'BTCUSDT',
      contractSymbol: 'BTCUSDT',
      baseSymbol: 'BTC',
      price: 0,
      volume24h: 0,
      change24h: 0
    };

  const btcCandles15m = await getCandles(
    'BTCUSDT',
    '15m',
    candleLimit()
  );

  const btcChange1h = calcOneHourChange(btcCandles15m);
  const btcChange24h = safeNumber(btcTicker.change24h, 0);

  const btcState = classifyBtcState({
    change24: btcChange24h,
    change1h: btcChange1h
  });

  const btcAtrPct = calculateAtrPct(btcCandles15m, 14);
  const volRegime = classifyVolatilityRegime(btcCandles15m, btcAtrPct);

  const regime =
    volRegime === 'EXTREME_VOL' ? 'HIGH_VOL' :
    volRegime === 'HIGH_VOL' ? 'HIGH_VOL' :
    volRegime === 'LOW_VOL' ? 'LOW_VOL' :
    'NORMAL_VOL';

  return {
    btcState,
    regime,
    btcChange1h: Number(btcChange1h.toFixed(3)),
    btcChange24h: Number(btcChange24h.toFixed(3)),
    btcAtrPct: Number(btcAtrPct.toFixed(6))
  };
}

function buildGateFlags({
  change1h,
  change24h,
  fake,
  side,
  volume24h
}) {
  const ch1 = safeNumber(change1h, 0);
  const ch24 = safeNumber(change24h, 0);

  const passesMoveFilter =
    ch1 <= -minAbsChange1h() ||
    ch24 <= -minAbsChange24h();

  const passesVolumeFilter = safeNumber(volume24h, 0) >= minQuoteVolume24h();
  const hasDirectionalSide = side === TARGET_SCANNER_SIDE;
  const risingMove = isRisingMove({ change1h: ch1, change24h: ch24 });

  const hardBlockedByDirection =
    blockNoDirectionEnabled() &&
    (!hasDirectionalSide || risingMove);

  const hardBlockedByMove =
    blockSmallMoveEnabled() &&
    !passesMoveFilter;

  const hardBlockedByFake =
    blockFakeBreakoutEnabled() &&
    Boolean(fake.fakeBreakout);

  const hardBlocked =
    hardBlockedByDirection ||
    hardBlockedByMove ||
    hardBlockedByFake;

  const scannerGatePassed =
    !hardBlocked &&
    !risingMove &&
    passesMoveFilter &&
    hasDirectionalSide &&
    !fake.fakeBreakout;

  const analyzeEligible =
    !hardBlocked &&
    !risingMove &&
    hasDirectionalSide;

  const tradeDiscoveryOnly =
    !scannerGatePassed;

  return {
    passesMoveFilter,
    passesVolumeFilter,
    hasDirectionalSide,
    risingMove,
    fallingMove: !risingMove && isFallingMove({ change1h: ch1, change24h: ch24 }),

    hardBlocked,
    hardBlockedByDirection,
    hardBlockedByMove,
    hardBlockedByFake,

    scannerGatePassed,
    analyzeEligible,
    tradeDiscoveryOnly,
    discoveryOnly: tradeDiscoveryOnly,
    analyzeOnly: tradeDiscoveryOnly
  };
}

function normalizeShortCandidate(candidate = {}, scannerMarketWeather = {}) {
  const scannerMicroFamilyId = candidate.scannerMicroFamilyId || null;
  const scannerFamilyId = candidate.scannerFamilyId || null;
  const scannerMacroFamilyId = candidate.scannerMacroFamilyId || null;

  const entryWeather = resolveCandidateEntryMarketWeather(candidate, scannerMarketWeather);

  return {
    ...candidate,

    ...marketWeatherCoreFields(entryWeather),
    ...entryMarketWeatherFields(entryWeather),

    scannerMarketWeatherCaptured: entryWeather.known,
    scannerMarketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    scannerCandidateWeatherCaptureSource: entryWeather.source,
    scannerCandidatePartialWeatherIgnored: entryWeather.candidatePartialWeatherIgnored || null,
    scannerCandidatesReceiveEntryMarketWeatherKey: true,
    unknownWeatherDoesNotOverrideKnownWeather: true,

    familyId: validLearningId(candidate.familyId) ? candidate.familyId : null,

    microFamilyId: null,
    trueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
    parentTrueMicroFamilyId: null,
    coarseMicroFamilyId: null,
    analyzeMicroFamilyId: null,
    learningMicroFamilyId: null,

    scannerMicroFamilyId,
    scannerFamilyId,
    scannerMacroFamilyId,

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
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,

    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true,

    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    outcomeSource: 'VIRTUAL',

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    analysisNeedsTrueMicroFamily: true,
    analyzeWillAssignExact75Child: true,

    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,
    marketWeatherExcludedFromFamilyId: true,
    marketWeatherDoesNotChangeScannerFingerprint: true,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    ...learningFlags(),
    ...scopeFlags()
  };
}

async function analyzeTickerCandidate({
  ticker,
  snapshotId,
  startedAt,
  btcState,
  regime,
  getCandles,
  scannerMarketWeather
}) {
  const normalizedTicker = normalizeScannerTicker(ticker);

  if (!normalizedTicker) {
    return {
      candidate: null,
      skippedReason: 'INVALID_SYMBOL',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  const contractSymbol = normalizedTicker.contractSymbol;
  const baseSymbol = normalizedTicker.baseSymbol;

  if (!isValidUsdtFuturesContractSymbol(contractSymbol)) {
    return {
      candidate: null,
      skippedReason: 'INVALID_CONTRACT_SYMBOL',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  if (isBlockedBaseSymbol(baseSymbol)) {
    return {
      candidate: null,
      skippedReason: 'BLOCKED_BASE_SYMBOL',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  const candles15m = await getCandles(
    contractSymbol,
    '15m',
    candleLimit()
  );

  if (candles15m.length < 30) {
    return {
      candidate: null,
      skippedReason: 'INSUFFICIENT_CANDLES',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  const change1h = calcOneHourChange(candles15m);
  const change24h = safeNumber(normalizedTicker.change24h, 0);

  if (isRisingMove({ change1h, change24h })) {
    return {
      candidate: null,
      skippedReason: 'SHORT_ONLY_RISING_COIN_BLOCKED',
      skippedTradeSide: OPPOSITE_TRADE_SIDE
    };
  }

  const side = inferSide({
    change1h,
    change24h,
    btcState
  });

  if (side !== TARGET_SCANNER_SIDE) {
    return {
      candidate: null,
      skippedReason: 'SHORT_ONLY_NOT_BEARISH',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  const fakeRaw = detectFakeBreakout({
    side,
    candles15m,
    btcState,
    lookback: fakeBreakoutLookback()
  });

  const fake = cleanFakeResult(fakeRaw);

  const gates = buildGateFlags({
    change1h,
    change24h,
    fake,
    side,
    volume24h: normalizedTicker.volume24h
  });

  if (gates.hardBlocked) {
    return {
      candidate: null,
      skippedReason: gates.hardBlockedByDirection
        ? 'NO_SHORT_DIRECTION'
        : gates.hardBlockedByMove
          ? 'SHORT_MOVE_TOO_SMALL'
          : 'SHORT_FAKE_BREAKDOWN',
      skippedTradeSide: gates.risingMove ? OPPOSITE_TRADE_SIDE : TARGET_TRADE_SIDE
    };
  }

  const volumeExpansion = calcVolumeExpansion(candles15m, 20);

  const sideConfidenceLevel = sideConfidence({
    side,
    change1h,
    change24h
  });

  const scannerScore = calcScannerScore({
    change1h,
    change24h,
    volume24h: normalizedTicker.volume24h,
    volumeExpansion,
    sideConfidenceLevel,
    ...fake
  });

  const scannerReason = scannerReasonFrom({
    fake,
    volumeExpansion,
    passesMoveFilter: gates.passesMoveFilter,
    sideConfidenceLevel
  });

  const fingerprint = buildScannerFingerprint({
    baseSymbol,
    scannerReason,
    sideConfidenceLevel,
    change1h,
    change24h,
    volumeExpansion,
    btcState,
    regime,
    scannerGatePassed: gates.scannerGatePassed,
    analyzeEligible: gates.analyzeEligible,
    tradeDiscoveryOnly: gates.tradeDiscoveryOnly,
    ...fake
  });

  const lastClose = safeNumber(candles15m.at(-1)?.close, 0);
  const price = lastClose > 0
    ? lastClose
    : safeNumber(normalizedTicker.price, 0);

  const atrPct = calculateAtrPct(candles15m, 14);
  const rangePct = calcRangePct(candles15m);
  const realizedVolPct = calcRealizedVolPct(candles15m);

  const candidate = normalizeShortCandidate({
    snapshotId,

    symbol: baseSymbol,
    baseSymbol,
    contractSymbol,

    price,

    scannerScore,
    moveScore: scannerScore,

    change1h: Number(change1h.toFixed(3)),
    change24h: Number(change24h.toFixed(3)),

    volume24h: safeNumber(normalizedTicker.volume24h, 0),
    quoteVolume: safeNumber(normalizedTicker.volume24h, 0),
    quoteVolume24h: safeNumber(normalizedTicker.volume24h, 0),
    tickerVolume24h: safeNumber(normalizedTicker.tickerVolume24h ?? normalizedTicker.volume24h, 0),
    candleVolume24h: safeNumber(normalizedTicker.candleVolume24h ?? normalizedTicker.volume24h, 0),
    volumeSource: normalizedTicker.volumeSource || 'TICKER',

    volumeExpansion: Number(volumeExpansion.toFixed(3)),
    atrPct: Number(safeNumber(atrPct, 0).toFixed(6)),
    rangePct: Number(safeNumber(rangePct, 0).toFixed(6)),
    realizedVolPct: Number(safeNumber(realizedVolPct, 0).toFixed(6)),

    btcState,
    regime,

    sideConfidence: sideConfidenceLevel,

    scannerReason,
    ...fingerprint,

    ...fake,
    ...gates,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    scannerTs: startedAt,
    createdAt: startedAt
  }, scannerMarketWeather);

  return {
    candidate,
    skippedReason: null,
    skippedTradeSide: null
  };
}

function countSkipped(results) {
  return results.reduce((acc, row) => {
    const reason = row?.skippedReason || (row?.candidate ? 'SELECTED' : 'UNKNOWN');

    acc[reason] = (acc[reason] || 0) + 1;

    return acc;
  }, {});
}

function sortCandidates(candidates = []) {
  return [...candidates].sort((a, b) => {
    const gateDelta = Number(Boolean(b.scannerGatePassed)) - Number(Boolean(a.scannerGatePassed));
    if (gateDelta !== 0) return gateDelta;

    const scoreDelta = safeNumber(b.scannerScore, 0) - safeNumber(a.scannerScore, 0);
    if (scoreDelta !== 0) return scoreDelta;

    const changeDelta = Math.max(0, -safeNumber(b.change1h, 0)) - Math.max(0, -safeNumber(a.change1h, 0));
    if (changeDelta !== 0) return changeDelta;

    const change24Delta = Math.max(0, -safeNumber(b.change24h, 0)) - Math.max(0, -safeNumber(a.change24h, 0));
    if (change24Delta !== 0) return change24Delta;

    return safeNumber(b.volume24h, 0) - safeNumber(a.volume24h, 0);
  });
}

function buildSnapshotSummary(snapshot) {
  return {
    ok: true,

    ...sideFlags(),
    ...scopeFlags(),
    ...marketWeatherCoreFields(snapshot.marketWeather || snapshot),
    marketWeather: snapshot.marketWeather || null,
    currentMarketWeather: snapshot.currentMarketWeather || snapshot.marketWeather || null,
    confirmedMarketWeather: snapshot.confirmedMarketWeather || snapshot.marketWeather || null,

    snapshotId: snapshot.snapshotId,
    createdAt: snapshot.createdAt,
    completedAt: snapshot.completedAt,
    durationMs: snapshot.durationMs,

    btcState: snapshot.btcState,
    regime: snapshot.regime,
    btcChange1h: snapshot.btcChange1h,
    btcChange24h: snapshot.btcChange24h,
    btcAtrPct: snapshot.btcAtrPct,

    rawCount: snapshot.rawCount,
    filteredUniverse: snapshot.filteredUniverse,

    marketUniverseCount: snapshot.marketUniverseCount,
    marketUniverseKeys: snapshot.marketUniverseKeys,
    marketUniverseSaved: snapshot.marketUniverseSaved,

    marketWeatherCount: snapshot.marketWeatherCount,
    marketWeatherKeys: snapshot.marketWeatherKeys,
    marketWeatherSaved: snapshot.marketWeatherSaved,
    marketWeatherRole: snapshot.marketWeatherRole,
    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,

    candidatesCount: snapshot.candidatesCount,
    scannerGateCandidatesCount: snapshot.scannerGateCandidatesCount,
    analyzeOnlyCandidatesCount: snapshot.analyzeOnlyCandidatesCount,

    shortCandidatesCount: snapshot.shortCandidatesCount,
    longCandidatesCount: 0,

    rawLongCandidatesIgnored: snapshot.rawLongCandidatesIgnored,

    maxSymbols: snapshot.maxSymbols,
    maxCandidates: snapshot.maxCandidates,

    strictFilters: snapshot.strictFilters,
    blockFakeBreakout: snapshot.blockFakeBreakout,
    blockNoDirection: snapshot.blockNoDirection,
    blockSmallMove: snapshot.blockSmallMove,

    minQuoteVolume24h: snapshot.minQuoteVolume24h,
    softMinQuoteVolume24h: snapshot.softMinQuoteVolume24h,
    minAbsChange1h: snapshot.minAbsChange1h,
    minAbsChange24h: snapshot.minAbsChange24h,

    skippedCounts: snapshot.skippedCounts,

    topSymbols: snapshot.topSymbols,
    scannerGateSymbols: snapshot.scannerGateSymbols,
    analyzeOnlySymbols: snapshot.analyzeOnlySymbols,

    marketUniverseSymbols: snapshot.marketUniverseSymbols,

    candidates: snapshot.candidates,

    shortKeys: snapshot.shortKeys
  };
}

function assertScannerWriteKey({ key, latestKey, snapshotKey }) {
  const value = String(key || '');

  if (!value) {
    throw new Error('SCANNER_WRITE_KEY_MISSING');
  }

  if (value !== namespacedShortKey(value, value)) {
    const error = new Error('SCANNER_RUN_REFUSED_NON_SHORT_NAMESPACE_KEY_WRITE');

    error.details = {
      key: value,
      requiredPrefix: SHORT_KEY_PREFIX,
      redisNamespace: SHORT_NAMESPACE,
      longRootTouched: false
    };

    throw error;
  }

  if (value === latestKey || value === snapshotKey) {
    return true;
  }

  const error = new Error('SCANNER_RUN_REFUSED_NON_SCANNER_KEY_WRITE');

  error.details = {
    key: value,
    allowed: [
      latestKey,
      snapshotKey
    ],
    runScope: SCANNER_RUN_SCOPE,
    writeScope: SCANNER_WRITE_SCOPE,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    longRootTouched: false
  };

  throw error;
}

function assertMarketUniverseWriteKey(key, allowedKeys = []) {
  const value = String(key || '').trim();

  if (!value) {
    throw new Error('MARKET_UNIVERSE_WRITE_KEY_MISSING');
  }

  if (!allowedKeys.includes(value)) {
    const error = new Error('SCANNER_RUN_REFUSED_NON_MARKET_UNIVERSE_KEY_WRITE');

    error.details = {
      key: value,
      allowed: allowedKeys,
      runScope: SCANNER_RUN_SCOPE,
      writeScope: SCANNER_WRITE_SCOPE,
      marketUniverseWriteOnly: true,
      writesLearningFamilies: false,
      writesMicroFamilies: false,
      writesPositions: false,
      writesRotation: false,
      longRootTouched: false
    };

    throw error;
  }

  if (value.startsWith(`${SHORT_KEY_PREFIX}MARKET:`)) {
    return true;
  }

  const error = new Error('SCANNER_RUN_REFUSED_UNSAFE_MARKET_UNIVERSE_KEY');

  error.details = {
    key: value,
    allowedPrefixes: [
      `${SHORT_KEY_PREFIX}MARKET:`
    ],
    longRootTouched: false
  };

  throw error;
}

function assertMarketWeatherWriteKey(key, allowedKeys = []) {
  const value = String(key || '').trim();

  if (!value) {
    throw new Error('MARKET_WEATHER_WRITE_KEY_MISSING');
  }

  if (!allowedKeys.includes(value)) {
    const error = new Error('SCANNER_RUN_REFUSED_NON_MARKET_WEATHER_KEY_WRITE');

    error.details = {
      key: value,
      allowed: allowedKeys,
      runScope: SCANNER_RUN_SCOPE,
      writeScope: SCANNER_WRITE_SCOPE,
      marketWeatherWriteOnly: true,
      writesLearningFamilies: false,
      writesMicroFamilies: false,
      longRootTouched: false
    };

    throw error;
  }

  if (value.startsWith(`${SHORT_KEY_PREFIX}MARKET:`)) {
    return true;
  }

  const error = new Error('SCANNER_RUN_REFUSED_UNSAFE_MARKET_WEATHER_KEY');

  error.details = {
    key: value,
    allowedPrefixes: [
      `${SHORT_KEY_PREFIX}MARKET:`
    ],
    longRootTouched: false
  };

  throw error;
}

async function setScannerJson(redis, key, value, options = {}, {
  latestKey,
  snapshotKey,
  role
} = {}) {
  assertScannerWriteKey({
    key,
    latestKey,
    snapshotKey
  });

  return setJson(
    redis,
    key,
    {
      ...value,
      scannerStorageRole: role || null,
      ...scopeFlags(),
      ...sideFlags()
    },
    options
  );
}

async function setMarketUniverseJson(redis, key, value, options = {}, {
  allowedKeys = [],
  role
} = {}) {
  assertMarketUniverseWriteKey(key, allowedKeys);

  return setJson(
    redis,
    key,
    {
      ...value,
      scannerStorageRole: role || 'SHORT_MARKET_UNIVERSE_LATEST',
      marketUniverseRole: 'MARKET_WEATHER_INPUT',
      marketWeatherInput: true,

      writesScanner: true,
      writesMarketUniverse: true,
      writesMarketWeatherInput: true,
      writesAnalyze: false,
      writesLearningFamilies: false,
      writesMicroFamilies: false,
      writesPositions: false,
      writesRotation: false,

      currentFitSoftOnly: true,
      currentFitBlocksLearning: false,
      currentFitBlocksVirtualLearning: false,
      currentFitBlocksShadowLearning: false,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
      learningRemainsBroad: true,
      selectionWillBeAdaptive: true,
      discordWillBeStrict: true,

      adaptiveLayerBuilt: false,
      adaptiveScoreBuilt: false,
      recentMomentumScoreBuilt: false,
      currentFitScoreBuilt: false,
      parentDiversificationBuilt: false,

      redisNamespace: SHORT_NAMESPACE,
      redisKeyPrefix: SHORT_KEY_PREFIX,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      redisKeysSeparatedFromLongRoot: true,
      longRootTouched: false,

      ...scopeFlags()
    },
    options
  );
}

async function setMarketWeatherJson(redis, key, value, options = {}, {
  allowedKeys = [],
  role
} = {}) {
  assertMarketWeatherWriteKey(key, allowedKeys);

  return setJson(
    redis,
    key,
    {
      ...value,
      ...marketWeatherCoreFields(value),
      scannerStorageRole: role || 'SHORT_MARKET_WEATHER_LATEST',
      marketWeatherRole: 'CURRENT_FIT_INPUT',
      marketWeatherInput: true,

      writesScanner: true,
      writesMarketUniverse: false,
      writesMarketWeather: true,
      writesMarketWeatherInput: true,
      writesAnalyze: false,
      writesLearningFamilies: false,
      writesMicroFamilies: false,
      longRootTouched: false,

      currentFitSoftOnly: true,
      currentFitBlocksLearning: false,
      currentFitBlocksVirtualLearning: false,
      currentFitBlocksShadowLearning: false,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
      learningRemainsBroad: true,
      selectionWillBeAdaptive: true,
      discordWillBeStrict: true,

      adaptiveLayerBuilt: false,
      adaptiveScoreBuilt: false,
      recentMomentumScoreBuilt: false,
      currentFitScoreBuilt: false,
      parentDiversificationBuilt: false,

      redisNamespace: SHORT_NAMESPACE,
      redisKeyPrefix: SHORT_KEY_PREFIX,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      redisKeysSeparatedFromLongRoot: true,
      longRootTouched: false,

      ...scopeFlags()
    },
    options
  );
}

function buildMarketUniversePayload({
  rows = [],
  snapshotId,
  startedAt,
  completedAt,
  btcContext
}) {
  return {
    ok: true,
    version: 'SCANNER_MARKET_UNIVERSE_V1',
    source: 'SCANNER_CACHE',
    marketUniverseRole: 'MARKET_WEATHER_INPUT',
    marketWeatherInput: true,

    snapshotId,
    generatedAt: completedAt,
    createdAt: startedAt,
    completedAt,
    updatedAt: completedAt,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: 'market',
    scannerSideForTrades: TARGET_SCANNER_SIDE,

    rows,
    tickers: rows,
    universe: rows,
    count: rows.length,

    btcState: btcContext.btcState,
    btcChange1h: btcContext.btcChange1h,
    btcChange24h: btcContext.btcChange24h,
    btcAtrPct: btcContext.btcAtrPct,
    regime: btcContext.regime,

    cacheHealthy: rows.length > 0,
    ttlSec: marketUniverseTtlSec(),

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false,

    measurementPrerequisite: 'avgCostR_directSL_seenDedupe_first',
    avgCostRRequiredBeforeAdaptiveSelection: true,
    directSLRequiredBeforeAdaptiveSelection: true,
    observationDedupeRequiredBeforeAdaptiveSelection: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function pct(part, total) {
  const a = safeNumber(part, 0);
  const b = safeNumber(total, 0);

  if (b <= 0) return 0;

  return (a / b) * 100;
}

function avg(values = []) {
  const nums = values
    .map((value) => safeNumber(value, NaN))
    .filter((value) => Number.isFinite(value));

  if (!nums.length) return 0;

  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function classifyMarketTrendSideFromRows(rows = [], btcContext = {}) {
  const total = rows.length;

  if (!total) return 'UNKNOWN';

  const bullish = rows.filter((row) => (
    safeNumber(row.change1h, 0) > 0 &&
    safeNumber(row.change24h, 0) >= 0
  )).length;

  const bearish = rows.filter((row) => (
    safeNumber(row.change1h, 0) < 0 ||
    safeNumber(row.change24h, 0) < 0
  )).length;

  const bullishPct = pct(bullish, total);
  const bearishPct = pct(bearish, total);
  const btcState = upper(btcContext.btcState);

  if (bearishPct >= 55 && bullishPct <= 35) return 'BEARISH';
  if (bullishPct >= 58 && bearishPct <= 32) return 'BULLISH';
  if (btcState.includes('BEAR') && bearishPct >= 45) return 'BEARISH';
  if (btcState.includes('BULL') && bullishPct >= 50) return 'BULLISH';

  return 'NEUTRAL';
}

function classifyMarketRegimeFromRows(rows = [], btcContext = {}) {
  const total = rows.length;

  if (!total) return 'UNKNOWN';

  const squeezeRows = rows.filter((row) => {
    const atrPct = safeNumber(row.atrPct, 0);
    const rangePct = safeNumber(row.rangePct, 0);
    const realizedVolPct = safeNumber(row.realizedVolPct, 0);
    const volumeExpansion = safeNumber(row.volumeExpansion, 1);

    return (
      atrPct > 0 &&
      atrPct <= 0.65 &&
      rangePct <= 3.5 &&
      realizedVolPct <= 0.8 &&
      volumeExpansion <= 1.25
    );
  }).length;

  const trendRows = rows.filter((row) => {
    const ch1 = Math.abs(safeNumber(row.change1h, 0));
    const ch24 = Math.abs(safeNumber(row.change24h, 0));
    const volumeExpansion = safeNumber(row.volumeExpansion, 1);

    return (
      ch1 >= 0.35 ||
      ch24 >= 1.25 ||
      volumeExpansion >= 1.35
    );
  }).length;

  const squeezePct = pct(squeezeRows, total);
  const trendPct = pct(trendRows, total);
  const btcRegime = upper(btcContext.regime);

  if (squeezePct >= 45) return 'SQUEEZE';
  if (trendPct >= 50) return 'TREND';
  if (btcRegime.includes('HIGH_VOL') && trendPct >= 38) return 'TREND';

  return 'CHOP';
}

function classifyMarketFlowFromRows(rows = []) {
  const total = rows.length;

  if (!total) return 'UNKNOWN';

  const strongUp = rows.filter((row) => (
    safeNumber(row.change1h, 0) >= 0.35 ||
    safeNumber(row.change24h, 0) >= 1.25
  )).length;

  const strongDown = rows.filter((row) => (
    safeNumber(row.change1h, 0) <= -0.35 ||
    safeNumber(row.change24h, 0) <= -1.25
  )).length;

  const upPct = pct(strongUp, total);
  const downPct = pct(strongDown, total);

  if (downPct >= 45 && upPct <= 30) return 'BEARISH_FLOW';
  if (upPct >= 45 && downPct <= 30) return 'BULLISH_FLOW';
  if (upPct >= 30 && downPct >= 30) return 'MIXED_FLOW';

  return 'QUIET_FLOW';
}

function classifyMarketVolatilityFromRows(rows = []) {
  if (!rows.length) return 'UNKNOWN';

  const atrAvg = avg(rows.map((row) => row.atrPct));
  const rangeAvg = avg(rows.map((row) => row.rangePct));
  const realizedAvg = avg(rows.map((row) => row.realizedVolPct));

  if (atrAvg >= 1.8 || rangeAvg >= 8 || realizedAvg >= 1.8) return 'HIGH_VOL';
  if (atrAvg <= 0.65 && rangeAvg <= 3.5 && realizedAvg <= 0.8) return 'LOW_VOL';

  return 'NORMAL_VOL';
}

function buildMarketWeatherPayload({
  rows = [],
  snapshotId,
  startedAt,
  completedAt,
  btcContext
}) {
  const total = rows.length;

  const bullishCount = rows.filter((row) => (
    safeNumber(row.change1h, 0) > 0 &&
    safeNumber(row.change24h, 0) >= 0
  )).length;

  const bearishCount = rows.filter((row) => (
    safeNumber(row.change1h, 0) < 0 ||
    safeNumber(row.change24h, 0) < 0
  )).length;

  const neutralCount = Math.max(0, total - bullishCount - bearishCount);

  const squeezeCount = rows.filter((row) => (
    safeNumber(row.atrPct, 0) > 0 &&
    safeNumber(row.atrPct, 0) <= 0.65 &&
    safeNumber(row.rangePct, 0) <= 3.5
  )).length;

  const bullishPct = pct(bullishCount, total);
  const bearishPct = pct(bearishCount, total);
  const neutralPct = pct(neutralCount, total);
  const squeezePct = pct(squeezeCount, total);

  const currentMarketWeatherRegime = normalizeMarketWeatherRegime(
    classifyMarketRegimeFromRows(rows, btcContext)
  );

  const currentMarketWeatherTrendSide = normalizeMarketWeatherTrendSide(
    classifyMarketTrendSideFromRows(rows, btcContext)
  );

  const currentMarketWeatherKey = buildMarketWeatherKey({
    regime: currentMarketWeatherRegime,
    trendSide: currentMarketWeatherTrendSide
  });

  const currentMarketWeatherKnown = currentMarketWeatherKey !== UNKNOWN_MARKET_WEATHER_KEY;

  const currentFlow = classifyMarketFlowFromRows(rows);
  const currentVolatilityState = classifyMarketVolatilityFromRows(rows);

  const confidence = total <= 0
    ? 0
    : Math.max(
        0,
        Math.min(
          100,
          Math.round(
            35 +
            Math.abs(bullishPct - bearishPct) * 0.45 +
            Math.min(20, total * 0.15)
          )
        )
      );

  return {
    ok: currentMarketWeatherKnown,
    available: currentMarketWeatherKnown,
    version: 'MARKET_WEATHER_ENGINE_FROM_SCANNER_V2_FULL_KEY',
    source: 'SCANNER_MARKET_UNIVERSE',

    snapshotId,
    generatedAt: completedAt,
    createdAt: startedAt,
    completedAt,
    updatedAt: completedAt,

    currentMarketWeatherKey,
    confirmedMarketWeatherKey: currentMarketWeatherKey,
    marketWeatherKey: currentMarketWeatherKey,

    currentMarketWeatherRegime,
    confirmedMarketWeatherRegime: currentMarketWeatherRegime,
    currentRegime: currentMarketWeatherRegime,
    regime: currentMarketWeatherRegime,

    currentMarketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: currentMarketWeatherTrendSide,
    currentTrendSide: currentMarketWeatherTrendSide,
    trendSide: currentMarketWeatherTrendSide,

    currentMarketWeatherKnown,
    confirmedMarketWeatherKnown: currentMarketWeatherKnown,

    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,

    currentFlow,
    flow: currentFlow,

    currentVolatilityState,
    volatilityState: currentVolatilityState,

    confidence,
    weatherConfidence: confidence,

    bullishCount,
    bearishCount,
    neutralCount,
    squeezeCount,

    bullishPct: Number(bullishPct.toFixed(2)),
    bearishPct: Number(bearishPct.toFixed(2)),
    neutralPct: Number(neutralPct.toFixed(2)),
    squeezePct: Number(squeezePct.toFixed(2)),

    avgAtrPct: Number(avg(rows.map((row) => row.atrPct)).toFixed(6)),
    avgRangePct: Number(avg(rows.map((row) => row.rangePct)).toFixed(6)),
    avgRealizedVolPct: Number(avg(rows.map((row) => row.realizedVolPct)).toFixed(6)),
    avgVolumeExpansion: Number(avg(rows.map((row) => row.volumeExpansion)).toFixed(4)),

    count: total,
    universeCount: total,
    symbols: rows.slice(0, 40).map((row) => row.symbol).filter(Boolean),
    rows: rows.slice(0, 120),
    universe: rows.slice(0, 120),

    btcState: btcContext.btcState,
    btcChange1h: btcContext.btcChange1h,
    btcChange24h: btcContext.btcChange24h,
    btcAtrPct: btcContext.btcAtrPct,
    btcRegime: btcContext.regime,

    currentFitLabels: [
      'MATCH',
      'WEAK_MATCH',
      'NEUTRAL',
      'MISFIT',
      'UNKNOWN'
    ],

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false,

    measurementPrerequisite: 'avgCostR_directSL_seenDedupe_first',
    avgCostRRequiredBeforeAdaptiveSelection: true,
    directSLRequiredBeforeAdaptiveSelection: true,
    observationDedupeRequiredBeforeAdaptiveSelection: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

async function saveMarketUniverse({
  redis,
  rows,
  snapshotId,
  startedAt,
  completedAt,
  btcContext,
  options = {}
}) {
  const keys = marketUniverseKeys(options);
  const payload = buildMarketUniversePayload({
    rows,
    snapshotId,
    startedAt,
    completedAt,
    btcContext
  });

  const ttlSec = marketUniverseTtlSec();
  const savedKeys = [];

  for (const key of keys) {
    await setMarketUniverseJson(
      redis,
      key,
      {
        ...payload,
        redisNamespace: SHORT_NAMESPACE,
        redisKeyPrefix: SHORT_KEY_PREFIX
      },
      {
        ex: ttlSec
      },
      {
        allowedKeys: keys,
        role: 'SHORT_MARKET_UNIVERSE_LATEST'
      }
    );

    savedKeys.push(key);
  }

  return {
    ok: savedKeys.length > 0,
    savedKeys,
    payload
  };
}

async function saveMarketWeather({
  redis,
  rows,
  snapshotId,
  startedAt,
  completedAt,
  btcContext,
  options = {},
  scannerMarketWeather = null
}) {
  const keys = marketWeatherKeys(options);
  const derivedPayload = buildMarketWeatherPayload({
    rows,
    snapshotId,
    startedAt,
    completedAt,
    btcContext
  });

  const resolvedWeather = normalizeMarketWeatherSnapshot(
    scannerMarketWeather || derivedPayload,
    scannerMarketWeather?.source || 'SCANNER_MARKET_WEATHER_SAVE'
  );

  const payload = {
    ...derivedPayload,
    ...marketWeatherCoreFields(resolvedWeather),
    marketWeather: resolvedWeather,
    currentMarketWeather: resolvedWeather,
    confirmedMarketWeather: resolvedWeather,
    source: resolvedWeather.source || derivedPayload.source || 'SCANNER_MARKET_UNIVERSE'
  };

  const ttlSec = marketWeatherTtlSec();
  const savedKeys = [];

  for (const key of keys) {
    await setMarketWeatherJson(
      redis,
      key,
      {
        ...payload,
        redisNamespace: SHORT_NAMESPACE,
        redisKeyPrefix: SHORT_KEY_PREFIX
      },
      {
        ex: ttlSec
      },
      {
        allowedKeys: keys,
        role: 'SHORT_MARKET_WEATHER_LATEST'
      }
    );

    savedKeys.push(key);
  }

  return {
    ok: savedKeys.length > 0,
    savedKeys,
    payload
  };
}

export async function runScanner(options = {}) {
  const redis = getVolatileRedis();
  const marketRedis = getDurableRedis();

  const startedAt = now();
  const snapshotId = randomId('scan_short');
  const getCandles = createCandleCache();

  const rawTickers = await fetchBitgetTickers();

  const marketUniverseRows = await buildMarketUniverseRows({
    rawTickers,
    getCandles,
    snapshotId,
    startedAt
  });

  const universe = buildTickerUniverse(rawTickers);

  const btcContext = await buildBtcContext({
    universe: marketUniverseRows.length ? marketUniverseRows : universe,
    getCandles
  });

  const derivedMarketWeatherPayload = buildMarketWeatherPayload({
    rows: marketUniverseRows,
    snapshotId,
    startedAt,
    completedAt: now(),
    btcContext
  });

  const scannerMarketWeather = resolveRunMarketWeather(
    options,
    derivedMarketWeatherPayload
  );

  const results = await mapConcurrent(
    universe,
    scannerConcurrency(),
    async (ticker) => analyzeTickerCandidate({
      ticker,
      snapshotId,
      startedAt,
      btcState: btcContext.btcState,
      regime: btcContext.regime,
      getCandles,
      scannerMarketWeather
    })
  );

  const allCandidates = results
    .map((row) => row?.candidate)
    .filter(Boolean)
    .filter(isTargetCandidate)
    .map((candidate) => normalizeShortCandidate(candidate, scannerMarketWeather))
    .filter((candidate) => !isScannerFingerprintId(candidate.trueMicroFamilyId))
    .filter((candidate) => !isScannerFingerprintId(candidate.microFamilyId))
    .filter((candidate) => !isExecutionFingerprintId(candidate.trueMicroFamilyId))
    .filter((candidate) => !isExecutionFingerprintId(candidate.microFamilyId));

  const cleanCandidates = sortCandidates(allCandidates)
    .slice(0, scannerMaxCandidates());

  const scannerGateCandidates = cleanCandidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = cleanCandidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly ||
    !candidate.scannerGatePassed
  ));

  const completedAt = now();

  const marketUniverseSave = await saveMarketUniverse({
    redis: marketRedis,
    rows: marketUniverseRows,
    snapshotId,
    startedAt,
    completedAt,
    btcContext,
    options
  });

  const marketWeatherSave = await saveMarketWeather({
    redis: marketRedis,
    rows: marketUniverseRows,
    snapshotId,
    startedAt,
    completedAt,
    btcContext,
    options,
    scannerMarketWeather
  });

  const resolvedMarketWeather = normalizeMarketWeatherSnapshot(
    marketWeatherSave.payload?.marketWeather ||
      marketWeatherSave.payload ||
      scannerMarketWeather,
    'SCANNER_SNAPSHOT_RESOLVED_MARKET_WEATHER'
  );

  const rawLongCandidatesIgnored =
    results.filter((row) => row?.skippedTradeSide === OPPOSITE_TRADE_SIDE).length +
    results
      .map((row) => row?.candidate)
      .filter(Boolean)
      .filter(isOppositeCandidate)
      .length;

  const snapshotKey = shortScanSnapshotKey(snapshotId, options);
  const latestKey = shortScanLatestKey(options);

  const snapshot = {
    ok: true,
    persisted: true,

    ...sideFlags(),
    ...scopeFlags(),
    ...marketWeatherCoreFields(resolvedMarketWeather),

    marketWeather: resolvedMarketWeather,
    currentMarketWeather: resolvedMarketWeather,
    confirmedMarketWeather: resolvedMarketWeather,

    scannerMarketWeatherCaptured: resolvedMarketWeather.known,
    scannerMarketWeatherCaptureVersion: MARKET_WEATHER_CAPTURE_VERSION,
    scannerCandidatesReceiveEntryMarketWeatherKey: true,
    unknownWeatherDoesNotOverrideKnownWeather: true,

    force: Boolean(options.force || options.forced),

    snapshotId,
    createdAt: startedAt,
    completedAt,
    durationMs: completedAt - startedAt,

    btcState: btcContext.btcState,
    regime: btcContext.regime,
    btcChange1h: btcContext.btcChange1h,
    btcChange24h: btcContext.btcChange24h,
    btcAtrPct: btcContext.btcAtrPct,

    rawCount: Array.isArray(rawTickers) ? rawTickers.length : 0,
    filteredUniverse: universe.length,

    marketUniverseCount: marketUniverseRows.length,
    marketUniverseKeys: marketUniverseSave.savedKeys,
    marketUniverseSaved: Boolean(marketUniverseSave.ok),
    marketUniverseRole: 'MARKET_WEATHER_INPUT',
    marketWeatherInput: true,

    marketWeatherCount: marketUniverseRows.length,
    marketWeatherKeys: marketWeatherSave.savedKeys,
    marketWeatherSaved: Boolean(marketWeatherSave.ok),
    marketWeatherRole: 'CURRENT_FIT_INPUT',

    candidatesCount: cleanCandidates.length,
    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    shortCandidatesCount: cleanCandidates.length,
    longCandidatesCount: 0,

    rawLongCandidatesIgnored,

    maxSymbols: scannerMaxSymbols(),
    maxCandidates: scannerMaxCandidates(),
    marketUniverseMaxSymbols: marketUniverseMaxSymbols(),

    strictFilters: strictScannerFiltersEnabled(),
    blockFakeBreakout: blockFakeBreakoutEnabled(),
    blockNoDirection: blockNoDirectionEnabled(),
    blockSmallMove: blockSmallMoveEnabled(),

    minQuoteVolume24h: minQuoteVolume24h(),
    softMinQuoteVolume24h: softMinQuoteVolume24h(),
    marketUniverseMinQuoteVolume24h: marketUniverseMinVolume24h(),

    minAbsChange1h: minAbsChange1h(),
    minAbsChange24h: minAbsChange24h(),

    skippedCounts: countSkipped(results),

    topSymbols: cleanCandidates
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

    marketUniverseSymbols: marketUniverseRows
      .slice(0, 30)
      .map((row) => row.symbol)
      .filter(Boolean),

    scannerMicroFamilyIdsMetadataOnly: cleanCandidates
      .map((candidate) => candidate.scannerMicroFamilyId)
      .filter(Boolean),

    trueMicroFamilyIds: [],
    microFamilyIds: [],
    childTrueMicroFamilyIds: [],
    parentTrueMicroFamilyIds: [],

    candidates: cleanCandidates,

    shortKeys: {
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      latest: latestKey,
      snapshot: snapshotKey,
      marketUniverse: marketUniverseSave.savedKeys,
      marketWeather: marketWeatherSave.savedKeys
    },

    longRootTouched: false,
    redisKeysSeparatedFromLongRoot: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    currentFitScoreBuilt: false,
    parentDiversificationBuilt: false
  };

  const ttlSec = snapshotTtlSec();

  await setScannerJson(
    redis,
    snapshotKey,
    snapshot,
    {
      ex: ttlSec
    },
    {
      latestKey,
      snapshotKey,
      role: 'SHORT_SCAN_SNAPSHOT'
    }
  );

  await setScannerJson(
    redis,
    latestKey,
    buildSnapshotSummary(snapshot),
    {
      ex: ttlSec
    },
    {
      latestKey,
      snapshotKey,
      role: 'SHORT_SCAN_LATEST'
    }
  );

  return snapshot;
}