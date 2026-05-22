import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ANALYZE_PATH =
  process.env.ANALYZE_EVENTS_PATH || "/tmp/analyze-events.json";

const MAX_STORED_EVENTS = Number(process.env.ANALYZE_MAX_STORED_EVENTS || 50000);

const REDIS_KEY =
  process.env.ANALYZE_REDIS_KEY || "tradesystem:analyze:store:v3";

const REDIS_REST_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  "";

const REDIS_REST_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  "";

const MEMORY_KEY = "__TRADESYSTEM_ANALYZE_STORE_V3__";
const STORE_VERSION = 3;

const IGNORE_ACTIONS = new Set([
  "WAIT",
  "HOLD",
  "RUNNING",
  "SKIP",
  "NO_TRADE",
  "NO_ACTION",
  "REJECT",
  "REJECTED",
  "IGNORE",
  "IGNORED",
  "NONE",
]);

const ENTRY_ACTIONS = new Set([
  "ENTRY",
  "OPEN",
  "OPEN_LONG",
  "OPEN_SHORT",
  "BUY",
  "SELL",
  "LONG",
  "SHORT",
]);

const EXIT_ACTIONS = new Set([
  "EXIT",
  "CLOSE",
  "CLOSED",
  "CLOSE_LONG",
  "CLOSE_SHORT",
  "TP",
  "TAKE_PROFIT",
  "TAKE_PROFIT_HIT",
  "SL",
  "STOP",
  "STOP_LOSS",
  "STOP_LOSS_HIT",
  "BE",
  "BE_SL",
  "BREAK_EVEN",
  "MANUAL_CLOSE",
  "EARLY_FAILURE_EXIT",
  "EARLY_OB_FLIP_EXIT",
]);

// ================= GENERIC HELPERS =================

function nowMs() {
  return Date.now();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTimestamp(value, fallback = nowMs()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function normalizeSymbol(value) {
  return safeString(value).toUpperCase().trim();
}

function normalizeSide(value) {
  const s = safeString(value).toLowerCase().trim();

  if (["long", "bull", "buy"].includes(s)) return "LONG";
  if (["short", "bear", "sell"].includes(s)) return "SHORT";

  return "";
}

function normalizeAction(value) {
  return safeString(value).toUpperCase().trim();
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function safeJsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }

  return undefined;
}

function cleanObject(object) {
  return Object.fromEntries(
    Object.entries(safeObject(object)).filter(([, value]) => {
      return value !== undefined && value !== null && value !== "";
    })
  );
}

function stableTradeId(value) {
  const id = safeString(value).trim();
  return id ? id : "";
}

function extractTradeId(event) {
  return stableTradeId(
    event?.tradeId ??
      event?.positionTradeId ??
      event?.positionId ??
      event?.orderId ??
      event?.clientOrderId ??
      event?.id ??
      event?.analyzeEventKey
  );
}

function extractFamilyId(event) {
  const direct =
    event?.familyId ??
    event?.analyzeFamilyId ??
    event?.analysisFamilyId ??
    event?.family?.id ??
    event?.family ??
    event?.filterSnapshot?.familyId ??
    event?.filterSnapshot?.analyzeFamilyId ??
    event?.filterSnapshot?.analysisFamilyId ??
    event?.entryEvent?.familyId ??
    event?.entryEvent?.analyzeFamilyId ??
    event?.entryEvent?.filterSnapshot?.familyId;

  const value = safeString(direct).toUpperCase().trim();
  return value || "";
}

function normalizeClosedFlag(value) {
  if (value === true) return true;

  const s = safeString(value).toUpperCase().trim();
  return ["TRUE", "1", "YES", "Y", "CLOSED", "EXIT"].includes(s);
}

function countStoreRecords(store) {
  return safeArray(store?.trades).length + safeArray(store?.unmatchedExits).length;
}

function trimRecords(records) {
  const clean = safeArray(records)
    .filter(record => record && typeof record === "object")
    .sort((a, b) => {
      const at = normalizeTimestamp(
        a.analyzeUpdatedAt ??
          a.updatedAt ??
          a.closedAt ??
          a.openedAt ??
          a.analyzeTs ??
          a.ts,
        0
      );

      const bt = normalizeTimestamp(
        b.analyzeUpdatedAt ??
          b.updatedAt ??
          b.closedAt ??
          b.openedAt ??
          b.analyzeTs ??
          b.ts,
        0
      );

      return at - bt;
    });

  if (clean.length <= MAX_STORED_EVENTS) return clean;

  return clean.slice(clean.length - MAX_STORED_EVENTS);
}

function createEmptyStore(source = "empty") {
  return {
    ok: true,
    version: STORE_VERSION,
    source,
    updatedAt: nowMs(),
    maxStoredEvents: MAX_STORED_EVENTS,
    trades: [],
    unmatchedExits: [],
  };
}

// ================= REDIS HELPERS =================

function hasRedisConfig() {
  return Boolean(REDIS_REST_URL && REDIS_REST_TOKEN);
}

async function redisCommand(command) {
  if (!hasRedisConfig()) {
    throw new Error("redis_not_configured");
  }

  const res = await fetch(REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const text = await res.text();

  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`redis_bad_json_response:${text.slice(0, 120)}`);
  }

  if (!res.ok || json?.error) {
    throw new Error(json?.error || `redis_http_${res.status}`);
  }

  return json?.result;
}

async function readRedisStore() {
  try {
    const raw = await redisCommand(["GET", REDIS_KEY]);

    if (!raw) {
      return {
        ok: true,
        available: hasRedisConfig(),
        source: "redis",
        store: createEmptyStore("redis"),
        error: null,
      };
    }

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

    return {
      ok: true,
      available: hasRedisConfig(),
      source: "redis",
      store: normalizeStorePayload(parsed, "redis"),
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      available: hasRedisConfig(),
      source: "redis",
      store: createEmptyStore("redis_failed"),
      error: e?.message || "redis_read_failed",
    };
  }
}

