// ================= FILE: api/admin/micro-families.js =================

import { getIsoWeekKey } from '../../src/utils.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';
import { rankMicros } from '../../src/analyze/scoring.js';
import { getActiveRotation } from '../../src/analyze/rotationEngine.js';

export default async function handler(req, res) {
  try {
    const weekKey = req.query?.weekKey || getIsoWeekKey();
    const mode = req.query?.mode || 'balanced';
    const limit = Number(req.query?.limit || 200);
    const micros = await getWeekMicros(weekKey);
    const active = await getActiveRotation();
    const activeSet = new Set(active?.microFamilyIds || []);
    const rows = rankMicros(micros, mode).slice(0, limit).map(row => ({
      ...row,
      active: activeSet.has(row.microFamilyId)
    }));
    res.status(200).json({ weekKey, mode, count: rows.length, activeRotationId: active?.rotationId || null, rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
