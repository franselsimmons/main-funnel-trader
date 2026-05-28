// lib/microRotationLearning.js

import { attachMicroRotationKeys } from "./microRotationGate.js";

export const MICRO_LEARNING_VERSION = "MRL_V2_WINRATE_FIRST_WEIGHTED_SAMPLE";

const DEFAULTS = {
  maxExamplesPerFamily: 8,
  maxProcessedOutcomeIds: 2500,

  // Minimaal aantal gesloten outcomes voordat een familie "echt" weekly-active mag worden.
  // Bootstrap op seen mag nog wel, maar krijgt lagere prioriteit.
  minCompletedForActive: 8,
  minSeenForBootstrap: 20,

  maxActiveFamiliesTotal: 16,
  maxActiveFamiliesPerSide: 8,

  maxOpenShadowRowsAfterCompact: 1200,
  maxClosedRowsAfterCompact: 250,
  maxFeatureRowsAfterCompact: 0,

  allowBootstrapFromSeen: true,

  // Winrate-first ranking:
  // Wilson lower bound corrigeert 10 trades vs 100 trades.
  // 1.645 = ongeveer 90% confidence. Direct genoeg voor weekly rotation.
  winrateWilsonZ: 1.645,

  // Bayesian shrink: kleine samples worden richting baseline getrokken.
  baselineWinrate: 0.50,
  bayesianPriorTrades: 20,

  // Vanaf dit aantal is sample-confidence bijna volledig.
  highConfidenceCompleted: 40,

  // PnL/R is niet de hoofdscore. Alleen lichte guard/tiebreaker.
  maxRBonusWeight: 2.0,
  maxRPenaltyWeight: 6.0,
};

const toNum = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
};

const cleanKey = value => {
  const raw = String(value ?? "UNKNOWN").trim().toUpperCase();

  return raw
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "UNKNOWN";
};

const normalizeBaseSymbol = raw => String(raw || "")
  .toUpperCase()
  .trim()
  .replace(/_UMCBL$/, "")
  .replace(/_DMCBL$/, "")
  .replace(/_CMCBL$/, "")
  .replace(/-UMCBL$/, "")
  .replace(/-DMCBL$/, "")
  .replace(/-CMCBL$/, "")
  .replace(/USDT$/, "")
  .replace(/USDC$/, "");

const pct = value => `${(Number(value || 0) * 100).toFixed(1)}%`;

const getUtcDate = ts => new Date(toNum(ts, Date.now()));

export const getDayKey = (ts = Date.now()) => {
  const d = getUtcDate(ts);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};

export const getWeekKey = (ts = Date.now()) => {
  const d = getUtcDate(ts);
  const day = d.getUTCDay() || 7;

  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);

  return `${d.getUTCFullYear()}W${String(weekNo).padStart(2, "0")}`;
};

export const getPeriodKeys = (ts = Date.now()) => ({
  dayKey: getDayKey(ts),
  weekKey: getWeekKey(ts),
});

const createTotals = () => ({
  seen: 0,
  entries: 0,
  exits: 0,
  completed: 0,
  wins: 0,
  losses: 0,
  flats: 0,
  totalR: 0,
  totalPnlPct: 0,
});

const createPeriodSummary = ({ type, key, ts = Date.now() }) => ({
  version: MICRO_LEARNING_VERSION,
  type,
  key,
  startedAt: ts,
  updatedAt: ts,
  totals: createTotals(),
  families: {},
  topFamilies: [],
});

const createActiveRotation = ({ weekKey, ts = Date.now() }) => ({
  version: MICRO_LEARNING_VERSION,
  rotationId: `ROT_${cleanKey(weekKey)}_MICRO_WINRATE_BEST`,
  weekKey,
  createdAt: ts,
  updatedAt: ts,
  source: "MICRO_LEARNING_WINRATE_FIRST",
  rankingMode: "WINRATE_WILSON_FIRST",
  bootstrap: true,
  microFamilyIds: [],
  activeMicroFamilyIds: [],
  allowedMicroFamilyIds: [],
  families: [],
  longFamilies: [],
  shortFamilies: [],
  meta: {
    minCompletedForActive: DEFAULTS.minCompletedForActive,
    minSeenForBootstrap: DEFAULTS.minSeenForBootstrap,
    maxActiveFamiliesTotal: DEFAULTS.maxActiveFamiliesTotal,
    winrateWilsonZ: DEFAULTS.winrateWilsonZ,
    baselineWinrate: DEFAULTS.baselineWinrate,
    bayesianPriorTrades: DEFAULTS.bayesianPriorTrades,
  },
});

