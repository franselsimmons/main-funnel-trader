// ================= FILE: api/admin/micro-families.js =================

import { sideToTradeSide, safeNumber } from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';
import { riskDecisionForEntry } from '../../src/trade/positionSizing.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';

const MICRO_MICRO_MARKER = '_MM_';
const MICRO_MICRO_HASH_LEN = 10;

const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const CHILD75_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const ADMIN_UI_VERSION =
  'SHORT_ADMIN_MICRO_FAMILIES_V5_BOUNDED_PAGINATED_MEMOIZED';
const MICRO_MICRO_RUNTIME_GATE_VERSION =
  'SHORT_MM_RUNTIME_GATE_V7_BOUNDED_PAGINATED_MEMOIZED';

const MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1';
const MARKET_WEATHER_AGGREGATION_VERSION =
  'SHORT_MARKET_WEATHER_AGGREGATION_V2_IMMUTABLE_ENTRY_LIFETIME_REGIME_REGIMETREND';

const MARKET_WEATHER_SELECTOR_VERSION =
  'SHORT_CURRENT_MARKET_PLAYBOOK_SELECTOR_V4_CONFIRMED_WEATHER_ENTRY_IMMUTABLE';

const MARKET_WEATHER_FDR_VERSION =
  'SHORT_MARKET_WEATHER_PLAYBOOK_FDR_FINAL_SLOTS_V1_OBSERVE';

const MARKET_WEATHER_FEATURE_FLAGS_VERSION =
  'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V4_IMMUTABLE_ENTRY_NETR_GEOMETRY_SAFE';

const EMPIRICAL_VETO_VERSION =
  'SHORT_EXACT_MICRO_MICRO_EMPIRICAL_VETO_LCB95_V2_NETR_SOURCE_OF_TRUTH';

const DISCORD_ACTIVATION_GATE_VERSION =
  'SHORT_MM_DISCORD_ACTIVATION_GATE_RISK_ZERO_V7_NETR_GEOMETRY_SAFE';

const SIGNAL_TYPE_TRADE_READY = 'TRADE_READY';
const SIGNAL_TYPE_WATCH_ONLY = 'WATCH_ONLY';
const SIGNAL_TYPE_OBSERVE_ONLY = 'OBSERVE_ONLY';
const SIGNAL_TYPE_BLOCKED = 'BLOCKED';

const PROOF_TIER_MICRO_MICRO_MARKET = 'MICRO_MICRO_MARKET_PROOF';
const PROOF_TIER_MICRO_MICRO_LIFETIME = 'MICRO_MICRO_LIFETIME_PROOF';
const PROOF_TIER_OBSERVATION_ONLY = 'OBSERVATION_ONLY';
const PROOF_TIER_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const PROOF_TIER_POLICY_BLOCKED = 'POLICY_BLOCKED';

const MAX_ALLOWED_RISK_BAND_HIGH = 'HIGH';
const MAX_ALLOWED_RISK_BAND_ZERO = 'ZERO';

const MICRO_MICRO_STATUS_PASSED = 'PASSED';
const MICRO_MICRO_STATUS_OBSERVING = 'OBSERVING';
const MICRO_MICRO_STATUS_REJECTED = 'REJECTED';
const MICRO_MICRO_STATUS_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const MICRO_MICRO_STATUS_POLICY_BLOCKED = 'POLICY_BLOCKED';

const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;

const MIN_DISCORD_ACTIVATION_COMPLETED = 35;
const MIN_DISCORD_ACTIVATION_AVG_R = 0;
const MIN_DISCORD_ACTIVATION_TOTAL_R = 0;
const MIN_DISCORD_ACTIVATION_PROFIT_FACTOR = 1;
const MIN_DISCORD_ACTIVATION_LCB95_AVG_R = 0;

const MAX_DISCORD_ACTIVATION_AVG_COST_R = 0.35;
const MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT = 0.25;

const MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES = 2;

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 150;
const DEFAULT_BEST_LIMIT = 25;
const MAX_BEST_LIMIT = 60;
const WEEK_MICROS_TIMEOUT_MS = 7_500;
const ACTIVE_ROTATION_TIMEOUT_MS = 1_500;

// Verlaagd van 5000 naar 2000 om de verwerkingslast te beperken
const MAX_SOURCE_MICRO_ROWS = 2_000;

// Verhoogde cache-TTL van 45s naar 120s om Redis-leeslast te verminderen
const CACHE_TTL_MS = 120_000;

// Ruimere deadline voor meer ademruimte
const ROUTE_HARD_DEADLINE_MS = 20_000;

const ROUTE_PROCESSING_RESERVE_MS = 1_250;
const MAX_PLAYBOOK_CANDIDATES = 60;

const CACHE_MAX_KEYS = 8;

const DEFAULT_RANK_MODE = 'currentMarket';

