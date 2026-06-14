// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getVolatileRedis,
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
const LONG_KEY_PREFIX = 'LONG:';

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const DEFAULT_LOCK_TTL_SEC = 540;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

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

function stripKnownNamespace(key = '') {
  const raw = String(callMaybeKey(key, '') || '').trim();

  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw.slice(SHORT_KEY_PREFIX.length);
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw.slice(LONG_KEY_PREFIX.length);

  return raw;
}

function namespacedShortKey(key, fallback = null) {
  const raw = stripKnownNamespace(callMaybeKey(key, fallback));

  if (!raw) return null;

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

function taxonomyFlags() {
  return {
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningGranularity: LEARNING_GRANULARITY,

    selectableMicroFamilyCount: 75,
    selectableChildMicroFamilyCount: 75,
    parentMicroFamilyCount: 15,

    taxonomySetups: SHORT_SETUP_TYPES,
    taxonomyRegimes: SHORT_REGIME_BUCKETS,
    taxonomyConfirmationProfiles: SHORT_CONFIRMATION_PROFILES,

    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    parentFamilyFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableChildFamilyFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

    parentTrueMicroFamilyExample: 'MICRO_SHORT_BREAKOUT_TREND',
    selectableTrueMicroFamilyExample: 'MICRO_SHORT_BREAKOUT_TREND_A_STRONG_ALIGN',

    parentIdsAreMetadataOnly: true,
    parentIdsAreNotSelectable: true,
    selectableIdsAreChildrenOnly: true,
    selectableIdsAre75ChildOnly: true,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED'
  };
}

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
    scannerFindsBearishCandidates: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotOpenPositions: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,
    scannerHashesMetadataOnly: true,
    coinNameMetadataOnly: true,
    symbolMetadataOnly: true,

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
    paperOnly: true,
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

    rankingUsesBalancedScore: true,
    rankingUsesFairWinrate: true,
    rankingUsesTotalR: true,
    rankingUsesAvgR: true,
    rankingUsesAvgCostR: true,
    rawWinrateRankingDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    shortRiskShape: 'tp < entry < sl',
    validShortRiskShape: 'entry > 0 && tp < entry && sl > entry',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsNotLearningIdentitySource: true,
    scannerIdentitySource: 'SCANNER_METADATA_ONLY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,

    ...taxonomyFlags(),

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionRequires75ChildTrueMicroFamilyId: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordMatchSource: 'MANUAL_SELECTED_75_CHILD_TRUE_MICRO_FAMILY_ID',
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

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
    longRootTouched: false
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

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('BLOCK_LONG_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return n;
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

function hasBullishMove(row = {}) {
  const values = moveMetricValues(row);

  if (!values.length) return false;

  return values.some((value) => value > 0);
}

function hasBearishMove(row = {}) {
  const values = moveMetricValues(row);

  if (!values.length) return false;

  return values.some((value) => value < 0);
}

function hasOnlyBearishMove(row = {}) {
  const values = moveMetricValues(row);

  if (!values.length) return false;

  return values.every((value) => value < 0);
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
    row.childTrueMicroFamilyId,
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

  if (hasOnlyBearishMove(row) || hasBearishMove(row)) return TARGET_TRADE_SIDE;
  if (hasBullishMove(row)) return OPPOSITE_TRADE_SIDE;

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
    coarseMicroFamilyId: null,

    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsLearningIdentitySource: false,
    scannerDoesNotSelectMicroFamilies: true
  };
}

function normalizeShortCandidate(candidate = {}) {
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
    scannerDoesNotWriteLearningFamilies: true,

    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

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
    fakeBreakdown: Boolean(candidate.fakeBreakdown),
    fakeBreakdownRisk: Boolean(candidate.fakeBreakdownRisk),
    avoidShort: Boolean(candidate.avoidShort),
    doNotShort: Boolean(candidate.doNotShort),

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
  if (result.result?.result) return result.result.result;
  if (result.result) return result.result;

  return result;
}

function normalizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      reason: 'EMPTY_SCANNER_PAYLOAD',
      ...baseFlags(),
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
    .map(normalizeShortCandidate)
    .filter((candidate) => candidate.symbol && candidate.contractSymbol);

  const scannerGateCandidates = candidates.filter(scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);

  const rawLongCandidatesIgnored = rawCandidates.filter(isLongCandidate).length;
  const rawUnknownSideCandidatesIgnored = rawCandidates.filter((row) => rowSide(row) === 'UNKNOWN').length;

  const analyze = payload.analyze && typeof payload.analyze === 'object'
    ? {
      ...payload.analyze,
      ...baseFlags(),
      scannerOutputOnly: true,
      scannerDoesNotWriteLearning: true,
      analyzeMustAssignTrueMicroFamily: true
    }
    : payload.analyze || null;

  return {
    ...payload,
    ...baseFlags(),

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

function normalizeLockResult(rawResult = {}) {
  if (!rawResult || typeof rawResult !== 'object') {
    return {
      ok: false,
      reason: 'EMPTY_LOCK_RESULT',
      ...baseFlags()
    };
  }

  const payload = normalizePayload(unwrapPayload(rawResult));

  if (rawResult.result?.result?.result?.candidates) {
    return {
      ...rawResult,
      ...baseFlags(),
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
      result: payload
    };
  }

  if (rawResult.candidates) {
    return payload;
  }

  return {
    ...rawResult,
    ...baseFlags(),
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

function buildScannerOptions(req, body = {}) {
  const force = shouldForce(req, body);

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
    scannerFindsBearishCandidates: true,
    scannerDecidesTrade: false,
    scannerDoesNotTrade: true,
    scannerDoesNotOpenPositions: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,

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
    paperOnly: true,
    shadowOnly: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    scannerIsNotLearningIdentitySource: true,
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,

    keys: {
      scanLock: SHORT_KEYS.scan.lock,
      scanLatest: SHORT_KEYS.scan.latest,
      scanSnapshotPattern: SHORT_KEYS.scan.snapshotPattern
    }
  };
}

async function persistShortScannerPayload(redis, payload = {}) {
  const snapshotId = payload?.snapshotId || payload?.id || payload?.scanId || null;

  const latestPayload = {
    ...payload,
    ...baseFlags(),

    snapshotId,
    persistedAt: now(),
    persistedBy: 'api/scanner/run.js',
    persistedNamespace: SHORT_NAMESPACE,

    scannerPayloadRole: 'DISCOVERY_METADATA_ONLY',
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,

    shortKeys: {
      namespace: SHORT_NAMESPACE,
      prefix: SHORT_KEY_PREFIX,
      scanLatest: SHORT_KEYS.scan.latest,
      snapshotKey: snapshotId ? SHORT_KEYS.scan.snapshot(snapshotId) : null
    }
  };

  await setJson(redis, SHORT_KEYS.scan.latest, latestPayload).catch(() => null);

  if (snapshotId) {
    await setJson(
      redis,
      SHORT_KEYS.scan.snapshot(snapshotId),
      latestPayload
    ).catch(() => null);
  }

  return {
    persistedShortLatest: true,
    persistedShortSnapshot: Boolean(snapshotId),
    scanLatest: SHORT_KEYS.scan.latest,
    snapshotKey: snapshotId ? SHORT_KEYS.scan.snapshot(snapshotId) : null
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Scanner-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Scanner-Side', TARGET_SCANNER_SIDE);
  res.setHeader('X-Scanner-Only', 'true');
  res.setHeader('X-Scanner-Finds-Bearish-Candidates', 'true');
  res.setHeader('X-No-Trade-Execution', 'true');
  res.setHeader('X-No-Discord', 'true');
  res.setHeader('X-No-Micro-Family-Selection', 'true');
  res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Scanner-Fingerprints-Used-As-Learning-Family', 'false');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_TRUE_MICRO_FAMILY');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Child-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Parent-Learning-Granularity', PARENT_LEARNING_GRANULARITY);
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-Paper-Only', 'true');
  res.setHeader('X-Shadow-Only', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');

  const startedAt = now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);
    const scannerOptions = buildScannerOptions(req, body);

    const redis = getVolatileRedis();
    const lockKey = SHORT_KEYS.scan.lock;
    const lockTtlSec = getLockTtlSec();

    const rawResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runScanner(scannerOptions)
    );

    const result = normalizeLockResult(rawResult);
    const payload = normalizePayload(unwrapPayload(result));

    const persistence = await persistShortScannerPayload(redis, payload);

    const ok = result?.ok !== false && payload?.ok !== false;

    return res.status(200).json({
      ok,
      skipped: Boolean(result?.skipped || payload?.skipped || false),
      reason: result?.reason || payload?.reason || null,

      source: sourceLabel(req, body),

      ...baseFlags(),

      force: scannerOptions.force,

      persisted: payload?.persisted ?? result?.persisted ?? null,
      shortPersistence: persistence,

      snapshotId: payload?.snapshotId || result?.snapshotId || null,

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

      shortKeys: {
        namespace: SHORT_NAMESPACE,
        prefix: SHORT_KEY_PREFIX,
        scanLock: SHORT_KEYS.scan.lock,
        scanLatest: SHORT_KEYS.scan.latest,
        scanSnapshotPattern: SHORT_KEYS.scan.snapshotPattern,
        snapshotKey: payload?.snapshotId ? SHORT_KEYS.scan.snapshot(payload.snapshotId) : null
      },

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