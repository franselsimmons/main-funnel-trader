import fs from "fs/promises";
import path from "path";

import { getLatestScan } from "../lib/scanStore.js";
import * as analyzeStore from "../lib/analyze/analyzeStore.js";
import * as familyEngine from "../lib/analyze/familyEngine.js";
import * as familyMicroAnalyzer from "../lib/familyMicroAnalyzer.js";

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data");
const ANALYZER_DIR = path.join(DATA_DIR, "analyzer");

const DEFAULT_ANALYZER_EXPORT_FILE = path.join(
  ANALYZER_DIR,
  "latest-microfamily-analysis.json"
);

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_INCLUDE_LATEST = false;
const MAX_DEBUG_EVENTS = 50;

const DEFAULT_MIN_PARENT_CLOSED = DEFAULT_MIN_CLOSED;
const DEFAULT_MIN_SUB_CLOSED = 8;
const DEFAULT_MIN_MICRO_CLOSED = 6;

const DAY_MS = 86400000;

const ACCEPTED_ROTATION_STATUSES = new Set([
  "ELITE",
  "HOT",
  "GOOD",
  "STABLE"
]);

// Winrate-first fair ranking.
// 10/10 mag niet automatisch boven 80/100 eindigen.
const FAIR_WINRATE_TARGET_CLOSED = readPositiveNumberEnv(
  "ANALYZER_FAIR_WINRATE_TARGET_CLOSED",
  100
);

const FAIR_WINRATE_WILSON_Z = readPositiveNumberEnv(
  "ANALYZER_FAIR_WINRATE_WILSON_Z",
  1.96
);

const FAIR_WINRATE_PRIOR_ALPHA = readPositiveNumberEnv(
  "ANALYZER_FAIR_WINRATE_PRIOR_ALPHA",
  8
);

const FAIR_WINRATE_PRIOR_BETA = readPositiveNumberEnv(
  "ANALYZER_FAIR_WINRATE_PRIOR_BETA",
  8
);

// ================= ENV HELPERS =================

function readPositiveNumberEnv(key, fallback) {
  const n = Number(process.env[key]);

  return Number.isFinite(n) && n > 0 ? n : fallback;
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

function safeNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const cleaned = value.replace("%", "").replace(",", ".").trim();
    const n = Number(cleaned);

    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 3) {
  const n = safeNumber(value, 0);
  const p = 10 ** decimals;

  return Math.round(n * p) / p;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["long", "bull", "buy"].includes(s)) return "LONG";
  if (["short", "bear", "sell"].includes(s)) return "SHORT";

  return "";
}

function inferSideFromFamilyId(value) {
  const id = normalizeText(value);

  if (id.includes("SHORT")) return "SHORT";
  if (id.includes("LONG")) return "LONG";

  return "";
}

function normalizeTs(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function serializeError(error, debug = false) {
  const payload = {
    message: error?.message || String(error || "unknown_error"),
    name: error?.name || "Error"
  };

  if (debug && error?.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

function getEnvList(key, fallback = []) {
  const raw = process.env[key];

  if (!raw) return fallback;

  return String(raw)
    .split(",")
    .map(item => normalizeText(item))
    .filter(Boolean);
}

function resolveProjectPath(inputPath, fallbackPath) {
  if (!inputPath) return fallbackPath;
  if (path.isAbsolute(inputPath)) return inputPath;

  return path.join(ROOT_DIR, inputPath);
}

function getAnalyzerExportFilePath() {
  return resolveProjectPath(
    process.env.WEEKLY_ROTATION_ANALYZER_FILE ||
      process.env.ANALYZER_MICRO_ROTATION_EXPORT_FILE,
    DEFAULT_ANALYZER_EXPORT_FILE
  );
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeJsonAtomic(filePath, data) {
  await ensureParentDir(filePath);

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(data, null, 2);

  await fs.writeFile(tmpPath, `${payload}\n`, "utf8");
  await fs.rename(tmpPath, filePath);

  return {
    ok: true,
    path: filePath,
    bytes: Buffer.byteLength(payload, "utf8")
  };
}

function addDays(dateInput, days) {
  const date = new Date(dateInput);

  return new Date(date.getTime() + days * DAY_MS);
}

function getIsoWeekId(dateInput = new Date()) {
  const date = new Date(dateInput);
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));

  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utcDate - yearStart) / DAY_MS + 1) / 7);

  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ================= FAIR WINRATE HELPERS =================

