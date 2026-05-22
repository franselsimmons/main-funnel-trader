// ================= lib/analyze/familyEngine.js =================

export const ANALYZE_ENGINE_VERSION = "ANALYZE_V3_50_LONG_50_SHORT_DATA_DRIVEN";

export const TRACKED_FILTERS = [
  {
    category: "Algemene Systeem & Feature Toggles",
    keys: [
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
      "ENABLE_BREAK_EVEN_RULE"
    ]
  },
  {
    category: "Spread & Market Depth Filters",
    keys: [
      "MAX_SPREAD_PCT",
      "MID_BULL_MAX_SPREAD_PCT",
      "MIN_DEPTH_USD_1P",
      "MIN_DEPTH_USD_1P_ABSOLUTE",
      "A_MIN_DEPTH_USD_1P",
      "BULL_TREND_MIN_DEPTH_USD_1P"
    ]
  },
  {
    category: "Risk:Reward & Setup Floors",
    keys: [
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
      "A_GOD_MAX_TP_REWARD_MULTIPLIER"
    ]
  },
  {
    category: "Confluence & Sniper Scores",
    keys: [
      "A_MIN_SNIPER",
      "A_MIN_CONFLUENCE",
      "B_MIN_SNIPER",
      "B_MIN_CONFLUENCE",
      "GOD_MIN_SNIPER",
      "GOD_MIN_CONFLUENCE",
      "GLOBAL_MIN_CONFLUENCE"
    ]
  },
  {
    category: "Algemene Score Filters",
    keys: [
      "CANDIDATE_MIN_SCORE",
      "BTC_BEARISH_LONG_MIN_SCORE",
      "BTC_NEUTRAL_MIN_SCORE",
      "MIN_EXTERNAL_SCORE_HEALTH",
      "TF_MIN_STRENGTH",
      "SETUP_GRADE_A_MIN_POINTS",
      "SETUP_GRADE_B_MIN_POINTS"
    ]
  },
  {
    category: "Orderbook Uitzonderingen & Alignment",
    keys: [
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
      "MID_BULL_SPREAD_EXCEPTION_MIN_SNIPER"
    ]
  },
  {
    category: "RSI Timings & Restricties",
    keys: [
      "MID_RSI_MIN_CONFLUENCE",
      "EARLY_RSI_MIN_SNIPER",
      "SHORT_BLOCKED_RSI_ZONES",
      "SHORT_LOWER1_ALLOWED_BTC_STATES",
      "SHORT_LOWER1_CONTINUATION_MIN_CONFLUENCE",
      "SHORT_LOWER1_CONTINUATION_MIN_SNIPER",
      "SHORT_LOWER1_CONTINUATION_MIN_RR",
      "LONG_LOWER2_MAX_1H_CHANGE",
      "SHORT_UPPER2_MIN_1H_CHANGE",
      "MID_RSI_CONTINUATION_RR_DISCOUNT"
    ]
  },
  {
    category: "Trend & Momentum Evaluaties",
    keys: [
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
      "MAX_BULL_DISTANCE_FROM_LOCAL_HIGH_PCT"
    ]
  },
  {
    category: "Bullish Mid Trend Probe Defaults",
    keys: [
      "BULLISH_MID_TREND_PROBE_MIN_CONFLUENCE",
      "BULLISH_MID_TREND_PROBE_MIN_SNIPER",
      "BULLISH_MID_TREND_PROBE_MIN_RR",
      "BULLISH_MID_TREND_PROBE_MAX_SPREAD_PCT",
      "BULLISH_MID_TREND_PROBE_MIN_DEPTH_USD_1P",
      "BULLISH_MID_TREND_PROBE_REQUIRE_BTC_BULLISH",
      "BULLISH_MID_TREND_PROBE_MIN_1H_MOVE_PCT",
      "BULLISH_MID_TREND_PROBE_MIN_24H_MOVE_PCT",
      "BULLISH_MID_TREND_PROBE_MIN_PULLBACK_FROM_HIGH_PCT"
    ]
  },
  {
    category: "BTC Bullish Bear Exception",
    keys: [
      "BTC_BULLISH_BEAR_EXCEPTION_MIN_DEPTH_USD_1P",
      "BTC_BULLISH_BEAR_EXCEPTION_MAX_SPREAD_PCT",
      "BTC_BULLISH_BEAR_EXCEPTION_MIN_RR",
      "BTC_BULLISH_BEAR_EXCEPTION_MIN_CONF",
      "BTC_BULLISH_BEAR_EXCEPTION_MAX_CONF",
      "BTC_BULLISH_BEAR_EXCEPTION_MIN_SNIPER"
    ]
  },
  {
    category: "Funding Rate Filters",
    keys: [
      "EXTREME_FUNDING_ABS_MAX",
      "BULL_CROWDED_FUNDING_MAX",
      "BEAR_CROWDED_FUNDING_MIN",
      "CROWDED_FUNDING_MIN_CONFLUENCE"
    ]
  },
  {
    category: "Exposure & Correlation",
    keys: [
      "MAX_OPEN_POSITIONS_TOTAL",
      "MAX_OPEN_POSITIONS_SAME_SIDE",
      "MAX_COUNTER_BTC_OPEN_POSITIONS"
    ]
  },
  {
    category: "V12 Quality Gates",
    keys: [
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
      "EARLY_OB_FLIP_MAX_CURRENT_R"
    ]
  },
  {
    category: "Break Even, Trailing & Path Tracking",
    keys: [
      "BREAK_EVEN_TRIGGER_R",
      "BREAK_EVEN_LOCK_R",
      "BREAK_EVEN_MIN_TICKS",
      "BREAK_EVEN_MIN_FAVORABLE_TICKS",
      "HALF_R_LEVEL",
      "ONE_R_LEVEL",
      "NEAR_TP_PROGRESS",
      "DIRECT_SL_MFE_LIMIT_R",
      "MAX_PRICE_PATH_SAMPLES"
    ]
  },
  {
    category: "Post Exit Monitors & Shadow Filters",
    keys: [
      "TP_FOLLOW_THROUGH_R",
      "TP_BIG_FOLLOW_THROUGH_R",
      "SL_RECOVERY_HALF_R",
      "SL_RECOVERY_ONE_R",
      "SL_DEEP_ADVERSE_R",
      "SHADOW_DIRECTIONAL_WIN_PCT",
      "SHADOW_DIRECTIONAL_LOSS_PCT"
    ]
  },
  {
    category: "Optimizer & Analyzer Variabelen",
    keys: [
      "BEST_SETUP_MIN_SAMPLE_LOW",
      "BEST_SETUP_MIN_SAMPLE_MEDIUM",
      "BEST_SETUP_MIN_SAMPLE_HIGH",
      "BEST_SETUP_MIN_WINRATE",
      "BEST_SETUP_MIN_AVG_R",
      "BAD_SETUP_MAX_WINRATE",
      "BAD_SETUP_MAX_AVG_R",
      "FINAL_DECISION_MIN_COMPLETED",
      "FINAL_DECISION_TARGET_COMPLETED",
      "FINAL_DECISION_TOP_N"
    ]
  },
  {
    category: "Cooldowns & API Throttles",
    keys: [
      "COOLDOWN_MS",
      "SYMBOL_REENTRY_COOLDOWN_MS",
      "DATA_FETCH_CONCURRENCY"
    ]
  }
];

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value) {
  return `${(num(value) * 100).toFixed(1)}%`;
}

