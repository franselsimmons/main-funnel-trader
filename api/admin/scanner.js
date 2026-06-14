// ================= FILE: api/admin/scanner.js =================

import { KEYS } from '../../src/keys.js';
import {
  getVolatileRedis,
  getJson,
  getKeys
} from '../../src/redis.js';
import { sideToTradeSide, safeNumber } from '../../src/utils.js';

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

const SNAPSHOT_SEARCH_LIMIT = 80;
const STALE_8M_SEC = 8 * 60;
const STALE_30M_SEC = 30 * 60;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

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

function stripKnownNamespace(key = '') {
  const raw = String(key || '').trim();

  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw.slice(SHORT_KEY_PREFIX.length);
  if (raw.startsWith(LONG_KEY_PREFIX)) return raw.slice(LONG_KEY_PREFIX.length);

  return raw;
}

function namespacedShortKey(key, fallback = null) {
  const raw = stripKnownNamespace(key || fallback || '');

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

function now() {
  return Date.now();
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modeFlags()
  });
}

function taxonomyMeta() {
  return {
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

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
    parentIdsAreMetadataOnly: true,
    scannerCreatesNoLearningFamily: true,
    analyzeCreatesTrueMicroFamily: true
  };
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

    scannerOnly: true,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,
    scannerFindsBearishCandidates: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,
    scannerBucketsAreNotSelectable: true,

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
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    fixedTaxonomyPreferred: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    parentMicroFamilyCount: 15,
    selectableChildMicroFamilyCount: 75,
    parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
    selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
    selectableIdsAreChildrenOnly: true,
    parentIdsAreMetadataOnly: true,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOnly: true,
    paperOnly: true,
    shadowOnly: true,
    virtualTracked: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    learningOutcomesOnly: true,
    outcomesSourceMode: 'VIRTUAL_AND_SHADOW_NET_OUTCOMES',
    outcomeSource: 'VIRTUAL',

    observationFirst: true,
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
    bareWinrateRankingDisabled: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    globalMaxOpenPositionsBlockDisabled: true,
    maxOneOpenPositionPerSymbol: true,
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    shortRiskShape: 'tp < entry < sl',
    validShortRiskShape: 'tp < entry && entry < sl',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    timeStopEnabled: true,

    manualSelectionOnly: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    manualSelectionMustUseSelectable75ChildId: true,
    autoRotationActivationDisabled: true,
    activateFreezeCronDisabled: true,
    resetCronDisabled: true,
    discordOnlyForSelectedMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: true,
    discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
    parentMatchDoesNotTriggerDiscord: true,
    macroMatchDoesNotTriggerDiscord: true,

    bucketsCoarseOnly: true,
    bucketGranularity: 'LOW_MID_HIGH',

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

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function snapshotPattern() {
  return SHORT_KEYS.scan.snapshotPattern;
}

function snapshotKey(snapshotId) {
  return SHORT_KEYS.scan.snapshot(snapshotId);
}

function extractSnapshotId(latest) {
  if (!latest) return null;
  if (typeof latest === 'string') return latest;

  if (typeof latest === 'object') {
    return (
      latest.snapshotId ||
      latest.id ||
      latest.latestSnapshotId ||
      latest.scanId ||
      null
    );
  }

  return null;
}

function hasFullSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.candidates)
  );
}

function snapshotCreatedAt(snapshot = {}) {
  return num(
    snapshot.createdAt ||
    snapshot.completedAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    0
  );
}

function snapshotAgeSec(snapshot = {}) {
  const createdAt = snapshotCreatedAt(snapshot);

  if (createdAt <= 0) return null;

  return Math.max(0, Math.floor((now() - createdAt) / 1000));
}

function parseShortTaxonomyMicroId(id = '') {
  const value = upper(id);

  if (!value.startsWith('MICRO_SHORT_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      rawId: String(id || '').trim()
    };
  }

  let body = value.slice('MICRO_SHORT_'.length);
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

  for (const candidateRegime of SHORT_FIXED_REGIME_BUCKETS) {
    const suffix = `_${candidateRegime}`;

    if (body.endsWith(suffix)) {
      regime = candidateRegime;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime
    ? `MICRO_SHORT_${setup}_${regime}`
    : null;

  const childId = parentId && confirmationProfile
    ? `${parentId}_${confirmationProfile}`
    : null;

  const validParent =
    Boolean(parentId) &&
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime);

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmationProfile);

  return {
    valid: validParent || validChild,
    selectable: validChild,
    isParent: validParent && !validChild,
    isChild: validChild,
    rawId: String(id || '').trim(),
    setup,
    regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY
  };
}

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts),
    ...getArray(row.executionFingerprintParts)
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');
}

