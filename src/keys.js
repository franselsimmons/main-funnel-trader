// ================= FILE: src/keys.js =================
// Redis key generation & write-scope guard for SHORT-only system.
//
// Namespace: SHORT:
// - SCAN:* → scanner fingerprints
// - LIVE:* → live position tracking
// - TRADE:* → trade execution
// - ANALYZE:* → virtual outcome learning
// - CIRCUIT:* → circuit breakers
// - DISCORD:* → webhook state
// - RESET:* → reset management
//
// All keys are SHORT-namespaced. LONG: prefixes are refused.

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;

const ALLOWED_WRITE_SCOPES = {
  SCAN_PARTIAL: 'SCAN_PARTIAL',
  LIVE_PARTIAL: 'LIVE_PARTIAL',
  TRADE_PARTIAL: 'TRADE_PARTIAL',
  ANALYZE_PARTIAL: 'ANALYZE_PARTIAL',
  CIRCUIT_PARTIAL: 'CIRCUIT_PARTIAL',
  DISCORD_PARTIAL: 'DISCORD_PARTIAL',
  RESET_PARTIAL: 'RESET_PARTIAL'
};

const SCOPE_PREFIX_MAP = {
  SCAN_PARTIAL: `${SHORT_KEY_PREFIX}SCAN:`,
  LIVE_PARTIAL: `${SHORT_KEY_PREFIX}LIVE:`,
  TRADE_PARTIAL: `${SHORT_KEY_PREFIX}TRADE:`,
  ANALYZE_PARTIAL: `${SHORT_KEY_PREFIX}ANALYZE:`,
  CIRCUIT_PARTIAL: `${SHORT_KEY_PREFIX}CIRCUIT:`,
  DISCORD_PARTIAL: `${SHORT_KEY_PREFIX}DISCORD:`,
  RESET_PARTIAL: `${SHORT_KEY_PREFIX}RESET:`
};

function validateWriteScope(scopeName, key) {
  const allowedPrefix = SCOPE_PREFIX_MAP[scopeName];

  if (!allowedPrefix) {
    const error = new Error('INVALID_WRITE_SCOPE_NAME');
    error.details = {
      scopeName,
      key,
      validScopes: Object.keys(ALLOWED_WRITE_SCOPES),
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX
    };
    throw error;
  }

  if (!key.startsWith(allowedPrefix)) {
    const error = new Error('WRITE_SCOPE_VIOLATION');
    error.details = {
      scopeName,
      key,
      requiredPrefix: allowedPrefix,
      namespace: SHORT_NAMESPACE,
      keyPrefix: SHORT_KEY_PREFIX,
      longRootTouched: false
    };
    throw error;
  }

  return true;
}

export function assertKeyAllowedForWriteScope(scopeName, key) {
  const normalizedKey = String(key || '').trim();

  if (!normalizedKey) {
    throw new Error('ASSERT_KEY_EMPTY');
  }

  return validateWriteScope(scopeName, normalizedKey);
}

export const KEYS = {
  namespace: SHORT_NAMESPACE,
  keyPrefix: SHORT_KEY_PREFIX,

  scopes: ALLOWED_WRITE_SCOPES,

  scan: {
    fingerprints: (snapshotId) =>
      `${SHORT_KEY_PREFIX}SCAN:FINGERPRINTS:${snapshotId}`,

    buckets: (snapshotId) =>
      `${SHORT_KEY_PREFIX}SCAN:BUCKETS:${snapshotId}`
  },

  live: {
    positions: (symbol) =>
      `${SHORT_KEY_PREFIX}LIVE:POSITIONS:${symbol}`,

    openCount: () =>
      `${SHORT_KEY_PREFIX}LIVE:OPEN_COUNT`,

    microState: (microId) =>
      `${SHORT_KEY_PREFIX}LIVE:MICRO_STATE:${microId}`
  },

  trade: {
    execution: (tradeId) =>
      `${SHORT_KEY_PREFIX}TRADE:EXECUTION:${tradeId}`,

    history: (symbol) =>
      `${SHORT_KEY_PREFIX}TRADE:HISTORY:${symbol}`,

    active: () =>
      `${SHORT_KEY_PREFIX}TRADE:ACTIVE`,

    pending: () =>
      `${SHORT_KEY_PREFIX}TRADE:PENDING`
  },

  analyze: {
    // Last observation snapshot for deduplication
    obsLast: (snapshotId, symbol, microId) =>
      `${SHORT_KEY_PREFIX}ANALYZE:OBS_LAST:${snapshotId}:${symbol}:${microId}`,

    // Weekly aggregates for micro-families
    weekMicros: (weekKey) =>
      `${SHORT_KEY_PREFIX}ANALYZE:WEEK_MICROS:${weekKey}`,

    // Weekly aggregates for parent families
    weekParents: (weekKey) =>
      `${SHORT_KEY_PREFIX}ANALYZE:WEEK_PARENTS:${weekKey}`,

    // Persistent stats for a micro-family
    microStats: (microId) =>
      `${SHORT_KEY_PREFIX}ANALYZE:MICRO_STATS:${microId}`,

    // Persistent stats for a parent family
    parentStats: (parentId) =>
      `${SHORT_KEY_PREFIX}ANALYZE:PARENT_STATS:${parentId}`,

    // Recent closed outcomes for a micro-family
    microOutcomes: (microId) =>
      `${SHORT_KEY_PREFIX}ANALYZE:MICRO_OUTCOMES:${microId}`,

    // Outcome deduplication key
    outcomeDedup: (outcomeId) =>
      `${SHORT_KEY_PREFIX}ANALYZE:OUTCOME_DEDUP:${outcomeId}`
  },

  circuit: {
    breaker: (circuitName) =>
      `${SHORT_KEY_PREFIX}CIRCUIT:BREAKER:${circuitName}`,

    state: (circuitName) =>
      `${SHORT_KEY_PREFIX}CIRCUIT:STATE:${circuitName}`
  },

  discord: {
    webhook: (webhookId) =>
      `${SHORT_KEY_PREFIX}DISCORD:WEBHOOK:${webhookId}`,

    queue: (channelId) =>
      `${SHORT_KEY_PREFIX}DISCORD:QUEUE:${channelId}`,

    sent: (messageId) =>
      `${SHORT_KEY_PREFIX}DISCORD:SENT:${messageId}`
  },

  reset: {
    state: () =>
      `${SHORT_KEY_PREFIX}RESET:STATE`,

    timestamp: () =>
      `${SHORT_KEY_PREFIX}RESET:TIMESTAMP`,

    reason: () =>
      `${SHORT_KEY_PREFIX}RESET:REASON`
  }
};

// Backward compatibility aliases
export const keys = KEYS;

export default {
  KEYS,
  keys,
  assertKeyAllowedForWriteScope,
  validateWriteScope,
  SCOPE_PREFIX_MAP,
  ALLOWED_WRITE_SCOPES
};
