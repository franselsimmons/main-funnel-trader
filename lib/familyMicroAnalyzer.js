// lib/familyMicroAnalyzer.js

const UNKNOWN = "UNKNOWN";
const DEFAULT_SCHEMA_VERSION = "MF_V4_ANALYZE";
const MAX_ANALYZE_FAMILIES_PER_SIDE = 50;

const MICRO_FAMILY_SCHEMA_VERSION =
  typeof process !== "undefined"
    ? process.env.MICRO_FAMILY_SCHEMA_VERSION || DEFAULT_SCHEMA_VERSION
    : DEFAULT_SCHEMA_VERSION;

const ANALYZE_FAMILY_ID_RE = /^(LONG|SHORT)_([1-9]|[1-4][0-9]|50)$/;
const CORE_MICRO_ID_RE =
  /^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_(?:[1-9]|[1-4][0-9]|50))_([A-Z0-9_]+)_([A-Z0-9]+)$/;

// ================= BASIC HELPERS =================

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, min, max, fallback = min) {
  const n = safeNumber(value, fallback);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cleanToken(value, fallback = UNKNOWN) {
  const raw = String(value ?? "").trim();

  if (!raw) return fallback;

  return (
    raw
      .replace(/\[object object\]/gi, "")
      .replace(/\{.*?\}/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9.%+-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || fallback
  );
}

function normalizeBaseSymbol(raw) {
  return String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function analyzerHashString(value) {
  const text = String(value || "");
  let hash = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return Math.abs(hash >>> 0).toString(36).toUpperCase();
}

function stableBucketIndex(value, max = MAX_ANALYZE_FAMILIES_PER_SIDE) {
  const hash = parseInt(analyzerHashString(value), 36);
  const safeHash = Number.isFinite(hash) ? hash : 0;

  return (safeHash % max) + 1;
}

// ================= NORMALIZERS =================

function normalizeSide(value) {
  const raw = String(value ?? "").toLowerCase();

  if (["long", "bull", "buy", "bullish"].includes(raw)) return "LONG";
  if (["short", "bear", "sell", "bearish"].includes(raw)) return "SHORT";

  const token = cleanToken(value, "");

  if (token === "LONG" || token === "SHORT") return token;
  if (token.startsWith("LONG_")) return "LONG";
  if (token.startsWith("SHORT_")) return "SHORT";
  if (token.startsWith("MICRO_LONG_")) return "LONG";
  if (token.startsWith("MICRO_SHORT_")) return "SHORT";

  return UNKNOWN;
}

function normalizeStage(value) {
  const raw = String(value ?? "").toLowerCase();

  if (raw.includes("exit") || raw === "close") return "EXIT";
  if (raw.includes("almost")) return "ALMOST";
  if (raw.includes("entry") || raw === "open") return "ENTRY";

  return "ENTRY";
}

function normalizeSetupClass(value) {
  const token = cleanToken(value, "B");

  if (token.includes("TREND_PROBE")) return "B_TREND_PROBE";
  if (token === "A" || token.includes("_A_")) return "A";
  if (token === "B" || token.includes("_B_")) return "B";
  if (token === "C" || token.includes("_C_")) return "C";

  return token;
}

function normalizeReason(value, setupClass = "B") {
  const token = cleanToken(value, "");

  if (token) return token;
  if (setupClass === "A") return "A_ENTRY";
  if (setupClass === "B") return "B_ENTRY";
  if (setupClass === "C") return "C_ENTRY";
  if (setupClass === "B_TREND_PROBE") return "MID_TREND_PROBE";

  return "ENTRY";
}

function normalizeRsiEdge(value, rsi, side) {
  const direct = cleanToken(value, "");

  if (
    direct === "RSI_CONTINUATION" ||
    direct === "RSI_AGAINST" ||
    direct === "RSI_NEUTRAL"
  ) {
    return direct;
  }

  const n = Number(rsi);
  if (!Number.isFinite(n)) return "RSI_NEUTRAL";

  if (side === "LONG") {
    if (n >= 55) return "RSI_CONTINUATION";
    if (n <= 45) return "RSI_AGAINST";
    return "RSI_NEUTRAL";
  }

  if (side === "SHORT") {
    if (n <= 45) return "RSI_CONTINUATION";
    if (n >= 55) return "RSI_AGAINST";
    return "RSI_NEUTRAL";
  }

  return "RSI_NEUTRAL";
}

function normalizeRsiBias(value, rsiHTF) {
  const direct = cleanToken(value, "");

  if (["BULLISH", "BEARISH", "NEUTRAL"].includes(direct)) return direct;

  const n = Number(rsiHTF);
  if (!Number.isFinite(n)) return "NEUTRAL";

  if (n >= 57) return "BULLISH";
  if (n <= 43) return "BEARISH";

  return "NEUTRAL";
}

// ================= CANONICAL FAMILY IDS =================

export function normalizeAnalyzeFamilyId(raw) {
  const token = cleanToken(raw, "");

  if (ANALYZE_FAMILY_ID_RE.test(token)) return token;

  const microMatch = token.match(CORE_MICRO_ID_RE);
  if (microMatch?.[2] && ANALYZE_FAMILY_ID_RE.test(microMatch[2])) {
    return microMatch[2];
  }

  return null;
}

export function extractParentFamilyIdFromMicroId(raw) {
  const token = cleanToken(raw, "");
  const match = token.match(CORE_MICRO_ID_RE);

  return normalizeAnalyzeFamilyId(match?.[2]) || null;
}

export function buildCoreMicroFamilyId(parentFamilyId) {
  const analyzeFamilyId = normalizeAnalyzeFamilyId(parentFamilyId);

  if (!analyzeFamilyId) return null;

  const side = analyzeFamilyId.startsWith("LONG_") ? "LONG" : "SHORT";
  const definition = `${MICRO_FAMILY_SCHEMA_VERSION} | ${analyzeFamilyId}`;
  const hash = analyzerHashString(definition).slice(0, 8);

  return `MICRO_${side}_${analyzeFamilyId}_${MICRO_FAMILY_SCHEMA_VERSION}_${hash}`;
}

function buildLegacyMicroFamilyId({
  side,
  setupClass,
  scannerStage,
  reason,
  rsiEdge,
  rsiBias
} = {}) {
  return [
    "MF",
    cleanToken(side),
    cleanToken(setupClass),
    cleanToken(scannerStage),
    cleanToken(reason),
    cleanToken(rsiEdge),
    cleanToken(rsiBias)
  ].join("_");
}

function inferExplicitAnalyzeFamilyId(event = {}) {
  return (
    normalizeAnalyzeFamilyId(event.analyzeFamilyId) ||
    normalizeAnalyzeFamilyId(event.analysisFamilyId) ||
    normalizeAnalyzeFamilyId(event.parentFamilyId) ||
    normalizeAnalyzeFamilyId(event.familyId) ||
    normalizeAnalyzeFamilyId(event.mainFamilyId) ||
    normalizeAnalyzeFamilyId(event.rotationCandidate?.analyzeFamilyId) ||
    normalizeAnalyzeFamilyId(event.rotationCandidate?.analysisFamilyId) ||
    normalizeAnalyzeFamilyId(event.rotationCandidate?.parentFamilyId) ||
    normalizeAnalyzeFamilyId(event.rotationCandidate?.familyId) ||
    extractParentFamilyIdFromMicroId(event.microFamilyId) ||
    extractParentFamilyIdFromMicroId(event.rotationMicroFamilyId) ||
    extractParentFamilyIdFromMicroId(event.analyzerMicroFamilyId) ||
    extractParentFamilyIdFromMicroId(event.rotationCandidate?.microFamilyId) ||
    extractParentFamilyIdFromMicroId(event.rotationCandidate?.rotationMicroFamilyId) ||
    extractParentFamilyIdFromMicroId(event.rotationCandidate?.analyzerMicroFamilyId) ||
    null
  );
}

function inferFamilyIndex(event = {}, fingerprint) {
  const direct =
    event.familyIndex ??
    event.familyRank ??
    event.analyzeFamilyIndex ??
    event.analysisFamilyIndex ??
    event.parentFamilyIndex ??
    event.rotationCandidate?.familyIndex ??
    event.rotationCandidate?.familyRank;

  const directIndex = Number(direct);

  if (Number.isFinite(directIndex) && directIndex >= 1 && directIndex <= 50) {
    return clampNumber(directIndex, 1, 50, 1);
  }

  return stableBucketIndex(fingerprint, MAX_ANALYZE_FAMILIES_PER_SIDE);
}

function buildAnalyzeFingerprint({
  side,
  setupClass,
  scannerStage,
  reason,
  rsiEdge,
  rsiBias,
  volatilityRegime,
  marketRegime,
  liquidityRegime,
  structureRegime
}) {
  return [
    MICRO_FAMILY_SCHEMA_VERSION,
    side,
    setupClass,
    scannerStage,
    reason,
    rsiEdge,
    rsiBias,
    volatilityRegime,
    marketRegime,
    liquidityRegime,
    structureRegime
  ]
    .map(value => cleanToken(value, "NA"))
    .join("|");
}

export function buildAnalyzeFamilyId({
  side,
  setupClass,
  scannerStage,
  reason,
  rsiEdge,
  rsiBias,
  volatilityRegime,
  marketRegime,
  liquidityRegime,
  structureRegime,
  familyId,
  analyzeFamilyId,
  analysisFamilyId,
  parentFamilyId,
  familyIndex,
  familyRank
} = {}) {
  const explicit =
    normalizeAnalyzeFamilyId(analyzeFamilyId) ||
    normalizeAnalyzeFamilyId(analysisFamilyId) ||
    normalizeAnalyzeFamilyId(parentFamilyId) ||
    normalizeAnalyzeFamilyId(familyId);

  if (explicit) return explicit;

  const normalizedSide = normalizeSide(side);
  if (normalizedSide === UNKNOWN) return null;

  const fingerprint = buildAnalyzeFingerprint({
    side: normalizedSide,
    setupClass,
    scannerStage,
    reason,
    rsiEdge,
    rsiBias,
    volatilityRegime,
    marketRegime,
    liquidityRegime,
    structureRegime
  });

  const index = inferFamilyIndex(
    {
      familyIndex,
      familyRank
    },
    fingerprint
  );

  return `${normalizedSide}_${index}`;
}

export function buildMicroFamilyId(input = {}) {
  const parentFamilyId = buildAnalyzeFamilyId(input);

  return buildCoreMicroFamilyId(parentFamilyId);
}

export function buildRotationId({ weekKey, side, setupClass, familyId } = {}) {
  const canonicalFamilyId = normalizeAnalyzeFamilyId(familyId);

  if (canonicalFamilyId) {
    return `ROT_${cleanToken(weekKey || "NO_WEEK")}_${canonicalFamilyId}`;
  }

  return `ROT_${cleanToken(weekKey || "NO_WEEK")}_${cleanToken(side)}_${cleanToken(
    setupClass
  )}`;
}

// ================= MAIN CLASSIFIER =================

export function classifyAnalyzeEvent(event = {}, opts = {}) {
  const weekKey =
    opts.weekKey ||
    event.weekKey ||
    event.activeWeekKey ||
    event.rotationCandidate?.weekKey ||
    null;

  const explicitFamilyId = inferExplicitAnalyzeFamilyId(event);

  const side = normalizeSide(
    explicitFamilyId ||
      event.side ??
      event.direction ??
      event.tradeSide ??
      event.signalSide ??
      event.bias
  );

  const scannerStage = normalizeStage(
    event.scannerStage ??
      event.stage ??
      event.actionType ??
      event.action ??
      event.type
  );

  const setupClass = normalizeSetupClass(
    event.setupClass ??
      event.class ??
      event.entryClass ??
      event.signalClass
  );

  const reason = normalizeReason(
    event.reason ??
      event.entryReason ??
      event.signalReason ??
      event.waitReason,
    setupClass
  );

  const rsi = event.rsi ?? event.rsiValue ?? event.rsi14 ?? event.rsiLtf;
  const rsiHTF = event.rsiHTF ?? event.htfRsi ?? event.rsiHigherTimeframe ?? rsi;

  const rsiEdge = normalizeRsiEdge(
    event.rsiEdge ?? event.microRsiEdge ?? event.rsiSignal,
    rsi,
    side
  );

  const rsiBias = normalizeRsiBias(
    event.rsiBias ?? event.rsiHTFBias ?? event.htfBias,
    rsiHTF
  );

  const volatilityRegime = cleanToken(
    event.volatilityRegime ?? event.volRegime ?? event.volatility ?? "NA",
    "NA"
  );

  const marketRegime = cleanToken(
    event.marketRegime ?? event.regime ?? event.marketContext?.regime ?? "NA",
    "NA"
  );

  const liquidityRegime = cleanToken(
    event.liquidityRegime ?? event.liquidityState ?? event.liquidity?.regime ?? "NA",
    "NA"
  );

  const structureRegime = cleanToken(
    event.structureRegime ?? event.structureState ?? event.structure?.regime ?? "NA",
    "NA"
  );

  const fingerprint = buildAnalyzeFingerprint({
    side,
    setupClass,
    scannerStage,
    reason,
    rsiEdge,
    rsiBias,
    volatilityRegime,
    marketRegime,
    liquidityRegime,
    structureRegime
  });

  const parentFamilyId =
    explicitFamilyId ||
    buildAnalyzeFamilyId({
      side,
      setupClass,
      scannerStage,
      reason,
      rsiEdge,
      rsiBias,
      volatilityRegime,
      marketRegime,
      liquidityRegime,
      structureRegime,
      familyIndex:
        opts.familyIndex ??
        event.familyIndex ??
        event.familyRank ??
        event.analyzeFamilyIndex ??
        event.analysisFamilyIndex
    });

  const microFamilyId = buildCoreMicroFamilyId(parentFamilyId);

  const legacyMicroFamilyId = buildLegacyMicroFamilyId({
    side,
    setupClass,
    scannerStage,
    reason,
    rsiEdge,
    rsiBias
  });

  const rotationId = buildRotationId({
    weekKey: weekKey || "NO_WEEK",
    side,
    setupClass,
    familyId: parentFamilyId
  });

  const symbol = event.symbol ?? event.baseCoin ?? event.instId ?? null;
  const normalizedSymbol = symbol ? normalizeBaseSymbol(symbol) : null;

  const familyIds = parentFamilyId ? [parentFamilyId] : [];
  const microFamilyIds = microFamilyId ? [microFamilyId] : [];

  return {
    ok: side !== UNKNOWN && Boolean(parentFamilyId) && Boolean(microFamilyId),

    side,
    tradeSide: side,
    rotationSide: side,

    scannerStage,
    setupClass,
    reason,

    rsiEdge,
    rsiBias,

    volatilityRegime,
    marketRegime,
    liquidityRegime,
    structureRegime,

    symbol: normalizedSymbol,

    // Canonical analyze family contract.
    familyId: parentFamilyId,
    familyIds,
    parentFamilyId,
    analyzeFamilyId: parentFamilyId,
    analysisFamilyId: parentFamilyId,
    analyzerParentFamilyId: parentFamilyId,

    // Canonical micro rotation contract.
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
    microFamilyId,
    microFamily: microFamilyId,
    microFamilyIds,
    microFamilies: microFamilyIds,
    rotationMicroFamilyId: microFamilyId,
    analyzerMicroFamilyId: microFamilyId,

    // Backward-compatible descriptor only. Niet gebruiken als rotation key.
    legacyMicroFamilyId,

    rotationId,
    weekKey,

    fingerprint,
    familyFingerprint: fingerprint,

    rotationCandidate: {
      symbol: normalizedSymbol,

      side,
      tradeSide: side,
      rotationSide: side,

      familyId: parentFamilyId,
      familyIds,
      parentFamilyId,
      analyzeFamilyId: parentFamilyId,
      analysisFamilyId: parentFamilyId,
      analyzerParentFamilyId: parentFamilyId,

      microFamilyId,
      microFamilyIds,
      microFamilies: microFamilyIds,
      rotationMicroFamilyId: microFamilyId,
      analyzerMicroFamilyId: microFamilyId,

      weekKey,
      rotationId
    }
  };
}

export default classifyAnalyzeEvent;