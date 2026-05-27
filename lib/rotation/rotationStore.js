import fs from 'fs/promises';
import path from 'path';

const ROOT_DIR = process.cwd();
const ROTATION_DIR = path.join(ROOT_DIR, 'data', 'rotation');

const ACTIVE_FILE = path.join(ROTATION_DIR, 'active-week.json');
const NEXT_FILE = path.join(ROTATION_DIR, 'next-week.json');
const HISTORY_FILE = path.join(ROTATION_DIR, 'history.json');

export const ROTATION_MODE = 'WEEKLY_MICRO_CHAMPIONS';

export function getIsoWeekId(dateInput = new Date()) {
  const date = new Date(dateInput);
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));

  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utcDate - yearStart) / 86400000 + 1) / 7);

  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function createEmptyRotation({
  rotationId = getIsoWeekId(),
  status = 'EMPTY',
  sourceWindow = null,
  allowlist = [],
} = {}) {
  const now = new Date().toISOString();

  return {
    rotationId,
    createdAt: now,
    updatedAt: now,
    activatedAt: null,
    status,
    mode: ROTATION_MODE,
    sourceWindow,
    allowlist,
    meta: {
      longCount: allowlist.filter(item => item.side === 'LONG').length,
      shortCount: allowlist.filter(item => item.side === 'SHORT').length,
      totalCount: allowlist.length,
    },
  };
}

function createEmptyHistory() {
  return {
    updatedAt: new Date().toISOString(),
    rotations: [],
  };
}

