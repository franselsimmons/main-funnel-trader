// lib/rotation/rotationStore.js

import fs from "node:fs/promises";
import path from "node:path";

// ================= CONFIG =================

const HAS_PROCESS = typeof process !== "undefined";
const PROCESS_ENV = HAS_PROCESS ? process.env : {};

const ROTATION_DIR =
  PROCESS_ENV.ROTATION_STORE_DIR ||
  path.join(HAS_PROCESS ? process.cwd() : ".", "data", "rotation");

const FILES = {
  active: "active-week.json",
  next: "next-week.json",
  history: "history.json"
};

const REDIS_URL = String(
  PROCESS_ENV.KV_REST_API_URL ||
    PROCESS_ENV.UPSTASH_REDIS_REST_URL ||
    ""
).replace(/\/+$/, "");

const REDIS_TOKEN = String(
  PROCESS_ENV.KV_REST_API_TOKEN ||
    PROCESS_ENV.UPSTASH_REDIS_REST_TOKEN ||
    ""
);

const HAS_REDIS_CONFIG = Boolean(REDIS_URL && REDIS_TOKEN);
const HAS_FETCH = typeof globalThis.fetch === "function";
const CAN_USE_REDIS = HAS_REDIS_CONFIG && HAS_FETCH;

const REDIS_TIMEOUT_MS = safeInteger(
  PROCESS_ENV.ROTATION_REDIS_TIMEOUT_MS,
  2500,
  100,
  60_000
);

const MEMORY_CACHE_TTL_MS = safeInteger(
  PROCESS_ENV.ROTATION_STORE_MEMORY_TTL_MS,
  1000,
  0,
  60_000
);

const HISTORY_LIMIT = safeInteger(
  PROCESS_ENV.ROTATION_HISTORY_LIMIT,
  52,
  1,
  1000
);

const FILE_BACKUP_ENABLED = parseBoolean(
  PROCESS_ENV.ROTATION_FILE_BACKUP_ENABLED,
  true
);

const SILENT_WARNINGS = parseBoolean(
  PROCESS_ENV.ROTATION_STORE_SILENT_WARNINGS,
  false
);

const KEYS = {
  active: "rotation:active-week:v2",
  next: "rotation:next-week:v2",
  history: "rotation:history:v2"
};

const CACHE_KEYS = {
  active: "active",
  next: "next",
  history: "history"
};

const STORE_VERSION = "rotation-store-v3";

const memoryCache = new Map();
const writeLocks = new Map();

// ================= BASIC HELPERS =================

function now() {
  return Date.now();
}

