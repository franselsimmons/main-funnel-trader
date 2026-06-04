// ================= FILE: api/admin/scanner.js =================

import { KEYS } from '../../src/keys.js';
import { getVolatileRedis, getJson } from '../../src/redis.js';
import { sideToTradeSide, safeNumber } from '../../src/utils.js';

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
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

function countCandidatesBySide(candidates = []) {
  let longCandidates = 0;
  let shortCandidates = 0;
  let unknownSideCandidates = 0;

  for (const candidate of candidates) {
    const tradeSide = sideToTradeSide(candidate?.side);

    if (tradeSide === 'LONG') {
      longCandidates += 1;
      continue;
    }

    if (tradeSide === 'SHORT') {
      shortCandidates += 1;
      continue;
    }

    unknownSideCandidates += 1;
  }

  return {
    longCandidates,
    shortCandidates,
    unknownSideCandidates,

    // Backwards-compatible namen voor admin.html.
    bullCandidates: longCandidates,
    bearCandidates: shortCandidates
  };
}

function averageScannerScore(candidates = []) {
  if (!candidates.length) return 0;

  const total = candidates.reduce((sum, candidate) => {
    return sum + safeNumber(candidate?.scannerScore ?? candidate?.moveScore, 0);
  }, 0);

  return Number((total / candidates.length).toFixed(2));
}

function normalizeSnapshot(snapshot, fallbackId = null) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const candidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const createdAt = safeNumber(
    snapshot.createdAt ||
    snapshot.ts ||
    snapshot.scannerTs,
    0
  );

  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
    : null;

  const cleanCandidates = candidates.filter((candidate) => !candidate.fakeBreakout);
  const fakeBreakouts = candidates.filter((candidate) => candidate.fakeBreakout);
  const fakeRiskCandidates = candidates.filter((candidate) => candidate.fakeBreakoutRisk);

  const sideCounts = countCandidatesBySide(candidates);

  const topSymbols = Array.isArray(snapshot.topSymbols)
    ? snapshot.topSymbols
    : candidates.slice(0, 20).map((candidate) => candidate.symbol).filter(Boolean);

  return {
    ...snapshot,

    snapshotId: snapshot.snapshotId || fallbackId || null,

    candidates,
    candidatesCount: candidates.length,

    topSymbols,

    stats: {
      candidates: candidates.length,
      cleanCandidates: cleanCandidates.length,
      fakeBreakouts: fakeBreakouts.length,
      fakeRiskCandidates: fakeRiskCandidates.length,
      ...sideCounts,
      avgScannerScore: averageScannerScore(candidates)
    },

    snapshotAgeSec,
    isStale8m: snapshotAgeSec === null ? null : snapshotAgeSec > 8 * 60,
    isStale30m: snapshotAgeSec === null ? null : snapshotAgeSec > 30 * 60
  };
}

async function loadSnapshot(redis, latest) {
  const snapshotId = extractSnapshotId(latest);

  if (hasFullSnapshotShape(latest)) {
    return {
      snapshot: normalizeSnapshot(latest, snapshotId),
      snapshotSource: 'SCAN:LATEST_FULL_SNAPSHOT',
      snapshotId
    };
  }

  if (!snapshotId) {
    return {
      snapshot: null,
      snapshotSource: 'NO_SNAPSHOT_ID',
      snapshotId: null
    };
  }

  const snapshot = await getJson(
    redis,
    KEYS.scan.snapshot(snapshotId),
    null
  );

  return {
    snapshot: normalizeSnapshot(snapshot, snapshotId),
    snapshotSource: 'SCAN:SNAPSHOT_BY_ID',
    snapshotId
  };
}

function emptyStats() {
  return {
    candidates: 0,
    cleanCandidates: 0,
    fakeBreakouts: 0,
    fakeRiskCandidates: 0,
    longCandidates: 0,
    shortCandidates: 0,
    unknownSideCandidates: 0,
    bullCandidates: 0,
    bearCandidates: 0,
    avgScannerScore: 0
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const redis = getVolatileRedis();
    const latest = await getJson(redis, KEYS.scan.latest, null);

    const {
      snapshot,
      snapshotSource,
      snapshotId
    } = await loadSnapshot(redis, latest);

    const candidates = Array.isArray(snapshot?.candidates)
      ? snapshot.candidates
      : [];

    return res.status(200).json({
      ok: true,

      latest,
      snapshot,
      candidates,

      snapshotId,
      snapshotSource,

      candidatesCount: candidates.length,
      stats: snapshot?.stats || emptyStats(),

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