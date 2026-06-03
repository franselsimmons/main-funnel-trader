// lib/tradesystem/microRotationGate.js

import * as liveGateModule from "../rotation/liveGate.js";

// ================= CONFIG =================

const MICRO_FAMILY_SCHEMA_VERSION =
  typeof process !== "undefined"
    ? process.env.MICRO_FAMILY_SCHEMA_VERSION || "MF_V4_ANALYZE"
    : "MF_V4_ANALYZE";

const MICRO_ROTATION_STRICT_ENTRY_GATE =
  String(
    typeof process !== "undefined"
      ? process.env.TS_MICRO_ROTATION_STRICT_ENTRY_GATE ??
          process.env.TS_MICRO_ROTATION_STRICT_GATE ??
          process.env.MICRO_ROTATION_STRICT_ENTRY_GATE ??
          "true"
      : "true"
  ).toLowerCase() !== "false";

const MICRO_ROTATION_ALLOW_EMPTY_BOOTSTRAP =
  String(
    typeof process !== "undefined"
      ? process.env.TS_MICRO_ROTATION_ALLOW_EMPTY_BOOTSTRAP ??
          process.env.MICRO_ROTATION_ALLOW_EMPTY_BOOTSTRAP ??
          "false"
      : "false"
  ).toLowerCase() === "true";

const MICRO_ROTATION_PARENT_FALLBACK = false;

const DEFAULT_MAX_FAMILY_IDS_CHECKED = Number(
  typeof process !== "undefined"
    ? process.env.MICRO_LEARNING_MAX_FAMILIES_PER_ROW || 1
    : 1
);

const ANALYZE_FAMILY_ID_RE = /^(LONG|SHORT)_([1-9]|[1-4][0-9]|50)$/;

const CORE_MICRO_ID_RE =
  /^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_(?:[1-9]|[1-4][0-9]|50))_([A-Z0-9_]+)_([A-Z0-9]+)$/;

// ================= BASIC HELPERS =================

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function flattenValues(values = []) {
  return values.flat(Infinity).filter(value => value !== undefined && value !== null);
}

