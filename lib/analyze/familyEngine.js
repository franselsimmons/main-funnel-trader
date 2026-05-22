// ================= ANALYZE FAMILY ENGINE =================

export const ANALYZE_VERSION = "ANALYZE_FULL_STACK_V1";

const ANY = "ANY";

export const FILTER_SCHEMA = [
  "side",
  "action",
  "stage",
  "setupClass",
  "entryReason",

  "btcState",
  "regime",
  "flow",

  "rsiZone",
  "rsiBucket",
  "rsiContinuation",

  "rrBucket",
  "finalRrBucket",
  "confluenceBucket",
  "sniperBucket",
  "scoreBucket",

  "obRelation",
  "obBias",
  "spreadBucket",
  "depthBucket",

  "fundingBucket",
  "momentum1hBucket",
  "momentum24hBucket",

  "tfBucket",
  "tfAlignment",

  "pullbackState",
  "fakeBreakout",
  "hasLiquidationData",

  "btcBullishBearException",
  "bullishMidTrendProbe",
  "neutralObException",

  "qualityGate",
  "confirmation",

  "directSL",
  "nearTpSeen",
  "reachedHalfR",
  "reachedOneR",
  "breakEvenActivated",

  "fromOpenPosition",
  "analysisType"
];

const DEFAULT_CRITERIA = Object.fromEntries(
  FILTER_SCHEMA.map(key => [key, [ANY]])
);

function arr(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null) return [ANY];
  return [String(value)];
}

function completeCriteria(partial = {}) {
  const out = {};

  for (const key of FILTER_SCHEMA) {
    out[key] = arr(partial[key] ?? DEFAULT_CRITERIA[key]);
  }

  return out;
}

function family({
  id,
  side,
  nr,
  name,
  group,
  description,
  criteria
}) {
  return {
    id,
    side,
    nr,
    name,
    group,
    description,
    criteria: completeCriteria({
      ...criteria,
      side
    })
  };
}

// ================= BUCKETS =================

export function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);
  if (!Number.isFinite(s) || s < 0) return 0;
  if (s > 0.05) s = s / 100;
  return s;
}

export function bucketRsiValue(rsi) {
  const v = safeNumber(rsi, 50);

  if (v <= 26) return "RSI_L3";
  if (v <= 33) return "RSI_L2";
  if (v <= 40) return "RSI_L1";
  if (v < 60) return "RSI_MID";
  if (v < 67) return "RSI_U1";
  if (v < 74) return "RSI_U2";

  return "RSI_U3";
}

export function bucketRR(rr) {
  const v = safeNumber(rr, 0);

  if (v < 0.2) return "RR_LT_020";
  if (v < 0.8) return "RR_020_080";
  if (v < 1.0) return "RR_080_100";
  if (v < 1.2) return "RR_100_120";
  if (v < 1.5) return "RR_120_150";
  if (v < 2.0) return "RR_150_200";

  return "RR_200_PLUS";
}

export function bucketScore(value, prefix) {
  const v = safeNumber(value, 0);

  if (v < 50) return `${prefix}_LT_50`;
  if (v < 60) return `${prefix}_50_60`;
  if (v < 70) return `${prefix}_60_70`;
  if (v < 80) return `${prefix}_70_80`;
  if (v < 90) return `${prefix}_80_90`;

  return `${prefix}_90_100`;
}

export function bucketSpread(spreadPct) {
  const s = normalizeSpread(spreadPct);

  if (!s) return "SPREAD_UNKNOWN";
  if (s <= 0.0008) return "SPREAD_TIGHT";
  if (s <= 0.0015) return "SPREAD_NORMAL";
  if (s <= 0.0030) return "SPREAD_WIDE";
  if (s <= 0.0150) return "SPREAD_DISCOVERY_WIDE";

  return "SPREAD_BAD";
}

export function bucketDepth(depthUsd) {
  const d = safeNumber(depthUsd, 0);

  if (d <= 0) return "DEPTH_MISSING";
  if (d < 10_000) return "DEPTH_LT_10K";
  if (d < 50_000) return "DEPTH_10K_50K";
  if (d < 100_000) return "DEPTH_50K_100K";
  if (d < 200_000) return "DEPTH_100K_200K";

  return "DEPTH_GT_200K";
}

export function bucketFunding(rate) {
  const r = safeNumber(rate, 0);

  if (r <= -0.015) return "FUNDING_NEG_EXTREME";
  if (r <= -0.008) return "FUNDING_NEG_HIGH";
  if (r < -0.002) return "FUNDING_NEG";
  if (r <= 0.002) return "FUNDING_NEUTRAL";
  if (r < 0.008) return "FUNDING_POS";
  if (r < 0.015) return "FUNDING_POS_HIGH";

  return "FUNDING_POS_EXTREME";
}

