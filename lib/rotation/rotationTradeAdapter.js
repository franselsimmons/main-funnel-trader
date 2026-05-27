// ================= ROTATION TRADE ADAPTER =================

import * as rotationStore from './rotationStore.js';

const DEFAULT_OPTIONS = Object.freeze({
  enabled: true,

  // Default: geen active rotation mag je systeem niet killen.
  // Hard blokkeren kan via WEEKLY_ROTATION_EMPTY_POLICY=DENY_ALL.
  failClosed: process.env.WEEKLY_ROTATION_FAIL_CLOSED === '1',
  allowWhenNoRotation: process.env.WEEKLY_ROTATION_EMPTY_POLICY === 'DENY_ALL'
    ? false
    : true,

  requireSideMatch: true,
  attachDecision: true,
  logger: console,
});

const ROTATION_STATUS_LOADER_NAMES = [
  'loadRotationStatus',
  'getRotationStatus',
  'readRotationStatus',
  'loadWeeklyRotationStatus',
  'getWeeklyRotationStatus',
  'readWeeklyRotationStatus',
  'loadActiveRotationStatus',
  'getActiveRotationStatus',
  'loadRotationState',
  'getRotationState',
  'readRotationState',
];

function resolveRotationStatusLoader() {
  for (const name of ROTATION_STATUS_LOADER_NAMES) {
    if (typeof rotationStore?.[name] === 'function') {
      return rotationStore[name];
    }
  }

  if (typeof rotationStore?.default === 'function') {
    return rotationStore.default;
  }

  if (rotationStore?.default && typeof rotationStore.default === 'object') {
    for (const name of ROTATION_STATUS_LOADER_NAMES) {
      if (typeof rotationStore.default?.[name] === 'function') {
        return rotationStore.default[name];
      }
    }
  }

  return null;
}

