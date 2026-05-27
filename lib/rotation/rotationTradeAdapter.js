import {
  loadActiveRotationStatus,
  normalizeRotationSide,
  isMicroFamilyActive
} from "./rotationStore.js";

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function normalizeSide(side) {
  const value = String(side || "").trim().toUpperCase();

  if (value === "BULL" || value === "LONG") return "LONG";
  if (value === "BEAR" || value === "SHORT") return "SHORT";

  return normalizeRotationSide(value);
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      values
        .flat()
        .map(value => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function extractSignalFamilyIds(signal) {
  return uniqueStrings([
    Array.isArray(signal?.microFamilyIds) ? signal.microFamilyIds : [],
    Array.isArray(signal?.familyIds) ? signal.familyIds : [],
    Array.isArray(signal?.microFamilies) ? signal.microFamilies : [],
    Array.isArray(signal?.families) ? signal.families : [],

    signal?.microFamilyId,
    signal?.familyId,

    signal?.rotationCandidate?.microFamilyId,
    signal?.rotationCandidate?.familyId,

    Array.isArray(signal?.rotationCandidate?.microFamilyIds)
      ? signal.rotationCandidate.microFamilyIds
      : [],

    Array.isArray(signal?.rotationCandidate?.familyIds)
      ? signal.rotationCandidate.familyIds
      : []
  ]);
}

function normalizeAllowlist(rotation) {
  if (!rotation || !Array.isArray(rotation.allowlist)) return [];

  return rotation.allowlist
    .filter(Boolean)
    .map(item => {
      const side = normalizeSide(item.side || item.tradeSide || item.rotationSide);

      return {
        ...item,
        side,
        tradeSide: side,
        microFamilyId: String(item.microFamilyId || item.familyId || "").trim(),
        familyId: String(item.familyId || item.microFamilyId || "").trim(),
        status: String(item.status || "ACTIVE").toUpperCase()
      };
    })
    .filter(item => item.microFamilyId || item.familyId);
}

function isActiveRotation(rotation) {
  if (!rotation || typeof rotation !== "object") return false;

  const status = String(rotation.status || "").toUpperCase();

  if (status !== "ACTIVE" && status !== "READY") {
    return false;
  }

  return normalizeAllowlist(rotation).some(item => item.status === "ACTIVE");
}

function findRotationMatch({ rotation, familyIds, side, requireSideMatch }) {
  const allowlist = normalizeAllowlist(rotation);
  const idSet = new Set(familyIds.map(String));

  for (const item of allowlist) {
    if (item.status !== "ACTIVE") continue;

    const ids = [
      item.microFamilyId,
      item.familyId,
      item.parentFamilyId
    ]
      .map(value => String(value || "").trim())
      .filter(Boolean);

    const idMatch = ids.some(id => idSet.has(id));
    if (!idMatch) continue;

    if (requireSideMatch && item.side !== side) {
      continue;
    }

    return item;
  }

  return null;
}

function buildDecision({
  allowed,
  reason,
  signal,
  rotation,
  familyIds,
  side,
  matchedItem = null,
  error = null
}) {
  const allowlist = normalizeAllowlist(rotation);

  return {
    allowed: Boolean(allowed),
    reason,

    activeRotationId: rotation?.rotationId || null,
    rotationId: rotation?.rotationId || null,
    rotationStatus: rotation?.status || null,
    mode: rotation?.mode || null,
    sourceWindow: rotation?.sourceWindow || null,

    signalSide: side,
    requiredSide: side,

    candidateFamilyIds: familyIds,
    candidateMicroFamilyIds: familyIds,

    matched: Boolean(matchedItem),
    matchedFamilyId: matchedItem?.microFamilyId || matchedItem?.familyId || null,
    matchedMicroFamilyId: matchedItem?.microFamilyId || null,
    matchedItem,

    allowlistCount: allowlist.length,
    longCount: allowlist.filter(item => item.side === "LONG").length,
    shortCount: allowlist.filter(item => item.side === "SHORT").length,

    signalSymbol: signal?.symbol || null,
    setupClass: signal?.setupClass || null,
    entryReason: signal?.reason || signal?.entryReason || signal?.entryType || null,

    error: error ? String(error.message || error) : null,
    ts: Date.now()
  };
}

export async function checkTradeSignalAgainstRotation(signal, options = {}) {
  const logger = options.logger || console;

  const enabled =
    options.enabled !== undefined
      ? Boolean(options.enabled)
      : process.env.WEEKLY_ROTATION_LIVE_GATE !== "0";

  const requireSideMatch =
    options.requireSideMatch !== undefined
      ? Boolean(options.requireSideMatch)
      : asBool("WEEKLY_ROTATION_REQUIRE_SIDE_MATCH", true);

  const allowWhenNoRotation =
    options.allowWhenNoRotation !== undefined
      ? Boolean(options.allowWhenNoRotation)
      : process.env.WEEKLY_ROTATION_EMPTY_POLICY !== "DENY_ALL";

  const failClosed =
    options.failClosed !== undefined
      ? Boolean(options.failClosed)
      : asBool("WEEKLY_ROTATION_FAIL_CLOSED", true);

  const attachDecision =
    options.attachDecision !== undefined
      ? Boolean(options.attachDecision)
      : true;

  const familyIds = extractSignalFamilyIds(signal);
  const side = normalizeSide(signal?.rotationSide || signal?.tradeSide || signal?.side);

  if (!enabled) {
    const decision = buildDecision({
      allowed: true,
      reason: "ROTATION_GATE_DISABLED",
      signal,
      rotation: null,
      familyIds,
      side
    });

    return {
      allowed: true,
      reason: decision.reason,
      decision,
      signal: attachDecision
        ? {
            ...signal,
            rotation: decision,
            rotationGate: decision
          }
        : signal
    };
  }

  try {
    const rotation = await loadActiveRotationStatus();

    if (!isActiveRotation(rotation)) {
      const decision = buildDecision({
        allowed: allowWhenNoRotation,
        reason: allowWhenNoRotation
          ? "NO_ACTIVE_ROTATION_ALLOW"
          : "NO_ACTIVE_ROTATION_DENY",
        signal,
        rotation,
        familyIds,
        side
      });

      return {
        allowed: decision.allowed,
        reason: decision.reason,
        decision,
        signal: attachDecision
          ? {
              ...signal,
              rotation: decision,
              rotationGate: decision
            }
          : signal
      };
    }

    if (!familyIds.length) {
      const decision = buildDecision({
        allowed: false,
        reason: "SIGNAL_HAS_NO_MICRO_FAMILY_IDS",
        signal,
        rotation,
        familyIds,
        side
      });

      return {
        allowed: false,
        reason: decision.reason,
        decision,
        signal: attachDecision
          ? {
              ...signal,
              rotation: decision,
              rotationGate: decision
            }
          : signal
      };
    }

    const matchedItem = findRotationMatch({
      rotation,
      familyIds,
      side,
      requireSideMatch
    });

    if (!matchedItem) {
      const decision = buildDecision({
        allowed: false,
        reason: requireSideMatch
          ? "MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION_OR_SIDE_MISMATCH"
          : "MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",
        signal,
        rotation,
        familyIds,
        side
      });

      return {
        allowed: false,
        reason: decision.reason,
        decision,
        signal: attachDecision
          ? {
              ...signal,
              rotation: decision,
              rotationGate: decision
            }
          : signal
      };
    }

    const decision = buildDecision({
      allowed: true,
      reason: "MICRO_FAMILY_ACTIVE_IN_WEEKLY_ROTATION",
      signal,
      rotation,
      familyIds,
      side,
      matchedItem
    });

    const patchedSignal = {
      ...signal,

      rotation: decision,
      rotationGate: decision,

      rotationSide: side,
      tradeSide: side,

      matchedRotationFamilyId: decision.matchedFamilyId,
      matchedRotationMicroFamilyId: decision.matchedMicroFamilyId,
      activeRotationId: decision.activeRotationId
    };

    return {
      allowed: true,
      reason: decision.reason,
      decision,
      signal: attachDecision ? patchedSignal : signal
    };
  } catch (e) {
    logger?.error?.("[rotationTradeAdapter] rotation gate error", e);

    const allowed = !failClosed;

    const decision = buildDecision({
      allowed,
      reason: allowed
        ? "ROTATION_GATE_ERROR_ALLOW_OPEN"
        : "ROTATION_GATE_ERROR_FAIL_CLOSED",
      signal,
      rotation: null,
      familyIds,
      side,
      error: e
    });

    return {
      allowed,
      reason: decision.reason,
      decision,
      signal: attachDecision
        ? {
            ...signal,
            rotation: decision,
            rotationGate: decision
          }
        : signal
    };
  }
}

export function buildRotationCandidate(signal) {
  const familyIds = extractSignalFamilyIds(signal);
  const side = normalizeSide(signal?.rotationSide || signal?.tradeSide || signal?.side);

  return {
    ...signal,
    rotationSide: side,
    tradeSide: side,
    familyIds,
    families: familyIds,
    microFamilyIds: familyIds,
    microFamilies: familyIds,
    familyId: familyIds[0] || null,
    microFamilyId: familyIds[0] || null
  };
}

export function isTradeSignalAllowedByRotationSync(signal, rotation, options = {}) {
  const requireSideMatch =
    options.requireSideMatch !== undefined
      ? Boolean(options.requireSideMatch)
      : true;

  if (!isActiveRotation(rotation)) {
    return false;
  }

  const familyIds = extractSignalFamilyIds(signal);
  const side = normalizeSide(signal?.rotationSide || signal?.tradeSide || signal?.side);

  if (!familyIds.length) return false;

  return Boolean(
    findRotationMatch({
      rotation,
      familyIds,
      side,
      requireSideMatch
    })
  );
}