export const createMicroLearningState = (ts = Date.now()) => {
  const { dayKey, weekKey } = getPeriodKeys(ts);

  return {
    version: MICRO_LEARNING_VERSION,
    createdAt: ts,
    updatedAt: ts,

    activeDayKey: dayKey,
    activeWeekKey: weekKey,

    daily: createPeriodSummary({ type: "DAY", key: dayKey, ts }),
    week: createPeriodSummary({ type: "WEEK", key: weekKey, ts }),

    activeRotation: createActiveRotation({ weekKey, ts }),

    lastCompletedDay: null,
    lastCompletedWeek: null,

    processedOutcomeIds: [],
  };
};

const normalizePeriodSummary = (summary, type, key, ts = Date.now()) => {
  const base = createPeriodSummary({ type, key, ts });
  const source = summary && typeof summary === "object" ? summary : {};

  return {
    ...base,
    ...source,
    version: MICRO_LEARNING_VERSION,
    type: source.type || type,
    key: source.key || key,
    totals: {
      ...createTotals(),
      ...(source.totals && typeof source.totals === "object" ? source.totals : {}),
    },
    families: source.families && typeof source.families === "object"
      ? source.families
      : {},
    topFamilies: Array.isArray(source.topFamilies) ? source.topFamilies : [],
  };
};

export const normalizeMicroLearningState = (state, ts = Date.now()) => {
  if (!state || typeof state !== "object") {
    return createMicroLearningState(ts);
  }

  const { dayKey, weekKey } = getPeriodKeys(ts);

  const normalized = {
    ...createMicroLearningState(ts),
    ...state,
    version: MICRO_LEARNING_VERSION,
  };

  normalized.activeDayKey = state.activeDayKey || dayKey;
  normalized.activeWeekKey = state.activeWeekKey || weekKey;

  normalized.daily = normalizePeriodSummary(
    state.daily,
    "DAY",
    normalized.activeDayKey,
    ts
  );

  normalized.week = normalizePeriodSummary(
    state.week,
    "WEEK",
    normalized.activeWeekKey,
    ts
  );

  normalized.activeRotation = {
    ...createActiveRotation({ weekKey: normalized.activeWeekKey, ts }),
    ...(state.activeRotation && typeof state.activeRotation === "object" ? state.activeRotation : {}),
    version: MICRO_LEARNING_VERSION,
  };

  normalized.processedOutcomeIds = Array.isArray(state.processedOutcomeIds)
    ? state.processedOutcomeIds.slice(-DEFAULTS.maxProcessedOutcomeIds)
    : [];

  return normalized;
};

const isSpecificMicroFamily = id => {
  const key = cleanKey(id);

  if (!key.startsWith("MF_")) return false;

  const parts = key.split("_");

  if (parts.length < 6) return false;
  if (["MF_LONG", "MF_SHORT"].includes(key)) return false;
  if (/^MF_(LONG|SHORT)_(ENTRY|ALMOST|HOLD|EXIT)$/.test(key)) return false;
  if (/^MF_(LONG|SHORT)_(GOD|A|B|C)$/.test(key)) return false;

  return true;
};

const familySpecificityScore = id => {
  const key = cleanKey(id);
  const parts = key.split("_");

  let score = Math.min(parts.length, 12);

  if (key.includes("_RSI_")) score += 4;
  if (key.includes("_BULLISH") || key.includes("_BEARISH") || key.includes("_NEUTRAL")) score += 2;
  if (key.includes("_SPREAD_") || key.includes("_DEPTH_")) score += 1;
  if (key.includes("_SCORE_")) score -= 2;
  if (!isSpecificMicroFamily(key)) score -= 8;

  return score;
};

const getFamilyIdsForLearning = row => {
  const enriched = attachMicroRotationKeys(row || {});
  const ids = Array.isArray(enriched.microFamilyIds) ? enriched.microFamilyIds : [];

  const specific = ids.filter(isSpecificMicroFamily);

  return specific.length ? specific.slice(0, 4) : ids.slice(0, 1);
};

const createFamilyStats = ({ id, row, ts = Date.now() }) => {
  const side = String(row?.side || "").toLowerCase();
  const setupClass = cleanKey(row?.setupClass || "UNKNOWN");
  const reason = cleanKey(row?.reason || row?.entryReason || row?.entryType || "UNKNOWN");

  return {
    id: cleanKey(id),
    side,
    rotationSide: side === "bull" ? "LONG" : side === "bear" ? "SHORT" : "UNKNOWN",
    setupClass,
    reason,

    firstSeenAt: ts,
    lastSeenAt: ts,

    seen: 0,
    entries: 0,
    exits: 0,
    completed: 0,
    wins: 0,
    losses: 0,
    flats: 0,

    totalR: 0,
    totalPnlPct: 0,

    rawWinrateNum: 0,
    rawWinrate: "0.0%",

    // Hoofd-ranking:
    // Kleine sample wordt automatisch lager gewaardeerd.
    winrateWilsonLower: 0,
    winrateWilson: "0.0%",
    bayesianWinrateNum: 0,
    bayesianWinrate: "0.0%",
    sampleConfidence: 0,

    avgR: 0,
    avgPnlPct: 0,
    profitFactorR: 0,
    expectancyR: 0,

    directSL: 0,
    nearTpSeen: 0,
    reachedHalfR: 0,
    reachedOneR: 0,

    score: 0,
    confidence: "LOW",
    specificity: familySpecificityScore(id),

    rsiZones: {},
    obBiases: {},
    btcStates: {},
    reasons: {},
    setupClasses: {},
    symbols: {},
    examples: [],
  };
};