const SETUP_ORDER = Object.freeze([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_ORDER = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const STATUS_RANK = Object.freeze({
  [MICRO_MICRO_STATUS_PASSED]: 0,
  [MICRO_MICRO_STATUS_OBSERVING]: 1,
  [MICRO_MICRO_STATUS_REJECTED]: 2,
  [MICRO_MICRO_STATUS_EMPIRICAL_VETO]: 3,
  [MICRO_MICRO_STATUS_POLICY_BLOCKED]: 4,
  UNKNOWN: 99
});

const SIGNAL_RANK = Object.freeze({
  [SIGNAL_TYPE_TRADE_READY]: 0,
  [SIGNAL_TYPE_WATCH_ONLY]: 1,
  [SIGNAL_TYPE_OBSERVE_ONLY]: 2,
  [SIGNAL_TYPE_BLOCKED]: 3,
  UNKNOWN: 99
});

const cache =
  globalThis.__ADMIN_MICRO_FAMILIES_V5_BOUNDED_PAGINATED_MEMOIZED_CACHE__ ||= {
    weekMicros: new Map(),
    activeRotation: {
      ts: 0,
      value: null
    }
  };

function now() {
  return Date.now();
}

function remainingMs(deadlineAt = 0) {
  if (!Number.isFinite(Number(deadlineAt)) || Number(deadlineAt) <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, Number(deadlineAt) - now());
}
function deadlineReached(deadlineAt = 0, reserveMs = 0) {
  return remainingMs(deadlineAt) <= Math.max(0, Number(reserveMs) || 0);
}
function boundedTimeoutMs(
  requestedMs,
  deadlineAt,
  reserveMs = ROUTE_PROCESSING_RESERVE_MS
) {
  const requested = Math.max(1, Math.floor(Number(requestedMs) || 1));
  const available = Math.max(1, remainingMs(deadlineAt) - reserveMs);
  return Math.max(1, Math.min(requested, available));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function finiteOrNull(value) {
  if (!hasValue(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = finiteOrNull(value);
    if (n !== null) return n;
  }

  return null;
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }

  return null;
}

function round(value, decimals = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : 0;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (!hasValue(value)) return fallback;
  return value;
}

function isTrue(value, fallback = false) {
  if (!hasValue(value)) return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const raw = lower(value);

  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;

  return fallback;
}

function toSafeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function toSafeOffset(value, fallback = 0) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(n, 100_000);
}
function parsePagination(req, limit) {
  const requestedPage = Math.floor(
    Number(firstQueryValue(req.query?.page, 1))
  );
  const page =
    Number.isFinite(requestedPage) && requestedPage >= 1
      ? requestedPage
      : 1;
  const explicitOffset = firstQueryValue(
    req.query?.offset,
    null
  );
  const offset = hasValue(explicitOffset)
    ? toSafeOffset(explicitOffset, 0)
    : (page - 1) * limit;
  return {
    page,
    offset
  };
}

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const out = [];

  while (stack.length) {
    const value = stack.shift();
    if (Array.isArray(value)) stack.unshift(...value);
    else out.push(value);
  }

  return out;
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const out = [];

  for (const value of flattenValues(values)) {
    const parts = typeof value === 'string'
      ? value.split(/[\s,;\n\r]+/g)
      : [value];

    for (const part of parts) {
      const clean = String(part || '').trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
  }

  return out;
}

function uniqueWarnings(values = []) {
  return [...new Set(
    flattenValues(values)
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function sourceEntriesFromMicros(micros = {}) {
  if (Array.isArray(micros)) {
    return micros.map((row, index) => [
      row?.trueMicroFamilyId ||
        row?.microMicroFamilyId ||
        row?.microFamilyId ||
        String(index),
      row
    ]);
  }

  if (!micros || typeof micros !== 'object') return [];

  return Object.entries(micros);
}

function withTimeout(promise, timeoutMs, code = 'TIMEOUT') {
  let timer = null;
  const safeTimeoutMs = Math.max(
    1,
    Math.floor(Number(timeoutMs) || 1)
  );
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.code = code;
      reject(error);
    }, safeTimeoutMs);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }
  });
  return Promise.race([
    Promise.resolve(promise),
    timeout
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeHash(value = '') {
  return upper(value).replace(/[^A-Z0-9]/g, '').slice(0, MICRO_MICRO_HASH_LEN);
}

function stableHash10(input = '') {
  const text = String(input || '').trim();
  if (!text) return '';

  let hash = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const hex = (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const tail = String(text.length).toString(16).toUpperCase().padStart(2, '0');

  return `${hex}${tail}`.slice(0, MICRO_MICRO_HASH_LEN);
}

function modePayload() {
  return {
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
    virtualTracked: true,

    noRealOrders: true,
    noExchangeOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

    parent15HiddenFromAdminRows: true,
    child75HiddenFromAdminRows: true,
    scannerFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitCanBlockDiscordOnly: true,
    currentFitIsNotPolicyBlock: true,

    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    entryMarketWeatherSourceOfTruth: 'STORED_ENTRY_FIELDS_ONLY',
    currentMarketWeatherDisplayOnly: true,
    confirmedMarketWeatherDisplayOnly: true,
    currentConfirmedNeverOverwriteEntryWeather: true,

    marketWeatherAggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95: true,
    empiricalVetoUsesRawAvgR: false,
    empiricalVetoSeparateFromPolicyBlocked: true,
    empiricalVetoBlocksRiskEntry: true,
    empiricalVetoBlocksDiscordTradeReady: true,
    empiricalVetoBlocksParentFallbackRescue: true,

    riskSourceOfTruth: 'riskFractionForEntry',
    proofTierIsLabelOnly: true,
    signalTypeIsActionLabelOnly: true,
    maxAllowedRiskBandIsOptionalCap: true,

    observeOnlyRisk: 0,
    watchOnlyRisk: 0,
    blockedRisk: 0,

    shortRiskShape: 'tp < entry < sl',
    riskGeometryRule: 'SHORT: tp < entry < sl',
    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    netRStatsSourceOfTruth: true,
    completedSourceOfTruth: 'netRStats.completed when available',
    totalRSourceOfTruth: 'netRStats.totalR when available',
    avgRSourceOfTruth: 'netRStats.avgR when available',
    profitFactorSourceOfTruth: 'netRStats.profitFactor when available',

    adminUiVersion: ADMIN_UI_VERSION
  };
}

function marketWeatherFeatureFlags() {
  return {
    version: MARKET_WEATHER_FEATURE_FLAGS_VERSION,

    capture: 'LIVE',
    aggregation: 'LIVE',
    selector: 'OBSERVE',
    sizingCap: 'OBSERVE',
    fdr: 'OBSERVE',
    discordTradeReady: 'VALIDATION_REQUIRED',

    captureEnabled: true,
    aggregationEnabled: true,
    selectorEnabled: true,

    selectorHardLiveDecisionEnabled: false,
    sizingCapHardLiveDecisionEnabled: false,
    fdrHardLiveDecisionEnabled: false,
    discordTradeReadyHardLiveDecisionEnabled: false,

    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherImmutable: true,
    entryMarketWeatherNeverRecomputedAtExit: true,
    entryMarketWeatherSourceOfTruth: 'STORED_ENTRY_FIELDS_ONLY',
    currentMarketWeatherDisplayOnly: true,
    confirmedMarketWeatherDisplayOnly: true,
    currentConfirmedNeverOverwriteEntryWeather: true,
    adminMicroFamiliesNeverRepairsEntryFromCurrent: true,
    adminMicroFamiliesNeverRepairsEntryFromConfirmed: true,

    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoUsesLcb95NotRawAvgR: true,
    empiricalVetoIsSeparateFromPolicyBlocked: true,
    empiricalVetoBlocksRiskEntry: true,
    empiricalVetoBlocksDiscordTradeReady: true,
    empiricalVetoBlocksParentFallbackRescue: true,

    netRStatsSourceOfTruth: true,
    completedReadsNetRStatsFirst: true,
    totalRReadsNetRStatsFirst: true,
    avgRReadsNetRStatsFirst: true,
    profitFactorReadsNetRStatsFirst: true,
    recentOutcomesFallbackEnabled: true,

    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
    bFlowAlignIsNeverBlockedByGeometryWithoutTradeShape: true,

    riskSourceOfTruth: 'riskFractionForEntry',
    proofTierIsLabelOnly: true,
    signalTypeIsActionLabelOnly: true,
    maxAllowedRiskBandIsOptionalCap: true,

    observeOnlyRiskAlwaysZero: true,
    watchOnlyRiskAlwaysZero: true,
    blockedRiskAlwaysZero: true,

    broadKnownForbiddenFamilyPolicyDisabled: true,
    knownForbiddenFamilyMustBeExplicit: true,
    bFlowAlignIsNeverForbiddenByDefault: true,
    currentFitMisfitIsSoftOnly: true,

    alwaysAnswer: true,
    alwaysAnswerDoesNotMeanAlwaysTrade: true
  };
}

function activationGateConfig() {
  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    runtimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,

    minCompleted: MIN_DISCORD_ACTIVATION_COMPLETED,
    minAvgR: MIN_DISCORD_ACTIVATION_AVG_R,
    minTotalR: MIN_DISCORD_ACTIVATION_TOTAL_R,
    minProfitFactor: MIN_DISCORD_ACTIVATION_PROFIT_FACTOR,
    minLcb95AvgR: MIN_DISCORD_ACTIVATION_LCB95_AVG_R,
    maxAvgCostR: MAX_DISCORD_ACTIVATION_AVG_COST_R,
    maxDirectSLPct: MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT,

    policyBlockedRules: [
      'E_WEAK_CONTRA',
      'INVALID_SIDE',
      'INVALID_GEOMETRY_ACTIONABLE_TRADE_ROWS_ONLY',
      'NON_SHORT',
      'SCANNER_FINGERPRINT',
      'EXECUTION_FINGERPRINT',
      'EXPLICIT_FORBIDDEN_FAMILY_FLAG_ONLY'
    ],

    removedBroadPolicyRules: [
      'KNOWN_FORBIDDEN_FAMILY_BY_TEXT_MATCH',
      'FORBIDDEN_FAMILY_BY_REASON_TEXT',
      'B_FLOW_ALIGN_AUTO_FORBIDDEN',
      'INVALID_GEOMETRY_ON_AGGREGATE_STATS_ROWS'
    ],

    currentFitMisfitIsPolicyBlock: false,
    currentFitMisfitIsSoftNoTradeReady: true,

    empiricalVetoRule:
      'exact micro-micro completed >= 35 AND standalone lifetime LCB95(avgR) < 0',
    empiricalVetoUsesLcb95NotRawAvgR: true,
    empiricalVetoBlocksParentFallbackRescue: true,

    netRStatsAreSourceOfTruth: true,
    entryMarketWeatherImmutable: true,
    currentConfirmedWeatherCannotOverwriteEntryWeather: true
  };
}

function normalizeMode(value) {
  const raw = lower(value || DEFAULT_RANK_MODE);

  if (['currentmarket', 'market', 'best'].includes(raw)) return 'currentMarket';
  if (['balanced', 'winrate', 'totalr', 'avgr', 'directsl', 'observed', 'cost', 'currentfit', 'passed', 'observe', 'clean'].includes(raw)) {
    if (raw === 'totalr') return 'totalR';
    if (raw === 'avgr') return 'avgR';
    if (raw === 'directsl') return 'directSL';
    if (raw === 'currentfit') return 'currentFit';
    return raw;
  }

  return DEFAULT_RANK_MODE;
}

function normalizeDirectSide(value) {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
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

function isCanonicalMicroMicroId(id = '') {
  return /^MICRO_SHORT_.+_MM_[A-Z0-9]{3,24}$/u.test(upper(id));
}

function isAlternateMicroMicroId(id = '') {
  return upper(id).startsWith('MM_SHORT_');
}

function isExecutionFingerprintId(id = '') {
  const value = upper(id);

  if (isCanonicalMicroMicroId(value) || isAlternateMicroMicroId(value)) return false;

  return (
    value.includes('_XR_') ||
    value.includes('__XR__') ||
    value.includes('|XR|') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
}

function invalidParsed(rawId = '', reason = 'INVALID_SHORT_TAXONOMY_ID') {
  return {
    valid: false,
    reason,
    selectable: false,
    isParent: false,
    isChild: false,
    isMicroMicro: false,
    rawId,
    setup: null,
    regime: null,
    confirmationProfile: null,
    microMicroHash: null,
    parentTrueMicroFamilyId: null,
    childTrueMicroFamilyId: null,
    trueMicroFamilyId: null,
    microMicroFamilyId: null,
    trueMicroMicroFamilyId: null,
    exactMicroMicroFamilyId: null
  };
}

function parseBodySetupRegimeConfirmation(body = '') {
  const clean = upper(body).replace(/^_+|_+$/g, '');

  for (const setup of SETUP_ORDER) {
    const setupPrefix = `${setup}_`;

    if (!clean.startsWith(setupPrefix)) continue;

    const afterSetup = clean.slice(setupPrefix.length);

    for (const regime of REGIME_ORDER) {
      if (afterSetup === regime) {
        return {
          ok: true,
          setup,
          regime,
          confirmationProfile: null,
          rest: ''
        };
      }

      const regimePrefix = `${regime}_`;

      if (!afterSetup.startsWith(regimePrefix)) continue;

      const afterRegime = afterSetup.slice(regimePrefix.length);

      for (const profile of CONFIRMATION_PROFILE_ORDER) {
        if (afterRegime === profile) {
          return {
            ok: true,
            setup,
            regime,
            confirmationProfile: profile,
            rest: ''
          };
        }

        const profilePrefix = `${profile}_`;

        if (afterRegime.startsWith(profilePrefix)) {
          return {
            ok: true,
            setup,
            regime,
            confirmationProfile: profile,
            rest: afterRegime.slice(profilePrefix.length)
          };
        }
      }
    }
  }

  return {
    ok: false,
    setup: null,
    regime: null,
    confirmationProfile: null,
    rest: ''
  };
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value) return invalidParsed(rawId, 'EMPTY_ID');

  if (value.includes('MICRO_LONG_') || value.startsWith('MM_LONG_')) {
    return invalidParsed(rawId, 'LONG_DISABLED_SHORT_ONLY');
  }

  if (isScannerFingerprintId(value)) {
    return invalidParsed(rawId, 'SCANNER_FINGERPRINT_METADATA_ONLY');
  }

  if (isExecutionFingerprintId(value)) {
    return invalidParsed(rawId, 'RAW_EXECUTION_FINGERPRINT_NOT_SELECTABLE');
  }

  let body = '';
  let explicitMicroMicro = false;
  let context = '';
  let canonicalMicroMicroSyntax = false;

  if (value.startsWith('MM_SHORT_')) {
    body = value.slice('MM_SHORT_'.length);
    explicitMicroMicro = true;
  } else if (value.startsWith('MICRO_SHORT_')) {
    body = value.slice('MICRO_SHORT_'.length);

    const markerIndex = body.lastIndexOf(MICRO_MICRO_MARKER);

    if (markerIndex > -1) {
      explicitMicroMicro = true;
      canonicalMicroMicroSyntax = true;
      context = body.slice(markerIndex + MICRO_MICRO_MARKER.length);
      body = body.slice(0, markerIndex);
    }
  } else {
    return invalidParsed(rawId, 'NOT_SHORT_TAXONOMY_ID');
  }

  const parsed = parseBodySetupRegimeConfirmation(body);

  if (!parsed.ok) return invalidParsed(rawId, 'INVALID_SHORT_TAXONOMY_BODY');

  if (explicitMicroMicro && !context && parsed.rest) context = parsed.rest;

  const parentTrueMicroFamilyId = `MICRO_SHORT_${parsed.setup}_${parsed.regime}`;
  const childTrueMicroFamilyId = parsed.confirmationProfile
    ? `${parentTrueMicroFamilyId}_${parsed.confirmationProfile}`
    : null;

  const isParent = Boolean(!parsed.confirmationProfile && !explicitMicroMicro);
  const isChild = Boolean(parsed.confirmationProfile && !explicitMicroMicro && !parsed.rest);
  const isMicroMicro = Boolean(parsed.confirmationProfile && (explicitMicroMicro || parsed.rest));

  let microMicroHash = null;

  if (isMicroMicro) {
    microMicroHash = canonicalMicroMicroSyntax
      ? normalizeHash(context)
      : normalizeHash(context || parsed.rest) || stableHash10(value);
  }

  if (isMicroMicro && !microMicroHash) {
    return invalidParsed(rawId, 'MICRO_MICRO_HASH_REQUIRED');
  }

  const microMicroFamilyId = isMicroMicro
    ? `${childTrueMicroFamilyId}${MICRO_MICRO_MARKER}${microMicroHash}`
    : null;

  const trueMicroFamilyId =
    microMicroFamilyId ||
    childTrueMicroFamilyId ||
    parentTrueMicroFamilyId;

  return {
    valid: true,
    reason: 'OK',
    selectable: isMicroMicro,
    isParent,
    isChild,
    isMicroMicro,

    rawId,
    setup: parsed.setup,
    regime: parsed.regime,
    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,

    microMicroContext: context || parsed.rest || '',
    microMicroHash,

    parentTrueMicroFamilyId,
    childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: childTrueMicroFamilyId,
    trueMicroFamilyId,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: isMicroMicro
      ? MICRO_MICRO_SCHEMA
      : isChild
        ? CHILD_TRUE_MICRO_SCHEMA
        : PARENT_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: isMicroMicro
      ? MICRO_MICRO_SCHEMA
      : isChild
        ? CHILD_TRUE_MICRO_SCHEMA
        : PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    learningGranularity: isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isChild
        ? CHILD75_LEARNING_GRANULARITY
        : PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    learningLayer: isMicroMicro
      ? 'MICRO_MICRO'
      : isChild
        ? 'CHILD_75_CONTEXT'
        : 'PARENT_15_CONTEXT',
    selectionGranularity: isMicroMicro
      ? 'EXACT_MICRO_MICRO_ONLY'
      : 'NOT_SELECTABLE'
  };
}

function isSelectableMicroMicroId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);
  return parsed.valid && parsed.isMicroMicro && parsed.selectable;
}

function firstParsed(values = [], predicate = () => true) {
  for (const value of flattenValues(values)) {
    const parsed = parseShortTaxonomyMicroId(value);
    if (parsed.valid && predicate(parsed)) return parsed;
  }

  return null;
}

function getExplicitMicroMicroId(row = {}, fallback = null) {
  if (typeof row === 'string') {
    return firstParsed([row, fallback], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || null;
  }

  return firstParsed([
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.id,
    row.key,
    fallback
  ], (parsed) => parsed.isMicroMicro)?.trueMicroFamilyId || null;
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const parsed = parseShortTaxonomyMicroId(input);

    if (parsed.valid) return TARGET_TRADE_SIDE;
    if (parsed.reason === 'LONG_DISABLED_SHORT_ONLY') return OPPOSITE_TRADE_SIDE;

    const value = upper(input);

    if (value.includes('MICRO_LONG_') || value.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (value.includes('MICRO_SHORT_') || value.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;

    return normalizeDirectSide(value);
  }

  for (const field of [
    input.tradeSide,
    input.targetTradeSide,
    input.positionSide,
    input.direction,
    input.signalSide,
    input.scannerSide,
    input.actualScannerSide,
    input.analysisSide,
    input.entrySide,
    input.dashboardSide,
    input.side
  ]) {
    const side = normalizeDirectSide(field);

    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const text = upper([
    input.microFamilyId,
    input.trueMicroFamilyId,
    input.learningFamilyId,
    input.learningMicroFamilyId,
    input.analyzeMicroFamilyId,
    input.childTrueMicroFamilyId,
    input.microMicroFamilyId,
    input.trueMicroMicroFamilyId,
    input.exactMicroMicroFamilyId,
    input.parentTrueMicroFamilyId,
    input.id,
    input.key,
    input.definition,
    input.microDefinition,
    input.microMicroDefinition
  ].filter(Boolean).join(' | '));

  if (text.includes('MICRO_LONG_') || text.includes('MM_LONG_')) return OPPOSITE_TRADE_SIDE;
  if (text.includes('MICRO_SHORT_') || text.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;

  if (input.shortOnly === true || input.longDisabled === true) return TARGET_TRADE_SIDE;
  if (input.longOnly === true || input.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isMicroMicroAnalyzeRow(row = {}) {
  const id = getExplicitMicroMicroId(row, row?.key);

  if (!id) return false;
  if (!isSelectableMicroMicroId(id)) return false;
  if (row.legacyScannerFamilyFallback === true || row.scannerFingerprintLegacy === true) return false;

  return isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id });
}

function normalizeMarketWeatherRegime(value = '') {
  const text = upper(value);

  if (text.includes('SQUEEZE') || text.includes('COMPRESS') || text.includes('COIL') || text.includes('LOW_VOL')) return 'SQUEEZE';
  if (text.includes('CHOP') || text.includes('RANGE') || text.includes('SIDEWAY') || text.includes('MIXED')) return 'CHOP';
  if (text.includes('TREND') || text.includes('MOMENTUM') || text.includes('DIRECTION') || text.includes('IMPULSE')) return 'TREND';

  return 'UNKNOWN';
}

function normalizeMarketWeatherTrendSide(value = '') {
  const side = normalizeDirectSide(value);

  if (side === TARGET_TRADE_SIDE) return 'BEARISH';
  if (side === OPPOSITE_TRADE_SIDE) return 'BULLISH';

  const text = upper(value);

  if (text.includes('BEAR') || text.includes('SHORT') || text.includes('SELL') || text.includes('DOWN') || text.includes('RISK_OFF')) {
    return 'BEARISH';
  }

  if (text.includes('BULL') || text.includes('LONG') || text.includes('BUY') || text.includes('UP') || text.includes('RISK_ON')) {
    return 'BULLISH';
  }

  if (text.includes('NEUTRAL') || text.includes('MIXED') || text.includes('FLAT')) {
    return 'NEUTRAL';
  }

  return 'UNKNOWN';
}

function buildMarketWeatherKeyV1({ regime, trendSide } = {}) {
  return `${normalizeMarketWeatherRegime(regime)}|${normalizeMarketWeatherTrendSide(trendSide)}`;
}

function parseMarketWeatherKey(key = '') {
  const raw = upper(key);

  if (!raw.includes('|') || raw.includes('[OBJECT OBJECT]')) {
    return {
      regime: 'UNKNOWN',
      trendSide: 'UNKNOWN',
      key: 'UNKNOWN|UNKNOWN',
      known: false
    };
  }

  const [regimeRaw, trendRaw] = raw.split('|');

  const regime = normalizeMarketWeatherRegime(regimeRaw);
  const trendSide = normalizeMarketWeatherTrendSide(trendRaw);
  const normalizedKey = `${regime}|${trendSide}`;

  return {
    regime,
    trendSide,
    key: normalizedKey,
    known: regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN'
  };
}

function currentMarketWeatherFromQuery(req) {
  const explicitKey = firstQueryValue(
    req.query?.confirmedMarketWeatherKey,
    firstQueryValue(
      req.query?.currentMarketWeatherKey,
      firstQueryValue(req.query?.marketWeatherKey, null)
    )
  );

  if (explicitKey) {
    const parsed = parseMarketWeatherKey(explicitKey);

    return {
      confirmedMarketWeatherKey: parsed.key,
      currentMarketWeatherKey: parsed.key,
      currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
      currentMarketWeatherRegime: parsed.regime,
      currentMarketWeatherTrendSide: parsed.trendSide,
      currentMarketWeatherAvailable: parsed.known,
      source: parsed.known ? 'QUERY_KEY' : 'QUERY_KEY_UNKNOWN_BLOCKED'
    };
  }

  const regime = normalizeMarketWeatherRegime(firstQueryValue(
    req.query?.confirmedMarketWeatherRegime,
    firstQueryValue(req.query?.currentMarketWeatherRegime, req.query?.marketWeatherRegime)
  ));

  const trendSide = normalizeMarketWeatherTrendSide(firstQueryValue(
    req.query?.confirmedMarketWeatherTrendSide,
    firstQueryValue(req.query?.currentMarketWeatherTrendSide, req.query?.marketWeatherTrendSide)
  ));

  const key = buildMarketWeatherKeyV1({ regime, trendSide });
  const known = regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN';

  return {
    confirmedMarketWeatherKey: key,
    currentMarketWeatherKey: key,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherRegime: regime,
    currentMarketWeatherTrendSide: trendSide,
    currentMarketWeatherAvailable: known,
    source: known ? 'QUERY_REGIME_TREND' : 'QUERY_REGIME_TREND_OR_UNKNOWN'
  };
}

function currentMarketKnownFields(currentMarket = {}) {
  const parsed = parseMarketWeatherKey(
    currentMarket.confirmedMarketWeatherKey ||
      currentMarket.currentMarketWeatherKey ||
      ''
  );

  if (!parsed.known) return null;

  return {
    key: parsed.key,
    regime: parsed.regime,
    trendSide: parsed.trendSide
  };
}

function rawEntryWeatherObject(row = {}) {
  const raw = row.entryMarketWeatherRaw ||
    row.entryMarketWeather ||
    row.lockedEntryMarketWeather ||
    null;

  return raw && typeof raw === 'object' ? raw : null;
}

function entryMarketWeatherFields(row = {}, currentMarket = {}) {
  const raw = rawEntryWeatherObject(row);

  const explicitEntryKey = firstValue(
    row.entryMarketWeatherKey,
    raw?.entryMarketWeatherKey
  );

  if (explicitEntryKey) {
    const parsed = parseMarketWeatherKey(explicitEntryKey);

    return {
      entryMarketWeatherKey: parsed.key,
      entryMarketWeatherKeyVersion: row.entryMarketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
      entryMarketWeatherRegime: parsed.regime,
      entryMarketWeatherTrendSide: parsed.trendSide,
      entryMarketWeatherCapturedAt:
        row.entryMarketWeatherCapturedAt ||
        row.entryCreatedAt ||
        row.openedAt ||
        row.createdAt ||
        raw?.createdAt ||
        raw?.completedAt ||
        raw?.updatedAt ||
        null,
      entryMarketWeatherRaw: raw,
      entryMarketWeatherRawAvailableFields: Array.isArray(row.entryMarketWeatherRawAvailableFields)
        ? row.entryMarketWeatherRawAvailableFields
        : raw
          ? Object.keys(raw).filter((key) => hasValue(raw[key])).sort()
          : [],
      entryMarketWeatherImmutable: row.entryMarketWeatherImmutable !== false,
      entryMarketWeatherNeverRecomputedAtExit:
        row.entryMarketWeatherNeverRecomputedAtExit !== false,

      adminMicroFamiliesOriginalEntryMarketWeatherKey: explicitEntryKey,
      adminMicroFamiliesWeatherFallbackApplied: false,
      adminMicroFamiliesPartialWeatherRepaired: false,
      adminMicroFamiliesEntryWeatherSource: 'STORED_ENTRY_KEY',
      adminMicroFamiliesCurrentConfirmedDidNotOverwriteEntry: true,

      confirmedMarketWeatherKey: currentMarket.confirmedMarketWeatherKey || null,
      currentMarketWeatherKey: currentMarket.currentMarketWeatherKey || null,
      currentMarketWeatherRegime: currentMarket.currentMarketWeatherRegime || null,
      currentMarketWeatherTrendSide: currentMarket.currentMarketWeatherTrendSide || null
    };
  }

  const regime = normalizeMarketWeatherRegime(firstValue(
    row.entryMarketWeatherRegime,
    raw?.entryMarketWeatherRegime,
    raw?.marketWeatherRegime
  ));

  const trendSide = normalizeMarketWeatherTrendSide(firstValue(
    row.entryMarketWeatherTrendSide,
    raw?.entryMarketWeatherTrendSide,
    raw?.marketWeatherTrendSide
  ));

  const key = buildMarketWeatherKeyV1({ regime, trendSide });
  const parsed = parseMarketWeatherKey(key);

  return {
    entryMarketWeatherKey: parsed.known ? parsed.key : 'UNKNOWN|UNKNOWN',
    entryMarketWeatherKeyVersion: row.entryMarketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherRegime: parsed.known ? parsed.regime : 'UNKNOWN',
    entryMarketWeatherTrendSide: parsed.known ? parsed.trendSide : 'UNKNOWN',
    entryMarketWeatherCapturedAt:
      row.entryMarketWeatherCapturedAt ||
      row.entryCreatedAt ||
      row.openedAt ||
      row.createdAt ||
      raw?.createdAt ||
      raw?.completedAt ||
      raw?.updatedAt ||
      null,
    entryMarketWeatherRaw: raw,
    entryMarketWeatherRawAvailableFields: Array.isArray(row.entryMarketWeatherRawAvailableFields)
      ? row.entryMarketWeatherRawAvailableFields
      : raw
        ? Object.keys(raw).filter((field) => hasValue(raw[field])).sort()
        : [],
    entryMarketWeatherImmutable: row.entryMarketWeatherImmutable !== false,
    entryMarketWeatherNeverRecomputedAtExit:
      row.entryMarketWeatherNeverRecomputedAtExit !== false,

    adminMicroFamiliesOriginalEntryMarketWeatherKey: row.entryMarketWeatherKey || null,
    adminMicroFamiliesWeatherFallbackApplied: false,
    adminMicroFamiliesPartialWeatherRepaired: false,
    adminMicroFamiliesEntryWeatherSource: parsed.known
      ? 'STORED_ENTRY_REGIME_TREND_FIELDS'
      : 'UNKNOWN_NO_ENTRY_WEATHER_ON_STORED_ROW',
    adminMicroFamiliesCurrentConfirmedDidNotOverwriteEntry: true,

    confirmedMarketWeatherKey: currentMarket.confirmedMarketWeatherKey || null,
    currentMarketWeatherKey: currentMarket.currentMarketWeatherKey || null,
    currentMarketWeatherRegime: currentMarket.currentMarketWeatherRegime || null,
    currentMarketWeatherTrendSide: currentMarket.currentMarketWeatherTrendSide || null
  };
}

function statsObject(row = {}) {
  const stats =
    row.netRStats ||
    row.shortNetRStats ||
    row.outcomeNetRStats ||
    null;

  return stats && typeof stats === 'object' ? stats : null;
}

function netRFromOutcome(outcome = {}) {
  const explicit = firstFinite(
    outcome.netR,
    outcome.shortNetR,
    outcome.exitR,
    outcome.realizedNetR,
    outcome.realizedR,
    outcome.r
  );

  if (explicit !== null) return explicit;

  const gross = firstFinite(
    outcome.grossR,
    outcome.shortGrossR,
    outcome.rawR,
    outcome.realizedGrossR
  );

  if (gross === null) return null;

  const cost = Math.max(0, firstFinite(
    outcome.costR,
    outcome.netCostR,
    outcome.estimatedCostR,
    outcome.avgCostR
  ) ?? 0);

  return gross - cost;
}

function recentOutcomeStats(row = {}) {
  const list = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  if (!list.length) return null;

  let completed = 0;
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let totalR = 0;
  let totalCostR = 0;
  let grossWinR = 0;
  let grossLossR = 0;
  let directSLCount = 0;
  let sumSqR = 0;

  for (const outcome of list) {
    if (!outcome || typeof outcome !== 'object') continue;

    const netR = netRFromOutcome(outcome);
    if (netR === null) continue;

    const costR = Math.max(0, firstFinite(
      outcome.costR,
      outcome.netCostR,
      outcome.estimatedCostR,
      outcome.avgCostR
    ) ?? 0);

    completed += 1;
    totalR += netR;
    totalCostR += costR;
    sumSqR += netR * netR;

    if (netR > 0) {
      wins += 1;
      grossWinR += netR;
    } else if (netR < 0) {
      losses += 1;
      grossLossR += Math.abs(netR);
    } else {
      flats += 1;
    }

    if (outcome.directSL || outcome.directToSL) {
      directSLCount += 1;
    }
  }

  if (completed <= 0) return null;

  const avgR = totalR / completed;
  const avgCostR = totalCostR / completed;
  const profitFactor = grossLossR > 0
    ? grossWinR / grossLossR
    : grossWinR > 0
      ? 99
      : 0;

  const lcb95AvgR = completed > 1
    ? avgR - 1.96 * Math.sqrt(Math.max(0, (sumSqR - (totalR * totalR) / completed) / (completed - 1))) / Math.sqrt(completed)
    : 0;

  return {
    source: 'RECENT_OUTCOMES_FALLBACK',
    completed,
    wins,
    losses,
    flats,
    totalR,
    avgR,
    totalCostR,
    avgCostR,
    grossWinR,
    grossLossR,
    profitFactor,
    directSLCount,
    directSLPct: directSLCount / completed,
    winrate: wins / completed,
    lcb95AvgR,
    avgRLCB95: lcb95AvgR
  };
}

function normalizedNetStats(row = {}) {
  const stats = statsObject(row);

  if (stats) {
    const completed = Math.max(0, num(stats.completed, 0));
    if (completed > 0) {
      const wins = Math.max(0, num(stats.wins, 0));
      const losses = Math.max(0, num(stats.losses, 0));
      const flats = Math.max(0, num(stats.flats, Math.max(0, completed - wins - losses)));
      const totalR = num(stats.totalR ?? stats.netTotalR ?? stats.shortNetTotalR, 0);
      const avgR = hasValue(stats.avgR)
        ? num(stats.avgR, 0)
        : totalR / completed;
      const totalCostR = Math.max(0, num(stats.totalCostR, 0));
      const avgCostR = hasValue(stats.avgCostR)
        ? Math.max(0, num(stats.avgCostR, 0))
        : totalCostR / completed;
      const grossWinR = Math.max(0, num(stats.grossWinR, 0));
      const grossLossR = Math.max(0, num(stats.grossLossR, 0));
      const profitFactor = hasValue(stats.profitFactor)
        ? num(stats.profitFactor, 0)
        : grossLossR > 0
          ? grossWinR / grossLossR
          : grossWinR > 0
            ? 99
            : 0;
      const directSLCount = Math.max(0, num(stats.directSLCount, 0));
      const lcb95AvgR = firstFinite(
        stats.lcb95AvgR,
        stats.avgRLCB95,
        stats.avgRLowerBound95
      );

      return {
        source: 'NET_R_STATS_SOURCE_OF_TRUTH',
        completed,
        wins,
        losses,
        flats,
        totalR,
        avgR,
        totalCostR,
        avgCostR,
        grossWinR,
        grossLossR,
        profitFactor,
        directSLCount,
        directSLPct: completed > 0 ? directSLCount / completed : 0,
        winrate: completed > 0 ? wins / completed : 0,
        lcb95AvgR,
        avgRLCB95: lcb95AvgR
      };
    }
  }

  return recentOutcomeStats(row);
}

function getOutcomeCounts(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return {
      wins: netStats.wins,
      losses: netStats.losses,
      flats: netStats.flats,
      total: netStats.completed
    };
  }

  const wins = Math.max(
    0,
    num(row.virtualWins, 0) + num(row.shadowWins, 0),
    num(row.wins, 0)
  );

  const losses = Math.max(
    0,
    num(row.virtualLosses, 0) + num(row.shadowLosses, 0),
    num(row.losses, 0)
  );

  const flats = Math.max(
    0,
    num(row.virtualFlats, 0) + num(row.shadowFlats, 0),
    num(row.flats, 0)
  );

  const completed = Math.max(
    wins + losses + flats,
    num(row.virtualCompleted, 0) + num(row.shadowCompleted, 0),
    num(row.closed, 0),
    num(row.completed, 0),
    num(row.outcomeSample, 0)
  );

  return {
    wins,
    losses,
    flats: Math.max(flats, Math.max(0, completed - wins - losses)),
    total: completed
  };
}

function getCompletedSample(row = {}) {
  return getOutcomeCounts(row).total;
}

function getObservationSample(row = {}) {
  return Math.max(
    num(row.observationSample, 0),
    num(row.seen, 0),
    num(row.observed, 0),
    num(row.observations, 0),
    getCompletedSample(row),
    0
  );
}

function getTotalR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return netStats.totalR;
  }

  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  const virtualShadowTotalR = num(row.virtualTotalR, 0) + num(row.shadowTotalR, 0);
  if (virtualShadowTotalR !== 0) return virtualShadowTotalR;

  const direct =
    row.shortNetTotalR ??
    row.netShortTotalR ??
    row.netTotalR ??
    row.totalNetR ??
    row.totalR;

  if (hasValue(direct)) return num(direct, 0);

  const avg = row.avgNetR ?? row.netAvgR ?? row.avgR;

  if (hasValue(avg)) return num(avg, 0) * completed;

  return 0;
}

function getAvgR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return netStats.avgR;
  }

  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  if (hasValue(row.avgNetR)) return num(row.avgNetR, 0);
  if (hasValue(row.netAvgR)) return num(row.netAvgR, 0);

  if (
    hasValue(row.avgR) &&
    !hasValue(row.totalR) &&
    !hasValue(row.netTotalR) &&
    !hasValue(row.totalNetR)
  ) {
    return num(row.avgR, 0);
  }

  return getTotalR(row) / completed;
}

function getLcb95AvgR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0 && netStats.lcb95AvgR !== null) {
    return netStats.lcb95AvgR;
  }

  const explicit = firstFinite(
    row.standaloneMicroMicroLifetimeLCB95AvgR,
    row.exactMicroMicroLifetimeLCB95AvgR,
    row.lcb95AvgR,
    row.avgRLCB95,
    row.avgRLcb95,
    row.avgRLowerBound95,
    row.avgRLowerConfidenceBound,
    row.lowerConfidenceBoundAvgR
  );

  if (explicit !== null) return explicit;

  const completed = getCompletedSample(row);
  const avgR = getAvgR(row);

  if (completed <= 1) return 0;

  return avgR - 1.96 * (1 / Math.sqrt(completed));
}

