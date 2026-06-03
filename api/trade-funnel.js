// API/tradefunnel

import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";
import {
  appendAnalyzeEvents,
  loadAnalyzeEvents,
} from "../lib/analyze/analyzeStore.js";

import {
  classifyAnalyzeEvent,
  createAnalyzeFamilies,
} from "../lib/analyze/familyEngine.js";

const TRADE_FUNNEL_ROUTE_VERSION = "trade-funnel-trace-v3-canonical-micro";

console.log("TRADE_FUNNEL_MODULE_LOADED:", JSON.stringify({
  version: TRADE_FUNNEL_ROUTE_VERSION,
  ts: Date.now(),
}));

const MAX_RESPONSE_TRADES = 250;

const LOCK_BUSY_ERROR = "TRADE_SYSTEM_DURABLE_LOCK_BUSY";
const PROCESS_TRADES_FAILED = "PROCESS_TRADES_FAILED";
const PROCESS_TRADES_TIMEOUT = "PROCESS_TRADES_TIMEOUT";
const DURABLE_SAVE_TOO_LARGE = "TRADE_SYSTEM_DURABLE_SAVE_TOO_LARGE";

const REDIS_SET_TOO_LARGE = "REDIS_SET_ABORTED_TOO_LARGE";
const REDIS_PAYLOAD_TOO_LARGE = "REDIS_PAYLOAD_TOO_LARGE";

const DEFAULT_MICRO_FAMILY_SCHEMA_VERSION = "MF_V4_ANALYZE";

const MICRO_FAMILY_SCHEMA_VERSION =
  process.env.MICRO_FAMILY_SCHEMA_VERSION ||
  DEFAULT_MICRO_FAMILY_SCHEMA_VERSION;

const ANALYZE_FAMILY_ID_RE = /^(LONG|SHORT)_([1-9]|[1-4][0-9]|50)$/;

const CORE_MICRO_ID_RE =
  /^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_(?:[1-9]|[1-4][0-9]|50))_([A-Z0-9_]+)_([A-Z0-9]+)$/;

const TRADE_FUNNEL_MIN_SCORE = readNumberEnv("TRADE_FUNNEL_MIN_SCORE", 45);
const TRADE_FUNNEL_ALMOST_MIN_SCORE = readNumberEnv("TRADE_FUNNEL_ALMOST_MIN_SCORE", 45);
const TRADE_FUNNEL_MAX_INPUT = readNumberEnv("TRADE_FUNNEL_MAX_INPUT", 180);

const PROCESS_TRADES_TIMEOUT_MS = readNumberEnv(
  "TRADE_FUNNEL_PROCESS_TRADES_TIMEOUT_MS",
  55_000
);

const ANALYZE_LOAD_TIMEOUT_MS = readNumberEnv(
  "TRADE_FUNNEL_ANALYZE_LOAD_TIMEOUT_MS",
  12_000
);

const ANALYZE_APPEND_TIMEOUT_MS = readNumberEnv(
  "TRADE_FUNNEL_ANALYZE_APPEND_TIMEOUT_MS",
  15_000
);

const SCAN_STORE_TIMEOUT_MS = readNumberEnv(
  "TRADE_FUNNEL_SCAN_STORE_TIMEOUT_MS",
  12_000
);

const SYNTHETIC_ANALYZE_ENABLED = readBooleanEnv("ANALYZE_SYNTHETIC_ENABLED", true);
const SYNTHETIC_ENTRY_MAX = readNumberEnv("ANALYZE_SYNTHETIC_ENTRY_MAX", 80);
const SYNTHETIC_ENTRY_MIN_SCORE = readNumberEnv("ANALYZE_SYNTHETIC_ENTRY_MIN_SCORE", 45);

const SYNTHETIC_EXIT_ENABLED = readBooleanEnv("ANALYZE_SYNTHETIC_EXIT_ENABLED", true);
const SYNTHETIC_EXIT_AFTER_MS = readNumberEnv("ANALYZE_SYNTHETIC_EXIT_AFTER_MS", 20 * 60 * 1000);
const SYNTHETIC_EXIT_MIN_AGE_MS = readNumberEnv("ANALYZE_SYNTHETIC_EXIT_MIN_AGE_MS", 4 * 60 * 1000);
const SYNTHETIC_EXIT_MAX_PER_RUN = readNumberEnv("ANALYZE_SYNTHETIC_EXIT_MAX_PER_RUN", 120);

const FAMILY_BY_ID = new Map(
  createAnalyzeFamilies().all.map(family => [family.id, family])
);

// ================= TRACE HELPERS =================

function traceTradeFunnel(label, payload = {}) {
  try {
    console.log(`TRADE_FUNNEL_TRACE_${label}:`, JSON.stringify({
      version: TRADE_FUNNEL_ROUTE_VERSION,
      ts: Date.now(),
      ...payload,
    }));
  } catch (e) {
    console.log(`TRADE_FUNNEL_TRACE_${label}:`, {
      version: TRADE_FUNNEL_ROUTE_VERSION,
      ts: Date.now(),
      payloadType: typeof payload,
      error: e?.message,
    });
  }
}

function errorTradeFunnel(label, error, payload = {}) {
  console.error(`TRADE_FUNNEL_ERROR_${label}:`, JSON.stringify({
    version: TRADE_FUNNEL_ROUTE_VERSION,
    ts: Date.now(),
    message: error?.message || String(error || "unknown_error"),
    name: error?.name || null,
    code: error?.code || null,
    stack: error?.stack?.slice?.(0, 2500) || null,
    ...payload,
  }));
}

function isLockBusyError(value) {
  const message = String(value?.message || value?.error || value?.reason || value || "");

  return (
    message === LOCK_BUSY_ERROR ||
    message.includes(LOCK_BUSY_ERROR) ||
    value?.reason === LOCK_BUSY_ERROR ||
    value?.busy === true
  );
}

function isRedisPayloadTooLargeError(value) {
  const message = String(value?.message || value?.error || value?.reason || value || "");

  return (
    message.includes(REDIS_SET_TOO_LARGE) ||
    message.includes(REDIS_PAYLOAD_TOO_LARGE) ||
    message.includes("runtime:core bytes=") ||
    message.includes("max=9000000")
  );
}

function isTimeoutError(value) {
  const message = String(value?.message || value?.error || value?.reason || value || "");
  const code = String(value?.code || "");

  return (
    code.includes("TIMEOUT") ||
    message.includes("_TIMEOUT_") ||
    message.includes("PROCESS_TRADES_TIMEOUT")
  );
}

