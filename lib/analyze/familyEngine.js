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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstNumber(event, keys, fallback = 0) {
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => acc?.[part], event);
    const n = Number(value);

    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function firstString(event, keys, fallback = "") {
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => acc?.[part], event);

    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }

  return fallback;
}

function firstBoolean(event, keys, fallback = false) {
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => acc?.[part], event);

    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  }

  return fallback;
}

function round(value, decimals = 3) {
  const n = safeNumber(value, 0);
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function pct(value, decimals = 1) {
  return `${round(value, decimals)}%`;
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

function getConfluence(event) {
  return firstNumber(event, [
    "confluence",
    "confluenceScore",
    "setupConfluence",
    "scores.confluence",
    "quality.confluence",
  ], 0);
}

function getSniper(event) {
  return firstNumber(event, [
    "sniperScore",
    "sniper",
    "scores.sniper",
    "quality.sniper",
  ], 0);
}

function getRR(event) {
  return firstNumber(event, [
    "rr",
    "finalRR",
    "baseRR",
    "riskReward",
    "riskRewardRatio",
    "preTpRR",
    "geometryRR",
    "quality.rr",
  ], 0);
}

function getMoveScore(event) {
  return firstNumber(event, [
    "moveScore",
    "score",
    "tradeScore",
    "candidateScore",
    "externalScore",
    "scores.move",
    "quality.score",
  ], 0);
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

  const conf = confRaw > 0 ? confRaw : (scoreRaw > 0 ? scoreRaw : 55);
  const rr = rrRaw > 0 ? rrRaw : 1.1;
  const score = scoreRaw > 0 ? scoreRaw : conf;
  const sniper = sniperRaw > 0 ? sniperRaw : conf;

  const confBucket = bucketScore01To5(conf);
  const rrBucket = bucketRRTo5(rr);
  const scoreBucket = bucketScore01To5(score);
  const sniperBucket = bucketScore01To5(sniper);

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

function getSpreadBps(event) {
  const raw = firstNumber(event, [
    "spreadBps",
    "spread.bps",
    "market.spreadBps",
  ], NaN);

  if (Number.isFinite(raw)) return raw;

  const spreadPct = firstNumber(event, [
    "spreadPct",
    "spread",
    "market.spreadPct",
  ], 0);

  if (!spreadPct) return 12;

  const n = Math.abs(spreadPct);

  if (n <= 0.05) return n * 10000;
  if (n <= 10) return n * 100;

  return n;
}

function getDepthUsd1p(event) {
  return firstNumber(event, [
    "depthMinUsd1p",
    "depthUsd1p",
    "depth1p",
    "depthUsd",
    "market.depthMinUsd1p",
    "orderbook.depthMinUsd1p",
    "orderbook.depthUsd1p",
  ], 75000);
}

function getFundingRate(event) {
  return firstNumber(event, [
    "fundingRate",
    "funding",
    "market.fundingRate",
  ], 0);
}

function getObRelative(event, side) {
  const raw = normalizeText(firstString(event, [
    "obRel",
    "obRelative",
    "obBias",
    "orderbookBias",
    "orderbook.bias",
    "market.obBias",
  ], "NEUTRAL"));

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
  const raw = normalizeText(firstString(event, [
    "btcRelative",
    "btcRel",
    "btcState",
    "btc.state",
    "market.btcState",
  ], "NEUTRAL"));

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

function getStage(event) {
  const raw = String(firstString(event, [
    "stage",
    "scannerStage",
    "setupStage",
    "stageSource",
  ], "")).toLowerCase();

  if (raw.includes("entry")) return "ENTRY";
  if (raw.includes("almost")) return "ALMOST";

  return "OTHER";
}

function getFlow(event) {
  const raw = normalizeText(firstString(event, [
    "flow",
    "flowState",
    "marketFlow",
  ], "NEUTRAL"));

  if (raw.includes("TREND") || raw.includes("BREAKOUT") || raw.includes("RUNNING")) return "TREND";
  if (raw.includes("BUILDING") || raw.includes("BUILDUP")) return "BUILDING";

  return "NEUTRAL";
}

function isRsiTimed(event, side) {
  const zone = normalizeText(firstString(event, [
    "rsiZone",
    "rsi.zone",
    "rsiBucket",
  ], ""));

  if (zone) {
    if (zone.includes("MID")) return true;

    if (side === "LONG") {
      return zone.includes("LOWER") || zone.includes("OVERSOLD");
    }

    if (side === "SHORT") {
      return zone.includes("UPPER") || zone.includes("OVERBOUGHT");
    }
  }

  const rsi = firstNumber(event, [
    "rsi",
    "rsi.value",
    "rsi1h",
    "rsiHTF",
  ], NaN);

  if (!Number.isFinite(rsi)) return false;

  if (side === "LONG") return rsi <= 62;
  if (side === "SHORT") return rsi >= 38;

  return false;
}

function isTfAligned(event, side) {
  if (firstBoolean(event, ["tfAligned", "timeframeAligned", "mtfAligned"], false)) {
    return true;
  }

  const tfStrength = firstNumber(event, [
    "tfStrength",
    "timeframeStrength",
    "mtfStrength",
  ], 0);

  if (tfStrength >= 1) return true;

  const tfScore = firstNumber(event, [
    "tfScore",
    "timeframeScore",
    "mtfScore",
  ], 0);

  if (side === "LONG") return tfScore > 0;
  if (side === "SHORT") return tfScore < 0;

  return false;
}

function isPullbackOk(event) {
  if (firstBoolean(event, [
    "pullbackOk",
    "hasPullback",
    "confirmationOk",
    "entryConfirmationOk",
  ], false)) {
    return true;
  }

  const distanceFromHigh = firstNumber(event, [
    "distanceFromLocalHighPct",
    "pullbackFromHighPct",
  ], 0);

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

function familyIndex(q, m, t) {
  return ((q - 1) * 10) + ((m - 1) * 2) + t;
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
    wins: 0,
    losses: 0,

    winrate: "0%",
    winrateNum: 0,
    totalR: 0,
    avgR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,

    status: "EMPTY",
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

function classifyEvent(event) {
  const side = normalizeSide(
    event.side ??
      event.direction ??
      event.tradeSide
  );

  if (!side) return null;

  const q = qualityIndex(event);
  const m = marketIndex(event, side);
  const t = timingIndex(event, side);
  const index = familyIndex(q, m, t);

  return {
    side,
    qualityIndex: q,
    marketIndex: m,
    timingIndex: t,
    familyId: `${side}_${index}`,
  };
}

function isClosedEvent(event) {
  if (event.closed === true) return true;
  if (event.isClosed === true) return true;
  if (event.exitPrice !== undefined && event.exitPrice !== null) return true;
  if (event.closedAt || event.exitAt || event.exitTs) return true;

  const status = normalizeText(firstString(event, [
    "status",
    "action",
    "reason",
    "exitReason",
  ], ""));

  if (
    status.includes("CLOSED") ||
    status.includes("EXIT") ||
    status.includes("TP") ||
    status.includes("SL") ||
    status.includes("WIN") ||
    status.includes("LOSS") ||
    status.includes("STOP")
  ) {
    return true;
  }

  return false;
}

function getR(event) {
  const direct = firstNumber(event, [
    "r",
    "pnlR",
    "realizedR",
    "currentR",
    "resultR",
    "outcomeR",
  ], NaN);

  if (Number.isFinite(direct)) return direct;

  const pnlPct = getPnlPct(event);
  if (pnlPct !== 0) return pnlPct / 2.25;

  return 0;
}

function getPnlPct(event) {
  return firstNumber(event, [
    "pnlPct",
    "pnlPercent",
    "realizedPnlPct",
    "currentPnlPct",
    "unrealizedPnlPct",
    "resultPnlPct",
    "pnl",
  ], 0);
}

function isWinEvent(event) {
  const status = normalizeText(firstString(event, [
    "status",
    "action",
    "reason",
    "exitReason",
    "result",
    "outcome",
  ], ""));

  if (status.includes("WIN") || status.includes("TP") || status.includes("PROFIT")) {
    return true;
  }

  return getR(event) > 0 || getPnlPct(event) > 0;
}

function isLossEvent(event) {
  const status = normalizeText(firstString(event, [
    "status",
    "action",
    "reason",
    "exitReason",
    "result",
    "outcome",
  ], ""));

  if (status.includes("LOSS") || status.includes("SL") || status.includes("STOP")) {
    return true;
  }

  return getR(event) < 0 || getPnlPct(event) < 0;
}

function scoreFamilyStatus(family, minClosed) {
  if (family.observed <= 0) return "EMPTY";
  if (family.closed < minClosed) return "COLLECTING";

  if (family.winrateNum >= 65 && family.avgR >= 0.35) return "HOT";
  if (family.winrateNum >= 55 && family.avgR >= 0.15) return "GOOD";
  if (family.winrateNum >= 50 && family.avgR >= 0) return "STABLE";

  return "BAD";
}

function finalizeFamily(family, minClosed) {
  family.winrateNum = family.closed > 0
    ? round((family.wins / family.closed) * 100, 3)
    : 0;

  family.winrate = pct(family.winrateNum, family.winrateNum % 1 === 0 ? 0 : 1);

  family.totalR = round(family.totalR, 3);
  family.avgR = family.closed > 0 ? round(family.totalR / family.closed, 3) : 0;

  family.totalPnlPct = round(family.totalPnlPct, 3);
  family.avgPnlPct = family.closed > 0 ? round(family.totalPnlPct / family.closed, 3) : 0;

  family.status = scoreFamilyStatus(family, minClosed);

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

    const closedDiff = b.closed - a.closed;
    if (closedDiff !== 0) return closedDiff;

    const observedDiff = b.observed - a.observed;
    if (observedDiff !== 0) return observedDiff;

    const sideDiff = a.side.localeCompare(b.side);
    if (sideDiff !== 0) return sideDiff;

    return a.index - b.index;
  });
}

function buildSummary(families, events) {
  const closed = events.filter(isClosedEvent);
  const open = events.length - closed.length;
  const wins = closed.filter(isWinEvent).length;
  const losses = closed.filter(isLossEvent).length;

  const totalR = round(closed.reduce((sum, event) => sum + getR(event), 0), 3);
  const totalPnlPct = round(closed.reduce((sum, event) => sum + getPnlPct(event), 0), 3);

  const winrateNum = closed.length > 0 ? round((wins / closed.length) * 100, 3) : 0;

  return {
    actions: events.length,
    trades: events.length,
    observed: events.length,
    open,
    closed: closed.length,
    wins,
    losses,
    totalR,
    totalPnlPct,
    winrateNum,
    winrate: pct(winrateNum, winrateNum % 1 === 0 ? 0 : 1),
    avgR: closed.length > 0 ? round(totalR / closed.length, 3) : 0,
    avgPnlPct: closed.length > 0 ? round(totalPnlPct / closed.length, 3) : 0,

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

export function buildAnalyzeReport(events = [], options = {}) {
  const minClosed = safeNumber(options.minClosed, 10);
  const sourceEvents = safeArray(events).filter(event => event && typeof event === "object");

  const families = createAnalyzeFamilies();
  const byId = new Map(families.all.map(family => [family.id, family]));

  for (const event of sourceEvents) {
    const classification = classifyEvent(event);
    if (!classification) continue;

    const family = byId.get(classification.familyId);
    if (!family) continue;

    const closed = isClosedEvent(event);
    const r = getR(event);
    const pnlPct = getPnlPct(event);

    family.observed += 1;
    family.trades += 1;

    if (closed) {
      family.closed += 1;
      family.totalR += r;
      family.totalPnlPct += pnlPct;

      if (isWinEvent(event)) family.wins += 1;
      else if (isLossEvent(event)) family.losses += 1;
    } else {
      family.open += 1;
    }
  }

  const finalizedLong = families.long.map(family => finalizeFamily(family, minClosed));
  const finalizedShort = families.short.map(family => finalizeFamily(family, minClosed));
  const finalizedAll = [...finalizedLong, ...finalizedShort];
  const ranked = sortRankedFamilies(finalizedAll);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      minClosed,
      familyCountLong: FAMILY_COUNT_PER_SIDE,
      familyCountShort: FAMILY_COUNT_PER_SIDE,
      totalFamilyCount: FAMILY_COUNT_PER_SIDE * 2,
    },
    summary: buildSummary(finalizedAll, sourceEvents),
    families: {
      all: ranked,
      long: finalizedLong,
      short: finalizedShort,
      ranked,
    },
    filterValues: {
      qualityBuckets: QUALITY_BUCKETS,
      marketBuckets: MARKET_BUCKETS,
      timingBuckets: TIMING_BUCKETS,
      trackedFields: [
        "side",
        "stage",
        "flow",
        "confluence",
        "sniperScore",
        "rr",
        "moveScore",
        "rsi",
        "rsiZone",
        "obBias",
        "spreadPct",
        "depthMinUsd1p",
        "btcState",
        "fundingRate",
        "tfScore",
        "tfStrength",
        "pnlPct",
        "pnlR",
        "status",
        "exitReason",
      ],
    },
  };
}

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
  buildAnalyzeReport,
  buildFamilyReport,
  buildReport,
  analyzeEvents,
  createAnalyzeReport,
};