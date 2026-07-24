// ================= FILE: api/trade/run.js =================
// SHORT-only virtual trade runner.
//
// Runtime contract:
// - this route does NOT run the scanner;
// - /api/scanner/run maintains SHORT:SCAN:LATEST;
// - this route reads the existing scanner snapshot;
// - trade execution runs under src/lock.js -> withLock();
// - lock conflicts return HTTP 200 with skipped=true;
// - real exchange orders remain disabled.

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  setJson
} from '../../src/redis.js';
import * as LockApi from '../../src/lock.js';
import { runTradeSystem } from '../../src/trade/tradeSystem.js';
import { sideToTradeSide } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const DEFAULT_LOCK_TTL_SEC = 55;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const DEFAULT_RUNTIME_BUDGET_MS = 50000;
const DEFAULT_RESPONSE_ROW_LIMIT = 150;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';

const LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

const PARENT_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const RUN_SCOPE =
  'TRADE_FROM_EXISTING_SCANNER_SNAPSHOT';

const WRITE_SCOPE =
  'TRADE_AND_ANALYZE_PARTIAL';

const READ_SCOPE =
  'READ_SHORT_SCANNER_AND_MARKET_WEATHER';

const TRADE_LOCK_RESOURCE = 'TRADE_RUN';

const MARKET_UNIVERSE_KEY =
  `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`;

const MARKET_WEATHER_KEY =
  `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`;

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

function safeNumber(
  value,
  fallback = 0
) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function round(
  value,
  decimals = 4
) {
  return Number(
    safeNumber(value, 0)
      .toFixed(decimals)
  );
}

function upper(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function firstValue(
  value,
  fallback = null
) {
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }

  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return fallback;
  }

  return value;
}

function isTrue(value) {
  if (
    value === true ||
    value === 1
  ) {
    return true;
  }

  return [
    'true',
    '1',
    'yes',
    'y',
    'on',
    'force',
    'forced'
  ].includes(
    String(value ?? '')
      .trim()
      .toLowerCase()
  );
}

function callMaybeKey(
  value,
  fallback = null
) {
  if (typeof value === 'function') {
    try {
      return value();
    } catch {
      return fallback;
    }
  }

  return value || fallback;
}

function namespacedShortKey(
  key,
  fallback = null
) {
  let raw = String(
    callMaybeKey(
      key,
      fallback
    ) || ''
  ).trim();

  if (!raw) {
    return null;
  }

  if (
    raw.startsWith(
      SHORT_KEY_PREFIX
    )
  ) {
    return raw;
  }

  if (raw.startsWith('LONG:')) {
    raw = raw.slice(
      'LONG:'.length
    );
  }

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function resolveTradeLockKey() {
  if (
    typeof LockApi.normalizeShortLockKey ===
    'function'
  ) {
    return LockApi.normalizeShortLockKey(
      TRADE_LOCK_RESOURCE
    );
  }

  return (
    `${SHORT_KEY_PREFIX}` +
    `LOCK:${TRADE_LOCK_RESOURCE}`
  );
}

async function executeWithTradeLock({
  durableRedis,
  lockTtlSec,
  callback
}) {
  if (
    typeof LockApi.withLock ===
    'function'
  ) {
    return LockApi.withLock(
      TRADE_LOCK_RESOURCE,
      callback,
      lockTtlSec
    );
  }

  /*
   * Alleen voor compatibiliteit met een
   * oudere lock.js-versie.
   *
   * Door de namespace-import ontstaat geen
   * ESM-importfout wanneer withRedisLock ontbreekt.
   */
  if (
    typeof LockApi.withRedisLock ===
    'function'
  ) {
    return LockApi.withRedisLock(
      durableRedis,
      resolveTradeLockKey(),
      lockTtlSec,
      callback
    );
  }

  throw new Error(
    'TRADE_LOCK_API_MISSING'
  );
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
    lock:
      resolveTradeLockKey(),

    legacyConfiguredLock:
      namespacedShortKey(
        KEYS.short?.trade?.lock ||
          KEYS.trade?.shortLock ||
          KEYS.trade?.lock,

        'TRADE:LOCK'
      ),

    runMeta:
      namespacedShortKey(
        KEYS.short?.trade?.runMeta ||
          KEYS.trade?.shortRunMeta ||
          KEYS.trade?.runMeta,

        'TRADE:RUN_META'
      ),

    lastProcessedSnapshot:
      namespacedShortKey(
        KEYS.short?.trade
          ?.lastProcessedSnapshot ||
          KEYS.trade
            ?.shortLastProcessedSnapshot ||
          KEYS.trade
            ?.lastProcessedSnapshot,

        'TRADE:LAST_PROCESSED_SNAPSHOT'
      )
  },

  market: {
    universeLatest:
      MARKET_UNIVERSE_KEY,

    weatherLatest:
      MARKET_WEATHER_KEY
  }
};

function getPositionTimeStopMin() {
  const value = Number(
    CONFIG.short?.trade
      ?.positionTimeStopMin ??
      CONFIG.trade
        ?.shortPositionTimeStopMin ??
      CONFIG.trade
        ?.positionTimeStopMin ??
      DEFAULT_POSITION_TIME_STOP_MIN
  );

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return DEFAULT_POSITION_TIME_STOP_MIN;
  }

  return Math.floor(value);
}

function getLockTtlSec() {
  const value = Number(
    CONFIG.short?.trade?.lockTtlSec ??
      CONFIG.trade?.shortLockTtlSec ??
      CONFIG.trade?.lockTtlSec ??
      DEFAULT_LOCK_TTL_SEC
  );

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return DEFAULT_LOCK_TTL_SEC;
  }

  return Math.max(
    5,
    Math.min(
      55,
      Math.floor(value)
    )
  );
}

function getRuntimeBudgetMs() {
  const value = Number(
    CONFIG.short?.trade
      ?.runtimeBudgetMs ??
      CONFIG.trade?.runtimeBudgetMs ??
      DEFAULT_RUNTIME_BUDGET_MS
  );

  if (
    !Number.isFinite(value) ||
    value < 5000
  ) {
    return DEFAULT_RUNTIME_BUDGET_MS;
  }

  return Math.min(
    50000,
    Math.floor(value)
  );
}

function getResponseRowLimit(
  req,
  body = {}
) {
  const value = Number(
    firstValue(
      req.query?.responseRowLimit,
      body.responseRowLimit
    )
  );

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return DEFAULT_RESPONSE_ROW_LIMIT;
  }

  return Math.max(
    25,
    Math.min(
      1000,
      Math.floor(value)
    )
  );
}

function isolationFlags() {
  return {
    runScope:
      RUN_SCOPE,

    writeScope:
      WRITE_SCOPE,

    readScope:
      READ_SCOPE,

    adminPageIsolation:
      true,

    doesNotOverwriteOtherAdminPages:
      true,

    scannerPreloadBeforeTrade:
      true,

    scannerPreloadMode:
      'READ_EXISTING_LATEST',

    scannerPreloadRequiredForMarketWeather:
      false,

    readsScannerLatest:
      true,

    scannerLatestReadOnlyInsideTradeSystem:
      true,

    preserveScannerLatest:
      true,

    preserveScannerSnapshot:
      true,

    preserveScannerHistory:
      true,

    scannerRunAllowed:
      false,

    scannerRunBeforeTrade:
      false,

    scannerRunDisabledInsideTradeSystem:
      true,

    noInternalScannerRunInsideTradeSystem:
      true,

    writesScanner:
      false,

    writesScannerLatest:
      false,

    writesScannerSnapshot:
      false,

    writesScannerHistory:
      false,

    writesMarketUniverse:
      true,

    writesMarketWeather:
      true,

    writesMarketWeatherInput:
      false,

    writesTrade:
      true,

    writesTradeRunMeta:
      true,

    writesTradePositions:
      true,

    writesAnalyze:
      true,

    writesAnalyzePartial:
      true,

    writesMicroFamilies:
      true,

    microFamiliesAppendOnly:
      true,

    microFamiliesAntiWipe:
      true,

    analyzePartialOnly:
      true,

    analyzeFullOverwriteDisabled:
      true,

    writesRotation:
      false,

    writesDiscordSelection:
      false,

    writesManualSelection:
      false,

    preserveRotation:
      true,

    preserveManualSelection:
      true,

    preserveDiscordSelection:
      true,

    noResetCron:
      true,

    resetCronDisabled:
      true,

    noActivateCron:
      true,

    activateCronDisabled:
      true,

    noFreezeCron:
      true,

    freezeCronDisabled:
      true,

    autoRotationActivationDisabled:
      true,

    ignoreGlobalMaxOpenPositions:
      true,

    noGlobalMaxOpenPositionsBlock:
      true,

    globalMaxOpenPositionsBlockDisabled:
      true,

    maxOneOpenPositionPerSymbol:
      true,

    oneOpenPositionPerSymbol:
      true
  };
}

