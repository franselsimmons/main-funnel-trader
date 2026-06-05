// ================= FILE: api/admin/overview.js =================

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson,
  readJsonLogs
} from '../../src/redis.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { getRotationDashboard } from '../../src/analyze/rotationEngine.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);

  return [];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function extractSnapshotId(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    return (
      value.snapshotId ||
      value.id ||
      value.latestSnapshotId ||
      value.scanId ||
      null
    );
  }

  return null;
}

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => upper(value))
    .join(' | ');
}

function inferTradeSide(input = {}) {
  if (typeof input === 'string') {
    const value = upper(input);

    if (!value) return 'UNKNOWN';

    if (
      value.includes('MICRO_SHORT_') ||
      value.includes('TRADESIDE=SHORT') ||
      value.includes('TRADE_SIDE=SHORT') ||
      value.includes('SIDE=SHORT') ||
      value.includes('SIDE=BEAR') ||
      value.includes('DIRECTION=SHORT') ||
      value.includes('DIRECTION=BEAR') ||
      value.includes('SHORT')
    ) {
      return 'SHORT';
    }

    if (
      value.includes('MICRO_LONG_') ||
      value.includes('TRADESIDE=LONG') ||
      value.includes('TRADE_SIDE=LONG') ||
      value.includes('SIDE=LONG') ||
      value.includes('SIDE=BULL') ||
      value.includes('DIRECTION=LONG') ||
      value.includes('DIRECTION=BULL') ||
      value.includes('LONG')
    ) {
      return 'LONG';
    }

    return 'UNKNOWN';
  }

  const direct = sideToTradeSide(
    input.tradeSide ||
    input.side ||
    input.positionSide ||
    input.direction ||
    input.signalSide ||
    input.scannerSide ||
    input.entrySide ||
    input.bias ||
    input.marketBias
  );

  if (direct !== 'UNKNOWN') return direct;

  const rawSide = upper(input.side);

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(rawSide)) return 'SHORT';
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(rawSide)) return 'LONG';

  const familyId = upper(input.familyId || input.family || input.baseFamilyId);

  const macroFamilyId = upper(
    input.parentMacroFamilyId ||
    input.macroFamilyId ||
    input.parentMicroFamilyId ||
    input.parentFamilyId ||
    input.macroId
  );

  const microFamilyId = upper(
    input.microFamilyId ||
    input.trueMicroFamilyId ||
    input.id ||
    input.key
  );

  if (familyId.startsWith('SHORT_')) return 'SHORT';
  if (familyId.startsWith('LONG_')) return 'LONG';

  if (macroFamilyId.includes('SHORT')) return 'SHORT';
  if (macroFamilyId.includes('LONG')) return 'LONG';

  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';
  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';

  if (microFamilyId.includes('TRADESIDE=SHORT')) return 'SHORT';
  if (microFamilyId.includes('TRADESIDE=LONG')) return 'LONG';

  const definition = getDefinitionHaystack(input);

  if (
    definition.includes('TRADESIDE=SHORT') ||
    definition.includes('TRADE_SIDE=SHORT') ||
    definition.includes('SIDE=SHORT') ||
    definition.includes('SIDE=BEAR') ||
    definition.includes('DIRECTION=SHORT') ||
    definition.includes('DIRECTION=BEAR') ||
    definition.includes('SIDE=SELL') ||
    definition.includes('DIRECTION=SELL')
  ) {
    return 'SHORT';
  }

  if (
    definition.includes('TRADESIDE=LONG') ||
    definition.includes('TRADE_SIDE=LONG') ||
    definition.includes('SIDE=LONG') ||
    definition.includes('SIDE=BULL') ||
    definition.includes('DIRECTION=LONG') ||
    definition.includes('DIRECTION=BULL') ||
    definition.includes('SIDE=BUY') ||
    definition.includes('DIRECTION=BUY')
  ) {
    return 'LONG';
  }

  if (microFamilyId.includes('SHORT')) return 'SHORT';
  if (microFamilyId.includes('LONG')) return 'LONG';

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isLongRow(row = {}) {
  return inferTradeSide(row) === 'LONG';
}

function isShortId(id = '') {
  return inferTradeSide(String(id || '')) === TARGET_TRADE_SIDE;
}

function filterShortRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .filter(isShortRow);
}

function countMapOrArray(value) {
  if (Array.isArray(value)) {
    return filterShortRows(value).length;
  }

  if (value && typeof value === 'object') {
    return Object.values(value).filter(isShortRow).length;
  }

  return 0;
}

function countLongMapOrArray(value) {
  if (Array.isArray(value)) {
    return value.filter(isLongRow).length;
  }

  if (value && typeof value === 'object') {
    return Object.values(value).filter(isLongRow).length;
  }

  return 0;
}

