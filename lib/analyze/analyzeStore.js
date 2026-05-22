import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, "../..");
const DEFAULT_STORE_PATH = process.env.ANALYZE_STORE_PATH || "/tmp/analyze-events.json";
const SEED_TRADES_PATH = path.join(ROOT_DIR, "data", "trades.json");

const MAX_STORED_EVENTS = Number(process.env.ANALYZE_MAX_STORED_EVENTS || 50_000);

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function normalizeEvent(event, meta = {}) {
  const src = safeObject(event);
  const now = Date.now();

  return {
    ...src,
    analyzeTs: safeNumber(src.analyzeTs ?? src.ts ?? src.updatedAt ?? meta.ts, now),
    source: src.source || meta.source || "trade_system",
    storedAt: now,
  };
}

function unwrapStoredEvents(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.trades)) return payload.trades;
  if (Array.isArray(payload?.actions)) return payload.actions;
  return [];
}

function extractEventsFromDataFile(payload) {
  const root = safeObject(payload);

  return [
    ...safeArray(root.events),
    ...safeArray(root.trades),
    ...safeArray(root.actions),
    ...safeArray(root.open),
    ...safeArray(root.closed),
    ...safeArray(root.positions),
    ...safeArray(root.tradeHistory),
    ...safeArray(root.history),
  ];
}

export async function readAnalyzeEvents(options = {}) {
  const limit = Math.max(0, safeNumber(options.limit, MAX_STORED_EVENTS));

  const storePayload = await readJson(DEFAULT_STORE_PATH, { events: [] });
  const storeEvents = unwrapStoredEvents(storePayload).map((event) =>
    normalizeEvent(event, { source: "analyze_store" })
  );

  if (storeEvents.length) {
    return limit ? storeEvents.slice(-limit) : storeEvents;
  }

  const seedPayload = await readJson(SEED_TRADES_PATH, { events: [] });
  const seedEvents = extractEventsFromDataFile(seedPayload).map((event) =>
    normalizeEvent(event, { source: "data_trades_json" })
  );

  return limit ? seedEvents.slice(-limit) : seedEvents;
}

export async function appendAnalyzeEvents(events, meta = {}) {
  const incoming = safeArray(events).length ? safeArray(events) : events ? [events] : [];

  if (!incoming.length) {
    return {
      ok: true,
      appended: 0,
      total: unwrapStoredEvents(await readJson(DEFAULT_STORE_PATH, { events: [] })).length,
      path: DEFAULT_STORE_PATH,
    };
  }

  const currentPayload = await readJson(DEFAULT_STORE_PATH, { events: [] });
  const current = unwrapStoredEvents(currentPayload);

  const normalized = incoming.map((event) => normalizeEvent(event, meta));
  const next = [...current, ...normalized].slice(-MAX_STORED_EVENTS);

  await writeJson(DEFAULT_STORE_PATH, {
    ok: true,
    updatedAt: Date.now(),
    count: next.length,
    events: next,
  });

  return {
    ok: true,
    appended: normalized.length,
    total: next.length,
    path: DEFAULT_STORE_PATH,
  };
}

export async function clearAnalyzeEvents() {
  await writeJson(DEFAULT_STORE_PATH, {
    ok: true,
    updatedAt: Date.now(),
    count: 0,
    events: [],
  });

  return {
    ok: true,
    cleared: true,
    path: DEFAULT_STORE_PATH,
  };
}

export async function getAnalyzeStoreInfo() {
  const payload = await readJson(DEFAULT_STORE_PATH, { events: [] });
  const events = unwrapStoredEvents(payload);

  return {
    ok: true,
    path: DEFAULT_STORE_PATH,
    count: events.length,
    maxStoredEvents: MAX_STORED_EVENTS,
  };
}