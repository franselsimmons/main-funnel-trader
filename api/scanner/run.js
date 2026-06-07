// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getVolatileRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const DEFAULT_LOCK_TTL_SEC = 540;

function now() {
  return Date.now();
}

function baseFlags() {
  return {
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

    scannerOnly: true,
    scannerDecidesTrade: false,
    noTradeExecution: true,
    noMicroFamilySelection: true,
    noDiscord: true
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],
    ...baseFlags()
  });
}

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
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

function isTrue(value) {
  if (value === true || value === 1) return true;

  const raw = String(value ?? '').trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on', 'force', 'forced'].includes(raw);
}

function getLockTtlSec() {
  const ttl = Number(CONFIG.scanner?.lockTtlSec || DEFAULT_LOCK_TTL_SEC);

  if (!Number.isFinite(ttl)) return DEFAULT_LOCK_TTL_SEC;
  if (ttl <= 0) return DEFAULT_LOCK_TTL_SEC;

  return Math.floor(ttl);
}

function shouldForce(req, body = {}) {
  return (
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(body.force) ||
    isTrue(body.forced)
  );
}

function sourceLabel(req, body = {}) {
  const manual = (
    isTrue(firstValue(req.query?.manual, false)) ||
    isTrue(firstValue(req.query?.force, false)) ||
    isTrue(firstValue(req.query?.forced, false)) ||
    isTrue(body.manual) ||
    isTrue(body.force) ||
    isTrue(body.forced)
  );

  return manual
    ? 'ADMIN_MANUAL_SCANNER_RUN'
    : 'CRON_OR_API_SCANNER_RUN';
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

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(raw)) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
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
    text.startsWith('SELL_') ||
    text.includes('_SELL_') ||
    text.endsWith('_SELL') ||
    text.includes('|SHORT|') ||
    text.includes('|BEAR|') ||
    text.includes('|SELL|') ||
    text.includes('=SHORT') ||
    text.includes('=BEAR') ||
    text.includes('=SELL')
  );
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
    text.startsWith('BUY_') ||
    text.includes('_BUY_') ||
    text.endsWith('_BUY') ||
    text.includes('|LONG|') ||
    text.includes('|BULL|') ||
    text.includes('|BUY|') ||
    text.includes('=LONG') ||
    text.includes('=BULL') ||
    text.includes('=BUY')
  );
}

