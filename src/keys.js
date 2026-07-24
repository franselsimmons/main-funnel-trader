// ================= FILE: src/keys.js =================

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

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

const keyPart = (value, fallback = 'UNKNOWN') => {
  const raw = value === undefined || value === null || value === ''
    ? fallback
    : value;

  const normalized = String(raw)
    .trim()
    .replaceAll(':', '_')
    .replaceAll('|', '_')
    .replaceAll('/', '_')
    .replaceAll('\\', '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || fallback;
};

const symbolPart = (value, fallback = 'UNKNOWN') => {
  return keyPart(value, fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
};

const deepFreeze = (object) => {
  Object.freeze(object);

  for (const value of Object.values(object)) {
    if (
      value &&
      typeof value === 'object' &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  }

  return object;
};

const shortKey = (value = '') => {
  const raw = String(value || '').trim();

  if (!raw) return SHORT_KEY_PREFIX;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;

  return `${SHORT_KEY_PREFIX}${raw}`;
};

const WRITE_SCOPE_NAMES = {
  SCANNER_RUN: 'SCANNER_RUN',
  TRADE_RUN: 'TRADE_RUN',
  ANALYZE_PARTIAL: 'ANALYZE_PARTIAL',
  ADMIN_READONLY: 'ADMIN_READONLY',
  MANUAL_ROTATION: 'MANUAL_ROTATION',
  FACTORY_RESET: 'FACTORY_RESET',
  RESET_LEARNING: 'RESET_LEARNING',
  RESET_ROTATION: 'RESET_ROTATION'
};

const exact = (key) => ({
  type: 'exact',
  value: key
});

const prefix = (value) => ({
  type: 'prefix',
  value
});

const pattern = (value) => ({
  type: 'pattern',
  value
});

const normalizeKey = (key) => String(key || '').trim();

const ruleMatches = (rule, key) => {
  const value = normalizeKey(key);

  if (!value || !rule) return false;

  if (rule.type === 'exact') return value === rule.value;
  if (rule.type === 'prefix') return value.startsWith(rule.value);

  if (rule.type === 'pattern') {
    const raw = String(rule.value || '');

    if (raw.endsWith('*')) {
      return value.startsWith(raw.slice(0, -1));
    }

    return value === raw;
  }

  return false;
};

const taxonomyFlags = () => ({
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
  selectableFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',

  setupTypes: SHORT_FIXED_SETUP_TYPES,
  regimeBuckets: SHORT_FIXED_REGIME_BUCKETS,
  confirmationProfiles: SHORT_CONFIRMATION_PROFILES
});

const shortRiskFlags = () => ({
  riskGeometryRule: 'SHORT: tp < entry < sl',
  tpHitRule: 'SHORT: price <= tp',
  slHitRule: 'SHORT: price >= sl',
  grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
  currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
  validShortRiskShape: 'tp < entry < sl',
  shortRiskRule: 'tp < entry < sl',
  shortTpExitRule: 'price <= tp',
  shortSlExitRule: 'price >= sl',
  shortTimeStopExitRule: 'TIME_STOP',
  shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
  shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)'
});

const currentFitFlags = () => ({
  currentFitSoftOnly: true,
  currentFitBlocksLearning: false,
  currentFitBlocksVirtualLearning: false,
  currentFitBlocksShadowLearning: false,
  currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
  currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT'
});

const shortIdentityFlags = () => ({
  namespace: SHORT_NAMESPACE,
  keyPrefix: SHORT_KEY_PREFIX,
  redisNamespace: SHORT_NAMESPACE,
  redisKeyPrefix: SHORT_KEY_PREFIX,
  persistentLearningKey: PERSISTENT_LEARNING_KEY,
  redisKeysSeparatedFromLongRoot: true,

  targetTradeSide: TARGET_TRADE_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,
  scannerSide: TARGET_SCANNER_SIDE,
  targetScannerSide: TARGET_SCANNER_SIDE,
  oppositeTradeSide: OPPOSITE_TRADE_SIDE,

  shortOnly: true,
  longDisabled: true,
  longOnly: false,
  shortDisabled: false,

  virtualLearning: true,
  virtualOnly: true,
  virtualTracked: true,

  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeOrdersDisabled: true,
  exchangeCallsDisabled: true,
  noRealOrders: true,
  noExchangeOrders: true,

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

  longRootTouched: false,

  ...taxonomyFlags(),
  ...shortRiskFlags(),
  ...currentFitFlags()
});

const buildKeyScope = ({
  name,
  description,
  allowed = [],
  denied = [],
  readonly = false
}) => ({
  name,
  description,
  readonly,
  allowed,
  denied,
  ...shortIdentityFlags()
});

const NON_SHORT_WRITE_DENY_PATTERNS = [
  pattern('SCAN:*'),
  pattern('LIVE:*'),
  pattern('TRADE:*'),
  pattern('ANALYZE:*'),
  pattern('CIRCUIT:*'),
  pattern('DISCORD:*'),
  pattern('RESET:*'),
  pattern('LONG:*'),
  pattern('LONG:*:*'),
  pattern('LONG_LIVE:*')
];

const SCAN_LATEST_KEY = shortKey('SCAN:LATEST');
const SCAN_LOCK_KEY = shortKey('SCAN:LOCK');
const SCAN_RUN_META_KEY = shortKey('SCAN:RUN:META');
const SCAN_SNAPSHOT_PREFIX = shortKey('SCAN:SNAPSHOT:');

const LIVE_CACHE_PREFIX = shortKey('LIVE:CACHE:');

const TRADE_LOCK_KEY = shortKey('TRADE:LOCK');
const TRADE_RUN_META_KEY = shortKey('TRADE:RUN:META');
const TRADE_LAST_PROCESSED_SNAPSHOT_KEY = shortKey('TRADE:LAST_PROCESSED_SNAPSHOT');
const TRADE_OPEN_PREFIX = shortKey('TRADE:OPEN:');
const TRADE_EVENT_LOG_KEY = shortKey('TRADE:EVENTS');
const TRADE_ENTRY_LOG_KEY = shortKey('TRADE:ENTRIES');
const TRADE_EXIT_LOG_KEY = shortKey('TRADE:EXITS');

const ANALYZE_OBS_LAST_PREFIX = shortKey('ANALYZE:OBS:LAST:');
const ANALYZE_WEEK_PREFIX = shortKey('ANALYZE:WEEK:');
const ANALYZE_SHADOW_PREFIX = shortKey('ANALYZE:SHADOW:');
const ANALYZE_MICRO_PREFIX = shortKey('ANALYZE:MICRO:');
const ANALYZE_PARENT_PREFIX = shortKey('ANALYZE:PARENT:');
const ANALYZE_CHILD_PREFIX = shortKey('ANALYZE:CHILD:');

const ANALYZE_ACTIVE_ROTATION_KEY = shortKey('ANALYZE:ACTIVE_ROTATION');
const ANALYZE_NEXT_ROTATION_KEY = shortKey('ANALYZE:NEXT_ROTATION');
const ANALYZE_ROTATION_VALID_FROM_KEY = shortKey('ANALYZE:ROTATION_VALID_FROM');
const ANALYZE_MANUAL_SELECTION_LOG_KEY = shortKey('ANALYZE:MANUAL_SELECTION_LOG');
const ANALYZE_ROTATION_HISTORY_KEY = shortKey('ANALYZE:ROTATION_HISTORY');
const ANALYZE_FREEZE_LOCK_KEY = shortKey('ANALYZE:WEEKLY_FREEZE_LOCK');
const ANALYZE_ACTIVATE_LOCK_KEY = shortKey('ANALYZE:ROTATION_ACTIVATE_LOCK');

const CIRCUIT_PAUSED_PREFIX = shortKey('CIRCUIT:PAUSED:');

const DISCORD_LOGS_KEY = shortKey('DISCORD:LOGS');
const RESET_LOGS_KEY = shortKey('RESET:LOGS');

const SHORT_PATTERNS = {
  scan: shortKey('SCAN:*'),
  live: shortKey('LIVE:*'),
  trade: shortKey('TRADE:*'),
  analyze: shortKey('ANALYZE:*'),
  circuit: shortKey('CIRCUIT:*'),
  discord: shortKey('DISCORD:*'),
  reset: shortKey('RESET:*')
};

export const WRITE_SCOPES = deepFreeze({
  names: WRITE_SCOPE_NAMES,

  scannerRun: buildKeyScope({
    name: WRITE_SCOPE_NAMES.SCANNER_RUN,
    description: 'SHORT scanner run mag uitsluitend SHORT scanner snapshot/latest/meta schrijven. Scanner selecteert geen microfamilies, triggert geen Discord en schrijft geen learning-family.',
    allowed: [
      exact(SCAN_LATEST_KEY),
      exact(SCAN_RUN_META_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX)
    ],
    denied: [
      ...NON_SHORT_WRITE_DENY_PATTERNS,

      pattern(shortKey('TRADE:*')),
      pattern(shortKey('ANALYZE:*')),
      pattern(shortKey('CIRCUIT:*')),
      pattern(shortKey('DISCORD:*')),
      pattern(shortKey('RESET:*')),
      pattern(shortKey('LIVE:*'))
    ]
  }),

  tradeRun: buildKeyScope({
    name: WRITE_SCOPE_NAMES.TRADE_RUN,
    description: 'SHORT trade run mag SHORT virtual trade state schrijven en Analyze alleen via partial learning updates. Geen scanner overwrite, geen rotation overwrite, geen echte orders.',
    allowed: [
      exact(TRADE_RUN_META_KEY),
      exact(TRADE_LAST_PROCESSED_SNAPSHOT_KEY),
      prefix(TRADE_OPEN_PREFIX),
      exact(TRADE_EVENT_LOG_KEY),
      exact(TRADE_ENTRY_LOG_KEY),
      exact(TRADE_EXIT_LOG_KEY),

      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX)
    ],
    denied: [
      ...NON_SHORT_WRITE_DENY_PATTERNS,

      exact(SCAN_LATEST_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX),
      exact(SCAN_RUN_META_KEY),

      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),

      pattern(shortKey('DISCORD:*')),
      pattern(shortKey('RESET:*'))
    ]
  }),

  analyzePartial: buildKeyScope({
    name: WRITE_SCOPE_NAMES.ANALYZE_PARTIAL,
    description: 'SHORT Analyze mag observations/outcomes cumulatief bijwerken op exact 75-child trueMicroFamilyId en parent 15 context, maar geen rotation/manual selectie overschrijven.',
    allowed: [
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX)
    ],
    denied: [
      ...NON_SHORT_WRITE_DENY_PATTERNS,

      exact(SCAN_LATEST_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX),
      pattern(shortKey('TRADE:*')),

      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),

      pattern(shortKey('DISCORD:*')),
      pattern(shortKey('RESET:*'))
    ]
  }),

  adminReadonly: buildKeyScope({
    name: WRITE_SCOPE_NAMES.ADMIN_READONLY,
    description: 'Admin GET/API read-only endpoints mogen niets schrijven.',
    readonly: true,
    allowed: [],
    denied: [
      ...NON_SHORT_WRITE_DENY_PATTERNS,

      pattern(shortKey('SCAN:*')),
      pattern(shortKey('LIVE:*')),
      pattern(shortKey('TRADE:*')),
      pattern(shortKey('ANALYZE:*')),
      pattern(shortKey('CIRCUIT:*')),
      pattern(shortKey('DISCORD:*')),
      pattern(shortKey('RESET:*'))
    ]
  }),

  manualRotation: buildKeyScope({
    name: WRITE_SCOPE_NAMES.MANUAL_ROTATION,
    description: 'Alleen expliciete SHORT admin manual selection mag SHORT rotation/Discord selectie aanpassen. Alleen exact 75-child trueMicroFamilyId is selecteerbaar.',
    allowed: [
      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),
      exact(DISCORD_LOGS_KEY)
    ],
    denied: [
      ...NON_SHORT_WRITE_DENY_PATTERNS,

      exact(SCAN_LATEST_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX),
      pattern(shortKey('TRADE:*')),

      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),

      pattern(shortKey('RESET:*'))
    ]
  }),

  factoryReset: buildKeyScope({
    name: WRITE_SCOPE_NAMES.FACTORY_RESET,
    description: 'Alleen SHORT factory reset endpoints met expliciete bevestiging mogen SHORT keys verwijderen/schrijven.',
    allowed: [
      pattern(shortKey('SCAN:*')),
      pattern(shortKey('LIVE:*')),
      pattern(shortKey('TRADE:*')),
      pattern(shortKey('ANALYZE:*')),
      pattern(shortKey('CIRCUIT:*')),
      pattern(shortKey('DISCORD:*')),
      pattern(shortKey('RESET:*'))
    ],
    denied: [
      ...NON_SHORT_WRITE_DENY_PATTERNS
    ]
  }),

  resetLearning: buildKeyScope({
    name: WRITE_SCOPE_NAMES.RESET_LEARNING,
    description: 'Reset alleen SHORT learning/analyze data. Rotation, manual selection, scanner, trade state, open virtual positions en Discord blijven bewaard.',
    allowed: [
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX),
      exact(RESET_LOGS_KEY)
    ],
    denied: [
      ...NON_SHORT_WRITE_DENY_PATTERNS,

      pattern(shortKey('SCAN:*')),
      pattern(shortKey('LIVE:*')),
      pattern(shortKey('TRADE:*')),

      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),

      pattern(shortKey('DISCORD:*'))
    ]
  }),

  resetRotation: buildKeyScope({
    name: WRITE_SCOPE_NAMES.RESET_ROTATION,
    description: 'Reset alleen SHORT active/next rotation en manual selection metadata. Learning/outcomes/open positions/scanner blijven bewaard.',
    allowed: [
      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),
      exact(RESET_LOGS_KEY)
    ],
    denied: [
      ...NON_SHORT_WRITE_DENY_PATTERNS,

      pattern(shortKey('SCAN:*')),
      pattern(shortKey('LIVE:*')),
      pattern(shortKey('TRADE:*')),

      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_PARENT_PREFIX),
      prefix(ANALYZE_CHILD_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),

      pattern(shortKey('DISCORD:*'))
    ]
  })
});

