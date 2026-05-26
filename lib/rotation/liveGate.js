import {
  loadActiveRotation,
  getActiveMicroFamilyIds,
  isMicroFamilyActive,
} from './rotationStore.js';

const DEFAULT_CACHE_MS = 10_000;

let cachedRotation = null;
let cachedAt = 0;

function nowMs() {
  return Date.now();
}

function isCacheFresh(cacheMs = DEFAULT_CACHE_MS) {
  if (!cachedRotation) return false;

  return nowMs() - cachedAt <= cacheMs;
}

function safeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(items) {
  return [
    ...new Set(
      items
        .flat()
        .map(item => String(item ?? '').trim())
        .filter(Boolean)
    ),
  ];
}

function normalizeSideValue(value) {
  const side = String(value || '').toUpperCase();

  if (side.includes('SHORT')) return 'SHORT';
  if (side.includes('SELL')) return 'SHORT';
  if (side.includes('BEAR')) return 'SHORT';

  if (side.includes('LONG')) return 'LONG';
  if (side.includes('BUY')) return 'LONG';
  if (side.includes('BULL')) return 'LONG';

  return null;
}

export async function getCachedActiveRotation({ cacheMs = DEFAULT_CACHE_MS, force = false } = {}) {
  if (!force && isCacheFresh(cacheMs)) return cachedRotation;

  cachedRotation = await loadActiveRotation();
  cachedAt = nowMs();

  return cachedRotation;
}

export function clearLiveGateCache() {
  cachedRotation = null;
  cachedAt = 0;
}

export function resolveSide(record = {}) {
  const rawSide =
    record.side ||
    record.tradeSide ||
    record.direction ||
    record.signalSide ||
    record?.signal?.side ||
    record?.entry?.side ||
    record?.rotationCandidate?.side ||
    '';

  return normalizeSideValue(rawSide);
}

export function resolveMicroFamilyIds(record = {}) {
  const rotationCandidate = record?.rotationCandidate || {};
  const family = record?.family || {};
  const micro = record?.micro || {};
  const analysis = record?.analysis || {};
  const analyze = record?.analyze || {};
  const meta = record?.meta || {};
  const entry = record?.entry || {};
  const signal = record?.signal || {};

  return unique([
    record.microFamilyId,
    record.microFamily,
    record.microFamilyKey,
    record.familyMicroId,
    record.mainMicroFamilyId,
    record.rotationMicroFamilyId,

    record.familyId,
    record.family,
    record.id,

    record.familyIds,
    record.families,
    record.microFamilyIds,
    record.microFamilies,

    rotationCandidate.microFamilyId,
    rotationCandidate.microFamily,
    rotationCandidate.familyId,
    rotationCandidate.family,
    rotationCandidate.id,
    rotationCandidate.familyIds,
    rotationCandidate.families,
    rotationCandidate.microFamilyIds,
    rotationCandidate.microFamilies,

    family.microFamilyId,
    family.microFamily,
    family.microId,
    family.familyId,
    family.id,

    micro.familyId,
    micro.microFamilyId,
    micro.id,

    analysis.microFamilyId,
    analysis.microFamily,
    analysis.mainMicroFamilyId,
    analysis.familyId,

    analyze.microFamilyId,
    analyze.microFamily,
    analyze.familyId,

    meta.microFamilyId,
    meta.microFamily,
    meta.familyId,

    entry.microFamilyId,
    entry.microFamily,
    entry.familyId,

    signal.microFamilyId,
    signal.microFamily,
    signal.familyId,
  ].flatMap(safeArray));
}

export function resolveMicroFamilyId(record = {}) {
  return resolveMicroFamilyIds(record)[0] || null;
}

export function getRotationSummary(rotation) {
  if (!rotation) {
    return {
      status: 'NO_ROTATION',
      rotationId: null,
      total: 0,
      long: 0,
      short: 0,
    };
  }

  const allowlist = Array.isArray(rotation.allowlist) ? rotation.allowlist : [];

  return {
    status: rotation.status || 'UNKNOWN',
    rotationId: rotation.rotationId || rotation.id || null,
    total: allowlist.length,
    long: allowlist.filter(item => normalizeSideValue(item.side) === 'LONG').length,
    short: allowlist.filter(item => normalizeSideValue(item.side) === 'SHORT').length,
  };
}

export function hasUsableRotation(rotation) {
  if (!rotation) return false;
  if (rotation.status !== 'ACTIVE') return false;
  if (!Array.isArray(rotation.allowlist)) return false;
  if (rotation.allowlist.length === 0) return false;

  if (rotation.expiresAt) {
    const expiresAt = new Date(rotation.expiresAt);

    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date()) {
      return false;
    }
  }

  return true;
}

