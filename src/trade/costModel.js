// ================= FILE: src/trade/costModel.js =================
//
// SHORT-only cost model.
//
// Doel:
// - Gross SHORT price moves omzetten naar fee+slippage-adjusted NET outcomes.
// - Analyze/scoring leert uitsluitend op netR na kosten.
// - avgCostR wordt gevoed met echte costR.
// - wins/losses/flats worden bepaald op netR.
// - Explicit LONG/BULL/BUY input wordt geweigerd en produceert geen learnable outcome.
//
// Fase-0 fix:
// - Cost model is auditbaar: grossR - costR = netR wordt expliciet gecontroleerd.
// - Measured spread wordt niet meer automatisch omhoog gefloord naar fallbackSpreadPct.
//   Fallback spread wordt alleen gebruikt wanneer spread ontbreekt/ongeldig is.
// - Funding zit NIET standaard in costR. Alleen als includeFunding/fundingEnabled expliciet aan staat.
// - Execution cost, funding cost en total cost worden apart zichtbaar gemaakt.
// - costR blijft de netto/signed totale cost in R zodat de vergelijking exact blijft:
//   netR = grossR - costR.
//
// Architectuur:
// - Learning blijft breed.
// - Selection wordt later adaptief.
// - Discord wordt later streng.
// - CurrentFit is zacht en blokkeert geen virtual/shadow learning.

import { CONFIG } from '../config.js';
import { safeNumber, sideToTradeSide } from '../utils.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const COST_MODEL_VERSION = 'SHORT_TAKER_NET_COST_AUDIT_V5';
const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';
const COST_AUDIT_VERSION = 'SHORT_COST_AUDIT_GROSS_MINUS_COST_EQUALS_NET_V1';

const DEFAULT_SOURCE = 'VIRTUAL';
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MIN_HEALTHY_RISK_PCT = 0.01;
const DEFAULT_HIGH_COST_R_WARNING = 0.25;

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

