// lib/rotation/liveGate.js

import { classifyAnalyzeEvent } from "../familyMicroAnalyzer.js";
import { getActiveWeeklyGate } from "./getActiveWeeklyGate.js";

function normalizeSide(value) {
  const raw = String(value ?? "").toLowerCase();

  if (["long", "bull", "buy", "bullish"].includes(raw)) return "LONG";
  if (["short", "bear", "sell", "bearish"].includes(raw)) return "SHORT";

  return null;
}

function isEntryCandidate(action = {}) {
  const type = String(action.type ?? action.action ?? action.actionType ?? "").toUpperCase();
  const stage = String(action.stage ?? action.scannerStage ?? "").toUpperCase();

  if (type.includes("EXIT") || type.includes("HOLD")) return false;
  if (stage.includes("EXIT")) return false;

  return true;
}

export async function evaluateWeeklyMicroGate(action = {}) {
  if (!isEntryCandidate(action)) {
    return {
      allowed: true,
      reason: "NON_ENTRY_ACTION",
      gateEnabled: false
    };
  }

  const gate = await getActiveWeeklyGate();

  if (!gate.usable || !gate.strict) {
    return {
      allowed: true,
      reason: gate.reason,
      gateEnabled: false,
      rotationId: gate.rotationId ?? null,
      activeMicroFamilyIds: gate.selectedMicroFamilyIds
    };
  }

  const family = classifyAnalyzeEvent(action, {
    weekKey: gate.targetWeekKey
  });

  const side = normalizeSide(family.side || action.side);
  const microFamilyId = action.microFamilyId || family.microFamilyId;

  const allowedIds =
    side === "LONG"
      ? gate.selectedLongMicroFamilyIds
      : side === "SHORT"
        ? gate.selectedShortMicroFamilyIds
        : gate.selectedMicroFamilyIds;

  if (!allowedIds.length) {
    return {
      allowed: true,
      reason: `NO_${side || "SIDE"}_ROTATION_BYPASS`,
      gateEnabled: false,
      rotationId: gate.rotationId ?? null,
      microFamilyId,
      activeMicroFamilyIds: gate.selectedMicroFamilyIds
    };
  }

  const allowed = allowedIds.includes(microFamilyId);

  return {
    allowed,
    reason: allowed ? "WEEKLY_ROTATION_ALLOWED" : "BLOCKED_BY_WEEKLY_ROTATION",
    gateEnabled: true,
    rotationId: gate.rotationId,
    targetWeekKey: gate.targetWeekKey,
    sourceWeekKey: gate.sourceWeekKey,
    microFamilyId,
    activeMicroFamilyIds: allowedIds,
    selectedMicroFamilyIds: gate.selectedMicroFamilyIds,
    side,
    setupClass: family.setupClass,
    scannerStage: family.scannerStage,
    family
  };
}

export default evaluateWeeklyMicroGate;
