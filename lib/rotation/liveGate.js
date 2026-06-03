// lib/rotation/liveGate.js

import {
  classifyAnalyzeEvent,
  buildCoreMicroFamilyId,
  normalizeAnalyzeFamilyId,
  extractParentFamilyIdFromMicroId
} from "../familyMicroAnalyzer.js";

import { getActiveWeeklyGate } from "./getActiveWeeklyGate.js";

const DEFAULT_SCHEMA_VERSION = "MF_V4_ANALYZE";

const MICRO_FAMILY_SCHEMA_VERSION =
  process.env.MICRO_FAMILY_SCHEMA_VERSION || DEFAULT_SCHEMA_VERSION;

const CORE_MICRO_ID_RE =
  /^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_(?:[1-9]|[1-4][0-9]|50))_([A-Z0-9_]+)_([A-Z0-9]+)$/;

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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
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
  const token = normalizeMicroFamilyId(microFamilyId);

  if (!token) return null;
  if (token.startsWith("MICRO_LONG_")) return "LONG";
  if (token.startsWith("MICRO_SHORT_")) return "SHORT";

  return null;
}

function isCoreMicroFamilyId(value) {
  const token = cleanToken(value);

  return Boolean(
    token &&
      CORE_MICRO_ID_RE.test(token) &&
      token.includes(`_${MICRO_FAMILY_SCHEMA_VERSION}_`)
  );
}

function normalizeMicroFamilyId(value) {
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
    values
      .flat(Infinity)
      .flatMap(asArray)
      .map(normalizeMicroFamilyId)
      .filter(isCoreMicroFamilyId)
  );
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
    rotation.payload
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

function collectIdsFromFamilyRows(rows = []) {
  return collectMicroFamilyIds(
    rows.flatMap(row => [
      row?.microFamilyId,
      row?.rotationMicroFamilyId,
      row?.analyzerMicroFamilyId,
      row?.familyId,
      row?.parentFamilyId,
      row?.analyzeFamilyId,
      row?.analysisFamilyId,
      row?.id,
      row?.key
    ])
  );
}

function extractGateMicroIds(rotation = {}) {
  const values = [];
  const sources = getRotationSources(rotation);

  for (const source of sources) {
    values.push(
      source.selectedMicroFamilyIds,
      source.activeMicroFamilyIds,
      source.allowedMicroFamilyIds,
      source.realActiveMicroFamilyIds,

      source.familyIds,
      source.activeFamilyIds,
      source.allowedFamilyIds,

      source.allowlist,
      source.allowed,
      source.active
    );

    values.push(
      collectIdsFromFamilyRows(source.families),
      collectIdsFromFamilyRows(source.selectedFamilies),
      collectIdsFromFamilyRows(source.rows),
      collectIdsFromFamilyRows(source.longFamilies),
      collectIdsFromFamilyRows(source.shortFamilies),
      collectIdsFromFamilyRows(source.selectedLongFamilies),
      collectIdsFromFamilyRows(source.selectedShortFamilies)
    );

    if (source.selectedFamilyMap && typeof source.selectedFamilyMap === "object") {
      values.push(Object.keys(source.selectedFamilyMap));
    }

    if (source.familyMap && typeof source.familyMap === "object") {
      values.push(Object.keys(source.familyMap));
    }
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
        source.selectedLongMicroFamilyIds,
        source.longMicroFamilyIds,
        source.activeLongMicroFamilyIds,
        source.allowedLongMicroFamilyIds,
        collectIdsFromFamilyRows(source.longFamilies),
        collectIdsFromFamilyRows(source.selectedLongFamilies)
      );
    }

    if (normalizedSide === "SHORT") {
      values.push(
        source.selectedShortMicroFamilyIds,
        source.shortMicroFamilyIds,
        source.activeShortMicroFamilyIds,
        source.allowedShortMicroFamilyIds,
        collectIdsFromFamilyRows(source.shortFamilies),
        collectIdsFromFamilyRows(source.selectedShortFamilies)
      );
    }
  }

  const sideSpecific = collectMicroFamilyIds(values);

  if (sideSpecific.length) {
    return sideSpecific.filter(id => getMicroSide(id) === normalizedSide);
  }

  return extractGateMicroIds(rotation).filter(id => getMicroSide(id) === normalizedSide);
}

