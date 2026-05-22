// ================= lib/analyze/analyzeStore.js =================

import fs from "fs/promises";
import path from "path";

const STORE_VERSION = "ANALYZE_STORE_V2";
const DEFAULT_MAX_ROWS = Number(process.env.ANALYZE_MAX_ROWS || 50_000);

const LOCAL_FILE = path.join(process.cwd(), "data", "trades.json");
const REDIS_KEY = process.env.ANALYZE_REDIS_KEY || "analysis:trades:v2";

let volatileRows = [];

function getRedisUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
}

function getRedisToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
}

export function hasAnalyzeRedis() {
  return Boolean(getRedisUrl() && getRedisToken());
}

async function redisCommand(command) {
  const url = getRedisUrl();
  const token = getRedisToken();

  if (!url || !token) throw new Error("redis_env_missing");

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

function extractRows(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.actions)) return payload.actions;
  if (Array.isArray(payload.trades)) return payload.trades;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;

  if (payload.action || payload.symbol || payload.tradeId) return [payload];

  return [];
}

function normalizeIngestPayload(payload, meta = {}) {
  const rows = extractRows(payload);
  const now = Date.now();

  const context = {
    storeVersion: STORE_VERSION,
    ingestedAt: now,

    runId: payload?.runId || meta?.runId || null,
    btcState: payload?.btcState || meta?.btcState || null,
    strategyVersion: payload?.strategyVersion || meta?.strategyVersion || null,
    discoveryMode: payload?.discoveryMode ?? meta?.discoveryMode ?? null,

    filterValues:
      payload?.filterValues ||
      payload?.currentFilterValues ||
      payload?.tradeSystemFilters ||
      meta?.filterValues ||
      meta?.currentFilterValues ||
      meta?.tradeSystemFilters ||
      null
  };

  return rows
    .filter(Boolean)
    .map((row, index) => ({
      ...row,
      _analysisStore: {
        ...context,
        index
      },
      runId: row.runId || context.runId,
      btcState: row.btcState || context.btcState,
      strategyVersion: row.strategyVersion || context.strategyVersion,
      filterValues: row.filterValues || context.filterValues,
      ts: Number(row.ts || row.createdAt || row.exitedAt || now)
    }));
}

async function readLocalRows() {
  try {
    const text = await fs.readFile(LOCAL_FILE, "utf8");
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.rows)) return parsed.rows;
    if (Array.isArray(parsed.trades)) return parsed.trades;
    if (Array.isArray(parsed.actions)) return parsed.actions;

    return [];
  } catch {
    return [];
  }
}

async function writeLocalRows(rows) {
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });

  const payload = {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    rows
  };

  await fs.writeFile(LOCAL_FILE, JSON.stringify(payload, null, 2), "utf8");
}

export async function loadAnalysisRows({ limit = DEFAULT_MAX_ROWS } = {}) {
  if (hasAnalyzeRedis()) {
    const start = Math.max(0, -Math.abs(Number(limit || DEFAULT_MAX_ROWS)));
    const raw = await redisCommand(["LRANGE", REDIS_KEY, start, -1]);

    return (Array.isArray(raw) ? raw : [])
      .map(item => {
        try {
          return typeof item === "string" ? JSON.parse(item) : item;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  const localRows = await readLocalRows();
  const merged = [...localRows, ...volatileRows];

  return merged.slice(-Math.abs(Number(limit || DEFAULT_MAX_ROWS)));
}

export async function ingestAnalysisRows(payload, meta = {}) {
  const rows = normalizeIngestPayload(payload, meta);
  if (!rows.length) {
    return {
      ok: true,
      sent: 0,
      total: 0,
      storageMode: hasAnalyzeRedis() ? "redis" : "local_memory",
      skipped: true,
      reason: "NO_ROWS"
    };
  }

  const maxRows = Number(meta.maxRows || DEFAULT_MAX_ROWS);

  if (hasAnalyzeRedis()) {
    const chunkSize = 100;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize).map(row => JSON.stringify(row));
      await redisCommand(["RPUSH", REDIS_KEY, ...chunk]);
    }

    await redisCommand(["LTRIM", REDIS_KEY, -maxRows, -1]);

    return {
      ok: true,
      sent: rows.length,
      total: rows.length,
      storageMode: "redis",
      key: REDIS_KEY
    };
  }

  volatileRows.push(...rows);
  volatileRows = volatileRows.slice(-maxRows);

  try {
    const current = await readLocalRows();
    const next = [...current, ...rows].slice(-maxRows);
    await writeLocalRows(next);
  } catch {
    // Vercel filesystem can be read-only. Memory fallback blijft draaien.
  }

  return {
    ok: true,
    sent: rows.length,
    total: rows.length,
    storageMode: "local_memory_or_file"
  };
}

export async function resetAnalysisRows() {
  volatileRows = [];

  if (hasAnalyzeRedis()) {
    await redisCommand(["DEL", REDIS_KEY]);
    return {
      ok: true,
      storageMode: "redis",
      key: REDIS_KEY
    };
  }

  try {
    await writeLocalRows([]);
  } catch {}

  return {
    ok: true,
    storageMode: "local_memory_or_file"
  };
}

export function getAnalyzeStoreInfo() {
  return {
    version: STORE_VERSION,
    storageMode: hasAnalyzeRedis() ? "redis" : "local_memory_or_file",
    redisEnabled: hasAnalyzeRedis(),
    redisKey: hasAnalyzeRedis() ? REDIS_KEY : null,
    localFile: LOCAL_FILE,
    volatileRows: volatileRows.length,
    maxRows: DEFAULT_MAX_ROWS
  };
}