const addCount = (obj, key, by = 1) => {
  const k = cleanKey(key || "UNKNOWN");
  obj[k] = toNum(obj[k], 0) + by;
};

const ensureFamily = (period, id, row, ts) => {
  const key = cleanKey(id);

  if (!period.families[key]) {
    period.families[key] = createFamilyStats({ id: key, row, ts });
  }

  return period.families[key];
};

const wilsonLowerBound = ({ wins, total, z = DEFAULTS.winrateWilsonZ }) => {
  const n = toNum(total, 0);
  const w = toNum(wins, 0);

  if (n <= 0) return 0;

  const p = clamp(w / n, 0, 1);
  const z2 = z * z;

  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const denom = 1 + z2 / n;

  return clamp((center - margin) / denom, 0, 1);
};

const bayesianWinrate = ({
  wins,
  total,
  baseline = DEFAULTS.baselineWinrate,
  priorTrades = DEFAULTS.bayesianPriorTrades,
}) => {
  const n = toNum(total, 0);
  const w = toNum(wins, 0);
  const prior = Math.max(0, toNum(priorTrades, 20));
  const base = clamp(baseline, 0, 1);

  return clamp((w + base * prior) / Math.max(1, n + prior), 0, 1);
};

const getConfidenceLabel = completed => {
  const n = toNum(completed, 0);

  if (n >= 40) return "HIGH";
  if (n >= 20) return "MEDIUM";
  if (n >= 8) return "LOW_PLUS";
  if (n >= 3) return "LOW";

  return "BOOTSTRAP";
};

const getWinrateScore = (family, cfg = DEFAULTS) => {
  const wins = toNum(family.wins, 0);
  const losses = toNum(family.losses, 0);
  const completed = wins + losses;

  const rawWinrateNum = completed ? wins / completed : 0;
  const winrateWilsonLower = wilsonLowerBound({
    wins,
    total: completed,
    z: cfg.winrateWilsonZ,
  });

  const bayes = bayesianWinrate({
    wins,
    total: completed,
    baseline: cfg.baselineWinrate,
    priorTrades: cfg.bayesianPriorTrades,
  });

  const sampleConfidence = clamp(
    completed / Math.max(1, cfg.highConfidenceCompleted),
    0,
    1
  );

  return {
    completed,
    rawWinrateNum: Number(rawWinrateNum.toFixed(4)),
    rawWinrate: pct(rawWinrateNum),

    winrateWilsonLower: Number(winrateWilsonLower.toFixed(4)),
    winrateWilson: pct(winrateWilsonLower),

    bayesianWinrateNum: Number(bayes.toFixed(4)),
    bayesianWinrate: pct(bayes),

    sampleConfidence: Number(sampleConfidence.toFixed(4)),
  };
};

const updateFamilyDerivedStats = (family, options = {}) => {
  const cfg = { ...DEFAULTS, ...options };

  const completed = toNum(family.completed, 0);
  const wins = toNum(family.wins, 0);
  const losses = toNum(family.losses, 0);
  const totalR = toNum(family.totalR, 0);
  const totalPnlPct = toNum(family.totalPnlPct, 0);

  family.avgR = completed ? Number((totalR / completed).toFixed(3)) : 0;
  family.avgPnlPct = completed ? Number((totalPnlPct / completed).toFixed(3)) : 0;

  const winrateMeta = getWinrateScore(family, cfg);

  family.rawWinrateNum = winrateMeta.rawWinrateNum;
  family.rawWinrate = winrateMeta.rawWinrate;

  family.winrateWilsonLower = winrateMeta.winrateWilsonLower;
  family.winrateWilson = winrateMeta.winrateWilson;

  family.bayesianWinrateNum = winrateMeta.bayesianWinrateNum;
  family.bayesianWinrate = winrateMeta.bayesianWinrate;

  family.sampleConfidence = winrateMeta.sampleConfidence;

  const avgWinR = wins && totalR > 0 ? totalR / wins : 0;
  const avgLossR = losses && totalR < 0 ? Math.abs(totalR / losses) : 0;

  family.profitFactorR =
    avgLossR > 0
      ? Number((avgWinR / avgLossR).toFixed(3))
      : avgWinR > 0
        ? 999
        : 0;

  family.expectancyR = family.avgR;

  const directSLPct = completed
    ? toNum(family.directSL, 0) / completed
    : 0;

  // Main focus = winrateWilsonLower.
  // PnL/R heeft bewust lage impact.
  const rBonus = Math.max(0, clamp(family.avgR, 0, 1)) * cfg.maxRBonusWeight;
  const rPenalty = Math.abs(Math.min(0, clamp(family.avgR, -1, 0))) * cfg.maxRPenaltyWeight;

  family.score = Number((
    family.winrateWilsonLower * 100 +
    family.bayesianWinrateNum * 10 +
    family.sampleConfidence * 5 +
    family.specificity * 0.15 +
    rBonus -
    rPenalty -
    directSLPct * 10
  ).toFixed(3));

  family.confidence = getConfidenceLabel(completed);

  return family;
};

