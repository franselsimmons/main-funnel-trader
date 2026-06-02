// lib/rotation/getActiveWeeklyGate.js

import { loadActiveRotation } from "./rotationStore.js";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export async function getActiveWeeklyGate() {
  const rotation = await loadActiveRotation();

  if (!rotation) {
    return {
      ok: true,
      enabled: false,
      usable: false,
      strict: false,
      reason: "NO_ACTIVE_ROTATION_BYPASS",
      rotation: null,
      selectedMicroFamilyIds: [],
      selectedLongMicroFamilyIds: [],
      selectedShortMicroFamilyIds: []
    };
  }

  const selectedLongMicroFamilyIds = unique(
    rotation.selectedLongMicroFamilyIds ??
      rotation.selection?.long?.microFamilyIds ??
      []
  );

  const selectedShortMicroFamilyIds = unique(
    rotation.selectedShortMicroFamilyIds ??
      rotation.selection?.short?.microFamilyIds ??
      []
  );

  const selectedMicroFamilyIds = unique([
    ...(rotation.selectedMicroFamilyIds ?? []),
    ...selectedLongMicroFamilyIds,
    ...selectedShortMicroFamilyIds
  ]);

  const usable = Boolean(rotation.enabled && selectedMicroFamilyIds.length > 0);

  if (!usable) {
    return {
      ok: true,
      enabled: false,
      usable: false,
      strict: false,
      reason: "NO_USABLE_WEEKLY_ROTATION_BYPASS",
      rotation,
      selectedMicroFamilyIds,
      selectedLongMicroFamilyIds,
      selectedShortMicroFamilyIds
    };
  }

  return {
    ok: true,
    enabled: true,
    usable: true,
    strict: rotation.strict !== false,
    reason: "ACTIVE_WEEKLY_ROTATION",
    rotation,
    rotationId: rotation.rotationId,
    targetWeekKey: rotation.targetWeekKey,
    sourceWeekKey: rotation.sourceWeekKey,
    selectedMicroFamilyIds,
    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds
  };
}

export default getActiveWeeklyGate;
