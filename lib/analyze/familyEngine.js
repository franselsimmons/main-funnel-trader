// ================= LIB/ANALYZE/FAMILYENGINE.JS =================
// Doel:
// - Elke trade/action normaliseren
// - Elke filterwaarde vastleggen
// - Dynamisch hokken/families bouwen
// - Top 50 long + top 50 short families tonen
// - Winrate, PnL, R, MFE/MAE, directSL per family bijhouden

export const ANALYZE_SCHEMA_VERSION = "TS_ANALYZE_FAMILY_V1";

const MAX_ACTION_ROWS = 12_000;
const MAX_TRADE_ROWS = 6_000;
const MAX_FILTER_SNAPSHOTS = 100;
const FAMILY_LIMIT_PER_SIDE = 50;

export const ANALYZE_FILTER_NAMES = [
  "DISCOVERY_MODE",
  "DISCOVERY_OPEN_MEMORY_POSITIONS",
  "DISCOVERY_SEND_DISCORD",
  "ENABLE_TS_OPTIMIZER",
  "ENABLE_FEATURE_STORE",
  "ENABLE_SHADOW_OUTCOMES",
  "ENABLE_POST_EXIT_MONITOR",
  "ENABLE_B_ENTRIES",
  "ENABLE_BULLISH_MID_TREND_PROBES",
  "ENABLE_BTC_BULLISH_BEAR_EXCEPTION",
  "ENABLE_FALLBACK_RISK_GEOMETRY",
  "ENABLE_BREAK_EVEN_RULE",

  "MAX_SPREAD_PCT",
  "MID_BULL_MAX_SPREAD_PCT",
  "MIN_DEPTH_USD_1P",
  "MIN_DEPTH_USD_1P_ABSOLUTE",
  "A_MIN_DEPTH_USD_1P",
  "BULL_TREND_MIN_DEPTH_USD_1P",

  "MIN_RR_FLOOR",
  "GRADE_A_MIN_RR_FLOOR",
  "GRADE_B_MIN_RR_FLOOR",
  "GRADE_C_MIN_RR_FLOOR",
  "COUNTERTREND_MIN_RR_FLOOR",
  "BUILDUP_MIN_RR_FLOOR",
  "A_ENTRY_MIN_RR",
  "B_ENTRY_MIN_RR",
  "GOD_ENTRY_MIN_RR",
  "A_PRE_TP_MIN_BASE_RR",
  "B_PRE_TP_MIN_BASE_RR",
  "GOD_PRE_TP_MIN_BASE_RR",
  "MIN_PRE_TP_GEOMETRY_RR",
  "A_FINAL_MIN_RR",
  "A_GOD_MAX_TP_REWARD_MULTIPLIER",

  "A_MIN_SNIPER",
  "A_MIN_CONFLUENCE",
  "B_MIN_SNIPER",
  "B_MIN_CONFLUENCE",
  "GOD_MIN_SNIPER",
  "GOD_MIN_CONFLUENCE",
  "GLOBAL_MIN_CONFLUENCE",

  "CANDIDATE_MIN_SCORE",
  "BTC_BEARISH_LONG_MIN_SCORE",
  "BTC_NEUTRAL_MIN_SCORE",
  "MIN_EXTERNAL_SCORE_HEALTH",
  "TF_MIN_STRENGTH",
  "SETUP_GRADE_A_MIN_POINTS",
  "SETUP_GRADE_B_MIN_POINTS",

  "OB_AGAINST_MIN_CONFLUENCE",
  "OB_NEUTRAL_MIN_CONFLUENCE",
  "BAD_MARKET_QUALITY_MIN_CONFLUENCE",
  "NEUTRAL_OB_A_EXCEPTION_MIN_CONFLUENCE",
  "NEUTRAL_OB_A_EXCEPTION_MIN_RR",
  "NEUTRAL_OB_A_EXCEPTION_MIN_SNIPER",
  "NEUTRAL_OB_B_EXCEPTION_MIN_CONFLUENCE",
  "NEUTRAL_OB_B_EXCEPTION_MIN_RR",
  "NEUTRAL_OB_B_EXCEPTION_MIN_SNIPER",
  "NEUTRAL_OB_B_EXCEPTION_MIN_SCORE",
  "MID_BULL_SPREAD_EXCEPTION_MIN_CONFLUENCE",
  "MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER",

  "MID_RSI_MIN_CONFLUENCE",
  "EARLY_RSI_MIN_SNIPER",
  "SHORT_BLOCKED_RSI_ZONES",
  "SHORT_LOWER1_ALLOWED_BTC_STATES",
  "SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE",
  "SHORT_LOWER1_CONTINUATION_MIN_SNIPER",
  "SHORT_LOWER1_CONTINUATION_MIN_RR",
  "LONG_LOWER2_MAX_1H_CHANGE",
  "SHORT_UPPER2_MIN_1H_CHANGE",
  "MID_RSI_CONTINUATION_RR_DISCOUNT",

  "TREND_CONTINUATION_MIN_CONFLUENCE",
  "TREND_CONTINUATION_MIN_SNIPER",
  "TREND_CONTINUATION_MIN_RR",
  "STRONG_MOMENTUM_MIN_1H_MOVE_PCT",
  "STRONG_MOMENTUM_MIN_24H_MOVE_PCT",
  "SOFT_MOMENTUM_MIN_1H_MOVE_PCT",
  "SOFT_MOMENTUM_MIN_24H_MOVE_PCT",
  "ELITE_MOMENTUM_MIN_CONFLUENCE",
  "ELITE_MOMENTUM_MIN_1H_MOVE_PCT",
  "LOW_VOL_MIN_CONFLUENCE",
  "NO_FLOW_MIN_CONFLUENCE",
  "REQUIRE_BULL_TREND_PULLBACK",
  "MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT",

  "BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE",
  "BULLISH_MID_TREND_PROBE_MIN_SNIPER",
  "BULLISH_MID_TREND_PROBE_MIN_RR",
  "BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT",
  "BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P",
  "BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH",
  "BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT",
  "BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT",
  "BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT",

  "BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P",
  "BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT",
  "BTC_BULLISH_BEAR_EXCEPTION_MIN_RR",
  "BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF",
  "BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF",
  "BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER",

  "EXTREME_FUNDING_ABS_MAX",
  "BULL_CROWDED_FUNDING_MAX",
  "BEAR_CROWDED_FUNDING_MIN",
  "CROWDED_FUNDING_MIN_CONFLUENCE",

  "MAX_OPEN_POSITIONS_TOTAL",
  "MAX_OPEN_POSITIONS_SAME_SIDE",
  "MAX_COUNTER_BTC_OPEN_POSITIONS",

  "ENABLE_ENTRY_QUALITY_GATE_V12",
  "QUALITY_LOW_RR_THRESHOLD",
  "QUALITY_LOW_RR_MIN_SNIPER",
  "QUALITY_LOW_RR_MIN_CONFLUENCE",
  "QUALITY_MID_NEUTRAL_MIN_SNIPER",
  "QUALITY_MID_NEUTRAL_MIN_CONFLUENCE",
  "QUALITY_MID_NEUTRAL_MIN_RR",
  "QUALITY_MID_NEUTRAL_MAX_SPREAD_PCT",
  "QUALITY_MID_NEUTRAL_MIN_DEPTH_USD_1P",
  "QUALITY_CHOP_RSI_MIN",
  "QUALITY_CHOP_RSI_MAX",
  "QUALITY_CHOP_MIN_SNIPER",
  "QUALITY_CHOP_MIN_CONFLUENCE",
  "QUALITY_LOWER_RSI_LONG_MIN_SNIPER",
  "QUALITY_LOWER_RSI_LONG_MIN_CONFLUENCE",
  "ENTRY_CONFIRMATION_TTL_MS",
  "ENTRY_CONFIRMATION_MIN_SNIPER",
  "ENTRY_CONFIRMATION_MIN_CONFLUENCE",
  "ENABLE_EARLY_FAILURE_EXIT",
  "EARLY_FAILURE_MIN_AGE_SEC",
  "EARLY_FAILURE_MIN_MFE_R",
  "EARLY_FAILURE_MAX_MAE_R",
  "EARLY_FAILURE_MAX_CURRENT_R",
  "EARLY_OB_FLIP_MIN_AGE_SEC",
  "EARLY_OB_FLIP_MIN_MFE_R",
  "EARLY_OB_FLIP_MAX_CURRENT_R",

  "BREAK_EVEN_TRIGGER_R",
  "BREAK_EVEN_LOCK_R",
  "BREAK_EVEN_MIN_TICKS",
  "BREAK_EVEN_MIN_FAVORABLE_TICKS",
  "HALF_R_LEVEL",
  "ONE_R_LEVEL",
  "NEAR_TP_PROGRESS",
  "DIRECT_SL_MFE_LIMIT_R",
  "MAX_PRICE_PATH_SAMPLES",

  "TP_FOLLOW_THROUGH_R",
  "TP_BIG_FOLLOW_THROUGH_R",
  "SL_RECOVERY_HALF_R",
  "SL_RECOVERY_ONE_R",
  "SL_DEEP_ADVERSE_R",
  "SHADOW_DIRECTIONAL_WIN_PCT",
  "SHADOW_DIRECTIONAL_LOSS_PCT",

  "BEST_SETUP_MIN_SAMPLE_LOW",
  "BEST_SETUP_MIN_SAMPLE_MEDIUM",
  "BEST_SETUP_MIN_SAMPLE_HIGH",
  "BEST_SETUP_MIN_WINRATE",
  "BEST_SETUP_MIN_AVG_R",
  "BAD_SETUP_MAX_WINRATE",
  "BAD_SETUP_MAX_AVG_R",
  "FINAL_DECISION_MIN_COMPLETED",
  "FINAL_DECISION_TARGET_COMPLETED",
  "FINAL_DECISION_TOP_N",

  "COOLDOWN_MS",
  "SYMBOL_REENTRY_COOLDOWN_MS",
  "DATA_FETCH_CONCURRENCY"
];

