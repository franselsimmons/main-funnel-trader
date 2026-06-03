// lib/rotation/rotationRunner.js

import fs from "node:fs/promises";
import path from "node:path";

import { selectWeeklyRotation } from "./weeklySelector.js";
import {
  appendRotationHistory,
  saveActiveRotation,
  saveNextRotation
} from "./rotationStore.js";

// ================= CONFIG =================

const HAS_PROCESS = typeof process !== "undefined";
const PROCESS_ENV = HAS_PROCESS ? process.env : {};

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const SOURCE_LIMIT = safeInteger(
  PROCESS_ENV.ROTATION_RUNNER_SOURCE_LIMIT,
  10_000,
  100,
  250_000
);

const SOURCE_TIMEOUT_MS = safeInteger(
  PROCESS_ENV.ROTATION_RUNNER_SOURCE_TIMEOUT_MS,
  10_000,
  500,
  120_000
);

const TRADES_JSON_PATH =
  PROCESS_ENV.ROTATION_TRADES_JSON_PATH ||
  path.join(HAS_PROCESS ? process.cwd() : ".", "data", "trades.json");

const RUNNER_VERSION = "rotation-runner-v3";

const moduleCache = new Map();

// ================= BASIC HELPERS =================

function nowMs() {
  return Date.now();
}

function safeInteger(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.min(max, Math.max(min, Math.trunc(n)));
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

function cleanToken(value, fallback = "") {
  const raw = String(value ?? "").trim();

  if (!raw) return fallback;

  return (
    raw
      .replace(/\[object object\]/gi, "")
      .replace(/\{.*?\}/g, "")
      .replace(/[^A-Z0-9.%+-]+/gi, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || fallback
  );
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;

  const raw = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;

  return fallback;
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

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === "") return "";

  const direct = Number(value);
  if (Number.isFinite(direct)) return String(Math.trunc(direct));

  const parsed = Number(new Date(value));
  if (Number.isFinite(parsed)) return String(Math.trunc(parsed));

  return cleanToken(value);
}

function normalizeSide(value) {
  const raw = String(value ?? "").toLowerCase();

  if (["long", "bull", "buy", "bullish"].includes(raw)) return "LONG";
  if (["short", "bear", "sell", "bearish"].includes(raw)) return "SHORT";

  const token = cleanToken(value);

  if (token === "LONG" || token === "SHORT") return token;

  return "";
}

function normalizeSymbol(value) {
  return cleanToken(value)
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function extractRowTimestamp(row = {}) {
  return (
    row.closedAt ??
    row.exitTs ??
    row.exitTime ??
    row.closeTime ??
    row.completedAt ??
    row.updatedAt ??
    row.createdAt ??
    row.ts ??
    row.time ??
    row.timestamp ??
    ""
  );
}

function extractRowPnl(row = {}) {
  return (
    row.pnlR ??
    row.realizedR ??
    row.rMultiple ??
    row.pnl ??
    row.realizedPnl ??
    row.profit ??
    row.netPnl ??
    ""
  );
}

function buildRowDedupeKey(row = {}, index = 0) {
  const id =
    row.id ??
    row.tradeId ??
    row.positionId ??
    row.orderId ??
    row.eventId ??
    row.signalId ??
    row.uid ??
    null;

  if (id !== null && id !== undefined && id !== "") {
    return `ID:${cleanToken(id)}`;
  }

  const symbol = normalizeSymbol(
    row.symbol ??
      row.baseCoin ??
      row.coin ??
      row.instId ??
      row.market ??
      ""
  );

  const side = normalizeSide(
    row.tradeSide ??
      row.rotationSide ??
      row.side ??
      row.direction ??
      row.bias ??
      ""
  );

  const family =
    cleanToken(
      row.microFamilyId ??
        row.rotationMicroFamilyId ??
        row.analyzerMicroFamilyId ??
        row.familyId ??
        row.parentFamilyId ??
        row.analyzeFamilyId ??
        row.analysisFamilyId ??
        ""
    ) || "NO_FAMILY";

  const ts = normalizeTimestamp(extractRowTimestamp(row));
  const pnl = cleanToken(extractRowPnl(row), "NO_PNL");

  if (!symbol && !side && family === "NO_FAMILY" && !ts) {
    return `ROW:${index}`;
  }

  return `${symbol || "NO_SYMBOL"}:${side || "NO_SIDE"}:${family}:${ts || "NO_TS"}:${pnl}`;
}

function uniqueRows(rows = []) {
  const seen = new Set();
  const result = [];

  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") return;

    const key = buildRowDedupeKey(row, index);

    if (seen.has(key)) return;

    seen.add(key);
    result.push(row);
  });

  return result;
}

function extractRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;

  const object = safeObject(payload);

  const directCandidates = [
    object.events,
    object.rows,
    object.items,
    object.outcomes,
    object.trades,
    object.closedTrades,
    object.entries,
    object.data?.events,
    object.data?.rows,
    object.data?.items,
    object.data?.outcomes,
    object.data?.trades,
    object.data?.closedTrades,
    object.data?.entries
  ];

  for (const candidate of directCandidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  const values = Object.values(object);

  if (values.every(value => value && typeof value === "object" && !Array.isArray(value))) {
    return values;
  }

  return values.flatMap(value => {
    if (Array.isArray(value)) return value;
    return [];
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;

  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timer]).finally(() => {
    clearTimeout(timeout);
  });
}

function logRunnerWarning(reason, detail = {}) {
  if (PROCESS_ENV.ROTATION_RUNNER_SILENT_WARNINGS === "true") return;

  console.warn(
    "ROTATION_RUNNER_WARNING:",
    JSON.stringify({
      reason,
      ...detail,
      ts: nowMs()
    })
  );
}

// ================= ISO WEEK =================

function pad2(n) {
  return String(n).padStart(2, "0");
}

function normalizeDate(dateLike = Date.now()) {
  const date = new Date(dateLike);
  const time = Number(date);

  if (Number.isFinite(time)) return date;

  return new Date();
}

function getIsoWeekParts(dateLike = Date.now()) {
  const date = normalizeDate(dateLike);

  const utc = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate()
    )
  );

  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / DAY_MS + 1) / 7);

  return {
    year: utc.getUTCFullYear(),
    week
  };
}

export function getIsoWeekKey(dateLike = Date.now()) {
  const { year, week } = getIsoWeekParts(dateLike);
  return `${year}_W${pad2(week)}`;
}

export function getNextIsoWeekKey(dateLike = Date.now()) {
  const date = normalizeDate(dateLike);
  return getIsoWeekKey(new Date(Number(date) + WEEK_MS));
}

// ================= DYNAMIC IMPORT =================

async function tryImport(modulePath) {
  if (moduleCache.has(modulePath)) {
    return moduleCache.get(modulePath);
  }

  try {
    const mod = await import(modulePath);
    moduleCache.set(modulePath, mod);
    return mod;
  } catch (error) {
    moduleCache.set(modulePath, null);

    logRunnerWarning("MODULE_IMPORT_FAILED", {
      modulePath,
      error: error?.message || String(error)
    });

    return null;
  }
}

async function callFirstAvailableLoader({
  modulePath,
  candidateNames,
  args = {}
}) {
  const mod = await tryImport(modulePath);

  if (!mod) {
    return {
      ok: false,
      source: modulePath,
      rows: [],
      loader: null,
      reason: "MODULE_NOT_AVAILABLE"
    };
  }

  for (const name of candidateNames) {
    const fn = mod[name];

    if (typeof fn !== "function") continue;

    try {
      const payload = await withTimeout(
        Promise.resolve(fn(args)),
        SOURCE_TIMEOUT_MS,
        `${modulePath}:${name}`
      );

      const rows = extractRowsFromPayload(payload);

      return {
        ok: true,
        source: modulePath,
        rows,
        loader: name,
        reason: "LOADED"
      };
    } catch (error) {
      logRunnerWarning("SOURCE_LOADER_FAILED", {
        modulePath,
        loader: name,
        error: error?.message || String(error)
      });
    }
  }

  return {
    ok: false,
    source: modulePath,
    rows: [],
    loader: null,
    reason: "NO_COMPATIBLE_LOADER"
  };
}

// ================= SOURCES =================

async function loadRowsFromAnalyzeStore() {
  return callFirstAvailableLoader({
    modulePath: "../analyze/analyzeStore.js",
    candidateNames: [
      "loadAnalyzeEvents",
      "getAnalyzeEvents",
      "readAnalyzeEvents",
      "loadAllAnalyzeEvents",
      "getAllEvents"
    ],
    args: {
      limit: SOURCE_LIMIT
    }
  });
}

async function loadRowsFromOutcomeStore() {
  return callFirstAvailableLoader({
    modulePath: "../microFamilyOutcomeStore.js",
    candidateNames: [
      "loadMicroFamilyOutcomes",
      "getMicroFamilyOutcomes",
      "loadOutcomeRows",
      "getOutcomeRows",
      "loadAllOutcomes"
    ],
    args: {
      limit: SOURCE_LIMIT
    }
  });
}

