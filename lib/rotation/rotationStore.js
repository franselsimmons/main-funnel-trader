// lib/rotation/rotationStore.js

import fs from "node:fs/promises";
import path from "node:path";

// ================= CONFIG =================

const ROTATION_DIR =
  typeof process !== "undefined"
    ? process.env.ROTATION_STORE_DIR ||
      path.join(process.cwd(), "data", "rotation")
    : path.join(process.cwd(), "data", "rotation");

const FILES = {
  active: "active-week.json",
  next: "next-week.json",
  history: "history.json"
};

const REDIS_URL = String(
  typeof process !== "undefined"
    ? process.env.KV_REST_API_URL ||
        process.env.UPSTASH_REDIS_REST_URL ||
        ""
    : ""
).replace(/\/+$/, "");

const REDIS_TOKEN = String(
  typeof process !== "undefined"
    ? process.env.KV_REST_API_TOKEN ||
        process.env.UPSTASH_REDIS_REST_TOKEN ||
        ""
    : ""
);

const HAS_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

const HAS_FETCH = typeof globalThis.fetch === "function";

const REDIS_TIMEOUT_MS = Number(
  typeof process !== "undefined"
    ? process.env.ROTATION_REDIS_TIMEOUT_MS || 2500
    : 2500
);

const MEMORY_CACHE_TTL_MS = Number(
  typeof process !== "undefined"
    ? process.env.ROTATION_STORE_MEMORY_TTL_MS || 1000
    : 1000
);

const HISTORY_LIMIT = Number(
  typeof process !== "undefined"
    ? process.env.ROTATION_HISTORY_LIMIT || 52
    : 52
);

const FILE_BACKUP_ENABLED =
  String(
    typeof process !== "undefined"
      ? process.env.ROTATION_FILE_BACKUP_ENABLED ?? "true"
      : "true"
  ).toLowerCase() !== "false";

const KEYS = {
  active: "rotation:active-week:v2",
  next: "rotation:next-week:v2",
  history: "rotation:history:v2"
};

const memoryCache = new Map();

// ================= BASIC HELPERS =================

function now() {
  return Date.now();
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values = []) {
  return Array.from(new Set(values.flat(Infinity).filter(Boolean)));
}

function safeJsonParse(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === "") return fallback;

  if (typeof raw !== "string") {
    return raw;
  }

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

function getCache(cacheKey) {
  if (!MEMORY_CACHE_TTL_MS) return undefined;

  const cached = memoryCache.get(cacheKey);

  if (!cached) return undefined;

  if (cached.expiresAt <= now()) {
    memoryCache.delete(cacheKey);
    return undefined;
  }

  return cached.value;
}

function setCache(cacheKey, value) {
  if (!MEMORY_CACHE_TTL_MS) return value;

  memoryCache.set(cacheKey, {
    value,
    expiresAt: now() + MEMORY_CACHE_TTL_MS
  });

  return value;
}

function deleteCache(cacheKey) {
  memoryCache.delete(cacheKey);
}

