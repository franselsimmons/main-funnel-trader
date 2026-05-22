const MIN_CLOSED_DEFAULT = 10;

function n(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function s(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function upper(value) {
  return s(value).trim().toUpperCase();
}

function pct(value) {
  const num = n(value, 0);
  return `${num.toFixed(1)}%`;
}

function round(value, decimals = 3) {
  const num = n(value, 0);
  const p = 10 ** decimals;
  return Math.round(num * p) / p;
}

function firstNumber(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return 0;
}

function sideOf(trade) {
  const side = upper(
    trade?.side ||
      trade?.direction ||
      trade?.positionSide ||
      trade?.signalSide ||
      trade?.entrySide
  );

  if (side.includes("SHORT") || side === "SELL") return "SHORT";
  return "LONG";
}

function statusOf(trade) {
  return upper(trade?.status || trade?.state || trade?.result || trade?.outcome);
}

function isClosedTrade(trade) {
  const status = statusOf(trade);

  if (trade?.closed === true) return true;
  if (trade?.isClosed === true) return true;
  if (trade?.exitPrice || trade?.closedAt || trade?.exitTime) return true;

  return [
    "CLOSED",
    "TP",
    "SL",
    "STOP",
    "STOP_LOSS",
    "TAKE_PROFIT",
    "WIN",
    "LOSS",
    "BREAKEVEN",
    "BE",
    "EXITED",
    "DONE",
    "FINISHED",
  ].some((key) => status.includes(key));
}

function isOpenTrade(trade) {
  if (isClosedTrade(trade)) return false;

  const status = statusOf(trade);

  if (!status) return true;

  return [
    "OPEN",
    "LIVE",
    "ACTIVE",
    "RUNNING",
    "ENTRY",
    "PENDING",
    "MONITORING",
  ].some((key) => status.includes(key));
}

function getR(trade) {
  return firstNumber(
    trade?.r,
    trade?.R,
    trade?.realizedR,
    trade?.pnlR,
    trade?.resultR,
    trade?.exitR,
    trade?.finalR,
    trade?.rrResult,
    trade?.outcomeR,
    trade?.profitR,
    trade?.lossR
  );
}

function getPnlPct(trade) {
  return firstNumber(
    trade?.pnlPct,
    trade?.pnlPercent,
    trade?.realizedPnlPct,
    trade?.realizedPnlPercent,
    trade?.profitPct,
    trade?.profitPercent,
    trade?.netPnlPct,
    trade?.pnl_percentage
  );
}

function isWinTrade(trade) {
  const status = statusOf(trade);
  const r = getR(trade);
  const pnlPct = getPnlPct(trade);

  if (["WIN", "TP", "TAKE_PROFIT"].some((key) => status.includes(key))) return true;
  if (r > 0) return true;
  if (pnlPct > 0) return true;

  return false;
}

function isLossTrade(trade) {
  const status = statusOf(trade);
  const r = getR(trade);
  const pnlPct = getPnlPct(trade);

  if (["LOSS", "SL", "STOP"].some((key) => status.includes(key))) return true;
  if (r < 0) return true;
  if (pnlPct < 0) return true;

  return false;
}

function getConfluence(trade) {
  return firstNumber(
    trade?.confluence,
    trade?.confluenceScore,
    trade?.conf,
    trade?.confidence,
    trade?.setupConfluence,
    trade?.scores?.confluence
  );
}

function getSniper(trade) {
  return firstNumber(
    trade?.sniper,
    trade?.sniperScore,
    trade?.entryScore,
    trade?.scores?.sniper
  );
}

function getRR(trade) {
  return firstNumber(
    trade?.rr,
    trade?.RR,
    trade?.riskReward,
    trade?.riskRewardRatio,
    trade?.baseRR,
    trade?.finalRR,
    trade?.setupRR,
    trade?.geometryRR,
    trade?.scores?.rr
  );
}

function getScore(trade) {
  return firstNumber(
    trade?.score,
    trade?.candidateScore,
    trade?.externalScore,
    trade?.setupScore,
    trade?.scores?.total,
    trade?.scores?.score
  );
}

function getSpreadBps(trade) {
  const pct = firstNumber(
    trade?.spreadPct,
    trade?.spreadPercent,
    trade?.spread,
    trade?.market?.spreadPct,
    trade?.orderbook?.spreadPct
  );

  if (pct > 0 && pct < 1) return pct * 10000;
  if (pct >= 1 && pct <= 100) return pct * 100;

  return firstNumber(
    trade?.spreadBps,
    trade?.market?.spreadBps,
    trade?.orderbook?.spreadBps
  );
}

function getDepthUsd(trade) {
  return firstNumber(
    trade?.depthUsd1p,
    trade?.depthUsd,
    trade?.depth1p,
    trade?.minDepthUsd1p,
    trade?.market?.depthUsd1p,
    trade?.orderbook?.depthUsd1p,
    trade?.liquidity?.depthUsd1p
  );
}

function getFunding(trade) {
  return firstNumber(
    trade?.fundingRate,
    trade?.funding,
    trade?.market?.fundingRate,
    trade?.funding?.rate
  );
}

function getStage(trade) {
  return upper(trade?.stage || trade?.entryStage || trade?.setupStage);
}

function getFlow(trade) {
  return upper(trade?.flow || trade?.flowState || trade?.flowRegime || trade?.marketFlow);
}

function getRsiZone(trade) {
  return upper(
    trade?.rsiZone ||
      trade?.rsiState ||
      trade?.rsiBucket ||
      trade?.rsi?.zone ||
      trade?.rsi?.state
  );
}

function getObRelation(trade, side) {
  const raw = upper(
    trade?.obRelation ||
      trade?.orderbookRelation ||
      trade?.obAlignment ||
      trade?.orderbookAlignment ||
      trade?.ob?.relation ||
      trade?.orderbook?.alignment
  );

  if (raw.includes("AGAINST") || raw.includes("COUNTER")) return "AGAINST";
  if (raw.includes("WITH") || raw.includes("ALIGNED") || raw.includes("SUPPORT")) return "WITH";
  if (raw.includes("NEUTRAL")) return "NEUTRAL";

  const bias = upper(
    trade?.obBias ||
      trade?.orderbookBias ||
      trade?.obSide ||
      trade?.orderbook?.bias
  );

  if (!bias) return "NEUTRAL";

  if (side === "LONG") {
    if (bias.includes("BID") || bias.includes("LONG") || bias.includes("BUY")) return "WITH";
    if (bias.includes("ASK") || bias.includes("SHORT") || bias.includes("SELL")) return "AGAINST";
  }

  if (side === "SHORT") {
    if (bias.includes("ASK") || bias.includes("SHORT") || bias.includes("SELL")) return "WITH";
    if (bias.includes("BID") || bias.includes("LONG") || bias.includes("BUY")) return "AGAINST";
  }

  return "NEUTRAL";
}

function getBtcRelation(trade, side) {
  const raw = upper(
    trade?.btcRelation ||
      trade?.btcAlignment ||
      trade?.btcStateRelation ||
      trade?.btc?.relation ||
      trade?.btc?.alignment
  );

  if (raw.includes("COUNTER") || raw.includes("AGAINST")) return "COUNTER";
  if (raw.includes("WITH") || raw.includes("ALIGNED")) return "WITH";
  if (raw.includes("NEUTRAL")) return "NEUTRAL";

  const btcState = upper(trade?.btcState || trade?.btcRegime || trade?.btc?.state);

  if (!btcState) return "NEUTRAL";

  if (side === "LONG") {
    if (btcState.includes("BULL")) return "WITH";
    if (btcState.includes("BEAR")) return "COUNTER";
  }

  if (side === "SHORT") {
    if (btcState.includes("BEAR")) return "WITH";
    if (btcState.includes("BULL")) return "COUNTER";
  }

  return "NEUTRAL";
}

function getTfAligned(trade) {
  const raw = upper(
    trade?.tfAligned ||
      trade?.timeframeAligned ||
      trade?.mtfAligned ||
      trade?.tfState ||
      trade?.timeframeState
  );

  if (raw === "TRUE" || raw.includes("ALIGNED") || raw.includes("WITH")) return true;
  return false;
}

function qualityBucket(trade) {
  const conf = getConfluence(trade);
  const sniper = getSniper(trade);
  const rr = getRR(trade);
  const score = getScore(trade);

  const composite = Math.max(
    Math.min(conf, sniper, score || conf),
    rr >= 2 ? 85 : 0,
    rr >= 1.5 ? 75 : 0,
    rr >= 1.2 ? 65 : 0,
    rr >= 1 ? 50 : 0
  );

  if (composite >= 85 || rr >= 2) {
    return {
      index: 5,
      key: "Q5_ELITE",
      conf: "CONF_85_100",
      sniper: "SNIPER_85_100",
      rr: "RR_2p00_PLUS",
      score: "SCORE_85_100",
    };
  }

  if (composite >= 75 || rr >= 1.5) {
    return {
      index: 4,
      key: "Q4_STRONG",
      conf: "CONF_75_85",
      sniper: "SNIPER_75_85",
      rr: "RR_1p50_2p00",
      score: "SCORE_75_85",
    };
  }

  if (composite >= 65 || rr >= 1.2) {
    return {
      index: 3,
      key: "Q3_BASE",
      conf: "CONF_65_75",
      sniper: "SNIPER_65_75",
      rr: "RR_1p20_1p50",
      score: "SCORE_65_75",
    };
  }

  if (composite >= 50 || rr >= 1) {
    return {
      index: 2,
      key: "Q2_LOW",
      conf: "CONF_50_65",
      sniper: "SNIPER_50_65",
      rr: "RR_1p00_1p20",
      score: "SCORE_50_65",
    };
  }

  return {
    index: 1,
    key: "Q1_WEAK",
    conf: "CONF_0_50",
    sniper: "SNIPER_0_50",
    rr: "RR_LT_1p00",
    score: "SCORE_0_50",
  };
}

function marketBucket(trade, side) {
  const spread = getSpreadBps(trade);
  const depth = getDepthUsd(trade);
  const ob = getObRelation(trade, side);
  const btc = getBtcRelation(trade, side);
  const funding = getFunding(trade);

  if (ob === "WITH" && spread > 0 && spread < 8 && depth >= 250000 && btc === "WITH" && Math.abs(funding) <= 0.0003) {
    return {
      index: 5,
      key: "M5_PREMIUM",
      ob: "OB_REL_WITH",
      spread: "SPREAD_LT_8BPS",
      depth: "DEPTH_GT_250K",
      btc: "BTC_REL_WITH",
      funding: "FUNDING_OPTIMAL",
    };
  }

  if ((ob === "WITH" || ob === "NEUTRAL") && spread > 0 && spread <= 12 && depth >= 100000 && Math.abs(funding) <= 0.0006) {
    return {
      index: 4,
      key: "M4_CLEAN",
      ob: "OB_REL_WITH_OR_NEUTRAL",
      spread: "SPREAD_5_12BPS",
      depth: "DEPTH_100K_250K",
      btc: "BTC_REL_WITH_OR_NEUTRAL",
      funding: "FUNDING_OK",
    };
  }

  if (ob === "NEUTRAL" && spread > 0 && spread <= 16 && depth >= 50000) {
    return {
      index: 3,
      key: "M3_NORMAL",
      ob: "OB_REL_NEUTRAL",
      spread: "SPREAD_8_16BPS",
      depth: "DEPTH_50K_100K",
      btc: "BTC_REL_NEUTRAL",
      funding: "FUNDING_NEUTRAL",
    };
  }

  if ((ob === "AGAINST" || ob === "NEUTRAL") && spread > 0 && spread <= 25 && depth >= 10000) {
    return {
      index: 2,
      key: "M2_WEAK",
      ob: "OB_REL_AGAINST_OR_NEUTRAL",
      spread: "SPREAD_16_25BPS",
      depth: "DEPTH_10K_50K",
      btc: "BTC_REL_COUNTER",
      funding: "FUNDING_EDGE_WEAK",
    };
  }

  return {
    index: 1,
    key: "M1_DIRTY",
    ob: "OB_REL_AGAINST",
    spread: "SPREAD_GT_25BPS",
    depth: "DEPTH_LT_10K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_CROWDED",
  };
}

function timingBucket(trade, side) {
  const stage = getStage(trade);
  const flow = getFlow(trade);
  const rsi = getRsiZone(trade);
  const tfAligned = getTfAligned(trade);

  const stageOk =
    stage.includes("ENTRY") ||
    stage.includes("ALMOST") ||
    stage.includes("READY") ||
    stage.includes("CONFIRM");

  const flowOk =
    flow.includes("TREND") ||
    flow.includes("BUILDING") ||
    flow.includes("IMPULSE") ||
    flow.includes("CONTINUATION");

  const rsiOk =
    side === "LONG"
      ? rsi.includes("LOWER") || rsi.includes("MID") || rsi.includes("OVERSOLD")
      : rsi.includes("UPPER") || rsi.includes("MID") || rsi.includes("OVERBOUGHT");

  if (stageOk && flowOk && (rsiOk || !rsi) && tfAligned) {
    return {
      index: 2,
      key: "T2_TIMED",
      stage: "STAGE_ENTRY_OR_ALMOST",
      flow: "FLOW_TREND_OR_BUILDING",
      rsi: side === "LONG" ? "RSI_LOWER_OR_MID" : "RSI_UPPER_OR_MID",
      tf: "TF_ALIGNED",
      pullback: "PULLBACK_OR_CONFIRMATION_OK",
    };
  }

  return {
    index: 1,
    key: "T1_EARLY_OR_NOISY",
    stage: "STAGE_ANY",
    flow: "FLOW_ANY",
    rsi: "RSI_ANY",
    tf: "TF_ANY",
    pullback: "PULLBACK_NOT_REQUIRED",
  };
}

function familyIndex(qualityIndex, marketIndex, timingIndex) {
  return (qualityIndex - 1) * 10 + (marketIndex - 1) * 2 + timingIndex;
}

function buildDefinition(side, quality, market, timing) {
  return [
    quality.key,
    market.key,
    timing.key,
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
  ].join(" | ");
}

function buildFamily(side, qIndex, mIndex, tIndex) {
  const qualityTemplates = {
    1: {
      index: 1,
      key: "Q1_WEAK",
      conf: "CONF_0_50",
      sniper: "SNIPER_0_50",
      rr: "RR_LT_1p00",
      score: "SCORE_0_50",
    },
    2: {
      index: 2,
      key: "Q2_LOW",
      conf: "CONF_50_65",
      sniper: "SNIPER_50_65",
      rr: "RR_1p00_1p20",
      score: "SCORE_50_65",
    },
    3: {
      index: 3,
      key: "Q3_BASE",
      conf: "CONF_65_75",
      sniper: "SNIPER_65_75",
      rr: "RR_1p20_1p50",
      score: "SCORE_65_75",
    },
    4: {
      index: 4,
      key: "Q4_STRONG",
      conf: "CONF_75_85",
      sniper: "SNIPER_75_85",
      rr: "RR_1p50_2p00",
      score: "SCORE_75_85",
    },
    5: {
      index: 5,
      key: "Q5_ELITE",
      conf: "CONF_85_100",
      sniper: "SNIPER_85_100",
      rr: "RR_2p00_PLUS",
      score: "SCORE_85_100",
    },
  };

  const marketTemplates = {
    1: {
      index: 1,
      key: "M1_DIRTY",
      ob: "OB_REL_AGAINST",
      spread: "SPREAD_GT_25BPS",
      depth: "DEPTH_LT_10K",
      btc: "BTC_REL_COUNTER",
      funding: "FUNDING_CROWDED",
    },
    2: {
      index: 2,
      key: "M2_WEAK",
      ob: "OB_REL_AGAINST_OR_NEUTRAL",
      spread: "SPREAD_16_25BPS",
      depth: "DEPTH_10K_50K",
      btc: "BTC_REL_COUNTER",
      funding: "FUNDING_EDGE_WEAK",
    },
    3: {
      index: 3,
      key: "M3_NORMAL",
      ob: "OB_REL_NEUTRAL",
      spread: "SPREAD_8_16BPS",
      depth: "DEPTH_50K_100K",
      btc: "BTC_REL_NEUTRAL",
      funding: "FUNDING_NEUTRAL",
    },
    4: {
      index: 4,
      key: "M4_CLEAN",
      ob: "OB_REL_WITH_OR_NEUTRAL",
      spread: "SPREAD_5_12BPS",
      depth: "DEPTH_100K_250K",
      btc: "BTC_REL_WITH_OR_NEUTRAL",
      funding: "FUNDING_OK",
    },
    5: {
      index: 5,
      key: "M5_PREMIUM",
      ob: "OB_REL_WITH",
      spread: "SPREAD_LT_8BPS",
      depth: "DEPTH_GT_250K",
      btc: "BTC_REL_WITH",
      funding: "FUNDING_OPTIMAL",
    },
  };

  const timingTemplates = {
    1: {
      index: 1,
      key: "T1_EARLY_OR_NOISY",
      stage: "STAGE_ANY",
      flow: "FLOW_ANY",
      rsi: "RSI_ANY",
      tf: "TF_ANY",
      pullback: "PULLBACK_NOT_REQUIRED",
    },
    2: {
      index: 2,
      key: "T2_TIMED",
      stage: "STAGE_ENTRY_OR_ALMOST",
      flow: "FLOW_TREND_OR_BUILDING",
      rsi: side === "LONG" ? "RSI_LOWER_OR_MID" : "RSI_UPPER_OR_MID",
      tf: "TF_ALIGNED",
      pullback: "PULLBACK_OR_CONFIRMATION_OK",
    },
  };

  const index = familyIndex(qIndex, mIndex, tIndex);

  return {
    id: `${side}_${index}`,
    side,
    index,
    qualityIndex: qIndex,
    marketIndex: mIndex,
    timingIndex: tIndex,
    definition: buildDefinition(
      side,
      qualityTemplates[qIndex],
      marketTemplates[mIndex],
      timingTemplates[tIndex]
    ),
    qualityBucket: qualityTemplates[qIndex].key,
    marketBucket: marketTemplates[mIndex].key,
    timingBucket: timingTemplates[tIndex].key,
    actions: 0,
    trades: 0,
    observed: 0,
    open: 0,
    closed: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winrate: "0.0%",
    winrateNum: 0,
    totalR: 0,
    avgR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,
    openRate: "0.0%",
    status: "EMPTY",
    samples: [],
  };
}

function createFamiliesForSide(side) {
  const families = [];

  for (let q = 1; q <= 5; q += 1) {
    for (let m = 1; m <= 5; m += 1) {
      for (let t = 1; t <= 2; t += 1) {
        families.push(buildFamily(side, q, m, t));
      }
    }
  }

  return families;
}

function assignFamilyId(trade) {
  const side = sideOf(trade);
  const q = qualityBucket(trade);
  const m = marketBucket(trade, side);
  const t = timingBucket(trade, side);
  const index = familyIndex(q.index, m.index, t.index);

  return {
    side,
    familyId: `${side}_${index}`,
    quality: q,
    market: m,
    timing: t,
  };
}

function updateFamilyWithTrade(family, trade) {
  family.actions += 1;
  family.trades += 1;
  family.observed += 1;

  const closed = isClosedTrade(trade);
  const open = isOpenTrade(trade);

  if (open) family.open += 1;

  if (closed) {
    family.closed += 1;

    const r = getR(trade);
    const pnlPct = getPnlPct(trade);

    family.totalR += r;
    family.totalPnlPct += pnlPct;

    if (isWinTrade(trade)) family.wins += 1;
    else if (isLossTrade(trade)) family.losses += 1;
    else family.breakeven += 1;
  }

  if (family.samples.length < 25) {
    family.samples.push({
      id: uniqueTradeDisplayId(trade),
      symbol: trade?.symbol || trade?.pair || trade?.market || "",
      side: sideOf(trade),
      status: statusOf(trade) || (closed ? "CLOSED" : "OPEN"),
      r: getR(trade),
      pnlPct: getPnlPct(trade),
      rr: getRR(trade),
      confluence: getConfluence(trade),
      sniper: getSniper(trade),
      score: getScore(trade),
      createdAt: trade?.createdAt || trade?.timestamp || trade?.entryTime || trade?.openedAt || null,
      closedAt: trade?.closedAt || trade?.exitTime || null,
    });
  }
}

function uniqueTradeDisplayId(trade) {
  return (
    trade?.id ||
    trade?.tradeId ||
    trade?.positionId ||
    trade?.orderId ||
    trade?.symbol ||
    "unknown"
  );
}

function finalizeFamily(family, minClosed) {
  family.totalR = round(family.totalR, 3);
  family.avgR = family.closed > 0 ? round(family.totalR / family.closed, 3) : 0;

  family.totalPnlPct = round(family.totalPnlPct, 3);
  family.avgPnlPct =
    family.closed > 0 ? round(family.totalPnlPct / family.closed, 3) : 0;

  family.winrateNum =
    family.closed > 0 ? round((family.wins / family.closed) * 100, 1) : 0;

  family.winrate = pct(family.winrateNum);
  family.openRate =
    family.observed > 0 ? pct((family.open / family.observed) * 100) : "0.0%";

  if (family.observed <= 0) {
    family.status = "EMPTY";
    return family;
  }

  if (family.closed < minClosed) {
    family.status = "COLLECTING";
    return family;
  }

  if (family.winrateNum >= 55 && family.avgR > 0.15 && family.totalR > 0) {
    family.status = "HOT";
    return family;
  }

  if (family.winrateNum >= 50 && family.avgR >= 0) {
    family.status = "STABLE";
    return family;
  }

  if (family.winrateNum <= 42 || family.avgR < 0) {
    family.status = "BAD";
    return family;
  }

  family.status = "NEUTRAL";
  return family;
}

function makeSummary(families, trades) {
  const all = families;

  const actions = all.reduce((sum, f) => sum + f.actions, 0);
  const observed = all.reduce((sum, f) => sum + f.observed, 0);
  const open = all.reduce((sum, f) => sum + f.open, 0);
  const closed = all.reduce((sum, f) => sum + f.closed, 0);
  const wins = all.reduce((sum, f) => sum + f.wins, 0);
  const losses = all.reduce((sum, f) => sum + f.losses, 0);
  const totalR = round(all.reduce((sum, f) => sum + f.totalR, 0), 3);
  const totalPnlPct = round(all.reduce((sum, f) => sum + f.totalPnlPct, 0), 3);

  const longFamilies = all.filter((f) => f.side === "LONG").length;
  const shortFamilies = all.filter((f) => f.side === "SHORT").length;

  return {
    actions,
    trades: safeLen(trades),
    observed,
    open,
    closed,
    wins,
    losses,
    winrate: closed > 0 ? pct((wins / closed) * 100) : "0.0%",
    winrateNum: closed > 0 ? round((wins / closed) * 100, 1) : 0,
    totalR,
    avgR: closed > 0 ? round(totalR / closed, 3) : 0,
    totalPnlPct,
    avgPnlPct: closed > 0 ? round(totalPnlPct / closed, 3) : 0,
    longFamilies,
    shortFamilies,
    hotFamilies: all.filter((f) => f.status === "HOT").length,
    stableFamilies: all.filter((f) => f.status === "STABLE").length,
    badFamilies: all.filter((f) => f.status === "BAD").length,
    collectingFamilies: all.filter((f) => f.status === "COLLECTING").length,
    emptyFamilies: all.filter((f) => f.status === "EMPTY").length,
  };
}

function safeLen(value) {
  return Array.isArray(value) ? value.length : 0;
}

function sortFamilies(families) {
  const rank = {
    HOT: 1,
    STABLE: 2,
    NEUTRAL: 3,
    COLLECTING: 4,
    BAD: 5,
    EMPTY: 6,
  };

  return [...families].sort((a, b) => {
    const statusDiff = (rank[a.status] || 99) - (rank[b.status] || 99);
    if (statusDiff !== 0) return statusDiff;

    if (b.closed !== a.closed) return b.closed - a.closed;
    if (b.observed !== a.observed) return b.observed - a.observed;
    if (b.totalR !== a.totalR) return b.totalR - a.totalR;

    return a.index - b.index;
  });
}

function filterValues() {
  return {
    quality: [
      "Q1_WEAK",
      "Q2_LOW",
      "Q3_BASE",
      "Q4_STRONG",
      "Q5_ELITE",
    ],
    market: [
      "M1_DIRTY",
      "M2_WEAK",
      "M3_NORMAL",
      "M4_CLEAN",
      "M5_PREMIUM",
    ],
    timing: ["T1_EARLY_OR_NOISY", "T2_TIMED"],
    confluence: [
      "CONF_0_50",
      "CONF_50_65",
      "CONF_65_75",
      "CONF_75_85",
      "CONF_85_100",
    ],
    sniper: [
      "SNIPER_0_50",
      "SNIPER_50_65",
      "SNIPER_65_75",
      "SNIPER_75_85",
      "SNIPER_85_100",
    ],
    rr: [
      "RR_LT_1p00",
      "RR_1p00_1p20",
      "RR_1p20_1p50",
      "RR_1p50_2p00",
      "RR_2p00_PLUS",
    ],
    marketQuality: [
      "OB_REL_AGAINST",
      "OB_REL_AGAINST_OR_NEUTRAL",
      "OB_REL_NEUTRAL",
      "OB_REL_WITH_OR_NEUTRAL",
      "OB_REL_WITH",
      "SPREAD_GT_25BPS",
      "SPREAD_16_25BPS",
      "SPREAD_8_16BPS",
      "SPREAD_5_12BPS",
      "SPREAD_LT_8BPS",
      "DEPTH_LT_10K",
      "DEPTH_10K_50K",
      "DEPTH_50K_100K",
      "DEPTH_100K_250K",
      "DEPTH_GT_250K",
    ],
  };
}

export function buildFamilyReport(trades = [], options = {}) {
  const minClosed = Number.isFinite(Number(options.minClosed))
    ? Number(options.minClosed)
    : MIN_CLOSED_DEFAULT;

  const longFamilies = createFamiliesForSide("LONG");
  const shortFamilies = createFamiliesForSide("SHORT");
  const familyMap = new Map();

  for (const family of [...longFamilies, ...shortFamilies]) {
    familyMap.set(family.id, family);
  }

  for (const trade of trades) {
    if (!trade || typeof trade !== "object") continue;

    const assignment = assignFamilyId(trade);
    const family = familyMap.get(assignment.familyId);

    if (!family) continue;

    updateFamilyWithTrade(family, trade);
  }

  const finalized = [...familyMap.values()].map((family) =>
    finalizeFamily(family, minClosed)
  );

  const sortedAll = sortFamilies(finalized);
  const sortedLong = sortFamilies(finalized.filter((f) => f.side === "LONG"));
  const sortedShort = sortFamilies(finalized.filter((f) => f.side === "SHORT"));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
      totalFamilyCount: 100,
    },
    summary: makeSummary(finalized, trades),
    families: {
      all: sortedAll,
      long: sortedLong,
      short: sortedShort,
    },
    filterValues: filterValues(),
  };
}

export default {
  buildFamilyReport,
};