async function writeRedisStore(store) {
  try {
    await redisCommand(["SET", REDIS_KEY, JSON.stringify(store)]);

    return {
      ok: true,
      source: "redis",
      key: REDIS_KEY,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      source: "redis",
      key: REDIS_KEY,
      error: e?.message || "redis_write_failed",
    };
  }
}

async function clearRedisStore() {
  try {
    await redisCommand(["DEL", REDIS_KEY]);

    return {
      ok: true,
      source: "redis",
      key: REDIS_KEY,
      error: null,
    };
  } catch (e) {
    return {
      ok: false,
      source: "redis",
      key: REDIS_KEY,
      error: e?.message || "redis_clear_failed",
    };
  }
}

// ================= FILE HELPERS =================

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e?.code === "ENOENT") return null;

    console.error("ANALYZE STORE FILE READ ERROR:", e);
    return null;
  }
}

async function writeJsonFile(filePath, store) {
  await ensureDir(filePath);

  const payload = {
    ...store,
    ok: true,
    version: STORE_VERSION,
    updatedAt: nowMs(),
    maxStoredEvents: MAX_STORED_EVENTS,
  };

  const tmpPath = `${filePath}.tmp`;

  await fs.writeFile(tmpPath, JSON.stringify(payload), "utf8");
  await fs.rename(tmpPath, filePath);
}

async function readFileStore(filePath) {
  const raw = await readJsonFile(filePath);

  return {
    ok: true,
    available: true,
    source: "file",
    path: filePath,
    store: normalizeStorePayload(raw, "file"),
    error: null,
  };
}

async function writeFileStore(filePath, store) {
  try {
    await writeJsonFile(filePath, store);

    return {
      ok: true,
      source: "file",
      path: filePath,
      error: null,
    };
  } catch (e) {
    console.error("ANALYZE STORE FILE WRITE ERROR:", e);

    return {
      ok: false,
      source: "file",
      path: filePath,
      error: e?.message || "file_write_failed",
    };
  }
}

// ================= MEMORY HELPERS =================

function getMemoryStore() {
  const current = globalThis[MEMORY_KEY];

  if (isPlainObject(current) || Array.isArray(current)) {
    return normalizeStorePayload(current, "memory");
  }

  const empty = createEmptyStore("memory");
  globalThis[MEMORY_KEY] = empty;
  return empty;
}

function setMemoryStore(store) {
  globalThis[MEMORY_KEY] = normalizeStorePayload(store, "memory");
}

// ================= ACTION CLASSIFICATION =================

function getActionCandidates(event) {
  return [
    event?.analyzeLifecycle,
    event?.analyzeAction,
    event?.lifecycleAction,
    event?.tradeAction,
    event?.action,
    event?.status,
    event?.state,
    event?.reason,
    event?.exitReason,
  ]
    .map(normalizeAction)
    .filter(Boolean);
}

function hasExitFields(event) {
  return (
    event?.closed === true ||
    event?.isClosed === true ||
    normalizeClosedFlag(event?.status) ||
    event?.exitPrice !== undefined ||
    event?.exit !== undefined ||
    event?.executionPrice !== undefined ||
    event?.closedAt !== undefined ||
    event?.exitAt !== undefined ||
    event?.exitTs !== undefined ||
    event?.exitReason !== undefined ||
    event?.realizedR !== undefined ||
    event?.pnlR !== undefined ||
    event?.exitR !== undefined ||
    event?.resultR !== undefined ||
    event?.outcomeR !== undefined ||
    event?.rMultiple !== undefined ||
    event?.pnlPct !== undefined
  );
}

function hasEntryFields(event) {
  return (
    event?.entry !== undefined ||
    event?.entryPrice !== undefined ||
    event?.openPrice !== undefined ||
    event?.sl !== undefined ||
    event?.stopLoss !== undefined ||
    event?.tp !== undefined ||
    event?.takeProfit !== undefined ||
    event?.rr !== undefined ||
    event?.baseRR !== undefined
  );
}

function classifyLifecycleAction(event) {
  const actions = getActionCandidates(event);

  for (const action of actions) {
    if (IGNORE_ACTIONS.has(action)) {
      return {
        type: "IGNORE",
        rawAction: action,
        reason: `IGNORED_${action}`,
      };
    }

    if (
      action.includes("WAIT") ||
      action.includes("HOLD") ||
      action.includes("RUNNING") ||
      action.includes("SKIP") ||
      action.includes("REJECT")
    ) {
      return {
        type: "IGNORE",
        rawAction: action,
        reason: `IGNORED_${action}`,
      };
    }
  }

  for (const action of actions) {
    if (EXIT_ACTIONS.has(action)) {
      return {
        type: "EXIT",
        rawAction: action,
        reason: "EXIT_ACTION",
      };
    }

    if (
      action.includes("EXIT") ||
      action.includes("CLOSE") ||
      action.includes("TAKE_PROFIT") ||
      action.includes("STOP_LOSS") ||
      action === "TP" ||
      action === "SL"
    ) {
      return {
        type: "EXIT",
        rawAction: action,
        reason: "EXIT_ACTION",
      };
    }
  }

  if (hasExitFields(event)) {
    return {
      type: "EXIT",
      rawAction: actions[0] || "EXIT_BY_FIELDS",
      reason: "EXIT_FIELDS",
    };
  }

  for (const action of actions) {
    if (ENTRY_ACTIONS.has(action)) {
      return {
        type: "ENTRY",
        rawAction: action,
        reason: "ENTRY_ACTION",
      };
    }

    if (action.includes("ENTRY") || action.includes("OPEN")) {
      return {
        type: "ENTRY",
        rawAction: action,
        reason: "ENTRY_ACTION",
      };
    }
  }

  if (hasEntryFields(event)) {
    return {
      type: "ENTRY",
      rawAction: actions[0] || "ENTRY_BY_FIELDS",
      reason: "ENTRY_FIELDS",
    };
  }

  return {
    type: "IGNORE",
    rawAction: actions[0] || "UNKNOWN",
    reason: "NO_LIFECYCLE_SIGNAL",
  };
}

