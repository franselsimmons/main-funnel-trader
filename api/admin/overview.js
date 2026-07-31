// ================= FILE: api/admin/overview.js =================

import { KEYS } from '../../src/keys.js';
import {
getDurableRedis,
getVolatileRedis,
getJson,
readJsonLogs
} from '../../src/redis.js';
import {
safeNumber,
sideToTradeSide
} from '../../src/utils.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getRotationDashboard } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';
const TEMPORAL_CONTEXT_VERSION =
'SHORT_TEMPORAL_CONTEXT_UTC_V2';
const WEEKEND_POLICY_VERSION =
'SHORT_WEEKEND_POSITIVE_OVERRIDE_V2';
const SESSION_POLICY_VERSION =
'SHORT_SESSION_NEGATIVE_VETO_V2';
const WEEKEND_MODE = 'POSITIVE_OVERRIDE';
const SESSION_MODE = 'NEGATIVE_VETO';

const TEMPORAL_STATS_VERSION = 'SHORT_TEMPORAL_FAMILY_STATS_V1';
const TEMPORAL_POLICY_VERSION = 'SHORT_TEMPORAL_NEGATIVE_VETO_WEEKLY_GENERATION_V1';
const TEMPORAL_AGGREGATION_VERSION = 'SHORT_TEMPORAL_CANONICAL_OUTCOME_V1';
const TEMPORAL_GENERATION_VERSION = 'SHORT_TEMPORAL_ROOT_GENERATION_V1';
const TEMPORAL_POLICY_MODES = Object.freeze(['OFF', 'OBSERVE', 'ENFORCE']);
const TEMPORAL_GENERATION_STATES = Object.freeze([
  'BUILDING',
  'INTEGRITY_CHECK_RUNNING',
  'READY',
  'ACTIVE',
  'SUPERSEDED',
  'INVALID',
  'EXPIRED',
  'ACTIVATION_WINDOW_EXPIRED'
]);
const TEMPORAL_ACTIVE_DECISIONS = Object.freeze([
  'INHERIT_GLOBAL',
  'NO_VETO',
  'VETO_ACTIVE',
  'CONFOUNDED_NO_VETO'
]);
const TEMPORAL_CANDIDATE_DECISIONS = Object.freeze([
  'VETO_CANDIDATE',
  'RECOVERY_CANDIDATE',
  'CONFOUNDED_CANDIDATE',
  'WEEKEND_APPROVAL_CANDIDATE'
]);
const TEMPORAL_DAY_TYPES = Object.freeze(['WEEKDAY', 'WEEKEND']);
const TEMPORAL_GATE_WINDOW_MAX_OUTCOMES = 50;
const TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS = 180;
const TEMPORAL_VETO_MIN_COMPLETED = 35;
const TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED = 50;
const TEMPORAL_GENERATION_MAX_AGE_DAYS = 14;
const TEMPORAL_VETO_STALE_DAYS = 60;
const TEMPORAL_WEEKEND_FRESHNESS_DAYS = 45;

const DAY_NAMES_UTC = Object.freeze([
'SUNDAY',
'MONDAY',
'TUESDAY',

'WEDNESDAY',
'THURSDAY',
'FRIDAY',
'SATURDAY'
]);
const PRIMARY_SESSION_BUCKETS = Object.freeze([
'ASIA',
'EUROPE',
'US',
'ASIA_EU_OVERLAP',
'EU_US_OVERLAP',
'OFF_HOURS'
]);

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY';
const LEARNING_GRANULARITY =
'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const EMPIRICAL_VETO_MIN_COMPLETED = 35;
const EMPIRICAL_VETO_MAX_AVG_R = 0;
const MEASUREMENT_FIX_VERSION =
'SHORT_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION =
'SHORT_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const EMPIRICAL_VETO_POLICY_VERSION =
'SHORT_EXACT_75_CHILD_NET_EDGE_VETO_V1';
const OUTCOME_MEASUREMENT_GATE_MODE = 'STRICT_EXACT_VERSION';

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

function now() {
return Date.now();
}
function normalizeTemporalTimestamp(value, fallback = Date.now()) {
const n = Number(value);
if (!Number.isFinite(n) || n <= 0) {

return Number.isFinite(Number(fallback))
? Number(fallback)
: Date.now();
}
return n < 10_000_000_000
? Math.floor(n * 1000)
: Math.floor(n);
}
function buildTemporalContext(value = Date.now()) {
const contextTs = normalizeTemporalTimestamp(value, Date.now());
const date = new Date(contextTs);
const hourUtc = date.getUTCHours();
const dayIndexUtc = date.getUTCDay();
const dayOfWeekUtc = DAY_NAMES_UTC[dayIndexUtc] || 'UNKNOWN';
const isWeekend = dayIndexUtc === 0 || dayIndexUtc === 6;
const asiaActive = hourUtc >= 0 && hourUtc < 8;
const europeActive = hourUtc >= 7 && hourUtc < 16;
const usActive = hourUtc >= 13 && hourUtc < 22;
const sessionTags = [];
if (asiaActive) sessionTags.push('ASIA');
if (europeActive) sessionTags.push('EUROPE');
if (usActive) sessionTags.push('US');
let primarySessionBucket = 'OFF_HOURS';
if (europeActive && usActive) {
primarySessionBucket = 'EU_US_OVERLAP';
} else if (asiaActive && europeActive) {
primarySessionBucket = 'ASIA_EU_OVERLAP';
} else if (asiaActive) {
primarySessionBucket = 'ASIA';
} else if (europeActive) {
primarySessionBucket = 'EUROPE';
} else if (usActive) {
primarySessionBucket = 'US';
}
return {
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
contextTs,
hourUtc,
dayOfWeekUtc,
dayType: isWeekend ? 'WEEKEND' : 'WEEKDAY',

isWeekend,
sessionTags,
primarySessionBucket,
sessionOverlap: sessionTags.length > 1,
offHours: primarySessionBucket === 'OFF_HOURS'
};
}
function resolveRecordTemporalContext(record = {}, fallbackTs = Date.now()) {
const source = record && typeof record === 'object'
? record
: {};
const rawTs =
source.contextTs ??
source.entryTs ??
source.createdAt ??
source.completedAt ??
source.ts ??
source.scannerTs ??
source.updatedAt ??
fallbackTs;
const computed = buildTemporalContext(rawTs);
const explicitBucket = String(
source.primarySessionBucket ||
source.sessionBucket ||
''
).trim().toUpperCase();
const explicitTags = Array.isArray(source.sessionTags)
? source.sessionTags
.map((value) => String(value || '').trim().toUpperCase())
.filter((value) => ['ASIA', 'EUROPE', 'US'].includes(value))
: computed.sessionTags;
const primarySessionBucket = PRIMARY_SESSION_BUCKETS.includes(explicitBucket)
? explicitBucket
: computed.primarySessionBucket;
const isWeekend = typeof source.isWeekend === 'boolean'
? source.isWeekend
: computed.isWeekend;
return {
temporalContextVersion:
source.temporalContextVersion ||

TEMPORAL_CONTEXT_VERSION,
contextTs: normalizeTemporalTimestamp(
source.contextTs ?? rawTs,
computed.contextTs
),
hourUtc: Number.isFinite(Number(source.hourUtc))
? Number(source.hourUtc)
: computed.hourUtc,
dayOfWeekUtc:
source.dayOfWeekUtc ||
computed.dayOfWeekUtc,
dayType:
source.dayType ||
(isWeekend ? 'WEEKEND' : 'WEEKDAY'),
isWeekend,
sessionTags: explicitTags,
primarySessionBucket,
sessionOverlap: typeof source.sessionOverlap === 'boolean'
? source.sessionOverlap
: explicitTags.length > 1,
offHours: typeof source.offHours === 'boolean'
? source.offHours
: primarySessionBucket === 'OFF_HOURS'
};
}
function buildEntryExitTemporalMetadata(record = {}) {
const source = record && typeof record === 'object'
? record
: {};
const entryTsRaw =
source.entryTs ??
source.openedAt ??
source.openTs ??
source.positionOpenedAt ??
source.createdAt ??
null;
const exitTsRaw =
source.exitTs ??
source.closedAt ??
source.closeTs ??
source.positionClosedAt ??
null;
const output = {};

if (entryTsRaw !== null && entryTsRaw !== undefined && entryTsRaw !== '') {
const entry = buildTemporalContext(entryTsRaw);
output.entryTs = normalizeTemporalTimestamp(entryTsRaw, entry.contextTs);
output.entryHourUtc = Number.isFinite(Number(source.entryHourUtc))
? Number(source.entryHourUtc)
: entry.hourUtc;
output.entryDayOfWeekUtc =
source.entryDayOfWeekUtc ||
entry.dayOfWeekUtc;
output.entryDayType =
source.entryDayType ||
entry.dayType;
output.entryIsWeekend = typeof source.entryIsWeekend === 'boolean'
? source.entryIsWeekend
: entry.isWeekend;
output.entrySessionTags = Array.isArray(source.entrySessionTags)
? source.entrySessionTags
: entry.sessionTags;
output.entrySessionBucket =
source.entrySessionBucket ||
entry.primarySessionBucket;
output.entrySessionOverlap =
typeof source.entrySessionOverlap === 'boolean'
? source.entrySessionOverlap
: entry.sessionOverlap;
output.entryOffHours = typeof source.entryOffHours === 'boolean'
? source.entryOffHours
: entry.offHours;
}
if (exitTsRaw !== null && exitTsRaw !== undefined && exitTsRaw !== '') {
const exit = buildTemporalContext(exitTsRaw);
output.exitTs = normalizeTemporalTimestamp(exitTsRaw, exit.contextTs);
output.exitHourUtc = Number.isFinite(Number(source.exitHourUtc))
? Number(source.exitHourUtc)
: exit.hourUtc;
output.exitDayOfWeekUtc =
source.exitDayOfWeekUtc ||
exit.dayOfWeekUtc;
output.exitDayType =
source.exitDayType ||
exit.dayType;
output.exitIsWeekend = typeof source.exitIsWeekend === 'boolean'
? source.exitIsWeekend

: exit.isWeekend;
output.exitSessionTags = Array.isArray(source.exitSessionTags)
? source.exitSessionTags
: exit.sessionTags;
output.exitSessionBucket =
source.exitSessionBucket ||
exit.primarySessionBucket;
output.exitSessionOverlap =
typeof source.exitSessionOverlap === 'boolean'
? source.exitSessionOverlap
: exit.sessionOverlap;
output.exitOffHours = typeof source.exitOffHours === 'boolean'
? source.exitOffHours
: exit.offHours;
}
return output;
}
function temporalPolicyFlags(context = buildTemporalContext()) {
const resolved = context && typeof context === 'object'
? context
: buildTemporalContext();
return {
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
weekendMode: WEEKEND_MODE,
sessionMode: SESSION_MODE,
weekendLearningAllowed: true,
weekendVirtualEntryAllowed: true,
weekendDiscordEntryAllowed: resolved.isWeekend !== true,
weekendDiscordEntryBlocked: resolved.isWeekend === true,
weekendExitMonitoringAllowed: true,
weekendOutcomeRecordingAllowed: true,
sessionLearningAllowed: true,
sessionVirtualEntryAllowed: true,
sessionDiscordEntryAllowed: true,
sessionPolicyObservedOnly: true,
temporalContextDoesNotSplitMicroFamily: true,
dayTypeExcludedFromFamilyId: true,
sessionExcludedFromFamilyId: true,
primarySessionBucketCountedOnce: true,

sessionTagsMetadataOnly: true,
familyGateStillRequired: true,
currentFitCannotOverrideFamilyGate: true
};
}
function emptyTemporalStats() {
const emptyBucket = () => ({
seen: 0,
observations: 0,
completed: 0,
wins: 0,
losses: 0,
flats: 0,
totalR: 0,
avgR: 0,
grossWinR: 0,
grossLossR: 0,
profitFactor: 0,
directSLCount: 0,
directSLPct: 0,
totalCostR: 0,
avgCostR: 0
});
return {
contextStats: {
WEEKDAY: emptyBucket(),
WEEKEND: emptyBucket()
},
sessionStats: {
ASIA: emptyBucket(),
EUROPE: emptyBucket(),
US: emptyBucket(),
ASIA_EU_OVERLAP: emptyBucket(),
EU_US_OVERLAP: emptyBucket(),
OFF_HOURS: emptyBucket()
}
};
}
function temporalStatsFields(record = {}) {
const defaults = emptyTemporalStats();
const source = record && typeof record === 'object'
? record
: {};

return {
         temporalAdmin: buildTemporalAdminEnvelope(source),
contextStats:
source.contextStats &&
typeof source.contextStats === 'object' &&
!Array.isArray(source.contextStats)
? source.contextStats
: defaults.contextStats,
sessionStats:
source.sessionStats &&
typeof source.sessionStats === 'object' &&
!Array.isArray(source.sessionStats)
? source.sessionStats
: defaults.sessionStats
};
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

function namespacedShortKey(key, fallback = null) {
let raw = String(callMaybeKey(key, fallback) || '').trim();

if (!raw) return null;
if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
if (raw.startsWith('LONG:')) raw = raw.slice('LONG:'.length);

return `${SHORT_KEY_PREFIX}${raw}`;
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
runMeta: namespacedShortKey(
KEYS.short?.trade?.runMeta ||
KEYS.trade?.shortRunMeta ||
KEYS.trade?.runMeta,
'TRADE:RUN_META'
)
},

discord: {
logList: namespacedShortKey(
KEYS.short?.discord?.logList ||
KEYS.discord?.shortLogList ||
KEYS.discordShort?.logList ||
KEYS.discord?.logList,
'DISCORD:LOGS'
)
}
};

function methodNotAllowed(res) {
res.setHeader('Allow', 'GET');

return res.status(405).json({
ok: false,
error: 'METHOD_NOT_ALLOWED',
allowed: ['GET'],
...modeFlags()
});
}

