// ================= FILE: src/analyze/microFamilies.js =================

import { CONFIG } from ‘../config.js’;
import {
getObRelation,
sideToTradeSide,
stableHash,
safeNumber
} from ‘../utils.js’;

const FALLBACK_MACRO_SCHEMA = ‘MF_V1’;
const FALLBACK_MICRO_SCHEMA = ‘MF_V2’;

const TARGET_TRADE_SIDE = ‘SHORT’;
const TARGET_DASHBOARD_SIDE = ‘bear’;
const OPPOSITE_TRADE_SIDE = ‘LONG’;

const EXECUTION_MICRO_SUFFIX = ‘XR’;
const EXECUTION_MICRO_HASH_LEN = 10;

/*
BELANGRIJKE WIJZIGING (taxonomie i.p.v. hash):

De echte Analyze learning-ID (trueMicroFamilyId) is NIET langer een hash
over ~25 buckets. Dat veroorzaakte families met 1 coin (astronomisch veel
unieke combinaties). In plaats daarvan vallen alle setups verplicht in een
klein, vast aantal families:

```
  MICRO_SHORT_{SETUP}_{REGIME}

  SETUP:  BREAKDOWN | RETEST | SWEEP_REVERSAL | CONTINUATION | COMPRESSION
  REGIME: TREND | CHOP | SQUEEZE
```

= 5 x 3 = 15 vaste families. Breed genoeg voor data, smal genoeg voor edge.

Alle oude buckets (rsi, flow, ob, spread, depth, funding, cost, etc.)
BLIJVEN behouden als metadata/debug in definitionParts en in de
execution-fingerprint. Ze bepalen alleen niet langer de IDENTITEIT.

Zo kun je per family genoeg observaties/outcomes opbouwen om te zien wat
werkt, en later nog steeds debuggen WAAROM een trade won of verloor.
*/
const LEARNING_GRANULARITY = ‘SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1’;

// Vaste taxonomie-dimensies (voor referentie/validatie).
const SETUP_TYPES = Object.freeze([
‘BREAKDOWN’,
‘RETEST’,
‘SWEEP_REVERSAL’,
‘CONTINUATION’,
‘COMPRESSION’
]);

const REGIME_BUCKETS = Object.freeze([
‘TREND’,
‘CHOP’,
‘SQUEEZE’
]);

const SHORT_TOKENS = new Set([
‘SHORT’,
‘BEAR’,
‘BEARISH’,
‘SELL’,
‘ASK’,
‘DOWN’,
‘DOWNSIDE’,
‘RED’
]);

const LONG_TOKENS = new Set([
‘LONG’,
‘BULL’,
‘BULLISH’,
‘BUY’,
‘BID’,
‘UP’,
‘UPSIDE’,
‘GREEN’
]);

function getMacroSchema() {
return String(
CONFIG?.analyze?.macroSchema ||
CONFIG?.analyze?.legacySchema ||
FALLBACK_MACRO_SCHEMA
).toUpperCase();
}

function getMicroSchema() {
return String(
CONFIG?.analyze?.microSchema ||
FALLBACK_MICRO_SCHEMA
).toUpperCase();
}

function shouldBuildExecutionFingerprintMetadata() {
return CONFIG.analyze?.buildExecutionFingerprintMetadata !== false;
}

function toUpper(value, fallback = ‘UNKNOWN’) {
const raw = String(value ?? ‘’).trim();

if (!raw) return fallback;

return raw.toUpperCase();
}

function boolToken(value) {
return Boolean(value) ? ‘YES’ : ‘NO’;
}

function normalizeToken(value, fallback = ‘NA’, maxLength = 56) {
const text = String(value ?? ‘’).trim();

if (!text) return fallback;

return text
.toUpperCase()
.replace(/[^A-Z0-9]+/g, ‘*’)
.replace(/^*+|_+$/g, ‘’)
.slice(0, maxLength) || fallback;
}

function cleanSideText(value = ‘’) {
return String(value || ‘’)
.trim()
.toUpperCase()
.replaceAll(‘LONG_DISABLED’, ‘’)
.replaceAll(‘LONGDISABLED’, ‘’)
.replaceAll(‘BLOCK_LONG’, ‘’)
.replaceAll(‘LONG_ENABLED_FALSE’, ‘’)
.replaceAll(‘LONG_ONLY_FALSE’, ‘’)
.replaceAll(‘SHORT_DISABLED_FALSE’, ‘’)
.replaceAll(‘SHORT_ONLY_MODE’, ‘SHORT’)
.replaceAll(‘SHORT_ONLY’, ‘SHORT’)
.replaceAll(‘SHORT-ONLY’, ‘SHORT’);
}

function normalizedSignalText(value = ‘’) {
return cleanSideText(value)
.replace(/[^A-Z0-9]+/g, ‘*’)
.replace(/^*+|_+$/g, ‘’);
}

function hasSignalPattern(value = ‘’, patterns = []) {
const text = normalizedSignalText(value);

if (!text) return false;

return patterns.some((pattern) => (
text === pattern ||
text.startsWith(`${pattern}_`) ||
text.endsWith(`_${pattern}`) ||
text.includes(`_${pattern}_`)
));
}

function hasShortSignal(value = ‘’) {
const text = normalizedSignalText(value);

if (!text) return false;
if (SHORT_TOKENS.has(text)) return true;

return hasSignalPattern(text, [
‘SHORT’,
‘BEAR’,
‘BEARISH’,
‘SELL’,
‘SIDE_SHORT’,
‘TRADE_SIDE_SHORT’,
‘TRADESIDE_SHORT’,
‘POSITION_SIDE_SHORT’,
‘POSITIONSIDE_SHORT’,
‘DIRECTION_SHORT’,
‘SIDE_BEAR’,
‘TRADE_SIDE_BEAR’,
‘DIRECTION_BEAR’,
‘SIDE_SELL’,
‘DIRECTION_SELL’,
‘MICRO_SHORT’,
‘FAMILY_SHORT’
]);
}

function hasLongSignal(value = ‘’) {
const text = normalizedSignalText(value);

if (!text) return false;
if (LONG_TOKENS.has(text)) return true;

return hasSignalPattern(text, [
‘LONG’,
‘BULL’,
‘BULLISH’,
‘BUY’,
‘SIDE_LONG’,
‘TRADE_SIDE_LONG’,
‘TRADESIDE_LONG’,
‘POSITION_SIDE_LONG’,
‘POSITIONSIDE_LONG’,
‘DIRECTION_LONG’,
‘SIDE_BULL’,
‘TRADE_SIDE_BULL’,
‘DIRECTION_BULL’,
‘SIDE_BUY’,
‘DIRECTION_BUY’,
‘MICRO_LONG’,
‘FAMILY_LONG’
]);
}