function normalizeShortSide(row = {}) {
  return {
    ...row,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE
  };
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') {
    return null;
  }

  const rawCandidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const candidates = filterShortRows(rawCandidates).map(normalizeShortSide);

  const createdAt = safeNumber(
    latestScan.createdAt ||
    latestScan.ts ||
    latestScan.scannerTs,
    0
  );

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
    : null;

  const topSymbols = rawCandidates.length > 0
    ? candidates.slice(0, 20).map((row) => row.symbol).filter(Boolean)
    : Array.isArray(latestScan.topSymbols)
      ? latestScan.topSymbols
      : [];

  return {
    ...latestScan,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    snapshotId: extractSnapshotId(latestScan),

    createdAt: createdAt || null,
    snapshotAgeSec,

    rawCandidatesCount: rawCandidates.length,

    candidatesCount: rawCandidates.length > 0
      ? candidates.length
      : safeNumber(
        latestScan.shortCandidatesCount ??
        latestScan.scannerGateCandidatesCount ??
        latestScan.candidatesCount ??
        latestScan.count,
        0
      ),

    shortCandidatesCount: candidates.length,

    longCandidatesIgnored: rawCandidates.filter(isLongRow).length,

    topSymbols,

    candidates
  };
}

function normalizeRotation(rotation) {
  if (!rotation || typeof rotation !== 'object') {
    return null;
  }

  const rawMicroFamilies = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const microFamilies = rawMicroFamilies
    .filter(isShortRow)
    .map(normalizeShortSide);

  const rowIds = microFamilies
    .map((row) => row.microFamilyId || row.trueMicroFamilyId || row.id)
    .filter(Boolean);

  const explicitIds = Array.isArray(rotation.microFamilyIds)
    ? rotation.microFamilyIds.filter(isShortId)
    : [];

  const microFamilyIds = uniqueStrings([
    ...explicitIds,
    ...rowIds
  ]);

  const macroFamilyIds = uniqueStrings([
    ...(Array.isArray(rotation.macroFamilyIds) ? rotation.macroFamilyIds : []),
    ...(Array.isArray(rotation.activeMacroFamilyIds) ? rotation.activeMacroFamilyIds : []),
    ...microFamilies.map((row) => (
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId
    ))
  ])
    .filter((id) => isShortId(id) || upper(id).includes('SHORT'));

  const bestShortRaw =
    rotation.bestShort ||
    microFamilies.find((row) => isShortRow(row)) ||
    null;

  const bestShort = bestShortRaw
    ? normalizeShortSide(bestShortRaw)
    : null;

  return {
    ...rotation,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    sideMode: 'short_only',

    bestLong: null,
    bestShort,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microFamilies,

    count: microFamilyIds.length || microFamilies.length,

    rawMicroFamiliesCount: rawMicroFamilies.length,
    longMicroFamiliesIgnored: rawMicroFamilies.filter(isLongRow).length,

    missingSides: microFamilyIds.length || microFamilies.length
      ? []
      : [TARGET_TRADE_SIDE]
  };
}

function buildShortActionCounts(actions = [], fallbackCounts = {}) {
  const shortActions = filterShortRows(actions);

  if (!shortActions.length && !actions.length) {
    return fallbackCounts || {};
  }

  return shortActions.reduce((acc, row) => {
    const key = row?.action || row?.type || 'UNKNOWN';

    acc[key] = (acc[key] || 0) + 1;

    return acc;
  }, {});
}

function buildTradeSummary(tradeMeta) {
  if (!tradeMeta || typeof tradeMeta !== 'object') {
    return {
      lastRunAt: null,
      actionCounts: {},
      realExits: 0,
      shadowExits: 0,
      skippedNewEntries: null,
      reason: null,

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true
    };
  }

  const actions = Array.isArray(tradeMeta.actions)
    ? tradeMeta.actions
    : [];

  const shortActions = filterShortRows(actions);
  const longActionsIgnored = actions.filter(isLongRow).length;

  const realExits = Array.isArray(tradeMeta.realExits)
    ? filterShortRows(tradeMeta.realExits)
    : [];

  const shadowExits = Array.isArray(tradeMeta.shadowExits)
    ? filterShortRows(tradeMeta.shadowExits)
    : [];

  return {
    lastRunAt: tradeMeta.completedAt || tradeMeta.startedAt || tradeMeta.ts || null,
    durationMs: tradeMeta.durationMs ?? null,

    snapshotId: tradeMeta.snapshotId || null,
    snapshotAgeSec: tradeMeta.snapshotAgeSec ?? null,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    actionCounts: buildShortActionCounts(actions, tradeMeta.actionCounts || {}),

    actions: shortActions.length,
    rawActions: actions.length,
    longActionsIgnored,

    realExits: realExits.length,
    shadowExits: shadowExits.length,

    skippedNewEntries: Boolean(tradeMeta.skippedNewEntries),
    reason: tradeMeta.reason || null,

    activeRotationId: tradeMeta.activeRotationId || null,
    activeMicroFamilies: tradeMeta.activeMicroFamilies ?? null
  };
}

