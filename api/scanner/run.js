// ================= FILE: api/scanner/run.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import { getVolatileRedis } from '../../src/redis.js';
import { withRedisLock } from '../../src/lock.js';
import { runScanner } from '../../src/market/scanner.js';

const TARGET_TRADE_SIDE = 'SHORT';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST']
  });
}

function isAllowedMethod(method) {
  return method === 'GET' || method === 'POST';
}

function getLockTtlSec() {
  const ttl = Number(CONFIG.scanner?.lockTtlSec || 240);

  return Number.isFinite(ttl) && ttl > 0 ? ttl : 240;
}

function sourceLabel(req) {
  if (req.query?.force === 'true') return 'ADMIN_MANUAL_RUN';

  return 'CRON_OR_API_RUN';
}

function normalizeTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) return 'SHORT';

  return 'UNKNOWN';
}

function rowSide(row = {}) {
  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.analysisSide
  );

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  if (
    haystack.includes('SHORT') ||
    haystack.includes('BEAR') ||
    haystack.includes('SELL') ||
    haystack.includes('MICRO_SHORT_') ||
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR')
  ) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortCandidate(row = {}) {
  return rowSide(row) === TARGET_TRADE_SIDE;
}

function enforceShortOnlyResult(result = {}) {
  if (!result || typeof result !== 'object') return result;

  const candidates = Array.isArray(result.candidates)
    ? result.candidates.filter(isShortCandidate)
    : [];

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => candidate.tradeDiscoveryOnly);

  return {
    ...result,

    shortOnly: true,
    targetTradeSide: TARGET_TRADE_SIDE,
    longDisabled: true,

    candidates,
    candidatesCount: candidates.length,
    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    topSymbols: candidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const startedAt = Date.now();

  try {
    if (!isAllowedMethod(req.method)) {
      return methodNotAllowed(res);
    }

    const redis = getVolatileRedis();
    const lockKey = KEYS.scan?.lock || 'SCAN:LOCK';
    const lockTtlSec = getLockTtlSec();

    const rawResult = await withRedisLock(
      redis,
      lockKey,
      lockTtlSec,
      async () => runScanner()
    );

    const result = enforceShortOnlyResult(rawResult);

    return res.status(200).json({
      ok: result?.ok !== false,
      source: sourceLabel(req),
      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,
      durationMs: Date.now() - startedAt,
      result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      targetTradeSide: TARGET_TRADE_SIDE,
      shortOnly: true,
      longDisabled: true,
      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}