function tradeSideFromText(value = ‘’) {
const raw = cleanSideText(value);

if (!raw) return ‘UNKNOWN’;

const direct = sideToTradeSide(raw);

if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

const shortHit = hasShortSignal(raw);
const longHit = hasLongSignal(raw);

if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
if (shortHit && !longHit) return TARGET_TRADE_SIDE;
if (shortHit && longHit) return ‘MIXED’;

return ‘UNKNOWN’;
}

function normalizeTradeSideValue(value) {
const side = tradeSideFromText(value);

if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

return TARGET_TRADE_SIDE;
}

function inferSideFromValues(values = []) {
let hasShort = false;
let hasLong = false;

for (const value of values) {
const side = tradeSideFromText(value);

```
if (side === OPPOSITE_TRADE_SIDE) hasLong = true;
if (side === TARGET_TRADE_SIDE) hasShort = true;
```

}

if (hasLong && !hasShort) return OPPOSITE_TRADE_SIDE;
if (hasShort && !hasLong) return TARGET_TRADE_SIDE;
if (hasLong && hasShort) return ‘MIXED’;

return ‘UNKNOWN’;
}

function inferSideFromIds(metrics = {}) {
return inferSideFromValues([
metrics.familyId,
metrics.microFamilyId,
metrics.macroFamilyId,
metrics.parentMacroFamilyId,
metrics.parentMicroFamilyId,
metrics.trueMicroFamilyId,
metrics.coarseMicroFamilyId,
metrics.baseMicroFamilyId,
metrics.legacyMicroFamilyId,
metrics.id,
metrics.key
]);
}

function inferSideFromScannerReason(metrics = {}) {
return inferSideFromValues([
metrics.scannerReason,
metrics.reason,
metrics.signalReason,
metrics.actionReason
]);
}