function compactRotationDashboard(rotationDashboard = {}) {
  const active = normalizeRotation(
    rotationDashboard.active ||
    rotationDashboard.activeRotation ||
    null
  );

  const next = normalizeRotation(
    rotationDashboard.next ||
    rotationDashboard.nextRotation ||
    null
  );

  return {
    ...rotationDashboard,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    active,
    next,
    activeRotation: active,
    nextRotation: next,

    activeRows: filterShortRows(rotationDashboard.activeRows || []).map(normalizeShortSide),
    nextRows: filterShortRows(rotationDashboard.nextRows || []).map(normalizeShortSide),

    activeCount: active?.count || 0,
    nextCount: next?.count || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    bestLong: null,
    bestShort: active?.bestShort || null,

    nextBestLong: null,
    nextBestShort: next?.bestShort || null,

    missingSides: active?.missingSides || [],
    nextMissingSides: next?.missingSides || []
  };
}

async function safeRead(label, fn, fallback) {
  try {
    const value = await fn();

    return {
      ok: true,
      label,
      value
    };
  } catch (error) {
    return {
      ok: false,
      label,
      value: fallback,
      error: error?.message || String(error)
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Overview-Mode', 'short-only');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const weekKey = getIsoWeekKey();
    const previousWeekKey = getPreviousIsoWeekKey();

    const [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
    ] = await Promise.all([
      safeRead(
        'latestScan',
        () => getJson(volatile, KEYS.scan.latest, null),
        null
      ),

      safeRead(
        'tradeMeta',
        () => getJson(durable, KEYS.trade.runMeta, null),
        null
      ),

      safeRead(
        'openPositions',
        () => getOpenPositions(),
        []
      ),

      safeRead(
        'currentWeekMicros',
        () => getWeekMicros(weekKey),
        {}
      ),

      safeRead(
        'previousWeekMicros',
        () => getWeekMicros(previousWeekKey),
        {}
      ),

      safeRead(
        'rotationDashboard',
        () => getRotationDashboard(),
        {
          active: null,
          next: null,
          validFrom: null,
          activeRows: [],
          nextRows: [],
          activeCount: 0,
          nextCount: 0
        }
      ),

      safeRead(
        'discordLogs',
        () => readJsonLogs(durable, KEYS.discord.logList, 10),
        []
      )
    ]);

    const latestScan = normalizeLatestScan(latestScanRead.value);
    const tradeMeta = tradeMetaRead.value || null;
    const tradeSummary = buildTradeSummary(tradeMeta);

    const rawPositions = asArray(positionsRead.value);
    const positions = filterShortRows(rawPositions).map(normalizeShortSide);

    const currentMicros = currentMicrosRead.value || {};
    const previousMicros = previousMicrosRead.value || {};

    const rawRotationDashboard = rotationRead.value || {};
    const rotationDashboard = compactRotationDashboard(rawRotationDashboard);

    const activeRotation = rotationDashboard.active || null;
    const nextRotation = rotationDashboard.next || null;

    const discordLogs = Array.isArray(discordLogsRead.value)
      ? discordLogsRead.value
      : [];

    const warnings = [
      latestScanRead,
      tradeMetaRead,
      positionsRead,
      currentMicrosRead,
      previousMicrosRead,
      rotationRead,
      discordLogsRead
    ]
      .filter((row) => !row.ok)
      .map((row) => ({
        source: row.label,
        error: row.error
      }));

    const longIgnored = {
      positions: rawPositions.filter(isLongRow).length,
      currentWeekMicroFamilies: countLongMapOrArray(currentMicros),
      previousWeekMicroFamilies: countLongMapOrArray(previousMicros),
      scannerCandidates: latestScan?.longCandidatesIgnored || 0,
      activeRotationRows: activeRotation?.longMicroFamiliesIgnored || 0,
      nextRotationRows: nextRotation?.longMicroFamiliesIgnored || 0
    };

    return res.status(200).json({
      ok: true,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      shortOnly: true,
      longDisabled: true,

      weekKey,
      currentWeekKey: weekKey,
      previousWeekKey,

      latestScan,
      latestScannerSnapshotId: latestScan?.snapshotId || null,

      scannerCandidates: latestScan?.candidatesCount || 0,
      shortScannerCandidates: latestScan?.shortCandidatesCount || latestScan?.candidatesCount || 0,

      tradeMeta,
      tradeSummary,

      openPositions: positions.length,
      positionsCount: positions.length,
      rawPositionsCount: rawPositions.length,
      positions,

      currentWeekMicroFamilies: countMapOrArray(currentMicros),
      previousWeekMicroFamilies: countMapOrArray(previousMicros),

      activeRotation,
      nextRotation,

      activeRotationId: activeRotation?.rotationId || null,
      nextRotationId: nextRotation?.rotationId || null,

      activeRotationCount: activeRotation?.count || 0,
      nextRotationCount: nextRotation?.count || 0,

      activeMicroFamilyIds: activeRotation?.microFamilyIds || [],
      nextMicroFamilyIds: nextRotation?.microFamilyIds || [],

      activeMacroFamilyIds: activeRotation?.macroFamilyIds || [],
      nextMacroFamilyIds: nextRotation?.macroFamilyIds || [],

      bestLong: null,
      bestShort: activeRotation?.bestShort || null,
      nextBestLong: null,
      nextBestShort: nextRotation?.bestShort || null,

      rotationDashboard,

      discordLogs,

      longIgnored,
      warnings,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}