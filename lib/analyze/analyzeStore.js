// ================= lib/analyze/analyzeStore.js =================
// Fixes:
// - Geen mega JSON SET meer naar Upstash.
// - Redis gebruikt LIST + RPUSH batches + LTRIM.
// - Entries worden als open records opgeslagen.
// - Exits worden op bestaande open entries gematched via tradeId.
// - Same-batch ENTRY -> EXIT mutatie werkt correct.
// - Gesloten ENTRY-records blijven ENTRY-records met closed=true.
// - Unmatched exits worden standaard genegeerd om rommel te voorkomen.
// - File + memory fallback blijven bestaan.
// - Winrate is hoofdmetric: fair ranking via Wilson lower bound + Bayesian shrinkage.
// - PnL/R wordt alleen secundair opgeslagen, niet gebruikt als primaire "beste" score.
// - Micro/family IDs worden expliciet genormaliseerd en opgeslagen voor rotation-learning.

import { promises as fs } from "fs";
import path from "path";

// ================= CONFIG =================

const ANALYZE_REDIS_BASE_KEY =
  process.env.ANALYZE_REDIS_KEY ||
  "tradesystem:analyze:store:v3";

const ANALYZE_REDIS_LIST_KEY =
  process.env.ANALYZE_REDIS_LIST_KEY ||
  `${ANALYZE_REDIS_BASE_KEY}:events`;

const ANALYZE_REDIS_META_KEY =
  process.env.ANALYZE_REDIS_META_KEY ||
  `${ANALYZE_REDIS_BASE_KEY}:meta`;

const ANALYZE_FILE_PATH =
  process.env.ANALYZE_FILE_PATH ||
  "/tmp/analyze-events.json";

const MAX_STORED_EVENTS = readNumberEnv("ANALYZE_MAX_STORED_EVENTS", 50000);
const REDIS_RPUSH_BATCH_SIZE = readNumberEnv("ANALYZE_REDIS_RPUSH_BATCH_SIZE", 100);
const MEMORY_CACHE_TTL_MS = readNumberEnv("ANALYZE_MEMORY_CACHE_TTL_MS", 5000);

const STORE_UNMATCHED_EXITS =
  readBooleanEnv("ANALYZE_STORE_UNMATCHED_EXITS", false);

// Winrate-first ranking.
// Doel: 100 trades vs 10 trades eerlijk behandelen.
const ANALYZE_WINRATE_MIN_COMPLETED =
  readNumberEnv("ANALYZE_WINRATE_MIN_COMPLETED", 5);

const ANALYZE_WINRATE_TARGET_TRADES =
  readNumberEnv("ANALYZE_WINRATE_TARGET_TRADES", 100);

// 1.96 = conservative 95% Wilson lower bound.
// Lager zetten naar 1.64 als je sneller families wil toelaten.
const ANALYZE_WINRATE_WILSON_Z =
  Number(process.env.ANALYZE_WINRATE_WILSON_Z || 1.96);

const ANALYZE_WINRATE_PRIOR_ALPHA =
  readNumberEnv("ANALYZE_WINRATE_PRIOR_ALPHA", 8);

const ANALYZE_WINRATE_PRIOR_BETA =
  readNumberEnv("ANALYZE_WINRATE_PRIOR_BETA", 8);

const ANALYZE_WINRATE_MAX_FAMILIES_PER_TRADE =
  readNumberEnv("ANALYZE_WINRATE_MAX_FAMILIES_PER_TRADE", 5);

const globalStore = globalThis.__TRADESYSTEM_ANALYZE_STORE__ || {
  events: [],
  loadedAt: 0,
  lastPersistAt: 0,
};

globalThis.__TRADESYSTEM_ANALYZE_STORE__ = globalStore;

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