export function createAnalyzeState() {
  return {
    schemaVersion: ANALYZE_SCHEMA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),

    batches: 0,
    actionsIngested: 0,

    actions: [],
    trades: [],
    openIndex: {},

    filterSnapshots: []
  };
}

export function hydrateAnalyzeState(raw) {
  const state = raw && typeof raw === "object"
    ? raw
    : createAnalyzeState();

  if (state.schemaVersion !== ANALYZE_SCHEMA_VERSION) {
    return createAnalyzeState();
  }

  if (!Array.isArray(state.actions)) state.actions = [];
  if (!Array.isArray(state.trades)) state.trades = [];
  if (!Array.isArray(state.filterSnapshots)) state.filterSnapshots = [];
  if (!state.openIndex || typeof state.openIndex !== "object") state.openIndex = {};

  state.batches = safeNumber(state.batches, 0);
  state.actionsIngested = safeNumber(state.actionsIngested, 0);
  state.createdAt = safeNumber(state.createdAt, Date.now());
  state.updatedAt = safeNumber(state.updatedAt, Date.now());

  rebuildOpenIndex(state);
  return state;
}

export function ingestAnalysisBatch(rawState, payload = {}) {
  const state = hydrateAnalyzeState(rawState);

  const actions = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.actions)
      ? payload.actions
      : [];

  const meta = normalizeBatchMeta(payload);

  collectFilterSnapshot(state, payload, actions, meta);

  state.batches++;

  for (let i = 0; i < actions.length; i++) {
    const row = normalizeAction(actions[i], meta, i);
    const family = assignFamily(row);

    row.familyKey = family.familyKey;
    row.familyHash = family.familyHash;
    row.familySignature = family.signature;
    row.familyLabel = family.label;

    state.actions.push(row);
    state.actionsIngested++;

    updateTradeStateFromAction(state, row);
  }

  trimState(state);
  state.updatedAt = Date.now();

  return state;
}

export function buildAnalyzeReport(rawState, options = {}) {
  const state = hydrateAnalyzeState(rawState);
  const latestFilterSnapshot = state.filterSnapshots.at(-1) || buildEmptyFilterSnapshot();

  const families = buildFamilyStats(state);
  const longFamilies = rankFamilies(families.filter(f => f.side === "bull"))
    .slice(0, FAMILY_LIMIT_PER_SIDE)
    .map((f, i) => ({
      ...f,
      familySlot: `LONG_${i + 1}`
    }));

  const shortFamilies = rankFamilies(families.filter(f => f.side === "bear"))
    .slice(0, FAMILY_LIMIT_PER_SIDE)
    .map((f, i) => ({
      ...f,
      familySlot: `SHORT_${i + 1}`
    }));

  const trades = state.trades || [];
  const closedTrades = trades.filter(t => t.status === "CLOSED");
  const openTrades = trades.filter(t => t.status === "OPEN");

  const wins = closedTrades.filter(t => safeNumber(t.exitR, 0) > 0).length;
  const losses = closedTrades.filter(t => safeNumber(t.exitR, 0) < 0).length;
  const flats = closedTrades.length - wins - losses;

  const totalR = sum(closedTrades.map(t => safeNumber(t.exitR, 0)));
  const totalPnlPct = sum(closedTrades.map(t => safeNumber(t.pnlPct, 0)));

  return {
    schemaVersion: ANALYZE_SCHEMA_VERSION,
    generatedAt: Date.now(),

    summary: {
      batches: state.batches,
      actionsIngested: state.actionsIngested,
      actionsStored: state.actions.length,

      tradesStored: trades.length,
      openTrades: openTrades.length,
      closedTrades: closedTrades.length,

      wins,
      losses,
      flats,

      winrate: formatPct(wins, wins + losses),
      winrateNum: ratio(wins, wins + losses),

      totalR: round(totalR, 3),
      avgR: round(avg(closedTrades.map(t => safeNumber(t.exitR, 0))), 3),

      totalPnlPct: round(totalPnlPct, 3),
      avgPnlPct: round(avg(closedTrades.map(t => safeNumber(t.pnlPct, 0))), 3),

      longFamilies: longFamilies.length,
      shortFamilies: shortFamilies.length,

      lastUpdatedAt: state.updatedAt
    },

    filters: buildFilterReport(latestFilterSnapshot),

    families: {
      long: longFamilies,
      short: shortFamilies,
      allCount: families.length
    },

    recentTrades: trades
      .slice(-150)
      .reverse(),

    recentActions: state.actions
      .slice(-250)
      .reverse()
  };
}

// ================= FAMILY ASSIGNMENT =================

export function assignFamily(row) {
  const signature = buildFamilySignature(row);
  const rawKey = stableSignatureText(signature);
  const familyHash = stableHash(rawKey);

  return {
    familyHash,
    familyKey: `${signature.side}:${familyHash}`,
    signature,
    label: buildFamilyLabel(signature)
  };
}

