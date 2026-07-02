// ================= FILE: src/analyze/analyzeEngine.js =================

import { createHash } from 'crypto';
import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getVolatileRedis, getJson, setJson } from '../redis.js';
import { safeNumber, sideToTradeSide } from '../utils.js';
import { classifyMicroFamily, classifyMacroFamily } from './microFamilies.js';
import {
  createMicroStats,
  updateObservation,
  updateOutcome,
  refreshStats,
  getWeeklyTradingCandidates as scoreWeeklyTradingCandidates
} from './scoring.js';
import { applyCosts } from '../trade/costModel.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';
const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_75_MICRO_MICRO_V1';
const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;
const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';
const SELECTION_EXACT_MICRO_MICRO = 'EXACT_MICRO_MICRO';
const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 6;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_LAYERED_MICRO_MICRO_V5';
const POSITION_MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V2';
const MICRO_MICRO_VERSION = 'SHORT_PARENT_MICRO_MICRO_LAYERING_V2';
const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const OBSERVATION_DEDUPE_VERSION = 'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_LAYERED_ENTRY_V4';
const OUTCOME_DEDUPE_VERSION = 'SHORT_OUTCOME_DEDUPE_STABLE_CLOSED_POSITION_LAYERED_V5';
const SELECTION_ENGINE_VERSION = 'SHORT_LIFETIME_LCB_CURRENTFIT_SELECTION_V1';

const SETUP_ORDER = Object.freeze(['BREAKOUT', 'RETEST', 'SWEEP_REVERSAL', 'CONTINUATION', 'COMPRESSION']);
const REGIME_ORDER = Object.freeze(['TREND', 'CHOP', 'SQUEEZE']);
const CONFIRMATION_PROFILE_ORDER = Object.freeze(['A_STRONG_ALIGN', 'B_FLOW_ALIGN', 'C_VOLUME_ALIGN', 'D_MIXED_OK', 'E_WEAK_CONTRA']);
const SETUPS = new Set(SETUP_ORDER);
const REGIMES = new Set(REGIME_ORDER);
const CONFIRMATIONS = new Set(CONFIRMATION_PROFILE_ORDER);

function now() { return Date.now(); }
function upper(value = '') { return String(value || '').trim().toUpperCase(); }
function n(value, fallback = 0) { const x = safeNumber(value, fallback); return Number.isFinite(x) ? x : fallback; }
function hashText(value, len = EXECUTION_MICRO_HASH_LEN) { return createHash('sha256').update(String(value || '')).digest('hex').toUpperCase().slice(0, len); }
function uniq(values = []) { return [...new Set((Array.isArray(values) ? values : [values]).flat(Infinity).map((x) => String(x || '').trim()).filter(Boolean))]; }
function norm(value = '', fallback = '') { return upper(value).replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || fallback; }

function shortKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();
  if (!raw) return null;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;
  return `${SHORT_KEY_PREFIX}${raw}`;
}

function getWeekMicrosBaseKey(weekKey) {
  const fromKeys = typeof KEYS.analyze?.weekMicros === 'function' ? KEYS.analyze.weekMicros(weekKey) : null;
  return shortKey(fromKeys, `ANALYZE:WEEK:${weekKey}:MICROS`);
}
function getWeekMicrosTopKey(weekKey) { return `${getWeekMicrosBaseKey(weekKey)}:TOP`; }
function getWeekMetaKey(weekKey) { return shortKey(typeof KEYS.analyze?.weekMeta === 'function' ? KEYS.analyze.weekMeta(weekKey) : null, `ANALYZE:WEEK:${weekKey}:META`); }
function getWeekTradingCandidatesKey(weekKey) { return `${getWeekMicrosBaseKey(weekKey)}:TRADING_CANDIDATES`; }

async function readJsonAny(key, fallback = null) {
  const volatile = getVolatileRedis();
  const durable = getDurableRedis();
  const v = await getJson(volatile, key, null).catch(() => null);
  if (v) return v;
  const d = await getJson(durable, key, null).catch(() => null);
  return d || fallback;
}
async function setJsonEverywhere(key, value) {
  await setJson(getDurableRedis(), key, value);
  await setJson(getVolatileRedis(), key, value).catch(() => null);
}

function modeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    virtualOnly: true,
    virtualLearning: true,
    virtualTracked: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,
    bitgetOrderPlaced: false,
    realOrdersDisabled: true,
    exchangeOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsUsedAsLearningFamily: true,
    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: MICRO_MICRO_SCHEMA,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningGranularity: LEARNING_GRANULARITY,
    child75LearningGranularity: LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    selectionGranularity: SELECTION_EXACT_MICRO_MICRO,
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,
    microMicroVersion: MICRO_MICRO_VERSION,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}
