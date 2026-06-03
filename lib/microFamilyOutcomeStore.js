// lib/microFamilyOutcomeStore.js
// Weekly adaptive micro-family learning store.
// Doel:
// - Intraday: deduped coin/family observations opslaan.
// - Daily: raw coin rows compacten naar family outcomes.
// - Weekly: daily outcomes optellen, beste canonical micro-families selecteren.
// - Daarna raw/daily buffers resetten zodat opslag klein blijft.

const DAY_MS = 86_400_000;

// ================= CONFIG =================

const DEFAULT_SCHEMA_VERSION = "MF_V4_ANALYZE";

const MICRO_FAMILY_SCHEMA_VERSION =
  typeof process !== "undefined"
    ? process.env.MICRO_FAMILY_SCHEMA_VERSION || DEFAULT_SCHEMA_VERSION
    : DEFAULT_SCHEMA_VERSION;

const ANALYZE_FAMILY_ID_RE = /^(LONG|SHORT)_([1-9]|[1-4][0-9]|50)$/;

const CORE_MICRO_ID_RE =
  /^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_(?:[1-9]|[1-4][0-9]|50))_([A-Z0-9_]+)_([A-Z0-9]+)$/;

export const MICRO_FAMILY_KEYS = {
  meta: "tradeSystem:microFamilies:meta:v2",
  activeRotation: "tradeSystem:microFamilies:activeWeeklyRotation:v2",
  today: dateKey => `tradeSystem:microFamilies:today:${dateKey}:v2`,
  weekly: weekId => `tradeSystem:microFamilies:weekly:${weekId}:v2`,
  lastRotation: "tradeSystem:microFamilies:lastRotation:v2"
};

export const DEFAULT_MICRO_FAMILY_LEARNING_CONFIG = {
  strategyVersion: "TS_V12_7_MICRO_ROTATION_GATE",
  microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

  // shadow-outcome model
  shadowTargetR: 1.42,
  fallbackRiskPct: 0.006,
  minRiskPct: 0.0025,
  maxRiskPct: 0.025,

  // storage caps
  maxTodayRows: 2500,
  maxFamilyIdsPerCandidate: 12,

  // weekly selection
  topFamiliesPerSide: 12,
  minSamplesPerFamily: 8,
  minWinrate: 0.42,
  minExpectancyR: 0.03,
  maxAvgMaeR: 0.95,

  // fallback selection when strict eligibility is empty
  fallbackTopFamiliesPerSide: 3,

  // reset policy
  deleteRawDayAfterRollup: true,
  deleteWeeklyStatsAfterRotation: true,

  // first week / no data behavior
  allowBootstrapWhenNoWeeklyData: true
};

// ================= BASIC HELPERS =================

function nowTs() {
  return Date.now();
}