function buildFamilySignature(row) {
  const side = normalizeSide(row.side);

  return {
    side,

    // Algemene entry-klasse
    setupClass: clean(row.setupClass || "NONE"),
    grade: clean(row.grade || "NA"),
    stage: bucketStage(row.stage),
    actionType: bucketAction(row.action),
    reasonFamily: bucketReason(row.reason),

    // Score/kwaliteit
    score: bucketScore(row.score),
    confluence: bucketConfluence(row.confluence),
    rawConfluence: bucketConfluence(row.rawConfluence),
    sniper: bucketSniper(row.sniperScore),
    quality: bucketQuality(row),

    // RR/risk
    rr: bucketRR(row.plannedRR || row.rr),
    baseRR: bucketRR(row.baseRR),
    finalRR: bucketRR(row.finalRr || row.plannedRR || row.rr),
    riskWidth: bucketRiskWidth(row),

    // RSI
    rsiZone: clean(row.rsiZone || "UNKNOWN"),
    rsiValue: bucketRsiValue(row.rsi),
    rsiDirectionalEdge: bucketRsiDirectionalEdge(row),
    rsiEdge: clean(row.rsiEdge || row.rsiEntryEdge || "UNKNOWN"),
    rsiHTF: bucketRsiValue(row.rsiHTF),

    // OB/execution
    obBias: bucketObBias(row.obBias),
    obRelation: bucketObRelation(row),
    spread: bucketSpread(row.spreadPct),
    depth: bucketDepth(row.depthMinUsd1p),
    spoof: row.spoof ? "SPOOF" : "NO_SPOOF",

    // Flow/market
    flow: bucketFlow(row.flow),
    btcState: bucketBtcState(row.btcState),
    btcRelation: bucketBtcRelation(row),
    regime: clean(row.regime || "UNKNOWN"),
    volatility: clean(row.volatility || row.vol || "UNKNOWN"),

    // MTF/momentum
    tfStrength: bucketTfStrength(row.tfStrength),
    tfScore: bucketSigned(row.tfScore, "TF"),
    tfAlignment: clean(row.tfAlignment || "UNKNOWN"),
    change1h: bucketMomentum(row.change1h, "M1H"),
    change24: bucketMomentum(row.change24, "M24H"),

    // Pullback/structure
    pullback: bucketBool(row.pullbackConfirmed, "PULLBACK"),
    sweep: bucketBool(row.sweepConfirmed, "SWEEP"),
    retest: bucketBool(row.retestConfirmed, "RETEST"),
    distanceFromHigh: bucketPctDistance(row.distanceFromLocalHighPct),

    // Funding
    funding: bucketFunding(row.funding),

    // Special setups
    bullishMidTrendProbe: row.bullishMidTrendProbe ? "PROBE_ON" : "PROBE_OFF",
    btcBullishBearException: row.btcBullishBearException ? "BTC_BULL_SHORT_EXC_ON" : "BTC_BULL_SHORT_EXC_OFF",

    // Feature flags snapshot
    featureFlags: bucketFeatureFlags(row.filterValues)
  };
}

function buildFamilyLabel(signature) {
  return [
    signature.setupClass,
    signature.stage,
    signature.flow,
    signature.rsiZone,
    signature.rr,
    signature.confluence,
    signature.sniper,
    signature.obRelation,
    signature.spread,
    signature.depth,
    signature.btcRelation
  ].join(" | ");
}

function stableSignatureText(signature) {
  return Object.keys(signature)
    .sort()
    .map(k => `${k}=${JSON.stringify(signature[k])}`)
    .join("|");
}

// ================= TRADE STATE =================

function updateTradeStateFromAction(state, row) {
  const action = clean(row.action);

  if (action === "ENTRY") {
    upsertEntryTrade(state, row);
    return;
  }

  if (action === "EXIT") {
    closeTrade(state, row);
    return;
  }
}

function upsertEntryTrade(state, row) {
  const indexKey = `${row.symbol}_${row.side}`;
  const tradeId = row.tradeId || `trade_${row.runId}_${row.symbol}_${row.side}_${row.ts}`;

  const existing = state.trades.find(t => t.tradeId === tradeId);

  const trade = {
    ...(existing || {}),

    tradeId,
    status: "OPEN",

    symbol: row.symbol,
    side: row.side,

    entryActionId: row.id,
    entryFamilyKey: row.familyKey,
    entryFamilyHash: row.familyHash,
    entryFamilyLabel: row.familyLabel,
    entryFamilySignature: row.familySignature,

    setupClass: row.setupClass,
    grade: row.grade,
    reason: row.reason,
    entryReason: row.reason,

    entry: row.entry,
    sl: row.sl,
    initialSl: row.initialSl || row.sl,
    tp: row.tp,

    plannedRR: row.plannedRR || row.rr,
    baseRR: row.baseRR,
    finalRr: row.finalRr,

    score: row.score,
    confluence: row.confluence,
    sniperScore: row.sniperScore,
    rsi: row.rsi,
    rsiHTF: row.rsiHTF,
    rsiZone: row.rsiZone,

    obBias: row.obBias,
    spreadPct: row.spreadPct,
    depthMinUsd1p: row.depthMinUsd1p,

    flow: row.flow,
    funding: row.funding,
    btcState: row.btcState,
    regime: row.regime,
    tfStrength: row.tfStrength,
    tfScore: row.tfScore,

    createdAt: row.ts,
    openedAt: row.ts,
    updatedAt: Date.now(),

    strategyVersion: row.strategyVersion,
    runId: row.runId,

    filterValues: row.filterValues,
    filterChecks: row.filterChecks
  };

  if (existing) {
    Object.assign(existing, trade);
  } else {
    state.trades.push(trade);
  }

  state.openIndex[indexKey] = tradeId;
}

function closeTrade(state, row) {
  const indexKey = `${row.symbol}_${row.side}`;
  const tradeId = row.tradeId || state.openIndex[indexKey];

  let trade = tradeId
    ? state.trades.find(t => t.tradeId === tradeId)
    : null;

  if (!trade) {
    trade = findLatestOpenTrade(state, row) || createExitOnlyTrade(row);
    state.trades.push(trade);
  }

  trade.status = "CLOSED";

  trade.exitActionId = row.id;
  trade.exitFamilyKey = row.familyKey;
  trade.exitFamilyHash = row.familyHash;
  trade.exitFamilyLabel = row.familyLabel;
  trade.exitFamilySignature = row.familySignature;

  trade.exitReason = row.reason;
  trade.exit = row.exit;
  trade.executionPrice = row.executionPrice || row.exit;
  trade.triggerPrice = row.triggerPrice || row.exit;

  trade.exitR = safeNumber(row.exitR, safeNumber(row.triggerR, 0));
  trade.pnlPct = safeNumber(row.pnlPct, safeNumber(row.triggerPnlPct, 0));

  trade.triggerR = safeNumber(row.triggerR, trade.exitR);
  trade.triggerPnlPct = safeNumber(row.triggerPnlPct, trade.pnlPct);

  trade.mfeR = safeNumber(row.mfeR, trade.mfeR || 0);
  trade.maeR = safeNumber(row.maeR, trade.maeR || 0);
  trade.currentR = safeNumber(row.currentR, 0);

  trade.directToSL = Boolean(row.directToSL);
  trade.reachedHalfR = Boolean(row.reachedHalfR);
  trade.reachedOneR = Boolean(row.reachedOneR);
  trade.nearTpSeen = Boolean(row.nearTpSeen);
  trade.breakEvenActivated = Boolean(row.breakEvenActivated);
  trade.breakEvenStop = Boolean(row.breakEvenStop);

  trade.holdMinutes = safeNumber(row.holdMinutes, 0);
  trade.closedAt = row.ts;
  trade.exitedAt = row.ts;
  trade.updatedAt = Date.now();

  delete state.openIndex[indexKey];
}