function wilsonLowerBound(wins, total, z = FAIR_WINRATE_WILSON_Z) {
  const n = safeNumber(total, 0);
  const w = safeNumber(wins, 0);

  if (n <= 0) return 0;

  const p = clamp(w / n, 0, 1);
  const z2 = z * z;

  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function bayesianWinrate(wins, total) {
  const w = safeNumber(wins, 0);
  const n = safeNumber(total, 0);

  return (
    (w + FAIR_WINRATE_PRIOR_ALPHA) /
    (n + FAIR_WINRATE_PRIOR_ALPHA + FAIR_WINRATE_PRIOR_BETA)
  );
}

function normalizePercent(value) {
  const n = safeNumber(value, 0);

  if (n > 0 && n <= 1) return n * 100;

  return n;
}

function getRowClosed(row) {
  return safeNumber(
    row?.closed ??
      row?.closedTrades ??
      row?.closedCount ??
      row?.sampleSize,
    0
  );
}

function getRowWins(row) {
  const directWins = row?.wins;

  if (directWins !== undefined && directWins !== null && directWins !== "") {
    return safeNumber(directWins, 0);
  }

  const closed = getRowClosed(row);
  const rawWinrate = getRowWinrate(row);

  if (closed <= 0 || rawWinrate <= 0) return 0;

  return Math.round((rawWinrate / 100) * closed);
}

function calculateFairWinrateMeta(row) {
  const closed = getRowClosed(row);
  const wins = getRowWins(row);

  const directFairScore = safeNumber(row?.fairWinrateScore, NaN);
  const directWilson = normalizePercent(row?.wilsonLowerBoundNum ?? row?.wilsonLowerBound);
  const directAdjusted = normalizePercent(row?.adjustedWinrateNum ?? row?.adjustedWinrate);

  if (Number.isFinite(directFairScore) && directFairScore > 0) {
    return {
      wins,
      closed,
      winrate: getRowWinrate(row),
      adjustedWinrate: directAdjusted,
      wilsonLowerBound: directWilson,
      sampleConfidence: normalizePercent(row?.sampleConfidenceNum ?? row?.sampleConfidence),
      fairWinrateScore: directFairScore,
      source: "ROW_FAIR_SCORE"
    };
  }

  if (closed <= 0) {
    return {
      wins: 0,
      closed: 0,
      winrate: 0,
      adjustedWinrate: 0,
      wilsonLowerBound: 0,
      sampleConfidence: 0,
      fairWinrateScore: 0,
      source: "NO_CLOSED_SAMPLE"
    };
  }

  const raw = clamp(wins / closed, 0, 1);
  const adjusted = bayesianWinrate(wins, closed);
  const wilson = wilsonLowerBound(wins, closed);
  const sampleConfidence = clamp(closed / FAIR_WINRATE_TARGET_CLOSED, 0, 1);

  const fairWinrateScore =
    wilson * 72 +
    adjusted * 20 +
    raw * 8;

  return {
    wins,
    closed,
    winrate: round(raw * 100, 3),
    adjustedWinrate: round(adjusted * 100, 3),
    wilsonLowerBound: round(wilson * 100, 3),
    sampleConfidence: round(sampleConfidence * 100, 3),
    fairWinrateScore: round(fairWinrateScore, 3),
    source: "CALCULATED_WILSON_BAYES"
  };
}

// ================= TRADE RECORD HELPERS =================

function getTradeId(event) {
  const id =
    event?.tradeId ||
    event?.positionId ||
    event?.orderId ||
    event?.analyzeEventKey ||
    event?.analyzeEventId ||
    event?.eventId ||
    event?.id;

  return id ? String(id) : "";
}

function getEventTs(event, fallback = Date.now()) {
  return normalizeTs(
    event?.analyzeUpdatedAt ??
      event?.closedAt ??
      event?.exitAt ??
      event?.exitTs ??
      event?.updatedAt ??
      event?.openedAt ??
      event?.createdAt ??
      event?.entryTs ??
      event?.analyzeTs ??
      event?.ts,
    fallback
  );
}

function isIgnoredAction(event) {
  const action = normalizeText(event?.action || event?.status || event?.reason);
  const kind = normalizeText(event?.analyzeKind || event?.type);

  if (kind === "TRADE_RECORD") return false;
  if (kind === "UNMATCHED_EXIT") return false;

  return (
    action === "WAIT" ||
    action === "HOLD" ||
    action === "RUNNING" ||
    action === "NO_TRADE" ||
    action === "SKIP"
  );
}

function isTradeLikeRecord(event) {
  if (!event || typeof event !== "object") return false;
  if (isIgnoredAction(event)) return false;

  const kind = normalizeText(event.analyzeKind || event.type);

  if (kind === "TRADE_RECORD") return true;
  if (kind === "UNMATCHED_EXIT") return true;

  const action = normalizeText(event.action || event.status || event.reason);

  if (action.includes("ENTRY")) return true;
  if (action.includes("EXIT")) return true;
  if (action.includes("TP")) return true;
  if (action.includes("SL")) return true;
  if (event.closed === true) return true;

  return Boolean(
    event.tradeId ||
      event.positionId ||
      event.entry !== undefined ||
      event.entryPrice !== undefined ||
      event.exitPrice !== undefined
  );
}

function compactLatestEvent(event) {
  const side = normalizeSide(event.side || event.direction || event.tradeSide);
  const tradeId = getTradeId(event);

  return {
    ...event,
    tradeId: tradeId || undefined,
    side: side || event.side,
    analyzeSource: event.analyzeSource || "latest_scan_debug",
    analyzeTs: getEventTs(event)
  };
}

function eventKey(event, fallbackIndex = 0) {
  const tradeId = getTradeId(event);

  if (tradeId) return tradeId;

  const kind = normalizeText(event?.analyzeKind || event?.type);
  const symbol = String(event?.symbol || "").toUpperCase().trim();
  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);
  const ts = getEventTs(event, fallbackIndex);

  return [kind || "EVENT", symbol, side, ts, fallbackIndex].join("|");
}