function getTotalCostR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return Math.max(0, netStats.totalCostR);
  }

  const completed = getCompletedSample(row);

  if (completed <= 0) return 0;

  const virtualShadowCost =
    Math.max(0, num(row.virtualTotalCostR, 0)) +
    Math.max(0, num(row.shadowTotalCostR, 0));

  if (virtualShadowCost > 0) return virtualShadowCost;

  if (hasValue(row.totalCostR)) return Math.max(0, num(row.totalCostR, 0));
  if (hasValue(row.totalNetCostR)) return Math.max(0, num(row.totalNetCostR, 0));
  if (hasValue(row.avgCostR)) return Math.max(0, num(row.avgCostR, 0)) * completed;
  if (hasValue(row.costR)) return Math.max(0, num(row.costR, 0)) * completed;

  return 0;
}

function getAvgCostR(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return Math.max(0, netStats.avgCostR);
  }

  const completed = getCompletedSample(row);
  return completed > 0 ? getTotalCostR(row) / completed : 0;
}

function getDirectSLCount(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return Math.max(0, netStats.directSLCount);
  }

  return Math.max(
    0,
    num(row.virtualDirectSLCount, 0) + num(row.shadowDirectSLCount, 0),
    num(row.directSLCount, 0),
    num(row.directToSLCount, 0)
  );
}

function getDirectSLPct(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return clamp(netStats.directSLPct, 0, 1);
  }

  if (hasValue(row.directSLPct)) {
    const direct = num(row.directSLPct, 0);
    return direct > 1 ? clamp(direct / 100, 0, 1) : clamp(direct, 0, 1);
  }

  const completed = getCompletedSample(row);
  return completed > 0 ? clamp(getDirectSLCount(row) / completed, 0, 1) : 0;
}

function getProfitFactor(row = {}) {
  const netStats = normalizedNetStats(row);

  if (netStats && netStats.completed > 0) {
    return netStats.profitFactor;
  }

  if (hasValue(row.netProfitFactor)) return num(row.netProfitFactor, 0);
  if (hasValue(row.profitFactor)) return num(row.profitFactor, 0);
  if (hasValue(row.pf)) return num(row.pf, 0);

  const winR = Math.max(
    num(row.virtualWinR, 0) + num(row.shadowWinR, 0),
    num(row.netWinR, 0),
    num(row.totalWinR, 0),
    num(row.grossWinR, 0),
    0
  );

  const lossR = Math.max(
    Math.abs(num(row.virtualLossR, 0) + num(row.shadowLossR, 0)),
    Math.abs(num(row.netLossR, 0)),
    Math.abs(num(row.totalLossR, 0)),
    Math.abs(num(row.grossLossR, 0)),
    0
  );

  if (winR <= 0 && lossR <= 0) return 0;
  if (lossR <= 0) return winR > 0 ? 99 : 0;

  return winR / lossR;
}

