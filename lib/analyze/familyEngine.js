// ================= lib/analyze/familyEngine.js =================
// Fixed 50 LONG + 50 SHORT broad filter families.
// Elke trade krijgt exact 1 family. Families zijn breed genoeg voor echte sample-size.

export const ANALYZE_ENGINE_VERSION = "ANALYZE_FAMILY_V2_50x50";

const ANY = ["ANY"];

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

const QUALITY_TIERS = [
  {
    key: "Q1_SCOUT_WEAK",
    rr: [0, 1.20],
    confluence: [0, 50],
    sniper: [0, 50],
    spreadBps: [0, 999],
    depthUsd: [0, 50_000],
    score: [0, 50],
    label: "weak/early discovery"
  },
  {
    key: "Q2_BASE",
    rr: [1.20, 1.50],
    confluence: [50, 65],
    sniper: [0, 65],
    spreadBps: [0, 40],
    depthUsd: [0, 100_000],
    score: [0, 65],
    label: "base discovery"
  },
  {
    key: "Q3_CLEAN",
    rr: [1.20, 1.80],
    confluence: [65, 75],
    sniper: [50, 75],
    spreadBps: [0, 25],
    depthUsd: [10_000, 250_000],
    score: [40, 75],
    label: "clean medium"
  },
  {
    key: "Q4_STRONG",
    rr: [1.50, 2.20],
    confluence: [75, 85],
    sniper: [65, 85],
    spreadBps: [0, 16],
    depthUsd: [50_000, 500_000],
    score: [55, 90],
    label: "strong"
  },
  {
    key: "Q5_ELITE",
    rr: [1.80, 999],
    confluence: [85, 100],
    sniper: [85, 100],
    spreadBps: [0, 12],
    depthUsd: [100_000, 999_999_999],
    score: [70, 100],
    label: "elite"
  }
];

function rsiEdgeZones(side) {
  return side === "LONG"
    ? ["LOWER_3", "LOWER_2", "LOWER_1", "MID"]
    : ["UPPER_3", "UPPER_2", "UPPER_1", "MID"];
}

function rsiExtendedZones(side) {
  return side === "LONG"
    ? ["UPPER_1", "UPPER_2", "UPPER_3"]
    : ["LOWER_1", "LOWER_2", "LOWER_3"];
}