function dedupeEvents(events) {
  const map = new Map();

  safeArray(events).forEach((event, index) => {
    if (!isTradeLikeRecord(event)) return;

    const key = eventKey(event, index);
    const previous = map.get(key);

    if (!previous) {
      map.set(key, {
        ...event,
        analyzeEventKey: event.analyzeEventKey || key
      });
      return;
    }

    const prevTs = getEventTs(previous, 0);
    const nextTs = getEventTs(event, 0);

    if (nextTs >= prevTs) {
      map.set(key, {
        ...previous,
        ...event,
        analyzeEventKey: previous.analyzeEventKey || event.analyzeEventKey || key
      });
    }
  });

  return Array.from(map.values()).sort((a, b) => getEventTs(a, 0) - getEventTs(b, 0));
}

function collectLatestEvents(latest) {
  if (!latest?.ok) return [];

  const raw = [
    ...safeArray(latest.trades),
    ...safeArray(latest.tradeSystemResult?.actions),
    ...safeArray(latest.actions)
  ];

  return dedupeEvents(raw.map(compactLatestEvent));
}

// ================= STORE LOADERS =================

async function loadStoredEvents() {
  const loadStore =
    analyzeStore.loadAnalyzeStore ||
    analyzeStore.default?.loadAnalyzeStore;

  const loadEvents =
    analyzeStore.loadAnalyzeEvents ||
    analyzeStore.readAnalyzeEvents ||
    analyzeStore.getAnalyzeEvents ||
    analyzeStore.default?.loadAnalyzeEvents ||
    analyzeStore.default?.readAnalyzeEvents ||
    analyzeStore.default?.getAnalyzeEvents;

  if (typeof loadStore === "function") {
    const store = await loadStore();
    const events = safeArray(store?.events);

    return {
      store: {
        ok: Boolean(store?.ok),
        path: store?.path || null,
        count: safeNumber(store?.count, events.length),
        trades: safeNumber(store?.trades, events.length),
        unmatchedExits: safeNumber(store?.unmatchedExits, 0),
        maxStoredEvents: store?.maxStoredEvents || null,
        primary: store?.primary || store?.source || null,
        redisEnabled: Boolean(store?.redisEnabled),
        fileEnabled: store?.fileEnabled !== false,
        error: store?.error || null
      },
      events
    };
  }

  if (typeof loadEvents === "function") {
    const events = await loadEvents();

    return {
      store: {
        ok: true,
        path: null,
        count: safeArray(events).length,
        trades: safeArray(events).length,
        unmatchedExits: 0,
        maxStoredEvents: null,
        primary: "events_loader",
        redisEnabled: false,
        fileEnabled: false,
        error: null
      },
      events: safeArray(events)
    };
  }

  return {
    store: {
      ok: false,
      path: null,
      count: 0,
      trades: 0,
      unmatchedExits: 0,
      maxStoredEvents: null,
      primary: null,
      redisEnabled: false,
      fileEnabled: false,
      error: "NO_ANALYZE_STORE_LOADER_FOUND"
    },
    events: []
  };
}

async function clearStoredEvents() {
  const clearFn =
    analyzeStore.clearAnalyzeEvents ||
    analyzeStore.resetAnalyzeEvents ||
    analyzeStore.default?.clearAnalyzeEvents ||
    analyzeStore.default?.resetAnalyzeEvents;

  if (typeof clearFn !== "function") {
    return {
      ok: false,
      error: "NO_CLEAR_ANALYZE_EVENTS_EXPORT_FOUND"
    };
  }

  return clearFn();
}

// ================= REPORT BUILDER =================

function buildReport(events, options) {
  const buildFn =
    familyEngine.buildAnalyzeReport ||
    familyEngine.buildFamilyReport ||
    familyEngine.buildReport ||
    familyEngine.analyzeEvents ||
    familyEngine.createAnalyzeReport ||
    familyEngine.default?.buildAnalyzeReport ||
    familyEngine.default?.buildFamilyReport ||
    familyEngine.default?.buildReport ||
    familyEngine.default?.analyzeEvents ||
    familyEngine.default?.createAnalyzeReport;

  if (typeof buildFn !== "function") {
    throw new Error("NO_ANALYZE_REPORT_BUILDER_FOUND");
  }

  return buildFn(events, options);
}

// ================= MICRO FAMILY BUILDER =================

function getMicroBuildFn() {
  return (
    familyMicroAnalyzer.buildMainFamilyMicroAnalysis ||
    familyMicroAnalyzer.buildFamilyMicroAnalysis ||
    familyMicroAnalyzer.buildMicroFamilyAnalysis ||
    familyMicroAnalyzer.buildFamilyMicroReport ||
    familyMicroAnalyzer.buildMicroReport ||
    familyMicroAnalyzer.default?.buildMainFamilyMicroAnalysis ||
    familyMicroAnalyzer.default?.buildFamilyMicroAnalysis ||
    familyMicroAnalyzer.default?.buildMicroFamilyAnalysis ||
    familyMicroAnalyzer.default?.buildFamilyMicroReport ||
    familyMicroAnalyzer.default?.buildMicroReport
  );
}

function getBestMainLongShortFn() {
  return (
    familyMicroAnalyzer.getBestMainLongShort ||
    familyMicroAnalyzer.getBestLongShort ||
    familyMicroAnalyzer.getBestMicroLongShort ||
    familyMicroAnalyzer.default?.getBestMainLongShort ||
    familyMicroAnalyzer.default?.getBestLongShort ||
    familyMicroAnalyzer.default?.getBestMicroLongShort
  );
}

