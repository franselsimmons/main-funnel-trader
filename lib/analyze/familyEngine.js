const FAMILY_COUNT_PER_SIDE = 50;

const QUALITY_BUCKETS = {
  1: {
    key: "Q1_WEAK",
    conf: "CONF_0_50",
    sniper: "SNIPER_0_50",
    rr: "RR_LT_1p00",
    score: "SCORE_0_50",
  },
  2: {
    key: "Q2_LOW",
    conf: "CONF_50_65",
    sniper: "SNIPER_50_65",
    rr: "RR_1p00_1p20",
    score: "SCORE_50_65",
  },
  3: {
    key: "Q3_BASE",
    conf: "CONF_65_75",
    sniper: "SNIPER_65_75",
    rr: "RR_1p20_1p50",
    score: "SCORE_65_75",
  },
  4: {
    key: "Q4_STRONG",
    conf: "CONF_75_85",
    sniper: "SNIPER_75_85",
    rr: "RR_1p50_2p00",
    score: "SCORE_75_85",
  },
  5: {
    key: "Q5_ELITE",
    conf: "CONF_85_100",
    sniper: "SNIPER_85_100",
    rr: "RR_2p00_PLUS",
    score: "SCORE_85_100",
  },
};

const MARKET_BUCKETS = {
  1: {
    key: "M1_DIRTY",
    ob: "OB_REL_AGAINST",
    spread: "SPREAD_GT_25BPS",
    depth: "DEPTH_LT_10K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_CROWDED",
  },
  2: {
    key: "M2_WEAK",
    ob: "OB_REL_AGAINST_OR_NEUTRAL",
    spread: "SPREAD_16_25BPS",
    depth: "DEPTH_10K_50K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_EDGE_WEAK",
  },
  3: {
    key: "M3_NORMAL",
    ob: "OB_REL_NEUTRAL",
    spread: "SPREAD_8_16BPS",
    depth: "DEPTH_50K_100K",
    btc: "BTC_REL_NEUTRAL",
    funding: "FUNDING_NEUTRAL",
  },
  4: {
    key: "M4_CLEAN",
    ob: "OB_REL_WITH_OR_NEUTRAL",
    spread: "SPREAD_5_12BPS",
    depth: "DEPTH_100K_250K",
    btc: "BTC_REL_WITH_OR_NEUTRAL",
    funding: "FUNDING_OK",
  },
  5: {
    key: "M5_PREMIUM",
    ob: "OB_REL_WITH",
    spread: "SPREAD_LT_8BPS",
    depth: "DEPTH_GT_250K",
    btc: "BTC_REL_WITH",
    funding: "FUNDING_OPTIMAL",
  },
};

const TIMING_BUCKETS = {
  1: {
    key: "T1_EARLY_OR_NOISY",
    stage: "STAGE_ANY",
    flow: "FLOW_ANY",
    tf: "TF_ANY",
    pullback: "PULLBACK_NOT_REQUIRED",
  },
  2: {
    key: "T2_TIMED",
    stage: "STAGE_ENTRY_OR_ALMOST",
    flow: "FLOW_TREND_OR_BUILDING",
    tf: "TF_ALIGNED",
    pullback: "PULLBACK_OR_CONFIRMATION_OK",
  },
};

const FAMILY_ID_RE = /^(LONG|SHORT)_([1-9]|[1-4][0-9]|50)$/;

const DEFAULT_MIN_CLOSED = 10;
const RESULT_EPSILON = 0.000001;

// Winrate-first fair ranking.
// Kern: 10/10 mag niet automatisch beter zijn dan 80/100.
const FAIR_WINRATE_TARGET_CLOSED = readNumberEnv("ANALYZE_FAIR_WINRATE_TARGET_CLOSED", 100);
const FAIR_WINRATE_WILSON_Z = readFloatEnv("ANALYZE_FAIR_WINRATE_WILSON_Z", 1.96);
const FAIR_WINRATE_PRIOR_ALPHA = readNumberEnv("ANALYZE_FAIR_WINRATE_PRIOR_ALPHA", 8);
const FAIR_WINRATE_PRIOR_BETA = readNumberEnv("ANALYZE_FAIR_WINRATE_PRIOR_BETA", 8);

// ================= ENV HELPERS =================

