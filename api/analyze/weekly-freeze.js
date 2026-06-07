// ================= FILE: api/analyze/weekly-freeze.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getJson,
  setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey
} from '../../src/utils.js';
import { freezeWeeklyRotation } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';

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

    nextRotationOnly: true,
    activeRotationPreserved: true,
    autoActivationDisabled: true,
    activateNextRotationDisabled: true,
    manualSelectionRemainsLeading: true,

    noRealOrders: true,
    virtualLearningOnly: true
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
      CONFIG.rotation?.mode || 'balanced'
    ) || 'balanced'
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
    .replaceAll('SHORT_ONLY', 'SHORT');
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function hasLongSignal(value = '') {
  const text = cleanSideText(value);

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
    text.startsWith('LONG_') ||
    text.includes('_LONG_') ||
    text.endsWith('_LONG') ||
    text.startsWith('BULL_') ||
    text.includes('_BULL_') ||
    text.endsWith('_BULL') ||
    text.includes('|LONG|') ||
    text.includes('|BULL|') ||
    text.includes('|BUY|') ||
    text.includes('=LONG') ||
    text.includes('=BULL') ||
    text.includes('=BUY')
  );
}

function hasShortSignal(value = '') {
  const text = cleanSideText(value);

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
    text.startsWith('SHORT_') ||
    text.includes('_SHORT_') ||
    text.endsWith('_SHORT') ||
    text.startsWith('BEAR_') ||
    text.includes('_BEAR_') ||
    text.endsWith('_BEAR') ||
    text.includes('|SHORT|') ||
    text.includes('|BEAR|') ||
    text.includes('|SELL|') ||
    text.includes('=SHORT') ||
    text.includes('=BEAR') ||
    text.includes('=SELL')
  );
}

function inferTradeSideFromText(value = '') {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const shortSignal = hasShortSignal(text);
  const longSignal = hasLongSignal(text);

  if (shortSignal && !longSignal) return TARGET_TRADE_SIDE;
  if (longSignal && !shortSignal) return 'LONG';

  if (shortSignal && longSignal) {
    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return 'LONG';
  }

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);

  const direct = cleanSideText(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.analysisSide ||
    row.side ||
    ''
  );

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(direct)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(direct)) return 'LONG';

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

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
}

function isLongRow(row = {}) {
  return inferRowTradeSide(row) === 'LONG';
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
  const microFamilyId = getMicroFamilyId(row);
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

    ...flags()
  };
}

function shortIdsFromRows(rows = []) {
  return uniqueStrings(
    rows
      .filter(isShortRow)
      .map((row) => getMicroFamilyId(row))
      .filter(Boolean)
  );
}

function shortMacroIdsFromRows(rows = []) {
  return uniqueStrings(
    rows
      .filter(isShortRow)
      .map((row) => getMacroFamilyId(row))
      .filter(Boolean)
  );
}