// ================= SNAPSHOT NORMALIZATION =================

function buildFilterSnapshot(event) {
  const fromNested = {
    ...safeObject(event?.filterSnapshot),
    ...safeObject(event?.filters),
    ...safeObject(event?.filterValues),
    ...safeObject(event?.analysisFilters),
  };

  const familyId = extractFamilyId(event);

  const picked = {
    familyId,
    analyzeFamilyId: familyId,

    setupClass: event?.setupClass,
    grade: event?.grade,

    score: pickFirst(event?.score, event?.moveScore, event?.tradeScore),
    moveScore: pickFirst(event?.moveScore, event?.score, event?.tradeScore),
    confluence: event?.confluence,
    sniperScore: event?.sniperScore,

    rr: event?.rr,
    baseRR: event?.baseRR,
    plannedRR: event?.plannedRR,
    finalRR: pickFirst(event?.finalRR, event?.finalRr),
    preTpRR: event?.preTpRR,
    effectiveRR: event?.effectiveRR,

    stage: event?.stage,
    scannerStage: event?.scannerStage,
    stageSource: event?.stageSource,
    flow: event?.flow,

    rsi: event?.rsi,
    rsiHTF: event?.rsiHTF,
    rsiZone: event?.rsiZone,
    tfScore: event?.tfScore,
    tfStrength: event?.tfStrength,
    tfAlignment: event?.tfAlignment,

    obBias: event?.obBias,
    obSide: event?.obSide,
    obAlignment: event?.obAlignment,
    spreadPct: event?.spreadPct,
    spreadBps: event?.spreadBps,
    depthMinUsd1p: event?.depthMinUsd1p,
    depthUsd1p: event?.depthUsd1p,

    btcState: event?.btcState,
    btcTrend: event?.btcTrend,
    btcRelation: event?.btcRelation,
    regime: event?.regime,
    market: event?.market,

    fundingRate: event?.fundingRate,
    funding: event?.funding,

    pullbackPct: event?.pullbackPct,
    distanceFromHighPct: event?.distanceFromHighPct,
    distanceFromLocalHighPct: event?.distanceFromLocalHighPct,
    pullbackFromHighPct: event?.pullbackFromHighPct,

    strategyVersion: event?.strategyVersion,
  };

  return cleanObject({
    ...fromNested,
    ...picked,
  });
}

// ================= RECORD NORMALIZATION =================

function normalizeEntryRecord(event, meta = {}) {
  const currentTs = nowMs();
  const tradeId = extractTradeId(event);
  const symbol = normalizeSymbol(event?.symbol);
  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);

  const openedAt = normalizeTimestamp(
    event?.openedAt ??
      event?.entryTs ??
      event?.createdAt ??
      event?.ts ??
      event?.analyzeTs ??
      meta?.ts,
    currentTs
  );

  const familyId = extractFamilyId(event);
  const filterSnapshot = buildFilterSnapshot(event);

  if (familyId) {
    filterSnapshot.familyId = familyId;
    filterSnapshot.analyzeFamilyId = familyId;
  }

  return {
    type: "TRADE",
    analyzeKind: "TRADE_RECORD",
    analyzeEventKey: tradeId,
    tradeId,

    symbol,
    side,

    action: "ENTRY",
    rawAction: normalizeAction(event?.action),
    source: meta?.source || event?.analyzeSource || event?.source || "unknown",

    openedAt,
    createdAt: event?.createdAt ?? openedAt,
    updatedAt: currentTs,
    analyzeTs: openedAt,
    analyzeCreatedAt: currentTs,
    analyzeUpdatedAt: currentTs,
    analyzeStoredAt: currentTs,

    closed: false,
    closedAt: null,

    entry: nullableNumber(event?.entry ?? event?.entryPrice ?? event?.openPrice),
    entryPrice: nullableNumber(event?.entryPrice ?? event?.entry ?? event?.openPrice),
    sl: nullableNumber(event?.sl ?? event?.stopLoss),
    tp: nullableNumber(event?.tp ?? event?.takeProfit),
    rr: nullableNumber(event?.rr),
    baseRR: nullableNumber(event?.baseRR),

    exit: null,
    exitPrice: null,
    exitReason: "",
    realizedR: null,
    pnlR: null,
    resultR: null,
    outcomeR: null,
    rMultiple: null,
    pnlPct: null,

    confluence: nullableNumber(event?.confluence),
    sniperScore: nullableNumber(event?.sniperScore),
    score: nullableNumber(event?.score ?? event?.moveScore ?? event?.tradeScore),
    moveScore: nullableNumber(event?.moveScore ?? event?.score ?? event?.tradeScore),

    setupClass: event?.setupClass || "",
    grade: event?.grade || "",

    rsi: event?.rsi ?? null,
    rsiHTF: event?.rsiHTF ?? null,
    rsiZone: event?.rsiZone || "",
    flow: event?.flow || "",
    obBias: event?.obBias || "",
    spreadPct: nullableNumber(event?.spreadPct),
    spreadBps: nullableNumber(event?.spreadBps),
    depthMinUsd1p: nullableNumber(event?.depthMinUsd1p),
    btcState: event?.btcState || "",
    regime: event?.regime || "",
    fundingRate: nullableNumber(event?.fundingRate ?? event?.funding),

    familyId,
    analyzeFamilyId: familyId,
    analysisFamilyId: familyId,
    familyFrozen: Boolean(familyId),
    familyFrozenAt: familyId ? currentTs : null,
    familyDefinition:
      event?.familyDefinition ||
      event?.definition ||
      filterSnapshot?.definition ||
      "",

    filterSnapshot,
    entryEvent: safeJsonClone(event),
    exitEvent: null,
  };
}