function scenarioTemplates(side) {
  const edge = rsiEdgeZones(side);
  const extended = rsiExtendedZones(side);

  return [
    {
      key: "TREND_WITH_OB_WITH_BTC",
      label: "trend + OB with side + BTC with/neutral",
      stages: ["entry", "almost"],
      flows: ["TREND"],
      rsiZones: edge,
      obRelations: ["WITH"],
      btcRelations: ["WITH", "NEUTRAL"],
      tfStrengthBuckets: ["MID", "HIGH"],
      fundingBuckets: ANY
    },
    {
      key: "TREND_NEUTRAL_OB",
      label: "trend + neutral OB",
      stages: ["entry", "almost"],
      flows: ["TREND"],
      rsiZones: edge,
      obRelations: ["NEUTRAL"],
      btcRelations: ["WITH", "NEUTRAL", "COUNTER"],
      tfStrengthBuckets: ANY,
      fundingBuckets: ANY
    },
    {
      key: "TREND_OB_AGAINST",
      label: "trend but OB against",
      stages: ["entry", "almost"],
      flows: ["TREND"],
      rsiZones: ["MID", ...edge],
      obRelations: ["AGAINST"],
      btcRelations: ["WITH", "NEUTRAL", "COUNTER"],
      tfStrengthBuckets: ANY,
      fundingBuckets: ANY
    },
    {
      key: "COUNTER_BTC_MID",
      label: "counter BTC + MID RSI",
      stages: ["entry", "almost"],
      flows: ["TREND", "BUILDING", "NEUTRAL"],
      rsiZones: ["MID"],
      obRelations: ["WITH", "NEUTRAL", "AGAINST"],
      btcRelations: ["COUNTER"],
      tfStrengthBuckets: ANY,
      fundingBuckets: ANY
    },
    {
      key: "REVERSAL_RSI_EDGE",
      label: "RSI edge reversal / pullback",
      stages: ["entry", "almost", "buildup"],
      flows: ["BUILDING", "NEUTRAL"],
      rsiZones: edge.filter(z => z !== "MID"),
      obRelations: ["WITH", "NEUTRAL"],
      btcRelations: ["WITH", "NEUTRAL", "COUNTER"],
      tfStrengthBuckets: ANY,
      fundingBuckets: ANY
    },
    {
      key: "EXTENDED_RSI_CHASE",
      label: "extended RSI chase risk",
      stages: ["entry", "almost"],
      flows: ["TREND", "BUILDING", "NEUTRAL"],
      rsiZones: extended,
      obRelations: ["WITH", "NEUTRAL", "AGAINST"],
      btcRelations: ["WITH", "NEUTRAL", "COUNTER"],
      tfStrengthBuckets: ANY,
      fundingBuckets: ANY
    },
    {
      key: "BUILDING_CLEAN_EXECUTION",
      label: "building flow + clean execution",
      stages: ["entry", "almost", "buildup"],
      flows: ["BUILDING"],
      rsiZones: ["MID", ...edge],
      obRelations: ["WITH", "NEUTRAL"],
      btcRelations: ["WITH", "NEUTRAL"],
      tfStrengthBuckets: ["LOW", "MID", "HIGH"],
      fundingBuckets: ANY
    },
    {
      key: "NEUTRAL_FLOW_DECISION",
      label: "neutral flow decision zone",
      stages: ["entry", "almost", "buildup"],
      flows: ["NEUTRAL", "UNKNOWN"],
      rsiZones: ["MID", ...edge, ...extended],
      obRelations: ["WITH", "NEUTRAL", "AGAINST"],
      btcRelations: ["WITH", "NEUTRAL", "COUNTER"],
      tfStrengthBuckets: ANY,
      fundingBuckets: ANY
    },
    {
      key: "BAD_EXECUTION_ZONE",
      label: "wide spread / low depth execution risk",
      stages: ["entry", "almost", "buildup"],
      flows: ["TREND", "BUILDING", "NEUTRAL", "UNKNOWN"],
      rsiZones: ["MID", ...edge, ...extended],
      obRelations: ["WITH", "NEUTRAL", "AGAINST"],
      btcRelations: ["WITH", "NEUTRAL", "COUNTER"],
      tfStrengthBuckets: ANY,
      fundingBuckets: ANY,
      forceExecutionWeak: true
    },
    {
      key: "HIGH_CONF_ANY_CONTEXT",
      label: "high confluence any context",
      stages: ["entry", "almost", "buildup"],
      flows: ["TREND", "BUILDING", "NEUTRAL", "UNKNOWN"],
      rsiZones: ["MID", ...edge, ...extended],
      obRelations: ["WITH", "NEUTRAL", "AGAINST"],
      btcRelations: ["WITH", "NEUTRAL", "COUNTER"],
      tfStrengthBuckets: ANY,
      fundingBuckets: ANY,
      forceHighConf: true
    }
  ];
}

let FAMILY_CACHE = null;