function round(value, decimals = 3) {
  const n = num(value, 0);
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function normalizeSide(side) {
  const s = String(side || "").toLowerCase();

  if (s === "bull" || s === "long") return "LONG";
  if (s === "bear" || s === "short") return "SHORT";

  return "UNKNOWN";
}

function normalizeAction(action, row) {
  const a = String(action || row?.status || "UNKNOWN").toUpperCase();

  if (["ENTRY", "EXIT", "WAIT", "HOLD"].includes(a)) return a;
  if (["HIT_TP", "HIT_SL", "HORIZON_DONE", "CLOSED"].includes(a)) return "EXIT";
  if (a === "OPEN") return "ENTRY";

  return a;
}

function normalizeSpread(spreadPct) {
  let s = num(spreadPct, 0);

  if (!Number.isFinite(s) || s < 0) return 0;
  if (s > 0.05) s = s / 100;

  return s;
}

function getObRelation(side, obBias) {
  const s = normalizeSide(side);
  const ob = String(obBias || "NEUTRAL").toUpperCase();

  if (ob === "NEUTRAL" || ob === "UNKNOWN") return "NEUTRAL";
  if (s === "LONG" && ob === "BULLISH") return "WITH";
  if (s === "SHORT" && ob === "BEARISH") return "WITH";
  if (s === "LONG" && ob === "BEARISH") return "AGAINST";
  if (s === "SHORT" && ob === "BULLISH") return "AGAINST";

  return "NEUTRAL";
}

function getBtcRelation(side, btcState) {
  const s = normalizeSide(side);
  const btc = String(btcState || "NEUTRAL").toUpperCase();

  if (btc === "NEUTRAL" || btc === "UNKNOWN") return "NEUTRAL";
  if (s === "LONG" && ["BULLISH", "STRONG_BULL"].includes(btc)) return "WITH";
  if (s === "SHORT" && ["BEARISH", "STRONG_BEAR"].includes(btc)) return "WITH";

  return "COUNTER";
}

function bucketRr(rr) {
  const r = num(rr, 0);

  if (r < 0.8) return "RR_LT_0p80";
  if (r < 1.0) return "RR_0p80_1p00";
  if (r < 1.2) return "RR_1p00_1p20";
  if (r < 1.5) return "RR_1p20_1p50";
  if (r < 2.0) return "RR_1p50_2p00";
  return "RR_2p00_PLUS";
}

function bucketScore(value, prefix) {
  const v = num(value, 0);

  if (v < 30) return `${prefix}_0_30`;
  if (v < 50) return `${prefix}_30_50`;
  if (v < 65) return `${prefix}_50_65`;
  if (v < 75) return `${prefix}_65_75`;
  if (v < 85) return `${prefix}_75_85`;
  if (v < 92) return `${prefix}_85_92`;
  return `${prefix}_92_100`;
}

function bucketSpread(spreadPct) {
  const bps = normalizeSpread(spreadPct) * 10_000;

  if (bps < 5) return "SPREAD_LT_5BPS";
  if (bps < 8) return "SPREAD_5_8BPS";
  if (bps < 12) return "SPREAD_8_12BPS";
  if (bps < 16) return "SPREAD_12_16BPS";
  if (bps < 25) return "SPREAD_16_25BPS";
  if (bps < 40) return "SPREAD_25_40BPS";

  return "SPREAD_GT_40BPS";
}

function bucketDepth(depth) {
  const d = num(depth, 0);

  if (d <= 0) return "DEPTH_MISSING";
  if (d < 10_000) return "DEPTH_LT_10K";
  if (d < 50_000) return "DEPTH_10K_50K";
  if (d < 100_000) return "DEPTH_50K_100K";
  if (d < 250_000) return "DEPTH_100K_250K";
  if (d < 500_000) return "DEPTH_250K_500K";

  return "DEPTH_GT_500K";
}

function bucketFunding(funding) {
  const f = num(funding, 0);

  if (f <= -0.015) return "FUNDING_NEG_EXTREME";
  if (f <= -0.006) return "FUNDING_NEG_HIGH";
  if (f < -0.001) return "FUNDING_NEG";
  if (f <= 0.001) return "FUNDING_NEUTRAL";
  if (f < 0.006) return "FUNDING_POS";
  if (f < 0.015) return "FUNDING_POS_HIGH";

  return "FUNDING_POS_EXTREME";
}

function bucketTf(tfStrength) {
  const tf = Math.abs(num(tfStrength, 0));

  if (tf < 0.5) return "TF_WEAK";
  if (tf < 1.5) return "TF_MEDIUM";
  if (tf < 2.5) return "TF_STRONG";

  return "TF_ELITE";
}

function rsiGroupForSide(side, rsiZone) {
  const s = normalizeSide(side);
  const z = String(rsiZone || "UNKNOWN").toUpperCase();

  if (z === "MID") return "RSI_MID";

  if (s === "LONG") {
    if (z.startsWith("LOWER")) return "RSI_EDGE";
    if (z.startsWith("UPPER")) return "RSI_LATE";
  }

  if (s === "SHORT") {
    if (z.startsWith("UPPER")) return "RSI_EDGE";
    if (z.startsWith("LOWER")) return "RSI_LATE";
  }

  return `RSI_${z}`;
}

function extractFilterValues(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];

    const filters =
      row?._analyzeMeta?.filterValues ||
      row?.filterValues ||
      row?.currentFilterValues ||
      row?.tradeSystemFilters ||
      null;

    if (filters && typeof filters === "object") {
      return filters;
    }
  }

  return null;
}