function normalizeExitPatch(event, meta = {}) {
  const currentTs = nowMs();

  const closedAt = normalizeTimestamp(
    event?.closedAt ??
      event?.exitAt ??
      event?.exitTs ??
      event?.updatedAt ??
      event?.ts ??
      event?.analyzeTs ??
      meta?.ts,
    currentTs
  );

  const exitPrice = nullableNumber(
    event?.exitPrice ??
      event?.exit ??
      event?.executionPrice ??
      event?.triggerPrice ??
      event?.price
  );

  const realizedR = nullableNumber(
    event?.realizedR ??
      event?.pnlR ??
      event?.exitR ??
      event?.resultR ??
      event?.outcomeR ??
      event?.rMultiple ??
      event?.r
  );

  const pnlPct = nullableNumber(
    event?.pnlPct ??
      event?.pnlPercent ??
      event?.realizedPnlPct ??
      event?.resultPnlPct ??
      event?.profitPct
  );

  return {
    action: "EXIT",
    rawExitAction: normalizeAction(event?.action),
    closed: true,
    closedAt,
    updatedAt: currentTs,
    analyzeUpdatedAt: currentTs,
    analyzeStoredAt: currentTs,
    analyzeTs: closedAt,

    exit: exitPrice,
    exitPrice,
    executionPrice: nullableNumber(event?.executionPrice ?? exitPrice),
    triggerPrice: nullableNumber(event?.triggerPrice),
    intendedExecutionPrice: nullableNumber(event?.intendedExecutionPrice),

    exitReason: safeString(
      event?.exitReason ??
        event?.reason ??
        event?.status ??
        event?.action ??
        "EXIT"
    ),

    realizedR,
    pnlR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    rMultiple: realizedR,
    exitR: realizedR,

    pnlPct,

    mfeR: nullableNumber(event?.mfeR),
    maeR: nullableNumber(event?.maeR),
    currentR: nullableNumber(event?.currentR),
    maxTpProgress: nullableNumber(event?.maxTpProgress),
    reachedHalfR: Boolean(event?.reachedHalfR),
    reachedOneR: Boolean(event?.reachedOneR),
    nearTpSeen: Boolean(event?.nearTpSeen),
    directToSL: Boolean(event?.directToSL),
    slAfterHalfR: Boolean(event?.slAfterHalfR),
    slAfterOneR: Boolean(event?.slAfterOneR),
    slAfterNearTp: Boolean(event?.slAfterNearTp),
    breakEvenActivated: Boolean(event?.breakEvenActivated),
    breakEvenStop: Boolean(event?.breakEvenStop),

    holdMinutes: nullableNumber(event?.holdMinutes),
    ticksObserved: nullableNumber(event?.ticksObserved),
    adverseTicks: nullableNumber(event?.adverseTicks),
    favorableTicks: nullableNumber(event?.favorableTicks),

    exitEvent: safeJsonClone(event),
  };
}

function mergeEntryIntoExisting(existing, entryRecord) {
  if (!existing) return entryRecord;

  const keepFamilyId = existing.familyId || entryRecord.familyId || "";

  const filterSnapshot = {
    ...safeObject(entryRecord.filterSnapshot),
    ...safeObject(existing.filterSnapshot),
  };

  if (keepFamilyId) {
    filterSnapshot.familyId = keepFamilyId;
    filterSnapshot.analyzeFamilyId = keepFamilyId;
  }

  return {
    ...existing,

    symbol: existing.symbol || entryRecord.symbol,
    side: existing.side || entryRecord.side,

    openedAt: existing.openedAt || entryRecord.openedAt,
    createdAt: existing.createdAt || entryRecord.createdAt,

    entry: existing.entry ?? entryRecord.entry,
    entryPrice: existing.entryPrice ?? entryRecord.entryPrice,
    sl: existing.sl ?? entryRecord.sl,
    tp: existing.tp ?? entryRecord.tp,
    rr: existing.rr ?? entryRecord.rr,
    baseRR: existing.baseRR ?? entryRecord.baseRR,

    confluence: existing.confluence ?? entryRecord.confluence,
    sniperScore: existing.sniperScore ?? entryRecord.sniperScore,
    score: existing.score ?? entryRecord.score,
    moveScore: existing.moveScore ?? entryRecord.moveScore,

    setupClass: existing.setupClass || entryRecord.setupClass,
    grade: existing.grade || entryRecord.grade,

    rsi: existing.rsi ?? entryRecord.rsi,
    rsiHTF: existing.rsiHTF ?? entryRecord.rsiHTF,
    rsiZone: existing.rsiZone || entryRecord.rsiZone,
    flow: existing.flow || entryRecord.flow,
    obBias: existing.obBias || entryRecord.obBias,
    spreadPct: existing.spreadPct ?? entryRecord.spreadPct,
    spreadBps: existing.spreadBps ?? entryRecord.spreadBps,
    depthMinUsd1p: existing.depthMinUsd1p ?? entryRecord.depthMinUsd1p,
    btcState: existing.btcState || entryRecord.btcState,
    regime: existing.regime || entryRecord.regime,
    fundingRate: existing.fundingRate ?? entryRecord.fundingRate,

    familyId: keepFamilyId,
    analyzeFamilyId: keepFamilyId,
    analysisFamilyId: keepFamilyId,
    familyFrozen: Boolean(keepFamilyId),
    familyFrozenAt:
      existing.familyFrozenAt ||
      entryRecord.familyFrozenAt ||
      (keepFamilyId ? nowMs() : null),

    familyDefinition: existing.familyDefinition || entryRecord.familyDefinition,

    filterSnapshot,
    entryEvent: existing.entryEvent || entryRecord.entryEvent,

    analyzeUpdatedAt: nowMs(),
    updatedAt: nowMs(),
    analyzeStoredAt: nowMs(),
  };
}

