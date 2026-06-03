// lib/rotation/getActiveWeeklyGate.js

import { loadActiveRotation } from "./rotationStore.js";

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

const ANALYZE_FAMILY_ID_RE = /^(LONG|SHORT)_([1-9]|[1-4][0-9]|50)$/;

const MICRO_ID_RE = /^MICRO_(LONG|SHORT)_/;

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

function unique(values = []) {
  return [...new Set(flattenValues(values).filter(Boolean))];
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

  return null;
}

function getMicroSide(microFamilyId) {
  const id = cleanToken(microFamilyId);

  if (id.startsWith("MICRO_LONG_")) return "LONG";
  if (id.startsWith("MICRO_SHORT_")) return "SHORT";

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

// ================= CANONICAL ID NORMALIZATION =================

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
  if (!MICRO_ID_RE.test(value)) return null;
  if (value.includes("UNKNOWN")) return null;

  return value;
}

export function extractParentFamilyIdFromMicroId(raw) {
  const id = normalizeMicroFamilyId(raw);

  if (!id) return null;

  const match = id.match(/^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_\d{1,3})_/);

  return normalizeAnalyzeFamilyId(match?.[2]) || null;
}

export function normalizeRotationMicroId(raw) {
  const microId = normalizeMicroFamilyId(raw);

  if (microId) {
    const parentFromMicro = extractParentFamilyIdFromMicroId(microId);
    return buildCoreMicroIdFromAnalyzeFamilyId(parentFromMicro);
  }

  const analyzeFamilyId = normalizeAnalyzeFamilyId(raw);
  return buildCoreMicroIdFromAnalyzeFamilyId(analyzeFamilyId);
}

export function normalizeRotationMicroIds(values = [], side = null) {
  const normalized = unique(
    flattenValues(values)
      .map(normalizeRotationMicroId)
      .filter(Boolean)
  );

  if (side !== "LONG" && side !== "SHORT") {
    return normalized;
  }

  return normalized.filter(id => getMicroSide(id) === side);
}

// ================= ROTATION EXTRACTION =================

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
  "active"
];

const LONG_ID_PATHS = [
  "selectedLongMicroFamilyIds",
  "selection.long.microFamilyIds",
  "selection.long.familyIds",
  "selection.long.selectedMicroFamilyIds",
  "long.microFamilyIds",
  "long.familyIds"
];

const SHORT_ID_PATHS = [
  "selectedShortMicroFamilyIds",
  "selection.short.microFamilyIds",
  "selection.short.familyIds",
  "selection.short.selectedMicroFamilyIds",
  "short.microFamilyIds",
  "short.familyIds"
];

const ROW_ID_KEYS = [
  "familyId",
  "parentFamilyId",
  "analyzeFamilyId",
  "analysisFamilyId",
  "microFamilyId",
  "analyzerMicroFamilyId",
  "rotationMicroFamilyId",
  "id",
  "key"
];

const GENERIC_ROW_PATHS = [
  "families",
  "selectedFamilies",
  "rows",
  "selection.families",
  "selection.rows",
  "selectedRows"
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

function collectPathValues(source = {}, paths = []) {
  const values = [];

  for (const path of paths) {
    values.push(getNestedValue(source, path));
  }

  return values;
}

function collectRowValues(rows = []) {
  const values = [];

  for (const row of safeArray(rows)) {
    if (!row || typeof row !== "object") continue;

    for (const key of ROW_ID_KEYS) {
      values.push(row[key]);
    }
  }

  return values;
}

function collectRowsFromPaths(source = {}, paths = []) {
  const values = [];

  for (const path of paths) {
    const rows = getNestedValue(source, path);
    values.push(collectRowValues(rows));
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
    ...safeArray(source.selection?.families),
    ...safeArray(source.selection?.rows)
  ];

  const values = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const rowSide =
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
      normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(row.microFamilyId));

    const inferredSide =
      rowSide ||
      (familyId?.startsWith("LONG_") ? "LONG" : null) ||
      (familyId?.startsWith("SHORT_") ? "SHORT" : null);

    if (inferredSide !== targetSide) continue;

    for (const key of ROW_ID_KEYS) {
      values.push(row[key]);
    }
  }

  return values;
}

export function extractWeeklyRotationRawIds(rotation = {}) {
  const sources = getRotationSources(rotation);

  const generic = [];
  const long = [];
  const short = [];

  for (const source of sources) {
    generic.push(
      collectPathValues(source, GENERIC_ID_PATHS),
      collectRowsFromPaths(source, GENERIC_ROW_PATHS),
      collectMapKeys(source, MAP_PATHS)
    );

    long.push(
      collectPathValues(source, LONG_ID_PATHS),
      collectRowsFromPaths(source, LONG_ROW_PATHS),
      collectSideCompatibleRows(source, "LONG")
    );

    short.push(
      collectPathValues(source, SHORT_ID_PATHS),
      collectRowsFromPaths(source, SHORT_ROW_PATHS),
      collectSideCompatibleRows(source, "SHORT")
    );
  }

  return {
    generic: unique(generic),
    long: unique(long),
    short: unique(short)
  };
}

