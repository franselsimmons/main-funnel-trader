// ================= FILE: src/trade/positionSizing.js =================
//
// SHORT-only virtual position sizing.
// Risk contribution = fraction of equity lost if a virtual SHORT position hits initial SL.
// Required SHORT risk geometry: tp < entry < sl.
// No real orders. No LONG sizing.
// Supports:
// - parent 15: MICRO_SHORT_{SETUP}_{REGIME}                          context only
// - child 75:  MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}           selectable fallback
// - MM hash:   MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH} selectable exact
// - MM bucket: MM_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_{ENTRY}_{SPREAD}_{BTC}_{RISK} selectable exact

import { CONFIG } from '../config.js';
import {
  clamp,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

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

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_ENTRY_SPREAD_BTC_RISK_V1';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;

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

const MICRO_MICRO_ENTRY_BUCKETS = Object.freeze([
  'ENTRY_EARLY',
  'ENTRY_NORMAL',
  'ENTRY_LATE'
]);

const MICRO_MICRO_SPREAD_BUCKETS = Object.freeze([
  'SPREAD_LOW',
  'SPREAD_MID',
  'SPREAD_HIGH'
]);

const MICRO_MICRO_BTC_BUCKETS = Object.freeze([
  'BTC_BEAR',
  'BTC_NEUTRAL',
  'BTC_BULL'
]);

const MICRO_MICRO_RISK_BUCKETS = Object.freeze([
  'RISK_TIGHT',
  'RISK_CLEAN',
  'RISK_WIDE'
]);

const SHORT_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const SHORT_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

const SHORT_DIRECT = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

const LONG_DIRECT = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text ? text.toUpperCase() : fallback;
}

function hasOwn(row = {}, key) {
  return Object.prototype.hasOwnProperty.call(row || {}, key);
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = safeNumber(value, NaN);
    if (Number.isFinite(n)) return n;
  }

  return NaN;
}

function normalizeToken(value, fallback = '') {
  const text = String(value ?? '').trim();

  if (!text) return fallback;

  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function normalizeRatioOrPct(value, fallback = 0) {
  const n = safeNumber(value, NaN);

  if (!Number.isFinite(n)) return fallback;

  if (n > 1.5) return n / 100;

  return n;
}

function sizingConfig() {
  const baseRiskPct = Math.max(
    0,
    safeNumber(
      CONFIG.short?.sizing?.baseRiskPct ??
        CONFIG.sizing?.shortBaseRiskPct ??
        CONFIG.sizing?.baseRiskPct,
      0.0025
    )
  );

  return {
    enabled:
      CONFIG.short?.sizing?.enabled ??
      CONFIG.sizing?.shortEnabled ??
      CONFIG.sizing?.enabled ??
      true,

    baseRiskPct,

    minMult: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.minMult ??
          CONFIG.sizing?.shortMinMult ??
          CONFIG.sizing?.minMult,
        0.35
      )
    ),

    maxMult: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.maxMult ??
          CONFIG.sizing?.shortMaxMult ??
          CONFIG.sizing?.maxMult,
        1.15
      )
    ),

    maxTotalRiskPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.maxTotalRiskPct ??
          CONFIG.sizing?.shortMaxTotalRiskPct ??
          CONFIG.sizing?.maxTotalRiskPct,
        0.03
      )
    ),

    maxSameSideRiskPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.maxSameSideRiskPct ??
          CONFIG.sizing?.shortMaxSameSideRiskPct ??
          CONFIG.sizing?.maxSameSideRiskPct,
        0.015
      )
    ),

    maxCounterBtcRiskPct: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.maxCounterBtcRiskPct ??
          CONFIG.sizing?.shortMaxCounterBtcRiskPct ??
          CONFIG.sizing?.maxCounterBtcRiskPct,
        0.0075
      )
    ),

    priorTrades: Math.max(
      1,
      safeNumber(
        CONFIG.short?.rotation?.priorTrades ??
          CONFIG.rotation?.shortPriorTrades ??
          CONFIG.rotation?.priorTrades,
        35
      )
    ),

    hardRejectBadStats:
      CONFIG.short?.sizing?.hardRejectBadStats ??
      CONFIG.sizing?.shortHardRejectBadStats ??
      CONFIG.sizing?.hardRejectBadStats ??
      true,

    minCompletedForStatsGate: Math.max(
      1,
      safeNumber(
        CONFIG.short?.sizing?.minCompletedForStatsGate ??
          CONFIG.sizing?.shortMinCompletedForStatsGate ??
          CONFIG.sizing?.minCompletedForStatsGate,
        MIN_COMPLETED_MICRO_MICRO_ACTIVE
      )
    ),

    maxDirectSlRate: normalizeRatioOrPct(
      CONFIG.short?.sizing?.maxDirectSlRate ??
        CONFIG.sizing?.shortMaxDirectSlRate ??
        CONFIG.sizing?.maxDirectSlRate,
      0.55
    ),

    maxAvgCostR: Math.max(
      0,
      safeNumber(
        CONFIG.short?.sizing?.maxAvgCostR ??
          CONFIG.sizing?.shortMaxAvgCostR ??
          CONFIG.sizing?.maxAvgCostR,
        0.55
      )
    )
  };
}