function modeFlags() {
return {
         temporalAdmin: buildTemporalAdminEnvelope(),
...temporalPolicyFlags(),

persistentLearningKey: PERSISTENT_LEARNING_KEY,
weekResetDisabled: true,
isoWeekLearningDisabled: true,

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

virtualOnly: true,
virtualLearning: true,
virtualLearningForced: true,
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
noRealOrders: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,

exchangeOrdersDisabled: true,
exchangeCallsDisabled: true,

globalMaxOpenPositionsBlockDisabled: true,
maxOneOpenPositionPerSymbol: true,
oneOpenPositionPerSymbol: true,

tradePositionTimeStopMinDefault: 720,
shortRiskShape: 'tp < entry < sl',
riskTradeSide: TARGET_TRADE_SIDE,
riskGeometryRule: 'SHORT: tp < entry < sl',
tpRule: 'price <= tp',
slRule: 'price >= sl',
tpHitRule: 'SHORT: price <= tp',
slHitRule: 'SHORT: price >= sl',
grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
timeStopEnabled: true,

currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
currentFitBlocksVirtualLearning: false,
currentFitBlocksShadowLearning: false,

scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
scannerBucketsDebugMetadataOnly: true,
legacy25BucketsDebugMetadataOnly: true,

executionFingerprintRole: 'METADATA_ONLY',
executionFingerprintsMetadataOnly: true,
executionFingerprintsUsedAsLearningFamily: false,

analyzeMicroFamiliesOnly: true,
learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
symbolExcludedFromFamilyId: true,
coinNameExcludedFromLearningIdentity: true,
hashesExcludedFromLearningIdentity: true,

trueMicroOnly: true,
exactTrueMicroOnly: true,
exactTrueMicroFamilyRequired: true,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
broadTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
fixedTaxonomyPreferred: true,
learningGranularity: LEARNING_GRANULARITY,

parentMicroFamilyCount: 15,
selectableChildMicroFamilyCount: 75,
parentFamilyRule: 'MICRO_SHORT_{SETUP}_{REGIME}',
selectableFamilyRule:
'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
selectableIdsAreChildrenOnly: true,
parentIdsAreMetadataOnly: true,

manualSelectionOnly: true,
manualSelectionRequired: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
discordSelectionRule: 'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY',
autoRotationActivationDisabled: true,
activateFreezeCronDisabled: true,
resetCronDisabled: true,
discordOnlyForSelectedMicroFamilies: true,
discordOnlyForExactTrueMicroMatch: true,
parentMatchDoesNotTriggerDiscord: true,
macroMatchDoesNotTriggerDiscord: true,

measurementFixVersion: MEASUREMENT_FIX_VERSION,
acceptedOutcomeMeasurementVersion: MEASUREMENT_FIX_VERSION,
outcomeMeasurementGateMode: OUTCOME_MEASUREMENT_GATE_MODE,
completedCurrentMeasurementOnly: true,
legacyOutcomeMeasurementsExcluded: true,
exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
empiricalVetoEnabled: true,
empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
empiricalVetoMinCompleted: EMPIRICAL_VETO_MIN_COMPLETED,
empiricalVetoMaxAvgR: EMPIRICAL_VETO_MAX_AVG_R,
statusRules: {
OBSERVING: 'completed == 0',
EARLY_OUTCOMES:
`completed >= 1 && completed < ${MIN_COMPLETED_ACTIVE_LEARNING}`,

ACTIVE_LEARNING:
`completed >= ${MIN_COMPLETED_ACTIVE_LEARNING} && completed <
${EMPIRICAL_VETO_MIN_COMPLETED}`,
PASSED:
`completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
EMPIRICAL_VETO:
`completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
},
activationGateRules: {
PASSED:
`completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR >
${EMPIRICAL_VETO_MAX_AVG_R}`,
EMPIRICAL_VETO:
`completed >= ${EMPIRICAL_VETO_MIN_COMPLETED} && avgR <=
${EMPIRICAL_VETO_MAX_AVG_R}`
},
redisNamespace: SHORT_NAMESPACE,
redisKeyPrefix: SHORT_KEY_PREFIX,
redisKeysSeparatedFromLongRoot: true,
longRootTouched: false,

minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING
};
}

function asArray(value) {
if (Array.isArray(value)) return value;
if (value && typeof value === 'object') return Object.values(value);

return [];
}

function safeObject(value) {
return value && typeof value === 'object' && !Array.isArray(value)
? value
: {};
}
function sourceEntries(value = {}) {
if (Array.isArray(value)) {
return value.map((row, index) => [

row?.trueMicroFamilyId ||
row?.learningMicroFamilyId ||
row?.analyzeMicroFamilyId ||
row?.microFamilyId ||
row?.id ||
row?.key ||
String(index),
row
]);
}

if (value && typeof value === 'object') {
return Object.entries(value);
}

return [];
}

function uniqueStrings(values = []) {
return [...new Set(
(Array.isArray(values) ? values : [])
.flatMap((value) => Array.isArray(value) ? value : [value])
.map((value) => String(value || '').trim())
.filter(Boolean)
)];
}

function upper(value) {
return String(value || '').trim().toUpperCase();
}

function hasValue(value) {
return value !== undefined && value !== null && value !== '';
}
function rowMeasurementFixVersion(row = {}) {
return upper(
row.measurementFixVersion ??
row.outcomeMeasurementVersion ??
row.positionMeasurementFixVersion ??
row.measurementVersion ??
row.exitMeasurementVersion ??

''
);
}
function isCurrentMeasurementOutcome(row = {}) {
return rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION;
}
function currentMeasurementAggregateAllowed(row = {}) {
const completed = Math.max(
num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0),
num(row.completed, 0),
num(row.outcomeSample, 0),
0
);
const acceptedOutcomeCount = Math.max(
num(row.measurementVersionAcceptedOutcomeCount, 0),
0
);
return (
rowMeasurementFixVersion(row) === MEASUREMENT_FIX_VERSION &&
(completed <= 0 || acceptedOutcomeCount <= 0 || acceptedOutcomeCount >=
completed)
);
}

function num(value, fallback = 0) {
const n = safeNumber(value, fallback);

return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
return Number(num(value, 0).toFixed(decimals));
}
function flattenValues(values = []) {
const stack = Array.isArray(values) ? [...values] : [values];
const output = [];

while (stack.length > 0) {
const value = stack.shift();

if (Array.isArray(value)) {
stack.unshift(...value);
continue;
}

output.push(value);
}

return output;
}

function firstFiniteNumber(values = []) {
for (const value of flattenValues(values)) {
if (value === undefined || value === null || value === '') continue;

const n = Number(value);

if (Number.isFinite(n)) return n;
}

return null;
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
.replaceAll('BLOCK_SHORT_FALSE', '')
.replaceAll('SHORT_ENABLED_FALSE', '')
.replaceAll('SHORT_ONLY_FALSE', '')
.replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
.replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
.replaceAll('BLOCK_LONG', 'SHORT')

.replaceAll('LONG_DISABLED', 'SHORT')
.replaceAll('LONGDISABLED', 'SHORT')
.replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
.replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
.replaceAll('BLOCK_SHORT', 'LONG')
.replaceAll('SHORT_DISABLED', 'LONG')
.replaceAll('SHORTDISABLED', 'LONG')
.replaceAll('LONG_ONLY_MODE', 'LONG')
.replaceAll('LONG_ONLY', 'LONG')
.replaceAll('SHORT-ONLY', 'SHORT')
.replaceAll('SHORT_ONLY_MODE', 'SHORT')
.replaceAll('SHORT_ONLY', 'SHORT')
.replaceAll('LONG-ONLY', 'LONG');
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

function hasLongSignal(text = '') {
  return hasSignalPattern(text, [
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

function hasShortSignal(text = '') {
  return hasSignalPattern(text, [
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

function normalizeSideToken(value) {
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

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) {
      return TARGET_TRADE_SIDE;
    }
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) {
      return OPPOSITE_TRADE_SIDE;
    }
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }
  return 'UNKNOWN';
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
learningGranularity: LEARNING_GRANULARITY
};
}

function isFixedShortParentMicroId(id = '') {
const parsed = parseShortTaxonomyMicroId(id);

return parsed.valid && parsed.isParent;
}

function isFixedShortChildMicroId(id = '') {
const parsed = parseShortTaxonomyMicroId(id);

return parsed.valid && parsed.isChild;
}

function isScannerFingerprintId(id = '') {

const value = upper(id);

return (
value.startsWith('MICRO_SHORT_SCANNER__') ||
value.includes('MICRO_SHORT_SCANNER__') ||
value.startsWith('SHORT_SCANNER_') ||
value.includes('SHORT_SCANNER_') ||
value.startsWith('MICRO_LONG_SCANNER__') ||
value.includes('MICRO_LONG_SCANNER__') ||
value.startsWith('LONG_SCANNER_') ||
value.includes('LONG_SCANNER_') ||
value.includes('__SCANNER__') ||
value.includes('SCANNER_GATE_PASS') ||
value.includes('SCANNER_GATE_FAIL')
);
}

function isExecutionFingerprintId(id = '') {
const value = upper(id);

return (
value.includes('_XR_') ||
value.includes('__XR__') ||
value.includes('EXECUTION_FINGERPRINT') ||
value.includes('EXECUTION_MICRO') ||
value.includes('REFINED_EXECUTION')
);
}

function validLearningId(id = '') {
const value = String(id || '').trim();
if (!value) return false;
if (isScannerFingerprintId(value)) return false;
if (isExecutionFingerprintId(value)) return false;

return true;
}

function isSelectableTrueMicroId(id = '') {
const value = String(id || '').trim();

if (!validLearningId(value)) return false;

return isFixedShortChildMicroId(value);
}

function extractSnapshotId(value) {
if (!value) return null;

if (typeof value === 'string') {
return value;
}

if (typeof value === 'object') {
return (
value.snapshotId ||
value.id ||
value.latestSnapshotId ||
value.scanId ||
null
);
}

return null;
}

function getDefinitionHaystack(row = {}) {
return [
row.definition,
row.microDefinition,
row.macroDefinition,
row.parentDefinition,
...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts :
[]),
...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts :
[]),
...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts :
[]),
...(Array.isArray(row.executionFingerprintParts) ?
row.executionFingerprintParts : [])

]
.map((value) => cleanSideText(value))
.join(' | ');
}