const sortFamiliesWinrateFirst = (families, options = {}) => {
  const cfg = { ...DEFAULTS, ...options };

  return [...families]
    .map(f => updateFamilyDerivedStats(f, cfg))
    .sort((a, b) => {
      const aCompleted = toNum(a.completed, 0);
      const bCompleted = toNum(b.completed, 0);

      const aBootstrap = aCompleted < cfg.minCompletedForActive ? 1 : 0;
      const bBootstrap = bCompleted < cfg.minCompletedForActive ? 1 : 0;

      // Echte completed families altijd boven bootstrap families.
      if (aBootstrap !== bBootstrap) return aBootstrap - bBootstrap;

      // Hoofd-ranking: sample-size gecorrigeerde winrate.
      const wilsonDiff = toNum(b.winrateWilsonLower, 0) - toNum(a.winrateWilsonLower, 0);
      if (wilsonDiff !== 0) return wilsonDiff;

      // Tweede: Bayesian winrate, kleine samples blijven geshrinkt.
      const bayesDiff = toNum(b.bayesianWinrateNum, 0) - toNum(a.bayesianWinrateNum, 0);
      if (bayesDiff !== 0) return bayesDiff;

      // Derde: grotere sample wint bij gelijke winrate-quality.
      const sampleDiff = bCompleted - aCompleted;
      if (sampleDiff !== 0) return sampleDiff;

      // Vierde: lichte total score.
      const scoreDiff = toNum(b.score, 0) - toNum(a.score, 0);
      if (scoreDiff !== 0) return scoreDiff;

      return toNum(b.seen, 0) - toNum(a.seen, 0);
    });
};

const rebuildTopFamilies = (period, options = {}) => {
  const rows = sortFamiliesWinrateFirst(Object.values(period.families || {}), options);

  period.topFamilies = rows.slice(0, 50).map(f => ({
    id: f.id,
    microFamilyId: f.id,
    side: f.side,
    rotationSide: f.rotationSide,
    setupClass: f.setupClass,
    reason: f.reason,

    seen: f.seen,
    completed: f.completed,
    wins: f.wins,
    losses: f.losses,
    flats: f.flats,

    rawWinrate: f.rawWinrate,
    rawWinrateNum: f.rawWinrateNum,

    winrateWilson: f.winrateWilson,
    winrateWilsonLower: f.winrateWilsonLower,

    bayesianWinrate: f.bayesianWinrate,
    bayesianWinrateNum: f.bayesianWinrateNum,

    sampleConfidence: f.sampleConfidence,

    avgR: f.avgR,
    totalR: Number(toNum(f.totalR, 0).toFixed(3)),
    profitFactorR: f.profitFactorR,

    directSL: f.directSL,
    score: f.score,
    confidence: f.confidence,
    specificity: f.specificity,

    examples: Array.isArray(f.examples) ? f.examples.slice(-4) : [],
  }));

  period.updatedAt = Date.now();
  return period;
};

