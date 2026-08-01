// ================= FILE: src/market/fakeBreakout.js =================
import {
getRecentRange,
calcVolumeExpansion,
candleBodyPct
} from './indicators.js';
import {
safeNumber,
sideToTradeSide
} from '../utils.js';
import {
buildTemporalContext,
buildMarketEventClusterId,
temporalRuntimeConfig,
TEMPORAL_CONTEXT_VERSION,
TEMPORAL_POLICY_VERSION,
WEEKEND_POLICY_VERSION,
SESSION_POLICY_VERSION,
TEMPORAL_GENERATION_SCHEMA_VERSION
} from '../analyze/scoring.js';
const DEFAULT_LOOKBACK = 24;
const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_SCANNER_SIDE = 'bear';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';
const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';
const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY =
'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const RETEST_TOLERANCE_PCT = 0.004;
const BREAKOUT_BUFFER_PCT = 0.0015;
const WICK_REJECT_THRESHOLD = 0.45;
const WEAK_BODY_THRESHOLD = 0.35;
const EXHAUSTION_VOLUME_EXPANSION = 1.4;
const SHORT_TOKENS = new Set([
'SHORT',

'BEAR',
'BEARISH',
'SELL',
'ASK',
'DOWN',
'DOWNSIDE',
'RED'
]);
const LONG_TOKENS = new Set([
'LONG',
'BULL',
'BULLISH',
'BUY',
'BID',
'UP',
'UPSIDE',
'GREEN'
]);
function now() {
return Date.now();
}
export function buildTemporalContextUtc(value = Date.now(), metadata = {}) {
const context = buildTemporalContext(value);
const runtime = temporalRuntimeConfig();
const marketEventClusterId = buildMarketEventClusterId(metadata, context);
return {
...context,
...runtime,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
weekendMode: runtime.effectiveTemporalPolicyMode,
sessionMode: runtime.effectiveTemporalPolicyMode,
sessionPolicyObservedOnly: runtime.effectiveTemporalPolicyMode === 'OBSERVE',
marketEventClusterId,
scannerTemporalContext: {
...context,
marketEventClusterId
},
scannerContextTs: context.contextTs,
scannerTemporalContextVersion: TEMPORAL_CONTEXT_VERSION,
scannerTemporalContextIsPreEntryMetadata: true,
entryTemporalContextAuthoritative: false,
entryContextImmutable: false,
temporalPolicyEvaluatedHere: false,
temporalWouldBlock: null,
finalDiscordEntryAllowed: null,
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
familyIdentityIncludesTemporalBucket: false,
temporalMetadataSource: 'FAKE_BREAKOUT_SCANNER_METADATA'
};
}
function upper(value) {
return String(value || '').trim().toUpperCase();
}
function shortMachineFlags() {
const runtime = temporalRuntimeConfig();
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
directionalSide: TARGET_DASHBOARD_SIDE,
inferredDirectionalSide: TARGET_DASHBOARD_SIDE,
marketSide: TARGET_DASHBOARD_SIDE,
shortOnly: true,
longDisabled: true,
longOnly: false,
shortDisabled: false,
virtualLearning: true,
virtualOnly: true,
virtualTracked: true,
shadowOnly: true,
realTrade: false,
realOrder: false,
exchangeOrder: false,
bitgetOrderPlaced: false,
noRealOrders: true,
realOrdersDisabled: true,
bitgetOrdersDisabled: true,
exchangeOrdersDisabled: true,
exchangeCallsDisabled: true,

scannerBearishOnly: true,
...runtime,
temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
temporalPolicyVersion: TEMPORAL_POLICY_VERSION,
weekendPolicyVersion: WEEKEND_POLICY_VERSION,
sessionPolicyVersion: SESSION_POLICY_VERSION,
temporalGenerationSchemaVersion: TEMPORAL_GENERATION_SCHEMA_VERSION,
weekendMode: runtime.effectiveTemporalPolicyMode,
sessionMode: runtime.effectiveTemporalPolicyMode,
sessionPolicyObservedOnly: runtime.effectiveTemporalPolicyMode === 'OBSERVE',
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
scannerTemporalContextIsPreEntryMetadata: true,
entryTemporalContextAuthoritative: false,
temporalPolicyEvaluatedHere: false,
familyIdentityIncludesTemporalBucket: false,
scannerDoesNotTrade: true,
scannerDoesNotSelectMicroFamilies: true,
scannerDoesNotSendDiscord: true,
scannerDoesNotWriteLearningFamilies: true,
scannerFingerprintRole: 'METADATA_ONLY',
scannerFingerprintsMetadataOnly: true,
scannerFingerprintsUsedAsLearningFamily: false,
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
fixedTaxonomyPreferred: true,
trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
parentLearningEnabled: true,
childLearningEnabled: true,
learningGranularity: LEARNING_GRANULARITY,
parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

selectionGranularity: 'EXACT_75_CHILD',
fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',
completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
scoringRSource: 'netR',
winsLossesFlatsSource: 'netR',
winrateDefinition: 'netR > 0',
avgRSource: 'netR',
totalRSource: 'netR',
avgCostRShown: true,
manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
discordOnlyForExactTrueMicroMatch: true,
bucketGranularity: 'LOW_MID_HIGH',
bucketsCoarseOnly: true,
riskTradeSide: TARGET_TRADE_SIDE,
shortRiskShape: 'tp < entry < sl',
validShortRiskShape: 'entry > 0 && tp < entry && entry < sl',
validShortGeometry: 'tp < entry < sl',
riskGeometryRule: 'SHORT: tp < entry < sl',
tpHitRule: 'SHORT: price <= tp',
slHitRule: 'SHORT: price >= initialSl',
grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',
shortExitRules: {
tp: 'price <= tp',
sl: 'price >= initialSl',
timeStop: 'TIME_STOP'
},
currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
currentFitSoftOnly: true,
currentFitBlocksLearning: false,
learningRemainsBroad: true,
redisNamespace: SHORT_NAMESPACE,
redisKeyPrefix: SHORT_KEY_PREFIX,
persistentLearningKey: PERSISTENT_LEARNING_KEY,
redisKeysSeparatedFromLongRoot: true,
longRootTouched: false
};
}