async function loadRowsFromTradesJson() {
  try {
    const raw = await withTimeout(
      fs.readFile(TRADES_JSON_PATH, "utf8"),
      SOURCE_TIMEOUT_MS,
      "trades.json"
    );

    const parsed = safeJsonParse(raw, null);
    const rows = extractRowsFromPayload(parsed);

    return {
      ok: true,
      source: TRADES_JSON_PATH,
      rows,
      loader: "tradesJson",
      reason: "LOADED"
    };
  } catch (error) {
    return {
      ok: false,
      source: TRADES_JSON_PATH,
      rows: [],
      loader: "tradesJson",
      reason: "TRADES_JSON_NOT_AVAILABLE",
      error: error?.message || String(error)
    };
  }
}

async function collectOutcomeRows() {
  const sourceResults = await Promise.all([
    loadRowsFromOutcomeStore(),
    loadRowsFromAnalyzeStore(),
    loadRowsFromTradesJson()
  ]);

  const mergedRows = sourceResults.flatMap(result => safeArray(result.rows));
  const rows = uniqueRows(mergedRows);

  return {
    rows,
    sourceResults,
    stats: {
      totalRawRows: mergedRows.length,
      totalUniqueRows: rows.length,
      sources: sourceResults.map(result => ({
        ok: Boolean(result.ok),
        source: result.source,
        loader: result.loader,
        reason: result.reason,
        rows: safeArray(result.rows).length
      }))
    }
  };
}

// ================= ROTATION SHAPING =================

function assertRotation(rotation) {
  if (!rotation || typeof rotation !== "object") {
    throw new Error("selectWeeklyRotation returned no rotation object");
  }

  return rotation;
}

function buildRunnerRotation({
  rotation,
  rows,
  sourceWeekKey,
  targetWeekKey,
  now,
  activate,
  config,
  sourceStats
}) {
  const base = assertRotation(rotation);
  const timestamp = normalizeTimestamp(now) || String(nowMs());

  return {
    ...base,

    enabled: base.enabled ?? true,
    strict: base.strict ?? true,

    sourceWeekKey: base.sourceWeekKey ?? sourceWeekKey,
    targetWeekKey: base.targetWeekKey ?? targetWeekKey,

    generatedAt: base.generatedAt ?? Number(timestamp),
    runnerGeneratedAt: nowMs(),

    activate: parseBoolean(activate, true),

    source: base.source ?? "rotationRunner",
    runnerVersion: RUNNER_VERSION,

    rowCount: base.rowCount ?? rows.length,
    inputRowCount: rows.length,

    sourceStats,

    configSnapshot: {
      sourceLimit: SOURCE_LIMIT,
      sourceTimeoutMs: SOURCE_TIMEOUT_MS,
      tradesJsonPath: TRADES_JSON_PATH,
      ...safeObject(config?.runner)
    }
  };
}

// ================= MAIN =================

export async function runWeeklyRotation({
  now = Date.now(),
  activate = true,
  sourceWeekKey = getIsoWeekKey(now),
  targetWeekKey = getNextIsoWeekKey(now),
  config = {}
} = {}) {
  const shouldActivate = parseBoolean(activate, true);

  const startedAt = nowMs();

  const {
    rows,
    stats: sourceStats
  } = await collectOutcomeRows();

  const selectedRotation = await selectWeeklyRotation({
    rows,
    sourceWeekKey,
    targetWeekKey,
    now,
    config
  });

  const rotation = buildRunnerRotation({
    rotation: selectedRotation,
    rows,
    sourceWeekKey,
    targetWeekKey,
    now,
    activate: shouldActivate,
    config,
    sourceStats
  });

  const savedNext = await saveNextRotation(rotation);
  const savedActive = shouldActivate
    ? await saveActiveRotation(rotation)
    : null;

  const history = await appendRotationHistory(
    savedActive ||
      savedNext ||
      rotation
  );

  return {
    ok: true,

    activate: shouldActivate,

    sourceWeekKey,
    targetWeekKey,

    rows: rows.length,
    rawRows: sourceStats.totalRawRows,
    uniqueRows: sourceStats.totalUniqueRows,

    rotation,

    savedNext: Boolean(savedNext),
    savedActive: Boolean(savedActive),

    historyCount: safeArray(history).length,

    sourceStats,

    startedAt,
    finishedAt: nowMs(),
    durationMs: nowMs() - startedAt,

    runnerVersion: RUNNER_VERSION
  };
}

export default runWeeklyRotation;