export function isShortNamespacedKey(key) {
  return normalizeKey(key).startsWith(SHORT_KEY_PREFIX);
}

export function isKeyAllowedForWriteScope(scopeName, key) {
  const scope = Object.values(WRITE_SCOPES)
    .find((entry) => entry && typeof entry === 'object' && entry.name === scopeName);

  if (!scope) return false;
  if (scope.readonly) return false;

  const normalized = normalizeKey(key);

  if (!normalized.startsWith(SHORT_KEY_PREFIX)) {
    return false;
  }

  const denied = Array.isArray(scope.denied)
    ? scope.denied.some((rule) => ruleMatches(rule, normalized))
    : false;

  if (denied) return false;

  return Array.isArray(scope.allowed)
    ? scope.allowed.some((rule) => ruleMatches(rule, normalized))
    : false;
}

export function assertKeyAllowedForWriteScope(scopeName, key) {
  if (isKeyAllowedForWriteScope(scopeName, key)) {
    return true;
  }

  const error = new Error('WRITE_SCOPE_VIOLATION_SHORT_ONLY');

  error.details = {
    scopeName,
    key: normalizeKey(key),
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    longDisabled: true,
    longRootTouched: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    ...taxonomyFlags(),
    ...shortRiskFlags(),
    ...currentFitFlags()
  };

  throw error;
}