function inferTradeSide(input = {}) {
if (typeof input === 'string') {
const value = cleanSideText(input);

if (!value) return 'UNKNOWN';

const direct = normalizeSideToken(value);

if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
return direct;
}

const parsed = parseShortTaxonomyMicroId(value);
if (parsed.valid) return TARGET_TRADE_SIDE;

const longSignal = hasLongSignal(value);
const shortSignal = hasShortSignal(value);

if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;

if (longSignal && shortSignal) {
if (value.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
if (value.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
}

return 'UNKNOWN';
}

const directSources = [
input.tradeSide,
input.side,

input.positionSide,
input.direction,
input.signalSide,
input.scannerSide,
input.actualScannerSide,
input.analysisSide,
input.entrySide,
input.bias,
input.marketBias
];

for (const source of directSources) {
const side = normalizeSideToken(source);

if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
return side;
}
}

const microFamilyId = cleanSideText(
input.trueMicroFamilyId ||
input.learningMicroFamilyId ||
input.analyzeMicroFamilyId ||
input.microFamilyId ||
input.childTrueMicroFamilyId ||
input.parentTrueMicroFamilyId ||
input.coarseMicroFamilyId ||
input.baseMicroFamilyId ||
input.legacyMicroFamilyId ||
input.id ||
input.key
);

if (parseShortTaxonomyMicroId(microFamilyId).valid) return TARGET_TRADE_SIDE;
if (microFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;

const definition = getDefinitionHaystack(input);
const longSignal = hasLongSignal(definition);
const shortSignal = hasShortSignal(definition);

if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;

if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;

if (longSignal && shortSignal) {
if (microFamilyId.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
if (microFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
}

if (input.shortOnly === true || input.longDisabled === true) {
return TARGET_TRADE_SIDE;
}

if (input.longOnly === true || input.shortDisabled === true) {
return OPPOSITE_TRADE_SIDE;
}
return 'UNKNOWN';
}

function isShortRow(row = {}) {
if (!row) return false;

const id = String(
row.trueMicroFamilyId ||
row.learningMicroFamilyId ||
row.analyzeMicroFamilyId ||
row.microFamilyId ||
row.coarseMicroFamilyId ||
row.id ||
row.key ||
''
).trim();

if (id && isScannerFingerprintId(id)) return false;
if (id && isExecutionFingerprintId(id)) return false;
if (inferTradeSide(row) === OPPOSITE_TRADE_SIDE) return false;

return true;
}

function isLongRow(row = {}) {

return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function getTrueMicroFamilyId(row = {}, key = '') {
const candidates = [
row.trueMicroFamilyId,
row.learningMicroFamilyId,
row.analyzeMicroFamilyId,
row.childTrueMicroFamilyId,
row.microFamilyId,
row.id,
row.key,
key
];

for (const candidate of candidates) {
const id = String(candidate || '').trim();

if (isSelectableTrueMicroId(id)) return id;
}

return null;
}

function getAnyMicroFamilyId(row = {}, key = '') {
return (
row.trueMicroFamilyId ||
row.learningMicroFamilyId ||
row.analyzeMicroFamilyId ||
row.microFamilyId ||
row.id ||
row.key ||
key ||
null
);
}

function getParentTrueMicroFamilyId(row = {}, key = '') {
const childId = getTrueMicroFamilyId(row, key);
const parsedChild = parseShortTaxonomyMicroId(childId);

if (parsedChild.parentTrueMicroFamilyId) return parsedChild.parentTrueMicroFamilyId;

const candidates = [
row.parentTrueMicroFamilyId,
row.coarseMicroFamilyId,
row.baseMicroFamilyId,
row.legacyMicroFamilyId,
row.parentMacroFamilyId,
row.macroFamilyId,
row.parentMicroFamilyId,
row.parentFamilyId,
row.familyId,
row.macroId
];

for (const candidate of candidates) {
const id = String(candidate || '').trim();

if (isFixedShortParentMicroId(id)) return id;
}

return null;
}

function filterShortRows(rows = []) {
return (Array.isArray(rows) ? rows : [])
.filter(Boolean)
.filter(isShortRow);
}

function normalizeShortSide(row = {}) {
const temporalContext = resolveRecordTemporalContext(row, now());
return {
...row,
...temporalContext,
...buildEntryExitTemporalMetadata(row),
...temporalStatsFields(row),
...modeFlags(),

...temporalPolicyFlags(temporalContext),

side: TARGET_DASHBOARD_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,

inferredTradeSide: TARGET_TRADE_SIDE
};
}

function countMapOrArray(value) {
return sourceEntries(value)
.filter(([key, row]) => {
const id = getTrueMicroFamilyId(row, key);

return Boolean(id && isShortRow({
...(row || {}),
trueMicroFamilyId: id
}));
})
.length;
}

function countLongMapOrArray(value) {
return sourceEntries(value)
.filter(([key, row]) => isLongRow({
...(row || {}),
microFamilyId: getAnyMicroFamilyId(row, key)
}))
.length;
}

function hasVirtualShadowOutcomeFields(row = {}) {
return [
'virtualCompleted',
'shadowCompleted',
'virtualWins',
'virtualLosses',
'virtualFlats',
'shadowWins',

'shadowLosses',
'shadowFlats',
'virtualTotalR',
'shadowTotalR'
].some((key) => hasValue(row[key]));
}

function virtualKeyFromReal(realKey = '') {
if (!realKey || !String(realKey).startsWith('real')) return null;

return `virtual${String(realKey).slice(4)}`;
}

function shadowKeyFromReal(realKey = '') {
if (!realKey || !String(realKey).startsWith('real')) return null;

return `shadow${String(realKey).slice(4)}`;
}

function isLearningOutcomeSource(source = '') {
const value = upper(source || 'VIRTUAL');

return value === 'VIRTUAL' || value === 'SHADOW' || value === 'PAPER' || value
=== '';
}

function getShortRiskGeometry(row = {}) {
  const entry = firstFiniteNumber([
      row.entryPrice,
      row.entry,
      row.avgEntryPrice,
      row.averageEntryPrice,
      row.averageEntry,
      row.openPrice
    ]);
  const initialSl = firstFiniteNumber([
      row.initialSl,
      row.initialSL,
      row.initialStopLoss,
      row.initialStopLossPrice,
      row.stopLoss,
      row.stopLossPrice,
      row.sl,
      row.slPrice
    ]);
  const tp = firstFiniteNumber([
      row.tp,
      row.takeProfit,
      row.takeProfitPrice,
      row.targetPrice,
      row.finalTp,
      row.finalTakeProfit
    ]);
  const exitPrice = firstFiniteNumber([
      row.exitPrice,
      row.closePrice,
      row.closedPrice,
      row.outcomePrice,
      row.fillExitPrice,
      row.exit
    ]);
  const currentPrice = firstFiniteNumber([
      row.currentPrice,
      row.markPrice,
      row.lastPrice,
      row.price
    ]);

  const denominator =
    Number.isFinite(entry) && Number.isFinite(initialSl)
      ? initialSl - entry
      : 0;

  const validGeometry =
    Number.isFinite(entry) &&
    Number.isFinite(initialSl) &&
    Number.isFinite(tp) &&
    denominator > 0 &&
    tp < entry &&
    entry < initialSl;

  const shortGrossR =
    validGeometry && Number.isFinite(exitPrice)
      ? (entry - exitPrice) / denominator
      : null;

  const shortCurrentR =
    validGeometry && Number.isFinite(currentPrice)
      ? (entry - currentPrice) / denominator
      : null;

  const shortTpHit =
    validGeometry &&
    (
      row.shortTpHit === true ||
      row.tpHit === true ||
      (Number.isFinite(exitPrice) && exitPrice <= tp) ||
      (Number.isFinite(currentPrice) && currentPrice <= tp)
    );

  const shortSlHit =
    validGeometry &&
    (
      row.shortSlHit === true ||
      row.slHit === true ||
      (Number.isFinite(exitPrice) && exitPrice >= initialSl) ||
      (Number.isFinite(currentPrice) && currentPrice >= initialSl)
    );

  return {
    entry,
    initialSl,
    tp,
    exitPrice,
    currentPrice,
    denominator,
    validGeometry,
    shortTpHit: Boolean(shortTpHit),
    shortSlHit: Boolean(shortSlHit),
    shortGrossR,
    shortCurrentR,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    sameCandlePolicy: 'CONSERVATIVE_SL_FIRST',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)'
  };
}

function outcomeNetR(row = {}) {
const explicitShortR = firstFiniteNumber([
row.shortNetR,
row.netShortR,
row.shortExitR,
row.shortRealizedNetR,
row.shortRealizedR
]);
if (explicitShortR !== null) return explicitShortR;

const geometry = getShortRiskGeometry(row);
const costR = num(row.costR ?? row.avgCostR, 0);

if (geometry.validGeometry && geometry.shortGrossR !== null) {
return geometry.shortGrossR - costR;
}

return num(
row.netR ??
row.exitR ??
row.realizedNetR ??
row.realizedR ??
row.r,
0
);
}

function getLearningCount(row = {}, aggregateKey, realKey = null, shadowKey =
null) {
const virtualKey = virtualKeyFromReal(realKey);
const resolvedShadowKey = shadowKey || shadowKeyFromReal(realKey);

const virtualShadow =
num(virtualKey ? row[virtualKey] : 0, 0) +
num(resolvedShadowKey ? row[resolvedShadowKey] : 0, 0);

if (virtualShadow > 0 || hasVirtualShadowOutcomeFields(row)) {
return virtualShadow;
}

if (aggregateKey && hasValue(row[aggregateKey])) {
return num(row[aggregateKey], 0);
}

return 0;
}

function aggregateRecentOutcomes(row = {}) {
const outcomes = Array.isArray(row.recentOutcomes)
? row.recentOutcomes
: [];

return outcomes.reduce(
(acc, outcome) => {
if (!outcome || typeof outcome !== 'object') return acc;
if (!isCurrentMeasurementOutcome(outcome)) return acc;
if (!isLearningOutcomeSource(outcome.source || outcome.outcomeSource
||
'VIRTUAL')) return acc;
if (!isShortRow({ ...row, ...outcome })) return acc;

const netR = outcomeNetR(outcome);
const costR = num(outcome.costR ?? outcome.avgCostR, 0);

acc.completed += 1;
acc.totalR += netR;
acc.totalCostR += costR;

if (netR > 0) acc.wins += 1;
else if (netR < 0) acc.losses += 1;
else acc.flats += 1;

return acc;

},
{
completed: 0,
wins: 0,
losses: 0,
flats: 0,
totalR: 0,
totalCostR: 0
}
);
}

function getOutcomeCounts(row = {}) {
const recent = aggregateRecentOutcomes(row);
if (!currentMeasurementAggregateAllowed(row)) {
return {
wins: recent.wins,
losses: recent.losses,
flats: recent.flats,
total: recent.completed
};
}

const wins = getLearningCount(row, 'wins', 'realWins', 'shadowWins');
const losses = getLearningCount(row, 'losses', 'realLosses', 'shadowLosses');
const flats = getLearningCount(row, 'flats', 'realFlats', 'shadowFlats');

const virtualShadowCompleted =
num(row.virtualCompleted, 0) +
num(row.shadowCompleted, 0);

const aggregateCompleted = hasVirtualShadowOutcomeFields(row)
? 0
: Math.max(
num(row.completed, 0),
num(row.outcomeSample, 0),
0
);
if (
wins + losses + flats <= 0 &&
virtualShadowCompleted <= 0 &&
aggregateCompleted <= 0 &&

recent.completed > 0
) {
return {
wins: recent.wins,
losses: recent.losses,
flats: recent.flats,
total: recent.completed
};
}

const countedTotal = wins + losses + flats;
const total = Math.max(
countedTotal,
virtualShadowCompleted,
aggregateCompleted,
recent.completed,
0
);

const inferredFlats = Math.max(0, total - wins - losses);

return {
wins,
losses,
flats: Math.max(flats, inferredFlats),
total
};
}

function getOutcomeSample(row = {}) {
return getOutcomeCounts(row).total;
}

function getObservationSample(row = {}) {
return Math.max(
num(row.seen, 0),
num(row.observations, 0),
getOutcomeSample(row),
0
);
}
function getTotalR(row = {}) {

const completed = getOutcomeSample(row);
const recent = aggregateRecentOutcomes(row);

if (completed <= 0) return 0;
if (!currentMeasurementAggregateAllowed(row)) return recent.totalR;

const virtualShadowTotalR =
num(row.virtualTotalR, 0) +
num(row.shadowTotalR, 0);

if (virtualShadowTotalR !== 0 || hasVirtualShadowOutcomeFields(row)) {
return virtualShadowTotalR;
}

if (recent.completed > 0) return recent.totalR;

if (hasValue(row.shortNetTotalR)) return num(row.shortNetTotalR, 0);
if (hasValue(row.netShortTotalR)) return num(row.netShortTotalR, 0);
if (hasValue(row.netTotalR)) return num(row.netTotalR, 0);
if (hasValue(row.totalNetR)) return num(row.totalNetR, 0);
if (hasValue(row.totalR)) return num(row.totalR, 0);

return 0;
}

function getTotalCostR(row = {}) {
const completed = getOutcomeSample(row);
const recent = aggregateRecentOutcomes(row);

if (completed <= 0) return 0;
if (!currentMeasurementAggregateAllowed(row)) return recent.totalCostR;

const virtualShadowCost =
num(row.virtualTotalCostR, 0) +
num(row.shadowTotalCostR, 0);

if (virtualShadowCost > 0 || hasVirtualShadowOutcomeFields(row)) return virtualShadowCost;

if (recent.completed > 0 && recent.totalCostR > 0) return recent.totalCostR;

if (hasValue(row.totalCostR)) return num(row.totalCostR, 0);
if (hasValue(row.avgCostR)) return num(row.avgCostR, 0) * completed;

return 0;
}

function getAvgR(row = {}) {
const completed = getOutcomeSample(row);

if (completed <= 0) return 0;

return getTotalR(row) / completed;
}

function getAvgCostR(row = {}) {
const completed = getOutcomeSample(row);

if (completed <= 0) return 0;

return getTotalCostR(row) / completed;
}

function tierForMicro(row = {}) {
const completed = getOutcomeSample(row);
const observed = getObservationSample(row);
const avgR = getAvgR(row);

if (completed >= EMPIRICAL_VETO_MIN_COMPLETED && avgR <=
EMPIRICAL_VETO_MAX_AVG_R) {
return 'EMPIRICAL_VETO';
}
if (completed >= EMPIRICAL_VETO_MIN_COMPLETED && avgR >

EMPIRICAL_VETO_MAX_AVG_R) {
return 'HARD';
}
if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'SOFT';
if (completed > 0) return 'SOFT';
if (observed > 0) return 'OBSERVATION';

return 'RAW';
}

function statusForMicro(row = {}) {
const completed = getOutcomeSample(row);
const avgR = getAvgR(row);

if (completed >= EMPIRICAL_VETO_MIN_COMPLETED) {
return avgR > EMPIRICAL_VETO_MAX_AVG_R
? 'PASSED'
: 'EMPIRICAL_VETO';
}
if (completed >= MIN_COMPLETED_ACTIVE_LEARNING) return 'ACTIVE_LEARNING';
if (completed > 0) return 'EARLY_OUTCOMES';

return 'OBSERVING';
}

function summarizeMicros(micros = {}) {
const rows = sourceEntries(micros)
.map(([key, row]) => {
const trueMicroFamilyId = getTrueMicroFamilyId(row, key);
const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(row, key);

return {
...(row || {}),
trueMicroFamilyId,
microFamilyId: trueMicroFamilyId,
learningMicroFamilyId: trueMicroFamilyId,
analyzeMicroFamilyId: trueMicroFamilyId,
parentTrueMicroFamilyId,
coarseMicroFamilyId: parentTrueMicroFamilyId
};
})

.filter((row) => row.trueMicroFamilyId &&
isSelectableTrueMicroId(row.trueMicroFamilyId))
.filter(isShortRow);

const summary = rows.reduce((acc, row) => {
const tier = tierForMicro(row);
const status = statusForMicro(row);
const completed = getOutcomeSample(row);
const observed = getObservationSample(row);

acc.rows += 1;
acc.seen += num(row.seen, 0);
acc.observations += num(row.observations, 0);
acc.completed += completed;
acc.totalR += getTotalR(row);
acc.totalCostR += getTotalCostR(row);

acc.tierCounts[tier] = (acc.tierCounts[tier] || 0) + 1;
acc.statusCounts[status] = (acc.statusCounts[status] || 0) + 1;

if (completed > 0) acc.completedFamilies += 1;
if (
completed >= MIN_COMPLETED_ACTIVE_LEARNING &&
completed < EMPIRICAL_VETO_MIN_COMPLETED
) acc.activeLearningFamilies += 1;
if (status === 'PASSED') acc.passedFamilies += 1;
if (status === 'EMPIRICAL_VETO') acc.empiricalVetoFamilies += 1;
if (completed > 0 && completed < MIN_COMPLETED_ACTIVE_LEARNING)
acc.earlyOutcomeFamilies += 1;
if (observed > 0 && completed <= 0) acc.observationOnlyFamilies += 1;

return acc;
}, {
rows: 0,
seen: 0,
observations: 0,
completed: 0,
totalR: 0,
totalCostR: 0,
completedFamilies: 0,
activeLearningFamilies: 0,
passedFamilies: 0,

empiricalVetoFamilies: 0,
earlyOutcomeFamilies: 0,
observationOnlyFamilies: 0,
tierCounts: {
HARD: 0,
SOFT: 0,
OBSERVATION: 0,
EMPIRICAL_VETO: 0,
RAW: 0
},
statusCounts: {
PASSED: 0,
EMPIRICAL_VETO: 0,
ACTIVE_LEARNING: 0,
EARLY_OUTCOMES: 0,
OBSERVING: 0
}
});

return {
...summary,
...modeFlags(),

selectableChildFamiliesWithRows: summary.rows,
selectableChildFamiliesTotal: 75,
parentFamiliesTotal: 15,

seen: round(summary.seen, 4),
observations: round(summary.observations, 4),
completed: round(summary.completed, 4),
totalR: round(summary.totalR, 4),
totalCostR: round(summary.totalCostR, 4),
avgR: summary.completed > 0 ? round(summary.totalR / summary.completed,
4) :
0,
avgCostR: summary.completed > 0 ? round(summary.totalCostR /
summary.completed, 4) : 0
};
}

function normalizeLatestScan(latestScan) {
if (!latestScan || typeof latestScan !== 'object') {
return null;

}

const rawCandidates = Array.isArray(latestScan.candidates)
? latestScan.candidates
: [];

const candidates = filterShortRows(rawCandidates)
.map((row) => normalizeShortSide({
...row,
source: row.source || 'SCANNER',
scannerOnly: true,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsUsedAsLearningFamily: false
}));
const createdAt = safeNumber(
latestScan.createdAt ||
latestScan.completedAt ||
latestScan.ts ||
latestScan.scannerTs,
0
);

const snapshotAgeSec = createdAt > 0
? Math.max(0, Math.floor((now() - createdAt) / 1000))
: null;
const temporalContext = resolveRecordTemporalContext(
latestScan,
createdAt || now()
);

const fallbackCandidatesCount = safeNumber(
latestScan.shortCandidatesCount ??
latestScan.selectedTargetCandidateCount ??
latestScan.scannerGateCandidatesCount ??
latestScan.candidatesCount ??
latestScan.count,
0
);

const topSymbols = candidates.length > 0
? candidates

.slice(0, 20)
.map((row) => row.symbol || row.contractSymbol)
.filter(Boolean)
: Array.isArray(latestScan.topSymbols)
? latestScan.topSymbols.slice(0, 20)
: [];

return {
...latestScan,
...temporalContext,
...buildEntryExitTemporalMetadata(latestScan),
...modeFlags(),
...temporalPolicyFlags(temporalContext),

snapshotId: extractSnapshotId(latestScan),

createdAt: createdAt || null,
snapshotAgeSec,

rawCandidatesCount: rawCandidates.length,

candidatesCount: rawCandidates.length > 0
? candidates.length
: fallbackCandidatesCount,

shortCandidatesCount: rawCandidates.length > 0
? candidates.length
: fallbackCandidatesCount,

longCandidatesIgnored: rawCandidates.filter(isLongRow).length,

scannerBucketsDebugMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,

topSymbols,
candidates
};
}

function normalizeRotation(rotation) {
if (!rotation || typeof rotation !== 'object') {
return null;
}

const rawMicroFamilies = Array.isArray(rotation.microFamilies)
? rotation.microFamilies
: [];

const microFamilies = rawMicroFamilies
.filter(isShortRow)
.map((row) => {
const trueMicroFamilyId = getTrueMicroFamilyId(row);
const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(row);

return normalizeShortSide({
...row,
trueMicroFamilyId,
microFamilyId: trueMicroFamilyId,
learningMicroFamilyId: trueMicroFamilyId,
analyzeMicroFamilyId: trueMicroFamilyId,
parentTrueMicroFamilyId,
coarseMicroFamilyId: parentTrueMicroFamilyId,
selectableTrueMicroFamily: Boolean(trueMicroFamilyId)
});
})
.filter((row) => row.trueMicroFamilyId &&
isSelectableTrueMicroId(row.trueMicroFamilyId));

const rowIds = microFamilies
.map((row) => row.trueMicroFamilyId)
.filter(Boolean);

const explicitIds = uniqueStrings([
...(Array.isArray(rotation.microFamilyIds) ? rotation.microFamilyIds :
[]),
...(Array.isArray(rotation.activeMicroFamilyIds) ?
rotation.activeMicroFamilyIds : []),
...(Array.isArray(rotation.trueMicroFamilyIds) ?
rotation.trueMicroFamilyIds :

[]),
...(Array.isArray(rotation.ids) ? rotation.ids : [])
]).filter(isSelectableTrueMicroId);

const microFamilyIds = uniqueStrings([
...explicitIds,
...rowIds
]).filter(isSelectableTrueMicroId);

const macroFamilyIds = uniqueStrings([
...(Array.isArray(rotation.macroFamilyIds) ? rotation.macroFamilyIds : []),
...(Array.isArray(rotation.activeMacroFamilyIds) ?
rotation.activeMacroFamilyIds : []),
...(Array.isArray(rotation.macroIds) ? rotation.macroIds : []),
...microFamilies.map((row) => row.parentTrueMicroFamilyId ||
row.coarseMicroFamilyId)
])
.filter(validLearningId)
.filter(isFixedShortParentMicroId);

const bestShortRaw =
rotation.bestShort ||
microFamilies.find((row) => isShortRow(row)) ||
null;

const bestShort = bestShortRaw
? normalizeShortSide(bestShortRaw)
: null;

return {
...rotation,
...modeFlags(),

sideMode: 'short_only',

manualOnly: true,
adminSelected: rotation.adminSelected === true || rotation.manualOnly ===
true,
autoRotation: false,
autoActivationDisabled: true,

liveSelectable: Boolean(microFamilyIds.length > 0),

exactTrueMicroOnly: true,
selectableChildOnly: true,
parentMatchDoesNotTriggerDiscord: true,
macroMatchDoesNotTriggerDiscord: true,

bestShort,
bestLong: null,

microFamilyIds,
activeMicroFamilyIds: microFamilyIds,
trueMicroFamilyIds: microFamilyIds,

macroFamilyIds,
activeMacroFamilyIds: macroFamilyIds,

microFamilies,

count: microFamilyIds.length || microFamilies.length,

rawMicroFamiliesCount: rawMicroFamilies.length,
longMicroFamiliesIgnored: rawMicroFamilies.filter(isLongRow).length,

missingSides: microFamilyIds.length || microFamilies.length
? []
: [TARGET_TRADE_SIDE]
};
}

function actionIsLearningVirtual(action = {}) {
return Boolean(
action.virtualOnly !== false ||
action.virtualTracked !== false ||
action.shadowOnly !== false ||
action.learningOnly ||
action.observationOnly ||
action.analysisInputOnly ||

action.source === 'VIRTUAL' ||
action.source === 'SHADOW' ||
action.shadowResult ||
action.reason === 'SHORT_RISK_INVALID' ||
action.reason === 'RISK_ENGINE_EMPTY_SHORT_RISK_OBSERVATION_ONLY'
);
}

function normalizeTradeAction(action = {}) {
const trueMicroFamilyId = getTrueMicroFamilyId(action);
const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(action);
const riskGeometry = getShortRiskGeometry(action);
return normalizeShortSide({
...action,

source: action.source || 'VIRTUAL',

trueMicroFamilyId,
microFamilyId: trueMicroFamilyId,
learningMicroFamilyId: trueMicroFamilyId,
analyzeMicroFamilyId: trueMicroFamilyId,
parentTrueMicroFamilyId,
coarseMicroFamilyId: parentTrueMicroFamilyId,

selectableTrueMicroFamily: Boolean(trueMicroFamilyId),

virtualOnly: true,
virtualTracked: true,
learningOnly: true,
realOrderPlaced: false,
exchangeOrder: false,
bitgetOrderPlaced: false,

scannerScore: action.scannerScore ?? action.moveScore ?? null,

validShortRiskShape: Boolean(riskGeometry.validGeometry),
validShortGeometry: Boolean(riskGeometry.validGeometry),
shortTpHit: riskGeometry.shortTpHit,
shortSlHit: riskGeometry.shortSlHit,
tpHit: riskGeometry.shortTpHit,

slHit: riskGeometry.shortSlHit,
shortGrossR: riskGeometry.shortGrossR,
shortCurrentR: riskGeometry.shortCurrentR,
currentR: riskGeometry.shortCurrentR ?? action.currentR ?? null,

learningAction: actionIsLearningVirtual(action),
discordAlertEligible: Boolean(action.discordAlertEligible),
selectedMicroFamilyAlert: Boolean(action.selectedMicroFamilyAlert),
exactSelectedTrueMicroMatch: Boolean(action.exactSelectedTrueMicroMatch ||
action.selectedMicroFamilyAlert),
discordAlertSent: Boolean(action.discordAlertSent ||
action.discordEntryAlertSent)
});
}

function buildActionCounts(actions = []) {
return actions.reduce((acc, row) => {
const key = row?.action || row?.type || 'UNKNOWN';
acc[key] = (acc[key] || 0) + 1;

return acc;
}, {});
}

function buildTradeSummary(tradeMeta) {
if (!tradeMeta || typeof tradeMeta !== 'object') {
return {
lastRunAt: null,
actionCounts: {},

actions: 0,
learningActions: 0,

virtualEntries: 0,
virtualWaits: 0,
virtualExits: 0,
shadowExits: 0,

discordEligibleActions: 0,
selectedMicroFamilyActions: 0,

exactSelectedTrueMicroActions: 0,
discordAlertsSent: 0,

skippedNewEntries: null,
reason: null,
skipReason: null,

...modeFlags()
};
}

const rawActions = Array.isArray(tradeMeta.actions)
? tradeMeta.actions
: [];

const rawShortActions = filterShortRows(rawActions);
const allShortActions = rawShortActions.map(normalizeTradeAction);
const learningActions = allShortActions.filter((row) => row.learningAction ||
row.virtualOnly);
const longActionsIgnored = rawActions.filter(isLongRow).length;

const entries = allShortActions.filter((row) => (
row.action === 'ENTRY' ||
row.action === 'VIRTUAL_ENTRY'
));
const waits = allShortActions.filter((row) => row.action === 'WAIT');

const exitArrays = [
...(Array.isArray(tradeMeta.exits) ? tradeMeta.exits : []),
...(Array.isArray(tradeMeta.virtualExits) ? tradeMeta.virtualExits : []),
...(Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []),
...(Array.isArray(tradeMeta.outcomes) ? tradeMeta.outcomes : [])
];

const virtualExits = filterShortRows(exitArrays).map((row) => {
const riskGeometry = getShortRiskGeometry(row);

return normalizeShortSide({
...row,

source: row.source || 'VIRTUAL',
outcomeSource: row.outcomeSource || 'VIRTUAL',
virtualOnly: true,
virtualTracked: true,
learningOnly: true,
realOrderPlaced: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
trueMicroFamilyId: getTrueMicroFamilyId(row),
parentTrueMicroFamilyId: getParentTrueMicroFamilyId(row),
validShortRiskShape: Boolean(riskGeometry.validGeometry),
validShortGeometry: Boolean(riskGeometry.validGeometry),
shortTpHit: riskGeometry.shortTpHit,
shortSlHit: riskGeometry.shortSlHit,
tpHit: riskGeometry.shortTpHit,
slHit: riskGeometry.shortSlHit,
shortGrossR: riskGeometry.shortGrossR,
shortCurrentR: riskGeometry.shortCurrentR,
netR: round(outcomeNetR(row), 4)
});
});

const shadowExits = filterShortRows(
Array.isArray(tradeMeta.shadowExits) ? tradeMeta.shadowExits : []
).map((row) => {
const riskGeometry = getShortRiskGeometry(row);

return normalizeShortSide({
...row,
source: row.source || 'VIRTUAL',
shadowOnly: true,
virtualOnly: true,
trueMicroFamilyId: getTrueMicroFamilyId(row),
parentTrueMicroFamilyId: getParentTrueMicroFamilyId(row),
validShortRiskShape: Boolean(riskGeometry.validGeometry),
validShortGeometry: Boolean(riskGeometry.validGeometry),
shortTpHit: riskGeometry.shortTpHit,
shortSlHit: riskGeometry.shortSlHit,
shortGrossR: riskGeometry.shortGrossR,
shortCurrentR: riskGeometry.shortCurrentR,
netR: round(outcomeNetR(row), 4)
});
});

const discordEligibleActions = allShortActions.filter((row) =>
row.discordAlertEligible);
const selectedMicroFamilyActions = allShortActions.filter((row) =>
row.selectedMicroFamilyAlert);
const exactSelectedTrueMicroActions = allShortActions.filter((row) =>
row.exactSelectedTrueMicroMatch);
const discordAlertsSent = allShortActions.filter((row) => row.discordAlertSent);

return {
lastRunAt: tradeMeta.completedAt || tradeMeta.startedAt || tradeMeta.ts ||
null,
durationMs: tradeMeta.durationMs ?? null,

runId: tradeMeta.runId || null,
snapshotId: tradeMeta.snapshotId || null,
snapshotAgeSec: tradeMeta.snapshotAgeSec ?? null,

...modeFlags(),

actionCounts: buildActionCounts(allShortActions),
rawActionCounts: tradeMeta.actionCounts || buildActionCounts(rawActions),
learningActionCounts: buildActionCounts(learningActions),

actions: allShortActions.length,
rawActions: rawActions.length,
allShortActions: allShortActions.length,
learningActions: learningActions.length,
longActionsIgnored,

virtualEntries: entries.length,
virtualWaits: waits.length,
virtualExits: virtualExits.length,
shadowExits: shadowExits.length,

entries: entries.length,
waits: waits.length,
exits: virtualExits.length,

entryRows: entries,

waitRows: waits,
virtualCreatedRows: entries,
virtualExitsRows: virtualExits,
shadowExitsRows: shadowExits,

discordEligibleActions: discordEligibleActions.length,
selectedMicroFamilyActions: selectedMicroFamilyActions.length,
exactSelectedTrueMicroActions: exactSelectedTrueMicroActions.length,
discordAlertsSent: discordAlertsSent.length,

skippedNewEntries: Boolean(tradeMeta.skippedNewEntries),
reason: tradeMeta.reason || tradeMeta.skipReason || null,
skipReason: tradeMeta.skipReason || tradeMeta.reason || null,

activeRotationId: tradeMeta.activeRotationId || null,
activeMicroFamilies: tradeMeta.activeMicroFamilies ?? null,

entriesSymbols: entries
.map((row) => row.symbol || row.contractSymbol)
.filter(Boolean)
.slice(0, 20),

exitSymbols: virtualExits
.map((row) => row.symbol || row.contractSymbol)
.filter(Boolean)
.slice(0, 20)
};
}

function compactRotationDashboard(rotationDashboard = {}) {
const active = normalizeRotation(
rotationDashboard.active ||
rotationDashboard.activeRotation ||
null
);

const nextRaw =
rotationDashboard.next ||
rotationDashboard.nextRotation ||
null;

const next = normalizeRotation(nextRaw);
const activeRows = filterShortRows(rotationDashboard.activeRows || [])
.map(normalizeShortSide)
.filter((row) => isSelectableTrueMicroId(row.trueMicroFamilyId ||
row.microFamilyId));

const nextRows = filterShortRows(rotationDashboard.nextRows || [])
.map((row) => normalizeShortSide({
...row,
autoActivationDisabled: true
}))
.filter((row) => isSelectableTrueMicroId(row.trueMicroFamilyId ||
row.microFamilyId));

return {
...rotationDashboard,
...modeFlags(),

active,
next,
activeRotation: active,
nextRotation: next,

activeRows,
nextRows,

activeCount: active?.count || activeRows.length || 0,
nextCount: next?.count || nextRows.length || 0,

activeMicroFamilyIds: active?.microFamilyIds || [],
nextMicroFamilyIds: next?.microFamilyIds || [],

activeMacroFamilyIds: active?.macroFamilyIds ||
active?.activeMacroFamilyIds
|| [],
nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds ||
[],

bestShort: active?.bestShort || null,
bestLong: null,

nextBestShort: next?.bestShort || null,
nextBestLong: null,

missingSides: active?.missingSides || [],
nextMissingSides: next?.missingSides || [],

autoRotationActivationDisabled: true
};
}
function normalizePosition(position = {}) {
const riskGeometry = getShortRiskGeometry(position);

const entry = riskGeometry.entry ?? num(position.entry ?? position.entryPrice,
0);
const sl = riskGeometry.initialSl ?? num(position.sl ?? position.stopLoss ??
position.initialSl, 0);
const tp = riskGeometry.tp ?? num(position.tp ?? position.takeProfit, 0);
const initialSl = riskGeometry.initialSl ?? sl;
const currentPrice = riskGeometry.currentPrice ?? num(position.currentPrice ??
position.lastPrice, 0);

const trueMicroFamilyId = getTrueMicroFamilyId(position);
const parentTrueMicroFamilyId = getParentTrueMicroFamilyId(position);

return normalizeShortSide({
...position,

source: position.source || 'VIRTUAL',

trueMicroFamilyId,
microFamilyId: trueMicroFamilyId,
learningMicroFamilyId: trueMicroFamilyId,
analyzeMicroFamilyId: trueMicroFamilyId,
parentTrueMicroFamilyId,
coarseMicroFamilyId: parentTrueMicroFamilyId,

selectableTrueMicroFamily: Boolean(trueMicroFamilyId),

virtualOnly: true,
virtualTracked: true,

realOrderPlaced: false,
exchangeOrder: false,
bitgetOrderPlaced: false,

entry,
entryPrice: entry,
sl,
tp,
initialSl,

validShortRiskShape: Boolean(riskGeometry.validGeometry),
validShortGeometry: Boolean(riskGeometry.validGeometry),

currentPrice: currentPrice || null,
lastPrice: currentPrice || null,

ageSec: position.ageSec ?? null,
currentR: position.currentR ?? riskGeometry.shortCurrentR,
shortCurrentR: riskGeometry.shortCurrentR,
shortGrossR: riskGeometry.shortGrossR,
mfeR: position.mfeR ?? null,
maeR: position.maeR ?? null,

reachedHalfR: Boolean(position.reachedHalfR),
reachedOneR: Boolean(position.reachedOneR),
nearTpSeen: Boolean(position.nearTpSeen),

tpHit: riskGeometry.shortTpHit,
slHit: riskGeometry.shortSlHit,
shortTpHit: riskGeometry.shortTpHit,
shortSlHit: riskGeometry.shortSlHit,

tpExitArmed: Boolean(currentPrice > 0 && tp > 0 && currentPrice <= tp),
slExitArmed: Boolean(currentPrice > 0 && initialSl > 0 && currentPrice <=
initialSl),
timeStopExitArmed: Boolean(position.timeStopExitArmed),

selectedMicroFamily: Boolean(
position.selectedMicroFamily ||
position.selectedMicroFamilyAlert
),
discordAlertEligible: Boolean(position.discordAlertEligible),
selectedMicroFamilyAlert: Boolean(position.selectedMicroFamilyAlert),
exactSelectedTrueMicroMatch: Boolean(position.exactSelectedTrueMicroMatch ||
position.selectedMicroFamilyAlert),
discordEntryAlertSent: Boolean(position.discordEntryAlertSent),
discordExitAlertEligible: Boolean(position.discordExitAlertEligible),
discordExitAlertSent: Boolean(position.discordExitAlertSent)
});
}

function buildPositionSummary(rawPositions = []) {
const positions = filterShortRows(rawPositions).map(normalizePosition);
const ignoredLongPositions = rawPositions.filter(isLongRow).length;
const unknownPositions = rawPositions.filter((row) => inferTradeSide(row) ===
'UNKNOWN').length;

return {
positions,
positionsCount: positions.length,
rawPositionsCount: rawPositions.length,
ignoredLongPositions,
unknownPositions,
ignoredUnknownPositions: unknownPositions,

virtualPositions: positions.length,
selectedPositions: positions.filter((row) => row.selectedMicroFamily ||
row.selectedMicroFamilyAlert).length,
exactSelectedTrueMicroPositions: positions.filter((row) =>
row.exactSelectedTrueMicroMatch).length,
discordEntryAlertSentPositions: positions.filter((row) =>
row.discordEntryAlertSent).length,
discordExitAlertEligiblePositions: positions.filter((row) =>
row.discordExitAlertEligible).length

};
}

function normalizeDiscordLog(row = {}) {
const payload = safeObject(row.payload);
const result = safeObject(row.result || payload.result);

const trueMicroFamilyId =
getTrueMicroFamilyId(row) ||
getTrueMicroFamilyId(payload) ||
getTrueMicroFamilyId(result);

const parentTrueMicroFamilyId =
getParentTrueMicroFamilyId(row) ||
getParentTrueMicroFamilyId(payload) ||
getParentTrueMicroFamilyId(result);

const selectedTrueMicroFamilyId = String(
row.selectedTrueMicroFamilyId ||
payload.selectedTrueMicroFamilyId ||
result.selectedTrueMicroFamilyId ||
row.selectedMicroFamilyId ||
payload.selectedMicroFamilyId ||
result.selectedMicroFamilyId ||
''
).trim();

const rawInferredTradeSide = inferTradeSide({
...row,
...payload,
...result,
trueMicroFamilyId,
microFamilyId: trueMicroFamilyId,
parentTrueMicroFamilyId,
coarseMicroFamilyId: parentTrueMicroFamilyId
});

const selectedMicroFamilyAlert = Boolean(
row.selectedMicroFamilyAlert ||
payload.selectedMicroFamilyAlert ||
result.selectedMicroFamilyAlert ||

row.alertAllowed ||
payload.alertAllowed ||
result.alertAllowed
);

const discordAlertEligible = Boolean(
row.discordAlertEligible ||
payload.discordAlertEligible ||
result.discordAlertEligible
);

const exactSelectedTrueMicroMatch = Boolean(
trueMicroFamilyId &&
isSelectableTrueMicroId(trueMicroFamilyId) &&
selectedMicroFamilyAlert &&
(
!selectedTrueMicroFamilyId ||
selectedTrueMicroFamilyId === trueMicroFamilyId
)
);

const alertAllowed = exactSelectedTrueMicroMatch;
const temporalContext = resolveRecordTemporalContext(
{
...row,
...payload,
...result
},
now()
);

return {
...row,
payload,
result,
...temporalContext,
...buildEntryExitTemporalMetadata({
...row,
...payload,
...result
}),
...modeFlags(),
...temporalPolicyFlags(temporalContext),

type: row.type || payload.type || result.type || row.level || payload.level
||
'UNKNOWN',

rawInferredTradeSide,
inferredTradeSide: rawInferredTradeSide,

symbol:
row.symbol ||
payload.symbol ||
payload.contractSymbol ||
result.symbol ||
result.contractSymbol ||
null,

microFamilyId: trueMicroFamilyId,
trueMicroFamilyId,
learningMicroFamilyId: trueMicroFamilyId,
analyzeMicroFamilyId: trueMicroFamilyId,
parentTrueMicroFamilyId,
coarseMicroFamilyId: parentTrueMicroFamilyId,

familyId:
parentTrueMicroFamilyId ||
row.familyId ||
payload.familyId ||
result.familyId ||
null,

macroFamilyId:
parentTrueMicroFamilyId ||
row.macroFamilyId ||
row.parentMacroFamilyId ||
payload.macroFamilyId ||
payload.parentMacroFamilyId ||
result.macroFamilyId ||
result.parentMacroFamilyId ||
null,

discordAlertEligible,
selectedMicroFamilyAlert,
selectedTrueMicroFamilyId: selectedTrueMicroFamilyId || null,
exactSelectedTrueMicroMatch,

selectedOnly: alertAllowed,

manualSelectionRequired: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
alertAllowed,
blockedByManualSelection: discordAlertEligible && !alertAllowed,
policyViolation: Boolean((row.sent || payload.sent || result.sent || result.ok
=== true) && !alertAllowed),

sent: Boolean(
row.sent ||
payload.sent ||
result.sent ||
result.ok === true
),

failed: Boolean(
row.failed ||
payload.failed ||
result.failed ||
result.ok === false
),

skipped: Boolean(
row.skipped ||
payload.skipped ||
result.skipped
),

source:
row.source ||
payload.source ||
result.source ||
null,

ts:
row.ts ||
row.createdAt ||
payload.ts ||
payload.createdAt ||
result.ts ||
result.createdAt ||
null
};
}

function summarizeDiscordLogs(logs = []) {
const normalized = logs
.map(normalizeDiscordLog)
.filter((log) => log.rawInferredTradeSide !== OPPOSITE_TRADE_SIDE)
.filter((log) => !log.trueMicroFamilyId ||
isSelectableTrueMicroId(log.trueMicroFamilyId));

return normalized.reduce((acc, log) => {
const type = upper(log.type || 'UNKNOWN');

acc.total += 1;
acc.byType[type] = (acc.byType[type] || 0) + 1;

if (log.discordAlertEligible) acc.eligible += 1;
if (log.selectedOnly || log.alertAllowed) acc.selectedOnly += 1;
if (log.exactSelectedTrueMicroMatch) acc.exactSelectedTrueMicroMatch += 1;
if (log.sent) acc.sent += 1;
if (log.failed) acc.failed += 1;
if (log.skipped) acc.skipped += 1;
if (log.policyViolation) acc.policyViolations += 1;
if (log.blockedByManualSelection) acc.blockedByManualSelection += 1;

return acc;
}, {
total: 0,
eligible: 0,
selectedOnly: 0,
exactSelectedTrueMicroMatch: 0,
sent: 0,
failed: 0,
skipped: 0,

policyViolations: 0,
blockedByManualSelection: 0,
byType: {}
});
}

function buildTaxonomySummary(micros = {}, activeMicroFamilyIds = []) {
const activeSet = new Set(activeMicroFamilyIds || []);
const rows = sourceEntries(micros)
.map(([key, row]) => {
const trueMicroFamilyId = getTrueMicroFamilyId(row, key);
const parsed = parseShortTaxonomyMicroId(trueMicroFamilyId);

return {
...(row || {}),
trueMicroFamilyId,
parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
taxonomySetup: parsed.setup,
taxonomyRegime: parsed.regime,
confirmationProfile: parsed.confirmationProfile
};
})
.filter((row) => row.trueMicroFamilyId &&
isSelectableTrueMicroId(row.trueMicroFamilyId));

const completedChildren = rows.filter((row) => getOutcomeSample(row) > 0);
const activeLearningChildren = rows.filter((row) => getOutcomeSample(row) >=
MIN_COMPLETED_ACTIVE_LEARNING);
const observingChildren = rows.filter((row) => getOutcomeSample(row) === 0 &&
getObservationSample(row) > 0);
return {
...modeFlags(),

parentFamiliesTotal: 15,
selectableChildFamiliesTotal: 75,

selectableChildFamiliesWithRows: rows.length,
selectableChildFamiliesWithCompleted: completedChildren.length,
selectableChildFamiliesActiveLearning: activeLearningChildren.length,
selectableChildFamiliesObserving: observingChildren.length,

activeSelectedChildFamilies: activeSet.size,

setupCount: SETUP_ORDER.length,
regimeCount: REGIME_ORDER.length,
confirmationProfileCount: CONFIRMATION_PROFILE_ORDER.length,

setups: SETUP_ORDER,
regimes: REGIME_ORDER,
confirmationProfiles: CONFIRMATION_PROFILE_ORDER
};
}

async function safeRead(label, fn, fallback) {
try {
const value = await fn();

return {
ok: true,
label,
value
};
} catch (error) {
return {
ok: false,
label,
value: fallback,
error: error?.message || String(error)
};
}
}



// ============================================================================
// TEMPORAL ADMIN PROJECTION - READ-ONLY NORMALIZATION
// ============================================================================
// This route does not build generations, aggregate outcomes or apply Discord
// entry gates. It only exposes the state produced by the authoritative SHORT
// trade/analyze/temporal modules. Unknown fields are normalized fail-safely.

function temporalAdminFinite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function temporalAdminBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function temporalAdminObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function temporalAdminFirst(source = {}, keys = [], fallback = null) {
  const row = temporalAdminObject(source);
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function temporalAdminPolicyMode(value, fallback = 'OBSERVE') {
  const normalized = String(value || '').trim().toUpperCase();
  if (TEMPORAL_POLICY_MODES.includes(normalized)) return normalized;
  const normalizedFallback = String(fallback || '').trim().toUpperCase();
  return TEMPORAL_POLICY_MODES.includes(normalizedFallback)
    ? normalizedFallback
    : 'OBSERVE';
}

function temporalAdminStatsEnabled(source = {}) {
  return temporalAdminBool(
    temporalAdminFirst(source, [
      'temporalStatsEnabled',
      'shortTemporalStatsEnabled',
      'TEMPORAL_STATS_ENABLED'
    ], process.env.SHORT_TEMPORAL_STATS_ENABLED ?? process.env.TEMPORAL_STATS_ENABLED),
    true
  );
}

function temporalAdminResolvedPolicyMode(source = {}) {
  if (!temporalAdminStatsEnabled(source)) return 'OFF';
  return temporalAdminPolicyMode(
    temporalAdminFirst(source, [
      'temporalPolicyMode',
      'policyMode',
      'shortTemporalPolicyMode',
      'TEMPORAL_POLICY_MODE'
    ], process.env.SHORT_TEMPORAL_POLICY_MODE ?? process.env.TEMPORAL_POLICY_MODE),
    'OBSERVE'
  );
}

function temporalAdminNormalizeTimestamp(value, fallback = Date.now()) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    const fallbackNumber = Number(fallback);
    return Number.isFinite(fallbackNumber) && fallbackNumber > 0
      ? Math.floor(fallbackNumber)
      : Date.now();
  }
  return n < 10_000_000_000 ? Math.floor(n * 1000) : Math.floor(n);
}

function temporalAdminMarketEventClusterId(source = {}, entryTs = Date.now()) {
  const explicit = temporalAdminFirst(source, [
    'marketEventClusterId',
    'scannerRunId',
    'marketSnapshotId',
    'snapshotId',
    'marketCycleId',
    'scanRunId'
  ]);
  if (explicit !== null) return String(explicit);
  const normalizedEntryTs = temporalAdminNormalizeTimestamp(entryTs, Date.now());
  const hourStartTs = Math.floor(normalizedEntryTs / 3_600_000) * 3_600_000;
  return `${TARGET_TRADE_SIDE}:UTC_HOUR:${hourStartTs}`;
}

function temporalAdminContextFromRecord(source = {}, prefix = 'entry', fallbackTs = Date.now()) {
  const row = temporalAdminObject(source);
  const isEntry = prefix === 'entry';
  const timestampKeys = isEntry
    ? ['entryTs', 'openedAt', 'openTs', 'entryAt', 'positionOpenedAt', 'createdAt', 'ts']
    : ['exitTs', 'closedAt', 'closeTs', 'exitAt', 'positionClosedAt', 'completedAt', 'updatedAt'];
  const explicitTs = temporalAdminFirst(row, timestampKeys, null);
  if (!isEntry && explicitTs === null) {
    return {
      exitTs: null,
      exitHourUtc: null,
      exitDayOfWeekUtc: null,
      exitDayType: null,
      exitIsWeekend: null,
      exitSessionTags: [],
      exitSessionBucket: null,
      exitSessionOverlap: false,
      exitOffHours: null
    };
  }
  const ts = temporalAdminNormalizeTimestamp(explicitTs, fallbackTs);
  const computed = buildTemporalContext(ts);
  const field = (suffix) => `${prefix}${suffix}`;
  const explicitTags = temporalAdminFirst(row, [field('SessionTags')], computed.sessionTags);
  const tags = Array.isArray(explicitTags)
    ? explicitTags.map((value) => String(value || '').trim().toUpperCase())
      .filter((value) => ['ASIA', 'EUROPE', 'US'].includes(value))
    : computed.sessionTags;
  const explicitBucket = String(
    temporalAdminFirst(row, [field('SessionBucket')], computed.primarySessionBucket) || ''
  ).trim().toUpperCase();
  const bucket = PRIMARY_SESSION_BUCKETS.includes(explicitBucket)
    ? explicitBucket
    : computed.primarySessionBucket;
  const day = String(
    temporalAdminFirst(row, [field('DayOfWeekUtc')], computed.dayOfWeekUtc) || computed.dayOfWeekUtc
  ).trim().toUpperCase();
  const weekend = temporalAdminBool(
    temporalAdminFirst(row, [field('IsWeekend')], computed.isWeekend),
    computed.isWeekend
  );
  return {
    [field('Ts')]: ts,
    [field('HourUtc')]: temporalAdminFinite(
      temporalAdminFirst(row, [field('HourUtc')], computed.hourUtc),
      computed.hourUtc
    ),
    [field('DayOfWeekUtc')]: DAY_NAMES_UTC.includes(day) ? day : computed.dayOfWeekUtc,
    [field('DayType')]: String(
      temporalAdminFirst(row, [field('DayType')], weekend ? 'WEEKEND' : 'WEEKDAY')
    ).trim().toUpperCase(),
    [field('IsWeekend')]: weekend,
    [field('SessionTags')]: tags,
    [field('SessionBucket')]: bucket,
    [field('SessionOverlap')]: temporalAdminBool(
      temporalAdminFirst(row, [field('SessionOverlap')], tags.length > 1),
      tags.length > 1
    ),
    [field('OffHours')]: temporalAdminBool(
      temporalAdminFirst(row, [field('OffHours')], bucket === 'OFF_HOURS'),
      bucket === 'OFF_HOURS'
    )
  };
}

function temporalAdminGateMaturity(completed) {
  const n = Math.max(0, Math.floor(temporalAdminFinite(completed, 0) || 0));
  if (n === 0) return 'OBSERVING';
  if (n < 20) return 'EARLY_OUTCOMES';
  if (n < 35) return 'ACTIVE_LEARNING';
  return 'MATURE';
}

function temporalAdminActiveDecision(value, fallback = 'INHERIT_GLOBAL') {
  const normalized = String(value || '').trim().toUpperCase();
  return TEMPORAL_ACTIVE_DECISIONS.includes(normalized) ? normalized : fallback;
}

function temporalAdminCandidateDecision(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return TEMPORAL_CANDIDATE_DECISIONS.includes(normalized) ? normalized : null;
}

function temporalAdminNormalizeBucket(value = {}) {
  const source = temporalAdminObject(value);
  const lifetimeSource = temporalAdminObject(
    source.lifetimeStats || source.lifetime || source
  );
  const windowSource = temporalAdminObject(
    source.gateWindowStats || source.gateWindow || source.recentWindow || {}
  );
  const completed = Math.max(0, Math.floor(temporalAdminFinite(
    temporalAdminFirst(lifetimeSource, ['completed', 'lifetimeCompleted'], 0),
    0
  ) || 0));
  const observations = Math.max(0, Math.floor(temporalAdminFinite(
    temporalAdminFirst(lifetimeSource, ['observations', 'seen'], 0),
    0
  ) || 0));
  const wins = Math.max(0, Math.floor(temporalAdminFinite(lifetimeSource.wins, 0) || 0));
  const losses = Math.max(0, Math.floor(temporalAdminFinite(lifetimeSource.losses, 0) || 0));
  const flats = Math.max(0, Math.floor(temporalAdminFinite(lifetimeSource.flats, 0) || 0));
  const sumNetR = temporalAdminFinite(
    temporalAdminFirst(lifetimeSource, ['sumNetR', 'totalR', 'lifetimeSumNetR'], 0),
    0
  );
  const sumNetR2 = temporalAdminFinite(
    temporalAdminFirst(lifetimeSource, ['sumNetR2', 'lifetimeSumNetR2'], 0),
    0
  );
  const grossWinR = Math.max(0, temporalAdminFinite(lifetimeSource.grossWinR, 0) || 0);
  const grossLossR = Math.abs(temporalAdminFinite(lifetimeSource.grossLossR, 0) || 0);
  const totalCostR = Math.max(0, temporalAdminFinite(lifetimeSource.totalCostR, 0) || 0);
  const directSLCount = Math.max(
    0,
    Math.floor(temporalAdminFinite(lifetimeSource.directSLCount, 0) || 0)
  );
  const profitFactor = grossWinR > 0 || grossLossR > 0
    ? grossLossR > 0
      ? grossWinR / grossLossR
      : grossWinR > 0
        ? 99
        : 0
    : Math.max(0, temporalAdminFinite(
      temporalAdminFirst(source, ['profitFactor', 'pf'], 0),
      0
    ) || 0);
  const directSLPct = completed > 0
    ? Math.min(1, Math.max(0, directSLCount / completed))
    : 0;
  const avgCostR = completed > 0 ? totalCostR / completed : 0;
  const avgNetR = completed > 0
    ? temporalAdminFinite(
      temporalAdminFirst(lifetimeSource, ['avgNetR', 'avgR'], sumNetR / completed),
      sumNetR / completed
    )
    : 0;

  const gateWindowCompleted = Math.max(0, Math.min(
    TEMPORAL_GATE_WINDOW_MAX_OUTCOMES,
    Math.floor(temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowCompleted', 'completed', 'n'], 0),
      0
    ) || 0)
  ));
  const gateWindowSumNetR = temporalAdminFinite(
    temporalAdminFirst(windowSource, ['gateWindowSumNetR', 'sumNetR', 'totalR'], null),
    null
  );
  const gateWindowSumNetR2 = temporalAdminFinite(
    temporalAdminFirst(windowSource, ['gateWindowSumNetR2', 'sumNetR2'], null),
    null
  );
  const gateWindowAvgNetR = gateWindowCompleted > 0
    ? temporalAdminFinite(
      temporalAdminFirst(
        windowSource,
        ['gateWindowAvgNetR', 'avgNetR', 'avgR'],
        gateWindowSumNetR !== null ? gateWindowSumNetR / gateWindowCompleted : 0
      ),
      gateWindowSumNetR !== null ? gateWindowSumNetR / gateWindowCompleted : 0
    )
    : 0;

  let variance = temporalAdminFinite(
    temporalAdminFirst(windowSource, ['variance', 'sampleVariance'], null),
    null
  );
  if (variance !== null) variance = Math.max(0, variance);
  if (
    variance === null &&
    gateWindowCompleted > 1 &&
    gateWindowSumNetR !== null &&
    gateWindowSumNetR2 !== null
  ) {
    variance = Math.max(
      0,
      (gateWindowSumNetR2 - (gateWindowSumNetR * gateWindowSumNetR) /
        gateWindowCompleted) /
      (gateWindowCompleted - 1)
    );
  }
  if (variance === null && completed > 1) {
    variance = Math.max(
      0,
      (sumNetR2 - (sumNetR * sumNetR) / completed) /
      (completed - 1)
    );
  }
  const explicitStddev = temporalAdminFinite(
    temporalAdminFirst(windowSource, ['gateWindowStddev', 'stddev'], null),
    null
  );
  const gateWindowStddev = explicitStddev !== null && explicitStddev > 0
    ? explicitStddev
    : variance !== null
      ? Math.sqrt(Math.max(0, variance))
      : explicitStddev === 0 && gateWindowCompleted <= 1
        ? 0
        : null;
  const explicitSE = temporalAdminFinite(
    temporalAdminFirst(windowSource, ['gateWindowSE', 'se', 'standardError'], null),
    null
  );
  const gateWindowSE = explicitSE !== null && explicitSE > 0
    ? explicitSE
    : gateWindowStddev !== null && gateWindowCompleted > 0
      ? gateWindowStddev / Math.sqrt(gateWindowCompleted)
      : explicitSE === 0 && gateWindowCompleted <= 1
        ? 0
        : null;

  const decisionSource = temporalAdminObject(
    source.activeDecision || source.decision || source
  );
  const diversity = temporalAdminObject(
    source.sampleDiversityDiagnostics || source.diversity ||
    windowSource.sampleDiversityDiagnostics
  );
  const eventDiversity = temporalAdminObject(
    source.marketEventDiversityDiagnostics || source.eventDiversity ||
    windowSource.marketEventDiversityDiagnostics
  );
  const confounding = temporalAdminObject(
    source.confoundingDiagnostics || source.confounding ||
    windowSource.confoundingDiagnostics
  );
  const sampleDiversityStatus = String(
    temporalAdminFirst(diversity, ['sampleDiversityStatus', 'status'], 'NOT_EVALUATED')
  ).trim().toUpperCase();
  const marketEventDiversityStatus = String(
    temporalAdminFirst(
      eventDiversity,
      ['marketEventDiversityStatus', 'status'],
      'NOT_EVALUATED'
    )
  ).trim().toUpperCase();
  const confoundingStatus = String(
    temporalAdminFirst(confounding, ['confoundingStatus', 'status'], 'NOT_EVALUATED')
  ).trim().toUpperCase();
  const evaluationBatchId = temporalAdminFirst(
    source,
    ['evaluationBatchId', 'batchId'],
    null
  );
  const testStatus = String(temporalAdminFirst(
    windowSource,
    ['statisticalTestStatus', 'testStatus'],
    temporalAdminFirst(source, ['statisticalTestStatus', 'testStatus'], '')
  )).trim().toUpperCase();
  const rawPValueCandidate = temporalAdminFinite(
    temporalAdminFirst(windowSource, ['rawPValue', 'gateWindowRawPValue'], null),
    null
  );
  const adjustedQValueCandidate = temporalAdminFinite(
    temporalAdminFirst(
      windowSource,
      ['adjustedQValue', 'gateWindowAdjustedQValue'],
      null
    ),
    null
  );
  const testsEvaluated = Boolean(
    evaluationBatchId ||
    source.statisticalTestsEvaluated === true ||
    source.testsEvaluated === true ||
    windowSource.statisticalTestsEvaluated === true ||
    windowSource.testsEvaluated === true ||
    ['EVALUATED', 'COMPLETE', 'COMPLETED', 'VALID', 'PASSED', 'FAILED'].includes(testStatus) ||
    (rawPValueCandidate !== null && rawPValueCandidate > 0) ||
    (adjustedQValueCandidate !== null && adjustedQValueCandidate > 0) ||
    (
      gateWindowCompleted > 0 &&
      (
        !['NOT_EVALUATED', 'UNKNOWN', ''].includes(sampleDiversityStatus) ||
        !['NOT_EVALUATED', 'UNKNOWN', ''].includes(marketEventDiversityStatus) ||
        !['NOT_EVALUATED', 'UNKNOWN', ''].includes(confoundingStatus)
      )
    )
  );

  return {
    observations,
    completed,
    wins,
    losses,
    flats,
    sumNetR,
    sumNetR2,
    avgNetR,
    grossWinR,
    grossLossR,
    profitFactor,
    totalCostR,
    avgCostR,
    directSLCount,
    directSLPct,
    lastOutcomeTs: temporalAdminFinite(lifetimeSource.lastOutcomeTs, null),
    acceptedTemporalOutcomeSeq: Math.max(0, Math.floor(temporalAdminFinite(
      temporalAdminFirst(source, ['acceptedTemporalOutcomeSeq', 'outcomeSeq'], 0),
      0
    ) || 0)),
    gateWindowCompleted,
    gateWindowSumNetR,
    gateWindowSumNetR2,
    gateWindowAvgNetR,
    gateWindowVariance: variance,
    gateWindowStddev,
    gateWindowSE,
    gateWindowLCB95: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowLCB95', 'lcb95'], null),
      null
    ),
    gateWindowUCB95: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['gateWindowUCB95', 'ucb95'], null),
      null
    ),
    rawPValue: testsEvaluated ? rawPValueCandidate : null,
    adjustedQValue: testsEvaluated ? adjustedQValueCandidate : null,
    oldestOutcomeTs: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['oldestOutcomeTs', 'gateWindowOldestOutcomeTs'], null),
      null
    ),
    newestOutcomeTs: temporalAdminFinite(
      temporalAdminFirst(windowSource, ['newestOutcomeTs', 'gateWindowNewestOutcomeTs'], null),
      null
    ),
    gateMaturityStatus: String(temporalAdminFirst(
      source,
      ['gateMaturityStatus', 'maturityStatus'],
      temporalAdminGateMaturity(gateWindowCompleted)
    )).trim().toUpperCase(),
    activeTemporalDecision: temporalAdminActiveDecision(temporalAdminFirst(
      decisionSource,
      ['activeTemporalDecision', 'decision', 'status'],
      'INHERIT_GLOBAL'
    )),
    candidateTemporalDecision: temporalAdminCandidateDecision(temporalAdminFirst(
      source,
      ['candidateTemporalDecision', 'candidateDecision', 'evaluationStatus'],
      null
    )),
    candidateEnteredAtSeq: temporalAdminFinite(source.candidateEnteredAtSeq, null),
    vetoActivatedAtSeq: temporalAdminFinite(source.vetoActivatedAtSeq, null),
    candidateEnteredFreezeSeq: temporalAdminFinite(source.candidateEnteredFreezeSeq, null),
    candidateAgeFreezes: temporalAdminFinite(source.candidateAgeFreezes, null),
    sampleDiversityStatus,
    distinctEntryDates: temporalAdminFinite(diversity.distinctEntryDates, null),
    distinctIsoWeeks: temporalAdminFinite(diversity.distinctIsoWeeks, null),
    distinctSymbols: temporalAdminFinite(diversity.distinctSymbols, null),
    dominantDateShare: temporalAdminFinite(
      temporalAdminFirst(diversity, ['dominantDateShare', 'maxDayShare'], null),
      null
    ),
    dominantSymbolShare: temporalAdminFinite(
      temporalAdminFirst(diversity, ['dominantSymbolShare', 'maxSymbolShare'], null),
      null
    ),
    marketEventDiversityStatus,
    distinctMarketEventClusters: temporalAdminFinite(
      eventDiversity.distinctMarketEventClusters,
      null
    ),
    dominantMarketEventClusterShare: temporalAdminFinite(
      temporalAdminFirst(
        eventDiversity,
        ['dominantMarketEventClusterShare', 'dominantClusterShare'],
        null
      ),
      null
    ),
    confoundingStatus,
    dominantLossShare: temporalAdminFinite(confounding.dominantLossShare, null),
    supportingNegativeCellCount: temporalAdminFinite(
      temporalAdminFirst(
        confounding,
        ['supportingNegativeCellCount', 'supportingCellCount'],
        null
      ),
      null
    ),
    evaluationBatchId,
    vetoReason: temporalAdminFirst(source, ['vetoReason', 'blockReason'], null)
  };
}