function getAllowlistFn() {
  return (
    familyMicroAnalyzer.buildMainDiscordAllowlist ||
    familyMicroAnalyzer.buildDiscordAllowlist ||
    familyMicroAnalyzer.buildMicroAllowlist ||
    familyMicroAnalyzer.default?.buildMainDiscordAllowlist ||
    familyMicroAnalyzer.default?.buildDiscordAllowlist ||
    familyMicroAnalyzer.default?.buildMicroAllowlist
  );
}

function getStatusRank(status) {
  const s = normalizeText(status);

  if (s === "ELITE") return 6;
  if (s === "HOT") return 5;
  if (s === "GOOD") return 4;
  if (s === "STABLE") return 3;
  if (s === "CANDIDATE") return 2;
  if (s === "COLLECTING") return 1;
  if (s === "EMPTY") return 0;
  if (s === "BAD") return -1;

  return 0;
}

function getRowProfitFactor(row) {
  return safeNumber(row?.pf ?? row?.profitFactor ?? row?.profitFactorR, 0);
}

function getRowWinrate(row) {
  const raw =
    row?.winrate ??
    row?.winRate ??
    row?.winrateNum ??
    row?.winRateNum;

  return normalizePercent(raw);
}

function getRowFairScore(row) {
  return calculateFairWinrateMeta(row).fairWinrateScore;
}

function getRowWilson(row) {
  return calculateFairWinrateMeta(row).wilsonLowerBound;
}

function getRowAdjustedWinrate(row) {
  return calculateFairWinrateMeta(row).adjustedWinrate;
}

function getRowSampleConfidence(row) {
  return calculateFairWinrateMeta(row).sampleConfidence;
}

function sortMainMicroFallback(a, b) {
  const statusDiff = getStatusRank(b.status) - getStatusRank(a.status);
  if (statusDiff !== 0) return statusDiff;

  const fairScoreDiff = getRowFairScore(b) - getRowFairScore(a);
  if (fairScoreDiff !== 0) return fairScoreDiff;

  const wilsonDiff = getRowWilson(b) - getRowWilson(a);
  if (wilsonDiff !== 0) return wilsonDiff;

  const adjustedWinrateDiff = getRowAdjustedWinrate(b) - getRowAdjustedWinrate(a);
  if (adjustedWinrateDiff !== 0) return adjustedWinrateDiff;

  const rawWinrateDiff = getRowWinrate(b) - getRowWinrate(a);
  if (rawWinrateDiff !== 0) return rawWinrateDiff;

  const sampleDiff = getRowSampleConfidence(b) - getRowSampleConfidence(a);
  if (sampleDiff !== 0) return sampleDiff;

  const closedDiff = getRowClosed(b) - getRowClosed(a);
  if (closedDiff !== 0) return closedDiff;

  // Alleen tie-break. Niet primair.
  const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgRDiff !== 0) return avgRDiff;

  const pfDiff = getRowProfitFactor(b) - getRowProfitFactor(a);
  if (pfDiff !== 0) return pfDiff;

  return String(extractFamilyId(b)).localeCompare(String(extractFamilyId(a)));
}

function fallbackBestMainLongShort(microAnalysis, minClosed) {
  const rows = [
    ...safeArray(microAnalysis?.microFamilies),
    ...safeArray(microAnalysis?.subFamilies),
    ...safeArray(microAnalysis?.parentFamilies)
  ]
    .filter(row => getRowClosed(row) >= minClosed)
    .filter(row => getRowFairScore(row) > 0)
    .sort(sortMainMicroFallback);

  return {
    mode: "MAIN",
    level: "fallback_combined",
    minClosed,
    rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
    bestLong: rows.find(row => normalizeSide(row.side) === "LONG") || null,
    bestShort: rows.find(row => normalizeSide(row.side) === "SHORT") || null
  };
}

function fallbackAllowlist(microAnalysis) {
  return [
    ...safeArray(microAnalysis?.allowlists?.micro),
    ...safeArray(microAnalysis?.allowlists?.sub),
    ...safeArray(microAnalysis?.allowlists?.parent)
  ].filter(item => ACCEPTED_ROTATION_STATUSES.has(normalizeText(item.status)));
}

function buildMicroAnalysis(events, options = {}) {
  const buildFn = getMicroBuildFn();

  if (typeof buildFn !== "function") {
    return {
      ok: false,
      enabled: false,
      error: "NO_FAMILY_MICRO_ANALYZER_EXPORT_FOUND",
      expectedFile: "../lib/familyMicroAnalyzer.js"
    };
  }

  return buildFn(events, options);
}

