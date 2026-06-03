// lib/rotation/weeklySelector.js

import { classifyAnalyzeEvent } from "../familyMicroAnalyzer.js";

// ================= CONFIG =================

const DEFAULT_SCHEMA_VERSION = "MF_V4_ANALYZE";

const MICRO_FAMILY_SCHEMA_VERSION =
  typeof process !== "undefined"
    ? process.env.MICRO_FAMILY_SCHEMA_VERSION || DEFAULT_SCHEMA_VERSION
    : DEFAULT_SCHEMA_VERSION;

const DEFAULT_CONFIG = {
  topPerSide: 2,
  maxFamiliesPerSide: 2,

  minCompletedSequence: [10, 5, 3, 1],
  minWinRate: 0,
  minExpectancyR: -999,
  minProfitFactor: 0,
  minDistinctSymbols: 0,

  sourceWeekOnly: false,
  lookbackDays: 0,

  expectancyWeight: 100,
  winRateWeight: 25,
  profitFactorWeight: 4,
  sampleSizeWeight: 6,
  recencyWeight: 3,

  maxProfitFactorScore: 5,
  maxTopFamilies: 30
};

const DAY_MS = 86_400_000;

const ANALYZE_FAMILY_ID_RE = /^(LONG|SHORT)_([1-9]|[1-4][0-9]|50)$/;

const CORE_MICRO_ID_RE =
  /^MICRO_(LONG|SHORT)_((?:LONG|SHORT)_(?:[1-9]|[1-4][0-9]|50))_([A-Z0-9_]+)_([A-Z0-9]+)$/;

// ================= BASIC HELPERS =================

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function flattenValues(values = []) {
  return values.flat(Infinity).filter(value => value !== undefined && value !== null);
}

function unique(values = []) {
  return Array.from(new Set(flattenValues(values).filter(Boolean)));
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toTimestamp(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;

  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;

  const parsed = Number(new Date(value));
  return Number.isFinite(parsed) ? parsed : fallback;
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

function normalizeSide(value) {
  const raw = String(value ?? "").toLowerCase();

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

// ================= CONFIG NORMALIZATION =================

function normalizeNumberArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return value
      .map(item => Number(item))
      .filter(Number.isFinite);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map(item => Number(item.trim()))
      .filter(Number.isFinite);
  }

  return fallback;
}

function normalizeConfig(userConfig = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...userConfig
  };

  const minCompletedSequence = normalizeNumberArray(
    merged.minCompletedSequence,
    DEFAULT_CONFIG.minCompletedSequence
  )
    .map(value => Math.max(1, Math.trunc(value)))
    .filter(Boolean);

  return {
    ...merged,

    topPerSide: Math.max(1, Math.trunc(toNumber(merged.topPerSide, 2))),
    maxFamiliesPerSide: Math.max(1, Math.trunc(toNumber(merged.maxFamiliesPerSide, 2))),

    minCompletedSequence: minCompletedSequence.length
      ? minCompletedSequence
      : DEFAULT_CONFIG.minCompletedSequence,

    minWinRate: toNumber(merged.minWinRate, 0),
    minExpectancyR: toNumber(merged.minExpectancyR, -999),
    minProfitFactor: toNumber(merged.minProfitFactor, 0),
    minDistinctSymbols: Math.max(0, Math.trunc(toNumber(merged.minDistinctSymbols, 0))),

    lookbackDays: Math.max(0, toNumber(merged.lookbackDays, 0)),

    expectancyWeight: toNumber(merged.expectancyWeight, DEFAULT_CONFIG.expectancyWeight),
    winRateWeight: toNumber(merged.winRateWeight, DEFAULT_CONFIG.winRateWeight),
    profitFactorWeight: toNumber(merged.profitFactorWeight, DEFAULT_CONFIG.profitFactorWeight),
    sampleSizeWeight: toNumber(merged.sampleSizeWeight, DEFAULT_CONFIG.sampleSizeWeight),
    recencyWeight: toNumber(merged.recencyWeight, DEFAULT_CONFIG.recencyWeight),

    maxProfitFactorScore: Math.max(1, toNumber(merged.maxProfitFactorScore, 5)),
    maxTopFamilies: Math.max(1, Math.trunc(toNumber(merged.maxTopFamilies, 30)))
  };
}

// ================= CANONICAL MICRO FAMILY IDS =================

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