export async function checkLiveGate(record = {}, options = {}) {
  const {
    enabled = true,
    failOpen = false,
    cacheMs = DEFAULT_CACHE_MS,
    forceReload = false,
  } = options;

  const side = resolveSide(record);
  const microFamilyIds = resolveMicroFamilyIds(record);
  const microFamilyId = microFamilyIds[0] || null;

  if (!enabled) {
    return createDecision({
      allowed: true,
      reason: 'LIVE_GATE_DISABLED',
      side,
      microFamilyId,
      microFamilyIds,
    });
  }

  if (!side) {
    return createDecision({
      allowed: failOpen,
      reason: failOpen ? 'SIDE_MISSING_FAIL_OPEN' : 'SIDE_MISSING_BLOCKED',
      side,
      microFamilyId,
      microFamilyIds,
    });
  }

  if (!microFamilyIds.length) {
    return createDecision({
      allowed: failOpen,
      reason: failOpen ? 'MICRO_FAMILY_MISSING_FAIL_OPEN' : 'MICRO_FAMILY_MISSING_BLOCKED',
      side,
      microFamilyId,
      microFamilyIds,
    });
  }

  const rotation = await getCachedActiveRotation({
    cacheMs,
    force: forceReload,
  });

  const rotationSummary = getRotationSummary(rotation);

  if (!hasUsableRotation(rotation)) {
    return createDecision({
      allowed: failOpen,
      reason: failOpen ? 'NO_ACTIVE_ROTATION_FAIL_OPEN' : 'NO_ACTIVE_ROTATION_BLOCKED',
      side,
      microFamilyId,
      microFamilyIds,
      rotation,
      rotationSummary,
    });
  }

  const matchedMicroFamilyId = microFamilyIds.find(id => isMicroFamilyActive(rotation, id, side));

  if (!matchedMicroFamilyId) {
    return createDecision({
      allowed: false,
      reason: 'MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION',
      side,
      microFamilyId,
      microFamilyIds,
      rotation,
      rotationSummary,
    });
  }

  return createDecision({
    allowed: true,
    reason: 'MICRO_FAMILY_ALLOWED',
    side,
    microFamilyId: matchedMicroFamilyId,
    microFamilyIds,
    rotation,
    rotationSummary,
  });
}

export async function filterLiveCandidates(records = [], options = {}) {
  if (!Array.isArray(records)) return [];

  const checked = await Promise.all(
    records.map(async record => {
      const gate = await checkLiveGate(record, options);

      return {
        record,
        gate,
      };
    })
  );

  return checked
    .filter(item => item.gate.allowed)
    .map(item => ({
      ...item.record,
      liveGate: item.gate,
    }));
}

export async function annotateLiveCandidates(records = [], options = {}) {
  if (!Array.isArray(records)) return [];

  return Promise.all(
    records.map(async record => {
      const gate = await checkLiveGate(record, options);

      return {
        ...record,
        liveGate: gate,
        liveEligible: gate.allowed,
      };
    })
  );
}

export async function getActiveLiveMicroFamilies(side = null, options = {}) {
  const rotation = await getCachedActiveRotation(options);

  return getActiveMicroFamilyIds(rotation, side);
}

export function createDecision({
  allowed,
  reason,
  side = null,
  microFamilyId = null,
  microFamilyIds = [],
  rotation = null,
  rotationSummary = null,
}) {
  return {
    allowed: Boolean(allowed),
    blocked: !allowed,
    reason,
    side,
    microFamilyId,
    microFamilyIds,
    rotationId: rotation?.rotationId || rotation?.id || null,
    rotationStatus: rotation?.status || null,
    rotationSummary: rotationSummary || getRotationSummary(rotation),
    checkedAt: new Date().toISOString(),
  };
}

export function explainGateDecision(decision = {}) {
  if (decision.allowed) {
    return `ALLOW | ${decision.reason} | ${decision.side || 'SIDE_UNKNOWN'} | ${
      decision.microFamilyId || 'MICRO_UNKNOWN'
    }`;
  }

  return `BLOCK | ${decision.reason} | ${decision.side || 'SIDE_UNKNOWN'} | ${
    decision.microFamilyId || 'MICRO_UNKNOWN'
  }`;
}

export default {
  getCachedActiveRotation,
  clearLiveGateCache,
  resolveSide,
  resolveMicroFamilyId,
  resolveMicroFamilyIds,
  getRotationSummary,
  hasUsableRotation,
  checkLiveGate,
  filterLiveCandidates,
  annotateLiveCandidates,
  getActiveLiveMicroFamilies,
  createDecision,
  explainGateDecision,
};