function applyExitPatch(existing, patch) {
  if (!existing) return null;

  const familyId = existing.familyId || existing.analyzeFamilyId || "";

  return {
    ...existing,
    ...patch,

    familyId,
    analyzeFamilyId: familyId,
    analysisFamilyId: familyId,
    familyFrozen: existing.familyFrozen || Boolean(familyId),
    familyFrozenAt: existing.familyFrozenAt || (familyId ? existing.openedAt : null),

    filterSnapshot: existing.filterSnapshot,
    entryEvent: existing.entryEvent,
  };
}

function createUnmatchedExitRecord(event, patch, meta = {}) {
  const tradeId = extractTradeId(event);
  const symbol = normalizeSymbol(event?.symbol);
  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);

  return {
    type: "UNMATCHED_EXIT",
    analyzeKind: "UNMATCHED_EXIT",
    analyzeEventKey: tradeId,
    tradeId,

    symbol,
    side,

    source: meta?.source || event?.analyzeSource || event?.source || "unknown",
    createdAt: patch.closedAt,
    updatedAt: nowMs(),
    analyzeTs: patch.closedAt,
    analyzeCreatedAt: nowMs(),
    analyzeUpdatedAt: nowMs(),
    analyzeStoredAt: nowMs(),

    closed: true,
    closedAt: patch.closedAt,

    exit: patch.exit,
    exitPrice: patch.exitPrice,
    executionPrice: patch.executionPrice,
    triggerPrice: patch.triggerPrice,
    intendedExecutionPrice: patch.intendedExecutionPrice,

    exitReason: patch.exitReason,
    realizedR: patch.realizedR,
    pnlR: patch.pnlR,
    resultR: patch.resultR,
    outcomeR: patch.outcomeR,
    rMultiple: patch.rMultiple,
    exitR: patch.exitR,
    pnlPct: patch.pnlPct,

    exitEvent: safeJsonClone(event),
  };
}

// ================= STORE NORMALIZATION =================

function normalizeTradeRecord(record) {
  if (!record || typeof record !== "object") return null;

  const tradeId = extractTradeId(record);
  if (!tradeId) return null;

  const familyId = extractFamilyId(record);

  const openedAt = normalizeTimestamp(
    record?.openedAt ??
      record?.entryTs ??
      record?.createdAt ??
      record?.analyzeTs ??
      record?.ts,
    nowMs()
  );

  const closed = Boolean(record?.closed || hasExitFields(record));

  const closedAt = closed
    ? normalizeTimestamp(
        record?.closedAt ??
          record?.exitAt ??
          record?.exitTs ??
          record?.updatedAt ??
          record?.analyzeUpdatedAt ??
          record?.ts,
        openedAt
      )
    : null;

  const realizedR = nullableNumber(
    record?.realizedR ??
      record?.pnlR ??
      record?.exitR ??
      record?.resultR ??
      record?.outcomeR ??
      record?.rMultiple ??
      record?.r
  );

  const exitPrice = nullableNumber(
    record?.exitPrice ??
      record?.exit ??
      record?.executionPrice ??
      record?.triggerPrice
  );

  const filterSnapshot = {
    ...buildFilterSnapshot(record),
    ...safeObject(record?.filterSnapshot),
  };

  if (familyId) {
    filterSnapshot.familyId = familyId;
    filterSnapshot.analyzeFamilyId = familyId;
  }

  return {
    ...record,

    type: "TRADE",
    analyzeKind: "TRADE_RECORD",
    analyzeEventKey: tradeId,
    tradeId,

    symbol: normalizeSymbol(record?.symbol),
    side: normalizeSide(record?.side || record?.direction || record?.tradeSide),

    openedAt,
    closed,
    closedAt,

    analyzeTs: normalizeTimestamp(record?.analyzeTs ?? openedAt, openedAt),
    analyzeCreatedAt: normalizeTimestamp(record?.analyzeCreatedAt ?? openedAt, openedAt),
    analyzeUpdatedAt: normalizeTimestamp(
      record?.analyzeUpdatedAt ?? record?.updatedAt ?? closedAt ?? openedAt,
      nowMs()
    ),

    entry: nullableNumber(record?.entry ?? record?.entryPrice ?? record?.openPrice),
    entryPrice: nullableNumber(record?.entryPrice ?? record?.entry ?? record?.openPrice),
    sl: nullableNumber(record?.sl ?? record?.stopLoss),
    tp: nullableNumber(record?.tp ?? record?.takeProfit),
    rr: nullableNumber(record?.rr),
    baseRR: nullableNumber(record?.baseRR),

    exit: exitPrice,
    exitPrice,
    executionPrice: nullableNumber(record?.executionPrice ?? exitPrice),
    triggerPrice: nullableNumber(record?.triggerPrice),
    intendedExecutionPrice: nullableNumber(record?.intendedExecutionPrice),

    exitReason: safeString(record?.exitReason ?? record?.reason),
    realizedR,
    pnlR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    rMultiple: realizedR,
    exitR: realizedR,

    pnlPct: nullableNumber(
      record?.pnlPct ??
        record?.pnlPercent ??
        record?.realizedPnlPct ??
        record?.profitPct
    ),

    confluence: nullableNumber(record?.confluence),
    sniperScore: nullableNumber(record?.sniperScore),
    score: nullableNumber(record?.score ?? record?.moveScore ?? record?.tradeScore),
    moveScore: nullableNumber(record?.moveScore ?? record?.score ?? record?.tradeScore),

    familyId,
    analyzeFamilyId: familyId,
    analysisFamilyId: familyId,
    familyFrozen: Boolean(record?.familyFrozen || familyId),
    familyFrozenAt: record?.familyFrozenAt || (familyId ? openedAt : null),

    filterSnapshot,
  };
}