function flags(row = {}) { return { ...modeFlags(), ...row }; }

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);
  if (!value.startsWith('MICRO_SHORT_')) return { valid: false, selectable: false, isParent: false, isChild: false, isMicroMicro: false, rawId };

  let baseValue = value;
  let microMicroHash = null;
  const mm = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,24})$/u.exec(value);
  if (mm) { baseValue = mm[1]; microMicroHash = mm[2].slice(0, MICRO_MICRO_HASH_LEN); }

  let body = baseValue.slice('MICRO_SHORT_'.length);
  let confirmationProfile = null;
  for (const p of CONFIRMATION_PROFILE_ORDER) {
    const suffix = `_${p}`;
    if (body.endsWith(suffix)) { confirmationProfile = p; body = body.slice(0, -suffix.length); break; }
  }

  let setup = null;
  let regime = null;
  for (const r of REGIME_ORDER) {
    const suffix = `_${r}`;
    if (body.endsWith(suffix)) { regime = r; setup = body.slice(0, -suffix.length); break; }
  }

  const parentId = setup && regime ? `MICRO_SHORT_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;
  const validParent = Boolean(parentId) && SETUPS.has(setup) && REGIMES.has(regime);
  const validChild = validParent && Boolean(confirmationProfile) && CONFIRMATIONS.has(confirmationProfile);
  const microMicroFamilyId = validChild && microMicroHash ? `${childId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}` : null;
  const isMicroMicro = Boolean(microMicroFamilyId);
  const isChild = validChild && !isMicroMicro;
  const isParent = validParent && !validChild && !isMicroMicro;

  return {
    valid: validParent || validChild || isMicroMicro,
    selectable: isMicroMicro,
    isParent,
    isChild,
    isMicroMicro,
    rawId,
    id: microMicroFamilyId || childId || parentId || value,
    setup,
    regime,
    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,
    parentTrueMicroFamilyId: validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,
    trueMicroFamilyId: isMicroMicro ? microMicroFamilyId : validChild ? childId : validParent ? parentId : null,
    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,
    learningLayer: isMicroMicro ? LAYER_MICRO_MICRO : isChild ? LAYER_MICRO_75 : isParent ? LAYER_PARENT_15 : 'UNKNOWN'
  };
}
function isParentId(id = '') { return parseShortTaxonomyMicroId(id).isParent; }
function isChildId(id = '') { return parseShortTaxonomyMicroId(id).isChild; }
function isMicroMicroId(id = '') { return parseShortTaxonomyMicroId(id).isMicroMicro; }
function isLearningId(id = '') { const p = parseShortTaxonomyMicroId(id); return p.isParent || p.isChild || p.isMicroMicro; }
function childIdFrom(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);
  if (p.isMicroMicro || p.isChild) return p.childTrueMicroFamilyId || '';
  const direct = [row.childTrueMicroFamilyId, row.trueMicroFamilyId, row.microFamilyId, row.microMicroFamilyId].map((x) => parseShortTaxonomyMicroId(x)).find((x) => x.isChild || x.isMicroMicro);
  return direct?.childTrueMicroFamilyId || '';
}
function parentIdFrom(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);
  if (p.valid) return p.parentTrueMicroFamilyId || '';
  const child = childIdFrom(id, row);
  return parseShortTaxonomyMicroId(child).parentTrueMicroFamilyId || '';
}
function microMicroIdFrom(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);
  if (p.isMicroMicro) return p.microMicroFamilyId;
  const direct = [row.microMicroFamilyId, row.trueMicroMicroFamilyId, row.exactMicroMicroFamilyId].map((x) => parseShortTaxonomyMicroId(x)).find((x) => x.isMicroMicro);
  if (direct) return direct.microMicroFamilyId;
  const child = childIdFrom(id, row);
  if (!child) return '';
  const hash = String(row.microMicroHash || row.executionFingerprintHash || row.executionHash || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, MICRO_MICRO_HASH_LEN);
  if (hash.length >= 6) return `${child}_${MICRO_MICRO_SUFFIX}_${hash}`;
  const xr = /^(MICRO_SHORT_.+)_XR_([A-Z0-9]{6,24})$/u.exec(upper(row.executionMicroFamilyId || row.executionFingerprintMicroFamilyId || ''));
  if (xr) return `${child}_${MICRO_MICRO_SUFFIX}_${xr[2].slice(0, MICRO_MICRO_HASH_LEN)}`;
  return '';
}
function normalizeLearningFamilyId(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);
  if (p.isMicroMicro) return p.microMicroFamilyId;
  if (p.isChild) return p.childTrueMicroFamilyId;
  if (p.isParent) return p.parentTrueMicroFamilyId;
  const mm = microMicroIdFrom(id, row);
  if (mm) return mm;
  const child = childIdFrom(id, row);
  if (child) return child;
  return parentIdFrom(id, row);
}

function inferTradeSide(row = {}) {
  const direct = [row.tradeSide, row.positionSide, row.direction, row.signalSide, row.entrySide, row.analysisSide, row.scannerSide, row.actualScannerSide, row.side]
    .map((x) => sideToTradeSide(upper(x)))
    .find((x) => x === TARGET_TRADE_SIDE || x === OPPOSITE_TRADE_SIDE);
  if (direct) return direct;
  const text = upper([row.microFamilyId, row.trueMicroFamilyId, row.childTrueMicroFamilyId, row.microMicroFamilyId, row.definition, row.scannerReason, row.reason].filter(Boolean).join('|'));
  if (text.includes('MICRO_SHORT') || text.includes('SHORT') || text.includes('BEAR')) return TARGET_TRADE_SIDE;
  if (text.includes('MICRO_LONG') || text.includes('LONG') || text.includes('BULL')) return OPPOSITE_TRADE_SIDE;
  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;
  return 'UNKNOWN';
}
function isShort(row = {}) { return inferTradeSide(row) === TARGET_TRADE_SIDE; }

function normalizeSetup(value = '') {
  const v = norm(value);
  if (SETUPS.has(v)) return v;
  if (v.includes('SWEEP') || v.includes('REVERSAL') || v.includes('LIQUIDITY')) return 'SWEEP_REVERSAL';
  if (v.includes('RETEST') || v.includes('PULLBACK')) return 'RETEST';
  if (v.includes('SQUEEZE') || v.includes('COMPRESSION') || v.includes('COIL')) return 'COMPRESSION';
  if (v.includes('BREAKOUT') || v.includes('BREAKDOWN')) return 'BREAKOUT';
  if (v.includes('CONTINUATION') || v.includes('MOMENTUM') || v.includes('TREND')) return 'CONTINUATION';
  return null;
}
function normalizeRegime(value = '') {
  const v = norm(value);
  if (REGIMES.has(v)) return v;
  if (v.includes('SQUEEZE') || v.includes('LOW_VOL') || v.includes('TIGHT')) return 'SQUEEZE';
  if (v.includes('CHOP') || v.includes('RANGE') || v.includes('SIDEWAYS')) return 'CHOP';
  if (v.includes('TREND') || v.includes('NORMAL_VOL') || v.includes('HIGH_VOL') || v.includes('IMPULSE')) return 'TREND';
  return null;
}
function normalizeConfirmation(value = '') {
  const v = norm(value);
  if (CONFIRMATIONS.has(v)) return v;
  if (v.includes('STRONG') || v.includes('FULL_ALIGN') || v.includes('ALL_ALIGN')) return 'A_STRONG_ALIGN';
  if (v.includes('FLOW') || v.includes('MOMENTUM')) return 'B_FLOW_ALIGN';
  if (v.includes('VOLUME') || v.includes('VOL')) return 'C_VOLUME_ALIGN';
  if (v.includes('WEAK') || v.includes('CONTRA') || v.includes('AGAINST')) return 'E_WEAK_CONTRA';
  if (v.includes('MIXED') || v.includes('NEUTRAL') || v.includes('OK')) return 'D_MIXED_OK';
  return null;
}

function classifyTaxonomy(row = {}, classified = {}) {
  const explicit = [row.microMicroFamilyId, row.trueMicroMicroFamilyId, row.exactMicroMicroFamilyId, row.childTrueMicroFamilyId, row.trueMicroFamilyId, row.microFamilyId, classified.trueMicroFamilyId, classified.microFamilyId]
    .map((x) => parseShortTaxonomyMicroId(x)).find((x) => x.isChild || x.isMicroMicro);
  if (explicit) {
    const child = explicit.childTrueMicroFamilyId;
    return { setup: explicit.setup, regime: explicit.regime, confirmation: explicit.confirmationProfile, parentId: explicit.parentTrueMicroFamilyId, childId: child };
  }

  const text = [row.setupType, row.setup, row.pattern, row.scannerReason, row.reason, row.definition, classified.setupType, classified.setup, classified.scannerReason, classified.definition].filter(Boolean).join('|');
  const setup = normalizeSetup(text) || 'CONTINUATION';
  const regime = normalizeRegime(row.regimeBucket || row.regime || row.regimeCoarse || row.marketRegime || classified.regimeBucket || classified.regime || classified.regimeCoarse) || 'TREND';
  const confluence = n(row.confluence ?? row.sniperScore ?? row.scannerScore ?? row.moveScore ?? classified.confluence ?? classified.sniperScore, 0);
  const confirmation = normalizeConfirmation(row.confirmationProfile || classified.confirmationProfile || text) || (confluence >= 80 ? 'A_STRONG_ALIGN' : confluence >= 65 ? 'B_FLOW_ALIGN' : 'D_MIXED_OK');
  const parentId = `MICRO_SHORT_${setup}_${regime}`;
  return { setup, regime, confirmation, parentId, childId: `${parentId}_${confirmation}` };
}

function buildExecutionParts(row = {}, classified = {}, taxonomy = {}) {
  return [
    `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
    `TRUE_MICRO=${taxonomy.childId}`,
    `PARENT_TRUE_MICRO=${taxonomy.parentId}`,
    `SETUP=${taxonomy.setup}`,
    `REGIME_BUCKET=${taxonomy.regime}`,
    `CONFIRMATION_PROFILE=${taxonomy.confirmation}`,
    `RSI=${norm(row.rsiZone || row.rsiCoarse || classified.rsiZone || classified.rsiCoarse || 'NA')}`,
    `FLOW=${norm(row.flowCoarse || row.flow || classified.flowCoarse || classified.flow || 'NA')}`,
    `OB_REL=${norm(row.obRelation || classified.obRelation || 'NA')}`,
    `BTC_STATE=${norm(row.btcState || classified.btcState || 'NA')}`,
    `BTC_REL=${norm(row.btcRelation || classified.btcRelation || 'NA')}`,
    `SCANNER=${norm(row.scannerReasonCoarse || row.scannerReason || row.reason || classified.scannerReason || 'NA')}`,
    `SPREAD=${norm(row.spreadBps ?? row.spreadPct ?? 'NA')}`,
    `DEPTH=${norm(row.depthMinUsd1p ?? 'NA')}`,
    `RR=${norm(row.rr ?? row.riskReward ?? 'NA')}`,
    `CONF=${norm(row.confluence ?? row.sniperScore ?? row.scannerScore ?? row.moveScore ?? 'NA')}`,
    `ENTRY_DIST=${norm(row.entryDistancePct ?? row.entryDistanceBps ?? 'NA')}`,
    `RISK=${norm(row.riskPct ?? row.slDistancePct ?? 'NA')}`,
    `REWARD=${norm(row.rewardPct ?? row.tpDistancePct ?? 'NA')}`,
    `FAKE=${row.fakeBreakout || row.fakeBreakoutRisk ? 'YES' : 'NO'}`,
    `RISK_PLAN=${row.riskPlanVersion || SHORT_RISK_PLAN_VERSION}`,
    'SYMBOL_EXCLUDED=true',
    'COIN_EXCLUDED=true'
  ];
}

