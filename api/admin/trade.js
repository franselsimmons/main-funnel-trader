// ================= FILE: api/admin/trade.js =================

import { KEYS } from '../../src/keys.js';
import {
  getDurableRedis,
  getVolatileRedis,
  getJson
} from '../../src/redis.js';
import { getOpenPositions } from '../../src/trade/positionEngine.js';
import {
  safeNumber,
  sideToTradeSide,
  normalizeBaseSymbol,
  normalizeContractSymbol
} from '../../src/utils.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';

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

  if (value && typeof value === 'object') {
    return Object.values(value);
  }

  return [];
}

function num(value, fallback = 0) {
  return safeNumber(value, fallback);
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .flatMap((value) => String(value || '').split(/[\s,]+/g))
      .map((part) => part.trim())
      .filter(Boolean)
  )];
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

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    const value = upper(row);

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
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.entrySide ||
    row.bias ||
    row.marketBias
  );

  if (direct !== 'UNKNOWN') return direct;

  const rawSide = upper(row.side);

  if (['BEAR', 'SHORT', 'SELL', 'BEARISH'].includes(rawSide)) return 'SHORT';
  if (['BULL', 'LONG', 'BUY', 'BULLISH'].includes(rawSide)) return 'LONG';

  const familyId = upper(row.familyId || row.family || row.baseFamilyId);

  const macroFamilyId = upper(
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.macroFamily ||
    row.originalMicroFamilyId
  );

  const microFamilyId = upper(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.liveMicroFamilyId ||
    row.realMicroFamilyId ||
    row.executionMicroFamilyId ||
    row.id ||
    row.key
  );

  if (familyId.startsWith('SHORT_')) return 'SHORT';
  if (familyId.startsWith('LONG_')) return 'LONG';

  if (macroFamilyId.includes('MICRO_SHORT_') || macroFamilyId.startsWith('SHORT_')) return 'SHORT';
  if (macroFamilyId.includes('MICRO_LONG_') || macroFamilyId.startsWith('LONG_')) return 'LONG';

  if (macroFamilyId.includes('TRADESIDE=SHORT') || macroFamilyId.includes('SIDE=SHORT')) return 'SHORT';
  if (macroFamilyId.includes('TRADESIDE=LONG') || macroFamilyId.includes('SIDE=LONG')) return 'LONG';

  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';
  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';

  if (microFamilyId.includes('TRADESIDE=SHORT') || microFamilyId.includes('SIDE=SHORT')) return 'SHORT';
  if (microFamilyId.includes('TRADESIDE=LONG') || microFamilyId.includes('SIDE=LONG')) return 'LONG';

  const reason = upper(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason ||
    row.exitReason
  );

  if (
    reason.includes('SHORT') ||
    reason.includes('BEAR') ||
    reason.includes('SELL') ||
    reason.includes('DOWNSIDE')
  ) {
    return 'SHORT';
  }

  if (
    reason.includes('LONG') ||
    reason.includes('BULL') ||
    reason.includes('BUY') ||
    reason.includes('UPSIDE')
  ) {
    return 'LONG';
  }

  const definition = getDefinitionHaystack(row);

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

function forceShortRow(row = {}) {
  return {
    ...row,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true
  };
}

function normalizeDashboardSide(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE
    ? TARGET_DASHBOARD_SIDE
    : 'unknown';
}

function calcAgeSec(ts) {
  const value = num(ts, 0);

  if (value <= 0) return null;

  return Math.max(0, Math.floor((Date.now() - value) / 1000));
}

function calcRiskDistance(entry, initialSl) {
  const e = num(entry, 0);
  const sl = num(initialSl, 0);

  if (e <= 0 || sl <= 0) return 0;

  return Math.abs(e - sl);
}

function calcRewardDistance(entry, tp) {
  const e = num(entry, 0);
  const target = num(tp, 0);

  if (e <= 0 || target <= 0) return 0;

  return Math.abs(target - e);
}

function calcCurrentR({
  side,
  entry,
  initialSl,
  currentPrice,
  fallback = 0
} = {}) {
  const e = num(entry, 0);
  const sl = num(initialSl, 0);
  const price = num(currentPrice, 0);
  const riskDistance = calcRiskDistance(e, sl);

  if (e <= 0 || sl <= 0 || price <= 0 || riskDistance <= 0) {
    return num(fallback, 0);
  }

  const tradeSide = inferTradeSide({ side });

  if (tradeSide === 'SHORT') {
    return (e - price) / riskDistance;
  }

  return num(fallback, 0);
}

function getFamilyId(row = {}) {
  return (
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
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
    row.macroFamily ||
    row.originalMicroFamilyId ||
    null
  );
}