function normalizeUnmatchedExit(record) {
  if (!record || typeof record !== "object") return null;

  const tradeId = extractTradeId(record);
  if (!tradeId) return null;

  const closedAt = normalizeTimestamp(
    record?.closedAt ?? record?.createdAt ?? record?.analyzeTs ?? record?.ts,
    nowMs()
  );

  const realizedR = nullableNumber(
    record?.realizedR ??
      record?.pnlR ??
      record?.exitR ??
      record?.resultR ??
      record?.outcomeR ??
      record?.rMultiple ??
      record?.r
  );

  const exitPrice = nullableNumber(
    record?.exitPrice ??
      record?.exit ??
      record?.executionPrice ??
      record?.triggerPrice
  );

  return {
    ...record,

    type: "UNMATCHED_EXIT",
    analyzeKind: "UNMATCHED_EXIT",
    analyzeEventKey: tradeId,
    tradeId,

    symbol: normalizeSymbol(record?.symbol),
    side: normalizeSide(record?.side || record?.direction || record?.tradeSide),

    closed: true,
    closedAt,
    analyzeTs: closedAt,
    analyzeCreatedAt: normalizeTimestamp(record?.analyzeCreatedAt ?? closedAt, closedAt),
    analyzeUpdatedAt: normalizeTimestamp(record?.analyzeUpdatedAt ?? closedAt, closedAt),

    exit: exitPrice,
    exitPrice,
    executionPrice: nullableNumber(record?.executionPrice ?? exitPrice),
    triggerPrice: nullableNumber(record?.triggerPrice),
    intendedExecutionPrice: nullableNumber(record?.intendedExecutionPrice),

    exitReason: safeString(record?.exitReason ?? record?.reason ?? "UNMATCHED_EXIT"),
    realizedR,
    pnlR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    rMultiple: realizedR,
    exitR: realizedR,

    pnlPct: nullableNumber(
      record?.pnlPct ??
        record?.pnlPercent ??
        record?.realizedPnlPct ??
        record?.profitPct
    ),
  };
}

function incrementReason(map, reason) {
  const key = reason || "UNKNOWN";
  map[key] = Number(map[key] || 0) + 1;
}

function applyIncomingEventToMaps(tradeMap, unmatchedExitMap, rawEvent, meta = {}, stats = null) {
  if (!rawEvent || typeof rawEvent !== "object") {
    if (stats) {
      stats.ignored += 1;
      incrementReason(stats.ignoredReasons, "BAD_EVENT");
    }

    return;
  }

  const lifecycle = classifyLifecycleAction(rawEvent);

  if (lifecycle.type === "IGNORE") {
    if (stats) {
      stats.ignored += 1;
      incrementReason(stats.ignoredReasons, lifecycle.reason);
    }

    return;
  }

  const tradeId = extractTradeId(rawEvent);

  if (!tradeId) {
    if (stats) {
      stats.ignored += 1;
      incrementReason(stats.ignoredReasons, "NO_TRADE_ID");
    }

    return;
  }

  if (lifecycle.type === "ENTRY") {
    const entryRecord = normalizeEntryRecord(rawEvent, meta);
    const existing = tradeMap.get(tradeId);
    const merged = mergeEntryIntoExisting(existing, entryRecord);

    const unmatchedExit = unmatchedExitMap.get(tradeId);

    if (unmatchedExit) {
      const exitPatch = normalizeExitPatch(unmatchedExit, meta);
      const patched = applyExitPatch(merged, exitPatch);
      tradeMap.set(tradeId, patched || merged);
      unmatchedExitMap.delete(tradeId);

      if (stats) {
        stats.matchedExits += 1;
      }
    } else {
      tradeMap.set(tradeId, merged);
    }

    if (stats) {
      stats.accepted += 1;
      stats.entries += 1;
    }

    return;
  }

  if (lifecycle.type === "EXIT") {
    const exitPatch = normalizeExitPatch(rawEvent, meta);
    const existing = tradeMap.get(tradeId);

    if (existing) {
      const patched = applyExitPatch(existing, exitPatch);
      if (patched) tradeMap.set(tradeId, patched);

      if (stats) {
        stats.accepted += 1;
        stats.exits += 1;
        stats.matchedExits += 1;
      }

      return;
    }

    const unmatched = createUnmatchedExitRecord(rawEvent, exitPatch, meta);
    unmatchedExitMap.set(tradeId, unmatched);

    if (stats) {
      stats.accepted += 1;
      stats.exits += 1;
      stats.unmatchedExits += 1;
    }
  }
}

function reduceLegacyEventsToStore(events, source = "legacy") {
  const tradeMap = new Map();
  const unmatchedExitMap = new Map();

  const stats = {
    accepted: 0,
    ignored: 0,
    entries: 0,
    exits: 0,
    matchedExits: 0,
    unmatchedExits: 0,
    ignoredReasons: {},
  };

  const sorted = safeArray(events)
    .filter(event => event && typeof event === "object")
    .sort((a, b) => {
      const at = normalizeTimestamp(a.analyzeTs ?? a.ts ?? a.createdAt ?? a.updatedAt, 0);
      const bt = normalizeTimestamp(b.analyzeTs ?? b.ts ?? b.createdAt ?? b.updatedAt, 0);
      return at - bt;
    });

  for (const event of sorted) {
    applyIncomingEventToMaps(tradeMap, unmatchedExitMap, event, { source }, stats);
  }

  return {
    ...createEmptyStore(source),
    trades: trimRecords(Array.from(tradeMap.values())),
    unmatchedExits: trimRecords(Array.from(unmatchedExitMap.values())),
  };
}

