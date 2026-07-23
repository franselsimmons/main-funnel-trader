// ================= FILE: src/analyze/rotationEngine.js =================
// Rotation management logic

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now } from '../utils.js';

export async function selectRotation(families = [], targetCount = 42) {
  try {
    if (!families || families.length === 0) {
      return { ok: false, reason: 'NO_FAMILIES', selectedCount: 0 };
    }

    // Sort by score descending
    const sorted = [...families].sort((a, b) => b.score - a.score);
    const selected = sorted.slice(0, Math.min(targetCount, families.length));

    return {
      ok: true,
      selectedFamilies: selected,
      selectedCount: selected.length,
      targetCount
    };

  } catch (err) {
    console.error('selectRotation error:', err);
    return { ok: false, error: err.message, selectedCount: 0 };
  }
}

export async function storeRotation(rotation = {}) {
  try {
    const redis = getRedis();
    const weekKey = getWeekKey();
    const rotationKey = keys.rotation(weekKey);

    const rotationData = {
      weekKey,
      selectedFamilies: rotation.selectedFamilies || [],
      selectedCount: rotation.selectedCount || 0,
      activatedAt: now(),
      expires: now() + (7 * 24 * 60 * 60 * 1000),
      topFamilies: (rotation.selectedFamilies || []).slice(0, 10)
    };

    await redis.set(rotationKey, rotationData);

    return { ok: true, weekKey, rotationKey };

  } catch (err) {
    console.error('storeRotation error:', err);
    return { ok: false, error: err.message };
  }
}

export async function getActiveRotation() {
  try {
    const redis = getRedis();
    const weekKey = getWeekKey();
    const rotationKey = keys.rotation(weekKey);

    const rotation = await redis.get(rotationKey);
    if (!rotation) {
      return { ok: false, reason: 'NO_ACTIVE_ROTATION', families: [] };
    }

    return {
      ok: true,
      weekKey,
      rotation,
      families: rotation.selectedFamilies || []
    };

  } catch (err) {
    console.error('getActiveRotation error:', err);
    return { ok: false, error: err.message, families: [] };
  }
}

function getWeekKey() {
  const date = new Date();
  const year = date.getFullYear();
  const dayNum = date.getUTCDay() || 7;
  const firstDay = new Date(Date.UTC(year, 0, 1));
  const adjustedDate = new Date(date);
  adjustedDate.setUTCDate(adjustedDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(adjustedDate.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((adjustedDate - yearStart) / 86400000) + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

export default { selectRotation, storeRotation, getActiveRotation };