function enrichWithMicroFamily(row = {}) {
  if (!isShort(row)) return null;
  let macro = {};
  let micro = {};
  try { macro = classifyMacroFamily(row) || {}; } catch {}
  try { micro = classifyMicroFamily(row) || {}; } catch {}
  const classified = { ...macro, ...micro };
  const taxonomy = classifyTaxonomy(row, classified);
  const executionParts = buildExecutionParts(row, classified, taxonomy);
  const executionHash = hashText(executionParts.join('|'), EXECUTION_MICRO_HASH_LEN);
  const microMicroId = microMicroIdFrom(row.microMicroFamilyId, { ...row, childTrueMicroFamilyId: taxonomy.childId, executionFingerprintHash: executionHash }) || `${taxonomy.childId}_${MICRO_MICRO_SUFFIX}_${executionHash.slice(0, MICRO_MICRO_HASH_LEN)}`;
  const microMicroParts = [...executionParts, `MICRO_MICRO=${microMicroId}`, `MICRO_MICRO_HASH=${executionHash}`, `LAYER=${LAYER_MICRO_MICRO}`];

  return flags({
    ...row,
    familyId: row.familyId || 'SHORT_FIXED_TAXONOMY',
    microFamilyId: taxonomy.childId,
    trueMicroFamilyId: taxonomy.childId,
    childTrueMicroFamilyId: taxonomy.childId,
    parentTrueMicroFamilyId: taxonomy.parentId,
    coarseMicroFamilyId: taxonomy.parentId,
    baseMicroFamilyId: taxonomy.parentId,
    legacyMicroFamilyId: taxonomy.parentId,
    parentMicroFamilyId: taxonomy.parentId,
    macroFamilyId: taxonomy.parentId,
    parentMacroFamilyId: taxonomy.parentId,
    microMicroFamilyId: microMicroId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,
    microMicroHash: executionHash,
    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: taxonomy.confirmation,
    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `TRUE_MICRO=${taxonomy.childId}`,
      `PARENT_TRUE_MICRO=${taxonomy.parentId}`,
      `SETUP=${taxonomy.setup}`,
      `REGIME_BUCKET=${taxonomy.regime}`,
      `CONFIRMATION_PROFILE=${taxonomy.confirmation}`,
      `MEASUREMENT_FIX=${MEASUREMENT_FIX_VERSION}`
    ],
    parentDefinitionParts: [`TRADE_SIDE=${TARGET_TRADE_SIDE}`, `PARENT_TRUE_MICRO=${taxonomy.parentId}`, `SETUP=${taxonomy.setup}`, `REGIME_BUCKET=${taxonomy.regime}`, `LAYER=${LAYER_PARENT_15}`],
    microMicroDefinitionParts: microMicroParts,
    executionFingerprintHash: executionHash,
    executionFingerprintParts: executionParts,
    executionMicroFamilyId: `${taxonomy.childId}_${EXECUTION_MICRO_SUFFIX}_${executionHash}`,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: true,
    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    microMicroSelectionAllowed: true,
    riskPlanVersion: row.riskPlanVersion || SHORT_RISK_PLAN_VERSION
  });
}

