// lib/rotation/liveGate.js

import { classifyAnalyzeEvent } from "../familyMicroAnalyzer.js";
import { getActiveWeeklyGate } from "./getActiveWeeklyGate.js";

// ================= CONFIG =================

const DEFAULT_SCHEMA_VERSION = "MF_V4_ANALYZE";

const MICRO_FAMILY_SCHEMA_VERSION =
  typeof process !== "undefined"
    ? process.env.MICRO_FAMILY_SCHEMA_VERSION || DEFAULT_SCHEMA_VERSION
    : DEFAULT_SCHEMA_VERSION;

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
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function flattenValues(values = []) {
  return values.flat(Infinity).filter(value => value !== undefined && value !== null);
}

function unique(values = []) {
  return Array.from(new Set(flattenValues(values).filter(Boolean)));
}

function cleanToken(value, fallback = "") {
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

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;

  const raw = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;

  return Boolean(value);
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

function normalizeSide(value) {
  const raw = String(value ?? "").toLowerCase();

  if (["long", "bull", "buy", "bullish"].includes(raw)) return "LONG";
  if (["short", "bear", "sell", "bearish"].includes(raw)) return "SHORT";

  const token = cleanToken(value);

  if (token === "LONG" || token === "SHORT") return token;
  if (token.startsWith("LONG_")) return "LONG";
  if (token.startsWith("SHORT_")) return "SHORT";
  if (token.startsWith("MICRO_LONG_")) return "LONG";
  if (token.startsWith("MICRO_SHORT_")) return "SHORT";

  return null;
}

function getMicroSide(microFamilyId) {
  const token = cleanToken(microFamilyId);

  if (token.startsWith("MICRO_LONG_")) return "LONG";
  if (token.startsWith("MICRO_SHORT_")) return "SHORT";

  return null;
}

function getNestedValue(object, path) {
  if (!object || !path) return null;

  return String(path)
    .split(".")
    .reduce((current, key) => {
      if (!current || typeof current !== "object") return null;
      return current[key];
    }, object);
}

// ================= CANONICAL MICRO NORMALIZATION =================

export function extractParentFamilyIdFromMicroId(raw) {
  const token = cleanToken(raw);

  if (!token.startsWith("MICRO_")) return null;

  const match = token.match(
    /^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_(?:[1-9]|[1-4][0-9]|50))_/
  );

  const parentFamilyId = match?.[2] || null;

  return ANALYZE_FAMILY_ID_RE.test(parentFamilyId || "")
    ? parentFamilyId
    : null;
}

export function normalizeAnalyzeFamilyId(raw) {
  const token = cleanToken(raw);

  if (ANALYZE_FAMILY_ID_RE.test(token)) {
    return token;
  }

  return extractParentFamilyIdFromMicroId(token);
}

export function buildCoreMicroFamilyId(familyId) {
  const analyzeFamilyId = normalizeAnalyzeFamilyId(familyId);

  if (!analyzeFamilyId) return null;

  const side = analyzeFamilyId.startsWith("LONG_") ? "LONG" : "SHORT";
  const definition = `${MICRO_FAMILY_SCHEMA_VERSION} | ${analyzeFamilyId}`;
  const hash = analyzerHashString(definition).slice(0, 8);

  return `MICRO_${side}_${analyzeFamilyId}_${MICRO_FAMILY_SCHEMA_VERSION}_${hash}`;
}

export function isCoreMicroFamilyId(value) {
  const token = cleanToken(value);

  return Boolean(
    token &&
      CORE_MICRO_ID_RE.test(token) &&
      token.includes(`_${MICRO_FAMILY_SCHEMA_VERSION}_`)
  );
}

