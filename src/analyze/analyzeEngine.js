// ================= FILE: src/analyze/analyzeEngine.js =================
//
// SHORT analyze engine.
// Fix:
// - micro-micro is nu de primaire learning identity.
// - child75 blijft context/rollup.
// - parent15 blijft context/rollup.
// - recordOutcome() schrijft altijd MM als primary row wanneer MM beschikbaar is.
// - getWeekMicros() normaliseert oude rows opnieuw zodat MM niet meer als child75 verdwijnt.

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
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';
const TRUE_MICRO_MICRO_SCHEMA = MICRO_MICRO_SCHEMA;

const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;

const EXECUTION_MICRO_SUFFIX = 'XR';
const EXECUTION_MICRO_HASH_LEN = 10;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const CHILD75_LEARNING_GRANULARITY = LEARNING_GRANULARITY;
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const MIN_COMPLETED_ACTIVE_LEARNING = 20;
const MIN_COMPLETED_MICRO_MICRO_ACTIVE = 35;
const DEFAULT_POSITION_TIME_STOP_MIN = 720;

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V1';
const POSITION_MEASUREMENT_FIX_VERSION = MEASUREMENT_FIX_VERSION;
const MICRO_MICRO_VERSION = 'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V1';
const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const COST_MODEL_VERSION = 'POSITION_ENGINE_SHORT_NET_COST_V11';
const OBSERVATION_DEDUPE_VERSION = 'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V2';
const OUTCOME_DEDUPE_VERSION = 'SHORT_OUTCOME_DEDUPE_CLOSED_POSITION_V3';
const SELECTION_ENGINE_VERSION = 'SHORT_LIFETIME_LCB_CURRENTFIT_SELECTION_V1';
const ADAPTIVE_UI_VERSION = 'SHORT_ADAPTIVE_UI_MARKETWEATHER_CURRENTFIT_MICRO_MICRO_ONLY_V3';
const WEAK_CONTRA_ENTRY_GATE_VERSION = 'SHORT_E_WEAK_CONTRA_STRICT_ENTRY_GATE_V1';

const PRIMARY_LEARNING_ID_RULE = 'MICRO_MICRO_PRIMARY_CHILD75_PARENT15_CONTEXT_ONLY_V2';

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

const SETUPS = new Set(SETUP_ORDER);
const REGIMES = new Set(REGIME_ORDER);
const CONFIRMATIONS = new Set(CONFIRMATION_PROFILE_ORDER);

function now() {
  return Date.now();
}

function upper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function n(value, fallback = 0) {
  const x = safeNumber(value, fallback);
  return Number.isFinite(x) ? x : fallback;
}

function finite(value) {
  const x = Number(value);
  return Number.isFinite(x);
}

function hashText(value, len = EXECUTION_MICRO_HASH_LEN) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .toUpperCase()
    .slice(0, len);
}

function flattenSafe(values = [], maxDepth = 5) {
  const out = [];
  const stack = [{ value: values, depth: 0 }];

  while (stack.length) {
    const item = stack.shift();

    if (Array.isArray(item.value) && item.depth < maxDepth) {
      for (const child of item.value) {
        stack.push({
          value: child,
          depth: item.depth + 1
        });
      }

      continue;
    }

    out.push(item.value);
  }

  return out;
}

function uniq(values = []) {
  return [
    ...new Set(
      flattenSafe(values)
        .map((x) => String(x || '').trim())
        .filter(Boolean)
    )
  ];
}