function layerFor(id = '') { return parseShortTaxonomyMicroId(id).learningLayer || 'UNKNOWN'; }
function granularityFor(id = '') { const l = layerFor(id); return l === LAYER_MICRO_MICRO ? MICRO_MICRO_LEARNING_GRANULARITY : l === LAYER_PARENT_15 ? PARENT_LEARNING_GRANULARITY : LEARNING_GRANULARITY; }
function schemaFor(id = '') { const l = layerFor(id); return l === LAYER_MICRO_MICRO ? MICRO_MICRO_SCHEMA : l === LAYER_PARENT_15 ? PARENT_TRUE_MICRO_SCHEMA : TRUE_MICRO_SCHEMA; }
function minCompletedFor(id = '') { return layerFor(id) === LAYER_MICRO_MICRO ? MIN_COMPLETED_MICRO_MICRO_ACTIVE : MIN_COMPLETED_ACTIVE_LEARNING; }
function statusFor(row = {}) { const c = n(row.completed ?? row.outcomeSample, 0); const min = n(row.minCompletedForActiveLearning, MIN_COMPLETED_ACTIVE_LEARNING); return c >= min ? 'ACTIVE_LEARNING' : c > 0 ? 'EARLY_OUTCOMES' : 'OBSERVING'; }

function applyLayerIdentity(row = {}, id = '') {
  const learningId = normalizeLearningFamilyId(id, row);
  const parsed = parseShortTaxonomyMicroId(learningId);
  if (!parsed.valid) return null;
  const child = parsed.childTrueMicroFamilyId || childIdFrom(learningId, row);
  const parent = parsed.parentTrueMicroFamilyId || parentIdFrom(learningId, row);
  const mm = parsed.microMicroFamilyId || microMicroIdFrom(learningId, row);
  const layer = parsed.learningLayer;
  const minCompleted = minCompletedFor(learningId);
  return flags({
    ...row,
    microFamilyId: learningId,
    trueMicroFamilyId: learningId,
    analyzeMicroFamilyId: learningId,
    learningMicroFamilyId: learningId,
    childTrueMicroFamilyId: child || null,
    parentTrueMicroFamilyId: parent || null,
    coarseMicroFamilyId: parent || null,
    baseMicroFamilyId: parent || null,
    legacyMicroFamilyId: parent || null,
    parentMicroFamilyId: parent || null,
    macroFamilyId: parent || null,
    parentMacroFamilyId: parent || null,
    microMicroFamilyId: mm || (parsed.isMicroMicro ? learningId : null),
    trueMicroMicroFamilyId: mm || (parsed.isMicroMicro ? learningId : null),
    exactMicroMicroFamilyId: mm || (parsed.isMicroMicro ? learningId : null),
    microMicroHash: parsed.microMicroHash || row.microMicroHash || row.executionFingerprintHash || null,
    setupType: parsed.setup || row.setupType || null,
    regimeBucket: parsed.regime || row.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || row.confirmationProfile || null,
    schema: schemaFor(learningId),
    microFamilySchema: schemaFor(learningId),
    trueMicroFamilySchema: schemaFor(learningId),
    learningGranularity: granularityFor(learningId),
    learningLayer: layer,
    layer,
    selectable: layer === LAYER_MICRO_MICRO,
    microMicroSelectionAllowed: layer === LAYER_MICRO_MICRO,
    micro75SelectionAllowed: false,
    parentSelectionAllowed: false,
    parentContextOnly: layer === LAYER_PARENT_15,
    child75ContextOnly: layer === LAYER_MICRO_75,
    minCompletedForActiveLearning: minCompleted,
    status: statusFor({ ...row, minCompletedForActiveLearning: minCompleted }),
    learningStatus: statusFor({ ...row, minCompletedForActiveLearning: minCompleted })
  });
}

function layerIds(row = {}) {
  const child = childIdFrom(row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId, row);
  const parent = parentIdFrom(child, row);
  const mm = microMicroIdFrom(row.microMicroFamilyId, { ...row, childTrueMicroFamilyId: child }) || (child && row.executionFingerprintHash ? `${child}_${MICRO_MICRO_SUFFIX}_${String(row.executionFingerprintHash).slice(0, MICRO_MICRO_HASH_LEN)}` : '');
  return uniq([parent, child, mm]).filter(isLearningId);
}