function normalizeRow(row) {
  const side = normalizeSide(row?.side);
  const action = normalizeAction(row?.action, row);

  const rr = num(
    row?.plannedRR ??
    row?.finalRr ??
    row?.effectiveRR ??
    row?.rr ??
    row?.baseRR,
    0
  );

  const exitRRaw = row?.exitR ?? row?.r ?? null;
  const pnlRaw = row?.pnlPct ?? row?.pnlPercent ?? null;

  const hasExitR = Number.isFinite(Number(exitRRaw));
  const hasPnl = Number.isFinite(Number(pnlRaw));

  const exitR = hasExitR ? Number(exitRRaw) : null;
  const pnlPct = hasPnl ? Number(pnlRaw) : null;

  const closed =
    action === "EXIT" ||
    String(row?.status || "").toUpperCase().includes("HIT_") ||
    row?.exit !== undefined ||
    exitR !== null ||
    row?.completedAt !== undefined;

  const win =
    row?.win === true ||
    (exitR !== null && exitR > 0) ||
    (exitR === null && pnlPct !== null && pnlPct > 0);

  const loss =
    row?.loss === true ||
    (exitR !== null && exitR < 0) ||
    (exitR === null && pnlPct !== null && pnlPct < 0);

  const obRel = getObRelation(side, row?.obBias);
  const btcRel = getBtcRelation(side, row?.btcState);

  const normalized = {
    id: row?.tradeId || row?.id || `${row?.symbol || "UNKNOWN"}_${side}_${row?._analyzeIngestedAt || Date.now()}`,

    ts: num(row?.ts || row?.createdAt || row?._analyzeIngestedAt || Date.now(), Date.now()),

    symbol: String(row?.symbol || "UNKNOWN").toUpperCase(),
    side,
    action,

    reason: String(row?.reason || row?.entryReason || row?.exitReason || "UNKNOWN").toUpperCase(),
    setupClass: String(row?.setupClass || row?.grade || "UNKNOWN").toUpperCase(),

    stage: String(row?.stage || row?.scannerStage || "UNKNOWN").toUpperCase(),
    flow: String(row?.flow || "UNKNOWN").toUpperCase(),

    score: num(row?.score ?? row?.moveScore, 0),
    confluence: num(row?.confluence ?? row?.effectiveConfluence, 0),
    sniperScore: num(row?.sniperScore, 0),

    rsi: num(row?.rsi, 0),
    rsiHTF: num(row?.rsiHTF, 0),
    rsiZone: String(row?.rsiZone || "UNKNOWN").toUpperCase(),

    rr,
    baseRR: num(row?.baseRR, rr),
    finalRr: num(row?.finalRr, rr),

    obBias: String(row?.obBias || "UNKNOWN").toUpperCase(),
    obRel,

    spreadPct: normalizeSpread(row?.spreadPct),
    depthMinUsd1p: num(row?.depthMinUsd1p, 0),

    btcState: String(row?.btcState || row?._analyzeMeta?.btcState || "UNKNOWN").toUpperCase(),
    btcRel,

    funding: num(row?.funding, 0),

    tfScore: num(row?.tfScore, 0),
    tfStrength: num(row?.tfStrength, 0),
    tfAlignment: String(row?.tfAlignment || "UNKNOWN").toUpperCase(),

    regime: String(row?.regime || "UNKNOWN").toUpperCase(),

    pullbackConfirmed: Boolean(row?.pullbackConfirmed),
    sweepConfirmed: Boolean(row?.sweepConfirmed),
    retestConfirmed: Boolean(row?.retestConfirmed),

    bullishMidTrendProbe: Boolean(row?.bullishMidTrendProbe),
    btcBullishBearException: Boolean(row?.btcBullishBearException),

    directToSL: Boolean(row?.directToSL),
    nearTpSeen: Boolean(row?.nearTpSeen),
    reachedHalfR: Boolean(row?.reachedHalfR),
    reachedOneR: Boolean(row?.reachedOneR),

    closed,
    open: !closed,
    win,
    loss,
    exitR,
    pnlPct,

    strategyVersion: row?.strategyVersion || row?._analyzeMeta?.strategyVersion || "UNKNOWN"
  };

  normalized.buckets = {
    setup: `SETUP_${normalized.setupClass}`,
    stage: `STAGE_${normalized.stage}`,
    flow: `FLOW_${normalized.flow}`,
    rsi: rsiGroupForSide(side, normalized.rsiZone),
    rr: bucketRr(normalized.rr),
    conf: bucketScore(normalized.confluence, "CONF"),
    sniper: bucketScore(normalized.sniperScore, "SNIPER"),
    score: bucketScore(normalized.score, "SCORE"),
    obRel: `OB_REL_${normalized.obRel}`,
    spread: bucketSpread(normalized.spreadPct),
    depth: bucketDepth(normalized.depthMinUsd1p),
    btcRel: `BTC_REL_${normalized.btcRel}`,
    funding: bucketFunding(normalized.funding),
    tf: bucketTf(normalized.tfStrength),
    regime: `REGIME_${normalized.regime || "UNKNOWN"}`,
    pullback: normalized.pullbackConfirmed || normalized.sweepConfirmed || normalized.retestConfirmed
      ? "PULLBACK_YES"
      : "PULLBACK_NO",
    probe: normalized.bullishMidTrendProbe ? "PROBE_YES" : "PROBE_NO",
    btcException: normalized.btcBullishBearException ? "BTC_EXCEPTION_YES" : "BTC_EXCEPTION_NO"
  };

  return normalized;
}

