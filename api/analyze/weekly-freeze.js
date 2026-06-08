// ================= FILE: api/analyze/weekly-freeze.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  sideToTradeSide
} from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const DEFAULT_LOCK_TTL_SEC = 600;

function now() {
  return Date.now();
}

function activeRotationKey() {
  return KEYS.analyze?.activeRotation || 'ANALYZE:ACTIVE_ROTATION';
}

function nextRotationKey() {
  return KEYS.analyze?.nextRotation || 'ANALYZE:NEXT_ROTATION';
}

function rotationValidFromKey() {
  return KEYS.analyze?.rotationValidFrom || 'ANALYZE:ROTATION_VALID_FROM';
}

function freezeLockKey() {
  return KEYS.analyze?.freezeLock || 'ANALYZE:WEEKLY_FREEZE_LOCK';
}

function flags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    weeklyFreezeDisabled: true,
    weeklyFreezeBuildDisabled: true,
    nextRotationBuildDisabled: true,

    nextRotationOnly: false,
    activeRotationPreserved: true,
    activeRotationWriteBlocked: true,
    nextRotationWriteBlocked: true,
    rotationValidFromWriteBlocked: true,

    autoActivationDisabled: true,
    autoRotationDisabled: true,
    activateNextRotationDisabled: true,
    manualSelectionRemainsLeading: true,
    manualSelectionOnly: true,

    noRealOrders: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,

    virtualLearningOnly: true,
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,

    discordOnlyForManualSelection: true,
    discordOnlyForSelectedMicroFamilies: true
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...flags()
  });
}

function parseJson(text) {
  const raw = String(text || '').trim();

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.method === 'GET') return {};

  if (req.body) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function getParam(req, body, key, fallback = null) {
  const bodyValue = firstValue(body?.[key], null);
  const queryValue = firstValue(req.query?.[key], null);

  if (bodyValue !== null && bodyValue !== '') return bodyValue;
  if (queryValue !== null && queryValue !== '') return queryValue;

  return fallback;
}

function getFreezeLockTtlSec() {
  const ttl = Number(CONFIG.analyze?.freezeLockTtlSec || DEFAULT_LOCK_TTL_SEC);

  if (!Number.isFinite(ttl)) return DEFAULT_LOCK_TTL_SEC;
  if (ttl <= 0) return DEFAULT_LOCK_TTL_SEC;

  return Math.floor(ttl);
}

function getRotationMode(req, body = {}) {
  return String(
    getParam(
      req,
      body,
      'mode',
      CONFIG.rotation?.mode || 'manual'
    ) || 'manual'
  ).trim();
}

function getWeekKey(req, body = {}) {
  return String(
    getParam(
      req,
      body,
      'weekKey',
      getIsoWeekKey()
    ) || getIsoWeekKey()
  ).trim();
}