const scanKeys = {
  latest: SCAN_LATEST_KEY,
  lock: SCAN_LOCK_KEY,

  snapshot: (snapshotId) => `${SCAN_SNAPSHOT_PREFIX}${keyPart(snapshotId)}`,
  snapshotPattern: `${SCAN_SNAPSHOT_PREFIX}*`,

  runMeta: SCAN_RUN_META_KEY,
  runMetaPattern: shortKey('SCAN:RUN:*'),

  metadataOnly: true,
  scannerDoesNotTrade: true,
  scannerDoesNotSelectMicroFamilies: true,
  scannerDoesNotSendDiscord: true,
  scannerDoesNotWriteLearningFamilies: true
};

const liveKeys = {
  cache: (symbol, type) => `${LIVE_CACHE_PREFIX}${symbolPart(symbol)}:${keyPart(type)}`,
  cachePattern: `${LIVE_CACHE_PREFIX}*`,

  marketDataOnly: true,
  exchangeCallsReadOnly: true
};

const tradeKeys = {
  lock: TRADE_LOCK_KEY,
  runMeta: TRADE_RUN_META_KEY,

  lastProcessedSnapshot: TRADE_LAST_PROCESSED_SNAPSHOT_KEY,

  open: (symbol) => `${TRADE_OPEN_PREFIX}${symbolPart(symbol)}`,
  openPattern: `${TRADE_OPEN_PREFIX}*`,

  eventLog: TRADE_EVENT_LOG_KEY,
  entryLog: TRADE_ENTRY_LOG_KEY,
  exitLog: TRADE_EXIT_LOG_KEY,

  pattern: shortKey('TRADE:*'),

  virtualOnly: true,
  realOrdersDisabled: true,
  oneOpenPositionPerSymbol: true,
  closeRules: {
    tp: 'price <= tp',
    sl: 'price >= sl',
    timeStop: 'TIME_STOP'
  },
  validRiskShape: 'tp < entry < sl',
  outcomeRSource: 'netR',

  ...shortRiskFlags()
};