function baseModeFlags() {
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

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    exchangeCallsDisabled: true,
    noRealOrders: true,
    noExchangeOrders: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_OR_MICRO_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,
    coinNameExcludedFromFamilyId: true,
    hashesExcludedFromFamilyId: true,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    exactTrueMicroFamilyRequired: true,
    fixedTaxonomyPreferred: true,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    exactMicroMicroOnly: true,

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_OR_EXACT_75_CHILD',
    discordOnlyForExactTrueMicroMatch: true,
    discordOnlyForExactMicroMicroMatch: true,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    parentLearningEnabled: true,
    childLearningEnabled: true,
    microMicroLearningEnabled: true,

    selectionGranularity: 'EXACT_MICRO_MICRO_PREFERRED_FALLBACK_EXACT_75_CHILD',
    fallbackRankingGranularity: 'PARENT_15_UNTIL_CHILD_MIN_COMPLETED_THEN_MICRO_75_UNTIL_MM_MIN_COMPLETED',

    minCompletedForActiveLearning: MIN_COMPLETED_ACTIVE_LEARNING,
    minCompletedForMicroMicroActiveLearning: MIN_COMPLETED_MICRO_MICRO_ACTIVE,

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

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

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
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
    .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
    .replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
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
    value.includes('EXECUTIONMICRO') ||
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

function parseChildOrParentMicroShortId(id = '') {
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

  const mmHashMatch = /^(.+)_MM_([A-Z0-9]{6,24})$/u.exec(body);

  if (mmHashMatch) {
    body = mmHashMatch[1];
  }

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

  for (const candidateRegime of REGIME_ORDER) {
    const suffix = `_${candidateRegime}`;

    if (body.endsWith(suffix)) {
      regime = candidateRegime;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime ? `MICRO_SHORT_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;

  const validParent =
    Boolean(parentId) &&
    SHORT_FIXED_SETUP_TYPES.has(setup) &&
    SHORT_FIXED_REGIME_BUCKETS.has(regime);

  const validChild =
    validParent &&
    Boolean(confirmationProfile) &&
    SHORT_CONFIRMATION_PROFILES.has(confirmationProfile);

  const microMicroHash = mmHashMatch?.[2] || null;
  const microMicroFamilyId = validChild && microMicroHash
    ? `${childId}_MM_${microMicroHash.slice(0, 10)}`
    : null;

  return {
    valid: validParent || validChild || Boolean(microMicroFamilyId),
    selectable: validChild || Boolean(microMicroFamilyId),
    isParent: validParent && !validChild && !microMicroFamilyId,
    isChild: validChild && !microMicroFamilyId,
    isMicroMicro: Boolean(microMicroFamilyId),
    rawId: String(id || '').trim(),

    setup,
    regime,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    selectionGranularity: microMicroFamilyId
      ? 'EXACT_MICRO_MICRO'
      : validChild
        ? 'EXACT_75_CHILD'
        : 'PARENT_15_CONTEXT_ONLY'
  };
}

function parseBucketMicroMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value.startsWith('MM_SHORT_')) {
    return {
      valid: false,
      selectable: false,
      isMicroMicro: false,
      rawId
    };
  }

  const body = value.slice('MM_SHORT_'.length);

  for (const setup of SETUP_ORDER) {
    for (const regime of REGIME_ORDER) {
      for (const confirmationProfile of CONFIRMATION_PROFILE_ORDER) {
        for (const entryBucket of MICRO_MICRO_ENTRY_BUCKETS) {
          for (const spreadBucket of MICRO_MICRO_SPREAD_BUCKETS) {
            for (const btcBucket of MICRO_MICRO_BTC_BUCKETS) {
              for (const riskBucket of MICRO_MICRO_RISK_BUCKETS) {
                const suffix = [
                  setup,
                  regime,
                  confirmationProfile,
                  entryBucket,
                  spreadBucket,
                  btcBucket,
                  riskBucket
                ].join('_');

                if (body !== suffix) continue;

                const parentTrueMicroFamilyId = `MICRO_SHORT_${setup}_${regime}`;
                const childTrueMicroFamilyId = `${parentTrueMicroFamilyId}_${confirmationProfile}`;
                const microMicroFamilyId = `MM_SHORT_${suffix}`;

                return {
                  valid: true,
                  selectable: true,
                  isMicroMicro: true,
                  rawId,

                  setup,
                  regime,
                  confirmationProfile,
                  entryBucket,
                  spreadBucket,
                  btcBucket,
                  riskBucket,

                  parentTrueMicroFamilyId,
                  trueMicroFamilyId: childTrueMicroFamilyId,
                  childTrueMicroFamilyId,

                  microMicroFamilyId,
                  trueMicroMicroFamilyId: microMicroFamilyId,
                  exactMicroMicroFamilyId: microMicroFamilyId,

                  trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
                  parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
                  childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
                  microMicroFamilySchema: MICRO_MICRO_SCHEMA,
                  trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

                  learningGranularity: LEARNING_GRANULARITY,
                  parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
                  microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

                  selectionGranularity: 'EXACT_MICRO_MICRO'
                };
              }
            }
          }
        }
      }
    }
  }

  return {
    valid: false,
    selectable: false,
    isMicroMicro: false,
    rawId
  };
}

function parseLearningFamilyId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value || !validLearningId(value)) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId
    };
  }

  if (value.startsWith('MM_SHORT_')) return parseBucketMicroMicroId(value);

  return parseChildOrParentMicroShortId(value);
}

function isExactShortChildTrueMicroId(id = '') {
  const parsed = parseLearningFamilyId(id);
  return Boolean(parsed.valid && parsed.isChild && parsed.childTrueMicroFamilyId);
}

function isExactShortMicroMicroId(id = '') {
  const parsed = parseLearningFamilyId(id);
  return Boolean(parsed.valid && parsed.isMicroMicro && parsed.microMicroFamilyId);
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (SHORT_DIRECT.has(raw)) return TARGET_TRADE_SIDE;
  if (LONG_DIRECT.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = normalizeToken(raw);

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'SELL' ||
    normalized.includes('MICRO_SHORT_') ||
    normalized.includes('MM_SHORT_') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('SIDE_SELL') ||
    normalized.includes('DIRECTION_SELL') ||
    normalized.startsWith('SHORT_') ||
    normalized.includes('_SHORT_') ||
    normalized.endsWith('_SHORT') ||
    normalized.startsWith('BEAR_') ||
    normalized.includes('_BEAR_') ||
    normalized.endsWith('_BEAR') ||
    normalized.startsWith('SELL_') ||
    normalized.includes('_SELL_') ||
    normalized.endsWith('_SELL');

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BUY' ||
    normalized.includes('MICRO_LONG_') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('SIDE_BUY') ||
    normalized.includes('DIRECTION_BUY') ||
    normalized.startsWith('LONG_') ||
    normalized.includes('_LONG_') ||
    normalized.endsWith('_LONG') ||
    normalized.startsWith('BULL_') ||
    normalized.includes('_BULL_') ||
    normalized.endsWith('_BULL') ||
    normalized.startsWith('BUY_') ||
    normalized.includes('_BUY_') ||
    normalized.endsWith('_BUY');

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit && longHit) {
    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) return TARGET_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) return OPPOSITE_TRADE_SIDE;
    if (normalized.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function textParts(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.microMicroDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.microMicroDefinitionParts) ? row.microMicroDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => upper(value))
    .filter(Boolean);
}

function idText(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,

    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId,
    row.id,
    row.key,

    row.parentTrueMicroFamilyId,
    row.coarseMicroFamilyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.scannerMicroFamilyId,
    row.scannerFamilyId,
    row.executionMicroFamilyId
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function hasShortIdSignal(text = '') {
  const raw = upper(text);

  return (
    raw.includes('MM_SHORT_') ||
    raw.includes('MICRO_SHORT_') ||
    raw.includes('SHORT_') ||
    raw.includes('_SHORT_') ||
    raw.endsWith('_SHORT') ||
    raw.includes('|SHORT_') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT')
  );
}

function hasLongIdSignal(text = '') {
  const raw = upper(text);

  return (
    raw.includes('MICRO_LONG_') ||
    raw.includes('LONG_') ||
    raw.includes('_LONG_') ||
    raw.endsWith('_LONG') ||
    raw.includes('|LONG_') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG')
  );
}

function hasShortDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    haystack.includes('MM_SHORT_') ||
    haystack.includes('MICRO_SHORT_')
  );
}

function hasLongDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    haystack.includes('MICRO_LONG_')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = idText(row);

  if (!haystack) return 'UNKNOWN';

  const shortHit = hasShortIdSignal(haystack);
  const longHit = hasLongIdSignal(haystack);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromDefinitions(row = {}) {
  const parts = textParts(row);

  if (!parts.length) return 'UNKNOWN';

  const shortHit = hasShortDefinitionSignal(parts);
  const longHit = hasLongDefinitionSignal(parts);
  const haystack = parts.join('|');

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MM_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSide(row);
  }

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.side
  ];

  for (const value of directSources) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const fromIds = inferTradeSideFromIds(row);

  if (fromIds === TARGET_TRADE_SIDE || fromIds === OPPOSITE_TRADE_SIDE) return fromIds;

  const fromDefinitions = inferTradeSideFromDefinitions(row);

  if (fromDefinitions === TARGET_TRADE_SIDE || fromDefinitions === OPPOSITE_TRADE_SIDE) {
    return fromDefinitions;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function extractLearningFamilyId(row = {}) {
  const candidates = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,

    row.childTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.analyzeMicroFamilyId,
    row.learningMicroFamilyId,
    row.fixedTaxonomyMicroFamilyId
  ];

  for (const candidate of candidates) {
    const id = String(candidate || '').trim().toUpperCase();

    if (!id || !validLearningId(id)) continue;

    const parsed = parseLearningFamilyId(id);

    if (parsed.valid) return id;
  }

  return '';
}

function taxonomyIdentity(row = {}) {
  const id = extractLearningFamilyId(row);
  const parsed = parseLearningFamilyId(id);

  if (!parsed.valid) {
    return {
      exactChild: false,
      exactMicroMicro: false,
      selectable: false,

      parentTrueMicroFamilyId: null,
      childTrueMicroFamilyId: null,
      trueMicroFamilyId: id || null,

      microMicroFamilyId: null,
      trueMicroMicroFamilyId: null,
      exactMicroMicroFamilyId: null,

      setupType: null,
      regimeBucket: null,
      confirmationProfile: null,
      entryBucket: null,
      spreadBucket: null,
      btcBucket: null,
      riskBucket: null,

      selectionGranularity: null
    };
  }

  return {
    exactChild: Boolean(parsed.isChild && parsed.childTrueMicroFamilyId),
    exactMicroMicro: Boolean(parsed.isMicroMicro && parsed.microMicroFamilyId),
    selectable: Boolean(parsed.selectable),

    parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
    trueMicroFamilyId: parsed.childTrueMicroFamilyId || parsed.trueMicroFamilyId,

    microMicroFamilyId: parsed.microMicroFamilyId || null,
    trueMicroMicroFamilyId: parsed.trueMicroMicroFamilyId || null,
    exactMicroMicroFamilyId: parsed.exactMicroMicroFamilyId || null,

    setupType: parsed.setup,
    regimeBucket: parsed.regime,
    confirmationProfile: parsed.confirmationProfile,
    entryBucket: parsed.entryBucket || null,
    spreadBucket: parsed.spreadBucket || null,
    btcBucket: parsed.btcBucket || null,
    riskBucket: parsed.riskBucket || null,

    selectionGranularity: parsed.selectionGranularity
  };
}

function exactSelectableRequiredButMissing(row = {}) {
  const id = extractLearningFamilyId(row);

  if (!id) return false;

  const parsed = parseLearningFamilyId(id);

  return !(parsed.isChild || parsed.isMicroMicro);
}

function completedCount(row = {}) {
  const virtualCompleted = safeNumber(row.virtualCompleted, 0);
  const shadowCompleted = safeNumber(row.shadowCompleted, 0);
  const closed = safeNumber(row.closed, 0);
  const explicitCompleted = safeNumber(row.completed, 0);

  const fromVirtualShadow = virtualCompleted + shadowCompleted;

  return Math.max(0, fromVirtualShadow, closed, explicitCompleted);
}

function learningStatus(row = {}) {
  const completed = completedCount(row);

  if (completed <= 0) return 'OBSERVING';
  if (completed < MIN_COMPLETED_ACTIVE_LEARNING) return 'EARLY_OUTCOMES';

  return 'ACTIVE_LEARNING';
}

function normalizeBtcRelation(value) {
  const relation = upper(value, 'BTC_UNKNOWN');

  if (relation === 'BTC_WITH' || relation === 'WITH') return 'BTC_WITH';
  if (relation === 'BTC_AGAINST' || relation === 'AGAINST') return 'BTC_AGAINST';
  if (relation === 'BTC_NEUTRAL' || relation === 'NEUTRAL') return 'BTC_NEUTRAL';
  if (relation === 'BTC_UNKNOWN' || relation === 'UNKNOWN') return 'BTC_UNKNOWN';

  if (['BEARISH', 'STRONG_BEAR', 'BEAR', 'DOWN', 'BTC_BEAR'].includes(relation)) {
    return 'BTC_WITH';
  }

  if (['BULLISH', 'STRONG_BULL', 'BULL', 'UP', 'BTC_BULL'].includes(relation)) {
    return 'BTC_AGAINST';
  }

  return 'BTC_UNKNOWN';
}

function relationFromDefinitionParts(definitionParts = []) {
  const parts = Array.isArray(definitionParts) ? definitionParts : [];

  const directMatch = parts.find((part) => {
    const text = upper(part);

    return (
      text.startsWith('BTCRELATION=') ||
      text.startsWith('BTC_RELATION=') ||
      text.startsWith('BTC=') ||
      text.startsWith('BTC_STATE=') ||
      text.startsWith('BTCBUCKET=') ||
      text.startsWith('MICROMICROBTCBUCKET=')
    );
  });

  if (!directMatch) return 'BTC_UNKNOWN';

  return normalizeBtcRelation(String(directMatch).split('=').at(1));
}

function btcRelationFromRow(row = {}) {
  return normalizeBtcRelation(
    row.btcRelation ||
      row.btcStateRelation ||
      row.microMicroBtcBucket ||
      row.btcBucket ||
      row.btcState ||
      relationFromDefinitionParts(row.definitionParts) ||
      relationFromDefinitionParts(row.microMicroDefinitionParts)
  );
}

function validShortRiskGeometry(row = {}) {
  const hasGeometry =
    row.entry !== undefined ||
    row.sl !== undefined ||
    row.tp !== undefined ||
    row.stopLoss !== undefined ||
    row.takeProfit !== undefined;

  if (!hasGeometry) return true;

  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl ?? row.stopLoss ?? row.initialSl, 0);
  const tp = safeNumber(row.tp ?? row.takeProfit ?? row.target, 0);

  return entry > 0 && sl > 0 && tp > 0 && tp < entry && entry < sl;
}

function stopRiskPct(row = {}) {
  const direct = firstFinite(
    row.riskPct,
    row.slDistancePct,
    row.stopDistancePct,
    row.stopLossDistancePct
  );

  if (Number.isFinite(direct) && direct > 0) return direct;

  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.sl ?? row.stopLoss ?? row.initialSl, 0);

  if (entry > 0 && sl > entry) {
    return (sl - entry) / entry;
  }

  return 0;
}

function positionRiskFraction(position = {}) {
  const cfg = sizingConfig();
  const direct = safeNumber(position.riskFraction, NaN);

  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  return cfg.baseRiskPct;
}

function normalizeRiskFraction(value) {
  const cfg = sizingConfig();
  const risk = safeNumber(value, cfg.baseRiskPct);

  return clamp(
    risk,
    0,
    Math.max(
      cfg.maxTotalRiskPct,
      cfg.maxSameSideRiskPct,
      cfg.baseRiskPct,
      0
    )
  );
}

function buildStatsSideProbe({
  weeklyStats,
  side,
  tradeSide
} = {}) {
  return {
    ...(weeklyStats || {}),

    side: side ?? weeklyStats?.side,
    tradeSide: tradeSide ?? weeklyStats?.tradeSide,
    positionSide: tradeSide ?? weeklyStats?.positionSide,
    direction: tradeSide ?? weeklyStats?.direction
  };
}

function shortModeFlags(extra = {}) {
  const taxonomy = taxonomyIdentity(extra);
  const completed = completedCount(extra);
  const status = learningStatus(extra);

  return {
    ...baseModeFlags(),

    parentTrueMicroFamilyId: taxonomy.parentTrueMicroFamilyId,
    childTrueMicroFamilyId: taxonomy.childTrueMicroFamilyId,
    trueMicroFamilyId: taxonomy.trueMicroFamilyId,
    microFamilyId: taxonomy.trueMicroFamilyId,

    microMicroFamilyId: taxonomy.microMicroFamilyId,
    trueMicroMicroFamilyId: taxonomy.trueMicroMicroFamilyId,
    exactMicroMicroFamilyId: taxonomy.exactMicroMicroFamilyId,

    setupType: taxonomy.setupType,
    regimeBucket: taxonomy.regimeBucket,
    confirmationProfile: taxonomy.confirmationProfile,

    microMicroEntryBucket: taxonomy.entryBucket,
    microMicroSpreadBucket: taxonomy.spreadBucket,
    microMicroBtcBucket: taxonomy.btcBucket,
    microMicroRiskBucket: taxonomy.riskBucket,

    exact75ChildTrueMicro: taxonomy.exactChild,
    exactMicroMicro: taxonomy.exactMicroMicro,
    selectableLearningIdentity: taxonomy.selectable,
    selectionGranularity: taxonomy.selectionGranularity || 'UNKNOWN',

    learningStatus: status,
    status,
    completed,

    activeLearningUsable: completed >= MIN_COMPLETED_ACTIVE_LEARNING,
    microMicroActiveLearningUsable: completed >= MIN_COMPLETED_MICRO_MICRO_ACTIVE,
    tooEarly: completed < MIN_COMPLETED_ACTIVE_LEARNING
  };
}

function statsGate(row = {}, cfg = sizingConfig()) {
  const completed = completedCount(row);

  if (!cfg.hardRejectBadStats) {
    return {
      ok: true,
      reason: 'HARD_STATS_GATE_DISABLED'
    };
  }

  if (completed < cfg.minCompletedForStatsGate) {
    return {
      ok: true,
      reason: 'SAMPLE_TOO_SMALL_FOR_HARD_STATS_GATE',
      completed,
      minCompletedForStatsGate: cfg.minCompletedForStatsGate
    };
  }

  const avgR = safeNumber(row.avgR ?? row.avgNetR, 0);
  const totalR = safeNumber(row.totalR ?? row.totalNetR, 0);
  const lcb95AvgR = firstFinite(
    row.lcb95AvgR,
    row.avgRLcb95,
    row.avgRLowerConfidenceBound,
    row.lowerConfidenceBoundAvgR
  );

  const directSlRate = normalizeRatioOrPct(
    firstValue(
      row.directSLRate,
      row.directSlRate,
      row.slRate,
      row.stopLossRate
    ),
    0
  );

  const avgCostR = Math.max(
    0,
    safeNumber(row.avgCostR ?? row.costR, 0)
  );

  if (totalR < 0 && avgR < 0) {
    return {
      ok: false,
      reason: 'BAD_STATS_NEGATIVE_TOTAL_AND_AVG_R',
      completed,
      totalR,
      avgR
    };
  }

  if (Number.isFinite(lcb95AvgR) && lcb95AvgR < 0) {
    return {
      ok: false,
      reason: 'BAD_STATS_LCB95_AVG_R_BELOW_ZERO',
      completed,
      lcb95AvgR
    };
  }

  if (directSlRate > 0 && directSlRate > cfg.maxDirectSlRate) {
    return {
      ok: false,
      reason: 'BAD_STATS_DIRECT_SL_RATE_TOO_HIGH',
      completed,
      directSlRate,
      maxDirectSlRate: cfg.maxDirectSlRate
    };
  }

  if (avgCostR > cfg.maxAvgCostR) {
    return {
      ok: false,
      reason: 'BAD_STATS_AVG_COST_R_TOO_HIGH',
      completed,
      avgCostR,
      maxAvgCostR: cfg.maxAvgCostR
    };
  }

  return {
    ok: true,
    reason: 'STATS_GATE_OK',
    completed,
    avgR,
    totalR,
    lcb95AvgR: Number.isFinite(lcb95AvgR) ? lcb95AvgR : null,
    directSlRate,
    avgCostR
  };
}

function sizingConfidence(row = {}, cfg = sizingConfig()) {
  const completed = completedCount(row);

  const balanced = safeNumber(
    row.dashboardBalancedScore ??
      row.balancedScore ??
      row.selectorScore,
    0
  );

  const fairWinrate = normalizeRatioOrPct(
    row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      row.sampleWilsonLowerBound ??
      row.wilsonLowerBound,
    0
  );

  const avgR = safeNumber(row.avgR ?? row.avgNetR, 0);
  const totalR = safeNumber(row.totalR ?? row.totalNetR, 0);

  const lcb95AvgR = firstFinite(
    row.lcb95AvgR,
    row.avgRLcb95,
    row.avgRLowerConfidenceBound,
    row.lowerConfidenceBoundAvgR
  );

  const avgCostR = Math.max(0, safeNumber(row.avgCostR ?? row.costR, 0));
  const directSlRate = normalizeRatioOrPct(row.directSLRate ?? row.directSlRate ?? row.slRate, 0);

  const sampleConf = clamp(completed / cfg.priorTrades, 0, 1);
  const qualityConf = clamp(balanced / 100, 0, 1);
  const winrateConf = fairWinrate > 0
    ? clamp((fairWinrate - 0.45) / 0.25, 0, 1)
    : 0;

  const avgRConf = clamp((avgR + 0.15) / 0.75, 0, 1);
  const totalRConf = clamp(totalR / 15, 0, 1);

  const lcbConf = Number.isFinite(lcb95AvgR)
    ? clamp((lcb95AvgR + 0.10) / 0.45, 0, 1)
    : 0.35;

  const costPenalty = clamp(avgCostR / Math.max(cfg.maxAvgCostR, 0.01), 0, 1);
  const directSlPenalty = directSlRate > 0
    ? clamp(directSlRate / Math.max(cfg.maxDirectSlRate, 0.01), 0, 1)
    : 0;

  const currentFit = upper(row.currentFit || row.entryCurrentFit, 'UNKNOWN');
  const currentFitBoost =
    currentFit === 'MATCH'
      ? 0.08
      : currentFit === 'WEAK_MATCH'
        ? 0.03
        : currentFit === 'MISFIT'
          ? -0.12
          : 0;

  const rawConfidence =
    sampleConf * 0.24 +
    qualityConf * 0.18 +
    winrateConf * 0.14 +
    avgRConf * 0.15 +
    totalRConf * 0.12 +
    lcbConf * 0.17 -
    costPenalty * 0.16 -
    directSlPenalty * 0.08 +
    currentFitBoost;

  return clamp(rawConfidence, 0, 1);
}

export function riskFractionForEntry({
  weeklyStats,
  side = null,
  tradeSide = null
} = {}) {
  const cfg = sizingConfig();
  const stats = weeklyStats || {};

  const explicitSideProvided =
    side !== null ||
    tradeSide !== null ||
    stats?.tradeSide ||
    stats?.side ||
    stats?.positionSide ||
    stats?.direction;

  const statsSide = inferTradeSide(
    buildStatsSideProbe({
      weeklyStats: stats,
      side,
      tradeSide
    })
  );

  if (explicitSideProvided && statsSide !== TARGET_TRADE_SIDE) {
    return 0;
  }

  if (exactSelectableRequiredButMissing(stats)) {
    return 0;
  }

  if (!validShortRiskGeometry(stats)) {
    return 0;
  }

  if (!cfg.enabled) {
    return round6(cfg.baseRiskPct);
  }

  const gate = statsGate(stats, cfg);

  if (!gate.ok) {
    return 0;
  }

  const confidence = sizingConfidence(stats, cfg);
  const maxMult = Math.max(cfg.minMult, cfg.maxMult);

  const mult = clamp(
    cfg.minMult + (maxMult - cfg.minMult) * confidence,
    cfg.minMult,
    maxMult
  );

  return round6(cfg.baseRiskPct * mult);
}

export function positionSizeForStopRisk({
  equity,
  riskFraction,
  entry,
  sl,
  stopRiskPct: explicitStopRiskPct,
  maxNotional = Infinity,
  minNotional = 0
} = {}) {
  const accountEquity = safeNumber(equity, 0);
  const risk = normalizeRiskFraction(riskFraction);
  const entryPrice = safeNumber(entry, 0);
  const stopPrice = safeNumber(sl, 0);

  const riskPct = safeNumber(
    explicitStopRiskPct,
    entryPrice > 0 && stopPrice > entryPrice
      ? (stopPrice - entryPrice) / entryPrice
      : 0
  );

  if (accountEquity <= 0 || risk <= 0 || entryPrice <= 0 || riskPct <= 0) {
    return {
      ok: false,
      reason: 'POSITION_SIZE_INPUT_INVALID',
      equity: accountEquity,
      riskFraction: risk,
      entry: entryPrice,
      sl: stopPrice,
      stopRiskPct: riskPct,
      notional: 0,
      quantity: 0,
      riskUsd: 0,
      ...baseModeFlags()
    };
  }

  const riskUsd = accountEquity * risk;
  const rawNotional = riskUsd / riskPct;

  const cappedNotional = clamp(
    rawNotional,
    Math.max(0, safeNumber(minNotional, 0)),
    Math.max(0, safeNumber(maxNotional, Number.POSITIVE_INFINITY))
  );

  return {
    ok: true,
    reason: cappedNotional < rawNotional ? 'POSITION_SIZE_CAPPED_BY_MAX_NOTIONAL' : 'POSITION_SIZE_OK',
    equity: round6(accountEquity),
    riskFraction: round6(risk),
    riskUsd: round6(riskUsd),
    entry: entryPrice,
    sl: stopPrice,
    stopRiskPct: round6(riskPct),
    notional: round6(cappedNotional),
    rawNotional: round6(rawNotional),
    quantity: round6(cappedNotional / entryPrice),
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    noRealOrders: true,
    virtualOnly: true,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    sizingFormula: 'notional = (equity * riskFraction) / stopRiskPct',
    ...baseModeFlags()
  };
}

export function summarizeOpenRisk(openPositions = []) {
  const rows = Array.isArray(openPositions) ? openPositions : [];

  let total = 0;
  let shortRisk = 0;
  let nonShortRisk = 0;
  let unknownSideRisk = 0;
  let counterBtcRisk = 0;
  let exactChildPositions = 0;
  let exactMicroMicroPositions = 0;
  let invalidIdentityPositions = 0;
  let invalidRiskGeometryPositions = 0;

  const trueMicroFamilyIds = new Set();
  const parentTrueMicroFamilyIds = new Set();
  const microMicroFamilyIds = new Set();

  for (const position of rows) {
    const tradeSide = inferTradeSide(position);
    const identity = taxonomyIdentity(position);
    const risk = positionRiskFraction(position);

    total += risk;

    if (tradeSide === TARGET_TRADE_SIDE) {
      shortRisk += risk;
    } else if (tradeSide === 'UNKNOWN') {
      unknownSideRisk += risk;
      nonShortRisk += risk;
    } else {
      nonShortRisk += risk;
    }

    if (identity.exactMicroMicro) {
      exactMicroMicroPositions += 1;
      if (identity.microMicroFamilyId) microMicroFamilyIds.add(identity.microMicroFamilyId);
      if (identity.childTrueMicroFamilyId) trueMicroFamilyIds.add(identity.childTrueMicroFamilyId);
      if (identity.parentTrueMicroFamilyId) parentTrueMicroFamilyIds.add(identity.parentTrueMicroFamilyId);
    } else if (identity.exactChild) {
      exactChildPositions += 1;
      if (identity.childTrueMicroFamilyId) trueMicroFamilyIds.add(identity.childTrueMicroFamilyId);
      if (identity.parentTrueMicroFamilyId) parentTrueMicroFamilyIds.add(identity.parentTrueMicroFamilyId);
    } else if (extractLearningFamilyId(position)) {
      invalidIdentityPositions += 1;
    }

    if (!validShortRiskGeometry(position)) {
      invalidRiskGeometryPositions += 1;
    }

    if (btcRelationFromRow(position) === 'BTC_AGAINST') {
      counterBtcRisk += risk;
    }
  }

  return {
    total: round6(total),

    shortRisk: round6(shortRisk),

    longRisk: 0,

    nonShortRisk: round6(nonShortRisk),
    nonLongRisk: round6(nonShortRisk),
    unknownSideRisk: round6(unknownSideRisk),
    counterBtcRisk: round6(counterBtcRisk),

    exactChildPositions,
    exact75ChildPositions: exactChildPositions,
    exactMicroMicroPositions,

    invalidIdentityPositions,
    invalidRiskGeometryPositions,

    trueMicroFamilyIds: [...trueMicroFamilyIds],
    childTrueMicroFamilyIds: [...trueMicroFamilyIds],
    parentTrueMicroFamilyIds: [...parentTrueMicroFamilyIds],
    microMicroFamilyIds: [...microMicroFamilyIds],
    trueMicroMicroFamilyIds: [...microMicroFamilyIds],
    exactMicroMicroFamilyIds: [...microMicroFamilyIds],

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: true,
    executionFingerprintsUsedAsLearningFamily: false,

    ...baseModeFlags()
  };
}

export function checkRiskCaps({
  openPositions = [],
  side,
  tradeSide = side,
  btcRelation,
  riskFraction,
  weeklyStats,
  entry,
  sl,
  tp,
  stopLoss,
  takeProfit,
  trueMicroFamilyId,
  childTrueMicroFamilyId,
  microFamilyId,
  parentTrueMicroFamilyId,
  microMicroFamilyId,
  trueMicroMicroFamilyId,
  exactMicroMicroFamilyId
} = {}) {
  const cfg = sizingConfig();

  const requestRow = {
    ...(weeklyStats || {}),

    entry: entry ?? weeklyStats?.entry,
    sl: sl ?? stopLoss ?? weeklyStats?.sl ?? weeklyStats?.stopLoss,
    tp: tp ?? takeProfit ?? weeklyStats?.tp ?? weeklyStats?.takeProfit,

    microMicroFamilyId:
      exactMicroMicroFamilyId ||
      trueMicroMicroFamilyId ||
      microMicroFamilyId ||
      weeklyStats?.exactMicroMicroFamilyId ||
      weeklyStats?.trueMicroMicroFamilyId ||
      weeklyStats?.microMicroFamilyId,

    trueMicroMicroFamilyId:
      exactMicroMicroFamilyId ||
      trueMicroMicroFamilyId ||
      microMicroFamilyId ||
      weeklyStats?.trueMicroMicroFamilyId ||
      weeklyStats?.microMicroFamilyId,

    exactMicroMicroFamilyId:
      exactMicroMicroFamilyId ||
      trueMicroMicroFamilyId ||
      microMicroFamilyId ||
      weeklyStats?.exactMicroMicroFamilyId ||
      weeklyStats?.trueMicroMicroFamilyId ||
      weeklyStats?.microMicroFamilyId,

    trueMicroFamilyId:
      childTrueMicroFamilyId ||
      trueMicroFamilyId ||
      weeklyStats?.childTrueMicroFamilyId ||
      weeklyStats?.trueMicroFamilyId ||
      microFamilyId ||
      weeklyStats?.microFamilyId,

    childTrueMicroFamilyId:
      childTrueMicroFamilyId ||
      weeklyStats?.childTrueMicroFamilyId ||
      trueMicroFamilyId ||
      weeklyStats?.trueMicroFamilyId ||
      microFamilyId ||
      weeklyStats?.microFamilyId,

    microFamilyId:
      microFamilyId ||
      childTrueMicroFamilyId ||
      trueMicroFamilyId ||
      weeklyStats?.microFamilyId ||
      weeklyStats?.trueMicroFamilyId,

    parentTrueMicroFamilyId:
      parentTrueMicroFamilyId ||
      weeklyStats?.parentTrueMicroFamilyId ||
      weeklyStats?.coarseMicroFamilyId,

    side,
    tradeSide,
    positionSide: tradeSide,
    direction: tradeSide,
    shortOnly: true,
    longDisabled: true
  };

  const want = normalizeRiskFraction(riskFraction);
  const open = summarizeOpenRisk(openPositions);

  const requestedTradeSide = inferTradeSide(requestRow);
  const relation = normalizeBtcRelation(btcRelation ?? btcRelationFromRow(requestRow));
  const identity = taxonomyIdentity(requestRow);

  if (requestedTradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'SHORT_ONLY_SYSTEM_REJECTED_NON_SHORT_RISK',
      side,
      tradeSide: requestedTradeSide,
      riskFraction: 0,
      want,
      riskState: open,

      ...shortModeFlags(requestRow)
    };
  }

  if (extractLearningFamilyId(requestRow) && !identity.exactChild && !identity.exactMicroMicro) {
    return {
      ok: false,
      reason: 'EXACT_75_CHILD_OR_EXACT_MICRO_MICRO_FAMILY_ID_REQUIRED',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      want,
      riskState: open,

      ...shortModeFlags(requestRow)
    };
  }

  if (!validShortRiskGeometry(requestRow)) {
    return {
      ok: false,
      reason: 'SHORT_RISK_GEOMETRY_INVALID_TP_LT_ENTRY_LT_SL_REQUIRED',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      want,
      riskState: open,

      ...shortModeFlags(requestRow)
    };
  }

  if (want <= 0) {
    return {
      ok: false,
      reason: 'ZERO_RISK_FRACTION',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      want,
      riskState: open,

      ...shortModeFlags(requestRow)
    };
  }

  if (!cfg.enabled) {
    return {
      ok: true,
      reason: 'SIZING_DISABLED',
      riskFraction: want,
      openRiskBefore: open.total,
      openRiskAfter: round6(open.total + want),
      sideRiskAfter: round6(open.shortRisk + want),
      counterBtcRiskAfter: relation === 'BTC_AGAINST'
        ? round6(open.counterBtcRisk + want)
        : open.counterBtcRisk,
      riskState: open,

      ...shortModeFlags(requestRow)
    };
  }

  if (open.total + want > cfg.maxTotalRiskPct) {
    return {
      ok: false,
      reason: 'MAX_TOTAL_RISK',
      open: open.total,
      want,
      cap: cfg.maxTotalRiskPct,
      riskState: open,

      ...shortModeFlags(requestRow)
    };
  }

  if (open.shortRisk + want > cfg.maxSameSideRiskPct) {
    return {
      ok: false,
      reason: 'MAX_SHORT_SIDE_RISK',
      side: TARGET_TRADE_SIDE,
      open: open.shortRisk,
      want,
      cap: cfg.maxSameSideRiskPct,
      riskState: open,

      ...shortModeFlags(requestRow)
    };
  }

  if (
    relation === 'BTC_AGAINST' &&
    open.counterBtcRisk + want > cfg.maxCounterBtcRiskPct
  ) {
    return {
      ok: false,
      reason: 'MAX_COUNTER_BTC_RISK',
      open: open.counterBtcRisk,
      want,
      cap: cfg.maxCounterBtcRiskPct,
      riskState: open,

      ...shortModeFlags(requestRow)
    };
  }

  return {
    ok: true,
    reason: identity.exactMicroMicro
      ? 'RISK_CAPS_OK_EXACT_MICRO_MICRO'
      : identity.exactChild
        ? 'RISK_CAPS_OK_EXACT_75_CHILD'
        : 'RISK_CAPS_OK_SHORT',

    riskFraction: want,
    openRiskBefore: open.total,
    openRiskAfter: round6(open.total + want),
    sideRiskAfter: round6(open.shortRisk + want),
    counterBtcRiskAfter: relation === 'BTC_AGAINST'
      ? round6(open.counterBtcRisk + want)
      : open.counterBtcRisk,

    stopRiskPct: round6(stopRiskPct(requestRow)),
    riskState: open,

    ...shortModeFlags(requestRow)
  };
}