// ================= FILE: src/keys.js =================

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

const WRITE_SCOPE_NAMES = {
  SCANNER_RUN: 'SCANNER_RUN',
  TRADE_RUN: 'TRADE_RUN',
  ANALYZE_PARTIAL: 'ANALYZE_PARTIAL',
  ADMIN_READONLY: 'ADMIN_READONLY',
  MANUAL_ROTATION: 'MANUAL_ROTATION',
  FACTORY_RESET: 'FACTORY_RESET'
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
  denied
});

const SCAN_LATEST_KEY = 'SCAN:LATEST';
const SCAN_LOCK_KEY = 'SCAN:LOCK';
const SCAN_RUN_META_KEY = 'SCAN:RUN:META';
const SCAN_SNAPSHOT_PREFIX = 'SCAN:SNAPSHOT:';

const TRADE_LOCK_KEY = 'TRADE:LOCK';
const TRADE_RUN_META_KEY = 'TRADE:RUN:META';
const TRADE_LAST_PROCESSED_SNAPSHOT_KEY = 'TRADE:LAST_PROCESSED_SNAPSHOT';
const TRADE_OPEN_PREFIX = 'TRADE:OPEN:';
const TRADE_EVENT_LOG_KEY = 'TRADE:EVENTS';
const TRADE_ENTRY_LOG_KEY = 'TRADE:ENTRIES';
const TRADE_EXIT_LOG_KEY = 'TRADE:EXITS';

const ANALYZE_OBS_LAST_PREFIX = 'ANALYZE:OBS:LAST:';
const ANALYZE_WEEK_PREFIX = 'ANALYZE:WEEK:';
const ANALYZE_SHADOW_PREFIX = 'ANALYZE:SHADOW:';
const ANALYZE_MICRO_PREFIX = 'ANALYZE:MICRO:';

const ANALYZE_ACTIVE_ROTATION_KEY = 'ANALYZE:ACTIVE_ROTATION';
const ANALYZE_NEXT_ROTATION_KEY = 'ANALYZE:NEXT_ROTATION';
const ANALYZE_ROTATION_VALID_FROM_KEY = 'ANALYZE:ROTATION_VALID_FROM';
const ANALYZE_MANUAL_SELECTION_LOG_KEY = 'ANALYZE:MANUAL_SELECTION_LOG';
const ANALYZE_ROTATION_HISTORY_KEY = 'ANALYZE:ROTATION_HISTORY';
const ANALYZE_FREEZE_LOCK_KEY = 'ANALYZE:WEEKLY_FREEZE_LOCK';
const ANALYZE_ACTIVATE_LOCK_KEY = 'ANALYZE:ROTATION_ACTIVATE_LOCK';

const DISCORD_LOGS_KEY = 'DISCORD:LOGS';
const RESET_LOGS_KEY = 'RESET:LOGS';