function temporalAdminNormalizeStats(record = {}) {
  const row = temporalAdminObject(record);
  const root = temporalAdminObject(row.temporalStats || row.temporalFamilyStats || {});
  const dayTypeSource = temporalAdminObject(
    root.dayType || row.dayTypeStats || row.contextStats || {}
  );
  const dayOfWeekSource = temporalAdminObject(
    root.dayOfWeek || row.dayOfWeekStats || {}
  );
  const sessionSource = temporalAdminObject(
    root.session || row.sessionStats || row.primarySessionStats || {}
  );
  const hasSource = Boolean(
    row.temporalStats || row.temporalFamilyStats || row.dayTypeStats ||
    row.contextStats || row.dayOfWeekStats || row.sessionStats || row.primarySessionStats
  );
  return {
    available: hasSource,
    source: hasSource ? 'AUTHORITATIVE_TEMPORAL_AGGREGATE' : 'NOT_YET_AVAILABLE',
    temporalStatsVersion: temporalAdminFirst(row, ['temporalStatsVersion'], TEMPORAL_STATS_VERSION),
    temporalAggregationVersion: temporalAdminFirst(
      row, ['temporalAggregationVersion'], TEMPORAL_AGGREGATION_VERSION
    ),
    dayType: Object.fromEntries(
      TEMPORAL_DAY_TYPES.map((bucket) => [bucket, temporalAdminNormalizeBucket(dayTypeSource[bucket])])
    ),
    dayOfWeek: Object.fromEntries(
      DAY_NAMES_UTC.map((bucket) => [bucket, temporalAdminNormalizeBucket(dayOfWeekSource[bucket])])
    ),
    session: Object.fromEntries(
      PRIMARY_SESSION_BUCKETS.map((bucket) => [bucket, temporalAdminNormalizeBucket(sessionSource[bucket])])
    )
  };
}