function getQualityTier(row) {
  const rrScore = Math.min(num(row.rr, 0) / 2.0, 1) * 100;

  const composite =
    num(row.confluence, 0) * 0.34 +
    num(row.sniperScore, 0) * 0.26 +
    rrScore * 0.24 +
    num(row.score, 0) * 0.16;

  if (composite < 35) return 1;
  if (composite < 50) return 2;
  if (composite < 65) return 3;
  if (composite < 80) return 4;

  return 5;
}

function getMarketTier(row) {
  let score = 50;

  if (row.obRel === "WITH") score += 18;
  if (row.obRel === "NEUTRAL") score += 4;
  if (row.obRel === "AGAINST") score -= 18;

  const bps = normalizeSpread(row.spreadPct) * 10_000;

  if (bps < 5) score += 15;
  else if (bps < 8) score += 10;
  else if (bps < 12) score += 4;
  else if (bps < 16) score -= 2;
  else if (bps < 25) score -= 8;
  else score -= 16;

  const depth = num(row.depthMinUsd1p, 0);

  if (depth >= 250_000) score += 15;
  else if (depth >= 100_000) score += 10;
  else if (depth >= 50_000) score += 5;
  else if (depth >= 10_000) score -= 2;
  else score -= 12;

  if (row.btcRel === "WITH") score += 10;
  if (row.btcRel === "NEUTRAL") score += 2;
  if (row.btcRel === "COUNTER") score -= 10;

  const fundingAbs = Math.abs(num(row.funding, 0));

  if (fundingAbs <= 0.002) score += 4;
  else if (fundingAbs >= 0.015) score -= 10;

  if (score < 35) return 1;
  if (score < 50) return 2;
  if (score < 65) return 3;
  if (score < 80) return 4;

  return 5;
}