export function normalizeMicroFamilyId(value) {
  const token = cleanToken(value);

  if (!token) return null;

  if (isCoreMicroFamilyId(token)) {
    return token;
  }

  const parentFromMicro = extractParentFamilyIdFromMicroId(token);
  if (parentFromMicro) {
    return buildCoreMicroFamilyId(parentFromMicro);
  }

  const parentFamilyId = normalizeAnalyzeFamilyId(token);
  if (parentFamilyId) {
    return buildCoreMicroFamilyId(parentFamilyId);
  }

  return null;
}

function collectMicroFamilyIds(...values) {
  return unique(
    flattenValues(values)
      .map(normalizeMicroFamilyId)
      .filter(Boolean)
      .filter(isCoreMicroFamilyId)
  );
}

function collectAnalyzeFamilyIds(...values) {
  return unique(
    flattenValues(values)
      .map(normalizeAnalyzeFamilyId)
      .filter(Boolean)
  );
}

// ================= ENTRY DETECTION =================

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

  if (type.includes("EXIT")) return false;
  if (type.includes("HOLD")) return false;
  if (stage.includes("EXIT")) return false;

  return true;
}

// ================= ROTATION SOURCE EXTRACTION =================

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

function firstDefined(rotation, keys = []) {
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

function collectPathValues(source = {}, paths = []) {
  return paths.map(path => getNestedValue(source, path));
}

const GENERIC_ID_PATHS = [
  "selectedMicroFamilyIds",
  "microFamilyIds",
  "activeMicroFamilyIds",
  "allowedMicroFamilyIds",
  "realActiveMicroFamilyIds",

  "familyIds",
  "activeFamilyIds",
  "allowedFamilyIds",

  "selection.microFamilyIds",
  "selection.familyIds",
  "selection.selectedMicroFamilyIds",

  "allowlist",
  "allowed",
  "active"
];

const LONG_ID_PATHS = [
  "selectedLongMicroFamilyIds",
  "longMicroFamilyIds",
  "activeLongMicroFamilyIds",
  "allowedLongMicroFamilyIds",

  "selection.long.microFamilyIds",
  "selection.long.familyIds",
  "selection.long.selectedMicroFamilyIds",

  "long.microFamilyIds",
  "long.familyIds"
];

const SHORT_ID_PATHS = [
  "selectedShortMicroFamilyIds",
  "shortMicroFamilyIds",
  "activeShortMicroFamilyIds",
  "allowedShortMicroFamilyIds",

  "selection.short.microFamilyIds",
  "selection.short.familyIds",
  "selection.short.selectedMicroFamilyIds",

  "short.microFamilyIds",
  "short.familyIds"
];

const ROW_ID_KEYS = [
  "microFamilyId",
  "rotationMicroFamilyId",
  "analyzerMicroFamilyId",

  "familyId",
  "parentFamilyId",
  "analyzeFamilyId",
  "analysisFamilyId",
  "analyzerParentFamilyId",

  "id",
  "key"
];

const GENERIC_ROW_PATHS = [
  "families",
  "selectedFamilies",
  "rows",
  "selectedRows",

  "selection.families",
  "selection.rows"
];

const LONG_ROW_PATHS = [
  "longFamilies",
  "selectedLongFamilies",

  "selection.long.families",
  "selection.long.rows",

  "long.families",
  "long.rows"
];

const SHORT_ROW_PATHS = [
  "shortFamilies",
  "selectedShortFamilies",

  "selection.short.families",
  "selection.short.rows",

  "short.families",
  "short.rows"
];

const MAP_PATHS = [
  "selectedFamilyMap",
  "familyMap",
  "microFamilyMap",

  "selection.familyMap",
  "selection.microFamilyMap"
];

function collectIdsFromFamilyRows(rows = []) {
  const values = [];

  for (const row of safeArray(rows)) {
    if (!row || typeof row !== "object") continue;

    for (const key of ROW_ID_KEYS) {
      values.push(row[key]);
    }
  }

  return collectMicroFamilyIds(values);
}

function collectRowsFromPaths(source = {}, paths = []) {
  const values = [];

  for (const path of paths) {
    values.push(collectIdsFromFamilyRows(getNestedValue(source, path)));
  }

  return values;
}

function collectMapKeys(source = {}, paths = []) {
  const values = [];

  for (const path of paths) {
    const map = getNestedValue(source, path);

    if (map && typeof map === "object" && !Array.isArray(map)) {
      values.push(Object.keys(map));
    }
  }

  return values;
}

function collectSideCompatibleRows(source = {}, targetSide = null) {
  if (targetSide !== "LONG" && targetSide !== "SHORT") return [];

  const rows = [
    ...safeArray(source.families),
    ...safeArray(source.selectedFamilies),
    ...safeArray(source.rows),
    ...safeArray(source.selectedRows),
    ...safeArray(source.selection?.families),
    ...safeArray(source.selection?.rows)
  ];

  const values = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const explicitSide =
      normalizeSide(row.side) ||
      normalizeSide(row.tradeSide) ||
      normalizeSide(row.rotationSide) ||
      normalizeSide(row.direction) ||
      normalizeSide(row.bias);

    const familyId =
      normalizeAnalyzeFamilyId(row.familyId) ||
      normalizeAnalyzeFamilyId(row.parentFamilyId) ||
      normalizeAnalyzeFamilyId(row.analyzeFamilyId) ||
      normalizeAnalyzeFamilyId(row.analysisFamilyId) ||
      normalizeAnalyzeFamilyId(row.analyzerParentFamilyId) ||
      normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(row.microFamilyId)) ||
      normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(row.rotationMicroFamilyId)) ||
      normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(row.analyzerMicroFamilyId));

    const inferredSide =
      explicitSide ||
      (familyId?.startsWith("LONG_") ? "LONG" : null) ||
      (familyId?.startsWith("SHORT_") ? "SHORT" : null);

    if (inferredSide !== targetSide) continue;

    for (const key of ROW_ID_KEYS) {
      values.push(row[key]);
    }
  }

  return collectMicroFamilyIds(values);
}

