// ================= FILE: src/market/marketKey.js =================
// SHORT-root market key management
//
// Verantwoordelijkheid van dit bestand:
// - alle market-gerelateerde Redis-keys onder de afzonderlijke SHORT-root houden;
// - LONG-root keys weigeren en voorkomen dat een SHORT:-prefix dubbel wordt toegevoegd;
// - compatibele key-hooks aanbieden voor UTC temporal context, dagtype- en sessiestatistieken;
// - geen scanner-, Analyze-, position-, outcome- of Discordbeleid uitvoeren.
export const TARGET_TRADE_SIDE = 'SHORT';
export const TARGET_DASHBOARD_SIDE = 'bear';
export const TARGET_SCANNER_SIDE = 'bear';
export const OPPOSITE_TRADE_SIDE = 'LONG';
export const SHORT_NAMESPACE = 'SHORT';
export const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
export const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';
export const TEMPORAL_CONTEXT_VERSION =
'SHORT_TEMPORAL_CONTEXT_UTC_V1';
export const TEMPORAL_POLICY_VERSION =
'SHORT_TEMPORAL_FAMILY_PROFILE_V1';
export const WEEKEND_POLICY_VERSION =
'SHORT_WEEKEND_PER_FAMILY_DAY_APPROVAL_V1';
export const SESSION_POLICY_VERSION =
'SHORT_DAY_SESSION_VETO_RECOVERY_V1';
export const TEMPORAL_GENERATION_SCHEMA_VERSION =
'SHORT_TEMPORAL_ROOT_GENERATION_V1';
export const WEEKEND_MODE = 'DEFER_TO_ACTIVE_GENERATION';
export const SESSION_MODE = 'DEFER_TO_ACTIVE_GENERATION';
function cleanKeyPart(value = '', fallback = '') {
const raw = String(value ?? '').trim();
if (!raw) return fallback;
const normalized = raw.toUpperCase();
if (
normalized.startsWith('LONG:') ||
normalized.includes('SHORT:LONG:') ||
normalized.includes('LONG:SHORT:')
) {
throw new Error('SHORT_MARKET_KEY_REJECTED_LONG_NAMESPACE');
}
return raw
.replace(/^SHORT:/i, '')
.replace(/^:+|:+$/g, '')
.trim() || fallback;
}
function withShortNamespace(key = '') {
const raw = cleanKeyPart(key);

if (!raw) return SHORT_NAMESPACE;
return `${SHORT_KEY_PREFIX}${raw}`;
}
export function getMarketSnapshotKey(symbol = '') {
const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
return withShortNamespace(`MARKET:SNAPSHOT:${normalizedSymbol}`);
}
export function getMarketHistoryKey(symbol = '', timeframe = '1H') {
const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
const normalizedTimeframe = cleanKeyPart(timeframe, '1H').toUpperCase();
return withShortNamespace(
`MARKET:HISTORY:${normalizedSymbol}:${normalizedTimeframe}`
);
}
export function getMarketCandlesKey(symbol = '') {
const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
return withShortNamespace(`MARKET:CANDLES:${normalizedSymbol}`);
}
export function getMarketIndicesKey(symbol = '') {
const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
return withShortNamespace(`MARKET:INDICES:${normalizedSymbol}`);
}
export function getAllMarketsKey() {
return withShortNamespace('MARKET:ALL:SYMBOLS');
}
export function getMarketAlertKey(symbol = '') {
const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
return withShortNamespace(`MARKET:ALERT:${normalizedSymbol}`);
}
// Storage hook voor de UTC-context die bij een market snapshot hoort.
// De daadwerkelijke tijdsberekening wordt uitgevoerd door scanner/Analyze/runtime.
export function getMarketTemporalContextKey(symbol = '') {
const normalizedSymbol = cleanKeyPart(symbol, 'UNKNOWN');
return withShortNamespace(`MARKET:TEMPORAL_CONTEXT:${normalizedSymbol}`);
}
// Eén algemene dagtype-aggregatie per opgegeven scope, zonder family-ID's op te splitsen.
export function getMarketContextStatsKey(scope = 'GLOBAL') {

const normalizedScope = cleanKeyPart(scope, 'GLOBAL').toUpperCase();
return withShortNamespace(`MARKET:CONTEXT_STATS:${normalizedScope}`);
}
// Eén algemene primaire-sessiebucketaggregatie per opgegeven scope.
export function getMarketSessionStatsKey(scope = 'GLOBAL') {
const normalizedScope = cleanKeyPart(scope, 'GLOBAL').toUpperCase();
return withShortNamespace(`MARKET:SESSION_STATS:${normalizedScope}`);
}
// Optionele policy-key voor admin/runtime-inspectie.
// Deze key voert zelf geen blokkade uit.
export function getMarketTemporalPolicyKey() {
return withShortNamespace('MARKET:TEMPORAL_POLICY');
}
export function getMarketKeyModeFlags() {
return {
targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
scannerSide: TARGET_SCANNER_SIDE,
oppositeTradeSide: OPPOSITE_TRADE_SIDE,
shortOnly: true,
longDisabled: true,
longOnly: false,
shortDisabled: false,
redisNamespace: SHORT_NAMESPACE,
redisKeyPrefix: SHORT_KEY_PREFIX,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
redisKeysSeparatedFromLongRoot: true,
longRootTouched: false,
preventsLongShortDoublePrefix: true,
rejectsOppositeRootNamespace: true,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
weekendMode: WEEKEND_MODE,
sessionMode: SESSION_MODE,
sessionPolicyObservedOnly: false,
temporalPolicyModeOwner: 'TRADE_SYSTEM_ACTIVE_GENERATION',
weekendLearningAllowed: true,
weekendVirtualEntryAllowed: true,
weekendDiscordEntryAllowed: true,
weekendDiscordEntryDecisionDeferred: true,
weekendExitMonitoringAllowed: true,
weekendOutcomeRecordingAllowed: true,
sessionLearningAllowed: true,
sessionVirtualEntryAllowed: true,
sessionDiscordEntryAllowed: true,
sessionDiscordEntryDecisionDeferred: true,
temporalContextCalculatedHere: false,
temporalContextStoredByRuntime: true,
temporalStatsOwnedHere: false,
temporalPolicyEvaluatedHere: false,
familyIdsRemainUnchanged: true,
temporalContextExcludedFromFamilyId: true
};
}
export default {
getMarketSnapshotKey,
getMarketHistoryKey,
getMarketCandlesKey,
getMarketIndicesKey,
getAllMarketsKey,
getMarketAlertKey,
getMarketTemporalContextKey,
getMarketContextStatsKey,
getMarketSessionStatsKey,
getMarketTemporalPolicyKey,
getMarketKeyModeFlags
};