function compactMicro(row = {}) {
  const id = normalizeLearningFamilyId(row.trueMicroFamilyId || row.microFamilyId || row.learningMicroFamilyId || row.id || row.key, row);
  if (!id) return null;
  const layered = applyLayerIdentity(refreshStats(applyLayerIdentity(row, id) || row), id);
  if (!layered) return null;
  const min = minCompletedFor(id);
  const completed = n(layered.completed, 0);
  return flags({
    ...layered,
    definitionParts: Array.isArray(layered.definitionParts) ? layered.definitionParts.slice(0, 64) : [],
    parentDefinitionParts: Array.isArray(layered.parentDefinitionParts) ? layered.parentDefinitionParts.slice(0, 48) : [],
    microMicroDefinitionParts: Array.isArray(layered.microMicroDefinitionParts) ? layered.microMicroDefinitionParts.slice(0, 64) : [],
    examples: Array.isArray(layered.examples) ? layered.examples.slice(-8) : [],
    recentOutcomes: Array.isArray(layered.recentOutcomes) ? layered.recentOutcomes.slice(-8) : [],
    minCompletedForActiveLearning: min,
    status: completed >= min ? 'ACTIVE_LEARNING' : completed > 0 ? 'EARLY_OUTCOMES' : 'OBSERVING',
    learningStatus: completed >= min ? 'ACTIVE_LEARNING' : completed > 0 ? 'EARLY_OUTCOMES' : 'OBSERVING',
    tooEarly: completed < min,
    tooEarlyReason: completed < min ? `completed ${completed}/${min}` : null
  });
}

function normalizeMicros(micros = {}) {
  return Object.fromEntries(Object.entries(micros || {}).map(([key, row]) => {
    if (!row) return null;
    const id = normalizeLearningFamilyId(key, row) || normalizeLearningFamilyId(row.trueMicroFamilyId || row.microFamilyId || row.learningMicroFamilyId, row);
    if (!id) return null;
    const compact = compactMicro({ ...row, trueMicroFamilyId: id, microFamilyId: id, learningMicroFamilyId: id });
    return compact && isShort(compact) ? [id, compact] : null;
  }).filter(Boolean));
}

function compareRows(a = {}, b = {}) {
  const ar = refreshStats(a); const br = refreshStats(b);
  const layerScore = (x) => layerFor(x.trueMicroFamilyId || x.microFamilyId) === LAYER_MICRO_MICRO ? 2 : layerFor(x.trueMicroFamilyId || x.microFamilyId) === LAYER_MICRO_75 ? 1 : 0;
  const eligible = (x) => Number(x.tradingEligible === true || x.eligible === true || x.eligibleGatePassed === true);
  return eligible(br) - eligible(ar) || layerScore(br) - layerScore(ar) || n(br.avgRLCB95 ?? br.lcb95AvgR, 0) - n(ar.avgRLCB95 ?? ar.lcb95AvgR, 0) || n(br.totalR, 0) - n(ar.totalR, 0) || n(br.avgR, 0) - n(ar.avgR, 0) || n(br.completed, 0) - n(ar.completed, 0) || String(ar.microFamilyId || '').localeCompare(String(br.microFamilyId || ''));
}
function topObject(micros = {}, limit = 300) {
  return Object.fromEntries(Object.values(normalizeMicros(micros)).filter((r) => isChildId(r.trueMicroFamilyId) || isMicroMicroId(r.trueMicroFamilyId)).sort(compareRows).slice(0, limit).map((r) => [r.trueMicroFamilyId || r.microFamilyId, r]));
}

export async function getWeekMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const raw = await readJsonAny(getWeekMicrosBaseKey(weekKey), null).catch(() => null);
  if (!raw) return {};
  return normalizeMicros(raw.rows || raw.micros || raw || {});
}
export async function getWeekTopMicros(weekKey = PERSISTENT_LEARNING_KEY, { limit = 25 } = {}) {
  const raw = await readJsonAny(getWeekMicrosTopKey(weekKey), null).catch(() => null);
  if (raw?.rows && Object.keys(raw.rows).length) return topObject(raw.rows, limit);
  return topObject(await getWeekMicros(weekKey), limit);
}
export async function getWeekMicrosByIds(weekKey, ids = []) {
  const micros = await getWeekMicros(weekKey);
  return Object.fromEntries(uniq(ids).map((id) => normalizeLearningFamilyId(id)).filter((id) => id && micros[id]).map((id) => [id, micros[id]]));
}

export async function saveWeekMicros(weekKey, micros, { onlyIds = null, allowEmptyFullSave = false } = {}) {
  if (!weekKey) throw new Error('WEEK_KEY_MISSING');
  const existing = onlyIds ? await getWeekMicros(weekKey).catch(() => ({})) : {};
  const clean = normalizeMicros({ ...(existing || {}), ...(micros || {}) });
  const ids = Object.keys(clean);
  if (!ids.length && !allowEmptyFullSave) return existing || {};
  const layerCounts = Object.values(clean).reduce((acc, row) => { const l = layerFor(row.trueMicroFamilyId || row.microFamilyId); acc.total += 1; if (l === LAYER_PARENT_15) acc.parent15 += 1; if (l === LAYER_MICRO_75) acc.micro75 += 1; if (l === LAYER_MICRO_MICRO) acc.microMicro += 1; return acc; }, { total: 0, parent15: 0, micro75: 0, microMicro: 0 });
  const common = flags({ weekKey, updatedAt: now(), layerCounts, count: ids.length });
  const payload = { ...common, rows: clean, microFamilies: ids.length, sourceMicroMicroRows: layerCounts.microMicro, sourceChild75Rows: layerCounts.micro75, sourceParent15Rows: layerCounts.parent15 };
  const topRows = topObject(clean, 300);
  const candidates = scoreWeeklyTradingCandidates(clean, { requireCurrentFitMatch: false, currentFitLookup: currentFitLookupFromStoredRow });
  await setJsonEverywhere(getWeekMicrosBaseKey(weekKey), payload);
  await setJsonEverywhere(getWeekMicrosTopKey(weekKey), { ...common, rows: topRows, count: Object.keys(topRows).length, storageMode: 'TOP_MICROS_AND_MICRO_MICROS_SNAPSHOT' });
  await setJsonEverywhere(getWeekTradingCandidatesKey(weekKey), { ...common, rows: Object.fromEntries(candidates.map((r) => [r.trueMicroFamilyId || r.microFamilyId, r])), count: candidates.length, storageMode: 'ELIGIBLE_LIFETIME_LCB_CANDIDATES_PREVIEW' });
  await setJsonEverywhere(getWeekMetaKey(weekKey), { ...common, microFamilies: ids.length, tradingCandidatesPreview: candidates.length });
  return clean;
}