function readNumberEnv(key, fallback) {
  const env = typeof process !== "undefined" ? process.env : {};
  const n = Number(env?.[key]);

  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readFloatEnv(key, fallback) {
  const env = typeof process !== "undefined" ? process.env : {};
  const n = Number(env?.[key]);

  return Number.isFinite(n) && n > 0 ? n : fallback;
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

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 3) {
  const n = safeNumber(value, 0);
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function pct(value, decimals = 1) {
  return `${round(value, decimals)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["long", "bull", "buy"].includes(s)) return "LONG";
  if (["short", "bear", "sell"].includes(s)) return "SHORT";

  return "";
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function getPathValue(object, path) {
  if (!object || typeof object !== "object") return undefined;

  return String(path)
    .split(".")
    .reduce((acc, part) => acc?.[part], object);
}

function valueFromEvent(event, key) {
  const sources = [
    event,
    safeObject(event?.filterSnapshot),
    safeObject(event?.filters),
    safeObject(event?.filterValues),
    safeObject(event?.analysisFilters),
    safeObject(event?.entryEvent),
    safeObject(event?.entryEvent?.filterSnapshot),
  ];

  for (const source of sources) {
    const value = getPathValue(source, key);

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function firstNumber(event, keys, fallback = 0) {
  for (const key of keys) {
    const value = valueFromEvent(event, key);
    const n = Number(value);

    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function firstNullableNumber(event, keys) {
  for (const key of keys) {
    const value = valueFromEvent(event, key);
    const n = Number(value);

    if (Number.isFinite(n)) return n;
  }

  return null;
}

function firstString(event, keys, fallback = "") {
  for (const key of keys) {
    const value = valueFromEvent(event, key);

    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }

  return fallback;
}

function firstBoolean(event, keys, fallback = false) {
  for (const key of keys) {
    const value = valueFromEvent(event, key);

    if (typeof value === "boolean") return value;

    const s = String(value || "").toLowerCase().trim();

    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }

  return fallback;
}

// ================= FAMILY DEFINITIONS =================

function familyIndex(q, m, t) {
  return ((q - 1) * 10) + ((m - 1) * 2) + t;
}

function parseFamilyId(value) {
  const id = normalizeText(value);
  const match = FAMILY_ID_RE.exec(id);

  if (!match) return null;

  const side = match[1];
  const index = Number(match[2]);

  const qualityIndex = Math.ceil(index / 10);
  const rem = index - ((qualityIndex - 1) * 10);
  const marketIndex = Math.ceil(rem / 2);
  const timingIndex = rem % 2 === 0 ? 2 : 1;

  return {
    side,
    index,
    qualityIndex,
    marketIndex,
    timingIndex,
    familyId: `${side}_${index}`,
  };
}

function buildDefinition(side, q, m, t) {
  const qDef = QUALITY_BUCKETS[q];
  const mDef = MARKET_BUCKETS[m];
  const tDef = TIMING_BUCKETS[t];

  const rsi =
    t === 1
      ? "RSI_ANY"
      : side === "LONG"
        ? "RSI_LOWER_OR_MID"
        : "RSI_UPPER_OR_MID";

  return [
    qDef.key,
    mDef.key,
    tDef.key,
    qDef.conf,
    qDef.sniper,
    qDef.rr,
    qDef.score,
    tDef.stage,
    tDef.flow,
    rsi,
    mDef.ob,
    mDef.spread,
    mDef.depth,
    mDef.btc,
    mDef.funding,
    tDef.tf,
    tDef.pullback,
  ].join(" | ");
}

function createFamily(side, q, m, t) {
  const index = familyIndex(q, m, t);

  return {
    id: `${side}_${index}`,
    side,
    index,
    qualityIndex: q,
    marketIndex: m,
    timingIndex: t,

    definition: buildDefinition(side, q, m, t),
    qualityBucket: QUALITY_BUCKETS[q].key,
    marketBucket: MARKET_BUCKETS[m].key,
    timingBucket: TIMING_BUCKETS[t].key,

    observed: 0,
    trades: 0,
    open: 0,
    closed: 0,
    unresolved: 0,
    pendingOutcome: 0,

    wins: 0,
    losses: 0,
    breakeven: 0,

    // Raw winrate.
    winrate: "0%",
    winrateNum: 0,

    // Fair winrate metrics.
    adjustedWinrate: "0%",
    adjustedWinrateNum: 0,
    wilsonLowerBound: "0%",
    wilsonLowerBoundNum: 0,
    sampleConfidence: "0%",
    sampleConfidenceNum: 0,
    fairWinrateScore: 0,
    rankingMetric: "FAIR_WINRATE_WILSON_BAYES",

    // Secondary only. Niet primair voor ranking.
    totalR: 0,
    avgR: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    expectancyR: 0,
    profitFactorR: 0,

    grossProfitR: 0,
    grossLossAbsR: 0,

    bestR: 0,
    worstR: 0,

    status: "EMPTY",
    decision: "NO_DATA",
  };
}

export function createAnalyzeFamilies() {
  const long = [];
  const short = [];

  for (const side of ["LONG", "SHORT"]) {
    for (let q = 1; q <= 5; q += 1) {
      for (let m = 1; m <= 5; m += 1) {
        for (let t = 1; t <= 2; t += 1) {
          const family = createFamily(side, q, m, t);

          if (side === "LONG") long.push(family);
          else short.push(family);
        }
      }
    }
  }

  return {
    long,
    short,
    all: [...long, ...short],
  };
}

// ================= QUALITY BUCKETING =================

function getConfluence(event) {
  return firstNumber(
    event,
    [
      "confluence",
      "confluenceScore",
      "setupConfluence",
      "scores.confluence",
      "quality.confluence",
    ],
    0
  );
}

function getSniper(event) {
  return firstNumber(
    event,
    [
      "sniperScore",
      "sniper",
      "scores.sniper",
      "quality.sniper",
    ],
    0
  );
}

function getRR(event) {
  return firstNumber(
    event,
    [
      "plannedRR",
      "finalRr",
      "finalRR",
      "rr",
      "baseRR",
      "riskReward",
      "riskRewardRatio",
      "preTpRR",
      "geometryRR",
      "quality.rr",
    ],
    0
  );
}

function getMoveScore(event) {
  return firstNumber(
    event,
    [
      "moveScore",
      "score",
      "tradeScore",
      "candidateScore",
      "externalScore",
      "scores.move",
      "quality.score",
    ],
    0
  );
}

function bucketScore01To5(value) {
  const n = safeNumber(value, 0);

  if (n >= 85) return 5;
  if (n >= 75) return 4;
  if (n >= 65) return 3;
  if (n >= 50) return 2;

  return 1;
}

function bucketRRTo5(value) {
  const n = safeNumber(value, 0);

  if (n >= 2) return 5;
  if (n >= 1.5) return 4;
  if (n >= 1.2) return 3;
  if (n >= 1) return 2;

  return 1;
}

function qualityIndex(event) {
  const confRaw = getConfluence(event);
  const sniperRaw = getSniper(event);
  const rrRaw = getRR(event);
  const scoreRaw = getMoveScore(event);

  const conf = confRaw > 0 ? confRaw : scoreRaw > 0 ? scoreRaw : 55;
  const sniper = sniperRaw > 0 ? sniperRaw : conf;
  const rr = rrRaw > 0 ? rrRaw : 1.1;
  const score = scoreRaw > 0 ? scoreRaw : conf;

  const confBucket = bucketScore01To5(conf);
  const sniperBucket = bucketScore01To5(sniper);
  const rrBucket = bucketRRTo5(rr);
  const scoreBucket = bucketScore01To5(score);

  const weighted =
    confBucket * 1.25 +
    rrBucket * 1.25 +
    scoreBucket * 1 +
    sniperBucket * 0.75;

  const avg = weighted / 4.25;

  if (avg >= 4.5) return 5;
  if (avg >= 3.5) return 4;
  if (avg >= 2.5) return 3;
  if (avg >= 1.7) return 2;

  return 1;
}

// ================= MARKET BUCKETING =================

function getSpreadBps(event) {
  const rawBps = firstNumber(
    event,
    [
      "spreadBps",
      "spread.bps",
      "market.spreadBps",
    ],
    NaN
  );

  if (Number.isFinite(rawBps)) return rawBps;

  const spreadPct = firstNumber(
    event,
    [
      "spreadPct",
      "spread",
      "market.spreadPct",
    ],
    0
  );

  if (!spreadPct) return 12;

  const n = Math.abs(spreadPct);

  if (n <= 0.05) return n * 10000;
  if (n <= 10) return n * 100;

  return n;
}

function getDepthUsd1p(event) {
  return firstNumber(
    event,
    [
      "depthMinUsd1p",
      "depthUsd1p",
      "depth1p",
      "depthUsd",
      "market.depthMinUsd1p",
      "orderbook.depthMinUsd1p",
      "orderbook.depthUsd1p",
    ],
    75000
  );
}

function getFundingRate(event) {
  return firstNumber(
    event,
    [
      "fundingRate",
      "funding",
      "market.fundingRate",
    ],
    0
  );
}

function getObRelative(event, side) {
  const raw = normalizeText(
    firstString(
      event,
      [
        "obRel",
        "obRelative",
        "obSideRelation",
        "obBias",
        "orderbookBias",
        "orderbook.bias",
        "market.obBias",
      ],
      "NEUTRAL"
    )
  );

  if (raw.includes("WITH")) return "WITH";
  if (raw.includes("AGAINST")) return "AGAINST";
  if (raw.includes("NEUTRAL")) return "NEUTRAL";

  const bullish = ["BULL", "BULLISH", "BID", "BUY", "LONG"];
  const bearish = ["BEAR", "BEARISH", "ASK", "SELL", "SHORT"];

  const isBullish = bullish.some(x => raw.includes(x));
  const isBearish = bearish.some(x => raw.includes(x));

  if (side === "LONG") {
    if (isBullish) return "WITH";
    if (isBearish) return "AGAINST";
  }

  if (side === "SHORT") {
    if (isBearish) return "WITH";
    if (isBullish) return "AGAINST";
  }

  return "NEUTRAL";
}

function getBtcRelative(event, side) {
  const raw = normalizeText(
    firstString(
      event,
      [
        "btcRelative",
        "btcRel",
        "btcState",
        "btc.state",
        "market.btcState",
      ],
      "NEUTRAL"
    )
  );

  if (raw.includes("WITH")) return "WITH";
  if (raw.includes("COUNTER")) return "COUNTER";
  if (raw.includes("NEUTRAL")) return "NEUTRAL";

  const btcBullish = raw.includes("BULL");
  const btcBearish = raw.includes("BEAR");

  if (side === "LONG") {
    if (btcBullish) return "WITH";
    if (btcBearish) return "COUNTER";
  }

  if (side === "SHORT") {
    if (btcBearish) return "WITH";
    if (btcBullish) return "COUNTER";
  }

  return "NEUTRAL";
}

function getFundingBucket(event, side) {
  const funding = getFundingRate(event);

  if (side === "LONG") {
    if (funding > 0.001) return "CROWDED";
    if (funding < -0.0003) return "OPTIMAL";
    if (funding > 0.0005) return "EDGE_WEAK";
    return "NEUTRAL";
  }

  if (side === "SHORT") {
    if (funding < -0.001) return "CROWDED";
    if (funding > 0.0003) return "OPTIMAL";
    if (funding < -0.0005) return "EDGE_WEAK";
    return "NEUTRAL";
  }

  return "NEUTRAL";
}

function marketIndex(event, side) {
  const spreadBps = getSpreadBps(event);
  const depth = getDepthUsd1p(event);
  const obRel = getObRelative(event, side);
  const btcRel = getBtcRelative(event, side);
  const funding = getFundingBucket(event, side);

  let points = 0;

  if (spreadBps <= 8) points += 2;
  else if (spreadBps <= 12) points += 1;
  else if (spreadBps > 25) points -= 2;
  else if (spreadBps > 16) points -= 1;

  if (depth >= 250000) points += 2;
  else if (depth >= 100000) points += 1;
  else if (depth < 10000) points -= 2;
  else if (depth < 50000) points -= 1;

  if (obRel === "WITH") points += 1;
  if (obRel === "AGAINST") points -= 1;

  if (btcRel === "WITH") points += 1;
  if (btcRel === "COUNTER") points -= 1;

  if (funding === "OPTIMAL") points += 1;
  if (funding === "CROWDED") points -= 1;

  if (points >= 5) return 5;
  if (points >= 2) return 4;
  if (points >= 0) return 3;
  if (points >= -2) return 2;

  return 1;
}

// ================= TIMING BUCKETING =================

function getStage(event) {
  const raw = String(
    firstString(
      event,
      [
        "stage",
        "scannerStage",
        "setupStage",
        "stageSource",
      ],
      ""
    )
  ).toLowerCase();

  if (raw.includes("entry")) return "ENTRY";
  if (raw.includes("almost")) return "ALMOST";

  return "OTHER";
}

function getFlow(event) {
  const raw = normalizeText(
    firstString(
      event,
      [
        "flow",
        "flowState",
        "marketFlow",
      ],
      "NEUTRAL"
    )
  );

  if (
    raw.includes("TREND") ||
    raw.includes("BREAKOUT") ||
    raw.includes("RUNNING")
  ) {
    return "TREND";
  }

  if (raw.includes("BUILDING") || raw.includes("BUILDUP")) {
    return "BUILDING";
  }

  return "NEUTRAL";
}

function isRsiTimed(event, side) {
  const zone = normalizeText(
    firstString(
      event,
      [
        "rsiZone",
        "rsi.zone",
        "rsiBucket",
      ],
      ""
    )
  );

  if (zone) {
    if (zone.includes("MID")) return true;

    if (side === "LONG") {
      return zone.includes("LOWER") || zone.includes("OVERSOLD");
    }

    if (side === "SHORT") {
      return zone.includes("UPPER") || zone.includes("OVERBOUGHT");
    }
  }

  const rsi = firstNumber(
    event,
    [
      "rsi",
      "rsi.value",
      "rsi1h",
      "rsiHTF",
    ],
    NaN
  );

  if (!Number.isFinite(rsi)) return false;

  if (side === "LONG") return rsi <= 62;
  if (side === "SHORT") return rsi >= 38;

  return false;
}

function isTfAligned(event, side) {
  if (
    firstBoolean(
      event,
      [
        "tfAligned",
        "timeframeAligned",
        "mtfAligned",
      ],
      false
    )
  ) {
    return true;
  }

  const tfStrength = firstNumber(
    event,
    [
      "tfStrength",
      "timeframeStrength",
      "mtfStrength",
    ],
    0
  );

  if (tfStrength >= 1) return true;

  const tfScore = firstNumber(
    event,
    [
      "tfScore",
      "timeframeScore",
      "mtfScore",
    ],
    0
  );

  if (side === "LONG") return tfScore > 0;
  if (side === "SHORT") return tfScore < 0;

  return false;
}

function isPullbackOk(event) {
  if (
    firstBoolean(
      event,
      [
        "pullbackOk",
        "hasPullback",
        "confirmationOk",
        "entryConfirmationOk",
        "pullbackConfirmed",
        "sweepConfirmed",
        "retestConfirmed",
      ],
      false
    )
  ) {
    return true;
  }

  const distanceFromHigh = firstNumber(
    event,
    [
      "distanceFromLocalHighPct",
      "pullbackFromHighPct",
    ],
    0
  );

  if (distanceFromHigh >= 0.5) return true;

  const stage = getStage(event);
  return stage === "ENTRY";
}

function timingIndex(event, side) {
  const stage = getStage(event);
  const flow = getFlow(event);

  let points = 0;

  if (stage === "ENTRY" || stage === "ALMOST") points += 1;
  if (flow === "TREND" || flow === "BUILDING") points += 1;
  if (isRsiTimed(event, side)) points += 1;
  if (isTfAligned(event, side)) points += 1;
  if (isPullbackOk(event)) points += 1;

  return points >= 3 ? 2 : 1;
}

// ================= EVENT / TRADE CLASSIFICATION =================

function isUnmatchedExit(event) {
  const kind = normalizeText(event?.analyzeKind || event?.type);
  return kind === "UNMATCHED_EXIT";
}

function isTradeRecord(event) {
  if (!event || typeof event !== "object") return false;
  if (isUnmatchedExit(event)) return false;

  const kind = normalizeText(event?.analyzeKind || event?.type);

  if (kind === "TRADE_RECORD" || kind === "TRADE") return true;

  if (event.tradeId || event.positionId || event.orderId) return true;

  return Boolean(
    event.entry !== undefined ||
      event.entryPrice !== undefined ||
      event.sl !== undefined ||
      event.tp !== undefined ||
      event.rr !== undefined ||
      event.closed === true ||
      event.isClosed === true ||
      event.exitPrice !== undefined ||
      event.closedAt ||
      event.exitAt ||
      event.exitTs
  );
}

function getFrozenFamilyClassification(event) {
  const directFamilyId =
    event?.familyId ||
    event?.analyzeFamilyId ||
    event?.analysisFamilyId ||
    event?.filterSnapshot?.familyId ||
    event?.filterSnapshot?.analyzeFamilyId;

  const parsed = parseFamilyId(directFamilyId);

  if (!parsed) return null;

  return {
    ...parsed,
    source: "FROZEN_FAMILY_ID",
  };
}

function classifyEvent(event) {
  if (!isTradeRecord(event)) return null;

  const frozen = getFrozenFamilyClassification(event);
  if (frozen) return frozen;

  const side = normalizeSide(
    event.side ??
      event.direction ??
      event.tradeSide ??
      event.filterSnapshot?.side
  );

  if (!side) return null;

  const q = qualityIndex(event);
  const m = marketIndex(event, side);
  const t = timingIndex(event, side);
  const index = familyIndex(q, m, t);

  return {
    side,
    index,
    qualityIndex: q,
    marketIndex: m,
    timingIndex: t,
    familyId: `${side}_${index}`,
    source: "CLASSIFIED_FROM_FILTER_SNAPSHOT",
  };
}

export function classifyAnalyzeEvent(event) {
  return classifyEvent(event);
}

// ================= CLOSED / RESULT LOGIC =================

const R_RESULT_KEYS = [
  "realizedR",
  "pnlR",
  "closedR",
  "exitR",
  "resultR",
  "outcomeR",
  "netR",
  "rMultiple",
  "r",
];

const PNL_RESULT_KEYS = [
  "pnlPct",
  "pnlPercent",
  "realizedPnlPct",
  "closedPnlPct",
  "exitPnlPct",
  "resultPnlPct",
  "profitPct",
  "netPnlPct",
  "pnl",
];

function getStatusText(event) {
  return normalizeText(
    firstString(
      event,
      [
        "status",
        "action",
        "reason",
        "exitReason",
        "result",
        "outcome",
      ],
      ""
    )
  );
}

function getRawR(event) {
  return firstNullableNumber(event, R_RESULT_KEYS);
}

function getRawPnlPct(event) {
  return firstNullableNumber(event, PNL_RESULT_KEYS);
}

function hasNumericOutcome(event) {
  return getRawR(event) !== null || getRawPnlPct(event) !== null;
}

function hasExitSignal(event) {
  if (!isTradeRecord(event)) return false;

  if (event.closed === true) return true;
  if (event.isClosed === true) return true;

  if (event.exitPrice !== undefined && event.exitPrice !== null) return true;
  if (event.closedAt || event.exitAt || event.exitTs) return true;

  const exitReason = firstString(event, ["exitReason", "closeReason"], "");
  if (exitReason) return true;

  const status = getStatusText(event);

  return (
    status.includes("CLOSED") ||
    status.includes("EXIT") ||
    status.includes("TP") ||
    status.includes("SL") ||
    status.includes("WIN") ||
    status.includes("LOSS") ||
    status.includes("STOP") ||
    status.includes("BREAK_EVEN") ||
    status.includes("BREAKEVEN")
  );
}

function isClosedEvent(event) {
  if (!isTradeRecord(event)) return false;

  // Hard rule:
  // closed/action EXIT/status TP/SL zonder realizedR/pnlR/pnlPct telt NIET als closed.
  // Dat voorkomt fake 0R closed trades.
  return hasExitSignal(event) && hasNumericOutcome(event);
}

function isUnresolvedOutcomeEvent(event) {
  if (!isTradeRecord(event)) return false;
  if (isClosedEvent(event)) return false;

  return hasExitSignal(event) && !hasNumericOutcome(event);
}

function getR(event) {
  const direct = getRawR(event);

  if (direct !== null) return direct;

  const pnlPct = getRawPnlPct(event);

  if (pnlPct !== null && Math.abs(pnlPct) > RESULT_EPSILON) {
    return pnlPct / 2.25;
  }

  return 0;
}

function getPnlPct(event) {
  const value = getRawPnlPct(event);

  return value ?? 0;
}

function isWinEvent(event) {
  if (!isClosedEvent(event)) return false;

  const r = getR(event);
  const pnlPct = getPnlPct(event);

  if (r > RESULT_EPSILON || pnlPct > RESULT_EPSILON) return true;
  if (r < -RESULT_EPSILON || pnlPct < -RESULT_EPSILON) return false;

  return false;
}

function isLossEvent(event) {
  if (!isClosedEvent(event)) return false;

  const r = getR(event);
  const pnlPct = getPnlPct(event);

  if (r < -RESULT_EPSILON || pnlPct < -RESULT_EPSILON) return true;
  if (r > RESULT_EPSILON || pnlPct > RESULT_EPSILON) return false;

  return false;
}

function isBreakevenEvent(event) {
  if (!isClosedEvent(event)) return false;

  const r = getR(event);
  const pnlPct = getPnlPct(event);

  return (
    Math.abs(r) <= RESULT_EPSILON &&
    Math.abs(pnlPct) <= RESULT_EPSILON
  );
}

// ================= FAIR WINRATE SCORING =================

function wilsonLowerBound(wins, total, z = FAIR_WINRATE_WILSON_Z) {
  const n = safeNumber(total, 0);
  const w = safeNumber(wins, 0);

  if (n <= 0) return 0;

  const p = clamp(w / n, 0, 1);
  const z2 = z * z;

  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function bayesianWinrate(wins, total) {
  const w = safeNumber(wins, 0);
  const n = safeNumber(total, 0);

  return (
    (w + FAIR_WINRATE_PRIOR_ALPHA) /
    (n + FAIR_WINRATE_PRIOR_ALPHA + FAIR_WINRATE_PRIOR_BETA)
  );
}

function calculateFairWinrateScore({ wins, closed }) {
  const n = safeNumber(closed, 0);

  if (n <= 0) {
    return {
      rawWinrateNum: 0,
      adjustedWinrateNum: 0,
      wilsonLowerBoundNum: 0,
      sampleConfidenceNum: 0,
      fairWinrateScore: 0,
    };
  }

  const raw = clamp(safeNumber(wins, 0) / n, 0, 1);
  const adjusted = bayesianWinrate(wins, n);
  const wilson = wilsonLowerBound(wins, n);
  const sampleConfidence = clamp(n / FAIR_WINRATE_TARGET_CLOSED, 0, 1);

  // Hoofdmetric:
  // - Wilson lower bound corrigeert voor kleine sample.
  // - Bayesian shrinkage dempt 10/10 naar realistischer niveau.
  // - Raw winrate is alleen lichte component.
  // - AvgR/PnL is geen primaire component.
  const fairScore =
    wilson * 72 +
    adjusted * 20 +
    raw * 8;

  return {
    rawWinrateNum: round(raw * 100, 3),
    adjustedWinrateNum: round(adjusted * 100, 3),
    wilsonLowerBoundNum: round(wilson * 100, 3),
    sampleConfidenceNum: round(sampleConfidence * 100, 3),
    fairWinrateScore: round(fairScore, 3),
  };
}

// ================= FAMILY SCORING =================

function getFamilyDecision(family, minClosed) {
  if (family.observed <= 0) return "NO_DATA";
  if (family.closed < minClosed) return "COLLECT_MORE";

  if (family.fairWinrateScore >= 60 && family.wilsonLowerBoundNum >= 55) {
    return "ALLOW_PRIORITY";
  }

  if (family.fairWinrateScore >= 54 && family.wilsonLowerBoundNum >= 48) {
    return "ALLOW";
  }

  if (family.fairWinrateScore >= 48) {
    return "ALLOW_SMALL_SIZE";
  }

  return "BLOCK_OR_REDUCE";
}

function scoreFamilyStatus(family, minClosed) {
  if (family.observed <= 0) return "EMPTY";
  if (family.closed < minClosed) return "COLLECTING";

  if (family.fairWinrateScore >= 60 && family.wilsonLowerBoundNum >= 55) {
    return "HOT";
  }

  if (family.fairWinrateScore >= 54 && family.wilsonLowerBoundNum >= 48) {
    return "GOOD";
  }

  if (family.fairWinrateScore >= 48) {
    return "STABLE";
  }

  return "BAD";
}

function finalizeFamily(family, minClosed) {
  const fair = calculateFairWinrateScore({
    wins: family.wins,
    closed: family.closed,
  });

  family.winrateNum = fair.rawWinrateNum;
  family.winrate = pct(
    family.winrateNum,
    family.winrateNum % 1 === 0 ? 0 : 1
  );

  family.adjustedWinrateNum = fair.adjustedWinrateNum;
  family.adjustedWinrate = pct(
    family.adjustedWinrateNum,
    family.adjustedWinrateNum % 1 === 0 ? 0 : 1
  );

  family.wilsonLowerBoundNum = fair.wilsonLowerBoundNum;
  family.wilsonLowerBound = pct(
    family.wilsonLowerBoundNum,
    family.wilsonLowerBoundNum % 1 === 0 ? 0 : 1
  );

  family.sampleConfidenceNum = fair.sampleConfidenceNum;
  family.sampleConfidence = pct(
    family.sampleConfidenceNum,
    family.sampleConfidenceNum % 1 === 0 ? 0 : 1
  );

  family.fairWinrateScore = fair.fairWinrateScore;

  family.totalR = round(family.totalR, 3);
  family.avgR = family.closed > 0 ? round(family.totalR / family.closed, 3) : 0;

  family.totalPnlPct = round(family.totalPnlPct, 3);
  family.avgPnlPct =
    family.closed > 0 ? round(family.totalPnlPct / family.closed, 3) : 0;

  family.expectancyR = family.avgR;

  family.grossProfitR = round(family.grossProfitR, 3);
  family.grossLossAbsR = round(family.grossLossAbsR, 3);

  family.profitFactorR =
    family.grossLossAbsR > 0
      ? round(family.grossProfitR / family.grossLossAbsR, 3)
      : family.grossProfitR > 0
        ? 999
        : 0;

  family.bestR = round(family.bestR, 3);
  family.worstR = round(family.worstR, 3);

  family.status = scoreFamilyStatus(family, minClosed);
  family.decision = getFamilyDecision(family, minClosed);

  return family;
}

function sortRankedFamilies(families) {
  const statusRank = {
    HOT: 6,
    GOOD: 5,
    STABLE: 4,
    COLLECTING: 3,
    BAD: 2,
    EMPTY: 1,
  };

  return [...families].sort((a, b) => {
    const statusDiff = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
    if (statusDiff !== 0) return statusDiff;

    const fairDiff = b.fairWinrateScore - a.fairWinrateScore;
    if (fairDiff !== 0) return fairDiff;

    const wilsonDiff = b.wilsonLowerBoundNum - a.wilsonLowerBoundNum;
    if (wilsonDiff !== 0) return wilsonDiff;

    const adjustedDiff = b.adjustedWinrateNum - a.adjustedWinrateNum;
    if (adjustedDiff !== 0) return adjustedDiff;

    const rawWinrateDiff = b.winrateNum - a.winrateNum;
    if (rawWinrateDiff !== 0) return rawWinrateDiff;

    const closedDiff = b.closed - a.closed;
    if (closedDiff !== 0) return closedDiff;

    // Alleen als winrate-metrics gelijk zijn.
    const avgRDiff = b.avgR - a.avgR;
    if (avgRDiff !== 0) return avgRDiff;

    const observedDiff = b.observed - a.observed;
    if (observedDiff !== 0) return observedDiff;

    const sideDiff = a.side.localeCompare(b.side);
    if (sideDiff !== 0) return sideDiff;

    return a.index - b.index;
  });
}

function getBestFamilies(families, limit = 10) {
  return sortRankedFamilies(
    families.filter(family =>
      ["HOT", "GOOD", "STABLE"].includes(family.status)
    )
  ).slice(0, limit);
}

function getWorstFamilies(families, limit = 10) {
  return [...families]
    .filter(family => family.closed > 0)
    .sort((a, b) => {
      const fairDiff = a.fairWinrateScore - b.fairWinrateScore;
      if (fairDiff !== 0) return fairDiff;

      const wilsonDiff = a.wilsonLowerBoundNum - b.wilsonLowerBoundNum;
      if (wilsonDiff !== 0) return wilsonDiff;

      const rawWinrateDiff = a.winrateNum - b.winrateNum;
      if (rawWinrateDiff !== 0) return rawWinrateDiff;

      const avgRDiff = a.avgR - b.avgR;
      if (avgRDiff !== 0) return avgRDiff;

      return b.closed - a.closed;
    })
    .slice(0, limit);
}

// ================= SUMMARY =================

function buildSummary(families, sourceEvents) {
  const tradeEvents = sourceEvents.filter(isTradeRecord);
  const closedEvents = tradeEvents.filter(isClosedEvent);
  const unresolvedEvents = tradeEvents.filter(isUnresolvedOutcomeEvent);
  const openEvents = tradeEvents.filter(event => !isClosedEvent(event));

  const wins = closedEvents.filter(isWinEvent).length;
  const losses = closedEvents.filter(isLossEvent).length;
  const breakeven = closedEvents.filter(isBreakevenEvent).length;

  const totalR = round(
    closedEvents.reduce((sum, event) => sum + getR(event), 0),
    3
  );

  const totalPnlPct = round(
    closedEvents.reduce((sum, event) => sum + getPnlPct(event), 0),
    3
  );

  const fair = calculateFairWinrateScore({
    wins,
    closed: closedEvents.length,
  });

  return {
    actions: sourceEvents.length,
    trades: tradeEvents.length,
    observed: tradeEvents.length,

    open: openEvents.length,
    closed: closedEvents.length,
    unresolved: unresolvedEvents.length,
    pendingOutcome: unresolvedEvents.length,

    wins,
    losses,
    breakeven,

    totalR,
    totalPnlPct,

    winrateNum: fair.rawWinrateNum,
    winrate: pct(
      fair.rawWinrateNum,
      fair.rawWinrateNum % 1 === 0 ? 0 : 1
    ),

    adjustedWinrateNum: fair.adjustedWinrateNum,
    adjustedWinrate: pct(
      fair.adjustedWinrateNum,
      fair.adjustedWinrateNum % 1 === 0 ? 0 : 1
    ),

    wilsonLowerBoundNum: fair.wilsonLowerBoundNum,
    wilsonLowerBound: pct(
      fair.wilsonLowerBoundNum,
      fair.wilsonLowerBoundNum % 1 === 0 ? 0 : 1
    ),

    fairWinrateScore: fair.fairWinrateScore,
    sampleConfidenceNum: fair.sampleConfidenceNum,
    sampleConfidence: pct(
      fair.sampleConfidenceNum,
      fair.sampleConfidenceNum % 1 === 0 ? 0 : 1
    ),

    avgR: closedEvents.length > 0 ? round(totalR / closedEvents.length, 3) : 0,
    avgPnlPct:
      closedEvents.length > 0 ? round(totalPnlPct / closedEvents.length, 3) : 0,

    longFamilies: 50,
    shortFamilies: 50,

    hotFamilies: families.filter(f => f.status === "HOT").length,
    goodFamilies: families.filter(f => f.status === "GOOD").length,
    stableFamilies: families.filter(f => f.status === "STABLE").length,
    badFamilies: families.filter(f => f.status === "BAD").length,
    collectingFamilies: families.filter(f => f.status === "COLLECTING").length,
    emptyFamilies: families.filter(f => f.status === "EMPTY").length,
  };
}

// ================= REPORT BUILDER =================

export function buildAnalyzeReport(events = [], options = {}) {
  const minClosed = safeNumber(options.minClosed, DEFAULT_MIN_CLOSED);
  const sourceEvents = safeArray(events).filter(event => event && typeof event === "object");

  const families = createAnalyzeFamilies();
  const byId = new Map(families.all.map(family => [family.id, family]));

  const classificationStats = {
    sourceEvents: sourceEvents.length,
    tradeRecords: 0,
    skipped: 0,
    frozenFamily: 0,
    classifiedFromSnapshot: 0,
    missingFamily: 0,

    closedUsedForWinrate: 0,
    openTrackedOnly: 0,
    unresolvedNoOutcome: 0,
    exitSignalWithoutOutcome: 0,
  };

  for (const event of sourceEvents) {
    if (!isTradeRecord(event)) {
      classificationStats.skipped += 1;
      continue;
    }

    classificationStats.tradeRecords += 1;

    const classification = classifyEvent(event);

    if (!classification) {
      classificationStats.skipped += 1;
      classificationStats.missingFamily += 1;
      continue;
    }

    if (classification.source === "FROZEN_FAMILY_ID") {
      classificationStats.frozenFamily += 1;
    } else {
      classificationStats.classifiedFromSnapshot += 1;
    }

    const family = byId.get(classification.familyId);

    if (!family) {
      classificationStats.skipped += 1;
      classificationStats.missingFamily += 1;
      continue;
    }

    const closed = isClosedEvent(event);
    const unresolved = isUnresolvedOutcomeEvent(event);

    family.observed += 1;
    family.trades += 1;

    if (!closed) {
      family.open += 1;

      if (unresolved) {
        family.unresolved += 1;
        family.pendingOutcome += 1;
        classificationStats.unresolvedNoOutcome += 1;
        classificationStats.exitSignalWithoutOutcome += 1;
      } else {
        classificationStats.openTrackedOnly += 1;
      }

      continue;
    }

    const r = getR(event);
    const pnlPct = getPnlPct(event);

    family.closed += 1;
    family.totalR += r;
    family.totalPnlPct += pnlPct;

    if (family.closed === 1) {
      family.bestR = r;
      family.worstR = r;
    } else {
      family.bestR = Math.max(family.bestR, r);
      family.worstR = Math.min(family.worstR, r);
    }

    if (r > 0) {
      family.grossProfitR += r;
    }

    if (r < 0) {
      family.grossLossAbsR += Math.abs(r);
    }

    if (isWinEvent(event)) {
      family.wins += 1;
    } else if (isLossEvent(event)) {
      family.losses += 1;
    } else if (isBreakevenEvent(event)) {
      family.breakeven += 1;
    }

    classificationStats.closedUsedForWinrate += 1;
  }

  const finalizedLong = families.long.map(family => finalizeFamily(family, minClosed));
  const finalizedShort = families.short.map(family => finalizeFamily(family, minClosed));
  const finalizedAll = [...finalizedLong, ...finalizedShort];

  const ranked = sortRankedFamilies(finalizedAll);
  const best = getBestFamilies(finalizedAll, 10);
  const worst = getWorstFamilies(finalizedAll, 10);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),

    config: {
      minClosed,
      familyCountLong: FAMILY_COUNT_PER_SIDE,
      familyCountShort: FAMILY_COUNT_PER_SIDE,
      totalFamilyCount: FAMILY_COUNT_PER_SIDE * 2,

      primaryRankingMetric: "FAIR_WINRATE_WILSON_BAYES",
      rankingPriority: [
        "status",
        "fairWinrateScore",
        "wilsonLowerBoundNum",
        "adjustedWinrateNum",
        "winrateNum",
        "closed",
        "avgR_secondary_tiebreak_only",
      ],

      fairWinrate: {
        targetClosed: FAIR_WINRATE_TARGET_CLOSED,
        wilsonZ: FAIR_WINRATE_WILSON_Z,
        priorAlpha: FAIR_WINRATE_PRIOR_ALPHA,
        priorBeta: FAIR_WINRATE_PRIOR_BETA,
        formula: "fairWinrateScore = wilsonLowerBound*72 + bayesianAdjustedWinrate*20 + rawWinrate*8",
        pnlIsPrimary: false,
      },

      winrateUsesOnlyClosedTrades: true,
      closedRequiresNumericOutcome: true,
      closedWithoutOutcomeBecomesPendingOutcome: true,
      familyUsesFrozenEntryFamilyId: true,
    },

    summary: buildSummary(finalizedAll, sourceEvents),

    diagnostics: classificationStats,

    families: {
      all: ranked,
      long: finalizedLong,
      short: finalizedShort,
      ranked,
      best,
      worst,
    },

    filterValues: {
      qualityBuckets: QUALITY_BUCKETS,
      marketBuckets: MARKET_BUCKETS,
      timingBuckets: TIMING_BUCKETS,
      trackedFields: [
        "tradeId",
        "familyId",
        "side",
        "stage",
        "flow",
        "confluence",
        "sniperScore",
        "rr",
        "baseRR",
        "finalRr",
        "plannedRR",
        "moveScore",
        "rsi",
        "rsiZone",
        "obBias",
        "spreadPct",
        "spreadBps",
        "depthMinUsd1p",
        "btcState",
        "fundingRate",
        "tfScore",
        "tfStrength",
        "closed",
        "closedAt",
        "exitPrice",
        "pnlPct",
        "pnlR",
        "realizedR",
        "resultR",
        "outcomeR",
        "exitReason",
      ],
    },
  };
}

// ================= COMPAT EXPORTS =================

export function buildFamilyReport(events = [], options = {}) {
  return buildAnalyzeReport(events, options);
}

export function buildReport(events = [], options = {}) {
  return buildAnalyzeReport(events, options);
}

export function analyzeEvents(events = [], options = {}) {
  return buildAnalyzeReport(events, options);
}

export function createAnalyzeReport(events = [], options = {}) {
  return buildAnalyzeReport(events, options);
}

export default {
  createAnalyzeFamilies,
  classifyAnalyzeEvent,
  buildAnalyzeReport,
  buildFamilyReport,
  buildReport,
  analyzeEvents,
  createAnalyzeReport,
};