export function buildFamilyDefinitions() {
  if (FAMILY_CACHE) return FAMILY_CACHE;

  const families = [];

  for (const side of ["LONG", "SHORT"]) {
    let index = 1;

    for (const scenario of scenarioTemplates(side)) {
      for (const tier of QUALITY_TIERS) {
        const id = `${side}_${index}`;

        const conditions = {
          side,
          setupClasses: [
            "GOD",
            "A",
            "A_SHORT_EXCEPTION",
            "B",
            "B_TREND_PROBE",
            "C",
            "NONE",
            "OPEN",
            "UNKNOWN"
          ],
          stages: scenario.stages,
          flows: scenario.flows,
          rsiZones: scenario.rsiZones,
          rrRange: tier.rr,
          confluenceRange: scenario.forceHighConf ? [75, 100] : tier.confluence,
          sniperRange: tier.sniper,
          scoreRange: tier.score,
          obRelations: scenario.obRelations,
          spreadBpsRange: scenario.forceExecutionWeak ? [12, 999] : tier.spreadBps,
          depthUsdRange: scenario.forceExecutionWeak ? [0, 100_000] : tier.depthUsd,
          btcRelations: scenario.btcRelations,
          tfStrengthBuckets: scenario.tfStrengthBuckets,
          fundingBuckets: scenario.fundingBuckets,
          marketRegimes: ANY,
          volatilityRegimes: ANY,
          featureFlags: ANY,
          pathState: ANY
        };

        families.push({
          id,
          side,
          index,
          scenarioKey: scenario.key,
          qualityKey: tier.key,
          name: `${scenario.key} / ${tier.key}`,
          label: `${scenario.label} / ${tier.label}`,
          conditions
        });

        index++;
      }
    }
  }

  FAMILY_CACHE = families;
  return families;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);
  if (!Number.isFinite(s) || s < 0) return 0;
  if (s > 0.05) s = s / 100;
  return s;
}

function normalizeSide(row) {
  const raw = String(row?.side || row?.direction || "").toLowerCase();
  if (["bull", "long", "buy"].includes(raw)) return "LONG";
  if (["bear", "short", "sell"].includes(raw)) return "SHORT";
  return "UNKNOWN";
}

function normalizeFlow(raw) {
  const f = String(raw || "UNKNOWN").toUpperCase();
  if (["TREND", "BREAKOUT", "RUNNING"].includes(f)) return "TREND";
  if (["BUILDING", "BUILDUP"].includes(f)) return "BUILDING";
  if (["NEUTRAL", "NO_FLOW", "UNKNOWN"].includes(f)) return "NEUTRAL";
  return f;
}

function normalizeStage(raw) {
  const s = String(raw || "unknown").toLowerCase();
  if (["entry", "almost", "buildup", "radar"].includes(s)) return s;
  return "unknown";
}

function normalizeRsiZone(row) {
  const zone = String(row?.rsiZone || row?.rsi_zone || "").toUpperCase();

  if (
    [
      "LOWER_3",
      "LOWER_2",
      "LOWER_1",
      "MID",
      "UPPER_1",
      "UPPER_2",
      "UPPER_3"
    ].includes(zone)
  ) {
    return zone;
  }

  const rsi = Number(row?.rsi);
  if (!Number.isFinite(rsi)) return "UNKNOWN";
  if (rsi <= 26) return "LOWER_3";
  if (rsi <= 33) return "LOWER_2";
  if (rsi <= 40) return "LOWER_1";
  if (rsi >= 74) return "UPPER_3";
  if (rsi >= 67) return "UPPER_2";
  if (rsi >= 60) return "UPPER_1";
  return "MID";
}

function getObRelation(side, obBias, directRel = null) {
  const rel = String(directRel || "").toUpperCase();
  if (["WITH", "AGAINST", "NEUTRAL"].includes(rel)) return rel;

  const ob = String(obBias || "UNKNOWN").toUpperCase();

  if (["NEUTRAL", "UNKNOWN", "NONE"].includes(ob)) return "NEUTRAL";

  if (side === "LONG" && ob === "BULLISH") return "WITH";
  if (side === "SHORT" && ob === "BEARISH") return "WITH";

  if (side === "LONG" && ob === "BEARISH") return "AGAINST";
  if (side === "SHORT" && ob === "BULLISH") return "AGAINST";

  return "NEUTRAL";
}

function getBtcRelation(side, btcState) {
  const btc = String(btcState || "UNKNOWN").toUpperCase();

  if (["NEUTRAL", "UNKNOWN"].includes(btc)) return "NEUTRAL";

  if (side === "LONG" && ["BULLISH", "STRONG_BULL"].includes(btc)) return "WITH";
  if (side === "SHORT" && ["BEARISH", "STRONG_BEAR"].includes(btc)) return "WITH";

  if (side === "LONG" && ["BEARISH", "STRONG_BEAR"].includes(btc)) return "COUNTER";
  if (side === "SHORT" && ["BULLISH", "STRONG_BULL"].includes(btc)) return "COUNTER";

  return "NEUTRAL";
}