function temporalAdminNormalizeGeneration(value = {}, fallbackStatus = 'MISSING', referenceTs = Date.now()) {
  const source = temporalAdminObject(value);
  const manifest = temporalAdminObject(source.manifest || source.generationMetadata || source);
  const projectionCount = temporalAdminFinite(
    temporalAdminFirst(manifest, ['familyCount', 'projectionCount'], null), null
  );
  const cutoffTs = temporalAdminFinite(
    temporalAdminFirst(manifest, ['generationCutoffTs', 'profileCutoffTs', 'cutoffTs'], null), null
  );
  const ageDays = cutoffTs
    ? Math.max(0, (temporalAdminNormalizeTimestamp(referenceTs) - temporalAdminNormalizeTimestamp(cutoffTs)) / 86_400_000)
    : null;
  let status = String(
    temporalAdminFirst(source, ['generationStatus', 'status', 'profileStatus'], fallbackStatus)
  ).trim().toUpperCase();
  if (!TEMPORAL_GENERATION_STATES.includes(status) && status !== 'MISSING' && status !== 'CORRUPT' && status !== 'VERSION_INCOMPATIBLE') {
    status = fallbackStatus;
  }
  if (ageDays !== null && ageDays > TEMPORAL_GENERATION_MAX_AGE_DAYS && status === 'ACTIVE') {
    status = 'EXPIRED';
  }
  return {
    generationId: temporalAdminFirst(source, [
      'generationId', 'activeTemporalGenerationId', 'nextTemporalGenerationId', 'profileId'
    ], null),
    generationStatus: status,
    generationCutoffTs: cutoffTs,
    generationAgeDays: ageDays,
    temporalPolicyVersion: temporalAdminFirst(manifest, ['temporalPolicyVersion'], TEMPORAL_POLICY_VERSION),
    temporalGenerationVersion: temporalAdminFirst(manifest, ['temporalGenerationVersion'], TEMPORAL_GENERATION_VERSION),
    temporalAggregationVersion: temporalAdminFirst(manifest, ['temporalAggregationVersion'], TEMPORAL_AGGREGATION_VERSION),
    measurementVersion: temporalAdminFirst(manifest, ['measurementVersion', 'measurementFixVersion'], null),
    costModelVersion: temporalAdminFirst(manifest, ['costModelVersion', 'exitFillModelVersion'], null),
    taxonomyVersion: temporalAdminFirst(manifest, ['taxonomyVersion', 'trueMicroFamilySchema'], null),
    side: String(temporalAdminFirst(manifest, ['side', 'tradeSide'], TARGET_TRADE_SIDE)).trim().toUpperCase(),
    familyCount: projectionCount,
    expectedFamilyCount: 75,
    familyCountValid: projectionCount === null ? null : projectionCount === 75,
    checksum: temporalAdminFirst(manifest, ['checksum', 'checksumJson'], null),
    freezeSequence: temporalAdminFinite(manifest.freezeSequence, null),
    activationWindowExpiresTs: temporalAdminFinite(manifest.activationWindowExpiresTs, null),
    readyForActivation: status === 'READY',
    usableInEnforce: status === 'ACTIVE' && (ageDays === null || ageDays <= TEMPORAL_GENERATION_MAX_AGE_DAYS)
  };
}