function normalizeGate(rawGate = {}, options = {}) {
  const gate = rawGate && typeof rawGate === "object" ? rawGate : {};

  const selectedMicroFamilyIds = extractGateMicroIds(gate);
  const selectedLongMicroFamilyIds = extractGateSideMicroIds(gate, "LONG");
  const selectedShortMicroFamilyIds = extractGateSideMicroIds(gate, "SHORT");

  const explicitStrict =
    options.strictWeeklyRotation ??
    options.strict ??
    firstDefined(gate, ["strict", "strictWeeklyRotation"]);

  const explicitUsable = firstDefined(gate, ["usable"]);
  const explicitEnabled = firstDefined(gate, ["enabled", "gateEnabled"]);
  const explicitOk = firstDefined(gate, ["ok"]);

  const usable =
    explicitOk === false ||
    explicitEnabled === false ||
    explicitUsable === false
      ? false
      : selectedMicroFamilyIds.length > 0 ||
        Boolean(options.allowBootstrapWhenRotationEmpty);

  const strict =
    explicitStrict === undefined || explicitStrict === null
      ? true
      : Boolean(explicitStrict);

  return {
    ...gate,

    usable,
    strict,

    enabled: explicitEnabled === false ? false : true,
    gateEnabled: explicitEnabled === false ? false : true,

    reason:
      firstDefined(gate, ["reason", "gateReason", "waitReason"]) ||
      (usable ? "WEEKLY_ROTATION_READY" : "WEEKLY_ROTATION_NOT_USABLE"),

    rotationId:
      firstDefined(gate, ["rotationId", "activeRotationId", "id"]) || null,

    targetWeekKey:
      options.weekKey ||
      firstDefined(gate, ["targetWeekKey", "activeWeekKey", "weekKey"]) ||
      null,

    sourceWeekKey:
      firstDefined(gate, ["sourceWeekKey", "weekKey"]) || null,

    source:
      firstDefined(gate, ["source", "rotationSource"]) || null,

    selectedMicroFamilyIds,
    activeMicroFamilyIds: selectedMicroFamilyIds,
    allowedMicroFamilyIds: selectedMicroFamilyIds,
    realActiveMicroFamilyIds: selectedMicroFamilyIds,

    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds
  };
}

function getExplicitRotationFromOptionsOrAction(action = {}, options = {}) {
  return (
    options.weeklyRotation ??
    options.rotation ??
    options.rotationState ??
    options.activeRotation ??
    action.weeklyRotation ??
    action.rotation ??
    action.rotationState ??
    action.activeRotation ??
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
        family.side
    ) || family.side;

  const checkedMicroFamilyIds = collectMicroFamilyIds(
    action.analyzerMicroFamilyId,
    action.rotationMicroFamilyId,
    action.microFamilyId,
    action.microFamily,
    action.microFamilyIds,
    action.microFamilies,

    action.familyId,
    action.familyIds,
    action.families,
    action.parentFamilyId,
    action.analyzeFamilyId,
    action.analysisFamilyId,
    action.analyzerParentFamilyId,

    action.rotationCandidate?.analyzerMicroFamilyId,
    action.rotationCandidate?.rotationMicroFamilyId,
    action.rotationCandidate?.microFamilyId,
    action.rotationCandidate?.microFamilyIds,
    action.rotationCandidate?.microFamilies,
    action.rotationCandidate?.familyId,
    action.rotationCandidate?.familyIds,
    action.rotationCandidate?.parentFamilyId,
    action.rotationCandidate?.analyzeFamilyId,
    action.rotationCandidate?.analysisFamilyId,

    family.analyzerMicroFamilyId,
    family.rotationMicroFamilyId,
    family.microFamilyId,
    family.microFamilyIds,
    family.familyId,
    family.familyIds,
    family.parentFamilyId,
    family.analyzeFamilyId,
    family.analysisFamilyId
  );

  const primaryMicroFamilyId = checkedMicroFamilyIds[0] || null;

  return {
    ...family,
    side,
    checkedMicroFamilyIds,
    microFamilyId: primaryMicroFamilyId || family.microFamilyId || null
  };
}

