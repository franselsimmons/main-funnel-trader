// ================= FILE: api/admin/micro-family/[id].js =================

import { getIsoWeekKey } from '../../../src/utils.js';
import { getWeekMicros } from '../../../src/analyze/analyzeEngine.js';

export default async function handler(req, res) {
  try {
    const id = req.query?.id;
    const weekKey = req.query?.weekKey || getIsoWeekKey();
    const micros = await getWeekMicros(weekKey);
    const row = micros[id] || null;
    if (!row) return res.status(404).json({ ok: false, reason: 'MICRO_FAMILY_NOT_FOUND', id, weekKey });
    res.status(200).json({ weekKey, row });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
