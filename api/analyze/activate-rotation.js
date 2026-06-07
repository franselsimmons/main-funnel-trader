// ================= FILE: api/analyze/activate-rotation.js =================

import { randomUUID } from 'node:crypto';

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getJson,
  setJson
} from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { getIsoWeekKey } from '../../src/utils.js';
import { activateSelectedMicroFamilies } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';

const LOCK_TTL_SEC = 600;

function now() {
  return Date.now();
}

function activeRotationKey() {
  return KEYS.analyze?.activeRotation || 'ANALYZE:ACTIVE_ROTATION';
}

function activateLockKey() {
  return KEYS.analyze?.activateLock || 'ANALYZE:ROTATION_ACTIVATE_LOCK';
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

    manualSelectionOnly: true,
    autoRotationDisabled: true,
    autoBootstrapDisabled: true,
    activateNextRotationDisabled: true,
    buildFreshRotationDisabled: true,

    noRealOrders: true,
    virtualLearningOnly: true,
    discordOnlyForManualSelection: true
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

function parseIdList(value) {
  if (!value) return [];

  if (Array.isArray(value)) return uniqueStrings(value);

  if (typeof value === 'string') {
    return uniqueStrings(value.split(/[\s,;\n\r]+/g));
  }

  if (typeof value === 'object') {
    return uniqueStrings([
      value.microFamilyIds,
      value.activeMicroFamilyIds,
      value.trueMicroFamilyIds,
      value.ids,
      value.microFamilyId,
      value.trueMicroFamilyId,
      value.id,
      value.key
    ]);
  }

  return [];
}

function extractMicroFamilyIds(req, body = {}) {
  const q = req.query || {};

  return uniqueStrings([
    parseIdList(body.microFamilyIds),
    parseIdList(body.activeMicroFamilyIds),
    parseIdList(body.trueMicroFamilyIds),
    parseIdList(body.ids),
    parseIdList(body.microFamilyId),
    parseIdList(body.id),

    parseIdList(q.microFamilyIds),
    parseIdList(q.activeMicroFamilyIds),
    parseIdList(q.trueMicroFamilyIds),
    parseIdList(q.ids),
    parseIdList(q.microFamilyId),
    parseIdList(q.id)
  ]);
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

  const values = [
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
  ];

  for (const value of values) {
    const side = inferTradeSideFromText(value);

    if (side !== 'UNKNOWN') return side;
  }

  if (row.shortOnly === true || row.longDisabled === true) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function isTargetSideRow(row = {}) {
  return inferRowTradeSide(row) === TARGET_TRADE_SIDE;
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

function filterTargetIds(ids = []) {
  return uniqueStrings(ids).filter((id) => (
    inferTradeSideFromText(id) === TARGET_TRADE_SIDE
  ));
}

function ignoredIds(requestedIds = [], acceptedIds = []) {
  const accepted = new Set(acceptedIds);

  return uniqueStrings(requestedIds)
    .filter((id) => !accepted.has(id))
    .map((id) => ({
      id,
      reason: inferTradeSideFromText(id) === 'LONG'
        ? 'LONG_DISABLED_SHORT_ONLY'
        : 'UNKNOWN_OR_NON_SHORT_MICRO_FAMILY_ID'
    }));
}

function getWeekKey(req, body = {}) {
  return String(
    firstValue(
      body.weekKey,
      firstValue(req.query?.weekKey, getIsoWeekKey())
    ) || getIsoWeekKey()
  ).trim();
}

function getMode(req, body = {}) {
  return String(
    firstValue(
      body.mode,
      firstValue(req.query?.mode, 'manual')
    ) || 'manual'
  ).trim();
}

function forceShortRow(row = {}, index = 0) {
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

    source: row.source || 'MANUAL_SELECTION',
    selectedTier: row.selectedTier || row.rotationEligibilityTier || 'MANUAL',
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || 'MANUAL',

    manualOnly: true,
    adminSelected: true,

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

    seen: 0,
    observations: 0,
    completed: 0,
    realCompleted: 0,
    shadowCompleted: 0,

    wins: 0,
    losses: 0,
    flats: 0,
    realWins: 0,
    realLosses: 0,
    realFlats: 0,

    winrate: 0,
    fairWinrate: 0,
    wilsonLowerBound: 0,

    avgR: 0,
    totalR: 0,
    realTotalR: 0,
    profitFactor: 0,

    totalCostR: 0,
    avgCostR: 0,

    selectedTier: 'MANUAL',
    rotationEligibilityTier: 'MANUAL',

    definitionParts: [
      `TRADE_SIDE=${TARGET_TRADE_SIDE}`,
      'MANUAL_SELECTION=true'
    ],
    definition: `TRADE_SIDE=${TARGET_TRADE_SIDE} | MANUAL_SELECTION=true`
  }, index);
}

function extractEngineRotation(result) {
  if (!result || typeof result !== 'object') return null;

  return (
    result.activeRotation ||
    result.active ||
    result.rotation ||
    result.result?.activeRotation ||
    result.result?.active ||
    result.result?.rotation ||
    result
  );
}

function extractEngineRows(result) {
  const rotation = extractEngineRotation(result);

  if (Array.isArray(rotation?.microFamilies)) return rotation.microFamilies;
  if (Array.isArray(result?.microFamilies)) return result.microFamilies;
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result?.activeRows)) return result.activeRows;

  return [];
}

