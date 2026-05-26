import {
  getActiveRotation,
  readRotationStatus,
} from './rotationRunner.js';

const DEFAULT_GATE_OPTIONS = {
  enabled: true,

  // false = als er geen actieve rotatie is, laat hij signalen nog door.
  // true  = zonder actieve rotatie alles blokkeren.
  requireActiveRotation: false,

  // true = signaal moet exact in activeRotation.allowlist staan.
  // false = gate geeft alleen analyse terug, maar blokkeert niet.
  hardGate: true,

  // true = als microFamilyId ontbreekt, mag hij fallbacken naar familyId.
  // Voor echte micro-rotatie liever true tijdens overgangsfase, later false.
  allowParentFallback: true,
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';

  return String(value).trim();
}

function normalizeSide(side) {
  const value = normalizeText(side).toUpperCase();

  if (value === 'LONG') return 'LONG';
  if (value === 'SHORT') return 'SHORT';

  return '';
}

function normalizeFamilyId(value) {
  return normalizeText(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getNestedValue(source, path) {
  if (!isObject(source)) return null;

  return path.split('.').reduce((current, key) => {
    if (!isObject(current)) return null;

    return current[key] ?? null;
  }, source);
}

export function extractSignalSide(signal) {
  if (!isObject(signal)) return '';

  return normalizeSide(
    signal.side ||
    signal.direction ||
    signal.tradeSide ||
    signal.positionSide ||
    getNestedValue(signal, 'entry.side') ||
    getNestedValue(signal, 'trade.side') ||
    getNestedValue(signal, 'signal.side')
  );
}

export function extractMicroFamilyId(signal) {
  if (!isObject(signal)) return '';

  const candidates = [
    signal.microFamilyId,
    signal.microfamilyId,
    signal.microFamily,
    signal.microfamily,
    signal.microId,
    signal.familyMicroId,
    signal.mainMicroFamilyId,

    getNestedValue(signal, 'family.micro'),
    getNestedValue(signal, 'family.microFamilyId'),
    getNestedValue(signal, 'families.micro'),
    getNestedValue(signal, 'families.microFamilyId'),
    getNestedValue(signal, 'analysis.microFamilyId'),
    getNestedValue(signal, 'rotation.microFamilyId'),
    getNestedValue(signal, 'trade.microFamilyId'),
    getNestedValue(signal, 'entry.microFamilyId'),
    getNestedValue(signal, 'meta.microFamilyId'),
  ];

  return normalizeFamilyId(candidates.find(Boolean));
}

export function extractParentFamilyId(signal) {
  if (!isObject(signal)) return '';

  const candidates = [
    signal.parentFamilyId,
    signal.familyId,
    signal.family,
    signal.parent,
    signal.mainFamilyId,

    getNestedValue(signal, 'family.parent'),
    getNestedValue(signal, 'family.familyId'),
    getNestedValue(signal, 'families.parent'),
    getNestedValue(signal, 'families.familyId'),
    getNestedValue(signal, 'analysis.parentFamilyId'),
    getNestedValue(signal, 'trade.familyId'),
    getNestedValue(signal, 'entry.familyId'),
    getNestedValue(signal, 'meta.familyId'),
  ];

  return normalizeFamilyId(candidates.find(Boolean));
}

export function extractCandidateFamilyIds(signal, options = {}) {
  const finalOptions = {
    ...DEFAULT_GATE_OPTIONS,
    ...options,
  };

  const microFamilyId = extractMicroFamilyId(signal);
  const parentFamilyId = extractParentFamilyId(signal);

  if (!finalOptions.allowParentFallback) {
    return unique([microFamilyId]);
  }

  return unique([
    microFamilyId,
    parentFamilyId,
  ]);
}

export function rotationIsActive(rotation, now = new Date()) {
  if (!rotation?.expiresAt) return false;

  const expiresAt = new Date(rotation.expiresAt);

  if (Number.isNaN(expiresAt.getTime())) return false;

  return expiresAt > now;
}

export function getRotationAllowlist(rotation, side = '') {
  if (!rotation?.allowlist?.length) return [];

  const wantedSide = normalizeSide(side);

  return rotation.allowlist.filter(item => {
    if (!wantedSide) return true;

    return normalizeSide(item.side) === wantedSide;
  });
}

export function findAllowedRotationFamily(rotation, signal, options = {}) {
  const side = extractSignalSide(signal);
  const candidateFamilyIds = extractCandidateFamilyIds(signal, options);
  const allowlist = getRotationAllowlist(rotation, side);

  if (!candidateFamilyIds.length) return null;

  return allowlist.find(item => {
    const allowedFamilyId = normalizeFamilyId(item.familyId);

    return candidateFamilyIds.includes(allowedFamilyId);
  }) || null;
}

export function evaluateRotationGate(signal, rotation, options = {}) {
  const finalOptions = {
    ...DEFAULT_GATE_OPTIONS,
    ...options,
  };

  const now = finalOptions.now ? new Date(finalOptions.now) : new Date();
  const side = extractSignalSide(signal);
  const microFamilyId = extractMicroFamilyId(signal);
  const parentFamilyId = extractParentFamilyId(signal);
  const candidateFamilyIds = extractCandidateFamilyIds(signal, finalOptions);

  if (!finalOptions.enabled) {
    return {
      allowed: true,
      blocked: false,
      reason: 'GATE_DISABLED',
      side,
      microFamilyId,
      parentFamilyId,
      candidateFamilyIds,
      matchedFamily: null,
      rotationId: rotation?.rotationId || null,
    };
  }

  if (!rotation) {
    const allowed = !finalOptions.requireActiveRotation;

    return {
      allowed,
      blocked: !allowed,
      reason: allowed ? 'NO_ROTATION_FAIL_OPEN' : 'NO_ROTATION_FAIL_CLOSED',
      side,
      microFamilyId,
      parentFamilyId,
      candidateFamilyIds,
      matchedFamily: null,
      rotationId: null,
    };
  }

  const active = rotationIsActive(rotation, now);

  if (!active) {
    const allowed = !finalOptions.requireActiveRotation;

    return {
      allowed,
      blocked: !allowed,
      reason: allowed ? 'ROTATION_EXPIRED_FAIL_OPEN' : 'ROTATION_EXPIRED_FAIL_CLOSED',
      side,
      microFamilyId,
      parentFamilyId,
      candidateFamilyIds,
      matchedFamily: null,
      rotationId: rotation.rotationId || null,
      expiresAt: rotation.expiresAt || null,
    };
  }

  if (!side) {
    return {
      allowed: false,
      blocked: true,
      reason: 'MISSING_SIDE',
      side,
      microFamilyId,
      parentFamilyId,
      candidateFamilyIds,
      matchedFamily: null,
      rotationId: rotation.rotationId || null,
    };
  }

  if (!candidateFamilyIds.length) {
    return {
      allowed: false,
      blocked: true,
      reason: 'MISSING_FAMILY_ID',
      side,
      microFamilyId,
      parentFamilyId,
      candidateFamilyIds,
      matchedFamily: null,
      rotationId: rotation.rotationId || null,
    };
  }

  const matchedFamily = findAllowedRotationFamily(rotation, signal, finalOptions);

  if (matchedFamily) {
    return {
      allowed: true,
      blocked: false,
      reason: 'ROTATION_MATCH',
      side,
      microFamilyId,
      parentFamilyId,
      candidateFamilyIds,
      matchedFamily,
      rotationId: rotation.rotationId || null,
      expiresAt: rotation.expiresAt || null,
    };
  }

  if (!finalOptions.hardGate) {
    return {
      allowed: true,
      blocked: false,
      reason: 'NO_MATCH_SOFT_GATE',
      side,
      microFamilyId,
      parentFamilyId,
      candidateFamilyIds,
      matchedFamily: null,
      rotationId: rotation.rotationId || null,
      expiresAt: rotation.expiresAt || null,
    };
  }

  return {
    allowed: false,
    blocked: true,
    reason: 'NO_ROTATION_MATCH',
    side,
    microFamilyId,
    parentFamilyId,
    candidateFamilyIds,
    matchedFamily: null,
    rotationId: rotation.rotationId || null,
    expiresAt: rotation.expiresAt || null,
  };
}

export async function evaluateSignalAgainstActiveRotation(signal, options = {}, customPaths = {}) {
  const rotation = await getActiveRotation(customPaths);

  return evaluateRotationGate(signal, rotation, options);
}

export async function isSignalAllowedByActiveRotation(signal, options = {}, customPaths = {}) {
  const result = await evaluateSignalAgainstActiveRotation(signal, options, customPaths);

  return result.allowed;
}

export async function filterSignalsByActiveRotation(signals, options = {}, customPaths = {}) {
  if (!Array.isArray(signals)) {
    return {
      allowed: [],
      blocked: [],
      evaluations: [],
      status: await readRotationStatus(customPaths),
    };
  }

  const rotation = await getActiveRotation(customPaths);
  const evaluations = signals.map(signal => {
    const gate = evaluateRotationGate(signal, rotation, options);

    return {
      signal,
      gate,
    };
  });

  return {
    allowed: evaluations
      .filter(item => item.gate.allowed)
      .map(item => item.signal),

    blocked: evaluations
      .filter(item => item.gate.blocked)
      .map(item => item.signal),

    evaluations,

    status: await readRotationStatus(customPaths),
  };
}

export function attachRotationGateToSignal(signal, gateResult) {
  if (!isObject(signal)) return signal;

  return {
    ...signal,
    rotationGate: {
      allowed: Boolean(gateResult?.allowed),
      blocked: Boolean(gateResult?.blocked),
      reason: gateResult?.reason || 'UNKNOWN',
      rotationId: gateResult?.rotationId || null,
      matchedFamilyId: gateResult?.matchedFamily?.familyId || null,
      side: gateResult?.side || null,
      microFamilyId: gateResult?.microFamilyId || null,
      parentFamilyId: gateResult?.parentFamilyId || null,
    },
  };
}

export async function gateSignalForExecution(signal, options = {}, customPaths = {}) {
  const gate = await evaluateSignalAgainstActiveRotation(
    signal,
    {
      ...options,
      hardGate: true,
    },
    customPaths
  );

  return {
    allowed: gate.allowed,
    blocked: gate.blocked,
    reason: gate.reason,
    gate,
    signal: attachRotationGateToSignal(signal, gate),
  };
}

export async function gateSignalForDiscord(signal, options = {}, customPaths = {}) {
  const gate = await evaluateSignalAgainstActiveRotation(
    signal,
    {
      ...options,
      hardGate: true,
    },
    customPaths
  );

  return {
    send: gate.allowed,
    blocked: gate.blocked,
    reason: gate.reason,
    gate,
    signal: attachRotationGateToSignal(signal, gate),
  };
}

export async function observeSignalForAnalysis(signal, options = {}, customPaths = {}) {
  const gate = await evaluateSignalAgainstActiveRotation(
    signal,
    {
      ...options,
      hardGate: false,
    },
    customPaths
  );

  return {
    allowedForAnalysis: true,
    allowedForExecution: gate.allowed,
    gate,
    signal: attachRotationGateToSignal(signal, gate),
  };
}

export default {
  extractSignalSide,
  extractMicroFamilyId,
  extractParentFamilyId,
  extractCandidateFamilyIds,
  rotationIsActive,
  getRotationAllowlist,
  findAllowedRotationFamily,
  evaluateRotationGate,
  evaluateSignalAgainstActiveRotation,
  isSignalAllowedByActiveRotation,
  filterSignalsByActiveRotation,
  attachRotationGateToSignal,
  gateSignalForExecution,
  gateSignalForDiscord,
  observeSignalForAnalysis,
};