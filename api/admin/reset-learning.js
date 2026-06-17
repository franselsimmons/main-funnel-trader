// ================= FILE: api/admin/reset-learning.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey
} from '../../src/utils.js';
import {
  getDurableRedis,
  pushJsonLog,
  delPattern
} from '../../src/redis.js';
import { sendResetReport } from '../../src/discord/discord.js';

const CONFIRM_TEXT = 'RESET_LEARNING_SHORT';
const LOCK_TTL_SEC = 180;

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY';
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const DELETE_SCAN_COUNT = 10_000;

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

const SHORT_CONFIRMATION_PROFILES = new Set([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const SETUP_ORDER = [
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
];

const REGIME_ORDER = [
  'TREND',
  'CHOP',
  'SQUEEZE'
];

const CONFIRMATION_PROFILE_ORDER = [
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
];

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
  const raw = String(callMaybeKey(key, fallback) || '').trim();

  if (!raw) return null;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function namespacedShortPattern(pattern, fallback = null) {
  return namespacedShortKey(pattern, fallback);
}

const SHORT_KEYS = {
  reset: {
    logList: namespacedShortKey(
      KEYS.short?.reset?.logList ||
        KEYS.reset?.shortLogList ||
        KEYS.reset?.logList,
      'RESET:LOGS'
    )
  },

  trade: {
    lock: namespacedShortKey(
      KEYS.short?.trade?.lock ||
        KEYS.trade?.shortLock ||
        KEYS.trade?.lock,
      'TRADE:LOCK'
    )
  },

  analyze: {
    resetLearningLock: namespacedShortKey('ADMIN:RESET_LEARNING:LOCK'),

    freezeLock: namespacedShortKey(
      KEYS.short?.analyze?.freezeLock ||
        KEYS.analyze?.shortFreezeLock ||
        KEYS.analyze?.freezeLock,
      'ANALYZE:WEEKLY_FREEZE_LOCK'
    ),

    activateLock: namespacedShortKey(
      KEYS.short?.analyze?.activateLock ||
        KEYS.analyze?.shortActivateLock ||
        KEYS.analyze?.activateLock,
      'ANALYZE:ROTATION_ACTIVATE_LOCK'
    ),

    nextRotation: namespacedShortKey(
      KEYS.short?.analyze?.nextRotation ||
        KEYS.analyze?.shortNextRotation ||
        KEYS.analyze?.nextRotation,
      'ANALYZE:NEXT_ROTATION'
    ),

    rotationValidFrom: namespacedShortKey(
      KEYS.short?.analyze?.rotationValidFrom ||
        KEYS.analyze?.shortRotationValidFrom ||
        KEYS.analyze?.rotationValidFrom,
      'ANALYZE:ROTATION_VALID_FROM'
    ),

    activeRotation: namespacedShortKey(
      KEYS.short?.analyze?.activeRotation ||
        KEYS.analyze?.shortActiveRotation ||
        KEYS.analyze?.activeRotation,
      'ANALYZE:ACTIVE_ROTATION'
    ),

    obsLastPattern: namespacedShortPattern(
      KEYS.short?.analyze?.obsLastPattern ||
        KEYS.analyze?.shortObsLastPattern,
      'ANALYZE:OBS:LAST:*'
    ),

    outcomePattern: namespacedShortPattern(
      KEYS.short?.analyze?.outcomePattern ||
        KEYS.analyze?.shortOutcomePattern,
      'ANALYZE:OUTCOME:*'
    ),

    shadowPattern: namespacedShortPattern(
      KEYS.short?.analyze?.shadowPattern ||
        KEYS.analyze?.shortShadowPattern,
      'ANALYZE:SHADOW:*'
    ),

    microPattern: namespacedShortPattern(
      KEYS.short?.analyze?.microPattern ||
        KEYS.analyze?.shortMicroPattern,
      'ANALYZE:MICRO:*'
    ),

    weekPattern: namespacedShortPattern(
      KEYS.short?.analyze?.weekPattern ||
        KEYS.analyze?.shortWeekPattern,
      'ANALYZE:WEEK:*'
    ),

    scannerFingerprintPattern: namespacedShortPattern(
      KEYS.short?.analyze?.scannerFingerprintPattern ||
        KEYS.analyze?.shortScannerFingerprintPattern,
      'ANALYZE:*SCANNER*'
    ),

    executionFingerprintPattern: namespacedShortPattern(
      KEYS.short?.analyze?.executionFingerprintPattern ||
        KEYS.analyze?.shortExecutionFingerprintPattern,
      'ANALYZE:*EXECUTION*'
    )
  }
};

const LOCK_KEYS = {
  resetLearning: SHORT_KEYS.analyze.resetLearningLock,
  trade: SHORT_KEYS.trade.lock,
  freeze: SHORT_KEYS.analyze.freezeLock,
  activate: SHORT_KEYS.analyze.activateLock
};

function now() {
  return Date.now();
}

function modeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualOnly: true,
    virtualLearning: true,
    virtualLearningForced: true,
    virtualTracked: true,
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

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    oneOpenPositionPerSymbol: true,

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
    timeStopEnabled: true,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,

    executionFingerprintRole: 'METADATA_ONLY',
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,
    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableIdsAreChildrenOnly: true,
    parentIdsAreMetadataOnly: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionPreserved: true,
    activeRotationPreserved: true,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    statusRules: {
      OBSERVING: 'completed == 0',
      EARLY_OUTCOMES: `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,
      ACTIVE_LEARNING: `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    weekResetDisabled: true,
    isoWeekLearningDisabled: true,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['POST'],
    ...modeFlags()
  });
}

