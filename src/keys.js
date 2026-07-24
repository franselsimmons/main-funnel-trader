// ================= FILE: src/lock.js =================

import { randomUUID } from 'node:crypto';

const DEFAULT_LOCK_TTL_SEC = 180;
const MIN_LOCK_TTL_SEC = 5;

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

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const RAW_ROOT_KEY_PREFIXES = [
  'SCAN:',
  'LIVE:',
  'TRADE:',
  'ANALYZE:',
  'CIRCUIT:',
  'DISCORD:',
  'RESET:'
];

const REFUSED_NON_SHORT_PREFIXES = [
  'LONG:',
  'LONG_LIVE:',
  'BULL:',
  'BULLISH:',
  'BUY:'
];

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

    parentSelectable: false,
    childSelectable: true,
    selectableFamilyCount: 75,
    parentFamilyCount: 15,

    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}'
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

    noRealOrders: true,
    noExchangeOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

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

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    noResetCron: true,
    noActivateCron: true,
    noFreezeCron: true,
    manualSelectionPreserved: true,

    noGlobalMaxOpenPositionsBlock: true,
    oneOpenPositionPerSymbol: true,

    longRootTouched: false,

    ...taxonomyFlags(),
    ...shortRiskFlags(),
    ...currentFitFlags()
  };
}

function normalizeTtlSec(ttlSec) {
  const n = Number(ttlSec);

  if (!Number.isFinite(n)) return DEFAULT_LOCK_TTL_SEC;

  return Math.max(MIN_LOCK_TTL_SEC, Math.floor(n));
}