function getMicroFamilyId(row = {}) {
  return (
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.liveMicroFamilyId ||
    row.realMicroFamilyId ||
    row.executionMicroFamilyId ||
    row.id ||
    row.key ||
    null
  );
}

function normalizeDefinitionParts(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    return value
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizePosition(position = {}) {
  const symbol = normalizeBaseSymbol(
    position.symbol ||
    position.baseSymbol ||
    position.contractSymbol
  );

  const contractSymbol = normalizeContractSymbol(
    position.contractSymbol ||
    position.symbol ||
    symbol
  );

  const microFamilyId = getMicroFamilyId(position);
  const macroFamilyId = getMacroFamilyId(position) || microFamilyId;
  const familyId = getFamilyId(position);

  const tradeSide = inferTradeSide({
    ...position,
    microFamilyId,
    macroFamilyId,
    familyId
  });

  const entry = num(position.entry ?? position.entryPrice, 0);
  const sl = num(position.sl ?? position.stopLoss, 0);
  const initialSl = num(
    position.initialSl ??
    position.initialStopLoss ??
    sl,
    sl
  );
  const tp = num(position.tp ?? position.takeProfit, 0);

  const currentPrice = num(
    position.lastPrice ??
    position.currentPrice ??
    position.markPrice ??
    position.price,
    null
  );

  const riskDistance = calcRiskDistance(entry, initialSl);
  const rewardDistance = calcRewardDistance(entry, tp);

  const rr = num(
    position.rr,
    riskDistance > 0 ? rewardDistance / riskDistance : 0
  );

  const currentR = calcCurrentR({
    side: tradeSide,
    entry,
    initialSl,
    currentPrice,
    fallback: position.currentR
  });

  const openedAt = num(
    position.openedAt ??
    position.createdAt ??
    position.ts,
    null
  );

  const macroDefinitionParts = normalizeDefinitionParts(
    position.macroDefinitionParts ||
    position.parentDefinitionParts ||
    position.macroDefinition ||
    position.parentDefinition
  );

  const definitionParts = normalizeDefinitionParts(
    position.definitionParts ||
    position.microDefinitionParts ||
    position.definition ||
    position.microDefinition
  );

  return {
    ...position,

    symbol: symbol || position.symbol || null,
    baseSymbol: symbol || position.baseSymbol || null,
    contractSymbol,

    side: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_DASHBOARD_SIDE
      : normalizeDashboardSide({ ...position, tradeSide }),

    tradeSide,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    entry,
    sl,
    initialSl,
    tp,
    rr: round(rr, 4),

    currentPrice,
    currentR: round(currentR, 4),
    mfeR: round(position.mfeR, 4),
    maeR: round(position.maeR, 4),

    riskPct: round(position.riskPct, 6),
    riskFraction: round(position.riskFraction, 6),

    familyId,
    macroFamilyId,
    microFamilyId,

    macroDefinition: position.macroDefinition || position.parentDefinition || null,
    macroDefinitionParts,

    definition: position.definition || position.microDefinition || null,
    definitionParts,

    activeRotationId: position.activeRotationId || null,

    openedAt,
    ageSec: calcAgeSec(openedAt),

    riskDistance: round(riskDistance, 10),
    rewardDistance: round(rewardDistance, 10),

    ticksObserved: num(position.ticksObserved, 0),
    favorableTicks: num(position.favorableTicks, 0),
    adverseTicks: num(position.adverseTicks, 0),

    priceFetchFailures: num(position.priceFetchFailures, 0),
    lastPriceFetchFailedAt: position.lastPriceFetchFailedAt || null,

    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    nearTpSeen: Boolean(position.nearTpSeen),

    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: num(position.beExitR, 0),

    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),

    liveManaged: Boolean(position.liveManaged),
    beLiveApplied: Boolean(position.beLiveApplied),
    trailLiveApplied: Boolean(position.trailLiveApplied),
    slManagementSource: position.slManagementSource || null,

    breakEvenArmed: Boolean(position.beArmed || position.breakEvenArmed),
    trailingActive: Boolean(
      position.trailLiveApplied ||
      position.trailingActive ||
      upper(position.slManagementSource) === 'TRAIL'
    )
  };
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + num(selector(row), 0), 0);
}

function average(rows, selector) {
  if (!rows.length) return 0;

  return sum(rows, selector) / rows.length;
}

