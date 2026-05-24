// ================= ANALYZE STORE =================
// Fixes:
// - Geen mega JSON SET meer naar Upstash.
// - Redis gebruikt LIST + RPUSH batches + LTRIM.
// - Entries worden als open records opgeslagen.
// - Exits worden op bestaande open entries gematched via tradeId.
// - Unmatched exits worden standaard genegeerd om rommel te voorkomen.
// - File + memory fallback blijven bestaan.
// - FIX: ENTRY lifecycle heeft prioriteit boven EXIT-field-detectie.
// - FIX: null/undefined exit fields tellen niet meer als EXIT.
// - FIX: openByTradeId wijst naar het opgeslagen record, niet naar een losse kopie.

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

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function hasPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function hasFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n);
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

function isEntryText(value) {
  const v = normalizeText(value);

  return (
    v === "ENTRY" ||
    v === "OPEN" ||
    v === "OPENED" ||
    v === "ENTER" ||
    v === "FILLED" ||
    v === "PLACE_ORDER" ||
    v === "OPEN_LONG" ||
    v === "OPEN_SHORT" ||
    v === "LONG_ENTRY" ||
    v === "SHORT_ENTRY" ||
    v.includes("ENTRY") ||
    v.includes("OPEN_POSITION")
  );
}

function isExitText(value) {
  const v = normalizeText(value);

  return (
    v === "EXIT" ||
    v === "CLOSE" ||
    v === "CLOSED" ||
    v === "TP" ||
    v === "SL" ||
    v === "STOP" ||
    v === "STOP_LOSS" ||
    v === "TAKE_PROFIT" ||
    v.includes("EXIT") ||
    v.includes("CLOSE") ||
    v.includes("TAKE_PROFIT") ||
    v.includes("STOP_LOSS")
  );
}

function isIgnoreText(value) {
  const v = normalizeText(value);

  return (
    v === "WAIT" ||
    v === "HOLD" ||
    v === "RUNNING" ||
    v === "NO_TRADE" ||
    v === "SKIP" ||
    v === "IGNORE" ||
    v === "REJECT" ||
    v.includes("WAIT") ||
    v.includes("HOLD") ||
    v.includes("RUNNING") ||
    v.includes("REJECT")
  );
}

function hasMeaningfulEntryFields(event) {
  return (
    hasPositiveNumber(event?.entry) ||
    hasPositiveNumber(event?.entryPrice) ||
    hasPositiveNumber(event?.openPrice) ||
    hasPositiveNumber(event?.sl) ||
    hasPositiveNumber(event?.stopLoss) ||
    hasPositiveNumber(event?.tp) ||
    hasPositiveNumber(event?.takeProfit) ||
    hasFiniteNumber(event?.rr) ||
    hasFiniteNumber(event?.baseRR) ||
    hasFiniteNumber(event?.finalRR) ||
    hasFiniteNumber(event?.finalRr)
  );
}

function hasMeaningfulExitFields(event) {
  return (
    event?.closed === true ||
    event?.isClosed === true ||
    hasValue(event?.closedAt) ||
    hasValue(event?.exitAt) ||
    hasValue(event?.exitTs) ||
    hasPositiveNumber(event?.exitPrice) ||
    hasPositiveNumber(event?.exit) ||
    hasPositiveNumber(event?.executionPrice) ||
    hasFiniteNumber(event?.realizedR) ||
    hasFiniteNumber(event?.pnlR) ||
    hasFiniteNumber(event?.exitR) ||
    hasFiniteNumber(event?.resultR) ||
    hasFiniteNumber(event?.outcomeR) ||
    hasFiniteNumber(event?.pnlPct)
  );
}