function findLatestOpenTrade(state, row) {
  return [...state.trades]
    .reverse()
    .find(t =>
      t.status === "OPEN" &&
      t.symbol === row.symbol &&
      t.side === row.side
    );
}

function createExitOnlyTrade(row) {
  return {
    tradeId: row.tradeId || `exit_only_${row.runId}_${row.symbol}_${row.side}_${row.ts}`,
    status: "OPEN",

    symbol: row.symbol,
    side: row.side,

    entryFamilyKey: row.familyKey,
    entryFamilyHash: row.familyHash,
    entryFamilyLabel: row.familyLabel,
    entryFamilySignature: row.familySignature,

    setupClass: row.setupClass,
    grade: row.grade,
    reason: row.reason,
    entryReason: "EXIT_ONLY",

    entry: row.entry,
    sl: row.sl,
    initialSl: row.initialSl || row.sl,
    tp: row.tp,

    plannedRR: row.plannedRR || row.rr,
    score: row.score,
    confluence: row.confluence,
    sniperScore: row.sniperScore,

    createdAt: row.ts,
    openedAt: row.ts,
    runId: row.runId,
    strategyVersion: row.strategyVersion
  };
}

// ================= FAMILY STATS =================

function buildFamilyStats(state) {
  const map = new Map();

  for (const row of state.actions || []) {
    const family = touchFamily(map, row.familyKey, row.familySignature, row.familyLabel, row.side);

    family.observations++;
    family.actionCounts[row.action] = safeNumber(family.actionCounts[row.action], 0) + 1;
    family.reasonCounts[row.reason] = safeNumber(family.reasonCounts[row.reason], 0) + 1;
    family.symbolCounts[row.symbol] = safeNumber(family.symbolCounts[row.symbol], 0) + 1;

    pushLimited(family.examples.actions, compactActionExample(row), 20);
    collectNumericFields(family.numeric, row);
  }

  for (const trade of state.trades || []) {
    const key = trade.entryFamilyKey || trade.exitFamilyKey;
    const signature = trade.entryFamilySignature || trade.exitFamilySignature;
    const label = trade.entryFamilyLabel || trade.exitFamilyLabel;

    if (!key || !signature) continue;

    const family = touchFamily(map, key, signature, label, trade.side);

    family.entries++;

    if (trade.status === "OPEN") {
      family.openTrades++;
      pushLimited(family.examples.openTrades, compactTradeExample(trade), 20);
      continue;
    }

    family.closedTrades++;

    const exitR = safeNumber(trade.exitR, 0);
    const pnlPct = safeNumber(trade.pnlPct, 0);

    family.totalR += exitR;
    family.totalPnlPct += pnlPct;

    family.mfeTotal += safeNumber(trade.mfeR, 0);
    family.maeTotal += safeNumber(trade.maeR, 0);

    if (exitR > 0) family.wins++;
    else if (exitR < 0) family.losses++;
    else family.flats++;

    if (trade.directToSL) family.directSL++;
    if (trade.nearTpSeen) family.nearTpSeen++;
    if (trade.reachedHalfR) family.reachedHalfR++;
    if (trade.reachedOneR) family.reachedOneR++;
    if (trade.breakEvenStop) family.breakEvenStops++;

    pushLimited(family.examples.closedTrades, compactTradeExample(trade), 30);
  }

  return Array.from(map.values()).map(finalizeFamilyStats);
}

function touchFamily(map, key, signature, label, side) {
  if (map.has(key)) return map.get(key);

  const row = {
    familyKey: key,
    familyHash: key?.split(":")?.[1] || key,
    side: normalizeSide(side || signature?.side),
    label: label || buildFamilyLabel(signature),

    signature,

    observations: 0,
    entries: 0,
    openTrades: 0,
    closedTrades: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    totalR: 0,
    totalPnlPct: 0,

    mfeTotal: 0,
    maeTotal: 0,

    directSL: 0,
    nearTpSeen: 0,
    reachedHalfR: 0,
    reachedOneR: 0,
    breakEvenStops: 0,

    actionCounts: {},
    reasonCounts: {},
    symbolCounts: {},

    numeric: createNumericCollector(),

    examples: {
      actions: [],
      openTrades: [],
      closedTrades: []
    }
  };

  map.set(key, row);
  return row;
}

function finalizeFamilyStats(f) {
  const completed = f.wins + f.losses;
  const closed = f.closedTrades;

  const numericProfile = finalizeNumericCollector(f.numeric);

  return {
    familyKey: f.familyKey,
    familyHash: f.familyHash,
    side: f.side,
    label: f.label,

    signature: f.signature,

    observations: f.observations,
    entries: f.entries,
    openTrades: f.openTrades,
    closedTrades: f.closedTrades,

    wins: f.wins,
    losses: f.losses,
    flats: f.flats,

    winrate: formatPct(f.wins, completed),
    winrateNum: ratio(f.wins, completed),

    totalR: round(f.totalR, 3),
    avgR: round(closed ? f.totalR / closed : 0, 3),

    totalPnlPct: round(f.totalPnlPct, 3),
    avgPnlPct: round(closed ? f.totalPnlPct / closed : 0, 3),

    avgMfeR: round(closed ? f.mfeTotal / closed : 0, 3),
    avgMaeR: round(closed ? f.maeTotal / closed : 0, 3),

    directSL: f.directSL,
    directSLPct: formatPct(f.directSL, closed),

    nearTpSeen: f.nearTpSeen,
    nearTpPct: formatPct(f.nearTpSeen, closed),

    reachedHalfR: f.reachedHalfR,
    reachedHalfRPct: formatPct(f.reachedHalfR, closed),

    reachedOneR: f.reachedOneR,
    reachedOneRPct: formatPct(f.reachedOneR, closed),

    breakEvenStops: f.breakEvenStops,
    breakEvenStopPct: formatPct(f.breakEvenStops, closed),

    actionCounts: sortObjectByValue(f.actionCounts),
    topReasons: topCounts(f.reasonCounts, 10),
    topSymbols: topCounts(f.symbolCounts, 10),

    numericProfile,

    familyScore: scoreFamily(f, completed, closed),

    examples: f.examples
  };
}

function scoreFamily(f, completed, closed) {
  const winrate = ratio(f.wins, completed);
  const avgR = closed ? f.totalR / closed : 0;
  const avgPnl = closed ? f.totalPnlPct / closed : 0;
  const directSlPct = ratio(f.directSL, closed);
  const sampleScore = Math.min(1, closed / 30);

  const score =
    winrate * 40 +
    avgR * 35 +
    avgPnl * 4 +
    sampleScore * 20 -
    directSlPct * 25 +
    Math.min(f.entries, 20) * 0.25;

  return round(score, 3);
}

function rankFamilies(rows) {
  return [...rows].sort((a, b) => {
    const sampleDiff = safeNumber(b.closedTrades, 0) - safeNumber(a.closedTrades, 0);
    if (sampleDiff !== 0) return sampleDiff;

    const scoreDiff = safeNumber(b.familyScore, 0) - safeNumber(a.familyScore, 0);
    if (scoreDiff !== 0) return scoreDiff;

    return safeNumber(b.entries, 0) - safeNumber(a.entries, 0);
  });
}