function countBy(rows, selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildPositionStats(positions = [], ignored = {}) {
  const shortRows = positions.filter((position) => isShortRow(position));

  const totalCurrentR = sum(shortRows, (p) => p.currentR);
  const totalMfeR = sum(shortRows, (p) => p.mfeR);
  const totalMaeR = sum(shortRows, (p) => p.maeR);
  const totalRiskFraction = sum(shortRows, (p) => p.riskFraction);

  const profitable = shortRows.filter((p) => num(p.currentR, 0) > 0);
  const losing = shortRows.filter((p) => num(p.currentR, 0) < 0);

  const uniqueMacroFamilies = uniqueStrings(
    shortRows.map((position) => position.macroFamilyId)
  );

  const uniqueMicroFamilies = uniqueStrings(
    shortRows.map((position) => position.microFamilyId)
  );

  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    openPositions: shortRows.length,

    bullPositions: 0,
    bearPositions: shortRows.length,
    unknownSidePositions: 0,

    longPositions: 0,
    shortPositions: shortRows.length,

    rawOpenPositions: num(ignored.rawOpenPositions, shortRows.length),
    ignoredLongPositions: num(ignored.ignoredLongPositions, 0),
    ignoredUnknownSidePositions: num(ignored.ignoredUnknownSidePositions, 0),

    profitablePositions: profitable.length,
    losingPositions: losing.length,
    flatPositions: shortRows.length - profitable.length - losing.length,

    totalCurrentR: round(totalCurrentR, 4),
    avgCurrentR: round(average(shortRows, (p) => p.currentR), 4),

    totalMfeR: round(totalMfeR, 4),
    avgMfeR: round(average(shortRows, (p) => p.mfeR), 4),

    totalMaeR: round(totalMaeR, 4),
    avgMaeR: round(average(shortRows, (p) => p.maeR), 4),

    totalRiskFraction: round(totalRiskFraction, 6),
    longRiskFraction: 0,
    shortRiskFraction: round(totalRiskFraction, 6),

    reachedHalfR: shortRows.filter((p) => p.reachedHalfR).length,
    reachedOneR: shortRows.filter((p) => p.reachedOneR).length,
    nearTpSeen: shortRows.filter((p) => p.nearTpSeen).length,

    beArmed: shortRows.filter((p) => p.beArmed).length,
    beWouldExit: shortRows.filter((p) => p.beWouldExit).length,

    breakEvenArmed: shortRows.filter((p) => p.breakEvenArmed).length,
    trailingActive: shortRows.filter((p) => p.trailingActive).length,

    gaveBackAfterHalfR: shortRows.filter((p) => p.gaveBackAfterHalfR).length,
    gaveBackAfterOneR: shortRows.filter((p) => p.gaveBackAfterOneR).length,
    nearTpThenLoss: shortRows.filter((p) => p.nearTpThenLoss).length,

    uniqueMacroFamilies: uniqueMacroFamilies.length,
    uniqueMicroFamilies: uniqueMicroFamilies.length,

    byMacroFamily: countBy(shortRows, (p) => p.macroFamilyId),
    byMicroFamily: countBy(shortRows, (p) => p.microFamilyId),
    bySide: {
      bear: shortRows.length,
      bull: 0,
      unknown: 0
    }
  };
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

function normalizeLastProcessed(lastProcessed) {
  const snapshotId = extractSnapshotId(lastProcessed);

  if (!lastProcessed) {
    return {
      snapshotId: null,
      raw: null
    };
  }

  if (typeof lastProcessed === 'string') {
    return {
      snapshotId: lastProcessed,
      raw: lastProcessed
    };
  }

  return {
    ...lastProcessed,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    snapshotId,
    raw: lastProcessed
  };
}

function normalizeAction(action = {}) {
  const microFamilyId = getMicroFamilyId(action);
  const macroFamilyId = getMacroFamilyId(action) || microFamilyId;
  const familyId = getFamilyId(action);

  const tradeSide = inferTradeSide({
    ...action,
    microFamilyId,
    macroFamilyId,
    familyId
  });

  return {
    ...action,

    side: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_DASHBOARD_SIDE
      : normalizeDashboardSide({
        ...action,
        tradeSide,
        microFamilyId,
        macroFamilyId,
        familyId
      }),

    tradeSide,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    familyId,
    macroFamilyId,
    microFamilyId,

    scannerScore: action.scannerScore ?? action.moveScore ?? null,

    confluence: round(action.confluence, 4),
    sniperScore: round(action.sniperScore, 4),

    rr: round(action.rr, 4),
    spreadPct: round(action.spreadPct, 6),
    depthMinUsd1p: round(action.depthMinUsd1p, 2),

    liveEligible: Boolean(action.liveEligible),
    shadowOnly: Boolean(action.shadowOnly)
  };
}

function actionCounts(actions = []) {
  return actions.reduce((acc, action) => {
    const key = action.action || action.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizeRunMeta(runMeta) {
  if (!runMeta || typeof runMeta !== 'object') return null;

  const rawActions = Array.isArray(runMeta.actions)
    ? runMeta.actions.map(normalizeAction)
    : [];

  const actions = rawActions
    .filter(isShortRow)
    .map(forceShortRow);

  const ignoredLongActions = rawActions.filter(isLongRow).length;
  const ignoredUnknownSideActions = rawActions.filter((action) => (
    inferTradeSide(action) === 'UNKNOWN'
  )).length;

  const realExitsRaw = Array.isArray(runMeta.realExits)
    ? runMeta.realExits.map(normalizeAction)
    : [];

  const shadowExitsRaw = Array.isArray(runMeta.shadowExits)
    ? runMeta.shadowExits.map(normalizeAction)
    : [];

  const realExits = realExitsRaw
    .filter(isShortRow)
    .map(forceShortRow);

  const shadowExits = shadowExitsRaw
    .filter(isShortRow)
    .map(forceShortRow);

  const entryActions = actions.filter((action) => action.action === 'ENTRY');
  const waitActions = actions.filter((action) => action.action === 'WAIT');

  return {
    ...runMeta,

    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    actionCounts: actionCounts(actions),
    rawActionCounts: runMeta.actionCounts || actionCounts(rawActions),

    actions,
    actionsCount: actions.length,

    rawActionsCount: rawActions.length,
    ignoredLongActions,
    ignoredUnknownSideActions,

    entriesCount: entryActions.length,
    waitsCount: waitActions.length,

    realExits,
    shadowExits,

    realExitsCount: realExits.length,
    shadowExitsCount: shadowExits.length,

    rawRealExitsCount: realExitsRaw.length,
    rawShadowExitsCount: shadowExitsRaw.length,

    ignoredLongRealExits: realExitsRaw.filter(isLongRow).length,
    ignoredLongShadowExits: shadowExitsRaw.filter(isLongRow).length,

    macroFamiliesSeen: uniqueStrings(
      actions.map((action) => action.macroFamilyId)
    ).length,

    microFamiliesSeen: uniqueStrings(
      actions.map((action) => action.microFamilyId)
    ).length
  };
}

function idsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const normalizedRows = rows.map(normalizeAction);
  const shortRows = normalizedRows
    .filter(isShortRow)
    .map(forceShortRow);

  const explicitMicroFamilyIds = uniqueStrings([
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.trueMicroFamilyIds,
    rotation.ids
  ]).filter((id) => inferTradeSide(id) === TARGET_TRADE_SIDE);

  const explicitMacroFamilyIds = uniqueStrings([
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rotation.macroIds
  ]).filter((id) => inferTradeSide(id) === TARGET_TRADE_SIDE);

  const rowMicroFamilyIds = uniqueStrings(
    shortRows.map((row) => row.microFamilyId)
  );

  const rowMacroFamilyIds = uniqueStrings(
    shortRows.map((row) => (
      row.macroFamilyId ||
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.microFamilyId
    ))
  );

  const microFamilyIds = uniqueStrings([
    rowMicroFamilyIds,
    explicitMicroFamilyIds
  ]);

  const macroFamilyIds = uniqueStrings([
    rowMacroFamilyIds,
    explicitMacroFamilyIds
  ]);

  return {
    microFamilyIds,
    macroFamilyIds: macroFamilyIds.length
      ? macroFamilyIds
      : microFamilyIds,
    shortRows,
    rawRows: normalizedRows
  };
}

function normalizeActiveRotation(activeRotation) {
  if (!activeRotation) {
    return {
      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,

      rotationId: null,
      activeMicroFamilyIds: [],
      activeMacroFamilyIds: [],
      activeMicroCount: 0,
      activeMacroCount: 0,
      microFamilies: [],
      bestLong: null,
      bestShort: null,
      raw: null
    };
  }

  const ids = idsFromRotation(activeRotation);
  const shortRows = ids.shortRows;

  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,
    longDisabled: true,

    rotationId: activeRotation.rotationId || null,

    activeMicroFamilyIds: ids.microFamilyIds,
    activeMacroFamilyIds: ids.macroFamilyIds,

    activeMicroCount: ids.microFamilyIds.length,
    activeMacroCount: ids.macroFamilyIds.length,

    sourceWeekKey: activeRotation.sourceWeekKey || null,
    activeWeekKey: activeRotation.activeWeekKey || null,
    mode: activeRotation.mode || null,
    source: activeRotation.source || null,

    trueMicroOnly: activeRotation.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation.usedLegacyFallback),
    usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation.usedObservationFallback),

    microFamilies: shortRows,
    bestLong: null,
    bestShort: shortRows[0] || null,

    rawRowsCount: ids.rawRows.length,
    ignoredLongRows: ids.rawRows.filter(isLongRow).length,
    ignoredUnknownSideRows: ids.rawRows.filter((row) => inferTradeSide(row) === 'UNKNOWN').length,

    raw: {
      ...activeRotation,
      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,
      microFamilies: shortRows,
      microFamilyIds: ids.microFamilyIds,
      activeMicroFamilyIds: ids.microFamilyIds,
      trueMicroFamilyIds: ids.microFamilyIds,
      macroFamilyIds: ids.macroFamilyIds,
      activeMacroFamilyIds: ids.macroFamilyIds,
      bestLong: null,
      bestShort: shortRows[0] || null
    }
  };
}

