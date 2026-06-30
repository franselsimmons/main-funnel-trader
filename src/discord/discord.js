// ================= FILE: src/discord/discord.js =================
//
// SHORT-only Discord router.
//
// Aangepast op nieuwe laagstructuur:
// - Parent 15      = context / metadata
// - Micro 75       = selecteerbare fallback
// - Micro-micro MM = voorkeurselectie / strengste Discord-match
//
// Selecteerbaar:
// - MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}
// - MICRO_SHORT_{SETUP}_{REGIME}_{CONFIRMATION}_MM_{HASH}
//
// Niet selecteerbaar:
// - Parent 15
// - Scanner buckets
// - XR execution fingerprint raw ids
// - LONG ids
//
// Discord stuurt alleen:
// - SHORT
// - virtual/shadow/paper payloads
// - exact manual selected micro-family match
// - geldige SHORT geometry: tp < entry < sl

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, pushJsonLog } from '../redis.js';
import {
  normalizeBaseSymbol,
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

const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_75_MICRO_MICRO_V1';
const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';
const MICRO_MICRO_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_AVGCOST_DIRECTSL_STABLE_OUTCOME_DEDUPE_V2';
const POSITION_MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_V4';
const SHORT_RISK_PLAN_VERSION = 'SHORT_ADAPTIVE_RR_TP_SL_V2';
const MICRO_MICRO_VERSION = 'SHORT_PARENT_MICRO_MICRO_LAYERING_V1';

const SOURCE_VIRTUAL = 'VIRTUAL';
const SOURCE_REAL = 'REAL';
const SOURCE_LIVE = 'LIVE';
const SOURCE_TRADE = 'TRADE';
const SOURCE_SHADOW = 'SHADOW';

const CUSTOMER_DISCLAIMER = 'Geen financieel advies. Beheer je eigen risico.';

const DISCORD_LIMITS = {
  fieldName: 256,
  fieldValue: 1024
};

const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'DOWN',
  'DOWNSIDE'
]);

const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'UP',
  'UPSIDE'
]);

const REAL_ORDER_SOURCES = new Set([
  SOURCE_REAL,
  SOURCE_LIVE,
  'ENTRY',
  'ORDER',
  'BITGET'
]);

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

const SHORT_FIXED_SETUP_TYPES = new Set(SETUP_ORDER);
const SHORT_FIXED_REGIME_BUCKETS = new Set(REGIME_ORDER);
const SHORT_CONFIRMATION_PROFILES = new Set(CONFIRMATION_PROFILE_ORDER);

function namespacedShortKey(key, fallback) {
  const raw = String(key || fallback || '').trim();
  const safe = raw || String(fallback || '').trim();

  if (!safe) return `${SHORT_KEY_PREFIX}DISCORD:LOGS`;
  if (safe.startsWith(SHORT_KEY_PREFIX)) return safe;
  if (safe.startsWith('LONG:')) return `${SHORT_KEY_PREFIX}${safe.slice('LONG:'.length)}`;

  return `${SHORT_KEY_PREFIX}${safe}`;
}