const analyzeKeys = {
  persistentLearningKey: PERSISTENT_LEARNING_KEY,

  obsLast: (snapshotId, symbol, trueMicroFamilyId) => (
    `${ANALYZE_OBS_LAST_PREFIX}${keyPart(snapshotId)}:${symbolPart(symbol)}:${keyPart(trueMicroFamilyId)}`
  ),
  obsLastPattern: `${ANALYZE_OBS_LAST_PREFIX}*`,

  shadowLast: (symbol, trueMicroFamilyId) => (
    `${shortKey('ANALYZE:SHADOW:LAST:')}${symbolPart(symbol)}:${keyPart(trueMicroFamilyId)}`
  ),
  shadowLastPattern: shortKey('ANALYZE:SHADOW:LAST:*'),

  shadowOpen: (id) => `${shortKey('ANALYZE:SHADOW:OPEN:')}${keyPart(id)}`,
  shadowOpenPattern: shortKey('ANALYZE:SHADOW:OPEN:*'),
  shadowPattern: shortKey('ANALYZE:SHADOW:*'),

  microStats: (trueMicroFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(trueMicroFamilyId)}:STATS`,
  microRegimeStats: (trueMicroFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(trueMicroFamilyId)}:REGIME`,
  microOutcomes: (trueMicroFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(trueMicroFamilyId)}:OUTCOMES`,
  microExamples: (trueMicroFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(trueMicroFamilyId)}:EXAMPLES`,
  microPattern: `${ANALYZE_MICRO_PREFIX}*`,

  childStats: (childTrueMicroFamilyId) => `${ANALYZE_CHILD_PREFIX}${keyPart(childTrueMicroFamilyId)}:STATS`,
  childOutcomes: (childTrueMicroFamilyId) => `${ANALYZE_CHILD_PREFIX}${keyPart(childTrueMicroFamilyId)}:OUTCOMES`,
  childPattern: `${ANALYZE_CHILD_PREFIX}*`,

  parentStats: (parentTrueMicroFamilyId) => `${ANALYZE_PARENT_PREFIX}${keyPart(parentTrueMicroFamilyId)}:STATS`,
  parentOutcomes: (parentTrueMicroFamilyId) => `${ANALYZE_PARENT_PREFIX}${keyPart(parentTrueMicroFamilyId)}:OUTCOMES`,
  parentPattern: `${ANALYZE_PARENT_PREFIX}*`,

  weekMicros: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:MICROS`,
  weekParents: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:PARENTS`,
  weekChildren: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:CHILDREN`,
  weekMeta: (weekKey = PERSISTENT_LEARNING_KEY) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:META`,
  weekPattern: `${ANALYZE_WEEK_PREFIX}*`,

  activeRotation: ANALYZE_ACTIVE_ROTATION_KEY,
  nextRotation: ANALYZE_NEXT_ROTATION_KEY,
  rotationValidFrom: ANALYZE_ROTATION_VALID_FROM_KEY,

  manualSelectionLog: ANALYZE_MANUAL_SELECTION_LOG_KEY,
  rotationHistory: ANALYZE_ROTATION_HISTORY_KEY,

  freezeLock: ANALYZE_FREEZE_LOCK_KEY,
  activateLock: ANALYZE_ACTIVATE_LOCK_KEY,

  pattern: shortKey('ANALYZE:*'),

  completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
  scoringRSource: 'netR',
  statsKeyMode: 'EXACT_75_CHILD_TRUE_MICRO_ONLY',

  ...taxonomyFlags(),
  ...shortRiskFlags(),
  ...currentFitFlags()
};