function buildSelectionIndexes(rows = []) {
  const microFamilyIds = uniqueStrings(
    rows.map((row) => row.microFamilyId || row.trueMicroFamilyId || row.id)
  );

  const macroFamilyIds = uniqueStrings(
    rows.map((row) => getMacroFamilyId(row))
  );

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of rows) {
    const microId = String(row.microFamilyId || row.trueMicroFamilyId || row.id || '').trim();
    const macroId = String(getMacroFamilyId(row) || '').trim();

    if (!microId || !macroId) continue;

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

function normalizeManualActiveRotation({
  requestedMicroFamilyIds = [],
  acceptedMicroFamilyIds = [],
  engineResult = null,
  weekKey,
  mode
} = {}) {
  const acceptedSet = new Set(acceptedMicroFamilyIds);

  const engineRows = extractEngineRows(engineResult)
    .filter(isTargetSideRow)
    .map((row, index) => forceShortRow(row, index))
    .filter((row) => acceptedSet.has(row.microFamilyId));

  const rowsById = new Map();

  for (const row of engineRows) {
    if (!row.microFamilyId) continue;
    rowsById.set(row.microFamilyId, row);
  }

  for (const id of acceptedMicroFamilyIds) {
    if (rowsById.has(id)) continue;

    rowsById.set(id, buildManualRow(id, rowsById.size));
  }

  const microFamilies = [...rowsById.values()]
    .map((row, index) => forceShortRow({
      ...row,
      rank: index + 1
    }, index));

  const indexes = buildSelectionIndexes(microFamilies);
  const engineRotation = extractEngineRotation(engineResult);
  const empty = microFamilies.length === 0;

  return {
    ...(engineRotation && typeof engineRotation === 'object' ? engineRotation : {}),

    rotationId:
      engineRotation?.rotationId ||
      `ROT_MANUAL_SHORT_${randomUUID()}`,

    source: 'ADMIN_MANUAL_SELECTION_SHORT_ONLY',
    mode: mode || 'manual',
    sideMode: 'short_only',

    sourceWeekKey: weekKey,
    activeWeekKey: weekKey,

    generatedAt: now(),
    activatedAt: now(),

    ...flags(),

    trueMicroOnly: true,
    manualOnly: true,
    adminSelected: true,
    autoRotation: false,
    liveSelectable: !empty,

    empty,
    emptyReason: empty
      ? 'NO_VALID_SHORT_MICRO_FAMILY_IDS_SELECTED'
      : null,

    requestedMicroFamilyIds: uniqueStrings(requestedMicroFamilyIds),
    ignoredRequestedIds: ignoredIds(requestedMicroFamilyIds, acceptedMicroFamilyIds),

    ...indexes,

    microFamilies,

    selectedMicroFamilyId: microFamilies[0]?.microFamilyId || null,
    selectedMacroFamilyId: microFamilies[0]?.macroFamilyId || null,
    selectedRow: microFamilies[0] || null,

    bestLong: null,
    bestShort: microFamilies[0] || null,

    missingSides: empty ? [TARGET_TRADE_SIDE] : [],

    count: microFamilies.length,
    activeCount: microFamilies.length,
    microCount: microFamilies.length,
    trueMicroCount: microFamilies.length,
    macroCount: indexes.macroFamilyIds.length
  };
}

async function readStoredActiveRotation(redis) {
  const active = await getJson(redis, activeRotationKey(), null).catch(() => null);

  if (!active) return null;

  const rows = Array.isArray(active.microFamilies)
    ? active.microFamilies
      .filter(isTargetSideRow)
      .map((row, index) => forceShortRow(row, index))
    : [];

  const indexes = buildSelectionIndexes(rows);

  return {
    ...active,
    ...flags(),

    microFamilies: rows,

    microFamilyIds: indexes.microFamilyIds.length
      ? indexes.microFamilyIds
      : filterTargetIds([
        active.microFamilyIds,
        active.activeMicroFamilyIds,
        active.trueMicroFamilyIds,
        active.ids
      ]),

    activeMicroFamilyIds: indexes.activeMicroFamilyIds.length
      ? indexes.activeMicroFamilyIds
      : filterTargetIds([
        active.microFamilyIds,
        active.activeMicroFamilyIds,
        active.trueMicroFamilyIds,
        active.ids
      ]),

    trueMicroFamilyIds: indexes.trueMicroFamilyIds.length
      ? indexes.trueMicroFamilyIds
      : filterTargetIds([
        active.microFamilyIds,
        active.activeMicroFamilyIds,
        active.trueMicroFamilyIds,
        active.ids
      ]),

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    bestLong: null,
    bestShort: rows[0] || active.bestShort || null,

    manualOnly: active.manualOnly !== false,
    adminSelected: active.adminSelected !== false,
    autoRotation: false
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

async function activateManualSelection({
  redis,
  requestedMicroFamilyIds,
  acceptedMicroFamilyIds,
  weekKey,
  mode
}) {
  if (acceptedMicroFamilyIds.length <= 0) {
    return {
      ok: false,
      skipped: true,
      reason: requestedMicroFamilyIds.length > 0
        ? 'NO_VALID_SHORT_MICRO_FAMILY_IDS'
        : 'MANUAL_MICRO_FAMILY_IDS_REQUIRED',

      ...flags(),

      weekKey,
      mode,

      requestedMicroFamilyIds,
      acceptedMicroFamilyIds: [],
      ignoredRequestedIds: ignoredIds(requestedMicroFamilyIds, [])
    };
  }

  let engineResult = null;
  let engineError = null;

  try {
    engineResult = await activateSelectedMicroFamilies({
      microFamilyIds: acceptedMicroFamilyIds,
      activeMicroFamilyIds: acceptedMicroFamilyIds,
      trueMicroFamilyIds: acceptedMicroFamilyIds,

      weekKey,
      activeWeekKey: weekKey,
      mode: mode || 'manual',

      source: 'ADMIN_MANUAL_SELECTION_SHORT_ONLY',

      targetTradeSide: TARGET_TRADE_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      disableLong: true,
      manualOnly: true,
      adminSelected: true,
      autoRotation: false
    });
  } catch (error) {
    engineError = error?.message || String(error);
  }

  const activeRotation = normalizeManualActiveRotation({
    requestedMicroFamilyIds,
    acceptedMicroFamilyIds,
    engineResult,
    weekKey,
    mode
  });

  await setJson(
    redis,
    activeRotationKey(),
    activeRotation
  );

  return {
    ok: true,
    skipped: false,
    type: 'MANUAL_SHORT_MICRO_FAMILY_ROTATION_ACTIVATED',

    ...flags(),

    weekKey,
    activeWeekKey: weekKey,
    mode: mode || 'manual',

    rotationId: activeRotation.rotationId,

    activatedCount: activeRotation.microFamilies.length,
    activatedMicroCount: activeRotation.activeMicroFamilyIds.length,
    activatedMacroCount: activeRotation.activeMacroFamilyIds.length,

    requestedMicroFamilyIds,
    acceptedMicroFamilyIds,
    ignoredRequestedIds: activeRotation.ignoredRequestedIds,

    activeMicroFamilyIds: activeRotation.activeMicroFamilyIds,
    activeMacroFamilyIds: activeRotation.activeMacroFamilyIds,

    activeRotation,
    active: activeRotation,

    engineResult,
    engineError,

    warnings: [
      engineError
        ? `ROTATION_ENGINE_FALLBACK_USED:${engineError}`
        : null,
      activeRotation.microFamilies.some((row) => row.manualOnly)
        ? 'MANUAL_ROWS_USED_FOR_IDS_NOT_FOUND_IN_WEEK_MICROS'
        : null
    ].filter(Boolean)
  };
}

async function handleGet(req, res) {
  const startedAt = now();
  const redis = getDurableRedis();
  const activeRotation = await readStoredActiveRotation(redis);

  return res.status(200).json({
    ok: true,
    skipped: true,
    reason: 'AUTO_ROTATION_ENDPOINT_DISABLED_MANUAL_SELECTION_ONLY',

    ...flags(),

    endpointMode: 'READ_ONLY_FOR_GET',
    cronSafe: true,

    currentWeekKey: getIsoWeekKey(),

    activeRotation,
    active: activeRotation,

    activeRotationId: activeRotation?.rotationId || null,
    activeMicroFamilyIds: activeRotation?.activeMicroFamilyIds || [],
    activeMacroFamilyIds: activeRotation?.activeMacroFamilyIds || [],

    activatedCount: activeRotation?.activeMicroFamilyIds?.length || 0,

    durationMs: now() - startedAt,
    serverTs: Date.now()
  });
}

async function handlePost(req, res) {
  const startedAt = now();
  const body = await readBody(req);
  const redis = getDurableRedis();

  const requestedMicroFamilyIds = extractMicroFamilyIds(req, body);
  const acceptedMicroFamilyIds = filterTargetIds(requestedMicroFamilyIds);

  const weekKey = getWeekKey(req, body);
  const mode = getMode(req, body);

  const hasManualIds = requestedMicroFamilyIds.length > 0;

  if (!hasManualIds) {
    const activeRotation = await readStoredActiveRotation(redis);

    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'AUTO_ACTIVATION_DISABLED_MANUAL_MICRO_IDS_REQUIRED',

      ...flags(),

      blockedAutoActions: [
        'activateNextRotation',
        'buildRotationFromWeek',
        'autoBuildIfMissing',
        'weeklyFreezeActivation'
      ],

      currentWeekKey: getIsoWeekKey(),
      weekKey,
      mode,

      activeRotation,
      active: activeRotation,

      activeRotationId: activeRotation?.rotationId || null,
      activeMicroFamilyIds: activeRotation?.activeMicroFamilyIds || [],
      activeMacroFamilyIds: activeRotation?.activeMacroFamilyIds || [],

      requestedMicroFamilyIds: [],
      acceptedMicroFamilyIds: [],
      ignoredRequestedIds: [],

      durationMs: now() - startedAt,
      serverTs: Date.now()
    });
  }

  const lockResult = await withRedisLock(
    redis,
    activateLockKey(),
    LOCK_TTL_SEC,
    async () => activateManualSelection({
      redis,
      requestedMicroFamilyIds,
      acceptedMicroFamilyIds,
      weekKey,
      mode
    })
  );

  const result = unwrapLockResult(lockResult);

  const ok = lockResult?.ok === false || result?.ok === false
    ? false
    : true;

  return res.status(ok ? 200 : 400).json({
    ok,
    skipped: Boolean(lockResult?.skipped || result?.skipped),

    source: 'ADMIN_MANUAL_ACTIVATE_SHORT_MICRO_FAMILIES_ONLY',
    type: result?.type || null,

    ...flags(),

    weekKey,
    mode,

    rotationId: result?.rotationId || result?.activeRotation?.rotationId || null,

    activatedCount: result?.activatedCount || 0,
    activatedMicroCount: result?.activatedMicroCount || 0,
    activatedMacroCount: result?.activatedMacroCount || 0,

    requestedMicroFamilyIds,
    acceptedMicroFamilyIds,
    ignoredRequestedIds: ignoredIds(requestedMicroFamilyIds, acceptedMicroFamilyIds),

    activeMicroFamilyIds: result?.activeMicroFamilyIds || [],
    activeMacroFamilyIds: result?.activeMacroFamilyIds || [],

    reason: result?.reason || lockResult?.reason || null,
    warnings: result?.warnings || [],

    result,

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
  res.setHeader('X-Auto-Rotation-Disabled', 'true');
  res.setHeader('X-Manual-Selection-Only', 'true');

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