function temporalAdminProjectionSource(record = {}) {
  const row = temporalAdminObject(record);
  return temporalAdminObject(
    row.activeTemporalProjection ||
    row.temporalProjection ||
    row.activeTemporalProfile ||
    row.activeTemporalGeneration?.projection ||
    row.activeTemporalGeneration?.activeProjection ||
    {}
  );
}

function temporalAdminProjectionDecision(projection = {}, dimension, bucket, fallback = 'INHERIT_GLOBAL') {
  const source = temporalAdminObject(projection);
  const maps = dimension === 'dayOfWeek'
    ? [source.dayOfWeekDecisions, source.dayDecisions, source.dayOfWeek]
    : [source.sessionDecisions, source.session];
  for (const mapValue of maps) {
    const map = temporalAdminObject(mapValue);
    const raw = map[bucket];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === 'object'
      ? raw.decision || raw.activeTemporalDecision || raw.status
      : raw;
    return temporalAdminActiveDecision(value, fallback);
  }
  return fallback;
}

function temporalAdminWeekendApproval(projection = {}, dayOfWeekUtc) {
  const source = temporalAdminObject(projection);
  const weekend = temporalAdminObject(source.weekendOverrides || source.weekendApprovals || {});
  const raw = weekend[dayOfWeekUtc];
  if (typeof raw === 'boolean') return raw;
  const value = temporalAdminObject(raw);
  return temporalAdminBool(
    temporalAdminFirst(value, ['discordAllowed', 'approved'], false), false
  ) || String(temporalAdminFirst(value, ['status', 'decision'], '')).trim().toUpperCase() === 'WEEKEND_APPROVED';
}