const addObservationToPeriod = (period, row, options = {}) => {
  if (!period || !row?.symbol || !row?.side) return period;

  const ts = toNum(row.ts || row.createdAt || Date.now(), Date.now());
  const action = cleanKey(row.action || "WAIT");
  const familyIds = getFamilyIdsForLearning(row);

  if (!familyIds.length) return period;

  for (const familyId of familyIds) {
    const family = ensureFamily(period, familyId, row, ts);

    family.lastSeenAt = ts;
    family.seen++;
    period.totals.seen++;

    if (action === "ENTRY") {
      family.entries++;
      period.totals.entries++;
    }

    if (action === "EXIT") {
      family.exits++;
      period.totals.exits++;
    }

    addCount(family.rsiZones, row.rsiZone);
    addCount(family.obBiases, row.obBias);
    addCount(family.btcStates, row.btcState);
    addCount(family.reasons, row.reason || row.entryReason);
    addCount(family.setupClasses, row.setupClass);
    addCount(family.symbols, normalizeBaseSymbol(row.symbol));

    if (family.examples.length < (options.maxExamplesPerFamily || DEFAULTS.maxExamplesPerFamily)) {
      family.examples.push(`${normalizeBaseSymbol(row.symbol)}_${row.side}_${action}_${toNum(row.score ?? row.moveScore, 0)}`);
    } else if (Math.random() < 0.02) {
      family.examples.shift();
      family.examples.push(`${normalizeBaseSymbol(row.symbol)}_${row.side}_${action}_${toNum(row.score ?? row.moveScore, 0)}`);
    }

    updateFamilyDerivedStats(family, options);
  }

  return rebuildTopFamilies(period, options);
};

const getOutcomeId = row => {
  const raw = [
    row?.id,
    row?.tradeId,
    row?.shadowDedupeKey,
    normalizeBaseSymbol(row?.symbol),
    row?.side,
    row?.createdAt,
    row?.completedAt || row?.exitedAt || row?.closedAt,
    row?.status || row?.exitReason,
  ].filter(v => v !== null && v !== undefined).join("|");

  return cleanKey(raw);
};

const hasProcessedOutcome = (state, id) => {
  const key = cleanKey(id);
  return Array.isArray(state.processedOutcomeIds) && state.processedOutcomeIds.includes(key);
};

const markProcessedOutcome = (state, id, options = DEFAULTS) => {
  const key = cleanKey(id);

  if (!Array.isArray(state.processedOutcomeIds)) {
    state.processedOutcomeIds = [];
  }

  if (!state.processedOutcomeIds.includes(key)) {
    state.processedOutcomeIds.push(key);
  }

  if (state.processedOutcomeIds.length > options.maxProcessedOutcomeIds) {
    state.processedOutcomeIds = state.processedOutcomeIds.slice(-options.maxProcessedOutcomeIds);
  }
};

const isClosedOutcomeRow = row => {
  const status = cleanKey(row?.status || row?.exitReason || "");

  return (
    row?.status === "CLOSED" ||
    row?.closed === true ||
    row?.isClosed === true ||
    Boolean(row?.completedAt) ||
    Boolean(row?.exitedAt) ||
    ["HIT_TP", "HIT_SL", "HORIZON_DONE", "TP", "SL", "BE_SL", "CLOSED"].includes(status)
  );
};

const addOutcomeToPeriod = (period, row, options = {}) => {
  if (!period || !row?.symbol || !row?.side) return period;
  if (!isClosedOutcomeRow(row)) return period;

  const r = toNum(
    row.exitR ??
    row.realizedR ??
    row.pnlR ??
    row.resultR ??
    row.outcomeR,
    null
  );

  const pnlPct = toNum(row.pnlPct, 0);
  const familyIds = getFamilyIdsForLearning(row);

  if (!familyIds.length) return period;

  for (const familyId of familyIds) {
    const family = ensureFamily(
      period,
      familyId,
      row,
      toNum(row.completedAt || row.exitedAt || Date.now(), Date.now())
    );

    family.completed++;
    period.totals.completed++;

    const status = cleanKey(row.status || row.exitReason || "");

    const win =
      row.win === true ||
      (Number.isFinite(Number(r)) && Number(r) > 0) ||
      status === "HIT_TP" ||
      status === "TP";

    const loss =
      row.loss === true ||
      (Number.isFinite(Number(r)) && Number(r) < 0) ||
      status === "HIT_SL" ||
      status === "SL" ||
      status === "BE_SL";

    if (win) {
      family.wins++;
      period.totals.wins++;
    } else if (loss) {
      family.losses++;
      period.totals.losses++;
    } else {
      family.flats++;
      period.totals.flats++;
    }

    if (Number.isFinite(Number(r))) {
      family.totalR = Number((toNum(family.totalR, 0) + Number(r)).toFixed(4));
      period.totals.totalR = Number((toNum(period.totals.totalR, 0) + Number(r)).toFixed(4));
    }

    family.totalPnlPct = Number((toNum(family.totalPnlPct, 0) + pnlPct).toFixed(4));
    period.totals.totalPnlPct = Number((toNum(period.totals.totalPnlPct, 0) + pnlPct).toFixed(4));

    if (row.directToSL) family.directSL++;
    if (row.nearTpSeen) family.nearTpSeen++;
    if (row.reachedHalfR) family.reachedHalfR++;
    if (row.reachedOneR) family.reachedOneR++;

    updateFamilyDerivedStats(family, options);
  }

  return rebuildTopFamilies(period, options);
};

