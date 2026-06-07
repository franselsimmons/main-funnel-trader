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

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

function now() {
  return Date.now();
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

function snapshotPattern() {
  try {
    return KEYS.scan.snapshot('*');
  } catch {
    return 'SCAN:SNAPSHOT:*';
  }
}

function extractSnapshotId(latest) {
  if (!latest) return null;

  if (typeof latest === 'string') {
    return latest;
  }

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
  return safeNumber(
    snapshot.createdAt ||
    snapshot.completedAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    0
  );
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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .join(' | ');
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    const value = cleanSideText(row);

    if (!value) return 'UNKNOWN';

    if (
      value.includes('MICRO_LONG_') ||
      value.includes('TRADESIDE=LONG') ||
      value.includes('TRADE_SIDE=LONG') ||
      value.includes('SIDE=LONG') ||
      value.includes('SIDE=BULL') ||
      value.includes('DIRECTION=LONG') ||
      value.includes('DIRECTION=BULL') ||
      value.includes('POSITION_SIDE=LONG') ||
      value.includes('POSITIONSIDE=LONG')
    ) {
      return OPPOSITE_TRADE_SIDE;
    }

    if (
      value.includes('MICRO_SHORT_') ||
      value.includes('TRADESIDE=SHORT') ||
      value.includes('TRADE_SIDE=SHORT') ||
      value.includes('SIDE=SHORT') ||
      value.includes('SIDE=BEAR') ||
      value.includes('DIRECTION=SHORT') ||
      value.includes('DIRECTION=BEAR') ||
      value.includes('POSITION_SIDE=SHORT') ||
      value.includes('POSITIONSIDE=SHORT') ||
      value.includes('SHORT') ||
      value.includes('BEAR') ||
      value.includes('SELL')
    ) {
      return TARGET_TRADE_SIDE;
    }

    if (
      value.includes('LONG') ||
      value.includes('BULL') ||
      value.includes('BUY')
    ) {
      return OPPOSITE_TRADE_SIDE;
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
    row.actualScannerSide ||
    row.analysisSide ||
    row.entrySide ||
    row.bias ||
    row.marketBias
  );

  if (direct === TARGET_TRADE_SIDE || direct === OPPOSITE_TRADE_SIDE) {
    return direct;
  }

  const rawSide = cleanSideText(row.side);

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(rawSide)) return TARGET_TRADE_SIDE;
  if (['LONG', 'BULL', 'BULLISH', 'BUY'].includes(rawSide)) return OPPOSITE_TRADE_SIDE;

  const familyId = cleanSideText(row.familyId || row.family || row.baseFamilyId);

  const macroFamilyId = cleanSideText(
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId
  );

  const microFamilyId = cleanSideText(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key
  );

  if (familyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;
  if (familyId.startsWith('LONG_')) return OPPOSITE_TRADE_SIDE;

  if (macroFamilyId.includes('MICRO_LONG_') || macroFamilyId.startsWith('LONG_')) return OPPOSITE_TRADE_SIDE;
  if (macroFamilyId.includes('MICRO_SHORT_') || macroFamilyId.startsWith('SHORT_')) return TARGET_TRADE_SIDE;

  if (macroFamilyId.includes('TRADESIDE=LONG') || macroFamilyId.includes('SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  if (macroFamilyId.includes('TRADESIDE=SHORT') || macroFamilyId.includes('SIDE=SHORT')) return TARGET_TRADE_SIDE;

  if (microFamilyId.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  if (microFamilyId.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;

  if (microFamilyId.includes('TRADESIDE=LONG') || microFamilyId.includes('SIDE=LONG')) return OPPOSITE_TRADE_SIDE;
  if (microFamilyId.includes('TRADESIDE=SHORT') || microFamilyId.includes('SIDE=SHORT')) return TARGET_TRADE_SIDE;

  const scannerReason = cleanSideText(
    row.scannerReason ||
    row.reason ||
    row.signalReason ||
    row.actionReason
  );

  if (
    scannerReason.includes('LONG') ||
    scannerReason.includes('BULL') ||
    scannerReason.includes('BUY') ||
    scannerReason.includes('UPSIDE')
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (
    scannerReason.includes('SHORT') ||
    scannerReason.includes('BEAR') ||
    scannerReason.includes('SELL') ||
    scannerReason.includes('DOWNSIDE')
  ) {
    return TARGET_TRADE_SIDE;
  }

  const definition = getDefinitionHaystack(row);

  if (
    definition.includes('TRADESIDE=LONG') ||
    definition.includes('TRADE_SIDE=LONG') ||
    definition.includes('SIDE=LONG') ||
    definition.includes('SIDE=BULL') ||
    definition.includes('DIRECTION=LONG') ||
    definition.includes('DIRECTION=BULL') ||
    definition.includes('SIDE=BUY') ||
    definition.includes('DIRECTION=BUY') ||
    definition.includes('POSITION_SIDE=LONG') ||
    definition.includes('POSITIONSIDE=LONG')
  ) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (
    definition.includes('TRADESIDE=SHORT') ||
    definition.includes('TRADE_SIDE=SHORT') ||
    definition.includes('SIDE=SHORT') ||
    definition.includes('SIDE=BEAR') ||
    definition.includes('DIRECTION=SHORT') ||
    definition.includes('DIRECTION=BEAR') ||
    definition.includes('SIDE=SELL') ||
    definition.includes('DIRECTION=SELL') ||
    definition.includes('POSITION_SIDE=SHORT') ||
    definition.includes('POSITIONSIDE=SHORT')
  ) {
    return TARGET_TRADE_SIDE;
  }

  if (microFamilyId.includes('LONG')) return OPPOSITE_TRADE_SIDE;
  if (microFamilyId.includes('SHORT')) return TARGET_TRADE_SIDE;

  if (macroFamilyId.includes('LONG')) return OPPOSITE_TRADE_SIDE;
  if (macroFamilyId.includes('SHORT')) return TARGET_TRADE_SIDE;

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

function normalizeShortCandidate(candidate = {}) {
  return {
    ...candidate,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
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

function countCandidatesBySide(candidates = []) {
  const {
    shortCandidates,
    longCandidates,
    unknownSideCandidates
  } = splitCandidatesBySide(candidates);

  return {
    longCandidates: longCandidates.length,
    shortCandidates: shortCandidates.length,
    unknownSideCandidates: unknownSideCandidates.length,

    // Backwards-compatible namen voor admin.html.
    bullCandidates: 0,
    bearCandidates: shortCandidates.length,

    rawLongCandidates: longCandidates.length,
    rawShortCandidates: shortCandidates.length,
    rawUnknownSideCandidates: unknownSideCandidates.length
  };
}

function averageScannerScore(candidates = []) {
  if (!candidates.length) return 0;

  const total = candidates.reduce((sum, candidate) => {
    return sum + safeNumber(candidate?.scannerScore ?? candidate?.moveScore, 0);
  }, 0);

  return Number((total / candidates.length).toFixed(2));
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
    : {
      snapshotId
    };

  return {
    ...base,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    snapshotId,

    selectedSnapshotSource: meta.snapshotSource || null,
    selectedSnapshotReason: meta.snapshotReason || null,

    candidatesCount: candidates.length || safeNumber(base.shortCandidatesCount, 0),
    shortCandidatesCount: candidates.length || safeNumber(base.shortCandidatesCount, 0),
    longCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    topSymbols: candidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean)
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

  const createdAt = snapshotCreatedAt(snapshot);

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((now() - createdAt) / 1000))
    : null;

  const cleanCandidates = candidates.filter((candidate) => !candidate.fakeBreakout);
  const fakeBreakouts = candidates.filter((candidate) => candidate.fakeBreakout);
  const fakeRiskCandidates = candidates.filter((candidate) => candidate.fakeBreakoutRisk);

  const scannerGateCandidates = candidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = candidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly
  ));

  const sideCounts = countCandidatesBySide(candidates);

  const topSymbols = candidates
    .slice(0, 20)
    .map((candidate) => candidate.symbol)
    .filter(Boolean);

  const scannerGateSymbols = scannerGateCandidates
    .slice(0, 20)
    .map((candidate) => candidate.symbol)
    .filter(Boolean);

  return {
    ...snapshot,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    snapshotId: snapshot.snapshotId || fallbackId || null,

    selectedSnapshotSource: meta.snapshotSource || null,
    selectedSnapshotReason: meta.snapshotReason || null,

    rawCandidatesCount: rawCandidates.length,
    rawLongCandidatesIgnored: longCandidates.length,
    rawUnknownSideCandidatesIgnored: unknownSideCandidates.length,

    candidates,
    candidatesCount: candidates.length,
    shortCandidatesCount: candidates.length,
    longCandidatesCount: 0,

    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    topSymbols,
    scannerGateSymbols,

    stats: {
      candidates: candidates.length,
      cleanCandidates: cleanCandidates.length,
      fakeBreakouts: fakeBreakouts.length,
      fakeRiskCandidates: fakeRiskCandidates.length,

      scannerGateCandidates: scannerGateCandidates.length,
      analyzeOnlyCandidates: analyzeOnlyCandidates.length,

      ...sideCounts,

      avgScannerScore: averageScannerScore(candidates),

      rawCandidates: rawCandidates.length,
      rawLongCandidatesIgnored: longCandidates.length,
      rawUnknownSideCandidatesIgnored: unknownSideCandidates.length
    },

    snapshotAgeSec,
    isStale8m: snapshotAgeSec === null ? null : snapshotAgeSec > 8 * 60,
    isStale30m: snapshotAgeSec === null ? null : snapshotAgeSec > 30 * 60
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

async function loadSnapshot(redis, latest) {
  const snapshotId = extractSnapshotId(latest);
  const candidates = [];

  if (hasFullSnapshotShape(latest)) {
    candidates.push({
      snapshot: latest,
      snapshotSource: 'SCAN:LATEST_FULL_SNAPSHOT',
      snapshotReason: 'LATEST_FULL_SNAPSHOT',
      snapshotId,
      targetCount: targetCandidateCount(latest),
      oppositeCount: oppositeCandidateCount(latest),
      createdAt: snapshotCreatedAt(latest)
    });
  }

  if (snapshotId) {
    const byId = await safeGetSnapshotJson(
      redis,
      KEYS.scan.snapshot(snapshotId),
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

  const unique = new Map();

  for (const item of candidates) {
    const id = item.snapshot?.snapshotId || item.snapshotId || item.snapshotSource;

    if (!id) continue;

    const previous = unique.get(id);

    if (!previous) {
      unique.set(id, item);
      continue;
    }

    if (
      item.targetCount > previous.targetCount ||
      (
        item.targetCount === previous.targetCount &&
        item.createdAt > previous.createdAt
      )
    ) {
      unique.set(id, item);
    }
  }

  const sorted = [...unique.values()]
    .filter((item) => hasFullSnapshotShape(item.snapshot))
    .sort((a, b) => b.createdAt - a.createdAt);

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
      rawOppositeCount: selectedTarget.oppositeCount
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
      rawOppositeCount: 0
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
    rawOppositeCount: selectedAny.oppositeCount
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

    longCandidates: 0,
    shortCandidates: 0,
    unknownSideCandidates: 0,

    bullCandidates: 0,
    bearCandidates: 0,

    avgScannerScore: 0,

    rawCandidates: 0,
    rawLongCandidatesIgnored: 0,
    rawUnknownSideCandidatesIgnored: 0
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Scanner-Mode', 'short-only-wide-snapshot-search');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Disabled', 'true');

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
      rawOppositeCount
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

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

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

      stats: snapshot?.stats || emptyStats(),

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,

      shortOnly: true,
      longDisabled: true,
      longOnly: false,
      shortDisabled: false,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}