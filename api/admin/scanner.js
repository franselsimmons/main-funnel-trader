// ================= FILE: api/admin/scanner.js =================

import { KEYS } from '../../src/keys.js';
import {
  getVolatileRedis,
  getJson,
  getKeys
} from '../../src/redis.js';
import { sideToTradeSide, safeNumber } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SNAPSHOT_SEARCH_LIMIT = 80;
const STALE_8M_SEC = 8 * 60;
const STALE_30M_SEC = 30 * 60;

function now() {
  return Date.now();
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

    scannerOnly: true,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    virtualLearning: true,
    noRealOrders: true
  };
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

function num(value, fallback = 0) {
  const n = safeNumber(value, fallback);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function snapshotPattern() {
  try {
    return KEYS.scan.snapshot('*');
  } catch {
    return 'SCAN:SNAPSHOT:*';
  }
}

function snapshotKey(snapshotId) {
  try {
    return KEYS.scan.snapshot(snapshotId);
  } catch {
    return `SCAN:SNAPSHOT:${snapshotId}`;
  }
}

function extractSnapshotId(latest) {
  if (!latest) return null;
  if (typeof latest === 'string') return latest;

  if (typeof latest === 'object') {
    return (
      latest.snapshotId ||
      latest.id ||
      latest.latestSnapshotId ||
      latest.scanId ||
      null
    );
  }

  return null;
}

function hasFullSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray(value.candidates)
  );
}

function snapshotCreatedAt(snapshot = {}) {
  return num(
    snapshot.createdAt ||
    snapshot.completedAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    0
  );
}