function uniq(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanToken(value, fallback = "") {
  const raw = String(value ?? "").trim();

  if (!raw) return fallback;

  return (
    raw
      .replace(/\[object object\]/gi, "")
      .replace(/\{.*?\}/g, "")
      .replace(/[^A-Z0-9.%+-]+/gi, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || fallback
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

function inferTradeSide(signal = {}) {
  const raw = String(
    signal.tradeSide ||
      signal.rotationSide ||
      signal.side ||
      signal.direction ||
      signal.actionSide ||
      ""
  ).toLowerCase();

  if (["long", "bull", "buy", "bullish"].includes(raw)) return "LONG";
  if (["short", "bear", "sell", "bearish"].includes(raw)) return "SHORT";

  const token = cleanToken(raw);

  if (token === "LONG" || token === "SHORT") return token;

  return "UNKNOWN";
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

function getMicroSide(microFamilyId) {
  const id = cleanToken(microFamilyId);

  if (id.startsWith("MICRO_LONG_")) return "LONG";
  if (id.startsWith("MICRO_SHORT_")) return "SHORT";

  return null;
}

function isEntryCandidate(action = {}) {
  const type = String(
    action.type ??
      action.action ??
      action.actionType ??
      action.entryType ??
      ""
  ).toUpperCase();

  const stage = String(
    action.stage ??
      action.scannerStage ??
      action.entryStage ??
      ""
  ).toUpperCase();

  if (type.includes("EXIT") || type.includes("HOLD")) return false;
  if (stage.includes("EXIT")) return false;

  return true;
}

// ================= ANALYZE / MICRO ID NORMALIZATION =================

export function normalizeAnalyzeFamilyId(raw) {
  const direct = cleanToken(raw);

  if (ANALYZE_FAMILY_ID_RE.test(direct)) {
    return direct;
  }

  const fromMicro = extractParentFamilyIdFromMicroId(direct);

  if (ANALYZE_FAMILY_ID_RE.test(fromMicro || "")) {
    return fromMicro;
  }

  return null;
}

export function buildCoreMicroIdFromAnalyzeFamilyId(familyId) {
  const analyzeFamilyId = normalizeAnalyzeFamilyId(familyId);

  if (!analyzeFamilyId) return null;

  const side = analyzeFamilyId.startsWith("LONG_") ? "LONG" : "SHORT";
  const definition = `${MICRO_FAMILY_SCHEMA_VERSION} | ${analyzeFamilyId}`;
  const hash = analyzerHashString(definition).slice(0, 8);

  return `MICRO_${side}_${analyzeFamilyId}_${MICRO_FAMILY_SCHEMA_VERSION}_${hash}`;
}

export function normalizeMicroFamilyId(raw) {
  const value = cleanToken(raw);

  if (!value) return null;
  if (!value.startsWith("MICRO_")) return null;
  if (value.includes("UNKNOWN")) return null;

  return value;
}

export function extractParentFamilyIdFromMicroId(raw) {
  const id = normalizeMicroFamilyId(raw);

  if (!id) return null;

  const match = id.match(/^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_\d{1,3})_/);

  return normalizeAnalyzeFamilyId(match?.[2]) || null;
}

export function isCoreMicroFamilyId(raw) {
  const id = normalizeMicroFamilyId(raw);

  if (!id) return false;
  if (!CORE_MICRO_ID_RE.test(id)) return false;
  if (!id.includes(`_${MICRO_FAMILY_SCHEMA_VERSION}_`)) return false;

  return Boolean(normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(id)));
}

export function normalizeRotationMicroId(raw) {
  const microId = normalizeMicroFamilyId(raw);

  if (microId && isCoreMicroFamilyId(microId)) {
    return microId;
  }

  const parentFromMicro = extractParentFamilyIdFromMicroId(microId);
  if (parentFromMicro) {
    return buildCoreMicroIdFromAnalyzeFamilyId(parentFromMicro);
  }

  const analyzeFamilyId = normalizeAnalyzeFamilyId(raw);
  if (analyzeFamilyId) {
    return buildCoreMicroIdFromAnalyzeFamilyId(analyzeFamilyId);
  }

  return null;
}

function uniqMicroIds(values = []) {
  return uniq(
    flattenValues(values)
      .map(normalizeMicroFamilyId)
      .filter(Boolean)
  );
}

function uniqCoreMicroIds(values = []) {
  return uniq(
    flattenValues(values)
      .map(normalizeRotationMicroId)
      .filter(Boolean)
      .filter(isCoreMicroFamilyId)
  );
}

function uniqAnalyzeFamilyIds(values = []) {
  return uniq(
    flattenValues(values)
      .map(normalizeAnalyzeFamilyId)
      .filter(Boolean)
  );
}

function isAnalyzeSideCompatible(analyzeFamilyId, tradeSide) {
  if (!analyzeFamilyId) return false;
  if (tradeSide === "UNKNOWN") return true;

  if (tradeSide === "LONG") return analyzeFamilyId.startsWith("LONG_");
  if (tradeSide === "SHORT") return analyzeFamilyId.startsWith("SHORT_");

  return false;
}

function isMicroSideCompatible(microFamilyId, tradeSide) {
  if (!microFamilyId) return false;
  if (tradeSide === "UNKNOWN") return true;

  return getMicroSide(microFamilyId) === tradeSide;
}

// ================= SIGNAL ID EXTRACTION =================

function getNestedValue(object, path) {
  if (!object || !path) return null;

  return String(path)
    .split(".")
    .reduce((current, key) => {
      if (!current || typeof current !== "object") return null;
      return current[key];
    }, object);
}

const MICRO_SIGNAL_PATHS = [
  "microFamilyId",
  "microFamily",
  "microfamilyId",
  "microfamily",
  "rotationMicroFamilyId",
  "analyzerMicroFamilyId",
  "scannerMicroFamilyId",

  "meta.microFamilyId",
  "meta.microfamilyId",

  "scanner.microFamilyId",
  "scanner.microfamilyId",
  "scannerMeta.microFamilyId",
  "scannerMeta.microfamilyId",

  "analysis.microFamilyId",
  "analysis.microfamilyId",

  "family.microFamilyId",
  "family.microfamilyId",

  "micro.id",
  "micro.familyId",
  "micro.microFamilyId",

  "rotationCandidate.microFamilyId",
  "rotationCandidate.rotationMicroFamilyId",
  "rotationCandidate.analyzerMicroFamilyId"
];

const ANALYZE_SIGNAL_PATHS = [
  "analyzeFamilyId",
  "analysisFamilyId",
  "parentFamilyId",
  "analyzerParentFamilyId",
  "mainFamilyId",
  "familyId",

  "filterSnapshot.familyId",
  "filterSnapshot.analyzeFamilyId",
  "filterSnapshot.analysisFamilyId",

  "entryEvent.familyId",
  "entryEvent.analyzeFamilyId",
  "entryEvent.analysisFamilyId",
  "entryEvent.filterSnapshot.familyId",
  "entryEvent.filterSnapshot.analyzeFamilyId",

  "rotationCandidate.familyId",
  "rotationCandidate.parentFamilyId",
  "rotationCandidate.analyzeFamilyId",
  "rotationCandidate.analysisFamilyId"
];

function extractAnalyzeFamilyIdFromSignal(signal = {}) {
  const directCandidates = [
    signal.analyzeFamilyId,
    signal.analysisFamilyId,
    signal.parentFamilyId,
    signal.analyzerParentFamilyId,
    signal.mainFamilyId,
    signal.familyId,
    signal.familyIds,
    signal.families
  ];

  for (const path of ANALYZE_SIGNAL_PATHS) {
    directCandidates.push(getNestedValue(signal, path));
  }

  const direct = uniqAnalyzeFamilyIds(directCandidates)[0];

  if (direct) return direct;

  const microCandidates = [
    signal.microFamilyId,
    signal.microFamily,
    signal.rotationMicroFamilyId,
    signal.analyzerMicroFamilyId,
    signal.microFamilyIds,
    signal.microFamilies,
    signal.rotationCandidate?.microFamilyId,
    signal.rotationCandidate?.rotationMicroFamilyId,
    signal.rotationCandidate?.analyzerMicroFamilyId,
    signal.rotationCandidate?.microFamilyIds,
    signal.rotationCandidate?.microFamilies
  ];

  for (const path of MICRO_SIGNAL_PATHS) {
    microCandidates.push(getNestedValue(signal, path));
  }

  const coreMicro = uniqMicroIds(microCandidates).find(id => {
    return normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(id));
  });

  return normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(coreMicro)) || null;
}

function getSignalCoreMicroFamilyIds(
  signal = {},
  maxFamilyIdsChecked = DEFAULT_MAX_FAMILY_IDS_CHECKED
) {
  const explicitMicroValues = [
    signal.rotationMicroFamilyId,
    signal.analyzerMicroFamilyId,
    signal.microFamilyId,
    signal.microFamily,
    signal.microFamilyIds,
    signal.microFamilies,
    signal.rotationCandidate?.rotationMicroFamilyId,
    signal.rotationCandidate?.analyzerMicroFamilyId,
    signal.rotationCandidate?.microFamilyId,
    signal.rotationCandidate?.microFamilyIds,
    signal.rotationCandidate?.microFamilies
  ];

  for (const path of MICRO_SIGNAL_PATHS) {
    explicitMicroValues.push(getNestedValue(signal, path));
  }

  const explicitCore = uniqCoreMicroIds(explicitMicroValues);

  if (explicitCore.length) {
    return explicitCore.slice(0, Math.max(1, Number(maxFamilyIdsChecked || 1)));
  }

  const analyzeFamilyId = extractAnalyzeFamilyIdFromSignal(signal);
  const core = buildCoreMicroIdFromAnalyzeFamilyId(analyzeFamilyId);

  return core
    ? [core].slice(0, Math.max(1, Number(maxFamilyIdsChecked || 1)))
    : [];
}

// ================= ROTATION ID EXTRACTION =================

function getRotationSources(rotation = {}) {
  if (!rotation || typeof rotation !== "object") return [];

  return [
    rotation,

    rotation.gate,
    rotation.status,
    rotation.activeWeek,
    rotation.nextWeek,

    rotation.activeRotation,
    rotation.weeklyRotation,
    rotation.rotation,
    rotation.rotationState,
    rotation.current,
    rotation.currentRotation,
    rotation.selectedRotation,

    rotation.data,
    rotation.result,
    rotation.payload,
    rotation.decision
  ].filter(source => source && typeof source === "object");
}

function getFirstDefinedRotationValue(rotation, keys = []) {
  const sources = getRotationSources(rotation);

  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) {
        return source[key];
      }
    }
  }

  return null;
}

