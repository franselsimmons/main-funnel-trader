// ================= FILE: api/admin/rotation.js =================

import { KEYS } from '../../src/keys.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey
} from '../../src/utils.js';
import {
  getDurableRedis,
  setJson
} from '../../src/redis.js';
import {
  getRotationDashboard,
  buildRotationFromWeek,
  activateSelectedMicroFamilies
} from '../../src/analyze/rotationEngine.js';

const ALLOWED_ACTIONS = [
  'activateBestBalanced',
  'activateSelected'
];

const ALLOWED_MODES = new Set([
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST']
  });
}

function parseJson(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') {
      return parseJson(req.body.trim());
    }

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();

  return parseJson(text);
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function normalizeMode(value, fallback = 'balanced') {
  const mode = String(value || fallback).trim();

  return ALLOWED_MODES.has(mode) ? mode : fallback;
}

function normalizeMicroFamilyIds(value) {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  )];
}

function idsFromRotation(rotation = {}) {
  return normalizeMicroFamilyIds(
    rotation.microFamilyIds ||
    rotation.activeMicroFamilyIds ||
    rotation.ids ||
    (
      Array.isArray(rotation.microFamilies)
        ? rotation.microFamilies.map((row) => row.microFamilyId)
        : []
    )
  );
}

function normalizeRotation(rotation = {}, fallback = {}) {
  const base = {
    ...fallback,
    ...(rotation || {})
  };

  const microFamilyIds = idsFromRotation(base);

  return {
    ...base,
    microFamilyIds,
    count: microFamilyIds.length
  };
}

function normalizeDashboard(dashboard = {}) {
  const active = normalizeRotation(
    dashboard.active ||
    dashboard.activeRotation ||
    {}
  );

  const next = normalizeRotation(
    dashboard.next ||
    dashboard.nextRotation ||
    {}
  );

  return {
    ...dashboard,

    active,
    next,

    activeRotation: active,
    nextRotation: next,

    activeRows: dashboard.activeRows || active.microFamilies || [],
    nextRows: dashboard.nextRows || next.microFamilies || [],

    activeCount: active.microFamilyIds.length,
    nextCount: next.microFamilyIds.length
  };
}

async function handleGet(req, res) {
  const dashboard = normalizeDashboard(await getRotationDashboard());

  return res.status(200).json({
    ok: true,
    ...dashboard,
    serverTs: Date.now()
  });
}

async function activateBestBalanced(body) {
  const sourceWeekKey = firstValue(
    body.weekKey,
    getPreviousIsoWeekKey()
  );

  const activeWeekKey = firstValue(
    body.activeWeekKey,
    getIsoWeekKey()
  );

  const mode = normalizeMode(
    firstValue(body.mode, 'balanced'),
    'balanced'
  );

  const rotation = await buildRotationFromWeek({
    weekKey: sourceWeekKey,
    activeWeekKey,
    mode
  });

  const active = normalizeRotation({
    ...rotation,
    source: 'ADMIN_ACTIVATE_BEST_BALANCED',
    sourceWeekKey,
    activeWeekKey,
    mode,
    activatedAt: Date.now()
  });

  await setJson(
    getDurableRedis(),
    KEYS.analyze.activeRotation,
    active
  );

  return {
    action: 'activateBestBalanced',
    sourceWeekKey,
    activeWeekKey,
    mode,
    activeRotation: active,
    active,
    activatedCount: active.microFamilyIds.length
  };
}

async function activateSelected(body) {
  const microFamilyIds = normalizeMicroFamilyIds(body.microFamilyIds);

  if (!microFamilyIds.length) {
    const error = new Error('MICRO_FAMILY_IDS_REQUIRED');
    error.statusCode = 400;
    throw error;
  }

  const sourceWeekKey = firstValue(
    body.weekKey,
    getPreviousIsoWeekKey()
  );

  const active = await activateSelectedMicroFamilies({
    microFamilyIds,
    weekKey: sourceWeekKey,
    mode: 'selected'
  });

  const normalizedActive = normalizeRotation({
    ...active,
    source: 'ADMIN_ACTIVATE_SELECTED',
    sourceWeekKey,
    activeWeekKey: active.activeWeekKey || getIsoWeekKey(),
    mode: 'selected',
    activatedAt: active.activatedAt || Date.now()
  });

  await setJson(
    getDurableRedis(),
    KEYS.analyze.activeRotation,
    normalizedActive
  );

  return {
    action: 'activateSelected',
    sourceWeekKey,
    activeRotation: normalizedActive,
    active: normalizedActive,
    activatedCount: normalizedActive.microFamilyIds.length
  };
}

async function handlePost(req, res) {
  const body = await readBody(req);
  const action = String(body?.action || '').trim();

  if (!action) {
    return res.status(400).json({
      ok: false,
      reason: 'ACTION_REQUIRED',
      allowedActions: ALLOWED_ACTIONS
    });
  }

  if (action === 'activateBestBalanced') {
    const result = await activateBestBalanced(body);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelected') {
    const result = await activateSelected(body);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  return res.status(400).json({
    ok: false,
    reason: 'UNKNOWN_ACTION',
    action,
    allowedActions: ALLOWED_ACTIONS
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      return await handlePost(req, res);
    }

    return methodNotAllowed(res);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,
      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}