async function ensureDir() {
  await fs.mkdir(ROTATION_DIR, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  await ensureDir();

  const fileExists = await exists(filePath);

  if (!fileExists) {
    await writeJsonAtomic(filePath, fallback);
    return fallback;
  }

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  await ensureDir();

  const tmpPath = `${filePath}.tmp`;
  const updatedAt = new Date().toISOString();

  const payload = JSON.stringify(
    {
      ...data,
      updatedAt,
    },
    null,
    2
  );

  await fs.writeFile(tmpPath, `${payload}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);

  return {
    ...data,
    updatedAt,
  };
}

export async function ensureRotationFiles() {
  await ensureDir();

  if (!(await exists(ACTIVE_FILE))) {
    await writeJsonAtomic(
      ACTIVE_FILE,
      createEmptyRotation({
        status: 'NO_ACTIVE_ROTATION',
      })
    );
  }

  if (!(await exists(NEXT_FILE))) {
    await writeJsonAtomic(
      NEXT_FILE,
      createEmptyRotation({
        rotationId: getIsoWeekId(new Date(Date.now() + 7 * 86400000)),
        status: 'NO_NEXT_ROTATION',
      })
    );
  }

  if (!(await exists(HISTORY_FILE))) {
    await writeJsonAtomic(HISTORY_FILE, createEmptyHistory());
  }

  return true;
}

export async function loadActiveRotation() {
  await ensureRotationFiles();

  return readJson(
    ACTIVE_FILE,
    createEmptyRotation({
      status: 'NO_ACTIVE_ROTATION',
    })
  );
}

export async function loadNextRotation() {
  await ensureRotationFiles();

  return readJson(
    NEXT_FILE,
    createEmptyRotation({
      rotationId: getIsoWeekId(new Date(Date.now() + 7 * 86400000)),
      status: 'NO_NEXT_ROTATION',
    })
  );
}

export async function loadRotationHistory() {
  await ensureRotationFiles();

  return readJson(HISTORY_FILE, createEmptyHistory());
}

export async function saveActiveRotation(rotation) {
  if (!rotation || typeof rotation !== 'object') {
    throw new Error('saveActiveRotation: rotation object missing');
  }

  return writeJsonAtomic(ACTIVE_FILE, normalizeRotation(rotation));
}

export async function saveNextRotation(rotation) {
  if (!rotation || typeof rotation !== 'object') {
    throw new Error('saveNextRotation: rotation object missing');
  }

  return writeJsonAtomic(NEXT_FILE, normalizeRotation(rotation));
}

export async function saveRotationHistory(history) {
  if (!history || typeof history !== 'object') {
    throw new Error('saveRotationHistory: history object missing');
  }

  const safeHistory = {
    updatedAt: new Date().toISOString(),
    rotations: Array.isArray(history.rotations) ? history.rotations : [],
  };

  return writeJsonAtomic(HISTORY_FILE, safeHistory);
}

export async function appendRotationHistory(rotation, extra = {}) {
  const history = await loadRotationHistory();

  const record = {
    ...rotation,
    ...extra,
    archivedAt: new Date().toISOString(),
  };

  const nextHistory = {
    updatedAt: new Date().toISOString(),
    rotations: [record, ...(history.rotations || [])].slice(0, 104),
  };

  await saveRotationHistory(nextHistory);

  return record;
}

export async function promoteNextRotationToActive() {
  const active = await loadActiveRotation();
  const next = await loadNextRotation();

  if (!Array.isArray(next.allowlist) || next.allowlist.length === 0) {
    return {
      promoted: false,
      reason: 'NEXT_ROTATION_EMPTY',
      active,
      next,
    };
  }

  await appendRotationHistory(active, {
    replacedBy: next.rotationId,
  });

  const promoted = normalizeRotation({
    ...next,
    status: 'ACTIVE',
    activatedAt: new Date().toISOString(),
  });

  await saveActiveRotation(promoted);

  const freshNext = createEmptyRotation({
    rotationId: getIsoWeekId(new Date(Date.now() + 7 * 86400000)),
    status: 'NO_NEXT_ROTATION',
  });

  await saveNextRotation(freshNext);

  return {
    promoted: true,
    reason: 'NEXT_ROTATION_PROMOTED',
    active: promoted,
    next: freshNext,
  };
}

export async function clearActiveRotation(reason = 'MANUAL_CLEAR') {
  const active = await loadActiveRotation();

  await appendRotationHistory(active, {
    cleared: true,
    clearReason: reason,
  });

  const empty = createEmptyRotation({
    status: 'NO_ACTIVE_ROTATION',
  });

  await saveActiveRotation(empty);

  return empty;
}

export function normalizeRotation(rotation) {
  const allowlist = Array.isArray(rotation.allowlist)
    ? rotation.allowlist
        .filter(Boolean)
        .map(normalizeAllowlistItem)
        .filter(item => item.microFamilyId)
    : [];

  return {
    rotationId: rotation.rotationId || getIsoWeekId(),
    createdAt: rotation.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activatedAt: rotation.activatedAt || null,
    status: rotation.status || 'READY',
    mode: rotation.mode || ROTATION_MODE,
    sourceWindow: rotation.sourceWindow || null,
    allowlist,
    meta: {
      ...(rotation.meta || {}),
      longCount: allowlist.filter(item => item.side === 'LONG').length,
      shortCount: allowlist.filter(item => item.side === 'SHORT').length,
      totalCount: allowlist.length,
    },
  };
}

export function normalizeAllowlistItem(item) {
  return {
    microFamilyId: String(item.microFamilyId || item.familyId || '').trim(),
    parentFamilyId: item.parentFamilyId || item.parent || null,
    side: item.side === 'SHORT' ? 'SHORT' : 'LONG',
    status: item.status || 'ACTIVE',

    closed: Number(item.closed || 0),
    wins: Number(item.wins || 0),
    losses: Number(item.losses || 0),

    winrate: Number(item.winrate || 0),
    avgR: Number(item.avgR || 0),
    totalR: Number(item.totalR || 0),
    pf: Number(item.pf || 0),
    score: Number(item.score || 0),

    definition: Array.isArray(item.definition)
      ? item.definition
      : typeof item.definition === 'string'
        ? item.definition.split('|').map(part => part.trim()).filter(Boolean)
        : [],

    selectedAt: item.selectedAt || new Date().toISOString(),
  };
}

export function getActiveMicroFamilyIds(rotation, side = null) {
  if (!rotation || !Array.isArray(rotation.allowlist)) return [];

  return rotation.allowlist
    .filter(item => !side || item.side === side)
    .filter(item => String(item.status || 'ACTIVE').toUpperCase() === 'ACTIVE')
    .map(item => item.microFamilyId)
    .filter(Boolean);
}

export function isMicroFamilyActive(rotation, microFamilyId, side = null) {
  if (!rotation || !microFamilyId) return false;
  if (!Array.isArray(rotation.allowlist)) return false;

  return rotation.allowlist.some(item => {
    if (String(item.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') return false;
    if (item.microFamilyId !== microFamilyId) return false;
    if (side && item.side !== side) return false;

    return true;
  });
}

// ================= ROTATION STATUS COMPAT HELPERS =================
// rotationTradeAdapter.js zoekt named exports zoals:
// loadRotationStatus / getRotationStatus / readRotationStatus /
// loadWeeklyRotationStatus / getWeeklyRotationStatus /
// loadActiveRotationStatus / getRotationState / etc.

function normalizeRotationSide(side) {
  const value = String(side || '').toUpperCase();

  if (value === 'BULL') return 'LONG';
  if (value === 'BEAR') return 'SHORT';
  if (value === 'LONG') return 'LONG';
  if (value === 'SHORT') return 'SHORT';

  return value || null;
}

function isRotationActive(rotation) {
  if (!rotation || typeof rotation !== 'object') return false;

  const status = String(rotation.status || '').toUpperCase();
  const allowlist = Array.isArray(rotation.allowlist) ? rotation.allowlist : [];

  if (!allowlist.length) return false;

  return ['ACTIVE', 'READY', 'LIVE'].includes(status);
}

function getActiveAllowlist(rotation, side = null) {
  if (!rotation || !Array.isArray(rotation.allowlist)) return [];

  const normalizedSide = normalizeRotationSide(side);

  return rotation.allowlist
    .map(normalizeAllowlistItem)
    .filter(item => String(item.status || 'ACTIVE').toUpperCase() === 'ACTIVE')
    .filter(item => !normalizedSide || item.side === normalizedSide);
}

function unique(values) {
  return Array.from(
    new Set(
      values
        .map(value => String(value || '').trim())
        .filter(Boolean)
    )
  );
}

export function buildRotationStatus(rotation) {
  const safeRotation = normalizeRotation(rotation || createEmptyRotation({
    status: 'NO_ACTIVE_ROTATION',
  }));

  const activeAllowlist = getActiveAllowlist(safeRotation);
  const active = isRotationActive(safeRotation);

  const longItems = activeAllowlist.filter(item => item.side === 'LONG');
  const shortItems = activeAllowlist.filter(item => item.side === 'SHORT');

  const microFamilyIds = unique(activeAllowlist.map(item => item.microFamilyId));
  const familyIds = unique([
    ...activeAllowlist.map(item => item.parentFamilyId),
    ...activeAllowlist.map(item => item.microFamilyId),
  ]);

  const longMicroFamilyIds = unique(longItems.map(item => item.microFamilyId));
  const shortMicroFamilyIds = unique(shortItems.map(item => item.microFamilyId));

  const status = active
    ? 'ACTIVE'
    : safeRotation.status || 'NO_ACTIVE_ROTATION';

  return {
    ...safeRotation,

    active,
    isActive: active,
    enabled: active,

    status,
    reason: active
      ? 'ACTIVE_ROTATION_LOADED'
      : 'NO_ACTIVE_ROTATION',

    activeRotation: active ? safeRotation : null,
    activeRotationId: active ? safeRotation.rotationId : null,
    rotationId: safeRotation.rotationId,

    mode: safeRotation.mode || ROTATION_MODE,

    allowlist: activeAllowlist,

    allowedSides: [
      longItems.length ? 'LONG' : null,
      shortItems.length ? 'SHORT' : null,
    ].filter(Boolean),

    side: null,
    tradeSide: null,
    rotationSide: null,

    familyIds,
    families: familyIds,
    microFamilyIds,
    microFamilies: microFamilyIds,

    longFamilyIds: unique([
      ...longItems.map(item => item.parentFamilyId),
      ...longItems.map(item => item.microFamilyId),
    ]),
    longMicroFamilyIds,

    shortFamilyIds: unique([
      ...shortItems.map(item => item.parentFamilyId),
      ...shortItems.map(item => item.microFamilyId),
    ]),
    shortMicroFamilyIds,

    symbols: [],
    allowedSymbols: [],

    counts: {
      long: longItems.length,
      short: shortItems.length,
      total: activeAllowlist.length,
    },

    meta: {
      ...(safeRotation.meta || {}),
      longCount: longItems.length,
      shortCount: shortItems.length,
      totalCount: activeAllowlist.length,
    },

    updatedAt: safeRotation.updatedAt || new Date().toISOString(),
    ts: Date.now(),
  };
}

export async function loadRotationStatus() {
  const activeRotation = await loadActiveRotation();
  return buildRotationStatus(activeRotation);
}

export const getRotationStatus = loadRotationStatus;
export const readRotationStatus = loadRotationStatus;

export const loadWeeklyRotationStatus = loadRotationStatus;
export const getWeeklyRotationStatus = loadRotationStatus;
export const readWeeklyRotationStatus = loadRotationStatus;

export const loadActiveRotationStatus = loadRotationStatus;
export const getActiveRotationStatus = loadRotationStatus;

export const loadRotationState = loadRotationStatus;
export const getRotationState = loadRotationStatus;
export const readRotationState = loadRotationStatus;

export const rotationPaths = {
  dir: ROTATION_DIR,
  active: ACTIVE_FILE,
  next: NEXT_FILE,
  history: HISTORY_FILE,
};