// ================= REDIS CONFIG =================

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
    throw new Error("Redis env missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || json?.error) {
    throw new Error(json?.error || `Redis error ${res.status}`);
  }

  return json?.result;
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

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function safeJsonParse(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;

  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function cleanObject(object) {
  return Object.fromEntries(
    Object.entries(safeObject(object)).filter(([, value]) => {
      return value !== undefined && value !== null && value !== "";
    })
  );
}

function normalizeTimestamp(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function incrementCounter(map, key) {
  const k = key || "UNKNOWN";
  map[k] = Number(map[k] || 0) + 1;
}

function trimToMax(events) {
  const rows = safeArray(events);
  if (rows.length <= MAX_STORED_EVENTS) return rows;
  return rows.slice(rows.length - MAX_STORED_EVENTS);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeAvg(values) {
  const arr = safeArray(values)
    .map(Number)
    .filter(Number.isFinite);

  if (!arr.length) return 0;

  return arr.reduce((sum, value) => sum + value, 0) / arr.length;
}

function safeSum(values) {
  return safeArray(values)
    .map(Number)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
}

// ================= FAMILY NORMALIZATION =================

function normalizeFamilyId(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  const id = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!id) return null;

  if (id === "UNKNOWN") return null;
  if (id === "MF_UNKNOWN") return null;
  if (id === "MICRO_UNKNOWN") return null;
  if (id === "LONG_UNKNOWN") return null;
  if (id === "SHORT_UNKNOWN") return null;

  if (id.startsWith("SUB_")) return null;
  if (id.startsWith("PARENT_")) return null;
  if (/^(LONG|SHORT)_\d+/.test(id)) return null;

  return id;
}

function normalizeFamilyIdArray(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .flatMap(normalizeFamilyIdArray)
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const direct = normalizeFamilyId(value);
    return direct ? [direct] : [];
  }

  if (typeof value !== "object") return [];

  return [
    value.microFamilyId,
    value.familyId,
    value.analyzeFamilyId,
    value.analysisFamilyId,
    value.id,
    value.key,
    ...(Array.isArray(value.microFamilyIds) ? value.microFamilyIds : []),
    ...(Array.isArray(value.familyIds) ? value.familyIds : []),
    ...(Array.isArray(value.families) ? value.families : []),
    ...(Array.isArray(value.microFamilies) ? value.microFamilies : []),
  ]
    .flatMap(normalizeFamilyIdArray)
    .filter(Boolean);
}

function uniqueFamilyIds(ids) {
  return Array.from(new Set(
    safeArray(ids)
      .map(normalizeFamilyId)
      .filter(Boolean)
  ));
}

function getEventFamilyIds(event, snapshot = {}) {
  const ids = [
    event?.microFamilyId,
    event?.familyId,
    event?.analyzeFamilyId,
    event?.analysisFamilyId,

    snapshot.microFamilyId,
    snapshot.familyId,
    snapshot.analyzeFamilyId,
    snapshot.analysisFamilyId,

    event?.filterSnapshot?.microFamilyId,
    event?.filterSnapshot?.familyId,
    event?.filterSnapshot?.analyzeFamilyId,
    event?.filterSnapshot?.analysisFamilyId,

    ...(Array.isArray(event?.microFamilyIds) ? event.microFamilyIds : []),
    ...(Array.isArray(event?.familyIds) ? event.familyIds : []),
    ...(Array.isArray(event?.families) ? event.families : []),
    ...(Array.isArray(event?.microFamilies) ? event.microFamilies : []),

    ...(Array.isArray(snapshot.microFamilyIds) ? snapshot.microFamilyIds : []),
    ...(Array.isArray(snapshot.familyIds) ? snapshot.familyIds : []),
    ...(Array.isArray(snapshot.families) ? snapshot.families : []),
    ...(Array.isArray(snapshot.microFamilies) ? snapshot.microFamilies : []),
  ];

  return uniqueFamilyIds(ids).slice(0, ANALYZE_WINRATE_MAX_FAMILIES_PER_TRADE);
}

// ================= EVENT NORMALIZATION =================

function getTradeId(event) {
  const id =
    event?.tradeId ||
    event?.positionTradeId ||
    event?.positionId ||
    event?.orderId ||
    event?.clientOrderId ||
    event?.id;

  return id ? String(id) : "";
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["bull", "long", "buy"].includes(s)) return "LONG";
  if (["bear", "short", "sell"].includes(s)) return "SHORT";

  return "";
}