function extractGateMicroIds(rotation = {}) {
  const values = [];
  const sources = getRotationSources(rotation);

  for (const source of sources) {
    values.push(
      collectPathValues(source, GENERIC_ID_PATHS),
      collectPathValues(source, LONG_ID_PATHS),
      collectPathValues(source, SHORT_ID_PATHS),

      collectRowsFromPaths(source, GENERIC_ROW_PATHS),
      collectRowsFromPaths(source, LONG_ROW_PATHS),
      collectRowsFromPaths(source, SHORT_ROW_PATHS),

      collectMapKeys(source, MAP_PATHS)
    );
  }

  return collectMicroFamilyIds(values);
}

function extractGateSideMicroIds(rotation = {}, side) {
  const normalizedSide = normalizeSide(side);

  if (!normalizedSide) {
    return extractGateMicroIds(rotation);
  }

  const values = [];
  const sources = getRotationSources(rotation);

  for (const source of sources) {
    if (normalizedSide === "LONG") {
      values.push(
        collectPathValues(source, LONG_ID_PATHS),
        collectRowsFromPaths(source, LONG_ROW_PATHS),
        collectSideCompatibleRows(source, "LONG")
      );
    }

    if (normalizedSide === "SHORT") {
      values.push(
        collectPathValues(source, SHORT_ID_PATHS),
        collectRowsFromPaths(source, SHORT_ROW_PATHS),
        collectSideCompatibleRows(source, "SHORT")
      );
    }
  }

  const sideSpecific = collectMicroFamilyIds(values).filter(
    id => getMicroSide(id) === normalizedSide
  );

  if (sideSpecific.length) {
    return sideSpecific;
  }

  return extractGateMicroIds(rotation).filter(
    id => getMicroSide(id) === normalizedSide
  );
}

// ================= GATE NORMALIZATION =================

