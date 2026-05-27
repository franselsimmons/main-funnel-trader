import fs from 'fs/promises';
import path from 'path';

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');

const ROTATION_DIR = path.join(DATA_DIR, 'rotation');

const ACTIVE_FILE = path.join(ROTATION_DIR, 'active-week.json');
const NEXT_FILE = path.join(ROTATION_DIR, 'next-week.json');
const HISTORY_FILE = path.join(ROTATION_DIR, 'history.json');

const DEFAULT_ANALYZER_FILE = path.join(
  DATA_DIR,
  'analyzer',
  'latest-microfamily-analysis.json'
);

export const ROTATION_MODE = 'WEEKLY_ANALYZER_MICRO_CHAMPIONS';
export const ROTATION_SOURCE = 'TRADESYSTEM_ANALYZER';

const DAY_MS = 86400000;

const STATUS_RANK = {
  ELITE: 7,
  HOT: 6,
  GOOD: 5,
  STABLE: 4,
  CANDIDATE: 3,
  COLLECTING: 2,
  BAD: 1,
  EMPTY: 0,
};

function getEnvFlag(key, fallback = false) {
  const value = process.env[key];

  if (value === undefined || value === null || value === '') return fallback;

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function getEnvNumber(key, fallback) {
  const value = Number(process.env[key]);

  if (!Number.isFinite(value)) return fallback;

  return value;
}

function getEnvList(key, fallback = []) {
  const value = process.env[key];

  if (!value) return fallback;

  return String(value)
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
}

function resolveProjectPath(inputPath, fallbackPath) {
  if (!inputPath) return fallbackPath;
  if (path.isAbsolute(inputPath)) return inputPath;

  return path.join(ROOT_DIR, inputPath);
}

function getAnalyzerFilePath() {
  return resolveProjectPath(
    process.env.WEEKLY_ROTATION_ANALYZER_FILE,
    DEFAULT_ANALYZER_FILE
  );
}

function toDateSafe(dateInput = new Date()) {
  const date = new Date(dateInput);

  if (Number.isNaN(date.getTime())) return new Date();

  return date;
}

function addDays(dateInput, days) {
  const date = toDateSafe(dateInput);

  return new Date(date.getTime() + days * DAY_MS);
}

export function getIsoWeekId(dateInput = new Date()) {
  const date = toDateSafe(dateInput);
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));

  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utcDate - yearStart) / DAY_MS + 1) / 7);

  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function getNextIsoWeekId(dateInput = new Date()) {
  return getIsoWeekId(addDays(dateInput, 7));
}

function getAnalyzerSnapshotDate(snapshot = {}) {
  return toDateSafe(
    snapshot.weekEndedAt ||
      snapshot.snapshotAt ||
      snapshot.generatedAt ||
      snapshot.updatedAt ||
      snapshot.createdAt ||
      new Date()
  );
}

