// ================= FILE: src/analyze/activateRotation.js =================
// Rotation activation (select top families for new week)

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, getWeekKey } from '../utils.js';
import { getTopFamilies } from './analyzeEngine.js';
import { selectRotation, storeRotation } from './rotationEngine.js';

export async function activateRotation(targetFamilies = 42) {
  try {
    const redis = getRedis();

    // Get top families
    const topResult = await getTopFamilies(targetFamilies);
    if (!topResult.ok || topResult.families.length === 0) {
      return {
        ok: false,
        reason: 'NO_TOP_FAMILIES',
        selectedCount: 0
      };
    }

    // Select and store rotation
    const selectionResult = await selectRotation(topResult.families, targetFamilies);
    if (!selectionResult.ok) {
      return {
        ok: false,
        reason: 'SELECTION_FAILED',
        selectedCount: 0
      };
    }

    const storeResult = await storeRotation(selectionResult);
    if (!storeResult.ok) {
      return {
        ok: false,
        reason: 'STORAGE_FAILED',
        selectedCount: 0
      };
    }

    // Mark as activated
    const weekKey = getWeekKey();
    const activationKey = keys.rotationActivation(weekKey);
    await redis.set(activationKey, {
      weekKey,
      activatedAt: now(),
      selectedCount: selectionResult.selectedCount,
      targetFamilies
    });

    return {
      ok: true,
      weekKey,
      selectedCount: selectionResult.selectedCount,
      selectedFamilies: selectionResult.selectedFamilies
    };

  } catch (err) {
    console.error('activateRotation error:', err);
    return {
      ok: false,
      error: err.message,
      selectedCount: 0
    };
  }
}

export default { activateRotation };
