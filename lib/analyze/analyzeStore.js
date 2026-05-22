// ================= lib/analyze/analyzeStore.js =================

const ANALYZE_STORE_KEY = process.env.ANALYZE_STORE_KEY || "TS_ANALYZE:ROWS:V3";
const ANALYZE_MAX_ROWS = Number(process.env.ANALYZE_MAX_ROWS || 50_000);
const RPUSH_BATCH_SIZE = 150;

const globalKey = "__TS_ANALYZE_MEMORY_STORE__";

if (!globalThis[globalKey]) {
  globalThis[globalKey] = [];
}

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

function hasRedis() {
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
    throw new Error(json?.error || text?.slice(0, 500) || `redis_error_${res.status}`);
  }

  return json?.result;
}

function chunkArray(rows, size) {
  const chunks = [];

  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }

  return chunks;
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

function extractRows(body) {
  if (Array.isArray(body)) return body;

  if (Array.isArray(body?.actions)) return body.actions;
  if (Array.isArray(body?.rows)) return body.rows;
  if (Array.isArray(body?.trades)) return body.trades;

  if (Array.isArray(body?.analysis?.actions)) return body.analysis.actions;
  if (Array.isArray(body?.analysis?.rows)) return body.analysis.rows;

  if (Array.isArray(body?.report?.actions)) return body.report.actions;
  if (Array.isArray(body?.report?.rows)) return body.report.rows;
  if (Array.isArray(body?.report?.trades)) return body.report.trades;

  if (Array.isArray(body?.payload?.actions)) return body.payload.actions;
  if (Array.isArray(body?.payload?.rows)) return body.payload.rows;

  return [];
}

function extractMeta(body, meta = {}) {
  return {
    source: body?.source || meta?.source || "tradeSystem",
    runId: body?.runId || meta?.runId || body?.meta?.runId || null,
    btcState: body?.btcState || meta?.btcState || body?.meta?.btcState || null,
    strategyVersion: body?.strategyVersion || meta?.strategyVersion || body?.meta?.strategyVersion || null,
    discoveryMode: body?.discoveryMode ?? meta?.discoveryMode ?? body?.meta?.discoveryMode ?? null,

    filterValues:
      body?.filterValues ||
      body?.currentFilterValues ||
      body?.tradeSystemFilters ||
      body?.meta?.filterValues ||
      body?.meta?.currentFilterValues ||
      meta?.filterValues ||
      meta?.currentFilterValues ||
      null
  };
}

function enrichRows(rows, meta) {
  const now = Date.now();

  return rows
    .filter(row => row && typeof row === "object")
    .map(row => ({
      ...row,
      _analyzeIngestedAt: now,
      _analyzeMeta: meta
    }));
}

export async function ingestAnalysisRows(body, meta = {}) {
  const rows = extractRows(body);
  const finalMeta = extractMeta(body, meta);
  const enriched = enrichRows(rows, finalMeta);

  if (!enriched.length) {
    return {
      ingested: 0,
      total: await getStoredCountSafe(),
      storage: hasRedis() ? "redis" : "memory",
      reason: "NO_ROWS"
    };
  }

  if (hasRedis()) {
    const serialized = enriched.map(row => JSON.stringify(row));

    for (const chunk of chunkArray(serialized, RPUSH_BATCH_SIZE)) {
      await redisCommand(["RPUSH", ANALYZE_STORE_KEY, ...chunk]);
    }

    await redisCommand([
      "LTRIM",
      ANALYZE_STORE_KEY,
      Math.max(-ANALYZE_MAX_ROWS, -1 * ANALYZE_MAX_ROWS),
      -1
    ]);

    return {
      ingested: enriched.length,
      total: await getStoredCountSafe(),
      storage: "redis"
    };
  }

  const store = globalThis[globalKey];
  store.push(...enriched);

  if (store.length > ANALYZE_MAX_ROWS) {
    store.splice(0, store.length - ANALYZE_MAX_ROWS);
  }

  return {
    ingested: enriched.length,
    total: store.length,
    storage: "memory"
  };
}

export async function loadAnalysisRows({ limit = 50_000 } = {}) {
  const max = Math.max(1, Number(limit || 50_000));

  if (hasRedis()) {
    const rawRows = await redisCommand(["LRANGE", ANALYZE_STORE_KEY, -max, -1]);
    const arr = Array.isArray(rawRows) ? rawRows : [];

    return arr
      .map(safeJsonParse)
      .filter(row => row && typeof row === "object");
  }

  return globalThis[globalKey].slice(-max);
}

export async function resetAnalysisRows() {
  if (hasRedis()) {
    await redisCommand(["DEL", ANALYZE_STORE_KEY]);

    return {
      cleared: true,
      total: 0,
      storage: "redis"
    };
  }

  globalThis[globalKey] = [];

  return {
    cleared: true,
    total: 0,
    storage: "memory"
  };
}

async function getStoredCountSafe() {
  try {
    if (hasRedis()) {
      return Number(await redisCommand(["LLEN", ANALYZE_STORE_KEY])) || 0;
    }

    return globalThis[globalKey].length;
  } catch {
    return 0;
  }
}

export function getAnalyzeStoreInfo() {
  return {
    key: ANALYZE_STORE_KEY,
    maxRows: ANALYZE_MAX_ROWS,
    redisEnabled: hasRedis(),
    storage: hasRedis() ? "redis" : "memory"
  };
}