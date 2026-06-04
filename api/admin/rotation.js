// ================= FILE: api/admin/rotation.js =================

import { getIsoWeekKey } from '../../src/utils.js';
import { getRotationDashboard, buildRotationFromWeek, activateSelectedMicroFamilies } from '../../src/analyze/rotationEngine.js';
import { getDurableRedis, setJson } from '../../src/redis.js';
import { KEYS } from '../../src/keys.js';

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getRotationDashboard());
    }

    const body = await readBody(req);
    const action = body.action;

    if (action === 'activateBestBalanced') {
      const weekKey = body.weekKey || getIsoWeekKey();
      const rotation = await buildRotationFromWeek({ weekKey, activeWeekKey: getIsoWeekKey(), mode: 'balanced' });
      const active = { ...rotation, activatedAt: Date.now(), source: 'ADMIN_ACTIVATE_BEST_BALANCED' };
      await setJson(getDurableRedis(), KEYS.analyze.activeRotation, active);
      return res.status(200).json({ ok: true, activeRotation: active });
    }

    if (action === 'activateSelected') {
      const active = await activateSelectedMicroFamilies({
        microFamilyIds: body.microFamilyIds || [],
        weekKey: body.weekKey || getIsoWeekKey()
      });
      return res.status(200).json({ ok: true, activeRotation: active });
    }

    res.status(400).json({ ok: false, reason: 'UNKNOWN_ACTION' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