function baseFlags() {
  return {
    targetTradeSide:
      TARGET_TRADE_SIDE,

    dashboardSide:
      TARGET_DASHBOARD_SIDE,

    scannerSide:
      TARGET_SCANNER_SIDE,

    oppositeTradeSide:
      OPPOSITE_TRADE_SIDE,

    side:
      TARGET_DASHBOARD_SIDE,

    tradeSide:
      TARGET_TRADE_SIDE,

    positionSide:
      TARGET_TRADE_SIDE,

    direction:
      TARGET_TRADE_SIDE,

    actualScannerSide:
      TARGET_SCANNER_SIDE,

    analysisSide:
      TARGET_TRADE_SIDE,

    shortOnly:
      true,

    longDisabled:
      true,

    longOnly:
      false,

    shortDisabled:
      false,

    virtualOnly:
      true,

    virtualLearning:
      true,

    virtualLearningForced:
      true,

    virtualTracked:
      true,

    source:
      'VIRTUAL',

    outcomeSource:
      'VIRTUAL',

    realOrdersDisabled:
      true,

    exchangeOrdersDisabled:
      true,

    bitgetOrdersDisabled:
      true,

    exchangeCallsDisabled:
      true,

    noExchangeOrders:
      true,

    noRealOrders:
      true,

    realTrade:
      false,

    realOrder:
      false,

    exchangeOrder:
      false,

    bitgetOrderPlaced:
      false,

    learningOnly:
      true,

    microFamilyLearning:
      true,

    observationFirst:
      true,

    observationFirstAnalyze:
      true,

    completedDefinition:
      'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',

    scoringRSource:
      'netR',

    winsLossesFlatsSource:
      'netR',

    winrateDefinition:
      'netR > 0',

    avgRSource:
      'netR',

    totalRSource:
      'netR',

    avgCostRShown:
      true,

    statusRules: {
      OBSERVING:
        'completed == 0',

      EARLY_OUTCOMES:
        `completed > 0 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,

      ACTIVE_LEARNING:
        `completed >= ${MIN_COMPLETED_ACTIVE_LEARNING}`
    },

    scannerFingerprintRole:
      'METADATA_ONLY',

    scannerFingerprintOnlyMetadata:
      true,

    scannerFingerprintsHiddenFromLearning:
      true,

    scannerFingerprintsMetadataOnly:
      true,

    scannerFingerprintsUsedAsLearningFamily:
      false,

    scannerBucketsMetadataOnly:
      true,

    legacy25BucketsMetadataOnly:
      true,

    executionFingerprintRole:
      'METADATA_ONLY',

    executionFingerprintOnlyMetadata:
      true,

    executionFingerprintsMetadataOnly:
      true,

    executionFingerprintsUsedAsLearningFamily:
      false,

    analyzeMicroFamiliesOnly:
      true,

    learningIdentitySource:
      'ANALYZE_TRUE_MICRO_FAMILY',

    exactTrueMicroFamilyRequired:
      true,

    trueMicroOnly:
      true,

    exactTrueMicroOnly:
      true,

    trueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    parentTrueMicroFamilySchema:
      PARENT_TRUE_MICRO_SCHEMA,

    broadTrueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    fixedTaxonomyPreferred:
      true,

    learningGranularity:
      LEARNING_GRANULARITY,

    parentLearningGranularity:
      PARENT_LEARNING_GRANULARITY,

    symbolExcludedFromFamilyId:
      true,

    selectableMicroFamilyCount:
      75,

    parentMicroFamilyCount:
      15,

    selectionGranularity:
      'EXACT_75_CHILD',

    positionTimeStopMinDefault:
      DEFAULT_POSITION_TIME_STOP_MIN,

    positionTimeStopMin:
      getPositionTimeStopMin(),

    shortRiskShape:
      'tp < entry < sl',

    riskTradeSide:
      TARGET_TRADE_SIDE,

    riskGeometryRule:
      'SHORT: tp < entry < sl',

    tpRule:
      'price <= tp',

    slRule:
      'price >= sl',

    tpHitRule:
      'SHORT: price <= tp',

    slHitRule:
      'SHORT: price >= sl',

    grossRFormula:
      '(entry - exitPrice) / (initialSl - entry)',

    currentRFormula:
      '(entry - currentPrice) / (initialSl - entry)',

    currentFitPolarity:
      'BEARISH_POSITIVE_BULLISH_NEGATIVE',

    currentFitDefinition:
      'SHORT_MIRRORED_CURRENT_FIT',

    currentFitSoftOnly:
      true,

    currentFitBlocksLearning:
      false,

    discordOnlyForSelectedMicroFamilies:
      true,

    discordOnlyForManualSelection:
      true,

    discordOnlyForExactTrueMicroMatch:
      true,

    manualSelectionMatchMode:
      'EXACT_TRUE_MICRO_FAMILY_ID',

    manualSelectionRequires75ChildTrueMicroFamilyId:
      true,

    parentMacroMatchDoesNotTriggerDiscord:
      true,

    macroMatchDoesNotTriggerDiscord:
      true,

    persistentLearningKey:
      PERSISTENT_LEARNING_KEY,

    redisNamespace:
      SHORT_NAMESPACE,

    redisKeyPrefix:
      SHORT_KEY_PREFIX,

    redisKeysSeparatedFromLongRoot:
      true,

    longRootTouched:
      false,

    ...isolationFlags()
  };
}

function methodNotAllowed(res) {
  res.setHeader(
    'Allow',
    'GET, POST'
  );

  return res.status(405).json({
    ok:
      false,

    error:
      'METHOD_NOT_ALLOWED',

    allowed: [
      'GET',
      'POST'
    ],

    ...baseFlags()
  });
}

function isAllowedMethod(method) {
  return (
    method === 'GET' ||
    method === 'POST'
  );
}

function parseJson(text) {
  const raw =
    String(text || '').trim();

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error =
      new Error(
        'INVALID_JSON_BODY'
      );

    error.statusCode = 400;

    throw error;
  }
}

async function readBody(req) {
  if (req.method === 'GET') {
    return {};
  }

  if (req.body) {
    if (
      typeof req.body === 'string'
    ) {
      return parseJson(req.body);
    }

    if (
      Buffer.isBuffer(req.body)
    ) {
      return parseJson(
        req.body.toString('utf8')
      );
    }

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk)
    );
  }

  return parseJson(
    Buffer.concat(chunks)
      .toString('utf8')
  );
}

function shouldForceProcessSnapshot(
  req,
  body = {}
) {
  return (
    isTrue(
      firstValue(
        req.query?.force,
        false
      )
    ) ||
    isTrue(
      firstValue(
        req.query?.forced,
        false
      )
    ) ||
    isTrue(
      firstValue(
        req.query
          ?.forceProcessSnapshot,
        false
      )
    ) ||
    isTrue(
      firstValue(
        req.query
          ?.force_process_snapshot,
        false
      )
    ) ||
    isTrue(body.force) ||
    isTrue(body.forced) ||
    isTrue(
      body.forceProcessSnapshot
    ) ||
    isTrue(
      body.force_process_snapshot
    )
  );
}

function shouldMonitorOnly(
  req,
  body = {}
) {
  return (
    isTrue(
      firstValue(
        req.query?.monitorOnly,
        false
      )
    ) ||
    isTrue(
      firstValue(
        req.query?.monitor_only,
        false
      )
    ) ||
    isTrue(body.monitorOnly) ||
    isTrue(body.monitor_only)
  );
}

function getRunSource(
  req,
  body = {}
) {
  const manual =
    isTrue(
      firstValue(
        req.query?.manual,
        false
      )
    ) ||
    shouldForceProcessSnapshot(
      req,
      body
    ) ||
    isTrue(body.manual);

  return manual
    ? 'ADMIN_MANUAL_SHORT_TRADE_RUN_FROM_EXISTING_SCANNER_SNAPSHOT'
    : 'CRON_OR_API_SHORT_TRADE_RUN_FROM_EXISTING_SCANNER_SNAPSHOT';
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll(
      'LONG_DISABLED_FALSE',
      ''
    )
    .replaceAll(
      'LONGDISABLED_FALSE',
      ''
    )
    .replaceAll(
      'BLOCK_LONG_FALSE',
      ''
    )
    .replaceAll(
      'LONG_ENABLED_FALSE',
      ''
    )
    .replaceAll(
      'LONG_ONLY_FALSE',
      ''
    )
    .replaceAll(
      'SHORT_DISABLED_FALSE',
      ''
    )
    .replaceAll(
      'SHORTDISABLED_FALSE',
      ''
    )
    .replaceAll(
      'BLOCK_SHORT_FALSE',
      ''
    )
    .replaceAll(
      'SHORT_ENABLED_FALSE',
      ''
    )
    .replaceAll(
      'SHORT_ONLY_FALSE',
      ''
    )
    .replaceAll(
      'LONG_DISABLED_SHORT_ONLY',
      'SHORT'
    )
    .replaceAll(
      'LONGDISABLED_SHORT_ONLY',
      'SHORT'
    )
    .replaceAll(
      'BLOCK_LONG',
      'SHORT'
    )
    .replaceAll(
      'LONG_DISABLED',
      'SHORT'
    )
    .replaceAll(
      'LONGDISABLED',
      'SHORT'
    )
    .replaceAll(
      'SHORT_DISABLED_LONG_ONLY',
      'LONG'
    )
    .replaceAll(
      'SHORTDISABLED_LONG_ONLY',
      'LONG'
    )
    .replaceAll(
      'BLOCK_SHORT',
      'LONG'
    )
    .replaceAll(
      'SHORT_DISABLED',
      'LONG'
    )
    .replaceAll(
      'SHORTDISABLED',
      'LONG'
    )
    .replaceAll(
      'LONG_ONLY_MODE',
      'LONG'
    )
    .replaceAll(
      'LONG_ONLY',
      'LONG'
    )
    .replaceAll(
      'LONG-ONLY',
      'LONG'
    )
    .replaceAll(
      'SHORT_ONLY_MODE',
      'SHORT'
    )
    .replaceAll(
      'SHORT_ONLY',
      'SHORT'
    )
    .replaceAll(
      'SHORT-ONLY',
      'SHORT'
    );
}

function normalizeTradeSide(value) {
  const raw =
    cleanSideText(value);

  if (!raw) {
    return 'UNKNOWN';
  }

  const converted =
    sideToTradeSide(raw);

  if (
    converted ===
    TARGET_TRADE_SIDE
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (
    converted ===
    OPPOSITE_TRADE_SIDE
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (
    [
      'SHORT',
      'BEAR',
      'BEARISH',
      'SELL',
      'DOWN',
      'DOWNSIDE'
    ].includes(raw)
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (
    [
      'LONG',
      'BULL',
      'BULLISH',
      'BUY',
      'UP',
      'UPSIDE'
    ].includes(raw)
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (
    raw.includes(
      'MICRO_SHORT_'
    )
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (
    raw.includes(
      'MICRO_LONG_'
    )
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferActionTradeSide(
  row = {}
) {
  if (
    typeof row === 'string'
  ) {
    return normalizeTradeSide(row);
  }

  if (
    !row ||
    typeof row !== 'object'
  ) {
    return 'UNKNOWN';
  }

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

  for (
    const value
    of directSources
  ) {
    const side =
      normalizeTradeSide(value);

    if (
      side !== 'UNKNOWN'
    ) {
      return side;
    }
  }

  const haystack = [
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.scannerMicroFamilyId,
    row.executionMicroFamilyId,
    row.familyId,
    row.id,
    row.key,
    row.scannerReason,
    row.reason,
    row.exitReason,
    row.definition,

    ...(
      Array.isArray(
        row.definitionParts
      )
        ? row.definitionParts
        : []
    )
  ]
    .map(
      (value) =>
        String(value || '').trim()
    )
    .filter(Boolean)
    .join('|');

  const inferred =
    normalizeTradeSide(haystack);

  if (
    inferred !== 'UNKNOWN'
  ) {
    return inferred;
  }

  if (
    row.shortOnly === true ||
    row.longDisabled === true
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (
    row.longOnly === true ||
    row.shortDisabled === true
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortAction(
  row = {}
) {
  return (
    inferActionTradeSide(row) !==
    OPPOSITE_TRADE_SIDE
  );
}

function isLongAction(
  row = {}
) {
  return (
    inferActionTradeSide(row) ===
    OPPOSITE_TRADE_SIDE
  );
}

function parseShortFixedTaxonomyId(
  id = ''
) {
  const match =
    /^MICRO_SHORT_([A-Z_]+)_(TREND|CHOP|SQUEEZE)(?:_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA))?$/
      .exec(upper(id));

  if (!match) {
    return null;
  }

  const setup =
    match[1];

  const regime =
    match[2];

  const confirmation =
    match[3] || null;

  if (
    !SHORT_FIXED_SETUP_TYPES
      .has(setup)
  ) {
    return null;
  }

  if (
    !SHORT_FIXED_REGIME_BUCKETS
      .has(regime)
  ) {
    return null;
  }

  if (
    confirmation &&
    !SHORT_FIXED_CONFIRMATION_PROFILES
      .has(confirmation)
  ) {
    return null;
  }

  const parentTrueMicroFamilyId =
    `MICRO_SHORT_${setup}_${regime}`;

  return {
    setup,
    regime,
    confirmation,

    parentTrueMicroFamilyId,

    childTrueMicroFamilyId:
      confirmation
        ? `${parentTrueMicroFamilyId}_${confirmation}`
        : null,

    isParent:
      !confirmation,

    isChild:
      Boolean(confirmation)
  };
}

function isSelectableTrueMicroId(
  id = ''
) {
  return (
    parseShortFixedTaxonomyId(id)
      ?.isChild === true
  );
}

function isSelectableParentTrueMicroId(
  id = ''
) {
  return (
    parseShortFixedTaxonomyId(id)
      ?.isParent === true
  );
}

function parentFromChildTrueMicroFamilyId(
  id = ''
) {
  const parsed =
    parseShortFixedTaxonomyId(id);

  return parsed?.isChild
    ? parsed.parentTrueMicroFamilyId
    : null;
}

function isScannerFingerprintId(
  id = ''
) {
  const value =
    upper(id);

  return (
    value.includes(
      'SCANNER__'
    ) ||
    value.includes(
      '_SCANNER_'
    ) ||
    value.includes(
      'SCANNER_GATE_PASS'
    ) ||
    value.includes(
      'SCANNER_GATE_FAIL'
    )
  );
}

function isExecutionFingerprintId(
  id = ''
) {
  const value =
    upper(id);

  return (
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes(
      'EXECUTION_FINGERPRINT'
    ) ||
    value.includes(
      'EXECUTION_MICRO'
    ) ||
    value.includes(
      'REFINED_EXECUTION'
    )
  );
}

function validLearningId(
  id = ''
) {
  const value =
    String(id || '').trim();

  return Boolean(
    value &&
    !isScannerFingerprintId(
      value
    ) &&
    !isExecutionFingerprintId(
      value
    )
  );
}

function firstCleanId(
  values = []
) {
  for (const value of values) {
    const id =
      upper(value);

    if (
      id &&
      validLearningId(id)
    ) {
      return id;
    }
  }

  return '';
}

function normalizeLearningIdentity(
  row = {}
) {
  const childCandidate =
    firstCleanId([
      row.trueMicroFamilyId,
      row.learningMicroFamilyId,
      row.analyzeMicroFamilyId,
      row.childTrueMicroFamilyId,
      row.microFamilyId
    ]);

  const childTrueMicroFamilyId =
    isSelectableTrueMicroId(
      childCandidate
    )
      ? childCandidate
      : null;

  const parentCandidate =
    firstCleanId([
      row.parentTrueMicroFamilyId,
      row.parentMicroFamilyId,
      row.parentMacroFamilyId,
      row.coarseMicroFamilyId,
      parentFromChildTrueMicroFamilyId(
        childTrueMicroFamilyId
      )
    ]);

  const parentTrueMicroFamilyId =
    isSelectableParentTrueMicroId(
      parentCandidate
    )
      ? parentCandidate
      : parentFromChildTrueMicroFamilyId(
          childTrueMicroFamilyId
        );

  return {
    microFamilyId:
      childTrueMicroFamilyId,

    trueMicroFamilyId:
      childTrueMicroFamilyId,

    analyzeMicroFamilyId:
      childTrueMicroFamilyId,

    learningMicroFamilyId:
      childTrueMicroFamilyId,

    childTrueMicroFamilyId,

    parentTrueMicroFamilyId,

    parentMicroFamilyId:
      parentTrueMicroFamilyId,

    parentMacroFamilyId:
      parentTrueMicroFamilyId,

    macroFamilyId:
      parentTrueMicroFamilyId,

    coarseMicroFamilyId:
      parentTrueMicroFamilyId,

    fixedTaxonomyLearningId:
      Boolean(
        childTrueMicroFamilyId
      ),

    fixedTaxonomyParentId:
      Boolean(
        parentTrueMicroFamilyId
      ),

    trueMicroFamilySchema:
      childTrueMicroFamilyId
        ? TRUE_MICRO_SCHEMA
        : null,

    parentTrueMicroFamilySchema:
      parentTrueMicroFamilyId
        ? PARENT_TRUE_MICRO_SCHEMA
        : null,

    learningGranularity:
      LEARNING_GRANULARITY,

    parentLearningGranularity:
      PARENT_LEARNING_GRANULARITY
  };
}

function forceShortVirtualRow(
  row = {}
) {
  const identity =
    normalizeLearningIdentity(row);

  return {
    ...row,
    ...identity,
    ...baseFlags(),

    side:
      TARGET_DASHBOARD_SIDE,

    tradeSide:
      TARGET_TRADE_SIDE,

    positionSide:
      TARGET_TRADE_SIDE,

    direction:
      TARGET_TRADE_SIDE,

    targetTradeSide:
      TARGET_TRADE_SIDE,

    dashboardSide:
      TARGET_DASHBOARD_SIDE,

    scannerSide:
      TARGET_SCANNER_SIDE,

    actualScannerSide:
      TARGET_SCANNER_SIDE,

    source:
      row.source ||
      'VIRTUAL',

    outcomeSource:
      row.outcomeSource ||
      row.source ||
      'VIRTUAL',

    hasAnalyzeMicroFamilyId:
      Boolean(
        identity.trueMicroFamilyId
      ),

    selectedMicroFamilyAlert:
      Boolean(
        row.selectedMicroFamilyAlert &&
        identity.trueMicroFamilyId
      ),

    discordAlertEligible:
      Boolean(
        row.discordAlertEligible &&
        row.selectedMicroFamilyAlert &&
        identity.trueMicroFamilyId
      )
  };
}

function normalizeExitMath(
  row = {}
) {
  const entry =
    safeNumber(
      row.entry ??
      row.entryPrice,
      0
    );

  const initialSl =
    safeNumber(
      row.initialSl ??
      row.initialStopLoss ??
      row.sl ??
      row.stopLoss,
      0
    );

  const exitPrice =
    safeNumber(
      row.exitPrice ??
      row.currentPrice ??
      row.lastPrice ??
      row.price,
      0
    );

  const currentPrice =
    safeNumber(
      row.currentPrice ??
      row.lastPrice ??
      row.price ??
      exitPrice,
      0
    );

  const tp =
    safeNumber(
      row.tp ??
      row.takeProfit,
      0
    );

  const riskDistance =
    entry > 0 &&
    initialSl > entry
      ? initialSl - entry
      : 0;

  const grossR =
    riskDistance > 0
      ? (
          entry -
          exitPrice
        ) / riskDistance
      : safeNumber(
          row.shortGrossR ??
          row.grossR,
          0
        );

  const currentR =
    riskDistance > 0
      ? (
          entry -
          currentPrice
        ) / riskDistance
      : safeNumber(
          row.shortCurrentR ??
          row.currentR,
          0
        );

  const netR =
    safeNumber(
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
    entry:
      round(entry, 10),

    initialSl:
      round(initialSl, 10),

    sl:
      round(
        row.sl ??
        row.stopLoss ??
        initialSl,
        10
      ),

    tp:
      round(tp, 10),

    exitPrice:
      round(exitPrice, 10),

    currentPrice:
      round(currentPrice, 10),

    validShortGeometry:
      tp > 0 &&
      entry > 0 &&
      initialSl > 0 &&
      tp < entry &&
      entry < initialSl,

    shortTpHit:
      exitPrice > 0 &&
      tp > 0 &&
      exitPrice <= tp,

    shortSlHit:
      exitPrice > 0 &&
      initialSl > 0 &&
      exitPrice >= initialSl,

    grossR:
      round(grossR, 4),

    shortGrossR:
      round(grossR, 4),

    currentR:
      round(currentR, 4),

    shortCurrentR:
      round(currentR, 4),

    netR:
      round(netR, 4),

    r:
      round(netR, 4),

    realizedR:
      round(
        row.realizedR ??
        netR,
        4
      ),

    costR:
      round(
        row.costR ??
        row.totalCostR,
        4
      ),

    avgCostR:
      round(
        row.avgCostR ??
        row.costR ??
        row.totalCostR,
        4
      )
  };
}

function sanitizeRows(
  rows = [],
  limit =
    DEFAULT_RESPONSE_ROW_LIMIT
) {
  return (
    Array.isArray(rows)
      ? rows
      : []
  )
    .filter(isShortAction)
    .slice(0, limit)
    .map(forceShortVirtualRow);
}

function sanitizeExitRows(
  rows = [],
  limit =
    DEFAULT_RESPONSE_ROW_LIMIT
) {
  return sanitizeRows(
    rows,
    limit
  ).map(
    (row) => ({
      ...row,
      ...normalizeExitMath(row),

      action:
        'VIRTUAL_EXIT',

      source:
        'VIRTUAL',

      outcomeSource:
        'VIRTUAL'
    })
  );
}

function selectRawExitRows(
  payload = {}
) {
  if (
    Array.isArray(
      payload.virtualExits
    )
  ) {
    return payload.virtualExits;
  }

  if (
    Array.isArray(
      payload.shadowExits
    )
  ) {
    return payload.shadowExits;
  }

  if (
    Array.isArray(
      payload.exits
    )
  ) {
    return payload.exits;
  }

  if (
    Array.isArray(
      payload.closedPositions
    )
  ) {
    return payload.closedPositions;
  }

  if (
    Array.isArray(
      payload.outcomes
    )
  ) {
    return payload.outcomes;
  }

  return [];
}

function selectRawEntryRows(
  payload = {},
  actions = []
) {
  if (
    Array.isArray(
      payload.entryRows
    )
  ) {
    return payload.entryRows;
  }

  if (
    Array.isArray(
      payload.entries
    )
  ) {
    return payload.entries;
  }

  if (
    Array.isArray(
      payload.virtualCreatedRows
    )
  ) {
    return payload
      .virtualCreatedRows;
  }

  if (
    Array.isArray(
      payload.shadowCreatedRows
    )
  ) {
    return payload
      .shadowCreatedRows;
  }

  return actions.filter(
    (row) => (
      row?.action ===
        'VIRTUAL_ENTRY' ||
      row?.action ===
        'ENTRY'
    )
  );
}

function selectRawWaitRows(
  payload = {},
  actions = []
) {
  if (
    Array.isArray(
      payload.waitRows
    )
  ) {
    return payload.waitRows;
  }

  if (
    Array.isArray(
      payload.waits
    )
  ) {
    return payload.waits;
  }

  return actions.filter(
    (row) =>
      row?.action === 'WAIT'
  );
}

function countActionsByType(
  actions = []
) {
  return (
    Array.isArray(actions)
      ? actions
      : []
  ).reduce(
    (acc, row) => {
      const key =
        row?.action ||
        row?.type ||
        'UNKNOWN';

      acc[key] =
        safeNumber(
          acc[key],
          0
        ) + 1;

      return acc;
    },
    {}
  );
}

function mergeActionCounts(
  ...counts
) {
  return counts.reduce(
    (acc, row) => {
      for (
        const [key, value]
        of Object.entries(
          row || {}
        )
      ) {
        acc[key] =
          safeNumber(
            acc[key],
            0
          ) +
          safeNumber(
            value,
            0
          );
      }

      return acc;
    },
    {}
  );
}

function sanitizeTrueMicroIds(
  ids = []
) {
  return [
    ...new Set(
      (
        Array.isArray(ids)
          ? ids
          : [ids]
      )
        .flat(Infinity)
        .map(upper)
        .filter(
          isSelectableTrueMicroId
        )
    )
  ];
}

function sanitizeParentIds(
  ids = []
) {
  return [
    ...new Set(
      (
        Array.isArray(ids)
          ? ids
          : [ids]
      )
        .flat(Infinity)
        .map(upper)
        .filter(
          isSelectableParentTrueMicroId
        )
    )
  ];
}

function sanitizeRunPayload(
  payload,
  {
    rowLimit =
      DEFAULT_RESPONSE_ROW_LIMIT
  } = {}
) {
  if (
    !payload ||
    typeof payload !== 'object'
  ) {
    return payload;
  }

  const rawActions =
    Array.isArray(
      payload.actions
    )
      ? payload.actions
      : [];

  const rawExitRows =
    selectRawExitRows(payload);

  const shortRawActions =
    rawActions.filter(
      isShortAction
    );

  const shortRawExitRows =
    rawExitRows.filter(
      isShortAction
    );

  const actions =
    sanitizeRows(
      shortRawActions,
      rowLimit
    );

  const virtualExits =
    sanitizeExitRows(
      shortRawExitRows,
      rowLimit
    );

  const entryRowsList =
    sanitizeRows(
      selectRawEntryRows(
        payload,
        shortRawActions
      ),
      rowLimit
    );

  const waitRowsList =
    sanitizeRows(
      selectRawWaitRows(
        payload,
        shortRawActions
      ),
      rowLimit
    );

  const activeMicroFamilyIds =
    sanitizeTrueMicroIds(
      payload.activeMicroFamilyIds ||
      payload.selectedMicroFamilyIds ||
      payload.trueMicroFamilyIds ||
      payload.microFamilyIds ||
      []
    );

  const selectedMicroFamilyIds =
    sanitizeTrueMicroIds(
      payload.selectedMicroFamilyIds ||
      payload.activeMicroFamilyIds ||
      payload.trueMicroFamilyIds ||
      payload.microFamilyIds ||
      []
    );

  const activeMacroFamilyIds =
    sanitizeParentIds(
      payload.activeMacroFamilyIds ||
      payload.selectedMacroFamilyIds ||
      payload.macroFamilyIds ||
      []
    );

  const selectedMacroFamilyIds =
    sanitizeParentIds(
      payload.selectedMacroFamilyIds ||
      payload.activeMacroFamilyIds ||
      payload.macroFamilyIds ||
      []
    );

  const actionCounts =
    mergeActionCounts(
      payload.actionCounts || {},

      countActionsByType(
        shortRawActions
      ),

      countActionsByType(
        shortRawExitRows.map(
          (row) => ({
            ...row,

            action:
              'VIRTUAL_EXIT'
          })
        )
      )
    );

  const entryRows =
    safeNumber(
      Array.isArray(
        payload.entryRows
      )
        ? payload.entryRows
            .filter(
              isShortAction
            )
            .length
        : payload.entryRows ??
          entryRowsList.length,

      entryRowsList.length
    );

  const waitRows =
    safeNumber(
      Array.isArray(
        payload.waitRows
      )
        ? payload.waitRows
            .filter(
              isShortAction
            )
            .length
        : payload.waitRows ??
          waitRowsList.length,

      waitRowsList.length
    );

  const virtualCreatedRows =
    safeNumber(
      Array.isArray(
        payload.virtualCreatedRows
      )
        ? payload
            .virtualCreatedRows
            .filter(
              isShortAction
            )
            .length
        : payload
            .virtualCreatedRows ??
          payload
            .shadowCreatedRows ??
          entryRows,

      entryRows
    );

  return {
    ...payload,
    ...baseFlags(),

    ok:
      payload.ok !== false,

    runId:
      payload.runId || null,

    actions,

    virtualActions:
      actions,

    actionsCount:
      shortRawActions.length,

    virtualActionsCount:
      shortRawActions.length,

    responseActionsTruncated:
      shortRawActions.length >
      actions.length,

    entryRows,
    waitRows,
    virtualCreatedRows,

    entryRowsList,
    waitRowsList,

    virtualCreatedRowsList:
      entryRowsList,

    actionCounts,

    realExits:
      [],

    realExitsCount:
      0,

    realExitRows:
      0,

    shadowExits:
      virtualExits,

    shadowExitsCount:
      shortRawExitRows.length,

    shadowExitRows:
      shortRawExitRows.length,

    virtualExits,

    virtualExitsCount:
      shortRawExitRows.length,

    virtualExitRows:
      shortRawExitRows.length,

    responseExitsTruncated:
      shortRawExitRows.length >
      virtualExits.length,

    exits:
      virtualExits,

    exitsCount:
      shortRawExitRows.length,

    rawActionsCount:
      rawActions.length,

    rawExitRowsCount:
      rawExitRows.length,

    ignoredLongActions:
      rawActions.filter(
        isLongAction
      ).length,

    ignoredLongExitRows:
      rawExitRows.filter(
        isLongAction
      ).length,

    activeMicroFamilyIds,
    selectedMicroFamilyIds,

    activeMacroFamilyIds,
    selectedMacroFamilyIds,

    trueMicroFamilyIds:
      activeMicroFamilyIds,

    activeTrueMicroFamilyIds:
      activeMicroFamilyIds,

    selectedTrueMicroFamilyIds:
      selectedMicroFamilyIds,

    activeMicroFamilies:
      activeMicroFamilyIds.length,

    activeMacroFamilies:
      activeMacroFamilyIds.length,

    selectedOppositeCandidateCount:
      0,

    skippedNewEntries:
      Boolean(
        payload.skippedNewEntries
      ),

    skipReason:
      payload.skipReason ||
      payload.reason ||
      null,

    reason:
      payload.reason ||
      payload.skipReason ||
      null,

    scannerPreloadBeforeTrade:
      true,

    scannerPreloadMode:
      'READ_EXISTING_LATEST',

    scannerLatestPreserved:
      true,

    scannerSnapshotPreserved:
      true,

    microFamiliesAppendOnly:
      true,

    analyzePartialOnly:
      true
  };
}

function unwrapLockResult(
  lockResult
) {
  if (!lockResult) {
    return null;
  }

  if (
    lockResult.result
      ?.result
      ?.result
  ) {
    return lockResult
      .result
      .result
      .result;
  }

  if (
    lockResult.result?.result
  ) {
    return lockResult
      .result
      .result;
  }

  if (lockResult.result) {
    return lockResult.result;
  }

  return lockResult;
}

function lockSignalText(
  value = null
) {
  const payload =
    unwrapLockResult(value);

  return [
    value?.reason,
    value?.error,
    value?.message,
    value?.code,

    payload?.reason,
    payload?.error,
    payload?.message,
    payload?.code,

    typeof value === 'string'
      ? value
      : '',

    value instanceof Error
      ? value.message
      : ''
  ]
    .filter(Boolean)
    .map(
      (part) =>
        String(part)
          .toUpperCase()
    )
    .join('|');
}

function isLockNotAcquiredSignal(
  value = null
) {
  const text =
    lockSignalText(value);

  return (
    text.includes(
      'LOCK_HELD'
    ) ||
    text.includes(
      'LOCK_NOT_ACQUIRED'
    ) ||
    text.includes(
      'TRADE_RUN_LOCK_ACTIVE'
    ) ||
    text.includes(
      'LOCK_ACTIVE'
    ) ||
    text.includes(
      'ALREADY_RUNNING'
    ) ||
    text.includes(
      'CONFLICT_LOCK'
    ) ||
    text.includes(
      'MAX_RETRIES_EXCEEDED'
    )
  );
}

function isLockNotAcquiredResult(
  lockResult = null
) {
  if (
    !lockResult ||
    typeof lockResult !== 'object'
  ) {
    return false;
  }

  const payload =
    unwrapLockResult(lockResult);

  return Boolean(
    isLockNotAcquiredSignal(
      lockResult
    ) ||
    isLockNotAcquiredSignal(
      payload
    ) ||
    (
      lockResult.ok === false &&
      lockResult.executed === false &&
      String(
        lockResult.reason || ''
      )
        .toUpperCase()
        .includes('LOCK')
    )
  );
}

function responseOk(
  lockResult,
  payload
) {
  return (
    lockResult?.ok !== false &&
    payload?.ok !== false
  );
}

function responseSkipped(
  lockResult,
  payload
) {
  return Boolean(
    lockResult?.skipped ||
    payload?.skippedNewEntries ||
    payload?.skipped ||
    false
  );
}

function responseReason(
  lockResult,
  payload
) {
  return (
    lockResult?.reason ||
    payload?.reason ||
    payload?.skipReason ||
    null
  );
}

function buildRunOptions(
  req,
  body = {},
  {
    startedAt,
    deadlineAt,
    runtimeBudgetMs
  }
) {
  const forceProcessSnapshot =
    shouldForceProcessSnapshot(
      req,
      body
    );

  const monitorOnly =
    shouldMonitorOnly(
      req,
      body
    );

  return {
    force:
      forceProcessSnapshot,

    forceProcessSnapshot,

    monitorOnly,

    monitorOpenPositionsFirst:
      true,

    monitorOpenPositions:
      true,

    processOpenPositions:
      true,

    closeVirtualPositions:
      true,

    processScannerSnapshot:
      !monitorOnly,

    targetTradeSide:
      TARGET_TRADE_SIDE,

    tradeSide:
      TARGET_TRADE_SIDE,

    side:
      TARGET_DASHBOARD_SIDE,

    positionSide:
      TARGET_TRADE_SIDE,

    direction:
      TARGET_TRADE_SIDE,

    scannerSide:
      TARGET_SCANNER_SIDE,

    actualScannerSide:
      TARGET_SCANNER_SIDE,

    analysisSide:
      TARGET_TRADE_SIDE,

    dashboardSide:
      TARGET_DASHBOARD_SIDE,

    shortOnly:
      true,

    longDisabled:
      true,

    disableLong:
      true,

    longOnly:
      false,

    shortDisabled:
      false,

    virtualOnly:
      true,

    virtualLearning:
      true,

    virtualLearningForced:
      true,

    virtualTracked:
      true,

    source:
      'VIRTUAL',

    outcomeSource:
      'VIRTUAL',

    realTrade:
      false,

    realOrder:
      false,

    exchangeOrder:
      false,

    bitgetOrderPlaced:
      false,

    realOrdersDisabled:
      true,

    exchangeOrdersDisabled:
      true,

    bitgetOrdersDisabled:
      true,

    exchangeCallsDisabled:
      true,

    noExchangeOrders:
      true,

    noRealOrders:
      true,

    learningOnly:
      true,

    microFamilyLearning:
      true,

    observationFirst:
      true,

    scannerFingerprintRole:
      'METADATA_ONLY',

    scannerFingerprintOnlyMetadata:
      true,

    scannerFingerprintsHiddenFromLearning:
      true,

    scannerFingerprintsMetadataOnly:
      true,

    scannerFingerprintsUsedAsLearningFamily:
      false,

    scannerBucketsMetadataOnly:
      true,

    legacy25BucketsMetadataOnly:
      true,

    executionFingerprintRole:
      'METADATA_ONLY',

    executionFingerprintOnlyMetadata:
      true,

    executionFingerprintsMetadataOnly:
      true,

    executionFingerprintsUsedAsLearningFamily:
      false,

    analyzeMicroFamiliesOnly:
      true,

    learningIdentitySource:
      'ANALYZE_TRUE_MICRO_FAMILY',

    exactTrueMicroFamilyRequired:
      true,

    trueMicroOnly:
      true,

    exactTrueMicroOnly:
      true,

    trueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    parentTrueMicroFamilySchema:
      PARENT_TRUE_MICRO_SCHEMA,

    broadTrueMicroFamilySchema:
      TRUE_MICRO_SCHEMA,

    fixedTaxonomyPreferred:
      true,

    learningGranularity:
      LEARNING_GRANULARITY,

    parentLearningGranularity:
      PARENT_LEARNING_GRANULARITY,

    symbolExcludedFromFamilyId:
      true,

    selectionGranularity:
      'EXACT_75_CHILD',

    allowLearningWithoutActiveRotation:
      true,

    ignoreMaxOpenPositionsForLearning:
      true,

    ignoreGlobalMaxOpenPositions:
      true,

    ignoreRiskCapsForLearning:
      true,

    oneOpenPositionPerSymbol:
      true,

    maxOneOpenPositionPerSymbol:
      true,

    positionTimeStopMin:
      getPositionTimeStopMin(),

    shortRiskShape: {
      entryPositive:
        true,

      tpBelowEntry:
        true,

      slAboveEntry:
        true,

      expression:
        'tp < entry < sl'
    },

    shortExitRules: {
      validRiskShape:
        'entry > 0 && tp < entry && sl > entry',

      tp:
        'currentPrice <= tp',

      sl:
        'currentPrice >= sl',

      timeStop:
        `age >= ${getPositionTimeStopMin()} minutes`,

      tpSlIndependentFromTimeStop:
        true,

      grossR:
        '(entry - exitPrice) / (initialSl - entry)',

      currentR:
        '(entry - currentPrice) / (initialSl - entry)',

      outcomeSource:
        'VIRTUAL'
    },

    riskGeometryRule:
      'SHORT: tp < entry < sl',

    tpHitRule:
      'SHORT: price <= tp',

    slHitRule:
      'SHORT: price >= sl',

    grossRFormula:
      '(entry - exitPrice) / (initialSl - entry)',

    currentRFormula:
      '(entry - currentPrice) / (initialSl - entry)',

    currentFitPolarity:
      'BEARISH_POSITIVE_BULLISH_NEGATIVE',

    currentFitDefinition:
      'SHORT_MIRRORED_CURRENT_FIT',

    discordOnlyForSelectedMicroFamilies:
      true,

    discordOnlyForManualSelection:
      true,

    discordOnlyForExactTrueMicroMatch:
      true,

    manualSelectionMatchMode:
      'EXACT_TRUE_MICRO_FAMILY_ID',

    manualSelectionRequires75ChildTrueMicroFamilyId:
      true,

    macroMatchDoesNotTriggerDiscord:
      true,

    parentMacroMatchDoesNotTriggerDiscord:
      true,

    completedDefinition:
      'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',

    scoringRSource:
      'netR',

    winsLossesFlatsSource:
      'netR',

    winrateDefinition:
      'netR > 0',

    avgRSource:
      'netR',

    totalRSource:
      'netR',

    avgCostRShown:
      true,

    runScope:
      RUN_SCOPE,

    writeScope:
      WRITE_SCOPE,

    readScope:
      READ_SCOPE,

    namespace:
      SHORT_NAMESPACE,

    keyPrefix:
      SHORT_KEY_PREFIX,

    redisNamespace:
      SHORT_NAMESPACE,

    redisKeyPrefix:
      SHORT_KEY_PREFIX,

    persistentLearningKey:
      PERSISTENT_LEARNING_KEY,

    weekKey:
      PERSISTENT_LEARNING_KEY,

    keys: {
      scannerLatest:
        SHORT_KEYS.scan.latest,

      tradeLock:
        SHORT_KEYS.trade.lock,

      tradeRunMeta:
        SHORT_KEYS.trade.runMeta,

      tradeLastProcessedSnapshot:
        SHORT_KEYS.trade
          .lastProcessedSnapshot,

      marketUniverseLatest:
        MARKET_UNIVERSE_KEY,

      shortMarketUniverseLatest:
        MARKET_UNIVERSE_KEY,

      marketWeatherLatest:
        MARKET_WEATHER_KEY,

      shortMarketWeatherLatest:
        MARKET_WEATHER_KEY
    },

    scannerPreloadBeforeTrade:
      true,

    scannerPreloadMode:
      'READ_EXISTING_LATEST',

    marketWeatherPreloadBeforeTrade:
      true,

    scannerRunAllowed:
      false,

    scannerRunDisabledInsideTradeSystem:
      true,

    preventScannerRun:
      true,

    doNotRunScanner:
      true,

    noInternalScannerRun:
      true,

    scannerLatestReadOnly:
      true,

    readScannerLatestOnly:
      true,

    allowTradeWrite:
      true,

    allowAnalyzePartialWrite:
      true,

    allowScannerWrite:
      false,

    allowRotationWrite:
      false,

    allowDiscordSelectionWrite:
      false,

    analyzePartialOnly:
      true,

    microFamiliesAppendOnly:
      true,

    analyzeFullOverwriteDisabled:
      true,

    microFamiliesAntiWipe:
      true,

    preserveRotation:
      true,

    preserveManualSelection:
      true,

    preserveDiscordSelection:
      true,

    requestStartedAt:
      startedAt,

    deadlineAt,

    runtimeBudgetMs,

    stopBeforeDeadlineMs:
      4000,

    abortBeforeDeadline:
      true,

    adminPageIsolation:
      true,

    doesNotOverwriteOtherAdminPages:
      true
  };
}

function summarizeScannerSnapshot(
  snapshot = null,
  source = null
) {
  if (
    !snapshot ||
    typeof snapshot !== 'object'
  ) {
    return {
      ok:
        false,

      reason:
        'SCANNER_LATEST_NOT_FOUND',

      source:
        source || null
    };
  }

  return {
    ok:
      snapshot.ok !== false,

    source,

    snapshotId:
      snapshot.snapshotId ||
      null,

    createdAt:
      snapshot.createdAt ||
      null,

    completedAt:
      snapshot.completedAt ||
      null,

    durationMs:
      snapshot.durationMs ||
      null,

    rawCount:
      safeNumber(
        snapshot.rawCount,
        0
      ),

    filteredUniverse:
      safeNumber(
        snapshot.filteredUniverse,
        0
      ),

    candidatesCount:
      safeNumber(
        snapshot.candidatesCount,
        0
      ),

    scannerGateCandidatesCount:
      safeNumber(
        snapshot
          .scannerGateCandidatesCount,
        0
      ),

    analyzeOnlyCandidatesCount:
      safeNumber(
        snapshot
          .analyzeOnlyCandidatesCount,
        0
      ),

    marketUniverseCount:
      safeNumber(
        snapshot.marketUniverseCount,
        0
      ),

    marketWeatherCount:
      safeNumber(
        snapshot.marketWeatherCount,
        snapshot.marketUniverseCount ||
        0
      ),

    btcState:
      snapshot.btcState ||
      null,

    regime:
      snapshot.regime ||
      null,

    topSymbols:
      Array.isArray(
        snapshot.topSymbols
      )
        ? snapshot.topSymbols
            .slice(0, 25)
        : [],

    scannerExecutedInsideTradeRoute:
      false,

    scannerPreloadMode:
      'READ_EXISTING_LATEST'
  };
}

async function mirrorOneMarketKey({
  volatileRedis,
  durableRedis,
  key
}) {
  const volatilePayload =
    await getJson(
      volatileRedis,
      key,
      null
    ).catch(() => null);

  if (volatilePayload) {
    await setJson(
      durableRedis,
      key,
      {
        ...volatilePayload,

        mirroredFromVolatile:
          true,

        mirroredToDurable:
          true,

        mirroredAt:
          now(),

        mirrorSourceKey:
          key,

        scannerPreloadMode:
          'READ_EXISTING_LATEST',

        marketWeatherPreloadBeforeTrade:
          true,

        currentFitPolarity:
          'BEARISH_POSITIVE_BULLISH_NEGATIVE',

        currentFitDefinition:
          'SHORT_MIRRORED_CURRENT_FIT',

        currentFitSoftOnly:
          true,

        currentFitBlocksLearning:
          false,

        learningRemainsBroad:
          true
      }
    );

    return {
      key,

      ok:
        true,

      mirrored:
        true,

      source:
        'VOLATILE'
    };
  }

  const durablePayload =
    await getJson(
      durableRedis,
      key,
      null
    ).catch(() => null);

  if (durablePayload) {
    return {
      key,

      ok:
        true,

      mirrored:
        false,

      alreadyDurable:
        true,

      source:
        'DURABLE'
    };
  }

  return {
    key,

    ok:
      false,

    mirrored:
      false,

    reason:
      'SOURCE_KEY_EMPTY'
  };
}

async function mirrorMarketCacheFromVolatileToDurable({
  volatileRedis,
  durableRedis
}) {
  const keys = [
    ...new Set([
      MARKET_UNIVERSE_KEY,
      MARKET_WEATHER_KEY
    ])
  ];

  const settled =
    await Promise.allSettled(
      keys.map(
        (key) =>
          mirrorOneMarketKey({
            volatileRedis,
            durableRedis,
            key
          })
      )
    );

  const results =
    settled.map(
      (row, index) => {
        if (
          row.status ===
          'fulfilled'
        ) {
          return row.value;
        }

        return {
          key:
            keys[index],

          ok:
            false,

          mirrored:
            false,

          reason:
            'MIRROR_ERROR',

          error:
            row.reason?.message ||
            String(row.reason)
        };
      }
    );

  const okKeys =
    results
      .filter((row) => row.ok)
      .map((row) => row.key);

  return {
    ok:
      okKeys.length > 0,

    okKeys,

    results,

    marketWeatherMirrored:
      okKeys.includes(
        MARKET_WEATHER_KEY
      ),

    marketUniverseMirrored:
      okKeys.includes(
        MARKET_UNIVERSE_KEY
      )
  };
}

async function loadScannerPreload({
  volatileRedis,
  durableRedis
}) {
  const startedAt =
    now();

  const [
    volatileSnapshot,
    durableSnapshot,
    mirror
  ] = await Promise.all([
    getJson(
      volatileRedis,
      SHORT_KEYS.scan.latest,
      null
    ).catch(() => null),

    getJson(
      durableRedis,
      SHORT_KEYS.scan.latest,
      null
    ).catch(() => null),

    mirrorMarketCacheFromVolatileToDurable({
      volatileRedis,
      durableRedis
    })
  ]);

  const snapshot =
    volatileSnapshot ||
    durableSnapshot;

  const source =
    volatileSnapshot
      ? 'VOLATILE_SCANNER_LATEST'
      : durableSnapshot
        ? 'DURABLE_SCANNER_LATEST'
        : null;

  return {
    ok:
      Boolean(snapshot),

    scanner:
      summarizeScannerSnapshot(
        snapshot,
        source
      ),

    mirror,

    durationMs:
      now() - startedAt,

    scannerExecutedInsideTradeRoute:
      false,

    scannerRunSkippedToPreventVercelTimeout:
      true,

    scannerPreloadMode:
      'READ_EXISTING_LATEST'
  };
}

function compactPayloadForPersistence(
  payload = {}
) {
  return {
    ok:
      payload.ok !== false,

    skipped:
      Boolean(
        payload.skipped ||
        payload.skippedNewEntries
      ),

    reason:
      payload.reason ||
      payload.skipReason ||
      null,

    skipReason:
      payload.skipReason ||
      null,

    runId:
      payload.runId ||
      null,

    snapshotId:
      payload.snapshotId ||
      null,

    candidates:
      safeNumber(
        payload.candidates ||
        payload.candidatesCount,
        0
      ),

    processed:
      safeNumber(
        payload.processed,
        0
      ),

    entryRows:
      safeNumber(
        payload.entryRows,
        0
      ),

    waitRows:
      safeNumber(
        payload.waitRows,
        0
      ),

    virtualCreatedRows:
      safeNumber(
        payload.virtualCreatedRows,
        0
      ),

    virtualExitRows:
      safeNumber(
        payload.virtualExitRows,
        0
      ),

    shadowExitRows:
      safeNumber(
        payload.shadowExitRows,
        0
      ),

    actionCounts:
      payload.actionCounts ||
      {},

    activeRotationId:
      payload.activeRotationId ||
      null,

    selectedRotationId:
      payload.selectedRotationId ||
      payload.activeRotationId ||
      null,

    activeMicroFamilyIds:
      Array.isArray(
        payload.activeMicroFamilyIds
      )
        ? payload.activeMicroFamilyIds
        : [],

    activeMacroFamilyIds:
      Array.isArray(
        payload.activeMacroFamilyIds
      )
        ? payload.activeMacroFamilyIds
        : [],

    selectedMicroFamilyIds:
      Array.isArray(
        payload.selectedMicroFamilyIds
      )
        ? payload.selectedMicroFamilyIds
        : [],

    selectedMacroFamilyIds:
      Array.isArray(
        payload.selectedMacroFamilyIds
      )
        ? payload.selectedMacroFamilyIds
        : [],

    durationMs:
      safeNumber(
        payload.durationMs,
        0
      ),

    completedAt:
      payload.completedAt ||
      now()
  };
}

async function persistShortRunMeta(
  redis,
  payload = {},
  scannerPreload = null
) {
  if (
    !payload ||
    typeof payload !== 'object'
  ) {
    return {
      persistedShortRunMeta:
        false,

      persistedShortLastProcessedSnapshot:
        false,

      reason:
        'NO_PAYLOAD'
    };
  }

  const compact =
    compactPayloadForPersistence(
      payload
    );

  const runMeta = {
    ...compact,
    ...baseFlags(),

    scannerPreload,

    persistedAt:
      now(),

    persistedBy:
      'api/trade/run.js',

    persistedNamespace:
      SHORT_NAMESPACE
  };

  const runMetaWrite =
    setJson(
      redis,
      SHORT_KEYS.trade.runMeta,
      runMeta
    )
      .then(() => true)
      .catch(() => false);

  const snapshotWrite =
    compact.snapshotId
      ? setJson(
          redis,

          SHORT_KEYS.trade
            .lastProcessedSnapshot,

          {
            snapshotId:
              compact.snapshotId,

            runId:
              compact.runId,

            processedAt:
              now(),

            scannerPreload,

            ...baseFlags()
          }
        )
          .then(() => true)
          .catch(() => false)

      : Promise.resolve(false);

  const [
    runMetaOk,
    snapshotOk
  ] = await Promise.all([
    runMetaWrite,
    snapshotWrite
  ]);

  return {
    persistedShortRunMeta:
      runMetaOk,

    persistedShortLastProcessedSnapshot:
      snapshotOk,

    tradeRunMeta:
      SHORT_KEYS.trade.runMeta,

    tradeLastProcessedSnapshot:
      SHORT_KEYS.trade
        .lastProcessedSnapshot
  };
}

function responseCounts(
  payload = {}
) {
  const actions =
    Array.isArray(
      payload.actions
    )
      ? payload.actions
      : [];

  return {
    ...baseFlags(),

    candidates:
      safeNumber(
        payload.candidates ||
        payload.candidatesCount,
        0
      ),

    shortCandidateCount:
      safeNumber(
        payload.shortCandidateCount ||
        payload.targetCandidateCount ||
        payload.shortCandidatesCount,
        0
      ),

    nonShortCandidateCount:
      safeNumber(
        payload.nonShortCandidateCount ||
        payload.nonTargetCandidateCount,
        0
      ),

    processed:
      safeNumber(
        payload.processed,
        0
      ),

    earlyActions:
      safeNumber(
        payload.earlyActions,
        0
      ),

    liveRows:
      safeNumber(
        payload.liveRows,
        0
      ),

    analyzeInputRows:
      safeNumber(
        payload.analyzeInputRows,
        0
      ),

    observationOnlyRows:
      safeNumber(
        payload.observationOnlyRows,
        0
      ),

    entryRows:
      safeNumber(
        payload.entryRows,
        0
      ),

    waitRows:
      safeNumber(
        payload.waitRows,
        0
      ),

    virtualCreatedRows:
      safeNumber(
        payload.virtualCreatedRows,
        0
      ),

    actions:
      safeNumber(
        payload.actionsCount,
        actions.length
      ),

    shortActions:
      safeNumber(
        payload.actionsCount,
        actions.length
      ),

    entries:
      safeNumber(
        payload.entryRows,
        0
      ),

    waits:
      safeNumber(
        payload.waitRows,
        0
      ),

    realExits:
      0,

    realExitRows:
      0,

    shadowExits:
      safeNumber(
        payload.shadowExitRows,
        0
      ),

    shadowExitRows:
      safeNumber(
        payload.shadowExitRows,
        0
      ),

    virtualExits:
      safeNumber(
        payload.virtualExitRows,
        0
      ),

    virtualExitRows:
      safeNumber(
        payload.virtualExitRows,
        0
      ),

    activeMicroFamilies:
      safeNumber(
        payload.activeMicroFamilies,
        0
      ),

    activeMacroFamilies:
      safeNumber(
        payload.activeMacroFamilies,
        0
      ),

    selectedTargetCandidateCount:
      safeNumber(
        payload.selectedTargetCandidateCount,
        0
      ),

    selectedOppositeCandidateCount:
      0,

    ignoredLongActions:
      safeNumber(
        payload.ignoredLongActions,
        0
      ),

    ignoredLongExitRows:
      safeNumber(
        payload.ignoredLongExitRows,
        0
      ),

    scannerPreloadBeforeTrade:
      true,

    scannerPreloadMode:
      'READ_EXISTING_LATEST',

    scannerSnapshotPreserved:
      true,

    microFamiliesAppendOnly:
      true
  };
}

function buildLockSkippedResponse({
  req,
  body = {},
  startedAt,
  lockKey,
  lockTtlSec,
  rawResult = null,
  error = null
}) {
  const reason =
    'TRADE_RUN_LOCK_ACTIVE';

  return {
    ok:
      true,

    tradeOk:
      true,

    scannerPreloadOk:
      null,

    skipped:
      true,

    skippedNewEntries:
      true,

    reason,

    skipReason:
      reason,

    message:
      'Trade run overgeslagen: vorige SHORT trade-run is nog actief.',

    ...baseFlags(),

    runSource:
      getRunSource(
        req,
        body
      ),

    lock: {
      resource:
        TRADE_LOCK_RESOURCE,

      key:
        lockKey,

      ttlSec:
        lockTtlSec,

      active:
        true,

      reason
    },

    runId:
      null,

    snapshotId:
      null,

    entryRows:
      0,

    waitRows:
      0,

    virtualCreatedRows:
      0,

    virtualExitRows:
      0,

    shadowExitRows:
      0,

    entryRowsList:
      [],

    waitRowsList:
      [],

    virtualCreatedRowsList:
      [],

    virtualExits:
      [],

    shadowExits:
      [],

    realExits:
      [],

    actionCounts:
      {},

    counts: {
      candidates:
        0,

      processed:
        0,

      entries:
        0,

      waits:
        0,

      virtualExits:
        0,

      shadowExits:
        0,

      realExits:
        0
    },

    warnings: [
      'TRADE_RUN_SKIPPED_BECAUSE_LOCK_ACTIVE',
      'NO_ERROR_FOR_CRON'
    ],

    rawLockResult:
      rawResult ||
      undefined,

    rawError:
      error
        ? {
            message:
              error?.message ||
              String(error),

            reason:
              error?.reason ||
              null,

            code:
              error?.code ||
              null
          }
        : undefined,

    durationMs:
      now() - startedAt,

    completedAt:
      now()
  };
}

function resolveStatus(error) {
  if (
    Number.isFinite(
      error?.statusCode
    )
  ) {
    return error.statusCode;
  }

  return 500;
}

export default async function handler(
  req,
  res
) {
  res.setHeader(
    'Cache-Control',
    'no-store, max-age=0'
  );

  res.setHeader(
    'X-Trade-Target-Side',
    TARGET_TRADE_SIDE
  );

  res.setHeader(
    'X-Target-Trade-Side',
    TARGET_TRADE_SIDE
  );

  res.setHeader(
    'X-Dashboard-Side',
    TARGET_DASHBOARD_SIDE
  );

  res.setHeader(
    'X-Short-Only',
    'true'
  );

  res.setHeader(
    'X-Long-Disabled',
    'true'
  );

  res.setHeader(
    'X-Virtual-Only',
    'true'
  );

  res.setHeader(
    'X-Virtual-Learning-Forced',
    'true'
  );

  res.setHeader(
    'X-Exchange-Orders-Disabled',
    'true'
  );

  res.setHeader(
    'X-Bitget-Orders-Disabled',
    'true'
  );

  res.setHeader(
    'X-No-Real-Orders',
    'true'
  );

  res.setHeader(
    'X-Scanner-Fingerprint-Role',
    'METADATA_ONLY'
  );

  res.setHeader(
    'X-Execution-Fingerprint-Role',
    'METADATA_ONLY'
  );

  res.setHeader(
    'X-Learning-Identity-Source',
    'ANALYZE_TRUE_MICRO_FAMILY'
  );

  res.setHeader(
    'X-Exact-True-Micro-Match',
    'true'
  );

  res.setHeader(
    'X-True-Micro-Family-Schema',
    TRUE_MICRO_SCHEMA
  );

  res.setHeader(
    'X-Parent-True-Micro-Family-Schema',
    PARENT_TRUE_MICRO_SCHEMA
  );

  res.setHeader(
    'X-Learning-Granularity',
    LEARNING_GRANULARITY
  );

  res.setHeader(
    'X-Parent-Learning-Granularity',
    PARENT_LEARNING_GRANULARITY
  );

  res.setHeader(
    'X-Run-Scope',
    RUN_SCOPE
  );

  res.setHeader(
    'X-Write-Scope',
    WRITE_SCOPE
  );

  res.setHeader(
    'X-Scanner-Write',
    'false'
  );

  res.setHeader(
    'X-Scanner-Run-Allowed',
    'false'
  );

  res.setHeader(
    'X-Scanner-Preload-Before-Trade',
    'READ_EXISTING_LATEST'
  );

  res.setHeader(
    'X-MarketWeather-Preload-Before-Trade',
    'true'
  );

  res.setHeader(
    'X-MicroFamilies-Append-Only',
    'true'
  );

  res.setHeader(
    'X-Admin-Page-Isolation',
    'true'
  );

  res.setHeader(
    'X-Persistent-Learning-Key',
    PERSISTENT_LEARNING_KEY
  );

  res.setHeader(
    'X-Redis-Namespace',
    SHORT_NAMESPACE
  );

  res.setHeader(
    'X-Long-Root-Touched',
    'false'
  );

  const startedAt =
    now();

  const runtimeBudgetMs =
    getRuntimeBudgetMs();

  const deadlineAt =
    startedAt +
    runtimeBudgetMs;

  let body = {};

  try {
    if (
      !isAllowedMethod(
        req.method
      )
    ) {
      return methodNotAllowed(
        res
      );
    }

    body =
      await readBody(req);

    const rowLimit =
      getResponseRowLimit(
        req,
        body
      );

    const runOptions =
      buildRunOptions(
        req,
        body,
        {
          startedAt,
          deadlineAt,
          runtimeBudgetMs
        }
      );

    const durableRedis =
      getDurableRedis();

    const volatileRedis =
      getVolatileRedis();

    const lockKey =
      SHORT_KEYS.trade.lock;

    const lockTtlSec =
      getLockTtlSec();

    let scannerPreload =
      null;

    const rawResult =
      await executeWithTradeLock({
        durableRedis,
        lockTtlSec,

        callback:
          async () => {
            scannerPreload =
              await loadScannerPreload({
                volatileRedis,
                durableRedis
              });

            return runTradeSystem({
              ...runOptions,

              scannerPreloadOk:
                scannerPreload
                  ?.ok === true,

              scannerSnapshotAvailable:
                scannerPreload
                  ?.ok === true,

              scannerPreloadMode:
                'READ_EXISTING_LATEST',

              marketWeatherMirroredToDurable:
                scannerPreload
                  ?.mirror
                  ?.marketWeatherMirrored ===
                true,

              marketUniverseMirroredToDurable:
                scannerPreload
                  ?.mirror
                  ?.marketUniverseMirrored ===
                true,

              remainingRuntimeMs:
                Math.max(
                  0,
                  deadlineAt -
                  now()
                )
            });
          }
      });

    if (
      isLockNotAcquiredResult(
        rawResult
      )
    ) {
      return res
        .status(200)
        .json(
          buildLockSkippedResponse({
            req,
            body,
            startedAt,
            lockKey,
            lockTtlSec,
            rawResult
          })
        );
    }

    const rawPayload =
      unwrapLockResult(
        rawResult
      );

    const payload =
      sanitizeRunPayload(
        rawPayload,
        {
          rowLimit
        }
      ) || {};

    const tradeOk =
      responseOk(
        rawResult,
        payload
      );

    const scannerOk =
      scannerPreload
        ?.ok === true;

    const persistence =
      now() <
      deadlineAt - 2000

        ? await persistShortRunMeta(
            durableRedis,
            payload,
            scannerPreload
          )

        : {
            persistedShortRunMeta:
              false,

            persistedShortLastProcessedSnapshot:
              false,

            reason:
              'SKIPPED_NEAR_RUNTIME_DEADLINE'
          };

    const actionCounts =
      payload.actionCounts ||
      {};

    const counts =
      responseCounts(
        payload
      );

    return res
      .status(200)
      .json({
        ok:
          tradeOk,

        tradeOk,

        scannerPreloadOk:
          scannerOk,

        skipped:
          responseSkipped(
            rawResult,
            payload
          ),

        reason:
          responseReason(
            rawResult,
            payload
          ) ||
          (
            !scannerOk
              ? 'SCANNER_LATEST_NOT_AVAILABLE'
              : null
          ),

        skipReason:
          payload.skipReason ||
          null,

        ...baseFlags(),

        runSource:
          getRunSource(
            req,
            body
          ),

        force:
          runOptions.force,

        forceProcessSnapshot:
          runOptions
            .forceProcessSnapshot,

        monitorOnly:
          runOptions.monitorOnly,

        monitorOpenPositionsFirst:
          true,

        monitorOpenPositions:
          true,

        processScannerSnapshot:
          runOptions
            .processScannerSnapshot,

        runtimeBudgetMs,

        deadlineAt,

        remainingRuntimeMs:
          Math.max(
            0,
            deadlineAt -
            now()
          ),

        scannerPreload,

        scannerExecutedInsideTradeRoute:
          false,

        scannerRunSkippedToPreventVercelTimeout:
          true,

        marketWeatherAvailableAfterRun:
          scannerPreload
            ?.mirror
            ?.marketWeatherMirrored ===
          true,

        marketUniverseAvailableAfterRun:
          scannerPreload
            ?.mirror
            ?.marketUniverseMirrored ===
          true,

        runId:
          payload.runId ||
          null,

        snapshotId:
          payload.snapshotId ||
          null,

        entryRows:
          safeNumber(
            payload.entryRows,
            0
          ),

        waitRows:
          safeNumber(
            payload.waitRows,
            0
          ),

        virtualCreatedRows:
          safeNumber(
            payload
              .virtualCreatedRows,
            0
          ),

        virtualExitRows:
          safeNumber(
            payload.virtualExitRows,
            0
          ),

        shadowExitRows:
          safeNumber(
            payload.shadowExitRows,
            0
          ),

        entryRowsList:
          Array.isArray(
            payload.entryRowsList
          )
            ? payload.entryRowsList
            : [],

        waitRowsList:
          Array.isArray(
            payload.waitRowsList
          )
            ? payload.waitRowsList
            : [],

        virtualCreatedRowsList:
          Array.isArray(
            payload
              .virtualCreatedRowsList
          )
            ? payload
                .virtualCreatedRowsList
            : [],

        virtualExits:
          Array.isArray(
            payload.virtualExits
          )
            ? payload.virtualExits
            : [],

        shadowExits:
          Array.isArray(
            payload.shadowExits
          )
            ? payload.shadowExits
            : [],

        realExits:
          [],

        actionCounts,
        counts,

        activeRotationId:
          payload.activeRotationId ||
          null,

        selectedRotationId:
          payload
            .selectedRotationId ||
          payload
            .activeRotationId ||
          null,

        activeMicroFamilies:
          safeNumber(
            payload
              .activeMicroFamilies,
            0
          ),

        activeMacroFamilies:
          safeNumber(
            payload
              .activeMacroFamilies,
            0
          ),

        activeMicroFamilyIds:
          Array.isArray(
            payload
              .activeMicroFamilyIds
          )
            ? payload
                .activeMicroFamilyIds
            : [],

        activeMacroFamilyIds:
          Array.isArray(
            payload
              .activeMacroFamilyIds
          )
            ? payload
                .activeMacroFamilyIds
            : [],

        selectedMicroFamilyIds:
          Array.isArray(
            payload
              .selectedMicroFamilyIds
          )
            ? payload
                .selectedMicroFamilyIds
            : [],

        selectedMacroFamilyIds:
          Array.isArray(
            payload
              .selectedMacroFamilyIds
          )
            ? payload
                .selectedMacroFamilyIds
            : [],

        selectedSnapshotSource:
          payload
            .selectedSnapshotSource ||
          null,

        selectedSnapshotReason:
          payload
            .selectedSnapshotReason ||
          null,

        selectedTargetCandidateCount:
          safeNumber(
            payload
              .selectedTargetCandidateCount,
            0
          ),

        selectedOppositeCandidateCount:
          0,

        scannerLatestPreserved:
          true,

        scannerSnapshotPreserved:
          true,

        scannerHistoryPreserved:
          true,

        scannerRunBlockedInsideTradeRun:
          true,

        scannerRunDisabledInsideTradeSystem:
          true,

        microFamiliesAppendOnly:
          true,

        analyzePartialOnly:
          true,

        analyzeFullOverwriteDisabled:
          true,

        rotationPreserved:
          true,

        manualSelectionPreserved:
          true,

        discordSelectionPreserved:
          true,

        shortPersistence:
          persistence,

        lock: {
          resource:
            TRADE_LOCK_RESOURCE,

          key:
            lockKey,

          ttlSec:
            lockTtlSec,

          acquired:
            rawResult?.ok !==
            false,

          released:
            rawResult
              ?.lockReleased ??
            null,

          releaseReason:
            rawResult
              ?.lockReleaseReason ||
            null
        },

        shortKeys: {
          namespace:
            SHORT_NAMESPACE,

          prefix:
            SHORT_KEY_PREFIX,

          scanLatest:
            SHORT_KEYS.scan.latest,

          tradeLock:
            lockKey,

          legacyConfiguredTradeLock:
            SHORT_KEYS.trade
              .legacyConfiguredLock,

          tradeRunMeta:
            SHORT_KEYS.trade
              .runMeta,

          tradeLastProcessedSnapshot:
            SHORT_KEYS.trade
              .lastProcessedSnapshot,

          marketUniverseLatest:
            MARKET_UNIVERSE_KEY,

          shortMarketUniverseLatest:
            MARKET_UNIVERSE_KEY,

          marketWeatherLatest:
            MARKET_WEATHER_KEY,

          shortMarketWeatherLatest:
            MARKET_WEATHER_KEY
        },

        warnings: [
          !scannerOk
            ? 'SCANNER_LATEST_NOT_AVAILABLE_TRADE_MONITORING_CONTINUES'
            : null,

          scannerPreload
            ?.mirror
            ?.marketWeatherMirrored !==
          true
            ? 'MARKET_WEATHER_NOT_AVAILABLE_IN_DURABLE_REDIS'
            : null,

          scannerPreload
            ?.mirror
            ?.marketUniverseMirrored !==
          true
            ? 'MARKET_UNIVERSE_NOT_AVAILABLE_IN_DURABLE_REDIS'
            : null,

          safeNumber(
            payload
              .ignoredLongActions,
            0
          ) > 0
            ? `LONG_ACTIONS_IGNORED:${payload.ignoredLongActions}`
            : null,

          safeNumber(
            payload
              .ignoredLongExitRows,
            0
          ) > 0
            ? `LONG_EXIT_ROWS_IGNORED:${payload.ignoredLongExitRows}`
            : null,

          payload
            .responseActionsTruncated
            ? `RESPONSE_ACTIONS_TRUNCATED_TO:${rowLimit}`
            : null,

          payload
            .responseExitsTruncated
            ? `RESPONSE_EXITS_TRUNCATED_TO:${rowLimit}`
            : null,

          now() >=
          deadlineAt - 2000
            ? 'RUNTIME_BUDGET_ALMOST_EXHAUSTED'
            : null
        ].filter(Boolean),

        responseRowLimit:
          rowLimit,

        durationMs:
          now() - startedAt,

        completedAt:
          now(),

        run:
          payload,

        result: {
          ok:
            tradeOk,

          skipped:
            responseSkipped(
              rawResult,
              payload
            ),

          reason:
            responseReason(
              rawResult,
              payload
            ),

          ...baseFlags(),

          result:
            compactPayloadForPersistence(
              payload
            )
        }
      });
  } catch (error) {
    console.error(
      '[api/trade/run] fatal handler error:',
      {
        name:
          error?.name || null,

        message:
          error?.message ||
          String(error),

        code:
          error?.code || null,

        reason:
          error?.reason || null,

        stack:
          error?.stack || null
      }
    );

    const lockKey =
      SHORT_KEYS.trade.lock;

    const lockTtlSec =
      getLockTtlSec();

    if (
      isLockNotAcquiredSignal(
        error
      )
    ) {
      return res
        .status(200)
        .json(
          buildLockSkippedResponse({
            req,
            body,
            startedAt,
            lockKey,
            lockTtlSec,
            error
          })
        );
    }

    return res
      .status(
        resolveStatus(error)
      )
      .json({
        ok:
          false,

        ...baseFlags(),

        error:
          error?.message ||
          String(error),

        code:
          error?.code ||
          null,

        reason:
          error?.reason ||
          null,

        durationMs:
          now() - startedAt,

        stack:
          process.env.NODE_ENV ===
          'production'
            ? undefined
            : error?.stack
      });
  }
}