function normalizeStorePayload(payload, source = "unknown") {
  if (!payload) return createEmptyStore(source);

  if (Array.isArray(payload)) {
    return reduceLegacyEventsToStore(payload, source);
  }

  if (!isPlainObject(payload)) {
    return createEmptyStore(source);
  }

  if (Array.isArray(payload.trades) || Array.isArray(payload.unmatchedExits)) {
    const tradeMap = new Map();
    const unmatchedExitMap = new Map();

    for (const record of safeArray(payload.trades)) {
      const normalized = normalizeTradeRecord(record);
      if (!normalized?.tradeId) continue;
      tradeMap.set(normalized.tradeId, normalized);
    }

    for (const record of safeArray(payload.unmatchedExits)) {
      const normalized = normalizeUnmatchedExit(record);
      if (!normalized?.tradeId) continue;

      if (tradeMap.has(normalized.tradeId)) {
        const patched = applyExitPatch(
          tradeMap.get(normalized.tradeId),
          normalizeExitPatch(normalized)
        );

        if (patched) tradeMap.set(normalized.tradeId, patched);
        continue;
      }

      unmatchedExitMap.set(normalized.tradeId, normalized);
    }

    return {
      ok: true,
      version: STORE_VERSION,
      source,
      updatedAt: normalizeTimestamp(payload.updatedAt, nowMs()),
      maxStoredEvents: MAX_STORED_EVENTS,
      trades: trimRecords(Array.from(tradeMap.values())),
      unmatchedExits: trimRecords(Array.from(unmatchedExitMap.values())),
    };
  }

  if (Array.isArray(payload.events)) {
    return reduceLegacyEventsToStore(payload.events, source);
  }

  return createEmptyStore(source);
}

function mergeStores(stores) {
  const tradeMap = new Map();
  const unmatchedExitMap = new Map();

  const normalizedStores = safeArray(stores).map((store, index) =>
    normalizeStorePayload(store, `merge_${index}`)
  );

  for (const store of normalizedStores) {
    for (const trade of safeArray(store.trades)) {
      const normalized = normalizeTradeRecord(trade);
      if (!normalized?.tradeId) continue;

      const prev = tradeMap.get(normalized.tradeId);

      if (!prev) {
        tradeMap.set(normalized.tradeId, normalized);
        continue;
      }

      const prevTs = normalizeTimestamp(prev.analyzeUpdatedAt ?? prev.updatedAt, 0);
      const nextTs = normalizeTimestamp(normalized.analyzeUpdatedAt ?? normalized.updatedAt, 0);

      if (nextTs >= prevTs) {
        const familyId = prev.familyId || normalized.familyId || "";

        const filterSnapshot = {
          ...safeObject(normalized.filterSnapshot),
          ...safeObject(prev.filterSnapshot),
        };

        if (familyId) {
          filterSnapshot.familyId = familyId;
          filterSnapshot.analyzeFamilyId = familyId;
        }

        tradeMap.set(normalized.tradeId, {
          ...prev,
          ...normalized,

          familyId,
          analyzeFamilyId: familyId,
          analysisFamilyId: familyId,
          familyFrozen: prev.familyFrozen || normalized.familyFrozen || Boolean(familyId),
          familyFrozenAt: prev.familyFrozenAt || normalized.familyFrozenAt,

          filterSnapshot,
          entryEvent: prev.entryEvent || normalized.entryEvent,
        });
      }
    }

    for (const unmatched of safeArray(store.unmatchedExits)) {
      const normalized = normalizeUnmatchedExit(unmatched);
      if (!normalized?.tradeId) continue;

      if (tradeMap.has(normalized.tradeId)) {
        const patch = normalizeExitPatch(normalized);
        const patched = applyExitPatch(tradeMap.get(normalized.tradeId), patch);

        if (patched) tradeMap.set(normalized.tradeId, patched);
        continue;
      }

      const prev = unmatchedExitMap.get(normalized.tradeId);
      const prevTs = normalizeTimestamp(prev?.analyzeUpdatedAt ?? prev?.updatedAt, 0);
      const nextTs = normalizeTimestamp(normalized.analyzeUpdatedAt ?? normalized.updatedAt, 0);

      if (!prev || nextTs >= prevTs) {
        unmatchedExitMap.set(normalized.tradeId, normalized);
      }
    }
  }

  return {
    ...createEmptyStore("merged"),
    trades: trimRecords(Array.from(tradeMap.values())),
    unmatchedExits: trimRecords(Array.from(unmatchedExitMap.values())),
    updatedAt: nowMs(),
  };
}

function appendEventsToStore(store, events, meta = {}) {
  const normalized = normalizeStorePayload(store, "append_base");

  const tradeMap = new Map();
  const unmatchedExitMap = new Map();

  for (const trade of safeArray(normalized.trades)) {
    const clean = normalizeTradeRecord(trade);
    if (clean?.tradeId) tradeMap.set(clean.tradeId, clean);
  }

  for (const unmatched of safeArray(normalized.unmatchedExits)) {
    const clean = normalizeUnmatchedExit(unmatched);
    if (clean?.tradeId) unmatchedExitMap.set(clean.tradeId, clean);
  }

  const stats = {
    accepted: 0,
    ignored: 0,
    entries: 0,
    exits: 0,
    matchedExits: 0,
    unmatchedExits: 0,
    ignoredReasons: {},
  };

  const sortedIncoming = safeArray(events)
    .filter(event => event && typeof event === "object")
    .sort((a, b) => {
      const at = normalizeTimestamp(a.analyzeTs ?? a.ts ?? a.createdAt ?? a.updatedAt, nowMs());
      const bt = normalizeTimestamp(b.analyzeTs ?? b.ts ?? b.createdAt ?? b.updatedAt, nowMs());
      return at - bt;
    });

  for (const event of sortedIncoming) {
    applyIncomingEventToMaps(tradeMap, unmatchedExitMap, event, meta, stats);
  }

  return {
    store: {
      ...createEmptyStore("append_result"),
      trades: trimRecords(Array.from(tradeMap.values())),
      unmatchedExits: trimRecords(Array.from(unmatchedExitMap.values())),
      updatedAt: nowMs(),
    },
    stats,
  };
}

// ================= LOAD / WRITE CORE =================

