// ================= FILE: api/admin/rotation.js =================

import { KEYS } from '../../src/keys.js';
import { getIsoWeekKey, getPreviousIsoWeekKey } from '../../src/utils.js';
import { getDurableRedis, setJson } from '../../src/redis.js';
import {
  getRotationDashboard,
  buildRotationFromWeek,
  activateSelectedMicroFamilies
} from '../../src/analyze/src/rotationEngine.js';

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') {
      return req.body.trim() ? JSON.parse(req.body) : {};
    }

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();

  return text ? JSON.parse(text) : {};
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

function normalizeMicroFamilyIds(value) {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .map(id => String(id || '').trim())
      .filter(Boolean)
  )];
}

function normalizeRotation(rotation, fallback = {}) {
  const microFamilyIds = normalizeMicroFamilyIds(
    rotation?.microFamilyIds ||
    rotation?.activeMicroFamilyIds ||
    rotation?.ids ||
    []
  );

  return {
    ...fallback,
    ...rotation,
    microFamilyIds,
    count: microFamilyIds.length
  };
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST']
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method === 'GET') {
      const dashboard = await getRotationDashboard();

      const active = normalizeRotation(dashboard?.active || dashboard?.activeRotation || {});
      const next = normalizeRotation(dashboard?.next || dashboard?.nextRotation || {});

      return res.status(200).json({
        ok: true,
        ...dashboard,
        active,
        next,
        activeRotation: active,
        nextRotation: next,
        serverTs: Date.now()
      });
    }

    if (req.method !== 'POST') {
      return methodNotAllowed(res);
    }

    const body = await readBody(req);
    const action = String(body?.action || '').trim();

    if (!action) {
      return res.status(400).json({
        ok: false,
        reason: 'ACTION_REQUIRED',
        allowedActions: ['activateBestBalanced', 'activateSelected']
      });
    }

    if (action === 'activateBestBalanced') {
      const sourceWeekKey = firstQueryValue(
        body.weekKey,
        getPreviousIsoWeekKey()
      );

      const activeWeekKey = firstQueryValue(
        body.activeWeekKey,
        getIsoWeekKey()
      );

      const mode = firstQueryValue(body.mode, 'balanced');

      const rotation = await buildRotationFromWeek({
        weekKey: sourceWeekKey,
        activeWeekKey,
        mode
      });

      const active = normalizeRotation(rotation, {
        rotationId: `ADMIN_ROTATION_${activeWeekKey}_${Date.now()}`,
        source: 'ADMIN_ACTIVATE_BEST_BALANCED',
        sourceWeekKey,
        activeWeekKey,
        mode,
        activatedAt: Date.now()
      });

      await setJson(getDurableRedis(), KEYS.analyze.activeRotation, active);

      return res.status(200).json({
        ok: true,
        action,
        sourceWeekKey,
        activeWeekKey,
        mode,
        activeRotation: active,
        active,
        activatedCount: active.microFamilyIds.length,
        serverTs: Date.now()
      });
    }

    if (action === 'activateSelected') {
      const microFamilyIds = normalizeMicroFamilyIds(body.microFamilyIds);

      if (!microFamilyIds.length) {
        return res.status(400).json({
          ok: false,
          reason: 'MICRO_FAMILY_IDS_REQUIRED',
          message: 'activateSelected vereist minimaal één microFamilyId.'
        });
      }

      const sourceWeekKey = firstQueryValue(
        body.weekKey,
        getPreviousIsoWeekKey()
      );

      const active = await activateSelectedMicroFamilies({
        microFamilyIds,
        weekKey: sourceWeekKey
      });

      const normalizedActive = normalizeRotation(active, {
        source: 'ADMIN_ACTIVATE_SELECTED',
        sourceWeekKey,
        activeWeekKey: getIsoWeekKey(),
        mode: 'selected',
        activatedAt: Date.now()
      });

      return res.status(200).json({
        ok: true,
        action,
        sourceWeekKey,
        activeRotation: normalizedActive,
        active: normalizedActive,
        activatedCount: normalizedActive.microFamilyIds.length,
        serverTs: Date.now()
      });
    }

    return res.status(400).json({
      ok: false,
      reason: 'UNKNOWN_ACTION',
      action,
      allowedActions: ['activateBestBalanced', 'activateSelected']
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    });
  }
}