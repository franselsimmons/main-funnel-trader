// lib/rotation/rotationStore.js

import fs from "fs/promises";
import path from "path";
import os from "os";

const ROOT_DIR = process.cwd();

function isReadonlyRuntime() {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT ||
      String(ROOT_DIR).startsWith("/var/task")
  );
}

function resolveBaseDataDir() {
  if (process.env.DATA_DIR) {
    return path.isAbsolute(process.env.DATA_DIR)
      ? process.env.DATA_DIR
      : path.join(ROOT_DIR, process.env.DATA_DIR);
  }

  return isReadonlyRuntime()
    ? path.join(os.tmpdir(), "data")
    : path.join(ROOT_DIR, "data");
}

const DATA_DIR = resolveBaseDataDir();
const ROTATION_DIR = path.join(DATA_DIR, "rotation");

const ACTIVE_FILE = path.join(ROTATION_DIR, "active-week.json");
const NEXT_FILE = path.join(ROTATION_DIR, "next-week.json");
const HISTORY_FILE = path.join(ROTATION_DIR, "history.json");

const DEFAULT_ANALYZER_FILE = path.join(
  DATA_DIR,
  "analyzer",
  "latest-microfamily-analysis.json"
);

export const ROTATION_MODE = "WEEKLY_ANALYZER_MICRO_CHAMPIONS";
export const ROTATION_SOURCE = "TRADESYSTEM_ANALYZER";

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

const USABLE_ACTIVE_STATUSES = new Set([
  "ACTIVE",
  "READY",
  "READY_FROM_ANALYZER",
]);

// ================= ENV / PATH HELPERS =================

function getEnvFlag(key, fallback = false) {
  const value = process.env[key];

  if (value === undefined || value === null || value === "") return fallback;

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
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
    .split(",")
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
    process.env.WEEKLY_ROTATION_ANALYZER_FILE ||
      process.env.ANALYZER_MICRO_ROTATION_EXPORT_FILE,
    DEFAULT_ANALYZER_FILE
  );
}

// ================= DATE HELPERS =================

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

  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
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

// ================= NORMALIZATION HELPERS =================

function parseNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const cleaned = value.replace("%", "").replace(",", ".").trim();
    const parsed = Number(cleaned);

    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function parseSide(value, fallback = "LONG") {
  const side = String(value || fallback).toUpperCase();

  if (["SHORT", "BEAR", "SELL"].includes(side)) return "SHORT";
  if (["LONG", "BULL", "BUY"].includes(side)) return "LONG";

  return fallback === "SHORT" ? "SHORT" : "LONG";
}

function normalizeStatus(value) {
  return String(value || "ACTIVE").trim().toUpperCase();
}