function normalizeGate(rawGate = {}, options = {}) {
  const gate = safeObject(rawGate);

  const selectedLongMicroFamilyIds = extractGateSideMicroIds(gate, "LONG");
  const selectedShortMicroFamilyIds = extractGateSideMicroIds(gate, "SHORT");

  const selectedMicroFamilyIds = unique([
    ...extractGateMicroIds(gate),
    ...selectedLongMicroFamilyIds,
    ...selectedShortMicroFamilyIds
  ]);

  const explicitStrict =
    options.strictWeeklyRotation ??
    options.strict ??
    firstDefined(gate, ["strict", "strictWeeklyRotation"]);

  const explicitUsable = firstDefined(gate, ["usable"]);
  const explicitEnabled = firstDefined(gate, ["enabled", "gateEnabled"]);
  const explicitOk = firstDefined(gate, ["ok"]);

  const enabled = explicitEnabled === false ? false : true;

  const usable =
    explicitOk === false ||
    explicitEnabled === false ||
    explicitUsable === false
      ? false
      : selectedMicroFamilyIds.length > 0 ||
        parseBoolean(options.allowBootstrapWhenRotationEmpty, false);

  const strict = parseBoolean(explicitStrict, true);

  return {
    ...gate,

    ok: explicitOk === false ? false : true,
    enabled,
    usable,
    strict,
    gateEnabled: enabled && usable && strict,

    reason:
      firstDefined(gate, ["reason", "gateReason", "waitReason"]) ||
      (usable ? "WEEKLY_ROTATION_READY" : "WEEKLY_ROTATION_NOT_USABLE"),

    rotationId:
      firstDefined(gate, ["rotationId", "activeRotationId", "id"]) || null,

    activeRotationId:
      firstDefined(gate, ["activeRotationId", "rotationId", "id"]) || null,

    targetWeekKey:
      options.weekKey ||
      firstDefined(gate, ["targetWeekKey", "activeWeekKey", "weekKey"]) ||
      null,

    sourceWeekKey:
      firstDefined(gate, ["sourceWeekKey", "weekKey", "activeWeekKey"]) || null,

    source:
      firstDefined(gate, ["source", "mode", "rotationSource"]) || null,

    rankingMode:
      firstDefined(gate, ["rankingMode", "rankingMetric"]) || null,

    bootstrap: parseBoolean(
      firstDefined(gate, ["bootstrap", "isBootstrap"]),
      false
    ),

    selectedMicroFamilyIds,
    activeMicroFamilyIds: selectedMicroFamilyIds,
    allowedMicroFamilyIds: selectedMicroFamilyIds,
    realActiveMicroFamilyIds: selectedMicroFamilyIds,

    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds,

    selectedMicroFamilyCount: selectedMicroFamilyIds.length,
    selectedLongMicroFamilyCount: selectedLongMicroFamilyIds.length,
    selectedShortMicroFamilyCount: selectedShortMicroFamilyIds.length,

    schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
  };
}

function getExplicitRotationFromOptionsOrAction(action = {}, options = {}) {
  return (
    options.weeklyRotation ??
    options.rotation ??
    options.rotationState ??
    options.activeRotation ??
    options.currentRotation ??
    options.selectedRotation ??
    action.weeklyRotation ??
    action.rotation ??
    action.rotationState ??
    action.activeRotation ??
    action.currentRotation ??
    action.selectedRotation ??
    null
  );
}

async function loadGate(action = {}, options = {}) {
  const explicitRotation = getExplicitRotationFromOptionsOrAction(action, options);

  if (explicitRotation) {
    return normalizeGate(explicitRotation, options);
  }

  const activeGate = await getActiveWeeklyGate();

  return normalizeGate(activeGate, options);
}

// ================= SIGNAL FAMILY EXTRACTION =================