function logRotationStoreWarning(reason, detail = {}) {
  if (
    typeof process !== "undefined" &&
    process.env.ROTATION_STORE_SILENT_WARNINGS === "true"
  ) {
    return;
  }

  console.warn(
    "ROTATION_STORE_WARNING:",
    JSON.stringify({
      reason,
      ...detail,
      ts: now()
    })
  );
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
  const tmpPath = `${fullPath}.${process.pid}.${now()}.tmp`;

  await fs.writeFile(tmpPath, safeJsonStringify(value), "utf8");
  await fs.rename(tmpPath, fullPath);

  return true;
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
  if (!HAS_REDIS || !HAS_FETCH) return null;

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

function buildStoredRotation(rotation, storage) {
  const row = safeObject(rotation);

  return {
    ...row,
    savedAt: now(),
    storage,
    storageWriteMode: HAS_REDIS ? "redis_with_file_backup" : "file_only"
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

function buildHistoryRow(rotation = {}) {
  const row = safeObject(rotation);
  const selection = safeObject(row.selection);

  const selectedLongMicroFamilyIds = unique(
    row.selectedLongMicroFamilyIds ??
      selection.long?.microFamilyIds ??
      selection.long?.familyIds ??
      []
  );

  const selectedShortMicroFamilyIds = unique(
    row.selectedShortMicroFamilyIds ??
      selection.short?.microFamilyIds ??
      selection.short?.familyIds ??
      []
  );

  const selectedMicroFamilyIds = unique([
    ...(row.selectedMicroFamilyIds ?? []),
    ...selectedLongMicroFamilyIds,
    ...selectedShortMicroFamilyIds
  ]);

  return {
    ts: now(),

    targetWeekKey: row.targetWeekKey ?? row.weekKey ?? null,
    sourceWeekKey: row.sourceWeekKey ?? null,

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

    selection: row.selection ?? null
  };
}

async function loadStoredValue({ cacheKey, redisKey, fileName, fallback }) {
  const cached = getCache(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  if (HAS_REDIS) {
    const redisValue = await redisGetJson(redisKey);

    if (redisValue !== null && redisValue !== undefined) {
      return setCache(cacheKey, redisValue);
    }
  }

  const fileValue = await readJsonFile(fileName, fallback);

  return setCache(cacheKey, fileValue);
}

async function saveStoredValue({
  cacheKey,
  redisKey,
  fileName,
  value,
  fileRequired = false
}) {
  const redisSaved = HAS_REDIS
    ? await redisSetJson(redisKey, value)
    : false;

  const fileRequiredFinal = fileRequired || !HAS_REDIS || !redisSaved;

  await writeJsonFileSafe(fileName, value, {
    required: fileRequiredFinal
  });

  return setCache(cacheKey, value);
}

// ================= ACTIVE ROTATION =================

export async function loadActiveRotation() {
  return loadStoredValue({
    cacheKey: "active",
    redisKey: KEYS.active,
    fileName: FILES.active,
    fallback: null
  });
}

export async function saveActiveRotation(rotation) {
  const value = buildStoredRotation(rotation, HAS_REDIS ? "redis" : "file");

  return saveStoredValue({
    cacheKey: "active",
    redisKey: KEYS.active,
    fileName: FILES.active,
    value
  });
}

// ================= NEXT ROTATION =================

export async function loadNextRotation() {
  return loadStoredValue({
    cacheKey: "next",
    redisKey: KEYS.next,
    fileName: FILES.next,
    fallback: null
  });
}

export async function saveNextRotation(rotation) {
  const value = buildStoredRotation(rotation, HAS_REDIS ? "redis" : "file");

  return saveStoredValue({
    cacheKey: "next",
    redisKey: KEYS.next,
    fileName: FILES.next,
    value
  });
}

// ================= HISTORY =================

export async function loadRotationHistory() {
  const value = await loadStoredValue({
    cacheKey: "history",
    redisKey: KEYS.history,
    fileName: FILES.history,
    fallback: []
  });

  return normalizeHistoryItems(value);
}

export async function saveRotationHistory(history = []) {
  const value = normalizeHistoryItems(history).slice(0, HISTORY_LIMIT);

  return saveStoredValue({
    cacheKey: "history",
    redisKey: KEYS.history,
    fileName: FILES.history,
    value,
    fileRequired: !HAS_REDIS
  });
}

export async function appendRotationHistory(rotation) {
  const history = await loadRotationHistory();

  const nextHistory = [
    buildHistoryRow(rotation),
    ...history
  ].slice(0, HISTORY_LIMIT);

  return saveRotationHistory(nextHistory);
}

// ================= CACHE / STATUS =================

export function clearRotationStoreMemoryCache() {
  deleteCache("active");
  deleteCache("next");
  deleteCache("history");

  return true;
}

export async function getRotationStorageStatus() {
  return {
    ok: true,

    hasRedis: HAS_REDIS,
    hasFetch: HAS_FETCH,
    redisUrlConfigured: Boolean(REDIS_URL),
    redisTokenConfigured: Boolean(REDIS_TOKEN),

    redisTimeoutMs: REDIS_TIMEOUT_MS,

    fileBackupEnabled: FILE_BACKUP_ENABLED,
    fileDir: ROTATION_DIR,
    files: FILES,

    memoryCacheTtlMs: MEMORY_CACHE_TTL_MS,
    memoryCacheKeys: Array.from(memoryCache.keys()),

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