function norm(value = '', fallback = '') {
  return upper(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function shortKey(key, fallback = null) {
  const raw = String(key || fallback || '').trim();

  if (!raw) return null;
  if (raw.startsWith(SHORT_KEY_PREFIX)) return raw;
  if (raw.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${raw.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function getWeekMicrosBaseKey(weekKey) {
  const fromKeys = typeof KEYS.analyze?.weekMicros === 'function'
    ? KEYS.analyze.weekMicros(weekKey)
    : null;

  return shortKey(fromKeys, `ANALYZE:WEEK:${weekKey}:MICROS`);
}

function getWeekMicrosTopKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TOP`;
}

function getWeekMetaKey(weekKey) {
  return shortKey(
    typeof KEYS.analyze?.weekMeta === 'function'
      ? KEYS.analyze.weekMeta(weekKey)
      : null,
    `ANALYZE:WEEK:${weekKey}:META`
  );
}

function getWeekTradingCandidatesKey(weekKey) {
  return `${getWeekMicrosBaseKey(weekKey)}:TRADING_CANDIDATES`;
}

async function readJsonAny(key, fallback = null) {
  const volatile = getVolatileRedis();
  const durable = getDurableRedis();

  const v = await getJson(volatile, key, null).catch(() => null);
  if (v) return v;

  const d = await getJson(durable, key, null).catch(() => null);
  return d || fallback;
}

async function setJsonEverywhere(key, value) {
  const safeValue = jsonSafe(value);

  await setJson(getDurableRedis(), key, safeValue);
  await setJson(getVolatileRedis(), key, safeValue).catch(() => null);
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

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    scannerBucketsMetadataOnly: true,
    legacy25BucketsMetadataOnly: true,

    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    analyzeMicroFamiliesOnly: true,
    learningIdentitySource: 'ANALYZE_MICRO_MICRO_FAMILY',
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,
    child75ContextOnly: true,
    parent15ContextOnly: true,

    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: MICRO_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    learningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    microMicroEnabled: true,
    microMicroLearningEnabled: true,
    microMicroSelectionEnabled: true,
    microMicroVersion: MICRO_MICRO_VERSION,

    selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    microMicroSelectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
    discordMatch: 'candidate.microMicroFamilyId === selectedMicroMicroFamilyId',

    discordOnlyForSelectedMicroFamilies: false,
    discordOnlyForSelectedMicroMicroFamilies: true,
    discordOnlyForExactTrueMicroMatch: false,
    discordOnlyForExactMicroMicroMatch: true,

    parent15MatchTriggersDiscord: false,
    child75MatchTriggersDiscord: false,
    micro75MatchDoesNotTriggerDiscord: true,
    scannerMatchTriggersDiscord: false,

    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,

    completedDefinition: 'CLOSED_VIRTUAL_OR_SHADOW_OUTCOMES',
    scoringRSource: 'netR',
    winsLossesFlatsSource: 'netR',
    winrateDefinition: 'netR > 0',
    avgRSource: 'netR',
    totalRSource: 'netR',
    avgCostRShown: true,

    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: candle.low <= tp',
    slHitRule: 'SHORT: candle.high >= sl',
    sameCandleBothHitRule: 'CONSERVATIVE_SL_FIRST',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    weakContraEntryGateEnabled: true,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraRejectedBlocksVirtualEntry: true,
    weakContraRejectedBlocksLearning: false,

    positionTimeStopMinDefault: DEFAULT_POSITION_TIME_STOP_MIN,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    adaptiveUiVersion: ADAPTIVE_UI_VERSION,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };
}

function flags(row = {}) {
  return {
    ...modeFlags(),
    ...row
  };
}

function jsonSafe(value) {
  const seen = new WeakSet();

  return JSON.parse(JSON.stringify(value, (key, val) => {
    if (typeof val === 'bigint') return Number(val);

    if (val && typeof val === 'object') {
      if (seen.has(val)) return undefined;
      seen.add(val);
    }

    return val;
  }));
}

function parseShortTaxonomyMicroId(id = '') {
  const rawId = String(id || '').trim();
  const value = upper(rawId);

  if (!value.startsWith('MICRO_SHORT_')) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId
    };
  }

  let baseValue = value;
  let microMicroHash = null;

  const mm = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,24})$/u.exec(value);

  if (mm) {
    baseValue = mm[1];
    microMicroHash = mm[2].slice(0, MICRO_MICRO_HASH_LEN);
  }

  let body = baseValue.slice('MICRO_SHORT_'.length);
  let confirmationProfile = null;

  for (const p of CONFIRMATION_PROFILE_ORDER) {
    const suffix = `_${p}`;

    if (body.endsWith(suffix)) {
      confirmationProfile = p;
      body = body.slice(0, -suffix.length);
      break;
    }
  }

  let setup = null;
  let regime = null;

  for (const r of REGIME_ORDER) {
    const suffix = `_${r}`;

    if (body.endsWith(suffix)) {
      regime = r;
      setup = body.slice(0, -suffix.length);
      break;
    }
  }

  const parentId = setup && regime ? `MICRO_SHORT_${setup}_${regime}` : null;
  const childId = parentId && confirmationProfile ? `${parentId}_${confirmationProfile}` : null;

  const validParent = Boolean(parentId) && SETUPS.has(setup) && REGIMES.has(regime);
  const validChild = validParent && Boolean(confirmationProfile) && CONFIRMATIONS.has(confirmationProfile);
  const microMicroFamilyId = validChild && microMicroHash
    ? `${childId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`
    : null;

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
    base75ChildTrueMicroFamilyId: validChild ? childId : null,

    trueMicroFamilyId: validChild
      ? childId
      : validParent
        ? parentId
        : null,

    microFamilyId: validChild
      ? childId
      : validParent
        ? parentId
        : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    learningLayer: isMicroMicro
      ? LAYER_MICRO_MICRO
      : isChild
        ? LAYER_MICRO_75
        : isParent
          ? LAYER_PARENT_15
          : 'UNKNOWN'
  };
}

function isParentId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent;
}

function isChildId(id = '') {
  return parseShortTaxonomyMicroId(id).isChild;
}

function isMicroMicroId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro;
}

function isLearningId(id = '') {
  const p = parseShortTaxonomyMicroId(id);
  return p.isParent || p.isChild || p.isMicroMicro;
}

function childIdFrom(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);

  if (p.isMicroMicro || p.isChild) {
    return p.childTrueMicroFamilyId || '';
  }

  const direct = [
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.baseTrueMicroFamilyId,
    row.trueMicro75FamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.learningMicroFamilyId,
    row.learningFamilyId,
    row.analyzeMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId
  ]
    .map((x) => parseShortTaxonomyMicroId(x))
    .find((x) => x.isChild || x.isMicroMicro);

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

  const direct = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.selectedMicroMicroFamilyId,
    row.selectedTrueMicroMicroFamilyId,
    row.selectedExactMicroMicroFamilyId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId
  ]
    .map((x) => parseShortTaxonomyMicroId(x))
    .find((x) => x.isMicroMicro);

  if (direct) return direct.microMicroFamilyId;

  const child = childIdFrom(id, row);
  if (!child) return '';

  const hash = String(
    row.microMicroHash ||
      row.executionFingerprintHash ||
      row.executionHash ||
      ''
  )
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, MICRO_MICRO_HASH_LEN);

  if (hash.length >= 6) {
    return `${child}_${MICRO_MICRO_SUFFIX}_${hash}`;
  }

  const xr = /^(MICRO_SHORT_.+)_XR_([A-Z0-9]{6,24})$/u.exec(
    upper(row.executionMicroFamilyId || row.executionFingerprintMicroFamilyId || '')
  );

  if (xr) {
    return `${child}_${MICRO_MICRO_SUFFIX}_${xr[2].slice(0, MICRO_MICRO_HASH_LEN)}`;
  }

  return '';
}

function normalizeLearningFamilyId(id = '', row = {}) {
  const p = parseShortTaxonomyMicroId(id);

  if (p.isMicroMicro) return p.microMicroFamilyId;
  if (p.isChild) return p.childTrueMicroFamilyId;
  if (p.isParent) return p.parentTrueMicroFamilyId;

  const direct = [
    row.id,
    row.key,
    row.rowId,
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.parentTrueMicroFamilyId
  ];

  for (const candidate of direct) {
    const parsed = parseShortTaxonomyMicroId(candidate);

    if (parsed.isMicroMicro) return parsed.microMicroFamilyId;
    if (parsed.isChild) return parsed.childTrueMicroFamilyId;
    if (parsed.isParent) return parsed.parentTrueMicroFamilyId;
  }

  const mm = microMicroIdFrom(id, row);
  if (mm) return mm;

  const child = childIdFrom(id, row);
  if (child) return child;

  return parentIdFrom(id, row);
}

function rowIdentityId(row = {}) {
  const explicitMicroMicro = microMicroIdFrom(
    row.id ||
      row.key ||
      row.rowId ||
      row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId,
    row
  );

  if (explicitMicroMicro && isMicroMicroId(explicitMicroMicro)) {
    return explicitMicroMicro;
  }

  return normalizeLearningFamilyId(
    row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId ||
      row.id ||
      row.key ||
      row.rowId ||
      row.microFamilyId ||
      row.trueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.base75ChildTrueMicroFamilyId ||
      row.parentTrueMicroFamilyId,
    row
  );
}

function inferTradeSide(row = {}) {
  const direct = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.entrySide,
    row.analysisSide,
    row.scannerSide,
    row.actualScannerSide,
    row.side
  ]
    .map((x) => sideToTradeSide(upper(x)))
    .find((x) => x === TARGET_TRADE_SIDE || x === OPPOSITE_TRADE_SIDE);

  if (direct) return direct;

  const text = upper([
    row.learningFamilyId,
    row.learningMicroFamilyId,
    row.analyzeMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.definition,
    row.scannerReason,
    row.reason
  ].filter(Boolean).join('|'));

  if (text.includes('MICRO_SHORT') || text.includes('SHORT') || text.includes('BEAR')) return TARGET_TRADE_SIDE;
  if (text.includes('MICRO_LONG') || text.includes('LONG') || text.includes('BULL')) return OPPOSITE_TRADE_SIDE;

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;
  if (row.longOnly === true || row.shortDisabled === true) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShort(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function slimOutcome(row = {}) {
  if (!row || typeof row !== 'object') return row;

  const mm = microMicroIdFrom(
    row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId ||
      row.microFamilyId ||
      row.trueMicroFamilyId,
    row
  );

  const child = childIdFrom(mm || row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId, row);
  const parent = parentIdFrom(child || mm, row);
  const primaryId = mm || child || parent || null;

  return flags({
    type: row.type || 'OUTCOME',
    source: row.source || row.outcomeSource || 'VIRTUAL',
    outcomeSource: row.outcomeSource || row.source || 'VIRTUAL',

    symbol: row.symbol || null,
    contractSymbol: row.contractSymbol || null,
    tradeId: row.tradeId || null,
    positionId: row.positionId || null,

    entry: n(row.entry, 0),
    exit: n(row.exit ?? row.exitPrice, 0),
    exitPrice: n(row.exitPrice ?? row.exit, 0),
    exitReason: row.exitReason || row.reason || null,

    openedAt: row.openedAt || row.createdAt || null,
    closedAt: row.closedAt || row.completedAt || row.ts || null,
    completedAt: row.completedAt || row.closedAt || row.ts || null,

    netR: n(row.netR ?? row.exitR ?? row.realizedR ?? row.r, 0),
    shortNetR: n(row.shortNetR ?? row.netR ?? row.exitR ?? row.realizedR ?? row.r, 0),
    exitR: n(row.exitR ?? row.netR ?? row.realizedR ?? row.r, 0),
    realizedNetR: n(row.realizedNetR ?? row.netR ?? row.exitR ?? row.r, 0),
    realizedR: n(row.realizedR ?? row.netR ?? row.exitR ?? row.r, 0),
    r: n(row.r ?? row.netR ?? row.exitR ?? row.realizedR, 0),

    grossR: n(row.grossR ?? row.shortGrossR ?? row.rawR, 0),
    shortGrossR: n(row.shortGrossR ?? row.grossR ?? row.rawR, 0),
    rawR: n(row.rawR ?? row.grossR ?? row.shortGrossR, 0),

    costR: n(row.costR ?? row.avgCostR, 0),
    avgCostR: n(row.avgCostR ?? row.costR, 0),

    win: row.win === true || n(row.netR ?? row.exitR ?? row.realizedR ?? row.r, 0) > 0,
    loss: row.loss === true || n(row.netR ?? row.exitR ?? row.realizedR ?? row.r, 0) < 0,
    flat: row.flat === true || n(row.netR ?? row.exitR ?? row.realizedR ?? row.r, 0) === 0,

    directSL: Boolean(row.directSL || row.directToSL),
    directToSL: Boolean(row.directSL || row.directToSL),

    primaryLearningFamilyId: primaryId,
    primaryLearningIdentity: mm ? 'MICRO_MICRO' : child ? 'CHILD75_CONTEXT' : 'PARENT15_CONTEXT',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    learningFamilyId: primaryId,
    learningMicroFamilyId: primaryId,
    analyzeMicroFamilyId: primaryId,

    microFamilyId: primaryId,
    trueMicroFamilyId: primaryId,

    childTrueMicroFamilyId: child || null,
    base75ChildTrueMicroFamilyId: child || null,
    parentTrueMicroFamilyId: parent || null,

    microMicroFamilyId: mm || null,
    trueMicroMicroFamilyId: mm || null,
    exactMicroMicroFamilyId: mm || null,

    outcomeDedupeKey: row.outcomeDedupeKey || null,
    outcomeDedupeVersion: row.outcomeDedupeVersion || OUTCOME_DEDUPE_VERSION
  });
}

function sanitizeStatsRow(row = {}) {
  if (!row || typeof row !== 'object') return {};

  const clone = {
    ...row
  };

  delete clone.recordOutcomeResult;
  delete clone.openPositionDeleteResult;
  delete clone.discordExitAlertResult;
  delete clone.position;
  delete clone.outcome;
  delete clone.raw;
  delete clone.rawPosition;
  delete clone.rawOutcome;
  delete clone.rawSnapshot;
  delete clone.scannerSnapshot;
  delete clone.currentMarketUniverse;
  delete clone.entryMarketUniverse;
  delete clone.marketUniverseRows;
  delete clone.universeRows;

  clone.definitionParts = Array.isArray(row.definitionParts)
    ? row.definitionParts.slice(0, 64)
    : [];

  clone.parentDefinitionParts = Array.isArray(row.parentDefinitionParts)
    ? row.parentDefinitionParts.slice(0, 48)
    : [];

  clone.microMicroDefinitionParts = Array.isArray(row.microMicroDefinitionParts)
    ? row.microMicroDefinitionParts.slice(0, 64)
    : [];

  clone.executionFingerprintParts = Array.isArray(row.executionFingerprintParts)
    ? row.executionFingerprintParts.slice(0, 64)
    : [];

  clone.examples = Array.isArray(row.examples)
    ? row.examples.slice(-8).map((example) => (
      example && typeof example === 'object'
        ? {
          symbol: example.symbol || null,
          contractSymbol: example.contractSymbol || null,
          createdAt: example.createdAt || example.openedAt || null,
          source: example.source || 'VIRTUAL'
        }
        : example
    ))
    : [];

  clone.recentOutcomes = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes.slice(-40).map(slimOutcome)
    : [];

  return clone;
}

function safeRefreshStats(row = {}) {
  const safeRow = sanitizeStatsRow(row);

  try {
    return refreshStats(safeRow);
  } catch (error) {
    const outcomes = Array.isArray(safeRow.recentOutcomes)
      ? safeRow.recentOutcomes
      : [];

    let wins = n(safeRow.wins, 0);
    let losses = n(safeRow.losses, 0);
    let flats = n(safeRow.flats, 0);
    let totalR = n(safeRow.totalR, 0);
    let totalCostR = n(safeRow.totalCostR, 0);
    let directSLCount = n(safeRow.directSLCount, 0);

    if (outcomes.length) {
      wins = 0;
      losses = 0;
      flats = 0;
      totalR = 0;
      totalCostR = 0;
      directSLCount = 0;

      for (const outcome of outcomes) {
        const netR = n(outcome.netR ?? outcome.exitR ?? outcome.realizedR ?? outcome.r, 0);
        const costR = Math.max(0, n(outcome.costR ?? outcome.avgCostR, 0));

        totalR += netR;
        totalCostR += costR;

        if (netR > 0) wins += 1;
        else if (netR < 0) losses += 1;
        else flats += 1;

        if (outcome.directSL || outcome.directToSL) directSLCount += 1;
      }
    }

    const completed = Math.max(
      n(safeRow.completed, 0),
      n(safeRow.outcomeSample, 0),
      wins + losses + flats,
      outcomes.length
    );

    const avgR = completed > 0 ? totalR / completed : 0;
    const avgCostR = completed > 0 ? totalCostR / completed : 0;
    const winrate = completed > 0 ? wins / completed : 0;

    return {
      ...safeRow,
      refreshStatsFallbackUsed: true,
      refreshStatsFallbackReason: error?.message || String(error),

      wins,
      losses,
      flats,
      completed,
      outcomeSample: completed,

      totalR,
      avgR,
      winrate,

      totalCostR,
      avgCostR,

      directSLCount,
      directSLPct: completed > 0 ? directSLCount / completed : 0
    };
  }
}

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
  const explicit = [
    row.microMicroFamilyId,
    row.trueMicroMicroFamilyId,
    row.exactMicroMicroFamilyId,
    row.childTrueMicroFamilyId,
    row.base75ChildTrueMicroFamilyId,
    row.trueMicroFamilyId,
    row.microFamilyId,
    row.learningMicroFamilyId,
    row.learningFamilyId,
    row.analyzeMicroFamilyId,
    classified.trueMicroFamilyId,
    classified.microFamilyId,
    classified.childTrueMicroFamilyId,
    classified.microMicroFamilyId,
    classified.trueMicroMicroFamilyId,
    classified.exactMicroMicroFamilyId
  ]
    .map((x) => parseShortTaxonomyMicroId(x))
    .find((x) => x.isChild || x.isMicroMicro);

  if (explicit) {
    const child = explicit.childTrueMicroFamilyId;

    return {
      setup: explicit.setup,
      regime: explicit.regime,
      confirmation: explicit.confirmationProfile,
      parentId: explicit.parentTrueMicroFamilyId,
      childId: child
    };
  }

  const text = [
    row.setupType,
    row.setup,
    row.pattern,
    row.scannerReason,
    row.reason,
    row.definition,
    classified.setupType,
    classified.setup,
    classified.scannerReason,
    classified.definition
  ].filter(Boolean).join('|');

  const setup = normalizeSetup(text) || 'CONTINUATION';

  const regime = normalizeRegime(
    row.regimeBucket ||
      row.regime ||
      row.regimeCoarse ||
      row.marketRegime ||
      classified.regimeBucket ||
      classified.regime ||
      classified.regimeCoarse
  ) || 'TREND';

  const confluence = n(
    row.confluence ??
      row.sniperScore ??
      row.scannerScore ??
      row.moveScore ??
      classified.confluence ??
      classified.sniperScore,
    0
  );

  const confirmation = normalizeConfirmation(row.confirmationProfile || classified.confirmationProfile || text) ||
    (confluence >= 80
      ? 'A_STRONG_ALIGN'
      : confluence >= 65
        ? 'B_FLOW_ALIGN'
        : 'D_MIXED_OK');

  const parentId = `MICRO_SHORT_${setup}_${regime}`;

  return {
    setup,
    regime,
    confirmation,
    parentId,
    childId: `${parentId}_${confirmation}`
  };
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
    `CURRENT_FIT=${norm(row.currentFit || row.entryCurrentFit || 'NA')}`,
    `SCANNER=${norm(row.scannerReasonCoarse || row.scannerReason || row.reason || classified.scannerReason || 'NA')}`,
    `SPREAD=${norm(row.spreadBps ?? row.spreadPct ?? 'NA')}`,
    `DEPTH=${norm(row.depthMinUsd1p ?? 'NA')}`,
    `RR=${norm(row.rr ?? row.riskReward ?? 'NA')}`,
    `CONF=${norm(row.confluence ?? row.sniperScore ?? row.scannerScore ?? row.moveScore ?? 'NA')}`,
    `ENTRY_DIST=${norm(row.entryDistancePct ?? row.entryDistanceBps ?? 'NA')}`,
    `RISK=${norm(row.riskPct ?? row.slDistancePct ?? 'NA')}`,
    `REWARD=${norm(row.rewardPct ?? row.tpDistancePct ?? 'NA')}`,
    `FAKE=${row.fakeBreakout || row.fakeBreakoutRisk ? 'YES' : 'NO'}`,
    `WEAK_CONTRA_GATE=${WEAK_CONTRA_ENTRY_GATE_VERSION}`,
    `RISK_PLAN=${row.riskPlanVersion || SHORT_RISK_PLAN_VERSION}`,
    'SYMBOL_EXCLUDED=true',
    'COIN_EXCLUDED=true',
    'EXECUTION_FINGERPRINT_ROLE=MICRO_MICRO_HASH_SOURCE',
    'EXECUTION_FINGERPRINT_USED_AS_LEARNING_FAMILY=false'
  ];
}

function buildMicroMicroFromChildAndRow(child, row = {}) {
  const parsed = parseShortTaxonomyMicroId(child);

  if (!parsed.isChild) return '';

  const direct = microMicroIdFrom(
    row.microMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId,
    {
      ...row,
      childTrueMicroFamilyId: child
    }
  );

  if (direct && isMicroMicroId(direct)) return direct;

  const directHash = String(
    row.microMicroHash ||
      row.executionFingerprintHash ||
      row.executionHash ||
      ''
  )
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, MICRO_MICRO_HASH_LEN);

  if (directHash.length >= 6) {
    return `${child}_${MICRO_MICRO_SUFFIX}_${directHash}`;
  }

  const taxonomy = {
    setup: parsed.setup,
    regime: parsed.regime,
    confirmation: parsed.confirmationProfile,
    parentId: parsed.parentTrueMicroFamilyId,
    childId: child
  };

  const parts = Array.isArray(row.executionFingerprintParts) && row.executionFingerprintParts.length
    ? row.executionFingerprintParts
    : buildExecutionParts(row, {}, taxonomy);

  const hash = hashText(parts.join('|'), MICRO_MICRO_HASH_LEN);

  return `${child}_${MICRO_MICRO_SUFFIX}_${hash}`;
}

function spreadBps(row = {}) {
  if (finite(row.spreadBps)) return Math.abs(Number(row.spreadBps));

  if (finite(row.spreadPct)) {
    return Math.abs(Number(row.spreadPct)) * 10000;
  }

  return null;
}

function volumeExpansionScore(row = {}) {
  return Math.max(
    n(row.volumeExpansion, 0),
    n(row.relativeVolume, 0),
    n(row.relVolume, 0),
    n(row.volumeStrength, 0),
    n(row.volumeScore, 0) >= 100 ? n(row.volumeScore, 0) / 100 : n(row.volumeScore, 0)
  );
}

function hasBearishEntryBar(row = {}) {
  const text = upper([
    row.entryBar,
    row.entryBarDirection,
    row.entryCandle,
    row.entryCandleDirection,
    row.triggerCandle,
    row.triggerCandleDirection,
    row.breakCandle,
    row.breakCandleDirection,
    row.reason,
    row.scannerReason,
    row.entryReason
  ].filter(Boolean).join('|'));

  return Boolean(
    row.entryBarConfirmed ||
      row.entryCandleConfirmed ||
      row.triggerCandleConfirmed ||
      row.breakdownCandleConfirmed ||
      row.shortEntryConfirmed ||
      row.candleCloseBelowEntry ||
      row.closeBelowEntry ||
      row.closeBelowTrigger ||
      row.breakdownConfirmed ||
      row.retestConfirmed ||
      row.sweepConfirmed ||
      text.includes('BEAR') ||
      text.includes('SHORT') ||
      text.includes('SELL') ||
      text.includes('BREAKDOWN') ||
      text.includes('CLOSE_BELOW')
  );
}

function hasBearishFlow(row = {}) {
  const text = upper([
    row.flow,
    row.flowCoarse,
    row.orderFlow,
    row.marketFlow,
    row.obRelation,
    row.btcRelation,
    row.currentTrendSide,
    row.entryCurrentTrendSide,
    row.currentFit,
    row.entryCurrentFit,
    row.reason,
    row.scannerReason
  ].filter(Boolean).join('|'));

  const fitScore = n(row.currentFitScore ?? row.entryCurrentFitScore, 0);
  const fitConfidence = n(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0);

  return Boolean(
    row.flowAlign ||
      row.flowAligned ||
      row.bearFlow ||
      row.sellFlow ||
      row.askFlowAlign ||
      text.includes('WITH') ||
      text.includes('BEAR') ||
      text.includes('SHORT') ||
      text.includes('SELL') ||
      text.includes('MATCH') ||
      fitScore >= 20 ||
      fitConfidence >= 65
  );
}

function evaluateWeakContraEntryGate(row = {}, taxonomy = {}) {
  const confirmation = taxonomy.confirmation || row.confirmationProfile || '';
  const isWeakContra = confirmation === 'E_WEAK_CONTRA';

  const entryBarOk = hasBearishEntryBar(row);
  const flowOk = hasBearishFlow(row);

  const volume = volumeExpansionScore(row);
  const volumeOk = Boolean(
    row.volumeSpike ||
      row.volumeConfirmed ||
      row.volumeAlign ||
      row.volumeAligned ||
      row.volumeSpikeConfirmed ||
      row.quoteVolumeSpike ||
      row.obVolumeAlign ||
      volume >= 1.6
  );

  const bps = spreadBps(row);
  const spreadOk = bps === null || bps <= 15;

  const currentFit = upper(row.currentFit || row.entryCurrentFit || '');
  const currentFitOk =
    currentFit.includes('MATCH') ||
    n(row.currentFitScore ?? row.entryCurrentFitScore, 0) >= 20 ||
    n(row.currentFitConfidence ?? row.entryCurrentFitConfidence, 0) >= 60;

  const extraConfirmationOk = volumeOk || currentFitOk;
  const strictEntryOk = entryBarOk && flowOk && extraConfirmationOk && spreadOk;

  if (!isWeakContra) {
    return {
      version: WEAK_CONTRA_ENTRY_GATE_VERSION,
      enabled: true,
      isWeakContra: false,
      ok: true,
      rejected: false,
      reason: 'NOT_E_WEAK_CONTRA',
      entryBarOk,
      flowOk,
      volumeOk,
      currentFitOk,
      spreadOk,
      blocksVirtualEntry: false,
      blocksLearning: false
    };
  }

  return {
    version: WEAK_CONTRA_ENTRY_GATE_VERSION,
    enabled: true,
    isWeakContra: true,
    ok: strictEntryOk,
    rejected: !strictEntryOk,
    reason: strictEntryOk
      ? 'E_WEAK_CONTRA_STRICT_ENTRY_GATE_OK'
      : 'E_WEAK_CONTRA_STRICT_ENTRY_GATE_FAILED',
    entryBarOk,
    flowOk,
    volumeOk,
    currentFitOk,
    spreadOk,
    spreadBps: bps,
    volumeExpansion: volume,
    blocksVirtualEntry: !strictEntryOk,
    blocksLearning: false
  };
}

function enrichWithMicroFamily(row = {}) {
  if (!isShort(row)) return null;

  let macro = {};
  let micro = {};

  try {
    macro = classifyMacroFamily(row) || {};
  } catch {
    // Fallback taxonomy below.
  }

  try {
    micro = classifyMicroFamily(row) || {};
  } catch {
    // Fallback taxonomy below.
  }

  const classified = {
    ...macro,
    ...micro
  };

  const taxonomy = classifyTaxonomy(row, classified);
  const weakContraEntryGate = evaluateWeakContraEntryGate(row, taxonomy);

  const executionParts = buildExecutionParts(row, classified, taxonomy);
  const executionHash = hashText(executionParts.join('|'), EXECUTION_MICRO_HASH_LEN);
  const microMicroId =
    microMicroIdFrom(row.microMicroFamilyId, {
      ...row,
      childTrueMicroFamilyId: taxonomy.childId,
      executionFingerprintHash: executionHash
    }) || `${taxonomy.childId}_${MICRO_MICRO_SUFFIX}_${executionHash.slice(0, MICRO_MICRO_HASH_LEN)}`;

  const microMicroParts = [
    ...executionParts,
    `MICRO_MICRO=${microMicroId}`,
    `MICRO_MICRO_HASH=${executionHash}`,
    `LAYER=${LAYER_MICRO_MICRO}`,
    `WEAK_CONTRA_GATE_OK=${weakContraEntryGate.ok ? 'YES' : 'NO'}`
  ];

  return flags({
    ...row,

    familyId: microMicroId,
    learningFamilyId: microMicroId,
    learningMicroFamilyId: microMicroId,
    analyzeMicroFamilyId: microMicroId,
    primaryLearningFamilyId: microMicroId,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    microFamilyId: microMicroId,
    trueMicroFamilyId: microMicroId,

    childTrueMicroFamilyId: taxonomy.childId,
    base75ChildTrueMicroFamilyId: taxonomy.childId,
    child75ContextFamilyId: taxonomy.childId,

    parentTrueMicroFamilyId: taxonomy.parentId,
    coarseMicroFamilyId: taxonomy.parentId,
    baseMicroFamilyId: taxonomy.parentId,
    legacyMicroFamilyId: taxonomy.parentId,
    parentMicroFamilyId: taxonomy.parentId,
    macroFamilyId: taxonomy.parentId,
    parentMacroFamilyId: taxonomy.parentId,
    parent15ContextFamilyId: taxonomy.parentId,

    microMicroFamilyId: microMicroId,
    trueMicroMicroFamilyId: microMicroId,
    exactMicroMicroFamilyId: microMicroId,
    microMicroHash: executionHash.slice(0, MICRO_MICRO_HASH_LEN),

    setupType: taxonomy.setup,
    regimeBucket: taxonomy.regime,
    confirmationProfile: taxonomy.confirmation,

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `PRIMARY_LEARNING=${microMicroId}`,
      `TRUE_MICRO=${taxonomy.childId}`,
      `PARENT_TRUE_MICRO=${taxonomy.parentId}`,
      `SETUP=${taxonomy.setup}`,
      `REGIME_BUCKET=${taxonomy.regime}`,
      `CONFIRMATION_PROFILE=${taxonomy.confirmation}`,
      `MEASUREMENT_FIX=${MEASUREMENT_FIX_VERSION}`
    ],
    parentDefinitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `PARENT_TRUE_MICRO=${taxonomy.parentId}`,
      `SETUP=${taxonomy.setup}`,
      `REGIME_BUCKET=${taxonomy.regime}`,
      `LAYER=${LAYER_PARENT_15}`
    ],
    microMicroDefinitionParts: microMicroParts,

    executionFingerprintHash: executionHash.slice(0, EXECUTION_MICRO_HASH_LEN),
    executionFingerprintParts: executionParts,
    executionMicroFamilyId: `${taxonomy.childId}_${EXECUTION_MICRO_SUFFIX}_${executionHash.slice(0, EXECUTION_MICRO_HASH_LEN)}`,
    executionFingerprintRole: 'MICRO_MICRO_IDENTITY_HASH_SOURCE',
    executionFingerprintsMetadataOnly: false,
    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true,

    scannerMicroFamilyId: row.scannerMicroFamilyId || null,
    scannerFamilyId: row.scannerFamilyId || null,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    weakContraEntryGate,
    weakContraEntryGateVersion: WEAK_CONTRA_ENTRY_GATE_VERSION,
    weakContraRejected: Boolean(weakContraEntryGate.rejected),
    weakContraAllowed: Boolean(weakContraEntryGate.ok),
    weakContraRejectReason: weakContraEntryGate.rejected ? weakContraEntryGate.reason : null,
    blockVirtualEntry: Boolean(weakContraEntryGate.blocksVirtualEntry),
    blockVirtualEntryReason: weakContraEntryGate.blocksVirtualEntry ? weakContraEntryGate.reason : null,
    weakContraRejectedBlocksLearning: false,
    weakContraRejectedBlocksVirtualEntry: true,

    microMicroSelectionAllowed: true,
    exactMicroMicro: true,
    selectableLearningId: microMicroId,
    selectableMicroMicroFamilyId: microMicroId,

    riskPlanVersion: row.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    costModelVersion: COST_MODEL_VERSION
  });
}

function layerFor(id = '') {
  return parseShortTaxonomyMicroId(id).learningLayer || 'UNKNOWN';
}

function granularityFor(id = '') {
  const layer = layerFor(id);

  if (layer === LAYER_MICRO_MICRO) return MICRO_MICRO_LEARNING_GRANULARITY;
  if (layer === LAYER_PARENT_15) return PARENT_LEARNING_GRANULARITY;

  return LEARNING_GRANULARITY;
}

function schemaFor(id = '') {
  const layer = layerFor(id);

  if (layer === LAYER_MICRO_MICRO) return MICRO_MICRO_SCHEMA;
  if (layer === LAYER_PARENT_15) return PARENT_TRUE_MICRO_SCHEMA;

  return TRUE_MICRO_SCHEMA;
}

function minCompletedFor(id = '') {
  return layerFor(id) === LAYER_MICRO_MICRO
    ? MIN_COMPLETED_MICRO_MICRO_ACTIVE
    : MIN_COMPLETED_ACTIVE_LEARNING;
}

function statusFor(row = {}) {
  const completed = n(row.completed ?? row.outcomeSample, 0);
  const min = n(row.minCompletedForActiveLearning, MIN_COMPLETED_ACTIVE_LEARNING);

  if (completed >= min) return 'ACTIVE_LEARNING';
  if (completed > 0) return 'EARLY_OUTCOMES';

  return 'OBSERVING';
}

function applyLayerIdentity(row = {}, id = '') {
  const learningId = normalizeLearningFamilyId(id, row);
  const parsed = parseShortTaxonomyMicroId(learningId);

  if (!parsed.valid) return null;

  const isMicroMicro = parsed.isMicroMicro;
  const isChild = parsed.isChild;
  const isParent = parsed.isParent;

  const child = parsed.childTrueMicroFamilyId || childIdFrom(learningId, row);
  const parent = parsed.parentTrueMicroFamilyId || parentIdFrom(learningId, row);
  const mm = isMicroMicro
    ? parsed.microMicroFamilyId
    : null;

  const layer = parsed.learningLayer;
  const minCompleted = minCompletedFor(learningId);
  const layerSchema = schemaFor(learningId);
  const primaryId = isMicroMicro ? mm : learningId;

  return flags({
    ...sanitizeStatsRow(row),

    id: learningId,
    key: learningId,
    rowId: learningId,

    learningFamilyId: learningId,
    learningMicroFamilyId: learningId,
    analyzeMicroFamilyId: learningId,
    primaryLearningFamilyId: primaryId,
    primaryLearningIdentity: isMicroMicro
      ? 'MICRO_MICRO'
      : isChild
        ? 'CHILD75_CONTEXT'
        : 'PARENT15_CONTEXT',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    // Belangrijk:
    // - MM-row: microFamilyId/trueMicroFamilyId zijn exact de MM-id.
    // - Child75 blijft alleen childTrueMicroFamilyId/base75ChildTrueMicroFamilyId.
    // - Parent15 blijft alleen context/rollup.
    microFamilyId: primaryId,
    trueMicroFamilyId: primaryId,

    childTrueMicroFamilyId: child || null,
    base75ChildTrueMicroFamilyId: child || null,
    child75ContextFamilyId: child || null,

    parentTrueMicroFamilyId: parent || null,
    parent15ContextFamilyId: parent || null,

    coarseMicroFamilyId: parent || null,
    baseMicroFamilyId: parent || null,
    legacyMicroFamilyId: parent || null,
    parentMicroFamilyId: parent || null,
    macroFamilyId: parent || null,
    parentMacroFamilyId: parent || null,

    microMicroFamilyId: mm,
    trueMicroMicroFamilyId: mm,
    exactMicroMicroFamilyId: mm,
    microMicroHash: isMicroMicro
      ? parsed.microMicroHash || row.microMicroHash || row.executionFingerprintHash || null
      : null,

    relatedMicroMicroFamilyId: isMicroMicro
      ? mm
      : buildMicroMicroFromChildAndRow(child, row) || null,

    setupType: parsed.setup || row.setupType || null,
    regimeBucket: parsed.regime || row.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || row.confirmationProfile || null,

    schema: layerSchema,
    microFamilySchema: layerSchema,
    trueMicroFamilySchema: layerSchema,
    exactTrueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,

    learningGranularity: granularityFor(learningId),
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    child75LearningGranularity: CHILD75_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    learningLayer: layer,
    layer,

    isParent15Row: isParent,
    isChild75Row: isChild,
    isMicroMicroRow: isMicroMicro,

    selectable: isMicroMicro,
    uiVisible: isMicroMicro,
    adminVisible: isMicroMicro,
    hiddenInAdmin: !isMicroMicro,

    microMicroSelectionAllowed: isMicroMicro,
    micro75SelectionAllowed: false,
    parentSelectionAllowed: false,

    parentContextOnly: isParent,
    child75ContextOnly: isChild,
    parent15RowsHiddenInAdmin: isParent,
    child75RowsHiddenInAdmin: isChild,

    selectionGranularity: isMicroMicro
      ? 'EXACT_MICRO_MICRO_ONLY'
      : 'CONTEXT_ONLY_NOT_SELECTABLE',

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

    minCompletedForActiveLearning: minCompleted,
    microMicroActiveThreshold: MIN_COMPLETED_MICRO_MICRO_ACTIVE,
    child75PrimaryThresholdBackend: MIN_COMPLETED_ACTIVE_LEARNING,

    status: statusFor({
      ...row,
      minCompletedForActiveLearning: minCompleted
    }),
    learningStatus: statusFor({
      ...row,
      minCompletedForActiveLearning: minCompleted
    }),

    executionFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsCanDeriveMicroMicroContextHash: true
  });
}

function compactMicro(row = {}) {
  const id = rowIdentityId(row);

  if (!id) return null;

  const baseLayered = applyLayerIdentity(
    {
      ...sanitizeStatsRow(row),
      id,
      key: id,
      rowId: id,
      learningFamilyId: id,
      learningMicroFamilyId: id,
      analyzeMicroFamilyId: id
    },
    id
  );

  if (!baseLayered) return null;

  const refreshed = safeRefreshStats(baseLayered);
  const layered = applyLayerIdentity(
    {
      ...refreshed,
      id,
      key: id,
      rowId: id,
      learningFamilyId: id,
      learningMicroFamilyId: id,
      analyzeMicroFamilyId: id
    },
    id
  );

  if (!layered) return null;

  const min = minCompletedFor(id);
  const completed = n(layered.completed, 0);
  const status = completed >= min
    ? 'ACTIVE_LEARNING'
    : completed > 0
      ? 'EARLY_OUTCOMES'
      : 'OBSERVING';

  return flags({
    ...layered,

    definitionParts: Array.isArray(layered.definitionParts)
      ? layered.definitionParts.slice(0, 64)
      : [],
    parentDefinitionParts: Array.isArray(layered.parentDefinitionParts)
      ? layered.parentDefinitionParts.slice(0, 48)
      : [],
    microMicroDefinitionParts: Array.isArray(layered.microMicroDefinitionParts)
      ? layered.microMicroDefinitionParts.slice(0, 64)
      : [],

    examples: Array.isArray(layered.examples)
      ? layered.examples.slice(-8)
      : [],
    recentOutcomes: Array.isArray(layered.recentOutcomes)
      ? layered.recentOutcomes.slice(-40).map(slimOutcome)
      : [],

    minCompletedForActiveLearning: min,
    status,
    learningStatus: status,
    tooEarly: completed < min,
    tooEarlyReason: completed < min ? `completed ${completed}/${min}` : null
  });
}

function extractMicrosPayload(raw = {}) {
  if (!raw) return {};
  if (Array.isArray(raw)) return raw;

  if (raw.rows && typeof raw.rows === 'object') return raw.rows;
  if (raw.micros && typeof raw.micros === 'object') return raw.micros;
  if (raw.microFamilies && typeof raw.microFamilies === 'object' && !Number.isFinite(Number(raw.microFamilies))) {
    return raw.microFamilies;
  }

  return raw;
}

function normalizeMicros(micros = {}) {
  const input = extractMicrosPayload(micros);
  const entries = Array.isArray(input)
    ? input.map((row, index) => [String(row?.id || row?.key || row?.rowId || index), row])
    : Object.entries(input || {});

  const out = {};

  for (const [key, row] of entries) {
    try {
      if (!row || typeof row !== 'object') continue;

      const id = rowIdentityId({
        ...row,
        key: row.key || key
      });

      if (!id) continue;

      const compact = compactMicro({
        ...row,
        id,
        key: id,
        rowId: id,
        learningFamilyId: id,
        learningMicroFamilyId: id,
        analyzeMicroFamilyId: id
      });

      if (compact && isShort(compact)) {
        out[id] = compact;
      }
    } catch {
      // Skip corrupt row instead of killing the endpoint.
    }
  }

  return out;
}

function compareRows(a = {}, b = {}) {
  const ar = safeRefreshStats(a);
  const br = safeRefreshStats(b);

  const layerScore = (x) => {
    const id = rowIdentityId(x);
    const layer = layerFor(id);

    if (layer === LAYER_MICRO_MICRO) return 2;
    if (layer === LAYER_MICRO_75) return 1;

    return 0;
  };

  const eligible = (x) => Number(
    x.tradingEligible === true ||
      x.eligible === true ||
      x.eligibleGatePassed === true ||
      x.discordActivationEligible === true
  );

  return eligible(br) - eligible(ar) ||
    layerScore(br) - layerScore(ar) ||
    n(br.avgRLCB95 ?? br.lcb95AvgR, 0) - n(ar.avgRLCB95 ?? ar.lcb95AvgR, 0) ||
    n(br.totalR, 0) - n(ar.totalR, 0) ||
    n(br.avgR, 0) - n(ar.avgR, 0) ||
    n(br.completed, 0) - n(ar.completed, 0) ||
    String(ar.learningMicroFamilyId || ar.id || '').localeCompare(String(br.learningMicroFamilyId || br.id || ''));
}

function topObject(micros = {}, limit = 300) {
  return Object.fromEntries(
    Object.values(normalizeMicros(micros))
      .filter((row) => {
        const id = rowIdentityId(row);
        return isChildId(id) || isMicroMicroId(id);
      })
      .sort(compareRows)
      .slice(0, limit)
      .map((row) => [rowIdentityId(row), row])
  );
}

export async function getWeekMicros(weekKey = PERSISTENT_LEARNING_KEY) {
  const raw = await readJsonAny(getWeekMicrosBaseKey(weekKey), null).catch(() => null);

  if (raw) {
    const normalized = normalizeMicros(extractMicrosPayload(raw));

    if (Object.keys(normalized).length) {
      return normalized;
    }
  }

  const topRaw = await readJsonAny(getWeekMicrosTopKey(weekKey), null).catch(() => null);

  if (topRaw) {
    const topNormalized = normalizeMicros(extractMicrosPayload(topRaw));

    if (Object.keys(topNormalized).length) {
      return topNormalized;
    }
  }

  return {};
}

export async function getWeekTopMicros(weekKey = PERSISTENT_LEARNING_KEY, { limit = 25 } = {}) {
  const raw = await readJsonAny(getWeekMicrosTopKey(weekKey), null).catch(() => null);

  if (raw?.rows && Object.keys(raw.rows).length) {
    return topObject(raw.rows, limit);
  }

  return topObject(await getWeekMicros(weekKey), limit);
}

export async function getWeekMicrosByIds(weekKey, ids = []) {
  const micros = await getWeekMicros(weekKey);

  return Object.fromEntries(
    uniq(ids)
      .map((id) => normalizeLearningFamilyId(id))
      .filter((id) => id && micros[id])
      .map((id) => [id, micros[id]])
  );
}

export async function saveWeekMicros(weekKey, micros, { onlyIds = null, allowEmptyFullSave = false } = {}) {
  if (!weekKey) throw new Error('WEEK_KEY_MISSING');

  const existing = onlyIds
    ? await getWeekMicros(weekKey).catch(() => ({}))
    : {};

  const clean = normalizeMicros({
    ...(existing || {}),
    ...(micros || {})
  });

  const ids = Object.keys(clean);

  if (!ids.length && !allowEmptyFullSave) {
    return existing || {};
  }

  const layerCounts = Object.values(clean).reduce((acc, row) => {
    const id = rowIdentityId(row);
    const layer = layerFor(id);

    acc.total += 1;
    if (layer === LAYER_PARENT_15) acc.parent15 += 1;
    if (layer === LAYER_MICRO_75) acc.micro75 += 1;
    if (layer === LAYER_MICRO_MICRO) acc.microMicro += 1;

    return acc;
  }, {
    total: 0,
    parent15: 0,
    micro75: 0,
    microMicro: 0
  });

  const common = flags({
    weekKey,
    updatedAt: now(),
    layerCounts,
    count: ids.length,
    rowsAreLayered: true,

    sourceMicroMicroRows: layerCounts.microMicro,
    sourceChild75Rows: layerCounts.micro75,
    sourceParent15Rows: layerCounts.parent15,

    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    trueMicroMicroFamilySchema: TRUE_MICRO_MICRO_SCHEMA,
    microMicroVersion: MICRO_MICRO_VERSION,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_ID',
    discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY'
  });

  const payload = {
    ...common,
    rows: clean,
    microFamilies: ids.length,
    storageMode: 'LAYERED_PARENT_CHILD_MICRO_MICRO_ROWS_MICRO_MICRO_PRIMARY',
    uiShowsOnlyMicroMicro: true,
    uiAllowsOnlyMicroMicroSelection: true
  };

  const topRows = topObject(clean, 300);
  const candidates = scoreWeeklyTradingCandidates(clean, {
    requireCurrentFitMatch: false,
    currentFitLookup: currentFitLookupFromStoredRow
  }).filter((row) => layerFor(rowIdentityId(row)) === LAYER_MICRO_MICRO);

  await setJsonEverywhere(getWeekMicrosBaseKey(weekKey), payload);

  await setJsonEverywhere(getWeekMicrosTopKey(weekKey), {
    ...common,
    rows: topRows,
    count: Object.keys(topRows).length,
    storageMode: 'TOP_MICROS_AND_MICRO_MICROS_SNAPSHOT_MICRO_MICRO_PRIMARY'
  });

  await setJsonEverywhere(getWeekTradingCandidatesKey(weekKey), {
    ...common,
    rows: Object.fromEntries(
      candidates.map((row) => [rowIdentityId(row), row])
    ),
    count: candidates.length,
    storageMode: 'ELIGIBLE_LIFETIME_LCB_MICRO_MICRO_CANDIDATES_PREVIEW'
  });

  await setJsonEverywhere(getWeekMetaKey(weekKey), {
    ...common,
    microFamilies: ids.length,
    tradingCandidatesPreview: candidates.length
  });

  return clean;
}

function getOrCreateMicro(micros, classified, learningId) {
  const id = normalizeLearningFamilyId(learningId, classified);

  if (!id) throw new Error('LEARNING_FAMILY_ID_REQUIRED');

  const parsed = parseShortTaxonomyMicroId(id);
  const child = parsed.childTrueMicroFamilyId || childIdFrom(id, classified);
  const parent = parsed.parentTrueMicroFamilyId || parentIdFrom(id, classified);
  const mm = parsed.isMicroMicro ? parsed.microMicroFamilyId : null;
  const primaryId = parsed.isMicroMicro ? mm : id;

  if (!micros[id]) {
    micros[id] = createMicroStats({
      id,
      key: id,
      rowId: id,

      microFamilyId: primaryId,
      trueMicroFamilyId: primaryId,

      learningMicroFamilyId: id,
      learningFamilyId: id,
      analyzeMicroFamilyId: id,
      primaryLearningFamilyId: primaryId,
      primaryLearningIdentity: parsed.isMicroMicro
        ? 'MICRO_MICRO'
        : parsed.isChild
          ? 'CHILD75_CONTEXT'
          : 'PARENT15_CONTEXT',
      primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

      familyId: primaryId,
      childTrueMicroFamilyId: child || null,
      base75ChildTrueMicroFamilyId: child || null,
      child75ContextFamilyId: child || null,
      parentTrueMicroFamilyId: parent || null,
      parent15ContextFamilyId: parent || null,

      microMicroFamilyId: mm,
      trueMicroMicroFamilyId: mm,
      exactMicroMicroFamilyId: mm,

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      definitionParts: classified.definitionParts || []
    });
  }

  const layered = applyLayerIdentity({
    ...classified,
    ...sanitizeStatsRow(micros[id]),
    id,
    key: id,
    rowId: id,
    learningFamilyId: id,
    learningMicroFamilyId: id,
    analyzeMicroFamilyId: id
  }, id);

  Object.assign(micros[id], layered);

  return micros[id];
}

function obsKey(snapshotId, symbol, learningId, entry = 0) {
  const base = typeof KEYS.analyze?.obsLast === 'function'
    ? KEYS.analyze.obsLast(snapshotId, symbol, learningId)
    : null;

  return `${shortKey(base, `ANALYZE:OBS_LAST:${snapshotId}:${symbol}:${learningId}`)}:ENTRY:${n(entry, 0).toFixed(8)}`;
}

function outcomeKey(weekKey, identity, learningId) {
  const base = typeof KEYS.analyze?.outcomeLast === 'function'
    ? KEYS.analyze.outcomeLast(weekKey, identity, learningId)
    : null;

  return shortKey(base, `ANALYZE:OUTCOME_LAST:${weekKey}:${identity}:${learningId}`);
}

async function claim(redis, key, ttlSec, type) {
  const value = String(now());

  for (const opts of [{ ex: ttlSec, nx: true }, { EX: ttlSec, NX: true }]) {
    try {
      const res = await redis.set(key, value, opts);

      if (res === null || res === false) {
        return {
          claimed: false,
          duplicate: true,
          method: 'SET_NX',
          key,
          type
        };
      }

      if (res === true || res === 1 || String(res).toUpperCase() === 'OK') {
        return {
          claimed: true,
          duplicate: false,
          method: 'SET_NX',
          key,
          type
        };
      }
    } catch {
      // Try next syntax.
    }
  }

  const existing = await redis.get(key).catch(() => null);

  if (existing !== null && existing !== undefined) {
    return {
      claimed: false,
      duplicate: true,
      method: 'GET_THEN_SET',
      key,
      type
    };
  }

  await redis.set(key, value, { ex: ttlSec }).catch(() => null);

  return {
    claimed: true,
    duplicate: false,
    method: 'GET_THEN_SET',
    key,
    type
  };
}

function obsTtl() {
  return Math.max(60, Math.floor(n(CONFIG?.analyze?.obsDedupeTtlSec, 86400)));
}

function outcomeTtl() {
  return Math.max(60, Math.floor(n(CONFIG?.analyze?.outcomeDedupeTtlSec, 86400 * 14)));
}

export async function analyzeCandidatesBatch(metricsRows = [], { weekKey = PERSISTENT_LEARNING_KEY } = {}) {
  const input = Array.isArray(metricsRows)
    ? metricsRows.filter(Boolean).filter(isShort)
    : [];

  if (!input.length) return [];

  const rows = input.map(enrichWithMicroFamily).filter(Boolean);
  if (!rows.length) return [];

  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);

  const touched = new Set();
  const analyzed = [];

  for (const row of rows) {
    const child = childIdFrom(row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId, row);
    const parent = parentIdFrom(child, row);
    const mm = buildMicroMicroFromChildAndRow(child, row);
    const ids = uniq([parent, child, mm]).filter(isLearningId);

    const snapshotId = String(
      row.snapshotId ||
        row.scanSnapshotId ||
        row.scannerSnapshotId ||
        row.runId ||
        'NO_SNAPSHOT'
    );

    const symbol = upper(row.symbol || row.contractSymbol || row.baseSymbol || 'UNKNOWN');
    const entry = n(row.entry || row.entryPrice || row.price, 0);
    const results = [];

    for (const id of ids) {
      const key = obsKey(snapshotId, symbol, id, entry);
      const c = await claim(redis, key, obsTtl(), `OBSERVATION:${layerFor(id)}`);
      const recorded = c.claimed && !c.duplicate;

      results.push({
        id,
        key,
        claim: c,
        recorded
      });

      if (!recorded) continue;

      const layerRow = applyLayerIdentity({
        ...row,
        childTrueMicroFamilyId: child,
        base75ChildTrueMicroFamilyId: child,
        child75ContextFamilyId: child,
        parentTrueMicroFamilyId: parent,
        parent15ContextFamilyId: parent,
        microMicroFamilyId: mm,
        trueMicroMicroFamilyId: mm,
        exactMicroMicroFamilyId: mm,
        relatedMicroMicroFamilyId: mm,
        source: 'VIRTUAL',
        weekKey
      }, id);

      const micro = getOrCreateMicro(micros, layerRow, id);

      updateObservation(
        micro,
        flags({
          ...layerRow,
          source: 'VIRTUAL',
          weekKey,
          observationDedupeKey: key,
          observationDedupeMethod: c.method,
          observationDedupeVersion: OBSERVATION_DEDUPE_VERSION,
          observationRecorded: true,
          observationCounted: true,
          countObservation: true,
          createdAt: row.createdAt || now()
        })
      );

      Object.assign(
        micro,
        applyLayerIdentity(
          safeRefreshStats(micro),
          id
        )
      );

      touched.add(id);
    }

    const chosen = results.find((x) => x.id === mm) ||
      results.find((x) => x.id === child) ||
      results[0];

    analyzed.push(flags({
      ...row,

      learningFamilyId: mm,
      learningMicroFamilyId: mm,
      analyzeMicroFamilyId: mm,
      primaryLearningFamilyId: mm,
      primaryLearningIdentity: 'MICRO_MICRO',
      primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

      trueMicroFamilyId: mm,
      microFamilyId: mm,
      childTrueMicroFamilyId: child,
      base75ChildTrueMicroFamilyId: child,
      child75ContextFamilyId: child,
      parentTrueMicroFamilyId: parent,
      parent15ContextFamilyId: parent,

      microMicroFamilyId: mm,
      trueMicroMicroFamilyId: mm,
      exactMicroMicroFamilyId: mm,
      microMicroHash: parseShortTaxonomyMicroId(mm).microMicroHash || row.microMicroHash || row.executionFingerprintHash || null,

      learningIds: ids,
      parentLearningId: parent,
      childLearningId: child,
      microMicroLearningId: mm,

      exactMicroMicro: Boolean(mm),
      microMicroSelectionAllowed: Boolean(mm),
      selectableLearningId: mm,
      selectableMicroMicroFamilyId: mm,

      weakContraEntryGate: row.weakContraEntryGate || evaluateWeakContraEntryGate(row, {
        confirmation: row.confirmationProfile
      }),
      weakContraRejected: Boolean(row.weakContraRejected),
      weakContraAllowed: Boolean(row.weakContraAllowed),
      weakContraRejectReason: row.weakContraRejectReason || null,
      blockVirtualEntry: Boolean(row.blockVirtualEntry),
      blockVirtualEntryReason: row.blockVirtualEntryReason || null,
      weakContraRejectedBlocksLearning: false,

      observationRecorded: results.some((x) => x.recorded),
      observationDuplicate: !results.some((x) => x.recorded) && results.some((x) => x.claim?.duplicate),
      observationDedupeKey: chosen?.key || null,
      observationDedupeMethod: chosen?.claim?.method || null,
      observationDedupeVersion: OBSERVATION_DEDUPE_VERSION
    }));
  }

  if (touched.size) {
    await saveWeekMicros(weekKey, micros, {
      onlyIds: [...touched]
    });
  }

  return analyzed;
}

function calcRiskPct({ entry, sl }) {
  return entry > 0 && sl > 0 ? Math.abs(entry - sl) / entry : 0;
}

function calcShortGrossR({ entry, initialSl, exit }) {
  const distance = initialSl - entry;
  return entry > 0 && exit > 0 && distance > 0 ? (entry - exit) / distance : 0;
}

function grossMovePct(entry, exit) {
  return entry > 0 && exit > 0 ? (entry - exit) / entry : 0;
}

function isDirectSL(position = {}, reason = '') {
  const raw = upper(reason);

  return Boolean(
    position.directToSL ||
      position.directSL ||
      (raw.includes('SL') && !position.nearTpSeen && !position.reachedHalfR && !position.reachedOneR)
  );
}

function stableOutcomeIdentity(outcome = {}, child = '') {
  const mm = microMicroIdFrom(
    outcome.microMicroFamilyId ||
      outcome.trueMicroMicroFamilyId ||
      outcome.exactMicroMicroFamilyId,
    outcome
  );

  const raw = [
    TARGET_TRADE_SIDE,
    outcome.tradeId || outcome.positionId || '',
    outcome.symbol || outcome.contractSymbol || 'UNKNOWN',
    outcome.openedAt || outcome.createdAt || 'NO_OPEN',
    outcome.closedAt || outcome.completedAt || outcome.ts || 'NO_CLOSE',
    outcome.exitReason || outcome.reason || 'NO_REASON',
    n(outcome.exit ?? outcome.exitPrice, 0).toFixed(8),
    child,
    mm
  ].join('|');

  return hashText(raw, 24);
}

function hasMicroIds(row = {}) {
  return Boolean(childIdFrom(
    row.childTrueMicroFamilyId ||
      row.base75ChildTrueMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      row.learningFamilyId ||
      row.learningMicroFamilyId ||
      row.analyzeMicroFamilyId ||
      row.microMicroFamilyId,
    row
  ));
}

function ensureOutcomeIds(outcome = {}) {
  const enriched = hasMicroIds(outcome)
    ? flags(outcome)
    : enrichWithMicroFamily(outcome);

  if (!enriched) return null;

  const child = childIdFrom(
    enriched.childTrueMicroFamilyId ||
      enriched.base75ChildTrueMicroFamilyId ||
      enriched.trueMicroFamilyId ||
      enriched.microFamilyId ||
      enriched.learningFamilyId ||
      enriched.learningMicroFamilyId ||
      enriched.analyzeMicroFamilyId ||
      enriched.microMicroFamilyId,
    enriched
  );

  const parent = parentIdFrom(child, enriched);
  const mm = buildMicroMicroFromChildAndRow(child, enriched);

  if (!child || !parent || !mm) return null;

  return flags({
    ...enriched,

    learningFamilyId: mm,
    learningMicroFamilyId: mm,
    analyzeMicroFamilyId: mm,
    primaryLearningFamilyId: mm,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    trueMicroFamilyId: mm,
    microFamilyId: mm,

    childTrueMicroFamilyId: child,
    base75ChildTrueMicroFamilyId: child,
    child75ContextFamilyId: child,

    parentTrueMicroFamilyId: parent,
    parent15ContextFamilyId: parent,
    coarseMicroFamilyId: parent,
    baseMicroFamilyId: parent,
    legacyMicroFamilyId: parent,

    microMicroFamilyId: mm,
    trueMicroMicroFamilyId: mm,
    exactMicroMicroFamilyId: mm,
    microMicroHash: parseShortTaxonomyMicroId(mm).microMicroHash || enriched.microMicroHash || enriched.executionFingerprintHash || null
  });
}

export function buildOutcomeFromPosition({ position, exitPrice, exitReason, source = 'VIRTUAL' }) {
  if (!position) throw new Error('POSITION_REQUIRED_FOR_OUTCOME');

  const entry = n(position.entry, 0);
  const initialSl = n(position.initialSl || position.sl, 0);
  const exit = n(exitPrice, 0);
  const tp = n(position.tp, 0);

  const riskPct = n(position.riskPct, 0) || calcRiskPct({
    entry,
    sl: initialSl
  });

  const grossMove = grossMovePct(entry, exit);
  const grossR = calcShortGrossR({
    entry,
    initialSl,
    exit
  });

  const cost = applyCosts({
    side: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    grossMovePct: grossMove,
    riskPct,
    entrySpreadPct: n(position.spreadPct, 0),
    exitSpreadPct: n(position.exitSpreadPct ?? position.spreadPct, 0)
  });

  const costR = n(cost.costR, 0);
  const netR = n(cost.netR, grossR - costR);
  const closedAt = n(position.closedAt || position.completedAt, now());
  const ids = ensureOutcomeIds(position) || {};
  const child = ids.childTrueMicroFamilyId || childIdFrom(ids.microMicroFamilyId || ids.trueMicroFamilyId, ids);
  const mm = ids.microMicroFamilyId || ids.trueMicroMicroFamilyId || ids.exactMicroMicroFamilyId || '';

  const identity = [
    TARGET_TRADE_SIDE,
    position.tradeId || '',
    position.symbol || position.contractSymbol || '',
    position.openedAt || position.createdAt || '',
    closedAt,
    exitReason || '',
    exit,
    child || '',
    mm || ''
  ].join('|');

  return flags({
    ...position,
    ...ids,

    type: 'OUTCOME',
    source,
    outcomeSource: source,
    positionSource: position.source || 'VIRTUAL',

    tradeId: position.tradeId,
    positionId: position.positionId || position.id || null,

    outcomeIdentity: position.outcomeIdentity || identity,
    stableOutcomeIdentity: identity,

    symbol: position.symbol,
    contractSymbol: position.contractSymbol,

    entry,
    exit,
    exitPrice: exit,
    sl: n(position.sl, 0),
    initialSl,
    tp,
    rr: n(position.rr, 0),

    riskPct,
    rewardPct: entry > 0 && tp > 0 ? Math.max(0, (entry - tp) / entry) : 0,
    validShortRiskShape: entry > 0 && tp < entry && entry < initialSl,

    exitReason,

    grossMovePct: grossMove,
    grossR,
    shortGrossR: grossR,
    rawR: grossR,
    realizedGrossR: grossR,

    netR,
    shortNetR: netR,
    exitR: netR,
    realizedNetR: netR,
    realizedR: netR,
    r: netR,

    costR,
    avgCostR: costR,
    executionCostR: Math.max(0, costR - n(position.fundingCostR, 0)),
    fundingCostR: n(position.fundingCostR, 0),

    win: netR > 0,
    loss: netR < 0,
    flat: netR === 0,

    directToSL: isDirectSL(position, exitReason),
    directSL: isDirectSL(position, exitReason),

    costModelApplied: true,
    netCostModelApplied: true,
    costModel: COST_MODEL_VERSION,
    costModelVersion: COST_MODEL_VERSION,

    openedAt: position.openedAt || position.createdAt || null,
    closedAt,
    completedAt: closedAt
  });
}

export async function recordOutcome(outcome = {}, { source = outcome.source || 'VIRTUAL', weekKey = PERSISTENT_LEARNING_KEY } = {}) {
  if (!isShort(outcome)) {
    return flags({
      ...outcome,
      skipped: true,
      reason: 'NON_SHORT_OUTCOME_SKIPPED_SHORT_ONLY',
      source,
      weekKey,
      recordedAt: now()
    });
  }

  const row = ensureOutcomeIds(outcome);

  if (!row) {
    return flags({
      ...outcome,
      skipped: true,
      reason: 'SHORT_ONLY_CLASSIFICATION_SKIPPED_OR_EXACT_MICRO_MICRO_MISSING',
      source,
      weekKey,
      recordedAt: now()
    });
  }

  const child = childIdFrom(row.childTrueMicroFamilyId || row.trueMicroFamilyId || row.microFamilyId, row);
  const parent = parentIdFrom(child, row);
  const mm = buildMicroMicroFromChildAndRow(child, row);
  const ids = uniq([parent, child, mm]).filter(isLearningId);

  if (!ids.length || !mm || !isMicroMicroId(mm)) {
    return flags({
      ...row,
      skipped: true,
      reason: 'NO_EXACT_MICRO_MICRO_LEARNING_ID_FOR_OUTCOME',
      source,
      weekKey,
      recordedAt: now()
    });
  }

  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);
  const touched = new Set();
  const outcomeIdentity = stableOutcomeIdentity(row, child);
  const results = [];

  const netR = n(row.netR ?? row.exitR ?? row.realizedR ?? row.r, 0);

  const normalizedOutcome = flags({
    ...slimOutcome({
      ...row,
      source,
      outcomeSource: source,
      weekKey,

      netR,
      shortNetR: netR,
      exitR: netR,
      realizedNetR: netR,
      realizedR: netR,
      r: netR,

      costR: n(row.costR ?? row.avgCostR, 0),
      avgCostR: n(row.avgCostR ?? row.costR, 0),

      win: netR > 0,
      loss: netR < 0,
      flat: netR === 0,

      directSL: Boolean(row.directSL || row.directToSL),
      directToSL: Boolean(row.directSL || row.directToSL)
    }),

    learningFamilyId: mm,
    learningMicroFamilyId: mm,
    analyzeMicroFamilyId: mm,
    primaryLearningFamilyId: mm,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    trueMicroFamilyId: mm,
    microFamilyId: mm,

    childTrueMicroFamilyId: child,
    base75ChildTrueMicroFamilyId: child,
    child75ContextFamilyId: child,

    parentTrueMicroFamilyId: parent,
    parent15ContextFamilyId: parent,

    microMicroFamilyId: mm,
    trueMicroMicroFamilyId: mm,
    exactMicroMicroFamilyId: mm
  });

  for (const id of ids) {
    const key = outcomeKey(weekKey, outcomeIdentity, id);
    const c = await claim(redis, key, outcomeTtl(), `OUTCOME:${layerFor(id)}`);
    const recorded = c.claimed && !c.duplicate;

    results.push({
      id,
      key,
      claim: c,
      recorded
    });

    if (!recorded) continue;

    const layerRow = applyLayerIdentity({
      ...normalizedOutcome,
      childTrueMicroFamilyId: child,
      base75ChildTrueMicroFamilyId: child,
      child75ContextFamilyId: child,
      parentTrueMicroFamilyId: parent,
      parent15ContextFamilyId: parent,
      microMicroFamilyId: mm,
      trueMicroMicroFamilyId: mm,
      exactMicroMicroFamilyId: mm,
      relatedMicroMicroFamilyId: mm
    }, id);

    const micro = getOrCreateMicro(micros, layerRow, id);

    updateOutcome(
      micro,
      flags({
        ...layerRow,
        outcomeDedupeKey: key,
        outcomeDedupeMethod: c.method,
        outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,
        outcomeCounted: true,
        countOutcome: true,
        recordedAt: now()
      }),
      source
    );

    Object.assign(
      micro,
      applyLayerIdentity(
        safeRefreshStats(micro),
        id
      )
    );

    touched.add(id);
  }

  const any = results.some((x) => x.recorded);

  if (touched.size) {
    await saveWeekMicros(weekKey, micros, {
      onlyIds: [...touched]
    });
  }

  const chosen = results.find((x) => x.id === mm) ||
    results.find((x) => x.id === child) ||
    results[0];

  return flags({
    ...normalizedOutcome,

    learningFamilyId: mm,
    learningMicroFamilyId: mm,
    analyzeMicroFamilyId: mm,
    primaryLearningFamilyId: mm,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

    trueMicroFamilyId: mm,
    microFamilyId: mm,

    childTrueMicroFamilyId: child,
    base75ChildTrueMicroFamilyId: child,
    child75ContextFamilyId: child,

    parentTrueMicroFamilyId: parent,
    parent15ContextFamilyId: parent,

    microMicroFamilyId: mm,
    trueMicroMicroFamilyId: mm,
    exactMicroMicroFamilyId: mm,
    microMicroHash: parseShortTaxonomyMicroId(mm).microMicroHash || row.microMicroHash || row.executionFingerprintHash || null,

    learningIds: ids,
    parentLearningId: parent,
    childLearningId: child,
    microMicroLearningId: mm,

    skipped: !any,
    reason: any ? null : 'DUPLICATE_OUTCOME_SKIPPED_NO_STATS_UPDATE',

    outcomeDuplicate: !any,
    outcomeCounted: any,
    countOutcome: any,

    outcomeDedupeKey: chosen?.key || null,
    outcomeDedupeMethod: chosen?.claim?.method || null,
    outcomeDedupeVersion: OUTCOME_DEDUPE_VERSION,

    recordedAt: now()
  });
}

export async function createShadowPosition() {
  return {
    ok: false,
    created: false,
    skipped: true,
    reason: 'SHADOW_POSITION_CREATION_MOVED_TO_POSITION_ENGINE_VIRTUAL_TRACKING'
  };
}

function currentFitLookupFromStoredRow(row = {}) {
  const direct = upper(row.currentFit || row.entryCurrentFit || row.marketFit || '');

  if (direct.includes('MISFIT') || direct.includes('AGAINST')) return 'MISFIT';
  if (direct.includes('MATCH') || direct === 'FIT' || direct === 'ALIGNED') return 'MATCH';

  const recent = Array.isArray(row.recentOutcomes)
    ? row.recentOutcomes
    : [];

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const fit = currentFitLookupFromStoredRow(recent[i]);
    if (fit !== 'UNKNOWN') return fit;
  }

  return 'UNKNOWN';
}

export async function getWeeklyTradingCandidates(
  weekKey = PERSISTENT_LEARNING_KEY,
  {
    limit = 10,
    requireCurrentFitMatch = true,
    currentFitLookup = null,
    includeMeta = false
  } = {}
) {
  const micros = await getWeekMicros(weekKey);

  const candidates = scoreWeeklyTradingCandidates(micros, {
    requireCurrentFitMatch,
    currentFitLookup: currentFitLookup || currentFitLookupFromStoredRow
  })
    .filter((row) => layerFor(rowIdentityId(row)) === LAYER_MICRO_MICRO)
    .slice(0, Math.max(1, Math.floor(n(limit, 10))))
    .map((row, index) => {
      const id = rowIdentityId(row);
      const parsed = parseShortTaxonomyMicroId(id);

      return flags({
        ...row,

        id,
        key: id,
        rowId: id,
        rank: index + 1,
        weekKey,

        tradingCandidate: true,
        tradingEligible: true,
        eligibleGatePassed: true,

        selectionSource: 'LIFETIME_LCB_CURRENTFIT',
        discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',

        learningFamilyId: id,
        learningMicroFamilyId: id,
        analyzeMicroFamilyId: id,
        primaryLearningFamilyId: id,
        primaryLearningIdentity: 'MICRO_MICRO',
        primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,

        microFamilyId: id,
        trueMicroFamilyId: id,

        childTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
        base75ChildTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
        child75ContextFamilyId: parsed.childTrueMicroFamilyId,

        microMicroFamilyId: id,
        trueMicroMicroFamilyId: id,
        exactMicroMicroFamilyId: id,

        parentTrueMicroFamilyId: parsed.parentTrueMicroFamilyId,
        parent15ContextFamilyId: parsed.parentTrueMicroFamilyId,
        coarseMicroFamilyId: parsed.parentTrueMicroFamilyId,
        baseMicroFamilyId: parsed.parentTrueMicroFamilyId,
        legacyMicroFamilyId: parsed.parentTrueMicroFamilyId,

        discordMatchId: id,
        selectedLearningFamilyId: id,
        selectedMicroFamilyId: id,
        selectedTrueMicroFamilyId: id,
        selectedChildTrueMicroFamilyId: parsed.childTrueMicroFamilyId,
        selectedMicroMicroFamilyId: id,
        selectedTrueMicroMicroFamilyId: id,
        selectedExactMicroMicroFamilyId: id,

        selectable: true,
        uiVisible: true,
        adminVisible: true,
        learningLayer: LAYER_MICRO_MICRO,
        layer: LAYER_MICRO_MICRO,
        selectionGranularity: 'EXACT_MICRO_MICRO_ONLY'
      });
    });

  if (!includeMeta) return candidates;

  return {
    weekKey,
    generatedAt: now(),
    count: candidates.length,
    candidates,
    requireCurrentFitMatch,
    selectionEngineVersion: SELECTION_ENGINE_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,
    primaryLearningIdentity: 'MICRO_MICRO',
    primaryLearningIdRule: PRIMARY_LEARNING_ID_RULE,
    rules: {
      selectionUsesWeeklyWinnerOnly: false,
      selectionUsesLifetimeStats: true,
      selectionUsesLCBAvgR: true,
      selectionRequiresEligibleGate: true,
      selectionRequiresCurrentFitMatch: requireCurrentFitMatch,
      discordSelectionRule: 'EXACT_MICRO_MICRO_ONLY',
      selectionGranularity: 'EXACT_MICRO_MICRO_ONLY',
      parent15MatchTriggersDiscord: false,
      child75MatchTriggersDiscord: false,
      micro75MatchDoesNotTriggerDiscord: true
    },
    emptyReason: candidates.length
      ? null
      : requireCurrentFitMatch
        ? 'NO_ELIGIBLE_MICRO_MICRO_WITH_CURRENT_FIT_MATCH'
        : 'NO_ELIGIBLE_MICRO_MICRO'
  };
}

export async function getAnalyzeMicroRowsByIds(weekKey = PERSISTENT_LEARNING_KEY, ids = []) {
  return getWeekMicrosByIds(weekKey, ids);
}