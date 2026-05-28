// ================= MICRO ROTATION GATE HELPERS =================
// Shared micro-family builder for TradeSystem, Analyzer and Rotation Gate.
// Doel: exact dezelfde microFamilyId in live entries en analyzer snapshots.

export const MICRO_FAMILY_PREFIX = "MICRO";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeRotationSide(side) {
  const value = String(side || "").toLowerCase();

  if (value === "bull") return "LONG";
  if (value === "bear") return "SHORT";
  if (value === "long") return "LONG";
  if (value === "short") return "SHORT";

  const upper = String(side || "").toUpperCase();
  if (upper === "LONG" || upper === "SHORT") return upper;

  return "LONG";
}

export function normalizeFamilyToken(value, fallback = "NA") {
  const token = String(value || fallback)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return token || fallback;
}

export function bucketRotationValue(value, step, prefix, decimals = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return `${prefix}_NA`;
  }

  const lower = Math.floor(n / step) * step;
  const upper = lower + step;

  const cleanLower = lower
    .toFixed(decimals)
    .replace(".", "P")
    .replace("-", "M");

  const cleanUpper = upper
    .toFixed(decimals)
    .replace(".", "P")
    .replace("-", "M");

  return `${prefix}_${cleanLower}_${cleanUpper}`;
}

export function normalizeSpreadForRotation(spreadPct) {
  let spread = Number(spreadPct || 0);

  if (!Number.isFinite(spread) || spread < 0) return 0;
  if (spread > 0.05) spread = spread / 100;

  return spread;
}

export function getRotationObRelation(side, obBias) {
  const normalizedSide = normalizeRotationSide(side);
  const ob = String(obBias || "NEUTRAL").toUpperCase();

  if (ob === "NEUTRAL" || ob === "UNKNOWN") return "NEUTRAL";

  if (
    (normalizedSide === "LONG" && ob === "BULLISH") ||
    (normalizedSide === "SHORT" && ob === "BEARISH")
  ) {
    return "WITH";
  }

  if (
    (normalizedSide === "LONG" && ob === "BEARISH") ||
    (normalizedSide === "SHORT" && ob === "BULLISH")
  ) {
    return "AGAINST";
  }

  return "NEUTRAL";
}

export function buildMicroFamilyIdFromFeatureRow(row = {}) {
  const rotationSide = normalizeRotationSide(
    row.rotationSide ||
      row.tradeSide ||
      row.side ||
      row.direction
  );

  const setupClass = normalizeFamilyToken(
    row.setupClass ||
      row.oldSetupClass ||
      row.grade ||
      "NONE"
  );

  const entryReason = normalizeFamilyToken(
    row.entryReason ||
      row.reason ||
      row.oldReason ||
      row.entryType ||
      "UNKNOWN"
  );

  const flow = normalizeFamilyToken(
    row.flow ||
      row.scannerFlow ||
      row.detectedFlow ||
      "UNKNOWN"
  );

  const rsiZone = normalizeFamilyToken(
    row.rsiZone ||
      "UNKNOWN"
  );

  const obRelation = normalizeFamilyToken(
    row.obSideRelation ||
      getRotationObRelation(rotationSide, row.obBias)
  );

  const btcState = normalizeFamilyToken(
    row.btcState ||
      "UNKNOWN"
  );

  const regime = normalizeFamilyToken(
    row.regime ||
      row.volatility ||
      "UNKNOWN"
  );

  const confBucket = bucketRotationValue(
    row.confluence ??
      row.effectiveConfluence ??
      row.rawConfluence,
    10,
    "CONF",
    0
  );

  const sniperBucket = bucketRotationValue(
    row.sniperScore ??
      row.sniper,
    10,
    "SNIPER",
    0
  );

  const rrBucket = bucketRotationValue(
    row.plannedRR ??
      row.finalRr ??
      row.effectiveRR ??
      row.rr ??
      row.baseRR,
    0.25,
    "RR",
    2
  );

  return [
    MICRO_FAMILY_PREFIX,
    rotationSide,
    setupClass,
    entryReason,
    flow,
    rsiZone,
    obRelation,
    btcState,
    regime,
    confBucket,
    sniperBucket,
    rrBucket
  ].join("_");
}