function isRotationDisabledOrUnusable(rotation = {}) {
  if (!rotation || typeof rotation !== "object") return false;

  const enabled = getFirstDefinedRotationValue(rotation, ["enabled"]);
  const gateEnabled = getFirstDefinedRotationValue(rotation, ["gateEnabled"]);
  const usable = getFirstDefinedRotationValue(rotation, ["usable"]);

  return enabled === false || gateEnabled === false || usable === false;
}

export function extractRotationMicroFamilyIds(rotation = {}, side = null) {
  if (!rotation || typeof rotation !== "object") return [];

  const values = [];
  const sources = getRotationSources(rotation);

  for (const source of sources) {
    values.push(
      source.selectedMicroFamilyIds,
      source.selectedLongMicroFamilyIds,
      source.selectedShortMicroFamilyIds,

      source.microFamilyIds,
      source.activeMicroFamilyIds,
      source.allowedMicroFamilyIds,
      source.realActiveMicroFamilyIds,

      source.familyIds,
      source.activeFamilyIds,
      source.allowedFamilyIds,

      source.allowlist,
      source.active
    );

    const familyRows = [
      ...safeArray(source.longFamilies),
      ...safeArray(source.shortFamilies),
      ...safeArray(source.families),
      ...safeArray(source.selectedFamilies),
      ...safeArray(source.selectedLongFamilies),
      ...safeArray(source.selectedShortFamilies),
      ...safeArray(source.rows)
    ];

    for (const row of familyRows) {
      values.push(
        row?.familyId,
        row?.parentFamilyId,
        row?.analyzeFamilyId,
        row?.analysisFamilyId,
        row?.microFamilyId,
        row?.analyzerMicroFamilyId,
        row?.rotationMicroFamilyId,
        row?.id,
        row?.key
      );
    }

    if (source.selectedFamilyMap && typeof source.selectedFamilyMap === "object") {
      values.push(Object.keys(source.selectedFamilyMap));
    }

    if (source.familyMap && typeof source.familyMap === "object") {
      values.push(Object.keys(source.familyMap));
    }
  }

  const allIds = uniqCoreMicroIds(values);

  if (side !== "LONG" && side !== "SHORT") {
    return allIds;
  }

  return allIds.filter(id => getMicroSide(id) === side);
}

