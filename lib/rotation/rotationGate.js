import { readRotationStatus } from './rotationRunner.js';

const DEFAULT_GATE_OPTIONS = Object.freeze({
  enabled: true,
  failClosed: true,
  allowWhenNoRotation: false,
  shadowOnly: false,
  requireSideMatch: true,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function cleanString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function upper(value) {
  return cleanString(value).toUpperCase();
}

function normalizeId(value) {
  return cleanString(value).toUpperCase();
}

function normalizeSide(value) {
  const side = upper(value);

  if (side === 'LONG') return 'LONG';
  if (side === 'SHORT') return 'SHORT';

  return 'UNKNOWN';
}

function getRotationRoot(status) {
  if (!isObject(status)) return null;

  return (
    status.activeRotation ||
    status.rotation ||
    status.currentRotation ||
    status
  );
}

function getRotationState(status) {
  const root = getRotationRoot(status);

  return upper(
    status?.state ||
      status?.status ||
      root?.state ||
      root?.status ||
      'UNKNOWN'
  );
}

function getRotationActive(status) {
  const root = getRotationRoot(status);

  const active =
    status?.active ??
    status?.isActive ??
    root?.active ??
    root?.isActive ??
    false;

  return Boolean(active);
}

function getRotationExpiresAt(status) {
  const root = getRotationRoot(status);

  return (
    root?.expiresAt ||
    root?.validUntil ||
    root?.endAt ||
    status?.expiresAt ||
    status?.validUntil ||
    null
  );
}

function isExpired(expiresAt, nowMs = Date.now()) {
  if (!expiresAt) return false;

  const expiresMs = new Date(expiresAt).getTime();

  if (!Number.isFinite(expiresMs)) return false;

  return expiresMs <= nowMs;
}

function normalizeFamilyItem(item) {
  if (!isObject(item)) {
    return {
      familyId: normalizeId(item),
      side: 'UNKNOWN',
      raw: item,
    };
  }

  const familyId = normalizeId(
    item.familyId ||
      item.id ||
      item.microFamilyId ||
      item.microId ||
      item.name
  );

  return {
    familyId,
    side: normalizeSide(item.side),
    status: upper(item.status || item.quality || item.label || ''),
    closed: Number(item.closed ?? item.closedTrades ?? item.tradesClosed ?? 0),
    avgR: Number(item.avgR ?? item.averageR ?? 0),
    pf: Number(item.pf ?? item.profitFactor ?? 0),
    winratePct: Number(item.winratePct ?? item.winrate ?? item.wr ?? 0),
    raw: item,
  };
}

function getAllowlistFromStatus(status) {
  const root = getRotationRoot(status);

  const source =
    root?.allowlist ||
    root?.families ||
    root?.selectedFamilies ||
    root?.activeFamilies ||
    status?.allowlist ||
    status?.families ||
    status?.selectedFamilies ||
    [];

  return asArray(source)
    .map(normalizeFamilyItem)
    .filter(item => item.familyId);
}

function buildAllowMap(allowlist) {
  const map = new Map();

  for (const family of allowlist) {
    if (!family.familyId) continue;

    if (!map.has(family.familyId)) {
      map.set(family.familyId, []);
    }

    map.get(family.familyId).push(family);
  }

  return map;
}

function extractNestedCandidate(candidate) {
  if (!isObject(candidate)) return {};

  return {
    ...candidate,
    ...(isObject(candidate.signal) ? candidate.signal : {}),
    ...(isObject(candidate.trade) ? candidate.trade : {}),
    ...(isObject(candidate.setup) ? candidate.setup : {}),
    ...(isObject(candidate.analysis) ? candidate.analysis : {}),
    ...(isObject(candidate.family) ? candidate.family : {}),
    ...(isObject(candidate.microFamily) ? candidate.microFamily : {}),
    ...(isObject(candidate.meta) ? candidate.meta : {}),
  };
}

function extractCandidateFamilyIds(candidate) {
  const data = extractNestedCandidate(candidate);

  const ids = [
    data.microFamilyId,
    data.familyId,
    data.activeFamilyId,
    data.rotationFamilyId,
    data.id,
    data.name,
  ];

  if (Array.isArray(data.familyIds)) {
    ids.push(...data.familyIds);
  }

  if (Array.isArray(data.microFamilyIds)) {
    ids.push(...data.microFamilyIds);
  }

  return [...new Set(ids.map(normalizeId).filter(Boolean))];
}

function extractCandidateSide(candidate) {
  const data = extractNestedCandidate(candidate);

  return normalizeSide(
    data.side ||
      data.tradeSide ||
      data.direction ||
      data.positionSide
  );
}

function buildDecision({
  allowed,
  reason,
  candidateFamilyIds = [],
  candidateSide = 'UNKNOWN',
  matchedFamily = null,
  allowlistCount = 0,
  rotationState = 'UNKNOWN',
  rotationActive = false,
  shadowOnly = false,
}) {
  return {
    allowed,
    shadowAllowed: shadowOnly ? allowed : null,
    blocked: !allowed,
    reason,
    candidateFamilyIds,
    candidateSide,
    matchedFamily,
    allowlistCount,
    rotationState,
    rotationActive,
    shadowOnly,
  };
}

export function isRotationTradable(status, nowMs = Date.now()) {
  const root = getRotationRoot(status);

  if (!root) {
    return {
      ok: false,
      reason: 'NO_ROTATION_STATUS',
      state: 'UNKNOWN',
      active: false,
      expired: false,
    };
  }

  const state = getRotationState(status);
  const active = getRotationActive(status);
  const expiresAt = getRotationExpiresAt(status);
  const expired = isExpired(expiresAt, nowMs);

  if (!active) {
    return {
      ok: false,
      reason: 'ROTATION_NOT_ACTIVE',
      state,
      active,
      expired,
    };
  }

  if (expired) {
    return {
      ok: false,
      reason: 'ROTATION_EXPIRED',
      state,
      active,
      expired,
      expiresAt,
    };
  }

  return {
    ok: true,
    reason: 'ROTATION_ACTIVE',
    state,
    active,
    expired,
    expiresAt,
  };
}

export function shouldAllowByRotation(candidate, status, options = {}) {
  const opts = {
    ...DEFAULT_GATE_OPTIONS,
    ...options,
  };

  if (!opts.enabled) {
    return buildDecision({
      allowed: true,
      reason: 'GATE_DISABLED',
      shadowOnly: opts.shadowOnly,
    });
  }

  const rotationCheck = isRotationTradable(status);

  if (!rotationCheck.ok) {
    const allowed = opts.allowWhenNoRotation && rotationCheck.reason === 'NO_ROTATION_STATUS';

    return buildDecision({
      allowed,
      reason: allowed ? 'NO_ROTATION_ALLOWED_BY_CONFIG' : rotationCheck.reason,
      rotationState: rotationCheck.state,
      rotationActive: rotationCheck.active,
      shadowOnly: opts.shadowOnly,
    });
  }

  const allowlist = getAllowlistFromStatus(status);
  const allowMap = buildAllowMap(allowlist);

  if (!allowlist.length) {
    return buildDecision({
      allowed: !opts.failClosed,
      reason: opts.failClosed ? 'EMPTY_ALLOWLIST_FAIL_CLOSED' : 'EMPTY_ALLOWLIST_FAIL_OPEN',
      allowlistCount: 0,
      rotationState: rotationCheck.state,
      rotationActive: rotationCheck.active,
      shadowOnly: opts.shadowOnly,
    });
  }

  const candidateFamilyIds = extractCandidateFamilyIds(candidate);
  const candidateSide = extractCandidateSide(candidate);

  if (!candidateFamilyIds.length) {
    return buildDecision({
      allowed: !opts.failClosed,
      reason: opts.failClosed ? 'MISSING_CANDIDATE_FAMILY_ID' : 'MISSING_CANDIDATE_FAMILY_ID_FAIL_OPEN',
      candidateFamilyIds,
      candidateSide,
      allowlistCount: allowlist.length,
      rotationState: rotationCheck.state,
      rotationActive: rotationCheck.active,
      shadowOnly: opts.shadowOnly,
    });
  }

  for (const familyId of candidateFamilyIds) {
    const matches = allowMap.get(familyId) || [];

    for (const family of matches) {
      const sideMatches =
        !opts.requireSideMatch ||
        family.side === 'UNKNOWN' ||
        candidateSide === 'UNKNOWN' ||
        family.side === candidateSide;

      if (!sideMatches) continue;

      return buildDecision({
        allowed: true,
        reason: 'FAMILY_ALLOWED',
        candidateFamilyIds,
        candidateSide,
        matchedFamily: family,
        allowlistCount: allowlist.length,
        rotationState: rotationCheck.state,
        rotationActive: rotationCheck.active,
        shadowOnly: opts.shadowOnly,
      });
    }
  }

  return buildDecision({
    allowed: false,
    reason: 'FAMILY_NOT_IN_ACTIVE_ROTATION',
    candidateFamilyIds,
    candidateSide,
    allowlistCount: allowlist.length,
    rotationState: rotationCheck.state,
    rotationActive: rotationCheck.active,
    shadowOnly: opts.shadowOnly,
  });
}

export async function shouldAllowTrade(candidate, options = {}) {
  const status = await readRotationStatus();

  return shouldAllowByRotation(candidate, status, options);
}

export async function rotationGate(candidate, options = {}) {
  const decision = await shouldAllowTrade(candidate, options);

  if (options?.shadowOnly) {
    return {
      ...decision,
      allowed: true,
      realAllowed: decision.allowed,
      blocked: false,
      reason: `SHADOW_${decision.reason}`,
    };
  }

  return decision;
}

export async function filterAllowedTrades(candidates = [], options = {}) {
  const status = await readRotationStatus();

  const allowed = [];
  const blocked = [];
  const decisions = [];

  for (const candidate of asArray(candidates)) {
    const decision = shouldAllowByRotation(candidate, status, options);

    decisions.push({
      candidate,
      decision,
    });

    if (decision.allowed) {
      allowed.push(candidate);
      continue;
    }

    blocked.push(candidate);
  }

  return {
    allowed,
    blocked,
    decisions,
    counts: {
      input: asArray(candidates).length,
      allowed: allowed.length,
      blocked: blocked.length,
    },
  };
}

export function explainRotationDecision(decision) {
  if (!isObject(decision)) return 'UNKNOWN_DECISION';

  const ids = decision.candidateFamilyIds?.length
    ? decision.candidateFamilyIds.join(', ')
    : 'NO_FAMILY_ID';

  const side = decision.candidateSide || 'UNKNOWN';

  return [
    `allowed=${decision.allowed}`,
    `reason=${decision.reason}`,
    `side=${side}`,
    `family=${ids}`,
    `allowlist=${decision.allowlistCount ?? 0}`,
    `rotation=${decision.rotationState || 'UNKNOWN'}`,
  ].join(' | ');
}

export default {
  shouldAllowTrade,
  shouldAllowByRotation,
  rotationGate,
  filterAllowedTrades,
  isRotationTradable,
  explainRotationDecision,
};