function inferTradeSideFromText(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const shortHit = hasShortSignal(text);
  const longHit = hasLongSignal(text);

  if (shortHit && !longHit) return TARGET_TRADE_SIDE;
  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;

  if (shortHit && longHit) {
    if (text.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (text.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=SHORT') || text.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (text.includes('TRADE_SIDE=LONG') || text.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function rowSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);

  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.signalSide ||
    row.entrySide ||
    row.side
  );

  if (direct !== 'UNKNOWN') return direct;

  const reasonSide = inferTradeSideFromText(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason ||
    ''
  );

  if (reasonSide !== 'UNKNOWN') return reasonSide;

  const haystack = [
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

  if (row.shortOnly === true || row.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortCandidate(row = {}) {
  return rowSide(row) === TARGET_TRADE_SIDE;
}

function isLongCandidate(row = {}) {
  return rowSide(row) === OPPOSITE_TRADE_SIDE;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return n;
}

function normalizeSymbol(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/_?USDT$/i, '');
}

function normalizeContractSymbol(value = '') {
  const raw = String(value || '').trim().toUpperCase();

  if (!raw) return '';

  if (raw.endsWith('USDT')) return raw;

  return `${normalizeSymbol(raw)}USDT`;
}

function normalizeShortCandidate(candidate = {}) {
  const symbol = normalizeSymbol(
    candidate.symbol ||
    candidate.baseSymbol ||
    candidate.contractSymbol
  );

  const contractSymbol = normalizeContractSymbol(
    candidate.contractSymbol ||
    candidate.symbol ||
    symbol
  );

  const createdAt = safeNumber(
    candidate.createdAt ||
    candidate.ts ||
    candidate.scannerTs ||
    Date.now(),
    Date.now()
  );

  return {
    ...candidate,

    symbol,
    baseSymbol: symbol,
    contractSymbol,

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

    scannerScore: safeNumber(candidate.scannerScore ?? candidate.moveScore, 0),
    change1h: safeNumber(candidate.change1h, 0),
    change24h: safeNumber(candidate.change24h, 0),
    volume24h: safeNumber(candidate.volume24h ?? candidate.quoteVolume24h, 0),

    btcState: candidate.btcState || null,
    regime: candidate.regime || null,

    fakeBreakout: Boolean(candidate.fakeBreakout),
    fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),

    scannerReason: candidate.scannerReason || candidate.reason || 'SHORT_SCANNER_CANDIDATE',

    createdAt,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false
  };
}

function scannerGatePassed(row = {}) {
  if (row.scannerGatePassed === undefined || row.scannerGatePassed === null) {
    return false;
  }

  return Boolean(row.scannerGatePassed);
}

function isAnalyzeOnly(row = {}) {
  return Boolean(
    row.tradeDiscoveryOnly ||
    row.discoveryOnly ||
    row.analyzeOnly ||
    !scannerGatePassed(row)
  );
}

function unwrapPayload(result) {
  if (!result) return null;

  if (result.result?.result?.result?.candidates) return result.result.result.result;
  if (result.result?.result?.candidates) return result.result.result;
  if (result.result?.candidates) return result.result;
  if (result.candidates) return result;

  if (result.result?.result?.result) return result.result.result.result;
  if (result.result?.result) return result.result.result;
  if (result.result) return result.result;

  return result;
}

function normalizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      reason: 'EMPTY_SCANNER_PAYLOAD',
      ...baseFlags(),
      candidates: [],
      candidatesCount: 0,
      shortCandidatesCount: 0,
      longCandidatesCount: 0
    };
  }

  const rawCandidates = Array.isArray(payload.candidates)
    ? payload.candidates
    : [];

  const candidates = rawCandidates
    .filter(isShortCandidate)
    .map(normalizeShortCandidate)
    .filter((candidate) => candidate.symbol && candidate.contractSymbol);

  const scannerGateCandidates = candidates.filter(scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter(isAnalyzeOnly);

  const rawLongCandidatesIgnored = rawCandidates.filter(isLongCandidate).length;
  const rawUnknownSideCandidatesIgnored = rawCandidates.filter((row) => rowSide(row) === 'UNKNOWN').length;

  const analyze = payload.analyze && typeof payload.analyze === 'object'
    ? {
      ...payload.analyze,
      ...baseFlags()
    }
    : payload.analyze || null;

  return {
    ...payload,
    ...baseFlags(),

    sideMode: 'SHORT_ONLY',

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
      .filter(Boolean),

    analyze
  };
}

function normalizeLockResult(rawResult = {}) {
  if (!rawResult || typeof rawResult !== 'object') {
    return {
      ok: false,
      reason: 'EMPTY_LOCK_RESULT',
      ...baseFlags()
    };
  }

  const payload = normalizePayload(unwrapPayload(rawResult));

  if (rawResult.result?.result?.result?.candidates) {
    return {
      ...rawResult,
      ...baseFlags(),
      result: {
        ...rawResult.result,
        result: {
          ...rawResult.result.result,
          result: payload
        }
      }
    };
  }

  if (rawResult.result?.result?.candidates) {
    return {
      ...rawResult,
      ...baseFlags(),
      result: {
        ...rawResult.result,
        result: payload
      }
    };
  }

  if (rawResult.result?.candidates) {
    return {
      ...rawResult,
      ...baseFlags(),
      result: payload
    };
  }

  if (rawResult.candidates) {
    return payload;
  }

  return {
    ...rawResult,
    ...baseFlags(),
    result: payload
  };
}

function resolveStatus(error) {
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

function buildScannerOptions(req, body = {}) {
  const force = shouldForce(req, body);

  return {
    force,
    forced: force,

    targetTradeSide: TARGET_TRADE_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    disableLong: true,

    longOnly: false,
    shortDisabled: false,

    scannerOnly: true,
    noTradeExecution: true,
    noDiscord: true,
    noMicroFamilySelection: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Scanner-Target-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Dashboard-Side', TARGET_DASHBOARD_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Scanner-Only', 'true');

  const startedAt = now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);
    const scannerOptions = buildScannerOptions(req, body);

    const redis = getVolatileRedis();
    const lockKey = KEYS.scan?.lock || 'SCAN:LOCK';
    const lockTtlSec = getLockTtlSec();

    const rawResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runScanner(scannerOptions)
    );

    const result = normalizeLockResult(rawResult);
    const payload = normalizePayload(unwrapPayload(result));

    const ok = result?.ok !== false && payload?.ok !== false;

    return res.status(200).json({
      ok,
      skipped: Boolean(result?.skipped || payload?.skipped || false),
      reason: result?.reason || payload?.reason || null,

      source: sourceLabel(req, body),

      ...baseFlags(),

      force: scannerOptions.force,

      persisted: payload?.persisted ?? result?.persisted ?? null,
      snapshotId: payload?.snapshotId || result?.snapshotId || null,

      candidatesCount: Number(payload?.candidatesCount || 0),
      shortCandidatesCount: Number(payload?.shortCandidatesCount || payload?.candidatesCount || 0),
      longCandidatesCount: 0,

      scannerGateCandidatesCount: Number(payload?.scannerGateCandidatesCount || 0),
      analyzeOnlyCandidatesCount: Number(payload?.analyzeOnlyCandidatesCount || 0),

      rawCandidatesCount: Number(payload?.rawCandidatesCount || payload?.rawCount || 0),
      rawLongCandidatesIgnored: Number(payload?.rawLongCandidatesIgnored || 0),
      rawUnknownSideCandidatesIgnored: Number(payload?.rawUnknownSideCandidatesIgnored || 0),

      topSymbols: payload?.topSymbols || [],
      scannerGateSymbols: payload?.scannerGateSymbols || [],
      analyzeOnlySymbols: payload?.analyzeOnlySymbols || [],

      analyze: payload?.analyze || null,

      durationMs: now() - startedAt,

      result
    });
  } catch (error) {
    return res.status(resolveStatus(error)).json({
      ok: false,

      ...baseFlags(),

      error: error?.message || String(error),
      durationMs: now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}