function getTimingTier(row) {
  let score = 0;

  if (row.stage === "ENTRY") score += 25;
  if (row.stage === "ALMOST") score += 15;

  if (row.flow === "TREND") score += 25;
  if (row.flow === "BUILDING") score += 15;
  if (row.flow === "NEUTRAL") score += 4;

  const rsiGroup = rsiGroupForSide(row.side, row.rsiZone);

  if (rsiGroup === "RSI_EDGE") score += 25;
  if (rsiGroup === "RSI_MID") score += 14;
  if (rsiGroup === "RSI_LATE") score -= 15;

  if (Math.abs(num(row.tfStrength, 0)) >= 1.5) score += 15;

  if (row.pullbackConfirmed || row.sweepConfirmed || row.retestConfirmed) score += 10;

  return score >= 45 ? 2 : 1;
}

function getFamilyNumber(row) {
  const q = getQualityTier(row);
  const m = getMarketTier(row);
  const t = getTimingTier(row);

  return ((q - 1) * 10) + ((m - 1) * 2) + t;
}

function qualityProfile(q) {
  const profiles = {
    1: {
      qualityTier: "Q1_WEAK",
      confRange: "CONF_0_50",
      sniperRange: "SNIPER_0_50",
      rrRange: "RR_LT_1p00",
      scoreRange: "SCORE_0_50"
    },
    2: {
      qualityTier: "Q2_LOW",
      confRange: "CONF_50_65",
      sniperRange: "SNIPER_50_65",
      rrRange: "RR_1p00_1p20",
      scoreRange: "SCORE_50_65"
    },
    3: {
      qualityTier: "Q3_BASE",
      confRange: "CONF_65_75",
      sniperRange: "SNIPER_65_75",
      rrRange: "RR_1p20_1p50",
      scoreRange: "SCORE_65_75"
    },
    4: {
      qualityTier: "Q4_STRONG",
      confRange: "CONF_75_85",
      sniperRange: "SNIPER_75_85",
      rrRange: "RR_1p50_2p00",
      scoreRange: "SCORE_75_85"
    },
    5: {
      qualityTier: "Q5_ELITE",
      confRange: "CONF_85_100",
      sniperRange: "SNIPER_85_100",
      rrRange: "RR_2p00_PLUS",
      scoreRange: "SCORE_85_100"
    }
  };

  return profiles[q] || profiles[1];
}