function parseJson(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body.trim());
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8').trim());

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();

  return parseJson(text);
}

function isConfirmed(body = {}) {
  return (
    body.confirm === CONFIRM_TEXT ||
    body.confirmed === CONFIRM_TEXT ||
    body.confirmation === CONFIRM_TEXT
  );
}

function isTrue(value) {
  return (
    value === true ||
    value === 'true' ||
    value === 'TRUE' ||
    value === 1 ||
    value === '1' ||
    value === 'yes' ||
    value === 'YES' ||
    value === 'on' ||
    value === 'ON'
  );
}

function wantsForbiddenRotationReset(body = {}) {
  return (
    isTrue(body.resetRotation) ||
    isTrue(body.clearRotation) ||
    isTrue(body.resetManualSelection) ||
    isTrue(body.clearManualSelection) ||
    isTrue(body.wipeRotation)
  );
}

async function acquireLock(redis, key, token) {
  if (!redis || !key || !token) return true;

  const acquired = await redis.set(key, token, {
    nx: true,
    ex: LOCK_TTL_SEC
  });

  return Boolean(acquired);
}

async function releaseLock(redis, key, token) {
  try {
    if (!redis || !key || !token) return false;

    const current = await redis.get(key);

    if (current !== token) return false;

    await redis.del(key);

    return true;
  } catch {
    return false;
  }
}

async function acquireOneLock({
  redis,
  key,
  token,
  reason,
  acquired
}) {
  if (!key) {
    return {
      ok: true,
      acquired
    };
  }

  const ok = await acquireLock(redis, key, token);

  if (!ok) {
    return {
      ok: false,
      reason,
      acquired
    };
  }

  acquired.push(key);

  return {
    ok: true,
    acquired
  };
}

async function acquireResetLearningLocks(redis, token) {
  const acquired = [];

  const steps = [
    {
      key: LOCK_KEYS.resetLearning,
      reason: 'SHORT_RESET_LEARNING_ALREADY_RUNNING'
    },
    {
      key: LOCK_KEYS.trade,
      reason: 'SHORT_TRADE_RUN_ACTIVE'
    },
    {
      key: LOCK_KEYS.freeze,
      reason: 'SHORT_WEEKLY_FREEZE_ACTIVE'
    },
    {
      key: LOCK_KEYS.activate,
      reason: 'SHORT_ROTATION_ACTIVATE_ACTIVE'
    }
  ];

  for (const step of steps) {
    const result = await acquireOneLock({
      redis,
      key: step.key,
      token,
      reason: step.reason,
      acquired
    });

    if (!result.ok) return result;
  }

  return {
    ok: true,
    acquired
  };
}

async function releaseLocks(redis, keys, token) {
  const released = [];

  for (const key of [...keys].reverse()) {
    const ok = await releaseLock(redis, key, token);

    released.push({
      key,
      released: ok
    });
  }

  return released;
}

async function delKey(redis, key) {
  if (!redis || !key) return 0;

  return redis.del(key).catch(() => 0);
}