function fundingBucket(rate) {
  const r = Number(rate || 0);
  if (r <= -0.008) return "NEG_HIGH";
  if (r < -0.002) return "NEG";
  if (r <= 0.002) return "NEUTRAL";
  if (r < 0.008) return "POS";
  return "POS_HIGH";
}

function tfBucket(tfStrength) {
  const n = Number(tfStrength || 0);
  if (n >= 2) return "HIGH";
  if (n >= 1) return "MID";
  return "LOW";
}

function sourceGroup(row) {
  const source = String(row?.source || row?.originSource || "").toUpperCase();
  if (source.includes("SHADOW")) return "SHADOW";
  if (source.includes("REAL")) return "REAL";
  return "LIVE";
}

function statusGroup(row) {
  const action = String(row?.action || "").toUpperCase();
  const status = String(row?.status || "").toUpperCase();
  const exitReason = String(row?.exitReason || row?.reason || "").toUpperCase();

  if (
    action === "EXIT" ||
    ["TP", "SL", "BE_SL", "HIT_TP", "HIT_SL", "HORIZON_DONE"].includes(status) ||
    ["TP", "SL", "BE_SL", "EARLY_NO_FOLLOW_THROUGH", "EARLY_OB_FLIP"].includes(exitReason) ||
    Number.isFinite(Number(row?.exitR)) ||
    Number.isFinite(Number(row?.pnlPct)) && Boolean(row?.exitedAt)
  ) {
    return "CLOSED";
  }

  if (action === "ENTRY" || action === "HOLD" || status === "OPEN") return "OPEN";
  return "OBSERVED";
}