export const WRITE_SCOPES = deepFreeze({
  names: WRITE_SCOPE_NAMES,

  scannerRun: buildKeyScope({
    name: WRITE_SCOPE_NAMES.SCANNER_RUN,
    description: 'Scanner run mag uitsluitend scanner snapshot/latest/meta schrijven.',
    allowed: [
      exact(SCAN_LATEST_KEY),
      exact(SCAN_RUN_META_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX)
    ],
    denied: [
      pattern('TRADE:*'),
      pattern('ANALYZE:*'),
      pattern('CIRCUIT:*'),
      pattern('DISCORD:*'),
      pattern('RESET:*'),
      pattern('LIVE:*')
    ]
  }),

  tradeRun: buildKeyScope({
    name: WRITE_SCOPE_NAMES.TRADE_RUN,
    description: 'Trade run mag trade state schrijven en Analyze alleen via partial learning updates.',
    allowed: [
      exact(TRADE_RUN_META_KEY),
      exact(TRADE_LAST_PROCESSED_SNAPSHOT_KEY),
      prefix(TRADE_OPEN_PREFIX),
      exact(TRADE_EVENT_LOG_KEY),
      exact(TRADE_ENTRY_LOG_KEY),
      exact(TRADE_EXIT_LOG_KEY),

      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX)
    ],
    denied: [
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

      pattern('DISCORD:*'),
      pattern('RESET:*')
    ]
  }),

  analyzePartial: buildKeyScope({
    name: WRITE_SCOPE_NAMES.ANALYZE_PARTIAL,
    description: 'Analyze mag observations/outcomes cumulatief bijwerken, maar geen rotation/manual selectie overschrijven.',
    allowed: [
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX)
    ],
    denied: [
      exact(SCAN_LATEST_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX),
      pattern('TRADE:*'),

      exact(ANALYZE_ACTIVE_ROTATION_KEY),
      exact(ANALYZE_NEXT_ROTATION_KEY),
      exact(ANALYZE_ROTATION_VALID_FROM_KEY),
      exact(ANALYZE_MANUAL_SELECTION_LOG_KEY),
      exact(ANALYZE_ROTATION_HISTORY_KEY),
      exact(ANALYZE_FREEZE_LOCK_KEY),
      exact(ANALYZE_ACTIVATE_LOCK_KEY),

      pattern('DISCORD:*'),
      pattern('RESET:*')
    ]
  }),

  adminReadonly: buildKeyScope({
    name: WRITE_SCOPE_NAMES.ADMIN_READONLY,
    description: 'Admin GET/API read-only endpoints mogen niets schrijven.',
    readonly: true,
    allowed: [],
    denied: [
      pattern('SCAN:*'),
      pattern('LIVE:*'),
      pattern('TRADE:*'),
      pattern('ANALYZE:*'),
      pattern('CIRCUIT:*'),
      pattern('DISCORD:*'),
      pattern('RESET:*')
    ]
  }),

  manualRotation: buildKeyScope({
    name: WRITE_SCOPE_NAMES.MANUAL_ROTATION,
    description: 'Alleen expliciete admin manual selection mag rotation/Discord selectie aanpassen.',
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
      exact(SCAN_LATEST_KEY),
      prefix(SCAN_SNAPSHOT_PREFIX),
      pattern('TRADE:*'),
      prefix(ANALYZE_WEEK_PREFIX),
      prefix(ANALYZE_OBS_LAST_PREFIX),
      prefix(ANALYZE_MICRO_PREFIX),
      prefix(ANALYZE_SHADOW_PREFIX),
      pattern('RESET:*')
    ]
  }),

  factoryReset: buildKeyScope({
    name: WRITE_SCOPE_NAMES.FACTORY_RESET,
    description: 'Alleen reset endpoints met expliciete bevestiging mogen breed verwijderen/schrijven.',
    allowed: [
      pattern('SCAN:*'),
      pattern('LIVE:*'),
      pattern('TRADE:*'),
      pattern('ANALYZE:*'),
      pattern('CIRCUIT:*'),
      pattern('DISCORD:*'),
      pattern('RESET:*')
    ],
    denied: []
  })
});

export function isKeyAllowedForWriteScope(scopeName, key) {
  const scope = Object.values(WRITE_SCOPES)
    .find((entry) => entry && typeof entry === 'object' && entry.name === scopeName);

  if (!scope) return false;
  if (scope.readonly) return false;

  const denied = Array.isArray(scope.denied)
    ? scope.denied.some((rule) => ruleMatches(rule, key))
    : false;

  if (denied) return false;

  return Array.isArray(scope.allowed)
    ? scope.allowed.some((rule) => ruleMatches(rule, key))
    : false;
}

export function assertKeyAllowedForWriteScope(scopeName, key) {
  if (isKeyAllowedForWriteScope(scopeName, key)) {
    return true;
  }

  const error = new Error('WRITE_SCOPE_VIOLATION');

  error.details = {
    scopeName,
    key: normalizeKey(key)
  };

  throw error;
}

