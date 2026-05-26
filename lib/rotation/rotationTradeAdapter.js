import { loadRotationStatus } from './rotationStore.js';
import {
  shouldAllowByRotation,
  explainRotationDecision,
} from './rotationGate.js';

const DEFAULT_OPTIONS = Object.freeze({
  enabled: true,
  failClosed: true,
  allowWhenNoRotation: false,
  requireSideMatch: true,
  attachDecision: true,
  logger: console,
});

function mergeOptions(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
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

function attachRotationDecision(signal, decision) {
  const next = cloneSignal(signal);

  if (!next || typeof next !== 'object') {
    return next;
  }

  next.rotation = {
    allowed: decision.allowed,
    reason: decision.reason,
    familyId: decision.candidateFamilyId,
    side: decision.candidateSide,
    activeRotationId: decision.activeRotationId,
    matchedFamily: decision.matchedFamily || null,
    checkedAt: decision.checkedAt,
  };

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
 *
 * Dit bestand is de brug tussen:
 * - je live trade systeem
 * - je weekly rotation engine
 *
 * Belangrijk:
 * - live trades gebruiken alleen activeRotation.allowlist
 * - achtergrond-analyse blijft gewoon alles loggen
 */
export async function getActiveRotationStatus(options = {}) {
  const merged = mergeOptions(options);

  try {
    const status = await loadRotationStatus();

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
 *
 * Return:
 * {
 *   allowed: boolean,
 *   rejected: boolean,
 *   reason: string,
 *   decision: object,
 *   signal: object
 * }
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
    const decision = shouldAllowByRotation(signal, null, {
      ...merged,
      failClosed: merged.failClosed,
    });

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
 *
 * Gebruik dit alleen op de LIVE execution-laag.
 * Niet gebruiken op je background analyzer.
 */
export async function filterTradableSignalsByRotation(signals = [], options = {}) {
  const merged = mergeOptions(options);
  const list = safeArray(signals);

  const loaded = await getActiveRotationStatus(merged);
  const status = loaded.ok ? loaded.status : null;

  const allowed = [];
  const rejected = [];
  const decisions = [];

  for (const signal of list) {
    const decision = shouldAllowByRotation(signal, status, merged);
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

  return {
    allowed,
    rejected,
    decisions,
    summary: {
      input: list.length,
      allowed: allowed.length,
      rejected: rejected.length,
      activeRotationId: status?.activeRotation?.id || null,
      rotationLoaded: loaded.ok,
    },
  };
}

/**
 * Splitst candidates in:
 * - liveTradable: mag naar execution
 * - backgroundOnly: blijft wel in analyzer/store
 *
 * Dit is precies jouw gewenste setup:
 * huidige week traden op vorige winnaar,
 * tegelijk alle nieuwe setups blijven verzamelen voor volgende week.
 */
export async function splitLiveAndBackgroundSignals(signals = [], options = {}) {
  const merged = mergeOptions(options);
  const list = safeArray(signals);

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
 *
 * Voorbeeld:
 *
 * const result = await runRotationProtectedTrade(signal, async (allowedSignal) => {
 *   return executeTrade(allowedSignal);
 * });
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
 *
 * Handig als je dit in je scanner/tradesystem constructor wilt hangen.
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
  getActiveRotationStatus,
  checkTradeSignalAgainstRotation,
  filterTradableSignalsByRotation,
  splitLiveAndBackgroundSignals,
  runRotationProtectedTrade,
  createRotationTradeAdapter,
};