function getRotationMeta(rotation = {}) {
  return {
    rotationId:
      getFirstDefinedRotationValue(rotation, ["rotationId", "activeRotationId", "id"]) || null,

    activeRotationId:
      getFirstDefinedRotationValue(rotation, ["activeRotationId", "rotationId", "id"]) || null,

    weekKey:
      getFirstDefinedRotationValue(rotation, [
        "weekKey",
        "activeWeekKey",
        "targetWeekKey",
        "sourceWeekKey"
      ]) || null,

    source:
      getFirstDefinedRotationValue(rotation, ["source", "mode", "rotationSource"]) || null,

    bootstrap: Boolean(
      getFirstDefinedRotationValue(rotation, ["bootstrap", "isBootstrap"])
    ),

    rankingMode:
      getFirstDefinedRotationValue(rotation, ["rankingMode", "rankingMetric"]) || null
  };
}

function selectRotationInput(options = {}) {
  return (
    options.weeklyRotation ||
    options.rotation ||
    options.rotationState ||
    options.activeRotation ||
    options.currentRotation ||
    options.selectedRotation ||
    null
  );
}

// ================= QUALITY GATE =================

function getSignalScore(signal = {}) {
  return safeNumber(
    signal.entryScore ??
      signal.finalScore ??
      signal.score ??
      signal.moveScore,
    0
  );
}

function getSignalConfluence(signal = {}) {
  return safeNumber(
    signal.confluence ??
      signal.effectiveConfluence ??
      signal.confluenceScore,
    0
  );
}

function getSignalSniperScore(signal = {}) {
  return safeNumber(
    signal.sniperScore ??
      signal.sniper ??
      signal.sniperConfidence,
    0
  );
}

function getSignalPlannedRR(signal = {}) {
  return safeNumber(
    signal.plannedRR ??
      signal.finalRr ??
      signal.finalRR ??
      signal.effectiveRR ??
      signal.rr ??
      signal.riskReward,
    0
  );
}

function evaluateSignalQuality(signal = {}, options = {}) {
  const stage = String(signal.stage || signal.scannerStage || "").toLowerCase();

  const minEntryScore = safeNumber(options.minEntryScore, 0);
  const minAlmostScore = safeNumber(options.minAlmostScore, minEntryScore);
  const minScore = stage === "almost" ? minAlmostScore : minEntryScore;

  const minConfluence = safeNumber(options.minConfluence, 0);
  const minSniperScore = safeNumber(options.minSniperScore, 0);
  const minPlannedRR = safeNumber(options.minPlannedRR, 0);

  const score = getSignalScore(signal);
  const confluence = getSignalConfluence(signal);
  const sniperScore = getSignalSniperScore(signal);
  const plannedRR = getSignalPlannedRR(signal);

  const failures = [];

  if (score < minScore) {
    failures.push({
      key: "score",
      value: score,
      threshold: minScore
    });
  }

  if (confluence < minConfluence) {
    failures.push({
      key: "confluence",
      value: confluence,
      threshold: minConfluence
    });
  }

  if (sniperScore < minSniperScore) {
    failures.push({
      key: "sniperScore",
      value: sniperScore,
      threshold: minSniperScore
    });
  }

  if (plannedRR < minPlannedRR) {
    failures.push({
      key: "plannedRR",
      value: plannedRR,
      threshold: minPlannedRR
    });
  }

  return {
    ok: failures.length === 0,
    failures,

    stage,

    score,
    confluence,
    sniperScore,
    plannedRR,

    minScore,
    minEntryScore,
    minAlmostScore,
    minConfluence,
    minSniperScore,
    minPlannedRR
  };
}

