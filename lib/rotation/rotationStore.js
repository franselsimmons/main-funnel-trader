// lib/rotation/rotationStore.js

import fs from "node:fs/promises";
import path from "node:path";

const ROTATION_DIR = path.join(process.cwd(), "data", "rotation");

const FILES = {
  active: "active-week.json",
  next: "next-week.json",
  history: "history.json"
};

const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  "";

const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  "";

const HAS_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

const KEYS = {
  active: "rotation:active-week:v2",
  next: "rotation:next-week:v2",
  history: "rotation:history:v2"
};

async function ensureDir() {
  await fs.mkdir(ROTATION_DIR, { recursive: true });
}

async function redisCommand(command) {
  if (!HAS_REDIS) return null;

  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([command])
  });

  if (!res.ok) {
    throw new Error(`Redis command failed: ${res.status} ${await res.text()}`);
  }

  const payload = await res.json();
  return payload?.[0]?.result ?? null;
}

async function redisGetJson(key) {
  const raw = await redisCommand(["GET", key]);
  if (!raw) return null;

  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function redisSetJson(key, value) {
  await redisCommand(["SET", key, JSON.stringify(value)]);
  return true;
}

async function readJsonFile(fileName, fallback) {
  try {
    const fullPath = path.join(ROTATION_DIR, fileName);
    const raw = await fs.readFile(fullPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(fileName, value) {
  await ensureDir();
  const fullPath = path.join(ROTATION_DIR, fileName);
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return true;
}

export async function loadActiveRotation() {
  if (HAS_REDIS) {
    const data = await redisGetJson(KEYS.active);
    if (data) return data;
  }

  return readJsonFile(FILES.active, null);
}

export async function saveActiveRotation(rotation) {
  const value = {
    ...rotation,
    savedAt: Date.now(),
    storage: HAS_REDIS ? "redis" : "file"
  };

  if (HAS_REDIS) await redisSetJson(KEYS.active, value);
  await writeJsonFile(FILES.active, value);

  return value;
}

export async function loadNextRotation() {
  if (HAS_REDIS) {
    const data = await redisGetJson(KEYS.next);
    if (data) return data;
  }

  return readJsonFile(FILES.next, null);
}

export async function saveNextRotation(rotation) {
  const value = {
    ...rotation,
    savedAt: Date.now(),
    storage: HAS_REDIS ? "redis" : "file"
  };

  if (HAS_REDIS) await redisSetJson(KEYS.next, value);
  await writeJsonFile(FILES.next, value);

  return value;
}

export async function loadRotationHistory() {
  if (HAS_REDIS) {
    const data = await redisGetJson(KEYS.history);
    if (Array.isArray(data)) return data;
  }

  return readJsonFile(FILES.history, []);
}

export async function appendRotationHistory(rotation) {
  const history = await loadRotationHistory();

  const nextHistory = [
    {
      ts: Date.now(),
      targetWeekKey: rotation?.targetWeekKey ?? null,
      sourceWeekKey: rotation?.sourceWeekKey ?? null,
      rotationId: rotation?.rotationId ?? null,
      selectedMicroFamilyIds: rotation?.selectedMicroFamilyIds ?? [],
      selection: rotation?.selection ?? null,
      status: rotation?.status ?? null
    },
    ...history
  ].slice(0, 52);

  if (HAS_REDIS) await redisSetJson(KEYS.history, nextHistory);
  await writeJsonFile(FILES.history, nextHistory);

  return nextHistory;
}

export async function getRotationStorageStatus() {
  return {
    hasRedis: HAS_REDIS,
    redisUrlConfigured: Boolean(REDIS_URL),
    redisTokenConfigured: Boolean(REDIS_TOKEN),
    fileDir: ROTATION_DIR,
    keys: KEYS
  };
}