function getOrCreateMicro(micros, classified, learningId) {
  const id = normalizeLearningFamilyId(learningId, classified);
  if (!id) throw new Error('LEARNING_FAMILY_ID_REQUIRED');
  if (!micros[id]) {
    micros[id] = createMicroStats({ microFamilyId: id, trueMicroFamilyId: id, familyId: classified.familyId || 'SHORT_FIXED_TAXONOMY', side: TARGET_DASHBOARD_SIDE, tradeSide: TARGET_TRADE_SIDE, definitionParts: classified.definitionParts || [] });
  }
  Object.assign(micros[id], applyLayerIdentity({ ...classified, ...micros[id], trueMicroFamilyId: id, microFamilyId: id }, id));
  return micros[id];
}

function obsKey(snapshotId, symbol, learningId, entry = 0) {
  const base = typeof KEYS.analyze?.obsLast === 'function' ? KEYS.analyze.obsLast(snapshotId, symbol, learningId) : null;
  return `${shortKey(base, `ANALYZE:OBS_LAST:${snapshotId}:${symbol}:${learningId}`)}:ENTRY:${n(entry, 0).toFixed(8)}`;
}
function outcomeKey(weekKey, identity, learningId) {
  const base = typeof KEYS.analyze?.outcomeLast === 'function' ? KEYS.analyze.outcomeLast(weekKey, identity, learningId) : null;
  return shortKey(base, `ANALYZE:OUTCOME_LAST:${weekKey}:${identity}:${learningId}`);
}
async function claim(redis, key, ttlSec, type) {
  const value = String(now());
  for (const opts of [{ ex: ttlSec, nx: true }, { EX: ttlSec, NX: true }]) {
    try {
      const res = await redis.set(key, value, opts);
      if (res === null || res === false) return { claimed: false, duplicate: true, method: 'SET_NX', key, type };
      if (res === true || res === 1 || String(res).toUpperCase() === 'OK') return { claimed: true, duplicate: false, method: 'SET_NX', key, type };
    } catch {}
  }
  const existing = await redis.get(key).catch(() => null);
  if (existing !== null && existing !== undefined) return { claimed: false, duplicate: true, method: 'GET_THEN_SET', key, type };
  await redis.set(key, value, { ex: ttlSec }).catch(() => null);
  return { claimed: true, duplicate: false, method: 'GET_THEN_SET', key, type };
}
function obsTtl() { return Math.max(60, Math.floor(n(CONFIG?.analyze?.obsDedupeTtlSec, 86400))); }
function outcomeTtl() { return Math.max(60, Math.floor(n(CONFIG?.analyze?.outcomeDedupeTtlSec, 86400 * 14))); }

export async function analyzeCandidatesBatch(metricsRows = [], { weekKey = PERSISTENT_LEARNING_KEY } = {}) {
  const input = Array.isArray(metricsRows) ? metricsRows.filter(Boolean).filter(isShort) : [];
  if (!input.length) return [];
  const rows = input.map(enrichWithMicroFamily).filter(Boolean);
  if (!rows.length) return [];
  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);
  const touched = new Set();
  const analyzed = [];

  for (const row of rows) {
    const child = childIdFrom(row.trueMicroFamilyId, row);
    const parent = parentIdFrom(child, row);
    const ids = layerIds(row);
    const snapshotId = String(row.snapshotId || row.scanSnapshotId || row.scannerSnapshotId || row.runId || 'NO_SNAPSHOT');
    const symbol = upper(row.symbol || row.contractSymbol || row.baseSymbol || 'UNKNOWN');
    const entry = n(row.entry || row.entryPrice || row.price, 0);
    const results = [];
    for (const id of ids) {
      const key = obsKey(snapshotId, symbol, id, entry);
      const c = await claim(redis, key, obsTtl(), `OBSERVATION:${layerFor(id)}`);
      const recorded = c.claimed && !c.duplicate;
      results.push({ id, key, claim: c, recorded });
      if (!recorded) continue;
      const layerRow = applyLayerIdentity({ ...row, childTrueMicroFamilyId: child, parentTrueMicroFamilyId: parent }, id);
      const micro = getOrCreateMicro(micros, layerRow, id);
      updateObservation(micro, flags({ ...layerRow, source: 'VIRTUAL', weekKey, observationDedupeKey: key, observationDedupeMethod: c.method, observationDedupeVersion: OBSERVATION_DEDUPE_VERSION, observationRecorded: true, observationCounted: true, countObservation: true, createdAt: row.createdAt || now() }));
      Object.assign(micro, applyLayerIdentity(refreshStats(micro), id));
      touched.add(id);
    }
    const mm = microMicroIdFrom(row.microMicroFamilyId, row);
    const chosen = results.find((x) => x.id === mm) || results.find((x) => x.id === child) || results[0];
    analyzed.push(flags({ ...row, trueMicroFamilyId: child, microFamilyId: child, childTrueMicroFamilyId: child, parentTrueMicroFamilyId: parent, microMicroFamilyId: mm, trueMicroMicroFamilyId: mm, exactMicroMicroFamilyId: mm, learningIds: ids, parentLearningId: parent, childLearningId: child, microMicroLearningId: mm, observationRecorded: results.some((x) => x.recorded), observationDuplicate: !results.some((x) => x.recorded) && results.some((x) => x.claim?.duplicate), observationDedupeKey: chosen?.key || null, observationDedupeMethod: chosen?.claim?.method || null, observationDedupeVersion: OBSERVATION_DEDUPE_VERSION }));
  }
  if (touched.size) await saveWeekMicros(weekKey, micros, { onlyIds: [...touched] });
  return analyzed;
}