function buildRotationMatchStats(positions = [], activeRotationMeta = {}) {
  const activeMicroSet = new Set(activeRotationMeta.activeMicroFamilyIds || []);
  const activeMacroSet = new Set(activeRotationMeta.activeMacroFamilyIds || []);

  const activeMicroPositions = positions.filter((position) => (
    position.microFamilyId &&
    activeMicroSet.has(position.microFamilyId)
  ));

  const activeMacroPositions = positions.filter((position) => (
    position.macroFamilyId &&
    activeMacroSet.has(position.macroFamilyId)
  ));

  const outsideRotation = positions.filter((position) => (
    !activeMicroSet.has(position.microFamilyId) &&
    !activeMacroSet.has(position.macroFamilyId)
  ));

  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    shortOnly: true,

    activeMicroPositions: activeMicroPositions.length,
    activeMacroPositions: activeMacroPositions.length,
    outsideRotationPositions: outsideRotation.length,

    outsideRotationSymbols: outsideRotation.map((position) => position.symbol).filter(Boolean)
  };
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') return latestScan;

  return {
    ...latestScan,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Trade-Mode', 'short-only');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const durable = getDurableRedis();
    const volatile = getVolatileRedis();

    const [
      rawPositions,
      runMetaRaw,
      lastProcessedRaw,
      latestScanRaw,
      activeRotationRaw
    ] = await Promise.all([
      getOpenPositions(),
      getJson(durable, KEYS.trade.runMeta, null),
      getJson(durable, KEYS.trade.lastProcessedSnapshot, null),
      getJson(volatile, KEYS.scan.latest, null),
      getActiveRotation().catch(() => null)
    ]);

    const allPositions = asArray(rawPositions).map(normalizePosition);

    const positions = allPositions
      .filter(isShortRow)
      .map(forceShortRow);

    const ignoredLongPositions = allPositions.filter(isLongRow).length;
    const ignoredUnknownSidePositions = allPositions.filter((position) => (
      inferTradeSide(position) === 'UNKNOWN'
    )).length;

    const stats = buildPositionStats(positions, {
      rawOpenPositions: allPositions.length,
      ignoredLongPositions,
      ignoredUnknownSidePositions
    });

    const runMeta = normalizeRunMeta(runMetaRaw);
    const lastProcessed = normalizeLastProcessed(lastProcessedRaw);

    const latestScan = normalizeLatestScan(latestScanRaw);
    const latestScannerSnapshotId = extractSnapshotId(latestScanRaw);

    const scannerAndTradeInSync =
      Boolean(latestScannerSnapshotId) &&
      Boolean(lastProcessed.snapshotId) &&
      latestScannerSnapshotId === lastProcessed.snapshotId;

    const activeRotation = normalizeActiveRotation(activeRotationRaw);
    const rotationMatchStats = buildRotationMatchStats(
      positions,
      activeRotation
    );

    return res.status(200).json({
      ok: true,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      shortOnly: true,
      longDisabled: true,

      positions,
      openPositions: positions,
      positionsCount: positions.length,

      rawPositionsCount: allPositions.length,
      ignoredLongPositions,
      ignoredUnknownSidePositions,

      stats,
      rotationMatchStats,

      runMeta,
      lastProcessed,

      latestScan,
      latestScannerSnapshotId,
      scannerAndTradeInSync,

      activeRotationId: activeRotation.rotationId,
      activeMicroFamilyIds: activeRotation.activeMicroFamilyIds,
      activeMacroFamilyIds: activeRotation.activeMacroFamilyIds,
      activeMicroCount: activeRotation.activeMicroCount,
      activeMacroCount: activeRotation.activeMacroCount,
      activeRotation,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}