function buildMicroPayload(events, options = {}) {
  const minClosed = safeNumber(options.minClosed, DEFAULT_MIN_CLOSED);
  const minParentClosed = safeNumber(options.minParentClosed, DEFAULT_MIN_PARENT_CLOSED);
  const minSubClosed = safeNumber(options.minSubClosed, DEFAULT_MIN_SUB_CLOSED);
  const minMicroClosed = safeNumber(options.minMicroClosed, DEFAULT_MIN_MICRO_CLOSED);

  const microAnalysis = buildMicroAnalysis(events, {
    minClosed,
    minParentClosed,
    minSubClosed,
    minMicroClosed,

    familyCountLong: 50,
    familyCountShort: 50,

    profile: "MAIN",
    mode: "MAIN",

    rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
    optimizeFor: "WINRATE"
  });

  if (!microAnalysis?.ok) {
    return {
      microAnalysis,
      bestMicroMain: {
        mode: "MAIN",
        ok: false,
        reason: microAnalysis?.error || "MICRO_ANALYSIS_NOT_AVAILABLE",
        bestLong: null,
        bestShort: null
      },
      mainDiscordAllowlist: []
    };
  }

  const bestFn = getBestMainLongShortFn();
  const allowlistFn = getAllowlistFn();

  const bestMicroMain =
    typeof bestFn === "function"
      ? bestFn(microAnalysis, {
          level: "micro",
          minClosed: minMicroClosed,
          rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
          optimizeFor: "WINRATE"
        })
      : fallbackBestMainLongShort(microAnalysis, minMicroClosed);

  const mainDiscordAllowlist =
    typeof allowlistFn === "function"
      ? allowlistFn(microAnalysis, {
          level: "micro",
          minStatus: "STABLE",
          rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
          optimizeFor: "WINRATE"
        })
      : fallbackAllowlist(microAnalysis);

  return {
    microAnalysis,
    bestMicroMain,
    mainDiscordAllowlist
  };
}

// ================= ROTATION EXPORT BUILDER =================

function extractFamilyId(row) {
  if (typeof row === "string") return row.trim();

  return String(
    row?.microFamilyId ||
      row?.familyId ||
      row?.family ||
      row?.id ||
      row?.key ||
      row?.name ||
      ""
  ).trim();
}

function extractParentFamilyId(row) {
  return (
    row?.parentFamilyId ||
    row?.parentFamily ||
    row?.parent ||
    row?.parentId ||
    row?.mainFamily ||
    null
  );
}

function normalizeDefinition(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split("|")
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeWinnerForExport(row, fallbackSide = "") {
  const raw = typeof row === "string" ? { microFamilyId: row } : safeObject(row);
  const microFamilyId = extractFamilyId(raw);

  if (!microFamilyId) return null;

  const side =
    normalizeSide(raw.side || raw.direction) ||
    inferSideFromFamilyId(microFamilyId) ||
    fallbackSide;

  if (!side) return null;

  const fair = calculateFairWinrateMeta(raw);
  const winrate = fair.winrate || getRowWinrate(raw);
  const pf = getRowProfitFactor(raw);
  const closed = getRowClosed(raw);

  return {
    microFamilyId,
    parentFamilyId: extractParentFamilyId(raw),
    level: normalizeText(raw.level || "MICRO"),
    side,
    status: normalizeText(raw.status || raw.rating || "ACTIVE"),

    observed: safeNumber(raw.observed ?? raw.trades ?? raw.count, 0),
    trades: safeNumber(raw.trades ?? raw.observed ?? raw.count, 0),
    closed,
    wins: fair.wins,
    losses: safeNumber(raw.losses, Math.max(0, closed - fair.wins)),
    breakeven: safeNumber(raw.breakeven ?? raw.be, 0),

    winrate,
    adjustedWinrate: fair.adjustedWinrate,
    wilsonLowerBound: fair.wilsonLowerBound,
    sampleConfidence: fair.sampleConfidence,
    fairWinrateScore: fair.fairWinrateScore,
    fairWinrateSource: fair.source,
    rankingMetric: "FAIR_WINRATE_WILSON_BAYES",

    avgR: safeNumber(raw.avgR ?? raw.averageR, 0),
    totalR: safeNumber(raw.totalR ?? raw.sumR, 0),
    pf,
    score: safeNumber(raw.score ?? raw.analyzerScore, 0),

    definition: normalizeDefinition(
      raw.definition ||
        raw.filterFamily ||
        raw.signature ||
        raw.filters ||
        raw.tags
    ),

    selectedAt: new Date().toISOString(),
    source: "TRADESYSTEM_ANALYZER"
  };
}

function selectDirectBest(bestMicroMain, side) {
  const payload = safeObject(bestMicroMain);
  const wantedSide = normalizeText(side);

  if (wantedSide === "LONG") {
    return (
      payload.bestMainLong ||
      payload.bestMicroLong ||
      payload.bestLong ||
      payload.long ||
      payload.LONG ||
      null
    );
  }

  if (wantedSide === "SHORT") {
    return (
      payload.bestMainShort ||
      payload.bestMicroShort ||
      payload.bestShort ||
      payload.short ||
      payload.SHORT ||
      null
    );
  }

  return null;
}

function collectCandidateRows(microAnalysis, mainDiscordAllowlist) {
  return [
    ...safeArray(mainDiscordAllowlist),
    ...safeArray(microAnalysis?.allowlists?.micro),
    ...safeArray(microAnalysis?.microFamilies),
    ...safeArray(microAnalysis?.subFamilies),
    ...safeArray(microAnalysis?.parentFamilies)
  ];
}

function rowPassesRotationExport(row, side, minClosed) {
  const normalized = normalizeWinnerForExport(row, side);

  if (!normalized) return false;
  if (normalized.side !== side) return false;
  if (normalized.level && normalized.level !== "MICRO") return false;
  if (!ACCEPTED_ROTATION_STATUSES.has(normalized.status)) return false;
  if (normalized.closed < minClosed) return false;
  if (normalized.fairWinrateScore <= 0) return false;

  // Geen avgR/PF hard-block meer.
  // Winrate is leidend; avgR/PF zijn alleen tie-breaks en diagnostiek.
  return true;
}

function sortExportWinners(a, b) {
  const statusDiff = getStatusRank(b.status) - getStatusRank(a.status);
  if (statusDiff !== 0) return statusDiff;

  const fairDiff = safeNumber(b.fairWinrateScore, 0) - safeNumber(a.fairWinrateScore, 0);
  if (fairDiff !== 0) return fairDiff;

  const wilsonDiff = safeNumber(b.wilsonLowerBound, 0) - safeNumber(a.wilsonLowerBound, 0);
  if (wilsonDiff !== 0) return wilsonDiff;

  const adjustedDiff = safeNumber(b.adjustedWinrate, 0) - safeNumber(a.adjustedWinrate, 0);
  if (adjustedDiff !== 0) return adjustedDiff;

  const rawWinrateDiff = safeNumber(b.winrate, 0) - safeNumber(a.winrate, 0);
  if (rawWinrateDiff !== 0) return rawWinrateDiff;

  const confidenceDiff = safeNumber(b.sampleConfidence, 0) - safeNumber(a.sampleConfidence, 0);
  if (confidenceDiff !== 0) return confidenceDiff;

  const closedDiff = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  if (closedDiff !== 0) return closedDiff;

  // Alleen tie-break.
  const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgRDiff !== 0) return avgRDiff;

  const pfDiff = safeNumber(b.pf, 0) - safeNumber(a.pf, 0);
  if (pfDiff !== 0) return pfDiff;

  return String(a.microFamilyId).localeCompare(String(b.microFamilyId));
}