function classifyProcessTradesError(error) {
  if (isLockBusyError(error)) {
    return {
      ok: true,
      busy: true,
      skipped: true,
      reason: LOCK_BUSY_ERROR,
      nonFatal: true,
    };
  }

  if (isRedisPayloadTooLargeError(error)) {
    return {
      ok: true,
      busy: false,
      skipped: true,
      reason: DURABLE_SAVE_TOO_LARGE,
      nonFatal: true,
    };
  }

  if (isTimeoutError(error)) {
    return {
      ok: false,
      busy: false,
      skipped: true,
      reason: PROCESS_TRADES_TIMEOUT,
      nonFatal: false,
    };
  }

  return {
    ok: false,
    busy: false,
    skipped: true,
    reason: PROCESS_TRADES_FAILED,
    nonFatal: false,
  };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}_TIMEOUT_${timeoutMs}MS`);
      error.code = `${label}_TIMEOUT`;
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ================= ENV HELPERS =================

function readNumberEnv(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = process.env[key];

  if (raw === undefined || raw === null || raw === "") return fallback;

  const v = String(raw).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

// ================= GENERIC HELPERS =================

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function flattenValues(values = []) {
  return values.flat(Infinity).filter(value => value !== undefined && value !== null);
}

function unique(values = []) {
  return Array.from(new Set(flattenValues(values).filter(Boolean)));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;

  return fallback;
}

function normalizeNotify(value, fallback = true) {
  return normalizeBoolean(value, fallback);
}

function normalizeStore(value, fallback = true) {
  return normalizeBoolean(value, fallback);
}

function normalizeFullResponse(value, fallback = false) {
  return normalizeBoolean(value, fallback);
}

function incrementCounter(map, key) {
  const k = key || "UNKNOWN";
  map[k] = Number(map[k] || 0) + 1;
}

function cleanObject(object) {
  return Object.fromEntries(
    Object.entries(safeObject(object)).filter(([, value]) => {
      return value !== undefined && value !== null && value !== "";
    })
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeTimestamp(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
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

function analyzerHashString(value) {
  const text = String(value || "");
  let hash = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return Math.abs(hash >>> 0).toString(36).toUpperCase();
}

// ================= CANONICAL FAMILY HELPERS =================

function extractParentFamilyIdFromMicroId(raw) {
  const token = cleanToken(raw);

  if (!token.startsWith("MICRO_")) return null;

  const match = token.match(
    /^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_(?:[1-9]|[1-4][0-9]|50))_/
  );

  const parentFamilyId = match?.[2] || null;

  return ANALYZE_FAMILY_ID_RE.test(parentFamilyId || "")
    ? parentFamilyId
    : null;
}

function normalizeAnalyzeFamilyId(raw) {
  const token = cleanToken(raw);

  if (ANALYZE_FAMILY_ID_RE.test(token)) {
    return token;
  }

  return extractParentFamilyIdFromMicroId(token);
}

function buildCoreMicroFamilyId(familyId) {
  const analyzeFamilyId = normalizeAnalyzeFamilyId(familyId);

  if (!analyzeFamilyId) return null;

  const side = analyzeFamilyId.startsWith("LONG_") ? "LONG" : "SHORT";
  const definition = `${MICRO_FAMILY_SCHEMA_VERSION} | ${analyzeFamilyId}`;
  const hash = analyzerHashString(definition).slice(0, 8);

  return `MICRO_${side}_${analyzeFamilyId}_${MICRO_FAMILY_SCHEMA_VERSION}_${hash}`;
}

function isCoreMicroFamilyId(raw) {
  const token = cleanToken(raw);

  return Boolean(
    token &&
      CORE_MICRO_ID_RE.test(token) &&
      token.includes(`_${MICRO_FAMILY_SCHEMA_VERSION}_`)
  );
}

function normalizeMicroFamilyId(raw) {
  const token = cleanToken(raw);

  if (!token) return null;

  if (isCoreMicroFamilyId(token)) {
    return token;
  }

  const parentFromMicro = extractParentFamilyIdFromMicroId(token);
  if (parentFromMicro) {
    return buildCoreMicroFamilyId(parentFromMicro);
  }

  const parentFamilyId = normalizeAnalyzeFamilyId(token);
  if (parentFamilyId) {
    return buildCoreMicroFamilyId(parentFamilyId);
  }

  return null;
}

function normalizeFamilyNumber(value) {
  const n = Number(value);

  if (Number.isInteger(n) && n >= 1 && n <= 50) {
    return n;
  }

  const token = cleanToken(value);
  const match = token.match(/(?:LONG|SHORT)?_?([1-9]|[1-4][0-9]|50)$/);

  if (!match) return null;

  const parsed = Number(match[1]);

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50
    ? parsed
    : null;
}

function inferAnalyzeFamilyIdFromParts(source = {}, sideOverride = null) {
  const side =
    normalizeAnalyzeSide(sideOverride) ||
    normalizeAnalyzeSide(source.tradeSide) ||
    normalizeAnalyzeSide(source.rotationSide) ||
    normalizeAnalyzeSide(source.side) ||
    normalizeAnalyzeSide(source.direction) ||
    normalizeAnalyzeSide(source.signalSide) ||
    normalizeAnalyzeSide(source.bias);

  if (!side) return null;

  const familyNumber = normalizeFamilyNumber(
    source.familyNumber ??
      source.analyzeFamilyNumber ??
      source.analysisFamilyNumber ??
      source.parentFamilyNumber ??
      source.familyIndex ??
      source.analyzeFamilyIndex ??
      source.analysisFamilyIndex ??
      source.familyRank ??
      source.rank ??
      source.index
  );

  if (!familyNumber) return null;

  return `${side}_${familyNumber}`;
}

function buildCanonicalFamilyBundle({
  familyId = null,
  microFamilyId = null,
  side = null,
  event = {},
  snapshot = {},
} = {}) {
  const row = safeObject(event);
  const snap = safeObject(snapshot);

  const analyzeCandidates = [
    familyId,

    row.parentFamilyId,
    row.familyId,
    row.analyzeFamilyId,
    row.analysisFamilyId,
    row.analyzerParentFamilyId,

    snap.parentFamilyId,
    snap.familyId,
    snap.analyzeFamilyId,
    snap.analysisFamilyId,
    snap.analyzerParentFamilyId,

    row.filterSnapshot?.parentFamilyId,
    row.filterSnapshot?.familyId,
    row.filterSnapshot?.analyzeFamilyId,
    row.filterSnapshot?.analysisFamilyId,
    row.filterSnapshot?.analyzerParentFamilyId,

    row.rotationCandidate?.parentFamilyId,
    row.rotationCandidate?.familyId,
    row.rotationCandidate?.analyzeFamilyId,
    row.rotationCandidate?.analysisFamilyId,
    row.rotationCandidate?.analyzerParentFamilyId,

    row.familyIds,
    row.families,
    snap.familyIds,
    snap.families,

    microFamilyId,
    row.microFamilyId,
    row.rotationMicroFamilyId,
    row.analyzerMicroFamilyId,
    snap.microFamilyId,
    snap.rotationMicroFamilyId,
    snap.analyzerMicroFamilyId,

    inferAnalyzeFamilyIdFromParts(row, side),
    inferAnalyzeFamilyIdFromParts(snap, side),
  ];

  const analyzeFamilyIds = unique(
    flattenValues(analyzeCandidates)
      .map(normalizeAnalyzeFamilyId)
      .filter(Boolean)
  );

  const parentFamilyId = analyzeFamilyIds[0] || null;

  const microCandidates = [
    microFamilyId,

    row.microFamilyId,
    row.microFamily,
    row.rotationMicroFamilyId,
    row.analyzerMicroFamilyId,
    row.scannerMicroFamilyId,

    snap.microFamilyId,
    snap.microFamily,
    snap.rotationMicroFamilyId,
    snap.analyzerMicroFamilyId,
    snap.scannerMicroFamilyId,

    row.filterSnapshot?.microFamilyId,
    row.filterSnapshot?.microFamily,
    row.filterSnapshot?.rotationMicroFamilyId,
    row.filterSnapshot?.analyzerMicroFamilyId,

    row.rotationCandidate?.microFamilyId,
    row.rotationCandidate?.microFamily,
    row.rotationCandidate?.rotationMicroFamilyId,
    row.rotationCandidate?.analyzerMicroFamilyId,

    row.microFamilyIds,
    row.microFamilies,
    snap.microFamilyIds,
    snap.microFamilies,

    parentFamilyId ? buildCoreMicroFamilyId(parentFamilyId) : null,
  ];

  const microFamilyIds = unique(
    flattenValues(microCandidates)
      .map(normalizeMicroFamilyId)
      .filter(Boolean)
  );

  const primaryMicroFamilyId = microFamilyIds[0] || null;
  const finalParentFamilyId =
    parentFamilyId ||
    normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(primaryMicroFamilyId));

  const finalFamilyIds = finalParentFamilyId
    ? unique([finalParentFamilyId, ...analyzeFamilyIds])
    : [];

  const finalMicroFamilyIds = primaryMicroFamilyId
    ? unique([primaryMicroFamilyId, ...microFamilyIds])
    : [];

  return {
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    parentFamilyId: finalParentFamilyId || null,
    familyId: finalParentFamilyId || null,
    analyzeFamilyId: finalParentFamilyId || null,
    analysisFamilyId: finalParentFamilyId || null,
    analyzerParentFamilyId: finalParentFamilyId || null,
    familyIds: finalFamilyIds,
    families: finalFamilyIds,

    microFamilyId: primaryMicroFamilyId || null,
    microFamily: primaryMicroFamilyId || null,
    rotationMicroFamilyId: primaryMicroFamilyId || null,
    analyzerMicroFamilyId: primaryMicroFamilyId || null,
    microFamilyIds: finalMicroFamilyIds,
    microFamilies: finalMicroFamilyIds,
  };
}

// ================= RANK HELPERS =================

function stageRank(stage) {
  const s = String(stage || "").toLowerCase();

  if (s === "entry") return 2;
  if (s === "almost") return 1;

  return 0;
}

function flowRank(flow) {
  const f = String(flow || "NEUTRAL").toUpperCase();

  if (f === "TREND") return 2;
  if (f === "BUILDING") return 1;

  return 0;
}

function candidateQualityScore(c) {
  const score = safeNumber(c.moveScore, 0);
  const vm = safeNumber(c.vm, 0);
  const tfStrength = safeNumber(c.tfStrength, Math.abs(safeNumber(c.tfScore, 0)));
  const stage = String(c.stage || "").toLowerCase();
  const flow = String(c.flow || "NEUTRAL").toUpperCase();

  return (
    score +
    stageRank(stage) * 8 +
    flowRank(flow) * 6 +
    Math.min(tfStrength * 4, 10) +
    Math.min(vm * 40, 10)
  );
}

// ================= NORMALIZATION =================

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["bull", "long", "buy"].includes(s)) return "bull";
  if (["bear", "short", "sell"].includes(s)) return "bear";

  return "";
}

function normalizeAnalyzeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["bull", "long", "buy"].includes(s)) return "LONG";
  if (["bear", "short", "sell"].includes(s)) return "SHORT";

  if (String(value || "").toUpperCase() === "LONG") return "LONG";
  if (String(value || "").toUpperCase() === "SHORT") return "SHORT";
  if (String(value || "").toUpperCase().startsWith("LONG_")) return "LONG";
  if (String(value || "").toUpperCase().startsWith("SHORT_")) return "SHORT";
  if (String(value || "").toUpperCase().startsWith("MICRO_LONG_")) return "LONG";
  if (String(value || "").toUpperCase().startsWith("MICRO_SHORT_")) return "SHORT";

  return "";
}

function sideToScannerSide(value) {
  const s = normalizeAnalyzeSide(value);

  if (s === "LONG") return "bull";
  if (s === "SHORT") return "bear";

  return normalizeSide(value);
}

function normalizeStage(value) {
  const s = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/^scanner[-_]/, "");

  if (s === "entry") return "entry";
  if (s === "almost") return "almost";

  return "";
}

function normalizeFlow(value) {
  const f = String(value || "NEUTRAL").toUpperCase().trim();

  if (["TREND", "BREAKOUT", "RUNNING"].includes(f)) return "TREND";
  if (["BUILDING", "BUILDUP"].includes(f)) return "BUILDING";

  return "NEUTRAL";
}

function getCandidateScore(coin) {
  return safeNumber(
    coin.moveScore ??
      coin.score ??
      coin.tradeScore ??
      coin.sniperScore,
    0
  );
}

function getTradeId(action) {
  const id =
    action?.tradeId ||
    action?.positionTradeId ||
    action?.positionId ||
    action?.orderId ||
    action?.clientOrderId ||
    action?.id;

  return id ? String(id) : "";
}

// ================= LIFECYCLE =================

function getActionCandidates(action) {
  return [
    action?.analyzeLifecycle,
    action?.analyzeAction,
    action?.lifecycleAction,
    action?.tradeAction,
    action?.action,
    action?.status,
    action?.state,
    action?.type,
    action?.reason,
    action?.exitReason,
  ]
    .map(normalizeText)
    .filter(Boolean);
}

function getPrimaryLifecycleText(action) {
  return normalizeText(
    action?.analyzeLifecycle ||
      action?.analyzeAction ||
      action?.lifecycleAction ||
      action?.tradeAction ||
      action?.action
  );
}

function isExitText(value) {
  return (
    value === "EXIT" ||
    value === "CLOSE" ||
    value === "CLOSED" ||
    value === "TP" ||
    value === "SL" ||
    value === "STOP" ||
    value === "STOP_LOSS" ||
    value === "TAKE_PROFIT" ||
    value === "BE_SL" ||
    value.includes("EXIT") ||
    value.includes("CLOSE") ||
    value.includes("TAKE_PROFIT") ||
    value.includes("STOP_LOSS")
  );
}

function isEntryText(value) {
  return (
    value === "ENTRY" ||
    value === "OPEN" ||
    value === "OPENED" ||
    value === "ENTER" ||
    value === "FILLED" ||
    value === "PLACE_ORDER" ||
    value === "OPEN_LONG" ||
    value === "OPEN_SHORT" ||
    value === "LONG_ENTRY" ||
    value === "SHORT_ENTRY" ||
    value.includes("ENTRY") ||
    value.includes("OPEN_POSITION")
  );
}

function isWaitText(value) {
  return (
    value === "WAIT" ||
    value === "HOLD" ||
    value === "RUNNING" ||
    value === "NO_TRADE" ||
    value === "SKIP" ||
    value === "IGNORE" ||
    value.includes("WAIT") ||
    value.includes("HOLD") ||
    value.includes("RUNNING") ||
    value.includes("REJECT")
  );
}

function hasExplicitExitAction(action) {
  return getActionCandidates(action).some(isExitText);
}

function hasExplicitEntryAction(action) {
  return getActionCandidates(action).some(isEntryText);
}

function hasExitFields(action) {
  return (
    action?.closed === true ||
    action?.isClosed === true ||
    action?.exitPrice !== undefined ||
    action?.exit !== undefined ||
    action?.executionPrice !== undefined ||
    action?.closedAt ||
    action?.exitAt ||
    action?.exitTs ||
    action?.realizedR !== undefined ||
    action?.pnlR !== undefined ||
    action?.exitR !== undefined ||
    action?.resultR !== undefined ||
    action?.outcomeR !== undefined ||
    action?.pnlPct !== undefined
  );
}

function hasEntryFields(action) {
  return (
    action?.entry !== undefined ||
    action?.entryPrice !== undefined ||
    action?.openPrice !== undefined ||
    action?.sl !== undefined ||
    action?.tp !== undefined ||
    action?.rr !== undefined ||
    action?.baseRR !== undefined ||
    action?.familyId ||
    action?.microFamilyId ||
    action?.analyzeFamilyId ||
    action?.analysisFamilyId ||
    action?.filterSnapshot?.familyId ||
    action?.filterSnapshot?.microFamilyId
  );
}

function getLifecycleAction(action) {
  const primary = getPrimaryLifecycleText(action);

  if (isEntryText(primary)) return "ENTRY";
  if (isExitText(primary)) return "EXIT";
  if (isWaitText(primary)) return "";

  if (hasExplicitEntryAction(action)) return "ENTRY";
  if (hasExplicitExitAction(action)) return "EXIT";

  if (hasExitFields(action)) return "EXIT";
  if (hasEntryFields(action)) return "ENTRY";

  return "";
}

function getActionTimestamp(action) {
  return normalizeTimestamp(
    action?.closedAt ??
      action?.exitAt ??
      action?.exitTs ??
      action?.updatedAt ??
      action?.createdAt ??
      action?.openedAt ??
      action?.entryTs ??
      action?.ts,
    Date.now()
  );
}

function getEntryTimestamp(action) {
  return normalizeTimestamp(
    action?.openedAt ??
      action?.entryTs ??
      action?.createdAt ??
      action?.ts,
    Date.now()
  );
}

// ================= TRADE-FUNNEL GATE =================

function passesTradeFunnelGate(coin) {
  const symbol = String(coin.symbol || "").toUpperCase().trim();
  const side = normalizeSide(coin.side);
  const stage = normalizeStage(coin.stage);
  const score = getCandidateScore(coin);

  if (!symbol) return { ok: false, reason: "NO_SYMBOL" };
  if (!side) return { ok: false, reason: "BAD_SIDE" };
  if (Boolean(coin.uiOnly)) return { ok: false, reason: "UI_ONLY" };
  if (!stage) return { ok: false, reason: "BAD_STAGE" };

  if (stage === "entry" && score < TRADE_FUNNEL_MIN_SCORE) {
    return { ok: false, reason: "ENTRY_SCORE_TOO_LOW" };
  }

  if (stage === "almost" && score < TRADE_FUNNEL_ALMOST_MIN_SCORE) {
    return { ok: false, reason: "ALMOST_SCORE_TOO_LOW" };
  }

  return { ok: true, reason: "OK" };
}

// ================= CANDIDATE SELECTOR =================

function getTradeFunnelCandidates(latest) {
  const buckets = [
    ...safeArray(latest?.funnel?.bull?.entry),
    ...safeArray(latest?.funnel?.bear?.entry),
    ...safeArray(latest?.funnel?.bull?.almost),
    ...safeArray(latest?.funnel?.bear?.almost),
  ];

  const accepted = new Map();
  const rejectCounts = {};

  for (const coin of buckets) {
    if (!coin) continue;

    const gate = passesTradeFunnelGate(coin);

    if (!gate.ok) {
      incrementCounter(rejectCounts, gate.reason);
      continue;
    }

    const symbol = String(coin.symbol || "").toUpperCase().trim();
    const side = normalizeSide(coin.side);
    const stage = normalizeStage(coin.stage);
    const flow = normalizeFlow(coin.flow);
    const score = getCandidateScore(coin);

    const vm = safeNumber(
      coin.vm ??
        coin.volumeMomentum ??
        coin.volMomentum,
      0
    );

    const tfScore = safeNumber(coin.tfScore, 0);
    const tfStrength = safeNumber(
      coin.tfStrength,
      Math.abs(tfScore)
    );

    const normalized = {
      ...coin,
      symbol,
      side,
      stage,
      scannerStage: stage,
      stageSource: coin.stageSource || "tradefunnel_adapter",
      flow,
      moveScore: score,
      vm,
      tfScore,
      tfStrength,
      uiOnly: false,
    };

    normalized.tradeFunnelQuality = candidateQualityScore(normalized);

    const key = `${symbol}_${side}`;
    const prev = accepted.get(key);

    if (!prev) {
      accepted.set(key, normalized);
      continue;
    }

    if (candidateQualityScore(normalized) > candidateQualityScore(prev)) {
      accepted.set(key, normalized);
    }
  }

  let result = Array.from(accepted.values()).sort((a, b) => {
    const qDiff =
      safeNumber(b.tradeFunnelQuality, 0) -
      safeNumber(a.tradeFunnelQuality, 0);

    if (qDiff !== 0) return qDiff;

    const stageDiff = stageRank(b.stage) - stageRank(a.stage);
    if (stageDiff !== 0) return stageDiff;

    return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
  });

  if (result.length > TRADE_FUNNEL_MAX_INPUT) {
    rejectCounts.CAPPED_INPUT = result.length - TRADE_FUNNEL_MAX_INPUT;
    result = result.slice(0, TRADE_FUNNEL_MAX_INPUT);
  }

  traceTradeFunnel("TRADE_FUNNEL_SELECTED", {
    raw: buckets.length,
    accepted: result.length,
    rejected: rejectCounts,
    symbols: result
      .slice(0, 80)
      .map(c => `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore)}`),
  });

  return {
    candidates: result,
    rawCount: buckets.length,
    rejectCounts,
  };
}

// ================= FAMILY SNAPSHOT =================

function buildBaseFilterSnapshot(action) {
  return cleanObject({
    ...safeObject(action?.filterSnapshot),
    ...safeObject(action?.filters),
    ...safeObject(action?.filterValues),
    ...safeObject(action?.analysisFilters),

    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    parentFamilyId: action?.parentFamilyId,
    familyId: action?.familyId,
    analyzeFamilyId: action?.analyzeFamilyId,
    analysisFamilyId: action?.analysisFamilyId,
    analyzerParentFamilyId: action?.analyzerParentFamilyId,
    familyIds: action?.familyIds,
    families: action?.families,

    microFamilyId: action?.microFamilyId,
    microFamily: action?.microFamily,
    rotationMicroFamilyId: action?.rotationMicroFamilyId,
    analyzerMicroFamilyId: action?.analyzerMicroFamilyId,
    microFamilyIds: action?.microFamilyIds,
    microFamilies: action?.microFamilies,

    setupClass: action?.setupClass,
    grade: action?.grade,

    score: action?.score ?? action?.moveScore ?? action?.tradeScore,
    moveScore: action?.moveScore ?? action?.score ?? action?.tradeScore,
    confluence: action?.confluence,
    sniperScore: action?.sniperScore,

    rr: action?.rr,
    baseRR: action?.baseRR,
    finalRR: action?.finalRr ?? action?.finalRR,
    plannedRR: action?.plannedRR,
    effectiveRR: action?.effectiveRR,

    stage: action?.stage,
    scannerStage: action?.scannerStage,
    stageSource: action?.stageSource,
    flow: action?.flow,

    rsi: action?.rsi,
    rsiHTF: action?.rsiHTF,
    rsiZone: action?.rsiZone,
    rsiEdge: action?.rsiEdge,
    tfScore: action?.tfScore,
    tfStrength: action?.tfStrength,
    tfAlignment: action?.tfAlignment,

    obBias: action?.obBias,
    spreadPct: action?.spreadPct,
    spreadBps: action?.spreadBps,
    depthMinUsd1p: action?.depthMinUsd1p,
    depthUsd1p: action?.depthUsd1p,

    btcState: action?.btcState ?? action?.btc?.state,
    regime: action?.regime,
    market: action?.market,
    fundingRate: action?.fundingRate,
    funding: action?.funding,

    pullbackConfirmed: action?.pullbackConfirmed,
    sweepConfirmed: action?.sweepConfirmed,
    retestConfirmed: action?.retestConfirmed,
    distanceFromLocalHighPct: action?.distanceFromLocalHighPct,
    pullbackFromHighPct: action?.pullbackFromHighPct,

    strategyVersion: action?.strategyVersion,
  });
}

function buildAnalyzeFamilySnapshot(event) {
  try {
    const classified = classifyAnalyzeEvent({
      ...event,
      closed: false,
      action: "ENTRY",
      analyzeLifecycle: "ENTRY",
    });

    const familyId = normalizeAnalyzeFamilyId(classified?.familyId || classified?.id);

    if (!familyId) return null;

    const family = FAMILY_BY_ID.get(familyId);
    const bundle = buildCanonicalFamilyBundle({
      familyId,
      side: classified.side,
      event,
    });

    return {
      ...bundle,

      side: classified.side,
      index: classified.index,
      qualityIndex: classified.qualityIndex,
      marketIndex: classified.marketIndex,
      timingIndex: classified.timingIndex,
      qualityBucket: family?.qualityBucket || null,
      marketBucket: family?.marketBucket || null,
      timingBucket: family?.timingBucket || null,
      definition: family?.definition || null,
      source: classified.source || "CLASSIFIED_FROM_FILTER_SNAPSHOT",
      frozenAt: Date.now(),
    };
  } catch (e) {
    errorTradeFunnel("ANALYZE_FAMILY_SNAPSHOT", e);
    return null;
  }
}

function buildSyntheticTradeId({ symbol, analyzeSide, familyId }) {
  const s = String(symbol || "").toUpperCase().trim();
  const side = String(analyzeSide || "").toUpperCase().trim();
  const family = String(familyId || "UNKNOWN").toUpperCase().trim();

  return `SIM_${side}_${family}_${s}`;
}

// ================= SYNTHETIC ENTRIES =================

function buildSyntheticEntryEvent(candidate, latest, index = 0) {
  const symbol = String(candidate.symbol || "").toUpperCase().trim();
  const scannerSide = normalizeSide(candidate.side);
  const analyzeSide = normalizeAnalyzeSide(candidate.side);
  const entryPrice = nullableNumber(candidate.entry ?? candidate.entryPrice ?? candidate.price);

  if (!symbol || !scannerSide || !analyzeSide || !entryPrice || entryPrice <= 0) {
    return null;
  }

  const now = Date.now();

  const base = cleanObject({
    ...candidate,

    symbol,
    side: analyzeSide,

    action: "ENTRY",
    analyzeLifecycle: "ENTRY",
    analyzeSource: "synthetic_scan_candidate",
    syntheticAnalyzeEntry: true,

    openedAt: now,
    entryTs: now,
    ts: now,
    analyzeTs: now,

    entry: entryPrice,
    entryPrice,
    openPrice: entryPrice,

    stage: candidate.stage,
    scannerStage: candidate.scannerStage || candidate.stage,
    stageSource: candidate.stageSource,
    flow: candidate.flow,

    moveScore: candidate.moveScore,
    score: candidate.score ?? candidate.moveScore,
    confluence: candidate.confluence,
    sniperScore: candidate.sniperScore,

    rr: candidate.rr ?? candidate.baseRR ?? 1.2,
    baseRR: candidate.baseRR ?? candidate.rr ?? 1.2,

    rsi: candidate.rsi,
    rsiHTF: candidate.rsiHTF,
    rsiZone: candidate.rsiZone,
    rsiEdge: candidate.rsiEdge,

    obBias: candidate.obBias,
    spreadPct: candidate.spreadPct,
    spreadBps: candidate.spreadBps,
    depthMinUsd1p: candidate.depthMinUsd1p ?? candidate.depthUsd1p,

    btcState: candidate.btcState ?? latest?.btc?.state,
    btc: latest?.btc || candidate.btc || null,
    regime: candidate.regime ?? latest?.regime,
    market: candidate.market ?? latest?.market,

    fundingRate: candidate.fundingRate,
    funding: candidate.funding,

    tfScore: candidate.tfScore,
    tfStrength: candidate.tfStrength,
    tfAlignment: candidate.tfAlignment,

    strategyVersion: candidate.strategyVersion || "synthetic-analyze-v1",
    sequenceIndex: index,
  });

  const baseSnapshot = buildBaseFilterSnapshot(base);
  const familySnapshot = buildAnalyzeFamilySnapshot({
    ...base,
    filterSnapshot: baseSnapshot,
  });

  const familyBundle = buildCanonicalFamilyBundle({
    familyId: familySnapshot?.familyId,
    microFamilyId: familySnapshot?.microFamilyId,
    side: analyzeSide,
    event: base,
    snapshot: {
      ...baseSnapshot,
      ...safeObject(familySnapshot),
    },
  });

  const familyId = familyBundle.familyId || null;
  const tradeId = buildSyntheticTradeId({
    symbol,
    analyzeSide,
    familyId,
  });

  return cleanObject({
    ...base,
    ...familyBundle,

    tradeId,

    closed: false,

    filterSnapshot: cleanObject({
      ...baseSnapshot,
      ...safeObject(familySnapshot),
      ...familyBundle,
    }),
  });
}

function buildSyntheticEntryEvents(candidates, latest) {
  if (!SYNTHETIC_ANALYZE_ENABLED) {
    return {
      events: [],
      debug: {
        enabled: false,
        candidates: safeArray(candidates).length,
        max: SYNTHETIC_ENTRY_MAX,
        minScore: SYNTHETIC_ENTRY_MIN_SCORE,
        rejected: {},
        created: 0,
      },
    };
  }

  const events = [];
  const rejected = {};
  const rows = safeArray(candidates);

  for (const candidate of rows) {
    if (events.length >= SYNTHETIC_ENTRY_MAX) break;

    const score = getCandidateScore(candidate);

    if (score < SYNTHETIC_ENTRY_MIN_SCORE) {
      incrementCounter(rejected, "SCORE_TOO_LOW");
      continue;
    }

    const event = buildSyntheticEntryEvent(candidate, latest, events.length);

    if (!event) {
      incrementCounter(rejected, "BUILD_FAILED");
      continue;
    }

    events.push(event);
  }

  return {
    events,
    debug: {
      enabled: true,
      candidates: rows.length,
      max: SYNTHETIC_ENTRY_MAX,
      minScore: SYNTHETIC_ENTRY_MIN_SCORE,
      rejected,
      created: events.length,
    },
  };
}

// ================= SYNTHETIC EXIT ENGINE =================

function collectLatestCoins(latest) {
  const rows = [];

  for (const side of ["bull", "bear"]) {
    for (const stage of ["entry", "almost", "buildup", "radar"]) {
      rows.push(...safeArray(latest?.funnel?.[side]?.[stage]));
    }
  }

  return rows;
}

function buildCurrentPriceMap(latest) {
  const map = new Map();

  for (const coin of collectLatestCoins(latest)) {
    const symbol = String(coin.symbol || "").toUpperCase().trim();
    const scannerSide = normalizeSide(coin.side);
    const price = nullableNumber(coin.price ?? coin.lastPrice ?? coin.markPrice);

    if (!symbol || !scannerSide || !price || price <= 0) continue;

    map.set(`${symbol}_${scannerSide}`, {
      symbol,
      scannerSide,
      price,
      coin,
    });
  }

  return map;
}

function getOpenAnalyzeEntries(records) {
  return safeArray(records).filter(record => {
    const action = normalizeText(record?.action || record?.analyzeLifecycle);
    const closed = record?.closed === true;

    if (closed) return false;
    if (action !== "ENTRY") return false;

    return Boolean(
      record.syntheticAnalyzeEntry ||
        record.analyzeSource === "synthetic_scan_candidate" ||
        String(record.tradeId || "").startsWith("SIM_")
    );
  });
}

function getEntryPrice(record) {
  return nullableNumber(
    record.entryPrice ??
      record.entry ??
      record.openPrice ??
      record.price
  );
}

function getEntryAgeMs(record, now = Date.now()) {
  const openedAt = normalizeTimestamp(
    record.openedAt ??
      record.entryTs ??
      record.analyzeTs ??
      record.ts,
    now
  );

  return Math.max(0, now - openedAt);
}

function deriveSyntheticRiskPct(record) {
  const snapshot = safeObject(record.filterSnapshot);

  const explicit =
    nullableNumber(record.riskPct) ??
    nullableNumber(record.stopDistancePct) ??
    nullableNumber(snapshot.riskPct) ??
    nullableNumber(snapshot.stopDistancePct);

  if (explicit && explicit > 0) {
    return clamp(explicit, 0.20, 3.00);
  }

  const spreadBps = safeNumber(
    record.spreadBps ??
      snapshot.spreadBps,
    0
  );

  if (spreadBps > 0) {
    return clamp((spreadBps / 100) * 6, 0.35, 1.50);
  }

  const rr = safeNumber(record.rr ?? record.baseRR ?? snapshot.rr ?? snapshot.baseRR, 1.2);

  if (rr >= 1.5) return 0.75;
  if (rr >= 1.2) return 0.65;

  return 0.55;
}

function deriveSyntheticRR(record) {
  const snapshot = safeObject(record.filterSnapshot);

  return clamp(
    safeNumber(
      record.rr ??
        record.baseRR ??
        snapshot.rr ??
        snapshot.baseRR,
      1.2
    ),
    0.8,
    3.0
  );
}

function computeDirectionalPnlPct({ side, entryPrice, exitPrice }) {
  const analyzeSide = normalizeAnalyzeSide(side);

  if (!entryPrice || !exitPrice || entryPrice <= 0 || exitPrice <= 0) return null;

  if (analyzeSide === "LONG") {
    return ((exitPrice - entryPrice) / entryPrice) * 100;
  }

  if (analyzeSide === "SHORT") {
    return ((entryPrice - exitPrice) / entryPrice) * 100;
  }

  return null;
}

function buildSyntheticExitForOpenEntry(record, latestPriceRow, now = Date.now()) {
  const tradeId = getTradeId(record);
  const symbol = String(record.symbol || "").toUpperCase().trim();
  const analyzeSide = normalizeAnalyzeSide(record.side);
  const entryPrice = getEntryPrice(record);
  const exitPrice = nullableNumber(latestPriceRow?.price);

  if (!tradeId || !symbol || !analyzeSide || !entryPrice || !exitPrice) return null;

  const ageMs = getEntryAgeMs(record, now);
  const riskPct = deriveSyntheticRiskPct(record);
  const rr = deriveSyntheticRR(record);

  const pnlPct = computeDirectionalPnlPct({
    side: analyzeSide,
    entryPrice,
    exitPrice,
  });

  if (pnlPct === null) return null;

  const hitStop = ageMs >= SYNTHETIC_EXIT_MIN_AGE_MS && pnlPct <= -riskPct;
  const hitTarget = ageMs >= SYNTHETIC_EXIT_MIN_AGE_MS && pnlPct >= riskPct * rr;
  const timedOut = ageMs >= SYNTHETIC_EXIT_AFTER_MS;

  if (!hitStop && !hitTarget && !timedOut) return null;

  let realizedR = pnlPct / riskPct;
  let exitReason = "SYNTHETIC_TIMEOUT";

  if (hitStop) {
    realizedR = -1;
    exitReason = "SYNTHETIC_SL";
  } else if (hitTarget) {
    realizedR = rr;
    exitReason = "SYNTHETIC_TP";
  } else {
    realizedR = clamp(realizedR, -1.25, Math.max(1.25, rr));
  }

  const snapshot = safeObject(record.filterSnapshot);
  const familyBundle = buildCanonicalFamilyBundle({
    familyId:
      record.familyId ||
      record.analyzeFamilyId ||
      record.analysisFamilyId ||
      snapshot.familyId ||
      snapshot.analyzeFamilyId ||
      null,
    microFamilyId:
      record.microFamilyId ||
      record.rotationMicroFamilyId ||
      record.analyzerMicroFamilyId ||
      snapshot.microFamilyId ||
      null,
    side: analyzeSide,
    event: record,
    snapshot,
  });

  return cleanObject({
    tradeId,
    symbol,
    side: analyzeSide,

    action: "EXIT",
    analyzeLifecycle: "EXIT",
    analyzeSource: "synthetic_exit_engine",
    syntheticAnalyzeExit: true,

    closed: true,
    closedAt: now,
    exitTs: now,
    analyzeTs: now,
    ts: now,

    entry: entryPrice,
    entryPrice,
    exit: exitPrice,
    exitPrice,

    realizedR,
    pnlR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    rMultiple: realizedR,
    pnlPct,

    exitReason,

    ...familyBundle,

    rr,
    baseRR: record.baseRR ?? record.rr ?? rr,

    stage: record.stage,
    scannerStage: record.scannerStage,
    stageSource: record.stageSource,
    flow: record.flow,

    confluence: record.confluence,
    sniperScore: record.sniperScore,
    moveScore: record.moveScore,
    score: record.score,

    rsi: record.rsi,
    rsiHTF: record.rsiHTF,
    rsiZone: record.rsiZone,
    rsiEdge: record.rsiEdge,

    obBias: record.obBias,
    spreadPct: record.spreadPct,
    spreadBps: record.spreadBps,
    depthMinUsd1p: record.depthMinUsd1p,

    btcState: latestPriceRow?.coin?.btcState ?? record.btcState ?? record.btc?.state,
    btc: record.btc,
    regime: record.regime,
    market: record.market,

    fundingRate: record.fundingRate,
    funding: record.funding,

    tfScore: record.tfScore,
    tfStrength: record.tfStrength,
    tfAlignment: record.tfAlignment,

    strategyVersion: record.strategyVersion || "synthetic-analyze-v1",

    filterSnapshot: cleanObject({
      ...snapshot,
      ...familyBundle,
    }),
  });
}

async function buildSyntheticExitEvents(latest, now = Date.now()) {
  if (!SYNTHETIC_EXIT_ENABLED) {
    return {
      events: [],
      debug: {
        enabled: false,
        open: 0,
        created: 0,
        rejected: {},
      },
    };
  }

  const rejected = {};
  const currentPriceMap = buildCurrentPriceMap(latest);

  let records = [];

  try {
    records = await withTimeout(
      loadAnalyzeEvents({ force: true }),
      ANALYZE_LOAD_TIMEOUT_MS,
      "LOAD_ANALYZE_EVENTS"
    );
  } catch (e) {
    errorTradeFunnel("LOAD_ANALYZE_EVENTS_FOR_SYNTHETIC_EXIT", e);
    records = [];
  }

  const openEntries = getOpenAnalyzeEntries(records);
  const events = [];

  for (const record of openEntries) {
    if (events.length >= SYNTHETIC_EXIT_MAX_PER_RUN) break;

    const symbol = String(record.symbol || "").toUpperCase().trim();
    const scannerSide = sideToScannerSide(record.side);
    const current = currentPriceMap.get(`${symbol}_${scannerSide}`);

    if (!current) {
      incrementCounter(rejected, "NO_CURRENT_PRICE");
      continue;
    }

    const event = buildSyntheticExitForOpenEntry(record, current, now);

    if (!event) {
      incrementCounter(rejected, "NOT_READY");
      continue;
    }

    events.push(event);
  }

  return {
    events,
    debug: {
      enabled: true,
      open: openEntries.length,
      created: events.length,
      rejected,
      holdMs: SYNTHETIC_EXIT_AFTER_MS,
      minAgeMs: SYNTHETIC_EXIT_MIN_AGE_MS,
      maxPerRun: SYNTHETIC_EXIT_MAX_PER_RUN,
    },
  };
}

// ================= ACTION ENRICHMENT =================

function buildCandidateIndex(candidates, latest) {
  const map = new Map();

  for (const candidate of safeArray(candidates)) {
    const symbol = String(candidate.symbol || "").toUpperCase().trim();
    const side = normalizeSide(candidate.side);

    if (!symbol || !side) continue;

    const syntheticEntry = buildSyntheticEntryEvent(candidate, latest, 0);
    const tradeId =
      syntheticEntry?.tradeId ||
      buildSyntheticTradeId({
        symbol,
        analyzeSide: normalizeAnalyzeSide(candidate.side),
        familyId: syntheticEntry?.familyId || "UNKNOWN",
      });

    map.set(`${symbol}_${side}`, {
      candidate,
      syntheticEntry,
      tradeId,
    });
  }

  return map;
}

function findCandidateForAction(action, candidateIndex) {
  const symbol = String(action?.symbol || action?.baseSymbol || "").toUpperCase().trim();
  const scannerSide = sideToScannerSide(action?.side || action?.direction || action?.tradeSide);

  if (symbol && scannerSide) {
    const direct = candidateIndex.get(`${symbol}_${scannerSide}`);
    if (direct) return direct;
  }

  return null;
}

function enrichTradeAction(action, latest, candidateIndex, index = 0) {
  if (!action || typeof action !== "object") return null;

  const match = findCandidateForAction(action, candidateIndex);
  const candidate = match?.candidate || {};

  const symbol = String(
    action.symbol ||
      action.baseSymbol ||
      candidate.symbol ||
      ""
  ).toUpperCase().trim();

  const analyzeSide = normalizeAnalyzeSide(
    action.side ||
      action.direction ||
      action.tradeSide ||
      candidate.side
  );

  const lifecycle = getLifecycleAction(action);
  const explicitTradeId = getTradeId(action);
  const syntheticTradeId = match?.tradeId || "";
  const tradeId = explicitTradeId || syntheticTradeId;

  const enriched = cleanObject({
    ...candidate,
    ...action,

    tradeId,

    symbol,
    side: analyzeSide || action.side || candidate.side,

    action: lifecycle || action.action,
    analyzeLifecycle: lifecycle || action.analyzeLifecycle,

    analyzeSource: action.analyzeSource || "api_trade_funnel",
    analyzeTs: getActionTimestamp(action),
    ts: getActionTimestamp(action),

    openedAt: lifecycle === "ENTRY"
      ? getEntryTimestamp(action)
      : action.openedAt,

    entryTs: lifecycle === "ENTRY"
      ? getEntryTimestamp(action)
      : action.entryTs,

    btc: action.btc ?? latest?.btc ?? null,
    regime: action.regime ?? latest?.regime ?? null,
    market: action.market ?? latest?.market ?? null,

    stage: action.stage ?? candidate.stage,
    scannerStage: action.scannerStage ?? candidate.scannerStage ?? candidate.stage,
    stageSource: action.stageSource ?? candidate.stageSource,
    flow: action.flow ?? candidate.flow,

    moveScore: action.moveScore ?? action.score ?? candidate.moveScore,
    score: action.score ?? action.moveScore ?? candidate.score ?? candidate.moveScore,

    entry: action.entry ?? action.entryPrice ?? candidate.entry ?? candidate.entryPrice ?? candidate.price,
    entryPrice: action.entryPrice ?? action.entry ?? candidate.entryPrice ?? candidate.entry ?? candidate.price,
    openPrice: action.openPrice ?? action.entryPrice ?? action.entry ?? candidate.price,

    rr: action.rr ?? action.baseRR ?? candidate.rr ?? candidate.baseRR,
    baseRR: action.baseRR ?? action.rr ?? candidate.baseRR ?? candidate.rr,

    sequenceIndex: index,
  });

  const baseSnapshot = buildBaseFilterSnapshot(enriched);

  if (lifecycle === "ENTRY") {
    const existingFamilyId = normalizeAnalyzeFamilyId(
      enriched.familyId ||
        enriched.analyzeFamilyId ||
        enriched.analysisFamilyId ||
        baseSnapshot.familyId ||
        baseSnapshot.analyzeFamilyId
    );

    const familySnapshot = existingFamilyId
      ? {
          ...buildCanonicalFamilyBundle({
            familyId: existingFamilyId,
            side: analyzeSide,
            event: enriched,
            snapshot: baseSnapshot,
          }),
          source: "EXISTING_FAMILY_ID",
          frozenAt: Date.now(),
        }
      : buildAnalyzeFamilySnapshot({
          ...enriched,
          filterSnapshot: baseSnapshot,
        });

    const familyBundle = buildCanonicalFamilyBundle({
      familyId: familySnapshot?.familyId,
      microFamilyId: familySnapshot?.microFamilyId,
      side: analyzeSide,
      event: enriched,
      snapshot: {
        ...baseSnapshot,
        ...safeObject(familySnapshot),
      },
    });

    return cleanObject({
      ...enriched,
      ...familyBundle,
      filterSnapshot: cleanObject({
        ...baseSnapshot,
        ...safeObject(familySnapshot),
        ...familyBundle,
      }),
    });
  }

  if (lifecycle === "EXIT") {
    const familyBundle = buildCanonicalFamilyBundle({
      familyId:
        enriched.familyId ||
        enriched.analyzeFamilyId ||
        enriched.analysisFamilyId ||
        baseSnapshot.familyId ||
        baseSnapshot.analyzeFamilyId ||
        null,
      microFamilyId:
        enriched.microFamilyId ||
        enriched.rotationMicroFamilyId ||
        enriched.analyzerMicroFamilyId ||
        baseSnapshot.microFamilyId ||
        null,
      side: analyzeSide,
      event: enriched,
      snapshot: baseSnapshot,
    });

    return cleanObject({
      ...enriched,
      ...familyBundle,
      filterSnapshot: cleanObject({
        ...baseSnapshot,
        ...familyBundle,
      }),
    });
  }

  return enriched;
}

// ================= ANALYZE NORMALIZATION =================

function normalizeAnalyzeEvent(action, latest, context = {}, index = 0) {
  const lifecycleAction = getLifecycleAction(action);
  if (!lifecycleAction) return null;

  const tradeId = getTradeId(action);
  if (!tradeId) return null;

  const symbol = String(action.symbol || "").toUpperCase().trim();
  const side = normalizeAnalyzeSide(action.side || action.direction || action.tradeSide);

  if (lifecycleAction === "ENTRY" && (!symbol || !side)) return null;

  const ts = getActionTimestamp(action);
  const openedAt = getEntryTimestamp(action);

  const realizedR = nullableNumber(
    action.realizedR ??
      action.pnlR ??
      action.exitR ??
      action.resultR ??
      action.outcomeR ??
      action.rMultiple ??
      action.r
  );

  const pnlPct = nullableNumber(
    action.pnlPct ??
      action.pnlPercent ??
      action.realizedPnlPct ??
      action.resultPnlPct ??
      action.profitPct
  );

  const base = cleanObject({
    ...action,

    tradeId,
    symbol,
    side,

    action: lifecycleAction,
    originalAction: action.action || action.status || action.reason || null,
    analyzeLifecycle: lifecycleAction,
    analyzeSource: action.analyzeSource || "api_trade_funnel",
    analyzeTs: ts,
    ts,

    openedAt: lifecycleAction === "ENTRY" ? openedAt : action.openedAt ?? null,
    entryTs: lifecycleAction === "ENTRY" ? openedAt : action.entryTs ?? null,

    closed: lifecycleAction === "EXIT"
      ? true
      : Boolean(action.closed || action.isClosed),

    closedAt: lifecycleAction === "EXIT"
      ? normalizeTimestamp(action.closedAt ?? action.exitAt ?? action.exitTs ?? ts, ts)
      : action.closedAt ?? null,

    exitPrice: lifecycleAction === "EXIT"
      ? nullableNumber(action.exitPrice ?? action.exit ?? action.executionPrice ?? action.price)
      : nullableNumber(action.exitPrice ?? action.exit),

    exit: lifecycleAction === "EXIT"
      ? nullableNumber(action.exit ?? action.exitPrice ?? action.executionPrice ?? action.price)
      : nullableNumber(action.exit),

    realizedR,
    pnlR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    rMultiple: realizedR,
    pnlPct,

    btc: action.btc ?? latest?.btc ?? null,
    regime: action.regime ?? latest?.regime ?? null,
    market: action.market ?? latest?.market ?? null,

    tradeFunnelUpdatedAt: context.tradeFunnelUpdatedAt || Date.now(),
    latestUpdatedAt: latest?.updatedAt || null,
    sequenceIndex: index,
  });

  const baseSnapshot = buildBaseFilterSnapshot(action);

  if (lifecycleAction === "EXIT") {
    const familyBundle = buildCanonicalFamilyBundle({
      familyId:
        action.familyId ||
        action.analyzeFamilyId ||
        action.analysisFamilyId ||
        action.filterSnapshot?.familyId ||
        action.filterSnapshot?.analyzeFamilyId ||
        null,
      microFamilyId:
        action.microFamilyId ||
        action.rotationMicroFamilyId ||
        action.analyzerMicroFamilyId ||
        action.filterSnapshot?.microFamilyId ||
        null,
      side,
      event: action,
      snapshot: baseSnapshot,
    });

    return cleanObject({
      ...base,
      ...familyBundle,
      filterSnapshot: cleanObject({
        ...baseSnapshot,
        ...familyBundle,
      }),
    });
  }

  const existingFamilyId = normalizeAnalyzeFamilyId(
    action.familyId ||
      action.analyzeFamilyId ||
      action.analysisFamilyId ||
      baseSnapshot.familyId ||
      baseSnapshot.analyzeFamilyId ||
      null
  );

  const familySnapshot = existingFamilyId
    ? {
        ...buildCanonicalFamilyBundle({
          familyId: existingFamilyId,
          side,
          event: base,
          snapshot: baseSnapshot,
        }),
        frozenAt: Date.now(),
        source: "EXISTING_FAMILY_ID",
      }
    : buildAnalyzeFamilySnapshot({
        ...base,
        filterSnapshot: baseSnapshot,
      });

  const familyBundle = buildCanonicalFamilyBundle({
    familyId: familySnapshot?.familyId,
    microFamilyId: familySnapshot?.microFamilyId,
    side,
    event: base,
    snapshot: {
      ...baseSnapshot,
      ...safeObject(familySnapshot),
    },
  });

  return cleanObject({
    ...base,
    ...familyBundle,
    filterSnapshot: cleanObject({
      ...baseSnapshot,
      ...safeObject(familySnapshot),
      ...familyBundle,
    }),
  });
}

function buildAnalyzeEvents(actions, latest, context = {}) {
  const received = safeArray(actions);
  const events = [];
  const rejectCounts = {};

  received.forEach((action, index) => {
    if (!action || typeof action !== "object") {
      incrementCounter(rejectCounts, "BAD_ACTION");
      return;
    }

    const lifecycleAction = getLifecycleAction(action);

    if (!lifecycleAction) {
      incrementCounter(rejectCounts, "NOT_ENTRY_OR_EXIT");
      return;
    }

    if (!getTradeId(action)) {
      incrementCounter(rejectCounts, "NO_TRADE_ID");
      return;
    }

    const normalized = normalizeAnalyzeEvent(action, latest, context, index);

    if (!normalized) {
      incrementCounter(rejectCounts, "NORMALIZE_FAILED");
      return;
    }

    events.push(normalized);
  });

  return {
    events,
    stats: {
      received: received.length,
      accepted: events.length,
      acceptedEntries: events.filter(e => e.action === "ENTRY").length,
      acceptedExits: events.filter(e => e.action === "EXIT").length,
      rejected: received.length - events.length,
      rejectCounts,
    },
  };
}

// ================= ANALYZE APPEND =================

async function appendTradesToAnalyzer(eventsToAppend, latest, context = {}) {
  const actions = safeArray(eventsToAppend);

  traceTradeFunnel("ANALYZE_APPEND_BEFORE", {
    received: actions.length,
  });

  if (!actions.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ACTIONS",
      received: 0,
      accepted: 0,
      acceptedEntries: 0,
      acceptedExits: 0,
      rejected: 0,
      rejectCounts: {},
    };
  }

  const { events, stats } = buildAnalyzeEvents(actions, latest, {
    tradeFunnelUpdatedAt: Date.now(),
    ...context,
  });

  traceTradeFunnel("ANALYZE_NORMALIZED", {
    received: stats.received,
    accepted: stats.accepted,
    acceptedEntries: stats.acceptedEntries,
    acceptedExits: stats.acceptedExits,
    rejected: stats.rejected,
    rejectCounts: stats.rejectCounts,
    withMicroFamilyId: events.filter(event => Boolean(event.microFamilyId)).length,
    withParentFamilyId: events.filter(event => Boolean(event.familyId)).length,
  });

  if (!events.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ENTRY_OR_EXIT_EVENTS",
      ...stats,
    };
  }

  try {
    const result = await withTimeout(
      appendAnalyzeEvents(events, {
        source: "api_trade_funnel",
        tradeFunnelUpdatedAt: Date.now(),
        latestUpdatedAt: latest?.updatedAt || null,
        btc: latest?.btc || null,
        regime: latest?.regime || null,
        market: latest?.market || null,
        microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
        ...context,
      }),
      ANALYZE_APPEND_TIMEOUT_MS,
      "APPEND_ANALYZE_EVENTS"
    );

    traceTradeFunnel("ANALYZE_APPEND_AFTER", {
      ok: Boolean(result?.ok),
      accepted: stats.accepted,
      acceptedEntries: stats.acceptedEntries,
      acceptedExits: stats.acceptedExits,
      resultKeys: Object.keys(result || {}).slice(0, 20),
    });

    return {
      ...result,
      ...stats,
    };
  } catch (e) {
    errorTradeFunnel("ANALYZE_APPEND", e, stats);

    return {
      ok: false,
      error: e?.message || "analyze_append_failed",
      ...stats,
    };
  }
}

// ================= PROCESS TRADES SAFE WRAPPER =================

async function runProcessTradesSafe(candidates, latest, notify) {
  const rows = safeArray(candidates);

  traceTradeFunnel("PROCESS_TRADES_BEFORE", {
    candidates: rows.length,
    notify,
    timeoutMs: PROCESS_TRADES_TIMEOUT_MS,
    hasBtc: Boolean(latest?.btc),
    hasRegime: Boolean(latest?.regime),
    hasMarket: Boolean(latest?.market),
  });

  if (!rows.length) {
    traceTradeFunnel("PROCESS_TRADES_SKIPPED_NO_CANDIDATES");

    return {
      ok: true,
      skipped: false,
      busy: false,
      result: {
        ok: true,
        actions: [],
        candidatesCount: 0,
      },
      error: null,
    };
  }

  try {
    const result = await withTimeout(
      processTrades(rows, {
        notify,
        log: true,
        analyze: true,
        btc: latest.btc,
        regime: latest.regime,
        market: latest.market,
      }),
      PROCESS_TRADES_TIMEOUT_MS,
      "PROCESS_TRADES"
    );

    const actions = Array.isArray(result)
      ? result
      : safeArray(result?.actions);

    traceTradeFunnel("PROCESS_TRADES_AFTER", {
      resultIsArray: Array.isArray(result),
      ok: result?.ok ?? null,
      skipped: Boolean(result?.skipped),
      busy: Boolean(result?.busy),
      reason: result?.reason || null,
      candidatesCount: result?.candidatesCount ?? rows.length,
      actions: actions.length,
      entries: actions.filter(a => String(a?.action).toUpperCase() === "ENTRY").length,
      exits: actions.filter(a => String(a?.action).toUpperCase() === "EXIT").length,
      waits: actions.filter(a => String(a?.action).toUpperCase() === "WAIT").length,
      holds: actions.filter(a => String(a?.action).toUpperCase() === "HOLD").length,
    });

    if (result?.skipped && result?.reason === LOCK_BUSY_ERROR) {
      return {
        ok: true,
        skipped: true,
        busy: true,
        result: {
          ...result,
          ok: true,
          actions,
          candidatesCount: result?.candidatesCount ?? rows.length,
        },
        error: null,
      };
    }

    return {
      ok: result?.ok !== false,
      skipped: Boolean(result?.skipped),
      busy: Boolean(result?.busy),
      result: Array.isArray(result)
        ? {
            ok: true,
            actions: result,
            candidatesCount: rows.length,
          }
        : {
            ok: result?.ok !== false,
            ...safeObject(result),
            actions,
            candidatesCount: result?.candidatesCount ?? rows.length,
          },
      error: null,
    };
  } catch (error) {
    const classification = classifyProcessTradesError(error);

    errorTradeFunnel("PROCESS_TRADES", error, {
      busy: classification.busy,
      skipped: classification.skipped,
      reason: classification.reason,
      nonFatal: classification.nonFatal,
      candidates: rows.length,
    });

    const ok = classification.ok === true;

    return {
      ok,
      skipped: true,
      busy: classification.busy,
      result: {
        ok,
        skipped: true,
        busy: classification.busy,
        reason: classification.reason,
        error: error?.message || "process_trades_failed",
        actions: [],
        candidatesCount: rows.length,
        durableSaveFailed: classification.reason === DURABLE_SAVE_TOO_LARGE,
      },
      error: {
        reason: classification.reason,
        message: error?.message || "process_trades_failed",
        name: error?.name || null,
        code: error?.code || null,
        stack: error?.stack?.slice?.(0, 2500) || null,
        nonFatal: classification.nonFatal,
      },
    };
  }
}

// ================= RESPONSE COMPACTION =================

function compactAction(action) {
  if (!action || typeof action !== "object") return action;

  return {
    tradeId: action.tradeId,
    symbol: action.symbol,
    side: action.side,
    action: action.action,
    analyzeLifecycle: action.analyzeLifecycle,
    reason: action.reason,
    exitReason: action.exitReason,

    parentFamilyId:
      action.parentFamilyId ||
      action.familyId ||
      action.analyzeFamilyId ||
      action.analysisFamilyId ||
      action.filterSnapshot?.parentFamilyId ||
      action.filterSnapshot?.familyId ||
      null,

    familyId:
      action.familyId ||
      action.analyzeFamilyId ||
      action.analysisFamilyId ||
      action.filterSnapshot?.familyId ||
      null,

    analyzeFamilyId:
      action.analyzeFamilyId ||
      action.familyId ||
      action.analysisFamilyId ||
      action.filterSnapshot?.analyzeFamilyId ||
      null,

    analysisFamilyId:
      action.analysisFamilyId ||
      action.familyId ||
      action.analyzeFamilyId ||
      action.filterSnapshot?.analysisFamilyId ||
      null,

    familyIds: action.familyIds || action.filterSnapshot?.familyIds || [],

    microFamilyId:
      action.microFamilyId ||
      action.rotationMicroFamilyId ||
      action.analyzerMicroFamilyId ||
      action.filterSnapshot?.microFamilyId ||
      null,

    rotationMicroFamilyId:
      action.rotationMicroFamilyId ||
      action.microFamilyId ||
      action.filterSnapshot?.rotationMicroFamilyId ||
      null,

    analyzerMicroFamilyId:
      action.analyzerMicroFamilyId ||
      action.microFamilyId ||
      action.filterSnapshot?.analyzerMicroFamilyId ||
      null,

    microFamilyIds: action.microFamilyIds || action.filterSnapshot?.microFamilyIds || [],
    microFamilySchemaVersion:
      action.microFamilySchemaVersion ||
      action.filterSnapshot?.microFamilySchemaVersion ||
      MICRO_FAMILY_SCHEMA_VERSION,

    syntheticAnalyzeEntry: action.syntheticAnalyzeEntry,
    syntheticAnalyzeExit: action.syntheticAnalyzeExit,

    setupClass: action.setupClass,
    grade: action.grade,

    entry: action.entry,
    entryPrice: action.entryPrice,
    openedAt: action.openedAt,
    entryTs: action.entryTs,

    exit: action.exit,
    exitPrice: action.exitPrice,
    closed: action.closed,
    closedAt: action.closedAt,

    sl: action.sl,
    tp: action.tp,

    rr: action.rr,
    baseRR: action.baseRR,
    finalRr: action.finalRr,
    plannedRR: action.plannedRR,

    realizedR: action.realizedR ?? action.pnlR ?? action.exitR,
    pnlR: action.pnlR ?? action.realizedR ?? action.exitR,
    exitR: action.exitR,
    pnlPct: action.pnlPct,

    confluence: action.confluence,
    sniperScore: action.sniperScore,
    moveScore: action.moveScore,
    score: action.score,

    rsi: action.rsi,
    rsiHTF: action.rsiHTF,
    rsiZone: action.rsiZone,
    rsiEdge: action.rsiEdge,

    stage: action.stage,
    scannerStage: action.scannerStage,
    flow: action.flow,

    obBias: action.obBias,
    spreadPct: action.spreadPct,
    spreadBps: action.spreadBps,
    depthMinUsd1p: action.depthMinUsd1p,
    btcState: action.btcState,
    fundingRate: action.fundingRate,
    funding: action.funding,

    regime: action.regime,
    strategyVersion: action.strategyVersion,
    ts: action.ts,
  };
}

function compactResponse(data) {
  const actions = Array.isArray(data?.tradeSystemResult?.actions)
    ? data.tradeSystemResult.actions
    : safeArray(data?.trades);

  return {
    ok: Boolean(data?.ok),
    skipped: Boolean(data?.skipped),
    busy: Boolean(data?.busy),
    reason: data?.reason || null,
    error: data?.error || null,

    traceVersion: data?.traceVersion || TRADE_FUNNEL_ROUTE_VERSION,
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
    durationMs: data?.durationMs ?? null,

    updatedAt: data?.updatedAt || Date.now(),
    tradeFunnelUpdatedAt: data?.tradeFunnelUpdatedAt || null,

    btc: data?.btc || null,
    regime: data?.regime || null,
    market: data?.market || null,

    tradeFunnelRawCount: safeNumber(data?.tradeFunnelRawCount, 0),
    tradeFunnelRejectCounts: data?.tradeFunnelRejectCounts || {},
    tradeFunnelInputCount: safeNumber(data?.tradeFunnelInputCount, 0),
    tradeFunnelInputSymbols: safeArray(data?.tradeFunnelInputSymbols).slice(0, 250),

    processTradesError: data?.processTradesError || null,
    analyzeAppendResult: data?.analyzeAppendResult || null,
    scanStoreResult: data?.scanStoreResult || null,
    syntheticDebug: data?.syntheticDebug || null,

    trades: actions.slice(0, MAX_RESPONSE_TRADES).map(compactAction),

    tradeSystemResult: {
      ok: data?.tradeSystemResult?.ok ?? null,
      skipped: Boolean(data?.tradeSystemResult?.skipped),
      busy: Boolean(data?.tradeSystemResult?.busy),
      reason: data?.tradeSystemResult?.reason || null,
      error: data?.tradeSystemResult?.error || null,
      candidatesCount: safeNumber(data?.tradeSystemResult?.candidatesCount, 0),
      strategyVersion: data?.tradeSystemResult?.strategyVersion || null,
      durableEnabled: Boolean(data?.tradeSystemResult?.durableEnabled),
      durableSaveFailed: Boolean(data?.tradeSystemResult?.durableSaveFailed),
      actions: actions.slice(0, MAX_RESPONSE_TRADES).map(compactAction),
    },
  };
}

// ================= CORE =================

export async function runTradeFunnel(options = {}) {
  const startedAt = Date.now();

  const notify = options.notify !== false;
  const store = options.store !== false;

  traceTradeFunnel("RUN_START", {
    notify,
    store,
  });

  let latest = null;

  try {
    traceTradeFunnel("GET_LATEST_SCAN_BEFORE");

    latest = await getLatestScan();

    traceTradeFunnel("GET_LATEST_SCAN_AFTER", {
      hasLatest: Boolean(latest),
      ok: Boolean(latest?.ok),
      updatedAt: latest?.updatedAt || null,
      hasFunnel: Boolean(latest?.funnel),
      bullEntry: safeArray(latest?.funnel?.bull?.entry).length,
      bearEntry: safeArray(latest?.funnel?.bear?.entry).length,
      bullAlmost: safeArray(latest?.funnel?.bull?.almost).length,
      bearAlmost: safeArray(latest?.funnel?.bear?.almost).length,
    });
  } catch (error) {
    errorTradeFunnel("GET_LATEST_SCAN", error);

    return {
      ok: false,
      skipped: true,
      busy: false,
      reason: "LATEST_SCAN_LOAD_FAILED",
      error: error?.message || "latest_scan_load_failed",
      notify,
      store,
      trades: [],
      tradeSystemResult: {
        ok: false,
        skipped: true,
        busy: false,
        reason: "LATEST_SCAN_LOAD_FAILED",
        error: error?.message || "latest_scan_load_failed",
        actions: [],
        candidatesCount: 0,
      },
      processTradesError: null,
      analyzeAppendResult: null,
      scanStoreResult: null,
      syntheticDebug: null,
      tradeFunnelRawCount: 0,
      tradeFunnelInputCount: 0,
      tradeFunnelRejectCounts: {},
      tradeFunnelInputSymbols: [],
      tradeFunnelUpdatedAt: Date.now(),
      updatedAt: Date.now(),
      traceVersion: TRADE_FUNNEL_ROUTE_VERSION,
      microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!latest?.ok) {
    traceTradeFunnel("NO_LATEST_SCAN_AVAILABLE", {
      latestOk: latest?.ok ?? null,
      keys: latest ? Object.keys(latest).slice(0, 30) : [],
    });

    return {
      ok: false,
      skipped: true,
      busy: false,
      reason: "NO_LATEST_SCAN_AVAILABLE",
      error: "no_latest_scan_available",
      notify,
      store,
      trades: [],
      tradeSystemResult: {
        ok: false,
        skipped: true,
        busy: false,
        reason: "NO_LATEST_SCAN_AVAILABLE",
        error: "no_latest_scan_available",
        actions: [],
        candidatesCount: 0,
      },
      processTradesError: null,
      analyzeAppendResult: null,
      scanStoreResult: null,
      syntheticDebug: null,
      tradeFunnelRawCount: 0,
      tradeFunnelInputCount: 0,
      tradeFunnelRejectCounts: {},
      tradeFunnelInputSymbols: [],
      tradeFunnelUpdatedAt: Date.now(),
      updatedAt: Date.now(),
      traceVersion: TRADE_FUNNEL_ROUTE_VERSION,
      microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
      durationMs: Date.now() - startedAt,
    };
  }

  const tradeFunnel = getTradeFunnelCandidates(latest);
  const candidates = tradeFunnel.candidates;
  const now = Date.now();

  traceTradeFunnel("CANDIDATES_READY", {
    rawCount: tradeFunnel.rawCount,
    candidates: candidates.length,
    rejectCounts: tradeFunnel.rejectCounts,
    symbols: candidates
      .slice(0, 40)
      .map(c => `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore || 0)}`),
  });

  const candidateIndex = buildCandidateIndex(candidates, latest);

  const syntheticEntries = buildSyntheticEntryEvents(candidates, latest);
  const syntheticExits = await buildSyntheticExitEvents(latest, now);

  traceTradeFunnel("SYNTHETIC_READY", {
    syntheticEntries: syntheticEntries.events.length,
    syntheticExits: syntheticExits.events.length,
    syntheticEntryDebug: syntheticEntries.debug,
    syntheticExitDebug: syntheticExits.debug,
  });

  const processTradesResult = await runProcessTradesSafe(candidates, latest, notify);
  const result = processTradesResult.result;

  const rawTradeActions = Array.isArray(result)
    ? result
    : Array.isArray(result?.actions)
      ? result.actions
      : [];

  traceTradeFunnel("RAW_TRADE_ACTIONS_READY", {
    rawTradeActions: rawTradeActions.length,
    processOk: processTradesResult.ok,
    processSkipped: processTradesResult.skipped,
    processBusy: processTradesResult.busy,
    processReason: result?.reason || null,
  });

  const enrichedTradeActions = rawTradeActions
    .map((action, index) => enrichTradeAction(action, latest, candidateIndex, index))
    .filter(Boolean);

  traceTradeFunnel("ENRICHED_TRADE_ACTIONS_READY", {
    enrichedTradeActions: enrichedTradeActions.length,
    entries: enrichedTradeActions.filter(a => String(a?.action).toUpperCase() === "ENTRY").length,
    exits: enrichedTradeActions.filter(a => String(a?.action).toUpperCase() === "EXIT").length,
    withMicroFamilyId: enrichedTradeActions.filter(a => Boolean(a?.microFamilyId)).length,
    withParentFamilyId: enrichedTradeActions.filter(a => Boolean(a?.familyId)).length,
  });

  const analyzeEvents = [
    ...syntheticEntries.events,
    ...syntheticExits.events,
    ...enrichedTradeActions,
  ];

  traceTradeFunnel("ANALYZE_EVENTS_READY", {
    analyzeEvents: analyzeEvents.length,
    syntheticEntries: syntheticEntries.events.length,
    syntheticExits: syntheticExits.events.length,
    realActions: enrichedTradeActions.length,
    withMicroFamilyId: analyzeEvents.filter(event => Boolean(event?.microFamilyId)).length,
    withParentFamilyId: analyzeEvents.filter(event => Boolean(event?.familyId)).length,
  });

  const analyzeAppendResult = store
    ? await appendTradesToAnalyzer(analyzeEvents, latest, {
        notify,
        store,
        syntheticEntries: syntheticEntries.events.length,
        syntheticExits: syntheticExits.events.length,
        realActions: enrichedTradeActions.length,
      })
    : {
        ok: true,
        skipped: true,
        reason: "STORE_FALSE",
        received: analyzeEvents.length,
        accepted: 0,
        acceptedEntries: 0,
        acceptedExits: 0,
        rejected: analyzeEvents.length,
        rejectCounts: {
          STORE_FALSE: analyzeEvents.length,
        },
      };

  const updatedResult = Array.isArray(result)
    ? {
        ok: true,
        actions: enrichedTradeActions,
        candidatesCount: candidates.length,
      }
    : {
        ok: result?.ok !== false,
        ...safeObject(result),
        actions: enrichedTradeActions,
        candidatesCount: result?.candidatesCount ?? candidates.length,
      };

  const updated = {
    ...latest,
    ok: processTradesResult.ok !== false,

    skipped: Boolean(processTradesResult.skipped),
    busy: Boolean(processTradesResult.busy),
    reason:
      result?.reason ||
      processTradesResult.error?.reason ||
      null,
    error:
      processTradesResult.error?.message ||
      result?.error ||
      null,

    traceVersion: TRADE_FUNNEL_ROUTE_VERSION,
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    trades: enrichedTradeActions,
    tradeSystemResult: updatedResult,
    processTradesError: processTradesResult.error,
    analyzeAppendResult,

    scanStoreResult: null,

    syntheticDebug: {
      entries: syntheticEntries.debug,
      exits: syntheticExits.debug,
      analyzeEvents: analyzeEvents.length,
      realActions: enrichedTradeActions.length,
    },

    tradeFunnelRawCount: tradeFunnel.rawCount,
    tradeFunnelInputCount: candidates.length,
    tradeFunnelRejectCounts: tradeFunnel.rejectCounts,
    tradeFunnelInputSymbols: candidates.map(c =>
      `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore || 0)}`
    ),

    tradeFunnelUpdatedAt: now,
    updatedAt: now,
    durationMs: Date.now() - startedAt,
  };

  let scanStoreResult = {
    ok: true,
    skipped: true,
    reason: "STORE_FALSE",
    ts: Date.now(),
  };

  if (store) {
    try {
      traceTradeFunnel("SET_LATEST_SCAN_BEFORE", {
        trades: enrichedTradeActions.length,
        actions: updatedResult.actions?.length || 0,
        analyzeOk: analyzeAppendResult?.ok ?? null,
      });

      await withTimeout(
        setLatestScan({
          ...updated,
          scanStoreResult: {
            ok: true,
            skipped: false,
            reason: "LATEST_SCAN_UPDATED",
            ts: Date.now(),
          },
        }),
        SCAN_STORE_TIMEOUT_MS,
        "SET_LATEST_SCAN"
      );

      scanStoreResult = {
        ok: true,
        skipped: false,
        reason: "LATEST_SCAN_UPDATED",
        ts: Date.now(),
      };

      traceTradeFunnel("SET_LATEST_SCAN_AFTER", {
        ok: true,
      });
    } catch (error) {
      errorTradeFunnel("SET_LATEST_SCAN", error);

      scanStoreResult = {
        ok: false,
        skipped: false,
        reason: "SET_LATEST_SCAN_FAILED",
        error: error?.message || "set_latest_scan_failed",
        ts: Date.now(),
      };
    }
  }

  const finalData = {
    ...updated,
    scanStoreResult,
    durationMs: Date.now() - startedAt,
  };

  traceTradeFunnel("RUN_DONE", {
    ok: Boolean(finalData.ok),
    skipped: Boolean(finalData.skipped),
    busy: Boolean(finalData.busy),
    reason: finalData.reason || null,
    error: finalData.error || null,
    candidates: finalData.tradeFunnelInputCount,
    trades: finalData.trades.length,
    analyzeOk: finalData.analyzeAppendResult?.ok ?? null,
    scanStoreOk: finalData.scanStoreResult?.ok ?? null,
    durationMs: finalData.durationMs,
  });

  return finalData;
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const startedAt = Date.now();

  const notify = normalizeNotify(req?.query?.notify, true);
  const store = normalizeStore(req?.query?.store, true);
  const full = normalizeFullResponse(req?.query?.full, false);

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Trade-Funnel-Version", TRADE_FUNNEL_ROUTE_VERSION);

  traceTradeFunnel("HANDLER_START", {
    method: req?.method || null,
    url: req?.url || null,
    notify,
    store,
    full,
    query: req?.query || {},
  });

  try {
    const data = await runTradeFunnel({ notify, store });

    traceTradeFunnel("HANDLER_SUCCESS", {
      ok: Boolean(data?.ok),
      skipped: Boolean(data?.skipped),
      busy: Boolean(data?.busy),
      reason: data?.reason || null,
      error: data?.error || null,
      trades: safeArray(data?.trades).length,
      candidates: data?.tradeFunnelInputCount || 0,
      analyzeOk: data?.analyzeAppendResult?.ok ?? null,
      scanStoreOk: data?.scanStoreResult?.ok ?? null,
      durationMs: Date.now() - startedAt,
    });

    return res.status(200).json(
      full
        ? {
            ...data,
            traceVersion: TRADE_FUNNEL_ROUTE_VERSION,
            microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
            httpStatus: 200,
            durationMs: data?.durationMs ?? Date.now() - startedAt,
          }
        : compactResponse({
            ...data,
            traceVersion: TRADE_FUNNEL_ROUTE_VERSION,
            durationMs: data?.durationMs ?? Date.now() - startedAt,
          })
    );
  } catch (error) {
    const busy = isLockBusyError(error);
    const redisTooLarge = isRedisPayloadTooLargeError(error);

    errorTradeFunnel("HANDLER_FATAL", error, {
      notify,
      store,
      full,
      busy,
      redisTooLarge,
      durationMs: Date.now() - startedAt,
    });

    return res.status(200).json({
      ok: redisTooLarge ? true : false,
      skipped: true,
      busy,
      reason: busy
        ? LOCK_BUSY_ERROR
        : redisTooLarge
          ? DURABLE_SAVE_TOO_LARGE
          : "TRADE_FUNNEL_API_ERROR",
      error: error?.message || "trade_funnel_api_error",
      traceVersion: TRADE_FUNNEL_ROUTE_VERSION,
      microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
      notify,
      store,
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
      ts: Date.now(),
    });
  }
}