function marketProfile(m) {
  const profiles = {
    1: {
      marketTier: "M1_DIRTY",
      obRel: "OB_REL_AGAINST",
      spread: "SPREAD_GT_25BPS",
      depth: "DEPTH_LT_10K",
      btcRel: "BTC_REL_COUNTER",
      funding: "FUNDING_CROWDED"
    },
    2: {
      marketTier: "M2_WEAK",
      obRel: "OB_REL_AGAINST_OR_NEUTRAL",
      spread: "SPREAD_16_25BPS",
      depth: "DEPTH_10K_50K",
      btcRel: "BTC_REL_COUNTER",
      funding: "FUNDING_EDGE_WEAK"
    },
    3: {
      marketTier: "M3_NORMAL",
      obRel: "OB_REL_NEUTRAL",
      spread: "SPREAD_8_16BPS",
      depth: "DEPTH_50K_100K",
      btcRel: "BTC_REL_NEUTRAL",
      funding: "FUNDING_NEUTRAL"
    },
    4: {
      marketTier: "M4_CLEAN",
      obRel: "OB_REL_WITH_OR_NEUTRAL",
      spread: "SPREAD_5_12BPS",
      depth: "DEPTH_100K_250K",
      btcRel: "BTC_REL_WITH_OR_NEUTRAL",
      funding: "FUNDING_OK"
    },
    5: {
      marketTier: "M5_PREMIUM",
      obRel: "OB_REL_WITH",
      spread: "SPREAD_LT_8BPS",
      depth: "DEPTH_GT_250K",
      btcRel: "BTC_REL_WITH",
      funding: "FUNDING_OPTIMAL"
    }
  };

  return profiles[m] || profiles[1];
}

function timingProfile(side, t) {
  if (t === 2) {
    return {
      timingTier: "T2_TIMED",
      stage: "STAGE_ENTRY_OR_ALMOST",
      flow: "FLOW_TREND_OR_BUILDING",
      rsi: side === "LONG" ? "RSI_LOWER_OR_MID" : "RSI_UPPER_OR_MID",
      tf: "TF_ALIGNED",
      pullback: "PULLBACK_OR_CONFIRMATION_OK"
    };
  }

  return {
    timingTier: "T1_EARLY_OR_NOISY",
    stage: "STAGE_ANY",
    flow: "FLOW_ANY",
    rsi: "RSI_ANY",
    tf: "TF_ANY",
    pullback: "PULLBACK_NOT_REQUIRED"
  };
}