// ================= ATTACH KEYS =================

export function attachMicroRotationKeys(signal = {}, options = {}) {
  const row = safeObject(signal);

  const tradeSide = inferTradeSide(row);

  const directAnalyzeFamilyId = extractAnalyzeFamilyIdFromSignal(row);
  const cleanDirectAnalyzeFamilyId = isAnalyzeSideCompatible(directAnalyzeFamilyId, tradeSide)
    ? directAnalyzeFamilyId
    : null;

  const explicitCoreId = getSignalCoreMicroFamilyIds(row, 1).find(id => {
    return isMicroSideCompatible(id, tradeSide);
  }) || null;

  const explicitAnalyzeFamilyId =
    normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(explicitCoreId)) || null;

  const parentFamilyId =
    cleanDirectAnalyzeFamilyId ||
    explicitAnalyzeFamilyId ||
    null;

  const coreFromAnalyze = buildCoreMicroIdFromAnalyzeFamilyId(parentFamilyId);

  const primaryMicroFamilyId =
    coreFromAnalyze ||
    explicitCoreId ||
    null;

  const familyIds = parentFamilyId ? [parentFamilyId] : [];
  const microFamilyIds = primaryMicroFamilyId ? [primaryMicroFamilyId] : [];

  const rotationCandidate = {
    ...safeObject(row.rotationCandidate),

    symbol: row.symbol ? normalizeBaseSymbol(row.symbol) : null,
    side: row.side || null,

    tradeSide,
    rotationSide: tradeSide,

    analyzeFamilyId: parentFamilyId,
    analysisFamilyId: parentFamilyId,
    parentFamilyId,
    analyzerParentFamilyId: parentFamilyId,
    familyId: parentFamilyId,
    familyIds,
    families: familyIds,

    microFamilyId: primaryMicroFamilyId,
    rotationMicroFamilyId: primaryMicroFamilyId,
    analyzerMicroFamilyId: primaryMicroFamilyId,
    microFamilyIds,
    microFamilies: microFamilyIds,

    weekKey: options.weekKey || row.weekKey || row.rotationCandidate?.weekKey || null
  };

  return {
    ...row,

    symbol: row.symbol ? normalizeBaseSymbol(row.symbol) : row.symbol,

    tradeSide,
    rotationSide: tradeSide,

    analyzeFamilyId: parentFamilyId,
    analysisFamilyId: parentFamilyId,
    parentFamilyId,
    analyzerParentFamilyId: parentFamilyId,

    familyId: parentFamilyId,
    familyIds,
    families: familyIds,

    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
    microFamilyId: primaryMicroFamilyId,
    microFamily: primaryMicroFamilyId,
    rotationMicroFamilyId: primaryMicroFamilyId,
    analyzerMicroFamilyId: primaryMicroFamilyId,
    microFamilyIds,
    microFamilies: microFamilyIds,

    rotationCandidate
  };
}

// ================= MATCHING =================

function buildCanonicalRotationMatch({
  signal = {},
  activeMicroFamilyIds = [],
  maxFamilyIdsChecked = DEFAULT_MAX_FAMILY_IDS_CHECKED
}) {
  const checkedMicroFamilyIds = getSignalCoreMicroFamilyIds(
    signal,
    maxFamilyIdsChecked
  );

  const activeCoreMicroFamilyIds = uniqCoreMicroIds(activeMicroFamilyIds);
  const activeSet = new Set(activeCoreMicroFamilyIds);

  const matchedMicroFamilyId =
    checkedMicroFamilyIds.find(id => activeSet.has(id)) || null;

  return {
    allowed: Boolean(matchedMicroFamilyId),
    matchedMicroFamilyId,
    checkedMicroFamilyIds,
    activeMicroFamilyIds: activeCoreMicroFamilyIds,
    realActiveMicroFamilyIds: activeCoreMicroFamilyIds
  };
}

