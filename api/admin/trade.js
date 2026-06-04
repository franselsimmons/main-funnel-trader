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
    (Array.isArray(values) ? values : [])
      .flatMap((value) => {
        if (Array.isArray(value)) return value;

        return String(value || '')
          .split(/[\s,]+/g)
          .map((part) => part.trim());
      })
      .filter(Boolean)
  )];
}

function inferTradeSide(row = {}) {
  const direct = sideToTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction
  );

  if (direct !== 'UNKNOWN') return direct;

  const rawSide = upper(row.side);

  if (['BULL', 'LONG', 'BUY'].includes(rawSide)) return 'LONG';
  if (['BEAR', 'SHORT', 'SELL'].includes(rawSide)) return 'SHORT';

  const familyId = upper(row.familyId);
  const macroFamilyId = upper(row.macroFamilyId);
  const microFamilyId = upper(row.microFamilyId);

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('MICRO_LONG_') || macroFamilyId.startsWith('LONG_')) {
    return 'LONG';
  }

  if (macroFamilyId.includes('MICRO_SHORT_') || macroFamilyId.startsWith('SHORT_')) {
    return 'SHORT';
  }

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

  return 'UNKNOWN';
}

function normalizeDashboardSide(row = {}) {
  const tradeSide = inferTradeSide(row);

  if (tradeSide === 'LONG') return 'bull';
  if (tradeSide === 'SHORT') return 'bear';

  return 'unknown';
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

  if (tradeSide === 'LONG') {
    return (price - e) / riskDistance;
  }

  if (tradeSide === 'SHORT') {
    return (e - price) / riskDistance;
  }

  return num(fallback, 0);
}

function getFamilyId(position = {}) {
  return (
    position.familyId ||
    position.family ||
    position.baseFamilyId ||
    null
  );
}

function getMacroFamilyId(position = {}) {
  return (
    position.macroFamilyId ||
    position.parentMicroFamilyId ||
    position.parentFamilyId ||
    position.macroId ||
    position.macroFamily ||
    position.originalMicroFamilyId ||
    null
  );
}