function getLifecycleCandidates(event) {
  return [
    event?.analyzeLifecycle,
    event?.analyzeAction,
    event?.lifecycleAction,
    event?.tradeAction,
    event?.action,
    event?.status,
    event?.state,
    event?.type,
    event?.reason,
    event?.exitReason,
  ]
    .map(normalizeText)
    .filter(Boolean);
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

function hasExplicitExitAction(event) {
  return getLifecycleCandidates(event).some(isExitText);
}

function hasExplicitEntryAction(event) {
  return getLifecycleCandidates(event).some(isEntryText);
}

function hasExitFields(event) {
  return (
    event?.closed === true ||
    event?.isClosed === true ||
    event?.exitPrice !== undefined ||
    event?.exit !== undefined ||
    event?.closedAt ||
    event?.exitAt ||
    event?.exitTs ||
    event?.realizedR !== undefined ||
    event?.pnlR !== undefined ||
    event?.exitR !== undefined ||
    event?.resultR !== undefined ||
    event?.outcomeR !== undefined ||
    event?.pnlPct !== undefined
  );
}

function hasEntryFields(event) {
  return (
    event?.entry !== undefined ||
    event?.entryPrice !== undefined ||
    event?.openPrice !== undefined ||
    event?.sl !== undefined ||
    event?.tp !== undefined ||
    event?.rr !== undefined ||
    event?.baseRR !== undefined ||
    event?.familyId ||
    event?.microFamilyId ||
    event?.analyzeFamilyId ||
    event?.analysisFamilyId ||
    event?.filterSnapshot?.familyId ||
    event?.filterSnapshot?.microFamilyId ||
    event?.filterSnapshot?.analyzeFamilyId
  );
}

function getPrimaryLifecycleText(event) {
  return normalizeText(
    event?.analyzeLifecycle ||
      event?.analyzeAction ||
      event?.lifecycleAction ||
      event?.tradeAction ||
      event?.action
  );
}

function getLifecycleAction(event) {
  // Belangrijk:
  // - Gesloten ENTRY-records blijven ENTRY-records.
  // - Daarom wint expliciete action=ENTRY van exitReason=TP/SL.
  // - Alleen pure exit-events worden EXIT.

  const primary = getPrimaryLifecycleText(event);

  if (isEntryText(primary)) return "ENTRY";
  if (isExitText(primary)) return "EXIT";

  if (hasExplicitEntryAction(event)) return "ENTRY";
  if (hasExplicitExitAction(event)) return "EXIT";

  if (hasExitFields(event)) return "EXIT";
  if (hasEntryFields(event)) return "ENTRY";

  return "";
}

function compactFilterSnapshot(event) {
  const src = {
    ...safeObject(event?.filterSnapshot),
    ...safeObject(event?.filters),
    ...safeObject(event?.filterValues),
    ...safeObject(event?.analysisFilters),
  };

  const fields = [
    "familyId",
    "analyzeFamilyId",
    "analysisFamilyId",
    "microFamilyId",
    "microFamilyIds",
    "familyIds",
    "families",
    "microFamilies",

    "rotationId",
    "rotationSide",
    "tradeSide",
    "rotationGate",

    "side",
    "index",
    "qualityIndex",
    "marketIndex",
    "timingIndex",
    "qualityBucket",
    "marketBucket",
    "timingBucket",
    "definition",
    "source",
    "frozenAt",

    "setupClass",
    "grade",

    "stage",
    "scannerStage",
    "stageSource",
    "flow",

    "confluence",
    "sniperScore",
    "score",
    "moveScore",

    "rr",
    "baseRR",
    "finalRR",
    "finalRr",
    "plannedRR",
    "effectiveRR",

    "rsi",
    "rsiHTF",
    "rsiZone",
    "rsiEdge",
    "tfScore",
    "tfStrength",
    "tfAlignment",

    "obBias",
    "spreadPct",
    "spreadBps",
    "depthMinUsd1p",
    "depthUsd1p",

    "btcState",
    "regime",
    "fundingRate",
    "funding",

    "pullbackConfirmed",
    "sweepConfirmed",
    "retestConfirmed",
    "distanceFromLocalHighPct",
    "pullbackFromHighPct",

    "bullishMidTrendProbe",
    "btcBullishBearException",

    "strategyVersion",
  ];

  const out = {};

  for (const field of fields) {
    const value = src[field] ?? event?.[field];

    if (value !== undefined && value !== null && value !== "") {
      out[field] = value;
    }
  }

  return cleanObject(out);
}

function compactMarket(value) {
  const market = safeObject(value);

  return cleanObject({
    trend: market.trend,
    state: market.state,
    regime: market.regime,
    bias: market.bias,
    score: market.score,
  });
}

function compactBtc(value) {
  const btc = safeObject(value);

  return cleanObject({
    state: btc.state,
    chg24: btc.chg24,
    chg1h: btc.chg1h,
  });
}

function normalizeAnalyzeEvent(event, fallbackTs = Date.now()) {
  if (!event || typeof event !== "object") return null;

  const action = getLifecycleAction(event);
  if (!action) return null;

  const tradeId = getTradeId(event);
  if (!tradeId) return null;

  const symbol = String(event.symbol || "").toUpperCase().trim();
  const side = normalizeSide(event.side || event.direction || event.tradeSide);

  if (action === "ENTRY" && (!symbol || !side)) return null;

  const ts = normalizeTimestamp(
    event.analyzeTs ??
      event.ts ??
      event.updatedAt ??
      event.createdAt ??
      event.openedAt ??
      event.entryTs,
    fallbackTs
  );

  const entryTs = normalizeTimestamp(
    event.openedAt ??
      event.entryTs ??
      event.createdAt ??
      event.ts,
    ts
  );

  const isClosed = action === "EXIT"
    ? true
    : Boolean(event.closed || event.isClosed);

  const closedAt = isClosed
    ? normalizeTimestamp(
        event.closedAt ??
          event.exitAt ??
          event.exitTs ??
          event.updatedAt ??
          event.analyzeTs ??
          event.ts,
        ts
      )
    : null;

  const realizedR = nullableNumber(
    event.realizedR ??
      event.pnlR ??
      event.exitR ??
      event.resultR ??
      event.outcomeR ??
      event.rMultiple ??
      event.r
  );

  const pnlPct = nullableNumber(
    event.pnlPct ??
      event.pnlPercent ??
      event.realizedPnlPct ??
      event.resultPnlPct ??
      event.profitPct
  );

  const snapshot = compactFilterSnapshot(event);
  const familyIds = getEventFamilyIds(event, snapshot);
  const primaryFamilyId = familyIds[0] || null;

  return cleanObject({
    tradeId,
    symbol,
    side,

    action,
    analyzeLifecycle: action,
    analyzeSource: event.analyzeSource || "api_trade_funnel",
    analyzeTs: ts,
    ts,

    familyId: primaryFamilyId,
    analyzeFamilyId: primaryFamilyId,
    analysisFamilyId: primaryFamilyId,
    microFamilyId: normalizeFamilyId(event.microFamilyId) || primaryFamilyId,

    familyIds,
    microFamilyIds: uniqueFamilyIds([
      event.microFamilyId,
      ...(Array.isArray(event.microFamilyIds) ? event.microFamilyIds : []),
      ...familyIds,
    ]),
    families: familyIds,
    microFamilies: familyIds,

    rotationId: event.rotationId || snapshot.rotationId || null,
    rotationSide: event.rotationSide || snapshot.rotationSide || null,
    tradeSide: event.tradeSide || snapshot.tradeSide || null,
    rotationGate: event.rotationGate || snapshot.rotationGate || null,

    openedAt: action === "ENTRY" ? entryTs : event.openedAt,
    entryTs: action === "ENTRY" ? entryTs : event.entryTs,

    entry: nullableNumber(event.entry ?? event.entryPrice ?? event.openPrice),
    entryPrice: nullableNumber(event.entryPrice ?? event.entry ?? event.openPrice),
    openPrice: nullableNumber(event.openPrice ?? event.entryPrice ?? event.entry),

    sl: nullableNumber(event.sl ?? event.stopLoss),
    tp: nullableNumber(event.tp ?? event.takeProfit),

    rr: nullableNumber(event.rr ?? event.baseRR ?? event.finalRR ?? event.finalRr),
    baseRR: nullableNumber(event.baseRR ?? event.rr),
    finalRR: nullableNumber(event.finalRR ?? event.finalRr),
    plannedRR: nullableNumber(event.plannedRR),

    closed: isClosed,
    closedAt,

    exitPrice: isClosed
      ? nullableNumber(event.exitPrice ?? event.exit ?? event.executionPrice ?? event.price)
      : nullableNumber(event.exitPrice ?? event.exit),

    exit: isClosed
      ? nullableNumber(event.exit ?? event.exitPrice ?? event.executionPrice ?? event.price)
      : nullableNumber(event.exit),

    realizedR,
    pnlR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    rMultiple: realizedR,
    pnlPct,

    exitReason: event.exitReason || event.reason || null,

    setupClass: event.setupClass,
    grade: event.grade,

    confluence: nullableNumber(event.confluence),
    sniperScore: nullableNumber(event.sniperScore),
    moveScore: nullableNumber(event.moveScore ?? event.score ?? event.tradeScore),
    score: nullableNumber(event.score ?? event.moveScore ?? event.tradeScore),

    stage: event.stage,
    scannerStage: event.scannerStage,
    stageSource: event.stageSource,
    flow: event.flow,

    rsi: nullableNumber(event.rsi),
    rsiHTF: nullableNumber(event.rsiHTF),
    rsiZone: event.rsiZone,
    rsiEdge: event.rsiEdge,

    obBias: event.obBias,
    spreadPct: nullableNumber(event.spreadPct),
    spreadBps: nullableNumber(event.spreadBps),
    depthMinUsd1p: nullableNumber(event.depthMinUsd1p ?? event.depthUsd1p),

    btcState: event.btcState ?? event.btc?.state,
    fundingRate: nullableNumber(event.fundingRate),
    funding: event.funding,

    tfScore: nullableNumber(event.tfScore),
    tfStrength: nullableNumber(event.tfStrength),
    tfAlignment: event.tfAlignment,

    regime: event.regime,
    market: compactMarket(event.market),
    btc: compactBtc(event.btc),

    bullishMidTrendProbe: Boolean(event.bullishMidTrendProbe),
    btcBullishBearException: Boolean(event.btcBullishBearException),

    strategyVersion: event.strategyVersion,
    syntheticAnalyzeEntry: Boolean(event.syntheticAnalyzeEntry),

    filterSnapshot: cleanObject({
      ...snapshot,
      familyId: primaryFamilyId || snapshot.familyId,
      analyzeFamilyId: primaryFamilyId || snapshot.analyzeFamilyId,
      analysisFamilyId: primaryFamilyId || snapshot.analysisFamilyId,
      microFamilyId: normalizeFamilyId(event.microFamilyId) || primaryFamilyId || snapshot.microFamilyId,
      familyIds,
      microFamilyIds: familyIds,
    }),

    storedAt: event.storedAt,
    updatedAt: event.updatedAt,
  });
}

function isSameTradeEntry(a, b) {
  return (
    String(a?.tradeId || "") === String(b?.tradeId || "") &&
    getLifecycleAction(a) === "ENTRY" &&
    getLifecycleAction(b) === "ENTRY"
  );
}

function buildEventKey(event) {
  const tradeId = getTradeId(event);
  const action = getLifecycleAction(event);

  if (!tradeId || !action) return "";

  const ts =
    event.closedAt ||
    event.exitAt ||
    event.exitTs ||
    event.openedAt ||
    event.entryTs ||
    event.analyzeTs ||
    event.ts ||
    "";

  const r =
    event.realizedR ??
    event.pnlR ??
    event.resultR ??
    event.outcomeR ??
    "";

  return `${tradeId}:${action}:${ts}:${r}`;
}

function buildIndexes(records) {
  const entryByTradeId = new Map();
  const openByTradeId = new Map();
  const eventKeySet = new Set();

  for (const record of safeArray(records)) {
    const tradeId = getTradeId(record);
    if (!tradeId) continue;

    const action = getLifecycleAction(record);
    const key = buildEventKey(record);

    if (key) eventKeySet.add(key);

    if (action !== "ENTRY") continue;

    entryByTradeId.set(tradeId, record);

    if (record.closed !== true) {
      openByTradeId.set(tradeId, record);
    }
  }

  return {
    entryByTradeId,
    openByTradeId,
    eventKeySet,
  };
}

function mergeExitIntoEntry(entry, exit) {
  const closedAt = normalizeTimestamp(
    exit.closedAt ??
      exit.exitAt ??
      exit.exitTs ??
      exit.analyzeTs ??
      exit.ts,
    Date.now()
  );

  const realizedR = nullableNumber(
    exit.realizedR ??
      exit.pnlR ??
      exit.exitR ??
      exit.resultR ??
      exit.outcomeR ??
      exit.rMultiple
  );

  const pnlPct = nullableNumber(
    exit.pnlPct ??
      exit.pnlPercent ??
      exit.realizedPnlPct ??
      exit.resultPnlPct ??
      exit.profitPct
  );

  entry.action = "ENTRY";
  entry.analyzeLifecycle = "ENTRY";

  entry.closed = true;
  entry.closedAt = closedAt;

  entry.exitPrice = nullableNumber(
    exit.exitPrice ??
      exit.exit ??
      exit.executionPrice ??
      exit.price
  );

  entry.exit = nullableNumber(
    exit.exit ??
      exit.exitPrice ??
      exit.executionPrice ??
      exit.price
  );

  entry.realizedR = realizedR;
  entry.pnlR = realizedR;
  entry.resultR = realizedR;
  entry.outcomeR = realizedR;
  entry.rMultiple = realizedR;
  entry.pnlPct = pnlPct;

  entry.exitReason = exit.exitReason || exit.reason || entry.exitReason || null;
  entry.lastExitTs = exit.analyzeTs || exit.ts || closedAt;
  entry.updatedAt = Date.now();

  return entry;
}

// ================= LOAD SOURCES =================

async function loadFromRedis() {
  if (!hasRedis()) {
    return {
      ok: false,
      source: "redis",
      key: ANALYZE_REDIS_LIST_KEY,
      error: "redis_env_missing",
      events: [],
    };
  }

  try {
    const result = await redisCommand([
      "LRANGE",
      ANALYZE_REDIS_LIST_KEY,
      0,
      -1,
    ]);

    const rows = safeArray(result)
      .map(item => safeJsonParse(item, null))
      .filter(Boolean)
      .map(item => normalizeAnalyzeEvent(item, Date.now()))
      .filter(Boolean);

    if (rows.length > 0) {
      return {
        ok: true,
        source: "redis",
        key: ANALYZE_REDIS_LIST_KEY,
        error: null,
        events: rows,
      };
    }

    const legacy = await redisCommand([
      "GET",
      ANALYZE_REDIS_BASE_KEY,
    ]).catch(() => null);

    const parsed = safeJsonParse(legacy, null);
    const legacyRows = Array.isArray(parsed)
      ? parsed
      : safeArray(parsed?.events || parsed?.records || parsed?.data);

    const normalizedLegacy = legacyRows
      .map(item => normalizeAnalyzeEvent(item, Date.now()))
      .filter(Boolean);

    return {
      ok: true,
      source: "redis",
      key: ANALYZE_REDIS_LIST_KEY,
      legacyKey: ANALYZE_REDIS_BASE_KEY,
      error: null,
      events: normalizedLegacy,
    };
  } catch (e) {
    return {
      ok: false,
      source: "redis",
      key: ANALYZE_REDIS_LIST_KEY,
      error: e?.message || "redis_load_failed",
      events: [],
    };
  }
}

async function loadFromFile() {
  try {
    const raw = await fs.readFile(ANALYZE_FILE_PATH, "utf8");
    const parsed = safeJsonParse(raw, []);

    const rows = Array.isArray(parsed)
      ? parsed
      : safeArray(parsed?.events || parsed?.records || parsed?.data);

    const normalized = rows
      .map(item => normalizeAnalyzeEvent(item, Date.now()))
      .filter(Boolean);

    return {
      ok: true,
      source: "file",
      path: ANALYZE_FILE_PATH,
      error: null,
      events: normalized,
    };
  } catch (e) {
    return {
      ok: false,
      source: "file",
      path: ANALYZE_FILE_PATH,
      error: e?.message || "file_load_failed",
      events: [],
    };
  }
}

export async function loadAnalyzeEvents(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();

  if (
    !force &&
    globalStore.events.length > 0 &&
    now - Number(globalStore.loadedAt || 0) < MEMORY_CACHE_TTL_MS
  ) {
    return globalStore.events;
  }

  const redis = await loadFromRedis();

  if (redis.ok && redis.events.length > 0) {
    globalStore.events = trimToMax(redis.events);
    globalStore.loadedAt = now;
    return globalStore.events;
  }

  const file = await loadFromFile();

  if (file.ok && file.events.length > 0) {
    globalStore.events = trimToMax(file.events);
    globalStore.loadedAt = now;
    return globalStore.events;
  }

  globalStore.loadedAt = now;
  return globalStore.events || [];
}

export async function readAnalyzeEvents(options = {}) {
  return await loadAnalyzeEvents(options);
}

export async function getAnalyzeEvents(options = {}) {
  return await loadAnalyzeEvents(options);
}

// ================= PERSIST =================

async function persistToRedis(events) {
  if (!hasRedis()) {
    return {
      ok: false,
      source: "redis",
      key: ANALYZE_REDIS_LIST_KEY,
      error: "redis_env_missing",
    };
  }

  try {
    const rows = trimToMax(events).map(event => JSON.stringify(event));

    await redisCommand([
      "DEL",
      ANALYZE_REDIS_LIST_KEY,
    ]);

    for (let i = 0; i < rows.length; i += REDIS_RPUSH_BATCH_SIZE) {
      const batch = rows.slice(i, i + REDIS_RPUSH_BATCH_SIZE);
      if (!batch.length) continue;

      await redisCommand([
        "RPUSH",
        ANALYZE_REDIS_LIST_KEY,
        ...batch,
      ]);
    }

    await redisCommand([
      "LTRIM",
      ANALYZE_REDIS_LIST_KEY,
      -MAX_STORED_EVENTS,
      -1,
    ]);

    await redisCommand([
      "SET",
      ANALYZE_REDIS_META_KEY,
      JSON.stringify({
        key: ANALYZE_REDIS_LIST_KEY,
        count: rows.length,
        maxStoredEvents: MAX_STORED_EVENTS,
        persistedAt: Date.now(),
        mode: "redis_list",
        rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
        winrateConfig: {
          minCompleted: ANALYZE_WINRATE_MIN_COMPLETED,
          targetTrades: ANALYZE_WINRATE_TARGET_TRADES,
          wilsonZ: ANALYZE_WINRATE_WILSON_Z,
          priorAlpha: ANALYZE_WINRATE_PRIOR_ALPHA,
          priorBeta: ANALYZE_WINRATE_PRIOR_BETA,
        },
      }),
    ]);

    return {
      ok: true,
      source: "redis",
      key: ANALYZE_REDIS_LIST_KEY,
      error: null,
      count: rows.length,
      mode: "redis_list",
    };
  } catch (e) {
    return {
      ok: false,
      source: "redis",
      key: ANALYZE_REDIS_LIST_KEY,
      error: e?.message || "redis_persist_failed",
    };
  }
}

async function persistToFile(events) {
  try {
    await fs.mkdir(path.dirname(ANALYZE_FILE_PATH), {
      recursive: true,
    });

    await fs.writeFile(
      ANALYZE_FILE_PATH,
      JSON.stringify(trimToMax(events)),
      "utf8"
    );

    return {
      ok: true,
      source: "file",
      path: ANALYZE_FILE_PATH,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      source: "file",
      path: ANALYZE_FILE_PATH,
      error: e?.message || "file_persist_failed",
    };
  }
}

async function persistEvents(events) {
  const trimmed = trimToMax(events);

  globalStore.events = trimmed;
  globalStore.lastPersistAt = Date.now();

  const [redis, file] = await Promise.all([
    persistToRedis(trimmed),
    persistToFile(trimmed),
  ]);

  return {
    redis,
    file,
    memory: {
      ok: true,
      source: "memory",
      error: null,
      count: trimmed.length,
    },
  };
}

// ================= WINRATE-FIRST STATS =================

function wilsonLowerBound(wins, total, z = ANALYZE_WINRATE_WILSON_Z) {
  const n = Number(total || 0);
  const w = Number(wins || 0);

  if (!n) return 0;

  const p = w / n;
  const z2 = z * z;

  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function getOutcomeSide(row) {
  const r = nullableNumber(
    row.realizedR ??
      row.pnlR ??
      row.resultR ??
      row.outcomeR ??
      row.rMultiple
  );

  if (Number.isFinite(r)) {
    if (r > 0) return "WIN";
    if (r < 0) return "LOSS";
    return "FLAT";
  }

  const pnlPct = nullableNumber(row.pnlPct);

  if (Number.isFinite(pnlPct)) {
    if (pnlPct > 0) return "WIN";
    if (pnlPct < 0) return "LOSS";
    return "FLAT";
  }

  return "UNKNOWN";
}

function createWinrateFamilyStats(familyId, side = "UNKNOWN") {
  return {
    familyId,
    side,

    trades: 0,
    closed: 0,
    completed: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    rawWinrate: 0,
    rawWinratePct: "0.0%",

    adjustedWinrate: 0,
    adjustedWinratePct: "0.0%",

    wilsonLowerBound: 0,
    wilsonLowerBoundPct: "0.0%",

    sampleConfidence: 0,
    sampleConfidencePct: "0.0%",

    fairWinrateScore: 0,
    eligible: false,

    totalR: 0,
    avgR: 0,
    avgWinR: 0,
    avgLossR: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    setupClasses: {},
    entryReasons: {},
    rsiZones: {},
    obBiases: {},
    btcStates: {},

    examples: [],
  };
}

function deriveWinrateFamilyStats(stats) {
  const completed = Number(stats.completed || 0);
  const wins = Number(stats.wins || 0);

  const rawWinrate = completed ? wins / completed : 0;

  const adjustedWinrate =
    (wins + ANALYZE_WINRATE_PRIOR_ALPHA) /
    (completed + ANALYZE_WINRATE_PRIOR_ALPHA + ANALYZE_WINRATE_PRIOR_BETA);

  const lower = wilsonLowerBound(wins, completed, ANALYZE_WINRATE_WILSON_Z);
  const sampleConfidence = clamp(completed / ANALYZE_WINRATE_TARGET_TRADES, 0, 1);

  // Hoofdscore = fair winrate.
  // Geen PnL-primary bias.
  // Wilson zwaarste component, Bayesian tweede component, raw winrate alleen tie-light.
  const fairWinrateScore =
    lower * 72 +
    adjustedWinrate * 20 +
    rawWinrate * 8;

  const rValues = safeArray(stats._rValues);
  const pnlValues = safeArray(stats._pnlValues);

  const winRValues = rValues.filter(v => Number(v) > 0);
  const lossRValues = rValues.filter(v => Number(v) < 0);

  stats.rawWinrate = Number(rawWinrate.toFixed(4));
  stats.rawWinratePct = `${(rawWinrate * 100).toFixed(1)}%`;

  stats.adjustedWinrate = Number(adjustedWinrate.toFixed(4));
  stats.adjustedWinratePct = `${(adjustedWinrate * 100).toFixed(1)}%`;

  stats.wilsonLowerBound = Number(lower.toFixed(4));
  stats.wilsonLowerBoundPct = `${(lower * 100).toFixed(1)}%`;

  stats.sampleConfidence = Number(sampleConfidence.toFixed(4));
  stats.sampleConfidencePct = `${(sampleConfidence * 100).toFixed(1)}%`;

  stats.fairWinrateScore = Number(fairWinrateScore.toFixed(4));
  stats.eligible = completed >= ANALYZE_WINRATE_MIN_COMPLETED;

  stats.totalR = Number(safeSum(rValues).toFixed(4));
  stats.avgR = Number(safeAvg(rValues).toFixed(4));
  stats.avgWinR = Number(safeAvg(winRValues).toFixed(4));
  stats.avgLossR = Number(safeAvg(lossRValues).toFixed(4));

  stats.totalPnlPct = Number(safeSum(pnlValues).toFixed(4));
  stats.avgPnlPct = Number(safeAvg(pnlValues).toFixed(4));

  delete stats._rValues;
  delete stats._pnlValues;

  return stats;
}

function buildAnalyzeWinrateStatsFromEvents(events, options = {}) {
  const rows = safeArray(events)
    .map(row => normalizeAnalyzeEvent(row, Date.now()))
    .filter(Boolean);

  const closedEntries = rows.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed === true;
  });

  const byFamily = new Map();

  for (const row of closedEntries) {
    const familyIds = getEventFamilyIds(row, row.filterSnapshot);

    if (!familyIds.length) continue;

    const outcome = getOutcomeSide(row);
    const isCompleted = outcome === "WIN" || outcome === "LOSS";
    const r = nullableNumber(row.realizedR ?? row.pnlR ?? row.resultR ?? row.outcomeR);
    const pnlPct = nullableNumber(row.pnlPct);

    for (const familyId of familyIds.slice(0, ANALYZE_WINRATE_MAX_FAMILIES_PER_TRADE)) {
      if (!byFamily.has(familyId)) {
        byFamily.set(familyId, createWinrateFamilyStats(familyId, row.side || "UNKNOWN"));
      }

      const stats = byFamily.get(familyId);

      stats.trades++;
      stats.closed++;

      if (isCompleted) stats.completed++;
      if (outcome === "WIN") stats.wins++;
      else if (outcome === "LOSS") stats.losses++;
      else if (outcome === "FLAT") stats.flats++;

      if (Number.isFinite(r)) {
        stats._rValues = stats._rValues || [];
        stats._rValues.push(r);
      }

      if (Number.isFinite(pnlPct)) {
        stats._pnlValues = stats._pnlValues || [];
        stats._pnlValues.push(pnlPct);
      }

      incrementCounter(stats.setupClasses, normalizeText(row.setupClass || "UNKNOWN"));
      incrementCounter(stats.entryReasons, normalizeText(row.exitReason || row.reason || "UNKNOWN"));
      incrementCounter(stats.rsiZones, normalizeText(row.rsiZone || "UNKNOWN"));
      incrementCounter(stats.obBiases, normalizeText(row.obBias || "UNKNOWN"));
      incrementCounter(stats.btcStates, normalizeText(row.btcState || "UNKNOWN"));

      if (stats.examples.length < 12) {
        stats.examples.push([
          row.symbol || "NA",
          row.side || "NA",
          row.setupClass || "NA",
          outcome,
          Number.isFinite(r) ? `R=${r.toFixed(2)}` : "R=NA",
        ].join("_"));
      }
    }
  }

  const minCompleted = Number(options.minCompleted || ANALYZE_WINRATE_MIN_COMPLETED);

  const families = Array.from(byFamily.values())
    .map(deriveWinrateFamilyStats)
    .map(stats => ({
      ...stats,
      eligible: Number(stats.completed || 0) >= minCompleted,
    }))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;

      const fairDiff = Number(b.fairWinrateScore || 0) - Number(a.fairWinrateScore || 0);
      if (fairDiff !== 0) return fairDiff;

      const lowerDiff = Number(b.wilsonLowerBound || 0) - Number(a.wilsonLowerBound || 0);
      if (lowerDiff !== 0) return lowerDiff;

      const rawDiff = Number(b.rawWinrate || 0) - Number(a.rawWinrate || 0);
      if (rawDiff !== 0) return rawDiff;

      return Number(b.completed || 0) - Number(a.completed || 0);
    });

  const eligibleFamilies = families.filter(row => row.eligible);

  return {
    ok: true,
    metric: "FAIR_WINRATE_WILSON_BAYES",
    primarySort: "fairWinrateScore",
    note: "PnL/R is stored as secondary context only; ranking is winrate-first with sample-size correction.",

    config: {
      minCompleted,
      targetTrades: ANALYZE_WINRATE_TARGET_TRADES,
      wilsonZ: ANALYZE_WINRATE_WILSON_Z,
      priorAlpha: ANALYZE_WINRATE_PRIOR_ALPHA,
      priorBeta: ANALYZE_WINRATE_PRIOR_BETA,
      maxFamiliesPerTrade: ANALYZE_WINRATE_MAX_FAMILIES_PER_TRADE,
    },

    sample: {
      totalRecords: rows.length,
      closedEntries: closedEntries.length,
      familyCount: families.length,
      eligibleFamilyCount: eligibleFamilies.length,
    },

    bestFamily: eligibleFamilies[0] || null,
    families,
  };
}