const mergeFamilyIntoPeriod = (target, sourceFamily, options = {}) => {
  if (!target || !sourceFamily?.id) return target;

  const family = ensureFamily(target, sourceFamily.id, sourceFamily, Date.now());

  for (const field of [
    "seen",
    "entries",
    "exits",
    "completed",
    "wins",
    "losses",
    "flats",
    "directSL",
    "nearTpSeen",
    "reachedHalfR",
    "reachedOneR",
  ]) {
    family[field] = toNum(family[field], 0) + toNum(sourceFamily[field], 0);
  }

  for (const field of ["totalR", "totalPnlPct"]) {
    family[field] = Number((toNum(family[field], 0) + toNum(sourceFamily[field], 0)).toFixed(4));
  }

  family.firstSeenAt = Math.min(toNum(family.firstSeenAt, Date.now()), toNum(sourceFamily.firstSeenAt, Date.now()));
  family.lastSeenAt = Math.max(toNum(family.lastSeenAt, 0), toNum(sourceFamily.lastSeenAt, 0));

  for (const mapField of ["rsiZones", "obBiases", "btcStates", "reasons", "setupClasses", "symbols"]) {
    family[mapField] = family[mapField] || {};

    for (const [key, count] of Object.entries(sourceFamily[mapField] || {})) {
      family[mapField][key] = toNum(family[mapField][key], 0) + toNum(count, 0);
    }
  }

  family.examples = [
    ...(Array.isArray(family.examples) ? family.examples : []),
    ...(Array.isArray(sourceFamily.examples) ? sourceFamily.examples : []),
  ].slice(-DEFAULTS.maxExamplesPerFamily);

  updateFamilyDerivedStats(family, options);
  return target;
};

const mergePeriodIntoWeek = (week, day, options = {}) => {
  if (!week || !day) return week;

  for (const field of Object.keys(createTotals())) {
    week.totals[field] = Number((toNum(week.totals[field], 0) + toNum(day.totals?.[field], 0)).toFixed(4));
  }

  for (const family of Object.values(day.families || {})) {
    mergeFamilyIntoPeriod(week, family, options);
  }

  return rebuildTopFamilies(week, options);
};

const clonePeriod = period => {
  if (!period) return null;
  return JSON.parse(JSON.stringify(period));
};

const buildEffectiveWeekPeriod = (state, options = {}) => {
  const week = clonePeriod(state.week) || createPeriodSummary({
    type: "WEEK",
    key: state.activeWeekKey || getWeekKey(),
  });

  const daily = state.daily;

  if (daily && daily.key === state.activeDayKey) {
    return mergePeriodIntoWeek(week, daily, options);
  }

  return rebuildTopFamilies(week, options);
};