const circuitKeys = {
  paused: (trueMicroFamilyId) => `${CIRCUIT_PAUSED_PREFIX}${keyPart(trueMicroFamilyId)}`,
  pausedPattern: `${CIRCUIT_PAUSED_PREFIX}*`
};

const discordKeys = {
  logList: DISCORD_LOGS_KEY,
  pattern: shortKey('DISCORD:*'),

  selectedMicroOnly: true,
  exactTrueMicroFamilyMatchOnly: true,
  exact75ChildTrueMicroMatchOnly: true,
  allowParentMatch: false,
  allowMacroMatch: false,
  allowScannerFingerprintMatch: false,
  allowExecutionFingerprintMatch: false
};

const resetKeys = {
  logList: RESET_LOGS_KEY,
  pattern: shortKey('RESET:*'),

  factoryConfirmText: 'SHORT_FACTORY_RESET_CONFIRMED',
  learningConfirmText: 'RESET_LEARNING_SHORT',
  rotationConfirmText: 'RESET_ROTATION_SHORT'
};

const taxonomyKeys = {
  setupTypes: SHORT_FIXED_SETUP_TYPES,
  regimeBuckets: SHORT_FIXED_REGIME_BUCKETS,
  confirmationProfiles: SHORT_CONFIRMATION_PROFILES,

  parentTrueMicroFamily: (setup, regime) => (
    `MICRO_SHORT_${keyPart(setup).toUpperCase()}_${keyPart(regime).toUpperCase()}`
  ),

  childTrueMicroFamily: (setup, regime, confirmationProfile) => (
    `MICRO_SHORT_${keyPart(setup).toUpperCase()}_${keyPart(regime).toUpperCase()}_${keyPart(confirmationProfile).toUpperCase()}`
  ),

  ...taxonomyFlags()
};