function isRawRootKey(key = '') {
  return RAW_ROOT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isExplicitNonShortKey(key = '') {
  const raw = String(key || '').trim().toUpperCase();

  if (!raw) return false;

  return REFUSED_NON_SHORT_PREFIXES.some((prefix) => raw.startsWith(prefix));
}

function normalizeLockKey(key) {
  const raw = String(key || '').trim();

  if (!raw) return '';

  if (isExplicitNonShortKey(raw)) {
    const error = new Error('SHORT_LOCK_REFUSED_NON_SHORT_NAMESPACE_KEY');

    error.details = {
      key: raw,
      requiredNamespace: SHORT_NAMESPACE,
      requiredPrefix: SHORT_KEY_PREFIX,
      oppositeTradeSide: OPPOSITE_TRADE_SIDE,
      longRootTouched: false,
      ...modeFlags()
    };

    throw error;
  }

  if (raw.startsWith(SHORT_KEY_PREFIX)) {
    return raw;
  }

  if (isRawRootKey(raw)) {
    return `${SHORT_KEY_PREFIX}${raw}`;
  }

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function createLockToken() {
  return `${SHORT_NAMESPACE}_${TARGET_TRADE_SIDE}_${Date.now()}_${randomUUID()}`;
}

function isLockAcquiredResult(value) {
  if (value === true) return true;
  if (value === 'OK') return true;
  if (value === 'ok') return true;
  if (value === 1) return true;

  return false;
}

async function atomicRelease(redis, key, token) {
  if (typeof redis.eval === 'function') {
    const result = await redis.eval(RELEASE_LOCK_SCRIPT, [key], [token]);

    return Number(result) === 1;
  }

  if (typeof redis.evalsha === 'function') {
    return false;
  }

  return null;
}

async function fallbackRelease(redis, key, token) {
  const current = await redis.get(key);

  if (String(current || '') !== token) {
    return {
      ok: false,
      released: false,
      reason: current ? 'LOCK_TOKEN_MISMATCH' : 'LOCK_ALREADY_EXPIRED',
      key,
      lockNamespace: SHORT_NAMESPACE,
      lockKeyPrefix: SHORT_KEY_PREFIX,
      ...modeFlags()
    };
  }

  const deleted = await redis.del(key);

  return {
    ok: Number(deleted) > 0,
    released: Number(deleted) > 0,
    reason: Number(deleted) > 0 ? 'LOCK_RELEASED' : 'LOCK_DELETE_NOOP',
    key,
    lockNamespace: SHORT_NAMESPACE,
    lockKeyPrefix: SHORT_KEY_PREFIX,
    ...modeFlags()
  };
}

export function normalizeShortLockKey(key) {
  return normalizeLockKey(key);
}

export async function acquireRedisLock(redis, key, ttlSec = DEFAULT_LOCK_TTL_SEC) {
  const lockKey = normalizeLockKey(key);

  if (!redis || !lockKey) {
    throw new Error('ACQUIRE_SHORT_LOCK_INVALID_REDIS_OR_KEY');
  }

  const token = createLockToken();
  const ttl = normalizeTtlSec(ttlSec);

  const acquired = await redis.set(lockKey, token, {
    nx: true,
    ex: ttl
  });

  if (!isLockAcquiredResult(acquired)) {
    return {
      ok: false,
      acquired: false,
      key: lockKey,
      ttlSec: ttl,
      token: null,
      reason: 'PREVIOUS_SHORT_RUN_STILL_ACTIVE',
      lockNamespace: SHORT_NAMESPACE,
      lockKeyPrefix: SHORT_KEY_PREFIX,
      ...modeFlags()
    };
  }

  return {
    ok: true,
    acquired: true,
    key: lockKey,
    ttlSec: ttl,
    token,
    lockNamespace: SHORT_NAMESPACE,
    lockKeyPrefix: SHORT_KEY_PREFIX,
    ...modeFlags()
  };
}

export async function releaseRedisLock(redis, key, token) {
  let lockKey = '';

  try {
    lockKey = normalizeLockKey(key);
  } catch (error) {
    return {
      ok: false,
      released: false,
      reason: error?.message || 'RELEASE_SHORT_LOCK_INVALID_KEY',
      key: String(key || '').trim(),
      error: error?.message || String(error),
      details: error?.details || null,
      lockNamespace: SHORT_NAMESPACE,
      lockKeyPrefix: SHORT_KEY_PREFIX,
      ...modeFlags()
    };
  }

  const lockToken = String(token || '').trim();

  if (!redis || !lockKey || !lockToken) {
    return {
      ok: false,
      released: false,
      reason: 'RELEASE_SHORT_LOCK_INVALID_INPUT',
      key: lockKey || key,
      lockNamespace: SHORT_NAMESPACE,
      lockKeyPrefix: SHORT_KEY_PREFIX,
      ...modeFlags()
    };
  }

  try {
    const atomic = await atomicRelease(redis, lockKey, lockToken);

    if (atomic === true) {
      return {
        ok: true,
        released: true,
        reason: 'SHORT_LOCK_RELEASED_ATOMIC',
        key: lockKey,
        lockNamespace: SHORT_NAMESPACE,
        lockKeyPrefix: SHORT_KEY_PREFIX,
        ...modeFlags()
      };
    }

    if (atomic === false) {
      return {
        ok: false,
        released: false,
        reason: 'SHORT_LOCK_TOKEN_MISMATCH_OR_ALREADY_EXPIRED',
        key: lockKey,
        lockNamespace: SHORT_NAMESPACE,
        lockKeyPrefix: SHORT_KEY_PREFIX,
        ...modeFlags()
      };
    }

    return await fallbackRelease(redis, lockKey, lockToken);
  } catch (error) {
    try {
      return await fallbackRelease(redis, lockKey, lockToken);
    } catch (fallbackError) {
      return {
        ok: false,
        released: false,
        reason: 'SHORT_LOCK_RELEASE_FAILED',
        key: lockKey,
        error: fallbackError?.message || error?.message || String(fallbackError || error),
        lockNamespace: SHORT_NAMESPACE,
        lockKeyPrefix: SHORT_KEY_PREFIX,
        ...modeFlags()
      };
    }
  }
}

export async function withRedisLock(redis, key, ttlSec, task) {
  if (typeof task !== 'function') {
    throw new Error('WITH_SHORT_REDIS_LOCK_TASK_MUST_BE_FUNCTION');
  }

  const lockKey = normalizeLockKey(key);
  const lock = await acquireRedisLock(redis, lockKey, ttlSec);

  if (!lock.acquired) {
    return {
      ok: false,
      skipped: true,
      reason: lock.reason,
      lockKey,
      ttlSec: lock.ttlSec,
      lockNamespace: SHORT_NAMESPACE,
      lockKeyPrefix: SHORT_KEY_PREFIX,
      ...modeFlags()
    };
  }

  let taskResult;
  let taskError;
  let releaseResult;

  try {
    taskResult = await task({
      lockKey,
      lockToken: lock.token,
      lockTtlSec: lock.ttlSec,
      lockNamespace: SHORT_NAMESPACE,
      lockKeyPrefix: SHORT_KEY_PREFIX,
      ...modeFlags()
    });
  } catch (error) {
    taskError = error;
  }

  releaseResult = await releaseRedisLock(redis, lockKey, lock.token);

  if (taskError) {
    taskError.lockReleased = Boolean(releaseResult?.released);
    taskError.lockReleaseReason = releaseResult?.reason || null;
    taskError.lockKey = lockKey;
    taskError.lockNamespace = SHORT_NAMESPACE;
    taskError.lockKeyPrefix = SHORT_KEY_PREFIX;
    taskError.tradeSide = TARGET_TRADE_SIDE;
    taskError.dashboardSide = TARGET_DASHBOARD_SIDE;
    taskError.longDisabled = true;
    taskError.realOrdersDisabled = true;
    taskError.bitgetOrdersDisabled = true;
    taskError.exchangeOrdersDisabled = true;
    taskError.trueMicroFamilySchema = TRUE_MICRO_SCHEMA;
    taskError.parentTrueMicroFamilySchema = PARENT_TRUE_MICRO_SCHEMA;
    taskError.childTrueMicroFamilySchema = CHILD_TRUE_MICRO_SCHEMA;
    taskError.riskGeometryRule = 'SHORT: tp < entry < sl';
    taskError.tpHitRule = 'SHORT: price <= tp';
    taskError.slHitRule = 'SHORT: price >= sl';
    taskError.grossRFormula = '(entry - exitPrice) / (initialSl - entry)';
    taskError.currentRFormula = '(entry - currentPrice) / (initialSl - entry)';
    taskError.currentFitPolarity = 'BEARISH_POSITIVE_BULLISH_NEGATIVE';
    taskError.currentFitDefinition = 'SHORT_MIRRORED_CURRENT_FIT';
    taskError.longRootTouched = false;

    throw taskError;
  }

  return {
    ok: true,
    skipped: false,
    lockKey,
    ttlSec: lock.ttlSec,
    lockReleased: Boolean(releaseResult?.released),
    lockReleaseReason: releaseResult?.reason || null,
    result: taskResult,
    lockNamespace: SHORT_NAMESPACE,
    lockKeyPrefix: SHORT_KEY_PREFIX,
    ...modeFlags()
  };
}