function selectWinnerForExport({
  bestMicroMain,
  microAnalysis,
  mainDiscordAllowlist,
  side,
  minClosed
}) {
  const direct = selectDirectBest(bestMicroMain, side);

  const candidates = [
    direct,
    ...collectCandidateRows(microAnalysis, mainDiscordAllowlist)
  ]
    .filter(Boolean)
    .map(row => normalizeWinnerForExport(row, side))
    .filter(Boolean)
    .filter(row => rowPassesRotationExport(row, side, minClosed))
    .sort(sortExportWinners);

  return candidates[0] || null;
}

function shouldExportMicroRotation(selectedSource) {
  const enabled = normalizeBoolean(
    process.env.ANALYZER_MICRO_ROTATION_EXPORT ??
      process.env.ANALYZER_MICRO_ROTATION_EXPORT_ENABLED,
    true
  );

  if (!enabled) return false;

  const allowedSources = getEnvList("ANALYZER_MICRO_ROTATION_EXPORT_SOURCES", [
    "STORED"
  ]);

  return allowedSources.includes(normalizeText(selectedSource));
}

function buildMicroRotationExportPayload({
  selectedSource,
  selectedEvents,
  store,
  latest,
  microAnalysis,
  bestMicroMain,
  mainDiscordAllowlist,
  minClosed,
  minParentClosed,
  minSubClosed,
  minMicroClosed,
  generatedAt
}) {
  const generatedDate = new Date(generatedAt);
  const sourceWeekId = getIsoWeekId(generatedDate);
  const targetWeekId = getIsoWeekId(addDays(generatedDate, 7));

  const bestMainLong = selectWinnerForExport({
    bestMicroMain,
    microAnalysis,
    mainDiscordAllowlist,
    side: "LONG",
    minClosed: minMicroClosed
  });

  const bestMainShort = selectWinnerForExport({
    bestMicroMain,
    microAnalysis,
    mainDiscordAllowlist,
    side: "SHORT",
    minClosed: minMicroClosed
  });

  const allowlist = [bestMainLong, bestMainShort].filter(Boolean);

  return {
    ok: allowlist.length > 0,
    exportVersion: 2,
    type: "LATEST_MICROFAMILY_ANALYSIS",
    mode: "MAIN_MICRO_WEEKLY_ROTATION",
    source: "TRADESYSTEM_ANALYZER",

    generatedAt,
    updatedAt: generatedAt,

    weekId: sourceWeekId,
    sourceWeekId,
    nextWeekId: targetWeekId,
    targetWeekId,

    selectedSource,

    ranking: {
      primary: "FAIR_WINRATE_WILSON_BAYES",
      optimizeFor: "WINRATE",
      pnlIsPrimary: false,
      avgRIsTieBreakOnly: true,
      targetClosed: FAIR_WINRATE_TARGET_CLOSED,
      wilsonZ: FAIR_WINRATE_WILSON_Z,
      priorAlpha: FAIR_WINRATE_PRIOR_ALPHA,
      priorBeta: FAIR_WINRATE_PRIOR_BETA,
      formula: "fairWinrateScore = wilsonLowerBound*72 + bayesianAdjustedWinrate*20 + rawWinrate*8"
    },

    bestMainLong,
    bestMainShort,

    winners: {
      long: bestMainLong,
      short: bestMainShort
    },

    allowedMicroFamilyIds: allowlist.map(row => row.microFamilyId),
    activeMicroFamilyIds: allowlist.map(row => row.microFamilyId),

    allowlist,

    config: {
      minClosed,
      minParentClosed,
      minSubClosed,
      minMicroClosed,
      level: "MICRO",
      acceptedStatuses: Array.from(ACCEPTED_ROTATION_STATUSES)
    },

    stats: {
      selectedEvents: safeArray(selectedEvents).length,
      microFamilies: safeArray(microAnalysis?.microFamilies).length,
      subFamilies: safeArray(microAnalysis?.subFamilies).length,
      parentFamilies: safeArray(microAnalysis?.parentFamilies).length,
      mainDiscordAllowlist: safeArray(mainDiscordAllowlist).length
    },

    sourceState: {
      store: {
        ok: Boolean(store?.ok),
        count: safeNumber(store?.count, 0),
        trades: safeNumber(store?.trades, 0),
        primary: store?.primary || null,
        path: store?.path || null,
        error: store?.error || null
      },
      latest: {
        ok: latest?.ok ?? null,
        skipped: Boolean(latest?.skipped),
        updatedAt: latest?.updatedAt || null,
        error: latest?.error || null
      }
    },

    note:
      "Dit bestand is de source-of-truth voor weekly rotation. Beste MICRO LONG en MICRO SHORT worden gekozen op fair winrate, niet op hoogste PnL."
  };
}