function getMicroFamilyId(position = {}) {
  return (
    position.microFamilyId ||
    position.liveMicroFamilyId ||
    position.realMicroFamilyId ||
    position.executionMicroFamilyId ||
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

  const side = normalizeDashboardSide({
    ...position,
    tradeSide,
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
    position.macroDefinition
  );

  const definitionParts = normalizeDefinitionParts(
    position.definitionParts ||
    position.microDefinitionParts ||
    position.definition
  );

  return {
    ...position,

    symbol: symbol || position.symbol || null,
    baseSymbol: symbol || position.baseSymbol || null,
    contractSymbol,

    side,
    tradeSide,

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

    macroDefinition: position.macroDefinition || null,
    macroDefinitionParts,

    definition: position.definition || null,
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

function buildPositionStats(positions = []) {
  const bull = positions.filter((position) => position.side === 'bull');
  const bear = positions.filter((position) => position.side === 'bear');
  const unknown = positions.filter((position) => position.side === 'unknown');

  const totalCurrentR = sum(positions, (p) => p.currentR);
  const totalMfeR = sum(positions, (p) => p.mfeR);
  const totalMaeR = sum(positions, (p) => p.maeR);
  const totalRiskFraction = sum(positions, (p) => p.riskFraction);

  const profitable = positions.filter((p) => num(p.currentR, 0) > 0);
  const losing = positions.filter((p) => num(p.currentR, 0) < 0);

  const longRiskFraction = sum(bull, (p) => p.riskFraction);
  const shortRiskFraction = sum(bear, (p) => p.riskFraction);

  const uniqueMacroFamilies = uniqueStrings(
    positions.map((position) => position.macroFamilyId)
  );

  const uniqueMicroFamilies = uniqueStrings(
    positions.map((position) => position.microFamilyId)
  );

  return {
    openPositions: positions.length,

    bullPositions: bull.length,
    bearPositions: bear.length,
    unknownSidePositions: unknown.length,

    longPositions: bull.length,
    shortPositions: bear.length,

    profitablePositions: profitable.length,
    losingPositions: losing.length,
    flatPositions: positions.length - profitable.length - losing.length,

    totalCurrentR: round(totalCurrentR, 4),
    avgCurrentR: round(average(positions, (p) => p.currentR), 4),

    totalMfeR: round(totalMfeR, 4),
    avgMfeR: round(average(positions, (p) => p.mfeR), 4),

    totalMaeR: round(totalMaeR, 4),
    avgMaeR: round(average(positions, (p) => p.maeR), 4),

    totalRiskFraction: round(totalRiskFraction, 6),
    longRiskFraction: round(longRiskFraction, 6),
    shortRiskFraction: round(shortRiskFraction, 6),

    reachedHalfR: positions.filter((p) => p.reachedHalfR).length,
    reachedOneR: positions.filter((p) => p.reachedOneR).length,
    nearTpSeen: positions.filter((p) => p.nearTpSeen).length,

    beArmed: positions.filter((p) => p.beArmed).length,
    beWouldExit: positions.filter((p) => p.beWouldExit).length,

    breakEvenArmed: positions.filter((p) => p.breakEvenArmed).length,
    trailingActive: positions.filter((p) => p.trailingActive).length,

    gaveBackAfterHalfR: positions.filter((p) => p.gaveBackAfterHalfR).length,
    gaveBackAfterOneR: positions.filter((p) => p.gaveBackAfterOneR).length,
    nearTpThenLoss: positions.filter((p) => p.nearTpThenLoss).length,

    uniqueMacroFamilies: uniqueMacroFamilies.length,
    uniqueMicroFamilies: uniqueMicroFamilies.length,

    byMacroFamily: countBy(positions, (p) => p.macroFamilyId),
    byMicroFamily: countBy(positions, (p) => p.microFamilyId),
    bySide: countBy(positions, (p) => p.side)
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

    side: normalizeDashboardSide({
      ...action,
      tradeSide,
      microFamilyId,
      macroFamilyId,
      familyId
    }),
    tradeSide,

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

function normalizeRunMeta(runMeta) {
  if (!runMeta || typeof runMeta !== 'object') return null;

  const actions = Array.isArray(runMeta.actions)
    ? runMeta.actions.map(normalizeAction)
    : [];

  const entryActions = actions.filter((action) => action.action === 'ENTRY');
  const waitActions = actions.filter((action) => action.action === 'WAIT');

  const actionCounts = runMeta.actionCounts || actions.reduce((acc, action) => {
    const key = action.action || action.type || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    ...runMeta,

    actionCounts,

    actions,
    actionsCount: actions.length || num(runMeta.actionsCount, 0),

    entriesCount: entryActions.length,
    waitsCount: waitActions.length,

    realExitsCount: Array.isArray(runMeta.realExits)
      ? runMeta.realExits.length
      : num(runMeta.realExitsCount, 0),

    shadowExitsCount: Array.isArray(runMeta.shadowExits)
      ? runMeta.shadowExits.length
      : num(runMeta.shadowExitsCount, 0),

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

  const microFamilyIds = uniqueStrings([
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.ids,
    rows.map((row) => row?.microFamilyId)
  ]);

  const macroFamilyIds = uniqueStrings([
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rows.map((row) => (
      row?.macroFamilyId ||
      row?.parentMicroFamilyId ||
      row?.parentFamilyId ||
      row?.microFamilyId
    ))
  ]);

  return {
    microFamilyIds,
    macroFamilyIds: macroFamilyIds.length
      ? macroFamilyIds
      : microFamilyIds
  };
}

function normalizeActiveRotation(activeRotation) {
  if (!activeRotation) {
    return {
      rotationId: null,
      activeMicroFamilyIds: [],
      activeMacroFamilyIds: [],
      activeMicroCount: 0,
      activeMacroCount: 0,
      raw: null
    };
  }

  const ids = idsFromRotation(activeRotation);

  return {
    rotationId: activeRotation.rotationId || null,

    activeMicroFamilyIds: ids.microFamilyIds,
    activeMacroFamilyIds: ids.macroFamilyIds,

    activeMicroCount: ids.microFamilyIds.length,
    activeMacroCount: ids.macroFamilyIds.length,

    sourceWeekKey: activeRotation.sourceWeekKey || null,
    activeWeekKey: activeRotation.activeWeekKey || null,
    mode: activeRotation.mode || null,
    source: activeRotation.source || null,

    raw: activeRotation
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
    activeMicroPositions: activeMicroPositions.length,
    activeMacroPositions: activeMacroPositions.length,
    outsideRotationPositions: outsideRotation.length,

    outsideRotationSymbols: outsideRotation.map((position) => position.symbol).filter(Boolean)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

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
      latestScan,
      activeRotationRaw
    ] = await Promise.all([
      getOpenPositions(),
      getJson(durable, KEYS.trade.runMeta, null),
      getJson(durable, KEYS.trade.lastProcessedSnapshot, null),
      getJson(volatile, KEYS.scan.latest, null),
      getActiveRotation().catch(() => null)
    ]);

    const positions = asArray(rawPositions).map(normalizePosition);
    const stats = buildPositionStats(positions);

    const runMeta = normalizeRunMeta(runMetaRaw);
    const lastProcessed = normalizeLastProcessed(lastProcessedRaw);

    const latestScannerSnapshotId = extractSnapshotId(latestScan);

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

      positions,
      openPositions: positions,
      positionsCount: positions.length,

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
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}