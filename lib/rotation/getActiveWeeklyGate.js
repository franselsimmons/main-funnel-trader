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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function flattenValues(values = []) {
  return values
    .flat(Infinity)
    .filter(value => value !== undefined && value !== null);
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
      .replace(/[^A-Z0-9.%+-]+/gi, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || fallback
  );
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;

  const raw = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;

  return fallback;
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
  if (value.startsWith("SUB_")) return null;
  if (value.startsWith("PARENT_")) return null;

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
    values.push(collectRowValues(getNestedValue(source, path)));
  }

  return values;
}

function collectMapValues(source = {}, paths = []) {
  const values = [];

  for (const path of paths) {
    const map = getNestedValue(source, path);

    if (!map || typeof map !== "object" || Array.isArray(map)) continue;

    values.push(Object.keys(map));

    for (const value of Object.values(map)) {
      if (typeof value === "string" || typeof value === "number") {
        values.push(value);
        continue;
      }

      if (value && typeof value === "object") {
        values.push(collectRowValues([value]));
      }
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
      normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(row.microFamilyId)) ||
      normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(row.rotationMicroFamilyId)) ||
      normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(row.analyzerMicroFamilyId));

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
      collectMapValues(source, MAP_PATHS)
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

    activeMicroFamilyIds: selectedMicroFamilyIds,
    allowedMicroFamilyIds: selectedMicroFamilyIds,
    realActiveMicroFamilyIds: selectedMicroFamilyIds,

    activeLongMicroFamilyIds: selectedLongMicroFamilyIds,
    allowedLongMicroFamilyIds: selectedLongMicroFamilyIds,

    activeShortMicroFamilyIds: selectedShortMicroFamilyIds,
    allowedShortMicroFamilyIds: selectedShortMicroFamilyIds,

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
  const targetWeekKey =
    getFirstDefinedRotationValue(rotation, [
      "targetWeekKey",
      "weekKey",
      "activeWeekKey"
    ]) || null;

  const sourceWeekKey =
    getFirstDefinedRotationValue(rotation, [
      "sourceWeekKey",
      "weekKey",
      "activeWeekKey"
    ]) || null;

  const rotationId =
    getFirstDefinedRotationValue(rotation, [
      "rotationId",
      "activeRotationId",
      "id"
    ]) || null;

  const activeRotationId =
    getFirstDefinedRotationValue(rotation, [
      "activeRotationId",
      "rotationId",
      "id"
    ]) || null;

  return {
    rotationId,
    activeRotationId,

    weekKey: targetWeekKey,
    targetWeekKey,
    sourceWeekKey,

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

    bootstrap: parseBoolean(
      getFirstDefinedRotationValue(rotation, [
        "bootstrap",
        "isBootstrap"
      ]),
      false
    )
  };
}

function isRotationEnabled(rotation = {}) {
  const enabled = getFirstDefinedRotationValue(rotation, [
    "enabled",
    "gateEnabled"
  ]);

  return parseBoolean(enabled, true);
}

function isRotationStrict(rotation = {}) {
  const strict = getFirstDefinedRotationValue(rotation, [
    "strict",
    "strictGate",
    "strictWeeklyRotation"
  ]);

  return parseBoolean(strict, true) && MICRO_ROTATION_STRICT_ENTRY_GATE;
}

function buildGateResponse({
  rotation = null,
  enabled = false,
  usable = false,
  strict = false,
  reason = "NO_ACTIVE_ROTATION_BYPASS",
  ids = {},
  meta = {}
}) {
  const selectedMicroFamilyIds = ids.selectedMicroFamilyIds ?? [];
  const selectedLongMicroFamilyIds = ids.selectedLongMicroFamilyIds ?? [];
  const selectedShortMicroFamilyIds = ids.selectedShortMicroFamilyIds ?? [];

  return {
    ok: true,

    enabled,
    usable,
    strict,
    gateEnabled: Boolean(enabled && usable && strict),

    reason,

    rotation,

    rotationId: meta.rotationId ?? null,
    activeRotationId: meta.activeRotationId ?? null,

    weekKey: meta.weekKey ?? null,
    targetWeekKey: meta.targetWeekKey ?? meta.weekKey ?? null,
    sourceWeekKey: meta.sourceWeekKey ?? null,

    source: meta.source ?? null,
    rankingMode: meta.rankingMode ?? null,
    bootstrap: Boolean(meta.bootstrap),

    selectedMicroFamilyIds,
    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds,

    activeMicroFamilyIds: selectedMicroFamilyIds,
    allowedMicroFamilyIds: selectedMicroFamilyIds,
    realActiveMicroFamilyIds: selectedMicroFamilyIds,

    activeLongMicroFamilyIds: selectedLongMicroFamilyIds,
    allowedLongMicroFamilyIds: selectedLongMicroFamilyIds,

    activeShortMicroFamilyIds: selectedShortMicroFamilyIds,
    allowedShortMicroFamilyIds: selectedShortMicroFamilyIds,

    rawSelectedMicroFamilyIds: ids.rawSelectedMicroFamilyIds ?? [],
    rawSelectedLongMicroFamilyIds: ids.rawSelectedLongMicroFamilyIds ?? [],
    rawSelectedShortMicroFamilyIds: ids.rawSelectedShortMicroFamilyIds ?? [],

    selectedMicroFamilyCount: selectedMicroFamilyIds.length,
    selectedLongMicroFamilyCount: selectedLongMicroFamilyIds.length,
    selectedShortMicroFamilyCount: selectedShortMicroFamilyIds.length,

    rotationEmpty: selectedMicroFamilyIds.length === 0,

    schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
  };
}

// ================= MAIN =================

export async function getActiveWeeklyGate() {
  const rotation = await loadActiveRotation();

  if (!rotation) {
    return buildGateResponse({
      reason: "NO_ACTIVE_ROTATION_BYPASS"
    });
  }

  const ids = extractWeeklyRotationMicroFamilyIds(rotation);
  const meta = getRotationMeta(rotation);

  const enabled = isRotationEnabled(rotation);
  const strict = isRotationStrict(rotation);
  const usable = Boolean(enabled && ids.selectedMicroFamilyIds.length > 0);

  if (!enabled) {
    return buildGateResponse({
      rotation,
      enabled: false,
      usable: false,
      strict: false,
      reason: "WEEKLY_ROTATION_DISABLED_BYPASS",
      ids,
      meta
    });
  }

  if (!usable) {
    return buildGateResponse({
      rotation,
      enabled: true,
      usable: false,
      strict: false,
      reason: "NO_USABLE_WEEKLY_ROTATION_BYPASS",
      ids,
      meta
    });
  }

  return buildGateResponse({
    rotation,
    enabled: true,
    usable: true,
    strict,
    reason: strict
      ? "ACTIVE_WEEKLY_ROTATION"
      : "ACTIVE_WEEKLY_ROTATION_STRICT_DISABLED",
    ids,
    meta
  });
}

export default getActiveWeeklyGate;