function buildDecision({
  signal,
  rotation,
  activeMicroFamilyIds,
  match,
  quality,
  options,
  externalGateResult = null
}) {
  const strictWeeklyRotation =
    options.strictWeeklyRotation ??
    options.strictGate ??
    MICRO_ROTATION_STRICT_ENTRY_GATE;

  const allowBootstrapWhenRotationEmpty =
    options.allowBootstrapWhenRotationEmpty ??
    options.allowEmptyBootstrap ??
    MICRO_ROTATION_ALLOW_EMPTY_BOOTSTRAP;

  const rotationDisabled = rotation
    ? isRotationDisabledOrUnusable(rotation)
    : false;

  const rotationMeta = getRotationMeta(rotation || {});
  const activeIds = uniqCoreMicroIds(activeMicroFamilyIds);

  const rotationEmpty = activeIds.length === 0;
  const qualityOk = Boolean(quality?.ok);

  let allowed = true;
  let reason = "MICRO_ROTATION_ALLOWED";

  if (!qualityOk) {
    allowed = false;
    reason = `QUALITY_GATE_FAILED_${quality.failures?.[0]?.key || "UNKNOWN"}`;
  } else if (externalGateResult?.reason === "EXTERNAL_LIVE_GATE_ERROR" && !rotation) {
    allowed = false;
    reason = "EXTERNAL_LIVE_GATE_ERROR";
  } else if (rotationDisabled) {
    allowed = false;
    reason = "WEEKLY_ROTATION_DISABLED_OR_UNUSABLE";
  } else if (!strictWeeklyRotation) {
    allowed = true;
    reason = "MICRO_ROTATION_STRICT_GATE_DISABLED";
  } else if (rotationEmpty) {
    allowed = Boolean(allowBootstrapWhenRotationEmpty);
    reason = allowed
      ? "EMPTY_MICRO_ROTATION_BOOTSTRAP_ALLOWED"
      : "STRICT_GATE_WITH_ZERO_ACTIVE_MICRO_FAMILIES";
  } else if (match.allowed) {
    allowed = true;
    reason = "CANONICAL_CORE_MICRO_EXACT_MATCH";
  } else {
    allowed = false;
    reason = match.checkedMicroFamilyIds.length
      ? "REAL_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION"
      : "CORE_MICRO_FAMILY_MISSING";
  }

  const matchedMicroFamilyId = match.matchedMicroFamilyId || null;

  const primaryMicroFamilyId =
    matchedMicroFamilyId ||
    signal.microFamilyId ||
    signal.analyzerMicroFamilyId ||
    signal.rotationMicroFamilyId ||
    match.checkedMicroFamilyIds[0] ||
    null;

  return {
    ok: allowed,
    pass: allowed,
    allow: allowed,
    allowed,

    reason,
    waitReason: allowed ? null : reason,
    gateReason: reason,

    rotationId: rotationMeta.rotationId || externalGateResult?.rotationId || null,
    activeRotationId:
      rotationMeta.activeRotationId ||
      rotationMeta.rotationId ||
      externalGateResult?.activeRotationId ||
      externalGateResult?.rotationId ||
      null,

    weekKey:
      options.weekKey ||
      rotationMeta.weekKey ||
      externalGateResult?.weekKey ||
      null,

    source:
      rotationMeta.source ||
      externalGateResult?.source ||
      null,

    bootstrap:
      Boolean(rotationMeta.bootstrap) ||
      Boolean(externalGateResult?.bootstrap),

    rankingMode:
      rotationMeta.rankingMode ||
      externalGateResult?.rankingMode ||
      null,

    microFamilyId: primaryMicroFamilyId,
    matchedMicroFamilyId,

    checkedMicroFamilyIds: match.checkedMicroFamilyIds,
    activeMicroFamilyIds: activeIds,
    realActiveMicroFamilyIds: activeIds,

    activeMicroFamilyCount: activeIds.length,
    realActiveMicroFamilyCount: activeIds.length,
    checkedMicroFamilyCount: match.checkedMicroFamilyIds.length,

    hasRealMicroAllowlist: activeIds.length > 0,

    strictWeeklyRotation: Boolean(strictWeeklyRotation),
    strictGate: Boolean(strictWeeklyRotation),
    emptyBootstrapAllowed: Boolean(allowBootstrapWhenRotationEmpty),
    rotationEmpty,
    rotationDisabled,

    parentFallback: MICRO_ROTATION_PARENT_FALLBACK,

    quality,

    schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
  };
}

// ================= EXTERNAL LIVE GATE FALLBACK =================

