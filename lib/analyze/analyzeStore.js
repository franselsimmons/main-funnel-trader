// ================= lib/analyze/analyzeStore.js =================
// Durable analyze event store.
// Redis/Upstash first. Local data/trades.json as fallback seed.
// Vercel serverless heeft geen betrouwbare file writes, dus Redis is leading.

import fs from "fs/promises";
import path from "path";

const ANALYZE_EVENTS_KEY = "TS_ANALYZE:events:v4";
const ANALYZE_MAX_ROWS = Number(process.env.ANALYZE_MAX_ROWS || 50000);

function getRedisUrl() {
  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ""
  );
}

function getRedisToken() {
  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ""
  );
}

export function hasAnalyzeRedis() {
  return Boolean(getRedisUrl() && getRedisToken());
}

async function redisCommand(command) {
  const url = getRedisUrl();
  const token = getRedisToken();

  if (!url || !token) {
    throw new Error("redis_env_missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || json?.error) {
    throw new Error(json?.error || text || `redis_error_${res.status}`);
  }

  return json?.result;
}

function safeJsonParse(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeStoreEvent(row, meta = {}) {
  const now = Date.now();

  return {
    ...(row || {}),

    source: row?.source || meta.source || "ACTION",

    runId: row?.runId || meta.runId || null,
    strategyVersion: row?.strategyVersion || meta.strategyVersion || null,
    btcState: row?.btcState || meta.btcState || null,

    ts: Number(row?.ts || row?.createdAt || row?.completedAt || row?.exitedAt || now),

    storedAt: now
  };
}

function dedupeRows(rows) {
  const map = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;

    const key = [
      row.tradeId || row.id || "",
      row.symbol || "",
      row.side || "",
      row.action || "",
      row.status || "",
      row.reason || row.exitReason || "",
      row.ts || row.createdAt || row.completedAt || row.exitedAt || ""
    ].join("|");

    map.set(key, row);
  }

  return Array.from(map.values());
}

export async function appendAnalyzeEvents(events, meta = {}) {
  const rows = (Array.isArray(events) ? events : [events])
    .filter(Boolean)
    .map(row => normalizeStoreEvent(row, meta));

  if (!rows.length) {
    return {
      ok: true,
      stored: 0,
      skipped: true,
      reason: "NO_EVENTS"
    };
  }

  if (!hasAnalyzeRedis()) {
    return {
      ok: true,
      stored: 0,
      skipped: true,
      reason: "REDIS_DISABLED"
    };
  }

  const serialized = rows.map(row => JSON.stringify(row));
  const chunkSize = 100;
  let stored = 0;

  for (let i = 0; i < serialized.length; i += chunkSize) {
    const chunk = serialized.slice(i, i + chunkSize);

    await redisCommand([
      "RPUSH",
      ANALYZE_EVENTS_KEY,
      ...chunk
    ]);

    stored += chunk.length;
  }

  await redisCommand([
    "LTRIM",
    ANALYZE_EVENTS_KEY,
    Math.max(-ANALYZE_MAX_ROWS, -500000),
    -1
  ]);

  return {
    ok: true,
    stored,
    key: ANALYZE_EVENTS_KEY
  };
}

export async function readAnalyzeEventsFromRedis() {
  if (!hasAnalyzeRedis()) return [];

  const result = await redisCommand([
    "LRANGE",
    ANALYZE_EVENTS_KEY,
    0,
    -1
  ]);

  if (!Array.isArray(result)) return [];

  return result
    .map(safeJsonParse)
    .filter(Boolean);
}

export async function readLocalTradeRows() {
  const filePath = path.join(process.cwd(), "data", "trades.json");

  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.trades)) return parsed.trades;
    if (Array.isArray(parsed?.events)) return parsed.events;
    if (Array.isArray(parsed?.actions)) return parsed.actions;

    return [];
  } catch {
    return [];
  }
}

export async function readAllAnalyzeEvents(options = {}) {
  const includeLocal = options.includeLocal !== false;

  const [redisRows, localRows] = await Promise.all([
    readAnalyzeEventsFromRedis().catch(() => []),
    includeLocal ? readLocalTradeRows().catch(() => []) : Promise.resolve([])
  ]);

  return dedupeRows([
    ...localRows.map(row => ({
      ...row,
      source: row?.source || "LOCAL_TRADES_JSON"
    })),
    ...redisRows
  ]);
}

export async function resetAnalyzeStore() {
  if (!hasAnalyzeRedis()) {
    return {
      ok: false,
      skipped: true,
      reason: "REDIS_DISABLED"
    };
  }

  await redisCommand([
    "DEL",
    ANALYZE_EVENTS_KEY
  ]);

  return {
    ok: true,
    deletedKey: ANALYZE_EVENTS_KEY
  };
}

export function getAnalyzeStoreMeta() {
  return {
    redisEnabled: hasAnalyzeRedis(),
    key: ANALYZE_EVENTS_KEY,
    maxRows: ANALYZE_MAX_ROWS
  };
}