export const buildActiveRotationFromPeriod = (period, options = {}) => {
  const cfg = { ...DEFAULTS, ...options };
  const key = period?.key || getWeekKey();
  const ts = Date.now();

  const rows = sortFamiliesWinrateFirst(Object.values(period?.families || {}), cfg)
    .filter(f => isSpecificMicroFamily(f.id))
    .filter(f => {
      if (toNum(f.completed, 0) >= cfg.minCompletedForActive) return true;
      return cfg.allowBootstrapFromSeen && toNum(f.seen, 0) >= cfg.minSeenForBootstrap;
    });

  const longFamilies = [];
  const shortFamilies = [];

  for (const family of rows) {
    const completed = toNum(family.completed, 0);
    const bootstrap = completed < cfg.minCompletedForActive;

    const row = {
      id: family.id,
      microFamilyId: family.id,
      side: family.side,
      rotationSide: family.rotationSide,
      setupClass: family.setupClass,
      reason: family.reason,

      seen: family.seen,
      completed: family.completed,
      wins: family.wins,
      losses: family.losses,

      rawWinrate: family.rawWinrate,
      rawWinrateNum: family.rawWinrateNum,

      winrateWilson: family.winrateWilson,
      winrateWilsonLower: family.winrateWilsonLower,

      bayesianWinrate: family.bayesianWinrate,
      bayesianWinrateNum: family.bayesianWinrateNum,

      sampleConfidence: family.sampleConfidence,

      avgR: family.avgR,
      totalR: Number(toNum(family.totalR, 0).toFixed(3)),
      score: family.score,
      confidence: family.confidence,

      bootstrap,
      rankingMode: "WINRATE_WILSON_FIRST",
      examples: Array.isArray(family.examples) ? family.examples.slice(-4) : [],
    };

    if (family.rotationSide === "LONG" && longFamilies.length < cfg.maxActiveFamiliesPerSide) {
      longFamilies.push(row);
    }

    if (family.rotationSide === "SHORT" && shortFamilies.length < cfg.maxActiveFamiliesPerSide) {
      shortFamilies.push(row);
    }

    if (longFamilies.length + shortFamilies.length >= cfg.maxActiveFamiliesTotal) {
      break;
    }
  }

  const selected = [...longFamilies, ...shortFamilies]
    .sort((a, b) => {
      const bootstrapDiff = Number(a.bootstrap) - Number(b.bootstrap);
      if (bootstrapDiff !== 0) return bootstrapDiff;

      const wilsonDiff = toNum(b.winrateWilsonLower, 0) - toNum(a.winrateWilsonLower, 0);
      if (wilsonDiff !== 0) return wilsonDiff;

      const bayesDiff = toNum(b.bayesianWinrateNum, 0) - toNum(a.bayesianWinrateNum, 0);
      if (bayesDiff !== 0) return bayesDiff;

      return toNum(b.completed, 0) - toNum(a.completed, 0);
    })
    .slice(0, cfg.maxActiveFamiliesTotal);

  const ids = selected.map(f => cleanKey(f.id));

  return {
    version: MICRO_LEARNING_VERSION,
    rotationId: `ROT_${cleanKey(key)}_MICRO_WINRATE_BEST`,
    weekKey: key,
    createdAt: ts,
    updatedAt: ts,
    source: "MICRO_LEARNING_WINRATE_FIRST",
    rankingMode: "WINRATE_WILSON_FIRST",

    bootstrap: selected.some(f => f.bootstrap),

    microFamilyIds: ids,
    activeMicroFamilyIds: ids,
    allowedMicroFamilyIds: ids,

    families: selected,
    longFamilies: selected.filter(f => f.rotationSide === "LONG"),
    shortFamilies: selected.filter(f => f.rotationSide === "SHORT"),

    meta: {
      periodKey: key,
      periodType: period?.type || "WEEK",
      familyCandidates: rows.length,

      minCompletedForActive: cfg.minCompletedForActive,
      minSeenForBootstrap: cfg.minSeenForBootstrap,
      maxActiveFamiliesTotal: cfg.maxActiveFamiliesTotal,
      maxActiveFamiliesPerSide: cfg.maxActiveFamiliesPerSide,

      winrateWilsonZ: cfg.winrateWilsonZ,
      baselineWinrate: cfg.baselineWinrate,
      bayesianPriorTrades: cfg.bayesianPriorTrades,

      note: "Ranking is winrate-first via Wilson lower bound; PnL/R is only a small tiebreaker/guard.",
    },
  };
};

export const syncMicroLearningPeriod = (state, options = {}) => {
  const cfg = { ...DEFAULTS, ...options };
  const ts = toNum(options.ts, Date.now());
  const { dayKey, weekKey } = getPeriodKeys(ts);

  const s = normalizeMicroLearningState(state, ts);

  if (s.activeDayKey !== dayKey) {
    const completedDay = {
      ...s.daily,
      completedAt: ts,
      activeRotationPreview: buildActiveRotationFromPeriod(s.daily, cfg),
    };

    s.lastCompletedDay = completedDay;
    s.week = mergePeriodIntoWeek(s.week, s.daily, cfg);

    s.activeDayKey = dayKey;
    s.daily = createPeriodSummary({ type: "DAY", key: dayKey, ts });
  }

  if (s.activeWeekKey !== weekKey) {
    const effectiveWeek = buildEffectiveWeekPeriod(s, cfg);

    const completedWeek = {
      ...effectiveWeek,
      completedAt: ts,
      activeRotation: buildActiveRotationFromPeriod(effectiveWeek, cfg),
    };

    s.lastCompletedWeek = completedWeek;
    s.activeRotation = completedWeek.activeRotation;

    s.activeWeekKey = weekKey;
    s.week = createPeriodSummary({ type: "WEEK", key: weekKey, ts });
    s.activeDayKey = dayKey;
    s.daily = createPeriodSummary({ type: "DAY", key: dayKey, ts });
    s.processedOutcomeIds = [];
  } else {
    const effectiveWeek = buildEffectiveWeekPeriod(s, cfg);
    s.activeRotation = buildActiveRotationFromPeriod(effectiveWeek, cfg);
  }

  s.updatedAt = ts;
  return s;
};

export const recordMicroLearningFromActions = (state, actions = [], options = {}) => {
  const s = syncMicroLearningPeriod(state, options);
  const rows = Array.isArray(actions) ? actions : [];

  for (const row of rows) {
    const action = cleanKey(row?.action || "UNKNOWN");

    if (!row?.symbol || !row?.side) continue;
    if (action === "HOLD") continue;

    addObservationToPeriod(s.daily, row, options);
  }

  s.updatedAt = Date.now();
  return syncMicroLearningPeriod(s, options);
};