export async function evaluateWeeklyMicroGate(action = {}, options = {}) {
  if (!isEntryCandidate(action)) {
    return {
      ok: true,
      pass: true,
      allowed: true,
      allow: true,

      reason: "NON_ENTRY_ACTION",
      gateEnabled: false,
      strict: false,

      activeMicroFamilyIds: [],
      checkedMicroFamilyIds: [],
      matchedMicroFamilyId: null
    };
  }

  const gate = await loadGate(action, options);

  const allowBootstrapWhenRotationEmpty = Boolean(
    options.allowBootstrapWhenRotationEmpty ??
      action.allowBootstrapWhenRotationEmpty ??
      false
  );

  const strictWeeklyRotation = Boolean(
    options.strictWeeklyRotation ??
      action.strictWeeklyRotation ??
      gate.strict
  );

  if (!gate.usable || gate.enabled === false || gate.gateEnabled === false) {
    const allowed = !strictWeeklyRotation || allowBootstrapWhenRotationEmpty;

    return {
      ok: allowed,
      pass: allowed,
      allowed,
      allow: allowed,

      reason: allowed
        ? "WEEKLY_ROTATION_NOT_USABLE_BYPASS"
        : "WEEKLY_ROTATION_NOT_USABLE",

      waitReason: allowed ? null : "WEEKLY_ROTATION_NOT_USABLE",
      gateReason: gate.reason,

      gateEnabled: false,
      strict: strictWeeklyRotation,

      rotationId: gate.rotationId ?? null,
      targetWeekKey: gate.targetWeekKey ?? null,
      sourceWeekKey: gate.sourceWeekKey ?? null,
      source: gate.source ?? null,

      microFamilyId: null,
      matchedMicroFamilyId: null,

      activeMicroFamilyIds: gate.selectedMicroFamilyIds,
      realActiveMicroFamilyIds: gate.selectedMicroFamilyIds,
      selectedMicroFamilyIds: gate.selectedMicroFamilyIds,
      selectedLongMicroFamilyIds: gate.selectedLongMicroFamilyIds,
      selectedShortMicroFamilyIds: gate.selectedShortMicroFamilyIds,
      checkedMicroFamilyIds: [],

      gate
    };
  }

  const family = buildFamilyFromAction(action, gate, options);
  const side = normalizeSide(family.side || action.side);

  const activeMicroFamilyIds =
    side === "LONG"
      ? gate.selectedLongMicroFamilyIds
      : side === "SHORT"
        ? gate.selectedShortMicroFamilyIds
        : gate.selectedMicroFamilyIds;

  const finalActiveMicroFamilyIds = activeMicroFamilyIds.length
    ? activeMicroFamilyIds
    : gate.selectedMicroFamilyIds;

  const checkedMicroFamilyIds = family.checkedMicroFamilyIds;
  const activeSet = new Set(finalActiveMicroFamilyIds);

  const matchedMicroFamilyId =
    checkedMicroFamilyIds.find(id => activeSet.has(id)) || null;

  if (!finalActiveMicroFamilyIds.length) {
    const allowed = !strictWeeklyRotation || allowBootstrapWhenRotationEmpty;

    return {
      ok: allowed,
      pass: allowed,
      allowed,
      allow: allowed,

      reason: allowed
        ? "EMPTY_WEEKLY_ROTATION_BOOTSTRAP_ALLOWED"
        : "STRICT_GATE_WITH_ZERO_ACTIVE_MICRO_FAMILIES",

      waitReason: allowed ? null : "STRICT_GATE_WITH_ZERO_ACTIVE_MICRO_FAMILIES",
      gateReason: allowed
        ? "EMPTY_WEEKLY_ROTATION_BOOTSTRAP_ALLOWED"
        : "STRICT_GATE_WITH_ZERO_ACTIVE_MICRO_FAMILIES",

      gateEnabled: strictWeeklyRotation,
      strict: strictWeeklyRotation,
      emptyBootstrapAllowed: allowBootstrapWhenRotationEmpty,

      rotationId: gate.rotationId ?? null,
      targetWeekKey: gate.targetWeekKey ?? null,
      sourceWeekKey: gate.sourceWeekKey ?? null,
      source: gate.source ?? null,

      side,
      setupClass: family.setupClass,
      scannerStage: family.scannerStage,

      microFamilyId: family.microFamilyId,
      matchedMicroFamilyId: null,

      activeMicroFamilyIds: [],
      realActiveMicroFamilyIds: [],
      selectedMicroFamilyIds: gate.selectedMicroFamilyIds,
      selectedLongMicroFamilyIds: gate.selectedLongMicroFamilyIds,
      selectedShortMicroFamilyIds: gate.selectedShortMicroFamilyIds,
      checkedMicroFamilyIds,

      family,
      gate
    };
  }

  if (!checkedMicroFamilyIds.length) {
    return {
      ok: false,
      pass: false,
      allowed: false,
      allow: false,

      reason: "CORE_MICRO_FAMILY_MISSING",
      waitReason: "CORE_MICRO_FAMILY_MISSING",
      gateReason: "CORE_MICRO_FAMILY_MISSING",

      gateEnabled: true,
      strict: strictWeeklyRotation,

      rotationId: gate.rotationId ?? null,
      targetWeekKey: gate.targetWeekKey ?? null,
      sourceWeekKey: gate.sourceWeekKey ?? null,
      source: gate.source ?? null,

      side,
      setupClass: family.setupClass,
      scannerStage: family.scannerStage,

      microFamilyId: null,
      matchedMicroFamilyId: null,

      activeMicroFamilyIds: finalActiveMicroFamilyIds,
      realActiveMicroFamilyIds: finalActiveMicroFamilyIds,
      selectedMicroFamilyIds: gate.selectedMicroFamilyIds,
      selectedLongMicroFamilyIds: gate.selectedLongMicroFamilyIds,
      selectedShortMicroFamilyIds: gate.selectedShortMicroFamilyIds,
      checkedMicroFamilyIds,

      family,
      gate
    };
  }

  const allowed = !strictWeeklyRotation || Boolean(matchedMicroFamilyId);

  return {
    ok: allowed,
    pass: allowed,
    allowed,
    allow: allowed,

    reason: allowed
      ? matchedMicroFamilyId
        ? "CANONICAL_CORE_MICRO_EXACT_MATCH"
        : "MICRO_ROTATION_STRICT_GATE_DISABLED"
      : "REAL_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",

    waitReason: allowed ? null : "REAL_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",
    gateReason: allowed
      ? "WEEKLY_ROTATION_ALLOWED"
      : "REAL_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",

    gateEnabled: true,
    strict: strictWeeklyRotation,

    rotationId: gate.rotationId ?? null,
    targetWeekKey: gate.targetWeekKey ?? null,
    sourceWeekKey: gate.sourceWeekKey ?? null,
    source: gate.source ?? null,

    side,
    setupClass: family.setupClass,
    scannerStage: family.scannerStage,

    microFamilyId: family.microFamilyId,
    matchedMicroFamilyId,

    activeMicroFamilyIds: finalActiveMicroFamilyIds,
    realActiveMicroFamilyIds: finalActiveMicroFamilyIds,
    selectedMicroFamilyIds: gate.selectedMicroFamilyIds,
    selectedLongMicroFamilyIds: gate.selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds: gate.selectedShortMicroFamilyIds,
    checkedMicroFamilyIds,

    family,
    gate,

    schemaVersion: MICRO_FAMILY_SCHEMA_VERSION
  };
}

export default evaluateWeeklyMicroGate;