// ================= NORMALIZATION =================

function normalizeBatchMeta(payload = {}) {
  const meta = payload.meta || {};

  return {
    runId: payload.runId || meta.runId || `run_${Date.now()}`,
    btcState: clean(payload.btcState || meta.btcState || "UNKNOWN"),
    strategyVersion: payload.strategyVersion || meta.strategyVersion || "UNKNOWN",
    discoveryMode: Boolean(payload.discoveryMode ?? meta.discoveryMode),
    receivedAt: Date.now()
  };
}

function normalizeAction(action = {}, meta = {}, index = 0) {
  const diagnostics = action.filterDiagnostics || {};
  const liveMetrics = action.liveFilterMetrics || diagnostics.liveMetrics || {};
  const filterChecks = action.filterChecks || diagnostics.passMap || {};
  const specialFilterChecks = action.specialFilterChecks || diagnostics.specialChecks || {};

  const filterValues =
    action.filterValues ||
    diagnostics.filterValues ||
    {};

  const symbol = normalizeBaseSymbol(action.symbol || liveMetrics.symbol);
  const side = normalizeSide(action.side || liveMetrics.side);

  const ts = safeNumber(action.ts, Date.now());

  return {
    id: action.id || `${meta.runId}_${index}_${ts}_${Math.random().toString(36).slice(2, 8)}`,
    runId: action.runId || meta.runId,
    ts,

    strategyVersion: action.strategyVersion || meta.strategyVersion,

    action: clean(action.action || "UNKNOWN"),
    reason: clean(action.reason || action.entryType || "UNKNOWN"),

    symbol,
    side,

    tradeId: action.tradeId || liveMetrics.tradeId || null,

    stage: clean(action.stage || liveMetrics.stage || "unknown").toLowerCase(),
    scannerStage: clean(action.scannerStage || liveMetrics.scannerStage || action.stage || "unknown").toLowerCase(),

    setupClass: clean(action.setupClass || liveMetrics.setupClass || "NONE"),
    grade: clean(action.grade || liveMetrics.grade || "NA"),
    gradePoints: safeNumber(action.gradePoints || liveMetrics.gradePoints, 0),

    score: safeNumber(liveMetrics.score ?? action.score ?? action.moveScore, 0),

    confluence: safeNumber(
      liveMetrics.confluence ??
      action.confluence ??
      action.effectiveConfluence,
      0
    ),

    rawConfluence: safeNumber(
      liveMetrics.rawConfluence ??
      action.rawConfluence,
      0
    ),

    sniper: action.sniper || liveMetrics.sniper || "UNKNOWN",
    sniperScore: safeNumber(liveMetrics.sniperScore ?? action.sniperScore, 0),

    rr: safeNumber(action.rr, 0),
    plannedRR: safeNumber(
      liveMetrics.finalRr ??
      action.plannedRR ??
      action.effectiveRR ??
      action.rr,
      0
    ),
    baseRR: safeNumber(liveMetrics.baseRR ?? action.baseRR, 0),
    finalRr: safeNumber(liveMetrics.finalRr ?? action.finalRr ?? action.plannedRR ?? action.rr, 0),

    entry: safeNumber(liveMetrics.entry ?? action.entry ?? action.price, 0),
    sl: safeNumber(liveMetrics.sl ?? action.sl, 0),
    initialSl: safeNumber(action.initialSl ?? liveMetrics.initialSl ?? action.sl, 0),
    tp: safeNumber(liveMetrics.tp ?? action.tp, 0),

    exit: safeNumber(action.exit ?? action.executionPrice, 0),
    executionPrice: safeNumber(action.executionPrice ?? action.exit, 0),
    triggerPrice: safeNumber(action.triggerPrice ?? action.exit, 0),

    exitR: safeNumber(action.exitR, null),
    triggerR: safeNumber(action.triggerR, null),
    pnlPct: safeNumber(action.pnlPct, null),
    triggerPnlPct: safeNumber(action.triggerPnlPct, null),

    currentR: safeNumber(action.currentR, 0),
    mfeR: safeNumber(action.mfeR, 0),
    maeR: safeNumber(action.maeR, 0),

    directToSL: Boolean(action.directToSL),
    reachedHalfR: Boolean(action.reachedHalfR),
    reachedOneR: Boolean(action.reachedOneR),
    nearTpSeen: Boolean(action.nearTpSeen),
    breakEvenActivated: Boolean(action.breakEvenActivated),
    breakEvenStop: Boolean(action.breakEvenStop),

    rsi: safeNumber(liveMetrics.rsi ?? action.rsi, 50),
    rsiHTF: safeNumber(liveMetrics.rsiHTF ?? action.rsiHTF, 50),
    rsiZone: clean(liveMetrics.rsiZone ?? action.rsiZone ?? "UNKNOWN"),
    rsiEdge: clean(action.rsiEdge || action.rsiEntryEdge || liveMetrics.rsiEdge || "UNKNOWN"),
    rsiEdgeRank: safeNumber(action.rsiEdgeRank || liveMetrics.rsiEdgeRank, 0),

    obBias: clean(liveMetrics.obBias ?? action.obBias ?? "UNKNOWN"),
    spreadPct: normalizeSpread(liveMetrics.spreadPct ?? action.spreadPct),
    depthMinUsd1p: safeNumber(liveMetrics.depthMinUsd1p ?? action.depthMinUsd1p, 0),
    spoof: Boolean(action.spoof),

    flow: clean(liveMetrics.flow ?? action.flow ?? "UNKNOWN"),
    btcState: clean(liveMetrics.btcState ?? action.btcState ?? meta.btcState ?? "UNKNOWN"),
    regime: clean(liveMetrics.regime ?? action.regime ?? "UNKNOWN"),
    volatility: clean(action.volatility || action.vol || "UNKNOWN"),

    funding: safeNumber(liveMetrics.funding ?? action.funding, 0),

    tfScore: safeNumber(liveMetrics.tfScore ?? action.tfScore, 0),
    tfStrength: safeNumber(liveMetrics.tfStrength ?? action.tfStrength, 0),
    tfAlignment: clean(liveMetrics.tfAlignment ?? action.tfAlignment ?? "UNKNOWN"),

    change1h: safeNumber(action.change1h ?? liveMetrics.change1h, 0),
    change24: safeNumber(action.change24 ?? liveMetrics.change24, 0),

    pullbackConfirmed: Boolean(action.pullbackConfirmed ?? liveMetrics.pullbackConfirmed),
    sweepConfirmed: Boolean(action.sweepConfirmed ?? liveMetrics.sweepConfirmed),
    retestConfirmed: Boolean(action.retestConfirmed ?? liveMetrics.retestConfirmed),
    distanceFromLocalHighPct: safeNumber(
      action.distanceFromLocalHighPct ??
      liveMetrics.distanceFromLocalHighPct,
      0
    ),

    bullishMidTrendProbe: Boolean(action.bullishMidTrendProbe),
    btcBullishBearException: Boolean(action.btcBullishBearException),

    filterValues,
    filterChecks,
    specialFilterChecks,

    raw: compactRawAction(action)
  };
}

function compactRawAction(action) {
  return {
    action: action.action,
    reason: action.reason,
    setupClass: action.setupClass,
    symbol: action.symbol,
    side: action.side,
    score: action.score,
    confluence: action.confluence,
    sniperScore: action.sniperScore,
    plannedRR: action.plannedRR,
    rsi: action.rsi,
    rsiZone: action.rsiZone,
    obBias: action.obBias,
    spreadPct: action.spreadPct,
    depthMinUsd1p: action.depthMinUsd1p
  };
}