function makeFamilyDefinition(side, familyNumber) {
  const q = Math.floor((familyNumber - 1) / 10) + 1;
  const withinQ = familyNumber - ((q - 1) * 10);
  const m = Math.floor((withinQ - 1) / 2) + 1;
  const t = withinQ % 2 === 1 ? 1 : 2;

  const qProfile = qualityProfile(q);
  const mProfile = marketProfile(m);
  const tProfile = timingProfile(side, t);

  const id = `${side}_${familyNumber}`;

  const label = [
    qProfile.qualityTier,
    mProfile.marketTier,
    tProfile.timingTier,
    qProfile.confRange,
    qProfile.sniperRange,
    qProfile.rrRange,
    qProfile.scoreRange,
    tProfile.stage,
    tProfile.flow,
    tProfile.rsi,
    mProfile.obRel,
    mProfile.spread,
    mProfile.depth,
    mProfile.btcRel,
    mProfile.funding,
    tProfile.tf,
    tProfile.pullback
  ].join(" | ");

  return {
    id,
    side,
    familyNumber,
    qualityTier: q,
    marketTier: m,
    timingTier: t,
    label,
    profile: {
      ...qProfile,
      ...mProfile,
      ...tProfile
    }
  };
}

export function buildFamilyDefinitions() {
  const rows = [];

  for (const side of ["LONG", "SHORT"]) {
    for (let i = 1; i <= 50; i++) {
      rows.push(makeFamilyDefinition(side, i));
    }
  }

  return rows;
}

function createFamilyStats(definition) {
  return {
    ...definition,

    actions: 0,
    entries: 0,
    waits: 0,
    holds: 0,
    exits: 0,

    open: 0,
    closed: 0,

    wins: 0,
    losses: 0,
    flats: 0,

    winrate: "0.0%",

    totalR: 0,
    avgR: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    directSL: 0,
    directSLPct: "0.0%",

    nearTp: 0,
    nearTpPct: "0.0%",

    avgConfluence: 0,
    avgSniper: 0,
    avgRR: 0,
    avgSpreadBps: 0,
    avgDepth: 0,

    status: "empty",

    examples: [],
    latestRows: []
  };
}

function updateFamily(family, row) {
  family.actions++;

  if (row.action === "ENTRY") family.entries++;
  if (row.action === "WAIT") family.waits++;
  if (row.action === "HOLD") family.holds++;
  if (row.action === "EXIT") family.exits++;

  if (row.closed) family.closed++;
  else family.open++;

  if (row.win) family.wins++;
  if (row.loss) family.losses++;
  if (row.closed && !row.win && !row.loss) family.flats++;

  if (row.closed && Number.isFinite(Number(row.exitR))) {
    family.totalR += Number(row.exitR);
  }

  if (row.closed && Number.isFinite(Number(row.pnlPct))) {
    family.totalPnlPct += Number(row.pnlPct);
  }

  if (row.directToSL) family.directSL++;
  if (row.nearTpSeen) family.nearTp++;

  family.examples.push(`${row.symbol}_${row.action}_${row.reason}_R=${row.exitR ?? "open"}`);

  family.latestRows.push(row);

  if (family.examples.length > 12) family.examples = family.examples.slice(-12);
  if (family.latestRows.length > 30) family.latestRows = family.latestRows.slice(-30);
}

