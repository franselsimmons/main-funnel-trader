import {
  loadActiveRotation,
  isEntryAllowedByRotation,
  resolveEntryMicroFamilyId,
} from '../rotation/rotationStore.js';

function parseSide(value, fallback = null) {
  const side = String(value || fallback || '').toUpperCase();

  if (side === 'LONG') return 'LONG';
  if (side === 'SHORT') return 'SHORT';

  return null;
}

function inferSideFromText(value, fallback = null) {
  const text = String(value || '').toUpperCase();

  if (text.includes('SHORT')) return 'SHORT';
  if (text.includes('LONG')) return 'LONG';

  return fallback;
}

export function resolveTradeSide(signal = {}) {
  return (
    parseSide(signal.side) ||
    parseSide(signal.direction) ||
    parseSide(signal.entrySide) ||
    parseSide(signal.tradeSide) ||
    parseSide(signal.setup?.side) ||
    parseSide(signal.entry?.side) ||
    inferSideFromText(resolveEntryMicroFamilyId(signal), null)
  );
}

export function buildRotationEntryFromSignal(signal = {}) {
  const microFamilyId = resolveEntryMicroFamilyId(signal);
  const side = resolveTradeSide(signal);

  return {
    microFamilyId,
    side,
    direction: side,

    symbol:
      signal.symbol ||
      signal.market ||
      signal.ticker ||
      signal.entry?.symbol ||
      null,

    entryType:
      signal.entryType ||
      signal.type ||
      signal.entry?.type ||
      null,

    score:
      signal.score ??
      signal.sniperScore ??
      signal.entry?.score ??
      null,
  };
}

export async function applyMicroRotationGate(signal = {}, options = {}) {
  const {
    rotation = null,
    failOpen = false,
  } = options;

  const activeRotation = rotation || await loadActiveRotation();
  const entry = buildRotationEntryFromSignal(signal);

  if (!entry.side) {
    return {
      allowed: false,
      reason: 'TRADE_SIDE_MISSING',
      entry,
    };
  }

  if (!entry.microFamilyId) {
    return {
      allowed: false,
      reason: 'TRADE_MICRO_FAMILY_MISSING',
      entry,
    };
  }

  const gate = isEntryAllowedByRotation(activeRotation, entry);

  if (!gate.allowed && failOpen) {
    return {
      allowed: true,
      reason: 'MICRO_ROTATION_FAIL_OPEN',
      originalReason: gate.reason,
      entry,
      gate,
    };
  }

  return {
    ...gate,
    entry,
  };
}

export async function filterTradeCandidateByMicroRotation(candidate = {}, options = {}) {
  const gate = await applyMicroRotationGate(candidate, options);

  if (!gate.allowed) {
    return {
      ...candidate,
      blocked: true,
      skip: true,
      skipReason: gate.reason,
      rotationGate: gate,
    };
  }

  return {
    ...candidate,
    blocked: false,
    skip: false,
    rotationGate: gate,
  };
}

export async function assertTradeAllowedByMicroRotation(candidate = {}, options = {}) {
  const gate = await applyMicroRotationGate(candidate, options);

  if (gate.allowed) {
    return {
      ok: true,
      gate,
    };
  }

  return {
    ok: false,
    skip: true,
    reason: gate.reason,
    gate,
  };
}