export async function getAnalyzeWinrateStats(options = {}) {
  const events = await loadAnalyzeEvents({
    force: Boolean(options.force),
  });

  return buildAnalyzeWinrateStatsFromEvents(events, options);
}

// ================= APPEND =================

export async function appendAnalyzeEvents(events, context = {}) {
  const received = safeArray(events);
  const now = Date.now();

  const existing = await loadAnalyzeEvents({
    force: true,
  });

  const records = safeArray(existing)
    .map(item => normalizeAnalyzeEvent(item, now))
    .filter(Boolean);

  const indexes = buildIndexes(records);

  const ignoredReasons = {};
  let addedEntries = 0;
  let matchedExits = 0;
  let unmatchedExits = 0;
  let newUnmatchedExits = 0;
  let ignored = 0;

  for (const rawEvent of received) {
    const event = normalizeAnalyzeEvent(
      {
        ...rawEvent,
        analyzeSource: rawEvent?.analyzeSource || context?.source || "api_trade_funnel",
        btc: rawEvent?.btc ?? context?.btc,
        regime: rawEvent?.regime ?? context?.regime,
        market: rawEvent?.market ?? context?.market,
        tradeFunnelUpdatedAt:
          rawEvent?.tradeFunnelUpdatedAt ??
          context?.tradeFunnelUpdatedAt,
        latestUpdatedAt:
          rawEvent?.latestUpdatedAt ??
          context?.latestUpdatedAt,
      },
      now
    );

    if (!event) {
      ignored++;
      incrementCounter(ignoredReasons, "NORMALIZE_FAILED");
      continue;
    }

    const action = getLifecycleAction(event);
    const tradeId = getTradeId(event);

    if (!tradeId || !action) {
      ignored++;
      incrementCounter(ignoredReasons, "BAD_EVENT");
      continue;
    }

    const eventKey = buildEventKey(event);

    if (eventKey && indexes.eventKeySet.has(eventKey)) {
      ignored++;
      incrementCounter(ignoredReasons, "DUPLICATE_EVENT");
      continue;
    }

    if (action === "ENTRY") {
      const existingEntry = indexes.entryByTradeId.get(tradeId);

      if (existingEntry && isSameTradeEntry(existingEntry, event)) {
        ignored++;
        incrementCounter(ignoredReasons, "DUPLICATE_ENTRY");
        continue;
      }

      const storedEntry = {
        ...event,
        action: "ENTRY",
        analyzeLifecycle: "ENTRY",
        closed: false,
        closedAt: null,
        exitPrice: null,
        exit: null,
        realizedR: null,
        pnlR: null,
        resultR: null,
        outcomeR: null,
        rMultiple: null,
        pnlPct: null,
        storedAt: now,
        updatedAt: now,
      };

      records.push(storedEntry);

      indexes.entryByTradeId.set(tradeId, storedEntry);
      indexes.openByTradeId.set(tradeId, storedEntry);

      if (eventKey) indexes.eventKeySet.add(eventKey);

      addedEntries++;
      continue;
    }

    if (action === "EXIT") {
      const openEntry = indexes.openByTradeId.get(tradeId);

      if (openEntry) {
        mergeExitIntoEntry(openEntry, event);
        indexes.openByTradeId.delete(tradeId);

        if (eventKey) indexes.eventKeySet.add(eventKey);

        matchedExits++;
        continue;
      }

      unmatchedExits++;

      if (!STORE_UNMATCHED_EXITS) {
        ignored++;
        incrementCounter(ignoredReasons, "UNMATCHED_EXIT");
        continue;
      }

      const orphanExit = {
        ...event,
        action: "EXIT",
        analyzeLifecycle: "EXIT",
        orphanExit: true,
        storedAt: now,
        updatedAt: now,
      };

      records.push(orphanExit);

      if (eventKey) indexes.eventKeySet.add(eventKey);

      newUnmatchedExits++;
      continue;
    }

    ignored++;
    incrementCounter(ignoredReasons, "UNKNOWN_ACTION");
  }

  const finalRecords = trimToMax(records);
  const persist = await persistEvents(finalRecords);

  const added = addedEntries + matchedExits + newUnmatchedExits;

  const closed = finalRecords.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed === true;
  }).length;

  const open = finalRecords.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed !== true;
  }).length;

  const winrateStats = buildAnalyzeWinrateStatsFromEvents(finalRecords, {
    minCompleted: ANALYZE_WINRATE_MIN_COMPLETED,
  });

  return {
    ok: true,
    path: ANALYZE_FILE_PATH,
    redisKey: ANALYZE_REDIS_LIST_KEY,

    added,
    accepted: added,
    ignored,
    ignoredReasons,

    entries: addedEntries,
    exits: matchedExits + newUnmatchedExits,
    matchedExits,
    unmatchedExits,
    newUnmatchedExits,

    count: finalRecords.length,
    totalRecords: finalRecords.length,
    open,
    closed,

    rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
    bestWinrateFamily: winrateStats.bestFamily,
    eligibleWinrateFamilies: winrateStats.sample.eligibleFamilyCount,

    maxStoredEvents: MAX_STORED_EVENTS,
    persist,
  };
}