function normalizeFamilyNumber(value) {
  const n = Number(value);

  if (Number.isInteger(n) && n >= 1 && n <= 50) {
    return n;
  }

  const token = cleanToken(value);
  const match = token.match(/(?:LONG|SHORT)?_?([1-9]|[1-4][0-9]|50)$/);

  if (!match) return null;

  const parsed = Number(match[1]);

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50
    ? parsed
    : null;
}

function inferAnalyzeFamilyIdFromParts(action = {}, side = null) {
  const normalizedSide = normalizeSide(side);

  if (!normalizedSide) return null;

  const familyNumber = normalizeFamilyNumber(
    action.familyNumber ??
      action.analyzeFamilyNumber ??
      action.analysisFamilyNumber ??
      action.parentFamilyNumber ??
      action.familyIndex ??
      action.analyzeFamilyIndex ??
      action.analysisFamilyIndex ??
      action.familyRank ??
      action.rank
  );

  if (!familyNumber) return null;

  return `${normalizedSide}_${familyNumber}`;
}

function buildFamilyFromAction(action = {}, gate = {}, options = {}) {
  const family = classifyAnalyzeEvent(action, {
    weekKey:
      options.weekKey ||
      gate.targetWeekKey ||
      gate.weekKey ||
      action.weekKey ||
      action.activeWeekKey ||
      null
  });

  const side =
    normalizeSide(
      action.tradeSide ??
        action.rotationSide ??
        action.side ??
        action.direction ??
        action.actionSide ??
        family.side
    ) || family.side;

  const inferredAnalyzeFamilyId = inferAnalyzeFamilyIdFromParts(action, side);

  const analyzeFamilyIds = collectAnalyzeFamilyIds(
    action.familyId,
    action.familyIds,
    action.families,
    action.parentFamilyId,
    action.analyzeFamilyId,
    action.analysisFamilyId,
    action.analyzerParentFamilyId,

    action.rotationCandidate?.familyId,
    action.rotationCandidate?.familyIds,
    action.rotationCandidate?.families,
    action.rotationCandidate?.parentFamilyId,
    action.rotationCandidate?.analyzeFamilyId,
    action.rotationCandidate?.analysisFamilyId,
    action.rotationCandidate?.analyzerParentFamilyId,

    family.familyId,
    family.familyIds,
    family.families,
    family.parentFamilyId,
    family.analyzeFamilyId,
    family.analysisFamilyId,
    family.analyzerParentFamilyId,

    inferredAnalyzeFamilyId
  );

  const checkedMicroFamilyIds = collectMicroFamilyIds(
    action.analyzerMicroFamilyId,
    action.rotationMicroFamilyId,
    action.microFamilyId,
    action.microFamily,
    action.microFamilyIds,
    action.microFamilies,

    action.rotationCandidate?.analyzerMicroFamilyId,
    action.rotationCandidate?.rotationMicroFamilyId,
    action.rotationCandidate?.microFamilyId,
    action.rotationCandidate?.microFamily,
    action.rotationCandidate?.microFamilyIds,
    action.rotationCandidate?.microFamilies,

    family.analyzerMicroFamilyId,
    family.rotationMicroFamilyId,
    family.microFamilyId,
    family.microFamily,
    family.microFamilyIds,
    family.microFamilies,

    analyzeFamilyIds
  ).filter(id => {
    if (side !== "LONG" && side !== "SHORT") return true;
    return getMicroSide(id) === side;
  });

  const primaryMicroFamilyId = checkedMicroFamilyIds[0] || null;
  const parentFamilyId =
    normalizeAnalyzeFamilyId(analyzeFamilyIds[0]) ||
    normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(primaryMicroFamilyId)) ||
    null;

  return {
    ...family,

    side,

    parentFamilyId,
    analyzeFamilyId: parentFamilyId,
    analysisFamilyId: parentFamilyId,
    familyId: parentFamilyId,
    familyIds: parentFamilyId ? [parentFamilyId] : [],

    microFamilyId: primaryMicroFamilyId,
    rotationMicroFamilyId: primaryMicroFamilyId,
    analyzerMicroFamilyId: primaryMicroFamilyId,
    microFamilyIds: checkedMicroFamilyIds,
    microFamilies: checkedMicroFamilyIds,

    checkedMicroFamilyIds,

    schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
  };
}