export function bucketMomentum(value) {
  const v = safeNumber(value, 0);

  if (v <= -3) return "MOMENTUM_DOWN_STRONG";
  if (v < -0.5) return "MOMENTUM_DOWN";
  if (v <= 0.5) return "MOMENTUM_FLAT";
  if (v < 3) return "MOMENTUM_UP";

  return "MOMENTUM_UP_STRONG";
}

export function bucketTf(tfStrength) {
  const v = Math.abs(safeNumber(tfStrength, 0));

  if (v < 0.5) return "TF_WEAK";
  if (v < 1.5) return "TF_OK";
  if (v < 2.5) return "TF_STRONG";

  return "TF_EXTREME";
}

export function getObRelation(side, obBias) {
  const s = String(side || "").toLowerCase();
  const ob = String(obBias || "UNKNOWN").toUpperCase();

  if (ob === "UNKNOWN" || ob === "NEUTRAL") return "OB_NEUTRAL";

  if (s === "bull" && ob === "BULLISH") return "OB_WITH_SIDE";
  if (s === "bear" && ob === "BEARISH") return "OB_WITH_SIDE";

  if (s === "bull" && ob === "BEARISH") return "OB_AGAINST_SIDE";
  if (s === "bear" && ob === "BULLISH") return "OB_AGAINST_SIDE";

  return "OB_NEUTRAL";
}

export function getPullbackState(row) {
  if (row.pullbackConfirmed) return "PULLBACK_CONFIRMED";
  if (row.sweepConfirmed) return "SWEEP_CONFIRMED";
  if (row.retestConfirmed) return "RETEST_CONFIRMED";
  if (row.fakeBreakout) return "FAKE_BREAKOUT";

  return "NO_PULLBACK";
}

function boolBucket(value) {
  if (value === true) return "TRUE";
  if (value === false) return "FALSE";
  return "UNKNOWN";
}

// ================= NORMALIZE ACTION =================

