// ================= FILE: src/keys.js =================

export const KEYS = Object.freeze({
  scan: {
    latest: 'SCAN:LATEST',
    snapshot: snapshotId => `SCAN:SNAPSHOT:${snapshotId}`,
    lock: 'SCAN:LOCK'
  },

  live: {
    cache: (symbol, type) => `LIVE:CACHE:${symbol}:${type}`
  },

  trade: {
    lock: 'TRADE:LOCK',
    lastProcessedSnapshot: 'TRADE:LAST_PROCESSED_SNAPSHOT',
    open: symbol => `TRADE:OPEN:${symbol}`,
    openPattern: 'TRADE:OPEN:*',
    runMeta: 'TRADE:RUN:META'
  },

  analyze: {
    obsLast: (snapshotId, symbol, microFamilyId) => `ANALYZE:OBS:LAST:${snapshotId}:${symbol}:${microFamilyId}`,
    shadowLast: (symbol, microFamilyId) => `ANALYZE:SHADOW:LAST:${symbol}:${microFamilyId}`,
    shadowOpen: id => `ANALYZE:SHADOW:OPEN:${id}`,
    shadowOpenPattern: 'ANALYZE:SHADOW:OPEN:*',
    weekMicros: weekKey => `ANALYZE:WEEK:${weekKey}:MICROS`,
    weekMeta: weekKey => `ANALYZE:WEEK:${weekKey}:META`,
    activeRotation: 'ANALYZE:ACTIVE_ROTATION',
    nextRotation: 'ANALYZE:NEXT_ROTATION',
    rotationValidFrom: 'ANALYZE:ROTATION_VALID_FROM',
    freezeLock: 'ANALYZE:WEEKLY_FREEZE_LOCK',
    activateLock: 'ANALYZE:ROTATION_ACTIVATE_LOCK'
  },

  discord: {
    logList: 'DISCORD:LOGS'
  },

  reset: {
    logList: 'RESET:LOGS'
  }
});