function cloneJson(value) {
  if (value === undefined || value === null) return value;

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
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

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstFinite(values = []) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round4(value) {
  return Math.round(Number(value || 0) * 10_000) / 10_000;
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

function normalizeBaseSymbol(value) {
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

function getNestedValue(object, path) {
  if (!object || !path) return null;

  return String(path)
    .split(".")
    .reduce((current, key) => {
      if (!current || typeof current !== "object") return null;
      return current[key];
    }, object);
}

// ================= STORE =================

export function createMemoryJsonStore(seed = {}) {
  const map = new Map(Object.entries(seed));

  return {
    async getJson(key) {
      const raw = map.get(key);
      if (raw == null) return null;
      return cloneJson(raw);
    },

    async setJson(key, value) {
      map.set(key, cloneJson(value));
      return true;
    },

    async deleteKey(key) {
      map.delete(key);
      return true;
    },

    dump() {
      return cloneJson(Object.fromEntries(map.entries()));
    }
  };
}

async function getJson(store, key, fallback = null) {
  if (typeof store.getJson === "function") {
    const value = await store.getJson(key);
    return value == null ? fallback : value;
  }

  if (typeof store.get === "function") {
    const value = await store.get(key);
    if (value == null) return fallback;

    if (typeof value !== "string") return value;

    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  throw new Error("Store must expose getJson(key) or get(key)");
}

async function setJson(store, key, value) {
  if (typeof store.setJson === "function") {
    return store.setJson(key, value);
  }

  if (typeof store.set === "function") {
    return store.set(key, JSON.stringify(value));
  }

  throw new Error("Store must expose setJson(key, value) or set(key, value)");
}

async function deleteKey(store, key) {
  if (typeof store.deleteKey === "function") {
    return store.deleteKey(key);
  }

  if (typeof store.del === "function") {
    return store.del(key);
  }

  if (typeof store.delete === "function") {
    return store.delete(key);
  }

  return false;
}

// ================= DATE / WEEK =================

function toDateKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function toIsoWeekId(ts = Date.now()) {
  const date = new Date(ts);
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / DAY_MS) + 1) / 7);

  return `${d.getUTCFullYear()}_W${String(weekNo).padStart(2, "0")}`;
}

// ================= CANONICAL MICRO IDS =================

function normalizeSide(value) {
  const raw = String(value ?? "").trim().toLowerCase();

  if (["long", "bull", "buy", "bullish"].includes(raw)) return "LONG";
  if (["short", "bear", "sell", "bearish"].includes(raw)) return "SHORT";

  const token = cleanToken(value);

  if (token === "LONG" || token === "SHORT") return token;
  if (token.startsWith("LONG_")) return "LONG";
  if (token.startsWith("SHORT_")) return "SHORT";
  if (token.startsWith("MICRO_LONG_")) return "LONG";
  if (token.startsWith("MICRO_SHORT_")) return "SHORT";

  return null;
}

function getMicroSide(microFamilyId) {
  const id = cleanToken(microFamilyId);

  if (id.startsWith("MICRO_LONG_")) return "LONG";
  if (id.startsWith("MICRO_SHORT_")) return "SHORT";

  return null;
}

export function extractParentFamilyIdFromMicroId(raw) {
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

export function normalizeAnalyzeFamilyId(raw) {
  const token = cleanToken(raw);

  if (ANALYZE_FAMILY_ID_RE.test(token)) {
    return token;
  }

  return extractParentFamilyIdFromMicroId(token);
}

export function buildCoreMicroFamilyId(familyId) {
  const analyzeFamilyId = normalizeAnalyzeFamilyId(familyId);

  if (!analyzeFamilyId) return null;

  const side = analyzeFamilyId.startsWith("LONG_") ? "LONG" : "SHORT";
  const definition = `${MICRO_FAMILY_SCHEMA_VERSION} | ${analyzeFamilyId}`;
  const hash = analyzerHashString(definition).slice(0, 8);

  return `MICRO_${side}_${analyzeFamilyId}_${MICRO_FAMILY_SCHEMA_VERSION}_${hash}`;
}

export function isCoreMicroFamilyId(value) {
  const token = cleanToken(value);

  return Boolean(
    token &&
      CORE_MICRO_ID_RE.test(token) &&
      token.includes(`_${MICRO_FAMILY_SCHEMA_VERSION}_`)
  );
}

export function normalizeMicroFamilyId(raw) {
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

function inferAnalyzeFamilyIdFromParts(candidate = {}, side = null) {
  const normalizedSide = normalizeSide(side);

  if (!normalizedSide) return null;

  const familyNumber = normalizeFamilyNumber(
    candidate.familyNumber ??
      candidate.analyzeFamilyNumber ??
      candidate.analysisFamilyNumber ??
      candidate.parentFamilyNumber ??
      candidate.familyIndex ??
      candidate.analyzeFamilyIndex ??
      candidate.analysisFamilyIndex ??
      candidate.familyRank ??
      candidate.rank
  );

  if (!familyNumber) return null;

  return `${normalizedSide}_${familyNumber}`;
}

// ================= CANDIDATE EXTRACTION =================

const MICRO_ID_PATHS = [
  "microFamilyId",
  "microFamily",
  "microFamilyIds",
  "microFamilies",
  "rotationMicroFamilyId",
  "analyzerMicroFamilyId",
  "scannerMicroFamilyId",

  "meta.microFamilyId",
  "meta.rotationMicroFamilyId",
  "meta.analyzerMicroFamilyId",

  "family.microFamilyId",
  "family.rotationMicroFamilyId",
  "family.analyzerMicroFamilyId",

  "filterSnapshot.microFamilyId",
  "filterSnapshot.rotationMicroFamilyId",
  "filterSnapshot.analyzerMicroFamilyId",

  "entryEvent.microFamilyId",
  "entryEvent.rotationMicroFamilyId",
  "entryEvent.analyzerMicroFamilyId",

  "rotationCandidate.microFamilyId",
  "rotationCandidate.microFamily",
  "rotationCandidate.microFamilyIds",
  "rotationCandidate.microFamilies",
  "rotationCandidate.rotationMicroFamilyId",
  "rotationCandidate.analyzerMicroFamilyId"
];

const ANALYZE_ID_PATHS = [
  "familyId",
  "familyIds",
  "families",
  "parentFamilyId",
  "analyzeFamilyId",
  "analysisFamilyId",
  "analyzerParentFamilyId",
  "mainFamilyId",

  "meta.familyId",
  "meta.parentFamilyId",
  "meta.analyzeFamilyId",
  "meta.analysisFamilyId",

  "family.familyId",
  "family.parentFamilyId",
  "family.analyzeFamilyId",
  "family.analysisFamilyId",

  "filterSnapshot.familyId",
  "filterSnapshot.parentFamilyId",
  "filterSnapshot.analyzeFamilyId",
  "filterSnapshot.analysisFamilyId",

  "entryEvent.familyId",
  "entryEvent.parentFamilyId",
  "entryEvent.analyzeFamilyId",
  "entryEvent.analysisFamilyId",

  "rotationCandidate.familyId",
  "rotationCandidate.familyIds",
  "rotationCandidate.families",
  "rotationCandidate.parentFamilyId",
  "rotationCandidate.analyzeFamilyId",
  "rotationCandidate.analysisFamilyId",
  "rotationCandidate.analyzerParentFamilyId"
];

function collectPathValues(object = {}, paths = []) {
  return paths.map(path => getNestedValue(object, path));
}

function extractAnalyzeFamilyIds(candidate = {}) {
  const direct = unique(collectPathValues(candidate, ANALYZE_ID_PATHS))
    .map(normalizeAnalyzeFamilyId)
    .filter(Boolean);

  const fromMicro = unique(collectPathValues(candidate, MICRO_ID_PATHS))
    .map(extractParentFamilyIdFromMicroId)
    .map(normalizeAnalyzeFamilyId)
    .filter(Boolean);

  const side =
    normalizeSide(candidate.tradeSide) ||
    normalizeSide(candidate.rotationSide) ||
    normalizeSide(candidate.side) ||
    normalizeSide(candidate.direction);

  const inferred = inferAnalyzeFamilyIdFromParts(candidate, side);

  return unique([
    direct,
    fromMicro,
    inferred
  ]);
}

function normalizeMicroFamilyIds(candidate = {}, config = {}) {
  const side =
    normalizeSide(candidate.tradeSide) ||
    normalizeSide(candidate.rotationSide) ||
    normalizeSide(candidate.side) ||
    normalizeSide(candidate.direction);

  const fromMicro = unique(collectPathValues(candidate, MICRO_ID_PATHS))
    .map(normalizeMicroFamilyId)
    .filter(Boolean);

  const fromAnalyze = extractAnalyzeFamilyIds(candidate)
    .map(buildCoreMicroFamilyId)
    .filter(Boolean);

  const normalized = unique([
    fromMicro,
    fromAnalyze
  ]).filter(id => {
    if (side !== "LONG" && side !== "SHORT") return true;
    return getMicroSide(id) === side;
  });

  return normalized.slice(0, config.maxFamilyIdsPerCandidate);
}

function normalizeStage(value) {
  const stage = cleanToken(value || "ENTRY");

  if (stage.includes("ALMOST")) return "ALMOST";
  if (stage.includes("EXIT") || stage === "CLOSE") return "EXIT";
  if (stage.includes("ENTRY") || stage === "OPEN") return "ENTRY";

  return stage || "ENTRY";
}

function normalizeCandidate(candidate, config) {
  const symbol = normalizeBaseSymbol(
    candidate?.symbol ||
      candidate?.baseSymbol ||
      candidate?.baseCoin ||
      candidate?.instId
  );

  const side =
    normalizeSide(candidate?.tradeSide) ||
    normalizeSide(candidate?.rotationSide) ||
    normalizeSide(candidate?.side) ||
    normalizeSide(candidate?.direction);

  if (!symbol || !side) return null;

  const stage = normalizeStage(candidate?.stage ?? candidate?.scannerStage);
  const setupClass = cleanToken(candidate?.setupClass || candidate?.setup || "UNKNOWN");
  const reason = cleanToken(candidate?.reason || candidate?.entryReason || "UNKNOWN");

  const microFamilyIds = normalizeMicroFamilyIds(candidate, config);
  const microFamilyId = microFamilyIds[0];

  if (!microFamilyId || !isCoreMicroFamilyId(microFamilyId)) {
    return null;
  }

  const parentFamilyId = normalizeAnalyzeFamilyId(
    extractParentFamilyIdFromMicroId(microFamilyId)
  );

  if (!parentFamilyId) {
    return null;
  }

  const entryPrice = firstFinite([
    candidate.entryPrice,
    candidate.entry,
    candidate.price,
    candidate.markPrice,
    candidate.lastPrice,
    candidate.currentPrice,
    candidate.close
  ]);

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  const currentPrice = firstFinite([
    candidate.currentPrice,
    candidate.markPrice,
    candidate.lastPrice,
    candidate.price,
    candidate.close,
    entryPrice
  ]);

  const stopPrice = firstFinite([
    candidate.stopLoss,
    candidate.sl,
    candidate.stop,
    candidate.slPrice
  ]);

  const plannedRR = firstFinite([
    candidate.finalRr,
    candidate.finalRR,
    candidate.plannedRR,
    candidate.rr,
    candidate.baseRR,
    config.shadowTargetR
  ]);

  const riskAbs = resolveRiskAbs({
    side,
    entryPrice,
    stopPrice,
    spreadPct: Number(candidate.spreadPct),
    atrPct: Number(candidate.atrPct || candidate.volatilityPct),
    config
  });

  return {
    raw: candidate,

    symbol,
    side,
    stage,
    setupClass,
    reason,

    parentFamilyId,
    analyzeFamilyId: parentFamilyId,
    analysisFamilyId: parentFamilyId,
    familyId: parentFamilyId,
    familyIds: [parentFamilyId],

    microFamilyId,
    microFamilyIds,
    rotationMicroFamilyId: microFamilyId,
    analyzerMicroFamilyId: microFamilyId,

    entryPrice,
    currentPrice,
    stopPrice: Number.isFinite(stopPrice) ? stopPrice : null,
    riskAbs,

    targetR: clamp(Number(plannedRR || config.shadowTargetR), 0.6, 3.5),

    score: num(candidate.score),
    confluence: num(candidate.effectiveConfluence ?? candidate.confluence ?? candidate.rawConfluence),
    rawConfluence: num(candidate.rawConfluence ?? candidate.confluence),
    sniperScore: num(candidate.sniperScore),

    rsi: num(candidate.rsi),
    rsiHTF: num(candidate.rsiHTF),
    rsiZone: cleanToken(candidate.rsiZone || "NA"),
    rsiEdge: cleanToken(candidate.rsiEntryEdge || candidate.rsiEdge || "NA"),

    obBias: cleanToken(candidate.obBias || "NA"),
    spreadPct: num(candidate.spreadPct),
    depthMinUsd1p: num(candidate.depthMinUsd1p)
  };
}

// ================= MAIN CYCLE =================

export async function runMicroFamilyLearningCycle({
  store,
  candidates = [],
  now = Date.now(),
  config = {}
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };

  if (!store) {
    throw new Error("runMicroFamilyLearningCycle requires store");
  }

  const dateKey = toDateKey(now);
  const weekId = toIsoWeekId(now);

  const meta = await getJson(
    store,
    MICRO_FAMILY_KEYS.meta,
    createDefaultMeta({ dateKey, weekId, now })
  );

  const rollups = [];

  const oldDayKeys = unique(meta.openDayKeys || [])
    .filter(dayKey => dayKey < dateKey);

  for (const oldDateKey of oldDayKeys) {
    const result = await rollupDayToWeeklyStats({
      store,
      dateKey: oldDateKey,
      config: cfg
    });

    rollups.push(result);
  }

  meta.openDayKeys = unique(meta.openDayKeys || [])
    .filter(dayKey => dayKey >= dateKey);

  let rotationUpdated = false;
  let rotation = await getJson(store, MICRO_FAMILY_KEYS.activeRotation, null);

  if (meta.activeWeekId && meta.activeWeekId !== weekId) {
    const sourceWeekId = meta.activeWeekId;

    rotation = await buildAndSaveWeeklyRotation({
      store,
      sourceWeekId,
      targetWeekId: weekId,
      now,
      config: cfg
    });

    rotationUpdated = true;
    meta.activeWeekId = weekId;
    meta.lastWeeklyRotationAt = now;

    if (cfg.deleteWeeklyStatsAfterRotation) {
      await deleteKey(store, MICRO_FAMILY_KEYS.weekly(sourceWeekId));
    }
  }

  if (!meta.activeWeekId) {
    meta.activeWeekId = weekId;
  }

  let observation = null;

  if (Array.isArray(candidates) && candidates.length) {
    observation = await observeMicroFamilyCandidates({
      store,
      candidates,
      now,
      dateKey,
      config: cfg
    });

    meta.openDayKeys = unique([...(meta.openDayKeys || []), dateKey]);
    meta.lastObservedAt = now;
  }

  rotation = await getJson(store, MICRO_FAMILY_KEYS.activeRotation, null);

  if (!rotation && cfg.allowBootstrapWhenNoWeeklyData) {
    rotation = createBootstrapRotation({
      weekId,
      targetWeekKey: weekId,
      now,
      strategyVersion: cfg.strategyVersion,
      reason: "BOOTSTRAP_NO_WEEKLY_DATA"
    });

    await setJson(store, MICRO_FAMILY_KEYS.activeRotation, rotation);
  }

  meta.activeDateKey = dateKey;
  meta.updatedAt = now;
  meta.schemaVersion = 2;
  meta.microFamilySchemaVersion = MICRO_FAMILY_SCHEMA_VERSION;

  await setJson(store, MICRO_FAMILY_KEYS.meta, meta);

  return {
    ok: true,
    dateKey,
    weekId,
    rotationUpdated,
    activeRotation: rotation,
    observation,
    rollups,
    meta
  };
}

// ================= OBSERVATION =================

export async function observeMicroFamilyCandidates({
  store,
  candidates,
  now = Date.now(),
  dateKey = toDateKey(now),
  config = {}
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };
  const key = MICRO_FAMILY_KEYS.today(dateKey);

  const day = await getJson(
    store,
    key,
    createEmptyTodayStore({
      dateKey,
      now,
      strategyVersion: cfg.strategyVersion
    })
  );

  let observed = 0;
  let skipped = 0;

  for (const candidate of safeArray(candidates)) {
    const normalized = normalizeCandidate(candidate, cfg);

    if (!normalized) {
      skipped += 1;
      continue;
    }

    const rowKey = buildTodayRowKey(normalized);
    const previous = day.rows[rowKey];

    day.rows[rowKey] = mergeObservationRow({
      previous,
      candidate: normalized,
      now,
      config: cfg
    });

    observed += 1;
  }

  enforceTodayCap(day, cfg.maxTodayRows);

  day.updatedAt = now;
  day.rowCount = Object.keys(day.rows).length;

  await setJson(store, key, day);

  return {
    ok: true,
    dateKey,
    observed,
    skipped,
    rows: day.rowCount,
    key
  };
}

function mergeObservationRow({
  previous,
  candidate,
  now,
  config
}) {
  const row = previous || {
    rowVersion: 2,

    symbol: candidate.symbol,
    side: candidate.side,
    stage: candidate.stage,
    setupClass: candidate.setupClass,
    reason: candidate.reason,

    parentFamilyId: candidate.parentFamilyId,
    analyzeFamilyId: candidate.analyzeFamilyId,
    analysisFamilyId: candidate.analysisFamilyId,
    familyId: candidate.familyId,
    familyIds: candidate.familyIds,

    microFamilyId: candidate.microFamilyId,
    microFamilyIds: candidate.microFamilyIds,
    rotationMicroFamilyId: candidate.rotationMicroFamilyId,
    analyzerMicroFamilyId: candidate.analyzerMicroFamilyId,

    firstSeenAt: now,
    lastSeenAt: now,
    seen: 0,

    entryPrice: candidate.entryPrice,
    lastPrice: candidate.currentPrice,
    riskAbs: candidate.riskAbs,
    targetR: candidate.targetR,

    maxR: 0,
    minR: 0,
    lastR: 0,

    terminal: null,
    terminalAt: null,
    outcomeR: null,

    maxScore: 0,
    maxConfluence: 0,
    maxSniperScore: 0,

    rsiZone: candidate.rsiZone,
    rsiEdge: candidate.rsiEdge,
    obBias: candidate.obBias,
    spreadPct: candidate.spreadPct,
    depthMinUsd1p: candidate.depthMinUsd1p
  };

  row.seen += 1;
  row.lastSeenAt = now;
  row.lastPrice = candidate.currentPrice;

  row.stage = candidate.stage || row.stage;
  row.reason = candidate.reason || row.reason;
  row.rsiZone = candidate.rsiZone || row.rsiZone;
  row.rsiEdge = candidate.rsiEdge || row.rsiEdge;
  row.obBias = candidate.obBias || row.obBias;

  row.parentFamilyId = row.parentFamilyId || candidate.parentFamilyId;
  row.analyzeFamilyId = row.analyzeFamilyId || candidate.analyzeFamilyId;
  row.analysisFamilyId = row.analysisFamilyId || candidate.analysisFamilyId;
  row.familyId = row.familyId || candidate.familyId;
  row.familyIds = unique([...(row.familyIds || []), ...(candidate.familyIds || [])]);

  row.microFamilyIds = unique([
    ...(row.microFamilyIds || []),
    ...(candidate.microFamilyIds || [])
  ]).slice(0, config.maxFamilyIdsPerCandidate);

  row.rotationMicroFamilyId = row.rotationMicroFamilyId || candidate.rotationMicroFamilyId;
  row.analyzerMicroFamilyId = row.analyzerMicroFamilyId || candidate.analyzerMicroFamilyId;

  row.maxScore = Math.max(num(row.maxScore), num(candidate.score));
  row.maxConfluence = Math.max(num(row.maxConfluence), num(candidate.confluence));
  row.maxSniperScore = Math.max(num(row.maxSniperScore), num(candidate.sniperScore));

  updateRPath(row, candidate.currentPrice, now);

  return row;
}

function updateRPath(row, price, now) {
  if (!Number.isFinite(price) || price <= 0) return row;
  if (!Number.isFinite(row.entryPrice) || row.entryPrice <= 0) return row;
  if (!Number.isFinite(row.riskAbs) || row.riskAbs <= 0) return row;

  const r =
    row.side === "LONG"
      ? (price - row.entryPrice) / row.riskAbs
      : (row.entryPrice - price) / row.riskAbs;

  row.lastR = r;
  row.maxR = Math.max(Number(row.maxR || 0), r);
  row.minR = Math.min(Number(row.minR || 0), r);

  if (!row.terminal && r <= -1) {
    row.terminal = "SL";
    row.terminalAt = now;
    row.outcomeR = -1;
  }

  if (!row.terminal && r >= row.targetR) {
    row.terminal = "TP";
    row.terminalAt = now;
    row.outcomeR = row.targetR;
  }

  return row;
}

// ================= DAILY / WEEKLY ROLLUP =================

export async function rollupDayToWeeklyStats({
  store,
  dateKey,
  config = {}
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };
  const todayKey = MICRO_FAMILY_KEYS.today(dateKey);

  const day = await getJson(store, todayKey, null);

  if (!day || !day.rows) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_DAY_ROWS",
      dateKey,
      rows: 0
    };
  }

  const weekId = toIsoWeekId(new Date(`${dateKey}T12:00:00.000Z`).getTime());
  const weeklyKey = MICRO_FAMILY_KEYS.weekly(weekId);

  const weekly = await getJson(
    store,
    weeklyKey,
    createEmptyWeeklyStats({
      weekId,
      strategyVersion: cfg.strategyVersion
    })
  );

  const dailySummary = createDailySummaryFromRows({
    dateKey,
    rows: Object.values(day.rows),
    config: cfg
  });

  mergeDailySummaryIntoWeekly({
    weekly,
    dailySummary
  });

  weekly.updatedAt = nowTs();

  await setJson(store, weeklyKey, weekly);

  if (cfg.deleteRawDayAfterRollup) {
    await deleteKey(store, todayKey);
  }

  return {
    ok: true,
    skipped: false,
    dateKey,
    weekId,
    rawRows: Object.keys(day.rows).length,
    familyRows: Object.keys(dailySummary.families).length,
    weeklyKey,
    deletedRaw: Boolean(cfg.deleteRawDayAfterRollup)
  };
}

export function createDailySummaryFromRows({
  dateKey,
  rows,
  config = {}
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };

  const daily = {
    schemaVersion: 2,
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,
    dateKey,
    createdAt: nowTs(),
    families: {}
  };

  for (const row of safeArray(rows)) {
    const finalized = finalizeObservationRow(row, cfg);

    if (!finalized) continue;

    const key = finalized.microFamilyId;

    if (!daily.families[key]) {
      daily.families[key] = createEmptyFamilyStats({
        microFamilyId: finalized.microFamilyId,
        parentFamilyId: finalized.parentFamilyId,
        side: finalized.side,
        setupClass: finalized.setupClass,
        reason: finalized.reason
      });
    }

    addOutcomeToFamilyStats(daily.families[key], finalized);
  }

  for (const family of Object.values(daily.families)) {
    finalizeFamilyStats(family);
  }

  return daily;
}

export function mergeDailySummaryIntoWeekly({
  weekly,
  dailySummary
} = {}) {
  if (!weekly || !dailySummary?.families) return weekly;

  weekly.dailyKeys = unique([...(weekly.dailyKeys || []), dailySummary.dateKey]);

  for (const family of Object.values(dailySummary.families)) {
    if (!weekly.families[family.microFamilyId]) {
      weekly.families[family.microFamilyId] = createEmptyFamilyStats({
        microFamilyId: family.microFamilyId,
        parentFamilyId: family.parentFamilyId,
        side: family.side,
        setupClass: family.setupClass,
        reason: family.reason
      });

      weekly.families[family.microFamilyId].days = [];
    }

    const target = weekly.families[family.microFamilyId];

    target.samples += family.samples;
    target.wins += family.wins;
    target.losses += family.losses;
    target.tpHits += family.tpHits;
    target.slHits += family.slHits;
    target.timeoutExits += family.timeoutExits;

    target.sumR += family.sumR;
    target.sumMfeR += family.sumMfeR;
    target.sumMaeR += family.sumMaeR;

    target.bestR =
      target.bestR == null
        ? family.bestR
        : Math.max(target.bestR, family.bestR ?? target.bestR);

    target.worstR =
      target.worstR == null
        ? family.worstR
        : Math.min(target.worstR, family.worstR ?? target.worstR);

    target.days.push({
      dateKey: dailySummary.dateKey,
      samples: family.samples,
      wins: family.wins,
      losses: family.losses,
      avgR: family.avgR,
      expectancyR: family.expectancyR
    });

    finalizeFamilyStats(target);
  }

  weekly.familyCount = Object.keys(weekly.families).length;
  weekly.sampleCount = Object.values(weekly.families)
    .reduce((sum, family) => sum + Number(family.samples || 0), 0);

  return weekly;
}

// ================= WEEKLY ROTATION =================

export async function buildAndSaveWeeklyRotation({
  store,
  sourceWeekId,
  targetWeekId,
  now = Date.now(),
  config = {}
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };
  const weekly = await getJson(store, MICRO_FAMILY_KEYS.weekly(sourceWeekId), null);

  const rotation = buildWeeklyRotationFromStats({
    weekly,
    sourceWeekId,
    targetWeekId,
    now,
    config: cfg
  });

  await setJson(store, MICRO_FAMILY_KEYS.activeRotation, rotation);
  await setJson(store, MICRO_FAMILY_KEYS.lastRotation, rotation);

  return rotation;
}

export function buildWeeklyRotationFromStats({
  weekly,
  sourceWeekId,
  targetWeekId,
  now = Date.now(),
  config = {}
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };

  if (!weekly || !weekly.families || !Object.keys(weekly.families).length) {
    return createBootstrapRotation({
      weekId: targetWeekId,
      sourceWeekId,
      targetWeekKey: targetWeekId,
      sourceWeekKey: sourceWeekId,
      now,
      strategyVersion: cfg.strategyVersion,
      reason: "NO_WEEKLY_STATS"
    });
  }

  const ranked = Object.values(weekly.families)
    .map(family => scoreWeeklyFamily(family, cfg))
    .filter(family => isCoreMicroFamilyId(family.microFamilyId))
    .sort((a, b) => b.rankScore - a.rankScore);

  const eligible = ranked.filter(family => {
    if (family.samples < cfg.minSamplesPerFamily) return false;
    if (family.winrate < cfg.minWinrate) return false;
    if (family.expectancyR < cfg.minExpectancyR) return false;
    if (family.avgMaeR > cfg.maxAvgMaeR) return false;
    return true;
  });

  const source = eligible.length
    ? eligible
    : ranked.slice(0, Math.min(cfg.fallbackTopFamiliesPerSide * 2, ranked.length));

  const longFamilies = source
    .filter(family => family.side === "LONG")
    .slice(0, cfg.topFamiliesPerSide);

  const shortFamilies = source
    .filter(family => family.side === "SHORT")
    .slice(0, cfg.topFamiliesPerSide);

  const selected = [...longFamilies, ...shortFamilies];

  if (!selected.length) {
    return createBootstrapRotation({
      weekId: targetWeekId,
      sourceWeekId,
      targetWeekKey: targetWeekId,
      sourceWeekKey: sourceWeekId,
      now,
      strategyVersion: cfg.strategyVersion,
      reason: "NO_SELECTED_FAMILIES"
    });
  }

  const selectedLongMicroFamilyIds = unique(longFamilies.map(family => family.microFamilyId));
  const selectedShortMicroFamilyIds = unique(shortFamilies.map(family => family.microFamilyId));
  const selectedMicroFamilyIds = unique([
    ...selectedLongMicroFamilyIds,
    ...selectedShortMicroFamilyIds
  ]);

  const selectedLongFamilyIds = unique(longFamilies.map(family => family.parentFamilyId));
  const selectedShortFamilyIds = unique(shortFamilies.map(family => family.parentFamilyId));
  const selectedFamilyIds = unique([
    ...selectedLongFamilyIds,
    ...selectedShortFamilyIds
  ]);

  const selectedFamilyMap = {};

  for (const family of selected) {
    selectedFamilyMap[family.microFamilyId] = {
      microFamilyId: family.microFamilyId,
      rotationMicroFamilyId: family.microFamilyId,
      analyzerMicroFamilyId: family.microFamilyId,

      parentFamilyId: family.parentFamilyId,
      analyzeFamilyId: family.parentFamilyId,
      analysisFamilyId: family.parentFamilyId,
      familyId: family.parentFamilyId,

      side: family.side,
      setupClass: family.setupClass,
      reason: family.reason,

      samples: family.samples,
      wins: family.wins,
      losses: family.losses,

      winrate: round4(family.winrate),
      expectancyR: round4(family.expectancyR),
      avgR: round4(family.avgR),
      avgMfeR: round4(family.avgMfeR),
      avgMaeR: round4(family.avgMaeR),
      rankScore: round4(family.rankScore),

      selected: true
    };
  }

  const rotationId = `MFO_WR_${cleanToken(targetWeekId, "NO_WEEK")}_${now}`;

  return {
    schemaVersion: "MFO_WR_V2_CANONICAL_CORE_MICRO",
    strategyVersion: cfg.strategyVersion,
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    mode: eligible.length ? "SELECTED" : "FALLBACK_TOP_RANKED",
    status: "ACTIVE",

    enabled: true,
    usable: true,
    strict: true,
    gateEnabled: true,

    rotationId,
    activeRotationId: rotationId,

    weekId: targetWeekId,
    targetWeekKey: targetWeekId,
    sourceWeekId,
    sourceWeekKey: sourceWeekId,

    selectedAt: now,
    createdAt: now,
    generatedAt: now,

    rotationIdBySide: {
      LONG: `ROT_${targetWeekId}_LONG_CANONICAL`,
      SHORT: `ROT_${targetWeekId}_SHORT_CANONICAL`
    },

    selectedMicroFamilyIds,
    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds,

    activeMicroFamilyIds: selectedMicroFamilyIds,
    allowedMicroFamilyIds: selectedMicroFamilyIds,
    realActiveMicroFamilyIds: selectedMicroFamilyIds,

    selectedFamilyIds,
    selectedLongFamilyIds,
    selectedShortFamilyIds,

    longFamilies,
    shortFamilies,

    selection: {
      long: {
        side: "LONG",
        microFamilyIds: selectedLongMicroFamilyIds,
        familyIds: selectedLongFamilyIds,
        topFamilies: longFamilies
      },
      short: {
        side: "SHORT",
        microFamilyIds: selectedShortMicroFamilyIds,
        familyIds: selectedShortFamilyIds,
        topFamilies: shortFamilies
      }
    },

    selectedFamilyMap,

    sourceStats: {
      totalFamilies: ranked.length,
      eligibleFamilies: eligible.length,
      selectedFamilies: selected.length,
      selectedLongFamilies: longFamilies.length,
      selectedShortFamilies: shortFamilies.length,
      totalSamples: ranked.reduce((sum, family) => sum + family.samples, 0)
    },

    config: cfg
  };
}

export function scoreWeeklyFamily(family, config = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };

  const microFamilyId = normalizeMicroFamilyId(family.microFamilyId);
  const parentFamilyId =
    normalizeAnalyzeFamilyId(family.parentFamilyId) ||
    normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(microFamilyId));

  const side =
    normalizeSide(family.side) ||
    getMicroSide(microFamilyId);

  const samples = Number(family.samples || 0);
  const winrate = samples > 0 ? family.wins / samples : 0;
  const avgR = samples > 0 ? family.sumR / samples : 0;
  const avgMfeR = samples > 0 ? family.sumMfeR / samples : 0;
  const avgMaeR = samples > 0 ? family.sumMaeR / samples : 0;

  const sampleConfidence = Math.min(
    1,
    Math.log10(samples + 1) / Math.log10((cfg.minSamplesPerFamily * 4) + 1)
  );

  const dayCount = Array.isArray(family.days) ? family.days.length : 0;
  const losingDays = Array.isArray(family.days)
    ? family.days.filter(day => Number(day.avgR || 0) < 0).length
    : 0;

  const lossClusterPenalty = dayCount > 0 ? losingDays / dayCount : 0;

  const rankScore =
    avgR * 40 +
    winrate * 25 +
    avgMfeR * 15 -
    avgMaeR * 15 +
    sampleConfidence * 10 -
    lossClusterPenalty * 20;

  return {
    ...family,

    microFamilyId,
    rotationMicroFamilyId: microFamilyId,
    analyzerMicroFamilyId: microFamilyId,

    parentFamilyId,
    analyzeFamilyId: parentFamilyId,
    analysisFamilyId: parentFamilyId,
    familyId: parentFamilyId,

    side,

    samples,
    winrate,
    avgR,
    expectancyR: avgR,
    avgMfeR,
    avgMaeR,
    sampleConfidence,
    lossClusterPenalty,
    rankScore
  };
}

