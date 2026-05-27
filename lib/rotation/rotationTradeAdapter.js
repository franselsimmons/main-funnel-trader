import { loadActiveRotation } from "./rotationStore.js";

const LIVE_ROTATION_STATUSES = new Set([
  "ACTIVE",
  "READY",
  "READY_FROM_ANALYZER"
]);

const DEFAULT_LIVE_ALLOWLIST_STATUSES = [
  "ACTIVE",
  "READY",
  "ELITE",
  "HOT",
  "GOOD",
  "STABLE"
];

const BLOCKED_ALLOWLIST_STATUSES = new Set([
  "BAD",
  "EMPTY",
  "DISABLED",
  "INACTIVE",
  "BLOCKED",
  "DELETED"
]);

function envBool(key, fallback = false) {
  const value = process.env[key];

  if (value === undefined || value === null || value === "") return fallback;

  return ["1", "true", "yes", "y", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

function envText(key, fallback = "") {
  const value = process.env[key];

  if (value === undefined || value === null || value === "") return fallback;

  return String(value).trim();
}

function envList(key, fallback = []) {
  const value = process.env[key];

  if (!value) return fallback;

  return String(value)
    .split(",")
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
}

export function normalizeRotationSide(side, fallback = "") {
  const value = String(side || fallback || "").trim().toUpperCase();

  if (["LONG", "BULL", "BUY"].includes(value)) return "LONG";
  if (["SHORT", "BEAR", "SELL"].includes(value)) return "SHORT";

  return "";
}

function normalizeSide(side) {
  return normalizeRotationSide(side);
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      values
        .flat(Infinity)
        .map(value => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function extractSignalFamilyIds(signal = {}) {
  return uniqueStrings([
    Array.isArray(signal.microFamilyIds) ? signal.microFamilyIds : [],
    Array.isArray(signal.familyIds) ? signal.familyIds : [],
    Array.isArray(signal.microFamilies) ? signal.microFamilies : [],
    Array.isArray(signal.families) ? signal.families : [],

    signal.microFamilyId,
    signal.familyId,
    signal.analyzeFamilyId,
    signal.frozenFamilyId,
    signal.frozenMicroFamilyId,

    signal.filterSnapshot?.microFamilyId,
    signal.filterSnapshot?.familyId,
    signal.filterSnapshot?.analyzeFamilyId,

    signal.rotationCandidate?.microFamilyId,
    signal.rotationCandidate?.familyId,
    signal.rotationCandidate?.analyzeFamilyId,

    Array.isArray(signal.rotationCandidate?.microFamilyIds)
      ? signal.rotationCandidate.microFamilyIds
      : [],

    Array.isArray(signal.rotationCandidate?.familyIds)
      ? signal.rotationCandidate.familyIds
      : []
  ]);
}

function extractItemFamilyIds(item = {}) {
  return uniqueStrings([
    item.microFamilyId,
    item.familyId,
    item.parentFamilyId,
    item.parentFamily,
    item.parent,
    item.family,
    item.id,
    item.key,
    item.name
  ]);
}

function inferSideFromId(value) {
  const id = String(value || "").toUpperCase();

  if (id.includes("SHORT")) return "SHORT";
  if (id.includes("LONG")) return "LONG";

  return "";
}

function normalizeAllowlistItem(item = {}) {
  const rawItem = typeof item === "string" ? { microFamilyId: item } : item || {};

  const ids = extractItemFamilyIds(rawItem);
  const primaryId = String(
    rawItem.microFamilyId ||
      rawItem.familyId ||
      rawItem.family ||
      rawItem.id ||
      rawItem.key ||
      rawItem.name ||
      ids[0] ||
      ""
  ).trim();

  const side =
    normalizeSide(rawItem.side || rawItem.tradeSide || rawItem.rotationSide) ||
    inferSideFromId(primaryId);

  return {
    ...rawItem,

    side,
    tradeSide: side,
    rotationSide: side,

    microFamilyId: String(rawItem.microFamilyId || primaryId || "").trim(),
    familyId: String(rawItem.familyId || rawItem.microFamilyId || primaryId || "").trim(),
    parentFamilyId: rawItem.parentFamilyId || rawItem.parentFamily || rawItem.parent || null,

    status: String(rawItem.status || "ACTIVE").trim().toUpperCase(),

    _ids: ids
  };
}

function normalizeAllowlist(rotation) {
  if (!rotation || !Array.isArray(rotation.allowlist)) return [];

  return rotation.allowlist
    .filter(Boolean)
    .map(normalizeAllowlistItem)
    .filter(item => item.microFamilyId || item.familyId || item._ids.length);
}

function getAcceptedAllowlistStatuses() {
  return new Set(
    envList("WEEKLY_ROTATION_ACCEPT_STATUSES", DEFAULT_LIVE_ALLOWLIST_STATUSES)
  );
}

function isAllowlistStatusLive(status) {
  const normalized = String(status || "").trim().toUpperCase();

  if (!normalized) return false;
  if (BLOCKED_ALLOWLIST_STATUSES.has(normalized)) return false;

  const acceptedStatuses = getAcceptedAllowlistStatuses();

  return acceptedStatuses.has(normalized);
}

function isActiveRotation(rotation) {
  if (!rotation || typeof rotation !== "object") return false;

  const status = String(rotation.status || "").trim().toUpperCase();

  if (!LIVE_ROTATION_STATUSES.has(status)) {
    return false;
  }

  return normalizeAllowlist(rotation).some(item => isAllowlistStatusLive(item.status));
}

function findRotationMatch({ rotation, familyIds, side, requireSideMatch }) {
  const allowlist = normalizeAllowlist(rotation);
  const idSet = new Set(familyIds.map(value => String(value || "").trim()).filter(Boolean));

  for (const item of allowlist) {
    if (!isAllowlistStatusLive(item.status)) continue;

    const ids = extractItemFamilyIds(item);
    const idMatch = ids.some(id => idSet.has(id));

    if (!idMatch) continue;

    if (requireSideMatch && side && item.side && item.side !== side) {
      continue;
    }

    if (requireSideMatch && !side) {
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
    source: rotation?.source || null,
    sourceWindow: rotation?.sourceWindow || null,

    signalSide: side || null,
    requiredSide: side || null,

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
    entryReason:
      signal?.reason ||
      signal?.entryReason ||
      signal?.entryType ||
      signal?.action ||
      null,

    error: error ? String(error.message || error) : null,
    ts: Date.now()
  };
}

function attachRotationDecision(signal, decision, attachDecision) {
  if (!attachDecision) return signal;

  return {
    ...signal,
    rotation: decision,
    rotationGate: decision
  };
}

function buildAllowedResponse({ signal, decision, attachDecision }) {
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    decision,
    signal: attachRotationDecision(signal, decision, attachDecision)
  };
}

export async function loadActiveRotationStatus() {
  return loadActiveRotation();
}

export async function checkTradeSignalAgainstRotation(signal, options = {}) {
  const logger = options.logger || console;

  const enabled =
    options.enabled !== undefined
      ? Boolean(options.enabled)
      : envBool("WEEKLY_ROTATION_LIVE_GATE", true);

  const requireSideMatch =
    options.requireSideMatch !== undefined
      ? Boolean(options.requireSideMatch)
      : envBool("WEEKLY_ROTATION_REQUIRE_SIDE_MATCH", true);

  const emptyPolicy = envText("WEEKLY_ROTATION_EMPTY_POLICY", "DENY_ALL").toUpperCase();

  const allowWhenNoRotation =
    options.allowWhenNoRotation !== undefined
      ? Boolean(options.allowWhenNoRotation)
      : emptyPolicy !== "DENY_ALL";

  const failClosed =
    options.failClosed !== undefined
      ? Boolean(options.failClosed)
      : envBool("WEEKLY_ROTATION_FAIL_CLOSED", true);

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

    return buildAllowedResponse({ signal, decision, attachDecision });
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

      return buildAllowedResponse({ signal, decision, attachDecision });
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

      return buildAllowedResponse({ signal, decision, attachDecision });
    }

    if (requireSideMatch && !side) {
      const decision = buildDecision({
        allowed: false,
        reason: "SIGNAL_SIDE_MISSING",
        signal,
        rotation,
        familyIds,
        side
      });

      return buildAllowedResponse({ signal, decision, attachDecision });
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

      return buildAllowedResponse({ signal, decision, attachDecision });
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

    const patchedSignal = attachDecision
      ? {
          ...signal,

          rotation: decision,
          rotationGate: decision,

          rotationSide: side,
          tradeSide: side,

          matchedRotationFamilyId: decision.matchedFamilyId,
          matchedRotationMicroFamilyId: decision.matchedMicroFamilyId,
          activeRotationId: decision.activeRotationId
        }
      : signal;

    return {
      allowed: true,
      reason: decision.reason,
      decision,
      signal: patchedSignal
    };
  } catch (error) {
    logger?.error?.("[rotationTradeAdapter] rotation gate error", error);

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
      error
    });

    return buildAllowedResponse({ signal, decision, attachDecision });
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
  if (requireSideMatch && !side) return false;

  return Boolean(
    findRotationMatch({
      rotation,
      familyIds,
      side,
      requireSideMatch
    })
  );
}

export function getTradeSignalRotationDebug(signal, rotation) {
  const familyIds = extractSignalFamilyIds(signal);
  const side = normalizeSide(signal?.rotationSide || signal?.tradeSide || signal?.side);
  const allowlist = normalizeAllowlist(rotation);

  const matchedItem = findRotationMatch({
    rotation,
    familyIds,
    side,
    requireSideMatch: envBool("WEEKLY_ROTATION_REQUIRE_SIDE_MATCH", true)
  });

  return buildDecision({
    allowed: Boolean(matchedItem),
    reason: matchedItem
      ? "MICRO_FAMILY_ACTIVE_IN_WEEKLY_ROTATION"
      : "MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",
    signal,
    rotation,
    familyIds,
    side,
    matchedItem
  });
}

export default {
  loadActiveRotationStatus,
  checkTradeSignalAgainstRotation,
  buildRotationCandidate,
  isTradeSignalAllowedByRotationSync,
  getTradeSignalRotationDebug,
  normalizeRotationSide
};