async function delPatternSafe(redis, pattern, count = DELETE_SCAN_COUNT) {
  if (!redis || !pattern) return 0;

  return delPattern(redis, pattern, count).catch(() => 0);
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function getWeekKeyCandidates(body = {}) {
  return uniqueStrings([
    PERSISTENT_LEARNING_KEY,
    getPreviousIsoWeekKey(),
    getIsoWeekKey(),
    firstValue(body.weekKey, null),
    firstValue(body.currentWeekKey, null),
    firstValue(body.previousWeekKey, null),
    ...(Array.isArray(body.weekKeys) ? body.weekKeys : [])
  ]);
}

function baseWeekMicrosKey(weekKey) {
  if (typeof KEYS.short?.analyze?.weekMicros === 'function') {
    return KEYS.short.analyze.weekMicros(weekKey);
  }

  if (typeof KEYS.analyze?.shortWeekMicros === 'function') {
    return KEYS.analyze.shortWeekMicros(weekKey);
  }

  if (typeof KEYS.analyze?.weekMicros === 'function') {
    return KEYS.analyze.weekMicros(weekKey);
  }

  return `ANALYZE:WEEK:${weekKey}:MICROS`;
}

function baseWeekMetaKey(weekKey) {
  if (typeof KEYS.short?.analyze?.weekMeta === 'function') {
    return KEYS.short.analyze.weekMeta(weekKey);
  }

  if (typeof KEYS.analyze?.shortWeekMeta === 'function') {
    return KEYS.analyze.shortWeekMeta(weekKey);
  }

  if (typeof KEYS.analyze?.weekMeta === 'function') {
    return KEYS.analyze.weekMeta(weekKey);
  }

  return `ANALYZE:WEEK:${weekKey}:META`;
}

function weekMicrosKey(weekKey) {
  return namespacedShortKey(baseWeekMicrosKey(weekKey));
}

function weekMetaKey(weekKey) {
  return namespacedShortKey(baseWeekMetaKey(weekKey));
}

function getWeekStorageKeys(weekKey) {
  const base = weekMicrosKey(weekKey);

  return [
    base,
    `${base}:INDEX`,
    `${base}:TOP`,
    weekMetaKey(weekKey)
  ].filter(Boolean);
}

function getWeekRowPatterns(weekKey) {
  const base = weekMicrosKey(weekKey);

  return [
    `${base}:ROW:*`
  ].filter(Boolean);
}

async function deleteExactKeys(redis, keys = []) {
  const safeKeys = uniqueStrings(keys);

  if (!safeKeys.length) return 0;

  let deleted = 0;

  for (const key of safeKeys) {
    deleted += await delKey(redis, key);
  }

  return deleted;
}

async function deletePatterns(redis, patterns = []) {
  const safePatterns = uniqueStrings(patterns);

  if (!safePatterns.length) return 0;

  let deleted = 0;

  for (const pattern of safePatterns) {
    deleted += await delPatternSafe(redis, pattern);
  }

  return deleted;
}

function buildTaxonomyMeta() {
  return {
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,

    setups: SETUP_ORDER,
    regimes: REGIME_ORDER,
    confirmationProfiles: CONFIRMATION_PROFILE_ORDER,

    validSetupTypes: [...SHORT_FIXED_SETUP_TYPES],
    validRegimeBuckets: [...SHORT_FIXED_REGIME_BUCKETS],
    validConfirmationProfiles: [...SHORT_CONFIRMATION_PROFILES],

    parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableChildFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

    exampleParent: 'MICRO_SHORT_BREAKOUT_TREND',
    exampleSelectableChild: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',

    selectableIdsAreChildrenOnly: true,
    parentIdsAreMetadataOnly: true
  };
}

async function runLearningDeleteSteps(redis, body = {}) {
  const allWeeks = isTrue(body.allWeeks ?? body.full ?? true);
  const weekKeys = getWeekKeyCandidates(body);

  const weekMainKeys = weekKeys.flatMap(getWeekStorageKeys);
  const weekRowPatterns = weekKeys.flatMap(getWeekRowPatterns);

  const deleted = {
    weekKeys,
    allWeeks,

    exactWeekStorageKeys: await deleteExactKeys(redis, weekMainKeys),
    shardedWeekRows: await deletePatterns(redis, weekRowPatterns),

    observationDedupe: await delPatternSafe(
      redis,
      SHORT_KEYS.analyze.obsLastPattern
    ),

    outcomeDedupe: await delPatternSafe(
      redis,
      SHORT_KEYS.analyze.outcomePattern
    ),

    shadowAnalyzeData: await delPatternSafe(
      redis,
      SHORT_KEYS.analyze.shadowPattern
    ),

    legacyMicroData: await delPatternSafe(
      redis,
      SHORT_KEYS.analyze.microPattern
    )
  };

  if (allWeeks) {
    deleted.allWeekAnalyzeData = await delPatternSafe(
      redis,
      SHORT_KEYS.analyze.weekPattern
    );
  } else {
    deleted.allWeekAnalyzeData = 0;
  }

  deleted.nextRotation = await delKey(
    redis,
    SHORT_KEYS.analyze.nextRotation
  );

  deleted.rotationValidFrom = await delKey(
    redis,
    SHORT_KEYS.analyze.rotationValidFrom
  );

  deleted.activeRotation = 0;

  return deleted;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Reset-Learning-Mode', 'short-only-75-child-virtual-learning-v1');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Net-Outcomes-Only', 'true');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Selectable-Child-Micro-Families', '75');
  res.setHeader('X-Parent-Micro-Families', '15');
  res.setHeader('X-Manual-Selection-Preserved', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
  res.setHeader('X-Active-Rotation-Preserved', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');

  const token = randomUUID();
  let redis = null;
  let acquiredLocks = [];

  try {
    if (req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);

    if (!isConfirmed(body)) {
      return res.status(400).json({
        ok: false,
        blocked: true,
        reason: 'SHORT_CONFIRMATION_REQUIRED',
        required: CONFIRM_TEXT,
        ...modeFlags()
      });
    }

    if (wantsForbiddenRotationReset(body)) {
      return res.status(400).json({
        ok: false,
        blocked: true,
        reason: 'SHORT_ROTATION_RESET_NOT_ALLOWED_HERE',
        note: 'reset-learning wist alleen SHORT leerdata. Handmatige SHORT 75-child selectie blijft bewaard.',
        ...modeFlags()
      });
    }

    redis = getDurableRedis();

    const lockResult = await acquireResetLearningLocks(redis, token);
    acquiredLocks = lockResult.acquired || [];

    if (!lockResult.ok) {
      const released = await releaseLocks(redis, acquiredLocks, token);
      acquiredLocks = [];

      return res.status(409).json({
        ok: false,
        blocked: true,
        reason: lockResult.reason,
        released,
        ...modeFlags()
      });
    }

    const deleted = await runLearningDeleteSteps(redis, body);

    const report = {
      ok: true,
      type: 'RESET_LEARNING_SHORT_75_CHILD_ONLY_VIRTUAL',

      ...modeFlags(),

      taxonomy: buildTaxonomyMeta(),

      exchangeTouched: false,
      bitgetOrdersTouched: false,
      realOrdersTouched: false,
      longRootTouched: false,

      deleted,

      preserved: {
        longRoot: true,
        longRedisKeys: true,
        activeRotation: true,
        manualSelection: true,
        selected75ChildTrueMicroFamilyIds: true,
        openVirtualPositions: true,
        scannerSnapshots: true,
        tradeRunMeta: true,
        resetLogs: true,
        discordLogs: true,
        environmentVariables: true,
        deploymentConfig: true
      },

      removed: {
        weekMicros: true,
        weekMeta: true,
        weekTopSnapshots: true,
        shardedWeekRows: true,
        observationDedupe: true,
        outcomeDedupe: true,
        shadowAnalyzeData: true,
        legacyMicroData: true,
        nextRotation: true,
        rotationValidFrom: true,

        activeRotation: false,
        manualSelection: false,
        selected75ChildTrueMicroFamilyIds: false,
        openVirtualPositions: false,
        scannerSnapshots: false,
        tradeRunMeta: false,
        discordLogs: false,
        longRoot: false
      },

      shortKeys: {
        namespace: SHORT_NAMESPACE,
        prefix: SHORT_KEY_PREFIX,
        resetLogList: SHORT_KEYS.reset.logList,
        locks: LOCK_KEYS,
        analyze: SHORT_KEYS.analyze
      },

      resetAt: now()
    };

    await pushJsonLog(
      redis,
      SHORT_KEYS.reset.logList,
      report,
      100
    ).catch(() => null);

    await sendResetReport(report).catch(() => null);

    return res.status(200).json(report);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,
      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  } finally {
    if (redis && acquiredLocks.length > 0) {
      await releaseLocks(redis, acquiredLocks, token);
    }
  }
}