// ================= STATS =================

function finalizeObservationRow(row, config) {
  if (!row?.microFamilyId || !row?.side) return null;

  const microFamilyId = normalizeMicroFamilyId(row.microFamilyId);

  if (!microFamilyId || !isCoreMicroFamilyId(microFamilyId)) {
    return null;
  }

  const side = normalizeSide(row.side) || getMicroSide(microFamilyId);

  if (side !== "LONG" && side !== "SHORT") {
    return null;
  }

  if (getMicroSide(microFamilyId) !== side) {
    return null;
  }

  const parentFamilyId =
    normalizeAnalyzeFamilyId(row.parentFamilyId) ||
    normalizeAnalyzeFamilyId(row.familyId) ||
    normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(microFamilyId));

  if (!parentFamilyId) return null;

  const targetR = Number(row.targetR || config.shadowTargetR);
  const terminal = row.terminal || "TIMEOUT";

  let outcomeR;

  if (Number.isFinite(row.outcomeR)) {
    outcomeR = row.outcomeR;
  } else {
    outcomeR = clamp(Number(row.lastR || 0), -1, targetR);
  }

  return {
    symbol: row.symbol,

    side,
    setupClass: row.setupClass,
    reason: row.reason,

    parentFamilyId,
    analyzeFamilyId: parentFamilyId,
    analysisFamilyId: parentFamilyId,
    familyId: parentFamilyId,

    microFamilyId,
    rotationMicroFamilyId: microFamilyId,
    analyzerMicroFamilyId: microFamilyId,

    terminal,
    outcomeR,

    mfeR: Math.max(0, Number(row.maxR || 0)),
    maeR: Math.abs(Math.min(0, Number(row.minR || 0))),

    score: Number(row.maxScore || 0),
    confluence: Number(row.maxConfluence || 0),
    sniperScore: Number(row.maxSniperScore || 0)
  };
}