function snapshotAgeSec(snapshot = {}) {
  const createdAt = snapshotCreatedAt(snapshot);

  if (createdAt <= 0) return null;

  return Math.max(0, Math.floor((now() - createdAt) / 1000));
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

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

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
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,
    row.microFamilyId,
    row.trueMicroFamilyId,
    row.id,
    row.key
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');

  if (hasLongToken(familyText)) return OPPOSITE_TRADE_SIDE;
  if (hasShortToken(familyText)) return TARGET_TRADE_SIDE;

  const reasonText = [
    row.scannerReason,
    row.reason,
    row.signalReason,
    row.actionReason,
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

function isShortCandidate(candidate = {}) {
  return inferTradeSide(candidate) === TARGET_TRADE_SIDE;
}

function isLongCandidate(candidate = {}) {
  return inferTradeSide(candidate) === OPPOSITE_TRADE_SIDE;
}

function normalizeContractSymbol(candidate = {}) {
  return (
    candidate.contractSymbol ||
    candidate.symbol ||
    candidate.instId ||
    candidate.instrumentId ||
    null
  );
}

function normalizeSymbol(candidate = {}) {
  const symbol = (
    candidate.symbol ||
    candidate.baseSymbol ||
    candidate.contractSymbol ||
    candidate.instId ||
    candidate.instrumentId ||
    ''
  );

  return String(symbol || '').trim();
}

function normalizeShortCandidate(candidate = {}) {
  const symbol = normalizeSymbol(candidate);
  const contractSymbol = normalizeContractSymbol(candidate);
  const createdAt = num(candidate.createdAt || candidate.ts || now(), now());

  return {
    ...candidate,

    symbol,
    contractSymbol,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    scannerOnly: true,
    scannerDoesNotTrade: true,
    scannerDoesNotSelectMicroFamilies: true,
    scannerDoesNotSendDiscord: true,

    scannerScore: num(candidate.scannerScore ?? candidate.moveScore, 0),
    change1h: num(candidate.change1h ?? candidate.priceChange1hPct, 0),
    change24h: num(candidate.change24h ?? candidate.priceChange24hPct, 0),
    volume24h: num(candidate.volume24h ?? candidate.quoteVolume24h ?? candidate.quoteVolume, 0),

    btcState: candidate.btcState || null,
    regime: candidate.regime || null,
    fakeBreakout: Boolean(candidate.fakeBreakout),
    fakeBreakoutRisk: Boolean(candidate.fakeBreakoutRisk),

    scannerReason: candidate.scannerReason || candidate.reason || null,

    createdAt
  };
}

function splitCandidatesBySide(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];

  const shortCandidates = [];
  const longCandidates = [];
  const unknownSideCandidates = [];

  for (const candidate of rows) {
    const tradeSide = inferTradeSide(candidate);

    if (tradeSide === TARGET_TRADE_SIDE) {
      shortCandidates.push(candidate);
      continue;
    }

    if (tradeSide === OPPOSITE_TRADE_SIDE) {
      longCandidates.push(candidate);
      continue;
    }

    unknownSideCandidates.push(candidate);
  }

  return {
    shortCandidates,
    longCandidates,
    unknownSideCandidates
  };
}

function averageScannerScore(candidates = []) {
  if (!candidates.length) return 0;

  const total = candidates.reduce((sum, candidate) => {
    return sum + num(candidate?.scannerScore ?? candidate?.moveScore, 0);
  }, 0);

  return round(total / candidates.length, 2);
}

function topSymbols(candidates = [], limit = 20) {
  return candidates
    .slice(0, limit)
    .map((candidate) => candidate.symbol || candidate.contractSymbol)
    .filter(Boolean);
}

function buildCandidateStats(rawCandidates = [], candidates = []) {
  const {
    shortCandidates,
    longCandidates,
    unknownSideCandidates
  } = splitCandidatesBySide(rawCandidates);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const cleanCandidates = candidates.filter((candidate) => !candidate.fakeBreakout);
  const fakeBreakouts = candidates.filter((candidate) => candidate.fakeBreakout);
  const fakeRiskCandidates = candidates.filter((candidate) => candidate.fakeBreakoutRisk);

  return {
    candidates: candidates.length,
    cleanCandidates: cleanCandidates.length,
    fakeBreakouts: fakeBreakouts.length,
    fakeRiskCandidates: fakeRiskCandidates.length,

    scannerGateCandidates: scannerGateCandidates.length,
    analyzeOnlyCandidates: analyzeOnlyCandidates.length,

    shortCandidates: candidates.length,
    longCandidates: 0,
    unknownSideCandidates: 0,

    bearCandidates: candidates.length,
    bullCandidates: 0,

    rawCandidates: rawCandidates.length,
    rawShortCandidates: shortCandidates.length,
    rawLongCandidatesIgnored: longCandidates.length,
    rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

    avgScannerScore: averageScannerScore(candidates)
  };
}

function normalizeLatest(latest, snapshot = null, meta = {}) {
  const snapshotId = extractSnapshotId(latest) || snapshot?.snapshotId || meta.snapshotId || null;

  const candidates = Array.isArray(snapshot?.candidates)
    ? snapshot.candidates
    : [];

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const base = latest && typeof latest === 'object'
    ? latest
    : { snapshotId };

  const createdAt = snapshotCreatedAt(snapshot || base);
  const ageSec = createdAt > 0
    ? Math.max(0, Math.floor((now() - createdAt) / 1000))
    : null;

  return {
    ...base,

    ...modeFlags(),

    snapshotId,

    selectedSnapshotSource: meta.snapshotSource || null,
    selectedSnapshotReason: meta.snapshotReason || null,

    createdAt: createdAt || base.createdAt || null,
    snapshotAgeSec: ageSec,

    candidatesCount: candidates.length || num(base.shortCandidatesCount ?? base.candidatesCount, 0),
    shortCandidatesCount: candidates.length || num(base.shortCandidatesCount ?? base.candidatesCount, 0),
    longCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    topSymbols: topSymbols(candidates),
    scannerGateSymbols: topSymbols(scannerGateCandidates),

    isStale8m: ageSec === null ? null : ageSec > STALE_8M_SEC,
    isStale30m: ageSec === null ? null : ageSec > STALE_30M_SEC
  };
}

function normalizeSnapshot(snapshot, fallbackId = null, meta = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const rawCandidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const {
    shortCandidates,
    longCandidates,
    unknownSideCandidates
  } = splitCandidatesBySide(rawCandidates);

  const candidates = shortCandidates.map(normalizeShortCandidate);
  const ageSec = snapshotAgeSec(snapshot);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  return {
    ...snapshot,

    ...modeFlags(),

    snapshotId: snapshot.snapshotId || fallbackId || null,

    selectedSnapshotSource: meta.snapshotSource || null,
    selectedSnapshotReason: meta.snapshotReason || null,

    rawCandidatesCount: rawCandidates.length,
    rawShortCandidatesCount: shortCandidates.length,
    rawLongCandidatesIgnored: longCandidates.length,
    rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

    candidates,
    candidatesCount: candidates.length,
    shortCandidatesCount: candidates.length,
    longCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    topSymbols: topSymbols(candidates),
    scannerGateSymbols: topSymbols(scannerGateCandidates),

    stats: buildCandidateStats(rawCandidates, candidates),

    snapshotAgeSec: ageSec,
    isStale8m: ageSec === null ? null : ageSec > STALE_8M_SEC,
    isStale30m: ageSec === null ? null : ageSec > STALE_30M_SEC
  };
}

function targetCandidateCount(snapshot = {}) {
  const candidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return candidates.filter(isShortCandidate).length;
}

function oppositeCandidateCount(snapshot = {}) {
  const candidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  return candidates.filter(isLongCandidate).length;
}

async function safeGetSnapshotJson(redis, key, fallback = null) {
  return getJson(redis, key, fallback).catch(() => fallback);
}

async function loadRecentSnapshotCandidates(redis) {
  const keys = await getKeys(
    redis,
    snapshotPattern(),
    SNAPSHOT_SEARCH_LIMIT
  ).catch(() => []);

  if (!keys.length) return [];

  const rows = await Promise.all(
    keys.map(async (key) => {
      const snapshot = await safeGetSnapshotJson(redis, key, null);

      if (!hasFullSnapshotShape(snapshot)) return null;

      return {
        source: `SCAN:RECENT_SEARCH:${key}`,
        snapshot,
        snapshotId: snapshot.snapshotId || key,
        targetCount: targetCandidateCount(snapshot),
        oppositeCount: oppositeCandidateCount(snapshot),
        createdAt: snapshotCreatedAt(snapshot)
      };
    })
  );

  return rows
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function dedupeSnapshotCandidates(candidates = []) {
  const unique = new Map();

  for (const item of candidates) {
    if (!item?.snapshot || !hasFullSnapshotShape(item.snapshot)) continue;

    const id = item.snapshot?.snapshotId || item.snapshotId || item.snapshotSource;

    if (!id) continue;

    const previous = unique.get(id);

    if (!previous) {
      unique.set(id, item);
      continue;
    }

    if (
      item.createdAt > previous.createdAt ||
      (
        item.createdAt === previous.createdAt &&
        item.targetCount > previous.targetCount
      )
    ) {
      unique.set(id, item);
    }
  }

  return [...unique.values()]
    .filter((item) => hasFullSnapshotShape(item.snapshot))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function loadSnapshot(redis, latest) {
  const snapshotId = extractSnapshotId(latest);
  const candidates = [];

  if (hasFullSnapshotShape(latest)) {
    candidates.push({
      snapshot: latest,
      snapshotSource: 'SCAN:LATEST_FULL_SNAPSHOT',
      snapshotReason: 'LATEST_FULL_SNAPSHOT',
      snapshotId: latest.snapshotId || snapshotId,
      targetCount: targetCandidateCount(latest),
      oppositeCount: oppositeCandidateCount(latest),
      createdAt: snapshotCreatedAt(latest)
    });
  }

  if (snapshotId) {
    const byId = await safeGetSnapshotJson(
      redis,
      snapshotKey(snapshotId),
      null
    );

    if (hasFullSnapshotShape(byId)) {
      candidates.push({
        snapshot: byId,
        snapshotSource: 'SCAN:SNAPSHOT_BY_ID',
        snapshotReason: 'SNAPSHOT_REFERENCED_BY_LATEST_ID',
        snapshotId,
        targetCount: targetCandidateCount(byId),
        oppositeCount: oppositeCandidateCount(byId),
        createdAt: snapshotCreatedAt(byId)
      });
    }
  }

  const recent = await loadRecentSnapshotCandidates(redis);

  for (const item of recent) {
    candidates.push({
      ...item,
      snapshotSource: item.source,
      snapshotReason: 'RECENT_SNAPSHOT_SEARCH'
    });
  }

  const sorted = dedupeSnapshotCandidates(candidates);

  const selectedTarget = sorted.find((item) => item.targetCount > 0);

  if (selectedTarget) {
    return {
      snapshot: normalizeSnapshot(
        selectedTarget.snapshot,
        selectedTarget.snapshotId,
        {
          snapshotSource: selectedTarget.snapshotSource,
          snapshotReason: 'NEWEST_SHORT_SNAPSHOT_WITH_CANDIDATES'
        }
      ),
      snapshotSource: selectedTarget.snapshotSource,
      snapshotReason: 'NEWEST_SHORT_SNAPSHOT_WITH_CANDIDATES',
      snapshotId: selectedTarget.snapshotId,
      rawTargetCount: selectedTarget.targetCount,
      rawOppositeCount: selectedTarget.oppositeCount,
      snapshotsScanned: sorted.length
    };
  }

  const selectedAny = sorted[0] || null;

  if (!selectedAny) {
    return {
      snapshot: null,
      snapshotSource: snapshotId ? 'SNAPSHOT_NOT_FOUND' : 'NO_SNAPSHOT_ID',
      snapshotReason: snapshotId ? 'LATEST_REFERENCED_MISSING_SNAPSHOT' : 'NO_LATEST_SNAPSHOT_ID',
      snapshotId: snapshotId || null,
      rawTargetCount: 0,
      rawOppositeCount: 0,
      snapshotsScanned: 0
    };
  }

  return {
    snapshot: normalizeSnapshot(
      selectedAny.snapshot,
      selectedAny.snapshotId,
      {
        snapshotSource: selectedAny.snapshotSource,
        snapshotReason: 'NO_SHORT_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE'
      }
    ),
    snapshotSource: selectedAny.snapshotSource,
    snapshotReason: 'NO_SHORT_SNAPSHOT_FOUND_USING_NEWEST_AVAILABLE',
    snapshotId: selectedAny.snapshotId,
    rawTargetCount: selectedAny.targetCount,
    rawOppositeCount: selectedAny.oppositeCount,
    snapshotsScanned: sorted.length
  };
}

function emptyStats() {
  return {
    candidates: 0,
    cleanCandidates: 0,
    fakeBreakouts: 0,
    fakeRiskCandidates: 0,

    scannerGateCandidates: 0,
    analyzeOnlyCandidates: 0,

    shortCandidates: 0,
    longCandidates: 0,
    unknownSideCandidates: 0,

    bearCandidates: 0,
    bullCandidates: 0,

    rawCandidates: 0,
    rawShortCandidates: 0,
    rawLongCandidatesIgnored: 0,
    rawUnknownSideCandidatesIgnored: 0,

    avgScannerScore: 0
  };
}

function buildSummary({ latest, snapshot, candidates, rawTargetCount, rawOppositeCount, snapshotsScanned }) {
  return {
    ...modeFlags(),

    latestSnapshotId: latest?.snapshotId || null,
    selectedSnapshotId: snapshot?.snapshotId || null,

    snapshotsScanned: num(snapshotsScanned, 0),

    candidates: candidates.length,
    shortCandidates: candidates.length,
    longCandidates: 0,

    rawTargetCount: num(rawTargetCount, 0),
    rawOppositeCount: num(rawOppositeCount, 0),

    rawCandidates: num(snapshot?.rawCandidatesCount, 0),
    rawLongCandidatesIgnored: num(snapshot?.rawLongCandidatesIgnored, 0),
    rawUnknownSideCandidatesIgnored: num(snapshot?.rawUnknownSideCandidatesIgnored, 0),

    scannerGateCandidates: num(snapshot?.scannerGateCandidatesCount, 0),
    analyzeOnlyCandidates: num(snapshot?.analyzeOnlyCandidatesCount, 0),

    avgScannerScore: averageScannerScore(candidates),

    topSymbols: topSymbols(candidates)
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Scanner-Mode', 'short-only-scanner-discovery');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Scanner-Only', 'true');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const redis = getVolatileRedis();
    const latestRaw = await getJson(redis, KEYS.scan.latest, null);

    const {
      snapshot,
      snapshotSource,
      snapshotReason,
      snapshotId,
      rawTargetCount,
      rawOppositeCount,
      snapshotsScanned
    } = await loadSnapshot(redis, latestRaw);

    const candidates = Array.isArray(snapshot?.candidates)
      ? snapshot.candidates
      : [];

    const latest = normalizeLatest(latestRaw, snapshot, {
      snapshotId,
      snapshotSource,
      snapshotReason
    });

    return res.status(200).json({
      ok: true,

      ...modeFlags(),

      latest,
      snapshot,
      candidates,

      snapshotId,
      snapshotSource,
      snapshotReason,

      candidatesCount: candidates.length,
      shortCandidatesCount: candidates.length,
      longCandidatesCount: 0,

      rawTargetCount,
      rawOppositeCount,
      snapshotsScanned,

      stats: snapshot?.stats || emptyStats(),

      summary: buildSummary({
        latest,
        snapshot,
        candidates,
        rawTargetCount,
        rawOppositeCount,
        snapshotsScanned
      }),

      warnings: uniqueStrings([
        !snapshot ? 'NO_SCANNER_SNAPSHOT_AVAILABLE' : null,
        snapshot?.isStale8m ? 'SCANNER_SNAPSHOT_STALE_8M' : null,
        snapshot?.isStale30m ? 'SCANNER_SNAPSHOT_STALE_30M' : null,
        rawOppositeCount > 0 ? `LONG_CANDIDATES_IGNORED:${rawOppositeCount}` : null,
        snapshot?.rawUnknownSideCandidatesIgnored > 0
          ? `UNKNOWN_SIDE_CANDIDATES_IGNORED:${snapshot.rawUnknownSideCandidatesIgnored}`
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