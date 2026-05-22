import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();

const DATA_FILES = [
  "data/trades.json",
  "data/trade-history.json",
  "data/trades-history.json",
  "data/trade_history.json",
  "data/analyze-trades.json",
  "data/analyse-trades.json",
  "data/funnel-trades.json",
  "data/actions.json",
  "data/positions.json",
  "data/closed-trades.json",
  "data/open-trades.json",
];

const TMP_FILE = "/tmp/analyze-trades.json";

function nowIso() {
  return new Date().toISOString();
}

function safeArr(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function uniqueKey(trade) {
  return String(
    trade?.id ||
      trade?.tradeId ||
      trade?.positionId ||
      trade?.orderId ||
      `${trade?.symbol || "NA"}:${trade?.side || "NA"}:${trade?.entryTime || trade?.createdAt || trade?.openedAt || trade?.timestamp || ""}:${trade?.exitTime || trade?.closedAt || ""}`
  );
}

function dedupeTrades(trades) {
  const map = new Map();

  for (const trade of safeArr(trades)) {
    if (!isPlainObject(trade)) continue;

    const key = uniqueKey(trade);
    const previous = map.get(key);

    if (!previous) {
      map.set(key, trade);
      continue;
    }

    map.set(key, {
      ...previous,
      ...trade,
      raw: trade.raw || previous.raw,
    });
  }

  return [...map.values()];
}

function extractArrayFromPayload(payload) {
  if (Array.isArray(payload)) return payload;

  if (!isPlainObject(payload)) return [];

  const directKeys = [
    "trades",
    "actions",
    "history",
    "items",
    "data",
    "positions",
    "closed",
    "open",
    "results",
  ];

  for (const key of directKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  if (Array.isArray(payload?.report?.trades)) return payload.report.trades;
  if (Array.isArray(payload?.report?.actions)) return payload.report.actions;
  if (Array.isArray(payload?.data?.trades)) return payload.data.trades;
  if (Array.isArray(payload?.data?.actions)) return payload.data.actions;
  if (Array.isArray(payload?.result?.trades)) return payload.result.trades;
  if (Array.isArray(payload?.result?.actions)) return payload.result.actions;

  return [];
}

async function readJsonFile(absPath) {
  const raw = await fs.readFile(absPath, "utf8");
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

async function fileExists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function loadFromFile(relativeOrAbsolutePath) {
  const absPath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(ROOT, relativeOrAbsolutePath);

  const exists = await fileExists(absPath);
  if (!exists) {
    return {
      source: relativeOrAbsolutePath,
      ok: false,
      count: 0,
      reason: "missing",
      trades: [],
    };
  }

  try {
    const payload = await readJsonFile(absPath);
    const trades = extractArrayFromPayload(payload);

    return {
      source: relativeOrAbsolutePath,
      ok: true,
      count: trades.length,
      trades,
    };
  } catch (err) {
    return {
      source: relativeOrAbsolutePath,
      ok: false,
      count: 0,
      reason: err?.message || "read_failed",
      trades: [],
    };
  }
}

function getMemoryTrades() {
  const buckets = [
    globalThis.__ANALYZE_TRADES__,
    globalThis.__TRADE_HISTORY__,
    globalThis.__TRADES__,
    globalThis.__FUNNEL_TRADES__,
  ];

  return buckets.flatMap((bucket) => safeArr(bucket));
}

async function loadFromRemoteApi() {
  if (!process.env.VERCEL_URL && !process.env.ANALYZE_TRADES_URL) {
    return [];
  }

  const urls = [];

  if (process.env.ANALYZE_TRADES_URL) {
    urls.push(process.env.ANALYZE_TRADES_URL);
  }

  if (process.env.VERCEL_URL) {
    const base = `https://${process.env.VERCEL_URL}`;
    urls.push(`${base}/api/trade-history`);
    urls.push(`${base}/api/trade-stats`);
  }

  const results = [];

  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3500);

      const res = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        results.push({
          source: url,
          ok: false,
          count: 0,
          reason: `http_${res.status}`,
          trades: [],
        });
        continue;
      }

      const payload = await res.json();
      const trades = extractArrayFromPayload(payload);

      results.push({
        source: url,
        ok: true,
        count: trades.length,
        trades,
      });
    } catch (err) {
      results.push({
        source: url,
        ok: false,
        count: 0,
        reason: err?.message || "fetch_failed",
        trades: [],
      });
    }
  }

  return results;
}

export async function listAnalyzeTrades(options = {}) {
  const includeRemote = options.includeRemote !== false;

  const fileResults = await Promise.all([
    ...DATA_FILES.map((file) => loadFromFile(file)),
    loadFromFile(TMP_FILE),
  ]);

  const memoryTrades = getMemoryTrades();
  const memoryResult = {
    source: "memory",
    ok: true,
    count: memoryTrades.length,
    trades: memoryTrades,
  };

  const remoteResults = includeRemote ? await loadFromRemoteApi() : [];

  const allResults = [...fileResults, memoryResult, ...remoteResults];

  const trades = dedupeTrades(
    allResults.flatMap((result) => safeArr(result.trades))
  );

  const sources = allResults
    .filter((result) => result.ok && result.count > 0)
    .map((result) => ({
      source: result.source,
      count: result.count,
    }));

  const diagnostics = allResults.map((result) => ({
    source: result.source,
    ok: result.ok,
    count: result.count,
    reason: result.reason || null,
  }));

  return {
    ok: true,
    generatedAt: nowIso(),
    trades,
    tradesLoaded: trades.length,
    sources,
    diagnostics,
  };
}

async function writeJsonSafe(absPath, payload) {
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, JSON.stringify(payload, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function recordAnalyzeTrade(input = {}) {
  if (!globalThis.__ANALYZE_TRADES__) {
    globalThis.__ANALYZE_TRADES__ = [];
  }

  const trade = {
    ...input,
    analyzeRecordedAt: nowIso(),
  };

  globalThis.__ANALYZE_TRADES__.push(trade);

  const tmpExisting = await loadFromFile(TMP_FILE);
  const nextTmpTrades = dedupeTrades([...safeArr(tmpExisting.trades), trade]);

  await writeJsonSafe(TMP_FILE, {
    ok: true,
    updatedAt: nowIso(),
    trades: nextTmpTrades,
  });

  const dataPath = path.join(ROOT, "data", "analyze-trades.json");
  const dataExisting = await loadFromFile(dataPath);
  const nextDataTrades = dedupeTrades([...safeArr(dataExisting.trades), trade]);

  await writeJsonSafe(dataPath, {
    ok: true,
    updatedAt: nowIso(),
    trades: nextDataTrades,
  });

  return {
    ok: true,
    stored: true,
    trade,
  };
}

export default {
  listAnalyzeTrades,
  recordAnalyzeTrade,
};