function getLifecycleAction(event) {
  const primaryCandidates = [
    event?.analyzeLifecycle,
    event?.analyzeAction,
    event?.lifecycleAction,
    event?.tradeAction,
    event?.action,
    event?.status,
    event?.state,
    event?.type,
  ]
    .map(normalizeText)
    .filter(Boolean);

  // CRITICAL:
  // ENTRY eerst. Synthetic entries kunnen exitPrice:null/pnlR:null bevatten.
  // Die mogen nooit als EXIT worden gelezen.
  for (const value of primaryCandidates) {
    if (isEntryText(value)) return "ENTRY";
  }

  for (const value of primaryCandidates) {
    if (isExitText(value)) return "EXIT";
  }

  for (const value of primaryCandidates) {
    if (isIgnoreText(value)) return "";
  }

  const reasonCandidates = [
    event?.reason,
    event?.exitReason,
  ]
    .map(normalizeText)
    .filter(Boolean);

  for (const value of reasonCandidates) {
    if (isExitText(value)) return "EXIT";
  }

  // Entry fields vóór exit fields.
  // Dit beschermt analyze synthetic entries met closed:false en null exit velden.
  if (hasMeaningfulEntryFields(event)) return "ENTRY";
  if (hasMeaningfulExitFields(event)) return "EXIT";

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

  const closedAt = action === "EXIT"
    ? normalizeTimestamp(
        event.closedAt ??
          event.exitAt ??
          event.exitTs ??
          event.updatedAt ??
          event.ts,
        ts
      )
    : null;

  const realizedR = action === "EXIT"
    ? nullableNumber(
        event.realizedR ??
          event.pnlR ??
          event.exitR ??
          event.resultR ??
          event.outcomeR ??
          event.rMultiple ??
          event.r
      )
    : null;

  const pnlPct = action === "EXIT"
    ? nullableNumber(
        event.pnlPct ??
          event.pnlPercent ??
          event.realizedPnlPct ??
          event.resultPnlPct ??
          event.profitPct
      )
    : null;

  const snapshot = compactFilterSnapshot(event);

  const familyId =
    event.familyId ||
    event.analyzeFamilyId ||
    event.analysisFamilyId ||
    snapshot.familyId ||
    snapshot.analyzeFamilyId ||
    null;

  return cleanObject({
    tradeId,
    symbol,
    side,

    action,
    analyzeLifecycle: action,
    analyzeSource: event.analyzeSource || "api_trade_funnel",
    analyzeTs: ts,
    ts,

    familyId: familyId ? String(familyId).toUpperCase() : null,
    analyzeFamilyId: familyId ? String(familyId).toUpperCase() : null,
    analysisFamilyId: familyId ? String(familyId).toUpperCase() : null,

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

    // CRITICAL:
    // ENTRY blijft altijd open bij opslag.
    // Exit velden worden alleen op EXIT-events gevuld.
    closed: action === "EXIT" ? true : false,
    closedAt,

    exitPrice: action === "EXIT"
      ? nullableNumber(event.exitPrice ?? event.exit ?? event.executionPrice ?? event.price)
      : null,

    exit: action === "EXIT"
      ? nullableNumber(event.exit ?? event.exitPrice ?? event.executionPrice ?? event.price)
      : null,

    realizedR,
    pnlR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    rMultiple: realizedR,
    pnlPct,

    exitReason: action === "EXIT"
      ? event.exitReason || event.reason || null
      : null,

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

    strategyVersion: event.strategyVersion,
    syntheticAnalyzeEntry: Boolean(event.syntheticAnalyzeEntry),

    filterSnapshot: cleanObject({
      ...snapshot,
      familyId: familyId ? String(familyId).toUpperCase() : snapshot.familyId,
      analyzeFamilyId: familyId ? String(familyId).toUpperCase() : snapshot.analyzeFamilyId,
    }),
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

    if (action === "ENTRY") {
      entryByTradeId.set(tradeId, record);

      if (record.closed !== true) {
        openByTradeId.set(tradeId, record);
      }
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

  entry.closed = true;
  entry.closedAt = closedAt;
  entry.exitPrice = nullableNumber(exit.exitPrice ?? exit.exit ?? exit.executionPrice ?? exit.price);
  entry.exit = nullableNumber(exit.exit ?? exit.exitPrice ?? exit.executionPrice ?? exit.price);

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

    // Legacy fallback: oude mega SET lezen als die nog bestaat.
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
      };

      const cleanStoredEntry = cleanObject(storedEntry);

      records.push(cleanStoredEntry);

      indexes.entryByTradeId.set(tradeId, cleanStoredEntry);
      indexes.openByTradeId.set(tradeId, cleanStoredEntry);

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

      const orphanExit = cleanObject({
        ...event,
        action: "EXIT",
        analyzeLifecycle: "EXIT",
        closed: true,
        orphanExit: true,
        storedAt: now,
      });

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
  const closed = finalRecords.filter(row => row.action === "ENTRY" && row.closed === true).length;
  const open = finalRecords.filter(row => row.action === "ENTRY" && row.closed !== true).length;

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

      // Legacy key ook wissen.
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

  return {
    ok: true,
    redisKey: ANALYZE_REDIS_LIST_KEY,
    legacyRedisKey: ANALYZE_REDIS_BASE_KEY,
    path: ANALYZE_FILE_PATH,
    count: events.length,
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
  clearAnalyzeEvents,
  getAnalyzeStoreStatus,
};