export function normalizeAnalyzeRow(action = {}, meta = {}) {
  const side = String(action.side || "").toLowerCase();
  const rr = safeNumber(action.plannedRR ?? action.finalRr ?? action.effectiveRR ?? action.rr, 0);
  const finalRr = safeNumber(action.finalRr ?? action.effectiveRR ?? action.plannedRR ?? action.rr, rr);

  const row = {
    id: action.id || `${meta.runId || "run"}_${action.symbol}_${side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    runId: meta.runId || action.runId || null,
    tradeId: action.tradeId || null,

    ts: safeNumber(action.ts, Date.now()),
    strategyVersion: action.strategyVersion || meta.strategyVersion || null,
    analyzeVersion: ANALYZE_VERSION,

    symbol: String(action.symbol || "").toUpperCase(),
    side,

    action: String(action.action || "UNKNOWN").toUpperCase(),
    reason: String(action.reason || "UNKNOWN").toUpperCase(),
    entryReason: String(action.entryType || action.entryReason || action.reason || "UNKNOWN").toUpperCase(),

    stage: String(action.stage || "unknown").toLowerCase(),
    setupClass: String(action.setupClass || "NONE").toUpperCase(),

    btcState: String(action.btcState || meta.btcState || "UNKNOWN").toUpperCase(),
    regime: String(action.regime || meta.regime || "UNKNOWN").toUpperCase(),
    flow: String(action.flow || "UNKNOWN").toUpperCase(),

    score: safeNumber(action.score ?? action.moveScore, 0),
    confluence: safeNumber(action.confluence ?? action.effectiveConfluence, 0),
    rawConfluence: safeNumber(action.rawConfluence, 0),
    sniperScore: safeNumber(action.sniperScore, 0),

    rsi: safeNumber(action.rsi, 50),
    rsiHTF: safeNumber(action.rsiHTF, 50),
    rsiZone: String(action.rsiZone || "UNKNOWN").toUpperCase(),
    rsiEdge: String(action.rsiEdge || action.rsiEntryEdge || "UNKNOWN").toUpperCase(),
    rsiContinuation: boolBucket(action.rsiContinuationOK ?? action.rsiContinuationOk),

    rr,
    finalRr,
    baseRR: safeNumber(action.baseRR, rr),

    entry: safeNumber(action.entry, 0),
    sl: safeNumber(action.sl ?? action.initialSl, 0),
    tp: safeNumber(action.tp, 0),
    exit: safeNumber(action.exit ?? action.executionPrice, 0),

    exitR: Number.isFinite(Number(action.exitR)) ? Number(action.exitR) : null,
    pnlPct: Number.isFinite(Number(action.pnlPct)) ? Number(action.pnlPct) : null,

    obBias: String(action.obBias || "UNKNOWN").toUpperCase(),
    spreadPct: normalizeSpread(action.spreadPct),
    depthMinUsd1p: safeNumber(action.depthMinUsd1p, 0),

    funding: safeNumber(action.funding, 0),
    tfScore: safeNumber(action.tfScore, 0),
    tfStrength: safeNumber(action.tfStrength, 0),
    tfAlignment: String(action.tfAlignment || "UNKNOWN").toUpperCase(),

    change1h: safeNumber(action.change1h, 0),
    change24: safeNumber(action.change24, 0),

    pullbackConfirmed: Boolean(action.pullbackConfirmed),
    sweepConfirmed: Boolean(action.sweepConfirmed),
    retestConfirmed: Boolean(action.retestConfirmed),
    fakeBreakout: Boolean(action.fakeBreakout || action.fakeBreakoutConfirmed),
    hasLiquidationData: Boolean(action.hasLiquidationData),

    btcBullishBearException: Boolean(action.btcBullishBearException),
    bullishMidTrendProbe: Boolean(action.bullishMidTrendProbe),
    neutralObException: Boolean(action.neutralObExceptionOk),

    qualityGate: action.qualityGate || action.filterChecks?.qualityGate?.reason || "UNKNOWN",
    confirmation: action.confirmationTtlMs ? "PENDING" : "NONE",

    directSL: Boolean(action.directToSL),
    nearTpSeen: Boolean(action.nearTpSeen),
    reachedHalfR: Boolean(action.reachedHalfR),
    reachedOneR: Boolean(action.reachedOneR),
    breakEvenActivated: Boolean(action.breakEvenActivated),

    fromOpenPosition: Boolean(action.fromOpenPosition),
    analysisType: String(action.analysisType || "UNKNOWN").toUpperCase(),

    filterValues: action.filterValues || meta.filterValues || meta.currentFilterValues || null,
    filterChecks: action.filterChecks || null,
    liveFilterMetrics: action.liveFilterMetrics || null,
    raw: action
  };

  return {
    ...row,

    rsiBucket: bucketRsiValue(row.rsi),
    rrBucket: bucketRR(row.rr),
    finalRrBucket: bucketRR(row.finalRr),
    confluenceBucket: bucketScore(row.confluence, "CONF"),
    sniperBucket: bucketScore(row.sniperScore, "SNIPER"),
    scoreBucket: bucketScore(row.score, "SCORE"),

    obRelation: getObRelation(row.side, row.obBias),
    spreadBucket: bucketSpread(row.spreadPct),
    depthBucket: bucketDepth(row.depthMinUsd1p),

    fundingBucket: bucketFunding(row.funding),
    momentum1hBucket: bucketMomentum(row.change1h),
    momentum24hBucket: bucketMomentum(row.change24),

    tfBucket: bucketTf(row.tfStrength),
    pullbackState: getPullbackState(row),

    fakeBreakout: boolBucket(row.fakeBreakout),
    hasLiquidationData: boolBucket(row.hasLiquidationData),
    btcBullishBearException: boolBucket(row.btcBullishBearException),
    bullishMidTrendProbe: boolBucket(row.bullishMidTrendProbe),
    neutralObException: boolBucket(row.neutralObException),
    directSL: boolBucket(row.directSL),
    nearTpSeen: boolBucket(row.nearTpSeen),
    reachedHalfR: boolBucket(row.reachedHalfR),
    reachedOneR: boolBucket(row.reachedOneR),
    breakEvenActivated: boolBucket(row.breakEvenActivated),
    fromOpenPosition: boolBucket(row.fromOpenPosition)
  };
}

// ================= 50 LONG + 50 SHORT FAMILIES =================

const QUALITY_TIERS = [
  {
    code: "ELITE",
    confluenceBucket: ["CONF_90_100"],
    sniperBucket: ["SNIPER_90_100"],
    rrBucket: ["RR_150_200", "RR_200_PLUS"],
    finalRrBucket: ["RR_150_200", "RR_200_PLUS"],
    scoreBucket: ["SCORE_80_90", "SCORE_90_100"],
    spreadBucket: ["SPREAD_TIGHT"],
    depthBucket: ["DEPTH_100K_200K", "DEPTH_GT_200K"]
  },
  {
    code: "HIGH",
    confluenceBucket: ["CONF_80_90", "CONF_90_100"],
    sniperBucket: ["SNIPER_80_90", "SNIPER_90_100"],
    rrBucket: ["RR_120_150", "RR_150_200", "RR_200_PLUS"],
    finalRrBucket: ["RR_120_150", "RR_150_200", "RR_200_PLUS"],
    scoreBucket: ["SCORE_70_80", "SCORE_80_90", "SCORE_90_100"],
    spreadBucket: ["SPREAD_TIGHT", "SPREAD_NORMAL"],
    depthBucket: ["DEPTH_50K_100K", "DEPTH_100K_200K", "DEPTH_GT_200K"]
  },
  {
    code: "STANDARD",
    confluenceBucket: ["CONF_70_80", "CONF_80_90"],
    sniperBucket: ["SNIPER_70_80", "SNIPER_80_90"],
    rrBucket: ["RR_100_120", "RR_120_150"],
    finalRrBucket: ["RR_100_120", "RR_120_150"],
    scoreBucket: ["SCORE_60_70", "SCORE_70_80", "SCORE_80_90"],
    spreadBucket: ["SPREAD_NORMAL", "SPREAD_WIDE"],
    depthBucket: ["DEPTH_10K_50K", "DEPTH_50K_100K", "DEPTH_100K_200K"]
  },
  {
    code: "EARLY",
    confluenceBucket: ["CONF_60_70", "CONF_70_80"],
    sniperBucket: ["SNIPER_60_70", "SNIPER_70_80"],
    rrBucket: ["RR_080_100", "RR_100_120", "RR_120_150"],
    finalRrBucket: ["RR_080_100", "RR_100_120", "RR_120_150"],
    scoreBucket: ["SCORE_50_60", "SCORE_60_70", "SCORE_70_80"],
    spreadBucket: ["SPREAD_NORMAL", "SPREAD_WIDE", "SPREAD_DISCOVERY_WIDE"],
    depthBucket: ["DEPTH_MISSING", "DEPTH_LT_10K", "DEPTH_10K_50K", "DEPTH_50K_100K"]
  },
  {
    code: "DISCOVERY",
    confluenceBucket: ["CONF_LT_50", "CONF_50_60", "CONF_60_70"],
    sniperBucket: ["SNIPER_LT_50", "SNIPER_50_60", "SNIPER_60_70"],
    rrBucket: ["RR_LT_020", "RR_020_080", "RR_080_100"],
    finalRrBucket: ["RR_LT_020", "RR_020_080", "RR_080_100"],
    scoreBucket: ["SCORE_LT_50", "SCORE_50_60", "SCORE_60_70"],
    spreadBucket: ["SPREAD_UNKNOWN", "SPREAD_WIDE", "SPREAD_DISCOVERY_WIDE", "SPREAD_BAD"],
    depthBucket: ["DEPTH_MISSING", "DEPTH_LT_10K", "DEPTH_10K_50K"]
  }
];

const LONG_ARCHETYPES = [
  {
    code: "TREND_CONTINUATION_BTC_BULL",
    group: "Long trend continuation",
    criteria: {
      flow: ["TREND"],
      btcState: ["BULLISH", "STRONG_BULL"],
      rsiZone: ["MID", "LOWER_1"],
      rsiBucket: ["RSI_MID", "RSI_L1"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      momentum1hBucket: ["MOMENTUM_FLAT", "MOMENTUM_UP", "MOMENTUM_UP_STRONG"],
      momentum24hBucket: ["MOMENTUM_UP", "MOMENTUM_UP_STRONG", "MOMENTUM_FLAT"],
      setupClass: ["A", "GOD", "B"]
    }
  },
  {
    code: "PULLBACK_RECLAIM",
    group: "Long pullback / reclaim",
    criteria: {
      flow: ["TREND", "BUILDING"],
      btcState: ["BULLISH", "STRONG_BULL", "NEUTRAL"],
      rsiZone: ["LOWER_1", "LOWER_2", "MID"],
      rsiBucket: ["RSI_L1", "RSI_L2", "RSI_MID"],
      pullbackState: ["PULLBACK_CONFIRMED", "SWEEP_CONFIRMED", "RETEST_CONFIRMED"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      setupClass: ["A", "GOD", "B"]
    }
  },
  {
    code: "OVERSOLD_REVERSAL",
    group: "Long oversold reversal",
    criteria: {
      flow: ["BUILDING", "NEUTRAL"],
      btcState: ["NEUTRAL", "BULLISH"],
      rsiZone: ["LOWER_2", "LOWER_3"],
      rsiBucket: ["RSI_L2", "RSI_L3"],
      pullbackState: ["SWEEP_CONFIRMED", "FAKE_BREAKOUT", "PULLBACK_CONFIRMED", "NO_PULLBACK"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      setupClass: ["A", "B"]
    }
  },
  {
    code: "MID_RSI_TREND_PROBE",
    group: "Long bullish mid trend probe",
    criteria: {
      flow: ["TREND"],
      btcState: ["BULLISH", "STRONG_BULL", "NEUTRAL"],
      rsiZone: ["MID"],
      rsiBucket: ["RSI_MID"],
      bullishMidTrendProbe: ["TRUE"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      setupClass: ["B_TREND_PROBE", "B", "A"]
    }
  },
  {
    code: "BREAKOUT_OB_WITH",
    group: "Long breakout OB with-side",
    criteria: {
      flow: ["TREND", "BUILDING"],
      btcState: ["BULLISH", "STRONG_BULL"],
      rsiZone: ["MID", "UPPER_1"],
      rsiBucket: ["RSI_MID", "RSI_U1"],
      obRelation: ["OB_WITH_SIDE"],
      momentum1hBucket: ["MOMENTUM_UP", "MOMENTUM_UP_STRONG"],
      momentum24hBucket: ["MOMENTUM_UP", "MOMENTUM_UP_STRONG"],
      setupClass: ["A", "GOD", "B"]
    }
  },
  {
    code: "BTC_NEUTRAL_QUALITY",
    group: "Long BTC neutral quality",
    criteria: {
      flow: ["TREND", "BUILDING"],
      btcState: ["NEUTRAL"],
      rsiZone: ["LOWER_1", "MID"],
      rsiBucket: ["RSI_L1", "RSI_MID"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      setupClass: ["A", "GOD"]
    }
  },
  {
    code: "COUNTER_BTC_EXCEPTION",
    group: "Long counter-BTC exception",
    criteria: {
      flow: ["TREND", "BUILDING"],
      btcState: ["BEARISH", "STRONG_BEAR"],
      rsiZone: ["LOWER_1", "LOWER_2", "MID"],
      rsiBucket: ["RSI_L1", "RSI_L2", "RSI_MID"],
      obRelation: ["OB_WITH_SIDE"],
      setupClass: ["A", "GOD"]
    }
  },
  {
    code: "LOW_VOL_ACCUMULATION",
    group: "Long low-vol accumulation",
    criteria: {
      regime: ["LOW_VOL", "LOW", "NORMAL", "UNKNOWN"],
      flow: ["BUILDING", "NEUTRAL"],
      btcState: ["NEUTRAL", "BULLISH"],
      rsiZone: ["LOWER_1", "MID"],
      rsiBucket: ["RSI_L1", "RSI_MID"],
      spreadBucket: ["SPREAD_TIGHT", "SPREAD_NORMAL"],
      setupClass: ["B", "A"]
    }
  },
  {
    code: "HIGH_VOL_MOMENTUM",
    group: "Long high-vol momentum",
    criteria: {
      regime: ["HIGH_VOL", "HIGH", "NORMAL", "UNKNOWN"],
      flow: ["TREND"],
      btcState: ["BULLISH", "STRONG_BULL"],
      rsiZone: ["MID", "UPPER_1"],
      rsiBucket: ["RSI_MID", "RSI_U1"],
      momentum1hBucket: ["MOMENTUM_UP", "MOMENTUM_UP_STRONG"],
      setupClass: ["A", "GOD", "B"]
    }
  },
  {
    code: "NOISY_DISCOVERY",
    group: "Long noisy discovery",
    criteria: {
      flow: ["NEUTRAL", "BUILDING", "TREND"],
      btcState: ["UNKNOWN", "NEUTRAL", "BULLISH", "BEARISH", "STRONG_BULL", "STRONG_BEAR"],
      rsiZone: ["UNKNOWN", "LOWER_3", "LOWER_2", "LOWER_1", "MID", "UPPER_1", "UPPER_2", "UPPER_3"],
      obRelation: ["OB_NEUTRAL", "OB_AGAINST_SIDE", "OB_WITH_SIDE"],
      setupClass: ["NONE", "B", "A", "GOD", "B_TREND_PROBE"]
    }
  }
];

const SHORT_ARCHETYPES = [
  {
    code: "TREND_CONTINUATION_BTC_BEAR",
    group: "Short trend continuation",
    criteria: {
      flow: ["TREND"],
      btcState: ["BEARISH", "STRONG_BEAR"],
      rsiZone: ["MID", "UPPER_1"],
      rsiBucket: ["RSI_MID", "RSI_U1"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      momentum1hBucket: ["MOMENTUM_FLAT", "MOMENTUM_DOWN", "MOMENTUM_DOWN_STRONG"],
      momentum24hBucket: ["MOMENTUM_DOWN", "MOMENTUM_DOWN_STRONG", "MOMENTUM_FLAT"],
      setupClass: ["A", "GOD", "B"]
    }
  },
  {
    code: "PULLBACK_REJECTION",
    group: "Short pullback / rejection",
    criteria: {
      flow: ["TREND", "BUILDING"],
      btcState: ["BEARISH", "STRONG_BEAR", "NEUTRAL"],
      rsiZone: ["UPPER_1", "UPPER_2", "MID"],
      rsiBucket: ["RSI_U1", "RSI_U2", "RSI_MID"],
      pullbackState: ["PULLBACK_CONFIRMED", "SWEEP_CONFIRMED", "RETEST_CONFIRMED", "FAKE_BREAKOUT"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      setupClass: ["A", "GOD", "B"]
    }
  },
  {
    code: "OVERBOUGHT_REVERSAL",
    group: "Short overbought reversal",
    criteria: {
      flow: ["BUILDING", "NEUTRAL"],
      btcState: ["NEUTRAL", "BEARISH"],
      rsiZone: ["UPPER_2", "UPPER_3"],
      rsiBucket: ["RSI_U2", "RSI_U3"],
      pullbackState: ["SWEEP_CONFIRMED", "FAKE_BREAKOUT", "PULLBACK_CONFIRMED", "NO_PULLBACK"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      setupClass: ["A", "B"]
    }
  },
  {
    code: "BTC_BULLISH_BEAR_EXCEPTION",
    group: "Short BTC bullish exception",
    criteria: {
      flow: ["TREND", "BUILDING", "NEUTRAL"],
      btcState: ["BULLISH", "STRONG_BULL"],
      rsiZone: ["MID", "UPPER_1", "UPPER_2", "UPPER_3"],
      rsiBucket: ["RSI_MID", "RSI_U1", "RSI_U2", "RSI_U3"],
      btcBullishBearException: ["TRUE"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      setupClass: ["A_SHORT_EXCEPTION", "A", "B"]
    }
  },
  {
    code: "BREAKDOWN_OB_WITH",
    group: "Short breakdown OB with-side",
    criteria: {
      flow: ["TREND", "BUILDING"],
      btcState: ["BEARISH", "STRONG_BEAR"],
      rsiZone: ["MID", "LOWER_1"],
      rsiBucket: ["RSI_MID", "RSI_L1"],
      obRelation: ["OB_WITH_SIDE"],
      momentum1hBucket: ["MOMENTUM_DOWN", "MOMENTUM_DOWN_STRONG"],
      momentum24hBucket: ["MOMENTUM_DOWN", "MOMENTUM_DOWN_STRONG"],
      setupClass: ["A", "GOD", "B"]
    }
  },
  {
    code: "BTC_NEUTRAL_QUALITY",
    group: "Short BTC neutral quality",
    criteria: {
      flow: ["TREND", "BUILDING"],
      btcState: ["NEUTRAL"],
      rsiZone: ["UPPER_1", "MID"],
      rsiBucket: ["RSI_U1", "RSI_MID"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      setupClass: ["A", "GOD"]
    }
  },
  {
    code: "COUNTER_BTC_EXCEPTION",
    group: "Short counter-BTC exception",
    criteria: {
      flow: ["TREND", "BUILDING"],
      btcState: ["BULLISH", "STRONG_BULL"],
      rsiZone: ["UPPER_1", "UPPER_2", "MID"],
      rsiBucket: ["RSI_U1", "RSI_U2", "RSI_MID"],
      obRelation: ["OB_WITH_SIDE", "OB_NEUTRAL"],
      setupClass: ["A_SHORT_EXCEPTION", "A", "B"]
    }
  },
  {
    code: "LOW_VOL_DISTRIBUTION",
    group: "Short low-vol distribution",
    criteria: {
      regime: ["LOW_VOL", "LOW", "NORMAL", "UNKNOWN"],
      flow: ["BUILDING", "NEUTRAL"],
      btcState: ["NEUTRAL", "BEARISH"],
      rsiZone: ["UPPER_1", "MID"],
      rsiBucket: ["RSI_U1", "RSI_MID"],
      spreadBucket: ["SPREAD_TIGHT", "SPREAD_NORMAL"],
      setupClass: ["B", "A"]
    }
  },
  {
    code: "HIGH_VOL_MOMENTUM",
    group: "Short high-vol momentum",
    criteria: {
      regime: ["HIGH_VOL", "HIGH", "NORMAL", "UNKNOWN"],
      flow: ["TREND"],
      btcState: ["BEARISH", "STRONG_BEAR"],
      rsiZone: ["MID", "LOWER_1"],
      rsiBucket: ["RSI_MID", "RSI_L1"],
      momentum1hBucket: ["MOMENTUM_DOWN", "MOMENTUM_DOWN_STRONG"],
      setupClass: ["A", "GOD", "B"]
    }
  },
  {
    code: "NOISY_DISCOVERY",
    group: "Short noisy discovery",
    criteria: {
      flow: ["NEUTRAL", "BUILDING", "TREND"],
      btcState: ["UNKNOWN", "NEUTRAL", "BULLISH", "BEARISH", "STRONG_BULL", "STRONG_BEAR"],
      rsiZone: ["UNKNOWN", "LOWER_3", "LOWER_2", "LOWER_1", "MID", "UPPER_1", "UPPER_2", "UPPER_3"],
      obRelation: ["OB_NEUTRAL", "OB_AGAINST_SIDE", "OB_WITH_SIDE"],
      setupClass: ["NONE", "B", "A", "GOD", "A_SHORT_EXCEPTION"]
    }
  }
];

function buildSideFamilies(side, archetypes) {
  const families = [];
  let nr = 1;

  for (const archetype of archetypes) {
    for (const tier of QUALITY_TIERS) {
      const id = `${side.toUpperCase()}_F${String(nr).padStart(2, "0")}_${archetype.code}_${tier.code}`;

      families.push(
        family({
          id,
          side,
          nr,
          name: `${side.toUpperCase()} F${String(nr).padStart(2, "0")} ${archetype.code} ${tier.code}`,
          group: archetype.group,
          description: `${archetype.group} | ${tier.code} full-stack filter family`,
          criteria: {
            ...archetype.criteria,

            confluenceBucket: tier.confluenceBucket,
            sniperBucket: tier.sniperBucket,
            rrBucket: tier.rrBucket,
            finalRrBucket: tier.finalRrBucket,
            scoreBucket: tier.scoreBucket,

            spreadBucket: archetype.criteria.spreadBucket || tier.spreadBucket,
            depthBucket: archetype.criteria.depthBucket || tier.depthBucket,

            fundingBucket: ["FUNDING_NEG", "FUNDING_NEUTRAL", "FUNDING_POS"],
            tfBucket: ["TF_OK", "TF_STRONG", "TF_EXTREME"],

            qualityGate: ["UNKNOWN", "QUALITY_GATE_DISABLED", "V12_QUALITY_OK"],
            confirmation: ["NONE", "PENDING"],

            fakeBreakout: ["TRUE", "FALSE", "UNKNOWN"],
            hasLiquidationData: ["TRUE", "FALSE", "UNKNOWN"],
            neutralObException: ["TRUE", "FALSE", "UNKNOWN"],

            directSL: ["TRUE", "FALSE", "UNKNOWN"],
            nearTpSeen: ["TRUE", "FALSE", "UNKNOWN"],
            reachedHalfR: ["TRUE", "FALSE", "UNKNOWN"],
            reachedOneR: ["TRUE", "FALSE", "UNKNOWN"],
            breakEvenActivated: ["TRUE", "FALSE", "UNKNOWN"],

            analysisType: ["DEEP", "DISCOVERY_ALL_COINS", "UNKNOWN"]
          }
        })
      );

      nr++;
    }
  }

  return families;
}

export const LONG_FAMILIES = buildSideFamilies("bull", LONG_ARCHETYPES);
export const SHORT_FAMILIES = buildSideFamilies("bear", SHORT_ARCHETYPES);
export const ALL_FAMILIES = [...LONG_FAMILIES, ...SHORT_FAMILIES];

// ================= FAMILY ASSIGNMENT =================

const WEIGHTS = {
  setupClass: 3,
  entryReason: 1.5,
  btcState: 2,
  regime: 1,
  flow: 2.5,

  rsiZone: 2.5,
  rsiBucket: 2,
  rsiContinuation: 0.8,

  rrBucket: 2,
  finalRrBucket: 2,
  confluenceBucket: 3,
  sniperBucket: 3,
  scoreBucket: 1.5,

  obRelation: 2.5,
  obBias: 1,
  spreadBucket: 2,
  depthBucket: 2,

  fundingBucket: 1,
  momentum1hBucket: 1.5,
  momentum24hBucket: 1,

  tfBucket: 1,
  tfAlignment: 0.5,

  pullbackState: 2,
  fakeBreakout: 0.5,
  hasLiquidationData: 0.5,

  btcBullishBearException: 3,
  bullishMidTrendProbe: 3,
  neutralObException: 1,

  qualityGate: 0.7,
  confirmation: 0.5,

  directSL: 0.5,
  nearTpSeen: 0.5,
  reachedHalfR: 0.5,
  reachedOneR: 0.5,
  breakEvenActivated: 0.5,

  fromOpenPosition: 0.3,
  analysisType: 0.3
};

function valueMatches(allowed, actual) {
  const list = Array.isArray(allowed) ? allowed.map(String) : [String(allowed)];
  if (list.includes(ANY)) return "any";
  return list.includes(String(actual)) ? "match" : "miss";
}

export function scoreFamilyMatch(row, fam) {
  if (!row?.side || row.side !== fam.side) return -999999;

  let score = 0;
  const misses = [];
  const matches = [];

  for (const key of FILTER_SCHEMA) {
    if (key === "side") continue;

    const weight = WEIGHTS[key] || 1;
    const allowed = fam.criteria[key] || [ANY];
    const actual = row[key];

    const match = valueMatches(allowed, actual);

    if (match === "match") {
      score += weight;
      matches.push(key);
      continue;
    }

    if (match === "any") {
      score += weight * 0.08;
      continue;
    }

    score -= weight * 0.85;
    misses.push(key);
  }

  return {
    score: Number(score.toFixed(3)),
    misses,
    matches
  };
}

export function assignFamily(row) {
  const pool = row.side === "bull"
    ? LONG_FAMILIES
    : row.side === "bear"
      ? SHORT_FAMILIES
      : ALL_FAMILIES;

  let best = null;

  for (const fam of pool) {
    const result = scoreFamilyMatch(row, fam);
    if (typeof result === "number") continue;

    if (!best || result.score > best.matchScore) {
      best = {
        familyId: fam.id,
        familyName: fam.name,
        familyGroup: fam.group,
        familyNr: fam.nr,
        matchScore: result.score,
        matchMisses: result.misses,
        matchHits: result.matches,
        family: fam
      };
    }
  }

  return best;
}

// ================= STATS =================

function emptyStats(fam) {
  return {
    familyId: fam.id,
    familyName: fam.name,
    familyGroup: fam.group,
    side: fam.side,
    nr: fam.nr,
    description: fam.description,
    criteria: fam.criteria,

    observations: 0,
    entries: 0,
    waits: 0,
    holds: 0,
    exits: 0,

    closed: 0,
    wins: 0,
    losses: 0,
    flats: 0,

    winrate: "0.0%",
    winrateNum: 0,

    totalR: 0,
    avgR: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    avgMfeR: 0,
    avgMaeR: 0,

    directSL: 0,
    directSLPct: "0.0%",

    nearTp: 0,
    nearTpPct: "0.0%",

    reachedHalfR: 0,
    reachedOneR: 0,

    profitFactorR: 0,
    decisionScore: 0,

    topReasons: {},
    examples: []
  };
}

function pct(n) {
  return `${(safeNumber(n, 0) * 100).toFixed(1)}%`;
}

function avg(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(values) {
  return values.map(Number).filter(Number.isFinite).reduce((a, b) => a + b, 0);
}

function profitFactor(rows) {
  const rValues = rows.map(r => Number(r.exitR)).filter(Number.isFinite);

  const grossWin = rValues.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rValues.filter(r => r < 0).reduce((a, b) => a + b, 0));

  if (!grossLoss) return grossWin > 0 ? 999 : 0;
  return grossWin / grossLoss;
}

function buildDecisionScore(stats) {
  const sampleConfidence = Math.min(1, stats.closed / 50);
  const directSLPenalty = Number(String(stats.directSLPct).replace("%", "")) / 100;

  const raw =
    stats.winrateNum * 75 +
    stats.avgR * 45 +
    stats.avgPnlPct * 12 +
    Math.min(stats.profitFactorR, 5) * 8 +
    stats.totalR * 0.2 +
    sampleConfidence * 15 -
    directSLPenalty * 40;

  return Number(raw.toFixed(3));
}

export function buildFamilyStats({ observations = [], closedTrades = [] }) {
  const map = new Map();

  for (const fam of ALL_FAMILIES) {
    map.set(fam.id, emptyStats(fam));
  }

  for (const row of observations) {
    const stat = map.get(row.familyId);
    if (!stat) continue;

    stat.observations++;

    if (row.action === "ENTRY") stat.entries++;
    if (row.action === "WAIT") stat.waits++;
    if (row.action === "HOLD") stat.holds++;
    if (row.action === "EXIT") stat.exits++;

    const reason = row.reason || "UNKNOWN";
    stat.topReasons[reason] = Number(stat.topReasons[reason] || 0) + 1;

    if (stat.examples.length < 20) {
      stat.examples.push({
        ts: row.ts,
        symbol: row.symbol,
        side: row.side,
        action: row.action,
        reason: row.reason,
        setupClass: row.setupClass,
        rsiZone: row.rsiZone,
        rr: row.rr,
        finalRr: row.finalRr,
        confluence: row.confluence,
        sniperScore: row.sniperScore,
        pnlPct: row.pnlPct,
        exitR: row.exitR
      });
    }
  }

  for (const trade of closedTrades) {
    const stat = map.get(trade.familyId);
    if (!stat) continue;

    stat.closed++;

    const exitR = Number(trade.exitR);
    if (exitR > 0) stat.wins++;
    else if (exitR < 0) stat.losses++;
    else stat.flats++;

    if (trade.directSL === "TRUE") stat.directSL++;
    if (trade.nearTpSeen === "TRUE") stat.nearTp++;
    if (trade.reachedHalfR === "TRUE") stat.reachedHalfR++;
    if (trade.reachedOneR === "TRUE") stat.reachedOneR++;
  }

  for (const stat of map.values()) {
    const rows = closedTrades.filter(t => t.familyId === stat.familyId);

    const completed = stat.wins + stat.losses;
    stat.winrateNum = completed ? Number((stat.wins / completed).toFixed(4)) : 0;
    stat.winrate = pct(stat.winrateNum);

    stat.totalR = Number(sum(rows.map(r => r.exitR)).toFixed(3));
    stat.avgR = Number(avg(rows.map(r => r.exitR)).toFixed(3));

    stat.totalPnlPct = Number(sum(rows.map(r => r.pnlPct)).toFixed(3));
    stat.avgPnlPct = Number(avg(rows.map(r => r.pnlPct)).toFixed(3));

    stat.avgMfeR = Number(avg(rows.map(r => r.mfeR)).toFixed(3));
    stat.avgMaeR = Number(avg(rows.map(r => r.maeR)).toFixed(3));

    stat.directSLPct = stat.closed ? pct(stat.directSL / stat.closed) : "0.0%";
    stat.nearTpPct = stat.closed ? pct(stat.nearTp / stat.closed) : "0.0%";

    stat.profitFactorR = Number(profitFactor(rows).toFixed(3));
    stat.decisionScore = buildDecisionScore(stat);

    stat.topReasons = Object.entries(stat.topReasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  const all = Array.from(map.values());

  return {
    all,
    long: all.filter(f => f.side === "bull"),
    short: all.filter(f => f.side === "bear")
  };
}