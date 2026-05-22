// lib/analyze/analyzeStore.js
import fs from "fs/promises";
import path from "path";

const MAX_EVENTS = 20000;
const STORE_FILE = path.join("/tmp", "tradesystem-analyze-events.json");

// ================= HELPERS =================
function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSide(value) {
  const s = String(value || "").toUpperCase().trim();

  if (["LONG", "BULL", "BUY"].includes(s)) return "LONG";
  if (["SHORT", "BEAR", "SELL"].includes(s)) return "SHORT";

  return s || "UNKNOWN";
}

function normalizeStatus(value, fallback = "SHADOW") {
  const s = String(value || "").toUpperCase().trim();

  if (["OPEN", "CLOSED", "SHADOW", "WIN", "LOSS", "TP", "SL"].includes(s)) {
    if (s === "WIN" || s === "LOSS" || s === "TP" || s === "SL") return "CLOSED";
    return s;
  }

  return fallback;
}

function stableId(event) {
  if (event?.id) return String(event.id);
  if (event?.tradeId) return String(event.tradeId);
  if (event?.positionId) return String(event.positionId);
  if (event?.orderId) return String(event.orderId);

  const symbol = String(event?.symbol || "NA").toUpperCase();
  const side = normalizeSide(event?.side);
  const status = normalizeStatus(event?.status);
  const stage = String(event?.stage || event?.scannerStage || "NA").toUpperCase();
  const ts = String(event?.createdAt || event?.ts || event?.timestamp || nowIso());

  return `${symbol}_${side}_${status}_${stage}_${ts}`;
}

function normalizeEvent(input = {}) {
  const event = {
    ...input,
    id: stableId(input),
    symbol: String(input.symbol || "").toUpperCase().trim(),
    side: normalizeSide(input.side),
    status: normalizeStatus(input.status, input.sourceType === "accepted_candidate" ? "SHADOW" : "OPEN"),
    source: input.source || "analyze-store",
    sourceType: input.sourceType || "event",
    createdAt: input.createdAt || input.ts || input.timestamp || nowIso(),
  };

  event.rr = input.rr === undefined ? input.rr : safeNumber(input.rr, input.rr);
  event.baseRR = input.baseRR === undefined ? input.baseRR : safeNumber(input.baseRR, input.baseRR);
  event.finalRR = input.finalRR === undefined ? input.finalRR : safeNumber(input.finalRR, input.finalRR);
  event.confluence = input.confluence === undefined ? input.confluence : safeNumber(input.confluence, input.confluence);
  event.sniper = input.sniper === undefined ? input.sniper : safeNumber(input.sniper, input.sniper);
  event.sniperScore = input.sniperScore === undefined ? input.sniperScore : safeNumber(input.sniperScore, input.sniperScore);
  event.score = input.score === undefined ? input.score : safeNumber(input.score, input.score);
  event.r = input.r === undefined ? input.r : safeNumber(input.r, input.r);
  event.pnlPct = input.pnlPct === undefined ? input.pnlPct : safeNumber(input.pnlPct, input.pnlPct);

  return event;
}

async function ensureDir() {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
}

async function readRawEvents() {
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return safeArray(parsed?.events || parsed);
  } catch {
    return [];
  }
}

async function writeRawEvents(events) {
  await ensureDir();

  const payload = {
    ok: true,
    updatedAt: Date.now(),
    generatedAt: nowIso(),
    count: events.length,
    events,
  };

  await fs.writeFile(STORE_FILE, JSON.stringify(payload, null, 2), "utf8");

  return payload;
}

function mergeEvents(existing, incoming) {
  const map = new Map();

  for (const item of safeArray(existing)) {
    const event = normalizeEvent(item);
    if (!event.id) continue;
    map.set(event.id, event);
  }

  for (const item of safeArray(incoming)) {
    const event = normalizeEvent(item);
    if (!event.id) continue;
    map.set(event.id, event);
  }

  return Array.from(map.values()).slice(-MAX_EVENTS);
}

// ================= PUBLIC API =================
export async function appendAnalyzeEvents(events = []) {
  const incoming = safeArray(events).filter(Boolean);

  if (!incoming.length) {
    return {
      ok: true,
      appended: 0,
      count: 0,
      events: await readRawEvents(),
    };
  }

  const existing = await readRawEvents();
  const merged = mergeEvents(existing, incoming);
  const written = await writeRawEvents(merged);

  return {
    ok: true,
    appended: incoming.length,
    count: written.count,
    events: written.events,
  };
}

export async function appendAnalyzeEvent(event = {}) {
  return appendAnalyzeEvents([event]);
}

export async function recordAnalyzeTrade(record = {}) {
  return appendAnalyzeEvent({
    ...record,
    source: record.source || "recordAnalyzeTrade",
  });
}

export async function appendAnalyzeTrade(record = {}) {
  return recordAnalyzeTrade(record);
}

export async function appendTrade(record = {}) {
  return recordAnalyzeTrade(record);
}

export async function saveAnalyzeTrade(record = {}) {
  return recordAnalyzeTrade(record);
}

export async function addAnalyzeTrade(record = {}) {
  return recordAnalyzeTrade(record);
}

export async function addTrade(record = {}) {
  return recordAnalyzeTrade(record);
}

export async function recordTrade(record = {}) {
  return recordAnalyzeTrade(record);
}

export async function getAnalyzeEvents(options = {}) {
  const limit = safeNumber(options.limit, MAX_EVENTS);
  const events = await readRawEvents();

  return {
    ok: true,
    generatedAt: nowIso(),
    count: events.length,
    events: events.slice(-limit),
  };
}

export async function getAnalyzeRecords(options = {}) {
  return getAnalyzeEvents(options);
}

export async function readAnalyzeEvents(options = {}) {
  return getAnalyzeEvents(options);
}

export async function resetAnalyzeEvents() {
  const written = await writeRawEvents([]);

  return {
    ok: true,
    reset: true,
    count: written.count,
    events: written.events,
  };
}

export default {
  appendAnalyzeEvents,
  appendAnalyzeEvent,
  recordAnalyzeTrade,
  appendAnalyzeTrade,
  appendTrade,
  saveAnalyzeTrade,
  addAnalyzeTrade,
  addTrade,
  recordTrade,
  getAnalyzeEvents,
  getAnalyzeRecords,
  readAnalyzeEvents,
  resetAnalyzeEvents,
};