function normalizeDefinition(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split("|")
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function cleanFamilyId(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.%+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractMicroFamilyId(item = {}) {
  if (typeof item === "string") return cleanFamilyId(item);

  return cleanFamilyId(
    item.microFamilyId ||
      item.familyId ||
      item.family ||
      item.id ||
      item.key ||
      item.name ||
      ""
  );
}

function extractParentFamilyId(item = {}) {
  if (!item || typeof item !== "object") return null;

  return (
    item.parentFamilyId ||
    item.parentFamily ||
    item.parent ||
    item.parentId ||
    item.mainFamily ||
    null
  );
}

function inferSideFromFamilyId(familyId, fallbackSide = null) {
  const id = cleanFamilyId(familyId);

  if (id.includes("SHORT")) return "SHORT";
  if (id.includes("LONG")) return "LONG";

  return fallbackSide;
}

function inferLevelFromFamilyId(familyId, fallbackLevel = "MICRO") {
  const id = cleanFamilyId(familyId);

  if (!id) return String(fallbackLevel || "MICRO").toUpperCase();

  if (id.startsWith("MICRO_")) return "MICRO";
  if (id.includes("_MICRO_")) return "MICRO";

  if (id.startsWith("PARENT_")) return "PARENT";
  if (id.startsWith("SUB_")) return "SUB";

  if (/^(LONG|SHORT)_UNKNOWN$/.test(id)) return "PARENT";
  if (/^(LONG|SHORT)_\d+$/.test(id)) return "PARENT";

  return String(fallbackLevel || "MICRO").toUpperCase();
}

function isRealMicroFamilyId(familyId) {
  const id = cleanFamilyId(familyId);

  return (
    id.startsWith("MICRO_") &&
    id.split("_").length >= 4 &&
    !id.includes("UNKNOWN")
  );
}

function isBlockedFamilyId(familyId) {
  const id = cleanFamilyId(familyId);

  if (!id) return true;
  if (id.includes("UNKNOWN")) return true;

  // Parent/sub families mogen nooit live-gate source worden.
  if (id.startsWith("PARENT_")) return true;
  if (id.startsWith("SUB_")) return true;
  if (/^(LONG|SHORT)_UNKNOWN$/.test(id)) return true;
  if (/^(LONG|SHORT)_\d+$/.test(id)) return true;

  // Oude MF_* fallback keys mogen niet meer als weekly analyzer rotation dienen.
  if (id.startsWith("MF_")) return true;
  if (id.startsWith("FAMILY_")) return true;

  return false;
}

function isStrictMicroFamilyRaw(item = {}) {
  const familyId = extractMicroFamilyId(item);
  const level = String(
    item?.level || inferLevelFromFamilyId(familyId, "MICRO")
  ).toUpperCase();

  if (!familyId) return false;
  if (level !== "MICRO") return false;
  if (!isRealMicroFamilyId(familyId)) return false;
  if (isBlockedFamilyId(familyId)) return false;

  return true;
}

// ================= ALLOWLIST NORMALIZATION =================

export function normalizeAllowlistItem(item) {
  const rawItem = typeof item === "string" ? { microFamilyId: item } : item || {};
  const microFamilyId = extractMicroFamilyId(rawItem);

  const inferredSide = inferSideFromFamilyId(microFamilyId, "LONG");
  const side = parseSide(rawItem.side || rawItem.direction, inferredSide);

  const level = String(
    rawItem.level || inferLevelFromFamilyId(microFamilyId, "MICRO")
  ).toUpperCase();

  return {
    microFamilyId,
    parentFamilyId: extractParentFamilyId(rawItem),
    level,
    side,
    status: normalizeStatus(rawItem.status || rawItem.rating || "ACTIVE"),

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

    winrate: parseNumber(
      rawItem.winrate ??
        rawItem.winRate ??
        rawItem.winrateNum,
      0
    ),
    avgR: parseNumber(rawItem.avgR ?? rawItem.averageR, 0),
    totalR: parseNumber(rawItem.totalR ?? rawItem.sumR, 0),
    pf: parseNumber(rawItem.pf ?? rawItem.profitFactorR ?? rawItem.profitFactor, 0),
    score: parseNumber(rawItem.score ?? rawItem.analyzerScore ?? rawItem.rotationScore, 0),

    definition: normalizeDefinition(
      rawItem.definition ||
        rawItem.definitionParts ||
        rawItem.filterFamily ||
        rawItem.signature ||
        rawItem.filters ||
        rawItem.tags
    ),

    selectedAt: rawItem.selectedAt || new Date().toISOString(),
    source: rawItem.source || ROTATION_SOURCE,
  };
}

function isStrictMicroAllowlistItem(item) {
  const normalized = normalizeAllowlistItem(item);

  if (!normalized.microFamilyId) return false;
  if (normalized.level !== "MICRO") return false;
  if (!isRealMicroFamilyId(normalized.microFamilyId)) return false;
  if (isBlockedFamilyId(normalized.microFamilyId)) return false;

  return true;
}

function dedupeAllowlist(allowlist) {
  const seen = new Set();
  const output = [];

  for (const item of allowlist) {
    const normalized = normalizeAllowlistItem(item);

    if (!isStrictMicroAllowlistItem(normalized)) continue;

    const key = `${normalized.side}:${normalized.microFamilyId}`;
    if (seen.has(key)) continue;

    seen.add(key);
    output.push(normalized);
  }

  return output;
}

// ================= ROTATION OBJECTS =================

export function createEmptyRotation({
  rotationId = getIsoWeekId(),
  status = "EMPTY",
  sourceWindow = null,
  allowlist = [],
  meta = {},
} = {}) {
  const now = new Date().toISOString();
  const normalizedAllowlist = Array.isArray(allowlist)
    ? dedupeAllowlist(allowlist)
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
    activeMicroFamilyIds: normalizedAllowlist.map(item => item.microFamilyId),
    allowedMicroFamilyIds: normalizedAllowlist.map(item => item.microFamilyId),
    meta: {
      ...meta,
      microOnly: true,
      parentDisabled: true,
      subDisabled: true,
      longCount: normalizedAllowlist.filter(item => item.side === "LONG").length,
      shortCount: normalizedAllowlist.filter(item => item.side === "SHORT").length,
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

export function normalizeRotation(rotation = {}) {
  const allowlist = dedupeAllowlist(
    Array.isArray(rotation.allowlist) ? rotation.allowlist : []
  );

  return {
    rotationId: rotation.rotationId || getIsoWeekId(),
    createdAt: rotation.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activatedAt: rotation.activatedAt || null,
    status: rotation.status || "READY",
    mode: rotation.mode || ROTATION_MODE,
    source: rotation.source || ROTATION_SOURCE,
    sourceWindow: rotation.sourceWindow || null,
    allowlist,
    activeMicroFamilyIds: allowlist.map(item => item.microFamilyId),
    allowedMicroFamilyIds: allowlist.map(item => item.microFamilyId),
    meta: {
      ...(rotation.meta || {}),
      microOnly: true,
      parentDisabled: true,
      subDisabled: true,
      longCount: allowlist.filter(item => item.side === "LONG").length,
      shortCount: allowlist.filter(item => item.side === "SHORT").length,
      totalCount: allowlist.length,
    },
  };
}

function normalizeLoadedRotation(rotation = {}) {
  const allowlist = dedupeAllowlist(
    Array.isArray(rotation.allowlist) ? rotation.allowlist : []
  );

  return {
    ...rotation,
    allowlist,
    activeMicroFamilyIds: allowlist.map(item => item.microFamilyId),
    allowedMicroFamilyIds: allowlist.map(item => item.microFamilyId),
    meta: {
      ...(rotation.meta || {}),
      microOnly: true,
      parentDisabled: true,
      subDisabled: true,
      longCount: allowlist.filter(item => item.side === "LONG").length,
      shortCount: allowlist.filter(item => item.side === "SHORT").length,
      totalCount: allowlist.length,
    },
  };
}

// ================= FILE IO =================

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

async function writeJsonAtomic(filePath, data) {
  await ensureParentDir(filePath);

  const now = new Date().toISOString();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  const payloadObject = {
    ...(data || {}),
    updatedAt: now,
  };

  const payload = JSON.stringify(payloadObject, null, 2);

  await fs.writeFile(tmpPath, `${payload}\n`, "utf8");
  await fs.rename(tmpPath, filePath);

  return payloadObject;
}

async function readJson(filePath, fallbackFactory) {
  await ensureParentDir(filePath);

  const fallback =
    typeof fallbackFactory === "function" ? fallbackFactory() : fallbackFactory;

  if (!(await exists(filePath))) {
    return writeJsonAtomic(filePath, fallback);
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");

    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readExistingJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");

  if (!raw.trim()) {
    throw new Error(`JSON file empty: ${filePath}`);
  }

  return JSON.parse(raw);
}

// ================= LOAD / SAVE =================

export async function ensureRotationFiles() {
  await ensureDir();

  if (!(await exists(ACTIVE_FILE))) {
    await writeJsonAtomic(
      ACTIVE_FILE,
      createEmptyRotation({
        status: "NO_ACTIVE_ROTATION",
      })
    );
  }

  if (!(await exists(NEXT_FILE))) {
    await writeJsonAtomic(
      NEXT_FILE,
      createEmptyRotation({
        rotationId: getNextIsoWeekId(),
        status: "NO_NEXT_ROTATION",
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

  const rotation = await readJson(ACTIVE_FILE, () =>
    createEmptyRotation({
      status: "NO_ACTIVE_ROTATION",
    })
  );

  return normalizeLoadedRotation(rotation);
}

export async function loadNextRotation() {
  await ensureRotationFiles();

  const rotation = await readJson(NEXT_FILE, () =>
    createEmptyRotation({
      rotationId: getNextIsoWeekId(),
      status: "NO_NEXT_ROTATION",
    })
  );

  return normalizeLoadedRotation(rotation);
}

export async function loadRotationHistory() {
  await ensureRotationFiles();

  return readJson(HISTORY_FILE, createEmptyHistory);
}

export async function saveActiveRotation(rotation) {
  if (!rotation || typeof rotation !== "object") {
    throw new Error("saveActiveRotation: rotation object missing");
  }

  return writeJsonAtomic(ACTIVE_FILE, normalizeRotation(rotation));
}

export async function saveNextRotation(rotation) {
  if (!rotation || typeof rotation !== "object") {
    throw new Error("saveNextRotation: rotation object missing");
  }

  return writeJsonAtomic(NEXT_FILE, normalizeRotation(rotation));
}

export async function saveRotationHistory(history) {
  if (!history || typeof history !== "object") {
    throw new Error("saveRotationHistory: history object missing");
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

// ================= STATUS =================

export function getActiveMicroFamilyIds(rotation, side = null) {
  if (!rotation || !Array.isArray(rotation.allowlist)) return [];

  const normalizedSide = side ? parseSide(side) : null;

  return rotation.allowlist
    .map(normalizeAllowlistItem)
    .filter(item => isStrictMicroAllowlistItem(item))
    .filter(item => !normalizedSide || item.side === normalizedSide)
    .map(item => item.microFamilyId)
    .filter(Boolean);
}

export function isRotationUsable(rotation = {}) {
  const normalized = normalizeLoadedRotation(rotation);
  const status = normalizeStatus(normalized.status);

  if (!USABLE_ACTIVE_STATUSES.has(status)) return false;
  if (!Array.isArray(normalized.allowlist)) return false;
  if (normalized.allowlist.length === 0) return false;

  return true;
}

export async function loadActiveRotationStatus({
  now = new Date(),
} = {}) {
  await ensureRotationFiles();

  const currentWeekId = getIsoWeekId(now);
  const rotation = await loadActiveRotation();

  const status = normalizeStatus(rotation.status);
  const gateEnabled = getEnvFlag("WEEKLY_ROTATION_LIVE_GATE", true);
  const usable = isRotationUsable(rotation);
  const isCurrentWeek = rotation.rotationId === currentWeekId;

  const longMicroFamilyIds = getActiveMicroFamilyIds(rotation, "LONG");
  const shortMicroFamilyIds = getActiveMicroFamilyIds(rotation, "SHORT");
  const activeMicroFamilyIds = [...longMicroFamilyIds, ...shortMicroFamilyIds];

  return {
    ok: true,

    gateEnabled,
    enabled: gateEnabled && usable,
    usable,
    active: usable,

    currentWeekId,
    isCurrentWeek,

    rotationId: rotation.rotationId || null,
    status,
    mode: rotation.mode || ROTATION_MODE,
    source: rotation.source || ROTATION_SOURCE,

    createdAt: rotation.createdAt || null,
    updatedAt: rotation.updatedAt || null,
    activatedAt: rotation.activatedAt || null,
    sourceWindow: rotation.sourceWindow || null,

    allowlist: rotation.allowlist,

    activeMicroFamilyIds,
    allowedMicroFamilyIds: activeMicroFamilyIds,
    microFamilyIds: activeMicroFamilyIds,

    longMicroFamilyIds,
    shortMicroFamilyIds,

    longCount: longMicroFamilyIds.length,
    shortCount: shortMicroFamilyIds.length,
    totalCount: rotation.allowlist.length,

    emptyPolicy: String(
      process.env.WEEKLY_ROTATION_EMPTY_POLICY || "DENY_ALL"
    ).toUpperCase(),

    requireSideMatch: getEnvFlag("WEEKLY_ROTATION_REQUIRE_SIDE_MATCH", true),

    meta: {
      ...(rotation.meta || {}),
      microOnly: true,
      parentDisabled: true,
      subDisabled: true,
      currentWeekId,
      isCurrentWeek,
      usable,
      gateEnabled,
      longCount: longMicroFamilyIds.length,
      shortCount: shortMicroFamilyIds.length,
      totalCount: rotation.allowlist.length,
    },

    rotation,
    paths: rotationPaths,
  };
}

// ================= ANALYZER SNAPSHOT PARSING =================

function getPathValue(object, dottedPath) {
  if (!object || !dottedPath) return null;

  return dottedPath.split(".").reduce((current, key) => {
    if (!current || typeof current !== "object") return null;

    return current[key];
  }, object);
}

function pickFirstPath(object, paths) {
  for (const currentPath of paths) {
    const value = getPathValue(object, currentPath);

    if (value !== undefined && value !== null && value !== "") return value;
  }

  return null;
}

function isAnalyzerFamilyRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const familyId = extractMicroFamilyId(value);
  if (!familyId) return false;
  if (!isRealMicroFamilyId(familyId)) return false;

  const level = String(value.level || inferLevelFromFamilyId(familyId, "")).toUpperCase();

  const hasStats =
    value.closed !== undefined ||
    value.trades !== undefined ||
    value.winrate !== undefined ||
    value.winRate !== undefined ||
    value.winrateNum !== undefined ||
    value.avgR !== undefined ||
    value.pf !== undefined ||
    value.profitFactor !== undefined ||
    value.profitFactorR !== undefined;

  if (level === "MICRO") return true;
  if (hasStats && !isBlockedFamilyId(familyId)) return true;

  return false;
}

function collectAnalyzerRows(value, output = [], depth = 0) {
  if (!value || depth > 9) return output;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAnalyzerRows(item, output, depth + 1);
    }

    return output;
  }

  if (typeof value !== "object") return output;

  if (isAnalyzerFamilyRow(value) && isStrictMicroFamilyRaw(value)) {
    output.push(value);
  }

  for (const child of Object.values(value)) {
    collectAnalyzerRows(child, output, depth + 1);
  }

  return output;
}

function enrichWinnerWithRows(winner, rows, fallbackSide) {
  const rawWinner =
    typeof winner === "string"
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

  if (!rowMatch) {
    return {
      ...rawWinner,
      microFamilyId: familyId,
      side: rawWinner.side || inferSideFromFamilyId(familyId, fallbackSide),
      level: rawWinner.level || inferLevelFromFamilyId(familyId, "MICRO"),
    };
  }

  return {
    ...rowMatch,
    ...rawWinner,
    microFamilyId: familyId,
    definition:
      rawWinner.definition ||
      rawWinner.filterFamily ||
      rawWinner.signature ||
      rowMatch.definition ||
      rowMatch.definitionParts ||
      rowMatch.filterFamily ||
      rowMatch.signature,
    side:
      rawWinner.side ||
      rowMatch.side ||
      inferSideFromFamilyId(familyId, fallbackSide),
    level:
      rawWinner.level ||
      rowMatch.level ||
      inferLevelFromFamilyId(familyId, "MICRO"),
  };
}

function getDirectAnalyzerWinners(snapshot, rows) {
  const directLong = pickFirstPath(snapshot, [
    "bestMainLong",
    "winners.long",
    "long",

    "bestMicroMain.bestMainLong",
    "bestMicroMain.bestMicroLong",
    "bestMicroMain.microLong",
    "bestMicroMain.bestLong",
    "bestMicroMain.long",

    "report.bestMainLong",
    "report.winners.long",
    "report.bestMicroMain.bestMainLong",
    "report.bestMicroMain.bestMicroLong",
    "report.bestMicroMain.microLong",
    "report.bestMicroMain.bestLong",
    "report.bestMicroMain.long",

    "microAnalysis.bestMainLong",
    "microAnalysis.winners.long",
    "microAnalysis.bestMicroMain.bestMainLong",
    "microAnalysis.bestMicroMain.bestMicroLong",
    "microAnalysis.bestMicroMain.microLong",
    "microAnalysis.bestMicroMain.bestLong",
    "microAnalysis.bestMicroMain.long",

    "report.microAnalysis.bestMainLong",
    "report.microAnalysis.winners.long",
    "report.microAnalysis.bestMicroMain.bestMainLong",
    "report.microAnalysis.bestMicroMain.bestMicroLong",
    "report.microAnalysis.bestMicroMain.microLong",
    "report.microAnalysis.bestMicroMain.bestLong",
    "report.microAnalysis.bestMicroMain.long",

    "bestMicroLong",
    "micro.bestMicroLong",
    "micro.bestLong",
    "micro.long",

    "mainMicrofamily.bestMicroLong",
    "mainMicrofamily.bestLong",
    "mainMicrofamilyAnalyzer.bestMicroLong",
    "mainMicrofamilyAnalyzer.bestLong",
    "microfamily.bestMicroLong",
    "microfamily.bestLong",
  ]);

  const directShort = pickFirstPath(snapshot, [
    "bestMainShort",
    "winners.short",
    "short",

    "bestMicroMain.bestMainShort",
    "bestMicroMain.bestMicroShort",
    "bestMicroMain.microShort",
    "bestMicroMain.bestShort",
    "bestMicroMain.short",

    "report.bestMainShort",
    "report.winners.short",
    "report.bestMicroMain.bestMainShort",
    "report.bestMicroMain.bestMicroShort",
    "report.bestMicroMain.microShort",
    "report.bestMicroMain.bestShort",
    "report.bestMicroMain.short",

    "microAnalysis.bestMainShort",
    "microAnalysis.winners.short",
    "microAnalysis.bestMicroMain.bestMainShort",
    "microAnalysis.bestMicroMain.bestMicroShort",
    "microAnalysis.bestMicroMain.microShort",
    "microAnalysis.bestMicroMain.bestShort",
    "microAnalysis.bestMicroMain.short",

    "report.microAnalysis.bestMainShort",
    "report.microAnalysis.winners.short",
    "report.microAnalysis.bestMicroMain.bestMainShort",
    "report.microAnalysis.bestMicroMain.bestMicroShort",
    "report.microAnalysis.bestMicroMain.microShort",
    "report.microAnalysis.bestMicroMain.bestShort",
    "report.microAnalysis.bestMicroMain.short",

    "bestMicroShort",
    "micro.bestMicroShort",
    "micro.bestShort",
    "micro.short",

    "mainMicrofamily.bestMicroShort",
    "mainMicrofamily.bestShort",
    "mainMicrofamilyAnalyzer.bestMicroShort",
    "mainMicrofamilyAnalyzer.bestShort",
    "microfamily.bestMicroShort",
    "microfamily.bestShort",
  ]);

  const winners = [];

  if (directLong) {
    winners.push(enrichWinnerWithRows(directLong, rows, "LONG"));
  }

  if (directShort) {
    winners.push(enrichWinnerWithRows(directShort, rows, "SHORT"));
  }

  return winners;
}

function getAcceptedStatuses() {
  return getEnvList("WEEKLY_ROTATION_ACCEPT_STATUSES", [
    "ELITE",
    "HOT",
    "GOOD",
    "STABLE",
  ]);
}

function getMinClosedForSide(side) {
  if (side === "SHORT") {
    return getEnvNumber(
      "WEEKLY_ROTATION_MIN_CLOSED_SHORT",
      getEnvNumber("WEEKLY_ROTATION_MIN_CLOSED", 6)
    );
  }

  return getEnvNumber(
    "WEEKLY_ROTATION_MIN_CLOSED_LONG",
    getEnvNumber("WEEKLY_ROTATION_MIN_CLOSED", 6)
  );
}

function passesAnalyzerGuards(row, side) {
  const familyId = extractMicroFamilyId(row);

  const normalized = normalizeAllowlistItem({
    ...row,
    microFamilyId: familyId,
    side: row.side || inferSideFromFamilyId(familyId, side),
    level: row.level || inferLevelFromFamilyId(familyId, "MICRO"),
  });

  if (!normalized.microFamilyId) return false;
  if (normalized.side !== side) return false;
  if (!isStrictMicroAllowlistItem(normalized)) return false;

  const requiredLevel = String(process.env.WEEKLY_ROTATION_LEVEL || "MICRO").toUpperCase();

  if (requiredLevel && normalized.level !== requiredLevel) return false;

  const acceptedStatuses = getAcceptedStatuses();
  if (!acceptedStatuses.includes(normalized.status)) return false;

  const minClosed = getMinClosedForSide(side);
  if (normalized.closed < minClosed) return false;

  const minAvgR = getEnvNumber("WEEKLY_ROTATION_MIN_AVG_R", 0);
  if (normalized.avgR <= minAvgR) return false;

  const minTotalR = getEnvNumber("WEEKLY_ROTATION_MIN_TOTAL_R", 0);
  if (normalized.totalR < minTotalR) return false;

  const minPf = getEnvNumber("WEEKLY_ROTATION_MIN_PF", 1.05);
  if (normalized.pf > 0 && normalized.pf < minPf) return false;

  return true;
}

function scoreAnalyzerRow(row) {
  const normalized = normalizeAllowlistItem(row);

  const statusScore = STATUS_RANK[normalized.status] ?? 0;
  const closedScore = Math.min(normalized.closed, 50) / 50;
  const avgRScore = Math.max(-1, Math.min(normalized.avgR, 2));
  const totalRScore = Math.max(-50, Math.min(normalized.totalR, 100)) / 100;
  const pfScore = Math.max(0, Math.min(normalized.pf, 10)) / 10;
  const winrateScore = Math.max(0, Math.min(normalized.winrate, 100)) / 100;

  return (
    statusScore * 100000 +
    closedScore * 5000 +
    avgRScore * 2500 +
    totalRScore * 1500 +
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
    .filter(item => item.microFamilyId)
    .filter(item => ["LONG", "SHORT"].includes(item.side))
    .filter(item => passesAnalyzerGuards(item, item.side));

  const hasLong = directWinners.some(item => item.side === "LONG");
  const hasShort = directWinners.some(item => item.side === "SHORT");

  const winners = [...directWinners];

  if (!hasLong) {
    const fallbackLong = pickBestFallbackRow(rows, "LONG");

    if (fallbackLong) winners.push(normalizeAllowlistItem(fallbackLong));
  }

  if (!hasShort) {
    const fallbackShort = pickBestFallbackRow(rows, "SHORT");

    if (fallbackShort) winners.push(normalizeAllowlistItem(fallbackShort));
  }

  const deduped = dedupeAllowlist(winners)
    .filter(item => ["LONG", "SHORT"].includes(item.side));

  const long = deduped.find(item => item.side === "LONG");
  const short = deduped.find(item => item.side === "SHORT");

  return [long, short].filter(Boolean);
}

// ================= ANALYZER -> NEXT ROTATION =================

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
    ? "READY_FROM_ANALYZER"
    : "NO_MICRO_ANALYZER_WINNERS";

  return normalizeRotation({
    rotationId: targetWeekId,
    status,
    mode: ROTATION_MODE,
    source: ROTATION_SOURCE,
    sourceWindow: {
      type: "CURRENT_WEEK_ANALYZER_MICRO_TO_NEXT_WEEK",
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
      winnerSource: "ANALYZER_MICRO_LONG_SHORT_ONLY",
      sourceWeekId,
      targetWeekId,
      analyzerUpdatedAt:
        snapshot.updatedAt ||
        snapshot.snapshotAt ||
        snapshot.generatedAt ||
        null,
      microOnly: true,
      parentDisabled: true,
      subDisabled: true,
    },
  });
}

export async function syncNextRotationFromAnalyzerFile({
  analyzerFile = getAnalyzerFilePath(),
  overwriteEmpty = getEnvFlag("WEEKLY_ROTATION_OVERWRITE_NEXT_WITH_EMPTY", false),
} = {}) {
  await ensureRotationFiles();

  if (!(await exists(analyzerFile))) {
    return {
      synced: false,
      reason: "ANALYZER_FILE_NOT_FOUND",
      analyzerFile,
    };
  }

  const snapshot = await readExistingJson(analyzerFile);
  const nextRotation = buildNextRotationFromAnalyzerSnapshot(snapshot);

  if (!nextRotation.allowlist.length && !overwriteEmpty) {
    return {
      synced: false,
      reason: "NO_MICRO_ANALYZER_WINNERS_KEEPING_EXISTING_NEXT",
      analyzerFile,
      nextCandidate: nextRotation,
    };
  }

  const saved = await saveNextRotation(nextRotation);

  return {
    synced: true,
    reason: "NEXT_ROTATION_SYNCED_FROM_MICRO_ANALYZER",
    analyzerFile,
    next: saved,
  };
}

// ================= PROMOTION / MAINTENANCE =================

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
      reason: "NEXT_ROTATION_NOT_FOR_CURRENT_WEEK",
      currentWeekId,
      active,
      next,
    };
  }

  if (!Array.isArray(next.allowlist) || next.allowlist.length === 0) {
    return {
      promoted: false,
      reason: "NEXT_ROTATION_EMPTY",
      currentWeekId,
      active,
      next,
    };
  }

  const normalizedNext = normalizeLoadedRotation(next);

  if (!normalizedNext.allowlist.length) {
    return {
      promoted: false,
      reason: "NEXT_ROTATION_HAS_NO_VALID_MICRO_FAMILIES",
      currentWeekId,
      active,
      next,
    };
  }

  await appendRotationHistory(active, {
    replacedBy: next.rotationId,
    replaceReason: "WEEKLY_ANALYZER_MICRO_ROTATION",
  });

  const promoted = normalizeRotation({
    ...normalizedNext,
    rotationId: currentWeekId,
    status: "ACTIVE",
    activatedAt: new Date().toISOString(),
  });

  await saveActiveRotation(promoted);

  const freshNext = createEmptyRotation({
    rotationId: getNextIsoWeekId(now),
    status: "NO_NEXT_ROTATION",
    sourceWindow: {
      type: "WAITING_FOR_MICRO_ANALYZER_CURRENT_WEEK",
      sourceWeekId: currentWeekId,
      targetWeekId: getNextIsoWeekId(now),
    },
  });

  await saveNextRotation(freshNext);

  return {
    promoted: true,
    reason: "NEXT_MICRO_ROTATION_PROMOTED_TO_ACTIVE",
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

  if (active.rotationId === currentWeekId && normalizeStatus(active.status) === "ACTIVE") {
    return {
      changed: false,
      reason: "ACTIVE_ROTATION_ALREADY_CURRENT",
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

  const failClosed = getEnvFlag("WEEKLY_ROTATION_FAIL_CLOSED", true);

  if (!failClosed) {
    return {
      changed: false,
      reason: "NO_PROMOTION_AVAILABLE_KEEPING_ACTIVE",
      active,
      promotionResult: promoted,
    };
  }

  await appendRotationHistory(active, {
    replacedBy: null,
    replaceReason: "FAIL_CLOSED_NO_VALID_MICRO_NEXT_ROTATION",
  });

  const emptyActive = createEmptyRotation({
    rotationId: currentWeekId,
    status: "NO_ACTIVE_ROTATION",
    sourceWindow: {
      type: "FAIL_CLOSED_NO_VALID_MICRO_NEXT_ROTATION",
      sourceWeekId: null,
      targetWeekId: currentWeekId,
    },
  });

  await saveActiveRotation(emptyActive);

  return {
    changed: true,
    reason: "FAIL_CLOSED_EMPTY_ACTIVE_MICRO_ROTATION",
    active: emptyActive,
    promotionResult: promoted,
  };
}

export async function clearActiveRotation(reason = "MANUAL_CLEAR") {
  const active = await loadActiveRotation();

  await appendRotationHistory(active, {
    cleared: true,
    clearReason: reason,
  });

  const empty = createEmptyRotation({
    rotationId: getIsoWeekId(),
    status: "NO_ACTIVE_ROTATION",
  });

  await saveActiveRotation(empty);

  return empty;
}

export async function runRotationMaintenanceOnce() {
  const promotionResult = await activateWeeklyRotationIfNeeded();

  const useAnalyzer = getEnvFlag("WEEKLY_ROTATION_USE_ANALYZER", true);
  const syncNext = getEnvFlag("WEEKLY_ROTATION_SYNC_NEXT_FROM_ANALYZER", true);

  if (!useAnalyzer || !syncNext) {
    return {
      promotionResult,
      syncResult: {
        synced: false,
        reason: "ANALYZER_SYNC_DISABLED",
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
  intervalMs = getEnvNumber("WEEKLY_ROTATION_SYNC_INTERVAL_MS", 60000),
} = {}) {
  if (!getEnvFlag("WEEKLY_ROTATION_AUTO_MAINTENANCE", true)) {
    return null;
  }

  const run = async () => {
    try {
      await runRotationMaintenanceOnce();
    } catch (error) {
      console.error("[rotationStore] maintenance failed:", error?.message || error);
    }
  };

  run();

  const timer = setInterval(run, intervalMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return timer;
}

// ================= ENTRY GATE HELPERS =================

export function isMicroFamilyActive(rotation, microFamilyId, side = null) {
  if (!rotation || !microFamilyId) return false;
  if (!Array.isArray(rotation.allowlist)) return false;

  const normalizedMicroFamilyId = cleanFamilyId(microFamilyId);

  if (isBlockedFamilyId(normalizedMicroFamilyId)) return false;
  if (!isRealMicroFamilyId(normalizedMicroFamilyId)) return false;

  const normalizedSide = side ? parseSide(side) : null;

  return rotation.allowlist.map(normalizeAllowlistItem).some(item => {
    if (!isStrictMicroAllowlistItem(item)) return false;
    if (cleanFamilyId(item.microFamilyId) !== normalizedMicroFamilyId) return false;
    if (normalizedSide && item.side !== normalizedSide) return false;

    return true;
  });
}

export function resolveEntryMicroFamilyId(entry = {}) {
  return cleanFamilyId(
    entry.microFamilyId ||
      entry.analyzerMicroFamilyId ||
      entry.micro?.familyId ||
      entry.micro?.microFamilyId ||
      entry.microFamily?.id ||
      entry.microFamily?.familyId ||
      entry.entry?.microFamilyId ||
      entry.entry?.micro?.familyId ||
      entry.setup?.microFamilyId ||
      entry.setup?.micro?.familyId ||
      ""
  );
}

export function isEntryAllowedByRotation(rotation, entry = {}) {
  const liveGateEnabled = getEnvFlag("WEEKLY_ROTATION_LIVE_GATE", true);

  if (!liveGateEnabled) {
    return {
      allowed: true,
      reason: "ROTATION_GATE_DISABLED",
    };
  }

  if (!rotation || !Array.isArray(rotation.allowlist)) {
    return {
      allowed: false,
      reason: "ROTATION_MISSING",
    };
  }

  const normalizedRotation = normalizeLoadedRotation(rotation);

  if (!normalizedRotation.allowlist.length) {
    const emptyPolicy = String(
      process.env.WEEKLY_ROTATION_EMPTY_POLICY || "DENY_ALL"
    ).toUpperCase();

    return {
      allowed: emptyPolicy !== "DENY_ALL",
      reason: emptyPolicy === "DENY_ALL"
        ? "ROTATION_EMPTY_DENY_ALL"
        : "ROTATION_EMPTY_ALLOW",
    };
  }

  const microFamilyId = resolveEntryMicroFamilyId(entry);

  if (!microFamilyId) {
    return {
      allowed: false,
      reason: "ENTRY_MICRO_FAMILY_MISSING",
    };
  }

  if (isBlockedFamilyId(microFamilyId) || !isRealMicroFamilyId(microFamilyId)) {
    return {
      allowed: false,
      reason: "ENTRY_FAMILY_IS_NOT_REAL_MICRO",
      microFamilyId,
    };
  }

  const requireSideMatch = getEnvFlag("WEEKLY_ROTATION_REQUIRE_SIDE_MATCH", true);
  const inferredSide = inferSideFromFamilyId(microFamilyId, null);
  const side = requireSideMatch
    ? parseSide(entry.side || entry.direction || entry.tradeSide, inferredSide || "LONG")
    : null;

  const allowed = isMicroFamilyActive(normalizedRotation, microFamilyId, side);

  return {
    allowed,
    reason: allowed ? "MICRO_FAMILY_ACTIVE" : "MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",
    microFamilyId,
    side,
    rotationId: normalizedRotation.rotationId,
    microOnly: true,
  };
}

// ================= PATHS / DEFAULT EXPORT =================

export const rotationPaths = {
  dir: ROTATION_DIR,
  active: ACTIVE_FILE,
  next: NEXT_FILE,
  history: HISTORY_FILE,
  analyzer: getAnalyzerFilePath(),
  dataDir: DATA_DIR,
};

export default {
  ROTATION_MODE,
  ROTATION_SOURCE,

  rotationPaths,

  getIsoWeekId,
  getNextIsoWeekId,

  ensureRotationFiles,

  loadActiveRotation,
  loadNextRotation,
  loadRotationHistory,

  saveActiveRotation,
  saveNextRotation,
  saveRotationHistory,

  appendRotationHistory,

  normalizeAllowlistItem,
  normalizeRotation,

  isRotationUsable,
  loadActiveRotationStatus,

  selectAnalyzerWinners,
  buildNextRotationFromAnalyzerSnapshot,
  syncNextRotationFromAnalyzerFile,

  promoteNextRotationToActive,
  activateWeeklyRotationIfNeeded,
  clearActiveRotation,
  runRotationMaintenanceOnce,
  startRotationMaintenanceLoop,

  getActiveMicroFamilyIds,
  isMicroFamilyActive,
  resolveEntryMicroFamilyId,
  isEntryAllowedByRotation,
};