// ================= CLEAR =================

export async function clearAnalyzeEvents() {
  globalStore.events = [];
  globalStore.loadedAt = 0;
  globalStore.lastPersistAt = 0;

  const result = {
    ok: true,
    redis: null,
    file: null,
    memory: {
      ok: true,
      source: "memory",
    },
  };

  if (hasRedis()) {
    try {
      await redisCommand([
        "DEL",
        ANALYZE_REDIS_LIST_KEY,
      ]);

      await redisCommand([
        "DEL",
        ANALYZE_REDIS_META_KEY,
      ]);

      await redisCommand([
        "DEL",
        ANALYZE_REDIS_BASE_KEY,
      ]).catch(() => null);

      result.redis = {
        ok: true,
        source: "redis",
        key: ANALYZE_REDIS_LIST_KEY,
      };
    } catch (e) {
      result.redis = {
        ok: false,
        source: "redis",
        key: ANALYZE_REDIS_LIST_KEY,
        error: e?.message || "redis_clear_failed",
      };
    }
  }

  try {
    await fs.unlink(ANALYZE_FILE_PATH);

    result.file = {
      ok: true,
      source: "file",
      path: ANALYZE_FILE_PATH,
    };
  } catch (e) {
    result.file = {
      ok: false,
      source: "file",
      path: ANALYZE_FILE_PATH,
      error: e?.message || "file_clear_failed",
    };
  }

  return result;
}

