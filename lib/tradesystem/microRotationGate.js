// lib/tradesystem/microRotationGate.js

import { evaluateWeeklyMicroGate } from "../rotation/liveGate.js";

export async function microRotationGate(action = {}) {
  const result = await evaluateWeeklyMicroGate(action);

  if (result.allowed) {
    return {
      ok: true,
      allow: true,
      allowed: true,
      reason: result.reason,
      gate: result
    };
  }

  return {
    ok: true,
    allow: false,
    allowed: false,
    reason: result.reason,
    waitReason: "STRICT_WEEKLY_MICRO_ROTATION_FILTER",
    gateReason: result.reason,
    rotationId: result.rotationId,
    microFamilyId: result.microFamilyId,
    activeMicroFamilyIds: result.activeMicroFamilyIds,
    gate: result
  };
}

export default microRotationGate;