function wilsonLowerBound(successes, trials, z = 1.96) {
  const n = num(trials, 0);

  if (n <= 0) return 0;

  const p = clamp(successes / n, 0, 1);
  const z2 = z * z;
  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function sampleReliability(sample, cap = 50) {
  const n = num(sample, 0);
  return n > 0 ? clamp(Math.sqrt(Math.min(n, cap) / cap), 0, 1) : 0;
}

function getSampleAdjustedWinrate(row = {}) {
  const counts = getOutcomeCounts(row);
  const completed = counts.total;
  const observationSample = getObservationSample(row);

  if (completed <= 0) {
    return {
      sample: observationSample,
      outcomeSample: 0,
      observationSample,
      wins: 0,
      losses: 0,
      flats: 0,
      rawWinrate: 0,
      bayesianWinrate: 0,
      wilsonLowerBound: 0,
      reliability: sampleReliability(observationSample),
      score: 0,
      awaitingOutcomes: observationSample > 0
    };
  }

  const successes = counts.wins + counts.flats * 0.5;
  const rawWinrate = clamp(successes / completed, 0, 1);
  const bayesianWinrate = clamp((successes + 1) / (completed + 2), 0, 1);
  const wilson = wilsonLowerBound(successes, completed);
  const reliability = sampleReliability(completed);

  const score = clamp(
    wilson * 0.8 +
      bayesianWinrate * 0.15 +
      rawWinrate * 0.05,
    0,
    1
  );

  return {
    sample: completed,
    outcomeSample: completed,
    observationSample,
    wins: counts.wins,
    losses: counts.losses,
    flats: counts.flats,
    rawWinrate,
    bayesianWinrate,
    wilsonLowerBound: wilson,
    reliability,
    score,
    awaitingOutcomes: false
  };
}

function getBalancedScore(row = {}, winrateMeta = null) {
  const winrate = winrateMeta || getSampleAdjustedWinrate(row);

  if (winrate.outcomeSample <= 0 && winrate.observationSample > 0) {
    return Math.min(
      45,
      Math.log1p(winrate.observationSample) * 8 +
        winrate.reliability * 18
    );
  }

  return (
    winrate.score * 100 +
    winrate.reliability * 20 +
    Math.log1p(Math.max(0, getTotalR(row))) * 12 +
    Math.log1p(Math.max(0, getAvgR(row))) * 8 +
    Math.log1p(Math.min(Math.max(0, getProfitFactor(row)), 20)) * 3 -
    getDirectSLPct(row) * 60 -
    getAvgCostR(row) * 3
  );
}

function normalizeCurrentFitLabel(value = '') {
  const raw = upper(value);

  if (['FIT', 'MATCH', 'GOOD', 'ALIGNED', 'STRONG_MATCH'].includes(raw)) return 'FIT';
  if (['OK', 'WEAK_MATCH', 'PARTIAL_MATCH', 'SOFT_MATCH'].includes(raw)) return 'OK';
  if (['MISFIT', 'BAD', 'AGAINST', 'CONTRA', 'NO_FIT'].includes(raw)) return 'MISFIT';
  if (['NEUTRAL', 'MIXED'].includes(raw)) return 'NEUTRAL';

  return raw || 'UNKNOWN';
}

function currentFitLabelFromScore(score = 0, fallback = 'UNKNOWN') {
  const parsed = Number(score);

  if (!Number.isFinite(parsed)) return normalizeCurrentFitLabel(fallback);
  if (parsed >= 45) return 'FIT';
  if (parsed >= 20) return 'OK';
  if (parsed <= -20) return 'MISFIT';

  return 'NEUTRAL';
}

function getShortCurrentFit(row = {}) {
  const directShort = [
    row.shortCurrentFit,
    row.bearCurrentFit,
    row.currentFitShort,
    row.currentFitBear,
    row.shortFitScore,
    row.bearFitScore
  ].find((value) => Number.isFinite(Number(value)));

  if (hasValue(directShort)) {
    const score = Number(directShort);
    const label = currentFitLabelFromScore(
      score,
      row.currentFit || row.currentFitLabel || 'UNKNOWN'
    );

    return {
      currentFit: label,
      currentFitLabel: label,
      currentFitScore: round(score, 4),
      fitScore: round(score, 4),
      currentFitSource: 'EXPLICIT_SHORT_OR_BEAR_CURRENT_FIT'
    };
  }

  const direct = [
    row.currentFitScore,
    row.entryCurrentFitScore,
    row.marketFitScore,
    row.currentMarketFitScore,
    row.fitScore
  ].find((value) => Number.isFinite(Number(value)));

  if (hasValue(direct)) {
    const rawScore = Number(direct);
    const label = currentFitLabelFromScore(
      rawScore,
      row.currentFit || row.currentFitLabel || 'UNKNOWN'
    );

    return {
      currentFit: label,
      currentFitLabel: label,
      currentFitScore: round(rawScore, 4),
      fitScore: round(rawScore, 4),
      currentFitSource: 'GENERIC_CURRENT_FIT_SHORT_CONTEXT'
    };
  }

  const label = normalizeCurrentFitLabel(
    row.currentFitLabel ||
      row.currentFit ||
      row.fitLabel ||
      row.marketFit ||
      'UNKNOWN'
  );

  return {
    currentFit: label,
    currentFitLabel: label,
    currentFitScore: 0,
    fitScore: 0,
    currentFitSource: 'NO_NUMERIC_CURRENT_FIT'
  };
}

function hasTradeIdentity(row = {}) {
  return Boolean(
    row.tradeId ||
      row.positionId ||
      row.orderId ||
      row.outcomeIdentity ||
      row.stableOutcomeIdentity ||
      row.openedAt ||
      row.closedAt ||
      row.completedAt
  );
}

function hasStatsIdentity(row = {}) {
  return Boolean(
    row.netRStats ||
      row.shortNetRStats ||
      row.outcomeNetRStats ||
      row.marketWeatherStats ||
      Array.isArray(row.recentOutcomes) ||
      hasValue(row.completed) ||
      hasValue(row.outcomeSample) ||
      hasValue(row.closed) ||
      hasValue(row.seen) ||
      hasValue(row.observed) ||
      hasValue(row.observations)
  );
}

function isAggregateStatsRow(row = {}) {
  const id = getExplicitMicroMicroId(row, row?.key);
  const type = upper(row.type || row.rowType || row.eventType || '');

  if (!id) return false;

  if (
    type.includes('OUTCOME') ||
    type.includes('POSITION') ||
    type.includes('TRADE') ||
    type.includes('ENTRY') ||
    type.includes('CANDIDATE') ||
    type.includes('SIGNAL')
  ) {
    return false;
  }

  return hasStatsIdentity(row) && !hasTradeIdentity(row);
}

function isActionableTradeGeometryRow(row = {}) {
  if (!row || typeof row !== 'object') return false;
  if (isAggregateStatsRow(row)) return false;

  const type = upper(row.type || row.rowType || row.eventType || '');
  const source = upper(row.source || row.outcomeSource || row.positionSource || '');

  if (
    type.includes('OUTCOME') ||
    type.includes('POSITION') ||
    type.includes('TRADE') ||
    type.includes('ENTRY') ||
    type.includes('CANDIDATE') ||
    type.includes('SIGNAL')
  ) {
    return true;
  }

  if (
    source.includes('VIRTUAL') ||
    source.includes('SHADOW') ||
    source.includes('POSITION') ||
    source.includes('TRADE')
  ) {
    return Boolean(row.tradeId || row.positionId || row.symbol || row.contractSymbol);
  }

  return hasTradeIdentity(row);
}

function getShortRiskGeometry(row = {}) {
  const entry = Number(
    row.entryPrice ??
      row.entry ??
      row.avgEntryPrice ??
      row.averageEntryPrice ??
      row.openPrice
  );

  const initialSl = Number(
    row.initialSl ??
      row.initialSL ??
      row.initialStopLoss ??
      row.stopLoss ??
      row.stopLossPrice ??
      row.sl ??
      row.slPrice
  );

  const tp = Number(
    row.tp ??
      row.takeProfit ??
      row.takeProfitPrice ??
      row.targetPrice ??
      row.finalTp
  );

  const hasGeometry =
    Number.isFinite(entry) ||
    Number.isFinite(initialSl) ||
    Number.isFinite(tp);

  const completeGeometry =
    Number.isFinite(entry) &&
    Number.isFinite(initialSl) &&
    Number.isFinite(tp);

  const actionableTradeGeometryRow = isActionableTradeGeometryRow(row);
  const geometryPolicyCheckApplied = actionableTradeGeometryRow && completeGeometry;

  const denominator =
    Number.isFinite(entry) && Number.isFinite(initialSl)
      ? initialSl - entry
      : 0;

  const validGeometry =
    !geometryPolicyCheckApplied ||
    (
      denominator > 0 &&
      tp < entry &&
      entry < initialSl
    );

  return {
    entry: Number.isFinite(entry) ? entry : null,
    initialSl: Number.isFinite(initialSl) ? initialSl : null,
    tp: Number.isFinite(tp) ? tp : null,
    hasGeometry,
    completeGeometry,
    denominator,
    validGeometry,
    actionableTradeGeometryRow,
    aggregateStatsRow: isAggregateStatsRow(row),
    geometryPolicyCheckApplied,
    invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
    aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
    riskGeometryRule: 'SHORT: tp < entry < sl'
  };
}

function explicitForbiddenFlag(row = {}) {
  return Boolean(
    row.forbiddenFamily === true ||
      row.knownForbiddenFamily === true ||
      row.blacklistedFamily === true ||
      row.familyBlacklisted === true ||
      row.policy?.forbiddenFamily === true ||
      row.policy?.knownForbiddenFamily === true ||
      row.policyFlags?.forbiddenFamily === true ||
      row.policyFlags?.knownForbiddenFamily === true
  );
}

function inheritedForbiddenReasonText(row = {}) {
  return upper([
    row.reason,
    row.policyReason,
    row.policyBlockedReason,
    row.blockedReason,
    row.whyBlocked
  ].filter(Boolean).join('|'));
}

function isKnownForbiddenFamily(row = {}, parsed = null) {
  const id = getExplicitMicroMicroId(row, row?.key) ||
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.id ||
    row.key ||
    '';

  const p = parsed || parseShortTaxonomyMicroId(id);
  const confirmationProfile = upper(row.confirmationProfile || p.confirmationProfile);
  const reasonText = inheritedForbiddenReasonText(row);

  if (p.reason === 'LONG_DISABLED_SHORT_ONLY') return true;
  if (isScannerFingerprintId(id)) return true;
  if (isExecutionFingerprintId(id)) return true;

  if (confirmationProfile === 'E_WEAK_CONTRA') return false;

  if (explicitForbiddenFlag(row)) return true;

  if (
    reasonText.includes('KNOWN_FORBIDDEN_FAMILY') ||
    reasonText.includes('FORBIDDEN_FAMILY') ||
    reasonText.includes('BLACKLISTED_FAMILY')
  ) {
    return false;
  }

  return false;
}

function empiricalVetoGate(row = {}) {
  const id = getExplicitMicroMicroId(row, row.key);
  const completed = getCompletedSample(row);
  const lcb95AvgR = getLcb95AvgR(row);
  const parsed = parseShortTaxonomyMicroId(id);

  const exactMicroMicro =
    Boolean(id) &&
    parsed.isMicroMicro === true &&
    isSelectableMicroMicroId(id);

  const triggered =
    exactMicroMicro &&
    completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE &&
    lcb95AvgR !== null &&
    lcb95AvgR < 0;

  return {
    version: EMPIRICAL_VETO_VERSION,
    triggered,
    empiricalVeto: triggered,
    empiricalVetoReason: triggered
      ? 'EXACT_MICRO_MICRO_LCB95_NEGATIVE'
      : null,
    exactMicroMicro,
    id,
    microMicroFamilyId: id,
    completed: round(completed, 4),
    minCompleted: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
    standaloneMicroMicroLifetimeLCB95AvgR: lcb95AvgR === null ? null : round(lcb95AvgR, 6),
    usesRawAvgR: false,
    usesLcb95AvgR: true,
    blocksRiskEntry: triggered,
    blocksDiscordTradeReady: triggered,
    blocksParentFallbackRescue: triggered
  };
}

function microMicroRuntimeGate(row = {}) {
  const id = getExplicitMicroMicroId(row, row?.key);
  const parsed = parseShortTaxonomyMicroId(id);
  const fit = getShortCurrentFit(row);
  const geometry = getShortRiskGeometry(row);
  const veto = empiricalVetoGate(row);

  const completed = getCompletedSample(row);
  const observed = getObservationSample(row);
  const avgR = getAvgR(row);
  const totalR = getTotalR(row);
  const profitFactor = getProfitFactor(row);
  const avgCostR = getAvgCostR(row);
  const directSLPct = getDirectSLPct(row);
  const lcb95AvgR = getLcb95AvgR(row);
  const confirmationProfile = upper(row.confirmationProfile || parsed.confirmationProfile);

  const policyReasons = [];
  const edgeReasons = [];
  const softReasons = [];

  const inheritedReasonText = inheritedForbiddenReasonText(row);
  const inheritedForbiddenPolicyIgnored = Boolean(
    inheritedReasonText.includes('KNOWN_FORBIDDEN_FAMILY') ||
      inheritedReasonText.includes('FORBIDDEN_FAMILY') ||
      inheritedReasonText.includes('BLACKLISTED_FAMILY')
  ) && !explicitForbiddenFlag(row);

  if (!id || !isSelectableMicroMicroId(id)) {
    policyReasons.push('EXACT_MICRO_MICRO_ID_REQUIRED');
  }

  const inferredSide = inferTradeSide({
    ...row,
    trueMicroFamilyId: id,
    microMicroFamilyId: id
  });

  if (inferredSide === OPPOSITE_TRADE_SIDE) {
    policyReasons.push('LONG_DISABLED_SHORT_ONLY_SYSTEM');
  }

  if (inferredSide === 'UNKNOWN') {
    policyReasons.push('INVALID_SIDE_POLICY_BLOCK');
  }

  if (geometry.geometryPolicyCheckApplied && !geometry.validGeometry) {
    policyReasons.push('INVALID_SHORT_GEOMETRY_POLICY_BLOCK');
  }

  if (confirmationProfile === 'E_WEAK_CONTRA') {
    policyReasons.push('E_WEAK_CONTRA_POLICY_BLOCK');
  }

  if (isKnownForbiddenFamily(row, parsed)) {
    policyReasons.push('EXPLICIT_FORBIDDEN_FAMILY_POLICY_BLOCK');
  }

  if (fit.currentFitLabel === 'MISFIT') {
    softReasons.push('CURRENTFIT_MISFIT_SOFT_NO_TRADE_READY');
  }

  if (!(avgR > MIN_DISCORD_ACTIVATION_AVG_R)) {
    edgeReasons.push('AVG_R_NET_NOT_POSITIVE');
  }

  if (!(totalR > MIN_DISCORD_ACTIVATION_TOTAL_R)) {
    edgeReasons.push('TOTAL_R_NET_NOT_POSITIVE');
  }

  if (!(profitFactor > MIN_DISCORD_ACTIVATION_PROFIT_FACTOR)) {
    edgeReasons.push('PROFIT_FACTOR_NOT_ABOVE_1');
  }

  if (lcb95AvgR !== null && !(lcb95AvgR > MIN_DISCORD_ACTIVATION_LCB95_AVG_R)) {
    edgeReasons.push('LCB95_AVG_R_NOT_POSITIVE');
  }

  if (avgCostR > MAX_DISCORD_ACTIVATION_AVG_COST_R) {
    edgeReasons.push('AVG_COST_R_TOO_HIGH');
  }

  if (directSLPct > MAX_DISCORD_ACTIVATION_DIRECT_SL_PCT) {
    edgeReasons.push('DIRECT_SL_PCT_TOO_HIGH');
  }

  let status = MICRO_MICRO_STATUS_OBSERVING;
  let reasons = [];

  if (policyReasons.length > 0) {
    status = MICRO_MICRO_STATUS_POLICY_BLOCKED;
    reasons = policyReasons;
  } else if (veto.triggered) {
    status = MICRO_MICRO_STATUS_EMPIRICAL_VETO;
    reasons = [veto.empiricalVetoReason];
  } else if (completed < MIN_DISCORD_ACTIVATION_COMPLETED) {
    status = MICRO_MICRO_STATUS_OBSERVING;
    reasons = completed <= 0 && observed <= 0
      ? ['NO_PERSISTENT_STATS_YET_OBSERVING']
      : [`COMPLETED_BELOW_${MIN_DISCORD_ACTIVATION_COMPLETED}`];
  } else if (edgeReasons.length > 0) {
    status = MICRO_MICRO_STATUS_REJECTED;
    reasons = edgeReasons;
  } else {
    status = MICRO_MICRO_STATUS_PASSED;
    reasons = ['MICRO_MICRO_RUNTIME_GATE_PASSED'];
  }

  const passed = status === MICRO_MICRO_STATUS_PASSED;
  const observing = status === MICRO_MICRO_STATUS_OBSERVING;
  const rejected = status === MICRO_MICRO_STATUS_REJECTED;
  const empiricalVeto = status === MICRO_MICRO_STATUS_EMPIRICAL_VETO;
  const policyBlocked = status === MICRO_MICRO_STATUS_POLICY_BLOCKED;

  return {
    version: MICRO_MICRO_RUNTIME_GATE_VERSION,

    status,
    passed,
    observing,
    rejected,
    empiricalVeto,
    policyBlocked,

    eligible: passed,
    selectable: passed,
    activationEligible: passed,
    discordEligible: passed,
    discordActivationEligible: passed,

    virtualLearningAllowed: observing || passed,
    virtualObservationAllowed: observing || passed,
    virtualEntryAllowed: observing || passed,

    blocksNewVirtualEntry: rejected || empiricalVeto || policyBlocked,
    blocksDiscord: !passed,
    blocksRiskEntry: empiricalVeto || policyBlocked || rejected,

    reason: passed ? 'MICRO_MICRO_RUNTIME_GATE_PASSED' : reasons[0],
    reasons,
    policyReasons,
    edgeReasons,
    softReasons,

    inheritedForbiddenPolicyIgnored,
    inheritedForbiddenPolicyReason: inheritedForbiddenPolicyIgnored ? inheritedReasonText : null,
    broadKnownForbiddenFamilyPolicyDisabled: true,

    id,
    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId || null,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId || null,

    completed: round(completed, 4),
    observed: round(observed, 4),
    avgR: round(avgR, 4),
    totalR: round(totalR, 4),
    profitFactor: round(profitFactor, 4),
    avgCostR: round(avgCostR, 4),
    directSLPct: round(directSLPct, 4),
    lcb95AvgR: lcb95AvgR === null ? null : round(lcb95AvgR, 6),

    currentFit: fit.currentFitLabel,
    currentFitScore: round(fit.currentFitScore, 4),
    currentFitMisfitSoftOnly: fit.currentFitLabel === 'MISFIT',
    currentFitIsPolicyBlock: false,

    confirmationProfile,

    validShortGeometry: geometry.validGeometry,
    hasRiskGeometry: geometry.hasGeometry,
    completeRiskGeometry: geometry.completeGeometry,
    geometryPolicyCheckApplied: geometry.geometryPolicyCheckApplied,
    actionableTradeGeometryRow: geometry.actionableTradeGeometryRow,
    aggregateStatsRowGeometryIgnored: geometry.aggregateStatsRow,

    empiricalVetoGate: veto,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
    empiricalVetoReason: empiricalVeto ? veto.empiricalVetoReason : null,

    netRStatsSourceOfTruth: Boolean(normalizedNetStats(row)),
    netRStatsSource: normalizedNetStats(row)?.source || null,

    statusRank: STATUS_RANK[status] ?? STATUS_RANK.UNKNOWN,
    thresholds: activationGateConfig()
  };
}

// Helpers to reuse computed gates and stats
function runtimeGateOf(row = {}) {
  if (
    row.microMicroRuntimeGate &&
    typeof row.microMicroRuntimeGate === 'object'
  ) {
    return row.microMicroRuntimeGate;
  }
  return microMicroRuntimeGate(row);
}
function normalizedStatsOf(row = {}) {
  if (
    row.__normalizedNetStats &&
    typeof row.__normalizedNetStats === 'object'
  ) {
    return row.__normalizedNetStats;
  }
  return normalizedNetStats(row);
}

function getWeatherStatsObject(row = {}) {
  return row.marketWeatherStats ||
    row.weatherStats ||
    row.entryMarketWeatherStats ||
    {};
}

function selectWeatherAccumulator(row = {}, currentMarket = {}) {
  const stats = getWeatherStatsObject(row);

  const lifetime =
    stats.lifetime ||
    stats.all ||
    row.lifetimeStats ||
    row;

  const regimeStats =
    stats.regime ||
    stats.byRegime ||
    stats.marketWeatherRegime ||
    {};

  const regimeTrendStats =
    stats.regimeTrend ||
    stats.byRegimeTrend ||
    stats.marketWeatherRegimeTrend ||
    stats.marketWeatherKey ||
    stats.byMarketWeatherKey ||
    {};

  const regimeKey = currentMarket.currentMarketWeatherRegime;
  const regimeTrendKey = currentMarket.currentMarketWeatherKey;

  if (
    currentMarket.currentMarketWeatherAvailable &&
    regimeTrendKey &&
    regimeTrendStats[regimeTrendKey]
  ) {
    return {
      accumulator: regimeTrendStats[regimeTrendKey],
      familyResolution: 'MICRO_MICRO',
      marketResolution: 'REGIME_TREND',
      proofSource: 'MICRO_MICRO_REGIME_TREND',
      weatherMatched: true,
      playbookFresh: true,
      key: regimeTrendKey
    };
  }

  if (
    currentMarket.currentMarketWeatherAvailable &&
    regimeKey &&
    regimeStats[regimeKey]
  ) {
    return {
      accumulator: regimeStats[regimeKey],
      familyResolution: 'MICRO_MICRO',
      marketResolution: 'REGIME',
      proofSource: 'MICRO_MICRO_REGIME',
      weatherMatched: false,
      playbookFresh: false,
      key: regimeKey
    };
  }

  return {
    accumulator: lifetime,
    familyResolution: 'MICRO_MICRO',
    marketResolution: 'LIFETIME',
    proofSource: 'MICRO_MICRO_LIFETIME',
    weatherMatched: false,
    playbookFresh: false,
    key: null
  };
}

function proofTierFromGateAndMarket(gate = {}, market = {}) {
  if (gate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED) return PROOF_TIER_POLICY_BLOCKED;
  if (gate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO) return PROOF_TIER_EMPIRICAL_VETO;

  if (gate.status !== MICRO_MICRO_STATUS_PASSED) return PROOF_TIER_OBSERVATION_ONLY;

  if (market.marketResolution === 'REGIME_TREND') {
    return PROOF_TIER_MICRO_MICRO_MARKET;
  }

  if (market.marketResolution === 'LIFETIME') {
    return PROOF_TIER_MICRO_MICRO_LIFETIME;
  }

  return PROOF_TIER_OBSERVATION_ONLY;
}

function derivePreRiskSignalType({
  gate,
  currentMarket,
  marketCell,
  shrunkLCB95AvgR
} = {}) {
  if (gate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED) return SIGNAL_TYPE_BLOCKED;
  if (gate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO) return SIGNAL_TYPE_BLOCKED;
  if (gate.status === MICRO_MICRO_STATUS_REJECTED) return SIGNAL_TYPE_BLOCKED;

  if (!currentMarket.currentMarketWeatherAvailable) return SIGNAL_TYPE_OBSERVE_ONLY;

  if (gate.status === MICRO_MICRO_STATUS_OBSERVING) return SIGNAL_TYPE_OBSERVE_ONLY;

  if (gate.status !== MICRO_MICRO_STATUS_PASSED) return SIGNAL_TYPE_OBSERVE_ONLY;

  if (shrunkLCB95AvgR <= 0) return SIGNAL_TYPE_OBSERVE_ONLY;

  if (marketCell.marketResolution !== 'REGIME_TREND') return SIGNAL_TYPE_WATCH_ONLY;
  if (!marketCell.weatherMatched || !marketCell.playbookFresh) return SIGNAL_TYPE_WATCH_ONLY;

  return SIGNAL_TYPE_TRADE_READY;
}

function reasonForCandidate({
  gate,
  currentMarket,
  marketCell,
  preRiskSignalType,
  finalSignalType,
  shrunkLCB95AvgR,
  riskDecision
} = {}) {
  if (!currentMarket.currentMarketWeatherAvailable) return 'MARKET_WEATHER_UNKNOWN';
  if (gate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED) return gate.reason || 'POLICY_BLOCKED';
  if (gate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO) return 'EXACT_MICRO_MICRO_LCB95_NEGATIVE';
  if (gate.status === MICRO_MICRO_STATUS_REJECTED) return gate.reason || 'REJECTED_NET_EDGE';
  if (gate.status === MICRO_MICRO_STATUS_OBSERVING) return gate.reason || 'OBSERVE_ONLY_NOT_ENOUGH_COMPLETED_OUTCOMES';

  if (shrunkLCB95AvgR <= 0) return 'OBSERVE_ONLY_NO_POSITIVE_SHRUNK_LCB95';

  if (marketCell.marketResolution !== 'REGIME_TREND') {
    return 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER';
  }

  if (!marketCell.weatherMatched) return 'PLAYBOOK_WEATHER_MISMATCH';
  if (!marketCell.playbookFresh) return 'PLAYBOOK_MISSING_OR_STALE_FOR_CONFIRMED_WEATHER';

  if (preRiskSignalType === SIGNAL_TYPE_TRADE_READY && finalSignalType !== SIGNAL_TYPE_TRADE_READY) {
    return riskDecision?.reason || 'RISK_FRACTION_ZERO_AFTER_POSITION_SIZING';
  }

  if (finalSignalType === SIGNAL_TYPE_TRADE_READY) {
    return 'TRADE_READY_OBSERVE_MODE_VALIDATED_FOR_CURRENT_MARKET';
  }

  if (finalSignalType === SIGNAL_TYPE_WATCH_ONLY) {
    return 'WATCH_ONLY_CURRENT_MARKET_CANDIDATE';
  }

  return 'OBSERVE_ONLY_BEST_AVAILABLE_CANDIDATE';
}

function safeRiskDecisionForEntry(args = {}) {
  try {
    const decision = riskDecisionForEntry(args);
    if (decision && typeof decision === 'object') return decision;
  } catch {
    // force zero risk below
  }

  return {
    riskFraction: 0,
    riskFractionForEntry: 0,
    reason: 'RISK_DECISION_UNAVAILABLE'
  };
}

function buildCurrentMarketCandidate(row = {}, currentMarket = {}) {
  const gate = microMicroRuntimeGate(row);
  const marketCell = selectWeatherAccumulator(row, currentMarket);
  const accumulator = marketCell.accumulator || row;

  const cellAvgR = hasValue(accumulator.avgR)
    ? num(accumulator.avgR, 0)
    : getAvgR(accumulator);

  const cellTotalR = hasValue(accumulator.totalR)
    ? num(accumulator.totalR, 0)
    : getTotalR(accumulator);

  const cellCompleted = hasValue(accumulator.completed)
    ? num(accumulator.completed, 0)
    : getCompletedSample(accumulator);

  const cellProfitFactor = hasValue(accumulator.profitFactor)
    ? num(accumulator.profitFactor, 0)
    : getProfitFactor(accumulator);

  const cellAvgCostR = hasValue(accumulator.avgCostR)
    ? num(accumulator.avgCostR, 0)
    : getAvgCostR(accumulator);

  const cellDirectSLPct = hasValue(accumulator.directSLPct)
    ? num(accumulator.directSLPct, 0)
    : getDirectSLPct(accumulator);

  const shrunkLCB95AvgR = firstFinite(
    row.finalShrunkLCB95AvgR,
    row.shrunkLCB95AvgR,
    row.shrunkLcb95AvgR,
    row.shrunkAvgRLCB95,
    accumulator.finalShrunkLCB95AvgR,
    accumulator.shrunkLCB95AvgR,
    accumulator.lcb95AvgR,
    accumulator.avgRLCB95,
    getLcb95AvgR(accumulator),
    getLcb95AvgR(row),
    cellAvgR
  ) ?? 0;

  const shrunkAvgR = firstFinite(
    row.finalShrunkAvgR,
    row.shrunkAvgR,
    accumulator.finalShrunkAvgR,
    accumulator.shrunkAvgR,
    cellAvgR
  ) ?? 0;

  const proofTier = proofTierFromGateAndMarket(gate, marketCell);

  const preRiskSignalType = derivePreRiskSignalType({
    gate,
    currentMarket,
    marketCell,
    shrunkLCB95AvgR
  });

  const maxAllowedRiskBand =
    preRiskSignalType === SIGNAL_TYPE_TRADE_READY
      ? MAX_ALLOWED_RISK_BAND_HIGH
      : MAX_ALLOWED_RISK_BAND_ZERO;

  const riskDecision = safeRiskDecisionForEntry({
    weeklyStats: {
      ...row,
      ...currentMarket,

      proofTier,
      signalType: preRiskSignalType,
      maxAllowedRiskBand,

      shrunkLCB95AvgR,

      empiricalVeto: gate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO,
      empiricalVetoReason: gate.empiricalVetoReason,

      policyBlocked: gate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED,
      policyBlockedReason: gate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED ? gate.reason : null,

      weatherMatched: marketCell.weatherMatched,
      playbookFresh: marketCell.playbookFresh,
      fdrPassed: true
    },
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE
  });

  const rawRiskFractionForEntry = round(
    riskDecision.riskFractionForEntry ?? riskDecision.riskFraction ?? 0,
    6
  );

  const riskFractionForEntry =
    preRiskSignalType === SIGNAL_TYPE_TRADE_READY &&
    gate.status === MICRO_MICRO_STATUS_PASSED &&
    currentMarket.currentMarketWeatherAvailable &&
    marketCell.weatherMatched &&
    marketCell.playbookFresh &&
    shrunkLCB95AvgR > 0
      ? rawRiskFractionForEntry
      : 0;

  const finalSignalType =
    preRiskSignalType === SIGNAL_TYPE_TRADE_READY && riskFractionForEntry > 0
      ? SIGNAL_TYPE_TRADE_READY
      : preRiskSignalType === SIGNAL_TYPE_TRADE_READY
        ? SIGNAL_TYPE_OBSERVE_ONLY
        : preRiskSignalType;

  const selectedFamilyId = getExplicitMicroMicroId(row, row.key);

  const currentMarketScore =
    shrunkLCB95AvgR * 180 +
    shrunkAvgR * 100 +
    cellTotalR * 2 +
    Math.log1p(Math.max(0, cellCompleted)) * 5 +
    Math.log1p(Math.max(0, cellProfitFactor)) * 10 -
    cellAvgCostR * 30 -
    cellDirectSLPct * 70;

  const reason = reasonForCandidate({
    gate,
    currentMarket,
    marketCell,
    preRiskSignalType,
    finalSignalType,
    shrunkLCB95AvgR,
    riskDecision
  });

  return {
    ...currentMarket,

    selectedFamilyId,
    selectedMicroMicroFamilyId: selectedFamilyId,

    familyResolution: marketCell.familyResolution,
    marketResolution: marketCell.marketResolution,
    proofSource: marketCell.proofSource,
    proofTier,

    signalType: finalSignalType,
    preRiskSignalType,
    maxAllowedRiskBand,

    shrunkAvgR: round(shrunkAvgR, 6),
    shrunkLCB95AvgR: round(shrunkLCB95AvgR, 6),

    currentMarketCellCompleted: round(cellCompleted, 4),
    currentMarketCellAvgR: round(cellAvgR, 6),
    currentMarketCellTotalR: round(cellTotalR, 4),
    currentMarketCellProfitFactor: round(cellProfitFactor, 4),
    currentMarketCellAvgCostR: round(cellAvgCostR, 4),
    currentMarketCellDirectSLPct: round(cellDirectSLPct, 4),
    currentMarketScore: round(currentMarketScore, 4),

    weatherMatched: marketCell.weatherMatched,
    playbookFresh: marketCell.playbookFresh,
    fdrPassed: true,

    empiricalVeto: gate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO,
    empiricalVetoReason: gate.empiricalVetoReason,

    policyBlocked: gate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED,
    policyBlockedReason: gate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED ? gate.reason : null,

    inheritedForbiddenPolicyIgnored: gate.inheritedForbiddenPolicyIgnored,
    inheritedForbiddenPolicyReason: gate.inheritedForbiddenPolicyReason,

    riskDecision: {
      ...riskDecision,
      riskFractionForEntry,
      riskFraction: riskFractionForEntry,
      forcedZeroBecauseNotTradeReady: preRiskSignalType !== SIGNAL_TYPE_TRADE_READY || finalSignalType !== SIGNAL_TYPE_TRADE_READY
    },
    riskFraction: riskFractionForEntry,
    riskFractionForEntry,
    riskSourceOfTruth: 'riskFractionForEntry',

    selectorObserveOnly: true,
    sizingCapObserveOnly: true,
    fdrObserveOnly: true,
    discordTradeReadyHardLiveEnabled: false,

    reason,

    marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
    marketWeatherFdrVersion: MARKET_WEATHER_FDR_VERSION,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags()
  };
}

function compareNumberDesc(a, b) {
  return num(b, 0) - num(a, 0);
}

function compareNumberAsc(a, b) {
  return num(a, 0) - num(b, 0);
}

function compareIdAsc(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function netEdgeScore(row = {}) {
  const completed = getCompletedSample(row);
  const observed = getObservationSample(row);
  const avgR = getAvgR(row);
  const totalR = getTotalR(row);
  const pf = Math.min(20, getProfitFactor(row));
  const cost = getAvgCostR(row);
  const dsl = getDirectSLPct(row);
  const winrate = getSampleAdjustedWinrate(row);
  const lcb = getLcb95AvgR(row);

  return (
    avgR * 120 +
    (lcb ?? 0) * 150 +
    totalR * 2 +
    Math.log1p(Math.max(0, pf)) * 18 +
    winrate.score * 100 +
    winrate.reliability * 20 +
    Math.log1p(Math.max(0, observed)) * 1.5 +
    Math.log1p(Math.max(0, completed)) * 2 -
    cost * 35 -
    dsl * 85
  );
}

function compareRowsBase(a, b) {
  const gateA = runtimeGateOf(a);
  const gateB = runtimeGateOf(b);
  return (
    (STATUS_RANK[gateA.status] ?? STATUS_RANK.UNKNOWN) -
      (STATUS_RANK[gateB.status] ?? STATUS_RANK.UNKNOWN) ||
    compareNumberDesc(
      a.netEdgeScore ?? netEdgeScore(a),
      b.netEdgeScore ?? netEdgeScore(b)
    ) ||
    compareNumberDesc(
      a.lcb95AvgR ?? getLcb95AvgR(a) ?? 0,
      b.lcb95AvgR ?? getLcb95AvgR(b) ?? 0
    ) ||
    compareNumberDesc(
      a.totalR ?? getTotalR(a),
      b.totalR ?? getTotalR(b)
    ) ||
    compareNumberDesc(
      a.avgR ?? getAvgR(a),
      b.avgR ?? getAvgR(b)
    ) ||
    compareNumberDesc(
      a.profitFactor ?? getProfitFactor(a),
      b.profitFactor ?? getProfitFactor(b)
    ) ||
    compareNumberAsc(
      a.directSLPct ?? getDirectSLPct(a),
      b.directSLPct ?? getDirectSLPct(b)
    ) ||
    compareNumberAsc(
      a.avgCostR ?? getAvgCostR(a),
      b.avgCostR ?? getAvgCostR(b)
    ) ||
    compareNumberDesc(
      a.completed ?? getCompletedSample(a),
      b.completed ?? getCompletedSample(b)
    ) ||
    compareNumberDesc(
      a.observationSample ?? getObservationSample(a),
      b.observationSample ?? getObservationSample(b)
    ) ||
    compareIdAsc(
      a.trueMicroFamilyId ||
        getExplicitMicroMicroId(a, a?.key),
      b.trueMicroFamilyId ||
        getExplicitMicroMicroId(b, b?.key)
    )
  );
}

function compareCurrentMarketCandidates(a = {}, b = {}) {
  const ar = SIGNAL_RANK[upper(a.signalType)] ?? SIGNAL_RANK.UNKNOWN;
  const br = SIGNAL_RANK[upper(b.signalType)] ?? SIGNAL_RANK.UNKNOWN;

  return (
    ar - br ||
    compareNumberDesc(a.shrunkLCB95AvgR ?? 0, b.shrunkLCB95AvgR ?? 0) ||
    compareNumberDesc(a.shrunkAvgR ?? 0, b.shrunkAvgR ?? 0) ||
    compareNumberDesc(a.currentMarketScore ?? 0, b.currentMarketScore ?? 0) ||
    compareRowsBase(a, b)
  );
}

function compareRowsByMode(a, b, mode = DEFAULT_RANK_MODE) {
  if (mode === 'currentMarket') return compareCurrentMarketCandidates(a, b);

  if (mode === 'passed') {
    return (
      Number(runtimeGateOf(b).status === MICRO_MICRO_STATUS_PASSED) -
        Number(runtimeGateOf(a).status === MICRO_MICRO_STATUS_PASSED) ||
      compareRowsBase(a, b)
    );
  }

  if (mode === 'observe') {
    return (
      Number(runtimeGateOf(b).status === MICRO_MICRO_STATUS_OBSERVING) -
        Number(runtimeGateOf(a).status === MICRO_MICRO_STATUS_OBSERVING) ||
      compareRowsBase(a, b)
    );
  }

  if (mode === 'totalR') return compareNumberDesc(getTotalR(a), getTotalR(b)) || compareRowsBase(a, b);
  if (mode === 'avgR') return compareNumberDesc(getAvgR(a), getAvgR(b)) || compareRowsBase(a, b);
  if (mode === 'directSL') return compareNumberAsc(getDirectSLPct(a), getDirectSLPct(b)) || compareRowsBase(a, b);
  if (mode === 'observed') return compareNumberDesc(getObservationSample(a), getObservationSample(b)) || compareRowsBase(a, b);
  if (mode === 'cost') return compareNumberAsc(getAvgCostR(a), getAvgCostR(b)) || compareRowsBase(a, b);
  if (mode === 'currentFit') return compareNumberDesc(a.currentFitScore ?? a.fitScore, b.currentFitScore ?? b.fitScore) || compareRowsBase(a, b);
  if (mode === 'balanced') return compareNumberDesc(a.dashboardBalancedScore ?? a.balancedScore, b.dashboardBalancedScore ?? b.balancedScore) || compareRowsBase(a, b);

  return compareRowsBase(a, b);
}

function normalizeMicroMicroRow(row = {}, index = 0, activeSet = new Set(), compact = true, currentMarket = null) {
  const id = getExplicitMicroMicroId(row, row.key);
  const parsed = parseShortTaxonomyMicroId(id);

  if (!parsed.isMicroMicro) return null;
  if (!isShortRow({ ...row, trueMicroFamilyId: id, microMicroFamilyId: id })) return null;

  const normalizedStats = normalizedNetStats(row);
  const rowWithIdentity = {
    ...row,
    trueMicroFamilyId: id,
    microFamilyId: id,
    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id
  };
  const winrate = getSampleAdjustedWinrate(rowWithIdentity);
  const runtimeGate = microMicroRuntimeGate(rowWithIdentity);
  const marketFields = entryMarketWeatherFields(
    rowWithIdentity,
    currentMarket || {}
  );
  const fit = getShortCurrentFit(row);
  const currentMarketCandidate = currentMarket
    ? buildCurrentMarketCandidate(
        rowWithIdentity,
        currentMarket
      )
    : null;

  const normalized = {
    ...row,
    __normalizedNetStats: normalizedStats,

    rank: index + 1,

    id,
    key: id,
    microFamilyId: id,
    trueMicroFamilyId: id,
    analyzeMicroFamilyId: id,
    learningFamilyId: id,
    learningMicroFamilyId: id,

    microMicroFamilyId: id,
    trueMicroMicroFamilyId: id,
    exactMicroMicroFamilyId: id,

    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    base75ChildTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
    legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,
    familyId: parsed.parentTrueMicroFamilyId,
    macroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMacroFamilyId: parsed.parentTrueMicroFamilyId,
    parentMicroFamilyId: parsed.parentTrueMicroFamilyId,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    microMicroHash: parsed.microMicroHash,
    microMicroContext: parsed.microMicroContext,

    ...modePayload(),
    ...marketFields,

    inferredTradeSide: TARGET_TRADE_SIDE,

    isTrueMicro: true,
    isMicroMicro: true,
    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',

    active: activeSet.has(id),
    activeRawSelection: activeSet.has(id),
    activeDiscordEligible: activeSet.has(id) && runtimeGate.status === MICRO_MICRO_STATUS_PASSED,

    observationSample: round(winrate.observationSample, 4),
    outcomeSample: round(winrate.outcomeSample, 4),
    completed: round(winrate.outcomeSample, 4),
    seen: num(row.seen, 0),
    observed: num(row.observed, 0),
    observations: num(row.observations, 0),

    wins: round(winrate.wins, 4),
    losses: round(winrate.losses, 4),
    flats: round(winrate.flats, 4),

    winrate: round(winrate.rawWinrate, 4),
    sampleRawWinrate: round(winrate.rawWinrate, 4),
    bayesianWinrate: round(winrate.bayesianWinrate, 4),
    sampleBayesianWinrate: round(winrate.bayesianWinrate, 4),
    wilsonLowerBound: round(winrate.wilsonLowerBound, 4),
    sampleWilsonLowerBound: round(winrate.wilsonLowerBound, 4),
    sampleReliability: round(winrate.reliability, 4),
    fairWinrate: round(row.fairWinrate ?? row.sampleAdjustedWinrate ?? winrate.score, 4),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate ?? winrate.score, 4),

    totalR: round(getTotalR(row), 4),
    avgR: round(getAvgR(row), 4),
    lcb95AvgR: round(getLcb95AvgR(row), 6),
    avgRLCB95: round(getLcb95AvgR(row), 6),
    standaloneMicroMicroLifetimeLCB95AvgR: round(getLcb95AvgR(row), 6),

    profitFactor: round(getProfitFactor(row), 4),
    totalCostR: round(getTotalCostR(row), 4),
    avgCostR: round(getAvgCostR(row), 4),
    directSLCount: round(getDirectSLCount(row), 4),
    directSLPct: round(getDirectSLPct(row), 4),

    netRStatsSourceOfTruth: true,
    netRStatsSource: normalizedStats?.source || null,
    netRStatsPresent: Boolean(statsObject(row)),
    recentOutcomesFallbackUsed:
      normalizedStats?.source === 'RECENT_OUTCOMES_FALLBACK',

    dashboardBalancedScore: round(row.dashboardBalancedScore ?? getBalancedScore(row, winrate), 4),
    balancedScore: round(row.balancedScore ?? getBalancedScore(row, winrate), 4),
    netEdgeScore: round(netEdgeScore(row), 4),

    ...fit,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitIsPolicyBlock: false,
    currentFitBlocksDiscordOnly: fit.currentFitLabel === 'MISFIT',

    microMicroRuntimeGate: runtimeGate,
    microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    microMicroRuntimeStatus: runtimeGate.status,
    microMicroRuntimeGateStatus: runtimeGate.status,
    microMicroStatus: runtimeGate.status,
    microMicroRuntimeReason: runtimeGate.reason,
    microMicroRuntimeReasons: runtimeGate.reasons,

    status: `MICRO_MICRO_${runtimeGate.status}`,
    learningStatus: `MICRO_MICRO_${runtimeGate.status}`,
    tier:
      runtimeGate.status === MICRO_MICRO_STATUS_PASSED
        ? 'PASSED'
        : runtimeGate.status === MICRO_MICRO_STATUS_OBSERVING
          ? 'OBS'
          : runtimeGate.status,

    microMicroPassed: runtimeGate.status === MICRO_MICRO_STATUS_PASSED,
    microMicroObserving: runtimeGate.status === MICRO_MICRO_STATUS_OBSERVING,
    microMicroRejected: runtimeGate.status === MICRO_MICRO_STATUS_REJECTED,
    microMicroEmpiricalVeto: runtimeGate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO,
    microMicroPolicyBlocked: runtimeGate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED,

    empiricalVeto: runtimeGate.status === MICRO_MICRO_STATUS_EMPIRICAL_VETO,
    empiricalVetoReason: runtimeGate.empiricalVetoReason,
    empiricalVetoGate: runtimeGate.empiricalVetoGate,
    empiricalVetoVersion: EMPIRICAL_VETO_VERSION,

    policyBlocked: runtimeGate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED,
    policyBlockedReason:
      runtimeGate.status === MICRO_MICRO_STATUS_POLICY_BLOCKED
        ? runtimeGate.reason
        : null,

    inheritedForbiddenPolicyIgnored: runtimeGate.inheritedForbiddenPolicyIgnored,
    inheritedForbiddenPolicyReason: runtimeGate.inheritedForbiddenPolicyReason,

    allowVirtualEntry: runtimeGate.virtualEntryAllowed,
    virtualEntryAllowedByMicroMicroGate: runtimeGate.virtualEntryAllowed,
    virtualEntryBlockedByMicroMicroGate: runtimeGate.blocksNewVirtualEntry,
    virtualEntryBlockedReason: runtimeGate.blocksNewVirtualEntry ? runtimeGate.reason : null,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    executionFingerprintRole: 'MICRO_MICRO_CONTEXT_HASH_METADATA',
    executionFingerprintsUsedAsLearningFamily: false,

    sourceWeekKey: PERSISTENT_LEARNING_KEY,
    sourceWeekPrimary: true,

    definition: row.definition || row.microDefinition || '',
    microDefinition: row.microDefinition || row.definition || '',
    microMicroDefinition: row.microMicroDefinition || '',
    definitionParts: Array.isArray(row.definitionParts) ? row.definitionParts : [],
    microDefinitionParts: Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : [],
    microMicroDefinitionParts: Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : []
  };

  if (currentMarketCandidate) {
    Object.assign(normalized, currentMarketCandidate, {
      currentMarketCandidate: {
        currentMarketWeatherKey: currentMarketCandidate.currentMarketWeatherKey,
        currentMarketWeatherRegime: currentMarketCandidate.currentMarketWeatherRegime,
        currentMarketWeatherTrendSide: currentMarketCandidate.currentMarketWeatherTrendSide,
        selectedFamilyId: currentMarketCandidate.selectedFamilyId,
        familyResolution: currentMarketCandidate.familyResolution,
        marketResolution: currentMarketCandidate.marketResolution,
        proofSource: currentMarketCandidate.proofSource,
        proofTier: currentMarketCandidate.proofTier,
        signalType: currentMarketCandidate.signalType,
        maxAllowedRiskBand: currentMarketCandidate.maxAllowedRiskBand,
        shrunkAvgR: currentMarketCandidate.shrunkAvgR,
        shrunkLCB95AvgR: currentMarketCandidate.shrunkLCB95AvgR,
        empiricalVeto: currentMarketCandidate.empiricalVeto,
        empiricalVetoReason: currentMarketCandidate.empiricalVetoReason,
        policyBlocked: currentMarketCandidate.policyBlocked,
        policyBlockedReason: currentMarketCandidate.policyBlockedReason,
        inheritedForbiddenPolicyIgnored: currentMarketCandidate.inheritedForbiddenPolicyIgnored,
        inheritedForbiddenPolicyReason: currentMarketCandidate.inheritedForbiddenPolicyReason,
        riskFraction: currentMarketCandidate.riskFraction,
        riskFractionForEntry: currentMarketCandidate.riskFractionForEntry,
        reason: currentMarketCandidate.reason,
        weatherMatched: currentMarketCandidate.weatherMatched,
        playbookFresh: currentMarketCandidate.playbookFresh,
        fdrPassed: currentMarketCandidate.fdrPassed
      }
    });
  }

  if (compact) {
    delete normalized.recentOutcomes;
    delete normalized.examples;
    delete normalized.counters;
    delete normalized.rawCandles;
    delete normalized.rawKlines;
    delete normalized.marketWeatherStats;
    delete normalized.weatherStats;
    delete normalized.entryMarketWeatherStats;
    delete normalized.netRStats;
    delete normalized.shortNetRStats;
    delete normalized.outcomeNetRStats;
    delete normalized.entryMarketWeatherRaw;
    delete normalized.raw;
    delete normalized.payload;
    delete normalized.debug;
    delete normalized.diagnostics;
    delete normalized.riskDecision;
    delete normalized.__normalizedNetStats;
  }

  return normalized;
}

function hiddenLayerCountsFromMicros(micros = {}) {
  const counts = {
    parent15: 0,
    child75: 0,
    microMicro: 0,
    scanner: 0,
    executionFingerprint: 0,
    long: 0,
    unknown: 0
  };

  for (const [key, row] of sourceEntriesFromMicros(micros)) {
    const idText =
      row?.trueMicroFamilyId ||
      row?.microMicroFamilyId ||
      row?.microFamilyId ||
      key ||
      '';

    const parsed = parseShortTaxonomyMicroId(idText);

    if (inferTradeSide({ ...row, key }) === OPPOSITE_TRADE_SIDE || parsed.reason === 'LONG_DISABLED_SHORT_ONLY') {
      counts.long += 1;
    } else if (isScannerFingerprintId(idText) || isScannerFingerprintId(key)) {
      counts.scanner += 1;
    } else if (isExecutionFingerprintId(idText) || isExecutionFingerprintId(key)) {
      counts.executionFingerprint += 1;
    } else if (parsed.isMicroMicro) {
      counts.microMicro += 1;
    } else if (parsed.isChild) {
      counts.child75 += 1;
    } else if (parsed.isParent) {
      counts.parent15 += 1;
    } else {
      counts.unknown += 1;
    }
  }

  return counts;
}

function buildRowsFromMicros(
  micros = {},
  activeSet = new Set(),
  compact = true,
  currentMarket = null,
  options = {}
) {
  const rows = [];
  const seen = new Set();

  const deadlineAt = num(
    options.deadlineAt,
    0
  );
  const maxSourceRows = Math.max(
    1,
    Math.floor(
      num(
        options.maxSourceRows,
        MAX_SOURCE_MICRO_ROWS
      )
    )
  );
  let sourceRowsInspected = 0;
  let processingTruncated = false;

  for (const [key, row] of sourceEntriesFromMicros(micros)) {
    if (sourceRowsInspected >= maxSourceRows) {
      processingTruncated = true;
      break;
    }
    if (
      deadlineReached(
        deadlineAt,
        ROUTE_PROCESSING_RESERVE_MS
      )
    ) {
      processingTruncated = true;
      break;
    }
    sourceRowsInspected += 1;

    if (!row || typeof row !== 'object') continue;

    const id = getExplicitMicroMicroId({ ...row, key }, key);

    if (!id || !isSelectableMicroMicroId(id)) continue;
    if (seen.has(id)) continue;

    seen.add(id);

    const normalized = normalizeMicroMicroRow({
      ...row,
      id,
      key: id,
      microFamilyId: id,
      trueMicroFamilyId: id,
      analyzeMicroFamilyId: id,
      learningFamilyId: id,
      learningMicroFamilyId: id,
      microMicroFamilyId: id,
      trueMicroMicroFamilyId: id,
      exactMicroMicroFamilyId: id,
      active: activeSet.has(id)
    }, rows.length, activeSet, compact, currentMarket);

    if (normalized) rows.push(normalized);
  }

  return {
    rows,
    sourceRowsInspected,
    processingTruncated
  };
}

function normalizeActiveRotationObject(rotation = null) {
  if (!rotation || typeof rotation !== 'object') return null;
  return rotation.activeRotation || rotation.active || rotation.rotation || rotation;
}

function extractActiveMicroMicroIds(activeRotationRaw = null) {
  const activeRotation = normalizeActiveRotationObject(activeRotationRaw);
  if (!activeRotation) return [];

  const rows = [
    ...(Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies : []),
    ...(Array.isArray(activeRotation.rows) ? activeRotation.rows : []),
    ...(Array.isArray(activeRotation.activeRows) ? activeRotation.activeRows : []),
    ...(Array.isArray(activeRotation.selectedRows) ? activeRotation.selectedRows : [])
  ];

  return uniqueStrings([
    activeRotation.microMicroFamilyIds || [],
    activeRotation.trueMicroMicroFamilyIds || [],
    activeRotation.exactMicroMicroFamilyIds || [],
    activeRotation.activeMicroMicroFamilyIds || [],
    activeRotation.selectedMicroMicroFamilyIds || [],
    activeRotation.microFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    activeRotation.ids || [],
    rows.map((row) => getExplicitMicroMicroId(row, row?.key))
  ])
    .map((id) => parseShortTaxonomyMicroId(id).trueMicroFamilyId)
    .filter(Boolean)
    .filter(isSelectableMicroMicroId)
    .filter((id) => inferTradeSide(id) !== OPPOSITE_TRADE_SIDE)
    .slice(0, MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES);
}

function extractLegacyActiveChild75Ids(activeRotationRaw = null) {
  const activeRotation = normalizeActiveRotationObject(activeRotationRaw);
  if (!activeRotation) return [];

  const rows = [
    ...(Array.isArray(activeRotation.microFamilies) ? activeRotation.microFamilies : []),
    ...(Array.isArray(activeRotation.rows) ? activeRotation.rows : []),
    ...(Array.isArray(activeRotation.activeRows) ? activeRotation.activeRows : []),
    ...(Array.isArray(activeRotation.selectedRows) ? activeRotation.selectedRows : [])
  ];

  return uniqueStrings([
    activeRotation.childTrueMicroFamilyIds || [],
    activeRotation.active75ChildFamilyIds || [],
    activeRotation.microFamilyIds || [],
    activeRotation.trueMicroFamilyIds || [],
    rows.map((row) => row?.childTrueMicroFamilyId || row?.base75ChildTrueMicroFamilyId || row?.trueMicroFamilyId)
  ]).filter((id) => parseShortTaxonomyMicroId(id).isChild);
}

function rowMatchesSearch(row = {}, q = '') {
  if (!q) return true;

  const haystack = [
    row.trueMicroFamilyId,
    row.microMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.parentTrueMicroFamilyId,
    row.setupType,
    row.regimeBucket,
    row.confirmationProfile,
    row.status,
    row.learningStatus,
    row.tier,
    row.microMicroStatus,
    row.microMicroRuntimeStatus,
    row.currentFit,
    row.currentFitLabel,
    row.microMicroHash,
    row.microMicroContext,
    row.entryMarketWeatherKey,
    row.entryMarketWeatherRegime,
    row.entryMarketWeatherTrendSide,
    row.currentMarketWeatherKey,
    row.signalType,
    row.proofTier,
    row.proofSource,
    row.reason,
    row.definition,
    row.microDefinition,
    row.microMicroDefinition
  ].filter(Boolean).join(' | ');

  return upper(haystack).includes(q);
}

function parseFilters(req) {
  return {
    side: upper(firstQueryValue(req.query?.side, TARGET_TRADE_SIDE)),
    q: upper(firstQueryValue(req.query?.q, '')),
    activeOnly: isTrue(firstQueryValue(req.query?.activeOnly, false), false),
    minCompleted: num(firstQueryValue(req.query?.minCompleted, 0), 0),
    setup: upper(firstQueryValue(req.query?.setup, '')),
    regime: upper(firstQueryValue(req.query?.regime, '')),
    confirmationProfile: upper(firstQueryValue(req.query?.confirmationProfile, '')),
    currentFit: upper(firstQueryValue(req.query?.currentFit, '')),
    runtimeStatus: upper(firstQueryValue(req.query?.runtimeStatus, '')),
    signalType: upper(firstQueryValue(req.query?.signalType, '')),
    proofTier: upper(firstQueryValue(req.query?.proofTier, '')),
    marketWeatherKey: upper(firstQueryValue(req.query?.marketWeatherKey, firstQueryValue(req.query?.currentMarketWeatherKey, ''))),
    diagnostics: isTrue(firstQueryValue(req.query?.diagnostics, false), false)
  };
}

function rowPassesFilters(row = {}, filters, activeSet = new Set()) {
  const parsed = parseShortTaxonomyMicroId(row.trueMicroFamilyId || row.microMicroFamilyId);
  const gate = runtimeGateOf(row);

  if (!isMicroMicroAnalyzeRow(row)) return false;
  if (filters.side && ['LONG', 'BULL', 'BULLISH', 'BUY'].includes(filters.side)) return false;
  if (filters.activeOnly && !activeSet.has(row.trueMicroFamilyId)) return false;
  if (filters.minCompleted > 0 && getCompletedSample(row) < filters.minCompleted) return false;
  if (filters.setup && parsed.setup !== filters.setup) return false;
  if (filters.regime && parsed.regime !== filters.regime) return false;
  if (filters.confirmationProfile && parsed.confirmationProfile !== filters.confirmationProfile) return false;
  if (filters.currentFit && upper(row.currentFitLabel || row.currentFit) !== filters.currentFit) return false;
  if (filters.runtimeStatus && gate.status !== filters.runtimeStatus) return false;
  if (filters.signalType && upper(row.signalType) !== filters.signalType) return false;
  if (filters.proofTier && upper(row.proofTier) !== filters.proofTier) return false;
  if (filters.marketWeatherKey && upper(row.currentMarketWeatherKey || row.entryMarketWeatherKey) !== filters.marketWeatherKey) return false;

  if (!filters.diagnostics && upper(row.signalType) === SIGNAL_TYPE_BLOCKED) {
    return false;
  }

  return rowMatchesSearch(row, filters.q);
}

function countBy(rows = [], fn) {
  return rows.reduce((acc, row) => {
    const key = fn(row) || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function activationSummary(rows = []) {
  const eligible = [];
  const blocked = [];
  const blockedReasonCounts = {};
  const statusCounts = {};
  for (const row of rows) {
    const gate = runtimeGateOf(row);
    const status = gate.status || 'UNKNOWN';
    statusCounts[status] =
      (statusCounts[status] || 0) + 1;
    if (status === MICRO_MICRO_STATUS_PASSED) {
      eligible.push(row);
      continue;
    }
    blocked.push(row);
    for (const reason of gate.reasons || [
      gate.reason || 'UNKNOWN'
    ]) {
      blockedReasonCounts[reason] =
        (blockedReasonCounts[reason] || 0) + 1;
    }
  }
  return {
    version: DISCORD_ACTIVATION_GATE_VERSION,
    runtimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
    total: rows.length,
    eligible: eligible.length,
    blocked: blocked.length,
    statusCounts,
    eligibleIds: eligible.map(
      (row) => row.trueMicroFamilyId
    ),
    topEligibleIds: [...eligible]
      .sort(compareRowsBase)
      .slice(
        0,
        MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES
      )
      .map((row) => row.trueMicroFamilyId),
    blockedReasonCounts,
    thresholds: activationGateConfig()
  };
}

function compactBestRow(row = null) {
  if (!row || !isMicroMicroAnalyzeRow(row)) return null;

  return {
    id: row.trueMicroFamilyId,
    trueMicroFamilyId: row.trueMicroFamilyId,
    microMicroFamilyId: row.microMicroFamilyId,
    setupType: row.setupType,
    regimeBucket: row.regimeBucket,
    confirmationProfile: row.confirmationProfile,
    signalType: row.signalType,
    proofTier: row.proofTier,
    shrunkAvgR: row.shrunkAvgR,
    shrunkLCB95AvgR: row.shrunkLCB95AvgR,
    riskFractionForEntry: row.riskFractionForEntry,
    reason: row.reason,
    entryMarketWeatherKey: row.entryMarketWeatherKey,
    currentMarketWeatherKey: row.currentMarketWeatherKey,
    confirmedMarketWeatherKey: row.confirmedMarketWeatherKey,
    marketResolution: row.marketResolution,
    proofSource: row.proofSource,
    empiricalVeto: row.empiricalVeto,
    policyBlocked: row.policyBlocked,
    policyBlockedReason: row.policyBlockedReason,
    inheritedForbiddenPolicyIgnored: row.inheritedForbiddenPolicyIgnored,
    completed: row.completed,
    totalR: row.totalR,
    avgR: row.avgR,
    profitFactor: row.profitFactor,
    directSLPct: row.directSLPct,
    avgCostR: row.avgCostR,
    netRStatsSource: row.netRStatsSource
  };
}

function buildCurrentMarketPlaybook(rows = [], currentMarket = {}) {
  const candidates = rows
    .map((row) => {
      if (
        row.selectedFamilyId &&
        row.signalType &&
        hasValue(row.shrunkLCB95AvgR)
      ) {
        return row;
      }
      return {
        ...row,
        ...buildCurrentMarketCandidate(
          row,
          currentMarket
        )
      };
    })
    .sort(compareCurrentMarketCandidates)
    .slice(0, MAX_PLAYBOOK_CANDIDATES);

  const tradeReady = candidates.find((row) => row.signalType === SIGNAL_TYPE_TRADE_READY) || null;
  const watch = candidates.find((row) => row.signalType === SIGNAL_TYPE_WATCH_ONLY) || null;
  const observe = candidates.find((row) => row.signalType === SIGNAL_TYPE_OBSERVE_ONLY) || null;
  const blocked = candidates.find((row) => row.signalType === SIGNAL_TYPE_BLOCKED) || null;

  const selected =
    tradeReady ||
    watch ||
    observe ||
    blocked ||
    null;

  let answerType = 'NO_CANDIDATES';

  if (tradeReady) answerType = 'BEST_TRADE_READY';
  else if (watch) answerType = 'BEST_WATCH';
  else if (observe) answerType = 'BEST_OBSERVE_ONLY';
  else if (blocked) answerType = 'ALL_BLOCKED';

  return {
    version: MARKET_WEATHER_SELECTOR_VERSION,
    fdrVersion: MARKET_WEATHER_FDR_VERSION,
    featureFlags: marketWeatherFeatureFlags(),

    ...currentMarket,

    selectorMode: 'OBSERVE_ONLY',
    sizingCapMode: 'OBSERVE_ONLY',
    fdrMode: 'OBSERVE_ONLY',
    discordTradeReadyHardLiveEnabled: false,

    alwaysAnswer: true,
    alwaysAnswerDoesNotMeanAlwaysTrade: true,

    answerType,
    selected: compactBestRow(selected),
    bestForCurrentMarket: compactBestRow(selected),
    bestTradeReady: compactBestRow(tradeReady),
    bestWatch: compactBestRow(watch),
    bestObserveOnly: compactBestRow(observe),
    bestBlocked: compactBestRow(blocked),

    tradeReadyCount: candidates.filter((row) => row.signalType === SIGNAL_TYPE_TRADE_READY).length,
    watchCount: candidates.filter((row) => row.signalType === SIGNAL_TYPE_WATCH_ONLY).length,
    observeOnlyCount: candidates.filter((row) => row.signalType === SIGNAL_TYPE_OBSERVE_ONLY).length,
    blockedCount: candidates.filter((row) => row.signalType === SIGNAL_TYPE_BLOCKED).length,

    candidates: candidates.slice(0, 25).map((row, index) => ({
      rank: index + 1,
      selectedFamilyId: row.selectedFamilyId,
      entryMarketWeatherKey: row.entryMarketWeatherKey,
      currentMarketWeatherKey: row.currentMarketWeatherKey,
      familyResolution: row.familyResolution,
      marketResolution: row.marketResolution,
      proofSource: row.proofSource,
      proofTier: row.proofTier,
      signalType: row.signalType,
      shrunkAvgR: row.shrunkAvgR,
      shrunkLCB95AvgR: row.shrunkLCB95AvgR,
      empiricalVeto: row.empiricalVeto,
      empiricalVetoReason: row.empiricalVetoReason,
      policyBlocked: row.policyBlocked,
      policyBlockedReason: row.policyBlockedReason,
      inheritedForbiddenPolicyIgnored: row.inheritedForbiddenPolicyIgnored,
      weatherMatched: row.weatherMatched,
      playbookFresh: row.playbookFresh,
      fdrPassed: row.fdrPassed,
      riskFraction: row.riskFraction,
      riskFractionForEntry: row.riskFractionForEntry,
      reason: row.reason
    }))
  };
}

function buildSummary(rows = [], activeSet = new Set()) {
  const completed = rows.reduce((sum, row) => sum + getCompletedSample(row), 0);
  const observationSample = rows.reduce((sum, row) => sum + getObservationSample(row), 0);
  const totalR = rows.reduce((sum, row) => sum + getTotalR(row), 0);
  const totalCostR = rows.reduce((sum, row) => sum + getTotalCostR(row), 0);
  const directSLCount = rows.reduce((sum, row) => sum + getDirectSLCount(row), 0);

  return {
    rows: rows.length,
    microMicroRows: rows.length,
    child75Rows: 0,
    parent15Rows: 0,
    activeRows: rows.filter((row) => activeSet.has(row.trueMicroFamilyId)).length,
    activeIds: activeSet.size,

    completed: round(completed, 4),
    observationSample: round(observationSample, 4),
    completedMicroMicroFamilies: rows.filter((row) => getCompletedSample(row) > 0).length,

    runtimeStatusCounts: countBy(
      rows,
      (row) => runtimeGateOf(row).status
    ),
    signalTypeCounts: countBy(rows, (row) => upper(row.signalType || SIGNAL_TYPE_OBSERVE_ONLY)),
    currentFitCounts: countBy(rows, (row) => upper(row.currentFitLabel || row.currentFit || 'UNKNOWN')),

    inheritedForbiddenPolicyIgnoredRows: rows.filter(
      (row) =>
        runtimeGateOf(row).inheritedForbiddenPolicyIgnored
    ).length,

    totalR: round(totalR, 4),
    totalCostR: round(totalCostR, 4),
    avgR: completed > 0 ? round(totalR / completed, 4) : 0,
    avgCostR: completed > 0 ? round(totalCostR / completed, 4) : 0,
    directSLCount: round(directSLCount, 4),
    directSLPct: completed > 0 ? round(directSLCount / completed, 4) : 0,

    netRStatsSourceOfTruth: true,
    bestMicroMicro: compactBestRow([...rows].sort(compareRowsBase)[0] || null)
  };
}

function getCachedWeekMicros(weekKey) {
  const cached = cache.weekMicros.get(weekKey);

  if (cached && now() - cached.ts <= CACHE_TTL_MS) return cached.micros || {};

  return null;
}

async function getWeekMicrosCached(
  weekKey,
  timeoutMs = WEEK_MICROS_TIMEOUT_MS,
  deadlineAt = 0
) {
  const cached = getCachedWeekMicros(weekKey);

  if (cached) {
    return {
      weekKey,
      micros: cached,
      cacheHit: true,
      stale: false,
      warning: null
    };
  }

  try {
    const micros = await withTimeout(
      getWeekMicros(weekKey),
      boundedTimeoutMs(
        timeoutMs,
        deadlineAt
      ),
      `GET_WEEK_MICROS_TIMEOUT_${weekKey}`
    );

    const safeMicros = micros && typeof micros === 'object' ? micros : {};

    cache.weekMicros.set(weekKey, {
      ts: now(),
      micros: safeMicros
    });

    while (cache.weekMicros.size > CACHE_MAX_KEYS) {
      cache.weekMicros.delete(cache.weekMicros.keys().next().value);
    }

    return {
      weekKey,
      micros: safeMicros,
      cacheHit: false,
      stale: false,
      warning: null
    };
  } catch (error) {
    const stale = cache.weekMicros.get(weekKey);

    if (stale?.micros) {
      return {
        weekKey,
        micros: stale.micros,
        cacheHit: true,
        stale: true,
        warning: error?.message || String(error)
      };
    }

    return {
      weekKey,
      micros: {},
      cacheHit: false,
      stale: false,
      warning: error?.message || String(error)
    };
  }
}

async function getActiveRotationSafe(
  deadlineAt = 0
) {
  const cached = cache.activeRotation;
  try {
    const value = await withTimeout(
      getActiveRotation({
        tradeSide: TARGET_TRADE_SIDE,
        side: TARGET_DASHBOARD_SIDE,
        dashboardSide: TARGET_DASHBOARD_SIDE,
        weekKey: PERSISTENT_LEARNING_KEY,
        persistentLearningKey:
          PERSISTENT_LEARNING_KEY,
        namespace: SHORT_NAMESPACE,
        keyPrefix: SHORT_KEY_PREFIX,
        redisNamespace: SHORT_NAMESPACE,
        redisKeyPrefix: SHORT_KEY_PREFIX,
        shortOnly: true,
        longDisabled: true,
        microMicroOnly: true,
        selectableMicroMicroOnly: true,
        selectionGranularity:
          'EXACT_MICRO_MICRO_ONLY',
        discordOnlyForExactMicroMicroMatch: true,
        microMicroRuntimeGateVersion:
          MICRO_MICRO_RUNTIME_GATE_VERSION,
        discordActivationGateVersion:
          DISCORD_ACTIVATION_GATE_VERSION,
        empiricalVetoVersion:
          EMPIRICAL_VETO_VERSION
      }),
      boundedTimeoutMs(
        ACTIVE_ROTATION_TIMEOUT_MS,
        deadlineAt
      ),
      'GET_ACTIVE_ROTATION_TIMEOUT'
    );
    cache.activeRotation = {
      ts: now(),
      value: value || null
    };
    return {
      value: value || null,
      cacheHit: false,
      stale: false,
      warning: null
    };
  } catch (error) {
    if (cached?.value) {
      return {
        value: cached.value,
        cacheHit: true,
        stale: true,
        warning:
          error?.message ||
          String(error)
      };
    }
    return {
      value: null,
      cacheHit: false,
      stale: false,
      warning:
        error?.message ||
        String(error)
    };
  }
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modePayload()
  });
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Micro-Families-Mode', 'short-only-v5-bounded-paginated-memoized');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Micro-Micro-Only', 'true');
  res.setHeader('X-Micro-Micro-Schema', MICRO_MICRO_SCHEMA);
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_MICRO_MICRO_ID');
  res.setHeader('X-Discord-Selection-Rule', 'EXACT_MICRO_MICRO_ONLY');
  res.setHeader('X-Learning-Identity-Source', 'ANALYZE_MICRO_MICRO_FAMILY');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.setHeader('X-Min-Completed-Micro-Micro-Active', String(MIN_COMPLETED_MICRO_MICRO_ACTIVE));
  res.setHeader('X-Micro-Micro-Runtime-Gate-Version', MICRO_MICRO_RUNTIME_GATE_VERSION);
  res.setHeader('X-Discord-Activation-Gate-Version', DISCORD_ACTIVATION_GATE_VERSION);
  res.setHeader('X-Market-Weather-Key-Version', MARKET_WEATHER_KEY_VERSION);
  res.setHeader('X-Market-Weather-Selector-Version', MARKET_WEATHER_SELECTOR_VERSION);
  res.setHeader('X-Empirical-Veto-Version', EMPIRICAL_VETO_VERSION);
  res.setHeader('X-Broad-Known-Forbidden-Family-Policy-Disabled', 'true');
  res.setHeader('X-B-Flow-Align-Auto-Forbidden', 'false');
  res.setHeader('X-Entry-Market-Weather-Immutable', 'true');
  res.setHeader('X-Current-Confirmed-Weather-Does-Not-Overwrite-Entry', 'true');
  res.setHeader('X-NetR-Stats-Source-Of-Truth', 'true');
  res.setHeader('X-Invalid-Geometry-Only-For-Actionable-Trade-Rows', 'true');
}

export default async function handler(req, res) {
  const startedAt = now();
  const deadlineAt =
    startedAt + ROUTE_HARD_DEADLINE_MS;
  setHeaders(res);

  if (req.method !== 'GET') return methodNotAllowed(res);

  try {
    const requestedQueryWeekKey = String(
      firstQueryValue(req.query?.weekKey, PERSISTENT_LEARNING_KEY) ||
        PERSISTENT_LEARNING_KEY
    ).trim();

    const mode = normalizeMode(firstQueryValue(req.query?.mode, DEFAULT_RANK_MODE));
    const limit = toSafeLimit(firstQueryValue(req.query?.limit, DEFAULT_LIMIT), DEFAULT_LIMIT, MAX_LIMIT);
    const bestLimit = toSafeLimit(firstQueryValue(req.query?.bestLimit, DEFAULT_BEST_LIMIT), DEFAULT_BEST_LIMIT, MAX_BEST_LIMIT);
    const compact = !isTrue(firstQueryValue(req.query?.details, false), false);
    const filters = parseFilters(req);
    const currentMarket = currentMarketWeatherFromQuery(req);

    const pagination = parsePagination(
      req,
      limit
    );
    const {
      page,
      offset
    } = pagination;

    const [
      activeRotationResult,
      weekResult
    ] = await Promise.all([
      getActiveRotationSafe(deadlineAt),
      getWeekMicrosCached(
        PERSISTENT_LEARNING_KEY,
        WEEK_MICROS_TIMEOUT_MS,
        deadlineAt
      )
    ]);
    const activeRotationRaw =
      activeRotationResult.value;

    const configuredActiveMicroMicroFamilyIds = extractActiveMicroMicroIds(activeRotationRaw);
    const legacyChild75ActiveIdsIgnored = extractLegacyActiveChild75Ids(activeRotationRaw);

    const activeSet = new Set(configuredActiveMicroMicroFamilyIds);
    const hiddenCounts = hiddenLayerCountsFromMicros(weekResult.micros);

    const builtRowsResult =
      buildRowsFromMicros(
        weekResult.micros,
        activeSet,
        compact,
        currentMarket,
        {
          deadlineAt,
          maxSourceRows:
            MAX_SOURCE_MICRO_ROWS
        }
      );
    const rows = builtRowsResult.rows
      .filter(isMicroMicroAnalyzeRow);

    const rowById = new Map(
      rows.map((row) => [
        row.trueMicroFamilyId,
        row
      ])
    );
    const runtimeEligibleActiveIds =
      configuredActiveMicroMicroFamilyIds.filter(
        (id) => {
          const row =
            rowById.get(id) ||
            {
              id,
              key: id,
              trueMicroFamilyId: id,
              microMicroFamilyId: id
            };
          return (
            runtimeGateOf(row).status ===
            MICRO_MICRO_STATUS_PASSED
          );
        }
      );

    const runtimeBlockedActiveIds = configuredActiveMicroMicroFamilyIds.filter(
      (id) => !runtimeEligibleActiveIds.includes(id)
    );

    const runtimeEligibleActiveSet = new Set(runtimeEligibleActiveIds);

    const rowsWithActive = rows.map((row) => {
      const gate = runtimeGateOf(row);
      return {
        ...row,
        active:
          runtimeEligibleActiveSet.has(
            row.trueMicroFamilyId
          ),
        activeRawSelection:
          activeSet.has(
            row.trueMicroFamilyId
          ),
        activeDiscordEligible:
          runtimeEligibleActiveSet.has(
            row.trueMicroFamilyId
          ) &&
          gate.status ===
            MICRO_MICRO_STATUS_PASSED
      };
    });

    const filteredRows = rowsWithActive.filter((row) => rowPassesFilters(row, filters, runtimeEligibleActiveSet));

    const rankedRows = [...filteredRows]
      .sort((a, b) => compareRowsByMode(a, b, mode))
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const bestRows = [...rowsWithActive]
      .sort((a, b) => compareRowsByMode(a, b, mode))
      .slice(0, bestLimit)
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const responseRows = rankedRows
      .slice(
        offset,
        offset + limit
      )
      .map((row, index) => ({
        ...row,
        rank: offset + index + 1
      }));

    const bestMicroMicroFamilies =
      bestRows.map((row, index) => ({
        ...row,
        rank: index + 1
      }));

    const currentMarketPlaybook = buildCurrentMarketPlaybook(rowsWithActive, currentMarket);

    const activation = activationSummary(rowsWithActive);
    const filteredActivation = activationSummary(rankedRows);

    const inheritedForbiddenPolicyIgnoredRows = rowsWithActive.filter(
      (row) => runtimeGateOf(row).inheritedForbiddenPolicyIgnored
    ).length;

    const invalidGeometryPolicyRows = rowsWithActive.filter(
      (row) => runtimeGateOf(row).policyReasons.includes('INVALID_SHORT_GEOMETRY_POLICY_BLOCK')
    ).length;

    const aggregateGeometryIgnoredRows = rowsWithActive.filter(
      (row) => runtimeGateOf(row).aggregateStatsRowGeometryIgnored
    ).length;

    const netRStatsRows = rowsWithActive.filter(
      (row) => Boolean(
        row.__normalizedNetStats ||
        normalizedStatsOf(row)
      )
    ).length;

    // Voeg waarschuwing toe als we de limiet hebben bereikt
    const maxRowsReachedWarning = builtRowsResult.processingTruncated
      ? `MAX_SOURCE_MICRO_ROWS_REACHED:${MAX_SOURCE_MICRO_ROWS}; response may be incomplete`
      : null;

    const warnings = uniqueWarnings([
      requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY
        ? `QUERY_WEEKKEY_IGNORED_USING_PERSISTENT:${requestedQueryWeekKey}`
        : null,
      weekResult.warning,
      activeRotationResult.warning,
      activeRotationResult.stale
        ? 'USING_STALE_ACTIVE_ROTATION_CACHE'
        : null,
      builtRowsResult.processingTruncated
        ? `MICRO_FAMILY_PROCESSING_TRUNCATED:${builtRowsResult.sourceRowsInspected}`
        : null,
      maxRowsReachedWarning,
      deadlineReached(deadlineAt)
        ? 'ADMIN_MICRO_FAMILIES_INTERNAL_DEADLINE_REACHED'
        : null,
      weekResult.stale ? 'USING_STALE_WEEK_MICROS_CACHE' : null,
      legacyChild75ActiveIdsIgnored.length > 0
        ? `LEGACY_CHILD75_ACTIVE_IDS_IGNORED_MICRO_MICRO_ONLY:${legacyChild75ActiveIdsIgnored.length}`
        : null,
      runtimeBlockedActiveIds.length > 0
        ? `ACTIVE_MICRO_MICRO_IDS_FILTERED_BY_RUNTIME_GATE:${runtimeBlockedActiveIds.length}`
        : null,
      inheritedForbiddenPolicyIgnoredRows > 0
        ? `INHERITED_BROAD_FORBIDDEN_POLICY_IGNORED_FOR_VALID_MICRO_MICRO_ROWS:${inheritedForbiddenPolicyIgnoredRows}`
        : null,
      invalidGeometryPolicyRows > 0
        ? `INVALID_GEOMETRY_POLICY_ROWS_ACTIONABLE_ONLY:${invalidGeometryPolicyRows}`
        : null,
      aggregateGeometryIgnoredRows > 0
        ? `AGGREGATE_STATS_ROWS_GEOMETRY_POLICY_IGNORED:${aggregateGeometryIgnoredRows}`
        : null,
      hiddenCounts.scanner > 0
        ? `SCANNER_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${hiddenCounts.scanner}`
        : null,
      hiddenCounts.executionFingerprint > 0
        ? `EXECUTION_FINGERPRINT_ROWS_HIDDEN_METADATA_ONLY:${hiddenCounts.executionFingerprint}`
        : null,
      hiddenCounts.child75 > 0
        ? `CHILD75_ROWS_USED_AS_CONTEXT_ONLY_HIDDEN_FROM_ADMIN:${hiddenCounts.child75}`
        : null,
      hiddenCounts.parent15 > 0
        ? `PARENT15_ROWS_HIDDEN_METADATA_ONLY:${hiddenCounts.parent15}`
        : null,
      hiddenCounts.long > 0
        ? `LONG_ROWS_IGNORED_SHORT_ONLY:${hiddenCounts.long}`
        : null,
      rows.length === 0
        ? 'NO_EXPLICIT_MICRO_MICRO_ROWS_AVAILABLE'
        : null,
      activation.total > 0 && activation.eligible === 0
        ? 'NO_DISCORD_ACTIVATION_ELIGIBLE_MICRO_MICRO_ROWS_NET_EDGE_GATE'
        : null,
      currentMarket.currentMarketWeatherAvailable === false
        ? 'CURRENT_MARKET_WEATHER_UNKNOWN_PASS_CONFIRMEDMARKETWEATHERKEY_OR_REGIME_TREND'
        : null
    ]);

    return res.status(200).json({
      ok: true,
      fixed: true,

      ...modePayload(),

      availableRuntimeStatuses: [
        MICRO_MICRO_STATUS_PASSED,
        MICRO_MICRO_STATUS_OBSERVING,
        MICRO_MICRO_STATUS_REJECTED,
        MICRO_MICRO_STATUS_EMPIRICAL_VETO,
        MICRO_MICRO_STATUS_POLICY_BLOCKED
      ],

      availableSignalTypes: [
        SIGNAL_TYPE_TRADE_READY,
        SIGNAL_TYPE_WATCH_ONLY,
        SIGNAL_TYPE_OBSERVE_ONLY,
        SIGNAL_TYPE_BLOCKED
      ],

      availableProofTiers: [
        PROOF_TIER_MICRO_MICRO_MARKET,
        PROOF_TIER_MICRO_MICRO_LIFETIME,
        PROOF_TIER_OBSERVATION_ONLY,
        PROOF_TIER_EMPIRICAL_VETO,
        PROOF_TIER_POLICY_BLOCKED
      ],

      marketWeather: {
        version: MARKET_WEATHER_KEY_VERSION,
        aggregationVersion: MARKET_WEATHER_AGGREGATION_VERSION,
        selectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
        fdrVersion: MARKET_WEATHER_FDR_VERSION,
        featureFlags: marketWeatherFeatureFlags(),
        naming: {
          allowedFields: [
            'entryMarketWeatherKey',
            'entryMarketWeatherKeyVersion',
            'entryMarketWeatherRegime',
            'entryMarketWeatherTrendSide',
            'entryMarketWeatherCapturedAt',
            'entryMarketWeatherRaw',
            'entryMarketWeatherRawAvailableFields',
            'currentMarketWeatherKey',
            'confirmedMarketWeatherKey'
          ],
          forbiddenAliases: [
            'entryMarketRegime',
            'entryMarketKey'
          ]
        },
        v1KeyRule: 'entryMarketWeatherRegime + "|" + entryMarketWeatherTrendSide',
        entryWeatherRule: 'entryMarketWeatherKey is immutable and is never repaired from current/confirmed weather in this endpoint',
        currentWeatherRule: 'currentMarketWeatherKey is dashboard context only',
        confirmedWeatherRule: 'confirmedMarketWeatherKey is backend-current context only',
        current: currentMarket
      },

      currentMarketPlaybook,
      bestForCurrentMarket: currentMarketPlaybook.bestForCurrentMarket,
      bestTradeReadyForCurrentMarket: currentMarketPlaybook.bestTradeReady,
      bestWatchForCurrentMarket: currentMarketPlaybook.bestWatch,
      bestObserveOnlyForCurrentMarket: currentMarketPlaybook.bestObserveOnly,
      currentMarketAnswerType: currentMarketPlaybook.answerType,

      manualSelectionPolicy: {
        maxActiveMicroFamilies: MAX_ACTIVE_DISCORD_MICRO_MICRO_FAMILIES,
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
        selectableMicroMicroIdsAllowed: true,
        selectable75ChildIdsAllowed: false,
        selectableParentIdsAllowed: false,
        selectableRequiresRuntimeGatePassed: true,
        child75ProxySelectionDisabled: true,
        parentIdsAreMetadataOnly: true,
        child75IdsAreContextOnly: true,
        parentMatchDoesNotTriggerDiscord: true,
        child75MatchDoesNotTriggerDiscord: true,
        scannerFingerprintsUsedAsLearningFamily: false,
        executionFingerprintsUsedAsLearningFamily: false
      },

      empiricalVetoPolicy: {
        version: EMPIRICAL_VETO_VERSION,
        separateFromPolicyBlocked: true,
        rule: 'exact micro-micro completed >= 35 AND standalone lifetime LCB95(avgR) < 0',
        usesRawAvgR: false,
        usesLcb95AvgR: true,
        blocksDiscordTradeReady: true,
        blocksRiskEntry: true,
        blocksParentFallbackRescue: true,
        stillVisibleInDashboard: true
      },

      forbiddenFamilyPolicy: {
        broadKnownForbiddenFamilyPolicyDisabled: true,
        knownForbiddenFamilyByTextMatchDisabled: true,
        explicitForbiddenFlagRequired: true,
        bFlowAlignAutoForbidden: false,
        ignoredInheritedForbiddenRows: inheritedForbiddenPolicyIgnoredRows,
        stillBlockedReasons: [
          'LONG_DISABLED_SHORT_ONLY_SYSTEM',
          'INVALID_SIDE_POLICY_BLOCK',
          'INVALID_SHORT_GEOMETRY_POLICY_BLOCK_ACTIONABLE_ROWS_ONLY',
          'E_WEAK_CONTRA_POLICY_BLOCK',
          'EXPLICIT_FORBIDDEN_FAMILY_POLICY_BLOCK',
          'SCANNER_FINGERPRINT_METADATA_ONLY',
          'RAW_EXECUTION_FINGERPRINT_NOT_SELECTABLE'
        ],
        invalidGeometryPolicyBlockOnlyForActionableTradeRows: true,
        aggregateRowsDoNotUseGeometryAsPolicyBlock: true,
        invalidGeometryPolicyRows,
        aggregateGeometryIgnoredRows
      },

      statsPolicy: {
        netRStatsSourceOfTruth: true,
        netRStatsRows,
        completedReadsNetRStatsFirst: true,
        totalRReadsNetRStatsFirst: true,
        avgRReadsNetRStatsFirst: true,
        profitFactorReadsNetRStatsFirst: true,
        recentOutcomesFallbackEnabled: true
      },

      riskPolicy: {
        sourceOfTruth: 'riskFractionForEntry',
        proofTierIsLabelOnly: true,
        signalTypeIsActionLabelOnly: true,
        maxAllowedRiskBandIsOptionalCap: true,
        policyBlockedRisk: 0,
        empiricalVetoRisk: 0,
        observeOnlyRisk: 0,
        watchOnlyRisk: 0,
        tradeReadyRisk: 'computed by riskFractionForEntry only after all gates pass'
      },

      microMicroRuntimeGate: activationGateConfig(),
      microMicroRuntimeGateSummary: activation,
      discordActivationGate: activationGateConfig(),
      discordActivationSummary: activation,
      filteredDiscordActivationSummary: filteredActivation,

      taxonomy: {
        parentCount: 15,
        child75ContextCount: 75,
        selectableChildCount: 0,
        selectableMicroMicroCount: rowsWithActive.length,
        setups: SETUP_ORDER,
        regimes: REGIME_ORDER,
        confirmationProfiles: CONFIRMATION_PROFILE_ORDER,
        parentFormat: 'MICRO_SHORT_{SETUP}_{REGIME}',
        childFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}',
        microMicroFormat: 'MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}_MM_{CONTEXT_HASH}',
        selectableIdsAreMicroMicroOnly: true,
        child75IdsAreContextOnly: true,
        parentIdsAreMetadataOnly: true,
        parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
        childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
        microMicroFamilySchema: MICRO_MICRO_SCHEMA
      },

      rankingPolicy: {
        defaultMode: DEFAULT_RANK_MODE,
        activeMode: mode,
        defaultSort:
          'currentMarket first, then TRADE_READY, WATCH_ONLY, OBSERVE_ONLY, BLOCKED; then shrunkLCB/netEdge/fairWinrate/totalR/avgR/PF/directSL/cost',
        currentMarketFirst: true,
        runtimeGateFirst: true,
        rawWinrateIsNeverDefault: true,
        pnlSource: 'totalR',
        winrateSource: 'fairWinrate',
        scannerFingerprintsExcludedFromRows: true,
        exactMicroMicroOnly: true,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        empiricalVetoSeparateFromPolicyBlocked: true,
        observingAboveRejected: true
      },

      weekKey: PERSISTENT_LEARNING_KEY,
      requestedWeekKey:
        requestedQueryWeekKey,
      requestedQueryWeekKey,
      ignoredQueryWeekKey: requestedQueryWeekKey !== PERSISTENT_LEARNING_KEY ? requestedQueryWeekKey : null,
      sourceWeekKeyUsed:
        PERSISTENT_LEARNING_KEY,
      source: 'persistentLearningKey',

      mode,
      limit,
      bestLimit,
      filters,
      compact,
      page,
      offset,
      pagination: {
        page,
        offset,
        limit,
        returned:
          responseRows.length,
        filteredTotal:
          rankedRows.length,
        totalAvailable:
          rowsWithActive.length,
        hasPrevious:
          offset > 0,
        hasMore:
          offset + responseRows.length <
          rankedRows.length,
        nextOffset:
          offset + responseRows.length <
          rankedRows.length
            ? offset + responseRows.length
            : null,
        previousOffset:
          offset > 0
            ? Math.max(0, offset - limit)
            : null,
        totalPages:
          limit > 0
            ? Math.ceil(
                rankedRows.length / limit
              )
            : 0
      },

      count: responseRows.length,
      filtered: rankedRows.length,
      totalAvailable: rowsWithActive.length,

      rows: responseRows,
      microRows: responseRows,
      microFamilies: responseRows,
      availableRows: responseRows,
      availableMicroFamilies: responseRows,
      microMicroRows: responseRows,
      microMicroFamilies: responseRows,

      bestCount: bestMicroMicroFamilies.length,
      bestRows: bestMicroMicroFamilies,
      best: bestMicroMicroFamilies,
      bestMicroFamilies: bestMicroMicroFamilies,
      bestMicroMicroRows: bestMicroMicroFamilies,
      bestMicroMicroFamilies,

      rawRows: compact ? [] : rowsWithActive,
      rawMicroMicroRows: compact ? [] : rowsWithActive,

      hiddenLayerCounts: hiddenCounts,
      child75RowsHidden: hiddenCounts.child75,
      parentRowsHidden: hiddenCounts.parent15,
      rawScannerFingerprintRowsHidden: hiddenCounts.scanner,
      rawExecutionFingerprintRowsHidden: hiddenCounts.executionFingerprint,
      rawLongRowsHidden: hiddenCounts.long,

      runtimeStatusCounts: countBy(
        rowsWithActive,
        (row) => runtimeGateOf(row).status
      ),
      signalTypeCounts: countBy(rowsWithActive, (row) => upper(row.signalType || SIGNAL_TYPE_OBSERVE_ONLY)),
      currentFitCounts: countBy(rowsWithActive, (row) => upper(row.currentFitLabel || row.currentFit || 'UNKNOWN')),

      inheritedForbiddenPolicyIgnoredRows,
      invalidGeometryPolicyRows,
      aggregateGeometryIgnoredRows,
      netRStatsRows,

      activeRotationId: normalizeActiveRotationObject(activeRotationRaw)?.rotationId || null,
      activeRotation: {
        rotationId: normalizeActiveRotationObject(activeRotationRaw)?.rotationId || null,
        configuredActiveMicroMicroFamilyIds,
        runtimeEligibleActiveMicroMicroFamilyIds: runtimeEligibleActiveIds,
        runtimeBlockedActiveMicroMicroFamilyIds: runtimeBlockedActiveIds,
        activeMicroMicroFamilyIds: runtimeEligibleActiveIds,
        activeMicroFamilyIds: runtimeEligibleActiveIds,
        trueMicroFamilyIds: runtimeEligibleActiveIds,
        legacyChild75ActiveIdsIgnored,
        runtimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
        empiricalVetoVersion: EMPIRICAL_VETO_VERSION,
        ...modePayload()
      },

      configuredActiveMicroMicroFamilyIds,
      activeRuntimeBlockedMicroMicroFamilyIds: runtimeBlockedActiveIds,
      activeMicroFamilyIds: runtimeEligibleActiveIds,
      activeTrueMicroFamilyIds: runtimeEligibleActiveIds,
      activeMicroMicroFamilyIds: runtimeEligibleActiveIds,
      selectedMicroMicroFamilyIds: runtimeEligibleActiveIds,
      legacyChild75ActiveIdsIgnored,

      bestShort: compactBestRow(bestRows[0] || null),
      bestLong: null,

      summary: buildSummary(rankedRows, runtimeEligibleActiveSet),

      parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
      childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
      trueMicroFamilySchema: MICRO_MICRO_SCHEMA,
      microMicroFamilySchema: MICRO_MICRO_SCHEMA,

      rankingPolicyText:
        'currentMarket|signalType|runtimeGate|shrunkLCB|netEdge|fairWinrate|totalR|avgR|profitFactor|directSL|avgCostR',
      rankingPolicyShort:
        'currentMarket|signalType|shrunkLCB|netEdge|fairWinrate|totalR|avgR|PF',

      adminUiVersion: ADMIN_UI_VERSION,
      microMicroRuntimeGateVersion: MICRO_MICRO_RUNTIME_GATE_VERSION,
      marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
      marketWeatherSelectorVersion: MARKET_WEATHER_SELECTOR_VERSION,
      empiricalVetoVersion: EMPIRICAL_VETO_VERSION,

      warnings,
      error: null,

      perf: {
        durationMs:
          now() - startedAt,
        hardDeadlineMs:
          ROUTE_HARD_DEADLINE_MS,
        remainingMsAtResponse:
          remainingMs(deadlineAt),
        deadlineReached:
          deadlineReached(deadlineAt),
        processingTruncated:
          builtRowsResult.processingTruncated,
        sourceRowsInspected:
          builtRowsResult.sourceRowsInspected,
        normalizedRows:
          rows.length,
        filteredRows:
          rankedRows.length,
        returnedRows:
          responseRows.length,
        weekMicrosCacheHit:
          Boolean(weekResult.cacheHit),
        weekMicrosCacheStale:
          Boolean(weekResult.stale),
        weekMicrosCacheSize:
          cache.weekMicros.size,
        activeRotationCacheHit:
          Boolean(
            activeRotationResult.cacheHit
          ),
        activeRotationCacheStale:
          Boolean(
            activeRotationResult.stale
          ),
        path:
          'shortOnlyExactMicroMicroV5BoundedPaginatedMemoized',
        compactPayload:
          compact
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      degraded: true,
      ...modePayload(),
      rows: [],
      microRows: [],
      microFamilies: [],
      microMicroRows: [],
      microMicroFamilies: [],
      bestRows: [],
      bestMicroMicroFamilies: [],
      count: 0,
      filtered: 0,
      totalAvailable: 0,
      currentMarketPlaybook: null,
      bestForCurrentMarket: null,
      warnings: [
        'ADMIN_MICRO_FAMILIES_DEGRADED_RESPONSE_INSTEAD_OF_HTTP_500'
      ],
      error:
        error?.message ||
        String(error),
      stack:
        process.env.NODE_ENV ===
        'production'
          ? undefined
          : error?.stack,
      perf: {
        durationMs:
          now() - startedAt,
        hardDeadlineMs:
          ROUTE_HARD_DEADLINE_MS,
        deadlineReached:
          deadlineReached(deadlineAt),
        path:
          'shortOnlyExactMicroMicroV5Degraded'
      },
      serverTs: Date.now()
    });
  }
}