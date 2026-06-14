// ================= FILE: src/analyze/rotationEngine.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { getWeekMicros, saveWeekMicros } from './analyzeEngine.js';
import { rankMicros, refreshStats } from './scoring.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const ROTATION_SIDES = [TARGET_TRADE_SIDE];

const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const DEFAULT_TOP_N_PER_SIDE = 1;
const MAX_TOP_N_PER_SIDE = 160;
const DEFAULT_MIN_WEIGHTED_COMPLETED = 0.35;
const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE = 25;

const EXECUTION_MICRO_SUFFIX = 'XR';

const FIXED_TAXONOMY_SETUP_TYPES = new Set([
  'BREAKDOWN',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION',
  'COMPRESSION_EXPANSION'
]);

const FIXED_TAXONOMY_REGIME_BUCKETS = new Set([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const FIXED_TAXONOMY_CONFIRMATION_PROFILES = new Set([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const MANUAL_ACTIVE_SOURCES = new Set([
  'ADMIN_MANUAL_SELECTION_SHORT_TRUE_MICRO_ONLY',
  'ADMIN_ACTIVATE_SELECTED_SHORT_TRUE_MICROS',
  'ADMIN_ACTIVATE_SELECTED_SHORT_MACRO_EXPANDED_TRUE_MICROS',
  'ADMIN_ACTIVATE_TOP_SHORT_TRUE_MICROS',
  'ADMIN_ACTIVATE_TOP_BALANCED_SHORT_TRUE_MICROS',
  'CLI_MANUAL_SELECTION_SHORT_ONLY',
  'CLI_MANUAL_SHORT_MICRO_FAMILY_DISCORD_SELECTION'
]);

function now() {
  return Date.now();
}

function learningDataKey() {
  const configured = String(
    CONFIG.analyze?.persistentLearningKey ||
    CONFIG.analyze?.learningKey ||
    CONFIG.rotation?.learningKey ||
    PERSISTENT_LEARNING_KEY
  ).trim();

  return configured || PERSISTENT_LEARNING_KEY;
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

function normalizeSchema(value) {
  return String(value || '').trim().toUpperCase();
}

function schemaMeta() {
  const macroSchema = normalizeSchema(
    CONFIG.analyze?.macroSchema ||
    CONFIG.analyze?.legacySchema ||
    CONFIG.analyze?.schema ||
    'MF_V1'
  );

  const microSchema = normalizeSchema(
    CONFIG.analyze?.microSchema ||
    'MF_V2'
  );

  return {
    schema: normalizeSchema(CONFIG.analyze?.schema || microSchema),
    macroSchema,
    microSchema,
    strategyVersion: CONFIG.strategyVersion
  };
}

function minWeightedCompleted() {
  return Math.max(
    0,
    safeNumber(CONFIG.rotation?.minWeightedCompleted, DEFAULT_MIN_WEIGHTED_COMPLETED)
  );
}

function topNPerSide() {
  const preferred =
    CONFIG.rotation?.topNShort ??
    CONFIG.rotation?.topNPerSide ??
    DEFAULT_TOP_N_PER_SIDE;

  const n = Math.floor(Number(preferred));

  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_N_PER_SIDE;

  return Math.max(1, Math.min(MAX_TOP_N_PER_SIDE, n));
}

function maxPerMacroFamily() {
  if (CONFIG.rotation?.enforceMaxPerMacroFamily !== true) return 0;

  const n = Number(CONFIG.rotation?.maxPerMacroFamily || 0);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
}

function minPrimaryRowsForPreviousMerge() {
  const n = Number(CONFIG.rotation?.minPrimaryRowsForPreviousMerge || 0);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE;
}

function defaultRotationMode() {
  return CONFIG.rotation?.mode || 'balanced';
}

function allowManualUnknownTrueMicroIds() {
  return CONFIG.rotation?.allowManualUnknownTrueMicroIds !== false;
}

function allowSoftRotationFallback() {
  return CONFIG.rotation?.allowSoftRotationFallback !== false;
}

function allowObservationRotationFallback() {
  return CONFIG.rotation?.allowObservationRotationFallback !== false;
}

function allowRawRotationFallback() {
  return CONFIG.rotation?.allowRawRotationFallback !== false;
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
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

function hasLongSignal(value = '') {
  return hasSignalPattern(value, [
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

function hasShortSignal(value = '') {
  return hasSignalPattern(value, [
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

function isScannerFamilyId(id = '') {
  const value = String(id || '').toUpperCase();

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
  const value = String(id || '').toUpperCase();

  return (
    value.includes(`_${EXECUTION_MICRO_SUFFIX}_`) ||
    value.includes('_XR_')
  );
}

function parseFixedTaxonomyMicroId(id = '') {
  const value = String(id || '').trim().toUpperCase();
  const prefix = `MICRO_${TARGET_TRADE_SIDE}_`;

  if (!value) return null;
  if (isScannerFamilyId(value)) return null;
  if (isExecutionFingerprintId(value)) return null;
  if (!value.startsWith(prefix)) return null;

  if (
    value.includes('_MF_V1_') ||
    value.includes('_MF_V2_') ||
    value.includes('_MF_V3_') ||
    value.includes('*MF_V1*') ||
    value.includes('*MF_V2*') ||
    value.includes('*MF_V3*')
  ) {
    return null;
  }

  let rest = value.slice(prefix.length);
  let confirmationProfile = null;

  const profiles = [...FIXED_TAXONOMY_CONFIRMATION_PROFILES]
    .sort((a, b) => b.length - a.length);

  for (const profile of profiles) {
    const suffix = `_${profile}`;

    if (rest.endsWith(suffix)) {
      confirmationProfile = profile;
      rest = rest.slice(0, rest.length - suffix.length);
      break;
    }
  }

  const regimes = [...FIXED_TAXONOMY_REGIME_BUCKETS]
    .sort((a, b) => b.length - a.length);

  for (const regime of regimes) {
    const suffix = `_${regime}`;

    if (rest.endsWith(suffix)) {
      const setupType = rest.slice(0, rest.length - suffix.length);

      if (!FIXED_TAXONOMY_SETUP_TYPES.has(setupType)) return null;

      return {
        id: value,
        setupType,
        regimeBucket: regime,
        confirmationProfile,
        taxonomyFamilyCount: confirmationProfile ? 75 : 15
      };
    }
  }

  return null;
}

function isFixedTaxonomyMicroId(id = '') {
  return Boolean(parseFixedTaxonomyMicroId(id));
}

function cleanLearningMicroId(id = '') {
  const value = String(id || '').trim().toUpperCase();

  if (!value) return '';
  if (isScannerFamilyId(value)) return '';
  if (isExecutionFingerprintId(value)) return '';

  return value;
}

function rowId(row = {}) {
  return cleanLearningMicroId(
    row.trueMicroFamilyId ||
    row.microFamilyId ||
    row.analyzeMicroFamilyId ||
    row.learningMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  );
}

function rowIdUpper(row = {}) {
  return rowId(row).toUpperCase();
}

function idLooksLikeMicroFamily(id = '') {
  const value = String(id || '').toUpperCase();

  if (!value) return false;
  if (isScannerFamilyId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;

  return value.startsWith('MICRO_');
}

function idLooksLikeLongFamily(id = '') {
  return hasLongSignal(id);
}

function idLooksLikeShortFamily(id = '') {
  return hasShortSignal(id);
}

function idLooksLikeSimpleMacroFamily(id = '') {
  const value = String(id || '').trim().toUpperCase();

  return (
    /^SHORT_\d+$/u.test(value) ||
    /^SHORT_F\d+$/u.test(value) ||
    /^SHORT_F_\d+$/u.test(value)
  );
}

function hasSchemaInId(id, schema) {
  const s = normalizeSchema(schema);
  const value = String(id || '').toUpperCase();

  if (!s) return false;

  return (
    value.includes(`_${s}_`) ||
    value.endsWith(`_${s}`) ||
    value.includes(`|SCHEMA=${s}`) ||
    value.includes(`SCHEMA=${s}`)
  );
}

function definitionText(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');
}

function definitionHasOwnSchema(row = {}, schema) {
  const s = normalizeSchema(schema);

  if (!s) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : [])
  ];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${s}`)) {
    return true;
  }

  return String(row.definition || row.microDefinition || '').toUpperCase().includes(`SCHEMA=${s}`);
}

function rowSchema(row = {}) {
  return normalizeSchema(
    row.microFamilySchema ||
    row.schema ||
    row.versionSchema ||
    ''
  );
}

function hasParentMacro(row = {}) {
  return Boolean(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId
  );
}

function parentMacroFamilyId(row = {}) {
  const direct = String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    ''
  ).trim();

  if (direct && !isScannerFamilyId(direct) && !isExecutionFingerprintId(direct)) {
    return direct;
  }

  const familyId = String(row.familyId || '').trim();

  if (familyId && /^SHORT_\d+$/i.test(familyId)) return familyId;
  if (familyId && /^SHORT_F\d+$/i.test(familyId)) return familyId;
  if (familyId && /^SHORT_F_\d+$/i.test(familyId)) return familyId;

  const id = rowId(row);

  if (idLooksLikeSimpleMacroFamily(id)) return id;

  return '';
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

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
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function directSide(row = {}) {
  const values = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.entrySide,
    row.side
  ];

  for (const value of values) {
    const side = normalizeDirectSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  return 'UNKNOWN';
}

function definitionSide(row = {}) {
  const text = definitionText(row);
  const shortHit = hasShortSignal(text);
  const longHit = hasLongSignal(text);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function microSide(row = {}) {
  const direct = directSide(row);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const familyId = String(row.familyId || '').toUpperCase();
  const macroId = String(parentMacroFamilyId(row) || '').toUpperCase();
  const microId = rowIdUpper(row);

  if (familyId.startsWith('LONG_')) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeLongFamily(macroId) && !idLooksLikeShortFamily(macroId)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeLongFamily(microId) && !idLooksLikeShortFamily(microId)) return OPPOSITE_TRADE_SIDE;

  if (familyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;
  if (macroId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(macroId)) return TARGET_TRADE_SIDE;
  if (idLooksLikeShortFamily(microId)) return TARGET_TRADE_SIDE;

  const fromDefinition = definitionSide(row);

  if (fromDefinition === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (fromDefinition === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function normalizedSide(row = {}) {
  const side = microSide(row);

  if (side === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return 'unknown';
}

function isShortRotationRow(row = {}) {
  return microSide(row) === TARGET_TRADE_SIDE;
}

function trueMicroSchemaForId(id = '', row = {}) {
  if (isFixedTaxonomyMicroId(id)) return 'FIXED_TAXONOMY';

  return row.trueMicroFamilySchema ||
    row.broadTrueMicroFamilySchema ||
    row.microFamilySchema ||
    row.schema ||
    schemaMeta().microSchema;
}

export function isTrueMicroFamily(row = {}) {
  const { microSchema, macroSchema } = schemaMeta();

  const id = rowIdUpper(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isScannerFamilyId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isShortRotationRow(row)) return false;

  if (isFixedTaxonomyMicroId(id)) return true;

  if (row.isLegacyMacro === true) return false;
  if (idLooksLikeSimpleMacroFamily(id)) return false;
  if (version.includes('MACRO')) return false;
  if (schema === macroSchema) return false;
  if (hasSchemaInId(id, macroSchema)) return false;
  if (definitionHasOwnSchema(row, macroSchema)) return false;

  if (row.trueMicro === true || row.isTrueMicro === true) return true;
  if (version.includes('MICRO')) return true;
  if (schema === microSchema) return true;
  if (schema === 'FIXED_TAXONOMY') return true;
  if (hasSchemaInId(id, microSchema)) return true;
  if (id.includes('_MF_V2_') || id.includes('_MF_V3_')) return true;
  if (definitionHasOwnSchema(row, microSchema)) return true;

  if (hasParentMacro(row) && idLooksLikeMicroFamily(id)) return true;

  return false;
}

export function isLegacyMacroFamily(row = {}) {
  const { macroSchema } = schemaMeta();

  const id = rowIdUpper(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (isScannerFamilyId(id)) return false;
  if (isExecutionFingerprintId(id)) return false;
  if (!isShortRotationRow(row)) return false;
  if (isFixedTaxonomyMicroId(id)) return false;
  if (isTrueMicroFamily(row)) return false;

  if (row.isLegacyMacro === true) return true;
  if (version.includes('MACRO')) return true;
  if (idLooksLikeSimpleMacroFamily(id)) return true;
  if (schema === macroSchema) return true;
  if (hasSchemaInId(id, macroSchema)) return true;
  if (definitionHasOwnSchema(row, macroSchema)) return true;

  return !row.parentMacroFamilyId && !row.parentMicroFamilyId;
}

function isKnownTrueMicroId(id = '') {
  const { microSchema, macroSchema } = schemaMeta();
  const value = cleanLearningMicroId(id);

  if (!value) return false;
  if (isScannerFamilyId(value)) return false;
  if (isExecutionFingerprintId(value)) return false;
  if (!idLooksLikeShortFamily(value)) return false;
  if (idLooksLikeLongFamily(value) && !idLooksLikeShortFamily(value)) return false;
  if (!idLooksLikeMicroFamily(value)) return false;

  if (isFixedTaxonomyMicroId(value)) return true;

  if (idLooksLikeSimpleMacroFamily(value)) return false;
  if (hasSchemaInId(value, macroSchema)) return false;
  if (value.includes('_MF_V1_')) return false;

  return (
    hasSchemaInId(value, microSchema) ||
    value.includes('_MF_V2_') ||
    value.includes('_MF_V3_')
  );
}

function isEligible(row = {}) {
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return safeNumber(row.completed, 0) >= minWeightedCompleted();
}

function isSoftEligible(row = {}) {
  if (!allowSoftRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const completed = safeNumber(row.completed, 0);
  const balancedScore = safeNumber(
    row.dashboardBalancedScore ?? row.balancedScore,
    0
  );

  if (completed <= 0) return false;
  if (balancedScore <= 0) return false;

  return (
    safeNumber(row.avgR, 0) > 0 ||
    safeNumber(row.totalR, 0) > 0 ||
    safeNumber(row.fairWinrate, 0) > 0 ||
    safeNumber(row.sampleAdjustedWinrate, 0) > 0 ||
    safeNumber(row.wilsonLowerBound, 0) > 0 ||
    safeNumber(row.sampleWilsonLowerBound, 0) > 0
  );
}

function isObservationEligible(row = {}) {
  if (!allowObservationRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const seen = safeNumber(row.seen, 0);
  const observations = safeNumber(row.observations, 0);
  const winrateSample = safeNumber(row.winrateSample, 0);
  const completed = safeNumber(row.completed, 0);

  return Math.max(seen, observations, winrateSample, completed) > 0;
}

function isRawFallbackEligible(row = {}) {
  if (!allowRawRotationFallback()) return false;
  if (!isShortRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return true;
}

function rotationEligibilityTier(row = {}) {
  if (isEligible(row)) return 'HARD';
  if (isSoftEligible(row)) return 'SOFT';
  if (isObservationEligible(row)) return 'OBSERVATION';
  if (isRawFallbackEligible(row)) return 'RAW';

  return 'NONE';
}

function isManualEligible(row = {}) {
  return isShortRotationRow(row) && isTrueMicroFamily(row);
}

function isManualActiveRotation(rotation = {}) {
  if (!rotation || typeof rotation !== 'object') return false;

  const source = String(rotation.source || '').trim().toUpperCase();
  const mode = String(rotation.mode || '').trim().toUpperCase();

  if (rotation.manualOnly === true) return true;
  if (rotation.adminSelected === true) return true;
  if (mode === 'MANUAL' || mode === 'SELECTED') return true;
  if (source.includes('MANUAL')) return true;
  if (source.includes('SELECTED')) return true;
  if (source.startsWith('ADMIN_')) return true;
  if (source.startsWith('CLI_MANUAL')) return true;
  if (MANUAL_ACTIVE_SOURCES.has(source)) return true;

  return false;
}

function compactRotationRow(row = {}, rank = 0) {
  const refreshed = refreshStats(row);
  const side = normalizedSide(refreshed);
  const tradeSide = microSide(refreshed);
  const macroId = parentMacroFamilyId(refreshed);
  const eligibilityTier = rotationEligibilityTier(refreshed);
  const meta = schemaMeta();

  const microFamilyId = cleanLearningMicroId(
    refreshed.trueMicroFamilyId ||
    refreshed.microFamilyId ||
    refreshed.analyzeMicroFamilyId ||
    refreshed.learningMicroFamilyId ||
    refreshed.id ||
    ''
  );

  const taxonomy = parseFixedTaxonomyMicroId(microFamilyId);

  return {
    rank,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    familyId: refreshed.familyId || null,

    macroFamilyId: macroId || refreshed.macroFamilyId || null,
    parentMacroFamilyId: macroId || null,
    parentMicroFamilyId: refreshed.parentMicroFamilyId || macroId || null,

    side,
    tradeSide,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    schema: trueMicroSchemaForId(microFamilyId, refreshed),
    microFamilySchema: refreshed.microFamilySchema || refreshed.schema || meta.microSchema,
    trueMicroFamilySchema: trueMicroSchemaForId(microFamilyId, refreshed),
    broadTrueMicroFamilySchema: refreshed.broadTrueMicroFamilySchema || trueMicroSchemaForId(microFamilyId, refreshed),
    version: refreshed.version || (taxonomy ? 'fixed-taxonomy-micro' : 'micro'),

    isTrueMicro: isTrueMicroFamily(refreshed),
    isLegacyMacro: isLegacyMacroFamily(refreshed),

    fixedTaxonomyLearningId: Boolean(refreshed.fixedTaxonomyLearningId || taxonomy),
    taxonomyFamilyCount: taxonomy?.taxonomyFamilyCount || refreshed.taxonomyFamilyCount || null,

    setupType: refreshed.setupType || taxonomy?.setupType || null,
    regimeBucket: refreshed.regimeBucket || taxonomy?.regimeBucket || null,
    confirmationProfile: refreshed.confirmationProfile || refreshed.confirmationBucket || taxonomy?.confirmationProfile || null,

    fineMicroFamilyId: refreshed.fineMicroFamilyId || refreshed.narrowMicroFamilyId || refreshed.mfV2MicroFamilyId || null,
    narrowMicroFamilyId: refreshed.narrowMicroFamilyId || refreshed.fineMicroFamilyId || refreshed.mfV2MicroFamilyId || null,
    mfV2MicroFamilyId: refreshed.mfV2MicroFamilyId || refreshed.fineMicroFamilyId || refreshed.narrowMicroFamilyId || null,

    executionFingerprintHash: refreshed.executionFingerprintHash || null,
    executionMicroFamilyId: refreshed.executionMicroFamilyId || null,
    executionFingerprintRole: refreshed.executionFingerprintRole || 'METADATA_ONLY',

    scannerMicroFamilyId: refreshed.scannerMicroFamilyId || null,
    scannerFamilyId: refreshed.scannerFamilyId || null,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,

    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    exactTrueMicroFamilyRequired: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    symbolExcludedFromFamilyId: true,

    rotationEligibilityTier: eligibilityTier,
    rotationEligible: eligibilityTier !== 'NONE',
    hardEligible: eligibilityTier === 'HARD',
    softEligible: eligibilityTier === 'SOFT',
    observationEligible: eligibilityTier === 'OBSERVATION',
    rawEligible: eligibilityTier === 'RAW',

    learningStatus: refreshed.learningStatus || refreshed.status || null,
    status: refreshed.status || refreshed.learningStatus || null,
    awaitingOutcomes: Boolean(refreshed.awaitingOutcomes),
    tooEarly: Boolean(refreshed.tooEarly),
    minCompletedForActiveLearning: safeNumber(refreshed.minCompletedForActiveLearning, 20),

    seen: safeNumber(refreshed.seen, 0),
    observations: safeNumber(refreshed.observations ?? refreshed.seen, 0),

    completed: safeNumber(refreshed.completed, 0),
    realCompleted: 0,
    virtualCompleted: safeNumber(refreshed.virtualCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    winrateSample: safeNumber(refreshed.winrateSample ?? refreshed.completed, 0),
    winrate: safeNumber(refreshed.winrate, 0),
    bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
    wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
    sampleWilsonLowerBound: safeNumber(
      refreshed.sampleWilsonLowerBound ?? refreshed.wilsonLowerBound,
      0
    ),
    fairWinrate: safeNumber(refreshed.fairWinrate, 0),
    sampleAdjustedWinrate: safeNumber(refreshed.sampleAdjustedWinrate, 0),
    sampleReliability: safeNumber(refreshed.sampleReliability, 0),

    wins: safeNumber(refreshed.wins, 0),
    losses: safeNumber(refreshed.losses, 0),
    flats: safeNumber(refreshed.flats, 0),

    virtualWins: safeNumber(refreshed.virtualWins, 0),
    virtualLosses: safeNumber(refreshed.virtualLosses, 0),
    virtualFlats: safeNumber(refreshed.virtualFlats, 0),

    shadowWins: safeNumber(refreshed.shadowWins, 0),
    shadowLosses: safeNumber(refreshed.shadowLosses, 0),
    shadowFlats: safeNumber(refreshed.shadowFlats, 0),

    avgR: safeNumber(refreshed.avgR, 0),
    totalR: safeNumber(refreshed.totalR, 0),
    virtualTotalR: safeNumber(refreshed.virtualTotalR, 0),
    shadowTotalR: safeNumber(refreshed.shadowTotalR, 0),
    avgWinR: safeNumber(refreshed.avgWinR, 0),
    avgLossR: safeNumber(refreshed.avgLossR, 0),

    profitFactor: safeNumber(refreshed.profitFactor, 0),
    directSLPct: safeNumber(refreshed.directSLPct, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),
    reachedHalfRPct: safeNumber(refreshed.reachedHalfRPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),

    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),

    totalCostR: safeNumber(refreshed.totalCostR, 0),
    avgCostR: safeNumber(refreshed.avgCostR, 0),

    balancedScore: safeNumber(refreshed.balancedScore, 0),
    dashboardBalancedScore: safeNumber(
      refreshed.dashboardBalancedScore ?? refreshed.balancedScore,
      0
    ),

    assetClass: refreshed.assetClass || null,

    rsiZone: refreshed.rsiZone || null,
    rsiCoarse: refreshed.rsiCoarse || null,

    flow: refreshed.flow || null,
    flowCoarse: refreshed.flowCoarse || null,

    obRelation: refreshed.obRelation || null,

    btcState: refreshed.btcState || null,
    btcRelation: refreshed.btcRelation || null,

    regime: refreshed.regime || null,
    regimeCoarse: refreshed.regimeCoarse || null,

    scannerReason: refreshed.scannerReason || null,
    scannerReasonCoarse: refreshed.scannerReasonCoarse || null,

    definitionParts: Array.isArray(refreshed.definitionParts)
      ? refreshed.definitionParts
      : [],

    definition: refreshed.definition || '',

    parentDefinitionParts: Array.isArray(refreshed.parentDefinitionParts)
      ? refreshed.parentDefinitionParts
      : [],

    parentDefinition: refreshed.parentDefinition || '',

    counters: refreshed.counters || {},
    examples: Array.isArray(refreshed.examples)
      ? refreshed.examples.slice(0, 20)
      : [],

    recentOutcomes: Array.isArray(refreshed.recentOutcomes)
      ? refreshed.recentOutcomes.slice(0, 20)
      : []
  };
}

function canUseMacroSlot({
  row,
  countsByMacro
}) {
  const macroCap = maxPerMacroFamily();

  if (macroCap <= 0) return true;

  const macroId = parentMacroFamilyId(row);

  if (!macroId) return true;

  return safeNumber(countsByMacro[macroId], 0) < macroCap;
}

function reserveMacroSlot({
  row,
  countsByMacro
}) {
  const macroId = parentMacroFamilyId(row);

  if (!macroId) return;

  countsByMacro[macroId] = safeNumber(countsByMacro[macroId], 0) + 1;
}

function addSelectedRow({
  row,
  selected,
  selectedIds,
  countsBySide,
  countsByMacro
}) {
  const id = cleanLearningMicroId(
    row?.trueMicroFamilyId ||
    row?.microFamilyId ||
    row?.id ||
    ''
  );

  const side = microSide(row);

  if (!id) return false;
  if (selectedIds.has(id)) return false;
  if (side !== TARGET_TRADE_SIDE) return false;
  if (!isTrueMicroFamily({ ...row, microFamilyId: id, trueMicroFamilyId: id })) return false;
  if (!canUseMacroSlot({ row, countsByMacro })) return false;

  selectedIds.add(id);
  countsBySide[TARGET_TRADE_SIDE] = safeNumber(countsBySide[TARGET_TRADE_SIDE], 0) + 1;
  reserveMacroSlot({ row, countsByMacro });

  selected.push({
    ...row,
    microFamilyId: id,
    trueMicroFamilyId: id,
    exactTrueMicroFamilyRequired: true
  });

  return true;
}

function buildSelectionState(existing = []) {
  const selected = [];
  const selectedIds = new Set();
  const countsBySide = {
    [TARGET_TRADE_SIDE]: 0
  };
  const countsByMacro = {};

  for (const row of existing) {
    addSelectedRow({
      row,
      selected,
      selectedIds,
      countsBySide,
      countsByMacro
    });
  }

  return {
    selected,
    selectedIds,
    countsBySide,
    countsByMacro
  };
}

function appendRowsToSelection({
  state,
  rows = [],
  targetCount = topNPerSide()
}) {
  for (const row of rows) {
    if (state.countsBySide[TARGET_TRADE_SIDE] >= targetCount) break;

    addSelectedRow({
      row,
      selected: state.selected,
      selectedIds: state.selectedIds,
      countsBySide: state.countsBySide,
      countsByMacro: state.countsByMacro
    });
  }

  return state.selected;
}

function hasSelectedSide(rows = [], side) {
  return rows.some((row) => microSide(row) === side);
}

function missingSides(rows = []) {
  return ROTATION_SIDES.filter((side) => !hasSelectedSide(rows, side));
}

function selectRotationCandidates(rankedCandidates = []) {
  const trueShortCandidates = rankedCandidates
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily);

  const hardEligible = trueShortCandidates.filter(isEligible);

  const softEligible = trueShortCandidates
    .filter((row) => !isEligible(row))
    .filter(isSoftEligible);

  const observationEligible = trueShortCandidates
    .filter((row) => !isEligible(row))
    .filter((row) => !isSoftEligible(row))
    .filter(isObservationEligible);

  const rawFallback = trueShortCandidates
    .filter((row) => !isEligible(row))
    .filter((row) => !isSoftEligible(row))
    .filter((row) => !isObservationEligible(row))
    .filter(isRawFallbackEligible);

  const targetCount = topNPerSide();
  const state = buildSelectionState();

  appendRowsToSelection({
    state,
    rows: hardEligible,
    targetCount
  });

  if (allowSoftRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: softEligible,
      targetCount
    });
  }

  if (allowObservationRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: observationEligible,
      targetCount
    });
  }

  if (allowRawRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: rawFallback,
      targetCount
    });
  }

  return {
    selected: state.selected,
    eligible: hardEligible,
    softEligible,
    observationEligible,
    rawFallback,

    usedSoftFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'SOFT'),
    usedObservationFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'OBSERVATION'),
    usedRawFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'RAW'),

    missingSides: missingSides(state.selected)
  };
}

function filterRankedRows(rows = [], filter = 'trueMicro') {
  const shortRows = rows.filter(isShortRotationRow);

  if (filter === 'all') return shortRows;
  if (filter === 'legacyMacro') return shortRows.filter(isLegacyMacroFamily);

  return shortRows.filter(isTrueMicroFamily);
}

function buildRankings(micros, { filter = 'trueMicro' } = {}) {
  const modes = [
    'balanced',
    'winrate',
    'totalR',
    'avgR',
    'directSL',
    'observed'
  ];

  return Object.fromEntries(
    modes.map((mode) => {
      const rows = filterRankedRows(rankMicros(micros, mode), filter)
        .slice(0, MAX_TOP_N_PER_SIDE)
        .map((row, index) => compactRotationRow(row, index + 1))
        .filter((row) => row.microFamilyId);

      return [mode, rows];
    })
  );
}

function buildSelectionIndexes(microFamilies = []) {
  const shortRows = microFamilies
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily);

  const microFamilyIds = uniqueStrings(
    shortRows.map((row) => cleanLearningMicroId(row.trueMicroFamilyId || row.microFamilyId))
  )
    .filter(isKnownTrueMicroId);

  const macroFamilyIds = uniqueStrings(
    shortRows.map((row) => (
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId
    ))
  ).filter(idLooksLikeShortFamily);

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of shortRows) {
    const microId = cleanLearningMicroId(row.trueMicroFamilyId || row.microFamilyId);
    const macroId = String(
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId ||
      ''
    ).trim();

    if (!microId || !macroId) continue;
    if (!isKnownTrueMicroId(microId)) continue;

    microToMacroFamilyId[microId] = macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(
      macroToMicroFamilyIds[macroId]
    ).filter(isKnownTrueMicroId);
  }

  return {
    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microToMacroFamilyId,
    macroToMicroFamilyIds,

    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false
  };
}

function countByPredicate(micros = {}, predicate) {
  return Object.values(micros || {}).filter(predicate).length;
}

function bestShortRow(rows = []) {
  return rows.find((row) => microSide(row) === TARGET_TRADE_SIDE) || null;
}

function mergeMicros(primary = {}, fallback = {}) {
  return {
    ...(fallback || {}),
    ...(primary || {})
  };
}

async function getRotationMicros(weekKey = getIsoWeekKey()) {
  const dataKey = learningDataKey();

  const persistent = await getWeekMicros(dataKey).catch(() => ({}));
  const persistentRows = Object.keys(persistent || {}).length;

  if (persistentRows > 0) {
    return {
      micros: persistent || {},
      dataWeekKey: dataKey,
      primaryWeekKey: dataKey,
      displayWeekKey: weekKey,
      previousWeekKey: null,
      primaryRows: persistentRows,
      previousRows: 0,
      usedPersistentLearningKey: true,
      usedPreviousWeekMerge: false
    };
  }

  const primary = await getWeekMicros(weekKey).catch(() => ({}));
  const primaryRows = Object.keys(primary || {}).length;

  const previousWeekKey = getPreviousIsoWeekKey();
  const shouldMergePrevious =
    weekKey !== previousWeekKey &&
    primaryRows < minPrimaryRowsForPreviousMerge();

  if (!shouldMergePrevious) {
    return {
      micros: primary || {},
      dataWeekKey: weekKey,
      primaryWeekKey: weekKey,
      displayWeekKey: weekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPersistentLearningKey: false,
      usedPreviousWeekMerge: false
    };
  }

  const previous = await getWeekMicros(previousWeekKey).catch(() => ({}));
  const previousRows = Object.keys(previous || {}).length;

  if (previousRows <= 0) {
    return {
      micros: primary || {},
      dataWeekKey: weekKey,
      primaryWeekKey: weekKey,
      displayWeekKey: weekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPersistentLearningKey: false,
      usedPreviousWeekMerge: false
    };
  }

  return {
    micros: mergeMicros(primary, previous),
    dataWeekKey: weekKey,
    primaryWeekKey: weekKey,
    displayWeekKey: weekKey,
    previousWeekKey,
    primaryRows,
    previousRows,
    usedPersistentLearningKey: false,
    usedPreviousWeekMerge: true
  };
}

function buildEmptyRotation({
  weekKey,
  activeWeekKey,
  dataWeekKey = learningDataKey(),
  mode,
  micros,
  ranked,
  eligible,
  softEligible = [],
  observationEligible = [],
  rawFallback = [],
  usedPersistentLearningKey = false,
  usedPreviousWeekMerge = false,
  primaryRows = 0,
  previousRows = 0,
  emptyReason = 'NO_SHORT_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
}) {
  const indexes = buildSelectionIndexes([]);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_short_candidate_snapshot`),
    source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_SHORT_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    usedLegacyFallback: false,
    usedSoftFallback: false,
    usedObservationFallback: false,
    usedRawFallback: false,
    usedPersistentLearningKey,
    usedPreviousWeekMerge,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    activationDisabled: true,
    manualSelectionRequired: true,
    liveSelectable: false,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible?.length || 0,
    softEligibleCount: softEligible?.length || 0,
    observationEligibleCount: observationEligible?.length || 0,
    rawFallbackCount: rawFallback?.length || 0,
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isShortRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isShortRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: [TARGET_TRADE_SIDE],

    empty: true,
    emptyReason,

    bestLong: null,
    bestShort: null,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies: [],

    rankings: buildRankings(micros, { filter: 'trueMicro' }),
    macroRankings: buildRankings(micros, { filter: 'legacyMacro' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function buildRotationFromWeek({
  weekKey = getIsoWeekKey(),
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const {
    micros,
    dataWeekKey,
    primaryRows,
    previousRows,
    usedPersistentLearningKey,
    usedPreviousWeekMerge
  } = await getRotationMicros(weekKey);

  const rankedAll = rankMicros(micros, mode)
    .filter(isShortRotationRow);

  const rankedTrueMicros = rankedAll
    .filter(isTrueMicroFamily);

  const rankedCandidates = rankedTrueMicros;

  const {
    selected,
    eligible,
    softEligible,
    observationEligible,
    rawFallback,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    missingSides: selectedMissingSides
  } = selectRotationCandidates(rankedCandidates);

  if (selected.length === 0) {
    return buildEmptyRotation({
      weekKey,
      activeWeekKey,
      dataWeekKey,
      mode,
      micros,
      ranked: rankedCandidates,
      eligible,
      softEligible,
      observationEligible,
      rawFallback,
      usedPersistentLearningKey,
      usedPreviousWeekMerge,
      primaryRows,
      previousRows,
      emptyReason: rankedTrueMicros.length === 0
        ? 'NO_SHORT_TRUE_MICRO_FAMILIES_FOUND'
        : 'NO_SHORT_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_CANDIDATE_SNAPSHOT'
    });
  }

  const microFamilies = selected
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.trueMicroFamilyId || row.microFamilyId));

  const indexes = buildSelectionIndexes(microFamilies);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_short_candidate_snapshot`),
    source: 'ANALYZE_WEEKLY_CANDIDATE_SNAPSHOT_SHORT_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    usedLegacyFallback: false,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    usedPersistentLearningKey,
    usedPreviousWeekMerge,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    activationDisabled: true,
    manualSelectionRequired: true,
    liveSelectable: false,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible.length,
    softEligibleCount: softEligible.length,
    observationEligibleCount: observationEligible.length,
    rawFallbackCount: rawFallback.length,
    rankedCount: rankedCandidates.length,
    allRankedCount: rankedAll.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isShortRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isShortRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: selectedMissingSides,

    empty: false,
    emptyReason: null,

    bestLong: null,
    bestShort: bestShortRow(microFamilies),

    candidateMicroFamilyIds: indexes.microFamilyIds,
    candidateMacroFamilyIds: indexes.macroFamilyIds,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies,

    rankings: buildRankings(micros, { filter: 'trueMicro' }),
    macroRankings: buildRankings(micros, { filter: 'legacyMacro' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function freezeWeeklyRotation({
  weekKey = getIsoWeekKey(),
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const redis = getDurableRedis();
  const dataKey = learningDataKey();

  const micros = await getWeekMicros(dataKey).catch(() => ({}));

  if (Object.keys(micros || {}).length > 0) {
    await saveWeekMicros(dataKey, micros);
  }

  const rotation = await buildRotationFromWeek({
    weekKey,
    activeWeekKey,
    mode
  });

  await setJson(
    redis,
    KEYS.analyze.nextRotation,
    rotation
  );

  await setJson(
    redis,
    KEYS.analyze.rotationValidFrom,
    {
      validFrom: `${activeWeekKey}_MONDAY_00_UTC`,
      ts: now(),
      sourceWeekKey: weekKey,
      dataWeekKey: rotation.dataWeekKey || dataKey,
      learningDataKey: rotation.learningDataKey || dataKey,
      activeWeekKey,
      rotationId: rotation.rotationId,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      allowCoarseMicroAliasLiveEntries: false,
      allowCoarseMicroAliasForDiscord: false,

      manualOnly: false,
      adminSelected: false,
      autoRotation: false,
      nextRotationOnly: true,
      activeRotationPreserved: true,
      liveSelectable: false,
      activationDisabled: true,
      manualSelectionRequired: true,

      usedLegacyFallback: false,
      usedSoftFallback: rotation.usedSoftFallback,
      usedObservationFallback: rotation.usedObservationFallback,
      usedRawFallback: rotation.usedRawFallback,
      usedPersistentLearningKey: rotation.usedPersistentLearningKey,
      usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,

      selectedMicroFamilies: 0,
      selectedMacroFamilies: 0,
      candidateMicroFamilies: rotation.microFamilyIds.length,
      candidateMacroFamilies: rotation.macroFamilyIds.length,

      missingSides: rotation.missingSides || [],
      bestLong: null,
      bestShort: rotation.bestShort?.microFamilyId || null
    }
  );

  await sendWeeklyRotationReport(
    rotation,
    'NEXT_ROTATION_CANDIDATES_READY_MANUAL_SELECTION_REQUIRED'
  ).catch(() => null);

  return {
    ok: true,
    type: 'NEXT_ROTATION_CANDIDATES_READY_MANUAL_SELECTION_REQUIRED',
    weekKey,
    dataWeekKey: rotation.dataWeekKey || dataKey,
    learningDataKey: rotation.learningDataKey || dataKey,
    activeWeekKey,
    mode,
    rotationId: rotation.rotationId,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    liveSelectable: false,
    activationDisabled: true,
    manualSelectionRequired: true,

    selectedMicroFamilies: 0,
    selectedMacroFamilies: 0,
    candidateMicroFamilies: rotation.microFamilyIds.length,
    candidateMacroFamilies: rotation.macroFamilyIds.length,

    usedLegacyFallback: false,
    usedSoftFallback: rotation.usedSoftFallback,
    usedObservationFallback: rotation.usedObservationFallback,
    usedRawFallback: rotation.usedRawFallback,
    usedPersistentLearningKey: rotation.usedPersistentLearningKey,
    usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,

    missingSides: rotation.missingSides || [],
    bestLong: null,
    bestShort: rotation.bestShort,
    rotation
  };
}

function sanitizeActiveRotation(rotation = {}, {
  requireManual = false
} = {}) {
  if (!rotation || typeof rotation !== 'object') return null;

  if (requireManual && !isManualActiveRotation(rotation)) {
    return null;
  }

  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const shortRows = rows
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.trueMicroFamilyId || row.microFamilyId));

  const indexes = buildSelectionIndexes(shortRows);
  const manual = isManualActiveRotation(rotation);

  return {
    ...rotation,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    usedLegacyFallback: false,

    manualOnly: manual,
    adminSelected: manual,
    autoRotation: false,
    liveSelectable: manual && shortRows.length > 0,

    microFamilies: shortRows,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    bestLong: null,
    bestShort: bestShortRow(shortRows),
    missingSides: missingSides(shortRows),

    empty: shortRows.length === 0,
    emptyReason: shortRows.length === 0
      ? 'ACTIVE_ROTATION_CONTAINED_NO_MANUAL_SHORT_TRUE_MICRO_FAMILIES'
      : null
  };
}

export async function activateNextRotation() {
  return {
    ok: false,
    skipped: true,
    changed: false,
    reason: 'AUTO_ROTATION_ACTIVATION_DISABLED_MANUAL_ONLY',
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true,
    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    manualOnly: true,
    activationDisabled: true
  };
}

export async function getActiveRotation() {
  const redis = getDurableRedis();

  const raw = await getJson(
    redis,
    KEYS.analyze.activeRotation,
    null
  );

  const sanitized = sanitizeActiveRotation(raw, {
    requireManual: true
  });

  if (!sanitized || sanitized.empty || !sanitized.microFamilyIds?.length) {
    return null;
  }

  if (
    raw?.longOnly === true ||
    raw?.shortDisabled === true ||
    raw?.targetTradeSide === 'LONG' ||
    raw?.dashboardSide === 'bull' ||
    raw?.manualOnly !== true ||
    raw?.liveSelectable !== true ||
    raw?.autoRotation === true ||
    raw?.exactTrueMicroOnly !== true ||
    raw?.allowCoarseMicroAliasForDiscord !== false
  ) {
    await setJson(
      redis,
      KEYS.analyze.activeRotation,
      sanitized
    ).catch(() => null);
  }

  return sanitized;
}

export async function getActiveRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings([
    active?.activeMicroFamilyIds || [],
    active?.trueMicroFamilyIds || [],
    active?.microFamilyIds || []
  ])
    .map(cleanLearningMicroId)
    .filter(isKnownTrueMicroId)
    .filter(idLooksLikeShortFamily);

  return new Set(ids);
}

export async function getActiveMacroRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings([
    active?.activeMacroFamilyIds || [],
    active?.macroFamilyIds || []
  ]).filter(idLooksLikeShortFamily);

  return new Set(ids);
}

function manualSideFromId(id = '') {
  const value = String(id || '').toUpperCase();

  if (idLooksLikeLongFamily(value) && !idLooksLikeShortFamily(value)) return OPPOSITE_TRADE_SIDE;
  if (idLooksLikeShortFamily(value)) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function buildManualOnlyRow(id, rank) {
  const cleanId = cleanLearningMicroId(id);
  const tradeSide = manualSideFromId(cleanId);
  const taxonomy = parseFixedTaxonomyMicroId(cleanId);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (!isKnownTrueMicroId(cleanId)) return null;

  return {
    rank,

    microFamilyId: cleanId,
    trueMicroFamilyId: cleanId,
    familyId: null,

    macroFamilyId: null,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    schema: taxonomy ? 'FIXED_TAXONOMY' : schemaMeta().microSchema,
    microFamilySchema: taxonomy ? 'FIXED_TAXONOMY' : schemaMeta().microSchema,
    trueMicroFamilySchema: taxonomy ? 'FIXED_TAXONOMY' : schemaMeta().microSchema,
    broadTrueMicroFamilySchema: taxonomy ? 'FIXED_TAXONOMY' : schemaMeta().microSchema,
    version: taxonomy ? 'manual_fixed_taxonomy_true_micro' : 'manual_true_micro',

    isTrueMicro: true,
    isLegacyMacro: false,
    manualOnly: true,
    unverifiedManualId: true,

    fixedTaxonomyLearningId: Boolean(taxonomy),
    taxonomyFamilyCount: taxonomy?.taxonomyFamilyCount || null,

    setupType: taxonomy?.setupType || null,
    regimeBucket: taxonomy?.regimeBucket || null,
    confirmationProfile: taxonomy?.confirmationProfile || null,

    rotationEligibilityTier: 'MANUAL',
    rotationEligible: true,
    hardEligible: false,
    softEligible: false,
    observationEligible: false,
    rawEligible: false,

    seen: 0,
    observations: 0,

    completed: 0,
    realCompleted: 0,
    virtualCompleted: 0,
    shadowCompleted: 0,

    winrateSample: 0,
    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    sampleWilsonLowerBound: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,
    sampleReliability: 0,

    avgR: 0,
    totalR: 0,
    avgWinR: 0,
    avgLossR: 0,

    profitFactor: 0,
    directSLPct: 0,
    nearTpPct: 0,
    reachedHalfRPct: 0,
    reachedOneRPct: 0,

    beWouldExitPct: 0,
    gaveBackAfterHalfRPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,

    totalCostR: 0,
    avgCostR: 0,

    balancedScore: 0,
    dashboardBalancedScore: 0,

    exactTrueMicroFamilyRequired: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsMetadataOnly: true,
    scannerFingerprintsUsedAsLearningFamily: false,
    learningIdentitySource: 'ANALYZE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      `MANUAL_TRUE_MICRO=${cleanId}`,
      'SOURCE=MANUAL_SELECTION',
      taxonomy ? 'SCHEMA=FIXED_TAXONOMY' : `SCHEMA=${schemaMeta().microSchema}`
    ],
    definition: `TRADE_SIDE=${TARGET_TRADE_SIDE} | MANUAL_TRUE_MICRO=${cleanId} | SOURCE=MANUAL_SELECTION`,

    parentDefinitionParts: [],
    parentDefinition: ''
  };
}

function resolveManualSelection({
  requestedIds = [],
  micros = {}
}) {
  const selectedRows = [];
  const ignoredIds = [];
  const expandedFromMacro = {};
  const seen = new Set();

  const microsByUpperId = Object.fromEntries(
    Object.values(micros || {})
      .filter(Boolean)
      .map((row) => [
        cleanLearningMicroId(row.trueMicroFamilyId || row.microFamilyId || row.id || ''),
        row
      ])
      .filter(([id]) => Boolean(id))
  );

  const addRow = (row) => {
    const id = cleanLearningMicroId(row?.trueMicroFamilyId || row?.microFamilyId || row?.id || '');

    if (!id || seen.has(id)) return;
    if (!isKnownTrueMicroId(id)) return;
    if (!isShortRotationRow({ ...row, microFamilyId: id, trueMicroFamilyId: id })) return;
    if (!isTrueMicroFamily({ ...row, microFamilyId: id, trueMicroFamilyId: id })) return;

    seen.add(id);
    selectedRows.push({
      ...row,
      microFamilyId: id,
      trueMicroFamilyId: id,
      exactTrueMicroFamilyRequired: true
    });
  };

  for (const rawId of requestedIds) {
    const id = cleanLearningMicroId(rawId);
    const side = manualSideFromId(id || rawId);

    if (side !== TARGET_TRADE_SIDE) {
      ignoredIds.push({
        id: rawId,
        side,
        reason: side === OPPOSITE_TRADE_SIDE
          ? 'LONG_DISABLED_SHORT_ONLY'
          : 'UNKNOWN_OR_NON_SHORT_ID_REJECTED'
      });
      continue;
    }

    if (!isKnownTrueMicroId(id)) {
      ignoredIds.push({
        id: rawId,
        side,
        reason: 'ONLY_EXACT_SHORT_TRUE_MICRO_IDS_ALLOWED'
      });
      continue;
    }

    const directRow = micros[id];
    const upperRow = microsByUpperId[id];
    const row = directRow || upperRow;

    if (
      row &&
      isShortRotationRow({ ...row, microFamilyId: id, trueMicroFamilyId: id }) &&
      isTrueMicroFamily({ ...row, microFamilyId: id, trueMicroFamilyId: id }) &&
      isManualEligible({ ...row, microFamilyId: id, trueMicroFamilyId: id })
    ) {
      addRow({
        ...row,
        microFamilyId: id,
        trueMicroFamilyId: id
      });
      continue;
    }

    if (!row && allowManualUnknownTrueMicroIds()) {
      const manualRow = buildManualOnlyRow(id, selectedRows.length + 1);

      if (manualRow) {
        addRow(manualRow);
        continue;
      }
    }

    ignoredIds.push({
      id: rawId,
      side,
      reason: row
        ? 'ROW_IS_NOT_SHORT_TRUE_MICRO'
        : 'UNKNOWN_SHORT_TRUE_MICRO_ID'
    });
  }

  return {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  };
}

function requestedManualIdsFromOptions(options = {}) {
  return uniqueStrings([
    options.microFamilyIds || [],
    options.activeMicroFamilyIds || [],
    options.trueMicroFamilyIds || [],
    options.ids || [],
    options.id || []
  ]);
}

function buildPreservedActiveResponse({
  existingActive,
  requestedIds,
  ignoredIds,
  expandedFromMacro,
  weekKey,
  mode
}) {
  const preserved = existingActive
    ? {
      ...existingActive,
      ok: false,
      skipped: true,
      changed: false,
      activePreserved: true,
      reason: 'NO_VALID_SHORT_TRUE_MICRO_IDS_SELECTED_ACTIVE_ROTATION_PRESERVED'
    }
    : {
      ok: false,
      skipped: true,
      changed: false,
      activePreserved: false,
      rotationId: null,
      source: 'ADMIN_MANUAL_SELECTION_SHORT_TRUE_MICRO_ONLY',
      mode,
      sourceWeekKey: weekKey,
      dataWeekKey: learningDataKey(),
      learningDataKey: learningDataKey(),
      activeWeekKey: getIsoWeekKey(),
      generatedAt: now(),
      activatedAt: null,
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,
      trueMicroOnly: true,
      exactTrueMicroOnly: true,
      allowCoarseMicroAliasLiveEntries: false,
      allowCoarseMicroAliasForDiscord: false,
      manualOnly: true,
      adminSelected: true,
      autoRotation: false,
      liveSelectable: false,
      empty: true,
      emptyReason: 'NO_VALID_SHORT_TRUE_MICRO_IDS_SELECTED',
      reason: 'NO_VALID_SHORT_TRUE_MICRO_IDS_SELECTED',
      microFamilies: [],
      microFamilyIds: [],
      activeMicroFamilyIds: [],
      trueMicroFamilyIds: [],
      macroFamilyIds: [],
      activeMacroFamilyIds: [],
      microToMacroFamilyId: {},
      macroToMicroFamilyIds: {},
      bestLong: null,
      bestShort: null,
      missingSides: [TARGET_TRADE_SIDE]
    };

  return {
    ...preserved,
    requestedMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro
  };
}

export async function activateSelectedMicroFamilies(options = {}) {
  const {
    weekKey = getIsoWeekKey(),
    activeWeekKey = getIsoWeekKey(),
    mode = 'manual'
  } = options || {};

  const redis = getDurableRedis();

  const [
    rotationMicros,
    existingRawActive
  ] = await Promise.all([
    getRotationMicros(weekKey),
    getJson(redis, KEYS.analyze.activeRotation, null).catch(() => null)
  ]);

  const {
    micros,
    dataWeekKey,
    usedPersistentLearningKey,
    usedPreviousWeekMerge,
    primaryRows,
    previousRows
  } = rotationMicros;

  const requestedIds = requestedManualIdsFromOptions(options);

  const {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  } = resolveManualSelection({
    requestedIds,
    micros
  });

  const microFamilies = selectedRows
    .filter(isShortRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => {
      if (row.manualOnly) {
        return {
          ...row,
          rank: index + 1
        };
      }

      return compactRotationRow(row, index + 1);
    })
    .filter((row) => row.microFamilyId)
    .filter((row) => isKnownTrueMicroId(row.trueMicroFamilyId || row.microFamilyId));

  if (microFamilies.length === 0) {
    const existingActive = sanitizeActiveRotation(existingRawActive, {
      requireManual: true
    });

    return buildPreservedActiveResponse({
      existingActive,
      requestedIds,
      ignoredIds,
      expandedFromMacro,
      weekKey,
      mode
    });
  }

  const indexes = buildSelectionIndexes(microFamilies);

  const active = sanitizeActiveRotation({
    rotationId: randomId(`ROT_${weekKey}_manual_short_only`),
    source: 'ADMIN_MANUAL_SELECTION_SHORT_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    dataWeekKey,
    learningDataKey: dataWeekKey,
    activeWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: indexes.microFamilyIds.length > 0,

    usedLegacyFallback: false,
    usedSoftFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'SOFT'),
    usedObservationFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'OBSERVATION'),
    usedRawFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'RAW'),
    usedPersistentLearningKey,
    usedPreviousWeekMerge,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    primaryRows,
    previousRows,

    empty: indexes.microFamilyIds.length === 0,
    emptyReason: indexes.microFamilyIds.length === 0
      ? 'NO_SHORT_TRUE_MICRO_IDS_SELECTED'
      : null,

    requestedMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro,

    bestLong: null,
    bestShort: bestShortRow(microFamilies),
    missingSides: missingSides(microFamilies),

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies
  }, {
    requireManual: true
  });

  const finalActive = {
    ...active,
    ok: true,
    skipped: false,
    changed: true,
    activePreserved: false
  };

  await setJson(
    redis,
    KEYS.analyze.activeRotation,
    finalActive
  );

  return finalActive;
}

function sanitizeDashboardRotation(rotation) {
  const sanitized = sanitizeActiveRotation(rotation, {
    requireManual: false
  });

  if (!sanitized) return null;

  return {
    ...sanitized,

    manualOnly: false,
    adminSelected: false,
    autoRotation: false,
    nextRotationOnly: true,
    activeRotationPreserved: true,
    liveSelectable: false,
    activationDisabled: true,
    manualSelectionRequired: true,

    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false,

    candidateMicroFamilyIds: sanitized.microFamilyIds || [],
    candidateMacroFamilyIds: sanitized.macroFamilyIds || []
  };
}

export async function getRotationDashboard() {
  const redis = getDurableRedis();

  const [activeRaw, nextRaw, validFrom] = await Promise.all([
    getActiveRotation(),
    getJson(redis, KEYS.analyze.nextRotation, null),
    getJson(redis, KEYS.analyze.rotationValidFrom, null)
  ]);

  const active = sanitizeActiveRotation(activeRaw, {
    requireManual: true
  });

  const next = sanitizeDashboardRotation(nextRaw);

  const activeRows = Array.isArray(active?.microFamilies)
    ? active.microFamilies
    : [];

  const nextRows = Array.isArray(next?.microFamilies)
    ? next.microFamilies
    : [];

  return {
    active,
    next,
    validFrom,

    activeRows,
    nextRows,

    activeCount: active?.microFamilyIds?.length || 0,
    nextCount: next?.microFamilyIds?.length || 0,

    activeMacroCount: active?.macroFamilyIds?.length || 0,
    nextMacroCount: next?.macroFamilyIds?.length || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    activeMicroToMacroFamilyId: active?.microToMacroFamilyId || {},
    nextMicroToMacroFamilyId: next?.microToMacroFamilyId || {},

    activeMacroToMicroFamilyIds: active?.macroToMicroFamilyIds || {},
    nextMacroToMicroFamilyIds: next?.macroToMicroFamilyIds || {},

    bestLong: null,
    bestShort: active?.bestShort || null,
    nextBestLong: null,
    nextBestShort: next?.bestShort || null,

    missingSides: active?.missingSides || [TARGET_TRADE_SIDE],
    nextMissingSides: next?.missingSides || [TARGET_TRADE_SIDE],

    usedSoftFallback: Boolean(active?.usedSoftFallback),
    nextUsedSoftFallback: Boolean(next?.usedSoftFallback),

    usedObservationFallback: Boolean(active?.usedObservationFallback),
    nextUsedObservationFallback: Boolean(next?.usedObservationFallback),

    usedRawFallback: Boolean(active?.usedRawFallback),
    nextUsedRawFallback: Boolean(next?.usedRawFallback),

    usedPersistentLearningKey: Boolean(active?.usedPersistentLearningKey),
    nextUsedPersistentLearningKey: Boolean(next?.usedPersistentLearningKey),

    usedPreviousWeekMerge: Boolean(active?.usedPreviousWeekMerge),
    nextUsedPreviousWeekMerge: Boolean(next?.usedPreviousWeekMerge),

    dataWeekKey: active?.dataWeekKey || learningDataKey(),
    learningDataKey: active?.learningDataKey || learningDataKey(),
    nextDataWeekKey: next?.dataWeekKey || learningDataKey(),
    nextLearningDataKey: next?.learningDataKey || learningDataKey(),

    manualOnly: true,
    autoRotationActivationDisabled: true,
    activeLiveSelectable: Boolean(active?.liveSelectable),

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    trueMicroOnly: true,
    exactTrueMicroOnly: true,
    allowCoarseMicroAliasLiveEntries: false,
    allowCoarseMicroAliasForDiscord: false
  };
}