async function exportMicroRotationAnalysis({
  selectedSource,
  selectedEvents,
  store,
  latest,
  microAnalysis,
  bestMicroMain,
  mainDiscordAllowlist,
  minClosed,
  minParentClosed,
  minSubClosed,
  minMicroClosed,
  generatedAt
}) {
  if (!shouldExportMicroRotation(selectedSource)) {
    return {
      ok: false,
      skipped: true,
      reason: "EXPORT_DISABLED_OR_SOURCE_NOT_ALLOWED",
      selectedSource,
      allowedSources: getEnvList("ANALYZER_MICRO_ROTATION_EXPORT_SOURCES", [
        "STORED"
      ])
    };
  }

  const filePath = getAnalyzerExportFilePath();

  const payload = buildMicroRotationExportPayload({
    selectedSource,
    selectedEvents,
    store,
    latest,
    microAnalysis,
    bestMicroMain,
    mainDiscordAllowlist,
    minClosed,
    minParentClosed,
    minSubClosed,
    minMicroClosed,
    generatedAt
  });

  const writeResult = await writeJsonAtomic(filePath, payload);

  return {
    ok: Boolean(payload.ok),
    skipped: false,
    reason: payload.ok
      ? "MICRO_ROTATION_ANALYSIS_EXPORTED"
      : "MICRO_ROTATION_ANALYSIS_EXPORTED_WITH_EMPTY_ALLOWLIST",
    file: writeResult.path,
    bytes: writeResult.bytes,
    weekId: payload.weekId,
    targetWeekId: payload.targetWeekId,
    rankingMetric: payload.ranking.primary,
    bestMainLong: payload.bestMainLong?.microFamilyId || null,
    bestMainShort: payload.bestMainShort?.microFamilyId || null,
    allowlistCount: payload.allowlist.length
  };
}

// ================= DEBUG HELPERS =================

function compactSourcePreview(events) {
  return safeArray(events)
    .slice(-MAX_DEBUG_EVENTS)
    .map(event => ({
      tradeId: getTradeId(event) || null,
      analyzeKind: event.analyzeKind || event.type || null,
      source: event.analyzeSource || null,
      symbol: event.symbol || null,
      side: normalizeSide(event.side || event.direction || event.tradeSide) || null,
      familyId: event.familyId || event.analyzeFamilyId || event.filterSnapshot?.familyId || null,
      closed: Boolean(event.closed),
      realizedR: event.realizedR ?? event.pnlR ?? event.resultR ?? null,
      pnlPct: event.pnlPct ?? event.realizedPnlPct ?? null,
      exitReason: event.exitReason || null,
      ts: getEventTs(event, null)
    }));
}

function countKinds(events) {
  const counts = {};

  for (const event of safeArray(events)) {
    const kind = normalizeText(event?.analyzeKind || event?.type || "UNKNOWN");
    counts[kind] = safeNumber(counts[kind], 0) + 1;
  }

  return counts;
}