function calcRiskPct({ entry, sl }) { return entry > 0 && sl > 0 ? Math.abs(entry - sl) / entry : 0; }
function calcShortGrossR({ entry, initialSl, exit }) { const d = initialSl - entry; return entry > 0 && exit > 0 && d > 0 ? (entry - exit) / d : 0; }
function grossMovePct(entry, exit) { return entry > 0 && exit > 0 ? (entry - exit) / entry : 0; }
function isDirectSL(position = {}, reason = '') { const r = upper(reason); return Boolean(position.directToSL || position.directSL || (r.includes('SL') && !position.nearTpSeen && !position.reachedHalfR && !position.reachedOneR)); }
function stableOutcomeIdentity(outcome = {}, child = '') {
  const raw = [TARGET_TRADE_SIDE, outcome.tradeId || outcome.positionId || '', outcome.symbol || outcome.contractSymbol || 'UNKNOWN', outcome.openedAt || outcome.createdAt || 'NO_OPEN', outcome.closedAt || outcome.completedAt || outcome.ts || 'NO_CLOSE', outcome.exitReason || outcome.reason || 'NO_REASON', n(outcome.exit ?? outcome.exitPrice, 0).toFixed(8), child, outcome.microMicroFamilyId || ''].join('|');
  return hashText(raw, 24);
}

function ensureOutcomeIds(outcome = {}) {
  const enriched = hasMicroIds(outcome) ? flags(outcome) : enrichWithMicroFamily(outcome);
  if (!enriched) return null;
  const child = childIdFrom(enriched.trueMicroFamilyId || enriched.microFamilyId, enriched);
  const parent = parentIdFrom(child, enriched);
  const mm = microMicroIdFrom(enriched.microMicroFamilyId, enriched) || (child ? `${child}_${MICRO_MICRO_SUFFIX}_${hashText(JSON.stringify(enriched), MICRO_MICRO_HASH_LEN)}` : '');
  return flags({ ...enriched, trueMicroFamilyId: child, microFamilyId: child, childTrueMicroFamilyId: child, parentTrueMicroFamilyId: parent, coarseMicroFamilyId: parent, microMicroFamilyId: mm, trueMicroMicroFamilyId: mm, exactMicroMicroFamilyId: mm });
}
function hasMicroIds(row = {}) { return Boolean(childIdFrom(row.trueMicroFamilyId || row.microFamilyId || row.childTrueMicroFamilyId, row)); }

export function buildOutcomeFromPosition({ position, exitPrice, exitReason, source = 'VIRTUAL' }) {
  if (!position) throw new Error('POSITION_REQUIRED_FOR_OUTCOME');
  const entry = n(position.entry, 0);
  const initialSl = n(position.initialSl || position.sl, 0);
  const exit = n(exitPrice, 0);
  const tp = n(position.tp, 0);
  const riskPct = n(position.riskPct, 0) || calcRiskPct({ entry, sl: initialSl });
  const grossMove = grossMovePct(entry, exit);
  const grossR = calcShortGrossR({ entry, initialSl, exit });
  const cost = applyCosts({ side: TARGET_TRADE_SIDE, tradeSide: TARGET_TRADE_SIDE, grossMovePct: grossMove, riskPct, entrySpreadPct: n(position.spreadPct, 0), exitSpreadPct: n(position.exitSpreadPct ?? position.spreadPct, 0) });
  const costR = n(cost.costR, 0);
  const netR = n(cost.netR, grossR - costR);
  const closedAt = n(position.closedAt || position.completedAt, now());
  const ids = ensureOutcomeIds(position) || {};
  const identity = [TARGET_TRADE_SIDE, position.tradeId || '', position.symbol || position.contractSymbol || '', position.openedAt || position.createdAt || '', closedAt, exitReason || '', exit, ids.trueMicroFamilyId || '', ids.microMicroFamilyId || ''].join('|');
  return flags({ ...position, ...ids, type: 'OUTCOME', source, outcomeSource: source, positionSource: position.source || 'VIRTUAL', tradeId: position.tradeId, positionId: position.positionId || position.id || null, outcomeIdentity: position.outcomeIdentity || identity, stableOutcomeIdentity: identity, symbol: position.symbol, contractSymbol: position.contractSymbol, entry, exit, exitPrice: exit, sl: n(position.sl, 0), initialSl, tp, rr: n(position.rr, 0), riskPct, rewardPct: entry > 0 && tp > 0 ? Math.max(0, (entry - tp) / entry) : 0, validShortRiskShape: entry > 0 && tp < entry && entry < initialSl, exitReason, grossMovePct: grossMove, grossR, shortGrossR: grossR, rawR: grossR, realizedGrossR: grossR, netR, shortNetR: netR, exitR: netR, realizedNetR: netR, realizedR: netR, r: netR, costR, avgCostR: costR, executionCostR: Math.max(0, costR - n(position.fundingCostR, 0)), fundingCostR: n(position.fundingCostR, 0), win: netR > 0, loss: netR < 0, flat: netR === 0, directToSL: isDirectSL(position, exitReason), directSL: isDirectSL(position, exitReason), costModelApplied: true, netCostModelApplied: true, costModel: 'APPLY_COSTS_NET_R_V2_EXECUTION_FUNDING_SPLIT', openedAt: position.openedAt || position.createdAt || null, closedAt, completedAt: closedAt });
}