// ================= RESULT SHAPING =================

function buildExposedGate(gate = {}, side = null, activeMicroFamilyIds = []) {
  const normalizedSide = normalizeSide(side);
  const activeIds = unique(activeMicroFamilyIds);

  if (normalizedSide === "LONG") {
    return {
      ...gate,

      selectedMicroFamilyIds: activeIds,
      activeMicroFamilyIds: activeIds,
      allowedMicroFamilyIds: activeIds,
      realActiveMicroFamilyIds: activeIds,

      selectedLongMicroFamilyIds: activeIds,
      selectedShortMicroFamilyIds: [],

      allSelectedMicroFamilyIds: gate.selectedMicroFamilyIds || [],
      allSelectedLongMicroFamilyIds: gate.selectedLongMicroFamilyIds || [],
      allSelectedShortMicroFamilyIds: gate.selectedShortMicroFamilyIds || []
    };
  }

  if (normalizedSide === "SHORT") {
    return {
      ...gate,

      selectedMicroFamilyIds: activeIds,
      activeMicroFamilyIds: activeIds,
      allowedMicroFamilyIds: activeIds,
      realActiveMicroFamilyIds: activeIds,

      selectedLongMicroFamilyIds: [],
      selectedShortMicroFamilyIds: activeIds,

      allSelectedMicroFamilyIds: gate.selectedMicroFamilyIds || [],
      allSelectedLongMicroFamilyIds: gate.selectedLongMicroFamilyIds || [],
      allSelectedShortMicroFamilyIds: gate.selectedShortMicroFamilyIds || []
    };
  }

  return {
    ...gate,

    selectedMicroFamilyIds: activeIds,
    activeMicroFamilyIds: activeIds,
    allowedMicroFamilyIds: activeIds,
    realActiveMicroFamilyIds: activeIds,

    selectedLongMicroFamilyIds: gate.selectedLongMicroFamilyIds || [],
    selectedShortMicroFamilyIds: gate.selectedShortMicroFamilyIds || [],

    allSelectedMicroFamilyIds: gate.selectedMicroFamilyIds || [],
    allSelectedLongMicroFamilyIds: gate.selectedLongMicroFamilyIds || [],
    allSelectedShortMicroFamilyIds: gate.selectedShortMicroFamilyIds || []
  };
}

