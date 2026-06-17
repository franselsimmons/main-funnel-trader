// ================= FILE: src/redis.js =================

import { Redis } from '@upstash/redis';

const DEFAULT_SCAN_COUNT = 100;
const DEFAULT_DELETE_BATCH_SIZE = 100;
const DEFAULT_LOG_LIMIT = 250;

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
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const ROOT_KEY_PREFIXES = [
  'SCAN:',
  'LIVE:',
  'TRADE:',
  'ANALYZE:',
  'CIRCUIT:',
  'DISCORD:',
  'RESET:'
];

const PUBLIC_MARKET_KEY_PREFIXES = [
  'MARKET:WEATHER',
  'MARKET:UNIVERSE',
  'MARKET:SCANNER:UNIVERSE'
];

const BLOCKED_KEY_PREFIXES = [
  `${OPPOSITE_TRADE_SIDE}:`,
  'LONG:',
  'LONG_SCAN:',
  'LONG_TRADE:',
  'LONG_ANALYZE:',
  'LONG_DISCORD:',
  'LONG_RESET:',
  'LONG_LIVE:',
  'BULL:',
  'BULLISH:',
  'BUY:'
];

const SHORT_FIXED_SETUP_TYPES = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const SHORT_FIXED_REGIME_BUCKETS = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const SHORT_CONFIRMATION_PROFILES = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

function taxonomyFlags() {
  return {
    trueMicroSchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,

    parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    childTrueMicroSchema: CHILD_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    fixedTaxonomyPreferred: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    selectableFamilyCount: 75,
    parentFamilyCount: 15,
    parentSelectable: false,
    childSelectable: true,

    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

    setupTypes: SHORT_FIXED_SETUP_TYPES,
    regimeBuckets: SHORT_FIXED_REGIME_BUCKETS,
    confirmationProfiles: SHORT_CONFIRMATION_PROFILES
  };
}

function shortRiskFlags() {
  return {
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    validShortRiskShape: true,
    shortRiskFormula: 'tp < entry < sl',
    shortTpExitRule: 'price <= tp',
    shortSlExitRule: 'price >= sl',
    shortTimeStopExitRule: 'TIME_STOP',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)'
  };
}

function currentFitFlags() {
  return {
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
  };
}

function modeFlags() {
  return {
    namespace: SHORT_NAMESPACE,
    redisNamespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,

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

    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    shadowOnly: true,
    source: 'VIRTUAL',
    outcomeSource: 'VIRTUAL',

    noRealOrders: true,
    noExchangeOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    noGlobalMaxOpenPositionsBlock: true,
    oneOpenPositionPerSymbol: true,

    manualDiscordSelectionExactTrueMicroOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,
    discordOnlyForSelectedMicroFamilies: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',

    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    rankingUsesBalancedScore: true,
    noBareWinrateRanking: true,
    balancedRankingFields: [
      'balancedScore',
      'dashboardBalancedScore',
      'fairWinrate',
      'totalR',
      'avgR',
      'avgCostR'
    ],

    noResetCron: true,
    noActivateCron: true,
    noFreezeCron: true,
    manualSelectionPreserved: true,

    longRootTouched: false,

    ...taxonomyFlags(),
    ...shortRiskFlags(),
    ...currentFitFlags()
  };
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }

  return '';
}

function makeRedis(url, token, label) {
  if (!url || !token) {
    throw new Error(`${label}_REDIS_ENV_MISSING`);
  }

  return new Redis({
    url,
    token,
    automaticDeserialization: false
  });
}

function getVolatileEnv() {
  return {
    url: envValue(
      'VOLATILE_REDIS_REST_URL',
      'KV_REST_API_URL',
      'UPSTASH_REDIS_REST_URL'
    ),
    token: envValue(
      'VOLATILE_REDIS_REST_TOKEN',
      'KV_REST_API_TOKEN',
      'UPSTASH_REDIS_REST_TOKEN'
    )
  };
}

function getDurableEnv() {
  return {
    url: envValue(
      'DURABLE_REDIS_REST_URL',
      'KV_REST_API_URL',
      'UPSTASH_REDIS_REST_URL'
    ),
    token: envValue(
      'DURABLE_REDIS_REST_TOKEN',
      'KV_REST_API_TOKEN',
      'UPSTASH_REDIS_REST_TOKEN'
    )
  };
}

