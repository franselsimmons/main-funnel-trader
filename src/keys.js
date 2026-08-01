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
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';
const TEMPORAL_CONTEXT_VERSION = 'SHORT_TEMPORAL_CONTEXT_UTC_V1';
const TEMPORAL_POLICY_VERSION = 'SHORT_TEMPORAL_FAMILY_PROFILE_V1';
const TEMPORAL_GENERATION_SCHEMA_VERSION = 'SHORT_TEMPORAL_ROOT_GENERATION_V1';
const WEEKEND_POLICY_VERSION = 'SHORT_WEEKEND_PER_FAMILY_DAY_APPROVAL_V1';
const SESSION_POLICY_VERSION = 'SHORT_DAY_SESSION_VETO_RECOVERY_V1';
const WEEKEND_MODE = 'RUNTIME_CONTROLLED';
const SESSION_MODE = 'RUNTIME_CONTROLLED';
const ALLOWED_WRITE_SCOPES = {
SCAN_PARTIAL: 'SCAN_PARTIAL',
LIVE_PARTIAL: 'LIVE_PARTIAL',
TRADE_PARTIAL: 'TRADE_PARTIAL',
ANALYZE_PARTIAL: 'ANALYZE_PARTIAL',
CIRCUIT_PARTIAL: 'CIRCUIT_PARTIAL',
DISCORD_PARTIAL: 'DISCORD_PARTIAL',
RESET_PARTIAL: 'RESET_PARTIAL',
MARKET_PARTIAL: 'MARKET_PARTIAL',
SHORT_ANALYZE_PARTIAL: 'SHORT_ANALYZE_PARTIAL',
ANALYZE_SHORT_PARTIAL: 'ANALYZE_SHORT_PARTIAL',
TRADE_RUN: 'TRADE_RUN'
};
const SCOPE_PREFIX_MAP = {
SCAN_PARTIAL: `${SHORT_KEY_PREFIX}SCAN:`,
LIVE_PARTIAL: `${SHORT_KEY_PREFIX}LIVE:`,

TRADE_PARTIAL: `${SHORT_KEY_PREFIX}TRADE:`,
ANALYZE_PARTIAL: `${SHORT_KEY_PREFIX}ANALYZE:`,
CIRCUIT_PARTIAL: `${SHORT_KEY_PREFIX}CIRCUIT:`,
DISCORD_PARTIAL: `${SHORT_KEY_PREFIX}DISCORD:`,
RESET_PARTIAL: `${SHORT_KEY_PREFIX}RESET:`,
MARKET_PARTIAL: `${SHORT_KEY_PREFIX}MARKET:`,
SHORT_ANALYZE_PARTIAL: `${SHORT_KEY_PREFIX}ANALYZE:`,
ANALYZE_SHORT_PARTIAL: `${SHORT_KEY_PREFIX}ANALYZE:`,
TRADE_RUN: `${SHORT_KEY_PREFIX}TRADE:`
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
// Compatibility and temporal-context keys used across the separate SHORT root.
Object.assign(KEYS.scan, {
lock: `${SHORT_KEY_PREFIX}SCAN:LOCK`,
shortLock: `${SHORT_KEY_PREFIX}SCAN:LOCK`,
latest: `${SHORT_KEY_PREFIX}SCAN:LATEST`,
shortLatest: `${SHORT_KEY_PREFIX}SCAN:LATEST`,
snapshot: (snapshotId) => `${SHORT_KEY_PREFIX}SCAN:SNAPSHOT:${snapshotId}`,
shortSnapshot: (snapshotId) =>

`${SHORT_KEY_PREFIX}SCAN:SNAPSHOT:${snapshotId}`,
snapshotPattern: `${SHORT_KEY_PREFIX}SCAN:SNAPSHOT:*`,
runMeta: `${SHORT_KEY_PREFIX}SCAN:RUN_META`,
universeLatest: `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
weatherLatest: `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`,
temporalContext: (snapshotId) =>
`${SHORT_KEY_PREFIX}SCAN:TEMPORAL_CONTEXT:${snapshotId}`,
shortUniverseLatest: `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
shortWeatherLatest: `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`
});
Object.assign(KEYS.trade, {
lock: `${SHORT_KEY_PREFIX}TRADE:LOCK`,
shortLock: `${SHORT_KEY_PREFIX}TRADE:LOCK`,
open: (symbol) => `${SHORT_KEY_PREFIX}TRADE:OPEN:${symbol}`,
shortOpen: (symbol) => `${SHORT_KEY_PREFIX}TRADE:OPEN:${symbol}`,
openPattern: `${SHORT_KEY_PREFIX}TRADE:OPEN:*`,
runMeta: `${SHORT_KEY_PREFIX}TRADE:RUN_META`,
shortRunMeta: `${SHORT_KEY_PREFIX}TRADE:RUN_META`,
lastProcessedSnapshot: `${SHORT_KEY_PREFIX}TRADE:LAST_PROCESSED_SNAPSHOT`,
shortLastProcessedSnapshot: `${SHORT_KEY_PREFIX}TRADE:LAST_PROCESSED_SNAPSHOT`,
snapshotProgress: `${SHORT_KEY_PREFIX}TRADE:SNAPSHOT_PROGRESS`,
shortOpenPattern: `${SHORT_KEY_PREFIX}TRADE:OPEN:*`,
shortSnapshotProgress: `${SHORT_KEY_PREFIX}TRADE:SNAPSHOT_PROGRESS`,
entryTemporalContext: (tradeId) =>
`${SHORT_KEY_PREFIX}TRADE:ENTRY_CONTEXT:${tradeId}`,
exitTemporalContext: (tradeId) =>
`${SHORT_KEY_PREFIX}TRADE:EXIT_CONTEXT:${tradeId}`
});
Object.assign(KEYS.analyze, {
freezeLock: `${SHORT_KEY_PREFIX}ANALYZE:WEEKLY_FREEZE_LOCK`,
shortFreezeLock: `${SHORT_KEY_PREFIX}ANALYZE:WEEKLY_FREEZE_LOCK`,
activateLock: `${SHORT_KEY_PREFIX}ANALYZE:ROTATION_ACTIVATE_LOCK`,
shortActivateLock: `${SHORT_KEY_PREFIX}ANALYZE:ROTATION_ACTIVATE_LOCK`,
activeTemporalGenerationId: `${SHORT_KEY_PREFIX}ANALYZE:TEMPORAL:ACTIVE_GENERATION_ID`,
shortActiveTemporalGenerationId: `${SHORT_KEY_PREFIX}ANALYZE:TEMPORAL:ACTIVE_GENERATION_ID`,
nextTemporalGenerationId: `${SHORT_KEY_PREFIX}ANALYZE:TEMPORAL:NEXT_GENERATION_ID`,
shortNextTemporalGenerationId: `${SHORT_KEY_PREFIX}ANALYZE:TEMPORAL:NEXT_GENERATION_ID`,
temporalGeneration: (generationId) =>
`${SHORT_KEY_PREFIX}ANALYZE:TEMPORAL:GENERATION:${generationId}`,
activeRotation: `${SHORT_KEY_PREFIX}ANALYZE:ACTIVE_ROTATION`,
shortActiveRotation: `${SHORT_KEY_PREFIX}ANALYZE:ACTIVE_ROTATION`,
nextRotation: `${SHORT_KEY_PREFIX}ANALYZE:NEXT_ROTATION`,
shortNextRotation: `${SHORT_KEY_PREFIX}ANALYZE:NEXT_ROTATION`,
rotationValidFrom: `${SHORT_KEY_PREFIX}ANALYZE:ROTATION_VALID_FROM`,
shortRotationValidFrom: `${SHORT_KEY_PREFIX}ANALYZE:ROTATION_VALID_FROM`,
observationDedup: (id) =>
`${SHORT_KEY_PREFIX}ANALYZE:OBSERVATION_DEDUP:${id}`,
contextStats: (microId, dayType) =>
`${SHORT_KEY_PREFIX}ANALYZE:CONTEXT_STATS:${microId}:${dayType}`,
sessionStats: (microId, sessionBucket) =>
`${SHORT_KEY_PREFIX}ANALYZE:SESSION_STATS:${microId}:${sessionBucket}`,
temporalContext: (id) => `${SHORT_KEY_PREFIX}ANALYZE:TEMPORAL_CONTEXT:${id}`
});
Object.assign(KEYS.discord, {
logList: `${SHORT_KEY_PREFIX}DISCORD:LOGS`,
shortLogList: `${SHORT_KEY_PREFIX}DISCORD:LOGS`,
cooldown: (symbol) => `${SHORT_KEY_PREFIX}DISCORD:COOLDOWN:${symbol}`,
dedupe: (id) => `${SHORT_KEY_PREFIX}DISCORD:DEDUPE:${id}`
});

Object.assign(KEYS.reset, {
logList: `${SHORT_KEY_PREFIX}RESET:LOGS`
});
KEYS.market = {
universeLatest: `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
weatherLatest: `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`,
temporalContext: (id) => `${SHORT_KEY_PREFIX}MARKET:TEMPORAL_CONTEXT:${id}`,
universe: `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
weather: `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`,
shortUniverseLatest: `${SHORT_KEY_PREFIX}MARKET:UNIVERSE:LATEST`,
shortWeatherLatest: `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`,
shortWeather: `${SHORT_KEY_PREFIX}MARKET:WEATHER:LATEST`
};
KEYS.short = {
namespace: SHORT_NAMESPACE,
keyPrefix: SHORT_KEY_PREFIX,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
weekendMode: WEEKEND_MODE,
sessionMode: SESSION_MODE,
scan: KEYS.scan,
live: KEYS.live,
trade: KEYS.trade,
analyze: KEYS.analyze,
circuit: KEYS.circuit,
discord: KEYS.discord,
reset: KEYS.reset,
market: KEYS.market
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