export const KEYS = deepFreeze({
  scopes: WRITE_SCOPE_NAMES,

  scan: {
    latest: SCAN_LATEST_KEY,
    lock: SCAN_LOCK_KEY,

    snapshot: (snapshotId) => `${SCAN_SNAPSHOT_PREFIX}${keyPart(snapshotId)}`,
    snapshotPattern: `${SCAN_SNAPSHOT_PREFIX}*`,

    runMeta: SCAN_RUN_META_KEY,
    runMetaPattern: 'SCAN:RUN:*'
  },

  live: {
    cache: (symbol, type) => `LIVE:CACHE:${symbolPart(symbol)}:${keyPart(type)}`,
    cachePattern: 'LIVE:CACHE:*'
  },

  trade: {
    lock: TRADE_LOCK_KEY,
    runMeta: TRADE_RUN_META_KEY,

    lastProcessedSnapshot: TRADE_LAST_PROCESSED_SNAPSHOT_KEY,

    open: (symbol) => `${TRADE_OPEN_PREFIX}${symbolPart(symbol)}`,
    openPattern: `${TRADE_OPEN_PREFIX}*`,

    /*
      Append-only logs. Alleen diagnostisch/admin.
      Posities zelf blijven onder TRADE:OPEN:<SYMBOL>.
    */
    eventLog: TRADE_EVENT_LOG_KEY,
    entryLog: TRADE_ENTRY_LOG_KEY,
    exitLog: TRADE_EXIT_LOG_KEY,

    pattern: 'TRADE:*'
  },

  analyze: {
    obsLast: (snapshotId, symbol, microFamilyId) => (
      `${ANALYZE_OBS_LAST_PREFIX}${keyPart(snapshotId)}:${symbolPart(symbol)}:${keyPart(microFamilyId)}`
    ),
    obsLastPattern: `${ANALYZE_OBS_LAST_PREFIX}*`,

    shadowLast: (symbol, microFamilyId) => (
      `ANALYZE:SHADOW:LAST:${symbolPart(symbol)}:${keyPart(microFamilyId)}`
    ),
    shadowLastPattern: 'ANALYZE:SHADOW:LAST:*',

    shadowOpen: (id) => `ANALYZE:SHADOW:OPEN:${keyPart(id)}`,
    shadowOpenPattern: 'ANALYZE:SHADOW:OPEN:*',
    shadowPattern: 'ANALYZE:SHADOW:*',

    microStats: (microFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(microFamilyId)}:STATS`,
    microRegimeStats: (microFamilyId) => `${ANALYZE_MICRO_PREFIX}${keyPart(microFamilyId)}:REGIME`,
    microPattern: `${ANALYZE_MICRO_PREFIX}*`,

    weekMicros: (weekKey) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:MICROS`,
    weekMeta: (weekKey) => `${ANALYZE_WEEK_PREFIX}${keyPart(weekKey)}:META`,
    weekPattern: `${ANALYZE_WEEK_PREFIX}*`,

    activeRotation: ANALYZE_ACTIVE_ROTATION_KEY,
    nextRotation: ANALYZE_NEXT_ROTATION_KEY,
    rotationValidFrom: ANALYZE_ROTATION_VALID_FROM_KEY,

    /*
      Manual-only rotation support.
      Het systeem mag dit nooit automatisch overschrijven.
    */
    manualSelectionLog: ANALYZE_MANUAL_SELECTION_LOG_KEY,
    rotationHistory: ANALYZE_ROTATION_HISTORY_KEY,

    freezeLock: ANALYZE_FREEZE_LOCK_KEY,
    activateLock: ANALYZE_ACTIVATE_LOCK_KEY,

    pattern: 'ANALYZE:*'
  },

  circuit: {
    paused: (microFamilyId) => `CIRCUIT:PAUSED:${keyPart(microFamilyId)}`,
    pausedPattern: 'CIRCUIT:PAUSED:*'
  },

  discord: {
    logList: DISCORD_LOGS_KEY,
    pattern: 'DISCORD:*'
  },

  reset: {
    logList: RESET_LOGS_KEY
  },

  /*
    Centrale patterns voor factory reset/admin cleanup.
    Gebruik selectief; niet blind verwijderen in normale runs.
  */
  patterns: {
    scan: 'SCAN:*',
    live: 'LIVE:*',
    trade: 'TRADE:*',
    analyze: 'ANALYZE:*',
    circuit: 'CIRCUIT:*',
    discord: 'DISCORD:*',
    reset: 'RESET:*',

    volatile: [
      'SCAN:*',
      'LIVE:*'
    ],

    durableLearning: [
      'ANALYZE:*'
    ],

    durableTrade: [
      'TRADE:*'
    ],

    all: [
      'SCAN:*',
      'LIVE:*',
      'TRADE:*',
      'ANALYZE:*',
      'CIRCUIT:*',
      'DISCORD:*',
      'RESET:*'
    ]
  }
});