export function createEmptyRotation({
  rotationId = getIsoWeekId(),
  status = 'EMPTY',
  sourceWindow = null,
  allowlist = [],
  meta = {},
} = {}) {
  const now = new Date().toISOString();
  const normalizedAllowlist = Array.isArray(allowlist)
    ? allowlist.map(normalizeAllowlistItem).filter(item => item.microFamilyId)
    : [];

  return {
    rotationId,
    createdAt: now,
    updatedAt: now,
    activatedAt: null,
    status,
    mode: ROTATION_MODE,
    source: ROTATION_SOURCE,
    sourceWindow,
    allowlist: normalizedAllowlist,
    meta: {
      ...meta,
      longCount: normalizedAllowlist.filter(item => item.side === 'LONG').length,
      shortCount: normalizedAllowlist.filter(item => item.side === 'SHORT').length,
      totalCount: normalizedAllowlist.length,
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

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallbackFactory) {
  await ensureParentDir(filePath);

  const fallback =
    typeof fallbackFactory === 'function' ? fallbackFactory() : fallbackFactory;

  if (!(await exists(filePath))) {
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

async function readExistingJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');

  if (!raw.trim()) {
    throw new Error(`JSON file empty: ${filePath}`);
  }

  return JSON.parse(raw);
}

async function writeJsonAtomic(filePath, data) {
  await ensureParentDir(filePath);

  const now = new Date().toISOString();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  const payloadObject = {
    ...(data || {}),
    updatedAt: now,
  };

  const payload = JSON.stringify(payloadObject, null, 2);

  await fs.writeFile(tmpPath, `${payload}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);

  return payloadObject;
}

function parseNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const cleaned = value.replace('%', '').replace(',', '.').trim();
    const parsed = Number(cleaned);

    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function parseSide(value, fallback = 'LONG') {
  const side = String(value || fallback).toUpperCase();

  return side === 'SHORT' ? 'SHORT' : 'LONG';
}

function normalizeStatus(value) {
  return String(value || 'ACTIVE').trim().toUpperCase();
}

function normalizeDefinition(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split('|')
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function extractMicroFamilyId(item = {}) {
  if (typeof item === 'string') return item.trim();

  return String(
    item.microFamilyId ||
      item.family ||
      item.familyId ||
      item.id ||
      item.key ||
      item.name ||
      ''
  ).trim();
}

function extractParentFamilyId(item = {}) {
  if (!item || typeof item !== 'object') return null;

  return (
    item.parentFamilyId ||
    item.parentFamily ||
    item.parent ||
    item.parentId ||
    item.mainFamily ||
    null
  );
}

export function normalizeAllowlistItem(item) {
  const rawItem = typeof item === 'string' ? { microFamilyId: item } : item || {};
  const microFamilyId = extractMicroFamilyId(rawItem);
  const side = parseSide(rawItem.side || rawItem.direction);

  return {
    microFamilyId,
    parentFamilyId: extractParentFamilyId(rawItem),
    level: String(rawItem.level || 'MICRO').toUpperCase(),
    side,
    status: normalizeStatus(rawItem.status || rawItem.rating || 'ACTIVE'),

    observed: parseNumber(rawItem.observed ?? rawItem.trades ?? rawItem.count, 0),
    trades: parseNumber(rawItem.trades ?? rawItem.observed ?? rawItem.count, 0),
    closed: parseNumber(
      rawItem.closed ??
        rawItem.closedTrades ??
        rawItem.closedCount ??
        rawItem.sampleSize,
      0
    ),
    wins: parseNumber(rawItem.wins, 0),
    losses: parseNumber(rawItem.losses, 0),
    breakeven: parseNumber(rawItem.breakeven ?? rawItem.be, 0),

    winrate: parseNumber(rawItem.winrate ?? rawItem.winRate, 0),
    avgR: parseNumber(rawItem.avgR ?? rawItem.averageR, 0),
    totalR: parseNumber(rawItem.totalR ?? rawItem.sumR, 0),
    pf: parseNumber(rawItem.pf ?? rawItem.profitFactor, 0),
    score: parseNumber(rawItem.score ?? rawItem.analyzerScore, 0),

    definition: normalizeDefinition(
      rawItem.definition ||
        rawItem.filterFamily ||
        rawItem.signature ||
        rawItem.filters ||
        rawItem.tags
    ),

    selectedAt: rawItem.selectedAt || new Date().toISOString(),
    source: rawItem.source || ROTATION_SOURCE,
  };
}

function dedupeAllowlist(allowlist) {
  const seen = new Set();
  const output = [];

  for (const item of allowlist) {
    const normalized = normalizeAllowlistItem(item);
    if (!normalized.microFamilyId) continue;

    const key = `${normalized.side}:${normalized.microFamilyId}`;
    if (seen.has(key)) continue;

    seen.add(key);
    output.push(normalized);
  }

  return output;
}

export function normalizeRotation(rotation = {}) {
  const allowlist = dedupeAllowlist(
    Array.isArray(rotation.allowlist) ? rotation.allowlist : []
  );

  return {
    rotationId: rotation.rotationId || getIsoWeekId(),
    createdAt: rotation.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activatedAt: rotation.activatedAt || null,
    status: rotation.status || 'READY',
    mode: rotation.mode || ROTATION_MODE,
    source: rotation.source || ROTATION_SOURCE,
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
        rotationId: getNextIsoWeekId(),
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

  return readJson(ACTIVE_FILE, () =>
    createEmptyRotation({
      status: 'NO_ACTIVE_ROTATION',
    })
  );
}

export async function loadNextRotation() {
  await ensureRotationFiles();

  return readJson(NEXT_FILE, () =>
    createEmptyRotation({
      rotationId: getNextIsoWeekId(),
      status: 'NO_NEXT_ROTATION',
    })
  );
}

export async function loadRotationHistory() {
  await ensureRotationFiles();

  return readJson(HISTORY_FILE, createEmptyHistory);
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

function getPathValue(object, dottedPath) {
  if (!object || !dottedPath) return null;

  return dottedPath.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') return null;

    return current[key];
  }, object);
}

function pickFirstPath(object, paths) {
  for (const currentPath of paths) {
    const value = getPathValue(object, currentPath);

    if (value !== undefined && value !== null && value !== '') return value;
  }

  return null;
}

function isAnalyzerFamilyRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const familyId = extractMicroFamilyId(value);
  if (!familyId) return false;

  const level = String(value.level || '').toUpperCase();
  const hasFamilyId = familyId.startsWith('MICRO_') || familyId.includes('_LONG_') || familyId.includes('_SHORT_');
  const hasStats =
    value.closed !== undefined ||
    value.trades !== undefined ||
    value.winrate !== undefined ||
    value.avgR !== undefined ||
    value.pf !== undefined;

  return hasFamilyId || level === 'MICRO' || hasStats;
}

function collectAnalyzerRows(value, output = [], depth = 0) {
  if (!value || depth > 6) return output;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAnalyzerRows(item, output, depth + 1);
    }

    return output;
  }

  if (typeof value !== 'object') return output;

  if (isAnalyzerFamilyRow(value)) {
    output.push(value);
    return output;
  }

  for (const child of Object.values(value)) {
    collectAnalyzerRows(child, output, depth + 1);
  }

  return output;
}

function inferSideFromFamilyId(familyId, fallbackSide = null) {
  const id = String(familyId || '').toUpperCase();

  if (id.includes('SHORT')) return 'SHORT';
  if (id.includes('LONG')) return 'LONG';

  return fallbackSide;
}

function enrichWinnerWithRows(winner, rows, fallbackSide) {
  const rawWinner =
    typeof winner === 'string'
      ? {
          microFamilyId: winner,
          side: fallbackSide,
        }
      : {
          ...(winner || {}),
          side: winner?.side || fallbackSide,
        };

  const familyId = extractMicroFamilyId(rawWinner);
  const rowMatch = rows.find(row => extractMicroFamilyId(row) === familyId);

  if (!rowMatch) return rawWinner;

  return {
    ...rowMatch,
    ...rawWinner,
    definition:
      rawWinner.definition ||
      rawWinner.filterFamily ||
      rawWinner.signature ||
      rowMatch.definition ||
      rowMatch.filterFamily ||
      rowMatch.signature,
    side:
      rawWinner.side ||
      rowMatch.side ||
      inferSideFromFamilyId(familyId, fallbackSide),
  };
}

function getDirectAnalyzerWinners(snapshot, rows) {
  const directLong = pickFirstPath(snapshot, [
    'bestMainLong',
    'bestMicroLong',
    'bestLong',
    'best.long',
    'winnerLong',
    'winners.long',
    'mainMicrofamily.bestMainLong',
    'mainMicrofamily.bestLong',
    'mainMicrofamilyAnalyzer.bestMainLong',
    'mainMicrofamilyAnalyzer.bestLong',
    'micro.bestMainLong',
    'micro.bestLong',
    'microfamily.bestMainLong',
    'microfamily.bestLong',
  ]);

  const directShort = pickFirstPath(snapshot, [
    'bestMainShort',
    'bestMicroShort',
    'bestShort',
    'best.short',
    'winnerShort',
    'winners.short',
    'mainMicrofamily.bestMainShort',
    'mainMicrofamily.bestShort',
    'mainMicrofamilyAnalyzer.bestMainShort',
    'mainMicrofamilyAnalyzer.bestShort',
    'micro.bestMainShort',
    'micro.bestShort',
    'microfamily.bestMainShort',
    'microfamily.bestShort',
  ]);

  const winners = [];

  if (directLong) {
    winners.push(enrichWinnerWithRows(directLong, rows, 'LONG'));
  }

  if (directShort) {
    winners.push(enrichWinnerWithRows(directShort, rows, 'SHORT'));
  }

  return winners;
}

function getAcceptedStatuses() {
  return getEnvList('WEEKLY_ROTATION_ACCEPT_STATUSES', [
    'ELITE',
    'HOT',
    'GOOD',
    'STABLE',
  ]);
}

function getMinClosedForSide(side) {
  if (side === 'SHORT') {
    return getEnvNumber(
      'WEEKLY_ROTATION_MIN_CLOSED_SHORT',
      getEnvNumber('WEEKLY_ROTATION_MIN_CLOSED', 6)
    );
  }

  return getEnvNumber(
    'WEEKLY_ROTATION_MIN_CLOSED_LONG',
    getEnvNumber('WEEKLY_ROTATION_MIN_CLOSED', 6)
  );
}

function passesAnalyzerGuards(row, side) {
  const normalized = normalizeAllowlistItem({
    ...row,
    side: row.side || inferSideFromFamilyId(extractMicroFamilyId(row), side),
  });

  if (!normalized.microFamilyId) return false;
  if (normalized.side !== side) return false;

  const requiredLevel = String(process.env.WEEKLY_ROTATION_LEVEL || 'MICRO').toUpperCase();
  if (requiredLevel && normalized.level && normalized.level !== requiredLevel) return false;

  const acceptedStatuses = getAcceptedStatuses();
  if (!acceptedStatuses.includes(normalized.status)) return false;

  const minClosed = getMinClosedForSide(side);
  if (normalized.closed < minClosed) return false;

  const minAvgR = getEnvNumber('WEEKLY_ROTATION_MIN_AVG_R', 0);
  if (normalized.avgR <= minAvgR) return false;

  const minPf = getEnvNumber('WEEKLY_ROTATION_MIN_PF', 1);
  if (normalized.pf > 0 && normalized.pf < minPf) return false;

  return true;
}

function scoreAnalyzerRow(row) {
  const normalized = normalizeAllowlistItem(row);

  const statusScore = STATUS_RANK[normalized.status] ?? 0;
  const closedScore = Math.min(normalized.closed, 50) / 50;
  const avgRScore = Math.max(-1, Math.min(normalized.avgR, 2));
  const pfScore = Math.max(0, Math.min(normalized.pf, 10)) / 10;
  const winrateScore = Math.max(0, Math.min(normalized.winrate, 100)) / 100;

  return (
    statusScore * 100000 +
    closedScore * 5000 +
    avgRScore * 2000 +
    pfScore * 1000 +
    winrateScore * 500
  );
}

function pickBestFallbackRow(rows, side) {
  return rows
    .filter(row => passesAnalyzerGuards(row, side))
    .sort((a, b) => scoreAnalyzerRow(b) - scoreAnalyzerRow(a))[0];
}

export function selectAnalyzerWinners(snapshot = {}) {
  const rows = collectAnalyzerRows(snapshot);
  const directWinners = getDirectAnalyzerWinners(snapshot, rows)
    .map(normalizeAllowlistItem)
    .filter(item => item.microFamilyId);

  const hasLong = directWinners.some(item => item.side === 'LONG');
  const hasShort = directWinners.some(item => item.side === 'SHORT');

  const winners = [...directWinners];

  if (!hasLong) {
    const fallbackLong = pickBestFallbackRow(rows, 'LONG');

    if (fallbackLong) winners.push(normalizeAllowlistItem(fallbackLong));
  }

  if (!hasShort) {
    const fallbackShort = pickBestFallbackRow(rows, 'SHORT');

    if (fallbackShort) winners.push(normalizeAllowlistItem(fallbackShort));
  }

  return dedupeAllowlist(winners)
    .filter(item => ['LONG', 'SHORT'].includes(item.side))
    .slice(0, 2);
}

export function buildNextRotationFromAnalyzerSnapshot(snapshot = {}) {
  const snapshotDate = getAnalyzerSnapshotDate(snapshot);
  const sourceWeekId =
    snapshot.sourceWeekId ||
    snapshot.weekId ||
    snapshot.isoWeekId ||
    getIsoWeekId(snapshotDate);

  const targetWeekId =
    snapshot.targetWeekId ||
    snapshot.nextWeekId ||
    getIsoWeekId(addDays(snapshotDate, 7));

  const allowlist = selectAnalyzerWinners(snapshot);

  const status = allowlist.length > 0
    ? 'READY_FROM_ANALYZER'
    : 'NO_ANALYZER_WINNERS';

  return normalizeRotation({
    rotationId: targetWeekId,
    status,
    mode: ROTATION_MODE,
    source: ROTATION_SOURCE,
    sourceWindow: {
      type: 'CURRENT_WEEK_ANALYZER_TO_NEXT_WEEK',
      sourceWeekId,
      targetWeekId,
      analyzerUpdatedAt:
        snapshot.updatedAt ||
        snapshot.snapshotAt ||
        snapshot.generatedAt ||
        null,
      analyzerFile: getAnalyzerFilePath(),
    },
    allowlist,
    meta: {
      source: ROTATION_SOURCE,
      winnerSource: 'ANALYZER_BEST_MAIN_LONG_SHORT',
      sourceWeekId,
      targetWeekId,
      analyzerUpdatedAt:
        snapshot.updatedAt ||
        snapshot.snapshotAt ||
        snapshot.generatedAt ||
        null,
    },
  });
}

export async function syncNextRotationFromAnalyzerFile({
  analyzerFile = getAnalyzerFilePath(),
  overwriteEmpty = getEnvFlag('WEEKLY_ROTATION_OVERWRITE_NEXT_WITH_EMPTY', false),
} = {}) {
  await ensureRotationFiles();

  if (!(await exists(analyzerFile))) {
    return {
      synced: false,
      reason: 'ANALYZER_FILE_NOT_FOUND',
      analyzerFile,
    };
  }

  const snapshot = await readExistingJson(analyzerFile);
  const nextRotation = buildNextRotationFromAnalyzerSnapshot(snapshot);

  if (!nextRotation.allowlist.length && !overwriteEmpty) {
    return {
      synced: false,
      reason: 'NO_ANALYZER_WINNERS_KEEPING_EXISTING_NEXT',
      analyzerFile,
      nextCandidate: nextRotation,
    };
  }

  const saved = await saveNextRotation(nextRotation);

  return {
    synced: true,
    reason: 'NEXT_ROTATION_SYNCED_FROM_ANALYZER',
    analyzerFile,
    next: saved,
  };
}

export async function promoteNextRotationToActive({
  now = new Date(),
  force = false,
} = {}) {
  await ensureRotationFiles();

  const currentWeekId = getIsoWeekId(now);
  const active = await loadActiveRotation();
  const next = await loadNextRotation();

  if (!force && next.rotationId !== currentWeekId) {
    return {
      promoted: false,
      reason: 'NEXT_ROTATION_NOT_FOR_CURRENT_WEEK',
      currentWeekId,
      active,
      next,
    };
  }

  if (!Array.isArray(next.allowlist) || next.allowlist.length === 0) {
    return {
      promoted: false,
      reason: 'NEXT_ROTATION_EMPTY',
      currentWeekId,
      active,
      next,
    };
  }

  await appendRotationHistory(active, {
    replacedBy: next.rotationId,
    replaceReason: 'WEEKLY_ANALYZER_ROTATION',
  });

  const promoted = normalizeRotation({
    ...next,
    rotationId: currentWeekId,
    status: 'ACTIVE',
    activatedAt: new Date().toISOString(),
  });

  await saveActiveRotation(promoted);

  const freshNext = createEmptyRotation({
    rotationId: getNextIsoWeekId(now),
    status: 'NO_NEXT_ROTATION',
    sourceWindow: {
      type: 'WAITING_FOR_ANALYZER_CURRENT_WEEK',
      sourceWeekId: currentWeekId,
      targetWeekId: getNextIsoWeekId(now),
    },
  });

  await saveNextRotation(freshNext);

  return {
    promoted: true,
    reason: 'NEXT_ROTATION_PROMOTED_TO_ACTIVE',
    active: promoted,
    next: freshNext,
  };
}

export async function activateWeeklyRotationIfNeeded({
  now = new Date(),
} = {}) {
  await ensureRotationFiles();

  const currentWeekId = getIsoWeekId(now);
  const active = await loadActiveRotation();

  if (active.rotationId === currentWeekId && active.status === 'ACTIVE') {
    return {
      changed: false,
      reason: 'ACTIVE_ROTATION_ALREADY_CURRENT',
      active,
    };
  }

  const promoted = await promoteNextRotationToActive({
    now,
    force: false,
  });

  if (promoted.promoted) {
    return {
      changed: true,
      reason: promoted.reason,
      active: promoted.active,
      next: promoted.next,
    };
  }

  const failClosed = getEnvFlag('WEEKLY_ROTATION_FAIL_CLOSED', true);

  if (!failClosed) {
    return {
      changed: false,
      reason: 'NO_PROMOTION_AVAILABLE_KEEPING_ACTIVE',
      active,
      promotionResult: promoted,
    };
  }

  await appendRotationHistory(active, {
    replacedBy: null,
    replaceReason: 'FAIL_CLOSED_NO_VALID_NEXT_ROTATION',
  });

  const emptyActive = createEmptyRotation({
    rotationId: currentWeekId,
    status: 'NO_ACTIVE_ROTATION',
    sourceWindow: {
      type: 'FAIL_CLOSED_NO_VALID_NEXT_ROTATION',
      sourceWeekId: null,
      targetWeekId: currentWeekId,
    },
  });

  await saveActiveRotation(emptyActive);

  return {
    changed: true,
    reason: 'FAIL_CLOSED_EMPTY_ACTIVE_ROTATION',
    active: emptyActive,
    promotionResult: promoted,
  };
}

export async function clearActiveRotation(reason = 'MANUAL_CLEAR') {
  const active = await loadActiveRotation();

  await appendRotationHistory(active, {
    cleared: true,
    clearReason: reason,
  });

  const empty = createEmptyRotation({
    rotationId: getIsoWeekId(),
    status: 'NO_ACTIVE_ROTATION',
  });

  await saveActiveRotation(empty);

  return empty;
}

export async function runRotationMaintenanceOnce() {
  const promotionResult = await activateWeeklyRotationIfNeeded();

  const useAnalyzer = getEnvFlag('WEEKLY_ROTATION_USE_ANALYZER', true);
  const syncNext = getEnvFlag('WEEKLY_ROTATION_SYNC_NEXT_FROM_ANALYZER', true);

  if (!useAnalyzer || !syncNext) {
    return {
      promotionResult,
      syncResult: {
        synced: false,
        reason: 'ANALYZER_SYNC_DISABLED',
      },
    };
  }

  const syncResult = await syncNextRotationFromAnalyzerFile();

  return {
    promotionResult,
    syncResult,
  };
}

export function startRotationMaintenanceLoop({
  intervalMs = getEnvNumber('WEEKLY_ROTATION_SYNC_INTERVAL_MS', 60000),
} = {}) {
  if (!getEnvFlag('WEEKLY_ROTATION_AUTO_MAINTENANCE', true)) {
    return null;
  }

  const run = async () => {
    try {
      await runRotationMaintenanceOnce();
    } catch (error) {
      console.error('[rotationStore] maintenance failed:', error?.message || error);
    }
  };

  run();

  const timer = setInterval(run, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return timer;
}

export function getActiveMicroFamilyIds(rotation, side = null) {
  if (!rotation || !Array.isArray(rotation.allowlist)) return [];

  return rotation.allowlist
    .filter(item => !side || item.side === side)
    .map(item => item.microFamilyId)
    .filter(Boolean);
}

export function isMicroFamilyActive(rotation, microFamilyId, side = null) {
  if (!rotation || !microFamilyId) return false;
  if (!Array.isArray(rotation.allowlist)) return false;

  const normalizedSide = side ? parseSide(side) : null;

  return rotation.allowlist.some(item => {
    if (item.microFamilyId !== microFamilyId) return false;
    if (normalizedSide && item.side !== normalizedSide) return false;

    return true;
  });
}

export function isEntryAllowedByRotation(rotation, entry = {}) {
  const liveGateEnabled = getEnvFlag('WEEKLY_ROTATION_LIVE_GATE', true);

  if (!liveGateEnabled) {
    return {
      allowed: true,
      reason: 'ROTATION_GATE_DISABLED',
    };
  }

  if (!rotation || !Array.isArray(rotation.allowlist)) {
    return {
      allowed: false,
      reason: 'ROTATION_MISSING',
    };
  }

  if (!rotation.allowlist.length) {
    const emptyPolicy = String(
      process.env.WEEKLY_ROTATION_EMPTY_POLICY || 'DENY_ALL'
    ).toUpperCase();

    return {
      allowed: emptyPolicy !== 'DENY_ALL',
      reason: emptyPolicy === 'DENY_ALL'
        ? 'ROTATION_EMPTY_DENY_ALL'
        : 'ROTATION_EMPTY_ALLOW',
    };
  }

  const microFamilyId = String(
    entry.microFamilyId ||
      entry.family ||
      entry.familyId ||
      entry.id ||
      ''
  ).trim();

  if (!microFamilyId) {
    return {
      allowed: false,
      reason: 'ENTRY_MICRO_FAMILY_MISSING',
    };
  }

  const requireSideMatch = getEnvFlag('WEEKLY_ROTATION_REQUIRE_SIDE_MATCH', true);
  const side = requireSideMatch ? parseSide(entry.side || entry.direction) : null;

  const allowed = isMicroFamilyActive(rotation, microFamilyId, side);

  return {
    allowed,
    reason: allowed ? 'MICRO_FAMILY_ACTIVE' : 'MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION',
    microFamilyId,
    side,
    rotationId: rotation.rotationId,
  };
}

export const rotationPaths = {
  dir: ROTATION_DIR,
  active: ACTIVE_FILE,
  next: NEXT_FILE,
  history: HISTORY_FILE,
  analyzer: getAnalyzerFilePath(),
};