function mergeOptions(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeSide(value) {
  const side = upper(value);

  if (side.includes('SHORT')) return 'SHORT';
  if (side.includes('SELL')) return 'SHORT';
  if (side.includes('BEAR')) return 'SHORT';

  if (side.includes('LONG')) return 'LONG';
  if (side.includes('BUY')) return 'LONG';
  if (side.includes('BULL')) return 'LONG';

  return null;
}

function getSignalId(signal = {}) {
  return (
    signal.tradeId ||
    signal.signalId ||
    signal.id ||
    signal.symbol ||
    signal?.signal?.tradeId ||
    signal?.signal?.signalId ||
    signal?.signal?.id ||
    signal?.signal?.symbol ||
    'UNKNOWN_SIGNAL'
  );
}

function cloneSignal(signal) {
  if (!signal || typeof signal !== 'object') return signal;

  return {
    ...signal,
    signal: signal.signal && typeof signal.signal === 'object'
      ? { ...signal.signal }
      : signal.signal,
  };
}

function resolveActiveRotation(status) {
  if (!status || typeof status !== 'object') return null;

  if (isObject(status.activeRotation)) return status.activeRotation;
  if (isObject(status.rotation)) return status.rotation;
  if (isObject(status.currentRotation)) return status.currentRotation;
  if (isObject(status.active)) return status.active;

  if (Array.isArray(status.allowlist)) return status;

  if (status.active === true && Array.isArray(status.allowlist)) {
    return status;
  }

  return null;
}

function rotationIsExpired(rotation, now = new Date()) {
  if (!rotation?.expiresAt) return false;

  const expiresAt = new Date(rotation.expiresAt);

  if (Number.isNaN(expiresAt.getTime())) return false;

  return expiresAt <= now;
}

function hasUsableRotation(rotation) {
  if (!rotation) return false;
  if (rotation.status && upper(rotation.status) !== 'ACTIVE') return false;
  if (rotationIsExpired(rotation)) return false;
  if (!Array.isArray(rotation.allowlist)) return false;
  if (!rotation.allowlist.length) return false;

  return true;
}

function getRotationId(rotation) {
  return rotation?.rotationId || rotation?.id || null;
}

function collectCandidateFamilyIds(signal = {}) {
  const rotationCandidate = isObject(signal.rotationCandidate)
    ? signal.rotationCandidate
    : {};

  const family = isObject(signal.family) ? signal.family : {};
  const micro = isObject(signal.micro) ? signal.micro : {};
  const analysis = isObject(signal.analysis) ? signal.analysis : {};
  const analyze = isObject(signal.analyze) ? signal.analyze : {};
  const meta = isObject(signal.meta) ? signal.meta : {};
  const entry = isObject(signal.entry) ? signal.entry : {};
  const nestedSignal = isObject(signal.signal) ? signal.signal : {};
  const setup = isObject(signal.setup) ? signal.setup : {};
  const classification = isObject(signal.classification) ? signal.classification : {};

  return unique([
    signal.familyId,
    signal.family,
    signal.id,
    signal.microFamilyId,
    signal.microFamily,
    signal.microFamilyKey,
    signal.familyMicroId,
    signal.mainMicroFamilyId,
    signal.rotationMicroFamilyId,

    signal.familyIds,
    signal.families,
    signal.microFamilyIds,
    signal.microFamilies,

    rotationCandidate.familyId,
    rotationCandidate.family,
    rotationCandidate.id,
    rotationCandidate.microFamilyId,
    rotationCandidate.microFamily,
    rotationCandidate.familyIds,
    rotationCandidate.families,
    rotationCandidate.microFamilyIds,
    rotationCandidate.microFamilies,

    family.familyId,
    family.id,
    family.microFamilyId,
    family.microFamily,

    micro.id,
    micro.familyId,
    micro.microFamilyId,

    analysis.familyId,
    analysis.microFamilyId,
    analysis.microFamily,
    analysis.mainMicroFamilyId,

    analyze.familyId,
    analyze.microFamilyId,
    analyze.microFamily,

    meta.familyId,
    meta.microFamilyId,
    meta.microFamily,

    entry.familyId,
    entry.microFamilyId,
    entry.microFamily,

    nestedSignal.familyId,
    nestedSignal.microFamilyId,
    nestedSignal.microFamily,

    setup.familyId,
    setup.microFamilyId,
    setup.microFamily,

    classification.familyId,
    classification.microFamilyId,
    classification.microFamily,
  ].flatMap(safeArray));
}

function resolveCandidateSide(signal = {}) {
  return normalizeSide(
    signal.side ||
    signal.tradeSide ||
    signal.direction ||
    signal.signalSide ||
    signal?.rotationCandidate?.side ||
    signal?.signal?.side ||
    signal?.entry?.side ||
    signal?.setup?.side
  );
}

function collectAllowlistFamilyIds(item = {}) {
  return unique([
    item.id,
    item.familyId,
    item.family,
    item.microFamilyId,
    item.microFamily,
    item.key,
    item.parent,
    item.parentFamily,
    item.parentFamilyId,
    item.familyIds,
    item.families,
    item.microFamilyIds,
    item.microFamilies,
  ].flatMap(safeArray));
}

function findMatchedFamily(rotation, candidateFamilyIds = [], candidateSide = null, options = {}) {
  if (!rotation?.allowlist?.length) return null;

  const candidateIdSet = new Set(candidateFamilyIds.map(upper));

  for (const item of rotation.allowlist) {
    const itemSide = normalizeSide(item.side || item.direction);

    if (options.requireSideMatch && candidateSide && itemSide && itemSide !== candidateSide) {
      continue;
    }

    const itemIds = collectAllowlistFamilyIds(item);
    const matchedId = itemIds.find(id => candidateIdSet.has(upper(id)));

    if (!matchedId) continue;

    return {
      family: item,
      matchedId,
      matchType: 'FAMILY_ID',
    };
  }

  return null;
}

export function shouldAllowByRotation(signal = {}, rotationStatus = null, options = {}) {
  const merged = mergeOptions(options);
  const checkedAt = new Date().toISOString();

  const candidateSide = resolveCandidateSide(signal);
  const candidateFamilyIds = collectCandidateFamilyIds(signal);
  const candidateFamilyId = candidateFamilyIds[0] || null;

  if (!merged.enabled) {
    return {
      allowed: true,
      reason: 'ROTATION_DISABLED',
      candidateFamilyId,
      candidateFamilyIds,
      candidateSide,
      activeRotationId: null,
      matchedFamily: null,
      matchType: 'DISABLED',
      checkedAt,
    };
  }

  const activeRotation = resolveActiveRotation(rotationStatus);

  if (!hasUsableRotation(activeRotation)) {
    const allowed = Boolean(merged.allowWhenNoRotation);

    return {
      allowed,
      reason: allowed ? 'NO_ACTIVE_ROTATION_ALLOW_ALL' : 'NO_ACTIVE_ROTATION_BLOCKED',
      candidateFamilyId,
      candidateFamilyIds,
      candidateSide,
      activeRotationId: getRotationId(activeRotation),
      matchedFamily: null,
      matchType: 'NO_ACTIVE_ROTATION',
      checkedAt,
    };
  }

  if (!candidateSide && merged.requireSideMatch) {
    return {
      allowed: false,
      reason: 'ROTATION_SIDE_MISSING',
      candidateFamilyId,
      candidateFamilyIds,
      candidateSide,
      activeRotationId: getRotationId(activeRotation),
      matchedFamily: null,
      matchType: 'SIDE_MISSING',
      checkedAt,
    };
  }

  if (!candidateFamilyIds.length) {
    return {
      allowed: false,
      reason: 'ROTATION_FAMILY_MISSING',
      candidateFamilyId,
      candidateFamilyIds,
      candidateSide,
      activeRotationId: getRotationId(activeRotation),
      matchedFamily: null,
      matchType: 'FAMILY_MISSING',
      checkedAt,
    };
  }

  const match = findMatchedFamily(
    activeRotation,
    candidateFamilyIds,
    candidateSide,
    merged
  );

  if (!match) {
    return {
      allowed: false,
      reason: 'FAMILY_NOT_IN_ACTIVE_ROTATION',
      candidateFamilyId,
      candidateFamilyIds,
      candidateSide,
      activeRotationId: getRotationId(activeRotation),
      matchedFamily: null,
      matchType: 'NO_MATCH',
      checkedAt,
    };
  }

  return {
    allowed: true,
    reason: 'MATCHED_ACTIVE_ROTATION_FAMILY',
    candidateFamilyId: match.matchedId,
    candidateFamilyIds,
    candidateSide,
    activeRotationId: getRotationId(activeRotation),
    matchedFamily: match.family,
    matchType: match.matchType,
    checkedAt,
  };
}

export function explainRotationDecision(decision = {}) {
  if (!decision) return 'NO_ROTATION_DECISION';

  if (decision.allowed) {
    return `ALLOW ${decision.reason} ${decision.candidateSide || 'SIDE_UNKNOWN'} ${decision.candidateFamilyId || 'FAMILY_UNKNOWN'}`;
  }

  return `BLOCK ${decision.reason} ${decision.candidateSide || 'SIDE_UNKNOWN'} ${decision.candidateFamilyId || 'FAMILY_UNKNOWN'}`;
}

function attachRotationDecision(signal, decision) {
  const next = cloneSignal(signal);

  if (!next || typeof next !== 'object') {
    return next;
  }

  next.rotation = {
    allowed: decision.allowed,
    reason: decision.reason,
    familyId: decision.candidateFamilyId,
    familyIds: decision.candidateFamilyIds,
    side: decision.candidateSide,
    activeRotationId: decision.activeRotationId,
    matchedFamily: decision.matchedFamily || null,
    matchType: decision.matchType || null,
    checkedAt: decision.checkedAt,
  };

  next.rotationGate = next.rotation;
  next.liveEligible = decision.allowed;
  next.shadowOnly = !decision.allowed;

  return next;
}

function makeRejectedResult(signal, decision, options = {}) {
  const decoratedSignal = options.attachDecision
    ? attachRotationDecision(signal, decision)
    : signal;

  return {
    allowed: false,
    rejected: true,
    reason: decision.reason,
    decision,
    signal: decoratedSignal,
  };
}

function makeAllowedResult(signal, decision, options = {}) {
  const decoratedSignal = options.attachDecision
    ? attachRotationDecision(signal, decision)
    : signal;

  return {
    allowed: true,
    rejected: false,
    reason: decision.reason,
    decision,
    signal: decoratedSignal,
  };
}

function logDecision(signal, decision, options = {}) {
  const logger = options.logger;

  if (!logger || typeof logger.info !== 'function') return;

  const signalId = getSignalId(signal);
  const line = explainRotationDecision(decision);

  logger.info(`[rotationTradeAdapter] ${signalId} ${line}`);
}

/**
 * Laadt de actieve rotation-status uit storage.
 */
export async function getActiveRotationStatus(options = {}) {
  const merged = mergeOptions(options);
  const loader = resolveRotationStatusLoader();

  if (!loader) {
    const error = new Error(
      `rotationStore.js heeft geen geldige status-loader export. Gezocht: ${ROTATION_STATUS_LOADER_NAMES.join(', ')}`
    );

    merged.logger?.error?.('[rotationTradeAdapter] failed to resolve rotation status loader', error);

    return {
      ok: false,
      status: null,
      error,
    };
  }

  try {
    let status;

    try {
      status = await loader(merged);
    } catch {
      status = await loader();
    }

    return {
      ok: true,
      status,
    };
  } catch (error) {
    merged.logger?.error?.('[rotationTradeAdapter] failed to load rotation status', error);

    return {
      ok: false,
      status: null,
      error,
    };
  }
}

/**
 * Checkt één trade signal tegen de actieve weekly rotation.
 */
export async function checkTradeSignalAgainstRotation(signal, options = {}) {
  const merged = mergeOptions(options);

  if (!merged.enabled) {
    const decision = shouldAllowByRotation(signal, null, {
      ...merged,
      enabled: false,
    });

    return makeAllowedResult(signal, decision, merged);
  }

  const loaded = await getActiveRotationStatus(merged);

  if (!loaded.ok) {
    const familyIds = collectCandidateFamilyIds(signal);

    const decision = {
      allowed: !merged.failClosed,
      reason: merged.failClosed
        ? 'ROTATION_STATUS_LOAD_FAILED_BLOCKED'
        : 'ROTATION_STATUS_LOAD_FAILED_FAIL_OPEN',
      candidateFamilyId: familyIds[0] || null,
      candidateFamilyIds: familyIds,
      candidateSide: resolveCandidateSide(signal),
      activeRotationId: null,
      matchedFamily: null,
      matchType: 'LOAD_ERROR',
      checkedAt: new Date().toISOString(),
    };

    logDecision(signal, decision, merged);

    return decision.allowed
      ? makeAllowedResult(signal, decision, merged)
      : makeRejectedResult(signal, decision, merged);
  }

  const decision = shouldAllowByRotation(signal, loaded.status, merged);

  logDecision(signal, decision, merged);

  return decision.allowed
    ? makeAllowedResult(signal, decision, merged)
    : makeRejectedResult(signal, decision, merged);
}

/**
 * Filtert een lijst trade signals.
 */
export async function filterTradableSignalsByRotation(signals = [], options = {}) {
  const merged = mergeOptions(options);
  const list = Array.isArray(signals) ? signals : [];

  const loaded = await getActiveRotationStatus(merged);
  const status = loaded.ok ? loaded.status : null;

  const allowed = [];
  const rejected = [];
  const decisions = [];

  for (const signal of list) {
    const familyIds = collectCandidateFamilyIds(signal);

    const decision = loaded.ok
      ? shouldAllowByRotation(signal, status, merged)
      : {
          allowed: !merged.failClosed,
          reason: merged.failClosed
            ? 'ROTATION_STATUS_LOAD_FAILED_BLOCKED'
            : 'ROTATION_STATUS_LOAD_FAILED_FAIL_OPEN',
          candidateFamilyId: familyIds[0] || null,
          candidateFamilyIds: familyIds,
          candidateSide: resolveCandidateSide(signal),
          activeRotationId: null,
          matchedFamily: null,
          matchType: 'LOAD_ERROR',
          checkedAt: new Date().toISOString(),
        };

    const result = decision.allowed
      ? makeAllowedResult(signal, decision, merged)
      : makeRejectedResult(signal, decision, merged);

    decisions.push(result.decision);

    if (result.allowed) {
      allowed.push(result.signal);
    } else {
      rejected.push(result.signal);
    }

    logDecision(signal, decision, merged);
  }

  const activeRotation = resolveActiveRotation(status);

  return {
    allowed,
    rejected,
    decisions,
    summary: {
      input: list.length,
      allowed: allowed.length,
      rejected: rejected.length,
      activeRotationId: getRotationId(activeRotation),
      rotationLoaded: loaded.ok,
    },
  };
}

/**
 * Splitst candidates in:
 * - liveTradable: mag naar execution
 * - backgroundOnly: blijft wel in analyzer/store
 */
export async function splitLiveAndBackgroundSignals(signals = [], options = {}) {
  const merged = mergeOptions(options);
  const list = Array.isArray(signals) ? signals : [];

  const filtered = await filterTradableSignalsByRotation(list, merged);

  return {
    liveTradable: filtered.allowed,
    backgroundOnly: filtered.rejected,
    allSignalsForAnalytics: list,
    decisions: filtered.decisions,
    summary: filtered.summary,
  };
}

/**
 * Wrapper voor bestaande trade pipeline.
 */
export async function runRotationProtectedTrade(signal, executeFn, options = {}) {
  const merged = mergeOptions(options);

  if (typeof executeFn !== 'function') {
    throw new TypeError('runRotationProtectedTrade requires executeFn(signal)');
  }

  const checked = await checkTradeSignalAgainstRotation(signal, merged);

  if (!checked.allowed) {
    return {
      executed: false,
      skipped: true,
      reason: checked.reason,
      decision: checked.decision,
      signal: checked.signal,
      result: null,
    };
  }

  const result = await executeFn(checked.signal);

  return {
    executed: true,
    skipped: false,
    reason: checked.reason,
    decision: checked.decision,
    signal: checked.signal,
    result,
  };
}

/**
 * Factory voor dependency injection.
 */
export function createRotationTradeAdapter(options = {}) {
  const merged = mergeOptions(options);

  return {
    getStatus: () => getActiveRotationStatus(merged),

    check: (signal, overrideOptions = {}) =>
      checkTradeSignalAgainstRotation(signal, {
        ...merged,
        ...overrideOptions,
      }),

    filter: (signals, overrideOptions = {}) =>
      filterTradableSignalsByRotation(signals, {
        ...merged,
        ...overrideOptions,
      }),

    split: (signals, overrideOptions = {}) =>
      splitLiveAndBackgroundSignals(signals, {
        ...merged,
        ...overrideOptions,
      }),

    runProtected: (signal, executeFn, overrideOptions = {}) =>
      runRotationProtectedTrade(signal, executeFn, {
        ...merged,
        ...overrideOptions,
      }),
  };
}

export default {
  shouldAllowByRotation,
  explainRotationDecision,
  getActiveRotationStatus,
  checkTradeSignalAgainstRotation,
  filterTradableSignalsByRotation,
  splitLiveAndBackgroundSignals,
  runRotationProtectedTrade,
  createRotationTradeAdapter,
};