async function loadAnalyzeStoreInternal(filePath = DEFAULT_ANALYZE_PATH) {
  const redisResult = await readRedisStore();
  const fileResult = await readFileStore(filePath);
  const memoryStore = getMemoryStore();

  const sources = {
    redis: {
      ok: redisResult.ok,
      available: redisResult.available,
      count: countStoreRecords(redisResult.store),
      trades: safeArray(redisResult.store?.trades).length,
      unmatchedExits: safeArray(redisResult.store?.unmatchedExits).length,
      error: redisResult.error,
    },
    file: {
      ok: fileResult.ok,
      available: fileResult.available,
      path: filePath,
      count: countStoreRecords(fileResult.store),
      trades: safeArray(fileResult.store?.trades).length,
      unmatchedExits: safeArray(fileResult.store?.unmatchedExits).length,
      error: fileResult.error,
    },
    memory: {
      ok: true,
      available: true,
      count: countStoreRecords(memoryStore),
      trades: safeArray(memoryStore?.trades).length,
      unmatchedExits: safeArray(memoryStore?.unmatchedExits).length,
      error: null,
    },
  };

  const merged = mergeStores([
    redisResult.store,
    fileResult.store,
    memoryStore,
  ]);

  setMemoryStore(merged);

  return {
    ...merged,
    ok: true,
    source: "merged",
    path: filePath,
    redisKey: REDIS_KEY,
    sources,
    count: safeArray(merged.trades).length,
    totalRecords: countStoreRecords(merged),
    events: safeArray(merged.trades),
  };
}

async function persistStore(store, filePath = DEFAULT_ANALYZE_PATH) {
  const normalized = normalizeStorePayload(store, "persist");

  const redis = await writeRedisStore(normalized);
  const file = await writeFileStore(filePath, normalized);

  setMemoryStore(normalized);

  const memory = {
    ok: true,
    source: "memory",
    error: null,
  };

  const ok = Boolean(redis.ok || file.ok || memory.ok);

  return {
    ok,
    redis,
    file,
    memory,
  };
}

// ================= PUBLIC API =================

export async function loadAnalyzeEvents(filePath = DEFAULT_ANALYZE_PATH) {
  const store = await loadAnalyzeStoreInternal(filePath);
  return safeArray(store.trades);
}

export async function readAnalyzeEvents(filePath = DEFAULT_ANALYZE_PATH) {
  return loadAnalyzeEvents(filePath);
}

export async function getAnalyzeEvents(filePath = DEFAULT_ANALYZE_PATH) {
  return loadAnalyzeEvents(filePath);
}

export async function loadAnalyzeStore(filePath = DEFAULT_ANALYZE_PATH) {
  const store = await loadAnalyzeStoreInternal(filePath);

  return {
    ok: true,
    version: STORE_VERSION,
    path: filePath,
    redisKey: REDIS_KEY,

    count: safeArray(store.trades).length,
    totalRecords: countStoreRecords(store),
    maxStoredEvents: MAX_STORED_EVENTS,

    trades: safeArray(store.trades),
    unmatchedExits: safeArray(store.unmatchedExits),

    // Backward compatibility.
    events: safeArray(store.trades),

    sources: store.sources,
    updatedAt: store.updatedAt,
  };
}

export async function getAnalyzeStoreMeta(filePath = DEFAULT_ANALYZE_PATH) {
  const store = await loadAnalyzeStoreInternal(filePath);

  return {
    ok: true,
    version: STORE_VERSION,
    path: filePath,
    redisKey: REDIS_KEY,

    count: safeArray(store.trades).length,
    totalRecords: countStoreRecords(store),
    trades: safeArray(store.trades).length,
    unmatchedExits: safeArray(store.unmatchedExits).length,
    maxStoredEvents: MAX_STORED_EVENTS,

    sources: store.sources,
    updatedAt: store.updatedAt,
  };
}

export async function appendAnalyzeEvents(
  events,
  meta = {},
  filePath = DEFAULT_ANALYZE_PATH
) {
  const incoming = safeArray(events).filter(event => event && typeof event === "object");
  const current = await loadAnalyzeStoreInternal(filePath);

  if (!incoming.length) {
    return {
      ok: true,
      path: filePath,
      redisKey: REDIS_KEY,

      added: 0,
      accepted: 0,
      ignored: 0,
      entries: 0,
      exits: 0,
      matchedExits: 0,
      unmatchedExits: safeArray(current.unmatchedExits).length,

      count: safeArray(current.trades).length,
      totalRecords: countStoreRecords(current),
      maxStoredEvents: MAX_STORED_EVENTS,

      sources: current.sources,
    };
  }

  const { store: nextStore, stats } = appendEventsToStore(current, incoming, meta);
  const persist = await persistStore(nextStore, filePath);

  return {
    ok: Boolean(persist.ok),
    path: filePath,
    redisKey: REDIS_KEY,

    added: stats.accepted,
    accepted: stats.accepted,
    ignored: stats.ignored,
    ignoredReasons: stats.ignoredReasons,

    entries: stats.entries,
    exits: stats.exits,
    matchedExits: stats.matchedExits,

    // Current unmatched total after merge.
    unmatchedExits: safeArray(nextStore.unmatchedExits).length,
    newUnmatchedExits: stats.unmatchedExits,

    count: safeArray(nextStore.trades).length,
    totalRecords: countStoreRecords(nextStore),
    maxStoredEvents: MAX_STORED_EVENTS,

    persist,
  };
}

export async function clearAnalyzeEvents(filePath = DEFAULT_ANALYZE_PATH) {
  const empty = createEmptyStore("clear");

  const redis = await clearRedisStore();
  const file = await writeFileStore(filePath, empty);

  setMemoryStore(empty);

  return {
    ok: Boolean(redis.ok || file.ok),
    version: STORE_VERSION,
    path: filePath,
    redisKey: REDIS_KEY,

    count: 0,
    totalRecords: 0,
    maxStoredEvents: MAX_STORED_EVENTS,

    redis,
    file,
    memory: {
      ok: true,
      source: "memory",
    },
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