export function buildParentFamilyIdFromFeatureRow(row = {}) {
  const rotationSide = normalizeRotationSide(
    row.rotationSide ||
      row.tradeSide ||
      row.side ||
      row.direction
  );

  const setupClass = normalizeFamilyToken(
    row.setupClass ||
      row.oldSetupClass ||
      row.grade ||
      "NONE"
  );

  const entryReason = normalizeFamilyToken(
    row.entryReason ||
      row.reason ||
      row.oldReason ||
      row.entryType ||
      "UNKNOWN"
  );

  return `PARENT_${rotationSide}_${setupClass}_${entryReason}`;
}

function collectStringValues(value, output = []) {
  if (!value) return output;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) output.push(trimmed);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, output);
    }

    return output;
  }

  return output;
}

export function getMicroFamilyCandidates(signal = {}) {
  const candidates = [];

  collectStringValues(signal.microFamilyId, candidates);
  collectStringValues(signal.microFamilyIds, candidates);
  collectStringValues(signal.microFamilies, candidates);

  if (signal.rotationCandidate && typeof signal.rotationCandidate === "object") {
    collectStringValues(signal.rotationCandidate.microFamilyId, candidates);
    collectStringValues(signal.rotationCandidate.microFamilyIds, candidates);
    collectStringValues(signal.rotationCandidate.microFamilies, candidates);
  }

  return Array.from(
    new Set(
      candidates
        .map(item => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

export function attachMicroRotationKeys(signal = {}, context = {}) {
  const btcState = signal.btcState || context.btcState || "UNKNOWN";
  const regime = signal.regime || context.regime || "UNKNOWN";

  const row = {
    ...signal,
    btcState,
    regime
  };

  const generatedMicroFamilyId = buildMicroFamilyIdFromFeatureRow(row);
  const existingMicroFamilyIds = getMicroFamilyCandidates(signal);

  const microFamilyId =
    existingMicroFamilyIds[0] ||
    signal.microFamilyId ||
    generatedMicroFamilyId;

  const rotationSide = normalizeRotationSide(
    signal.rotationSide ||
      signal.tradeSide ||
      signal.side ||
      signal.direction
  );

  const parentFamilyId =
    signal.parentFamilyId ||
    buildParentFamilyIdFromFeatureRow({
      ...row,
      rotationSide
    });

  const microFamilyIds = Array.from(
    new Set([
      microFamilyId,
      ...existingMicroFamilyIds
    ].filter(Boolean))
  );

  const legacyFamilyIds = Array.isArray(signal.familyIds)
    ? signal.familyIds.filter(Boolean)
    : [];

  const familyIds = Array.from(
    new Set([
      microFamilyId,
      ...legacyFamilyIds
    ].filter(Boolean))
  );

  return {
    ...signal,

    rotationSide,
    tradeSide: rotationSide,

    parentFamilyId,

    microFamilyId,
    familyId: microFamilyId,

    microFamilyIds,
    microFamilies: microFamilyIds,

    familyIds,
    families: familyIds,

    rotationCandidate: {
      ...(signal.rotationCandidate || {}),

      ...row,

      side: rotationSide,
      rotationSide,
      tradeSide: rotationSide,

      parentFamilyId,

      microFamilyId,
      familyId: microFamilyId,

      microFamilyIds,
      microFamilies: microFamilyIds,

      familyIds,
      families: familyIds
    }
  };
}

export function isValidMicroFamilyId(value) {
  const id = String(value || "").trim();

  if (!id) return false;

  return id.startsWith(`${MICRO_FAMILY_PREFIX}_`);
}

export default {
  normalizeRotationSide,
  normalizeFamilyToken,
  bucketRotationValue,
  normalizeSpreadForRotation,
  getRotationObRelation,
  buildMicroFamilyIdFromFeatureRow,
  buildParentFamilyIdFromFeatureRow,
  getMicroFamilyCandidates,
  attachMicroRotationKeys,
  isValidMicroFamilyId
};