function addOutcomeToFamilyStats(family, outcome) {
  family.samples += 1;

  if (outcome.outcomeR > 0) family.wins += 1;
  else family.losses += 1;

  if (outcome.terminal === "TP") family.tpHits += 1;
  else if (outcome.terminal === "SL") family.slHits += 1;
  else family.timeoutExits += 1;

  family.sumR += outcome.outcomeR;
  family.sumMfeR += outcome.mfeR;
  family.sumMaeR += outcome.maeR;

  family.bestR =
    family.bestR == null
      ? outcome.outcomeR
      : Math.max(family.bestR, outcome.outcomeR);

  family.worstR =
    family.worstR == null
      ? outcome.outcomeR
      : Math.min(family.worstR, outcome.outcomeR);
}

function finalizeFamilyStats(family) {
  const samples = Number(family.samples || 0);

  family.winrate = samples > 0 ? family.wins / samples : 0;
  family.avgR = samples > 0 ? family.sumR / samples : 0;
  family.expectancyR = family.avgR;
  family.avgMfeR = samples > 0 ? family.sumMfeR / samples : 0;
  family.avgMaeR = samples > 0 ? family.sumMaeR / samples : 0;

  family.bestR = family.bestR == null ? 0 : family.bestR;
  family.worstR = family.worstR == null ? 0 : family.worstR;

  return family;
}