function learningIdentityPlaceholders() {
return {
trueMicroFamilyId: null,
microFamilyId: null,
childTrueMicroFamilyId: null,
parentTrueMicroFamilyId: null,
coarseMicroFamilyId: null,
analyzeMicroFamilyId: null,
learningMicroFamilyId: null,
broadTrueMicroFamilyId: null,
fixedTaxonomyMicroFamilyId: null,
scannerMicroFamilyId: null,
scannerFamilyId: null,
scannerDefinition: null,
scannerDefinitionParts: [],
executionMicroFamilyId: null,
executionFingerprintHash: null,
executionFingerprintParts: [],
executionFingerprintSchema: null,
scannerBucketRole: 'DEBUG_METADATA_ONLY',
legacy25BucketRole: 'DEBUG_METADATA_ONLY',
coinNameRole: 'DEBUG_METADATA_ONLY',
hashesRole: 'DEBUG_METADATA_ONLY'
};
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
.replaceAll('SHORT_ENABLED_FALSE', '')
.replaceAll('SHORT_ONLY_FALSE', '')
.replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
.replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
.replaceAll('LONG_DISABLED_TRUE', 'SHORT')
.replaceAll('LONGDISABLED_TRUE', 'SHORT')
.replaceAll('BLOCK_LONG_TRUE', 'SHORT')
.replaceAll('BLOCK_LONG', 'SHORT')

.replaceAll('LONG_DISABLED', 'SHORT')
.replaceAll('LONGDISABLED', 'SHORT')
.replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
.replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
.replaceAll('SHORT_DISABLED_TRUE', 'LONG')
.replaceAll('SHORTDISABLED_TRUE', 'LONG')
.replaceAll('BLOCK_SHORT_TRUE', 'LONG')
.replaceAll('BLOCK_SHORT', 'LONG')
.replaceAll('SHORT_DISABLED', 'LONG')
.replaceAll('SHORTDISABLED', 'LONG')
.replaceAll('SHORT_ONLY_MODE', 'SHORT')
.replaceAll('SHORT_ONLY', 'SHORT')
.replaceAll('SHORT-ONLY', 'SHORT')
.replaceAll('LONG_ONLY_MODE', 'LONG')
.replaceAll('LONG_ONLY', 'LONG')
.replaceAll('LONG-ONLY', 'LONG');
}
function normalizedSignalText(value = '') {
return cleanSideText(value)
.replace(/[^A-Z0-9]+/g, '_')
.replace(/^_+|_+$/g, '');
}
function hasSignalPattern(value = '', patterns = []) {
const text = normalizedSignalText(value);
if (!text) return false;
return patterns.some((pattern) => (
text === pattern ||
text.startsWith(`${pattern}_`) ||
text.endsWith(`_${pattern}`) ||
text.includes(`_${pattern}_`)
));
}
function textHasShortSignal(value = '') {
const raw = cleanSideText(value);
if (!raw) return false;
if (SHORT_TOKENS.has(raw)) return true;
return hasSignalPattern(raw, [
'SHORT',
'BEAR',
'BEARISH',

'SELL',
'SIDE_SHORT',
'TRADE_SIDE_SHORT',
'TRADESIDE_SHORT',
'POSITION_SIDE_SHORT',
'POSITIONSIDE_SHORT',
'DIRECTION_SHORT',
'SIDE_BEAR',
'TRADE_SIDE_BEAR',
'DIRECTION_BEAR',
'SIDE_SELL',
'DIRECTION_SELL',
'MICRO_SHORT',
'FAMILY_SHORT'
]);
}
function textHasLongSignal(value = '') {
const raw = cleanSideText(value);
if (!raw) return false;
if (LONG_TOKENS.has(raw)) return true;
return hasSignalPattern(raw, [
'LONG',
'BULL',
'BULLISH',
'BUY',
'SIDE_LONG',
'TRADE_SIDE_LONG',
'TRADESIDE_LONG',
'POSITION_SIDE_LONG',
'POSITIONSIDE_LONG',
'DIRECTION_LONG',
'SIDE_BULL',
'TRADE_SIDE_BULL',
'DIRECTION_BULL',
'SIDE_BUY',
'DIRECTION_BUY',
'MICRO_LONG',
'FAMILY_LONG'
]);
}
function normalizeSide(side) {
const raw = cleanSideText(side);

if (!raw) return 'unknown';
const direct = sideToTradeSide(raw);
if (direct === TARGET_TRADE_SIDE) return TARGET_SCANNER_SIDE;
if (direct === OPPOSITE_TRADE_SIDE) return 'long_disabled';
const shortHit = textHasShortSignal(raw);
const longHit = textHasLongSignal(raw);
if (shortHit && !longHit) return TARGET_SCANNER_SIDE;
if (longHit && !shortHit) return 'long_disabled';
if (shortHit && longHit) {
if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_SCANNER_SIDE;
if (raw.includes('MICRO_SHORT_')) return TARGET_SCANNER_SIDE;
if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG'))
return 'long_disabled';
if (raw.includes('MICRO_LONG_')) return 'long_disabled';
return TARGET_SCANNER_SIDE;
}
if (raw === TARGET_DASHBOARD_SIDE.toUpperCase()) return TARGET_SCANNER_SIDE;
return 'unknown';
}
function normalizeBtcState(btcState) {
const state = upper(btcState || 'NEUTRAL');
if (state === 'STRONG_BEAR') return 'STRONG_BEARISH';
if (state === 'STRONG_BULL') return 'STRONG_BULLISH';
if (state === 'BEAR' || state === 'DOWN') return 'BEARISH';
if (state === 'BULL' || state === 'UP') return 'BULLISH';
return state;
}
function isBtcAgainstBear(btcState) {
return ['BULLISH', 'STRONG_BULLISH', 'BULL', 'UP'].includes(upper(btcState));
}
function isBtcWithBear(btcState) {
return ['BEARISH', 'STRONG_BEARISH', 'BEAR', 'DOWN'].includes(upper(btcState));
}
function scannerBucketFromBreakout({
fake,
fakeBreakoutRisk,
validBreakout,
sweptHigh,
retestConfirmed,
pullbackConfirmed,
volumeExpansion
}) {
if (fake) return 'BEAR_FAKE_BREAKDOWN_LOW_SWEEP';
if (fakeBreakoutRisk) return 'BEAR_BREAKDOWN_RISK';
if (validBreakout && retestConfirmed) return 'BEAR_BREAKDOWN_RETEST_CONFIRMED';
if (validBreakout) return 'BEAR_VALID_BREAKDOWN';
if (sweptHigh) return 'BEAR_LOW_SWEEP';
if (pullbackConfirmed) return 'BEAR_PULLBACK_IN_RANGE';
if (volumeExpansion >= EXHAUSTION_VOLUME_EXPANSION) return 'BEAR_VOLUME_EXPANSION';
return 'BEAR_RANGE_NEUTRAL';
}
function baseResult(reason = null, contextTs = now(), temporalMetadata = {}) {
return {
fakeBreakout: false,
fakeBreakdown: false,
fakeBreakoutRisk: false,
fakeBreakdownRisk: false,
fakeBreakoutReason: null,
fakeBreakdownReason: null,
breakoutType: 'UNKNOWN',
breakdownType: 'UNKNOWN',
breakoutValid: false,
breakdownValid: false,
shortContinuation: false,
longContinuation: false,
avoidShort: false,
avoidLong: false,
pullbackConfirmed: false,
sweepConfirmed: false,
retestConfirmed: false,
setupTypeHint: null,
regimeBucketHint: null,
confirmationProfileHint: null,
analyzeSetupHintSource: 'MARKET_METADATA_ONLY',
rangeHigh: null,
rangeLow: null,
volumeExpansion: 0,
scannerBucket: reason || 'BEAR_BREAKDOWN_UNCLASSIFIED',
legacy25Bucket: null,
reason,
createdAt: contextTs,
...buildTemporalContextUtc(contextTs, temporalMetadata),
...learningIdentityPlaceholders(),
...shortMachineFlags()
};
}
function emptyResult(
reason = 'INSUFFICIENT_DATA',
contextTs = now(),
temporalMetadata = {}
) {
return {
...baseResult(reason, contextTs, temporalMetadata),
breakoutType: 'NONE',
breakdownType: 'NONE',
scannerBucket: reason,
side: 'unknown',
tradeSide: 'UNKNOWN',
positionSide: 'UNKNOWN',
direction: 'UNKNOWN',
scannerSide: 'UNKNOWN',
actualScannerSide: 'UNKNOWN',
analysisSide: 'UNKNOWN',
directionalSide: 'unknown',
inferredDirectionalSide: 'unknown',
marketSide: 'unknown'
};
}
function pctDistance(a, b) {
const x = safeNumber(a, 0);
const y = safeNumber(b, 0);
if (x <= 0 || y <= 0) return Infinity;
return Math.abs(x - y) / Math.max(x, y);
}
function normalizeCandle(candle = {}) {
return {
...candle,
open: safeNumber(candle.open, 0),
high: safeNumber(candle.high, 0),
low: safeNumber(candle.low, 0),
close: safeNumber(candle.close, 0),
volume: safeNumber(candle.volume ?? candle.baseVolume ?? candle.vol, 0),

ts: safeNumber(candle.ts ?? candle.time ?? candle.timestamp, 0)
};
}
function validCandle(candle = {}) {
return (
safeNumber(candle.open, 0) > 0 &&
safeNumber(candle.high, 0) > 0 &&
safeNumber(candle.low, 0) > 0 &&
safeNumber(candle.close, 0) > 0 &&
safeNumber(candle.high, 0) >= safeNumber(candle.low, 0)
);
}
function lowerWickPct(candle = {}) {
const high = safeNumber(candle.high, 0);
const low = safeNumber(candle.low, 0);
const open = safeNumber(candle.open, 0);
const close = safeNumber(candle.close, 0);
const range = high - low;
if (range <= 0) return 0;
const bodyBottom = Math.min(open, close);
const wick = Math.max(0, bodyBottom - low);
return wick / range;
}
function inferSetupHint({
fake,
sweptHigh,
validBreakout,
retestConfirmed,
pullbackConfirmed,
volumeExpansion
}) {
if (fake || sweptHigh) return 'SWEEP_REVERSAL';
if (validBreakout && retestConfirmed) return 'RETEST';
if (pullbackConfirmed) return 'RETEST';
if (volumeExpansion >= EXHAUSTION_VOLUME_EXPANSION) return 'BREAKOUT';
return 'BREAKOUT';
}
function inferRegimeHint({
validBreakout,

volumeExpansion,
btcWith,
btcAgainst,
fakeBreakoutRisk
}) {
if (validBreakout && btcWith && volumeExpansion >= 1.15) return 'TREND';
if (fakeBreakoutRisk || btcAgainst) return 'CHOP';
if (volumeExpansion < 1.05) return 'SQUEEZE';
return 'CHOP';
}
function inferConfirmationProfileHint({
validBreakout,
fake,
fakeBreakoutRisk,
btcWith,
btcAgainst,
volumeExpansion,
wickReject,
weakBody,
retestConfirmed
}) {
if (validBreakout && btcWith && volumeExpansion >= 1.4 && retestConfirmed) {
return 'A_STRONG_ALIGN';
}
if (validBreakout && btcWith) return 'B_FLOW_ALIGN';
if (validBreakout && volumeExpansion >= 1.25) return 'C_VOLUME_ALIGN';
if (!fake && !fakeBreakoutRisk && !btcAgainst && !wickReject && !weakBody) {
return 'D_MIXED_OK';
}
return 'E_WEAK_CONTRA';
}
function analyzeBearBreakout({
last,
recentHigh,
recentLow,
volumeExpansion,
btcState,
contextTs = now(),
temporalMetadata = {}
}) {
const close = safeNumber(last.close, 0);
const high = safeNumber(last.high, 0);
const low = safeNumber(last.low, 0);
const lowerWick = lowerWickPct(last);
const body = candleBodyPct(last);
const sweptLow = low < recentLow && close > recentLow;
const closedBelowRange = close < recentLow * (1 - BREAKOUT_BUFFER_PCT);
const btcAgainst = isBtcAgainstBear(btcState);
const btcWith = isBtcWithBear(btcState);
const wickReject = lowerWick >= WICK_REJECT_THRESHOLD;
const weakBody = body <= WEAK_BODY_THRESHOLD;
const volumeExhaustion = volumeExpansion >= EXHAUSTION_VOLUME_EXPANSION;
const fake = sweptLow && wickReject && (volumeExhaustion || btcAgainst || weakBody);
const retestConfirmed =
pctDistance(close, recentLow) <= RETEST_TOLERANCE_PCT ||
pctDistance(high, recentLow) <= RETEST_TOLERANCE_PCT;
const pullbackConfirmed = close > recentLow && close < recentHigh;
const validBreakout = closedBelowRange && !wickReject && (btcWith || volumeExpansion >= 1.15);
const fakeBreakoutRisk = !fake && (sweptLow || (closedBelowRange && !btcWith));
const setupTypeHint = inferSetupHint({
fake,
sweptHigh: sweptLow,
validBreakout,
retestConfirmed,
pullbackConfirmed,
volumeExpansion
});
const regimeBucketHint = inferRegimeHint({
validBreakout,
volumeExpansion,
btcWith,
btcAgainst,
fakeBreakoutRisk
});
const confirmationProfileHint = inferConfirmationProfileHint({
validBreakout,
fake,
fakeBreakoutRisk,
btcWith,
btcAgainst,
volumeExpansion,
wickReject,
weakBody,
retestConfirmed
});
const scannerBucket = scannerBucketFromBreakout({
fake,
fakeBreakoutRisk,
validBreakout,
sweptHigh: sweptLow,
retestConfirmed,
pullbackConfirmed,
volumeExpansion
});
return {
...baseResult(null, contextTs, temporalMetadata),
fakeBreakout: false,
fakeBreakdown: fake,
fakeBreakoutRisk: false,
fakeBreakdownRisk: fakeBreakoutRisk,
fakeBreakoutReason: null,
fakeBreakdownReason: fake ? 'LOW_SWEEP_CLOSE_BACK_IN_RANGE' : null,
breakoutType: 'NONE',
breakdownType: fake ? 'FAKE_BREAKDOWN' : validBreakout ? 'VALID_BREAKDOWN' : 'NONE',
breakoutValid: false,
breakdownValid: validBreakout,
shortContinuation: validBreakout,
longContinuation: false,
avoidShort: fake || fakeBreakoutRisk,
avoidLong: false,
pullbackConfirmed,
sweepConfirmed: sweptLow,
retestConfirmed,
setupTypeHint,
regimeBucketHint,
confirmationProfileHint,
setupType: setupTypeHint,
regimeBucket: regimeBucketHint,
confirmationProfile: confirmationProfileHint,
rangeHigh: recentHigh,
rangeLow: recentLow,
volumeExpansion,
scannerBucket,
legacy25Bucket: scannerBucket,
details: {
recentHigh,
recentLow,
close,
high,
low,
lowerWick,
body,
volumeExpansion,
btcState,
btcAgainst,
btcWith,
sweptLow,
closedBelowRange,
wickReject,
weakBody,
volumeExhaustion,
validBreakdown: validBreakout,
fakeBreakdownRisk: fakeBreakoutRisk,
scannerBucket,
legacy25Bucket: scannerBucket,
setupTypeHint,
regimeBucketHint,
confirmationProfileHint,
...buildTemporalContextUtc(contextTs, temporalMetadata),
...learningIdentityPlaceholders(),
...shortMachineFlags()
}
};
}
export function detectFakeBreakout({
side,
candles15m,
btcState = 'NEUTRAL',
lookback = DEFAULT_LOOKBACK,
snapshotId = null,
scannerRunId = null,
marketCycleId = null,
marketEventClusterId = null
} = {}) {
const temporalMetadata = {
snapshotId,
scannerRunId,
marketCycleId,
marketEventClusterId
};
const rows = Array.isArray(candles15m)
? candles15m.filter(Boolean).map(normalizeCandle).filter(validCandle)
: [];
const lb = Math.max(5, Math.floor(Number(lookback) || DEFAULT_LOOKBACK));
if (rows.length < lb + 2) {
return emptyResult('INSUFFICIENT_CANDLES', now(), temporalMetadata);
}
const normalizedSide = normalizeSide(side);
if (normalizedSide === 'long_disabled') {
return emptyResult('LONG_DISABLED_SHORT_ONLY', now(), temporalMetadata);
}
if (normalizedSide !== TARGET_SCANNER_SIDE) {
return emptyResult('UNKNOWN_OR_NON_BEAR_SIDE', now(), temporalMetadata);
}
const last = rows.at(-1);
const prior = rows.slice(-(lb + 1), -1);
const { recentHigh, recentLow } = getRecentRange(prior, lb);
if (!last || recentHigh <= 0 || recentLow <= 0 || recentHigh <= recentLow) {
return emptyResult('INVALID_RANGE', now(), temporalMetadata);
}
const normalizedBtcState = normalizeBtcState(btcState);
const volumeExpansion = calcVolumeExpansion(rows, lb);
const contextTs = safeNumber(last.ts, 0) || now();
return analyzeBearBreakout({
last,
recentHigh,
recentLow,
volumeExpansion,
btcState: normalizedBtcState,
contextTs,
temporalMetadata
});
}

