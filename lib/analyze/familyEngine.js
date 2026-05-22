// lib/analyze/familyEngine.js

const SIDE_LONG = "LONG";
const SIDE_SHORT = "SHORT";

export const ANALYZE_FILTER_KEYS = [
  "qualityBucket",
  "marketBucket",
  "timingBucket",
  "confidenceBucket",
  "sniperBucket",
  "rrBucket",
  "scoreBucket",
  "stageBucket",
  "flowBucket",
  "rsiBucket",
  "obRelationBucket",
  "spreadBucket",
  "depthBucket",
  "btcRelationBucket",
  "fundingBucket",
  "tfBucket",
  "pullbackBucket",
];

const QUALITY_TIERS = [
  {
    id: "Q1_WEAK",
    conf: "CONF_0_50",
    sniper: "SNIPER_0_50",
    rr: "RR_LT_1p00",
    score: "SCORE_0_50",
  },
  {
    id: "Q2_LOW",
    conf: "CONF_50_65",
    sniper: "SNIPER_50_65",
    rr: "RR_1p00_1p20",
    score: "SCORE_50_65",
  },
  {
    id: "Q3_BASE",
    conf: "CONF_65_75",
    sniper: "SNIPER_65_75",
    rr: "RR_1p20_1p50",
    score: "SCORE_65_75",
  },
  {
    id: "Q4_STRONG",
    conf: "CONF_75_85",
    sniper: "SNIPER_75_85",
    rr: "RR_1p50_2p00",
    score: "SCORE_75_85",
  },
  {
    id: "Q5_ELITE",
    conf: "CONF_85_100",
    sniper: "SNIPER_85_100",
    rr: "RR_2p00_PLUS",
    score: "SCORE_85_100",
  },
];

const MARKET_TIERS = [
  {
    id: "M1_DIRTY",
    ob: "OB_REL_AGAINST",
    spread: "SPREAD_GT_25BPS",
    depth: "DEPTH_LT_10K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_CROWDED",
  },
  {
    id: "M2_WEAK",
    ob: "OB_REL_AGAINST_OR_NEUTRAL",
    spread: "SPREAD_16_25BPS",
    depth: "DEPTH_10K_50K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_EDGE_WEAK",
  },
  {
    id: "M3_NORMAL",
    ob: "OB_REL_NEUTRAL",
    spread: "SPREAD_8_16BPS",
    depth: "DEPTH_50K_100K",
    btc: "BTC_REL_NEUTRAL",
    funding: "FUNDING_NEUTRAL",
  },
  {
    id: "M4_CLEAN",
    ob: "OB_REL_WITH_OR_NEUTRAL",
    spread: "SPREAD_5_12BPS",
    depth: "DEPTH_100K_250K",
    btc: "BTC_REL_WITH_OR_NEUTRAL",
    funding: "FUNDING_OK",
  },
  {
    id: "M5_PREMIUM",
    ob: "OB_REL_WITH",
    spread: "SPREAD_LT_8BPS",
    depth: "DEPTH_GT_250K",
    btc: "BTC_REL_WITH",
    funding: "FUNDING_OPTIMAL",
  },
];

const TIMING_TIERS = {
  LONG: [
    {
      id: "T1_EARLY_OR_NOISY",
      stage: "STAGE_ANY",
      flow: "FLOW_ANY",
      rsi: "RSI_ANY",
      tf: "TF_ANY",
      pullback: "PULLBACK_NOT_REQUIRED",
    },
    {
      id: "T2_TIMED",
      stage: "STAGE_ENTRY_OR_ALMOST",
      flow: "FLOW_TREND_OR_BUILDING",
      rsi: "RSI_LOWER_OR_MID",
      tf: "TF_ALIGNED",
      pullback: "PULLBACK_OR_CONFIRMATION_OK",
    },
  ],
  SHORT: [
    {
      id: "T1_EARLY_OR_NOISY",
      stage: "STAGE_ANY",
      flow: "FLOW_ANY",
      rsi: "RSI_ANY",
      tf: "TF_ANY",
      pullback: "PULLBACK_NOT_REQUIRED",
    },
    {
      id: "T2_TIMED",
      stage: "STAGE_ENTRY_OR_ALMOST",
      flow: "FLOW_TREND_OR_BUILDING",
      rsi: "RSI_UPPER_OR_MID",
      tf: "TF_ALIGNED",
      pullback: "PULLBACK_OR_CONFIRMATION_OK",
    },
  ],
};