function buildResult({
  allowed,
  reason,
  waitReason = null,
  gateReason = null,

  gate,
  family = null,
  side = null,

  activeMicroFamilyIds = [],
  checkedMicroFamilyIds = [],
  matchedMicroFamilyId = null,

  strictWeeklyRotation = false,
  emptyBootstrapAllowed = false,
  gateEnabled = true,

  extra = {}
}) {
  const exposedGate = buildExposedGate(gate, side, activeMicroFamilyIds);
  const activeIds = unique(activeMicroFamilyIds);
  const checkedIds = unique(checkedMicroFamilyIds);

  const microFamilyId =
    matchedMicroFamilyId ||
    family?.microFamilyId ||
    checkedIds[0] ||
    null;

  return {
    ok: allowed,
    pass: allowed,
    allowed,
    allow: allowed,

    enabled: true,
    usable: true,

    reason,
    waitReason: allowed ? null : waitReason || reason,
    gateReason: gateReason || reason,

    gateEnabled,
    strict: Boolean(strictWeeklyRotation),
    strictWeeklyRotation: Boolean(strictWeeklyRotation),
    emptyBootstrapAllowed: Boolean(emptyBootstrapAllowed),

    rotationId: gate.rotationId ?? null,
    activeRotationId: gate.activeRotationId ?? gate.rotationId ?? null,
    targetWeekKey: gate.targetWeekKey ?? null,
    sourceWeekKey: gate.sourceWeekKey ?? null,
    source: gate.source ?? null,
    rankingMode: gate.rankingMode ?? null,
    bootstrap: Boolean(gate.bootstrap),

    side,
    setupClass: family?.setupClass ?? null,
    scannerStage: family?.scannerStage ?? null,

    microFamilyId,
    matchedMicroFamilyId,

    checkedMicroFamilyIds: checkedIds,
    checkedMicroFamilyCount: checkedIds.length,

    activeMicroFamilyIds: activeIds,
    realActiveMicroFamilyIds: activeIds,
    selectedMicroFamilyIds: activeIds,

    selectedLongMicroFamilyIds: exposedGate.selectedLongMicroFamilyIds || [],
    selectedShortMicroFamilyIds: exposedGate.selectedShortMicroFamilyIds || [],

    allSelectedMicroFamilyIds: exposedGate.allSelectedMicroFamilyIds || [],
    allSelectedLongMicroFamilyIds: exposedGate.allSelectedLongMicroFamilyIds || [],
    allSelectedShortMicroFamilyIds: exposedGate.allSelectedShortMicroFamilyIds || [],

    activeMicroFamilyCount: activeIds.length,
    realActiveMicroFamilyCount: activeIds.length,

    hasRealMicroAllowlist: activeIds.length > 0,

    family,
    gate: exposedGate,

    schemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    ...extra
  };
}

// ================= MAIN =================