function createEmptyFamilyStats({
  microFamilyId,
  parentFamilyId,
  side,
  setupClass,
  reason
}) {
  const canonicalMicroFamilyId = normalizeMicroFamilyId(microFamilyId);
  const canonicalParentFamilyId =
    normalizeAnalyzeFamilyId(parentFamilyId) ||
    normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(canonicalMicroFamilyId));

  return {
    microFamilyId: canonicalMicroFamilyId,
    rotationMicroFamilyId: canonicalMicroFamilyId,
    analyzerMicroFamilyId: canonicalMicroFamilyId,

    parentFamilyId: canonicalParentFamilyId,
    analyzeFamilyId: canonicalParentFamilyId,
    analysisFamilyId: canonicalParentFamilyId,
    familyId: canonicalParentFamilyId,

    side: normalizeSide(side) || getMicroSide(canonicalMicroFamilyId),
    setupClass,
    reason,

    samples: 0,
    wins: 0,
    losses: 0,

    tpHits: 0,
    slHits: 0,
    timeoutExits: 0,

    sumR: 0,
    sumMfeR: 0,
    sumMaeR: 0,

    bestR: null,
    worstR: null,

    winrate: 0,
    avgR: 0,
    expectancyR: 0,
    avgMfeR: 0,
    avgMaeR: 0
  };
}