const SHORT_KEYS = {
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

function nowIso() {
  return new Date().toISOString();
}

function discordConfig() {
  const cfg = CONFIG.short?.discord || CONFIG.discord || {};

  return {
    enabled: cfg.enabled !== false,
    webhookUrl: cfg.webhookUrl || '',
    timeoutMs: Math.max(500, safeNumber(cfg.timeoutMs, 2500)),
    logLimit: Math.max(1, Math.floor(safeNumber(cfg.logLimit, 250))),

    sendRotationReports: cfg.sendRotationReports === true,
    sendResetReports: cfg.sendResetReports !== false
  };
}

function truncate(value, max = 1024) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function field(name, value, inline = true) {
  return {
    name: truncate(name || 'Field', DISCORD_LIMITS.fieldName),
    value: truncate(value ?? 'NA', DISCORD_LIMITS.fieldValue) || 'NA',
    inline
  };
}

function fmtPrice(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(6);

  return n.toFixed(10);
}

function fmtPctSmart(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  const ratio = Math.abs(n) > 1 ? n / 100 : n;

  return `${(ratio * 100).toFixed(1)}%`;
}

function fmtR(value) {
  if (value === null || value === undefined || value === '') return 'NA';

  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;
}

function fmtNumber(value, decimals = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return n.toFixed(decimals);
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function isEntryAction(value = '') {
  const action = upper(value);

  if (!action) return true;

  return (
    action === 'ENTRY' ||
    action === 'VIRTUAL_ENTRY' ||
    action === 'OPEN' ||
    action === 'TRADE_OPEN' ||
    action === 'POSITION_OPEN' ||
    action === 'VIRTUAL_POSITION_OPEN'
  );
}

function displaySymbol(payload = {}) {
  const raw = upper(
    payload.contractSymbol ||
      payload.instId ||
      payload.instrumentId ||
      payload.symbol ||
      payload.baseSymbol ||
      ''
  );

  if (!raw) return 'UNKNOWN';

  const cleaned = raw.replace(/[^A-Z0-9]/g, '');

  if (cleaned.endsWith('USDT')) return cleaned;

  const base = normalizeBaseSymbol(cleaned) || cleaned.replace(/USDT$/u, '');

  return `${upper(base || cleaned)}USDT`;
}

function tradeDirectionEmoji(payload = {}) {
  return isShortPayload(payload) ? '🔴' : '🟢';
}

function exitEmoji(exitType = '', resultR = null) {
  const type = upper(exitType);

  if (type === 'TP') return '✅';
  if (type === 'SL') return '❌';
  if (type === 'TIME' || type === 'TIME_STOP') return '⏹️';

  const r = Number(resultR);

  if (Number.isFinite(r) && r > 0) return '✅';
  if (Number.isFinite(r) && r < 0) return '❌';

  return '⏹️';
}

function customerExitReason(exitType = '') {
  const type = upper(exitType);

  if (type === 'TP') return 'TP geraakt';
  if (type === 'SL') return 'SL geraakt';
  if (type === 'TIME' || type === 'TIME_STOP') return 'tijdslimiet';
  if (type === 'MANUAL') return 'handmatig gesloten';

  return 'gesloten';
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
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function normalizeSource(value) {
  const raw = upper(value || SOURCE_VIRTUAL, SOURCE_VIRTUAL);

  if (raw === SOURCE_VIRTUAL) return SOURCE_VIRTUAL;
  if (raw === SOURCE_SHADOW) return SOURCE_SHADOW;
  if (raw === SOURCE_REAL) return SOURCE_REAL;
  if (raw === SOURCE_LIVE) return SOURCE_LIVE;
  if (raw === SOURCE_TRADE) return SOURCE_TRADE;

  return raw;
}

function normalizeSideToken(value) {
  const direct = sideToTradeSide(value);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';
  if (SHORT_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (LONG_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const shortPatterns = [
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
  ];

  const longPatterns = [
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
  ];

  const hit = (patterns) => patterns.some((pattern) => (
    normalized === pattern ||
    normalized.startsWith(`${pattern}_`) ||
    normalized.endsWith(`_${pattern}`) ||
    normalized.includes(`_${pattern}_`)
  ));

  const shortHit = hit(shortPatterns);
  const longHit = hit(longPatterns);

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

function flattenValues(values = []) {
  const stack = Array.isArray(values) ? [...values] : [values];
  const out = [];

  while (stack.length > 0) {
    const value = stack.shift();

    if (Array.isArray(value)) {
      stack.unshift(...value);
      continue;
    }

    out.push(value);
  }

  return out;
}

function uniqueStrings(values = []) {
  return [...new Set(
    flattenValues(values)
      .flatMap((value) => {
        if (typeof value === 'string') {
          return value
            .split(/[\s,;\n\r]+/g)
            .map((part) => part.trim());
        }

        return [value];
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function firstFiniteNumber(...values) {
  for (const value of flattenValues(values)) {
    const n = safeNumber(value, NaN);

    if (Number.isFinite(n)) return n;
  }

  return null;
}

function isScannerFamilyId(id = '') {
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
    value.includes('|XR|') ||
    value.includes('EXECUTION_FINGERPRINT') ||
    value.includes('EXECUTION_MICRO') ||
    value.includes('EXECUTIONMICRO') ||
    value.includes('REFINED_EXECUTION')
  );
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

  if (isScannerFamilyId(value) || isExecutionFingerprintId(value)) {
    return {
      valid: false,
      selectable: false,
      isParent: false,
      isChild: false,
      isMicroMicro: false,
      rawId
    };
  }

  if (
    value.includes('_MF_V1_') ||
    value.includes('_MF_V2_') ||
    value.includes('_MF_V3_')
  ) {
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
  let microMicroFamilyId = null;

  const mmMatch = /^(MICRO_SHORT_.+)_MM_([A-Z0-9]{6,24})$/u.exec(value);

  if (mmMatch) {
    baseValue = mmMatch[1];
    microMicroHash = mmMatch[2].slice(0, MICRO_MICRO_HASH_LEN);
  }

  let body = baseValue.slice('MICRO_SHORT_'.length);
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

  if (validChild && microMicroHash) {
    microMicroFamilyId = `${childId}_${MICRO_MICRO_SUFFIX}_${microMicroHash}`;
  }

  const isMicroMicro = Boolean(microMicroFamilyId);
  const isChild = validChild && !isMicroMicro;
  const isParent = validParent && !validChild && !isMicroMicro;

  return {
    valid: validParent || validChild || isMicroMicro,
    selectable: isChild || isMicroMicro,

    isParent,
    isChild,
    isMicroMicro,
    isExactChild: validChild,

    rawId,
    setup,
    regime,
    setupType: setup,
    regimeBucket: regime,
    confirmationProfile,

    parentTrueMicroFamilyId: validParent ? parentId : null,
    trueMicroFamilyId: isMicroMicro ? microMicroFamilyId : validChild ? childId : validParent ? parentId : null,
    childTrueMicroFamilyId: validChild ? childId : null,

    microMicroFamilyId,
    trueMicroMicroFamilyId: microMicroFamilyId,
    exactMicroMicroFamilyId: microMicroFamilyId,
    microMicroHash,

    trueMicroFamilySchema: isMicroMicro ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,

    learningLayer: isMicroMicro
      ? 'MICRO_MICRO'
      : isChild
        ? 'MICRO_75'
        : isParent
          ? 'PARENT_15'
          : 'UNKNOWN',

    learningGranularity: isMicroMicro
      ? MICRO_MICRO_LEARNING_GRANULARITY
      : isParent
        ? PARENT_LEARNING_GRANULARITY
        : LEARNING_GRANULARITY,

    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY
  };
}

function isSelectableTrueMicroFamilyId(id = '') {
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.isChild === true || parsed.isMicroMicro === true;
}

function isMicroMicroFamilyId(id = '') {
  return parseShortTaxonomyMicroId(id).isMicroMicro === true;
}

function isParentTrueMicroFamilyId(id = '') {
  return parseShortTaxonomyMicroId(id).isParent === true;
}

function validLearningChildId(id = '') {
  const value = String(id || '').trim();

  if (!value) return false;
  if (isScannerFamilyId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return isSelectableTrueMicroFamilyId(value);
}

function definitionParts(payload = {}) {
  return [
    payload.definition,
    payload.microDefinition,
    payload.macroDefinition,
    payload.parentDefinition,
    payload.microMicroDefinition,

    ...(Array.isArray(payload.definitionParts) ? payload.definitionParts : []),
    ...(Array.isArray(payload.microDefinitionParts) ? payload.microDefinitionParts : []),
    ...(Array.isArray(payload.macroDefinitionParts) ? payload.macroDefinitionParts : []),
    ...(Array.isArray(payload.parentDefinitionParts) ? payload.parentDefinitionParts : []),
    ...(Array.isArray(payload.executionFingerprintParts) ? payload.executionFingerprintParts : []),
    ...(Array.isArray(payload.microMicroDefinitionParts) ? payload.microMicroDefinitionParts : [])
  ]
    .map((value) => upper(value))
    .filter(Boolean);
}

function idHaystack(payload = {}) {
  return [
    payload.familyId,
    payload.family,
    payload.baseFamilyId,

    payload.microFamilyId,
    payload.trueMicroFamilyId,
    payload.childTrueMicroFamilyId,
    payload.microMicroFamilyId,
    payload.trueMicroMicroFamilyId,
    payload.exactMicroMicroFamilyId,
    payload.id,
    payload.key,

    payload.coarseMicroFamilyId,
    payload.parentTrueMicroFamilyId,
    payload.baseMicroFamilyId,
    payload.legacyMicroFamilyId,

    payload.macroFamilyId,
    payload.parentMacroFamilyId,
    payload.parentMicroFamilyId,
    payload.parentFamilyId,
    payload.macroId,
    payload.activeMacroFamilyId
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function hasShortIdSignal(value = '') {
  const raw = upper(value);

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.startsWith('SHORT_') ||
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
    raw.includes('POSITIONSIDE=SHORT') ||
    raw.includes('SIDE=SELL') ||
    raw.includes('DIRECTION=SELL')
  );
}

function hasLongIdSignal(value = '') {
  const raw = upper(value);

  return (
    raw.includes('MICRO_LONG_') ||
    raw.startsWith('LONG_') ||
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
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY')
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

function inferTradeSide(payload = {}) {
  if (typeof payload !== 'object' || payload === null) {
    return normalizeSideToken(payload);
  }

  const directSources = [
    payload.tradeSide,
    payload.positionSide,
    payload.direction,
    payload.signalSide,
    payload.scannerSide,
    payload.actualScannerSide,
    payload.analysisSide,
    payload.entrySide,
    payload.side
  ];

  for (const value of directSources) {
    const side = normalizeSideToken(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  const ids = idHaystack(payload);
  const shortId = hasShortIdSignal(ids);
  const longId = hasLongIdSignal(ids);

  if (shortId && !longId) return TARGET_TRADE_SIDE;
  if (longId && !shortId) return OPPOSITE_TRADE_SIDE;
  if (shortId) return TARGET_TRADE_SIDE;
  if (longId) return OPPOSITE_TRADE_SIDE;

  const parts = definitionParts(payload);
  const shortDefinition = hasShortDefinitionSignal(parts);
  const longDefinition = hasLongDefinitionSignal(parts);

  if (shortDefinition && !longDefinition) return TARGET_TRADE_SIDE;
  if (longDefinition && !shortDefinition) return OPPOSITE_TRADE_SIDE;
  if (shortDefinition) return TARGET_TRADE_SIDE;
  if (longDefinition) return OPPOSITE_TRADE_SIDE;

  if (payload.shortOnly === true || payload.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (payload.longOnly === true || payload.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortPayload(payload = {}) {
  return inferTradeSide(payload) === TARGET_TRADE_SIDE;
}

function normalizeSideLabel(payload = {}) {
  return isShortPayload(payload) ? TARGET_TRADE_SIDE : 'NON_SHORT_SKIPPED';
}

function discordColorForSide(payload = {}) {
  return isShortPayload(payload) ? 0xdc2626 : 0x64748b;
}

function discordColorForResult(value) {
  const r = safeNumber(value, 0);

  if (r > 0) return 0x2563eb;
  if (r < 0) return 0xdc2626;

  return 0x94a3b8;
}

function extractExitPrice(outcome = {}) {
  return (
    outcome.exit ??
    outcome.exitPrice ??
    outcome.close ??
    outcome.closePrice ??
    outcome.price ??
    outcome.lastPrice ??
    null
  );
}

function extractResultR(outcome = {}) {
  return (
    outcome.shortNetR ??
    outcome.netShortR ??
    outcome.shortExitR ??
    outcome.realizedShortR ??
    outcome.netR ??
    outcome.exitR ??
    outcome.realizedNetR ??
    outcome.realizedR ??
    outcome.r ??
    null
  );
}

function getShortRiskGeometry(entry = {}) {
  const entryPrice = safeNumber(entry.entry ?? entry.entryPrice, 0);
  const sl = safeNumber(entry.sl ?? entry.initialSl ?? entry.stopLoss, 0);
  const tp = safeNumber(entry.tp ?? entry.takeProfit, 0);
  const exitPrice = safeNumber(extractExitPrice(entry), 0);
  const currentPrice = safeNumber(entry.currentPrice ?? entry.lastPrice ?? entry.price, 0);

  const riskDistance =
    entryPrice > 0 &&
    sl > entryPrice
      ? sl - entryPrice
      : 0;

  const validShortGeometry =
    entryPrice > 0 &&
    sl > entryPrice &&
    tp > 0 &&
    tp < entryPrice;

  const shortGrossR =
    validShortGeometry &&
    exitPrice > 0 &&
    riskDistance > 0
      ? (entryPrice - exitPrice) / riskDistance
      : null;

  const shortCurrentR =
    validShortGeometry &&
    currentPrice > 0 &&
    riskDistance > 0
      ? (entryPrice - currentPrice) / riskDistance
      : null;

  return {
    entry: entryPrice,
    initialSl: sl,
    sl,
    tp,
    exitPrice,
    currentPrice,
    riskDistance,
    validShortGeometry,
    validShortRiskShape: validShortGeometry,
    shortTpHit: validShortGeometry && currentPrice > 0 ? currentPrice <= tp : false,
    shortSlHit: validShortGeometry && currentPrice > 0 ? currentPrice >= sl : false,
    shortGrossR,
    shortCurrentR
  };
}

function resultRForDiscord(outcome = {}) {
  const direct = safeNumber(extractResultR(outcome), NaN);

  if (Number.isFinite(direct)) return direct;

  const risk = getShortRiskGeometry(outcome);

  if (Number.isFinite(risk.shortGrossR)) return risk.shortGrossR;

  return null;
}

function exitTypeLabel(outcome = {}) {
  const reason = upper(outcome.exitReason || outcome.reason || outcome.closeReason || outcome.status || '');

  if (
    reason === 'TP' ||
    reason.includes('TAKE_PROFIT') ||
    reason.includes('TAKE PROFIT') ||
    reason.includes('TARGET') ||
    outcome.tpHitNow === true ||
    outcome.tpExitArmed === true ||
    outcome.shortTpHit === true
  ) {
    return 'TP';
  }

  if (
    reason === 'SL' ||
    reason.includes('STOP_LOSS') ||
    reason.includes('STOP LOSS') ||
    reason.includes('STOPLOSS') ||
    outcome.slHitNow === true ||
    outcome.slExitArmed === true ||
    outcome.shortSlHit === true
  ) {
    return 'SL';
  }

  if (
    reason.includes('TIME') ||
    reason.includes('TIME_STOP') ||
    reason.includes('TIME STOP') ||
    outcome.timeStopHitNow === true ||
    outcome.timeStopExitArmed === true
  ) {
    return 'TIME';
  }

  if (
    reason.includes('MANUAL') ||
    reason.includes('ADMIN_CLOSE') ||
    reason.includes('FORCE_CLOSE')
  ) {
    return 'MANUAL';
  }

  const risk = getShortRiskGeometry(outcome);
  const exitPrice = safeNumber(extractExitPrice(outcome), 0);

  if (risk.validShortGeometry && exitPrice > 0) {
    if (exitPrice <= risk.tp) return 'TP';
    if (exitPrice >= risk.sl) return 'SL';
  }

  return reason || 'EXIT';
}

function selectedLearningId(payload = {}) {
  const candidates = [
    payload.microMicroFamilyId,
    payload.trueMicroMicroFamilyId,
    payload.exactMicroMicroFamilyId,

    payload.trueMicroFamilyId,
    payload.childTrueMicroFamilyId,
    payload.microFamilyId,
    payload.analyzeMicroFamilyId,
    payload.learningMicroFamilyId
  ];

  for (const candidate of candidates) {
    const value = upper(candidate);

    if (validLearningChildId(value)) {
      const parsed = parseShortTaxonomyMicroId(value);

      return parsed.trueMicroFamilyId;
    }
  }

  return null;
}

function trueMicroFamilyId(payload = {}) {
  return selectedLearningId(payload);
}

function childTrueMicroFamilyId(payload = {}) {
  const id = selectedLearningId(payload);
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.childTrueMicroFamilyId || null;
}

function microMicroFamilyId(payload = {}) {
  const id = selectedLearningId(payload);
  const parsed = parseShortTaxonomyMicroId(id);

  return parsed.microMicroFamilyId || null;
}

function parentTrueMicroFamilyId(payload = {}) {
  const selectedId = selectedLearningId(payload);
  const parsedSelected = parseShortTaxonomyMicroId(selectedId);

  if (parsedSelected.parentTrueMicroFamilyId) {
    return parsedSelected.parentTrueMicroFamilyId;
  }

  const candidates = [
    payload.parentTrueMicroFamilyId,
    payload.coarseMicroFamilyId,
    payload.parentMacroFamilyId,
    payload.parentMicroFamilyId,
    payload.macroFamilyId,
    payload.activeMacroFamilyId
  ];

  for (const candidate of candidates) {
    const value = upper(candidate);

    if (isParentTrueMicroFamilyId(value)) return value;

    const parsed = parseShortTaxonomyMicroId(value);

    if (parsed.parentTrueMicroFamilyId) return parsed.parentTrueMicroFamilyId;
  }

  return null;
}

function microFamilyId(payload = {}) {
  return trueMicroFamilyId(payload);
}

function macroFamilyId(payload = {}) {
  return parentTrueMicroFamilyId(payload);
}

function weeklyStats(payload = {}) {
  return payload.weeklyStats || payload.microStats || payload.stats || {};
}

function statValue(payload = {}, key, fallbackKey = null) {
  const stats = weeklyStats(payload);

  return (
    stats?.[key] ??
    (fallbackKey ? stats?.[fallbackKey] : undefined) ??
    payload?.[key] ??
    (fallbackKey ? payload?.[fallbackKey] : undefined) ??
    null
  );
}

function completedSample(payload = {}) {
  const stats = weeklyStats(payload);

  const virtualCompleted = safeNumber(stats.virtualCompleted ?? payload.virtualCompleted, 0);
  const shadowCompleted = safeNumber(stats.shadowCompleted ?? payload.shadowCompleted, 0);
  const closed = virtualCompleted + shadowCompleted;

  if (closed > 0) return closed;

  return (
    statValue(payload, 'completed') ??
    statValue(payload, 'winrateSample') ??
    0
  );
}

function bestWinrate(payload = {}) {
  return (
    statValue(payload, 'fairWinrate') ??
    statValue(payload, 'sampleAdjustedWinrate') ??
    statValue(payload, 'bayesianWinrate') ??
    statValue(payload, 'wilsonLowerBound') ??
    statValue(payload, 'winrate') ??
    0
  );
}

function fingerprint(payload = {}) {
  return (
    payload.executionFingerprintHash ||
    payload.fingerprintHash ||
    payload.microFingerprintHash ||
    payload.microMicroHash ||
    'NA'
  );
}

function marketBiasHaystack(payload = {}) {
  return [
    payload.currentMarketBias,
    payload.marketBias,
    payload.currentTrendSide,
    payload.entryCurrentTrendSide,
    payload.currentRegime,
    payload.entryCurrentRegime,
    payload.currentFit,
    payload.entryCurrentFit,
    payload.currentMarketFit,
    payload.currentFitReason,
    payload.marketWeather,
    payload.entryMarketWeather,
    payload.reason,
    payload.signalReason,
    ...(Array.isArray(payload.definitionParts) ? payload.definitionParts : [])
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function getShortCurrentFit(payload = {}) {
  const explicitShort = firstFiniteNumber(
    payload.shortCurrentFit,
    payload.bearCurrentFit,
    payload.bearishCurrentFit,
    payload.shortFitScore,
    payload.bearFitScore,
    payload.shortMarketFit,
    payload.bearMarketFit
  );

  if (explicitShort !== null) return explicitShort;

  const explicitLong = firstFiniteNumber(
    payload.longCurrentFit,
    payload.bullCurrentFit,
    payload.bullishCurrentFit,
    payload.longFitScore,
    payload.bullFitScore,
    payload.longMarketFit,
    payload.bullMarketFit
  );

  if (explicitLong !== null) return -Math.abs(explicitLong);

  const raw = firstFiniteNumber(
    payload.currentFitScore,
    payload.entryCurrentFitScore,
    payload.marketFitScore,
    payload.currentMarketFitScore,
    payload.currentFit,
    payload.entryCurrentFit,
    payload.currentMarketFit,
    payload.fitScore
  );

  if (raw === null) return null;

  const bias = marketBiasHaystack(payload);
  const bearish =
    bias.includes('BEAR') ||
    bias.includes('BEARISH') ||
    bias.includes('SHORT') ||
    bias.includes('SELL') ||
    bias.includes('DOWN');

  const bullish =
    bias.includes('BULL') ||
    bias.includes('BULLISH') ||
    bias.includes('LONG') ||
    bias.includes('BUY') ||
    bias.includes('UP');

  if (bearish && !bullish) return Math.abs(raw);
  if (bullish && !bearish) return -Math.abs(raw);

  return -raw;
}

function isExplicitlyVirtualPayload(payload = {}) {
  const sources = [
    payload.source,
    payload.sourceMode,
    payload.outcomeSource,
    payload.positionSource
  ].map(normalizeSource);

  return Boolean(
    sources.includes(SOURCE_VIRTUAL) ||
    sources.includes(SOURCE_SHADOW) ||
    payload.virtualOnly === true ||
    payload.virtualTracked === true ||
    payload.paperTrade === true ||
    payload.paperPosition === true ||
    payload.realTrade === false ||
    payload.realOrder === false ||
    payload.exchangeOrder === false ||
    payload.bitgetOrderPlaced === false
  );
}

function hasExplicitRealOrderFlag(payload = {}) {
  return Boolean(
    payload.realTrade === true ||
    payload.realOrder === true ||
    payload.exchangeOrder === true ||
    payload.bitgetOrderPlaced === true ||
    payload.liveOrder === true ||
    payload.orderPlaced === true
  );
}

function isRealOrderSource(payload = {}) {
  if (hasExplicitRealOrderFlag(payload)) return true;

  if (isExplicitlyVirtualPayload(payload)) return false;

  const sources = [
    payload.source,
    payload.sourceMode,
    payload.outcomeSource,
    payload.positionSource,
    payload.orderSource
  ]
    .map(normalizeSource)
    .filter(Boolean);

  return sources.some((source) => REAL_ORDER_SOURCES.has(source));
}

function isVirtualSource(payload = {}) {
  return isExplicitlyVirtualPayload(payload);
}

function isMirrorPayload(payload = {}) {
  const source = normalizeSource(payload.source);

  return Boolean(
    source === SOURCE_SHADOW ||
    payload.observationMirror === true ||
    payload.analysisMirror === true ||
    payload.mirrorAnalysisOnly === true ||
    payload.isMirrorMicroFamily === true ||
    payload.mirrorOfSide
  );
}

function isAnalysisOnlyPayload(payload = {}) {
  return Boolean(
    payload.observationOnly === true ||
    payload.analysisInputOnly === true ||
    payload.learningOnly === true ||
    payload.analyzeOnly === true ||
    payload.discoveryOnly === true ||
    payload.tradeDiscoveryOnly === true ||
    payload.scannerOnly === true
  );
}

function hasValidShortTradeShape(entry = {}) {
  return getShortRiskGeometry(entry).validShortGeometry === true;
}

function selectedTrueMicroIdsFromPayload(payload = {}) {
  return uniqueStrings([
    payload.selectedTrueMicroFamilyId,
    payload.selectedMicroFamilyId,
    payload.activeTrueMicroFamilyId,
    payload.activeMicroFamilyId,
    payload.rotationTrueMicroFamilyId,
    payload.rotationMicroFamilyId,

    payload.selectedMicroMicroFamilyId,
    payload.selectedTrueMicroMicroFamilyId,
    payload.activeMicroMicroFamilyId,
    payload.activeTrueMicroMicroFamilyId,
    payload.rotationMicroMicroFamilyId,
    payload.rotationTrueMicroMicroFamilyId,

    payload.selectedTrueMicroFamilyIds || [],
    payload.selectedMicroFamilyIds || [],
    payload.activeTrueMicroFamilyIds || [],
    payload.activeMicroFamilyIds || [],
    payload.trueMicroFamilyIds || [],
    payload.microFamilyIds || [],

    payload.selectedMicroMicroFamilyIds || [],
    payload.selectedTrueMicroMicroFamilyIds || [],
    payload.activeMicroMicroFamilyIds || [],
    payload.activeTrueMicroMicroFamilyIds || [],
    payload.trueMicroMicroFamilyIds || [],
    payload.microMicroFamilyIds || []
  ])
    .map(upper)
    .map((id) => {
      const parsed = parseShortTaxonomyMicroId(id);
      return parsed.selectable ? parsed.trueMicroFamilyId : null;
    })
    .filter(Boolean)
    .filter(validLearningChildId);
}

function matchTypeIsExactSelectedMicro(entry = {}) {
  const matchType = upper(entry.rotationMatchType || entry.matchType || '');

  if (!matchType) {
    return Boolean(
      entry.discordAlertEligible === true ||
      entry.selectedForDiscord === true ||
      entry.selectedMicroFamilyAlert === true
    );
  }

  if (
    matchType.includes('MACRO') ||
    matchType.includes('PARENT') ||
    matchType.includes('COARSE') ||
    matchType.includes('SCANNER') ||
    matchType.includes('EXECUTION') ||
    matchType.includes('XR')
  ) {
    return false;
  }

  return (
    matchType === 'TRUE_MICRO_EXACT' ||
    matchType === 'EXACT_TRUE_MICRO' ||
    matchType === 'EXACT_75_CHILD' ||
    matchType === 'EXACT_75_CHILD_TRUE_MICRO' ||
    matchType === 'SELECTED_TRUE_MICRO_EXACT' ||
    matchType === 'MICRO_MICRO_EXACT' ||
    matchType === 'EXACT_MICRO_MICRO' ||
    matchType === 'EXACT_MM' ||
    matchType === 'SELECTED_MICRO_MICRO_EXACT' ||
    matchType.includes('TRUE_MICRO_EXACT') ||
    matchType.includes('EXACT_TRUE_MICRO') ||
    matchType.includes('EXACT_75_CHILD') ||
    matchType.includes('CHILD_TRUE_MICRO') ||
    matchType.includes('MICRO_MICRO_EXACT') ||
    matchType.includes('EXACT_MICRO_MICRO') ||
    matchType.includes('EXACT_MM')
  );
}

function hasSelectedMicroRotationMatch(entry = {}) {
  const selectedId = trueMicroFamilyId(entry);

  if (!selectedId) return false;
  if (!validLearningChildId(selectedId)) return false;

  const selected = Boolean(
    entry.discordAlertEligible === true ||
    entry.selectedForDiscord === true ||
    entry.selectedMicroFamilyAlert === true ||
    entry.liveEligible === true
  );

  if (!selected) return false;
  if (!matchTypeIsExactSelectedMicro(entry)) return false;

  const selectedIds = selectedTrueMicroIdsFromPayload(entry);

  if (selectedIds.length > 0 && !selectedIds.includes(selectedId)) {
    return false;
  }

  return true;
}

function shouldSendEntryAlert(entry = {}) {
  if (!isShortPayload(entry)) return false;
  if (isMirrorPayload(entry)) return false;
  if (isAnalysisOnlyPayload(entry)) return false;
  if (isRealOrderSource(entry)) return false;
  if (!isVirtualSource(entry)) return false;

  if (entry.action && !isEntryAction(entry.action)) return false;

  if (!hasSelectedMicroRotationMatch(entry)) return false;
  if (!hasValidShortTradeShape(entry)) return false;

  return true;
}

function shouldSendExitAlert(outcome = {}) {
  if (!isShortPayload(outcome)) return false;
  if (isMirrorPayload(outcome)) return false;
  if (isAnalysisOnlyPayload(outcome)) return false;
  if (isRealOrderSource(outcome)) return false;
  if (!isVirtualSource(outcome)) return false;

  const selectedId = trueMicroFamilyId(outcome);

  if (!selectedId) return false;
  if (!validLearningChildId(selectedId)) return false;
  if (!hasSelectedMicroRotationMatch(outcome)) return false;

  return true;
}

function compactPayload(payload = {}) {
  const tradeSide = inferTradeSide(payload);
  const selectedId = trueMicroFamilyId(payload);
  const childId = childTrueMicroFamilyId(payload);
  const mmId = microMicroFamilyId(payload);
  const parentId = parentTrueMicroFamilyId(payload);
  const parsed = parseShortTaxonomyMicroId(selectedId);
  const risk = getShortRiskGeometry(payload);
  const shortCurrentFit = getShortCurrentFit(payload);
  const isMM = isMicroMicroFamilyId(selectedId);

  return {
    symbol: payload.symbol || null,
    contractSymbol: payload.contractSymbol || null,

    side: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_DASHBOARD_SIDE
      : payload.side || null,

    tradeSide,

    action: payload.action || null,
    reason: payload.reason || null,
    exitReason: payload.exitReason || null,

    source: normalizeSource(payload.source),
    sourceMode: payload.sourceMode || null,
    outcomeSource: payload.outcomeSource || null,
    positionSource: payload.positionSource || null,

    liveEligible: Boolean(payload.liveEligible),
    discordAlertEligible: Boolean(payload.discordAlertEligible),
    selectedMicroFamilyAlert: Boolean(payload.selectedMicroFamilyAlert),
    selectedForDiscord: Boolean(payload.selectedForDiscord),

    virtualOnly: payload.virtualOnly !== false,
    virtualTracked: payload.virtualTracked !== false,
    shadowOnly: Boolean(payload.shadowOnly),

    observationOnly: Boolean(payload.observationOnly),
    analysisInputOnly: Boolean(payload.analysisInputOnly),
    learningOnly: Boolean(payload.learningOnly),

    activeRotationId: payload.activeRotationId || payload.rotationId || null,
    selectedRotationId: payload.selectedRotationId || payload.activeRotationId || payload.rotationId || null,
    rotationMatchType: payload.rotationMatchType || null,

    microFamilyId: selectedId,
    trueMicroFamilyId: selectedId,
    selectedLearningMicroFamilyId: selectedId,

    childTrueMicroFamilyId: childId,
    microMicroFamilyId: mmId,
    trueMicroMicroFamilyId: mmId,
    exactMicroMicroFamilyId: mmId,
    microMicroHash: parsed.microMicroHash || payload.microMicroHash || null,

    parentTrueMicroFamilyId: parentId,
    coarseMicroFamilyId: parentId,

    setupType: parsed.setupType || payload.setupType || null,
    regimeBucket: parsed.regimeBucket || payload.regimeBucket || null,
    confirmationProfile: parsed.confirmationProfile || payload.confirmationProfile || null,

    familyId: payload.familyId || null,
    macroFamilyId: parentId,

    executionFingerprintHash: payload.executionFingerprintHash || fingerprint(payload),
    executionFingerprintRole: isMM ? 'MICRO_MICRO_IDENTITY_HASH_SOURCE' : 'METADATA_ONLY',
    scannerFingerprintRole: payload.scannerFingerprintRole || 'METADATA_ONLY',

    entry: payload.entry ?? null,
    exit: extractExitPrice(payload),
    sl: payload.sl ?? payload.initialSl ?? null,
    initialSl: payload.initialSl ?? payload.sl ?? null,
    tp: payload.tp ?? null,
    rr: payload.rr ?? null,

    validShortGeometry: risk.validShortGeometry,
    validShortRiskShape: risk.validShortRiskShape,
    shortTpHit: risk.shortTpHit,
    shortSlHit: risk.shortSlHit,
    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    shortGrossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    shortCurrentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    currentPrice: payload.currentPrice ?? payload.lastPrice ?? null,
    currentR: payload.shortCurrentR ?? risk.shortCurrentR ?? payload.currentR ?? null,
    shortCurrentR: payload.shortCurrentR ?? risk.shortCurrentR ?? null,
    mfeR: payload.mfeR ?? null,
    maeR: payload.maeR ?? null,

    currentFit: shortCurrentFit,
    shortCurrentFit,
    bearCurrentFit: shortCurrentFit,
    bullishCurrentFit: shortCurrentFit === null ? null : -Math.abs(shortCurrentFit),
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    reachedHalfR: Boolean(payload.reachedHalfR),
    reachedOneR: Boolean(payload.reachedOneR),
    nearTpSeen: Boolean(payload.nearTpSeen),

    winrate: bestWinrate(payload),
    completed: completedSample(payload),
    avgR: statValue(payload, 'avgR'),
    totalR: statValue(payload, 'totalR'),
    profitFactor: statValue(payload, 'profitFactor'),
    avgCostR: statValue(payload, 'avgCostR'),

    exitR: payload.shortExitR ?? payload.exitR ?? null,
    netR: payload.shortNetR ?? payload.netR ?? null,
    shortNetR: payload.shortNetR ?? payload.netR ?? null,
    grossR: payload.shortGrossR ?? risk.shortGrossR ?? payload.grossR ?? null,
    shortGrossR: payload.shortGrossR ?? risk.shortGrossR ?? payload.grossR ?? null,
    costR: payload.costR ?? null,
    pnlPct: payload.pnlPct ?? payload.netPnlPct ?? null,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    executionFingerprintsMetadataOnly: !isMM,
    executionFingerprintsUsedAsLearningFamily: isMM,

    manualSelectionMatchMode: 'EXACT_MICRO_MICRO_PREFERRED_OR_EXACT_75_CHILD',
    discordOnlyForExactTrueMicroMatch: true,
    selectionGranularity: isMM ? 'EXACT_MICRO_MICRO' : 'EXACT_75_CHILD',

    trueMicroFamilySchema: isMM ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    learningGranularity: isMM ? MICRO_MICRO_LEARNING_GRANULARITY : LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,
    microMicroLearningGranularity: MICRO_MICRO_LEARNING_GRANULARITY,

    measurementFixVersion: payload.measurementFixVersion || MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion:
      payload.positionMeasurementFixVersion ||
      payload.monitorMeasurementFixVersion ||
      POSITION_MEASUREMENT_FIX_VERSION,
    riskPlanVersion: payload.riskPlanVersion || SHORT_RISK_PLAN_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION,

    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    ts: Date.now()
  };
}

async function postDiscord(content) {
  const cfg = discordConfig();

  if (!cfg.enabled || !cfg.webhookUrl) {
    return {
      ok: true,
      skipped: true,
      reason: 'DISCORD_DISABLED'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const response = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(content),
      signal: controller.signal
    });

    const responseText = await response.text().catch(() => '');

    return {
      ok: response.ok,
      status: response.status,
      response: response.ok ? undefined : truncate(responseText, 500)
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === 'AbortError'
        ? 'DISCORD_TIMEOUT'
        : error?.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function logDiscord(type, payload, result) {
  try {
    const cfg = discordConfig();
    const redis = getDurableRedis();

    await pushJsonLog(
      redis,
      SHORT_KEYS.discord.logList,
      {
        type,
        payload: compactPayload(payload),
        result,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false,
        redisNamespace: SHORT_NAMESPACE,
        redisKeyPrefix: SHORT_KEY_PREFIX,
        redisKey: SHORT_KEYS.discord.logList,
        persistentLearningKey: PERSISTENT_LEARNING_KEY,
        redisKeysSeparatedFromLongRoot: true,
        longRootTouched: false,
        ts: Date.now()
      },
      cfg.logLimit
    );
  } catch {
    // Discord logging mag trade execution nooit blokkeren.
  }
}

async function skipDiscord(type, payload = {}, reason = 'DISCORD_SKIPPED') {
  const selectedId = trueMicroFamilyId(payload);
  const isMM = isMicroMicroFamilyId(selectedId);

  const result = {
    ok: true,
    skipped: true,
    reason,
    detectedTradeSide: inferTradeSide(payload),
    source: normalizeSource(payload.source),
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    discordOnlyForExactTrueMicroMatch: true,
    selectionGranularity: isMM ? 'EXACT_MICRO_MICRO' : 'EXACT_75_CHILD',
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false
  };

  await logDiscord(type, payload, result);

  return result;
}

function entrySkipReason(entry = {}) {
  const selectedId = trueMicroFamilyId(entry);

  if (!isShortPayload(entry)) return 'DISCORD_SHORT_ONLY_SKIPPED_NON_SHORT';
  if (isMirrorPayload(entry)) return 'DISCORD_SKIPPED_MIRROR_PAYLOAD';
  if (isAnalysisOnlyPayload(entry)) return 'DISCORD_SKIPPED_ANALYSIS_ONLY';
  if (isRealOrderSource(entry)) return 'DISCORD_REAL_ORDER_SOURCE_BLOCKED';
  if (!isVirtualSource(entry)) return 'DISCORD_VIRTUAL_SOURCE_REQUIRED';
  if (entry.action && !isEntryAction(entry.action)) return 'DISCORD_SKIPPED_NOT_ENTRY_ACTION';
  if (!selectedId) return 'ENTRY_EXACT_MICRO_MICRO_OR_75_CHILD_ID_MISSING';
  if (!validLearningChildId(selectedId)) return 'ENTRY_ONLY_EXACT_MICRO_MICRO_OR_75_CHILD_ALLOWED';
  if (!hasSelectedMicroRotationMatch(entry)) return 'ENTRY_NOT_SELECTED_MANUAL_EXACT_MICRO_MICRO_OR_75_CHILD_MATCH';
  if (!hasValidShortTradeShape(entry)) return 'ENTRY_INVALID_SHORT_TRADE_SHAPE_TP_ENTRY_SL_REQUIRED';

  return 'ENTRY_NOT_ELIGIBLE';
}

function exitSkipReason(outcome = {}) {
  const selectedId = trueMicroFamilyId(outcome);

  if (!isShortPayload(outcome)) return 'DISCORD_SHORT_ONLY_SKIPPED_NON_SHORT';
  if (isMirrorPayload(outcome)) return 'DISCORD_SKIPPED_MIRROR_PAYLOAD';
  if (isAnalysisOnlyPayload(outcome)) return 'DISCORD_SKIPPED_ANALYSIS_ONLY';
  if (isRealOrderSource(outcome)) return 'DISCORD_REAL_ORDER_SOURCE_BLOCKED';
  if (!isVirtualSource(outcome)) return 'DISCORD_VIRTUAL_SOURCE_REQUIRED';
  if (!selectedId) return 'EXIT_EXACT_MICRO_MICRO_OR_75_CHILD_ID_MISSING';
  if (!validLearningChildId(selectedId)) return 'EXIT_ONLY_EXACT_MICRO_MICRO_OR_75_CHILD_ALLOWED';
  if (!hasSelectedMicroRotationMatch(outcome)) return 'EXIT_NOT_SELECTED_MANUAL_EXACT_MICRO_MICRO_OR_75_CHILD_MATCH';

  return 'EXIT_NOT_ELIGIBLE';
}

function entryReasonText(entry = {}) {
  const statsSample = completedSample(entry);
  const wr = bestWinrate(entry);
  const avgR = statValue(entry, 'avgR');
  const totalR = statValue(entry, 'totalR');
  const avgCostR = statValue(entry, 'avgCostR');
  const selectedId = trueMicroFamilyId(entry);
  const isMM = isMicroMicroFamilyId(selectedId);

  return [
    isMM ? 'MANUAL_MICRO_MICRO_EXACT_MATCH' : 'MANUAL_75_CHILD_TRUE_MICRO_MATCH',
    `SOURCE=${SOURCE_VIRTUAL}`,
    `WR=${fmtPctSmart(wr)}`,
    `SAMPLE=${fmtNumber(statsSample, 2)}`,
    `AVG_R=${fmtR(avgR)}`,
    `TOTAL_R=${fmtR(totalR)}`,
    `AVG_COST_R=${fmtR(avgCostR)}`
  ].join(' | ');
}

export async function sendEntryAlert(entry = {}) {
  if (!shouldSendEntryAlert(entry)) {
    return skipDiscord(
      'ENTRY_SKIPPED',
      entry,
      entrySkipReason(entry)
    );
  }

  const symbol = displaySymbol(entry);
  const side = normalizeSideLabel(entry);
  const directionEmoji = tradeDirectionEmoji(entry);
  const reason = entryReasonText(entry);

  const content = {
    username: 'Trade Alerts',
    embeds: [
      {
        title: `${directionEmoji} ${side} — ${symbol}`,
        color: discordColorForSide(entry),
        description: [
          `Entry   ${fmtPrice(entry.entry)}`,
          `TP      ${fmtPrice(entry.tp)}`,
          `SL      ${fmtPrice(entry.sl ?? entry.initialSl)}`,
          '',
          reason
        ].join('\n'),
        footer: {
          text: CUSTOMER_DISCLAIMER
        },
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('ENTRY', {
    ...entry,
    source: SOURCE_VIRTUAL,
    outcomeSource: SOURCE_VIRTUAL,
    virtualOnly: true,
    virtualTracked: true,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    trueMicroFamilySchema: isMicroMicroFamilyId(trueMicroFamilyId(entry)) ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION
  }, result);

  return result;
}

export async function sendExitAlert(outcome = {}) {
  if (!shouldSendExitAlert(outcome)) {
    return skipDiscord(
      'EXIT_SKIPPED',
      outcome,
      exitSkipReason(outcome)
    );
  }

  const symbol = displaySymbol(outcome);
  const side = normalizeSideLabel(outcome);
  const exitPrice = extractExitPrice(outcome);
  const resultR = resultRForDiscord(outcome);
  const exitType = exitTypeLabel(outcome);
  const emoji = exitEmoji(exitType, resultR);
  const reason = customerExitReason(exitType);

  const content = {
    username: 'Trade Alerts',
    embeds: [
      {
        title: `${emoji} ${side} gesloten — ${symbol}`,
        color: discordColorForResult(resultR),
        description: [
          `Exit      ${fmtPrice(exitPrice)}`,
          `Resultaat ${fmtR(resultR)}  (${reason})`
        ].join('\n'),
        footer: {
          text: CUSTOMER_DISCLAIMER
        },
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('EXIT', {
    ...outcome,
    source: SOURCE_VIRTUAL,
    outcomeSource: SOURCE_VIRTUAL,
    virtualOnly: true,
    virtualTracked: true,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    trueMicroFamilySchema: isMicroMicroFamilyId(trueMicroFamilyId(outcome)) ? MICRO_MICRO_SCHEMA : TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION
  }, result);

  return result;
}

function exactSelectedIdsFromRotation(rotation = {}) {
  return uniqueStrings([
    rotation.trueMicroFamilyIds || [],
    rotation.childTrueMicroFamilyIds || [],
    rotation.microFamilyIds || [],
    rotation.activeMicroFamilyIds || [],
    rotation.activeTrueMicroFamilyIds || [],

    rotation.microMicroFamilyIds || [],
    rotation.trueMicroMicroFamilyIds || [],
    rotation.exactMicroMicroFamilyIds || [],
    rotation.activeMicroMicroFamilyIds || [],
    rotation.activeTrueMicroMicroFamilyIds || [],

    Array.isArray(rotation.microFamilies)
      ? rotation.microFamilies.map((row) => trueMicroFamilyId(row))
      : []
  ])
    .map(upper)
    .map((id) => {
      const parsed = parseShortTaxonomyMicroId(id);
      return parsed.selectable ? parsed.trueMicroFamilyId : null;
    })
    .filter(Boolean)
    .filter(validLearningChildId);
}

function bestShortId(rotation = {}) {
  const candidates = [
    trueMicroFamilyId(rotation.bestShort || {}),
    rotation.selectedTrueMicroFamilyId,
    rotation.selectedMicroFamilyId,
    rotation.selectedMicroMicroFamilyId,
    rotation.selectedTrueMicroMicroFamilyId,
    ...exactSelectedIdsFromRotation(rotation)
  ];

  for (const candidate of candidates) {
    const value = upper(candidate);

    if (validLearningChildId(value)) return value;
  }

  return 'NA';
}

function shouldSendRotationReport(rotation = {}, label = '') {
  const cfg = discordConfig();

  if (!cfg.sendRotationReports) return false;

  const normalizedLabel = upper(label);

  if (normalizedLabel.includes('NEXT_ROTATION_READY')) return false;
  if (rotation.autoRotation === true && rotation.liveSelectable !== true) return false;
  if (rotation.empty === true) return false;

  const selectedIds = exactSelectedIdsFromRotation(rotation);

  if (selectedIds.length === 0) return false;

  return Boolean(
    rotation.manualOnly === true ||
    rotation.adminSelected === true ||
    rotation.liveSelectable === true
  );
}

export async function sendWeeklyRotationReport(rotationInput = {}, label = 'WEEKLY_ROTATION') {
  const rotation =
    rotationInput.rotation ||
    rotationInput.activeRotation ||
    rotationInput.nextRotation ||
    rotationInput;

  if (!shouldSendRotationReport(rotation, label)) {
    return skipDiscord(
      'WEEKLY_ROTATION_SKIPPED',
      {
        ...rotation,
        bestLong: null,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      },
      'ROTATION_REPORT_DISABLED_OR_NOT_MANUAL_LIVE_SELECTABLE_EXACT_MICRO_MICRO_OR_75_CHILD'
    );
  }

  const selectedIds = exactSelectedIdsFromRotation(rotation);

  const childIds = uniqueStrings(
    selectedIds
      .map((id) => parseShortTaxonomyMicroId(id).childTrueMicroFamilyId)
      .filter(Boolean)
  );

  const microMicroIds = selectedIds.filter(isMicroMicroFamilyId);

  const parentIds = uniqueStrings(
    selectedIds
      .map((id) => parseShortTaxonomyMicroId(id).parentTrueMicroFamilyId)
      .filter(Boolean)
  );

  const week =
    rotation.sourceWeekKey ||
    rotation.activeWeekKey ||
    rotation.weekKey ||
    PERSISTENT_LEARNING_KEY;

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${label} SHORT MANUAL MICRO SET`,
        color: 0x7c3aed,
        fields: [
          field('Selected count', String(selectedIds.length), true),
          field('Micro-micro count', String(microMicroIds.length), true),
          field('75-child count', String(childIds.length), true),
          field('Parent-15 count', String(parentIds.length), true),
          field('Mode', rotation.mode || 'NA', true),
          field('Week', week, true),
          field('Best SHORT selected', bestShortId(rotation), false),
          field('Manual only', String(Boolean(rotation.manualOnly)), true),
          field('Live selectable', String(Boolean(rotation.liveSelectable)), true),
          field('Long disabled', 'true', true),
          field('Schema', MICRO_MICRO_SCHEMA, true),
          field('Learning key', PERSISTENT_LEARNING_KEY, true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('WEEKLY_ROTATION', {
    ...rotation,
    bestLong: null,
    trueMicroFamilyIds: selectedIds,
    childTrueMicroFamilyIds: childIds,
    microMicroFamilyIds: microMicroIds,
    trueMicroMicroFamilyIds: microMicroIds,
    parentTrueMicroFamilyIds: parentIds,
    macroFamilyIds: parentIds,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    microMicroFamilySchema: MICRO_MICRO_SCHEMA,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION
  }, result);

  return result;
}

export async function sendResetReport(report = {}) {
  const cfg = discordConfig();

  if (!cfg.sendResetReports) {
    return skipDiscord('RESET_SKIPPED', report, 'RESET_REPORTS_DISABLED');
  }

  const deletedCount = Object.keys(report.deleted || {}).length;

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `RESET ${report.type || 'UNKNOWN'}`,
        color: report.ok ? 0xf59e0b : 0xdc2626,
        fields: [
          field('OK', String(Boolean(report.ok)), true),
          field('Reason', report.reason || 'OK', true),
          field('Deleted', String(deletedCount), true),
          field('Short only', 'true', true),
          field('Long disabled', 'true', true),
          field('Redis namespace', SHORT_NAMESPACE, true),
          field('Learning key', PERSISTENT_LEARNING_KEY, true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('RESET', {
    ...report,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    positionMeasurementFixVersion: POSITION_MEASUREMENT_FIX_VERSION,
    riskPlanVersion: SHORT_RISK_PLAN_VERSION,
    microMicroVersion: MICRO_MICRO_VERSION
  }, result);

  return result;
}