function getMicroSide(microFamilyId) {
  const id = cleanToken(microFamilyId);

  if (id.startsWith("MICRO_LONG_")) return "LONG";
  if (id.startsWith("MICRO_SHORT_")) return "SHORT";

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

function inferAnalyzeFamilyIdFromParts(row = {}, side = null) {
  const normalizedSide = normalizeSide(side);

  if (!normalizedSide) return null;

  const familyNumber = normalizeFamilyNumber(
    row.familyNumber ??
      row.analyzeFamilyNumber ??
      row.analysisFamilyNumber ??
      row.parentFamilyNumber ??
      row.familyIndex ??
      row.analyzeFamilyIndex ??
      row.analysisFamilyIndex ??
      row.familyRank ??
      row.rank
  );

  if (!familyNumber) return null;

  return `${normalizedSide}_${familyNumber}`;
}

const ANALYZE_ID_PATHS = [
  "familyId",
  "familyIds",
  "families",
  "parentFamilyId",
  "analyzeFamilyId",
  "analysisFamilyId",
  "analyzerParentFamilyId",
  "mainFamilyId",

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

const MICRO_ID_PATHS = [
  "microFamilyId",
  "microFamily",
  "microFamilyIds",
  "microFamilies",
  "rotationMicroFamilyId",
  "analyzerMicroFamilyId",
  "scannerMicroFamilyId",

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

function collectPathValues(row = {}, paths = []) {
  return paths.map(path => getNestedValue(row, path));
}

function extractAnalyzeFamilyId(row = {}, family = {}) {
  const side =
    normalizeSide(row.tradeSide) ||
    normalizeSide(row.rotationSide) ||
    normalizeSide(row.side) ||
    normalizeSide(row.direction) ||
    normalizeSide(family.side);

  const direct = unique([
    collectPathValues(row, ANALYZE_ID_PATHS),
    family.familyId,
    family.familyIds,
    family.parentFamilyId,
    family.analyzeFamilyId,
    family.analysisFamilyId,
    family.analyzerParentFamilyId
  ])
    .map(normalizeAnalyzeFamilyId)
    .find(Boolean);

  if (direct) return direct;

  const fromMicro = unique([
    collectPathValues(row, MICRO_ID_PATHS),
    family.microFamilyId,
    family.microFamily,
    family.microFamilyIds,
    family.microFamilies,
    family.rotationMicroFamilyId,
    family.analyzerMicroFamilyId
  ])
    .map(extractParentFamilyIdFromMicroId)
    .map(normalizeAnalyzeFamilyId)
    .find(Boolean);

  if (fromMicro) return fromMicro;

  return inferAnalyzeFamilyIdFromParts(row, side);
}

function extractCanonicalMicroFamilyId(row = {}, family = {}) {
  const fromDirectMicro = unique([
    collectPathValues(row, MICRO_ID_PATHS),
    family.microFamilyId,
    family.microFamily,
    family.microFamilyIds,
    family.microFamilies,
    family.rotationMicroFamilyId,
    family.analyzerMicroFamilyId
  ])
    .map(normalizeMicroFamilyId)
    .find(Boolean);

  if (fromDirectMicro) return fromDirectMicro;

  const analyzeFamilyId = extractAnalyzeFamilyId(row, family);
  return buildCoreMicroFamilyId(analyzeFamilyId);
}

// ================= OUTCOME EXTRACTION =================

function isWin(row = {}) {
  const result = String(row.result ?? row.outcome ?? row.status ?? "").toUpperCase();

  if (["WIN", "WON", "TP", "PROFIT", "GREEN", "TAKE_PROFIT"].includes(result)) return true;
  if (["LOSS", "LOST", "SL", "RED", "STOP_LOSS"].includes(result)) return false;

  const pnl =
    row.pnlR ??
    row.realizedR ??
    row.profitR ??
    row.rrResult ??
    row.rMultiple ??
    row.pnl ??
    row.realizedPnl ??
    row.netPnl ??
    row.profit;

  if (pnl === undefined || pnl === null || pnl === "") return null;

  return toNumber(pnl) > 0;
}

function extractR(row = {}) {
  const direct =
    row.pnlR ??
    row.realizedR ??
    row.profitR ??
    row.rMultiple ??
    row.rrResult ??
    row.netR;

  if (direct !== undefined && direct !== null && direct !== "") {
    const n = Number(direct);
    if (Number.isFinite(n)) return n;
  }

  const win = isWin(row);
  if (win === true) return 1;
  if (win === false) return -1;

  const pnl = row.pnl ?? row.realizedPnl ?? row.netPnl ?? row.profit;

  if (pnl !== undefined && pnl !== null && pnl !== "") {
    const n = Number(pnl);

    if (Number.isFinite(n)) {
      if (n > 0) return 1;
      if (n < 0) return -1;
      return 0;
    }
  }

  return null;
}

function isCompletedRow(row = {}) {
  if (!row || typeof row !== "object") return false;

  if (row.closed === true) return true;
  if (row.isClosed === true) return true;
  if (row.completed === true) return true;
  if (row.isCompleted === true) return true;

  if (
    row.exitTs ||
    row.closedAt ||
    row.exitAt ||
    row.exitTime ||
    row.closeTime ||
    row.completedAt
  ) {
    return true;
  }

  const type = String(row.type ?? row.action ?? row.actionType ?? "").toUpperCase();
  if (type.includes("EXIT") || type.includes("CLOSE")) return true;

  return extractR(row) !== null && isWin(row) !== null;
}

function rowMatchesSourceWeek(row = {}, sourceWeekKey = null) {
  if (!sourceWeekKey) return true;

  const candidates = [
    row.weekKey,
    row.sourceWeekKey,
    row.activeWeekKey,
    row.closedWeekKey,
    row.exitWeekKey,
    row.rotationWeekKey
  ]
    .filter(Boolean)
    .map(cleanToken);

  if (!candidates.length) return true;

  return candidates.includes(cleanToken(sourceWeekKey));
}

function rowMatchesLookback(row = {}, now = Date.now(), lookbackDays = 0) {
  if (!lookbackDays) return true;

  const ts = toTimestamp(
    row.exitTs ??
      row.closedAt ??
      row.exitAt ??
      row.exitTime ??
      row.closeTime ??
      row.completedAt ??
      row.ts ??
      row.createdAt,
    0
  );

  if (!ts) return true;

  const cutoff = toTimestamp(now, Date.now()) - lookbackDays * DAY_MS;

  return ts >= cutoff;
}

function normalizeOutcomeRow(row = {}, opts = {}) {
  if (!isCompletedRow(row)) {
    return null;
  }

  if (opts.sourceWeekOnly && !rowMatchesSourceWeek(row, opts.sourceWeekKey)) {
    return null;
  }

  if (!rowMatchesLookback(row, opts.now, opts.lookbackDays)) {
    return null;
  }

  const family = classifyAnalyzeEvent(row, {
    weekKey: opts.targetWeekKey || opts.weekKey || opts.sourceWeekKey
  });

  const side =
    normalizeSide(row.tradeSide) ||
    normalizeSide(row.rotationSide) ||
    normalizeSide(row.side) ||
    normalizeSide(row.direction) ||
    normalizeSide(family.side);

  if (side !== "LONG" && side !== "SHORT") {
    return null;
  }

  const microFamilyId = extractCanonicalMicroFamilyId(row, family);

  if (!microFamilyId || !isCoreMicroFamilyId(microFamilyId)) {
    return null;
  }

  if (getMicroSide(microFamilyId) !== side) {
    return null;
  }

  const parentFamilyId =
    normalizeAnalyzeFamilyId(extractParentFamilyIdFromMicroId(microFamilyId)) ||
    extractAnalyzeFamilyId(row, family);

  if (!parentFamilyId) {
    return null;
  }

  const r = extractR(row);
  if (r === null) return null;

  const win = isWin(row);
  if (win === null) return null;

  const ts = toTimestamp(
    row.exitTs ??
      row.closedAt ??
      row.exitAt ??
      row.exitTime ??
      row.closeTime ??
      row.completedAt ??
      row.ts ??
      row.createdAt,
    0
  );

  return {
    raw: row,

    side,
    microFamilyId,
    parentFamilyId,

    setupClass: family.setupClass,
    scannerStage: family.scannerStage,
    reason: family.reason,
    rsiEdge: family.rsiEdge,
    rsiBias: family.rsiBias,

    symbol: normalizeSymbol(row.symbol ?? row.baseCoin ?? row.instId ?? family.symbol),

    win,
    r,
    ts
  };
}

// ================= GROUPING / SCORING =================

function buildInitialFamily(row) {
  return {
    microFamilyId: row.microFamilyId,
    parentFamilyId: row.parentFamilyId,

    side: row.side,
    setupClass: row.setupClass,
    scannerStage: row.scannerStage,
    reason: row.reason,
    rsiEdge: row.rsiEdge,
    rsiBias: row.rsiBias,

    completed: 0,
    wins: 0,
    losses: 0,

    totalR: 0,
    grossWinR: 0,
    grossLossR: 0,
    bestR: -Infinity,
    worstR: Infinity,

    lastTs: 0,
    firstTs: 0,

    symbols: new Set(),
    recentRows: []
  };
}

function finalizeFamily(family, config, now = Date.now()) {
  const completed = family.completed;
  const winRate = completed > 0 ? family.wins / completed : 0;
  const lossRate = completed > 0 ? family.losses / completed : 0;
  const expectancyR = completed > 0 ? family.totalR / completed : 0;

  const averageWinR = family.wins > 0 ? family.grossWinR / family.wins : 0;
  const averageLossR = family.losses > 0 ? family.grossLossR / family.losses : 0;

  const profitFactor =
    family.grossLossR > 0
      ? family.grossWinR / family.grossLossR
      : family.grossWinR > 0
        ? 99
        : 0;

  const distinctSymbols = family.symbols.size;
  const stability = Math.log1p(completed);
  const pfScore = Math.min(profitFactor, config.maxProfitFactorScore) * config.profitFactorWeight;

  const ageDays =
    family.lastTs > 0
      ? Math.max(0, (toTimestamp(now, Date.now()) - family.lastTs) / DAY_MS)
      : 999;

  const recencyScore =
    family.lastTs > 0
      ? Math.max(0, 1 / (1 + ageDays / 7)) * config.recencyWeight
      : 0;

  const score =
    expectancyR * config.expectancyWeight +
    winRate * config.winRateWeight +
    pfScore +
    stability * config.sampleSizeWeight +
    recencyScore;

  return {
    ...family,

    symbols: [...family.symbols].slice(0, 20),
    recentRows: family.recentRows.slice(-10),

    winRate,
    lossRate,
    expectancyR,
    averageWinR,
    averageLossR,
    profitFactor,

    bestR: Number.isFinite(family.bestR) ? family.bestR : 0,
    worstR: Number.isFinite(family.worstR) ? family.worstR : 0,

    distinctSymbols,
    ageDays,
    recencyScore,
    score
  };
}

function groupRows(rows = [], config = DEFAULT_CONFIG, now = Date.now()) {
  const map = new Map();

  for (const row of rows) {
    const current = map.get(row.microFamilyId) ?? buildInitialFamily(row);

    current.completed += 1;
    current.wins += row.win ? 1 : 0;
    current.losses += row.win ? 0 : 1;

    current.totalR += row.r;

    if (row.r > 0) current.grossWinR += row.r;
    if (row.r < 0) current.grossLossR += Math.abs(row.r);

    current.bestR = Math.max(current.bestR, row.r);
    current.worstR = Math.min(current.worstR, row.r);

    current.lastTs = Math.max(current.lastTs, row.ts || 0);
    current.firstTs = current.firstTs
      ? Math.min(current.firstTs, row.ts || current.firstTs)
      : row.ts || 0;

    if (row.symbol) current.symbols.add(row.symbol);

    current.recentRows.push({
      symbol: row.symbol,
      r: row.r,
      win: row.win,
      ts: row.ts
    });

    map.set(row.microFamilyId, current);
  }

  return [...map.values()]
    .map(family => finalizeFamily(family, config, now))
    .sort(compareFamilies);
}

function compareFamilies(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.expectancyR !== a.expectancyR) return b.expectancyR - a.expectancyR;
  if (b.winRate !== a.winRate) return b.winRate - a.winRate;
  if (b.completed !== a.completed) return b.completed - a.completed;
  if (b.lastTs !== a.lastTs) return b.lastTs - a.lastTs;

  return String(a.microFamilyId).localeCompare(String(b.microFamilyId));
}

// ================= SELECTION =================

function isEligibleFamily(family, minCompleted, config) {
  if (family.completed < minCompleted) return false;
  if (family.winRate < config.minWinRate) return false;
  if (family.expectancyR < config.minExpectancyR) return false;
  if (family.profitFactor < config.minProfitFactor) return false;
  if (family.distinctSymbols < config.minDistinctSymbols) return false;

  return true;
}

function selectSide(families = [], side, config) {
  const limit = Math.min(config.topPerSide, config.maxFamiliesPerSide);

  const sideFamilies = families
    .filter(family => family.side === side)
    .sort(compareFamilies);

  for (const minCompleted of config.minCompletedSequence) {
    const eligible = sideFamilies.filter(family =>
      isEligibleFamily(family, minCompleted, config)
    );

    if (eligible.length > 0) {
      const topFamilies = eligible.slice(0, limit);

      return {
        side,
        minCompletedUsed: minCompleted,

        microFamilyIds: topFamilies.map(family => family.microFamilyId),
        familyIds: topFamilies.map(family => family.parentFamilyId).filter(Boolean),

        topFamilies,

        eligibleFamilyCount: eligible.length,
        totalFamilyCount: sideFamilies.length
      };
    }
  }

  return {
    side,
    minCompletedUsed: null,

    microFamilyIds: [],
    familyIds: [],

    topFamilies: [],

    eligibleFamilyCount: 0,
    totalFamilyCount: sideFamilies.length
  };
}

// ================= MAIN =================

export function selectWeeklyRotation({
  rows = [],
  sourceWeekKey,
  targetWeekKey,
  now = Date.now(),
  config: userConfig = {}
} = {}) {
  const config = normalizeConfig(userConfig);

  const normalized = safeArray(rows)
    .map(row =>
      normalizeOutcomeRow(row, {
        weekKey: targetWeekKey,
        targetWeekKey,
        sourceWeekKey,
        now,
        sourceWeekOnly: Boolean(config.sourceWeekOnly),
        lookbackDays: config.lookbackDays
      })
    )
    .filter(Boolean);

  const families = groupRows(normalized, config, now);

  const long = selectSide(families, "LONG", config);
  const short = selectSide(families, "SHORT", config);

  const selectedLongMicroFamilyIds = unique(long.microFamilyIds);
  const selectedShortMicroFamilyIds = unique(short.microFamilyIds);

  const selectedMicroFamilyIds = unique([
    ...selectedLongMicroFamilyIds,
    ...selectedShortMicroFamilyIds
  ]);

  const selectedFamilyIds = unique([
    ...long.familyIds,
    ...short.familyIds
  ]);

  const usable = selectedMicroFamilyIds.length > 0;
  const createdAt = toTimestamp(now, Date.now());

  return {
    schemaVersion: "WR_V3_CANONICAL_CORE_MICRO",
    microFamilySchemaVersion: MICRO_FAMILY_SCHEMA_VERSION,

    rotationId: `WR_${cleanToken(targetWeekKey, "NO_WEEK")}_${createdAt}`,

    status: usable ? "ACTIVE" : "NO_DATA_BYPASS",

    enabled: usable,
    strict: usable,
    usable,

    createdAt,
    generatedAt: createdAt,

    sourceWeekKey,
    targetWeekKey,

    selectedMicroFamilyIds,
    selectedLongMicroFamilyIds,
    selectedShortMicroFamilyIds,

    selectedFamilyIds,
    selectedLongFamilyIds: unique(long.familyIds),
    selectedShortFamilyIds: unique(short.familyIds),

    selectedMicroFamilyCount: selectedMicroFamilyIds.length,
    selectedLongMicroFamilyCount: selectedLongMicroFamilyIds.length,
    selectedShortMicroFamilyCount: selectedShortMicroFamilyIds.length,

    selection: {
      long,
      short
    },

    stats: {
      rowsReceived: safeArray(rows).length,
      completedRows: normalized.length,

      totalFamilies: families.length,
      longFamilies: families.filter(family => family.side === "LONG").length,
      shortFamilies: families.filter(family => family.side === "SHORT").length,

      selectedFamilies: selectedMicroFamilyIds.length,
      selectedLongFamilies: selectedLongMicroFamilyIds.length,
      selectedShortFamilies: selectedShortMicroFamilyIds.length,

      skippedRows: Math.max(0, safeArray(rows).length - normalized.length)
    },

    config,

    topFamilies: families.slice(0, config.maxTopFamilies)
  };
}

export default selectWeeklyRotation;