export const KEYS = deepFreeze({
  namespace: SHORT_NAMESPACE,
  keyPrefix: SHORT_KEY_PREFIX,
  redisNamespace: SHORT_NAMESPACE,
  redisKeyPrefix: SHORT_KEY_PREFIX,
  redisKeysSeparatedFromLongRoot: true,

  targetTradeSide: TARGET_TRADE_SIDE,
  dashboardSide: TARGET_DASHBOARD_SIDE,
  scannerSide: TARGET_SCANNER_SIDE,
  targetScannerSide: TARGET_SCANNER_SIDE,
  oppositeTradeSide: OPPOSITE_TRADE_SIDE,

  shortOnly: true,
  longDisabled: true,
  longOnly: false,
  shortDisabled: false,

  virtualOnly: true,
  virtualLearning: true,
  realOrdersDisabled: true,
  bitgetOrdersDisabled: true,
  exchangeOrdersDisabled: true,
  exchangeCallsDisabled: true,
  noRealOrders: true,
  noExchangeOrders: true,

  persistentLearningKey: PERSISTENT_LEARNING_KEY,

  trueMicroSchema: TRUE_MICRO_SCHEMA,
  parentTrueMicroSchema: PARENT_TRUE_MICRO_SCHEMA,
  childTrueMicroSchema: CHILD_TRUE_MICRO_SCHEMA,
  learningGranularity: LEARNING_GRANULARITY,
  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

  scopes: WRITE_SCOPE_NAMES,

  scan: scanKeys,
  live: liveKeys,
  trade: tradeKeys,
  analyze: analyzeKeys,
  circuit: circuitKeys,
  discord: discordKeys,
  reset: resetKeys,
  taxonomy: taxonomyKeys,

  short: {
    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,

    scan: scanKeys,
    live: liveKeys,
    trade: tradeKeys,
    analyze: analyzeKeys,
    circuit: circuitKeys,
    discord: discordKeys,
    reset: resetKeys,
    taxonomy: taxonomyKeys
  },

  patterns: {
    scan: SHORT_PATTERNS.scan,
    live: SHORT_PATTERNS.live,
    trade: SHORT_PATTERNS.trade,
    analyze: SHORT_PATTERNS.analyze,
    circuit: SHORT_PATTERNS.circuit,
    discord: SHORT_PATTERNS.discord,
    reset: SHORT_PATTERNS.reset,

    volatile: [
      SHORT_PATTERNS.scan,
      SHORT_PATTERNS.live
    ],

    durableLearning: [
      SHORT_PATTERNS.analyze
    ],

    durableTrade: [
      SHORT_PATTERNS.trade
    ],

    durableRotation: [
      ANALYZE_ACTIVE_ROTATION_KEY,
      ANALYZE_NEXT_ROTATION_KEY,
      ANALYZE_ROTATION_VALID_FROM_KEY,
      ANALYZE_MANUAL_SELECTION_LOG_KEY,
      ANALYZE_ROTATION_HISTORY_KEY
    ],

    durableDiscord: [
      SHORT_PATTERNS.discord
    ],

    all: [
      SHORT_PATTERNS.scan,
      SHORT_PATTERNS.live,
      SHORT_PATTERNS.trade,
      SHORT_PATTERNS.analyze,
      SHORT_PATTERNS.circuit,
      SHORT_PATTERNS.discord,
      SHORT_PATTERNS.reset
    ],

    nonShortDenied: [
      'SCAN:*',
      'LIVE:*',
      'TRADE:*',
      'ANALYZE:*',
      'CIRCUIT:*',
      'DISCORD:*',
      'RESET:*',
      'LONG:*',
      'LONG:*:*',
      'LONG_LIVE:*'
    ]
  },

  guards: {
    scannerWritesLearning: false,
    scannerWritesDiscord: false,
    scannerWritesTrade: false,
    scannerBucketsAreMetadataOnly: true,
    old25BucketsAreMetadataOnly: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    tradeWritesRealOrders: false,
    tradeWritesVirtualPositionsOnly: true,

    discordRequiresManualExact75ChildMatch: true,
    parentIdsAreContextOnly: true,
    scannerFingerprintsAreMetadataOnly: true,
    executionFingerprintsAreMetadataOnly: true,

    completedOnlyClosedVirtualOrShadow: true,
    scoringWritesBackToExactTrueMicroFamilyId: true,
    learningKey: PERSISTENT_LEARNING_KEY,

    longRootTouched: false
  },

  ...shortIdentityFlags()
});