// ================= STORE SHAPES =================

function createDefaultMeta({ dateKey, weekId, now }) {
  return {
    schemaVersion: 2,
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    activeDateKey: dateKey,
    activeWeekId: weekId,
    openDayKeys: [],

    createdAt: now,
    updatedAt: now,
    lastObservedAt: null,
    lastWeeklyRotationAt: null
  };
}

function createEmptyTodayStore({ dateKey, now, strategyVersion }) {
  return {
    schemaVersion: 2,
    strategyVersion,
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    dateKey,
    createdAt: now,
    updatedAt: now,

    rowCount: 0,
    rows: {}
  };
}

function createEmptyWeeklyStats({ weekId, strategyVersion }) {
  const ts = nowTs();

  return {
    schemaVersion: 2,
    strategyVersion,
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    weekId,
    sourceWeekKey: weekId,

    createdAt: ts,
    updatedAt: ts,

    dailyKeys: [],
    familyCount: 0,
    sampleCount: 0,

    families: {}
  };
}

function createBootstrapRotation({
  weekId,
  sourceWeekId = null,
  targetWeekKey = weekId,
  sourceWeekKey = sourceWeekId,
  now,
  strategyVersion,
  reason = "BOOTSTRAP_NO_WEEKLY_DATA"
}) {
  const rotationId = `MFO_WR_${cleanToken(targetWeekKey, "NO_WEEK")}_BOOTSTRAP`;

  return {
    schemaVersion: "MFO_WR_V2_CANONICAL_CORE_MICRO",
    strategyVersion,
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    mode: "BOOTSTRAP_ALLOW_ALL",
    status: "NO_DATA_BYPASS",
    reason,

    enabled: false,
    usable: false,
    strict: false,
    gateEnabled: false,

    rotationId,
    activeRotationId: rotationId,

    weekId: targetWeekKey,
    targetWeekKey,
    sourceWeekId,
    sourceWeekKey,

    selectedAt: now,
    createdAt: now,
    generatedAt: now,

    rotationIdBySide: {
      LONG: `ROT_${targetWeekKey}_LONG_BOOTSTRAP`,
      SHORT: `ROT_${targetWeekKey}_SHORT_BOOTSTRAP`
    },

    longFamilies: [],
    shortFamilies: [],

    selectedMicroFamilyIds: [],
    selectedLongMicroFamilyIds: [],
    selectedShortMicroFamilyIds: [],

    activeMicroFamilyIds: [],
    allowedMicroFamilyIds: [],
    realActiveMicroFamilyIds: [],

    selectedFamilyIds: [],
    selectedLongFamilyIds: [],
    selectedShortFamilyIds: [],

    selectedFamilyMap: {},

    selection: {
      long: {
        side: "LONG",
        microFamilyIds: [],
        familyIds: [],
        topFamilies: []
      },
      short: {
        side: "SHORT",
        microFamilyIds: [],
        familyIds: [],
        topFamilies: []
      }
    },

    sourceStats: {
      totalFamilies: 0,
      eligibleFamilies: 0,
      selectedFamilies: 0,
      selectedLongFamilies: 0,
      selectedShortFamilies: 0,
      totalSamples: 0
    }
  };
}