function costConfig() {
  return {
    takerFeePct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.cost?.takerFeePct ??
          CONFIG.cost?.takerFeePct,
        0.0006
      )
    ),

    makerFeePct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.cost?.makerFeePct ??
          CONFIG.cost?.makerFeePct,
        0.0002
      )
    ),

    marketImpactPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.cost?.marketImpactPct ??
          CONFIG.cost?.marketImpactPct,
        0.0003
      )
    ),

    fallbackSpreadPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.cost?.fallbackSpreadPct ??
          CONFIG.cost?.fallbackSpreadPct,
        0.0008
      )
    ),

    maxSpreadPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.cost?.maxSpreadPct ??
          CONFIG.cost?.maxSpreadPct,
        0.05
      )
    ),

    // Belangrijk: true betekent fallback alleen bij ontbrekende spread.
    // Oude gedrag was effectief: appliedSpread = max(measuredSpread, fallbackSpreadPct).
    // Dat maakte costR mechanisch te streng bij liquid markets.
    fallbackSpreadOnlyWhenMissing:
      CONFIG.short?.cost?.fallbackSpreadOnlyWhenMissing !== false &&
      CONFIG.cost?.fallbackSpreadOnlyWhenMissing !== false,

    includeFundingByDefault:
      CONFIG.short?.cost?.includeFundingByDefault === true ||
      CONFIG.cost?.includeFundingByDefault === true ||
      CONFIG.short?.cost?.fundingEnabled === true ||
      CONFIG.cost?.fundingEnabled === true,

    fundingPctPer8h: safeNumber(
      CONFIG.short?.cost?.fundingPctPer8h ??
        CONFIG.short?.cost?.fundingRatePctPer8h ??
        CONFIG.cost?.fundingPctPer8h ??
        CONFIG.cost?.fundingRatePctPer8h,
      0
    ),

    minHealthyRiskPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.cost?.minHealthyRiskPct ??
          CONFIG.cost?.minHealthyRiskPct,
        DEFAULT_MIN_HEALTHY_RISK_PCT
      )
    ),

    highCostRWarning: Math.max(
      0,
      safeNumber(
        CONFIG.short?.cost?.highCostRWarning ??
          CONFIG.cost?.highCostRWarning,
        DEFAULT_HIGH_COST_R_WARNING
      )
    )
  };
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function round10(value) {
  return Number(safeNumber(value, 0).toFixed(10));
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED_TRUE', 'SHORT')
    .replaceAll('LONGDISABLED_TRUE', 'SHORT')
    .replaceAll('BLOCK_LONG_TRUE', 'SHORT')
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
    .replaceAll('BLOCK_LONG', 'SHORT')
    .replaceAll('LONG_DISABLED', 'SHORT')
    .replaceAll('LONGDISABLED', 'SHORT')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function hasPattern(value = '', patterns = []) {
  const text = cleanSideText(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`)
  ));
}

function hasShortSignal(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;
  if (SHORT_TOKENS.has(raw)) return true;

  return hasPattern(raw, [
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

function hasLongSignal(value = '') {
  const raw = cleanSideText(value);

  if (!raw) return false;
  if (LONG_TOKENS.has(raw)) return true;

  return hasPattern(raw, [
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

function normalizeTradeSide(value = TARGET_TRADE_SIDE) {
  const raw = cleanSideText(value);

  if (!raw) return TARGET_TRADE_SIDE;

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const shortHit = hasShortSignal(raw);
  const longHit = hasLongSignal(raw);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortSide(side = TARGET_TRADE_SIDE) {
  return normalizeTradeSide(side) === TARGET_TRADE_SIDE;
}

function isLongSide(side = TARGET_TRADE_SIDE) {
  return normalizeTradeSide(side) === OPPOSITE_TRADE_SIDE;
}

function normalizeSource(source = DEFAULT_SOURCE) {
  const src = upper(source || DEFAULT_SOURCE);

  if (src === 'SHADOW') return 'SHADOW';
  if (src === 'VIRTUAL') return 'VIRTUAL';

  return DEFAULT_SOURCE;
}

function normalizeLeg(leg) {
  const l = String(leg || '').toLowerCase();

  if (l === 'entry') return 'entry';
  if (l === 'exit') return 'exit';

  return 'unknown';
}

function clampSpread(spreadPct) {
  const cfg = costConfig();
  const spread = Math.max(0, safeNumber(spreadPct, 0));

  if (cfg.maxSpreadPct <= 0) return spread;

  return Math.min(spread, cfg.maxSpreadPct);
}

function spreadCostDetails(spreadPct, leg = 'unknown') {
  const cfg = costConfig();
  const raw = finiteNumber(spreadPct, null);
  const missing = raw === null || raw < 0;

  let appliedSpreadPct;
  let source;
  let fallbackUsed;
  let clampedByMax = false;

  if (missing) {
    appliedSpreadPct = cfg.fallbackSpreadPct;
    source = 'FALLBACK_SPREAD_MISSING_OR_INVALID';
    fallbackUsed = true;
  } else {
    const clamped = clampSpread(raw);
    clampedByMax = cfg.maxSpreadPct > 0 && raw > cfg.maxSpreadPct;

    if (cfg.fallbackSpreadOnlyWhenMissing) {
      appliedSpreadPct = clamped;
      source = clampedByMax
        ? 'MEASURED_SPREAD_CLAMPED_TO_MAX'
        : 'MEASURED_SPREAD';
      fallbackUsed = false;
    } else {
      appliedSpreadPct = Math.max(clamped, cfg.fallbackSpreadPct);
      source = appliedSpreadPct > clamped
        ? 'FALLBACK_SPREAD_FLOOR_APPLIED'
        : clampedByMax
          ? 'MEASURED_SPREAD_CLAMPED_TO_MAX'
          : 'MEASURED_SPREAD';
      fallbackUsed = appliedSpreadPct > clamped;
    }
  }

  return {
    leg,
    inputSpreadPct: missing ? null : round10(raw),
    appliedSpreadPct: round10(appliedSpreadPct),
    fallbackSpreadPct: round10(cfg.fallbackSpreadPct),
    maxSpreadPct: round10(cfg.maxSpreadPct),
    spreadSource: source,
    spreadFallbackUsed: fallbackUsed,
    spreadClampedByMax: clampedByMax,
    fallbackSpreadOnlyWhenMissing: Boolean(cfg.fallbackSpreadOnlyWhenMissing)
  };
}

function spreadForCost(spreadPct) {
  return spreadCostDetails(spreadPct).appliedSpreadPct;
}

function buildSpreadCostMeta(entrySpreadPct, exitSpreadPct) {
  const entry = spreadCostDetails(entrySpreadPct, 'entry');
  const exit = spreadCostDetails(exitSpreadPct, 'exit');

  return {
    entrySpreadInputPct: entry.inputSpreadPct,
    exitSpreadInputPct: exit.inputSpreadPct,

    entrySpreadPct: entry.appliedSpreadPct,
    exitSpreadPct: exit.appliedSpreadPct,

    entrySpreadSource: entry.spreadSource,
    exitSpreadSource: exit.spreadSource,

    entrySpreadFallbackUsed: entry.spreadFallbackUsed,
    exitSpreadFallbackUsed: exit.spreadFallbackUsed,
    spreadFallbackUsed: Boolean(entry.spreadFallbackUsed || exit.spreadFallbackUsed),

    entrySpreadClampedByMax: entry.spreadClampedByMax,
    exitSpreadClampedByMax: exit.spreadClampedByMax,
    spreadClampedByMax: Boolean(entry.spreadClampedByMax || exit.spreadClampedByMax),

    fallbackSpreadPct: entry.fallbackSpreadPct,
    maxSpreadPct: entry.maxSpreadPct,
    fallbackSpreadOnlyWhenMissing: entry.fallbackSpreadOnlyWhenMissing
  };
}

function validShortRiskShape({ entry, sl, tp } = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);
  const t = safeNumber(tp, 0);

  return e > 0 && s > 0 && t > 0 && t < e && e < s;
}

function calcRiskPct({ entry, sl } = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);

  if (e <= 0 || s <= 0 || s <= e) return 0;

  return (s - e) / e;
}

function calcGrossMovePct({ entry, exit } = {}) {
  const e = safeNumber(entry, 0);
  const x = safeNumber(exit, 0);

  if (e <= 0 || x <= 0) return 0;

  return (e - x) / e;
}

function calcShortGrossR({ entry, initialSl, exit } = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(initialSl, 0);
  const x = safeNumber(exit, 0);

  if (e <= 0 || s <= 0 || x <= 0 || s <= e) return 0;

  const riskDistance = s - e;

  if (riskDistance <= 0) return 0;

  return (e - x) / riskDistance;
}

function calcShortCurrentR({ entry, initialSl, currentPrice } = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(initialSl, 0);
  const p = safeNumber(currentPrice, 0);

  if (e <= 0 || s <= 0 || p <= 0 || s <= e) return 0;

  const riskDistance = s - e;

  if (riskDistance <= 0) return 0;

  return (e - p) / riskDistance;
}

function isPositiveNetR(value) {
  return safeNumber(value, 0) > 0;
}

function isNegativeNetR(value) {
  return safeNumber(value, 0) < 0;
}

function fundingCostDetails({
  includeFunding = null,
  fundingCostPct = null,
  fundingPctPer8h = null,
  fundingRatePct = null,
  fundingRatePctPer8h = null,
  holdMs = null,
  ageMs = null,
  positionAgeMs = null,
  source = DEFAULT_SOURCE
} = {}) {
  const cfg = costConfig();

  const explicitlyEnabled = includeFunding === true;
  const enabled = explicitlyEnabled || cfg.includeFundingByDefault === true;

  if (!enabled) {
    return {
      fundingIncluded: false,
      fundingApplied: false,
      fundingSource: 'FUNDING_DISABLED_BY_DEFAULT',
      fundingCostRatio: 0,
      fundingCostPct: 0,
      fundingCostR: 0,
      fundingBenefitRatio: 0,
      fundingChargeRatio: 0,
      fundingIntervalMs: FUNDING_INTERVAL_MS,
      fundingWindows: 0,
      fundingRatePctPer8h: 0,
      fundingNote: 'Funding is excluded unless includeFunding=true or CONFIG.short.cost.fundingEnabled/includeFundingByDefault=true.',
      source: normalizeSource(source)
    };
  }

  const explicitFundingCost = finiteNumber(fundingCostPct, null);

  if (explicitFundingCost !== null) {
    return {
      fundingIncluded: true,
      fundingApplied: true,
      fundingSource: 'EXPLICIT_SIGNED_FUNDING_COST_PCT',
      fundingCostRatio: round10(explicitFundingCost),
      fundingCostPct: round6(explicitFundingCost * 100),
      fundingCostR: 0,
      fundingBenefitRatio: round10(Math.max(0, -explicitFundingCost)),
      fundingChargeRatio: round10(Math.max(0, explicitFundingCost)),
      fundingIntervalMs: FUNDING_INTERVAL_MS,
      fundingWindows: null,
      fundingRatePctPer8h: null,
      fundingNote: 'Positive fundingCostPct is a cost. Negative fundingCostPct is a benefit.',
      source: normalizeSource(source)
    };
  }

  const rate = safeNumber(
    fundingPctPer8h ??
      fundingRatePctPer8h ??
      fundingRatePct ??
      cfg.fundingPctPer8h,
    0
  );

  const resolvedHoldMs = Math.max(
    0,
    safeNumber(holdMs ?? ageMs ?? positionAgeMs, 0)
  );

  if (resolvedHoldMs <= 0 || rate === 0) {
    return {
      fundingIncluded: true,
      fundingApplied: false,
      fundingSource: resolvedHoldMs <= 0
        ? 'NO_HOLD_MS_FOR_FUNDING_ESTIMATE'
        : 'ZERO_FUNDING_RATE',
      fundingCostRatio: 0,
      fundingCostPct: 0,
      fundingCostR: 0,
      fundingBenefitRatio: 0,
      fundingChargeRatio: 0,
      fundingIntervalMs: FUNDING_INTERVAL_MS,
      fundingWindows: resolvedHoldMs / FUNDING_INTERVAL_MS,
      fundingRatePctPer8h: round10(rate),
      fundingNote: 'Funding enabled but no charge/benefit could be applied.',
      source: normalizeSource(source)
    };
  }

  const windows = resolvedHoldMs / FUNDING_INTERVAL_MS;

  // Bitget perpetual convention in simplified form:
  // Positive funding rate: longs pay shorts -> SHORT receives -> negative cost.
  // Negative funding rate: shorts pay longs -> SHORT pays -> positive cost.
  const signedFundingCostRatio = -rate * windows;

  return {
    fundingIncluded: true,
    fundingApplied: true,
    fundingSource: 'SIGNED_FUNDING_RATE_PER_8H_TIMES_HOLD_TIME_SHORT_POLARITY',
    fundingCostRatio: round10(signedFundingCostRatio),
    fundingCostPct: round6(signedFundingCostRatio * 100),
    fundingCostR: 0,
    fundingBenefitRatio: round10(Math.max(0, -signedFundingCostRatio)),
    fundingChargeRatio: round10(Math.max(0, signedFundingCostRatio)),
    fundingIntervalMs: FUNDING_INTERVAL_MS,
    fundingWindows: round6(windows),
    fundingRatePctPer8h: round10(rate),
    fundingNote: 'For SHORT: positive funding rate is benefit, negative funding rate is cost.',
    source: normalizeSource(source)
  };
}

function executionRoundTripCostDetails(entrySpreadPct, exitSpreadPct) {
  const cfg = costConfig();
  const spreadMeta = buildSpreadCostMeta(entrySpreadPct, exitSpreadPct);

  const feeRoundTrip = cfg.takerFeePct * 2;

  const entryHalfSpreadRatio = spreadMeta.entrySpreadPct / 2;
  const exitHalfSpreadRatio = spreadMeta.exitSpreadPct / 2;

  const entryMarketImpactRatio = cfg.marketImpactPct;
  const exitMarketImpactRatio = cfg.marketImpactPct;

  const entrySlip = entryHalfSpreadRatio + entryMarketImpactRatio;
  const exitSlip = exitHalfSpreadRatio + exitMarketImpactRatio;

  const executionCostRatio = feeRoundTrip + entrySlip + exitSlip;
  const slippageRatio = entrySlip + exitSlip;

  return {
    ...spreadMeta,

    takerFeePct: round10(cfg.takerFeePct),
    makerFeePct: round10(cfg.makerFeePct),
    marketImpactPct: round10(cfg.marketImpactPct),

    feeRatio: round10(feeRoundTrip),
    feePct: round6(feeRoundTrip * 100),

    entryHalfSpreadRatio: round10(entryHalfSpreadRatio),
    exitHalfSpreadRatio: round10(exitHalfSpreadRatio),
    entryMarketImpactRatio: round10(entryMarketImpactRatio),
    exitMarketImpactRatio: round10(exitMarketImpactRatio),

    entrySlipRatio: round10(entrySlip),
    exitSlipRatio: round10(exitSlip),
    slippageRatio: round10(slippageRatio),
    slippagePct: round6(slippageRatio * 100),

    executionCostRatio: round10(executionCostRatio),
    executionCostPct: round6(executionCostRatio * 100),

    executionCostFormula: '2*takerFeePct + entrySpreadPct/2 + exitSpreadPct/2 + 2*marketImpactPct',
    spreadCostPolicy: spreadMeta.fallbackSpreadOnlyWhenMissing
      ? 'fallbackSpreadPct only when measured spread is missing/invalid'
      : 'fallbackSpreadPct is used as a minimum floor'
  };
}

function buildCostAudit({
  grossR,
  costR,
  netR,
  riskPct,
  costRatio,
  executionCostRatio,
  fundingCostRatio
} = {}) {
  const g = safeNumber(grossR, 0);
  const c = safeNumber(costR, 0);
  const n = safeNumber(netR, 0);
  const diff = (g - c) - n;
  const cfg = costConfig();
  const risk = safeNumber(riskPct, 0);
  const cost = safeNumber(costRatio, 0);

  return {
    costAuditVersion: COST_AUDIT_VERSION,
    costEquation: 'netR = grossR - costR',
    costRFormula: 'costR = totalCostRatio / riskPct',
    totalCostRatioFormula: 'executionCostRatio + fundingCostRatio',
    executionCostRatioFormula: '2*takerFeePct + entrySpreadPct/2 + exitSpreadPct/2 + 2*marketImpactPct',
    grossMinusCostEqualsNet: Math.abs(diff) <= 0.000001,
    netEquationDiffR: round10(diff),
    riskPct: round10(risk),
    costRatio: round10(cost),
    executionCostRatio: round10(executionCostRatio),
    fundingCostRatio: round10(fundingCostRatio),
    costR: round10(c),
    grossR: round10(g),
    netR: round10(n),
    riskPctTooTight: risk > 0 && risk < cfg.minHealthyRiskPct,
    highCostR: Math.abs(c) >= cfg.highCostRWarning,
    minHealthyRiskPct: round10(cfg.minHealthyRiskPct),
    highCostRWarning: round10(cfg.highCostRWarning),
    costRiskWarning: risk > 0 && risk < cfg.minHealthyRiskPct
      ? 'RISK_PCT_TOO_TIGHT_COSTR_CAN_EXPLODE'
      : Math.abs(c) >= cfg.highCostRWarning
        ? 'HIGH_COSTR_CHECK_SPREAD_SLIPPAGE_RISK_DISTANCE'
        : null
  };
}

function identityFlags() {
  return {
    virtualLearning: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    exchangeOrdersDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintRole: 'METADATA_ONLY',

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    fixedTaxonomyPreferred: true,

    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    discordOnlyForExactTrueMicroMatch: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    completedOnlyClosedVirtualOrShadow: true,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    costModelAuditEnabled: true,
    costAuditVersion: COST_AUDIT_VERSION,
    costEquation: 'netR = grossR - costR',
    costRFormula: 'costR = totalCostRatio / riskPct',
    fundingIncludedByDefault: costConfig().includeFundingByDefault,
    fundingDefaultPolicy: 'EXCLUDED_UNLESS_EXPLICITLY_ENABLED',
    spreadFallbackPolicy: costConfig().fallbackSpreadOnlyWhenMissing
      ? 'FALLBACK_ONLY_WHEN_MISSING'
      : 'FALLBACK_AS_MINIMUM_FLOOR',

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    seenDefinition: 'UNIQUE_OBSERVATION_DEDUPE_KEY_ONLY',
    observationDedupeRequired: true,
    outcomeDedupeRequired: true,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    learningRemainsBroad: true,
    selectionWillBeAdaptive: true,
    discordWillBeStrict: true,

    riskTradeSide: TARGET_TRADE_SIDE,
    validShortRiskShape: 'tp < entry < sl',
    shortRiskShape: 'tp < entry < sl',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    selectionGranularity: 'EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED',

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function baseShortOnlyMeta({
  skipped = false,
  reason = null,
  source = DEFAULT_SOURCE
} = {}) {
  const normalizedSource = normalizeSource(source);

  return {
    source: normalizedSource,

    costModel: COST_MODEL_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    costModelApplied: !skipped,
    netCostModelApplied: !skipped,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
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
    virtualTracked: true,
    shadowOnly: normalizedSource === 'SHADOW',
    outcomeSource: normalizedSource,

    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR',

    measurementFixVersion: MEASUREMENT_FIX_VERSION,

    skipped,
    reason,

    ...identityFlags()
  };
}

function emptyCostResult(reason = 'NON_SHORT_COST_MODEL_SKIPPED', source = DEFAULT_SOURCE) {
  const audit = buildCostAudit({
    grossR: 0,
    costR: 0,
    netR: 0,
    riskPct: 0,
    costRatio: 0,
    executionCostRatio: 0,
    fundingCostRatio: 0
  });

  return {
    ...baseShortOnlyMeta({
      skipped: true,
      reason,
      source
    }),

    feeRatio: 0,
    slippageRatio: 0,
    executionCostRatio: 0,
    fundingCostRatio: 0,
    costRatio: 0,
    totalCostRatio: 0,

    grossMovePct: 0,
    netMovePct: 0,
    breakEvenMovePct: 0,

    feePct: 0,
    slippagePct: 0,
    executionCostPct: 0,
    fundingCostPct: 0,
    costPct: 0,

    grossPnlPct: 0,
    netPnlPct: 0,

    grossR: 0,
    rawR: 0,
    realizedGrossR: 0,

    executionCostR: 0,
    fundingCostR: 0,
    costR: 0,
    avgCostR: 0,
    totalCostR: 0,

    netR: 0,
    exitR: 0,
    realizedNetR: 0,
    realizedR: 0,
    r: 0,

    win: false,
    loss: false,
    flat: true,
    isWin: false,

    ...audit
  };
}

export function validateShortRiskShape({ entry, sl, tp } = {}) {
  const e = safeNumber(entry, 0);
  const s = safeNumber(sl, 0);
  const t = safeNumber(tp, 0);
  const valid = validShortRiskShape({
    entry: e,
    sl: s,
    tp: t
  });

  return {
    valid,
    reason: valid ? null : 'INVALID_SHORT_RISK_SHAPE_REQUIRES_TP_LT_ENTRY_LT_SL',
    entry: e,
    sl: s,
    tp: t,
    riskPct: valid
      ? calcRiskPct({
        entry: e,
        sl: s
      })
      : 0,
    rewardPct: valid
      ? (e - t) / e
      : 0,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    ...baseShortOnlyMeta({
      skipped: !valid,
      reason: valid ? null : 'INVALID_SHORT_RISK_SHAPE_REQUIRES_TP_LT_ENTRY_LT_SL'
    })
  };
}

export function modelFillPrice({
  midPrice,
  side = TARGET_TRADE_SIDE,
  leg,
  spreadPct
} = {}) {
  const mid = safeNumber(midPrice, 0);

  if (mid <= 0) return 0;

  if (isLongSide(side)) return 0;
  if (!isShortSide(side)) return 0;

  const normalizedLeg = normalizeLeg(leg);

  if (normalizedLeg === 'unknown') {
    return mid;
  }

  const cfg = costConfig();
  const halfSpread = spreadForCost(spreadPct) / 2;
  const adverse = halfSpread + cfg.marketImpactPct;

  const sellingEntry = normalizedLeg === 'entry';

  return sellingEntry
    ? mid * (1 - adverse)
    : mid * (1 + adverse);
}

export function roundTripCostRatio(entrySpreadPct, exitSpreadPct) {
  return executionRoundTripCostDetails(entrySpreadPct, exitSpreadPct).executionCostRatio;
}

export function roundTripCostPct(entrySpreadPct, exitSpreadPct) {
  return roundTripCostRatio(entrySpreadPct, exitSpreadPct);
}

export function applyCosts({
  grossMovePct,
  grossR = null,
  riskPct,
  entrySpreadPct,
  exitSpreadPct,
  side = TARGET_TRADE_SIDE,
  tradeSide = side,
  source = DEFAULT_SOURCE,
  includeFunding = null,
  fundingCostPct = null,
  fundingPctPer8h = null,
  fundingRatePct = null,
  fundingRatePctPer8h = null,
  holdMs = null,
  ageMs = null,
  positionAgeMs = null
} = {}) {
  const normalizedSide = normalizeTradeSide(tradeSide || side);

  if (normalizedSide === OPPOSITE_TRADE_SIDE) {
    return emptyCostResult('LONG_DISABLED_SHORT_ONLY_COST_MODEL', source);
  }

  if (normalizedSide !== TARGET_TRADE_SIDE) {
    return emptyCostResult('UNKNOWN_OR_NON_SHORT_COST_MODEL_SKIPPED', source);
  }

  const move = safeNumber(grossMovePct, 0);
  const risk = Math.max(0, safeNumber(riskPct, 0));

  if (risk <= 0) {
    return emptyCostResult('INVALID_OR_ZERO_SHORT_RISK_PCT', source);
  }

  const execution = executionRoundTripCostDetails(entrySpreadPct, exitSpreadPct);
  const funding = fundingCostDetails({
    includeFunding,
    fundingCostPct,
    fundingPctPer8h,
    fundingRatePct,
    fundingRatePctPer8h,
    holdMs,
    ageMs,
    positionAgeMs,
    source
  });

  const executionCostRatio = safeNumber(execution.executionCostRatio, 0);
  const fundingCostRatio = safeNumber(funding.fundingCostRatio, 0);
  const totalCostRatio = executionCostRatio + fundingCostRatio;

  const feeRatio = safeNumber(execution.feeRatio, 0);
  const slippageRatio = safeNumber(execution.slippageRatio, 0);

  const netMovePct = move - totalCostRatio;

  const grossPnlPct = move * 100;
  const netPnlPct = netMovePct * 100;

  const calculatedGrossR = Number.isFinite(safeNumber(grossR, null))
    ? safeNumber(grossR, 0)
    : move / risk;

  const executionCostR = executionCostRatio / risk;
  const fundingCostR = fundingCostRatio / risk;
  const costR = totalCostRatio / risk;
  const netR = calculatedGrossR - costR;

  const audit = buildCostAudit({
    grossR: calculatedGrossR,
    costR,
    netR,
    riskPct: risk,
    costRatio: totalCostRatio,
    executionCostRatio,
    fundingCostRatio
  });

  return {
    ...baseShortOnlyMeta({
      source
    }),

    takerFeePct: round6(execution.takerFeePct),
    makerFeePct: round6(execution.makerFeePct),
    marketImpactPct: round6(execution.marketImpactPct),
    fallbackSpreadPct: round6(execution.fallbackSpreadPct),
    maxSpreadPct: round6(execution.maxSpreadPct),

    entrySpreadInputPct: execution.entrySpreadInputPct,
    exitSpreadInputPct: execution.exitSpreadInputPct,
    entrySpreadPct: round6(execution.entrySpreadPct),
    exitSpreadPct: round6(execution.exitSpreadPct),
    entrySpreadSource: execution.entrySpreadSource,
    exitSpreadSource: execution.exitSpreadSource,
    entrySpreadFallbackUsed: execution.entrySpreadFallbackUsed,
    exitSpreadFallbackUsed: execution.exitSpreadFallbackUsed,
    spreadFallbackUsed: execution.spreadFallbackUsed,
    spreadFallbackPolicy: execution.spreadCostPolicy,
    spreadClampedByMax: execution.spreadClampedByMax,

    feeRatio: round6(feeRatio),
    slippageRatio: round6(slippageRatio),
    executionCostRatio: round6(executionCostRatio),
    fundingCostRatio: round6(fundingCostRatio),
    costRatio: round6(totalCostRatio),
    totalCostRatio: round6(totalCostRatio),

    grossMovePct: round6(move),
    netMovePct: round6(netMovePct),
    breakEvenMovePct: round6(totalCostRatio),

    feePct: round6(feeRatio * 100),
    slippagePct: round6(slippageRatio * 100),
    executionCostPct: round6(executionCostRatio * 100),
    fundingCostPct: round6(fundingCostRatio * 100),
    costPct: round6(totalCostRatio * 100),

    grossPnlPct: round6(grossPnlPct),
    netPnlPct: round6(netPnlPct),

    grossR: round6(calculatedGrossR),
    rawR: round6(calculatedGrossR),
    realizedGrossR: round6(calculatedGrossR),

    executionCostR: round6(executionCostR),
    fundingCostR: round6(fundingCostR),
    costR: round6(costR),
    avgCostR: round6(costR),
    totalCostR: round6(costR),

    netR: round6(netR),
    exitR: round6(netR),
    realizedNetR: round6(netR),
    realizedR: round6(netR),
    r: round6(netR),

    win: isPositiveNetR(netR),
    loss: isNegativeNetR(netR),
    flat: !isPositiveNetR(netR) && !isNegativeNetR(netR),
    isWin: isPositiveNetR(netR),

    fundingIncluded: funding.fundingIncluded,
    fundingApplied: funding.fundingApplied,
    fundingSource: funding.fundingSource,
    fundingBenefitRatio: funding.fundingBenefitRatio,
    fundingChargeRatio: funding.fundingChargeRatio,
    fundingIntervalMs: funding.fundingIntervalMs,
    fundingWindows: funding.fundingWindows,
    fundingRatePctPer8h: funding.fundingRatePctPer8h,
    fundingNote: funding.fundingNote,

    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    ...audit
  };
}

export function applyCostsFromPrices({
  entry,
  exit,
  exitPrice = exit,
  currentPrice = exitPrice,
  sl,
  initialSl = sl,
  tp,
  side = TARGET_TRADE_SIDE,
  tradeSide = side,
  source = DEFAULT_SOURCE,
  entrySpreadPct,
  exitSpreadPct,
  includeFunding = null,
  fundingCostPct = null,
  fundingPctPer8h = null,
  fundingRatePct = null,
  fundingRatePctPer8h = null,
  holdMs = null,
  ageMs = null,
  positionAgeMs = null
} = {}) {
  const normalizedSide = normalizeTradeSide(tradeSide || side);

  if (normalizedSide === OPPOSITE_TRADE_SIDE) {
    return emptyCostResult('LONG_DISABLED_SHORT_ONLY_COST_MODEL', source);
  }

  if (normalizedSide !== TARGET_TRADE_SIDE) {
    return emptyCostResult('UNKNOWN_OR_NON_SHORT_COST_MODEL_SKIPPED', source);
  }

  const e = safeNumber(entry, 0);
  const s = safeNumber(initialSl, 0);
  const t = safeNumber(tp, 0);
  const x = safeNumber(exitPrice, 0);
  const p = safeNumber(currentPrice, x);

  if (!validShortRiskShape({
    entry: e,
    sl: s,
    tp: t
  })) {
    return emptyCostResult('INVALID_SHORT_RISK_SHAPE_REQUIRES_TP_LT_ENTRY_LT_SL', source);
  }

  if (x <= 0) {
    return emptyCostResult('INVALID_SHORT_EXIT_PRICE', source);
  }

  const riskPct = calcRiskPct({
    entry: e,
    sl: s
  });

  const grossMovePct = calcGrossMovePct({
    entry: e,
    exit: x
  });

  const grossR = calcShortGrossR({
    entry: e,
    initialSl: s,
    exit: x
  });

  const currentR = calcShortCurrentR({
    entry: e,
    initialSl: s,
    currentPrice: p
  });

  const result = applyCosts({
    grossMovePct,
    grossR,
    riskPct,
    entrySpreadPct,
    exitSpreadPct,
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    source,
    includeFunding,
    fundingCostPct,
    fundingPctPer8h,
    fundingRatePct,
    fundingRatePctPer8h,
    holdMs,
    ageMs,
    positionAgeMs
  });

  const netR = safeNumber(result.netR, grossR - safeNumber(result.costR, 0));
  const tpHit = x <= t;
  const slHit = x >= s;

  return {
    ...result,

    entry: e,
    exit: x,
    exitPrice: x,
    currentPrice: p,
    sl: s,
    initialSl: s,
    tp: t,

    validShortRiskShape: true,
    validShortGeometry: true,
    shortRiskFormula: 'tp < entry < sl',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    shortTpHit: tpHit,
    tpHit,
    shortSlHit: slHit,
    slHit,

    riskPct: round6(riskPct),
    grossMovePct: round6(grossMovePct),

    grossR: round6(grossR),
    rawR: round6(grossR),
    realizedGrossR: round6(grossR),
    shortGrossR: round6(grossR),

    currentR: round6(currentR),
    shortCurrentR: round6(currentR),

    executionCostR: round6(result.executionCostR),
    fundingCostR: round6(result.fundingCostR),
    costR: round6(result.costR),
    avgCostR: round6(result.costR),
    totalCostR: round6(result.costR),

    netR: round6(netR),
    exitR: round6(netR),
    realizedNetR: round6(netR),
    realizedR: round6(netR),
    r: round6(netR),

    win: isPositiveNetR(netR),
    loss: isNegativeNetR(netR),
    flat: !isPositiveNetR(netR) && !isNegativeNetR(netR),
    isWin: isPositiveNetR(netR),

    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    avgCostRSource: 'costR'
  };
}

export {
  calcShortGrossR,
  calcShortCurrentR,
  calcGrossMovePct,
  calcRiskPct,
  validShortRiskShape
};