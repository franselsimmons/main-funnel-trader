// ================= ROTATION TRADE ADAPTER =================
// Live gate tussen TradeSystem entries en weekly active micro-family rotation.
// Gebruikt alleen microFamilyId/microFamilyIds. Geen parent LONG/SHORT matching.

import {
  loadActiveRotationStatus,
  isEntryAllowedByRotation
} from "./rotationStore.js";

import {
  attachMicroRotationKeys,
  getMicroFamilyCandidates,
  normalizeRotationSide
} from "../microRotationGate.js";

function getEnvFlag(key, fallback = false) {
  const value = process.env[key];

  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function normalizeReason(value, fallback = "UNKNOWN") {
  return String(value || fallback)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function shouldBypassAction(signal = {}) {
  const action = String(signal.action || "").toUpperCase();

  return action === "EXIT" || action === "HOLD";
}

function buildDecision({
  allowed,
  reason,
  signal,
  rotationStatus = null,
  matchedMicroFamilyId = null,
  checkedMicroFamilyIds = [],
  extra = {}
}) {
  const rotationSide = normalizeRotationSide(
    signal?.rotationSide ||
      signal?.tradeSide ||
      signal?.side
  );

  const activeRotationId =
    rotationStatus?.rotationId ||
    rotationStatus?.rotation?.rotationId ||
    null;

  return {
    allowed: Boolean(allowed),
    reason: normalizeReason(reason),

    activeRotationId,
    rotationId: activeRotationId,

    rotationStatus: rotationStatus?.status || null,
    rotationMode: rotationStatus?.mode || null,
    gateEnabled: rotationStatus?.gateEnabled ?? null,
    usable: rotationStatus?.usable ?? null,

    side: rotationSide,
    rotationSide,
    tradeSide: rotationSide,

    microFamilyId: matchedMicroFamilyId || signal?.microFamilyId || null,
    matchedMicroFamilyId,

    checkedMicroFamilyIds,
    microFamilyIds: checkedMicroFamilyIds,

    longMicroFamilyIds: rotationStatus?.longMicroFamilyIds || [],
    shortMicroFamilyIds: rotationStatus?.shortMicroFamilyIds || [],

    longCount: rotationStatus?.longCount ?? null,
    shortCount: rotationStatus?.shortCount ?? null,
    totalCount: rotationStatus?.totalCount ?? null,

    source: "WEEKLY_MICRO_ROTATION_GATE",
    checkedAt: new Date().toISOString(),

    ...extra
  };
}

function attachDecisionToSignal(signal, decision) {
  return {
    ...signal,

    rotation: decision,
    rotationGate: decision,

    rotationSide: decision.rotationSide,
    tradeSide: decision.tradeSide,

    microFamilyId: decision.microFamilyId || signal.microFamilyId || null,
    familyId: decision.microFamilyId || signal.familyId || null,

    microFamilyIds: Array.isArray(signal.microFamilyIds)
      ? signal.microFamilyIds
      : decision.microFamilyIds || [],

    microFamilies: Array.isArray(signal.microFamilies)
      ? signal.microFamilies
      : decision.microFamilyIds || []
  };
}

function logRotationDecision(logger, tag, payload) {
  if (!logger || typeof logger.log !== "function") return;

  logger.log(tag, JSON.stringify(payload));
}

export async function checkTradeSignalAgainstRotation(signal = {}, options = {}) {
  const {
    enabled = getEnvFlag("WEEKLY_ROTATION_LIVE_GATE", true),
    requireSideMatch = getEnvFlag("WEEKLY_ROTATION_REQUIRE_SIDE_MATCH", true),
    allowWhenNoRotation = String(process.env.WEEKLY_ROTATION_EMPTY_POLICY || "ALLOW").toUpperCase() !== "DENY_ALL",
    failClosed = getEnvFlag("WEEKLY_ROTATION_FAIL_CLOSED", false),
    attachDecision = true,
    logger = null
  } = options;

  const enrichedSignal = attachMicroRotationKeys(signal, {
    btcState: signal.btcState,
    regime: signal.regime
  });

  const rotationSide = normalizeRotationSide(
    enrichedSignal.rotationSide ||
      enrichedSignal.tradeSide ||
      enrichedSignal.side
  );

  if (shouldBypassAction(enrichedSignal)) {
    const decision = buildDecision({
      allowed: true,
      reason: "ROTATION_BYPASS_NON_ENTRY_ACTION",
      signal: enrichedSignal,
      checkedMicroFamilyIds: getMicroFamilyCandidates(enrichedSignal)
    });

    return {
      allowed: true,
      reason: decision.reason,
      signal: attachDecision ? attachDecisionToSignal(enrichedSignal, decision) : enrichedSignal,
      decision
    };
  }

  if (!enabled) {
    const decision = buildDecision({
      allowed: true,
      reason: "ROTATION_GATE_DISABLED",
      signal: enrichedSignal,
      checkedMicroFamilyIds: getMicroFamilyCandidates(enrichedSignal)
    });

    return {
      allowed: true,
      reason: decision.reason,
      signal: attachDecision ? attachDecisionToSignal(enrichedSignal, decision) : enrichedSignal,
      decision
    };
  }

  const microFamilyIds = getMicroFamilyCandidates(enrichedSignal);

  if (!microFamilyIds.length) {
    const decision = buildDecision({
      allowed: false,
      reason: "ENTRY_MICRO_FAMILY_MISSING",
      signal: enrichedSignal,
      checkedMicroFamilyIds: []
    });

    logRotationDecision(logger, "ROTATION_GATE_BLOCKED:", {
      reason: decision.reason,
      symbol: enrichedSignal.symbol,
      side: enrichedSignal.side,
      rotationSide,
      microFamilyId: null
    });

    return {
      allowed: false,
      reason: decision.reason,
      signal: attachDecision ? attachDecisionToSignal(enrichedSignal, decision) : enrichedSignal,
      decision
    };
  }

  let rotationStatus = null;

  try {
    rotationStatus = await loadActiveRotationStatus();
  } catch (error) {
    const decision = buildDecision({
      allowed: !failClosed,
      reason: failClosed
        ? "ROTATION_STATUS_LOAD_FAILED_FAIL_CLOSED"
        : "ROTATION_STATUS_LOAD_FAILED_ALLOWED",
      signal: enrichedSignal,
      checkedMicroFamilyIds: microFamilyIds,
      extra: {
        error: error?.message || String(error)
      }
    });

    return {
      allowed: decision.allowed,
      reason: decision.reason,
      signal: attachDecision ? attachDecisionToSignal(enrichedSignal, decision) : enrichedSignal,
      decision
    };
  }

  if (!rotationStatus?.enabled || !rotationStatus?.usable) {
    const allowed = Boolean(allowWhenNoRotation);

    const decision = buildDecision({
      allowed,
      reason: allowed
        ? "NO_USABLE_ROTATION_ALLOWED"
        : "NO_USABLE_ROTATION_BLOCKED",
      signal: enrichedSignal,
      rotationStatus,
      checkedMicroFamilyIds: microFamilyIds
    });

    return {
      allowed,
      reason: decision.reason,
      signal: attachDecision ? attachDecisionToSignal(enrichedSignal, decision) : enrichedSignal,
      decision
    };
  }

  for (const microFamilyId of microFamilyIds) {
    const check = isEntryAllowedByRotation(rotationStatus.rotation, {
      ...enrichedSignal,
      microFamilyId,
      side: requireSideMatch ? rotationSide : null,
      rotationSide,
      tradeSide: rotationSide
    });

    if (check.allowed) {
      const decision = buildDecision({
        allowed: true,
        reason: "MICRO_FAMILY_ACTIVE",
        signal: {
          ...enrichedSignal,
          microFamilyId
        },
        rotationStatus,
        matchedMicroFamilyId: microFamilyId,
        checkedMicroFamilyIds: microFamilyIds,
        extra: {
          adapterReason: check.reason
        }
      });

      logRotationDecision(logger, "ROTATION_GATE_ALLOWED:", {
        symbol: enrichedSignal.symbol,
        side: enrichedSignal.side,
        rotationSide,
        microFamilyId,
        rotationId: decision.rotationId
      });

      return {
        allowed: true,
        reason: decision.reason,
        signal: attachDecision
          ? attachDecisionToSignal(
              {
                ...enrichedSignal,
                microFamilyId,
                familyId: microFamilyId
              },
              decision
            )
          : enrichedSignal,
        decision
      };
    }
  }

  const decision = buildDecision({
    allowed: false,
    reason: "MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",
    signal: enrichedSignal,
    rotationStatus,
    checkedMicroFamilyIds: microFamilyIds
  });

  logRotationDecision(logger, "ROTATION_GATE_BLOCKED:", {
    reason: decision.reason,
    symbol: enrichedSignal.symbol,
    side: enrichedSignal.side,
    rotationSide,
    rotationId: decision.rotationId,
    checkedMicroFamilyIds: microFamilyIds.slice(0, 5),
    activeLongCount: rotationStatus.longCount,
    activeShortCount: rotationStatus.shortCount
  });

  return {
    allowed: false,
    reason: decision.reason,
    signal: attachDecision ? attachDecisionToSignal(enrichedSignal, decision) : enrichedSignal,
    decision
  };
}

export default {
  checkTradeSignalAgainstRotation
};