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

export const KEYS = deepFreeze({
  scan: {
    latest: 'SCAN:LATEST',
    lock: 'SCAN:LOCK',

    snapshot: (snapshotId) => `SCAN:SNAPSHOT:${keyPart(snapshotId)}`,
    snapshotPattern: 'SCAN:SNAPSHOT:*',

    runMeta: 'SCAN:RUN:META',
    runMetaPattern: 'SCAN:RUN:*'
  },

  live: {
    cache: (symbol, type) => `LIVE:CACHE:${symbolPart(symbol)}:${keyPart(type)}`,
    cachePattern: 'LIVE:CACHE:*'
  },

  trade: {
    lock: 'TRADE:LOCK',
    runMeta: 'TRADE:RUN:META',

    lastProcessedSnapshot: 'TRADE:LAST_PROCESSED_SNAPSHOT',

    open: (symbol) => `TRADE:OPEN:${symbolPart(symbol)}`,
    openPattern: 'TRADE:OPEN:*',

    /*
      Append-only logs. Alleen diagnostisch/admin.
      Posities zelf blijven onder TRADE:OPEN:<SYMBOL>.
    */
    eventLog: 'TRADE:EVENTS',
    entryLog: 'TRADE:ENTRIES',
    exitLog: 'TRADE:EXITS',

    pattern: 'TRADE:*'
  },

  analyze: {
    obsLast: (snapshotId, symbol, microFamilyId) => (
      `ANALYZE:OBS:LAST:${keyPart(snapshotId)}:${symbolPart(symbol)}:${keyPart(microFamilyId)}`
    ),
    obsLastPattern: 'ANALYZE:OBS:LAST:*',

    shadowLast: (symbol, microFamilyId) => (
      `ANALYZE:SHADOW:LAST:${symbolPart(symbol)}:${keyPart(microFamilyId)}`
    ),
    shadowLastPattern: 'ANALYZE:SHADOW:LAST:*',

    shadowOpen: (id) => `ANALYZE:SHADOW:OPEN:${keyPart(id)}`,
    shadowOpenPattern: 'ANALYZE:SHADOW:OPEN:*',
    shadowPattern: 'ANALYZE:SHADOW:*',

    microStats: (microFamilyId) => `ANALYZE:MICRO:${keyPart(microFamilyId)}:STATS`,
    microRegimeStats: (microFamilyId) => `ANALYZE:MICRO:${keyPart(microFamilyId)}:REGIME`,
    microPattern: 'ANALYZE:MICRO:*',

    weekMicros: (weekKey) => `ANALYZE:WEEK:${keyPart(weekKey)}:MICROS`,
    weekMeta: (weekKey) => `ANALYZE:WEEK:${keyPart(weekKey)}:META`,
    weekPattern: 'ANALYZE:WEEK:*',

    activeRotation: 'ANALYZE:ACTIVE_ROTATION',
    nextRotation: 'ANALYZE:NEXT_ROTATION',
    rotationValidFrom: 'ANALYZE:ROTATION_VALID_FROM',

    /*
      Manual-only rotation support.
      Het systeem mag dit nooit automatisch overschrijven.
    */
    manualSelectionLog: 'ANALYZE:MANUAL_SELECTION_LOG',
    rotationHistory: 'ANALYZE:ROTATION_HISTORY',

    freezeLock: 'ANALYZE:WEEKLY_FREEZE_LOCK',
    activateLock: 'ANALYZE:ROTATION_ACTIVATE_LOCK',

    pattern: 'ANALYZE:*'
  },

  circuit: {
    paused: (microFamilyId) => `CIRCUIT:PAUSED:${keyPart(microFamilyId)}`,
    pausedPattern: 'CIRCUIT:PAUSED:*'
  },

  discord: {
    logList: 'DISCORD:LOGS',
    pattern: 'DISCORD:*'
  },

  reset: {
    logList: 'RESET:LOGS'
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