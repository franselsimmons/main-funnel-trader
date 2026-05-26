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
    '';

  const side = String(rawSide).toUpperCase();

  if (side.includes('SHORT')) return 'SHORT';
  if (side.includes('SELL')) return 'SHORT';
  if (side.includes('LONG')) return 'LONG';
  if (side.includes('BUY')) return 'LONG';

  return null;
}

export function resolveMicroFamilyId(record = {}) {
  const candidates = [
    record.microFamilyId,
    record.microFamily,
    record.microFamilyKey,
    record.familyMicroId,
    record.mainMicroFamilyId,
    record.rotationMicroFamilyId,

    record?.family?.microFamilyId,
    record?.family?.microFamily,
    record?.family?.microId,

    record?.micro?.familyId,
    record?.micro?.microFamilyId,
    record?.micro?.id,

    record?.analysis?.microFamilyId,
    record?.analysis?.microFamily,
    record?.analysis?.mainMicroFamilyId,

    record?.analyze?.microFamilyId,
    record?.analyze?.microFamily,

    record?.meta?.microFamilyId,
    record?.meta?.microFamily,

    record?.entry?.microFamilyId,
    record?.entry?.microFamily,

    record?.signal?.microFamilyId,
    record?.signal?.microFamily,
  ];

  const found = candidates.find(value => typeof value === 'string' && value.trim());

  return found ? found.trim() : null;
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
    rotationId: rotation.rotationId || null,
    total: allowlist.length,
    long: allowlist.filter(item => item.side === 'LONG').length,
    short: allowlist.filter(item => item.side === 'SHORT').length,
  };
}

export function hasUsableRotation(rotation) {
  if (!rotation) return false;
  if (rotation.status !== 'ACTIVE') return false;
  if (!Array.isArray(rotation.allowlist)) return false;
  if (rotation.allowlist.length === 0) return false;

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
  const microFamilyId = resolveMicroFamilyId(record);

  if (!enabled) {
    return createDecision({
      allowed: true,
      reason: 'LIVE_GATE_DISABLED',
      side,
      microFamilyId,
    });
  }

  if (!side) {
    return createDecision({
      allowed: failOpen,
      reason: failOpen ? 'SIDE_MISSING_FAIL_OPEN' : 'SIDE_MISSING_BLOCKED',
      side,
      microFamilyId,
    });
  }

  if (!microFamilyId) {
    return createDecision({
      allowed: failOpen,
      reason: failOpen ? 'MICRO_FAMILY_MISSING_FAIL_OPEN' : 'MICRO_FAMILY_MISSING_BLOCKED',
      side,
      microFamilyId,
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
      rotation,
      rotationSummary,
    });
  }

  const matched = isMicroFamilyActive(rotation, microFamilyId, side);

  if (!matched) {
    return createDecision({
      allowed: false,
      reason: 'MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION',
      side,
      microFamilyId,
      rotation,
      rotationSummary,
    });
  }

  return createDecision({
    allowed: true,
    reason: 'MICRO_FAMILY_ALLOWED',
    side,
    microFamilyId,
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
  rotation = null,
  rotationSummary = null,
}) {
  return {
    allowed: Boolean(allowed),
    blocked: !allowed,
    reason,
    side,
    microFamilyId,
    rotationId: rotation?.rotationId || null,
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