const OPEN_STATUSES = new Set([
  "OPEN",
  "ACTIVE",
  "RUNNING",
  "LIVE",
  "PENDING",
  "ENTRY",
  "IN_POSITION",
]);

const CLOSED_STATUSES = new Set([
  "CLOSED",
  "DONE",
  "EXITED",
  "TP",
  "SL",
  "STOPPED",
  "TAKE_PROFIT",
  "STOP_LOSS",
  "WIN",
  "LOSS",
  "BREAKEVEN",
]);

function round(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** decimals;
  return Math.round(n * m) / m;
}

function upper(value) {
  return String(value ?? "").trim().toUpperCase();
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function num(...values) {
  const value = firstDefined(...values);
  if (value === undefined) return 0;

  const cleaned = String(value)
    .replace("%", "")
    .replace(",", ".")
    .trim();

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function bool(value) {
  if (typeof value === "boolean") return value;
  const v = upper(value);
  if (["TRUE", "YES", "1", "Y", "OK"].includes(v)) return true;
  if (["FALSE", "NO", "0", "N"].includes(v)) return false;
  return false;
}

function normalizeScore(value) {
  const n = num(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n <= 1) return n * 100;
  return Math.max(0, Math.min(100, n));
}

function getSide(trade = {}) {
  const raw = upper(
    firstDefined(
      trade.side,
      trade.direction,
      trade.positionSide,
      trade.tradeSide,
      trade.signalSide,
      trade.setupSide
    )
  );

  if (raw.includes("SHORT") || raw === "SELL") return SIDE_SHORT;
  return SIDE_LONG;
}

function getStatus(trade = {}) {
  return upper(firstDefined(trade.status, trade.state, trade.tradeStatus, trade.resultStatus));
}

function hasClosedMarker(trade = {}) {
  const status = getStatus(trade);

  if (CLOSED_STATUSES.has(status)) return true;

  return Boolean(
    trade.exitTime ||
      trade.closedAt ||
      trade.closeTime ||
      trade.exitPrice ||
      trade.finalR !== undefined ||
      trade.realizedR !== undefined ||
      trade.resultR !== undefined ||
      trade.pnlPct !== undefined ||
      trade.pnlPercent !== undefined ||
      trade.netPnlPct !== undefined
  );
}

function isOpenTrade(trade = {}) {
  const status = getStatus(trade);
  if (hasClosedMarker(trade)) return false;
  if (OPEN_STATUSES.has(status)) return true;

  return Boolean(
    trade.entryPrice ||
      trade.openedAt ||
      trade.entryTime ||
      trade.currentR !== undefined ||
      trade.positionId
  );
}

function getRValue(trade = {}) {
  return num(
    trade.finalR,
    trade.realizedR,
    trade.resultR,
    trade.r,
    trade.R,
    trade.pnlR,
    trade.currentR
  );
}

function getPnlPct(trade = {}) {
  return num(
    trade.pnlPct,
    trade.pnlPercent,
    trade.netPnlPct,
    trade.realizedPnlPct,
    trade.roiPct,
    trade.profitPct
  );
}

function getMfeR(trade = {}) {
  return num(trade.mfeR, trade.maxFavorableR, trade.maxRunupR);
}

function getMaeR(trade = {}) {
  return num(trade.maeR, trade.maxAdverseR, trade.maxDrawdownR);
}

function getSpreadBps(trade = {}) {
  const bps = firstDefined(
    trade.spreadBps,
    trade.spread_bps,
    trade.marketSpreadBps,
    trade.orderbookSpreadBps
  );

  if (bps !== undefined) return num(bps);

  const pct = num(
    trade.spreadPct,
    trade.spreadPercent,
    trade.spread,
    trade.marketSpreadPct,
    trade.orderbookSpreadPct
  );

  if (!pct) return 0;

  if (Math.abs(pct) <= 0.02) return pct * 10000;
  return pct * 100;
}

function getDepthUsd(trade = {}) {
  return num(
    trade.depthUsd1p,
    trade.depthUsd1P,
    trade.depth1pUsd,
    trade.depth1PUsd,
    trade.depthUsd,
    trade.orderbookDepthUsd,
    trade.liquidityDepthUsd,
    trade.depth
  );
}

function getConfidence(trade = {}) {
  return normalizeScore(
    firstDefined(
      trade.confluence,
      trade.confluenceScore,
      trade.confidence,
      trade.conf,
      trade.setupConfluence
    )
  );
}

function getSniper(trade = {}) {
  return normalizeScore(
    firstDefined(
      trade.sniper,
      trade.sniperScore,
      trade.entrySniper,
      trade.sniperEntryScore
    )
  );
}

function getScore(trade = {}) {
  return normalizeScore(
    firstDefined(
      trade.score,
      trade.candidateScore,
      trade.externalScore,
      trade.setupScore,
      trade.totalScore
    )
  );
}

function getRR(trade = {}) {
  return num(
    trade.rr,
    trade.RR,
    trade.riskReward,
    trade.riskRewardRatio,
    trade.finalRR,
    trade.baseRR,
    trade.preTpRR
  );
}

function getFunding(trade = {}) {
  return num(
    trade.fundingRate,
    trade.funding,
    trade.fundingPct,
    trade.currentFundingRate
  );
}

function scoreToQualityIndex(score) {
  if (score < 50) return 1;
  if (score < 65) return 2;
  if (score < 75) return 3;
  if (score < 85) return 4;
  return 5;
}

function rrToQualityScore(rr) {
  if (rr < 1) return 30;
  if (rr < 1.2) return 57;
  if (rr < 1.5) return 70;
  if (rr < 2) return 80;
  return 92;
}

function getQualityIndex(trade = {}) {
  const confidence = getConfidence(trade);
  const sniper = getSniper(trade);
  const score = getScore(trade);
  const rr = getRR(trade);

  const composite = (
    confidence * 0.3 +
    sniper * 0.25 +
    score * 0.2 +
    rrToQualityScore(rr) * 0.25
  );

  return scoreToQualityIndex(composite);
}

function getObRelation(trade = {}, side = SIDE_LONG) {
  const raw = upper(
    firstDefined(
      trade.obRelation,
      trade.orderbookRelation,
      trade.orderbookAlignment,
      trade.obAlignment,
      trade.orderbookBias,
      trade.obBias,
      trade.orderbookSide
    )
  );

  if (!raw) return "NEUTRAL";

  const bullishWords = ["WITH", "BULL", "BUY", "BID", "LONG", "SUPPORT"];
  const bearishWords = ["AGAINST", "BEAR", "SELL", "ASK", "SHORT", "RESISTANCE"];

  const bullish = bullishWords.some((x) => raw.includes(x));
  const bearish = bearishWords.some((x) => raw.includes(x));

  if (raw.includes("NEUTRAL")) return "NEUTRAL";

  if (side === SIDE_LONG) {
    if (bullish) return "WITH";
    if (bearish) return "AGAINST";
  }

  if (side === SIDE_SHORT) {
    if (bearish) return "WITH";
    if (bullish) return "AGAINST";
  }

  return "NEUTRAL";
}

function getBtcRelation(trade = {}, side = SIDE_LONG) {
  const raw = upper(
    firstDefined(
      trade.btcRelation,
      trade.btcAlignment,
      trade.btcTrend,
      trade.btcState,
      trade.marketRegime,
      trade.btcBias
    )
  );

  if (!raw) return "NEUTRAL";
  if (raw.includes("NEUTRAL") || raw.includes("CHOP")) return "NEUTRAL";
  if (raw.includes("COUNTER") || raw.includes("AGAINST")) return "COUNTER";

  const bullish = raw.includes("BULL") || raw.includes("UP") || raw.includes("LONG");
  const bearish = raw.includes("BEAR") || raw.includes("DOWN") || raw.includes("SHORT");

  if (side === SIDE_LONG) {
    if (bullish) return "WITH";
    if (bearish) return "COUNTER";
  }

  if (side === SIDE_SHORT) {
    if (bearish) return "WITH";
    if (bullish) return "COUNTER";
  }

  return "NEUTRAL";
}

function getFundingBucketValue(trade = {}, side = SIDE_LONG) {
  const funding = getFunding(trade);
  const absFunding = Math.abs(funding);

  if (absFunding >= 0.08) return "CROWDED";
  if (absFunding >= 0.04) return "EDGE_WEAK";

  if (side === SIDE_LONG && funding <= 0) return "OPTIMAL";
  if (side === SIDE_SHORT && funding >= 0) return "OPTIMAL";

  if (absFunding <= 0.015) return "NEUTRAL";
  return "OK";
}

function getMarketIndex(trade = {}, side = SIDE_LONG) {
  const spreadBps = getSpreadBps(trade);
  const depthUsd = getDepthUsd(trade);
  const ob = getObRelation(trade, side);
  const btc = getBtcRelation(trade, side);
  const funding = getFundingBucketValue(trade, side);

  if (
    spreadBps > 25 ||
    depthUsd < 10000 ||
    (ob === "AGAINST" && btc === "COUNTER") ||
    funding === "CROWDED"
  ) {
    return 1;
  }

  if (
    spreadBps > 16 ||
    depthUsd < 50000 ||
    ob === "AGAINST" ||
    funding === "EDGE_WEAK"
  ) {
    return 2;
  }

  if (
    spreadBps <= 16 &&
    depthUsd >= 50000 &&
    depthUsd < 100000
  ) {
    return 3;
  }

  if (
    spreadBps <= 12 &&
    depthUsd >= 100000 &&
    depthUsd < 250000
  ) {
    return 4;
  }

  if (
    spreadBps <= 8 &&
    depthUsd >= 250000 &&
    ob === "WITH"
  ) {
    return 5;
  }

  return 3;
}

function getTimingIndex(trade = {}, side = SIDE_LONG) {
  const stage = upper(firstDefined(trade.stage, trade.setupStage, trade.entryStage));
  const flow = upper(firstDefined(trade.flow, trade.flowState, trade.marketFlow));
  const rsi = upper(firstDefined(trade.rsiZone, trade.rsiState, trade.rsiTiming));
  const tfAligned = bool(
    firstDefined(
      trade.tfAligned,
      trade.mtfAligned,
      trade.timeframeAligned,
      trade.trendAligned
    )
  );
  const pullbackOk = bool(
    firstDefined(
      trade.pullbackOk,
      trade.confirmationOk,
      trade.entryConfirmation,
      trade.hasPullback
    )
  );

  let points = 0;

  if (stage.includes("ENTRY") || stage.includes("ALMOST")) points += 2;
  if (flow.includes("TREND") || flow.includes("BUILDING")) points += 1;

  if (side === SIDE_LONG && (rsi.includes("LOWER") || rsi.includes("MID"))) points += 1;
  if (side === SIDE_SHORT && (rsi.includes("UPPER") || rsi.includes("MID"))) points += 1;

  if (tfAligned) points += 1;
  if (pullbackOk) points += 1;

  return points >= 3 ? 2 : 1;
}

function buildDefinition(side, index, qualityIndex, marketIndex, timingIndex) {
  const quality = QUALITY_TIERS[qualityIndex - 1];
  const market = MARKET_TIERS[marketIndex - 1];
  const timing = TIMING_TIERS[side][timingIndex - 1];

  const parts = [
    quality.id,
    market.id,
    timing.id,
    quality.conf,
    quality.sniper,
    quality.rr,
    quality.score,
    timing.stage,
    timing.flow,
    timing.rsi,
    market.ob,
    market.spread,
    market.depth,
    market.btc,
    market.funding,
    timing.tf,
    timing.pullback,
  ];

  return {
    id: `${side}_${index}`,
    side,
    index,
    qualityIndex,
    marketIndex,
    timingIndex,
    definition: parts.join(" | "),
    buckets: {
      qualityBucket: quality.id,
      marketBucket: market.id,
      timingBucket: timing.id,
      confidenceBucket: quality.conf,
      sniperBucket: quality.sniper,
      rrBucket: quality.rr,
      scoreBucket: quality.score,
      stageBucket: timing.stage,
      flowBucket: timing.flow,
      rsiBucket: timing.rsi,
      obRelationBucket: market.ob,
      spreadBucket: market.spread,
      depthBucket: market.depth,
      btcRelationBucket: market.btc,
      fundingBucket: market.funding,
      tfBucket: timing.tf,
      pullbackBucket: timing.pullback,
    },
  };
}

export function buildFamilyDefinitions(side = SIDE_LONG) {
  const normalizedSide = side === SIDE_SHORT ? SIDE_SHORT : SIDE_LONG;
  const definitions = [];
  let index = 1;

  for (let qualityIndex = 1; qualityIndex <= 5; qualityIndex += 1) {
    for (let marketIndex = 1; marketIndex <= 5; marketIndex += 1) {
      for (let timingIndex = 1; timingIndex <= 2; timingIndex += 1) {
        definitions.push(
          buildDefinition(normalizedSide, index, qualityIndex, marketIndex, timingIndex)
        );
        index += 1;
      }
    }
  }

  return definitions;
}

export function buildAllFamilyDefinitions() {
  return [
    ...buildFamilyDefinitions(SIDE_LONG),
    ...buildFamilyDefinitions(SIDE_SHORT),
  ];
}

function createEmptyFamily(definition, minClosed = 10) {
  return {
    ...definition,
    actions: 0,
    observed: 0,
    trades: 0,
    open: 0,
    closed: 0,
    wins: 0,
    losses: 0,
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
    minClosed,
    _mfeValues: [],
    _maeValues: [],
  };
}

export function classifyTradeFamily(trade = {}) {
  const side = getSide(trade);
  const qualityIndex = getQualityIndex(trade);
  const marketIndex = getMarketIndex(trade, side);
  const timingIndex = getTimingIndex(trade, side);

  const index = ((qualityIndex - 1) * 10) + ((marketIndex - 1) * 2) + timingIndex;

  return {
    side,
    id: `${side}_${index}`,
    index,
    qualityIndex,
    marketIndex,
    timingIndex,
  };
}

function getOutcome(trade = {}) {
  const status = getStatus(trade);
  const r = getRValue(trade);
  const pnlPct = getPnlPct(trade);

  if (status === "WIN" || status === "TP" || status === "TAKE_PROFIT") return "WIN";
  if (status === "LOSS" || status === "SL" || status === "STOP_LOSS" || status === "STOPPED") return "LOSS";

  if (r > 0) return "WIN";
  if (r < 0) return "LOSS";

  if (pnlPct > 0) return "WIN";
  if (pnlPct < 0) return "LOSS";

  return "FLAT";
}

function addTradeToFamily(family, trade = {}) {
  family.actions += 1;
  family.observed += 1;
  family.trades += 1;

  const closed = hasClosedMarker(trade);
  const open = isOpenTrade(trade);

  if (open) {
    family.open += 1;
  }

  if (!closed) return;

  family.closed += 1;

  const r = getRValue(trade);
  const pnlPct = getPnlPct(trade);
  const mfeR = getMfeR(trade);
  const maeR = getMaeR(trade);

  family.totalR += r;
  family.totalPnlPct += pnlPct;

  if (Number.isFinite(mfeR) && mfeR !== 0) family._mfeValues.push(mfeR);
  if (Number.isFinite(maeR) && maeR !== 0) family._maeValues.push(maeR);

  const outcome = getOutcome(trade);

  if (outcome === "WIN") family.wins += 1;
  if (outcome === "LOSS") family.losses += 1;

  if (outcome === "LOSS" && mfeR <= 0.15) {
    family.directSL += 1;
  }
}

export function finalizeFamilyStats(family, minClosed = 10) {
  const effectiveMinClosed = Math.max(1, Number(minClosed || 10));

  const completed = family.wins + family.losses;
  const closed = Number(family.closed || 0);
  const observed = Number(family.observed || 0);
  const open = Number(family.open || 0);

  family.totalR = round(family.totalR, 3);
  family.avgR = closed > 0 ? round(family.totalR / closed, 3) : 0;

  family.totalPnlPct = round(family.totalPnlPct, 3);
  family.avgPnlPct = closed > 0 ? round(family.totalPnlPct / closed, 3) : 0;

  family.winrateNum = completed > 0
    ? round(family.wins / completed, 4)
    : 0;

  family.winrate = completed > 0
    ? `${round(family.winrateNum * 100, 1)}%`
    : "0.0%";

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

  family.minClosed = effectiveMinClosed;

  if (observed === 0 && open === 0 && closed === 0) {
    family.status = "EMPTY";
    return family;
  }

  if (closed === 0) {
    family.status = "COLLECTING";
    return family;
  }

  if (closed < effectiveMinClosed) {
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

function buildFamilyMap(minClosed = 10) {
  const map = new Map();

  for (const definition of buildAllFamilyDefinitions()) {
    map.set(definition.id, createEmptyFamily(definition, minClosed));
  }

  return map;
}

function sortFamilies(families = []) {
  return [...families].sort((a, b) => {
    const statusRank = {
      HOT: 1,
      STABLE: 2,
      BAD: 3,
      COLLECTING: 4,
      EMPTY: 5,
    };

    const ar = statusRank[a.status] || 99;
    const br = statusRank[b.status] || 99;

    if (ar !== br) return ar - br;
    if (b.closed !== a.closed) return b.closed - a.closed;
    if (b.observed !== a.observed) return b.observed - a.observed;
    return a.index - b.index;
  });
}

function summarizeFamilies(families = []) {
  const summary = {
    actions: 0,
    trades: 0,
    observed: 0,
    open: 0,
    closed: 0,
    wins: 0,
    losses: 0,
    winrate: "0.0%",
    winrateNum: 0,
    totalR: 0,
    avgR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,
    longFamilies: 0,
    shortFamilies: 0,
    hotFamilies: 0,
    stableFamilies: 0,
    badFamilies: 0,
    collectingFamilies: 0,
    emptyFamilies: 0,
  };

  for (const family of families) {
    summary.actions += family.actions || 0;
    summary.trades += family.trades || 0;
    summary.observed += family.observed || 0;
    summary.open += family.open || 0;
    summary.closed += family.closed || 0;
    summary.wins += family.wins || 0;
    summary.losses += family.losses || 0;
    summary.totalR += family.totalR || 0;
    summary.totalPnlPct += family.totalPnlPct || 0;

    if (family.side === SIDE_LONG) summary.longFamilies += 1;
    if (family.side === SIDE_SHORT) summary.shortFamilies += 1;

    if (family.status === "HOT") summary.hotFamilies += 1;
    if (family.status === "STABLE") summary.stableFamilies += 1;
    if (family.status === "BAD") summary.badFamilies += 1;
    if (family.status === "COLLECTING") summary.collectingFamilies += 1;
    if (family.status === "EMPTY") summary.emptyFamilies += 1;
  }

  const completed = summary.wins + summary.losses;

  summary.totalR = round(summary.totalR, 3);
  summary.avgR = summary.closed > 0 ? round(summary.totalR / summary.closed, 3) : 0;

  summary.totalPnlPct = round(summary.totalPnlPct, 3);
  summary.avgPnlPct = summary.closed > 0
    ? round(summary.totalPnlPct / summary.closed, 3)
    : 0;

  summary.winrateNum = completed > 0
    ? round(summary.wins / completed, 4)
    : 0;

  summary.winrate = completed > 0
    ? `${round(summary.winrateNum * 100, 1)}%`
    : "0.0%";

  return summary;
}

function normalizeTradeRow(trade = {}) {
  const family = classifyTradeFamily(trade);

  return {
    id: firstDefined(trade.id, trade.tradeId, trade.positionId, trade.symbol, ""),
    symbol: firstDefined(trade.symbol, trade.market, trade.coin, ""),
    side: family.side,
    familyId: family.id,
    status: getStatus(trade) || (hasClosedMarker(trade) ? "CLOSED" : "OPEN"),
    closed: hasClosedMarker(trade),
    open: isOpenTrade(trade),
    r: round(getRValue(trade), 3),
    pnlPct: round(getPnlPct(trade), 3),
    confluence: round(getConfidence(trade), 2),
    sniper: round(getSniper(trade), 2),
    rr: round(getRR(trade), 3),
    score: round(getScore(trade), 2),
    spreadBps: round(getSpreadBps(trade), 2),
    depthUsd: round(getDepthUsd(trade), 0),
    createdAt: firstDefined(
      trade.createdAt,
      trade.timestamp,
      trade.time,
      trade.entryTime,
      trade.openedAt,
      ""
    ),
  };
}

export function buildAnalyzeReport(trades = [], options = {}) {
  const minClosed = Math.max(1, Number(options.minClosed || 10));
  const familyMap = buildFamilyMap(minClosed);
  const safeTrades = Array.isArray(trades) ? trades : [];

  for (const trade of safeTrades) {
    const classification = classifyTradeFamily(trade);
    const family = familyMap.get(classification.id);

    if (!family) continue;

    addTradeToFamily(family, trade);
  }

  const allFamilies = [...familyMap.values()].map((family) => (
    finalizeFamilyStats(family, minClosed)
  ));

  const long = sortFamilies(allFamilies.filter((family) => family.side === SIDE_LONG));
  const short = sortFamilies(allFamilies.filter((family) => family.side === SIDE_SHORT));
  const all = sortFamilies(allFamilies);

  const recentTrades = safeTrades
    .slice(-250)
    .reverse()
    .map(normalizeTradeRow);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
      totalFamilyCount: 100,
    },
    summary: summarizeFamilies(allFamilies),
    families: {
      all,
      long,
      short,
    },
    filterKeys: ANALYZE_FILTER_KEYS,
    trades: {
      total: safeTrades.length,
      items: recentTrades,
    },
  };
}

export const buildReport = buildAnalyzeReport;

export default {
  ANALYZE_FILTER_KEYS,
  buildFamilyDefinitions,
  buildAllFamilyDefinitions,
  classifyTradeFamily,
  finalizeFamilyStats,
  buildAnalyzeReport,
  buildReport,
};