function temporalAdminDecisionSnapshot(record = {}) {
  const row = temporalAdminObject(record);
  const source = temporalAdminObject(
    row.entryDecisionSnapshot || row.decisionSnapshot || row.temporalDecisionSnapshot || {}
  );
  if (Object.keys(source).length === 0) return null;
  return {
    entryDecisionId: temporalAdminFirst(source, ['entryDecisionId'], temporalAdminFirst(row, ['entryDecisionId'], null)),
    capturedAtTs: temporalAdminFinite(source.capturedAtTs, null),
    temporalPolicyMode: temporalAdminPolicyMode(source.temporalPolicyMode, 'OBSERVE'),
    temporalPolicyVersion: temporalAdminFirst(source, ['temporalPolicyVersion'], TEMPORAL_POLICY_VERSION),
    activeTemporalGenerationId: temporalAdminFirst(source, ['activeTemporalGenerationId'], null),
    evaluatedDayOfWeek: temporalAdminFirst(source, ['evaluatedDayOfWeek'], null),
    evaluatedSessionBucket: temporalAdminFirst(source, ['evaluatedSessionBucket'], null),
    evaluatedIsWeekend: temporalAdminBool(source.evaluatedIsWeekend, false),
    dayOfWeekDecision: temporalAdminActiveDecision(source.dayOfWeekDecision, 'INHERIT_GLOBAL'),
    sessionDecision: temporalAdminActiveDecision(source.sessionDecision, 'INHERIT_GLOBAL'),
    weekendDecision: temporalAdminFirst(source, ['weekendDecision'], null),
    exactSelected75ChildMatch: temporalAdminBool(source.exactSelected75ChildMatch, false),
    globalFamilyGate: temporalAdminFirst(source, ['globalFamilyGate', 'globalGate'], null),
    currentFitEligible: temporalAdminBool(source.currentFitEligible, false),
    cooldownBlocked: temporalAdminBool(source.cooldownBlocked, false),
    duplicateBlocked: temporalAdminBool(source.duplicateBlocked, false),
    wouldPublishWithoutTemporal: temporalAdminBool(source.wouldPublishWithoutTemporal, false),
    temporalWouldBlock: temporalAdminBool(source.temporalWouldBlock, false),
    temporallyAllowed: temporalAdminBool(
      temporalAdminFirst(source, ['temporallyAllowed', 'temporalAllowed'], true), true
    ),
    temporalBlockReasons: Array.isArray(source.temporalBlockReasons)
      ? source.temporalBlockReasons.map(String)
      : []
  };
}

function temporalAdminPublication(record = {}, type = 'ENTRY') {
  const row = temporalAdminObject(record);
  const keys = type === 'ENTRY'
    ? ['entryPublicationResult', 'entryPublicationAttempt', 'discordEntryPublication']
    : ['exitPublicationResult', 'exitPublicationAttempt', 'discordExitPublication'];
  let source = {};
  for (const key of keys) {
    const candidate = temporalAdminObject(row[key]);
    if (Object.keys(candidate).length > 0) {
      source = candidate;
      break;
    }
  }
  if (Object.keys(source).length === 0) return null;
  const attempted = temporalAdminBool(
    temporalAdminFirst(source, ['attempted', 'webhookAttempted'], false), false
  );
  const rawSucceeded = temporalAdminFirst(source, ['succeeded', 'successfullyPosted', 'webhookSucceeded'], null);
  const succeeded = attempted ? temporalAdminBool(rawSucceeded, false) : null;
  return {
    publicationType: type,
    attempted,
    succeeded,
    discordChannelAlias: temporalAdminFirst(source, ['discordChannelAlias', 'channelAlias'], null),
    messageReference: temporalAdminFirst(source, ['messageReference', 'messageId'], null),
    statusCode: temporalAdminFinite(temporalAdminFirst(source, ['statusCode', 'webhookResponseStatus'], null), null),
    errorCode: temporalAdminFirst(source, ['errorCode'], null),
    attemptedTs: temporalAdminFinite(temporalAdminFirst(source, ['attemptedTs', 'attemptedAtTs'], null), null),
    completedTs: temporalAdminFinite(temporalAdminFirst(source, ['completedTs', 'completedAtTs'], null), null),
    durationMs: temporalAdminFinite(source.durationMs, null),
    secretsExcluded: true
  };
}

function buildTemporalAdminEnvelope(record = {}, fallbackTs = Date.now()) {
  const row = temporalAdminObject(record);
  const entry = temporalAdminContextFromRecord(row, 'entry', fallbackTs);
  const exit = temporalAdminContextFromRecord(row, 'exit', fallbackTs);
  const activeGenerationSource = row.activeTemporalGeneration || row.activeTemporalProfile || {
    activeTemporalGenerationId: row.activeTemporalGenerationId,
    generationCutoffTs: row.activeTemporalGenerationCutoffTs,
    generationStatus: row.activeTemporalGenerationStatus
  };
  const nextGenerationSource = row.nextTemporalGeneration || row.nextTemporalProfile || {
    nextTemporalGenerationId: row.nextTemporalGenerationId,
    generationCutoffTs: row.nextTemporalGenerationCutoffTs,
    generationStatus: row.nextTemporalGenerationStatus
  };
  const activeGeneration = temporalAdminNormalizeGeneration(activeGenerationSource, 'MISSING', fallbackTs);
  const nextGeneration = temporalAdminNormalizeGeneration(nextGenerationSource, 'MISSING', fallbackTs);
  const projection = temporalAdminProjectionSource(row);
  const entryDay = entry.entryDayOfWeekUtc;
  const entrySession = entry.entrySessionBucket;
  const dayDecision = temporalAdminProjectionDecision(projection, 'dayOfWeek', entryDay);
  const sessionDecision = temporalAdminProjectionDecision(projection, 'session', entrySession);
  const weekendApproved = entry.entryIsWeekend
    ? temporalAdminWeekendApproval(projection, entryDay)
    : false;
  const generationUnavailable = ['MISSING', 'CORRUPT', 'INVALID', 'VERSION_INCOMPATIBLE', 'EXPIRED']
    .includes(activeGeneration.generationStatus);
  const temporalBlockReasons = [];
  if (generationUnavailable) temporalBlockReasons.push('TEMPORAL_GENERATION_UNAVAILABLE');
  if (dayDecision === 'VETO_ACTIVE') temporalBlockReasons.push('DAY_VETO_ACTIVE');
  if (sessionDecision === 'VETO_ACTIVE') temporalBlockReasons.push('SESSION_VETO_ACTIVE');
  if (entry.entryIsWeekend && !weekendApproved) temporalBlockReasons.push('WEEKEND_NOT_APPROVED');
  const policyMode = temporalAdminResolvedPolicyMode(row);
  const temporalWouldBlock = temporalBlockReasons.length > 0;
  return {
    architectureVersion: 'SHORT_TEMPORAL_ADMIN_PROJECTION_V2',
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    temporalStatsVersion: TEMPORAL_STATS_VERSION,
    temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
    temporalAggregationVersion: TEMPORAL_AGGREGATION_VERSION,
    temporalGenerationVersion: TEMPORAL_GENERATION_VERSION,
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    temporalStatsEnabled: temporalAdminStatsEnabled(row),
    temporalPolicyMode: policyMode,
    policyModes: TEMPORAL_POLICY_MODES,
    gateWindow: {
      maxOutcomes: TEMPORAL_GATE_WINDOW_MAX_OUTCOMES,
      maxAgeDays: TEMPORAL_GATE_WINDOW_MAX_AGE_DAYS,
      vetoMinCompleted: TEMPORAL_VETO_MIN_COMPLETED,
      weekendApprovalMinCompleted: TEMPORAL_WEEKEND_APPROVAL_MIN_COMPLETED
    },
    freshness: {
      generationMaxAgeDays: TEMPORAL_GENERATION_MAX_AGE_DAYS,
      vetoStaleDays: TEMPORAL_VETO_STALE_DAYS,
      weekendApprovalFreshnessDays: TEMPORAL_WEEKEND_FRESHNESS_DAYS
    },
    entryContext: {
      ...entry,
      temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
      marketEventClusterId: temporalAdminMarketEventClusterId(row, entry.entryTs)
    },
    exitContext: exit,
    temporalStats: temporalAdminNormalizeStats(row),
    activeTemporalGeneration: activeGeneration,
    nextTemporalGeneration: nextGeneration,
    runtimeProjection: {
      activeTemporalGenerationId: activeGeneration.generationId,
      evaluatedDayOfWeek: entryDay,
      evaluatedSessionBucket: entrySession,
      evaluatedIsWeekend: entry.entryIsWeekend,
      dayOfWeekDecision: dayDecision,
      sessionDecision,
      weekendApproved,
      temporalWouldBlock,
      temporalBlockReasons,
      enforceWouldBlock: policyMode === 'ENFORCE' && temporalWouldBlock,
      observeOnly: policyMode === 'OBSERVE'
    },
    entryDecisionSnapshot: temporalAdminDecisionSnapshot(row),
    entryPublicationResult: temporalAdminPublication(row, 'ENTRY'),
    exitPublicationResult: temporalAdminPublication(row, 'EXIT'),
    invariants: {
      exact75ChildFamilyIdentityPreserved: true,
      temporalContextExcludedFromFamilyId: true,
      scannerDoesNotApplyTemporalGate: true,
      virtualLearningNeverBlocked: true,
      exitPublicationNeverBlockedByTemporal: true,
      longRootTouched: false
    }
  };
}