function safeInteger(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;

  const raw = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;

  return fallback;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function flattenValues(values = []) {
  return values
    .flat(Infinity)
    .filter(value => value !== undefined && value !== null);
}

function unique(values = []) {
  return Array.from(new Set(flattenValues(values).filter(Boolean)));
}

function safeJsonParse(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function getFilePath(fileName) {
  return path.join(ROTATION_DIR, fileName);
}

function getProcessId() {
  return HAS_PROCESS ? process.pid : "runtime";
}

function logRotationStoreWarning(reason, detail = {}) {
  if (SILENT_WARNINGS) return;

  console.warn(
    "ROTATION_STORE_WARNING:",
    JSON.stringify({
      reason,
      ...detail,
      ts: now()
    })
  );
}

// ================= LOCKS =================

async function withKeyLock(key, fn) {
  const previous = writeLocks.get(key) || Promise.resolve();

  const current = previous
    .catch(() => undefined)
    .then(fn);

  writeLocks.set(key, current);

  try {
    return await current;
  } finally {
    if (writeLocks.get(key) === current) {
      writeLocks.delete(key);
    }
  }
}

// ================= MEMORY CACHE =================

function getCache(cacheKey) {
  if (MEMORY_CACHE_TTL_MS <= 0) return undefined;

  const cached = memoryCache.get(cacheKey);

  if (!cached) return undefined;

  if (cached.expiresAt <= now()) {
    memoryCache.delete(cacheKey);
    return undefined;
  }

  return cached.value;
}

function setCache(cacheKey, value) {
  if (MEMORY_CACHE_TTL_MS <= 0) return value;

  memoryCache.set(cacheKey, {
    value,
    expiresAt: now() + MEMORY_CACHE_TTL_MS
  });

  return value;
}

function deleteCache(cacheKey) {
  memoryCache.delete(cacheKey);
}

// ================= FILE STORAGE =================

async function ensureDir() {
  await fs.mkdir(ROTATION_DIR, { recursive: true });
}

async function readJsonFile(fileName, fallback) {
  try {
    const fullPath = getFilePath(fileName);
    const raw = await fs.readFile(fullPath, "utf8");

    return safeJsonParse(raw, fallback);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(fileName, value) {
  await ensureDir();

  const fullPath = getFilePath(fileName);
  const tmpPath = `${fullPath}.${getProcessId()}.${now()}.tmp`;

  let committed = false;

  try {
    await fs.writeFile(tmpPath, safeJsonStringify(value), "utf8");
    await fs.rename(tmpPath, fullPath);

    committed = true;

    return true;
  } finally {
    if (!committed) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
}

async function writeJsonFileSafe(fileName, value, { required = false } = {}) {
  if (!FILE_BACKUP_ENABLED && !required) return false;

  try {
    await writeJsonFile(fileName, value);
    return true;
  } catch (error) {
    if (required) throw error;

    logRotationStoreWarning("FILE_WRITE_FAILED", {
      fileName,
      error: error?.message || String(error)
    });

    return false;
  }
}

// ================= REDIS STORAGE =================

async function redisCommand(command) {
  if (!CAN_USE_REDIS) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);

  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([command]),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Redis command failed: ${res.status} ${await res.text()}`);
    }

    const payload = await res.json();
    const first = Array.isArray(payload) ? payload[0] : null;

    if (!first) return null;
    if (first.error) throw new Error(String(first.error));

    return first.result ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

async function redisGetJson(key) {
  if (!CAN_USE_REDIS) return null;

  try {
    const raw = await redisCommand(["GET", key]);
    return safeJsonParse(raw, null);
  } catch (error) {
    logRotationStoreWarning("REDIS_GET_FAILED", {
      key,
      error: error?.message || String(error)
    });

    return null;
  }
}

async function redisSetJson(key, value) {
  if (!CAN_USE_REDIS) return false;

  try {
    await redisCommand(["SET", key, JSON.stringify(value)]);
    return true;
  } catch (error) {
    logRotationStoreWarning("REDIS_SET_FAILED", {
      key,
      error: error?.message || String(error)
    });

    return false;
  }
}

// ================= VALUE SHAPING =================

function getStorageMode() {
  if (CAN_USE_REDIS) return "redis";
  return "file";
}

function getStorageWriteMode(redisSaved = false) {
  if (redisSaved && FILE_BACKUP_ENABLED) return "redis_with_file_backup";
  if (redisSaved) return "redis_only";
  return "file_only";
}

function buildStoredRotation(rotation, storage = getStorageMode()) {
  const row = safeObject(rotation);
  const timestamp = now();

  return {
    ...row,

    savedAt: timestamp,
    updatedAt: timestamp,

    storage,
    storageWriteMode: CAN_USE_REDIS
      ? "redis_with_file_backup"
      : "file_only",

    storeVersion: STORE_VERSION
  };
}

function normalizeHistoryItems(value) {
  if (Array.isArray(value)) return value;

  if (value && typeof value === "object") {
    if (Array.isArray(value.history)) return value.history;
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.rows)) return value.rows;
  }

  return [];
}

function getSelectionSideIds(selection = {}, side = "") {
  const bucket = safeObject(selection?.[side]);

  return unique([
    bucket.microFamilyIds,
    bucket.selectedMicroFamilyIds,
    bucket.activeMicroFamilyIds,
    bucket.allowedMicroFamilyIds,
    bucket.familyIds,
    safeArray(bucket.families).map(row => [
      row?.microFamilyId,
      row?.rotationMicroFamilyId,
      row?.analyzerMicroFamilyId,
      row?.familyId,
      row?.parentFamilyId,
      row?.analyzeFamilyId,
      row?.analysisFamilyId
    ]),
    safeArray(bucket.rows).map(row => [
      row?.microFamilyId,
      row?.rotationMicroFamilyId,
      row?.analyzerMicroFamilyId,
      row?.familyId,
      row?.parentFamilyId,
      row?.analyzeFamilyId,
      row?.analysisFamilyId
    ])
  ]);
}

function buildHistoryRow(rotation = {}) {
  const row = safeObject(rotation);
  const selection = safeObject(row.selection);

  const selectedLongMicroFamilyIds = unique([
    row.selectedLongMicroFamilyIds,
    row.longMicroFamilyIds,
    row.activeLongMicroFamilyIds,
    row.allowedLongMicroFamilyIds,
    getSelectionSideIds(selection, "long")
  ]);

  const selectedShortMicroFamilyIds = unique([
    row.selectedShortMicroFamilyIds,
    row.shortMicroFamilyIds,
    row.activeShortMicroFamilyIds,
    row.allowedShortMicroFamilyIds,
    getSelectionSideIds(selection, "short")
  ]);

  const selectedMicroFamilyIds = unique([
    row.selectedMicroFamilyIds,
    row.microFamilyIds,
    row.activeMicroFamilyIds,
    row.allowedMicroFamilyIds,
    row.realActiveMicroFamilyIds,
    selection.microFamilyIds,
    selection.selectedMicroFamilyIds,
    selection.familyIds,
    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds
  ]);

  return {
    ts: now(),

    targetWeekKey: row.targetWeekKey ?? row.weekKey ?? row.activeWeekKey ?? null,
    sourceWeekKey: row.sourceWeekKey ?? row.weekKey ?? null,

    rotationId: row.rotationId ?? row.activeRotationId ?? row.id ?? null,
    activeRotationId: row.activeRotationId ?? row.rotationId ?? row.id ?? null,

    enabled: row.enabled ?? null,
    strict: row.strict ?? null,
    status: row.status ?? null,

    source: row.source ?? row.mode ?? row.rotationSource ?? null,
    rankingMode: row.rankingMode ?? row.rankingMetric ?? null,

    selectedMicroFamilyIds,
    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds,

    selectedMicroFamilyCount: selectedMicroFamilyIds.length,
    selectedLongMicroFamilyCount: selectedLongMicroFamilyIds.length,
    selectedShortMicroFamilyCount: selectedShortMicroFamilyIds.length,

    selection: row.selection ?? null,

    storeVersion: STORE_VERSION
  };
}

// ================= STORAGE CORE =================

async function loadStoredValue({ cacheKey, redisKey, fileName, fallback }) {
  const cached = getCache(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  if (CAN_USE_REDIS) {
    const redisValue = await redisGetJson(redisKey);

    if (redisValue !== null && redisValue !== undefined) {
      return setCache(cacheKey, redisValue);
    }
  }

  const fileValue = await readJsonFile(fileName, fallback);

  return setCache(cacheKey, fileValue);
}

async function saveStoredValueUnlocked({
  cacheKey,
  redisKey,
  fileName,
  value,
  fileRequired = false
}) {
  const redisSaved = CAN_USE_REDIS
    ? await redisSetJson(redisKey, value)
    : false;

  const fileRequiredFinal = fileRequired || !redisSaved;

  const valueWithWriteMode =
    value && typeof value === "object" && !Array.isArray(value)
      ? {
          ...value,
          storageWriteMode: getStorageWriteMode(redisSaved)
        }
      : value;

  await writeJsonFileSafe(fileName, valueWithWriteMode, {
    required: fileRequiredFinal
  });

  return setCache(cacheKey, valueWithWriteMode);
}

async function saveStoredValue(args) {
  return withKeyLock(args.cacheKey, () => saveStoredValueUnlocked(args));
}

// ================= ACTIVE ROTATION =================

export async function loadActiveRotation() {
  return loadStoredValue({
    cacheKey: CACHE_KEYS.active,
    redisKey: KEYS.active,
    fileName: FILES.active,
    fallback: null
  });
}

export async function saveActiveRotation(rotation) {
  const value = buildStoredRotation(rotation, getStorageMode());

  return saveStoredValue({
    cacheKey: CACHE_KEYS.active,
    redisKey: KEYS.active,
    fileName: FILES.active,
    value
  });
}

// ================= NEXT ROTATION =================

export async function loadNextRotation() {
  return loadStoredValue({
    cacheKey: CACHE_KEYS.next,
    redisKey: KEYS.next,
    fileName: FILES.next,
    fallback: null
  });
}

export async function saveNextRotation(rotation) {
  const value = buildStoredRotation(rotation, getStorageMode());

  return saveStoredValue({
    cacheKey: CACHE_KEYS.next,
    redisKey: KEYS.next,
    fileName: FILES.next,
    value
  });
}

// ================= HISTORY =================

export async function loadRotationHistory() {
  const value = await loadStoredValue({
    cacheKey: CACHE_KEYS.history,
    redisKey: KEYS.history,
    fileName: FILES.history,
    fallback: []
  });

  return normalizeHistoryItems(value);
}

export async function saveRotationHistory(history = []) {
  const value = normalizeHistoryItems(history).slice(0, HISTORY_LIMIT);

  return saveStoredValue({
    cacheKey: CACHE_KEYS.history,
    redisKey: KEYS.history,
    fileName: FILES.history,
    value,
    fileRequired: !CAN_USE_REDIS
  });
}

export async function appendRotationHistory(rotation) {
  return withKeyLock(CACHE_KEYS.history, async () => {
    const history = await loadStoredValue({
      cacheKey: CACHE_KEYS.history,
      redisKey: KEYS.history,
      fileName: FILES.history,
      fallback: []
    });

    const nextHistory = [
      buildHistoryRow(rotation),
      ...normalizeHistoryItems(history)
    ].slice(0, HISTORY_LIMIT);

    return saveStoredValueUnlocked({
      cacheKey: CACHE_KEYS.history,
      redisKey: KEYS.history,
      fileName: FILES.history,
      value: nextHistory,
      fileRequired: !CAN_USE_REDIS
    });
  });
}

// ================= CACHE / STATUS =================

export function clearRotationStoreMemoryCache() {
  deleteCache(CACHE_KEYS.active);
  deleteCache(CACHE_KEYS.next);
  deleteCache(CACHE_KEYS.history);

  return true;
}

export async function getRotationStorageStatus() {
  return {
    ok: true,

    storeVersion: STORE_VERSION,

    hasRedis: CAN_USE_REDIS,
    hasRedisConfig: HAS_REDIS_CONFIG,
    hasFetch: HAS_FETCH,

    redisUrlConfigured: Boolean(REDIS_URL),
    redisTokenConfigured: Boolean(REDIS_TOKEN),
    redisAvailable: CAN_USE_REDIS,
    redisTimeoutMs: REDIS_TIMEOUT_MS,

    fileBackupEnabled: FILE_BACKUP_ENABLED,
    fileDir: ROTATION_DIR,
    files: FILES,

    memoryCacheTtlMs: MEMORY_CACHE_TTL_MS,
    memoryCacheKeys: Array.from(memoryCache.keys()),
    activeWriteLocks: Array.from(writeLocks.keys()),

    historyLimit: HISTORY_LIMIT,

    keys: KEYS
  };
}

export default {
  loadActiveRotation,
  saveActiveRotation,

  loadNextRotation,
  saveNextRotation,

  loadRotationHistory,
  saveRotationHistory,
  appendRotationHistory,

  clearRotationStoreMemoryCache,
  getRotationStorageStatus
};