function getActiveWeekKey(req, body = {}) {
  const explicit =
    getParam(req, body, 'activeWeekKey', null) ||
    getParam(req, body, 'nextWeekKey', null);

  if (explicit) return String(explicit).trim();

  return getNextIsoWeekKey();
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORT_ONLY', 'SHORT');
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .flatMap((value) => {
        if (value && typeof value === 'object') {
          return [
            value.microFamilyId,
            value.trueMicroFamilyId,
            value.id,
            value.key
          ];
        }

        return String(value || '').split(/[\s,;\n\r]+/g);
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function hasLongSignal(value = '') {
  const text = ` ${cleanSideText(value)} `;

  return (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('POSITION_SIDE=LONG') ||
    text.includes('POSITIONSIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('DIRECTION=BUY') ||
    text.includes(' LONG_') ||
    text.includes('_LONG ') ||
    text.includes('_LONG_') ||
    text.includes('|LONG|') ||
    text.includes(':LONG') ||
    text.includes('=LONG') ||
    text.includes(' BULL ') ||
    text.includes('_BULL') ||
    text.includes('BULL_') ||
    text.includes('|BULL|') ||
    text.includes(':BULL') ||
    text.includes('=BULL') ||
    text.includes(' BUY ') ||
    text.includes('_BUY') ||
    text.includes('BUY_') ||
    text.includes('|BUY|') ||
    text.includes(':BUY') ||
    text.includes('=BUY')
  );
}

function hasShortSignal(value = '') {
  const text = ` ${cleanSideText(value)} `;

  return (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('POSITION_SIDE=SHORT') ||
    text.includes('POSITIONSIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('DIRECTION=SELL') ||
    text.includes(' SHORT_') ||
    text.includes('_SHORT ') ||
    text.includes('_SHORT_') ||
    text.includes('|SHORT|') ||
    text.includes(':SHORT') ||
    text.includes('=SHORT') ||
    text.includes(' BEAR ') ||
    text.includes('_BEAR') ||
    text.includes('BEAR_') ||
    text.includes('|BEAR|') ||
    text.includes(':BEAR') ||
    text.includes('=BEAR') ||
    text.includes(' SELL ') ||
    text.includes('_SELL') ||
    text.includes('SELL_') ||
    text.includes('|SELL|') ||
    text.includes(':SELL') ||
    text.includes('=SELL')
  );
}

function normalizeDirectSide(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const converted = sideToTradeSide(text);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(text)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(text)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromText(value = '') {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const direct = normalizeDirectSide(text);

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const shortSignal = hasShortSignal(text);
  const longSignal = hasLongSignal(text);

  if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
  if (longSignal && !shortSignal) return OPPOSITE_TRADE_SIDE;

  if (shortSignal && longSignal) {
    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.analysisSide,
    row.side,
    row.bias,
    row.marketBias
  ];

  for (const source of directSources) {
    const side = normalizeDirectSide(source);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

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
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('|');

  const textSide = inferTradeSideFromText(haystack);

  if (textSide !== 'UNKNOWN') return textSide;

  if (row.longOnly === true || row.shortDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferRowTradeSide(row) !== OPPOSITE_TRADE_SIDE;
}

function isLongRow(row = {}) {
  return inferRowTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function isAllowedShortId(id = '') {
  return inferTradeSideFromText(id) !== OPPOSITE_TRADE_SIDE;
}

function getMicroFamilyId(row = {}, fallback = null) {
  return (
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    fallback ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.familyId ||
    null
  );
}

function forceShortRow(row = {}, index = 0) {
  const rawInferredTradeSide = inferRowTradeSide(row);
  const microFamilyId = getMicroFamilyId(row, row.microFamilyId || row.id || row.key);
  const macroFamilyId = getMacroFamilyId(row);

  return {
    ...row,

    rank: Number.isFinite(Number(row.rank))
      ? Number(row.rank)
      : index + 1,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,

    macroFamilyId,
    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    ...flags(),

    rawInferredTradeSide,
    inferredTradeSide: rawInferredTradeSide === 'UNKNOWN'
      ? TARGET_TRADE_SIDE
      : rawInferredTradeSide,
    inferredFromShortOnlyMode: rawInferredTradeSide === 'UNKNOWN',

    bestLong: null
  };
}

function buildManualRow(id, index = 0) {
  return forceShortRow({
    microFamilyId: id,
    trueMicroFamilyId: id,

    familyId: null,
    macroFamilyId: null,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

    source: 'STORED_ID_ONLY',

    selectedTier: 'MANUAL',
    rotationEligibilityTier: 'MANUAL',

    seen: 0,
    observations: 0,
    completed: 0,
    realCompleted: 0,
    shadowCompleted: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    totalR: 0,
    avgR: 0,
    totalCostR: 0,
    avgCostR: 0,

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      'STORED_ID_ONLY=true'
    ],
    definition: `TRADE_SIDE=${TARGET_TRADE_SIDE} | STORED_ID_ONLY=true`
  }, index);
}

function shortIdsFromRows(rows = []) {
  return uniqueStrings(
    rows
      .filter(isShortRow)
      .map((row) => getMicroFamilyId(row))
      .filter(Boolean)
  ).filter(isAllowedShortId);
}

function shortMacroIdsFromRows(rows = []) {
  return uniqueStrings(
    rows
      .filter(isShortRow)
      .map((row) => getMacroFamilyId(row))
      .filter(Boolean)
  ).filter(isAllowedShortId);
}

function filterShortIds(ids = []) {
  return uniqueStrings(ids).filter(isAllowedShortId);
}

function extractRotationFromPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;

  return (
    payload.nextRotation ||
    payload.rotation ||
    payload.result?.nextRotation ||
    payload.result?.rotation ||
    null
  );
}

function explicitMicroIds(rotation = {}) {
  return filterShortIds([
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.trueMicroFamilyIds,
    rotation.ids,
    rotation.selectedMicroFamilyId
  ]);
}

function explicitMacroIds(rotation = {}) {
  return filterShortIds([
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rotation.macroIds,
    rotation.selectedMacroFamilyId
  ]);
}

function buildIndexes(rows = []) {
  const microFamilyIds = shortIdsFromRows(rows);
  const macroFamilyIds = shortMacroIdsFromRows(rows);

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of rows) {
    const microId = String(row.microFamilyId || row.trueMicroFamilyId || row.id || '').trim();
    const macroId = String(getMacroFamilyId(row) || '').trim();

    if (!microId || !macroId) continue;
    if (!isAllowedShortId(microId) || !isAllowedShortId(macroId)) continue;

    microToMacroFamilyId[microId] = macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(macroToMicroFamilyIds[macroId]);
  }

  return {
    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microToMacroFamilyId,
    macroToMicroFamilyIds
  };
}

function normalizeShortRotation(rotation = {}, fallback = {}) {
  if (!rotation || typeof rotation !== 'object') {
    return null;
  }

  const rawRows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const rowsById = new Map();

  for (const row of rawRows) {
    if (isLongRow(row)) continue;

    const normalized = forceShortRow(row, rowsById.size);

    if (!normalized.microFamilyId) continue;

    rowsById.set(normalized.microFamilyId, normalized);
  }

  const storedMicroIds = explicitMicroIds(rotation);

  for (const id of storedMicroIds) {
    if (rowsById.has(id)) continue;

    rowsById.set(id, buildManualRow(id, rowsById.size));
  }

  const microFamilies = [...rowsById.values()]
    .filter(isShortRow)
    .map((row, index) => forceShortRow({
      ...row,
      rank: index + 1
    }, index));

  const rowIndexes = buildIndexes(microFamilies);

  const microFamilyIds = rowIndexes.microFamilyIds.length
    ? rowIndexes.microFamilyIds
    : storedMicroIds;

  const macroFamilyIds = rowIndexes.macroFamilyIds.length
    ? rowIndexes.macroFamilyIds
    : explicitMacroIds(rotation);

  const empty = microFamilyIds.length === 0 && microFamilies.length === 0;

  return {
    ...fallback,
    ...rotation,

    source: rotation.source || fallback.source || 'STORED_ROTATION_READ_ONLY',

    ...flags(),

    trueMicroOnly: true,
    autoRotation: false,
    manualOnly: rotation.manualOnly !== false,
    adminSelected: Boolean(rotation.adminSelected || rotation.manualOnly),

    activeRotationWriteBlocked: true,
    nextRotationWriteBlocked: true,

    bestLong: null,
    bestShort: microFamilies[0] || null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : [],

    empty,
    emptyReason: empty
      ? rotation.emptyReason || 'NO_SHORT_MICRO_FAMILIES_AVAILABLE'
      : null,

    microFamilies,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microToMacroFamilyId: rowIndexes.microToMacroFamilyId,
    macroToMicroFamilyIds: rowIndexes.macroToMicroFamilyIds,

    selectedMicroFamilyId: microFamilies[0]?.microFamilyId || rotation.selectedMicroFamilyId || null,
    selectedMacroFamilyId: microFamilies[0]?.macroFamilyId || rotation.selectedMacroFamilyId || null,
    selectedRow: microFamilies[0] || rotation.selectedRow || null,

    count: microFamilyIds.length || microFamilies.length,
    activeCount: microFamilyIds.length || microFamilies.length,

    rawMicroFamiliesCount: rawRows.length,
    ignoredLongMicroFamilies: rawRows.filter(isLongRow).length
  };
}

function sanitizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const rotation = extractRotationFromPayload(payload);
  const sanitizedRotation = rotation
    ? normalizeShortRotation(rotation)
    : null;

  return {
    ...payload,

    ...flags(),

    rotation: sanitizedRotation || null,
    nextRotation: sanitizedRotation || null,

    activeRotation: undefined,
    active: undefined,

    bestLong: null,
    bestShort: sanitizedRotation?.bestShort || null,

    microFamilyIds: sanitizedRotation?.microFamilyIds || [],
    macroFamilyIds: sanitizedRotation?.macroFamilyIds || [],

    selectedMicroFamilies: sanitizedRotation?.microFamilyIds?.length || 0,
    selectedMacroFamilies: sanitizedRotation?.macroFamilyIds?.length || 0
  };
}

function unwrapLockResult(lockResult) {
  if (
    lockResult &&
    typeof lockResult === 'object' &&
    Object.prototype.hasOwnProperty.call(lockResult, 'result')
  ) {
    return lockResult.result;
  }

  return lockResult || null;
}

function payloadOk(lockResult, payload) {
  if (lockResult?.ok === false) return false;
  if (payload?.ok === false) return false;

  return true;
}

function responseReason(payload = {}) {
  return (
    payload.reason ||
    payload.emptyReason ||
    payload.rotation?.emptyReason ||
    payload.nextRotation?.emptyReason ||
    null
  );
}

function errorStatus(error) {
  if (Number.isFinite(error?.statusCode)) return error.statusCode;

  if (
    error?.reason === 'LOCK_NOT_ACQUIRED' ||
    error?.message === 'LOCK_NOT_ACQUIRED' ||
    String(error?.message || '').includes('LOCK')
  ) {
    return 409;
  }

  return 500;
}

async function readRotationState(redis) {
  const [activeRotationRaw, nextRotationRaw, validFrom] = await Promise.all([
    getJson(redis, activeRotationKey(), null).catch(() => null),
    getJson(redis, nextRotationKey(), null).catch(() => null),
    getJson(redis, rotationValidFromKey(), null).catch(() => null)
  ]);

  return {
    activeRotationRaw,
    nextRotationRaw,
    validFrom,

    activeRotation: activeRotationRaw
      ? normalizeShortRotation(activeRotationRaw, {
        source: activeRotationRaw.source || 'ACTIVE_ROTATION_READ_ONLY'
      })
      : null,

    nextRotation: nextRotationRaw
      ? normalizeShortRotation(nextRotationRaw, {
        source: nextRotationRaw.source || 'NEXT_ROTATION_READ_ONLY'
      })
      : null
  };
}

async function runFreeze({
  req,
  body,
  redis
}) {
  const weekKey = getWeekKey(req, body);
  const activeWeekKey = getActiveWeekKey(req, body);
  const mode = getRotationMode(req, body);

  const state = await readRotationState(redis);

  const payload = sanitizePayload({
    ok: true,
    skipped: true,
    reason: 'WEEKLY_FREEZE_DISABLED_MANUAL_SELECTION_ONLY_NO_WRITES',

    ...flags(),

    weekKey,
    activeWeekKey,
    mode,

    activeRotation: state.activeRotation,
    nextRotation: state.nextRotation,
    validFrom: state.validFrom,

    writes: {
      activeRotation: false,
      nextRotation: false,
      rotationValidFrom: false
    }
  });

  return {
    ok: true,
    skipped: true,
    type: 'WEEKLY_FREEZE_DISABLED_MANUAL_SELECTION_ONLY',

    ...flags(),

    weekKey,
    activeWeekKey,
    mode,

    rotationId: state.nextRotation?.rotationId || null,

    selectedMicroFamilies: state.nextRotation?.microFamilyIds?.length || 0,
    selectedMacroFamilies: state.nextRotation?.macroFamilyIds?.length || 0,

    empty: Boolean(state.nextRotation?.empty),
    emptyReason: state.nextRotation?.emptyReason || responseReason(payload),

    microFamilyIds: state.nextRotation?.microFamilyIds || [],
    macroFamilyIds: state.nextRotation?.macroFamilyIds || [],

    activeRotation: state.activeRotation,
    nextRotation: state.nextRotation,
    validFrom: state.validFrom,

    nextRotationPersisted: false,

    activeProtection: {
      activeRotationPreserved: true,
      activeRotationWriteAttempted: false,
      activeRotationRestored: false
    },

    writes: {
      activeRotation: false,
      nextRotation: false,
      rotationValidFrom: false
    },

    result: payload
  };
}

async function handleGet(req, res) {
  const startedAt = now();
  const redis = getDurableRedis();

  const state = await readRotationState(redis);

  return res.status(200).json({
    ok: true,
    skipped: true,
    reason: 'GET_READ_ONLY_WEEKLY_FREEZE_DOES_NOT_BUILD_OR_ACTIVATE',

    ...flags(),

    endpointMode: 'READ_ONLY_FOR_GET',
    cronDisabledExpected: true,

    currentWeekKey: getIsoWeekKey(),
    nextWeekKey: getNextIsoWeekKey(),

    activeRotation: state.activeRotation,
    nextRotation: state.nextRotation,
    validFrom: state.validFrom,

    activeRotationId: state.activeRotation?.rotationId || null,
    nextRotationId: state.nextRotation?.rotationId || null,

    activeMicroFamilyIds: state.activeRotation?.microFamilyIds || [],
    nextMicroFamilyIds: state.nextRotation?.microFamilyIds || [],

    writes: {
      activeRotation: false,
      nextRotation: false,
      rotationValidFrom: false
    },

    durationMs: now() - startedAt,
    serverTs: Date.now()
  });
}

async function handlePost(req, res) {
  const startedAt = now();
  const body = await readBody(req);
  const redis = getDurableRedis();

  const lockResult = await withRedisLock(
    redis,
    freezeLockKey(),
    getFreezeLockTtlSec(),
    async () => runFreeze({
      req,
      body,
      redis
    })
  );

  const payload = unwrapLockResult(lockResult);
  const ok = payloadOk(lockResult, payload);

  return res.status(ok ? 200 : 500).json({
    ok,
    skipped: true,

    source: 'API_WEEKLY_FREEZE_DISABLED_NO_WRITES',
    type: payload?.type || 'WEEKLY_FREEZE_DISABLED_MANUAL_SELECTION_ONLY',

    reason: payload?.reason || 'WEEKLY_FREEZE_DISABLED_MANUAL_SELECTION_ONLY_NO_WRITES',

    ...flags(),

    weekKey: payload?.weekKey || getWeekKey(req, body),
    activeWeekKey: payload?.activeWeekKey || getActiveWeekKey(req, body),
    mode: payload?.mode || getRotationMode(req, body),

    rotationId: payload?.rotationId || null,

    selectedMicroFamilies: payload?.selectedMicroFamilies || 0,
    selectedMacroFamilies: payload?.selectedMacroFamilies || 0,

    empty: Boolean(payload?.empty),
    emptyReason: payload?.emptyReason || responseReason(payload),

    microFamilyIds: payload?.microFamilyIds || [],
    macroFamilyIds: payload?.macroFamilyIds || [],

    activeRotation: payload?.activeRotation || null,
    nextRotation: payload?.nextRotation || null,
    validFrom: payload?.validFrom || null,

    nextRotationPersisted: false,

    activeProtection: payload?.activeProtection || {
      activeRotationPreserved: true,
      activeRotationWriteAttempted: false,
      activeRotationRestored: false
    },

    writes: {
      activeRotation: false,
      nextRotation: false,
      rotationValidFrom: false
    },

    result: payload?.result || payload,

    lock: {
      ok: lockResult?.ok !== false,
      skipped: Boolean(lockResult?.skipped),
      reason: lockResult?.reason || null
    },

    durationMs: now() - startedAt,
    serverTs: Date.now()
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Rotation-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Weekly-Freeze-Disabled', 'true');
  res.setHeader('X-Active-Rotation-Preserved', 'true');
  res.setHeader('X-Auto-Activation-Disabled', 'true');
  res.setHeader('X-No-Writes', 'true');

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      return await handlePost(req, res);
    }

    return methodNotAllowed(res);
  } catch (error) {
    return res.status(errorStatus(error)).json({
      ok: false,

      ...flags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}