export async function recordOutcome(outcome = {}, { source = outcome.source || 'VIRTUAL', weekKey = PERSISTENT_LEARNING_KEY } = {}) {
  if (!isShort(outcome)) return flags({ ...outcome, skipped: true, reason: 'NON_SHORT_OUTCOME_SKIPPED_SHORT_ONLY', source, weekKey, recordedAt: now() });
  const row = ensureOutcomeIds(outcome);
  if (!row) return flags({ ...outcome, skipped: true, reason: 'SHORT_ONLY_CLASSIFICATION_SKIPPED_OR_EXACT_75_CHILD_MISSING', source, weekKey, recordedAt: now() });
  const child = childIdFrom(row.trueMicroFamilyId, row);
  const parent = parentIdFrom(child, row);
  const ids = layerIds(row);
  if (!ids.length) return flags({ ...row, skipped: true, reason: 'NO_LAYERED_LEARNING_IDS_FOR_OUTCOME', source, weekKey, recordedAt: now() });
  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);
  const touched = new Set();
  const outcomeIdentity = stableOutcomeIdentity(row, child);
  const results = [];
  const netR = n(row.netR ?? row.exitR ?? row.realizedR ?? row.r, 0);
  const normalizedOutcome = flags({ ...row, source, outcomeSource: source, weekKey, netR, shortNetR: netR, exitR: netR, realizedNetR: netR, realizedR: netR, r: netR, costR: n(row.costR ?? row.avgCostR, 0), avgCostR: n(row.avgCostR ?? row.costR, 0), win: netR > 0, loss: netR < 0, flat: netR === 0, directSL: Boolean(row.directSL || row.directToSL), directToSL: Boolean(row.directSL || row.directToSL) });
  for (const id of ids) {
    const key = outcomeKey(weekKey, outcomeIdentity, id);
    const c = await claim(redis, key, outcomeTtl(), `OUTCOME:${layerFor(id)}`);
    const recorded = c.claimed && !c.duplicate;
    results.push({ id, key, claim: c, recorded });
    if (!recorded) continue;
    const layerRow = applyLayerIdentity({ ...normalizedOutcome, childTrueMicroFamilyId: child, parentTrueMicroFamilyId: parent }, id);
    const micro = getOrCreateMicro(micros, layerRow, id);
    updateOutcome(micro, flags({ ...layerRow, outcomeDedupeKey: key, outcomeDedupeMethod: c.method, outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION, outcomeCounted: true, countOutcome: true, recordedAt: now() }), source);
    Object.assign(micro, applyLayerIdentity(refreshStats(micro), id));
    touched.add(id);
  }
  const any = results.some((x) => x.recorded);
  if (touched.size) await saveWeekMicros(weekKey, micros, { onlyIds: [...touched] });
  const mm = microMicroIdFrom(row.microMicroFamilyId, row);
  const chosen = results.find((x) => x.id === mm) || results.find((x) => x.id === child) || results[0];
  return flags({ ...normalizedOutcome, trueMicroFamilyId: child, microFamilyId: child, childTrueMicroFamilyId: child, parentTrueMicroFamilyId: parent, microMicroFamilyId: mm, trueMicroMicroFamilyId: mm, exactMicroMicroFamilyId: mm, learningIds: ids, parentLearningId: parent, childLearningId: child, microMicroLearningId: mm, skipped: !any, reason: any ? null : 'DUPLICATE_OUTCOME_SKIPPED_NO_STATS_UPDATE', outcomeDuplicate: !any, outcomeCounted: any, countOutcome: any, outcomeDedupeKey: chosen?.key || null, outcomeDedupeMethod: chosen?.claim?.method || null, outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION, recordedAt: now() });
}

export async function createShadowPosition() {
  return { ok: false, created: false, skipped: true, reason: 'SHADOW_POSITION_CREATION_MOVED_TO_POSITION_ENGINE_VIRTUAL_TRACKING' };
}

function currentFitLookupFromStoredRow(row = {}) {
  const direct = upper(row.currentFit || row.entryCurrentFit || row.marketFit || '');
  if (direct.includes('MATCH') || direct === 'FIT' || direct === 'ALIGNED') return 'MATCH';
  if (direct.includes('MISFIT') || direct.includes('AGAINST')) return 'MISFIT';
  const recent = Array.isArray(row.recentOutcomes) ? row.recentOutcomes : [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const fit = currentFitLookupFromStoredRow(recent[i]);
    if (fit !== 'UNKNOWN') return fit;
  }
  return 'UNKNOWN';
}

export async function getWeeklyTradingCandidates(weekKey = PERSISTENT_LEARNING_KEY, { limit = 10, requireCurrentFitMatch = true, currentFitLookup = null, includeMeta = false } = {}) {
  const micros = await getWeekMicros(weekKey);
  const candidates = scoreWeeklyTradingCandidates(micros, { requireCurrentFitMatch, currentFitLookup: currentFitLookup || currentFitLookupFromStoredRow })
    .filter((row) => layerFor(row.trueMicroFamilyId || row.microFamilyId) === LAYER_MICRO_MICRO)
    .slice(0, Math.max(1, Math.floor(n(limit, 10))))
    .map((row, index) => flags({ ...row, rank: index + 1, weekKey, tradingCandidate: true, tradingEligible: true, eligibleGatePassed: true, selectionSource: 'LIFETIME_LCB_CURRENTFIT', discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY', discordMatchId: row.microMicroFamilyId || row.trueMicroMicroFamilyId || row.exactMicroMicroFamilyId || row.microFamilyId }));
  if (!includeMeta) return candidates;
  return { weekKey, generatedAt: now(), count: candidates.length, candidates, requireCurrentFitMatch, selectionEngineVersion: SELECTION_ENGINE_VERSION, rules: { selectionUsesWeeklyWinnerOnly: false, selectionUsesLifetimeStats: true, selectionUsesLCBAvgR: true, selectionRequiresEligibleGate: true, selectionRequiresCurrentFitMatch: requireCurrentFitMatch, discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY' }, emptyReason: candidates.length ? null : requireCurrentFitMatch ? 'NO_ELIGIBLE_MICRO_MICRO_WITH_CURRENT_FIT_MATCH' : 'NO_ELIGIBLE_MICRO_MICRO' };
}

export async function getAnalyzeMicroRowsByIds(weekKey = PERSISTENT_LEARNING_KEY, ids = []) {
  return getWeekMicrosByIds(weekKey, ids);
}