// ================= FILTER SNAPSHOTS =================

function collectFilterSnapshot(state, payload, actions, meta) {
  const firstActionWithFilters = actions.find(a =>
    a?.filterValues ||
    a?.filterDiagnostics?.filterValues
  );

  const raw = {
    filterValues:
      payload.filterValues ||
      firstActionWithFilters?.filterValues ||
      firstActionWithFilters?.filterDiagnostics?.filterValues ||
      null,

    currentFilterValues:
      payload.currentFilterValues ||
      payload.tradeSystemFilters ||
      null,

    tradeSystemFilters:
      payload.tradeSystemFilters ||
      null
  };

  const hasAny = Boolean(raw.filterValues || raw.currentFilterValues || raw.tradeSystemFilters);
  if (!hasAny) return;

  const flat = flattenObject(raw);
  const byName = buildFilterByName(flat);

  state.filterSnapshots.push({
    ts: Date.now(),
    runId: meta.runId,
    strategyVersion: meta.strategyVersion,
    raw,
    flat,
    byName
  });

  if (state.filterSnapshots.length > MAX_FILTER_SNAPSHOTS) {
    state.filterSnapshots = state.filterSnapshots.slice(-MAX_FILTER_SNAPSHOTS);
  }
}

function buildFilterReport(snapshot) {
  const byName = snapshot.byName || {};
  const missing = ANALYZE_FILTER_NAMES.filter(name => !Object.prototype.hasOwnProperty.call(byName, name));

  return {
    latestSnapshotAt: snapshot.ts || null,
    strategyVersion: snapshot.strategyVersion || "UNKNOWN",

    expectedCount: ANALYZE_FILTER_NAMES.length,
    capturedCount: Object.keys(byName).length,
    missingCount: missing.length,

    byName,
    flat: snapshot.flat || {},
    missing,

    categories: buildFilterCategories(byName)
  };
}

function buildEmptyFilterSnapshot() {
  return {
    ts: null,
    strategyVersion: "UNKNOWN",
    raw: {},
    flat: {},
    byName: {}
  };
}

function buildFilterCategories(byName) {
  const out = {};

  for (const name of ANALYZE_FILTER_NAMES) {
    const category = inferFilterCategory(name);

    if (!out[category]) out[category] = [];

    out[category].push({
      name,
      value: Object.prototype.hasOwnProperty.call(byName, name)
        ? byName[name]
        : null,
      captured: Object.prototype.hasOwnProperty.call(byName, name)
    });
  }

  return out;
}

function inferFilterCategory(name) {
  if (/DISCOVERY|ENABLE_/.test(name)) return "Feature Toggles";
  if (/SPREAD|DEPTH/.test(name)) return "Spread & Depth";
  if (/RR|TP|SL|RISK|REWARD/.test(name)) return "Risk Reward";
  if (/SNIPER|CONFLUENCE|SCORE|POINTS/.test(name)) return "Score & Confluence";
  if (/OB_|ORDERBOOK|NEUTRAL_OB/.test(name)) return "Orderbook";
  if (/RSI/.test(name)) return "RSI";
  if (/TREND|MOMENTUM|VOL|FLOW|PULLBACK/.test(name)) return "Trend & Momentum";
  if (/BTC_BULLISH_BEAR/.test(name)) return "BTC Exception";
  if (/FUNDING/.test(name)) return "Funding";
  if (/OPEN_POSITIONS|COUNTER_BTC/.test(name)) return "Exposure";
  if (/QUALITY|ENTRY_CONFIRMATION|EARLY/.test(name)) return "Quality Gates";
  if (/BREAK_EVEN|HALF_R|ONE_R|MFE|MAE|PRICE_PATH/.test(name)) return "Path Tracking";
  if (/SHADOW|POST_EXIT|FOLLOW_THROUGH|RECOVERY/.test(name)) return "Shadow & Post Exit";
  if (/BEST_SETUP|FINAL_DECISION|OPTIMIZER/.test(name)) return "Optimizer";
  if (/COOLDOWN|CONCURRENCY/.test(name)) return "Runtime";
  return "Other";
}

// ================= BUCKETS =================

function bucketAction(value) {
  const a = clean(value || "UNKNOWN");
  if (a === "ENTRY") return "ACTION_ENTRY";
  if (a === "EXIT") return "ACTION_EXIT";
  if (a === "HOLD") return "ACTION_HOLD";
  if (a === "WAIT") return "ACTION_WAIT";
  return "ACTION_UNKNOWN";
}

function bucketReason(reason) {
  const r = clean(reason || "UNKNOWN");

  if (r.includes("RR")) return "REASON_RR";
  if (r.includes("RSI")) return "REASON_RSI";
  if (r.includes("OB")) return "REASON_OB";
  if (r.includes("SPREAD")) return "REASON_SPREAD";
  if (r.includes("DEPTH")) return "REASON_DEPTH";
  if (r.includes("BTC")) return "REASON_BTC";
  if (r.includes("FUNDING")) return "REASON_FUNDING";
  if (r.includes("CONFLUENCE")) return "REASON_CONFLUENCE";
  if (r.includes("SNIPER")) return "REASON_SNIPER";
  if (r.includes("TP")) return "REASON_TP";
  if (r.includes("SL")) return "REASON_SL";
  if (r.includes("ENTRY")) return "REASON_ENTRY";

  return r.slice(0, 40);
}

function bucketStage(stage) {
  const s = clean(stage || "UNKNOWN");
  if (s === "ENTRY") return "STAGE_ENTRY";
  if (s === "ALMOST") return "STAGE_ALMOST";
  if (s === "BUILDUP" || s === "BUILDING") return "STAGE_BUILDUP";
  if (s === "RADAR") return "STAGE_RADAR";
  if (s === "OPEN_POSITION") return "STAGE_OPEN_POSITION";
  return `STAGE_${s}`;
}

function bucketScore(value) {
  const n = safeNumber(value, 0);
  if (n < 20) return "SCORE_0_20";
  if (n < 40) return "SCORE_20_40";
  if (n < 60) return "SCORE_40_60";
  if (n < 75) return "SCORE_60_75";
  if (n < 85) return "SCORE_75_85";
  if (n < 92) return "SCORE_85_92";
  return "SCORE_92_100";
}

function bucketConfluence(value) {
  const n = safeNumber(value, 0);
  if (n < 30) return "CONF_0_30";
  if (n < 50) return "CONF_30_50";
  if (n < 65) return "CONF_50_65";
  if (n < 75) return "CONF_65_75";
  if (n < 85) return "CONF_75_85";
  if (n < 92) return "CONF_85_92";
  return "CONF_92_100";
}

function bucketSniper(value) {
  const n = safeNumber(value, 0);
  if (n < 30) return "SNIPER_0_30";
  if (n < 50) return "SNIPER_30_50";
  if (n < 65) return "SNIPER_50_65";
  if (n < 75) return "SNIPER_65_75";
  if (n < 85) return "SNIPER_75_85";
  if (n < 92) return "SNIPER_85_92";
  return "SNIPER_92_100";
}