function getEvaluateWeeklyMicroGateFn() {
  const candidates = [
    liveGateModule.evaluateWeeklyMicroGate,
    liveGateModule.default?.evaluateWeeklyMicroGate,
    typeof liveGateModule.default === "function"
      ? liveGateModule.default
      : null
  ];

  return candidates.find(fn => typeof fn === "function") || null;
}

async function evaluateExternalLiveGateSafe(signal, options = {}) {
  const fn = getEvaluateWeeklyMicroGateFn();

  if (!fn) return null;

  try {
    return await fn(signal, options);
  } catch (error) {
    console.warn("MICRO_ROTATION_EXTERNAL_LIVE_GATE_FAILED:", JSON.stringify({
      symbol: signal?.symbol || null,
      side: signal?.side || null,
      error: error?.message || String(error),
      ts: Date.now()
    }));

    return {
      ok: false,
      allowed: false,
      allow: false,
      pass: false,
      reason: "EXTERNAL_LIVE_GATE_ERROR",
      error: error?.message || String(error)
    };
  }
}

function normalizeExternalGateResult(result = null) {
  if (!result || typeof result !== "object") return null;

  const r = safeObject(result);
  const gate = safeObject(r.gate);
  const decision = safeObject(r.decision);

  const wrapped = {
    ...gate,
    ...decision,
    ...r
  };

  const activeMicroFamilyIds = extractRotationMicroFamilyIds(wrapped);

  const allowed = Boolean(
    wrapped.allowed ??
      wrapped.allow ??
      wrapped.pass ??
      wrapped.ok
  );

  return {
    ...wrapped,

    allowed,
    allow: allowed,
    pass: allowed,
    ok: allowed,

    reason:
      wrapped.reason ||
      wrapped.gateReason ||
      wrapped.waitReason ||
      (allowed ? "EXTERNAL_LIVE_GATE_ALLOWED" : "EXTERNAL_LIVE_GATE_BLOCKED"),

    waitReason:
      allowed
        ? null
        : wrapped.waitReason ||
            wrapped.gateReason ||
            wrapped.reason ||
            "EXTERNAL_LIVE_GATE_BLOCKED",

    gateReason:
      wrapped.gateReason ||
      wrapped.reason ||
      null,

    activeMicroFamilyIds,
    realActiveMicroFamilyIds: activeMicroFamilyIds,

    rotationId:
      wrapped.rotationId ||
      wrapped.activeRotationId ||
      null,

    activeRotationId:
      wrapped.activeRotationId ||
      wrapped.rotationId ||
      null,

    weekKey:
      wrapped.weekKey ||
      wrapped.activeWeekKey ||
      wrapped.targetWeekKey ||
      wrapped.sourceWeekKey ||
      null
  };
}

// ================= MAIN CHECK =================