function finalizeFamily(family) {
  const completed = family.wins + family.losses;

  family.winrate = completed > 0 ? pct(family.wins / completed) : "0.0%";

  family.totalR = round(family.totalR, 3);
  family.avgR = family.closed > 0 ? round(family.totalR / family.closed, 3) : 0;

  family.totalPnlPct = round(family.totalPnlPct, 3);
  family.avgPnlPct = family.closed > 0 ? round(family.totalPnlPct / family.closed, 3) : 0;

  family.directSLPct = family.closed > 0 ? pct(family.directSL / family.closed) : "0.0%";
  family.nearTpPct = family.closed > 0 ? pct(family.nearTp / family.closed) : "0.0%";

  const rows = family.latestRows;

  family.avgConfluence = rows.length ? round(rows.reduce((s, r) => s + r.confluence, 0) / rows.length, 2) : 0;
  family.avgSniper = rows.length ? round(rows.reduce((s, r) => s + r.sniperScore, 0) / rows.length, 2) : 0;
  family.avgRR = rows.length ? round(rows.reduce((s, r) => s + r.rr, 0) / rows.length, 3) : 0;
  family.avgSpreadBps = rows.length ? round(rows.reduce((s, r) => s + r.spreadPct * 10_000, 0) / rows.length, 2) : 0;
  family.avgDepth = rows.length ? Math.round(rows.reduce((s, r) => s + r.depthMinUsd1p, 0) / rows.length) : 0;

  if (family.actions === 0) family.status = "empty";
  else if (family.closed < 5) family.status = "low_sample";
  else if (family.avgR > 0 && Number(String(family.winrate).replace("%", "")) >= 50) family.status = "candidate_edge";
  else if (family.avgR < 0) family.status = "negative";
  else family.status = "neutral";

  return family;
}

function sortFamilies(rows) {
  return [...rows].sort((a, b) => {
    if ((b.actions > 0) !== (a.actions > 0)) return b.actions > 0 ? 1 : -1;
    if (b.closed !== a.closed) return b.closed - a.closed;
    if (b.totalR !== a.totalR) return b.totalR - a.totalR;
    return b.actions - a.actions;
  });
}

export function buildFamilyAnalysis(rawRows, options = {}) {
  const normalizedRows = (Array.isArray(rawRows) ? rawRows : [])
    .map(normalizeRow)
    .filter(row => row.side === "LONG" || row.side === "SHORT");

  const definitions = buildFamilyDefinitions();
  const familyMap = new Map();

  for (const def of definitions) {
    familyMap.set(def.id, createFamilyStats(def));
  }

  for (const row of normalizedRows) {
    const familyNumber = getFamilyNumber(row);
    const id = `${row.side}_${familyNumber}`;
    const family = familyMap.get(id);

    if (!family) continue;

    row.familyId = id;
    row.familyNumber = familyNumber;
    row.familyLabel = family.label;

    updateFamily(family, row);
  }

  const families = Array.from(familyMap.values()).map(finalizeFamily);
  const longFamilies = sortFamilies(families.filter(f => f.side === "LONG"));
  const shortFamilies = sortFamilies(families.filter(f => f.side === "SHORT"));

  const closedRows = normalizedRows.filter(row => row.closed);
  const wins = normalizedRows.filter(row => row.win).length;
  const losses = normalizedRows.filter(row => row.loss).length;
  const completed = wins + losses;

  const totalR = closedRows.reduce((sum, row) => sum + num(row.exitR, 0), 0);
  const totalPnlPct = closedRows.reduce((sum, row) => sum + num(row.pnlPct, 0), 0);

  const summary = {
    rawRows: Array.isArray(rawRows) ? rawRows.length : 0,
    normalizedRows: normalizedRows.length,

    actions: normalizedRows.length,
    trades: normalizedRows.length,

    open: normalizedRows.filter(row => !row.closed).length,
    closed: closedRows.length,

    wins,
    losses,
    winrate: completed > 0 ? pct(wins / completed) : "0.0%",

    totalR: round(totalR, 3),
    avgR: closedRows.length ? round(totalR / closedRows.length, 3) : 0,

    totalPnlPct: round(totalPnlPct, 3),
    avgPnlPct: closedRows.length ? round(totalPnlPct / closedRows.length, 3) : 0,

    families: families.length,
    longFamilies: longFamilies.length,
    shortFamilies: shortFamilies.length,
    observedFamilies: families.filter(f => f.actions > 0).length
  };

  return {
    ok: true,
    version: ANALYZE_ENGINE_VERSION,
    generatedAt: Date.now(),

    summary,

    families,
    longFamilies,
    shortFamilies,

    topLong: longFamilies.filter(f => f.actions > 0).slice(0, 10),
    topShort: shortFamilies.filter(f => f.actions > 0).slice(0, 10),

    rows: normalizedRows.slice(-500).reverse(),

    trackedFilters: TRACKED_FILTERS,
    filterValues: extractFilterValues(rawRows)
  };
}