function filterShortIds(ids = []) {
  return uniqueStrings(ids).filter((id) => inferTradeSideFromText(id) === TARGET_TRADE_SIDE);
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

function normalizeShortRotation(rotation = {}, fallback = {}) {
  if (!rotation || typeof rotation !== 'object') {
    return null;
  }

  const rawRows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const microFamilies = rawRows
    .filter((row) => !isLongRow(row))
    .filter(isShortRow)
    .map((row, index) => forceShortRow(row, index))
    .filter((row) => row.microFamilyId);

  const rowMicroIds = shortIdsFromRows(microFamilies);
  const rowMacroIds = shortMacroIdsFromRows(microFamilies);

  const explicitMicroIds = filterShortIds([
    ...(Array.isArray(rotation.microFamilyIds) ? rotation.microFamilyIds : []),
    ...(Array.isArray(rotation.activeMicroFamilyIds) ? rotation.activeMicroFamilyIds : []),
    ...(Array.isArray(rotation.trueMicroFamilyIds) ? rotation.trueMicroFamilyIds : []),
    ...(Array.isArray(rotation.ids) ? rotation.ids : [])
  ]);

  const explicitMacroIds = filterShortIds([
    ...(Array.isArray(rotation.macroFamilyIds) ? rotation.macroFamilyIds : []),
    ...(Array.isArray(rotation.activeMacroFamilyIds) ? rotation.activeMacroFamilyIds : []),
    ...(Array.isArray(rotation.macroIds) ? rotation.macroIds : [])
  ]);

  const microFamilyIds = rowMicroIds.length
    ? rowMicroIds
    : explicitMicroIds;

  const macroFamilyIds = rowMacroIds.length
    ? rowMacroIds
    : explicitMacroIds;

  const empty = microFamilyIds.length === 0 && microFamilies.length === 0;

  return {
    ...fallback,
    ...rotation,

    source: rotation.source || fallback.source || 'WEEKLY_FREEZE_NEXT_ROTATION_SHORT_ONLY',

    ...flags(),

    trueMicroOnly: true,
    autoRotation: false,
    activeRotationWriteBlocked: true,

    bestLong: null,
    bestShort: microFamilies[0] || null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : [],

    empty,
    emptyReason: empty
      ? rotation.emptyReason || 'NO_SHORT_MICRO_FAMILIES_FOR_NEXT_ROTATION'
      : null,

    microFamilies,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

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

    rotation: sanitizedRotation || payload.rotation || null,
    nextRotation: sanitizedRotation || payload.nextRotation || null,

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

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function restoreActiveRotation(redis, activeBefore) {
  const key = activeRotationKey();
  const activeAfter = await getJson(redis, key, null).catch(() => null);

  const changed = stableStringify(activeBefore) !== stableStringify(activeAfter);

  if (activeBefore === null || activeBefore === undefined) {
    await redis.del(key).catch(() => null);

    return {
      activeRotationRestored: changed,
      activeRotationExistedBefore: false,
      activeRotationRemovedBecauseFreezeCreatedIt: activeAfter !== null && activeAfter !== undefined
    };
  }

  await setJson(redis, key, activeBefore).catch(() => null);

  return {
    activeRotationRestored: changed,
    activeRotationExistedBefore: true,
    activeRotationRemovedBecauseFreezeCreatedIt: false
  };
}

async function persistSanitizedNextRotation({
  redis,
  payload,
  weekKey,
  activeWeekKey,
  mode
}) {
  const nextRaw =
    extractRotationFromPayload(payload) ||
    await getJson(redis, nextRotationKey(), null).catch(() => null);

  const nextRotation = normalizeShortRotation(nextRaw, {
    sourceWeekKey: weekKey,
    activeWeekKey,
    mode
  });

  if (!nextRotation) {
    return {
      nextRotation: null,
      nextRotationPersisted: false
    };
  }

  await setJson(redis, nextRotationKey(), nextRotation);

  await setJson(redis, rotationValidFromKey(), {
    validFrom: activeWeekKey,
    ts: now(),

    source: 'WEEKLY_FREEZE_NEXT_ONLY_ACTIVE_NOT_TOUCHED',

    sourceWeekKey: weekKey,
    activeWeekKey,
    mode,

    rotationId: nextRotation.rotationId || null,

    ...flags(),

    selectedMicroFamilies: nextRotation.microFamilyIds.length,
    selectedMacroFamilies: nextRotation.macroFamilyIds.length,

    bestShort: nextRotation.bestShort?.microFamilyId || null,
    bestLong: null,

    missingSides: nextRotation.missingSides || []
  });

  return {
    nextRotation,
    nextRotationPersisted: true
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

async function runFreeze({
  req,
  body,
  redis
}) {
  const weekKey = getWeekKey(req, body);
  const activeWeekKey = getActiveWeekKey(req, body);
  const mode = getRotationMode(req, body);

  const activeBefore = await getJson(redis, activeRotationKey(), null).catch(() => null);

  let rawPayload = null;
  let activeProtection = null;

  try {
    rawPayload = await freezeWeeklyRotation({
      weekKey,
      activeWeekKey,
      mode,

      targetTradeSide: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      shortOnly: true,
      longDisabled: true,
      disableLong: true,

      nextRotationOnly: true,
      preserveActiveRotation: true,
      doNotActivate: true,
      activateNextRotation: false,
      autoActivate: false
    });
  } finally {
    activeProtection = await restoreActiveRotation(redis, activeBefore);
  }

  const sanitizedPayload = sanitizePayload(rawPayload);

  const {
    nextRotation,
    nextRotationPersisted
  } = await persistSanitizedNextRotation({
    redis,
    payload: sanitizedPayload,
    weekKey,
    activeWeekKey,
    mode
  });

  return {
    ok: rawPayload?.ok !== false,
    type: 'WEEKLY_FREEZE_NEXT_ROTATION_ONLY',

    ...flags(),

    weekKey,
    activeWeekKey,
    mode,

    rotationId: nextRotation?.rotationId || sanitizedPayload?.rotationId || null,

    selectedMicroFamilies: nextRotation?.microFamilyIds?.length || 0,
    selectedMacroFamilies: nextRotation?.macroFamilyIds?.length || 0,

    empty: Boolean(nextRotation?.empty),
    emptyReason: nextRotation?.emptyReason || responseReason(sanitizedPayload),

    microFamilyIds: nextRotation?.microFamilyIds || [],
    macroFamilyIds: nextRotation?.macroFamilyIds || [],

    nextRotation,
    nextRotationPersisted,

    activeProtection,

    result: sanitizedPayload
  };
}

async function handleGet(req, res) {
  const startedAt = now();
  const redis = getDurableRedis();

  const [activeRotationRaw, nextRotationRaw, validFrom] = await Promise.all([
    getJson(redis, activeRotationKey(), null).catch(() => null),
    getJson(redis, nextRotationKey(), null).catch(() => null),
    getJson(redis, rotationValidFromKey(), null).catch(() => null)
  ]);

  const activeRotation = activeRotationRaw
    ? normalizeShortRotation(activeRotationRaw)
    : null;

  const nextRotation = nextRotationRaw
    ? normalizeShortRotation(nextRotationRaw)
    : null;

  return res.status(200).json({
    ok: true,
    skipped: true,
    reason: 'GET_READ_ONLY_WEEKLY_FREEZE_DOES_NOT_BUILD_OR_ACTIVATE',

    ...flags(),

    endpointMode: 'READ_ONLY_FOR_GET',
    cronDisabledExpected: true,

    currentWeekKey: getIsoWeekKey(),
    nextWeekKey: getNextIsoWeekKey(),

    activeRotation,
    nextRotation,
    validFrom,

    activeRotationId: activeRotation?.rotationId || null,
    nextRotationId: nextRotation?.rotationId || null,

    activeMicroFamilyIds: activeRotation?.microFamilyIds || [],
    nextMicroFamilyIds: nextRotation?.microFamilyIds || [],

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
    skipped: Boolean(lockResult?.skipped || payload?.skipped),

    source: 'API_WEEKLY_FREEZE_NEXT_ROTATION_ONLY',
    type: payload?.type || 'WEEKLY_FREEZE_NEXT_ROTATION_ONLY',

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

    nextRotation: payload?.nextRotation || null,
    nextRotationPersisted: Boolean(payload?.nextRotationPersisted),

    activeProtection: payload?.activeProtection || null,

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
  res.setHeader('X-Next-Rotation-Only', 'true');
  res.setHeader('X-Active-Rotation-Preserved', 'true');
  res.setHeader('X-Auto-Activation-Disabled', 'true');

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