function inferTradeSide(metrics = {}) {
const directSide = inferSideFromValues([
metrics.tradeSide,
metrics.side,
metrics.positionSide,
metrics.direction,
metrics.signalSide,
metrics.scannerSide,
metrics.actualScannerSide,
metrics.analysisSide,
metrics.expectedSide,
metrics.predictedSide,
metrics.intentSide,
metrics.biasSide
]);

if (directSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
if (directSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

const idSide = inferSideFromIds(metrics);

if (idSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
if (idSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

const reasonSide = inferSideFromScannerReason(metrics);

if (reasonSide === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
if (reasonSide === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

if (metrics.shortOnly === true || metrics.longDisabled === true) {
return TARGET_TRADE_SIDE;
}

return TARGET_TRADE_SIDE;
}

function assertShortOnly(metrics = {}) {
const side = inferTradeSide(metrics);

if (side === OPPOSITE_TRADE_SIDE) {
const error = new Error(‘SHORT_ONLY_MICRO_FAMILY_SYSTEM:LONG_DISABLED’);
error.reason = ‘LONG_DISABLED_SHORT_ONLY’;
error.tradeSide = OPPOSITE_TRADE_SIDE;
throw error;
}

return {
…metrics,
side: TARGET_TRADE_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,
targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
shortOnly: true,
longDisabled: true,
longOnly: false,
shortDisabled: false
};
}

function normalizeSide() {
return TARGET_DASHBOARD_SIDE;
}

function firstFinite(…values) {
for (const value of values) {
const n = safeNumber(value, NaN);

```
if (Number.isFinite(n)) return n;
```

}

return NaN;
}

function firstValue(…values) {
for (const value of values) {
if (value !== undefined && value !== null && value !== ‘’) return value;
}

return null;
}

function formatBucketNumber(value, decimals = 0) {
if (!Number.isFinite(value)) return ‘NA’;

return Number(value)
.toFixed(decimals)
.replace(/.?0+$/u, ‘’)
.replace(’-’, ‘M’)
.replace(’.’, ‘P’);
}

function ratioToBps(value) {
const n = safeNumber(value, NaN);

if (!Number.isFinite(n)) return NaN;

return Math.abs(n) * 10000;
}

function numericBps(value) {
const bps = ratioToBps(value);

if (!Number.isFinite(bps)) return null;

return Number(formatBucketNumber(bps, 3));
}

function threeTier(value, {
prefix,
low,
high,
scale = 1,
fallback = ‘NA’,
lowLabel = ‘LO’,
midLabel = ‘MID’,
highLabel = ‘HI’
} = {}) {
const n = safeNumber(value, NaN);

if (!Number.isFinite(n)) return `${prefix}_${fallback}`;

const scaled = n * scale;

if (scaled < low) return `${prefix}_${lowLabel}`;
if (scaled >= high) return `${prefix}_${highLabel}`;

return `${prefix}_${midLabel}`;
}

function signedThreeTier(value, {
prefix,
low = -0.25,
high = 0.25,
fallback = ‘NA’,
lowLabel = ‘NEG’,
midLabel = ‘MID’,
highLabel = ‘POS’
} = {}) {
const n = safeNumber(value, NaN);

if (!Number.isFinite(n)) return `${prefix}_${fallback}`;
if (n < low) return `${prefix}_${lowLabel}`;
if (n >= high) return `${prefix}_${highLabel}`;

return `${prefix}_${midLabel}`;
}

function pctThreeTier(value, {
prefix,
lowBps,
highBps,
fallback = ‘NA’,
lowLabel = ‘NEAR’,
midLabel = ‘MID’,
highLabel = ‘FAR’
} = {}) {
const bps = ratioToBps(value);

if (!Number.isFinite(bps)) return `${prefix}_${fallback}`;
if (bps < lowBps) return `${prefix}_${lowLabel}`;
if (bps >= highBps) return `${prefix}_${highLabel}`;

return `${prefix}_${midLabel}`;
}

function scoreTier(score, prefix) {
return threeTier(score, {
prefix,
low: 35,
high: 70
});
}

function signedScoreTier(score, prefix) {
return signedThreeTier(score, {
prefix,
low: -35,
high: 35,
lowLabel: ‘NEG’,
midLabel: ‘FLAT’,
highLabel: ‘POS’
});
}

function spreadTier(value) {
const bps = ratioToBps(value);

if (!Number.isFinite(bps)) return ‘SPREAD_NA’;
if (bps < 4) return ‘SPREAD_TIGHT’;
if (bps >= 15) return ‘SPREAD_WIDE’;

return ‘SPREAD_NORMAL’;
}

function volatilityTier(value) {
const bps = ratioToBps(value);

if (!Number.isFinite(bps)) return ‘VOL_NA’;
if (bps < 100) return ‘VOL_LO’;
if (bps >= 400) return ‘VOL_HI’;

return ‘VOL_MID’;
}

function depthTier(value) {
const usd = safeNumber(value, NaN);

if (!Number.isFinite(usd)) return ‘DEPTH_NA’;
if (usd < 50_000) return ‘DEPTH_LO’;
if (usd >= 300_000) return ‘DEPTH_HI’;

return ‘DEPTH_MID’;
}

function rrTier(rr) {
const r = safeNumber(rr, NaN);

if (!Number.isFinite(r)) return ‘RR_NA’;
if (r < 1.2) return ‘RR_LO’;
if (r >= 2.0) return ‘RR_HI’;

return ‘RR_MID’;
}

function fundingTier(value) {
const n = safeNumber(value, NaN);

if (!Number.isFinite(n)) return ‘FUNDING_NA’;
if (n < -0.0001) return ‘FUNDING_NEG’;
if (n > 0.0001) return ‘FUNDING_POS’;

return ‘FUNDING_FLAT’;
}

function costTier(costR) {
const c = safeNumber(costR, NaN);

if (!Number.isFinite(c)) return ‘COST_R_NA’;
if (c < 0.15) return ‘COST_R_LO’;
if (c >= 0.35) return ‘COST_R_HI’;

return ‘COST_R_MID’;
}

function coarseRsi(zone) {
const z = toUpper(zone, ‘MID’);

if (z.startsWith(‘LOWER’) || z.includes(‘OVERSOLD’)) return ‘LOWER’;
if (z.startsWith(‘UPPER’) || z.includes(‘OVERBOUGHT’)) return ‘UPPER’;

return ‘MID’;
}

function tier(score) {
const s = safeNumber(score, NaN);

if (!Number.isFinite(s)) return ‘NA’;
if (s >= 70) return ‘HI’;
if (s >= 35) return ‘MID’;

return ‘LO’;
}

function scoreBucket(score, prefix) {
return scoreTier(score, prefix);
}

function signedScoreBucket(score, prefix) {
return signedScoreTier(score, prefix);
}

function bucketDistancePct(value, prefix) {
return pctThreeTier(value, {
prefix,
lowBps: 25,
highBps: 150,
lowLabel: ‘NEAR’,
midLabel: ‘MID’,
highLabel: ‘FAR’
});
}

function bucketVolatilityPct(value) {
return volatilityTier(value);
}

function microDepthBucket(value) {
return depthTier(value);
}

function rrMicroBucket(rr) {
return rrTier(rr);
}

function entryQuality(metrics = {}) {
if (metrics.retestConfirmed) return ‘RETEST’;
if (metrics.pullbackConfirmed) return ‘PULLBACK’;
if (metrics.sweepConfirmed) return ‘SWEEP’;

return ‘RAW’;
}

function btcRelation(sideOrMetrics, btcStateInput = null) {
const btcState = sideOrMetrics && typeof sideOrMetrics === ‘object’
? sideOrMetrics.btcState
: btcStateInput;

const btc = toUpper(btcState, ‘NEUTRAL’);

if (btc === ‘NEUTRAL’ || btc === ‘UNKNOWN’ || btc === ‘NA’) return ‘BTC_NEUTRAL’;

if ([‘BEARISH’, ‘STRONG_BEAR’, ‘BEAR’, ‘DOWN’].includes(btc)) {
return ‘BTC_WITH’;
}

return ‘BTC_AGAINST’;
}

function coarseBtcState(sideOrMetrics, btcStateInput = null) {
return btcRelation(sideOrMetrics, btcStateInput);
}

function coarseRegime(regime) {
const r = toUpper(regime, ‘NORMAL_VOL’);

if (r.includes(‘HIGH’) || r.includes(‘EXTREME’)) return ‘HIGH_VOL’;
if (r.includes(‘LOW’)) return ‘LOW_VOL’;

return ‘NORMAL_VOL’;
}

function coarseFlow(flow) {
const f = toUpper(flow, ‘NEUTRAL’);

if ([‘TREND’, ‘IMPULSE’, ‘DUMP’, ‘SELL_IMPULSE’].includes(f)) return ‘TREND’;
if (f === ‘BUILDING’) return ‘BUILDING’;

return ‘NEUTRAL’;
}

function coarseScannerReason(reason) {
const r = toUpper(reason, ‘UNKNOWN’);

if (r.includes(‘RETEST’)) return ‘RETEST’;
if (r.includes(‘PULLBACK’)) return ‘PULLBACK’;
if (r.includes(‘BREAKOUT’)) return ‘BREAKOUT’;
if (r.includes(‘VOLUME’)) return ‘VOLUME’;
if (r.includes(‘MOMENTUM’)) return ‘MOMENTUM’;

return ‘UNKNOWN’;
}

function normalizeObRelation(metrics = {}) {
const explicit = toUpper(metrics.obRelation || ‘’, ‘’);

if (explicit) return explicit;

return toUpper(
getObRelation(TARGET_TRADE_SIDE, metrics.obBias) ||
‘UNKNOWN’
);
}

function assetClass(metrics = {}) {
const explicit = toUpper(
metrics.assetClass ||
metrics.marketClass ||
metrics.instrumentClass ||
‘’,
‘’
);

if (explicit) return explicit;

return ‘CRYPTO’;
}

function getCleanSymbol(metrics = {}) {
const raw = toUpper(
metrics.symbol ||
metrics.baseSymbol ||
metrics.contractSymbol ||
‘’,
‘’
);

const cleaned = raw
.replace(/USDTUMCBL|USDCUMCBL|USDTPERP|USDCPERP|USDT|USDC|BUSD|PERP|SWAP|USD/gu, ‘’)
.replace(/[^A-Z0-9]/gu, ‘’);

return cleaned || ‘UNKNOWN’;
}

function symbolClassBucket(metrics = {}) {
const symbol = getCleanSymbol(metrics);

const majors = new Set([
‘BTC’,
‘ETH’,
‘SOL’,
‘XRP’,
‘BNB’,
‘DOGE’,
‘ADA’,
‘AVAX’,
‘LINK’,
‘DOT’,
‘TON’,
‘TRX’,
‘LTC’,
‘BCH’
]);

const memes = new Set([
‘PEPE’,
‘SHIB’,
‘WIF’,
‘BONK’,
‘FLOKI’,
‘DOGE’
]);

if (majors.has(symbol)) return ‘SYMBOL_MAJOR’;
if (memes.has(symbol)) return ‘SYMBOL_MEME’;

return ‘SYMBOL_ALT’;
}

function getEntryDistancePct(metrics = {}) {
return firstFinite(
metrics.entryDistancePct,
metrics.entryDistanceToMidPct,
metrics.pullbackDistancePct,
metrics.distanceToEntryPct,
metrics.distancePct
);
}

function getSlDistancePct(metrics = {}) {
return firstFinite(
metrics.slDistancePct,
metrics.stopDistancePct,
metrics.stopLossDistancePct,
metrics.riskPct
);
}

function getTpDistancePct(metrics = {}) {
return firstFinite(
metrics.tpDistancePct,
metrics.takeProfitDistancePct,
metrics.rewardPct
);
}

function getLiquidationDistancePct(metrics = {}) {
return firstFinite(
metrics.liqDistancePct,
metrics.liquidationDistancePct,
metrics.distanceToLiquidationPct,
metrics.nearestLiqDistancePct
);
}

function getVolatilityPct(metrics = {}) {
return firstFinite(
metrics.atrPct,
metrics.volatilityPct,
metrics.rangePct,
metrics.realizedVolPct
);
}

function getSpoofScore(metrics = {}) {
return firstFinite(
metrics.spoofScore,
metrics.orderbookSpoofScore,
metrics.obSpoofScore,
metrics.fakeLiquidityScore
);
}

function getOrderbookImbalance(metrics = {}) {
return firstFinite(
metrics.orderbookImbalance,
metrics.bookImbalance,
metrics.obImbalance,
metrics.bidAskImbalance
);
}

function getRsiSlope(metrics = {}) {
return firstFinite(
metrics.rsiSlope,
metrics.rsiVelocity,
metrics.rsiDelta,
metrics.rsiMomentum
);
}

function getCostR(metrics = {}) {
return firstFinite(
metrics.costR,
metrics.avgCostR,
metrics.estimatedCostR
);
}

function getConfluenceScore(metrics = {}) {
return firstFinite(
metrics.confluence,
metrics.sniperScore,
metrics.scannerScore,
metrics.moveScore
);
}

function getSpreadPct(metrics = {}) {
const spreadPct = firstFinite(metrics.spreadPct);

if (Number.isFinite(spreadPct)) return spreadPct;

const spreadBps = firstFinite(metrics.spreadBps);

if (Number.isFinite(spreadBps)) return spreadBps / 10000;

return NaN;
}

# /*

# VASTE TAXONOMIE: SETUP-TYPE + REGIME-BUCKET

Dit zijn de twee bouwstenen van de echte learning-identiteit.
Geen hash. Elke coin valt deterministisch in 1 van 5 setups x 3 regimes.
*/

/*
Setup-type bepalen uit de signalen die de scanner/riskEngine al meelevert.
Volgorde van prioriteit is bewust:

1. RETEST   - bevestigde retest is het sterkst gedefinieerd
1. SWEEP_REVERSAL - liquidity sweep
1. COMPRESSION - lage volatiliteit / squeeze-achtige opzet
1. CONTINUATION - duidelijke trend-flow die doorloopt
1. BREAKDOWN - default/overige bearish afbraak

Alle signalen die hiervoor gebruikt worden bestaan al in je metrics:
retestConfirmed, pullbackConfirmed, sweepConfirmed, fakeBreakout,
scannerReason, flow, en volatiliteit (atrPct).
*/
function classifySetupType(metrics = {}) {
const reason = toUpper(metrics.scannerReason, ‘’);
const flow = coarseFlow(metrics.flow);
const volBucket = volatilityTier(getVolatilityPct(metrics));

// 1. Retest expliciet bevestigd of in reason.
if (metrics.retestConfirmed || reason.includes(‘RETEST’)) {
return ‘RETEST’;
}

// 2. Liquidity sweep.
if (metrics.sweepConfirmed || reason.includes(‘SWEEP’)) {
return ‘SWEEP_REVERSAL’;
}

// 3. Pullback telt als retest-achtige continuation entry.
if (metrics.pullbackConfirmed || reason.includes(‘PULLBACK’)) {
return ‘RETEST’;
}

// 4. Compressie/squeeze: lage volatiliteit zonder duidelijke trend-flow.
if (volBucket === ‘VOL_LO’ && flow !== ‘TREND’) {
return ‘COMPRESSION’;
}

// 5. Duidelijke doorlopende bearish flow = continuation.
if (flow === ‘TREND’ && !metrics.fakeBreakout) {
return ‘CONTINUATION’;
}

// 6. Default: bearish afbraak.
return ‘BREAKDOWN’;
}

/*
Regime-bucket: TREND / CHOP / SQUEEZE.
Gebaseerd op de bestaande regime-classificatie (HIGH_VOL/NORMAL_VOL/LOW_VOL)
gecombineerd met flow, zodat het aansluit op hoe de markt zich gedraagt.

- SQUEEZE: lage volatiliteit (compressie)
- TREND:   duidelijke richting (trend-flow of hoge volatiliteit met flow)
- CHOP:    de rest (rommelig/range)
  */
  function classifyRegimeBucket(metrics = {}) {
  const vol = coarseRegime(metrics.regime); // HIGH_VOL | NORMAL_VOL | LOW_VOL
  const flow = coarseFlow(metrics.flow);

if (vol === ‘LOW_VOL’) return ‘SQUEEZE’;

if (flow === ‘TREND’) return ‘TREND’;
if (vol === ‘HIGH_VOL’) return ‘TREND’;

return ‘CHOP’;
}

/*
De vaste learning-familie. Dit is de IDENTITEIT waarop geleerd wordt.
Vorm: MICRO_SHORT_{SETUP}_{REGIME}
Voorbeeld: MICRO_SHORT_BREAKDOWN_TREND
*/
function buildTaxonomyFamilyId(metrics = {}) {
const setup = classifySetupType(metrics);
const regime = classifyRegimeBucket(metrics);

return {
setup,
regime,
microFamilyId: `MICRO_${TARGET_TRADE_SIDE}_${setup}_${regime}`
};
}

function isScannerFamilyId(id = ‘’) {
const value = String(id || ‘’).toUpperCase();

return (
value.startsWith(‘MICRO_SHORT_SCANNER__’) ||
value.includes(‘MICRO_SHORT_SCANNER__’) ||
value.startsWith(‘SHORT_SCANNER_’) ||
value.includes(’**SCANNER**’)
);
}

function isAnalyzeFamilyId(id = ‘’) {
const value = String(id || ‘’).toUpperCase();

if (!value) return false;
if (isScannerFamilyId(value)) return false;

return (
/^SHORT_F\d{2}$/u.test(value) ||
(
value.startsWith(‘SHORT_’) &&
!value.startsWith(‘SHORT_SCANNER_’)
)
);
}

function getScannerMetadata(metrics = {}) {
const scannerMicroFamilyId = firstValue(
metrics.scannerMicroFamilyId,
isScannerFamilyId(metrics.trueMicroFamilyId) ? metrics.trueMicroFamilyId : null,
isScannerFamilyId(metrics.microFamilyId) ? metrics.microFamilyId : null,
isScannerFamilyId(metrics.id) ? metrics.id : null,
isScannerFamilyId(metrics.key) ? metrics.key : null
);

const scannerFamilyId = firstValue(
metrics.scannerFamilyId,
isScannerFamilyId(metrics.familyId) ? metrics.familyId : null,
isScannerFamilyId(metrics.baseFamilyId) ? metrics.baseFamilyId : null
);

const scannerDefinitionParts = Array.isArray(metrics.scannerDefinitionParts)
? metrics.scannerDefinitionParts
: Array.isArray(metrics.definitionParts) && scannerMicroFamilyId
? metrics.definitionParts
: [];

const scannerDefinition = firstValue(
metrics.scannerDefinition,
scannerMicroFamilyId ? metrics.definition : null,
scannerMicroFamilyId ? metrics.microDefinition : null
);

return {
scannerMicroFamilyId: scannerMicroFamilyId || null,
scannerFamilyId: scannerFamilyId || null,
scannerDefinition: scannerDefinition || null,
scannerDefinitionParts
};
}

function resolveAnalyzeFamilyId(metrics = {}) {
const candidate = firstValue(
metrics.analyzeFamilyId,
metrics.learningFamilyId,
metrics.familyId
);

if (isAnalyzeFamilyId(candidate)) {
return String(candidate).toUpperCase();
}

return classifyFamily(metrics);
}

function buildMacroDefinitionParts(metrics = {}, familyId) {
const normalizedSide = normalizeSide(metrics);
const obRelation = normalizeObRelation(metrics);
const btcRel = btcRelation(metrics);
const regime = coarseRegime(metrics.regime);
const flow = coarseFlow(metrics.flow);
const scannerReason = coarseScannerReason(metrics.scannerReason);

return [
`schema=${getMacroSchema()}`,
`side=${normalizedSide}`,
`tradeSide=${TARGET_TRADE_SIDE}`,
`family=${familyId}`,

```
`rsi=${coarseRsi(metrics.rsiZone)}`,
`flow=${flow}`,
`obRelation=${obRelation}`,
`btcRelation=${btcRel}`,
`regime=${regime}`,

`confluenceTier=${tier(getConfluenceScore(metrics))}`,
`rrTier=${rrTier(metrics.rr)}`,
`spreadTier=${spreadTier(getSpreadPct(metrics))}`,
`depthTier=${depthTier(metrics.depthMinUsd1p)}`,
`fundingTier=${fundingTier(metrics.fundingRate)}`,

`entryQuality=${entryQuality(metrics)}`,
`fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
`scannerReason=${scannerReason}`
```

];
}

/*
Deze parts blijven volledig behouden als METADATA/DEBUG.
Ze bepalen NIET meer de learning-identiteit (die komt uit de taxonomie),
maar ze leggen wel vast WAAROM een coin in een family viel en met welke
context-buckets. Zo kun je later nog steeds analyseren.
*/
function buildMicroDefinitionParts(metrics = {}, parent, taxonomy) {
const spreadPct = getSpreadPct(metrics);
const entryDistancePct = getEntryDistancePct(metrics);
const slDistancePct = getSlDistancePct(metrics);
const tpDistancePct = getTpDistancePct(metrics);
const volatilityPct = getVolatilityPct(metrics);
const spoofScore = getSpoofScore(metrics);
const orderbookImbalance = getOrderbookImbalance(metrics);
const rsiSlope = getRsiSlope(metrics);
const costR = getCostR(metrics);

return [
`schema=${getMicroSchema()}`,
`granularity=${LEARNING_GRANULARITY}`,
`parent=${parent.microFamilyId}`,
`side=${TARGET_DASHBOARD_SIDE}`,
`tradeSide=${TARGET_TRADE_SIDE}`,
`family=${parent.familyId}`,

```
// De vaste taxonomie-identiteit, expliciet vastgelegd in de definitie.
`setupType=${taxonomy.setup}`,
`regimeBucket=${taxonomy.regime}`,
`learningFamily=${taxonomy.microFamilyId}`,

`assetClass=${assetClass(metrics)}`,
`symbolClass=${symbolClassBucket(metrics)}`,

`rsi=${coarseRsi(metrics.rsiZone)}`,
`rsiSlope=${signedScoreBucket(rsiSlope, 'RSI_SLOPE')}`,

`flow=${coarseFlow(metrics.flow)}`,

`obRelation=${normalizeObRelation(metrics)}`,
`obImbalance=${signedThreeTier(orderbookImbalance, {
  prefix: 'OB_IMB',
  low: -0.25,
  high: 0.25,
  lowLabel: 'ASK_HEAVY',
  midLabel: 'BALANCED',
  highLabel: 'BID_HEAVY'
})}`,
`spoof=${scoreBucket(spoofScore, 'SPOOF')}`,

`btcState=${btcRelation(TARGET_TRADE_SIDE, metrics.btcState)}`,

`regime=${coarseRegime(metrics.regime)}`,
`vol=${bucketVolatilityPct(volatilityPct)}`,

`confluence=${scoreBucket(getConfluenceScore(metrics), 'CONF')}`,

`rr=${rrMicroBucket(metrics.rr)}`,

`spread=${spreadTier(spreadPct)}`,
`depth=${microDepthBucket(metrics.depthMinUsd1p)}`,
`funding=${fundingTier(metrics.fundingRate)}`,

`entryQuality=${entryQuality(metrics)}`,
`entryDistance=${bucketDistancePct(entryDistancePct, 'ENTRY_DIST')}`,
`slDistance=${pctThreeTier(slDistancePct, {
  prefix: 'RISK',
  lowBps: 70,
  highBps: 200,
  lowLabel: 'TIGHT',
  midLabel: 'NORMAL',
  highLabel: 'WIDE'
})}`,
`tpDistance=${pctThreeTier(tpDistancePct, {
  prefix: 'REWARD',
  lowBps: 100,
  highBps: 350,
  lowLabel: 'SMALL',
  midLabel: 'NORMAL',
  highLabel: 'LARGE'
})}`,

`cost=${costTier(costR)}`,

`fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
`fakeBreakoutRisk=${boolToken(metrics.fakeBreakoutRisk)}`,
`scannerReason=${coarseScannerReason(metrics.scannerReason)}`
```

];
}

function buildExecutionFingerprintParts(metrics = {}, parent) {
const spreadPct = getSpreadPct(metrics);
const entryDistancePct = getEntryDistancePct(metrics);
const slDistancePct = getSlDistancePct(metrics);
const tpDistancePct = getTpDistancePct(metrics);
const liqDistancePct = getLiquidationDistancePct(metrics);
const volatilityPct = getVolatilityPct(metrics);
const spoofScore = getSpoofScore(metrics);
const orderbookImbalance = getOrderbookImbalance(metrics);
const rsiSlope = getRsiSlope(metrics);
const costR = getCostR(metrics);
const confluence = getConfluenceScore(metrics);

const scannerReason = firstValue(
metrics.scannerReasonCoarse,
metrics.scannerReason,
metrics.reason,
metrics.signalReason
);

return [
`xrSchema=${EXECUTION_MICRO_SUFFIX}`,
`tradeSide=${TARGET_TRADE_SIDE}`,
`family=${normalizeToken(parent.familyId)}`,
`macro=${normalizeToken(parent.microFamilyId)}`,

```
`assetClass=${normalizeToken(assetClass(metrics))}`,
`symbolClass=${symbolClassBucket(metrics)}`,

`rsi=${normalizeToken(coarseRsi(metrics.rsiZone))}`,
`rsiSlope=${signedScoreBucket(rsiSlope, 'RSI_SLOPE')}`,

`flow=${normalizeToken(coarseFlow(metrics.flow))}`,

`obRelation=${normalizeToken(normalizeObRelation(metrics))}`,
`obImb=${signedThreeTier(orderbookImbalance, {
  prefix: 'OB_IMB',
  low: -0.25,
  high: 0.25,
  lowLabel: 'ASK_HEAVY',
  midLabel: 'BALANCED',
  highLabel: 'BID_HEAVY'
})}`,
`spoof=${scoreBucket(spoofScore, 'SPOOF')}`,

`btc=${normalizeToken(btcRelation(TARGET_TRADE_SIDE, metrics.btcState))}`,

`regime=${normalizeToken(coarseRegime(metrics.regime))}`,

`scanner=${normalizeToken(coarseScannerReason(scannerReason))}`,

`spread=${spreadTier(spreadPct)}`,
`entryDist=${bucketDistancePct(entryDistancePct, 'ENTRY_DIST')}`,
`risk=${pctThreeTier(slDistancePct, {
  prefix: 'RISK',
  lowBps: 70,
  highBps: 200,
  lowLabel: 'TIGHT',
  midLabel: 'NORMAL',
  highLabel: 'WIDE'
})}`,
`reward=${pctThreeTier(tpDistancePct, {
  prefix: 'REWARD',
  lowBps: 100,
  highBps: 350,
  lowLabel: 'SMALL',
  midLabel: 'NORMAL',
  highLabel: 'LARGE'
})}`,
`liqDist=${pctThreeTier(liqDistancePct, {
  prefix: 'LIQ_DIST',
  lowBps: 100,
  highBps: 500,
  lowLabel: 'NEAR',
  midLabel: 'MID',
  highLabel: 'FAR'
})}`,
`vol=${bucketVolatilityPct(volatilityPct)}`,

`depth=${depthTier(metrics.depthMinUsd1p)}`,
`funding=${fundingTier(metrics.fundingRate)}`,

`rr=${rrTier(metrics.rr)}`,
`cost=${costTier(costR)}`,
`confluence=${scoreBucket(confluence, 'CONF')}`,

`entryQuality=${normalizeToken(entryQuality(metrics))}`,
`fakeBreakout=${boolToken(metrics.fakeBreakout)}`,
`fakeBreakoutRisk=${boolToken(metrics.fakeBreakoutRisk)}`
```

];
}

function uniqueStrings(values = []) {
return […new Set(
(Array.isArray(values) ? values : [values])
.flatMap((value) => Array.isArray(value) ? value : [value])
.map((value) => String(value || ‘’).trim())
.filter(Boolean)
)];
}

function classifyFamily(metrics = {}) {
const sideSafeMetrics = assertShortOnly(metrics);

const seedParts = [
TARGET_TRADE_SIDE,
coarseFlow(sideSafeMetrics.flow),
coarseRsi(sideSafeMetrics.rsiZone),
normalizeObRelation(sideSafeMetrics),
coarseBtcState(TARGET_TRADE_SIDE, sideSafeMetrics.btcState),
coarseRegime(sideSafeMetrics.regime),
rrTier(sideSafeMetrics.rr),
scoreTier(getConfluenceScore(sideSafeMetrics), ‘CONF’)
];

const bucket = (parseInt(stableHash(seedParts.join(’|’), 6), 16) % 24) + 1;

return `${TARGET_TRADE_SIDE}_F${String(bucket).padStart(2, '0')}`;
}

export function buildMicroFamilyV1(metrics = {}) {
const sideSafeMetrics = assertShortOnly(metrics);
const tradeSide = TARGET_TRADE_SIDE;

const familyId = resolveAnalyzeFamilyId(sideSafeMetrics);

const normalizedSide = TARGET_DASHBOARD_SIDE;
const obRelation = normalizeObRelation(sideSafeMetrics);
const btcRel = btcRelation(tradeSide, metrics.btcState);
const regime = coarseRegime(metrics.regime);
const flow = coarseFlow(metrics.flow);
const scannerReason = coarseScannerReason(metrics.scannerReason);
const definitionParts = buildMacroDefinitionParts(sideSafeMetrics, familyId);
const hash = stableHash(definitionParts.join(’|’), 8);
const schema = getMacroSchema();

const microFamilyId = `MICRO_${tradeSide}_${familyId}_${schema}_${hash}`;

return {
schema,
version: ‘macro’,

```
familyId,
microFamilyId,
macroFamilyId: microFamilyId,
parentMacroFamilyId: null,
parentMicroFamilyId: null,

definition: definitionParts.join(' | '),
definitionParts,

side: normalizedSide,
tradeSide,
positionSide: tradeSide,
direction: tradeSide,

targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,

obRelation,
btcRelation: btcRel,
regime,
flow,
scannerReason,

shortOnly: true,
longDisabled: true,
longOnly: false,
shortDisabled: false,

spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3))
```

};
}

export function buildMicroFamilyV2(metrics = {}) {
const sideSafeMetrics = assertShortOnly(metrics);
const tradeSide = TARGET_TRADE_SIDE;

const scannerMetadata = getScannerMetadata(sideSafeMetrics);
const parent = buildMicroFamilyV1(sideSafeMetrics);

// === DE VASTE TAXONOMIE: dit is de echte learning-identiteit ===
const taxonomy = buildTaxonomyFamilyId(sideSafeMetrics);
const analyzeMicroFamilyId = taxonomy.microFamilyId; // MICRO_SHORT_{SETUP}_{REGIME}

// De oude buckets blijven als metadata/debug (NIET als identiteit).
const baseDefinitionParts = buildMicroDefinitionParts(sideSafeMetrics, parent, taxonomy);

const schema = getMicroSchema();

const executionFingerprintParts = shouldBuildExecutionFingerprintMetadata()
? buildExecutionFingerprintParts(sideSafeMetrics, parent)
: [];

const executionFingerprintHash = executionFingerprintParts.length
? stableHash(executionFingerprintParts.join(’|’), EXECUTION_MICRO_HASH_LEN)
: null;

const liqDistancePct = getLiquidationDistancePct(sideSafeMetrics);

const definitionParts = uniqueStrings([
…baseDefinitionParts,
`liqDistanceMetadataOnly=${pctThreeTier(liqDistancePct, { prefix: 'LIQ_DIST', lowBps: 100, highBps: 500, lowLabel: 'NEAR', midLabel: 'MID', highLabel: 'FAR' })}`,
`setupType=${taxonomy.setup}`,
`regimeBucket=${taxonomy.regime}`,
`analyzeMicroFamilyId=${analyzeMicroFamilyId}`,
`coarseMicroFamilyId=${analyzeMicroFamilyId}`,
`learningGranularity=${LEARNING_GRANULARITY}`,
`learningIdentity=ANALYZE_MICRO_FAMILY_FIXED_TAXONOMY`,
`scannerFingerprintRole=METADATA_ONLY`,
`executionFingerprintRole=METADATA_ONLY`
]);

return {
schema,
version: ‘micro’,

```
familyId: parent.familyId,

microFamilyId: analyzeMicroFamilyId,
trueMicroFamilyId: analyzeMicroFamilyId,

coarseMicroFamilyId: analyzeMicroFamilyId,
baseMicroFamilyId: analyzeMicroFamilyId,
legacyMicroFamilyId: analyzeMicroFamilyId,

analyzeMicroFamilyId,
learningMicroFamilyId: analyzeMicroFamilyId,

// Vaste taxonomie-velden, expliciet beschikbaar voor dashboard/sortering.
setupType: taxonomy.setup,
regimeBucket: taxonomy.regime,

learningGranularity: LEARNING_GRANULARITY,
learningHashInputParts: baseDefinitionParts,

scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId,
scannerFamilyId: scannerMetadata.scannerFamilyId,
scannerDefinition: scannerMetadata.scannerDefinition,
scannerDefinitionParts: scannerMetadata.scannerDefinitionParts,

executionFingerprintHash,
executionFingerprintParts,
executionFingerprintSchema: executionFingerprintHash ? EXECUTION_MICRO_SUFFIX : null,
executionMicroFamilyId: executionFingerprintHash
  ? `${analyzeMicroFamilyId}_${EXECUTION_MICRO_SUFFIX}_${executionFingerprintHash}`
  : null,
executionFingerprintRole: 'METADATA_ONLY',

macroFamilyId: parent.microFamilyId,
parentMacroFamilyId: parent.microFamilyId,
parentMicroFamilyId: parent.microFamilyId,

parentDefinition: parent.definition,
parentDefinitionParts: parent.definitionParts,

definition: definitionParts.join(' | '),
definitionParts,

side: TARGET_DASHBOARD_SIDE,
tradeSide,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,

targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,

assetClass: assetClass(sideSafeMetrics),

obRelation: normalizeObRelation(sideSafeMetrics),
btcRelation: btcRelation(TARGET_TRADE_SIDE, metrics.btcState),
btcState: toUpper(metrics.btcState, 'NEUTRAL'),

regime: coarseRegime(metrics.regime),
regimeCoarse: coarseRegime(metrics.regime),

flow: coarseFlow(metrics.flow),
flowCoarse: coarseFlow(metrics.flow),

scannerReason: coarseScannerReason(metrics.scannerReason),
scannerReasonCoarse: coarseScannerReason(metrics.scannerReason),

rsiZone: coarseRsi(metrics.rsiZone),
rsiCoarse: coarseRsi(metrics.rsiZone),

shortOnly: true,
longDisabled: true,
longOnly: false,
shortDisabled: false,

spreadBps: Number((safeNumber(getSpreadPct(metrics), 0) * 10000).toFixed(3)),
entryDistanceBps: numericBps(getEntryDistancePct(metrics)),
slDistanceBps: numericBps(getSlDistancePct(metrics)),
tpDistanceBps: numericBps(getTpDistancePct(metrics)),
liqDistanceBps: numericBps(getLiquidationDistancePct(metrics))
```

};
}

export function buildMicroFamily(metrics = {}, options = {}) {
const sideSafeMetrics = assertShortOnly(metrics);
const schema = toUpper(options.schema || options.version || getMicroSchema());

if (schema === getMacroSchema() || schema === ‘V1’ || schema === ‘MACRO’) {
return buildMicroFamilyV1(sideSafeMetrics);
}

return buildMicroFamilyV2(sideSafeMetrics);
}

export function buildMicroFamilyForSide(metrics = {}, side = TARGET_TRADE_SIDE, options = {}) {
const requestedSide = normalizeTradeSideValue(side);

if (requestedSide !== TARGET_TRADE_SIDE) {
throw new Error(`SHORT_ONLY_MICRO_FAMILY_SYSTEM:${side}`);
}

return buildMicroFamily(
{
…metrics,
side: TARGET_TRADE_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,
targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
shortOnly: true,
longDisabled: true,
longOnly: false,
shortDisabled: false
},
options
);
}

export function classifyMacroFamily(metrics = {}) {
return buildMicroFamilyV1(metrics);
}

export function classifyMicroFamily(metrics = {}) {
return buildMicroFamilyV2(metrics);
}

export function getMicroFamilyId(metrics = {}, options = {}) {
return buildMicroFamily(metrics, options).microFamilyId;
}

export function getParentMacroFamilyId(metrics = {}) {
return buildMicroFamilyV1(metrics).microFamilyId;
}

/*
De vaste-taxonomie micro-IDs hebben de vorm MICRO_SHORT_{SETUP}_{REGIME}
en bevatten GEEN schema-segment meer (geen *MF_V2*<hash>). De id-detectie
hieronder accepteert daarom zowel de nieuwe vaste vorm als de oude vorm,
zodat eventuele oude opgeslagen rijen niet kapotgaan.
*/
function isFixedTaxonomyMicroId(id = ‘’) {
const value = String(id || ‘’).toUpperCase();

if (!value || isScannerFamilyId(value)) return false;
if (!value.startsWith(`MICRO_${TARGET_TRADE_SIDE}_`)) return false;

return SETUP_TYPES.some((setup) => (
REGIME_BUCKETS.some((regime) => (
value === `MICRO_${TARGET_TRADE_SIDE}_${setup}_${regime}`
))
));
}

export function isMicroFamilyV1Id(id) {
const value = String(id || ‘’).toUpperCase();

return (
value.includes(`_${getMacroSchema()}_`) &&
value.includes(‘MICRO_SHORT_’) &&
!isScannerFamilyId(value)
);
}

export function isMicroFamilyV2Id(id) {
const value = String(id || ‘’).toUpperCase();

if (isScannerFamilyId(value)) return false;

// Nieuwe vaste taxonomie.
if (isFixedTaxonomyMicroId(value)) return true;

// Oude hash-vorm blijft herkenbaar voor backward-compat.
return (
value.includes(`_${getMicroSchema()}_`) &&
value.includes(‘MICRO_SHORT_’)
);
}

export function isExecutionRefinedMicroFamilyId(id) {
const value = String(id || ‘’).toUpperCase();

return (
value.includes(‘MICRO_SHORT_’) &&
!isScannerFamilyId(value) &&
value.includes(`_${EXECUTION_MICRO_SUFFIX}_`)
);
}

export function isScannerMicroFamilyId(id) {
return isScannerFamilyId(id);
}

export function attachMicroFamilies(metrics = {}) {
const sideSafeMetrics = assertShortOnly(metrics);

const scannerMetadata = getScannerMetadata(sideSafeMetrics);
const macro = buildMicroFamilyV1(sideSafeMetrics);
const micro = buildMicroFamilyV2(sideSafeMetrics);

return {
…metrics,

```
side: micro.side,
tradeSide: micro.tradeSide,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,

targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,

shortOnly: true,
longDisabled: true,
longOnly: false,
shortDisabled: false,

familyId: micro.familyId,

macroFamilyId: macro.microFamilyId,
parentMacroFamilyId: macro.microFamilyId,
parentMicroFamilyId: macro.microFamilyId,

microFamilyId: micro.microFamilyId,
trueMicroFamilyId: micro.trueMicroFamilyId || micro.microFamilyId,

coarseMicroFamilyId: micro.coarseMicroFamilyId,
baseMicroFamilyId: micro.baseMicroFamilyId,
legacyMicroFamilyId: micro.legacyMicroFamilyId,

analyzeMicroFamilyId: micro.analyzeMicroFamilyId,
learningMicroFamilyId: micro.learningMicroFamilyId,

setupType: micro.setupType,
regimeBucket: micro.regimeBucket,

learningGranularity: micro.learningGranularity,
learningHashInputParts: micro.learningHashInputParts,

scannerMicroFamilyId: scannerMetadata.scannerMicroFamilyId || micro.scannerMicroFamilyId,
scannerFamilyId: scannerMetadata.scannerFamilyId || micro.scannerFamilyId,
scannerDefinition: scannerMetadata.scannerDefinition || micro.scannerDefinition,
scannerDefinitionParts: scannerMetadata.scannerDefinitionParts?.length
  ? scannerMetadata.scannerDefinitionParts
  : micro.scannerDefinitionParts,

executionFingerprintHash: micro.executionFingerprintHash,
executionFingerprintParts: micro.executionFingerprintParts,
executionFingerprintSchema: micro.executionFingerprintSchema,
executionMicroFamilyId: micro.executionMicroFamilyId,
executionFingerprintRole: 'METADATA_ONLY',

microFamilySchema: micro.schema,

microFamilyDefinition: micro.definition,
microFamilyDefinitionParts: micro.definitionParts,

macroFamilyDefinition: macro.definition,
macroFamilyDefinitionParts: macro.definitionParts,

scannerFingerprintRole: 'METADATA_ONLY',
learningIdentitySource: 'ANALYZE_MICRO_FAMILY'
```

};
}

export function attachMicroFamiliesForBothSides(metrics = {}) {
const short = attachMicroFamilies({
…metrics,
side: TARGET_TRADE_SIDE,
tradeSide: TARGET_TRADE_SIDE,
positionSide: TARGET_TRADE_SIDE,
direction: TARGET_TRADE_SIDE,
targetTradeSide: TARGET_TRADE_SIDE,
dashboardSide: TARGET_DASHBOARD_SIDE,
shortOnly: true,
longDisabled: true,
longOnly: false,
shortDisabled: false
});

return {
short,
long: null
};
}