let volatileRedis = null;
let durableRedis = null;

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function isBlockedLongKey(key = '') {
  const value = upper(key);

  return BLOCKED_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isRootAppKey(key = '') {
  const value = String(key || '').trim();

  return ROOT_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isPublicMarketKey(key = '') {
  const value = String(key || '').trim();

  return PUBLIC_MARKET_KEY_PREFIXES.some((prefix) => (
    value === prefix ||
    value.startsWith(`${prefix}:`)
  ));
}

function isShortKey(key = '') {
  return String(key || '').trim().startsWith(SHORT_KEY_PREFIX);
}

function buildNamespaceError(message, payload = {}) {
  const error = new Error(message);

  error.details = {
    ...payload,
    namespace: SHORT_NAMESPACE,
    redisNamespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    targetTradeSide: TARGET_TRADE_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,
    longRootTouched: false,
    ...taxonomyFlags(),
    ...shortRiskFlags(),
    ...currentFitFlags()
  };

  return error;
}

function normalizeKey(key) {
  const raw = String(key || '').trim();

  if (!raw) return '';

  if (isBlockedLongKey(raw)) {
    throw buildNamespaceError('SHORT_REDIS_REFUSED_LONG_NAMESPACE_KEY', {
      key: raw
    });
  }

  if (isShortKey(raw)) return raw;

  if (isPublicMarketKey(raw)) return raw;

  if (isRootAppKey(raw)) return `${SHORT_KEY_PREFIX}${raw}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function normalizePattern(pattern) {
  const raw = String(pattern || '').trim();

  if (!raw) return '';

  if (isBlockedLongKey(raw)) {
    throw buildNamespaceError('SHORT_REDIS_REFUSED_LONG_NAMESPACE_PATTERN', {
      pattern: raw
    });
  }

  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;

  if (isPublicMarketKey(raw)) return raw;

  if (isRootAppKey(raw)) return `${SHORT_KEY_PREFIX}${raw}`;

  if (raw === '*') return `${SHORT_KEY_PREFIX}*`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function normalizeLimit(value, fallback = DEFAULT_LOG_LIMIT) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n <= 0) return fallback;

  return n;
}

function normalizeScanCount(value = DEFAULT_SCAN_COUNT) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SCAN_COUNT;

  return Math.max(1, Math.min(1000, n));
}

function normalizeMax(value, fallback = 1000) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n <= 0) return fallback;

  return n;
}

function parseJsonValue(value, fallback = null) {
  if (value === null || value === undefined) return fallback;

  if (typeof value !== 'string') return value;

  const text = value.trim();

  if (!text) return fallback;
  if (text === 'null') return null;
  if (text === 'undefined') return fallback;

  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function stringifyJsonValue(value, keyForError = 'UNKNOWN_KEY') {
  if (value === undefined) {
    throw new Error(`JSON_UNDEFINED_VALUE:${keyForError}`);
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error(`JSON_STRINGIFY_FAILED:${keyForError}:${error?.message || String(error)}`);
  }
}

function normalizeScanResult(result) {
  if (!Array.isArray(result)) {
    return {
      cursor: 0,
      keys: []
    };
  }

  const [nextCursor, keys] = result;

  return {
    cursor: Number(nextCursor) || 0,
    keys: Array.isArray(keys) ? keys.filter(Boolean) : []
  };
}

function withShortMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  return {
    ...value,
    ...modeFlags()
  };
}

function assertShortNormalizedKey(key) {
  const value = String(key || '').trim();

  if (
    !value.startsWith(SHORT_KEY_PREFIX) &&
    !isPublicMarketKey(value)
  ) {
    throw buildNamespaceError('SHORT_REDIS_REFUSED_NON_SHORT_KEY', {
      key: value
    });
  }

  return true;
}

async function deleteKeys(redis, keys = []) {
  const rows = Array.isArray(keys)
    ? keys
      .filter(Boolean)
      .map(normalizeKey)
      .filter((key) => (
        key.startsWith(SHORT_KEY_PREFIX) ||
        isPublicMarketKey(key)
      ))
    : [];

  if (!rows.length) return 0;

  let deleted = 0;

  for (let i = 0; i < rows.length; i += DEFAULT_DELETE_BATCH_SIZE) {
    const batch = rows.slice(i, i + DEFAULT_DELETE_BATCH_SIZE);

    if (!batch.length) continue;

    const result = await redis.del(...batch);
    const count = Number(result);

    deleted += Number.isFinite(count) ? count : batch.length;
  }

  return deleted;
}

export function getVolatileRedis() {
  if (!volatileRedis) {
    const { url, token } = getVolatileEnv();
    volatileRedis = makeRedis(url, token, 'VOLATILE');
  }

  return volatileRedis;
}

export function getDurableRedis() {
  if (!durableRedis) {
    const { url, token } = getDurableEnv();
    durableRedis = makeRedis(url, token, 'DURABLE');
  }

  return durableRedis;
}

export function hasVolatileRedisEnv() {
  const { url, token } = getVolatileEnv();

  return Boolean(url && token);
}

export function hasDurableRedisEnv() {
  const { url, token } = getDurableEnv();

  return Boolean(url && token);
}

export function hasRedisEnv() {
  return hasVolatileRedisEnv() && hasDurableRedisEnv();
}

export function normalizeRedisKey(key) {
  return normalizeKey(key);
}

export function normalizeRedisPattern(pattern) {
  return normalizePattern(pattern);
}

export function isShortRedisKey(key) {
  return isShortKey(key);
}

export function isPublicMarketRedisKey(key) {
  return isPublicMarketKey(key);
}

export function redisModeFlags() {
  return modeFlags();
}

export async function getJson(redis, key, fallback = null) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) return fallback;

  assertShortNormalizedKey(redisKey);

  const value = await redis.get(redisKey);

  return parseJsonValue(value, fallback);
}

export async function setJson(redis, key, value, options = undefined) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) {
    throw new Error('SET_SHORT_JSON_INVALID_REDIS_OR_KEY');
  }

  assertShortNormalizedKey(redisKey);

  const payload = stringifyJsonValue(withShortMeta(value), redisKey);

  return redis.set(redisKey, payload, options);
}

export async function setNxJson(redis, key, value, options = {}) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) {
    throw new Error('SET_NX_SHORT_JSON_INVALID_REDIS_OR_KEY');
  }

  assertShortNormalizedKey(redisKey);

  const payload = stringifyJsonValue(withShortMeta(value), redisKey);

  return redis.set(redisKey, payload, {
    ...options,
    nx: true
  });
}

export async function delJson(redis, key) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) return 0;

  assertShortNormalizedKey(redisKey);

  return redis.del(redisKey);
}

export async function delPattern(redis, pattern, max = 5000) {
  const redisPattern = normalizePattern(pattern);

  if (!redis || !redisPattern) return 0;

  assertShortNormalizedKey(redisPattern.replace(/\*.*$/u, '') || SHORT_KEY_PREFIX);

  const maxDelete = normalizeMax(max, 5000);

  let cursor = 0;
  let deleted = 0;

  do {
    const scanResult = await redis.scan(cursor, {
      match: redisPattern,
      count: normalizeScanCount()
    });

    const normalized = normalizeScanResult(scanResult);

    cursor = normalized.cursor;

    if (!normalized.keys.length) continue;

    const allowedKeys = normalized.keys
      .filter((key) => (
        String(key || '').startsWith(SHORT_KEY_PREFIX) ||
        isPublicMarketKey(key)
      ));

    const remaining = Math.max(0, maxDelete - deleted);
    const limitedKeys = allowedKeys.slice(0, remaining);

    deleted += await deleteKeys(redis, limitedKeys);

    if (deleted >= maxDelete) break;
  } while (cursor !== 0);

  return deleted;
}

export async function getKeys(redis, pattern, max = 1000) {
  const redisPattern = normalizePattern(pattern);

  if (!redis || !redisPattern) return [];

  assertShortNormalizedKey(redisPattern.replace(/\*.*$/u, '') || SHORT_KEY_PREFIX);

  const maxKeys = normalizeMax(max, 1000);

  let cursor = 0;
  const out = [];
  const seen = new Set();

  do {
    const scanResult = await redis.scan(cursor, {
      match: redisPattern,
      count: normalizeScanCount()
    });

    const normalized = normalizeScanResult(scanResult);

    cursor = normalized.cursor;

    for (const key of normalized.keys) {
      if (!key || seen.has(key)) continue;

      if (
        !String(key).startsWith(SHORT_KEY_PREFIX) &&
        !isPublicMarketKey(key)
      ) {
        continue;
      }

      seen.add(key);
      out.push(key);

      if (out.length >= maxKeys) break;
    }

    if (out.length >= maxKeys) break;
  } while (cursor !== 0);

  return out;
}

export async function pushJsonLog(redis, key, value, limit = DEFAULT_LOG_LIMIT) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) {
    throw new Error('PUSH_SHORT_JSON_LOG_INVALID_REDIS_OR_KEY');
  }

  assertShortNormalizedKey(redisKey);

  const safeLimit = normalizeLimit(limit, DEFAULT_LOG_LIMIT);
  const payload = stringifyJsonValue(withShortMeta(value), redisKey);

  await redis.lpush(redisKey, payload);
  await redis.ltrim(redisKey, 0, safeLimit - 1);

  return true;
}

export async function readJsonLogs(redis, key, limit = 100) {
  const redisKey = normalizeKey(key);

  if (!redis || !redisKey) return [];

  assertShortNormalizedKey(redisKey);

  const safeLimit = normalizeLimit(limit, 100);
  const rows = await redis.lrange(redisKey, 0, safeLimit - 1);

  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (row === null || row === undefined) return null;

      if (typeof row !== 'string') {
        return withShortMeta(row);
      }

      const parsed = parseJsonValue(row, null);

      return parsed === null
        ? {
          raw: row,
          ...modeFlags()
        }
        : withShortMeta(parsed);
    })
    .filter(Boolean);
}

export async function pingRedis(redis) {
  if (!redis) return false;

  try {
    const result = await redis.ping();

    return result === 'PONG' || result === 'pong' || result === true;
  } catch {
    return false;
  }
}