function applyTemporalAdminHeaders(res, record = {}) {
  if (!res || typeof res.setHeader !== 'function') return;
  const envelope = buildTemporalAdminEnvelope(record);
  res.setHeader('X-Temporal-Context-Version', TEMPORAL_CONTEXT_VERSION);
  res.setHeader('X-Temporal-Stats-Version', TEMPORAL_STATS_VERSION);
  res.setHeader('X-Temporal-Policy-Version', TEMPORAL_POLICY_VERSION);
  res.setHeader('X-Temporal-Aggregation-Version', TEMPORAL_AGGREGATION_VERSION);
  res.setHeader('X-Temporal-Generation-Version', TEMPORAL_GENERATION_VERSION);
  res.setHeader('X-Temporal-Stats-Enabled', String(envelope.temporalStatsEnabled));
  res.setHeader('X-Temporal-Policy-Mode', envelope.temporalPolicyMode);
  res.setHeader('X-Weekend-Policy-Version', WEEKEND_POLICY_VERSION);
  res.setHeader('X-Session-Policy-Version', SESSION_POLICY_VERSION);
}


export default async function handler(req, res) {
    applyTemporalAdminHeaders(res);
const startedAt = now();

res.setHeader('Cache-Control', 'no-store, max-age=0');
res.setHeader('X-Admin-Overview-Mode', 'short-only-75-child-persistent-virtuallearning-v1');
res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
res.setHeader('X-Short-Only', 'true');
res.setHeader('X-Long-Disabled', 'true');
res.setHeader('X-Virtual-Only', 'true');

res.setHeader('X-Virtual-Learning-Forced', 'true');
res.setHeader('X-Net-Outcomes-Only', 'true');
res.setHeader('X-Manual-Selection-Only', 'true');
res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
res.setHeader('X-Discord-Selection-Rule',
'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID_ONLY');
res.setHeader('X-True-Micro-Family-Schema', TRUE_MICRO_SCHEMA);
res.setHeader('X-Learning-Granularity', LEARNING_GRANULARITY);
res.setHeader('X-Real-Orders-Disabled', 'true');
res.setHeader('X-Bitget-Orders-Disabled', 'true');
res.setHeader('X-Exchange-Calls-Disabled', 'true');
res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
res.setHeader('X-Week-Reset-Disabled', 'true');
res.setHeader('X-Redis-Namespace', SHORT_NAMESPACE);
res.setHeader('X-Long-Root-Touched', 'false');

if (req.method !== 'GET') {
return methodNotAllowed(res);
}

try {
const durable = getDurableRedis();
const volatile = getVolatileRedis();

const weekKey = PERSISTENT_LEARNING_KEY;
const currentWeekKey = PERSISTENT_LEARNING_KEY;
const previousWeekKey = PERSISTENT_LEARNING_KEY;

const [
latestScanRead,
tradeMetaRead,
positionsRead,
currentMicrosRead,
previousMicrosRead,
rotationRead,
discordLogsRead
] = await Promise.all([
safeRead(
'latestScan',
() => getJson(volatile, SHORT_KEYS.scan.latest, null),
null
),
safeRead(

'tradeMeta',
() => getJson(durable, SHORT_KEYS.trade.runMeta, null),
null
),

safeRead(
'openPositions',
() => getOpenPositions({
tradeSide: TARGET_TRADE_SIDE,
side: TARGET_DASHBOARD_SIDE,
namespace: SHORT_NAMESPACE,
keyPrefix: SHORT_KEY_PREFIX,
virtualOnly: true
}),
[]
),

safeRead(
'persistentLearningMicros',
() => getWeekMicros(PERSISTENT_LEARNING_KEY),
{}
),

safeRead(
'previousWeekMicrosDisabledPersistentLearning',
() => getWeekMicros(PERSISTENT_LEARNING_KEY),
{}
),

safeRead(
'rotationDashboard',
() => getRotationDashboard({
tradeSide: TARGET_TRADE_SIDE,
side: TARGET_DASHBOARD_SIDE,
weekKey: PERSISTENT_LEARNING_KEY,
namespace: SHORT_NAMESPACE,
keyPrefix: SHORT_KEY_PREFIX
}),
{
active: null,
next: null,
validFrom: null,
activeRows: [],

nextRows: [],
activeCount: 0,
nextCount: 0
}
),

safeRead(
'discordLogs',
() => readJsonLogs(durable, SHORT_KEYS.discord.logList, 10),
[]
)
]);

const latestScan = normalizeLatestScan(latestScanRead.value);
const tradeMeta = tradeMetaRead.value || null;
const tradeSummary = buildTradeSummary(tradeMeta);

const rawPositions = asArray(positionsRead.value);
const positionSummary = buildPositionSummary(rawPositions);

const currentMicros = currentMicrosRead.value || {};
const previousMicros = previousMicrosRead.value || {};

const rawRotationDashboard = rotationRead.value || {};
const rotationDashboard = compactRotationDashboard(rawRotationDashboard);

const activeRotation = rotationDashboard.active || null;
const nextRotation = rotationDashboard.next || null;

const activeMicroFamilyIds = activeRotation?.microFamilyIds || [];
const activeMacroFamilyIds = activeRotation?.macroFamilyIds || [];

const currentMicroSummary = summarizeMicros(currentMicros);
const previousMicroSummary = summarizeMicros(previousMicros);
const taxonomySummary = buildTaxonomySummary(currentMicros,
activeMicroFamilyIds);

const rawDiscordLogs = Array.isArray(discordLogsRead.value)

? discordLogsRead.value
: [];

const discordLogs = rawDiscordLogs
.map(normalizeDiscordLog)
.filter((log) => log.rawInferredTradeSide !== OPPOSITE_TRADE_SIDE)
.filter((log) => !log.trueMicroFamilyId ||
isSelectableTrueMicroId(log.trueMicroFamilyId))
.map((log) => normalizeShortSide(log));

const warnings = [
latestScanRead,
tradeMetaRead,
positionsRead,
currentMicrosRead,
previousMicrosRead,
rotationRead,
discordLogsRead
]
.filter((row) => !row.ok)
.map((row) => ({
source: row.label,
error: row.error
}));

const longIgnored = {
positions: positionSummary.ignoredLongPositions,
currentWeekMicroFamilies: countLongMapOrArray(currentMicros),
previousWeekMicroFamilies: countLongMapOrArray(previousMicros),
scannerCandidates: latestScan?.longCandidatesIgnored || 0,
tradeActions: tradeSummary.longActionsIgnored || 0,
discordLogs: rawDiscordLogs.filter((row) =>
inferTradeSide(normalizeDiscordLog(row)) === OPPOSITE_TRADE_SIDE).length,
activeRotationRows: activeRotation?.longMicroFamiliesIgnored || 0,
nextRotationRows: nextRotation?.longMicroFamiliesIgnored || 0
};

const parentRowsHidden = sourceEntries(currentMicros)
.filter(([key, row]) => {
const id = String(
row?.trueMicroFamilyId ||
row?.learningMicroFamilyId ||
row?.analyzeMicroFamilyId ||

row?.microFamilyId ||
key ||
''
);

return isFixedShortParentMicroId(id);
})
.length;

const scannerFingerprintRowsHidden = sourceEntries(currentMicros)
.filter(([key, row]) => {
const id = String(
row?.trueMicroFamilyId ||
row?.learningMicroFamilyId ||
row?.analyzeMicroFamilyId ||
row?.microFamilyId ||
key ||
''
);

return (
isScannerFingerprintId(id) ||
isScannerFingerprintId(row?.scannerMicroFamilyId) ||
isScannerFingerprintId(row?.coarseMicroFamilyId)
);
})
.length;

const executionFingerprintRowsHidden = sourceEntries(currentMicros)
.filter(([key, row]) => {
const id = String(
row?.trueMicroFamilyId ||
row?.learningMicroFamilyId ||
row?.analyzeMicroFamilyId ||
row?.microFamilyId ||
key ||
''
);

return (
isExecutionFingerprintId(id) ||
isExecutionFingerprintId(row?.executionMicroFamilyId) ||

isExecutionFingerprintId(row?.coarseMicroFamilyId)
);
})
.length;

return res.status(200).json({
ok: true,
...modeFlags(),

weekKey,
currentWeekKey: weekKey,
previousWeekKey,

persistentLearningKey: PERSISTENT_LEARNING_KEY,
requestedLearningKey: PERSISTENT_LEARNING_KEY,
activeLearningStoreKey:
`${SHORT_KEY_PREFIX}ANALYZE:WEEK:${PERSISTENT_LEARNING_KEY}:MICROS`,
weekResetDisabled: true,
isoWeekLearningDisabled: true,
previousWeekComparisonDisabled: true,
shortKeys: {
namespace: SHORT_NAMESPACE,
prefix: SHORT_KEY_PREFIX,
scanLatest: SHORT_KEYS.scan.latest,
tradeRunMeta: SHORT_KEYS.trade.runMeta,
discordLogList: SHORT_KEYS.discord.logList
},

taxonomy: {
parentCount: 15,
selectableChildCount: 75,
setups: SETUP_ORDER,
regimes: REGIME_ORDER,
confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
childFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
selectableIdsAreChildrenOnly: true,
parentIdsAreMetadataOnly: true
},

taxonomySummary,

latestScan,
latestScannerSnapshotId: latestScan?.snapshotId || null,

scannerCandidates: latestScan?.candidatesCount || 0,
shortScannerCandidates: latestScan?.shortCandidatesCount ||
latestScan?.candidatesCount || 0,

tradeMeta,
tradeSummary,

runMeta: tradeMeta,
latestRunMeta: tradeMeta
? {
runId: tradeMeta.runId || null,
shadowExits: tradeMeta.shadowExits || [],
virtualExits: tradeMeta.virtualExits || tradeMeta.exits || [],
actionCounts: tradeSummary.actionCounts || {},
skipReason: tradeSummary.skipReason || null
}
: null,

openPositions: positionSummary.positionsCount,
positionsCount: positionSummary.positionsCount,
rawPositionsCount: positionSummary.rawPositionsCount,
virtualPositions: positionSummary.virtualPositions,
selectedPositions: positionSummary.selectedPositions,
exactSelectedTrueMicroPositions:
positionSummary.exactSelectedTrueMicroPositions,

ignoredLongPositions: positionSummary.ignoredLongPositions,
ignoredUnknownPositions: positionSummary.ignoredUnknownPositions,
unknownPositions: positionSummary.unknownPositions,

positions: positionSummary.positions,

currentWeekMicroFamilies: currentMicroSummary.rows,
previousWeekMicroFamilies: previousMicroSummary.rows,

persistentMicroFamilies: currentMicroSummary.rows,
persistentMicroSummary: currentMicroSummary,

currentMicroSummary,
previousMicroSummary,

observingMicroFamilies: currentMicroSummary.observationOnlyFamilies,
completedMicroFamilies: currentMicroSummary.completedFamilies,
activeLearningMicroFamilies: currentMicroSummary.activeLearningFamilies,
earlyOutcomeMicroFamilies: currentMicroSummary.earlyOutcomeFamilies,

activeRotation,
nextRotation,

activeRotationId: activeRotation?.rotationId || null,
nextRotationId: nextRotation?.rotationId || null,

activeRotationCount: activeRotation?.count || 0,
nextRotationCount: nextRotation?.count || 0,

activeMicroFamilyIds,
nextMicroFamilyIds: nextRotation?.microFamilyIds || [],

activeMacroFamilyIds,
nextMacroFamilyIds: nextRotation?.macroFamilyIds || [],

bestShort: activeRotation?.bestShort || null,
bestLong: null,
nextBestShort: nextRotation?.bestShort || null,
nextBestLong: null,

rotationDashboard,
discordLogs,
discordSummary: summarizeDiscordLogs(discordLogs),

hiddenMetadataRows: {
parentRowsHidden,

scannerFingerprintRowsHidden,
executionFingerprintRowsHidden
},

longIgnored,
warnings,

perf: {
durationMs: now() - startedAt,
source: 'short_only_75_child_persistent_virtual_learning_overview'
},

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