function selectEvents({ storedEvents, latestEvents, sourceMode }) {
  if (sourceMode === "latest") {
    return {
      selectedEvents: latestEvents,
      selectedSource: "latest"
    };
  }

  if (sourceMode === "merged") {
    return {
      selectedEvents: dedupeEvents([...storedEvents, ...latestEvents]),
      selectedSource: "merged"
    };
  }

  return {
    selectedEvents: storedEvents,
    selectedSource: "stored"
  };
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const startedAt = Date.now();

  const debug = normalizeBoolean(req?.query?.debug, false);
  const reset = normalizeBoolean(req?.query?.reset, false);

  const includeLatest = normalizeBoolean(
    req?.query?.includeLatest,
    DEFAULT_INCLUDE_LATEST
  );

  const minClosed = safeNumber(req?.query?.minClosed, DEFAULT_MIN_CLOSED);

  const minParentClosed = safeNumber(
    req?.query?.minParentClosed,
    minClosed
  );

  const minSubClosed = safeNumber(
    req?.query?.minSubClosed,
    DEFAULT_MIN_SUB_CLOSED
  );

  const minMicroClosed = safeNumber(
    req?.query?.minMicroClosed,
    DEFAULT_MIN_MICRO_CLOSED
  );

  const sourceMode = String(req?.query?.source || "stored").toLowerCase().trim();

  const normalizedSourceMode = ["stored", "latest", "merged"].includes(sourceMode)
    ? sourceMode
    : "stored";

  try {
    if (reset) {
      const clearResult = await clearStoredEvents();

      return res.status(clearResult?.ok ? 200 : 500).json({
        ok: Boolean(clearResult?.ok),
        reset: true,
        clearResult,
        generatedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt
      });
    }

    const generatedAt = new Date().toISOString();

    const { store, events: storedEventsRaw } = await loadStoredEvents();

    const latest =
      includeLatest || normalizedSourceMode === "latest" || normalizedSourceMode === "merged"
        ? await getLatestScan().catch(error => ({
            ok: false,
            error: error?.message || String(error)
          }))
        : {
            ok: null,
            skipped: true,
            reason: "includeLatest=false"
          };

    const storedEvents = dedupeEvents(storedEventsRaw);

    const latestEvents =
      latest?.ok &&
      (includeLatest || normalizedSourceMode === "latest" || normalizedSourceMode === "merged")
        ? collectLatestEvents(latest)
        : [];

    const { selectedEvents, selectedSource } = selectEvents({
      storedEvents,
      latestEvents,
      sourceMode: normalizedSourceMode
    });

    const baseReport = buildReport(selectedEvents, {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
      rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
      optimizeFor: "WINRATE"
    });

    const {
      microAnalysis,
      bestMicroMain,
      mainDiscordAllowlist
    } = buildMicroPayload(selectedEvents, {
      minClosed,
      minParentClosed,
      minSubClosed,
      minMicroClosed
    });

    const report = {
      ...safeObject(baseReport),

      microAnalysis,
      bestMicroMain,
      mainDiscordAllowlist,

      microConfig: {
        enabled: Boolean(microAnalysis?.ok),
        minParentClosed,
        minSubClosed,
        minMicroClosed,
        rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
        optimizeFor: "WINRATE",
        pnlIsPrimary: false,
        note:
          "Microfamilies gebruiken alleen entry-known velden voor classificatie. Outcome-data wordt alleen gebruikt voor fair-winrate ranking/statistiek."
      }
    };

    let analyzerExport = {
      ok: false,
      skipped: true,
      reason: "MICRO_ANALYSIS_NOT_OK"
    };

    if (microAnalysis?.ok) {
      try {
        analyzerExport = await exportMicroRotationAnalysis({
          selectedSource,
          selectedEvents,
          store,
          latest,
          microAnalysis,
          bestMicroMain,
          mainDiscordAllowlist,
          minClosed,
          minParentClosed,
          minSubClosed,
          minMicroClosed,
          generatedAt
        });
      } catch (exportError) {
        analyzerExport = {
          ok: false,
          skipped: false,
          reason: "MICRO_ROTATION_EXPORT_FAILED",
          error: serializeError(exportError, debug),
          file: getAnalyzerExportFilePath()
        };

        console.error("MICRO ROTATION EXPORT ERROR:", exportError);
      }
    }

    const response = {
      ok: true,
      generatedAt,
      latencyMs: Date.now() - startedAt,

      mode: {
        source: selectedSource,
        includeLatest,
        minClosed,
        minParentClosed,
        minSubClosed,
        minMicroClosed,
        rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
        optimizeFor: "WINRATE",
        pnlIsPrimary: false,
        note:
          selectedSource === "stored"
            ? "Analyse gebruikt alleen opgeslagen analyse-records. Latest scan wordt niet meegeteld tenzij source=latest/merged of includeLatest=true."
            : "Analyse gebruikt debug/latest data. Gebruik source=stored voor echte family-statistiek."
      },

      sources: {
        selectedEvents: selectedEvents.length,
        storedEvents: storedEvents.length,
        latestEvents: latestEvents.length,
        storedKinds: countKinds(storedEvents),
        latestKinds: countKinds(latestEvents),
        selectedKinds: countKinds(selectedEvents),
        store,
        latest: {
          ok: latest?.ok ?? null,
          skipped: Boolean(latest?.skipped),
          reason: latest?.reason || null,
          updatedAt: latest?.updatedAt || null,
          tradeFunnelUpdatedAt: latest?.tradeFunnelUpdatedAt || null,
          error: latest?.error || null
        }
      },

      tradesLoaded: selectedEvents.length,

      analyzerExport,

      // Top-level shortcuts voor frontend.
      microAnalysis,
      bestMicroMain,
      mainDiscordAllowlist,

      // Bestaande analyzer blijft onder report staan.
      report
    };

    if (debug) {
      response.debug = {
        storedPreview: compactSourcePreview(storedEvents),
        latestPreview: compactSourcePreview(latestEvents),
        selectedPreview: compactSourcePreview(selectedEvents)
      };
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("ANALYSE API ERROR:", error);

    return res.status(500).json({
      ok: false,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: serializeError(error, debug)
    });
  }
}