export function extractWeeklyRotationMicroFamilyIds(rotation = {}) {
  const raw = extractWeeklyRotationRawIds(rotation);

  const selectedLongMicroFamilyIds = normalizeRotationMicroIds(
    [...raw.generic, ...raw.long],
    "LONG"
  );

  const selectedShortMicroFamilyIds = normalizeRotationMicroIds(
    [...raw.generic, ...raw.short],
    "SHORT"
  );

  const selectedMicroFamilyIds = unique([
    ...normalizeRotationMicroIds(raw.generic),
    ...selectedLongMicroFamilyIds,
    ...selectedShortMicroFamilyIds
  ]);

  return {
    selectedMicroFamilyIds,
    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds,

    rawSelectedMicroFamilyIds: unique([
      ...raw.generic,
      ...raw.long,
      ...raw.short
    ]),
    rawSelectedLongMicroFamilyIds: unique([
      ...raw.generic,
      ...raw.long
    ]),
    rawSelectedShortMicroFamilyIds: unique([
      ...raw.generic,
      ...raw.short
    ])
  };
}

// ================= META =================

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

function getRotationMeta(rotation = {}) {
  return {
    rotationId:
      getFirstDefinedRotationValue(rotation, [
        "rotationId",
        "activeRotationId",
        "id"
      ]) || null,

    activeRotationId:
      getFirstDefinedRotationValue(rotation, [
        "activeRotationId",
        "rotationId",
        "id"
      ]) || null,

    targetWeekKey:
      getFirstDefinedRotationValue(rotation, [
        "targetWeekKey",
        "weekKey",
        "activeWeekKey"
      ]) || null,

    sourceWeekKey:
      getFirstDefinedRotationValue(rotation, [
        "sourceWeekKey",
        "weekKey",
        "activeWeekKey"
      ]) || null,

    source:
      getFirstDefinedRotationValue(rotation, [
        "source",
        "mode",
        "rotationSource"
      ]) || null,

    rankingMode:
      getFirstDefinedRotationValue(rotation, [
        "rankingMode",
        "rankingMetric"
      ]) || null,

    bootstrap: Boolean(
      getFirstDefinedRotationValue(rotation, [
        "bootstrap",
        "isBootstrap"
      ])
    )
  };
}

function isRotationEnabled(rotation = {}) {
  const enabled = getFirstDefinedRotationValue(rotation, ["enabled"]);

  return enabled !== false;
}

function isRotationStrict(rotation = {}) {
  const strict = getFirstDefinedRotationValue(rotation, ["strict"]);

  return strict !== false && MICRO_ROTATION_STRICT_ENTRY_GATE;
}

// ================= MAIN =================

export async function getActiveWeeklyGate() {
  const rotation = await loadActiveRotation();

  if (!rotation) {
    return {
      ok: true,
      enabled: false,
      usable: false,
      strict: false,
      gateEnabled: false,
      reason: "NO_ACTIVE_ROTATION_BYPASS",

      rotation: null,

      rotationId: null,
      activeRotationId: null,
      targetWeekKey: null,
      sourceWeekKey: null,
      source: null,
      rankingMode: null,
      bootstrap: false,

      selectedMicroFamilyIds: [],
      selectedLongMicroFamilyIds: [],
      selectedShortMicroFamilyIds: [],

      rawSelectedMicroFamilyIds: [],
      rawSelectedLongMicroFamilyIds: [],
      rawSelectedShortMicroFamilyIds: [],

      schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
    };
  }

  const {
    selectedMicroFamilyIds,
    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds,

    rawSelectedMicroFamilyIds,
    rawSelectedLongMicroFamilyIds,
    rawSelectedShortMicroFamilyIds
  } = extractWeeklyRotationMicroFamilyIds(rotation);

  const meta = getRotationMeta(rotation);

  const enabled = isRotationEnabled(rotation);
  const strict = isRotationStrict(rotation);
  const usable = Boolean(enabled && selectedMicroFamilyIds.length > 0);

  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      usable: false,
      strict: false,
      gateEnabled: false,
      reason: "WEEKLY_ROTATION_DISABLED_BYPASS",

      rotation,

      ...meta,

      selectedMicroFamilyIds,
      selectedLongMicroFamilyIds,
      selectedShortMicroFamilyIds,

      rawSelectedMicroFamilyIds,
      rawSelectedLongMicroFamilyIds,
      rawSelectedShortMicroFamilyIds,

      schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
    };
  }

  if (!usable) {
    return {
      ok: true,
      enabled: true,
      usable: false,
      strict: false,
      gateEnabled: false,
      reason: "NO_USABLE_WEEKLY_ROTATION_BYPASS",

      rotation,

      ...meta,

      selectedMicroFamilyIds,
      selectedLongMicroFamilyIds,
      selectedShortMicroFamilyIds,

      rawSelectedMicroFamilyIds,
      rawSelectedLongMicroFamilyIds,
      rawSelectedShortMicroFamilyIds,

      schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
    };
  }

  return {
    ok: true,
    enabled: true,
    usable: true,
    strict,
    gateEnabled: strict,
    reason: strict
      ? "ACTIVE_WEEKLY_ROTATION"
      : "ACTIVE_WEEKLY_ROTATION_STRICT_DISABLED",

    rotation,

    ...meta,

    selectedMicroFamilyIds,
    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds,

    rawSelectedMicroFamilyIds,
    rawSelectedLongMicroFamilyIds,
    rawSelectedShortMicroFamilyIds,

    selectedMicroFamilyCount: selectedMicroFamilyIds.length,
    selectedLongMicroFamilyCount: selectedLongMicroFamilyIds.length,
    selectedShortMicroFamilyCount: selectedShortMicroFamilyIds.length,

    schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
  };
}

export default getActiveWeeklyGate;