// ================= MISC =================

function enforceTodayCap(day, maxRows) {
  const rows = Object.entries(day.rows || {});
  const cap = Math.max(1, Number(maxRows || 1));

  if (rows.length <= cap) return;

  rows.sort((a, b) => {
    const rowA = a[1];
    const rowB = b[1];

    const qualityA =
      Number(rowA.maxConfluence || 0) +
      Number(rowA.maxSniperScore || 0) +
      Number(rowA.maxScore || 0);

    const qualityB =
      Number(rowB.maxConfluence || 0) +
      Number(rowB.maxSniperScore || 0) +
      Number(rowB.maxScore || 0);

    if (qualityB !== qualityA) return qualityB - qualityA;

    return Number(rowB.lastSeenAt || 0) - Number(rowA.lastSeenAt || 0);
  });

  day.rows = Object.fromEntries(rows.slice(0, cap));
  day.capped = true;
}

function buildTodayRowKey(candidate) {
  return [
    candidate.symbol,
    candidate.side,
    candidate.microFamilyId
  ].join("|");
}

function resolveRiskAbs({
  entryPrice,
  stopPrice,
  spreadPct,
  atrPct,
  config
}) {
  if (Number.isFinite(stopPrice) && stopPrice > 0) {
    const stopRisk = Math.abs(entryPrice - stopPrice);
    if (stopRisk > 0) return stopRisk;
  }

  const dynamicRiskPct = firstFinite([
    atrPct,
    Number.isFinite(spreadPct) ? spreadPct * 4 : null,
    config.fallbackRiskPct
  ]);

  const riskPct = clamp(dynamicRiskPct, config.minRiskPct, config.maxRiskPct);

  return entryPrice * riskPct;
}

export default {
  MICRO_FAMILY_KEYS,
  DEFAULT_MICRO_FAMILY_LEARNING_CONFIG,

  createMemoryJsonStore,

  runMicroFamilyLearningCycle,
  observeMicroFamilyCandidates,
  rollupDayToWeeklyStats,

  buildAndSaveWeeklyRotation,
  buildWeeklyRotationFromStats,

  createDailySummaryFromRows,
  mergeDailySummaryIntoWeekly,
  scoreWeeklyFamily,

  normalizeAnalyzeFamilyId,
  buildCoreMicroFamilyId,
  normalizeMicroFamilyId,
  extractParentFamilyIdFromMicroId,
  isCoreMicroFamilyId
};