export const recordMicroLearningOutcomes = (state, rows = [], options = {}) => {
  const s = syncMicroLearningPeriod(state, options);
  const arr = Array.isArray(rows) ? rows : [];

  for (const row of arr) {
    if (!row?.symbol || !row?.side) continue;
    if (!isClosedOutcomeRow(row)) continue;

    const id = getOutcomeId(row);
    if (hasProcessedOutcome(s, id)) continue;

    addOutcomeToPeriod(s.daily, row, options);
    markProcessedOutcome(s, id, options);
  }

  s.updatedAt = Date.now();
  return syncMicroLearningPeriod(s, options);
};

export const compactAuditLearningStorage = (auditState, learningState, options = {}) => {
  if (!auditState || typeof auditState !== "object") return auditState;

  const cfg = { ...DEFAULTS, ...options };

  if (Array.isArray(auditState.featureStore)) {
    auditState.featureStore = cfg.maxFeatureRowsAfterCompact > 0
      ? auditState.featureStore.slice(-cfg.maxFeatureRowsAfterCompact)
      : [];
  }

  if (Array.isArray(auditState.shadowOutcomes)) {
    const open = auditState.shadowOutcomes.filter(row => cleanKey(row.status || "OPEN") === "OPEN");
    auditState.shadowOutcomes = open.slice(-cfg.maxOpenShadowRowsAfterCompact);
  }

  if (Array.isArray(auditState.closedTrades)) {
    auditState.closedTrades = auditState.closedTrades.slice(-cfg.maxClosedRowsAfterCompact);
  }

  if (learningState && typeof learningState === "object") {
    auditState.microLearning = normalizeMicroLearningState(learningState);
  }

  return auditState;
};

export const getMicroLearningCompactSnapshot = (state, options = {}) => {
  const s = normalizeMicroLearningState(state);

  const compactPeriod = period => ({
    version: MICRO_LEARNING_VERSION,
    type: period?.type || null,
    key: period?.key || null,
    startedAt: period?.startedAt || null,
    updatedAt: period?.updatedAt || null,
    totals: period?.totals || createTotals(),
    familyCount: Object.keys(period?.families || {}).length,
    rankingMode: "WINRATE_WILSON_FIRST",
    topFamilies: Array.isArray(period?.topFamilies)
      ? period.topFamilies.slice(0, options.topN || 30)
      : [],
  });

  return {
    version: MICRO_LEARNING_VERSION,
    rankingMode: "WINRATE_WILSON_FIRST",
    activeDayKey: s.activeDayKey,
    activeWeekKey: s.activeWeekKey,
    updatedAt: s.updatedAt,

    daily: compactPeriod(s.daily),

    // Current week includes current day via activeRotation calculation.
    week: compactPeriod(buildEffectiveWeekPeriod(s, options)),

    activeRotation: {
      ...(s.activeRotation || {}),
      families: Array.isArray(s.activeRotation?.families)
        ? s.activeRotation.families.slice(0, options.rotationTopN || 20)
        : [],
    },

    lastCompletedDay: s.lastCompletedDay
      ? compactPeriod(s.lastCompletedDay)
      : null,

    lastCompletedWeek: s.lastCompletedWeek
      ? {
          ...compactPeriod(s.lastCompletedWeek),
          activeRotation: s.lastCompletedWeek.activeRotation || null,
        }
      : null,

    processedOutcomeCount: Array.isArray(s.processedOutcomeIds)
      ? s.processedOutcomeIds.length
      : 0,
  };
};

export const buildWeeklyRotationForGate = state => {
  const s = normalizeMicroLearningState(state);
  const rotation = s.activeRotation || createActiveRotation({ weekKey: s.activeWeekKey });

  return {
    ...rotation,
    rankingMode: "WINRATE_WILSON_FIRST",
    microFamilyIds: Array.isArray(rotation.microFamilyIds) ? rotation.microFamilyIds : [],
    activeMicroFamilyIds: Array.isArray(rotation.activeMicroFamilyIds)
      ? rotation.activeMicroFamilyIds
      : Array.isArray(rotation.microFamilyIds)
        ? rotation.microFamilyIds
        : [],
    allowedMicroFamilyIds: Array.isArray(rotation.allowedMicroFamilyIds)
      ? rotation.allowedMicroFamilyIds
      : Array.isArray(rotation.microFamilyIds)
        ? rotation.microFamilyIds
        : [],
  };
};

export default {
  MICRO_LEARNING_VERSION,
  createMicroLearningState,
  normalizeMicroLearningState,
  syncMicroLearningPeriod,
  recordMicroLearningFromActions,
  recordMicroLearningOutcomes,
  compactAuditLearningStorage,
  getMicroLearningCompactSnapshot,
  buildActiveRotationFromPeriod,
  buildWeeklyRotationForGate,
  getDayKey,
  getWeekKey,
};