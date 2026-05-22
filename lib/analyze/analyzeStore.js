import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ANALYZE_PATH = process.env.ANALYZE_EVENTS_PATH || "/tmp/analyze-events.json";
const MAX_STORED_EVENTS = Number(process.env.ANALYZE_MAX_STORED_EVENTS || 50000);

const MEMORY_KEY = "__TRADESYSTEM_ANALYZE_EVENTS_V2__";

function getMemoryStore() {
  if (!globalThis[MEMORY_KEY]) {
    globalThis[MEMORY_KEY] = [];
  }

  return globalThis[MEMORY_KEY];
}

function setMemoryStore(events) {
  globalThis[MEMORY_KEY] = Array.isArray(events) ? events : [];
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTimestamp(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function normalizeSymbol(value) {
  return String(value || "").toUpperCase().trim();
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["long", "bull", "buy"].includes(s)) return "LONG";
  if (["short", "bear", "sell"].includes(s)) return "SHORT";

  return "";
}

function stableNumber(value) {
  const n = safeNumber(value, 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100000) / 100000;
}

function makeEventKey(event, ts) {
  const explicit =
    event.analyzeEventId ||
    event.eventId ||
    event.tradeId ||
    event.positionId ||
    event.orderId ||
    event.id;

  if (explicit) {
    return String(explicit);
  }

  const symbol = normalizeSymbol(event.symbol);
  const side = normalizeSide(event.side || event.direction);
  const action = String(event.action || event.status || event.reason || "").toUpperCase().trim();
  const entry = stableNumber(event.entry ?? event.entryPrice);
  const sl = stableNumber(event.sl ?? event.stopLoss);
  const tp = stableNumber(event.tp ?? event.takeProfit);
  const created = normalizeTimestamp(
    event.createdAt ??
      event.openedAt ??
      event.entryTs ??
      event.ts,
    ts
  );

  return [
    symbol,
    side,
    action,
    entry,
    sl,
    tp,
    created,
  ].join("|");
}

function compactEvent(event, meta = {}) {
  const now = Date.now();
  const ts = normalizeTimestamp(
    event.ts ??
      event.updatedAt ??
      event.createdAt ??
      meta.ts,
    now
  );

  const key = makeEventKey(event, ts);

  return {
    ...event,
    analyzeEventKey: key,
    analyzeSource: meta.source || event.analyzeSource || "unknown",
    analyzeStoredAt: now,
    analyzeTs: ts,
    ts: event.ts ?? ts,
  };
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.events)) return parsed.events;

    return [];
  } catch (e) {
    if (e?.code === "ENOENT") return [];

    console.error("ANALYZE STORE READ ERROR:", e);
    return [];
  }
}

async function writeJsonFile(filePath, events) {
  await ensureDir(filePath);

  const payload = {
    ok: true,
    updatedAt: Date.now(),
    count: events.length,
    maxStoredEvents: MAX_STORED_EVENTS,
    events,
  };

  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload), "utf8");
  await fs.rename(tmpPath, filePath);
}

function dedupeEvents(events) {
  const map = new Map();

  for (const event of safeArray(events)) {
    if (!event || typeof event !== "object") continue;

    const ts = normalizeTimestamp(event.ts ?? event.analyzeTs ?? event.updatedAt ?? event.createdAt);
    const key = event.analyzeEventKey || makeEventKey(event, ts);

    map.set(key, {
      ...event,
      analyzeEventKey: key,
      analyzeTs: event.analyzeTs ?? ts,
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    const at = normalizeTimestamp(a.analyzeTs ?? a.ts ?? a.updatedAt ?? a.createdAt, 0);
    const bt = normalizeTimestamp(b.analyzeTs ?? b.ts ?? b.updatedAt ?? b.createdAt, 0);
    return at - bt;
  });
}

function trimEvents(events) {
  const clean = dedupeEvents(events);

  if (clean.length <= MAX_STORED_EVENTS) return clean;

  return clean.slice(clean.length - MAX_STORED_EVENTS);
}

export async function loadAnalyzeEvents(filePath = DEFAULT_ANALYZE_PATH) {
  const diskEvents = await readJsonFile(filePath);
  const memoryEvents = getMemoryStore();

  const merged = trimEvents([
    ...safeArray(diskEvents),
    ...safeArray(memoryEvents),
  ]);

  setMemoryStore(merged);

  return merged;
}

export async function loadAnalyzeStore(filePath = DEFAULT_ANALYZE_PATH) {
  const events = await loadAnalyzeEvents(filePath);

  return {
    ok: true,
    path: filePath,
    count: events.length,
    maxStoredEvents: MAX_STORED_EVENTS,
    events,
  };
}

export async function readAnalyzeEvents(filePath = DEFAULT_ANALYZE_PATH) {
  return loadAnalyzeEvents(filePath);
}

export async function getAnalyzeEvents(filePath = DEFAULT_ANALYZE_PATH) {
  return loadAnalyzeEvents(filePath);
}

export async function getAnalyzeStoreMeta(filePath = DEFAULT_ANALYZE_PATH) {
  const events = await loadAnalyzeEvents(filePath);

  return {
    ok: true,
    path: filePath,
    count: events.length,
    maxStoredEvents: MAX_STORED_EVENTS,
  };
}

export async function appendAnalyzeEvents(events, meta = {}, filePath = DEFAULT_ANALYZE_PATH) {
  const incoming = safeArray(events)
    .filter(event => event && typeof event === "object")
    .map(event => compactEvent(event, meta));

  if (!incoming.length) {
    const existing = await loadAnalyzeEvents(filePath);

    return {
      ok: true,
      path: filePath,
      added: 0,
      count: existing.length,
      maxStoredEvents: MAX_STORED_EVENTS,
    };
  }

  const existing = await loadAnalyzeEvents(filePath);
  const merged = trimEvents([...existing, ...incoming]);

  setMemoryStore(merged);

  try {
    await writeJsonFile(filePath, merged);
  } catch (e) {
    console.error("ANALYZE STORE WRITE ERROR:", e);

    return {
      ok: false,
      path: filePath,
      added: incoming.length,
      count: merged.length,
      maxStoredEvents: MAX_STORED_EVENTS,
      error: e?.message || "write_failed",
    };
  }

  return {
    ok: true,
    path: filePath,
    added: incoming.length,
    count: merged.length,
    maxStoredEvents: MAX_STORED_EVENTS,
  };
}

export async function clearAnalyzeEvents(filePath = DEFAULT_ANALYZE_PATH) {
  setMemoryStore([]);

  try {
    await ensureDir(filePath);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        ok: true,
        updatedAt: Date.now(),
        count: 0,
        maxStoredEvents: MAX_STORED_EVENTS,
        events: [],
      }),
      "utf8"
    );
  } catch (e) {
    console.error("ANALYZE STORE CLEAR ERROR:", e);

    return {
      ok: false,
      path: filePath,
      count: 0,
      error: e?.message || "clear_failed",
    };
  }

  return {
    ok: true,
    path: filePath,
    count: 0,
    maxStoredEvents: MAX_STORED_EVENTS,
  };
}

export async function resetAnalyzeEvents(filePath = DEFAULT_ANALYZE_PATH) {
  return clearAnalyzeEvents(filePath);
}

export default {
  appendAnalyzeEvents,
  loadAnalyzeEvents,
  loadAnalyzeStore,
  readAnalyzeEvents,
  getAnalyzeEvents,
  getAnalyzeStoreMeta,
  clearAnalyzeEvents,
  resetAnalyzeEvents,
};