function bucketRR(value) {
  const n = safeNumber(value, 0);
  if (n <= 0) return "RR_NONE";
  if (n < 0.50) return "RR_0_0p50";
  if (n < 0.80) return "RR_0p50_0p80";
  if (n < 1.00) return "RR_0p80_1p00";
  if (n < 1.20) return "RR_1p00_1p20";
  if (n < 1.50) return "RR_1p20_1p50";
  if (n < 2.00) return "RR_1p50_2p00";
  if (n < 3.00) return "RR_2p00_3p00";
  return "RR_GT_3p00";
}

function bucketRsiValue(value) {
  const n = safeNumber(value, 50);
  if (n < 26) return "RSI_0_26";
  if (n < 33) return "RSI_26_33";
  if (n < 40) return "RSI_33_40";
  if (n < 50) return "RSI_40_50";
  if (n < 60) return "RSI_50_60";
  if (n < 67) return "RSI_60_67";
  if (n < 74) return "RSI_67_74";
  return "RSI_74_100";
}

function bucketRsiDirectionalEdge(row) {
  const zone = clean(row.rsiZone || "UNKNOWN");
  const side = normalizeSide(row.side);

  const lower = zone.startsWith("LOWER");
  const upper = zone.startsWith("UPPER");
  const mid = zone === "MID";

  if (mid) return "RSI_EDGE_MID";

  if (side === "bull" && lower) return "RSI_EDGE_FAVORABLE";
  if (side === "bull" && upper) return "RSI_EDGE_AGAINST";

  if (side === "bear" && upper) return "RSI_EDGE_FAVORABLE";
  if (side === "bear" && lower) return "RSI_EDGE_AGAINST";

  return "RSI_EDGE_UNKNOWN";
}

function bucketObBias(value) {
  const v = clean(value || "UNKNOWN");
  if (["BULLISH", "BEARISH", "NEUTRAL"].includes(v)) return `OB_${v}`;
  return "OB_UNKNOWN";
}

function bucketObRelation(row) {
  const side = normalizeSide(row.side);
  const ob = clean(row.obBias || "UNKNOWN");

  if (ob === "NEUTRAL" || ob === "UNKNOWN") return "OB_REL_NEUTRAL";

  if (side === "bull" && ob === "BULLISH") return "OB_REL_WITH";
  if (side === "bear" && ob === "BEARISH") return "OB_REL_WITH";

  if (side === "bull" && ob === "BEARISH") return "OB_REL_AGAINST";
  if (side === "bear" && ob === "BULLISH") return "OB_REL_AGAINST";

  return "OB_REL_UNKNOWN";
}

function bucketSpread(value) {
  const spread = normalizeSpread(value);
  const bps = spread * 10_000;

  if (bps <= 0) return "SPREAD_UNKNOWN";
  if (bps < 5) return "SPREAD_LT_5BPS";
  if (bps < 8) return "SPREAD_5_8BPS";
  if (bps < 12) return "SPREAD_8_12BPS";
  if (bps < 16) return "SPREAD_12_16BPS";
  if (bps < 25) return "SPREAD_16_25BPS";
  if (bps < 40) return "SPREAD_25_40BPS";
  return "SPREAD_GT_40BPS";
}

function bucketDepth(value) {
  const d = safeNumber(value, 0);

  if (d <= 0) return "DEPTH_MISSING";
  if (d < 10_000) return "DEPTH_LT_10K";
  if (d < 50_000) return "DEPTH_10K_50K";
  if (d < 100_000) return "DEPTH_50K_100K";
  if (d < 250_000) return "DEPTH_100K_250K";
  if (d < 500_000) return "DEPTH_250K_500K";
  if (d < 1_000_000) return "DEPTH_500K_1M";
  return "DEPTH_GT_1M";
}

function bucketFlow(value) {
  const v = clean(value || "UNKNOWN");
  if (["TREND", "BUILDING", "NEUTRAL"].includes(v)) return `FLOW_${v}`;
  if (v.includes("TREND")) return "FLOW_TREND";
  if (v.includes("BUILD")) return "FLOW_BUILDING";
  return `FLOW_${v}`;
}

function bucketBtcState(value) {
  const v = clean(value || "UNKNOWN");
  if (["STRONG_BULL", "BULLISH", "NEUTRAL", "BEARISH", "STRONG_BEAR"].includes(v)) {
    return `BTC_${v}`;
  }

  return "BTC_UNKNOWN";
}

function bucketBtcRelation(row) {
  const side = normalizeSide(row.side);
  const btc = clean(row.btcState || "UNKNOWN");

  if (side === "bull" && ["BULLISH", "STRONG_BULL"].includes(btc)) return "BTC_REL_WITH";
  if (side === "bear" && ["BEARISH", "STRONG_BEAR"].includes(btc)) return "BTC_REL_WITH";

  if (side === "bull" && ["BEARISH", "STRONG_BEAR"].includes(btc)) return "BTC_REL_COUNTER";
  if (side === "bear" && ["BULLISH", "STRONG_BULL"].includes(btc)) return "BTC_REL_COUNTER";

  return "BTC_REL_NEUTRAL";
}

function bucketTfStrength(value) {
  const n = Math.abs(safeNumber(value, 0));
  if (n < 0.5) return "TF_0_0p5";
  if (n < 1) return "TF_0p5_1";
  if (n < 2) return "TF_1_2";
  if (n < 3) return "TF_2_3";
  return "TF_GT_3";
}

function bucketSigned(value, prefix) {
  const n = safeNumber(value, 0);
  if (n <= -3) return `${prefix}_NEG_3`;
  if (n <= -2) return `${prefix}_NEG_2`;
  if (n <= -1) return `${prefix}_NEG_1`;
  if (n < 1) return `${prefix}_FLAT`;
  if (n < 2) return `${prefix}_POS_1`;
  if (n < 3) return `${prefix}_POS_2`;
  return `${prefix}_POS_3`;
}

function bucketMomentum(value, prefix) {
  const n = safeNumber(value, 0);
  if (n <= -10) return `${prefix}_DUMP_GT_10`;
  if (n <= -5) return `${prefix}_DOWN_5_10`;
  if (n <= -2) return `${prefix}_DOWN_2_5`;
  if (n < -0.5) return `${prefix}_DOWN_0p5_2`;
  if (n <= 0.5) return `${prefix}_FLAT`;
  if (n < 2) return `${prefix}_UP_0p5_2`;
  if (n < 5) return `${prefix}_UP_2_5`;
  if (n < 10) return `${prefix}_UP_5_10`;
  return `${prefix}_PUMP_GT_10`;
}

function bucketFunding(value) {
  const n = safeNumber(value, 0);

  if (n <= -0.015) return "FUNDING_NEG_EXTREME";
  if (n <= -0.008) return "FUNDING_NEG_HIGH";
  if (n < -0.002) return "FUNDING_NEG";
  if (n <= 0.002) return "FUNDING_NEUTRAL";
  if (n < 0.008) return "FUNDING_POS";
  if (n < 0.015) return "FUNDING_POS_HIGH";
  return "FUNDING_POS_EXTREME";
}

function bucketPctDistance(value) {
  const n = Math.abs(safeNumber(value, 0));

  if (n <= 0) return "DIST_UNKNOWN";
  if (n < 0.0025) return "DIST_LT_0p25";
  if (n < 0.005) return "DIST_0p25_0p50";
  if (n < 0.010) return "DIST_0p50_1p00";
  if (n < 0.020) return "DIST_1p00_2p00";
  return "DIST_GT_2p00";
}

function bucketBool(value, label) {
  return value ? `${label}_YES` : `${label}_NO`;
}