function hasShortToken(text = '') {
  const value = ` ${cleanSideText(text)} `;

  return (
    value.includes('MICRO_SHORT_') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('POSITION_SIDE=SHORT') ||
    value.includes('POSITIONSIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('SIDE=SELL') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR') ||
    value.includes('DIRECTION=SELL') ||
    value.includes(' SHORT_') ||
    value.includes('_SHORT ') ||
    value.includes('_SHORT_') ||
    value.includes('|SHORT|') ||
    value.includes(':SHORT') ||
    value.includes('=SHORT') ||
    value.includes(' BEAR ') ||
    value.includes('_BEAR') ||
    value.includes('BEAR_') ||
    value.includes('|BEAR|') ||
    value.includes(':BEAR') ||
    value.includes('=BEAR') ||
    value.includes(' SELL ') ||
    value.includes('_SELL') ||
    value.includes('SELL_') ||
    value.includes('|SELL|') ||
    value.includes(':SELL') ||
    value.includes('=SELL') ||
    value.includes('DOWNSIDE')
  );
}

function hasLongToken(text = '') {
  const value = ` ${cleanSideText(text)} `;

  return (
    value.includes('MICRO_LONG_') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('POSITION_SIDE=LONG') ||
    value.includes('POSITIONSIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('SIDE=BUY') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL') ||
    value.includes('DIRECTION=BUY') ||
    value.includes(' LONG_') ||
    value.includes('_LONG ') ||
    value.includes('_LONG_') ||
    value.includes('|LONG|') ||
    value.includes(':LONG') ||
    value.includes('=LONG') ||
    value.includes(' BULL ') ||
    value.includes('_BULL') ||
    value.includes('BULL_') ||
    value.includes('|BULL|') ||
    value.includes(':BULL') ||
    value.includes('=BULL') ||
    value.includes(' BUY ') ||
    value.includes('_BUY') ||
    value.includes('BUY_') ||
    value.includes('|BUY|') ||
    value.includes(':BUY') ||
    value.includes('=BUY') ||
    value.includes('UPSIDE')
  );
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function directionalMoveScore(row = {}) {
  const values = [
    row.change1m,
    row.change5m,
    row.change15m,
    row.change30m,
    row.change1h,
    row.change4h,
    row.change24h,
    row.priceChange1mPct,
    row.priceChange5mPct,
    row.priceChange15mPct,
    row.priceChange30mPct,
    row.priceChange1hPct,
    row.priceChange4hPct,
    row.priceChange24hPct,
    row.priceChangePercent,
    row.priceChangePct,
    row.movePct,
    row.move,
    row.percentChange
  ]
    .map((value) => num(value, 0))
    .filter((value) => Number.isFinite(value) && value !== 0);

  if (!values.length) return 0;

  return values.reduce((sum, value) => sum + Math.sign(value), 0);
}

function hasBearishMove(row = {}) {
  return directionalMoveScore(row) < 0;
}

function hasBullishMove(row = {}) {
  return directionalMoveScore(row) > 0;
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    if (parseShortTaxonomyMicroId(row).valid) return TARGET_TRADE_SIDE;
    if (hasShortToken(row)) return TARGET_TRADE_SIDE;
    if (hasLongToken(row)) return OPPOSITE_TRADE_SIDE;

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

  for (const source of directSources) {
    const side = normalizeDirectSide(source);

    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const familyText = [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  if (parseShortTaxonomyMicroId(row.trueMicroFamilyId || row.microFamilyId).valid) return TARGET_TRADE_SIDE;
  if (hasShortToken(familyText)) return TARGET_TRADE_SIDE;
  if (hasLongToken(familyText)) return OPPOSITE_TRADE_SIDE;

  const reasonText = [
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.actionReason,
    row.rejectionReason
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  const reasonShort = hasShortToken(reasonText);
  const reasonLong = hasLongToken(reasonText);

  if (reasonShort && !reasonLong) return TARGET_TRADE_SIDE;
  if (reasonLong && !reasonShort) return OPPOSITE_TRADE_SIDE;

  const definition = getDefinitionHaystack(row);
  const definitionShort = hasShortToken(definition);
  const definitionLong = hasLongToken(definition);

  if (definitionShort && !definitionLong) return TARGET_TRADE_SIDE;
  if (definitionLong && !definitionShort) return OPPOSITE_TRADE_SIDE;

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (hasBearishMove(row)) return TARGET_TRADE_SIDE;
  if (hasBullishMove(row)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isTargetCandidate(candidate = {}) {
  return inferTradeSide(candidate) === TARGET_TRADE_SIDE;
}

function isOppositeCandidate(candidate = {}) {
  return inferTradeSide(candidate) === OPPOSITE_TRADE_SIDE;
}

function normalizeContractSymbol(candidate = {}) {
  return (
    candidate.contractSymbol ||
    candidate.symbol ||
    candidate.instId ||
    candidate.instrumentId ||
    null
  );
}

function normalizeSymbol(candidate = {}) {
  const symbol = (
    candidate.symbol ||
    candidate.baseSymbol ||
    candidate.contractSymbol ||
    candidate.instId ||
    candidate.instrumentId ||
    ''
  );

  return String(symbol || '').trim();
}

function normalizeShortCandidate(candidate = {}) {
  const symbol = normalizeSymbol(candidate);
  const contractSymbol = normalizeContractSymbol(candidate);
  const createdAt = num(candidate.createdAt || candidate.ts || now(), now());

  const rawTrueMicroFamilyId =
    candidate.trueMicroFamilyId ||
    candidate.microFamilyId ||
    candidate.analyzeMicroFamilyId ||
    candidate.learningMicroFamilyId ||
    candidate.childTrueMicroFamilyId ||
    null;

  const parsedTrueMicro = parseShortTaxonomyMicroId(rawTrueMicroFamilyId);

  const scannerMicroFamilyId =
    candidate.scannerMicroFamilyId ||
    candidate.scannerFamilyId ||
    candidate.scannerFingerprintId ||
    null;

  const carriedTrueMicroFamilyId = parsedTrueMicro.selectable
    ? parsedTrueMicro.trueMicroFamilyId
    : null;

  return {
    ...candidate,

    symbol,
    contractSymbol,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    scannerOnly: true,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,
    scannerDoesNotWriteLearningFamilies: true,
    scannerFindsBearishCandidates: true,

    scannerMicroFamilyId,
    scannerFamilyId: candidate.scannerFamilyId || scannerMicroFamilyId,
    scannerFingerprintId: candidate.scannerFingerprintId || scannerMicroFamilyId,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    scannerBucketsDebugMetadataOnly: true,
    legacy25BucketsDebugMetadataOnly: true,

    trueMicroFamilyId: carriedTrueMicroFamilyId,
    microFamilyId: carriedTrueMicroFamilyId,
    childTrueMicroFamilyId: carriedTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsedTrueMicro.parentTrueMicroFamilyId || null,
    coarseMicroFamilyId: parsedTrueMicro.parentTrueMicroFamilyId || null,

    scannerCarriedTrueMicroFamilyId: carriedTrueMicroFamilyId,
    scannerAssignedTrueMicroFamilyId: false,

    trueMicroFamilySchema: carriedTrueMicroFamilyId ? TRUE_MICRO_SCHEMA : null,
    parentTrueMicroFamilySchema: carriedTrueMicroFamilyId ? PARENT_TRUE_MICRO_SCHEMA : null,
    childTrueMicroFamilySchema: carriedTrueMicroFamilyId ? CHILD_TRUE_MICRO_SCHEMA : null,
    learningGranularity: carriedTrueMicroFamilyId ? LEARNING_GRANULARITY : null,
    parentLearningGranularity: carriedTrueMicroFamilyId ? PARENT_LEARNING_GRANULARITY : null,

    analyzeMustAssignTrueMicroFamily: !carriedTrueMicroFamilyId,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    selectable75ChildCandidate: Boolean(carriedTrueMicroFamilyId),

    scannerScore: num(candidate.scannerScore ?? candidate.moveScore, 0),
    change1h: num(candidate.change1h ?? candidate.priceChange1hPct, 0),
    change24h: num(candidate.change24h ?? candidate.priceChange24hPct, 0),
    volume24h: num(candidate.volume24h ?? candidate.quoteVolume24h ?? candidate.quoteVolume, 0),

    btcState: candidate.btcState || null,
    regime: candidate.regime || null,
    fakeBreakout: Boolean(candidate.fakeBreakout),
    fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),
    avoidShort: Boolean(candidate.avoidShort),

    scannerReason: candidate.scannerReason || candidate.reason || null,

    shortRiskShape: 'tp < entry < sl',
    validShortRiskShape: 'tp < entry && entry < sl',
    tpRule: 'price <= tp',
    slRule: 'price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    createdAt
  };
}

function splitCandidatesBySide(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];

  const targetCandidates = [];
  const oppositeCandidates = [];
  const unknownSideCandidates = [];

  for (const candidate of rows) {
    const tradeSide = inferTradeSide(candidate);

    if (tradeSide === TARGET_TRADE_SIDE) {
      targetCandidates.push(candidate);
      continue;
    }

    if (tradeSide === OPPOSITE_TRADE_SIDE) {
      oppositeCandidates.push(candidate);
      continue;
    }

    unknownSideCandidates.push(candidate);
  }

  return {
    targetCandidates,
    oppositeCandidates,
    unknownSideCandidates
  };
}

function averageScannerScore(candidates = []) {
  if (!candidates.length) return 0;

  const total = candidates.reduce((sum, candidate) => {
    return sum + num(candidate?.scannerScore ?? candidate?.moveScore, 0);
  }, 0);

  return round(total / candidates.length, 2);
}

function topSymbols(candidates = [], limit = 20) {
  return candidates
    .slice(0, limit)
    .map((candidate) => candidate.symbol || candidate.contractSymbol)
    .filter(Boolean);
}

function buildCandidateStats(rawCandidates = [], candidates = []) {
  const {
    targetCandidates,
    oppositeCandidates,
    unknownSideCandidates
  } = splitCandidatesBySide(rawCandidates);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const cleanCandidates = candidates.filter((candidate) => !candidate.fakeBreakout && !candidate.avoidShort);
  const fakeBreakouts = candidates.filter((candidate) => candidate.fakeBreakout);
  const fakeRiskCandidates = candidates.filter((candidate) => candidate.fakeBreakoutRisk || candidate.avoidShort);

  return {
    candidates: candidates.length,
    cleanCandidates: cleanCandidates.length,
    fakeBreakouts: fakeBreakouts.length,
    fakeRiskCandidates: fakeRiskCandidates.length,

    scannerGateCandidates: scannerGateCandidates.length,
    analyzeOnlyCandidates: analyzeOnlyCandidates.length,

    shortCandidates: candidates.length,
    longCandidates: 0,
    unknownSideCandidates: 0,

    bearCandidates: candidates.length,
    bullCandidates: 0,

    rawCandidates: rawCandidates.length,
    rawShortCandidates: targetCandidates.length,
    rawLongCandidatesIgnored: oppositeCandidates.length,
    rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

    avgScannerScore: averageScannerScore(candidates)
  };
}

function normalizeLatest(latest, snapshot = null, meta = {}) {
  const snapshotId = extractSnapshotId(latest) || snapshot?.snapshotId || meta.snapshotId || null;

  const candidates = Array.isArray(snapshot?.candidates)
    ? snapshot.candidates
    : [];

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const base = latest && typeof latest === 'object'
    ? latest
    : { snapshotId };

  const createdAt = snapshotCreatedAt(snapshot || base);
  const ageSec = createdAt > 0
    ? Math.max(0, Math.floor((now() - createdAt) / 1000))
    : null;

  const hasSnapshot = Boolean(snapshot);

  const fallbackCount = num(
    base.shortCandidatesCount ??
    base.selectedTargetCandidateCount ??
    base.scannerGateCandidatesCount ??
    base.candidatesCount ??
    base.count,
    0
  );

  return {
    ...base,

    ...modeFlags(),

    taxonomy: taxonomyMeta(),

    snapshotId,

    selectedSnapshotSource: meta.snapshotSource || null,
    selectedSnapshotReason: meta.snapshotReason || null,

    createdAt: createdAt || base.createdAt || null,
    snapshotAgeSec: ageSec,

    candidatesCount: hasSnapshot ? candidates.length : fallbackCount,
    shortCandidatesCount: hasSnapshot ? candidates.length : fallbackCount,
    longCandidatesCount: 0,

    scannerGateCandidatesCount: hasSnapshot
      ? scannerGateCandidates.length
      : num(base.scannerGateCandidatesCount, 0),

    analyzeOnlyCandidatesCount: hasSnapshot
      ? analyzeOnlyCandidates.length
      : num(base.analyzeOnlyCandidatesCount, 0),

    topSymbols: hasSnapshot
      ? topSymbols(candidates)
      : Array.isArray(base.topSymbols)
        ? base.topSymbols.slice(0, 20)
        : [],

    scannerGateSymbols: topSymbols(scannerGateCandidates),

    isStale8m: ageSec === null ? null : ageSec > STALE_8M_SEC,
    isStale30m: ageSec === null ? null : ageSec > STALE_30M_SEC
  };
}

function normalizeSnapshot(snapshot, fallbackId = null, meta = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const rawCandidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const {
    targetCandidates,
    oppositeCandidates,
    unknownSideCandidates
  } = splitCandidatesBySide(rawCandidates);

  const candidates = targetCandidates.map(normalizeShortCandidate);
  const ageSec = snapshotAgeSec(snapshot);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  return {
    ...snapshot,

    ...modeFlags(),

    taxonomy: taxonomyMeta(),

    snapshotId: snapshot.snapshotId || fallbackId || null,

    selectedSnapshotSource: meta.snapshotSource || null,
    selectedSnapshotReason: meta.snapshotReason || null,

    rawCandidatesCount: rawCandidates.length,
    rawShortCandidatesCount: targetCandidates.length,
    rawLongCandidatesIgnored: oppositeCandidates.length,
    rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

    candidates,
    candidatesCount: candidates.length,
    shortCandidatesCount: candidates.length,
    longCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    topSymbols: topSymbols(candidates),
    scannerGateSymbols: topSymbols(scannerGateCandidates),

    stats: buildCandidateStats(rawCandidates, candidates),

    snapshotAgeSec: ageSec,
    isStale8m: ageSec === null ? null : ageSec > STALE_8M_SEC,
    isStale30m: ageSec === null ? null : ageSec > STALE_30M_SEC
  };
}

function targetCandidateCount(snapshot = {}) {
  const candidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return candidates.filter(isTargetCandidate).length;
}

function oppositeCandidateCount(snapshot = {}) {
  const candidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return candidates.filter(isOppositeCandidate).length;
}

async function safeGetSnapshotJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

async function loadRecentSnapshotCandidates(redis) {
  const keys = await getKeys(
    redis,
    snapshotPattern(),
    SNAPSHOT_SEARCH_LIMIT
  ).catch(() => []);

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetSnapshotJson(redis, key, null);

      if (!hasFullSnapshotShape(snapshot)) return null;

      return {
        source: `SHORT_SCAN:RECENT_SEARCH:${key}`,
        snapshot,
        snapshotId: snapshot.snapshotId || key,
        targetCount: targetCandidateCount(snapshot),
        oppositeCount: oppositeCandidateCount(snapshot),
        createdAt: snapshotCreatedAt(snapshot)
      };
    })
  );

  return rows
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function dedupeSnapshotCandidates(candidates = []) {
  const unique = new Map();

  for (const item of candidates) {
    if (!item?.snapshot || !hasFullSnapshotShape(item.snapshot)) continue;

    const id = item.snapshot?.snapshotId || item.snapshotId || item.snapshotSource;

    if (!id) continue;

    const previous = unique.get(id);

    if (!previous) {
      unique.set(id, item);
      continue;
    }

    if (
      item.createdAt > previous.createdAt ||
      (
        item.createdAt === previous.createdAt &&
        item.targetCount > previous.targetCount
      )
    ) {
      unique.set(id, item);
    }
  }

  return [...unique.values()]
    .filter((item) => hasFullSnapshotShape(item.snapshot))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function loadSnapshot(redis, latest) {
  const snapshotId = extractSnapshotId(latest);
  const candidates = [];

  if (hasFullSnapshotShape(latest)) {
    candidates.push({
      snapshot: latest,
      snapshotSource: 'SHORT_SCAN:LATEST_FULL_SNAPSHOT',
      snapshotReason: 'LATEST_FULL_SNAPSHOT',
      snapshotId: latest.snapshotId || snapshotId,
      targetCount: targetCandidateCount(latest),
      oppositeCount: oppositeCandidateCount(latest),
      createdAt: snapshotCreatedAt(latest)
    });
  }

  if (snapshotId) {
    const byId = await safeGetSnapshotJson(
      redis,
      snapshotKey(snapshotId),
      null
    );

    if (hasFullSnapshotShape(byId)) {
      candidates.push({
        snapshot: byId,
        snapshotSource: 'SHORT_SCAN:SNAPSHOT_BY_ID',
        snapshotReason: 'SNAPSHOT_REFERENCED_BY_LATEST_ID',
        snapshotId,
        targetCount: targetCandidateCount(byId),
        oppositeCount: oppositeCandidateCount(byId),
        createdAt: snapshotCreatedAt(byId)
      });
    }
  }

  const recent = await loadRecentSnapshotCandidates(redis);

  for (const item of recent) {
    candidates.push({
      ...item,
      snapshotSource: item.source,
      snapshotReason: 'RECENT_SNAPSHOT_SEARCH'
    });
  }

  const sorted = dedupeSnapshotCandidates(candidates);

  const selectedTarget = sorted.find((item) => item.targetCount > 0);

  if (selectedTarget) {
    return {
      snapshot: normalizeSnapshot(
        selectedTarget.snapshot,
        selectedTarget.snapshotId,
        {
          snapshotSource: selectedTarget.snapshotSource,
          snapshotReason: 'NEWEST_SHORT_SNAPSHOT_WITH_CANDIDATES'
        }
      ),
      snapshotSource: selectedTarget.snapshotSource,
      snapshotReason: 'NEWEST_SHORT_SNAPSHOT_WITH_CANDIDATES',
      snapshotId: selectedTarget.snapshotId,
      rawTargetCount: selectedTarget.targetCount,
      rawOppositeCount: selectedTarget.oppositeCount,
      snapshotsScanned: sorted.length
    };
  }

  const selectedAny = sorted[0] || null;

  if (!selectedAny) {
    return {
      snapshot: null,
      snapshotSource: snapshotId ? 'SHORT_SNAPSHOT_NOT_FOUND' : 'NO_SHORT_SNAPSHOT_ID',
      snapshotReason: snapshotId ? 'LATEST_REFERENCED_MISSING_SHORT_SNAPSHOT' : 'NO_LATEST_SHORT_SNAPSHOT_ID',
      snapshotId: snapshotId || null,
      rawTargetCount: 0,
      rawOppositeCount: 0,
      snapshotsScanned: 0
    };
  }

  return {
    snapshot: normalizeSnapshot(
      selectedAny.snapshot,
      selectedAny.snapshotId,
      {
        snapshotSource: selectedAny.snapshotSource,
        snapshotReason: 'NO_SHORT_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE'
      }
    ),
    snapshotSource: selectedAny.snapshotSource,
    snapshotReason: 'NO_SHORT_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE',
    snapshotId: selectedAny.snapshotId,
    rawTargetCount: selectedAny.targetCount,
    rawOppositeCount: selectedAny.oppositeCount,
    snapshotsScanned: sorted.length
  };
}

function emptyStats() {
  return {
    candidates: 0,
    cleanCandidates: 0,
    fakeBreakouts: 0,
    fakeRiskCandidates: 0,

    scannerGateCandidates: 0,
    analyzeOnlyCandidates: 0,

    shortCandidates: 0,
    longCandidates: 0,
    unknownSideCandidates: 0,

    bearCandidates: 0,
    bullCandidates: 0,

    rawCandidates: 0,
    rawShortCandidates: 0,
    rawLongCandidatesIgnored: 0,
    rawUnknownSideCandidatesIgnored: 0,

    avgScannerScore: 0
  };
}

function buildSummary({
  latest,
  snapshot,
  candidates,
  rawTargetCount,
  rawOppositeCount,
  snapshotsScanned
}) {
  return {
    ...modeFlags(),

    taxonomy: taxonomyMeta(),

    latestSnapshotId: latest?.snapshotId || null,
    selectedSnapshotId: snapshot?.snapshotId || null,

    snapshotsScanned: num(snapshotsScanned, 0),

    candidates: candidates.length,
    shortCandidates: candidates.length,
    longCandidates: 0,

    rawTargetCount: num(rawTargetCount, 0),
    rawOppositeCount: num(rawOppositeCount, 0),

    rawCandidates: num(snapshot?.rawCandidatesCount, 0),
    rawLongCandidatesIgnored: num(snapshot?.rawLongCandidatesIgnored, 0),
    rawUnknownSideCandidatesIgnored: num(snapshot?.rawUnknownSideCandidatesIgnored, 0),

    scannerGateCandidates: num(snapshot?.scannerGateCandidatesCount, 0),
    analyzeOnlyCandidates: num(snapshot?.analyzeOnlyCandidatesCount, 0),

    avgScannerScore: averageScannerScore(candidates),

    topSymbols: topSymbols(candidates)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Scanner-Mode', 'short-only-scanner-discovery-75-child-contract-v1');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Scanner-Side', TARGET_SCANNER_SIDE);
  res.setHeader('X-Scanner-Only', 'true');
  res.setHeader('X-Scanner-Fingerprints-Metadata-Only', 'true');
  res.setHeader('X-Scanner-Fingerprints-Used-As-Learning-Family', 'false');
  res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
  res.setHeader('X-Parent-True-Micro-Family-Schema', PARENT_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Child-True-Micro-Family-Schema', CHILD_TRUE_MICRO_SCHEMA);
  res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
  res.setHeader('X-Selectable-Child-Micro-Families', '75');
  res.setHeader('X-Parent-Micro-Families', '15');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Exchange-Calls-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
  res.setHeader('X-Long-Root-Touched', 'false');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const redis = getVolatileRedis();
    const latestRaw = await getJson(redis, SHORT_KEYS.scan.latest, null);

    const {
      snapshot,
      snapshotSource,
      snapshotReason,
      snapshotId,
      rawTargetCount,
      rawOppositeCount,
      snapshotsScanned
    } = await loadSnapshot(redis, latestRaw);

    const candidates = Array.isArray(snapshot?.candidates)
      ? snapshot.candidates
      : [];

    const latest = normalizeLatest(latestRaw, snapshot, {
      snapshotId,
      snapshotSource,
      snapshotReason
    });

    return res.status(200).json({
      ok: true,

      ...modeFlags(),

      taxonomy: taxonomyMeta(),

      shortKeys: {
        namespace: SHORT_NAMESPACE,
        prefix: SHORT_KEY_PREFIX,
        scanLatest: SHORT_KEYS.scan.latest,
        snapshotPattern: SHORT_KEYS.scan.snapshotPattern
      },

      latest,
      snapshot,
      candidates,

      snapshotId,
      snapshotSource,
      snapshotReason,

      candidatesCount: candidates.length,
      shortCandidatesCount: candidates.length,
      longCandidatesCount: 0,

      rawTargetCount,
      rawOppositeCount,
      snapshotsScanned,

      stats: snapshot?.stats || emptyStats(),

      summary: buildSummary({
        latest,
        snapshot,
        candidates,
        rawTargetCount,
        rawOppositeCount,
        snapshotsScanned
      }),

      warnings: uniqueStrings([
        !snapshot ? 'NO_SHORT_SCANNER_SNAPSHOT_AVAILABLE' : null,
        snapshot?.isStale8m ? 'SHORT_SCANNER_SNAPSHOT_STALE_8M' : null,
        snapshot?.isStale30m ? 'SHORT_SCANNER_SNAPSHOT_STALE_30M' : null,
        rawOppositeCount > 0 ? `LONG_CANDIDATES_IGNORED:${rawOppositeCount}` : null,
        snapshot?.rawUnknownSideCandidatesIgnored > 0
          ? `UNKNOWN_SIDE_CANDIDATES_IGNORED:${snapshot.rawUnknownSideCandidatesIgnored}`
          : null,
        snapshot && candidates.length <= 0
          ? 'NO_SHORT_CANDIDATES_IN_SELECTED_SNAPSHOT'
          : null
      ].filter(Boolean)),

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}