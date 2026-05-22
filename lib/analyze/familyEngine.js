// ================= lib/analyze/familyEngine.js =================
// 50 LONG + 50 SHORT broad filter families.
// FIX: observed/open/closed/shadow zijn strikt gescheiden.
// FIX: closed telt alleen als er echte outcome-data is: exitR/pnlPct/exit/closedAt/status HIT_*.
// FIX: rr wordt nooit gebruikt als exitR. rr = planned RR, exitR = realized outcome.

export const ANALYZE_FAMILY_VERSION = "ANALYZE_FAMILIES_V4_OUTCOME_SAFE";

export const TRACKED_FILTERS = [
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

const QUALITY_DEFS = {
  1: {
    code: "Q1_WEAK",
    conf: "CONF_0_50",
    sniper: "SNIPER_0_50",
    rr: "RR_LT_1p00",
    score: "SCORE_0_50"
  },
  2: {
    code: "Q2_LOW",
    conf: "CONF_50_65",
    sniper: "SNIPER_50_65",
    rr: "RR_1p00_1p20",
    score: "SCORE_50_65"
  },
  3: {
    code: "Q3_BASE",
    conf: "CONF_65_75",
    sniper: "SNIPER_65_75",
    rr: "RR_1p20_1p50",
    score: "SCORE_65_75"
  },
  4: {
    code: "Q4_STRONG",
    conf: "CONF_75_85",
    sniper: "SNIPER_75_85",
    rr: "RR_1p50_2p00",
    score: "SCORE_75_85"
  },
  5: {
    code: "Q5_ELITE",
    conf: "CONF_85_100",
    sniper: "SNIPER_85_100",
    rr: "RR_2p00_PLUS",
    score: "SCORE_85_100"
  }
};

const MARKET_DEFS = {
  1: {
    code: "M1_DIRTY",
    ob: "OB_REL_AGAINST",
    spread: "SPREAD_GT_25BPS",
    depth: "DEPTH_LT_10K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_CROWDED"
  },
  2: {
    code: "M2_WEAK",
    ob: "OB_REL_AGAINST_OR_NEUTRAL",
    spread: "SPREAD_16_25BPS",
    depth: "DEPTH_10K_50K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_EDGE_WEAK"
  },
  3: {
    code: "M3_NORMAL",
    ob: "OB_REL_NEUTRAL",
    spread: "SPREAD_8_16BPS",
    depth: "DEPTH_50K_100K",
    btc: "BTC_REL_NEUTRAL",
    funding: "FUNDING_NEUTRAL"
  },
  4: {
    code: "M4_CLEAN",
    ob: "OB_REL_WITH_OR_NEUTRAL",
    spread: "SPREAD_5_12BPS",
    depth: "DEPTH_100K_250K",
    btc: "BTC_REL_WITH_OR_NEUTRAL",
    funding: "FUNDING_OK"
  },
  5: {
    code: "M5_PREMIUM",
    ob: "OB_REL_WITH",
    spread: "SPREAD_LT_8BPS",
    depth: "DEPTH_GT_250K",
    btc: "BTC_REL_WITH",
    funding: "FUNDING_OPTIMAL"
  }
};

const TIMING_DEFS = {
  LONG: {
    1: {
      code: "T1_EARLY_OR_NOISY",
      stage: "STAGE_ANY",
      flow: "FLOW_ANY",
      rsi: "RSI_ANY",
      tf: "TF_ANY",
      pullback: "PULLBACK_NOT_REQUIRED"
    },
    2: {
      code: "T2_TIMED",
      stage: "STAGE_ENTRY_OR_ALMOST",
      flow: "FLOW_TREND_OR_BUILDING",
      rsi: "RSI_LOWER_OR_MID",
      tf: "TF_ALIGNED",
      pullback: "PULLBACK_OR_CONFIRMATION_OK"
    }
  },
  SHORT: {
    1: {
      code: "T1_EARLY_OR_NOISY",
      stage: "STAGE_ANY",
      flow: "FLOW_ANY",
      rsi: "RSI_ANY",
      tf: "TF_ANY",
      pullback: "PULLBACK_NOT_REQUIRED"
    },
    2: {
      code: "T2_TIMED",
      stage: "STAGE_ENTRY_OR_ALMOST",
      flow: "FLOW_TREND_OR_BUILDING",
      rsi: "RSI_UPPER_OR_MID",
      tf: "TF_ALIGNED",
      pullback: "PULLBACK_OR_CONFIRMATION_OK"
    }
  }
};

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

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

export function normalizeAnalyzeSide(side) {
  const s = String(side || "").toLowerCase();

  if (s === "long" || s === "bull" || s === "buy") return "LONG";
  if (s === "short" || s === "bear" || s === "sell") return "SHORT";

  return "UNKNOWN";
}

function normalizeAction(action) {
  return String(action || "UNKNOWN").toUpperCase();
}

function normalizeStatus(status) {
  return String(status || "").toUpperCase();
}

function normalizeSetupClass(value) {
  const raw = String(value || "NONE").toUpperCase();

  if (raw.includes("GOD")) return "GOD";
  if (raw.includes("A_SHORT")) return "A_SHORT_EXCEPTION";
  if (raw === "A") return "A";
  if (raw.includes("B_TREND")) return "B_TREND_PROBE";
  if (raw === "B") return "B";

  return raw || "NONE";
}

function normalizeSpread(spreadPct) {
  let s = safeNumber(spreadPct, 0);

  if (s < 0) return 0;
  if (s > 0.05) s /= 100;

  return s;
}

function getPlannedRR(row) {
  return safeNumber(
    row?.plannedRR ??
    row?.finalRr ??
    row?.effectiveRR ??
    row?.baseRR ??
    row?.rr,
    0
  );
}

function getExitPrice(row) {
  return safeNumber(
    row?.exit ??
    row?.executionPrice ??
    row?.triggerPrice ??
    row?.exitPrice ??
    row?.closePrice,
    0
  );
}

function calculateExitRFromGeometry(row) {
  const side = normalizeAnalyzeSide(row?.side);
  const entry = safeNumber(row?.entry, 0);
  const sl = safeNumber(row?.initialSl ?? row?.originalSl ?? row?.sl, 0);
  const exit = getExitPrice(row);

  if (!entry || !sl || !exit) return null;

  const riskDist = Math.abs(entry - sl);
  if (!riskDist) return null;

  const pnl = side === "LONG"
    ? exit - entry
    : entry - exit;

  const r = pnl / riskDist;
  return Number.isFinite(r) ? r : null;
}

function getExitR(row) {
  const candidates = [
    row?.exitR,
    row?.realizedR,
    row?.rMultiple,
    row?.resultR,
    row?.closedR
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return calculateExitRFromGeometry(row);
}

function calculatePnlPctFromGeometry(row) {
  const side = normalizeAnalyzeSide(row?.side);
  const entry = safeNumber(row?.entry, 0);
  const exit = getExitPrice(row);

  if (!entry || !exit) return null;

  const pnlPct = side === "LONG"
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;

  return Number.isFinite(pnlPct) ? pnlPct : null;
}

function getPnlPct(row) {
  const candidates = [
    row?.pnlPct,
    row?.realizedPnlPct,
    row?.profitPct,
    row?.pnlPercentage,
    row?.triggerPnlPct
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return calculatePnlPctFromGeometry(row);
}

function isShadowRow(row) {
  const source = String(row?.source || row?.originSource || "").toUpperCase();
  const status = normalizeStatus(row?.status);

  return (
    source.includes("SHADOW") ||
    status === "HIT_TP" ||
    status === "HIT_SL" ||
    status === "HORIZON_DONE"
  );
}

function hasRealOutcome(row) {
  const exitR = getExitR(row);
  const pnlPct = getPnlPct(row);
  const exitPrice = getExitPrice(row);

  const status = normalizeStatus(row?.status);
  const action = normalizeAction(row?.action);
  const reason = String(row?.reason || row?.exitReason || "").toUpperCase();

  const outcomeStatus = [
    "CLOSED",
    "DONE",
    "EXITED",
    "HIT_TP",
    "HIT_SL",
    "HORIZON_DONE",
    "TP",
    "SL",
    "BE_SL"
  ].includes(status);

  const outcomeReason = [
    "TP",
    "SL",
    "BE_SL",
    "EARLY_NO_FOLLOW_THROUGH",
    "EARLY_OB_FLIP"
  ].includes(reason);

  return (
    Number.isFinite(exitR) ||
    Number.isFinite(pnlPct) ||
    exitPrice > 0 ||
    action === "EXIT" ||
    outcomeStatus ||
    outcomeReason ||
    row?.closedAt ||
    row?.completedAt ||
    row?.exitedAt
  );
}

function isClosedOutcome(row) {
  const status = normalizeStatus(row?.status);
  const action = normalizeAction(row?.action);

  if (status === "OPEN") return false;
  if (status === "ACTIVE") return false;

  return hasRealOutcome(row) && (
    action === "EXIT" ||
    status === "CLOSED" ||
    status === "DONE" ||
    status === "EXITED" ||
    status === "HIT_TP" ||
    status === "HIT_SL" ||
    status === "HORIZON_DONE" ||
    Boolean(row?.closedAt) ||
    Boolean(row?.completedAt) ||
    Boolean(row?.exitedAt)
  );
}

function isOpenPositionRow(row) {
  if (isClosedOutcome(row)) return false;

  const action = normalizeAction(row?.action);
  const status = normalizeStatus(row?.status);

  return (
    action === "ENTRY" ||
    action === "HOLD" ||
    status === "OPEN" ||
    Boolean(row?.fromOpenPosition) ||
    Boolean(row?.positionOpen)
  );
}

function qualityBucketByScore(value) {
  const n = safeNumber(value, 0);

  if (n >= 85) return 5;
  if (n >= 75) return 4;
  if (n >= 65) return 3;
  if (n >= 50) return 2;

  return 1;
}

function qualityBucketByRR(value) {
  const n = safeNumber(value, 0);

  if (n >= 2.0) return 5;
  if (n >= 1.5) return 4;
  if (n >= 1.2) return 3;
  if (n >= 1.0) return 2;

  return 1;
}

function classifyQualityIndex(row) {
  const conf = qualityBucketByScore(row.confluence);
  const sniper = qualityBucketByScore(row.sniperScore);
  const score = qualityBucketByScore(row.score);
  const rr = qualityBucketByRR(row.plannedRR);

  return Math.max(1, Math.min(conf, sniper, score, rr));
}

function getObRelation(row) {
  const side = normalizeAnalyzeSide(row?.side);
  const ob = String(row?.obBias || "UNKNOWN").toUpperCase();

  if (ob === "NEUTRAL" || ob === "UNKNOWN") return "NEUTRAL";
  if (side === "LONG" && ob === "BULLISH") return "WITH";
  if (side === "SHORT" && ob === "BEARISH") return "WITH";
  if (side === "LONG" && ob === "BEARISH") return "AGAINST";
  if (side === "SHORT" && ob === "BULLISH") return "AGAINST";

  return "NEUTRAL";
}

function getBtcRelation(row) {
  const side = normalizeAnalyzeSide(row?.side);
  const btc = String(row?.btcState || "UNKNOWN").toUpperCase();

  if (btc === "NEUTRAL" || btc === "UNKNOWN") return "NEUTRAL";
  if (side === "LONG" && ["BULLISH", "STRONG_BULL"].includes(btc)) return "WITH";
  if (side === "SHORT" && ["BEARISH", "STRONG_BEAR"].includes(btc)) return "WITH";
  if (side === "LONG" && ["BEARISH", "STRONG_BEAR"].includes(btc)) return "COUNTER";
  if (side === "SHORT" && ["BULLISH", "STRONG_BULL"].includes(btc)) return "COUNTER";

  return "NEUTRAL";
}

function scoreObRelation(row) {
  const rel = getObRelation(row);
  if (rel === "WITH") return 5;
  if (rel === "NEUTRAL") return 3;
  return 1;
}

function scoreBtcRelation(row) {
  const rel = getBtcRelation(row);
  if (rel === "WITH") return 5;
  if (rel === "NEUTRAL") return 3;
  return 1;
}

function scoreSpread(row) {
  const bps = normalizeSpread(row.spreadPct) * 10000;

  if (bps < 8) return 5;
  if (bps < 12) return 4;
  if (bps < 16) return 3;
  if (bps < 25) return 2;

  return 1;
}

function scoreDepth(row) {
  const d = safeNumber(row.depthMinUsd1p, 0);

  if (d >= 250000) return 5;
  if (d >= 100000) return 4;
  if (d >= 50000) return 3;
  if (d >= 10000) return 2;

  return 1;
}

function scoreFunding(row) {
  const side = normalizeAnalyzeSide(row?.side);
  const f = safeNumber(row.funding, 0);

  if (Math.abs(f) <= 0.002) return 3;

  if (side === "LONG") {
    if (f < -0.008) return 5;
    if (f < -0.002) return 4;
    if (f > 0.008) return 1;
    return 2;
  }

  if (side === "SHORT") {
    if (f > 0.008) return 5;
    if (f > 0.002) return 4;
    if (f < -0.008) return 1;
    return 2;
  }

  return 3;
}

function classifyMarketIndex(row) {
  const values = [
    scoreObRelation(row),
    scoreSpread(row),
    scoreDepth(row),
    scoreBtcRelation(row),
    scoreFunding(row)
  ];

  const avg = values.reduce((sum, n) => sum + n, 0) / values.length;

  return Math.max(1, Math.min(5, Math.round(avg)));
}

function isFavorableRsiForSide(row) {
  const side = normalizeAnalyzeSide(row?.side);
  const zone = String(row?.rsiZone || "UNKNOWN").toUpperCase();

  if (zone === "MID") return true;
  if (side === "LONG" && zone.startsWith("LOWER")) return true;
  if (side === "SHORT" && zone.startsWith("UPPER")) return true;

  return false;
}

function isTfAligned(row) {
  const strength = Math.abs(safeNumber(row.tfStrength, 0));
  const alignment = String(row.tfAlignment || "").toUpperCase();

  return (
    strength >= 1 ||
    alignment.includes("ALIGNED") ||
    alignment.includes("BULL") ||
    alignment.includes("BEAR")
  );
}

function hasPullbackOrConfirmation(row) {
  return Boolean(
    row.pullbackConfirmed ||
    row.sweepConfirmed ||
    row.retestConfirmed ||
    row.fakeBreakout ||
    row.fakeBreakoutConfirmed ||
    row.confirmationSeen ||
    row.bullishMidTrendProbe ||
    row.btcBullishBearException
  );
}

function classifyTimingIndex(row) {
  const stage = String(row.stage || "").toLowerCase();
  const flow = String(row.flow || "").toUpperCase();

  const checks = [
    stage === "entry" || stage === "almost",
    flow === "TREND" || flow === "BUILDING",
    isFavorableRsiForSide(row),
    isTfAligned(row),
    hasPullbackOrConfirmation(row)
  ];

  const score = checks.filter(Boolean).length;
  return score >= 3 ? 2 : 1;
}

function familyIndexFromParts(q, m, t) {
  return ((q - 1) * 10) + ((m - 1) * 2) + t;
}

function buildFamilyDefinition(side, q, m, t) {
  const qDef = QUALITY_DEFS[q];
  const mDef = MARKET_DEFS[m];
  const tDef = TIMING_DEFS[side][t];

  return [
    qDef.code,
    mDef.code,
    tDef.code,
    qDef.conf,
    qDef.sniper,
    qDef.rr,
    qDef.score,
    tDef.stage,
    tDef.flow,
    tDef.rsi,
    mDef.ob,
    mDef.spread,
    mDef.depth,
    mDef.btc,
    mDef.funding,
    tDef.tf,
    tDef.pullback
  ].join(" | ");
}

function emptyFamilyMetrics() {
  return {
    observed: 0,

    open: 0,

    closed: 0,
    realClosed: 0,
    shadowClosed: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    winrate: "0.0%",
    winrateNum: 0,

    totalR: 0,
    avgR: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    directSL: 0,
    directSLPct: "0.0%",

    avgMfeR: 0,
    avgMaeR: 0,

    status: "EMPTY",

    examples: []
  };
}

export function buildBaseFamilies() {
  const families = [];

  for (const side of ["LONG", "SHORT"]) {
    for (let q = 1; q <= 5; q++) {
      for (let m = 1; m <= 5; m++) {
        for (let t = 1; t <= 2; t++) {
          const index = familyIndexFromParts(q, m, t);
          const familyId = `${side}_${index}`;

          families.push({
            familyId,
            side,
            index,

            qualityIndex: q,
            marketIndex: m,
            timingIndex: t,

            quality: QUALITY_DEFS[q].code,
            market: MARKET_DEFS[m].code,
            timing: TIMING_DEFS[side][t].code,

            definition: buildFamilyDefinition(side, q, m, t),

            ...emptyFamilyMetrics()
          });
        }
      }
    }
  }

  return families;
}

export function assignFamilyId(row) {
  const side = normalizeAnalyzeSide(row?.side);
  if (side !== "LONG" && side !== "SHORT") return "UNKNOWN";

  const normalized = normalizeAnalyzeRowBase(row);

  const q = classifyQualityIndex(normalized);
  const m = classifyMarketIndex(normalized);
  const t = classifyTimingIndex(normalized);

  const index = familyIndexFromParts(q, m, t);
  return `${side}_${index}`;
}

function normalizeAnalyzeRowBase(row) {
  return {
    ...row,

    symbol: normalizeBaseSymbol(row?.symbol),
    side: normalizeAnalyzeSide(row?.side),

    action: normalizeAction(row?.action),
    status: normalizeStatus(row?.status),

    setupClass: normalizeSetupClass(row?.setupClass),

    score: safeNumber(row?.score ?? row?.moveScore, 0),
    confluence: safeNumber(row?.confluence ?? row?.effectiveConfluence, 0),
    sniperScore: safeNumber(row?.sniperScore ?? row?.sniper, 0),

    plannedRR: getPlannedRR(row),

    rsi: safeNumber(row?.rsi, 0),
    rsiHTF: safeNumber(row?.rsiHTF, 0),
    rsiZone: String(row?.rsiZone || "UNKNOWN").toUpperCase(),

    obBias: String(row?.obBias || "UNKNOWN").toUpperCase(),
    spreadPct: normalizeSpread(row?.spreadPct),
    depthMinUsd1p: safeNumber(row?.depthMinUsd1p, 0),

    btcState: String(row?.btcState || "UNKNOWN").toUpperCase(),
    funding: safeNumber(row?.funding, 0),

    tfScore: safeNumber(row?.tfScore, 0),
    tfStrength: safeNumber(row?.tfStrength, 0),
    tfAlignment: String(row?.tfAlignment || "UNKNOWN").toUpperCase(),

    flow: String(row?.flow || "UNKNOWN").toUpperCase(),
    stage: String(row?.stage || "unknown").toLowerCase(),

    pullbackConfirmed: Boolean(row?.pullbackConfirmed),
    sweepConfirmed: Boolean(row?.sweepConfirmed),
    retestConfirmed: Boolean(row?.retestConfirmed),
    fakeBreakout: Boolean(row?.fakeBreakout || row?.fakeBreakoutConfirmed),
    confirmationSeen: Boolean(row?.confirmationSeen),

    bullishMidTrendProbe: Boolean(row?.bullishMidTrendProbe),
    btcBullishBearException: Boolean(row?.btcBullishBearException)
  };
}

export function normalizeAnalyzeRow(row, meta = {}) {
  const base = normalizeAnalyzeRowBase({
    ...(row || {}),
    ...meta
  });

  const exitR = getExitR(base);
  const pnlPct = getPnlPct(base);

  const closed = isClosedOutcome(base);
  const shadow = isShadowRow(base);
  const open = isOpenPositionRow(base);

  const familyId =
    base.familyId ||
    base.family ||
    base.familyKey ||
    assignFamilyId(base);

  const tradeKey =
    base.tradeId ||
    base.id ||
    [
      base.symbol,
      base.side,
      base.entry || "",
      base.createdAt || "",
      base.ts || ""
    ].filter(Boolean).join("_");

  return {
    ...base,

    familyId,
    tradeKey,

    source: String(base.source || meta.source || "ACTION").toUpperCase(),

    ts: safeNumber(base.ts || base.createdAt || base.completedAt || Date.now(), Date.now()),

    entry: safeNumber(base.entry, 0),
    sl: safeNumber(base.sl ?? base.initialSl, 0),
    initialSl: safeNumber(base.initialSl ?? base.sl, 0),
    tp: safeNumber(base.tp, 0),
    exit: getExitPrice(base),

    exitR: Number.isFinite(exitR) ? round(exitR, 4) : null,
    pnlPct: Number.isFinite(pnlPct) ? round(pnlPct, 4) : null,

    mfeR: safeNumber(base.mfeR, 0),
    maeR: safeNumber(base.maeR, 0),

    directToSL: Boolean(base.directToSL),

    isClosed: closed,
    isShadowClosed: closed && shadow,
    isRealClosed: closed && !shadow,
    isOpen: open
  };
}

function createFamilyMap() {
  const map = new Map();

  for (const family of buildBaseFamilies()) {
    map.set(family.familyId, {
      ...family,
      ...emptyFamilyMetrics()
    });
  }

  return map;
}

function pushExample(family, row) {
  if (!Array.isArray(family.examples)) family.examples = [];
  if (family.examples.length >= 10) return;

  family.examples.push({
    symbol: row.symbol,
    side: row.side,
    action: row.action,
    status: row.status,
    source: row.source,
    setupClass: row.setupClass,
    reason: row.reason || row.entryReason || row.exitReason || "UNKNOWN",
    score: row.score,
    confluence: row.confluence,
    sniperScore: row.sniperScore,
    plannedRR: row.plannedRR,
    exitR: row.exitR,
    pnlPct: row.pnlPct,
    rsiZone: row.rsiZone,
    obBias: row.obBias,
    spreadPct: row.spreadPct,
    depthMinUsd1p: row.depthMinUsd1p,
    btcState: row.btcState,
    ts: row.ts
  });
}

function addObserved(family, row) {
  family.observed++;
  pushExample(family, row);
}

function addOpen(family, row) {
  family.open++;
  pushExample(family, row);
}

function addClosed(family, row) {
  const r = Number(row.exitR);
  const pnl = Number(row.pnlPct);

  family.closed++;

  if (row.isShadowClosed) family.shadowClosed++;
  else family.realClosed++;

  if (Number.isFinite(r)) {
    family.totalR += r;

    if (r > 0) family.wins++;
    else if (r < 0) family.losses++;
    else family.flats++;
  } else if (Number.isFinite(pnl)) {
    family.totalPnlPct += pnl;

    if (pnl > 0) family.wins++;
    else if (pnl < 0) family.losses++;
    else family.flats++;
  } else {
    family.flats++;
  }

  if (Number.isFinite(pnl)) {
    family.totalPnlPct += pnl;
  }

  if (row.directToSL) {
    family.directSL++;
  }

  family._mfeValues = family._mfeValues || [];
  family._maeValues = family._maeValues || [];

  family._mfeValues.push(Number(row.mfeR || 0));
  family._maeValues.push(Number(row.maeR || 0));

  pushExample(family, row);
}

function finalizeFamilyStats(family, minClosed = 10) {
  const completed = family.wins + family.losses;
  const closed = family.closed;

  family.totalR = round(family.totalR, 3);
  family.avgR = closed > 0 ? round(family.totalR / closed, 3) : 0;

  family.totalPnlPct = round(family.totalPnlPct, 3);
  family.avgPnlPct = closed > 0 ? round(family.totalPnlPct / closed, 3) : 0;

  family.winrateNum = completed > 0
    ? round(family.wins / completed, 4)
    : 0;

  family.winrate = `${round(family.winrateNum * 100, 1)}%`;

  family.directSLPct = closed > 0
    ? `${round((family.directSL / closed) * 100, 1)}%`
    : "0.0%";

  family.avgMfeR = family._mfeValues?.length
    ? round(family._mfeValues.reduce((a, b) => a + b, 0) / family._mfeValues.length, 3)
    : 0;

  family.avgMaeR = family._maeValues?.length
    ? round(family._maeValues.reduce((a, b) => a + b, 0) / family._maeValues.length, 3)
    : 0;

  delete family._mfeValues;
  delete family._maeValues;

  if (family.observed === 0 && family.open === 0 && family.closed === 0) {
    family.status = "EMPTY";
    return family;
  }

  if (family.closed < minClosed) {
    family.status = "COLLECTING";
    return family;
  }

  if (family.winrateNum >= 0.58 && family.avgR > 0 && family.totalPnlPct > 0) {
    family.status = "HOT";
    return family;
  }

  if (family.winrateNum <= 0.42 || family.avgR < 0 || family.totalPnlPct < 0) {
    family.status = "BAD";
    return family;
  }

  family.status = "STABLE";
  return family;
}

function sortFamilies(rows) {
  return [...rows].sort((a, b) => {
    const statusRank = {
      HOT: 5,
      STABLE: 4,
      COLLECTING: 3,
      BAD: 2,
      EMPTY: 1
    };

    const statusDiff = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
    if (statusDiff !== 0) return statusDiff;

    const closedDiff = Number(b.closed || 0) - Number(a.closed || 0);
    if (closedDiff !== 0) return closedDiff;

    const observedDiff = Number(b.observed || 0) - Number(a.observed || 0);
    if (observedDiff !== 0) return observedDiff;

    return Number(a.index || 0) - Number(b.index || 0);
  });
}

function uniqueLatestTradeStates(rows) {
  const map = new Map();

  const sorted = [...rows].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

  for (const row of sorted) {
    if (!row.tradeKey) continue;
    if (!row.isOpen && !row.isClosed) continue;

    const prev = map.get(row.tradeKey);

    if (!prev) {
      map.set(row.tradeKey, row);
      continue;
    }

    if (row.isClosed) {
      map.set(row.tradeKey, row);
      continue;
    }

    if (!prev.isClosed && row.ts >= prev.ts) {
      map.set(row.tradeKey, row);
    }
  }

  return Array.from(map.values());
}

function buildSummary({ rows, familyRows, tradeStates }) {
  const openRows = tradeStates.filter(row => row.isOpen && !row.isClosed);
  const closedRows = tradeStates.filter(row => row.isClosed);

  const realClosed = closedRows.filter(row => row.isRealClosed);
  const shadowClosed = closedRows.filter(row => row.isShadowClosed);

  const wins = closedRows.filter(row => Number(row.exitR ?? row.pnlPct) > 0).length;
  const losses = closedRows.filter(row => Number(row.exitR ?? row.pnlPct) < 0).length;
  const flats = closedRows.length - wins - losses;

  const totalR = closedRows
    .map(row => Number(row.exitR))
    .filter(Number.isFinite)
    .reduce((sum, n) => sum + n, 0);

  const totalPnlPct = closedRows
    .map(row => Number(row.pnlPct))
    .filter(Number.isFinite)
    .reduce((sum, n) => sum + n, 0);

  const completed = wins + losses;

  return {
    version: ANALYZE_FAMILY_VERSION,
    generatedAt: Date.now(),

    actions: rows.length,
    trades: tradeStates.length,

    observed: rows.length,

    open: openRows.length,
    closed: closedRows.length,
    realClosed: realClosed.length,
    shadowClosed: shadowClosed.length,

    wins,
    losses,
    flats,

    winrate: completed ? `${round((wins / completed) * 100, 1)}%` : "0.0%",
    winrateNum: completed ? round(wins / completed, 4) : 0,

    totalR: round(totalR, 3),
    avgR: closedRows.length ? round(totalR / closedRows.length, 3) : 0,

    totalPnlPct: round(totalPnlPct, 3),
    avgPnlPct: closedRows.length ? round(totalPnlPct / closedRows.length, 3) : 0,

    longFamilies: familyRows.filter(f => f.side === "LONG").length,
    shortFamilies: familyRows.filter(f => f.side === "SHORT").length,

    longFamiliesWithData: familyRows.filter(f => f.side === "LONG" && f.observed > 0).length,
    shortFamiliesWithData: familyRows.filter(f => f.side === "SHORT" && f.observed > 0).length,

    hotFamilies: familyRows.filter(f => f.status === "HOT").length,
    badFamilies: familyRows.filter(f => f.status === "BAD").length
  };
}

export function buildAnalyzeReport(rawRows = [], options = {}) {
  const minClosed = safeNumber(options.minClosed, 10);
  const raw = Array.isArray(rawRows) ? rawRows : [];

  const rows = raw
    .filter(Boolean)
    .map(row => normalizeAnalyzeRow(row))
    .filter(row => row.side === "LONG" || row.side === "SHORT")
    .filter(row => row.familyId && row.familyId !== "UNKNOWN");

  const familyMap = createFamilyMap();

  for (const row of rows) {
    const family = familyMap.get(row.familyId);
    if (!family) continue;
    addObserved(family, row);
  }

  const tradeStates = uniqueLatestTradeStates(rows);

  for (const row of tradeStates) {
    const family = familyMap.get(row.familyId);
    if (!family) continue;

    if (row.isClosed) {
      addClosed(family, row);
      continue;
    }

    if (row.isOpen) {
      addOpen(family, row);
    }
  }

  const familyRows = Array.from(familyMap.values())
    .map(row => finalizeFamilyStats(row, minClosed));

  const long = sortFamilies(familyRows.filter(row => row.side === "LONG"));
  const short = sortFamilies(familyRows.filter(row => row.side === "SHORT"));
  const all = sortFamilies(familyRows);

  const summary = buildSummary({
    rows,
    familyRows,
    tradeStates
  });

  return {
    ok: true,
    version: ANALYZE_FAMILY_VERSION,
    summary,

    families: {
      long,
      short,
      all
    },

    trackedFilters: TRACKED_FILTERS,

    samples: {
      latestRows: rows.slice(-100),
      open: tradeStates.filter(row => row.isOpen && !row.isClosed).slice(-100),
      closed: tradeStates.filter(row => row.isClosed).slice(-100)
    }
  };
}