function bucketRiskWidth(row) {
  const entry = safeNumber(row.entry, 0);
  const sl = safeNumber(row.initialSl || row.sl, 0);

  if (!entry || !sl) return "RISK_WIDTH_UNKNOWN";

  const pct = Math.abs(entry - sl) / entry;

  if (pct < 0.003) return "RISK_WIDTH_LT_0p3";
  if (pct < 0.006) return "RISK_WIDTH_0p3_0p6";
  if (pct < 0.010) return "RISK_WIDTH_0p6_1p0";
  if (pct < 0.020) return "RISK_WIDTH_1p0_2p0";
  return "RISK_WIDTH_GT_2p0";
}

function bucketQuality(row) {
  const conf = safeNumber(row.confluence, 0);
  const sniper = safeNumber(row.sniperScore, 0);
  const rr = safeNumber(row.finalRr || row.plannedRR || row.rr, 0);

  if (conf >= 85 && sniper >= 85 && rr >= 1.2) return "QUALITY_ELITE";
  if (conf >= 75 && sniper >= 75 && rr >= 1.0) return "QUALITY_HIGH";
  if (conf >= 60 && sniper >= 60 && rr >= 0.8) return "QUALITY_MID";
  if (conf >= 45 && sniper >= 45) return "QUALITY_LOW";
  return "QUALITY_WEAK";
}

function bucketFeatureFlags(filterValues = {}) {
  const flat = flattenObject(filterValues);
  const byName = buildFilterByName(flat);

  const flags = [
    byName.DISCOVERY_MODE === true ? "DISCOVERY" : "LIVE",
    byName.ENABLE_B_ENTRIES === false ? "B_OFF" : "B_ON",
    byName.ENABLE_BULLISH_MID_TREND_PROBES === false ? "PROBE_OFF" : "PROBE_ON",
    byName.ENABLE_BTC_BULLISH_BEAR_EXCEPTION === false ? "BTC_EXC_OFF" : "BTC_EXC_ON",
    byName.ENABLE_ENTRY_QUALITY_GATE_V12 === true ? "QG_ON" : "QG_OFF",
    byName.ENABLE_BREAK_EVEN_RULE === true ? "BE_ON" : "BE_OFF"
  ];

  return flags.join("+");
}

// ================= NUMERIC PROFILE =================

function createNumericCollector() {
  return {
    score: [],
    confluence: [],
    rawConfluence: [],
    sniperScore: [],
    plannedRR: [],
    baseRR: [],
    finalRr: [],
    rsi: [],
    rsiHTF: [],
    spreadPct: [],
    depthMinUsd1p: [],
    funding: [],
    tfScore: [],
    tfStrength: [],
    change1h: [],
    change24: [],
    distanceFromLocalHighPct: []
  };
}

function collectNumericFields(collector, row) {
  for (const key of Object.keys(collector)) {
    const value = safeNumber(row[key], null);
    if (value === null) continue;
    collector[key].push(value);
  }
}

function finalizeNumericCollector(collector) {
  const out = {};

  for (const [key, values] of Object.entries(collector)) {
    out[key] = {
      min: round(min(values), 6),
      max: round(max(values), 6),
      avg: round(avg(values), 6),
      count: values.length
    };
  }

  return out;
}

// ================= EXAMPLES =================

function compactActionExample(row) {
  return {
    ts: row.ts,
    action: row.action,
    reason: row.reason,
    symbol: row.symbol,
    side: row.side,
    setupClass: row.setupClass,
    score: row.score,
    confluence: row.confluence,
    sniperScore: row.sniperScore,
    rr: row.plannedRR || row.rr,
    rsiZone: row.rsiZone,
    obBias: row.obBias,
    spreadPct: row.spreadPct,
    depthMinUsd1p: row.depthMinUsd1p
  };
}

function compactTradeExample(trade) {
  return {
    tradeId: trade.tradeId,
    status: trade.status,
    symbol: trade.symbol,
    side: trade.side,
    setupClass: trade.setupClass,
    entryReason: trade.entryReason,
    exitReason: trade.exitReason,
    entry: trade.entry,
    sl: trade.initialSl || trade.sl,
    tp: trade.tp,
    exit: trade.exit,
    exitR: trade.exitR,
    pnlPct: trade.pnlPct,
    mfeR: trade.mfeR,
    maeR: trade.maeR,
    rsiZone: trade.rsiZone,
    obBias: trade.obBias,
    btcState: trade.btcState
  };
}

// ================= STATE MAINTENANCE =================

function trimState(state) {
  state.actions = state.actions.slice(-MAX_ACTION_ROWS);

  const open = state.trades.filter(t => t.status === "OPEN");
  const closed = state.trades.filter(t => t.status === "CLOSED").slice(-MAX_TRADE_ROWS);

  state.trades = [...closed, ...open].slice(-(MAX_TRADE_ROWS + 500));
  state.filterSnapshots = state.filterSnapshots.slice(-MAX_FILTER_SNAPSHOTS);

  rebuildOpenIndex(state);
}

function rebuildOpenIndex(state) {
  state.openIndex = {};

  for (const trade of state.trades || []) {
    if (trade.status !== "OPEN") continue;
    if (!trade.symbol || !trade.side || !trade.tradeId) continue;

    state.openIndex[`${trade.symbol}_${trade.side}`] = trade.tradeId;
  }
}

// ================= UTILS =================

function normalizeBaseSymbol(raw) {
  return String(raw || "")
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
}

function normalizeSide(raw) {
  const s = String(raw || "").toLowerCase().trim();

  if (s === "long") return "bull";
  if (s === "short") return "bear";
  if (s === "bull" || s === "bear") return s;

  return "unknown";
}

function normalizeSpread(value) {
  let n = safeNumber(value, 0);

  if (n < 0) n = 0;
  if (n > 0.05) n = n / 100;

  return n;
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clean(value) {
  return String(value || "UNKNOWN")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function round(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function sum(values) {
  return values
    .map(Number)
    .filter(Number.isFinite)
    .reduce((a, b) => a + b, 0);
}

function avg(values) {
  const arr = values
    .map(Number)
    .filter(Number.isFinite);

  if (!arr.length) return 0;
  return sum(arr) / arr.length;
}

function min(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  return arr.length ? Math.min(...arr) : 0;
}

function max(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  return arr.length ? Math.max(...arr) : 0;
}

function ratio(a, b) {
  const x = safeNumber(a, 0);
  const y = safeNumber(b, 0);
  return y ? round(x / y, 4) : 0;
}

function formatPct(a, b) {
  const r = ratio(a, b);
  return `${round(r * 100, 1)}%`;
}

function pushLimited(arr, value, maxLen) {
  arr.push(value);
  if (arr.length > maxLen) arr.shift();
}

function sortObjectByValue(obj) {
  return Object.fromEntries(
    Object.entries(obj || {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
  );
}

function topCounts(obj, limit = 10) {
  return Object.entries(obj || {})
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => Number(b.count) - Number(a.count))
    .slice(0, limit);
}

function flattenObject(value, prefix = "", out = {}) {
  if (!value || typeof value !== "object") return out;

  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      flattenObject(item, path, out);
    } else {
      out[path] = item;
    }
  }

  return out;
}

function buildFilterByName(flat) {
  const byName = {};

  for (const [path, value] of Object.entries(flat || {})) {
    const name = path.split(".").at(-1);
    byName[name] = value;
  }

  return byName;
}

function stableHash(text) {
  let hash = 2166136261;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return `F${(hash >>> 0).toString(36).toUpperCase()}`;
}