function firstNumber(row, keys, fallback = 0) {
  for (const key of keys) {
    const n = Number(row?.[key]);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function normalizeAnalyzeRow(row, index = 0) {
  const side = normalizeSide(row);
  const spreadPct = normalizeSpread(row?.spreadPct);
  const spreadBps = spreadPct * 10_000;

  const rr = firstNumber(row, [
    "finalRr",
    "plannedRR",
    "effectiveRR",
    "baseRR",
    "rr",
    "targetR"
  ]);

  const pnlPct = firstNumber(row, ["pnlPct", "triggerPnlPct", "unrealizedPnlPct"], 0);
  const exitR = firstNumber(row, ["exitR", "triggerR", "currentR"], 0);

  const status = statusGroup(row);
  const source = sourceGroup(row);

  return {
    _raw: row,
    _index: index,

    rowId:
      row?.id ||
      row?.tradeId ||
      `${normalizeBaseSymbol(row?.symbol)}_${side}_${row?.ts || row?.createdAt || index}`,

    tradeKey:
      row?.tradeId ||
      `${normalizeBaseSymbol(row?.symbol)}_${side}_${row?.createdAt || row?.entry || ""}`,

    symbol: normalizeBaseSymbol(row?.symbol),
    side,

    action: String(row?.action || "UNKNOWN").toUpperCase(),
    status,
    source,

    setupClass: String(row?.setupClass || "UNKNOWN").toUpperCase(),
    stage: normalizeStage(row?.stage || row?.scannerStage),
    flow: normalizeFlow(row?.flow),

    rsi: safeNumber(row?.rsi, 0),
    rsiHTF: safeNumber(row?.rsiHTF, 0),
    rsiZone: normalizeRsiZone(row),

    rr,
    confluence: firstNumber(row, ["confluence", "effectiveConfluence", "rawConfluence"], 0),
    sniperScore: firstNumber(row, ["sniperScore", "sniper"], 0),
    score: firstNumber(row, ["score", "moveScore"], 0),

    obBias: String(row?.obBias || "UNKNOWN").toUpperCase(),
    obRelation: getObRelation(side, row?.obBias, row?.obSideRelation),

    spreadPct,
    spreadBps,
    depthUsd: firstNumber(row, ["depthMinUsd1p", "depthUsd", "depth"], 0),

    btcState: String(row?.btcState || "UNKNOWN").toUpperCase(),
    btcRelation: getBtcRelation(side, row?.btcState),

    funding: safeNumber(row?.funding, 0),
    fundingBucket: fundingBucket(row?.funding),

    tfStrength: safeNumber(row?.tfStrength, 0),
    tfBucket: tfBucket(row?.tfStrength),

    regime: String(row?.regime || "UNKNOWN").toUpperCase(),
    volatility: String(row?.volatility || "UNKNOWN").toUpperCase(),

    pnlPct,
    exitR,

    win: status === "CLOSED" && (row?.win === true || exitR > 0 || pnlPct > 0),
    loss: status === "CLOSED" && (row?.loss === true || exitR < 0 || pnlPct < 0),

    mfeR: safeNumber(row?.mfeR, 0),
    maeR: safeNumber(row?.maeR, 0),
    directToSL: Boolean(row?.directToSL),
    nearTpSeen: Boolean(row?.nearTpSeen),

    ts: safeNumber(row?.ts || row?.createdAt || row?.exitedAt, Date.now()),

    filterValues: row?.filterValues || row?.currentFilterValues || null
  };
}

function listScore(value, allowed, weight) {
  if (!Array.isArray(allowed) || allowed.includes("ANY")) return weight * 0.65;
  return allowed.includes(value) ? weight : 0;
}

function rangeScore(value, [min, max], weight) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  if (n >= min && n <= max) return weight;

  const span = Math.max(1, max - min);
  const distance = n < min ? min - n : n - max;
  const penalty = Math.min(weight * 0.85, (distance / span) * weight);

  return Math.max(0, weight - penalty);
}

function exactSideScore(row, family) {
  return row.side === family.side ? 10_000 : -1_000_000;
}

export function scoreRowAgainstFamily(row, family) {
  const c = family.conditions;

  let score = exactSideScore(row, family);

  score += listScore(row.setupClass, c.setupClasses, 4);
  score += listScore(row.stage, c.stages, 8);
  score += listScore(row.flow, c.flows, 12);
  score += listScore(row.rsiZone, c.rsiZones, 12);
  score += listScore(row.obRelation, c.obRelations, 12);
  score += listScore(row.btcRelation, c.btcRelations, 12);
  score += listScore(row.tfBucket, c.tfStrengthBuckets, 4);
  score += listScore(row.fundingBucket, c.fundingBuckets, 2);

  score += rangeScore(row.rr, c.rrRange, 10);
  score += rangeScore(row.confluence, c.confluenceRange, 10);
  score += rangeScore(row.sniperScore, c.sniperRange, 10);
  score += rangeScore(row.score, c.scoreRange, 4);
  score += rangeScore(row.spreadBps, c.spreadBpsRange, 8);
  score += rangeScore(row.depthUsd, c.depthUsdRange, 8);

  return score;
}

export function assignFamily(row, families = buildFamilyDefinitions()) {
  const candidates = families.filter(f => f.side === row.side);

  let best = null;

  for (const family of candidates) {
    const score = scoreRowAgainstFamily(row, family);

    if (!best || score > best.score) {
      best = {
        family,
        score
      };
    }
  }

  return best;
}

function initFamilyStat(family) {
  return {
    familyId: family.id,
    side: family.side,
    index: family.index,
    name: family.name,
    label: family.label,
    scenarioKey: family.scenarioKey,
    qualityKey: family.qualityKey,
    definition: family.conditions,

    observed: 0,
    open: 0,

    closed: 0,
    wins: 0,
    losses: 0,
    flats: 0,

    shadowClosed: 0,
    shadowWins: 0,
    shadowLosses: 0,

    winrate: "0.0%",
    winrateNum: 0,

    totalR: 0,
    avgR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,

    shadowWinrate: "0.0%",
    shadowAvgR: 0,
    shadowTotalR: 0,

    avgMfeR: 0,
    avgMaeR: 0,
    directSLPct: "0.0%",
    nearTpPct: "0.0%",

    confidence: "NO_SAMPLE",
    status: "COLLECTING",

    bestSymbols: [],
    worstSymbols: [],
    examples: []
  };
}

function pct(num) {
  const n = Number(num || 0);
  return `${(n * 100).toFixed(1)}%`;
}

function avg(values) {
  const arr = values.map(Number).filter(Number.isFinite);
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(values) {
  return values.map(Number).filter(Number.isFinite).reduce((a, b) => a + b, 0);
}

function round(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function stableClosedKey(row) {
  return [
    row.source,
    row.rowId,
    row.tradeKey,
    row.symbol,
    row.side,
    row._raw?.exitReason || row._raw?.reason || "",
    row._raw?.exitedAt || row._raw?.completedAt || row.ts
  ].join("|");
}

function stableOpenKey(row) {
  return row.tradeKey || `${row.symbol}_${row.side}`;
}

function finalizeStats(statsMap, familyRows) {
  for (const stat of statsMap.values()) {
    const rows = familyRows.get(stat.familyId) || [];

    const realClosed = rows.filter(r => r.status === "CLOSED" && r.source !== "SHADOW");
    const shadowClosed = rows.filter(r => r.status === "CLOSED" && r.source === "SHADOW");

    stat.closed = realClosed.length;
    stat.wins = realClosed.filter(r => r.win).length;
    stat.losses = realClosed.filter(r => r.loss).length;
    stat.flats = Math.max(0, stat.closed - stat.wins - stat.losses);

    stat.shadowClosed = shadowClosed.length;
    stat.shadowWins = shadowClosed.filter(r => r.win).length;
    stat.shadowLosses = shadowClosed.filter(r => r.loss).length;

    const completed = stat.wins + stat.losses;
    stat.winrateNum = completed ? stat.wins / completed : 0;
    stat.winrate = pct(stat.winrateNum);

    const rValues = realClosed.map(r => r.exitR);
    const pnlValues = realClosed.map(r => r.pnlPct);

    stat.totalR = round(sum(rValues));
    stat.avgR = round(avg(rValues));

    stat.totalPnlPct = round(sum(pnlValues));
    stat.avgPnlPct = round(avg(pnlValues));

    const shadowCompleted = stat.shadowWins + stat.shadowLosses;
    stat.shadowWinrate = pct(shadowCompleted ? stat.shadowWins / shadowCompleted : 0);
    stat.shadowTotalR = round(sum(shadowClosed.map(r => r.exitR)));
    stat.shadowAvgR = round(avg(shadowClosed.map(r => r.exitR)));

    stat.avgMfeR = round(avg(realClosed.map(r => r.mfeR)));
    stat.avgMaeR = round(avg(realClosed.map(r => r.maeR)));

    stat.directSLPct = stat.closed ? pct(realClosed.filter(r => r.directToSL).length / stat.closed) : "0.0%";
    stat.nearTpPct = stat.closed ? pct(realClosed.filter(r => r.nearTpSeen).length / stat.closed) : "0.0%";

    stat.confidence =
      stat.closed >= 100 ? "HIGH"
      : stat.closed >= 50 ? "MEDIUM"
      : stat.closed >= 20 ? "LOW_PLUS"
      : stat.closed >= 5 ? "LOW"
      : stat.observed > 0 ? "OBSERVING"
      : "NO_SAMPLE";

    stat.status =
      stat.closed < 20 ? "COLLECTING"
      : stat.avgR > 0 && stat.winrateNum >= 0.55 ? "STRONG_EDGE"
      : stat.avgR > 0 && stat.winrateNum >= 0.48 ? "USABLE_EDGE"
      : stat.avgR < 0 && stat.winrateNum <= 0.45 ? "BAD_EDGE"
      : "MIXED";

    const sortedByR = [...realClosed].sort((a, b) => b.exitR - a.exitR);

    stat.bestSymbols = sortedByR.slice(0, 5).map(r => `${r.symbol}_${round(r.exitR, 2)}R`);
    stat.worstSymbols = sortedByR.slice(-5).reverse().map(r => `${r.symbol}_${round(r.exitR, 2)}R`);

    stat.examples = rows.slice(-10).map(r => ({
      symbol: r.symbol,
      side: r.side,
      action: r.action,
      source: r.source,
      status: r.status,
      setupClass: r.setupClass,
      stage: r.stage,
      flow: r.flow,
      rsiZone: r.rsiZone,
      rr: round(r.rr, 2),
      confluence: round(r.confluence, 1),
      sniperScore: round(r.sniperScore, 1),
      obRelation: r.obRelation,
      btcRelation: r.btcRelation,
      spreadBps: round(r.spreadBps, 1),
      depthUsd: round(r.depthUsd, 0),
      exitR: round(r.exitR, 3),
      pnlPct: round(r.pnlPct, 3)
    }));
  }
}

export function buildFamilyAnalysis(rowsInput = [], options = {}) {
  const rawRows = Array.isArray(rowsInput) ? rowsInput : [];
  const families = buildFamilyDefinitions();

  const statsMap = new Map(families.map(f => [f.id, initFamilyStat(f)]));
  const familyRows = new Map();

  const closedSeen = new Set();
  const openLatest = new Map();

  const normalized = rawRows
    .map(normalizeAnalyzeRow)
    .filter(r => r.side === "LONG" || r.side === "SHORT")
    .map(row => {
      const assigned = assignFamily(row, families);
      return {
        ...row,
        familyId: assigned?.family?.id || null,
        familyScore: assigned?.score || 0
      };
    })
    .filter(r => r.familyId);

  for (const row of normalized) {
    const stat = statsMap.get(row.familyId);
    if (!stat) continue;

    stat.observed++;

    if (row.status === "OPEN") {
      const key = `${row.familyId}|${stableOpenKey(row)}`;
      const prev = openLatest.get(key);
      if (!prev || row.ts > prev.ts) openLatest.set(key, row);
      continue;
    }

    if (row.status === "CLOSED") {
      const key = `${row.familyId}|${stableClosedKey(row)}`;
      if (closedSeen.has(key)) continue;
      closedSeen.add(key);
    }

    if (!familyRows.has(row.familyId)) familyRows.set(row.familyId, []);
    familyRows.get(row.familyId).push(row);
  }

  for (const row of openLatest.values()) {
    const stat = statsMap.get(row.familyId);
    if (!stat) continue;

    stat.open++;

    if (!familyRows.has(row.familyId)) familyRows.set(row.familyId, []);
    familyRows.get(row.familyId).push(row);
  }

  finalizeStats(statsMap, familyRows);

  const familyStats = Array.from(statsMap.values());
  const longFamilies = familyStats.filter(f => f.side === "LONG");
  const shortFamilies = familyStats.filter(f => f.side === "SHORT");

  const totalClosed = familyStats.reduce((sum, f) => sum + f.closed, 0);
  const totalWins = familyStats.reduce((sum, f) => sum + f.wins, 0);
  const totalLosses = familyStats.reduce((sum, f) => sum + f.losses, 0);

  return {
    version: ANALYZE_ENGINE_VERSION,
    generatedAt: Date.now(),

    summary: {
      rawRows: rawRows.length,
      normalizedRows: normalized.length,
      families: familyStats.length,
      longFamilies: longFamilies.length,
      shortFamilies: shortFamilies.length,

      observed: familyStats.reduce((sum, f) => sum + f.observed, 0),
      open: familyStats.reduce((sum, f) => sum + f.open, 0),

      closed: totalClosed,
      wins: totalWins,
      losses: totalLosses,
      winrate: pct(totalWins + totalLosses ? totalWins / (totalWins + totalLosses) : 0),

      totalR: round(familyStats.reduce((sum, f) => sum + f.totalR, 0)),
      totalPnlPct: round(familyStats.reduce((sum, f) => sum + f.totalPnlPct, 0))
    },

    trackedFilters: TRACKED_FILTERS,

    families: familyStats,

    longFamilies,
    shortFamilies,

    topLong: [...longFamilies]
      .filter(f => f.closed > 0 || f.observed > 0)
      .sort((a, b) => b.totalR - a.totalR)
      .slice(0, 20),

    topShort: [...shortFamilies]
      .filter(f => f.closed > 0 || f.observed > 0)
      .sort((a, b) => b.totalR - a.totalR)
      .slice(0, 20),

    options
  };
}