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
const OPPOSITE_TRADE_SIDE = 'LONG';

function now() {
  return Date.now();
}

function modeFlags() {
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

    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    noRealOrders: true,
    realOrdersDisabled: true,

    learningMode: 'MICRO_FAMILY_SHORT_ONLY_VIRTUAL',
    discordOnlyForManualSelection: true
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET'],
    ...modeFlags()
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);

  return [];
}

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
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
      .flatMap((value) => String(value || '').split(/[\s,;\n\r]+/g))
      .map((part) => part.trim())
      .filter(Boolean)
  )];
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...getArray(row.definitionParts),
    ...getArray(row.microDefinitionParts),
    ...getArray(row.macroDefinitionParts),
    ...getArray(row.parentDefinitionParts),
    ...getArray(row.executionFingerprintParts)
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');
}

function hasLongToken(text = '') {
  const value = cleanSideText(text);

  return (
    value.includes('MICRO_LONG_') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('POSITION_SIDE=LONG') ||
    value.includes('POSITIONSIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL') ||
    value.includes('SIDE=BUY') ||
    value.includes('DIRECTION=LONG') ||
    value.includes('DIRECTION=BULL') ||
    value.includes('DIRECTION=BUY') ||
    value.includes('LONG_') ||
    value.includes('_LONG') ||
    value.includes('BULL') ||
    value.includes('BUY') ||
    value.includes('UPSIDE')
  );
}

function hasShortToken(text = '') {
  const value = cleanSideText(text);

  return (
    value.includes('MICRO_SHORT_') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('POSITION_SIDE=SHORT') ||
    value.includes('POSITIONSIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR') ||
    value.includes('SIDE=SELL') ||
    value.includes('DIRECTION=SHORT') ||
    value.includes('DIRECTION=BEAR') ||
    value.includes('DIRECTION=SELL') ||
    value.includes('SHORT_') ||
    value.includes('_SHORT') ||
    value.includes('BEAR') ||
    value.includes('SELL') ||
    value.includes('DOWNSIDE')
  );
}

function normalizeDirectSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const converted = sideToTradeSide(raw);

  if (converted === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (converted === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    if (hasLongToken(row)) return OPPOSITE_TRADE_SIDE;
    if (hasShortToken(row)) return TARGET_TRADE_SIDE;

    return 'UNKNOWN';
  }

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.entrySide,
    row.side,
    row.bias,
    row.marketBias
  ];

  for (const source of directSources) {
    const side = normalizeDirectSide(source);

    if (side === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
    if (side === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;
  }

  const familyText = [
    row.familyId,
    row.family,
    row.baseFamilyId,
    row.parentMacroFamilyId,
    row.macroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.macroFamily,
    row.originalMicroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  if (hasLongToken(familyText) && !hasShortToken(familyText)) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (hasShortToken(familyText) && !hasLongToken(familyText)) {
    return TARGET_TRADE_SIDE;
  }

  if (hasLongToken(familyText) && hasShortToken(familyText)) {
    const microText = cleanSideText(
      row.microFamilyId ||
      row.trueMicroFamilyId ||
      row.liveMicroFamilyId ||
      row.realMicroFamilyId ||
      row.executionMicroFamilyId ||
      row.id ||
      row.key
    );

    if (hasShortToken(microText)) return TARGET_TRADE_SIDE;
    if (hasLongToken(microText)) return OPPOSITE_TRADE_SIDE;
  }

  const reasonText = [
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.actionReason,
    row.exitReason,
    row.rejectionReason
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  if (hasLongToken(reasonText) && !hasShortToken(reasonText)) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (hasShortToken(reasonText) && !hasLongToken(reasonText)) {
    return TARGET_TRADE_SIDE;
  }

  const definition = getDefinitionHaystack(row);

  if (hasLongToken(definition) && !hasShortToken(definition)) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (hasShortToken(definition) && !hasLongToken(definition)) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortRow(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isLongRow(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function isAllowedShortId(id = '') {
  return inferTradeSide(id) !== OPPOSITE_TRADE_SIDE;
}

function forceShortRow(row = {}) {
  return {
    ...row,
    ...modeFlags()
  };
}

function calcAgeSec(ts) {
  const value = num(ts, 0);

  if (value <= 0) return null;

  return Math.max(0, Math.floor((now() - value) / 1000));
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

  return (e - price) / riskDistance;
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

function safeBaseSymbol(value) {
  try {
    return normalizeBaseSymbol(value);
  } catch {
    return String(value || '').trim();
  }
}

function safeContractSymbol(value) {
  try {
    return normalizeContractSymbol(value);
  } catch {
    return String(value || '').trim();
  }
}

function normalizePosition(position = {}) {
  const rawSymbol =
    position.symbol ||
    position.baseSymbol ||
    position.contractSymbol ||
    position.instId ||
    position.instrumentId ||
    null;

  const symbol = safeBaseSymbol(rawSymbol);

  const contractSymbol = safeContractSymbol(
    position.contractSymbol ||
    position.symbol ||
    position.instId ||
    position.instrumentId ||
    symbol
  );

  const microFamilyId = getMicroFamilyId(position);
  const trueMicroFamilyId = position.trueMicroFamilyId || microFamilyId;
  const macroFamilyId = getMacroFamilyId(position) || position.parentMacroFamilyId || microFamilyId;
  const familyId = getFamilyId(position);

  const tradeSide = inferTradeSide({
    ...position,
    microFamilyId,
    trueMicroFamilyId,
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
    0
  );

  const riskDistance = calcRiskDistance(entry, initialSl);
  const rewardDistance = calcRewardDistance(entry, tp);

  const rr = num(
    position.rr,
    riskDistance > 0 ? rewardDistance / riskDistance : 0
  );

  const currentR = calcCurrentR({
    entry,
    initialSl,
    currentPrice,
    fallback: position.currentR
  });

  const openedAt = num(
    position.openedAt ??
    position.createdAt ??
    position.ts,
    0
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

    ...modeFlags(),

    inferredTradeSide: tradeSide,

    source: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,

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
    parentMacroFamilyId: position.parentMacroFamilyId || macroFamilyId || null,
    microFamilyId,
    trueMicroFamilyId,

    macroDefinition: position.macroDefinition || position.parentDefinition || null,
    macroDefinitionParts,

    definition: position.definition || position.microDefinition || null,
    definitionParts,
    microDefinitionParts: normalizeDefinitionParts(
      position.microDefinitionParts ||
      position.definitionParts ||
      position.microDefinition ||
      position.definition
    ),

    activeRotationId: position.activeRotationId || null,
    discordAlertEligible: Boolean(position.discordAlertEligible),
    discordEntryAlertSent: Boolean(position.discordEntryAlertSent),
    discordExitAlertSent: Boolean(position.discordExitAlertSent),

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

    liveManaged: false,
    beLiveApplied: false,
    trailLiveApplied: false,
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
  const shortRows = positions.filter(isShortRow);

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

  const discordEligiblePositions = shortRows.filter((position) => position.discordAlertEligible);

  return {
    ...modeFlags(),

    openPositions: shortRows.length,
    openVirtualPositions: shortRows.length,

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

    discordEligiblePositions: discordEligiblePositions.length,
    silentLearningPositions: shortRows.length - discordEligiblePositions.length,

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

  if (typeof value === 'string') return value;

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
      raw: null,
      ...modeFlags()
    };
  }

  if (typeof lastProcessed === 'string') {
    return {
      snapshotId: lastProcessed,
      raw: lastProcessed,
      ...modeFlags()
    };
  }

  return {
    ...lastProcessed,
    ...modeFlags(),
    snapshotId,
    raw: lastProcessed
  };
}

function normalizeAction(action = {}) {
  const microFamilyId = getMicroFamilyId(action);
  const trueMicroFamilyId = action.trueMicroFamilyId || microFamilyId;
  const macroFamilyId = getMacroFamilyId(action) || action.parentMacroFamilyId || microFamilyId;
  const familyId = getFamilyId(action);

  const tradeSide = inferTradeSide({
    ...action,
    microFamilyId,
    trueMicroFamilyId,
    macroFamilyId,
    familyId
  });

  const virtualOnly = action.virtualOnly !== false;
  const shadowOnly = action.shadowOnly !== false;

  return {
    ...action,

    ...modeFlags(),

    inferredTradeSide: tradeSide,

    source: action.source || 'VIRTUAL',
    virtualOnly,
    virtualTracked: true,
    shadowOnly,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,

    familyId,
    macroFamilyId,
    parentMacroFamilyId: action.parentMacroFamilyId || macroFamilyId || null,
    microFamilyId,
    trueMicroFamilyId,

    scannerScore: action.scannerScore ?? action.moveScore ?? null,

    confluence: round(action.confluence, 4),
    sniperScore: round(action.sniperScore, 4),

    rr: round(action.rr, 4),
    spreadPct: round(action.spreadPct, 6),
    depthMinUsd1p: round(action.depthMinUsd1p, 2),

    liveEligible: Boolean(action.liveEligible),
    riskValid: Boolean(action.riskValid),

    discordAlertEligible: Boolean(action.discordAlertEligible),
    discordEntryAlertSent: Boolean(action.discordEntryAlertSent),
    discordExitAlertSent: Boolean(action.discordExitAlertSent)
  };
}

function normalizeExit(row = {}) {
  const action = normalizeAction(row);

  return {
    ...action,

    source: 'VIRTUAL',
    virtualOnly: true,
    virtualTracked: true,
    shadowOnly: true,
    realTrade: false,
    realOrder: false,
    exchangeOrder: false,

    grossR: round(row.grossR, 4),
    costR: round(row.costR ?? row.totalCostR, 4),
    netR: round(row.netR ?? row.r, 4),
    r: round(row.netR ?? row.r, 4),

    exitReason: row.exitReason || row.reason || null,
    exitedAt: row.exitedAt || row.closedAt || row.ts || null
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

  const allShortActions = rawActions
    .filter(isShortRow)
    .map(forceShortRow);

  const ignoredLongActions = rawActions.filter(isLongRow).length;
  const ignoredUnknownSideActions = rawActions.filter((action) => (
    inferTradeSide(action) === 'UNKNOWN'
  )).length;

  const entryActions = allShortActions.filter((action) => action.action === 'ENTRY');
  const waitActions = allShortActions.filter((action) => action.action === 'WAIT');
  const observationActions = allShortActions.filter((action) => (
    action.action === 'OBSERVATION' ||
    action.observationWritten ||
    action.analysisInputOnly ||
    action.observationOnly
  ));
  const skippedActions = allShortActions.filter((action) => (
    action.action === 'SKIP' ||
    action.skipped ||
    action.reason
  ));

  const runVirtualExitsRaw = [
    ...asArray(runMeta.virtualExits),
    ...asArray(runMeta.realExits),
    ...asArray(runMeta.shadowExits),
    ...asArray(runMeta.exits),
    ...asArray(runMeta.closedPositions)
  ];

  const virtualExits = runVirtualExitsRaw
    .map(normalizeExit)
    .filter(isShortRow)
    .map(forceShortRow);

  const discordEntryAlerts = allShortActions.filter((action) => (
    action.discordAlertEligible &&
    (
      action.discordEntryAlertSent ||
      action.discordAlertSent ||
      action.action === 'ENTRY'
    )
  ));

  const discordExitAlerts = virtualExits.filter((exit) => (
    exit.discordAlertEligible &&
    (
      exit.discordExitAlertSent ||
      exit.discordAlertSent
    )
  ));

  return {
    ...runMeta,

    ...modeFlags(),

    actions: allShortActions,
    actionsCount: allShortActions.length,

    virtualActions: allShortActions,
    virtualActionsCount: allShortActions.length,

    rawActionsCount: rawActions.length,

    ignoredLongActions,
    ignoredUnknownSideActions,

    actionCounts: actionCounts(allShortActions),
    rawActionCounts: runMeta.actionCounts || actionCounts(rawActions),

    entries: entryActions,
    entriesCount: entryActions.length,

    waits: waitActions,
    waitsCount: waitActions.length,

    observations: observationActions,
    observationsCount: observationActions.length,

    skippedActions,
    skippedActionsCount: skippedActions.length,

    virtualExits,
    virtualExitsCount: virtualExits.length,

    exits: virtualExits,
    exitsCount: virtualExits.length,

    realExits: [],
    realExitsCount: 0,
    shadowExits: virtualExits,
    shadowExitsCount: virtualExits.length,

    rawExitRowsCount: runVirtualExitsRaw.length,
    ignoredLongExitRows: runVirtualExitsRaw
      .map(normalizeAction)
      .filter(isLongRow)
      .length,

    discordEntryAlerts: discordEntryAlerts.length,
    discordExitAlerts: discordExitAlerts.length,

    macroFamiliesSeen: uniqueStrings(
      allShortActions.map((action) => action.macroFamilyId)
    ).length,

    microFamiliesSeen: uniqueStrings(
      allShortActions.map((action) => action.microFamilyId)
    ).length,

    startedAt: runMeta.startedAt || null,
    completedAt: runMeta.completedAt || null,
    durationMs: runMeta.durationMs ?? null,

    snapshotId: runMeta.snapshotId || null,
    snapshotAgeSec: runMeta.snapshotAgeSec ?? null
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
  ]).filter(isAllowedShortId);

  const explicitMacroFamilyIds = uniqueStrings([
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rotation.macroIds
  ]).filter(isAllowedShortId);

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
      ...modeFlags(),

      rotationId: null,
      activeMicroFamilyIds: [],
      activeMacroFamilyIds: [],
      activeMicroCount: 0,
      activeMacroCount: 0,
      microFamilies: [],

      manualSelectionActive: false,
      discordAlertsEnabled: false,

      bestLong: null,
      bestShort: null,
      raw: null
    };
  }

  const ids = idsFromRotation(activeRotation);
  const shortRows = ids.shortRows;

  const manualSelectionActive = ids.microFamilyIds.length > 0;

  return {
    ...modeFlags(),

    rotationId: activeRotation.rotationId || null,

    activeMicroFamilyIds: ids.microFamilyIds,
    activeMacroFamilyIds: ids.macroFamilyIds,

    microFamilyIds: ids.microFamilyIds,
    trueMicroFamilyIds: ids.microFamilyIds,
    macroFamilyIds: ids.macroFamilyIds,

    activeMicroCount: ids.microFamilyIds.length,
    activeMacroCount: ids.macroFamilyIds.length,

    sourceWeekKey: activeRotation.sourceWeekKey || null,
    activeWeekKey: activeRotation.activeWeekKey || null,
    mode: activeRotation.mode || null,
    source: activeRotation.source || null,

    manualSelectionActive,
    discordAlertsEnabled: manualSelectionActive,

    trueMicroOnly: activeRotation.trueMicroOnly !== false,
    usedLegacyFallback: Boolean(activeRotation.usedLegacyFallback),
    usedSoftFallback: Boolean(activeRotation.usedSoftFallback),
    usedObservationFallback: Boolean(activeRotation.usedObservationFallback),
    usedRawFallback: Boolean(activeRotation.usedRawFallback),
    usedPreviousWeekMerge: Boolean(activeRotation.usedPreviousWeekMerge),

    microFamilies: shortRows,
    bestLong: null,
    bestShort: shortRows[0] || null,

    rawRowsCount: ids.rawRows.length,
    ignoredLongRows: ids.rawRows.filter(isLongRow).length,
    ignoredUnknownSideRows: ids.rawRows.filter((row) => inferTradeSide(row) === 'UNKNOWN').length,

    raw: {
      ...activeRotation,

      ...modeFlags(),

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

  const selectedMicroPositions = positions.filter((position) => (
    position.microFamilyId &&
    activeMicroSet.has(position.microFamilyId)
  ));

  const selectedMacroPositions = positions.filter((position) => (
    position.macroFamilyId &&
    activeMacroSet.has(position.macroFamilyId)
  ));

  const silentLearningPositions = positions.filter((position) => (
    !activeMicroSet.has(position.microFamilyId) &&
    !activeMacroSet.has(position.macroFamilyId)
  ));

  return {
    ...modeFlags(),

    manualSelectionActive: activeMicroSet.size > 0,
    discordAlertsEnabled: activeMicroSet.size > 0,

    selectedMicroPositions: selectedMicroPositions.length,
    selectedMacroPositions: selectedMacroPositions.length,

    discordEligiblePositions: selectedMicroPositions.length,
    silentLearningPositions: silentLearningPositions.length,

    silentLearningSymbols: silentLearningPositions
      .map((position) => position.symbol)
      .filter(Boolean),

    activeMicroFamilyIds: [...activeMicroSet],
    activeMacroFamilyIds: [...activeMacroSet]
  };
}

function normalizeLatestScan(latestScan) {
  if (!latestScan || typeof latestScan !== 'object') return latestScan;

  const candidates = Array.isArray(latestScan.candidates)
    ? latestScan.candidates
    : [];

  const shortCandidates = candidates
    .filter(isShortRow)
    .map(forceShortRow);

  return {
    ...latestScan,

    ...modeFlags(),

    candidates: shortCandidates,
    candidatesCount: shortCandidates.length,
    shortCandidatesCount: shortCandidates.length,
    longCandidatesCount: candidates.filter(isLongRow).length,
    rawCandidatesCount: candidates.length
  };
}

function buildSummary({
  positions = [],
  runMeta = null,
  activeRotation = null,
  latestScannerSnapshotId = null,
  lastProcessedSnapshotId = null
} = {}) {
  return {
    ...modeFlags(),

    openVirtualPositions: positions.length,

    virtualEntriesLastRun: num(runMeta?.entriesCount, 0),
    virtualExitsLastRun: num(runMeta?.virtualExitsCount, 0),
    observationsLastRun: num(runMeta?.observationsCount, 0),
    skippedActionsLastRun: num(runMeta?.skippedActionsCount, 0),

    activeMicroFamilies: num(activeRotation?.activeMicroCount, 0),
    activeMacroFamilies: num(activeRotation?.activeMacroCount, 0),
    manualSelectionActive: Boolean(activeRotation?.manualSelectionActive),
    discordAlertsEnabled: Boolean(activeRotation?.discordAlertsEnabled),

    latestScannerSnapshotId,
    lastProcessedSnapshotId,
    scannerAndTradeInSync: Boolean(
      latestScannerSnapshotId &&
      lastProcessedSnapshotId &&
      latestScannerSnapshotId === lastProcessedSnapshotId
    )
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Trade-Mode', 'short-only-virtual-learning');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Virtual-Only', 'true');
  res.setHeader('X-No-Real-Orders', 'true');

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

    const summary = buildSummary({
      positions,
      runMeta,
      activeRotation,
      latestScannerSnapshotId,
      lastProcessedSnapshotId: lastProcessed.snapshotId
    });

    return res.status(200).json({
      ok: true,

      ...modeFlags(),

      positions,
      openPositions: positions,
      virtualPositions: positions,
      openVirtualPositions: positions.length,

      positionsCount: positions.length,
      rawPositionsCount: allPositions.length,
      ignoredLongPositions,
      ignoredUnknownSidePositions,

      stats,
      rotationMatchStats,
      summary,

      runMeta,
      lastRunMeta: runMeta,

      lastProcessed,
      lastProcessedSnapshotId: lastProcessed.snapshotId,

      latestScan,
      latestScannerSnapshotId,
      scannerAndTradeInSync,

      activeRotationId: activeRotation.rotationId,
      activeMicroFamilyIds: activeRotation.activeMicroFamilyIds,
      activeMacroFamilyIds: activeRotation.activeMacroFamilyIds,
      activeMicroCount: activeRotation.activeMicroCount,
      activeMacroCount: activeRotation.activeMacroCount,
      activeRotation,

      warnings: uniqueStrings([
        activeRotation.activeMicroCount <= 0
          ? 'NO_MANUAL_MICRO_FAMILY_SELECTION_ACTIVE_DISCORD_DISABLED'
          : null,
        ignoredLongPositions > 0
          ? `LONG_POSITIONS_IGNORED:${ignoredLongPositions}`
          : null,
        ignoredUnknownSidePositions > 0
          ? `UNKNOWN_SIDE_POSITIONS_IGNORED:${ignoredUnknownSidePositions}`
          : null,
        runMeta?.ignoredLongActions > 0
          ? `LONG_ACTIONS_IGNORED:${runMeta.ignoredLongActions}`
          : null,
        runMeta?.ignoredLongExitRows > 0
          ? `LONG_EXIT_ROWS_IGNORED:${runMeta.ignoredLongExitRows}`
          : null
      ].filter(Boolean)),

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      ...modeFlags(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}