// ================= FILE: scripts/runScanner.js =================

import { runScanner } from '../src/market/scanner.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

function now() {
  return Date.now();
}

function argv() {
  return process.argv.slice(2);
}

function getArgValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));

  if (!match) return null;

  return match.slice(prefix.length).trim() || null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force'].includes(raw);
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
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferTradeSideFromText(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const shortHit = (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('POSITION_SIDE=SHORT') ||
    text.includes('POSITIONSIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.startsWith('SHORT_') ||
    text.includes('_SHORT_') ||
    text.endsWith('_SHORT') ||
    text.startsWith('BEAR_') ||
    text.includes('_BEAR_') ||
    text.endsWith('_BEAR') ||
    text.startsWith('SELL_') ||
    text.includes('_SELL_') ||
    text.endsWith('_SELL')
  );

  const longHit = (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('POSITION_SIDE=LONG') ||
    text.includes('POSITIONSIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.startsWith('LONG_') ||
    text.includes('_LONG_') ||
    text.endsWith('_LONG') ||
    text.startsWith('BULL_') ||
    text.includes('_BULL_') ||
    text.endsWith('_BULL') ||
    text.startsWith('BUY_') ||
    text.includes('_BUY_') ||
    text.endsWith('_BUY')
  );

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function getDefinitionHaystack(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
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

    row.scannerReason,
    row.reason,
    row.signalReason,
    row.actionReason,

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

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    return inferTradeSideFromText(row);
  }

  if (!row || typeof row !== 'object') {
    return 'UNKNOWN';
  }

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.signalSide ||
    row.entrySide ||
    row.side ||
    row.bias ||
    row.marketBias
  );

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const haystackSide = inferTradeSideFromText(getDefinitionHaystack(row));

  if (haystackSide === TARGET_TRADE_SIDE || haystackSide === OPPOSITE_TRADE_SIDE) {
    return haystackSide;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortCandidate(row = {}) {
  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isLongCandidate(row = {}) {
  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function normalizeShortCandidate(candidate = {}) {
  return {
    ...candidate,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    directionalSide: TARGET_DASHBOARD_SIDE,
    inferredDirectionalSide: TARGET_DASHBOARD_SIDE,
    marketSide: TARGET_DASHBOARD_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false
  };
}

function scannerGatePassed(candidate = {}) {
  return Boolean(candidate.scannerGatePassed);
}

function isAnalyzeOnly(candidate = {}) {
  return Boolean(
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly ||
    !scannerGatePassed(candidate)
  );
}

function enforceShortOnlyPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const rawCandidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];

  const candidates = rawCandidates
    .filter(isShortCandidate)
    .map(normalizeShortCandidate);

  const scannerGateCandidates = candidates.filter(scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);

  const rawLongCandidatesIgnored = rawCandidates.filter(isLongCandidate).length;
  const rawUnknownSideCandidatesIgnored = rawCandidates.filter((candidate) => (
    inferTradeSide(candidate) === 'UNKNOWN'
  )).length;

  return {
    ...payload,

    sideMode: 'SHORT_ONLY',

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    candidates,
    candidatesCount: candidates.length,

    shortCandidatesCount: candidates.length,
    longCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    rawCandidatesCount: rawCandidates.length,
    rawLongCandidatesIgnored,
    rawUnknownSideCandidatesIgnored,

    bullCandidates: 0,
    bearCandidates: candidates.length,

    topSymbols: candidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    analyzeOnlySymbols: analyzeOnlyCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean)
  };
}

function normalizeResult(rawResult = {}) {
  if (!rawResult || typeof rawResult !== 'object') {
    return rawResult;
  }

  if (Array.isArray(rawResult.candidates)) {
    return enforceShortOnlyPayload(rawResult);
  }

  if (rawResult.result && typeof rawResult.result === 'object') {
    return {
      ...rawResult,

      targetTradeSide: TARGET_TRADE_SIDE,
      targetScannerSide: TARGET_DASHBOARD_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      positionSide: TARGET_TRADE_SIDE,
      direction: TARGET_TRADE_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      result: normalizeResult(rawResult.result)
    };
  }

  return {
    ...rawResult,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  };
}

function unwrapPayload(result) {
  if (!result) return null;

  if (Array.isArray(result.candidates)) return result;
  if (Array.isArray(result.result?.candidates)) return result.result;
  if (Array.isArray(result.result?.result?.candidates)) return result.result.result;
  if (Array.isArray(result.result?.result?.result?.candidates)) return result.result.result.result;

  if (result.result?.result?.result) return result.result.result.result;
  if (result.result?.result) return result.result.result;
  if (result.result) return result.result;

  return result;
}

function shouldForce() {
  return (
    hasFlag('force') ||
    hasFlag('forced') ||
    isTrue(getArgValue('force')) ||
    isTrue(getArgValue('forced'))
  );
}

function isManualRun() {
  return (
    hasFlag('manual') ||
    hasFlag('force') ||
    hasFlag('forced') ||
    isTrue(getArgValue('manual')) ||
    isTrue(getArgValue('force')) ||
    isTrue(getArgValue('forced'))
  );
}

function buildScannerOptions() {
  const force = shouldForce();

  return {
    force,
    forced: force,

    source: isManualRun()
      ? 'CLI_MANUAL_RUN'
      : 'CLI_RUN',

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_TRADE_SIDE,
    scannerSide: TARGET_TRADE_SIDE,

    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true,

    longOnly: false,
    shortDisabled: false
  };
}

function buildSuccessPayload({
  result,
  startedAt,
  scannerOptions
}) {
  const normalizedResult = normalizeResult(result);
  const payload = unwrapPayload(normalizedResult) || {};
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];

  return {
    ok: normalizedResult?.ok !== false && payload?.ok !== false,

    source: 'CLI_RUN_SCANNER_SHORT_ONLY',
    runSource: scannerOptions.source,

    argv: argv(),
    options: scannerOptions,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    force: scannerOptions.force,

    persisted: payload.persisted ?? normalizedResult?.persisted ?? null,
    snapshotId: payload.snapshotId || normalizedResult?.snapshotId || null,

    candidatesCount: Number(payload.candidatesCount || candidates.length || 0),
    shortCandidatesCount: Number(payload.shortCandidatesCount || candidates.length || 0),
    longCandidatesCount: 0,

    scannerGateCandidatesCount: Number(payload.scannerGateCandidatesCount || 0),
    analyzeOnlyCandidatesCount: Number(payload.analyzeOnlyCandidatesCount || 0),

    rawCandidatesCount: Number(payload.rawCandidatesCount || 0),
    rawLongCandidatesIgnored: Number(payload.rawLongCandidatesIgnored || 0),
    rawUnknownSideCandidatesIgnored: Number(payload.rawUnknownSideCandidatesIgnored || 0),

    topSymbols: Array.isArray(payload.topSymbols)
      ? payload.topSymbols
      : candidates.slice(0, 20).map((candidate) => candidate.symbol).filter(Boolean),

    scannerGateSymbols: Array.isArray(payload.scannerGateSymbols)
      ? payload.scannerGateSymbols
      : candidates
        .filter(scannerGatePassed)
        .slice(0, 20)
        .map((candidate) => candidate.symbol)
        .filter(Boolean),

    durationMs: now() - startedAt,

    result: normalizedResult
  };
}

function buildErrorPayload({
  error,
  startedAt,
  scannerOptions
}) {
  return {
    ok: false,

    source: 'CLI_RUN_SCANNER_SHORT_ONLY',
    runSource: scannerOptions?.source || 'CLI_RUN',

    argv: argv(),
    options: scannerOptions || null,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_DASHBOARD_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    error: error?.message || String(error),
    stack: error?.stack,

    durationMs: now() - startedAt
  };
}

function exitCodeFromResult(result) {
  return result?.ok === false ? 1 : 0;
}

async function main() {
  const startedAt = now();
  const scannerOptions = buildScannerOptions();

  try {
    const result = await runScanner(scannerOptions);

    const response = buildSuccessPayload({
      result,
      startedAt,
      scannerOptions
    });

    console.log(JSON.stringify(response, null, 2));

    process.exitCode = exitCodeFromResult(response);
  } catch (error) {
    console.error(JSON.stringify(
      buildErrorPayload({
        error,
        startedAt,
        scannerOptions
      }),
      null,
      2
    ));

    process.exitCode = 1;
  }
}

await main();