export async function getAnalyzeStoreStatus() {
  const events = await loadAnalyzeEvents();

  const open = events.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed !== true;
  }).length;

  const closed = events.filter(row => {
    return getLifecycleAction(row) === "ENTRY" && row.closed === true;
  }).length;

  const winrateStats = buildAnalyzeWinrateStatsFromEvents(events, {
    minCompleted: ANALYZE_WINRATE_MIN_COMPLETED,
  });

  return {
    ok: true,
    redisKey: ANALYZE_REDIS_LIST_KEY,
    legacyRedisKey: ANALYZE_REDIS_BASE_KEY,
    path: ANALYZE_FILE_PATH,

    count: events.length,
    open,
    closed,

    rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
    bestWinrateFamily: winrateStats.bestFamily,
    familyCount: winrateStats.sample.familyCount,
    eligibleFamilyCount: winrateStats.sample.eligibleFamilyCount,

    winrateConfig: winrateStats.config,

    maxStoredEvents: MAX_STORED_EVENTS,
    loadedAt: globalStore.loadedAt,
    lastPersistAt: globalStore.lastPersistAt,
  };
}

export default {
  appendAnalyzeEvents,
  loadAnalyzeEvents,
  readAnalyzeEvents,
  getAnalyzeEvents,
  getAnalyzeWinrateStats,
  clearAnalyzeEvents,
  getAnalyzeStoreStatus,
};