export async function evaluateWeeklyMicroGate(action = {}, options = {}) {
  if (!isEntryCandidate(action)) {
    return buildResult({
      allowed: true,
      reason: "NON_ENTRY_ACTION",
      gateReason: "NON_ENTRY_ACTION",

      gate: normalizeGate({}, { strict: false }),
      family: null,
      side: null,

      activeMicroFamilyIds: [],
      checkedMicroFamilyIds: [],

      strictWeeklyRotation: false,
      gateEnabled: true
    });
  }

  const gate = await loadGate(action, options);

  const allowBootstrapWhenRotationEmpty = parseBoolean(
    options.allowBootstrapWhenRotationEmpty ??
      action.allowBootstrapWhenRotationEmpty,
    false
  );

  const strictWeeklyRotation = parseBoolean(
    options.strictWeeklyRotation ??
      action.strictWeeklyRotation ??
      gate.strict,
    true
  );

  const family = buildFamilyFromAction(action, gate, options);
  const side = normalizeSide(family.side || action.side);

  if (!gate.usable || gate.enabled === false || gate.ok === false) {
    const allowed = !strictWeeklyRotation || allowBootstrapWhenRotationEmpty;

    return buildResult({
      allowed,

      reason: allowed
        ? "WEEKLY_ROTATION_NOT_USABLE_BYPASS"
        : "WEEKLY_ROTATION_NOT_USABLE",

      waitReason: "WEEKLY_ROTATION_NOT_USABLE",
      gateReason: gate.reason || "WEEKLY_ROTATION_NOT_USABLE",

      gate,
      family,
      side,

      activeMicroFamilyIds: [],
      checkedMicroFamilyIds: family.checkedMicroFamilyIds,

      strictWeeklyRotation,
      emptyBootstrapAllowed: allowBootstrapWhenRotationEmpty,
      gateEnabled: true,

      extra: {
        rawGateEnabled: gate.enabled,
        rawGateUsable: gate.usable,
        rawGateOk: gate.ok
      }
    });
  }

  const sideActiveMicroFamilyIds =
    side === "LONG"
      ? gate.selectedLongMicroFamilyIds
      : side === "SHORT"
        ? gate.selectedShortMicroFamilyIds
        : gate.selectedMicroFamilyIds;

  if ((side === "LONG" || side === "SHORT") && !sideActiveMicroFamilyIds.length) {
    return buildResult({
      allowed: true,
      reason: `NO_${side}_ROTATION_BYPASS`,
      gateReason: `NO_${side}_ROTATION_BYPASS`,

      gate,
      family,
      side,

      activeMicroFamilyIds: [],
      checkedMicroFamilyIds: family.checkedMicroFamilyIds,

      strictWeeklyRotation: false,
      emptyBootstrapAllowed: allowBootstrapWhenRotationEmpty,
      gateEnabled: true,

      extra: {
        sideRotationEmpty: true
      }
    });
  }

  const finalActiveMicroFamilyIds = sideActiveMicroFamilyIds.length
    ? sideActiveMicroFamilyIds
    : gate.selectedMicroFamilyIds;

  if (!finalActiveMicroFamilyIds.length) {
    const allowed = !strictWeeklyRotation || allowBootstrapWhenRotationEmpty;

    return buildResult({
      allowed,

      reason: allowed
        ? "EMPTY_WEEKLY_ROTATION_BOOTSTRAP_ALLOWED"
        : "STRICT_GATE_WITH_ZERO_ACTIVE_MICRO_FAMILIES",

      waitReason: "STRICT_GATE_WITH_ZERO_ACTIVE_MICRO_FAMILIES",
      gateReason: allowed
        ? "EMPTY_WEEKLY_ROTATION_BOOTSTRAP_ALLOWED"
        : "STRICT_GATE_WITH_ZERO_ACTIVE_MICRO_FAMILIES",

      gate,
      family,
      side,

      activeMicroFamilyIds: [],
      checkedMicroFamilyIds: family.checkedMicroFamilyIds,

      strictWeeklyRotation,
      emptyBootstrapAllowed: allowBootstrapWhenRotationEmpty,
      gateEnabled: true,

      extra: {
        rotationEmpty: true
      }
    });
  }

  const checkedMicroFamilyIds = family.checkedMicroFamilyIds;
  const activeSet = new Set(finalActiveMicroFamilyIds);

  const matchedMicroFamilyId =
    checkedMicroFamilyIds.find(id => activeSet.has(id)) || null;

  if (!checkedMicroFamilyIds.length) {
    const allowed = !strictWeeklyRotation;

    return buildResult({
      allowed,

      reason: allowed
        ? "MICRO_ROTATION_STRICT_GATE_DISABLED"
        : "CORE_MICRO_FAMILY_MISSING",

      waitReason: "CORE_MICRO_FAMILY_MISSING",
      gateReason: allowed
        ? "MICRO_ROTATION_STRICT_GATE_DISABLED"
        : "CORE_MICRO_FAMILY_MISSING",

      gate,
      family,
      side,

      activeMicroFamilyIds: finalActiveMicroFamilyIds,
      checkedMicroFamilyIds,

      strictWeeklyRotation,
      emptyBootstrapAllowed: allowBootstrapWhenRotationEmpty,
      gateEnabled: true
    });
  }

  const allowed = !strictWeeklyRotation || Boolean(matchedMicroFamilyId);

  return buildResult({
    allowed,

    reason: allowed
      ? matchedMicroFamilyId
        ? "CANONICAL_CORE_MICRO_EXACT_MATCH"
        : "MICRO_ROTATION_STRICT_GATE_DISABLED"
      : "REAL_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",

    waitReason: "REAL_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",

    gateReason: allowed
      ? "WEEKLY_ROTATION_ALLOWED"
      : "REAL_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",

    gate,
    family,
    side,

    activeMicroFamilyIds: finalActiveMicroFamilyIds,
    checkedMicroFamilyIds,
    matchedMicroFamilyId,

    strictWeeklyRotation,
    emptyBootstrapAllowed: allowBootstrapWhenRotationEmpty,
    gateEnabled: true
  });
}

export default evaluateWeeklyMicroGate;