export async function checkTradeSignalAgainstRotation(signal = {}, options = {}) {
  const maxFamilyIdsChecked = Math.max(
    1,
    Number(options.maxFamilyIdsChecked || DEFAULT_MAX_FAMILY_IDS_CHECKED)
  );

  const attachedSignal = attachMicroRotationKeys(signal, options);

  if (!isEntryCandidate(attachedSignal)) {
    const decision = {
      ok: true,
      pass: true,
      allow: true,
      allowed: true,

      reason: "NON_ENTRY_ACTION",
      waitReason: null,
      gateReason: "NON_ENTRY_ACTION",

      rotationId: null,
      activeRotationId: null,
      weekKey: options.weekKey || attachedSignal.weekKey || null,
      source: null,

      microFamilyId: attachedSignal.microFamilyId || null,
      matchedMicroFamilyId: null,

      checkedMicroFamilyIds: attachedSignal.microFamilyIds || [],
      activeMicroFamilyIds: [],
      realActiveMicroFamilyIds: [],

      activeMicroFamilyCount: 0,
      realActiveMicroFamilyCount: 0,
      checkedMicroFamilyCount: attachedSignal.microFamilyIds?.length || 0,

      hasRealMicroAllowlist: false,
      strictWeeklyRotation: false,
      strictGate: false,
      emptyBootstrapAllowed: false,
      rotationEmpty: true,
      rotationDisabled: false,
      parentFallback: MICRO_ROTATION_PARENT_FALLBACK,

      quality: null,
      schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
    };

    return {
      ok: true,
      pass: true,
      allow: true,
      allowed: true,

      reason: decision.reason,
      waitReason: null,
      gateReason: decision.gateReason,

      rotationId: null,
      activeRotationId: null,
      weekKey: decision.weekKey,
      source: null,

      microFamilyId: decision.microFamilyId,
      matchedMicroFamilyId: null,

      checkedMicroFamilyIds: decision.checkedMicroFamilyIds,
      activeMicroFamilyIds: [],
      realActiveMicroFamilyIds: [],

      hasRealMicroAllowlist: false,
      bootstrap: false,
      rotationDisabled: false,
      strictGate: false,

      quality: null,

      decision,
      gate: decision,
      signal: attachedSignal
    };
  }

  const tradeSide = attachedSignal.tradeSide;

  const explicitRotation = selectRotationInput(options);
  const explicitActiveIds = extractRotationMicroFamilyIds(explicitRotation, tradeSide);

  const quality = evaluateSignalQuality(attachedSignal, options);

  let rotation = explicitRotation;
  let activeMicroFamilyIds = explicitActiveIds;
  let externalGateResult = null;

  if (!rotation || activeMicroFamilyIds.length === 0) {
    const rawExternalGateResult = await evaluateExternalLiveGateSafe(
      attachedSignal,
      options
    );

    externalGateResult = normalizeExternalGateResult(rawExternalGateResult);

    const externalIds = externalGateResult
      ? extractRotationMicroFamilyIds(externalGateResult, tradeSide)
      : [];

    if (!rotation && externalGateResult) {
      rotation = externalGateResult;
    }

    if (activeMicroFamilyIds.length === 0 && externalIds.length > 0) {
      activeMicroFamilyIds = externalIds;
    }
  }

  const match = buildCanonicalRotationMatch({
    signal: attachedSignal,
    activeMicroFamilyIds,
    maxFamilyIdsChecked
  });

  const decision = buildDecision({
    signal: attachedSignal,
    rotation,
    activeMicroFamilyIds,
    match,
    quality,
    options,
    externalGateResult
  });

  return {
    ok: decision.allowed,
    pass: decision.allowed,
    allow: decision.allowed,
    allowed: decision.allowed,

    reason: decision.reason,
    waitReason: decision.waitReason,
    gateReason: decision.gateReason,

    rotationId: decision.rotationId,
    activeRotationId: decision.activeRotationId,
    weekKey: decision.weekKey,
    source: decision.source,

    microFamilyId: decision.microFamilyId,
    matchedMicroFamilyId: decision.matchedMicroFamilyId,

    checkedMicroFamilyIds: decision.checkedMicroFamilyIds,
    activeMicroFamilyIds: decision.activeMicroFamilyIds,
    realActiveMicroFamilyIds: decision.realActiveMicroFamilyIds,

    hasRealMicroAllowlist: decision.hasRealMicroAllowlist,
    bootstrap: decision.bootstrap,
    rotationDisabled: decision.rotationDisabled,
    strictGate: decision.strictGate,

    quality: decision.quality,

    decision,
    gate: decision,
    signal: attachedSignal
  };
}

// ================= LEGACY DEFAULT WRAPPER =================

export async function microRotationGate(action = {}, options = {}) {
  const result = await checkTradeSignalAgainstRotation(action, options);

  if (result.allowed) {
    return {
      ok: true,
      allow: true,
      allowed: true,
      pass: true,

      reason: result.reason,

      rotationId: result.rotationId,
      activeRotationId: result.activeRotationId,
      weekKey: result.weekKey,

      microFamilyId: result.microFamilyId,
      matchedMicroFamilyId: result.matchedMicroFamilyId,
      checkedMicroFamilyIds: result.checkedMicroFamilyIds,
      activeMicroFamilyIds: result.activeMicroFamilyIds,
      realActiveMicroFamilyIds: result.realActiveMicroFamilyIds,

      decision: result.decision,
      gate: result.decision,
      signal: result.signal
    };
  }

  return {
    ok: true,
    allow: false,
    allowed: false,
    pass: false,

    reason: result.reason,
    waitReason: result.waitReason || "STRICT_WEEKLY_MICRO_ROTATION_FILTER",
    gateReason: result.gateReason || result.reason,

    rotationId: result.rotationId,
    activeRotationId: result.activeRotationId,
    weekKey: result.weekKey,

    microFamilyId: result.microFamilyId,
    matchedMicroFamilyId: result.matchedMicroFamilyId,
    checkedMicroFamilyIds: result.checkedMicroFamilyIds,
    activeMicroFamilyIds: result.activeMicroFamilyIds,
    realActiveMicroFamilyIds: result.realActiveMicroFamilyIds,

    decision: result.decision,
    gate: result.decision,
    signal: result.signal
  };
}

export default microRotationGate;