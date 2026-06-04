// ================= FILE: api/admin/scanner.js =================

import { KEYS } from '../../src/keys.js';
import { getVolatileRedis, getJson } from '../../src/redis.js';

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

function hasSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (
      Array.isArray(value.candidates) ||
      value.createdAt ||
      value.snapshotId ||
      value.btcState ||
      value.regime
    )
  );
}

function normalizeSnapshot(snapshot, fallbackId = null) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const candidates = Array.isArray(snapshot.candidates)
    ? snapshot.candidates
    : [];

  const createdAt = Number(snapshot.createdAt || snapshot.ts || snapshot.scannerTs || 0);
  const snapshotAgeSec = createdAt > 0
    ? Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
    : null;

  const cleanCandidates = candidates.filter((candidate) => !candidate.fakeBreakout);
  const fakeBreakouts = candidates.filter((candidate) => candidate.fakeBreakout);
  const fakeRiskCandidates = candidates.filter((candidate) => candidate.fakeBreakoutRisk);

  const bullCandidates = candidates.filter((candidate) => {
    const side = String(candidate.side || '').toLowerCase();
    return side === 'bull' || side === 'long' || side === 'buy';
  });

  const bearCandidates = candidates.filter((candidate) => {
    const side = String(candidate.side || '').toLowerCase();
    return side === 'bear' || side === 'short' || side === 'sell';
  });

  const avgScannerScore = candidates.length
    ? candidates.reduce((sum, candidate) => {
        return sum + Number(candidate.scannerScore ?? candidate.moveScore ?? 0);
      }, 0) / candidates.length
    : 0;

  return {
    ...snapshot,

    snapshotId: snapshot.snapshotId || fallbackId || null,

    candidates,
    candidatesCount: candidates.length,

    stats: {
      candidates: candidates.length,
      cleanCandidates: cleanCandidates.length,
      fakeBreakouts: fakeBreakouts.length,
      fakeRiskCandidates: fakeRiskCandidates.length,
      bullCandidates: bullCandidates.length,
      bearCandidates: bearCandidates.length,
      avgScannerScore
    },

    snapshotAgeSec,
    isStale8m: snapshotAgeSec === null ? null : snapshotAgeSec > 8 * 60,
    isStale30m: snapshotAgeSec === null ? null : snapshotAgeSec > 30 * 60
  };
}

async function loadSnapshot(redis, latest) {
  const snapshotId = extractSnapshotId(latest);

  if (hasSnapshotShape(latest) && Array.isArray(latest.candidates)) {
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

  const snapshot = await getJson(redis, KEYS.scan.snapshot(snapshotId), null);

  return {
    snapshot: normalizeSnapshot(snapshot, snapshotId),
    snapshotSource: 'SCAN:SNAPSHOT_BY_ID',
    snapshotId
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      allowed: ['GET']
    });
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
      stats: snapshot?.stats || {
        candidates: 0,
        cleanCandidates: 0,
        fakeBreakouts: 0,
        fakeRiskCandidates: 0,
        bullCandidates: 0,
        bearCandidates: 0,
        avgScannerScore: 0
      },

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}