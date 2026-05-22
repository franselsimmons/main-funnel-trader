const DEFAULT_MIN_CLOSED = 10;
const FAMILY_COUNT_PER_SIDE = 50;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;

  if (typeof value === "string") {
    const cleaned = value.replace("%", "").replace(",", ".").trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstNumber(values, fallback = 0) {
  for (const value of values) {
    const n = safeNumber(value, NaN);
    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function firstString(values, fallback = "") {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const s = String(value).trim();
    if (s) return s;
  }

  return fallback;
}

function round(value, digits = 3) {
  const n = safeNumber(value, 0);
  const factor = 10 ** digits;
  const out = Math.round(n * factor) / factor;
  return Object.is(out, -0) ? 0 : out;
}

function pct(value, digits = 1) {
  return `${round(value, digits)}%`;
}

function normalizeSide(value) {
  const s = String(value || "").trim().toLowerCase();

  if (["long", "bull", "buy"].includes(s)) return "LONG";
  if (["short", "bear", "sell"].includes(s)) return "SHORT";

  return "";
}

function normalizeAction(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeLifecycle(event) {
  const e = safeObject(event);

  const status = normalizeAction(
    e.status ??
      e.tradeStatus ??
      e.lifecycle ??
      e.state ??
      e.result ??
      e.outcome ??
      e.reason
  );

  const action = normalizeAction(e.action ?? e.type ?? e.eventType);

  const closedWords = [
    "CLOSED",
    "CLOSE",
    "EXIT",
    "TP",
    "TAKE_PROFIT",
    "SL",
    "STOP_LOSS",
    "WIN",
    "LOSS",
    "LIQUIDATED",
    "EXPIRED",
  ];

  const openWords = [
    "OPEN",
    "ENTRY",
    "ENTER",
    "POSITION_OPEN",
    "LIVE",
    "ACTIVE",
    "PENDING",
  ];

  const terminal =
    Boolean(e.closedAt || e.exitTs || e.exitTime || e.exitPrice) ||
    closedWords.some((w) => status.includes(w)) ||
    closedWords.some((w) => action.includes(w));

  if (terminal) return "CLOSED";

  const open =
    Boolean(e.entry || e.entryPrice || e.openedAt || e.positionId) ||
    openWords.some((w) => status.includes(w)) ||
    openWords.some((w) => action.includes(w));

  return open ? "OPEN" : "OBSERVED";
}

function isWin(event) {
  const e = safeObject(event);
  const raw = normalizeAction(e.outcome ?? e.result ?? e.status ?? e.reason ?? e.action);

  if (["WIN", "TP", "TAKE_PROFIT", "PROFIT"].some((w) => raw.includes(w))) return true;

  const r = getRealizedR(e);
  const pnl = getRealizedPnlPct(e);

  return r > 0 || pnl > 0;
}

function isLoss(event) {
  const e = safeObject(event);
  const raw = normalizeAction(e.outcome ?? e.result ?? e.status ?? e.reason ?? e.action);

  if (["LOSS", "SL", "STOP_LOSS", "LIQUIDATED"].some((w) => raw.includes(w))) return true;

  const r = getRealizedR(e);
  const pnl = getRealizedPnlPct(e);

  return r < 0 || pnl < 0;
}

function getRealizedR(event) {
  const e = safeObject(event);

  return firstNumber(
    [
      e.realizedR,
      e.exitR,
      e.finalR,
      e.closedR,
      e.rMultiple,
      e.r,
      e.pnlR,
    ],
    0
  );
}

function getRealizedPnlPct(event) {
  const e = safeObject(event);

  return firstNumber(
    [
      e.realizedPnlPct,
      e.realizedPnLPct,
      e.closedPnlPct,
      e.exitPnlPct,
      e.pnlPct,
      e.pnlPercent,
      e.pnl,
    ],
    0
  );
}

function getRR(event) {
  const e = safeObject(event);

  return firstNumber(
    [
      e.rr,
      e.finalRR,
      e.baseRR,
      e.riskReward,
      e.riskRewardRatio,
      e.preTpRR,
    ],
    0
  );
}

function getConfluence(event) {
  const e = safeObject(event);

  return firstNumber(
    [
      e.confluence,
      e.confluenceScore,
      e.confidence,
      e.conf,
    ],
    0
  );
}

function getSniper(event) {
  const e = safeObject(event);

  return firstNumber(
    [
      e.sniperScore,
      e.sniper,
      e.entryScore,
      e.timingScore,
    ],
    0
  );
}

function getMoveScore(event) {
  const e = safeObject(event);

  return firstNumber(
    [
      e.moveScore,
      e.score,
      e.tradeScore,
      e.externalScore,
      e.candidateScore,
    ],
    0
  );
}

function getSpreadBps(event) {
  const e = safeObject(event);
  const raw = firstNumber([e.spreadBps, e.spreadBP, e.spread_bps], NaN);

  if (Number.isFinite(raw)) return raw;

  const spreadPct = firstNumber([e.spreadPct, e.spreadPercent, e.spread], 0);

  if (spreadPct <= 0) return 0;

  if (spreadPct <= 0.02) return spreadPct * 10_000;
  return spreadPct * 100;
}

function getDepth(event) {
  const e = safeObject(event);

  return firstNumber(
    [
      e.depthMinUsd1p,
      e.minDepthUsd1p,
      e.depthUsd1p,
      e.depthUsd,
      e.depth,
    ],
    0
  );
}

function getFunding(event) {
  const e = safeObject(event);

  return firstNumber(
    [
      e.fundingRate,
      e.funding,
      e.fundingPct,
      e.predictedFundingRate,
    ],
    0
  );
}

function getObRel(event, side) {
  const e = safeObject(event);
  const raw = String(
    e.obRel ??
      e.orderbookRelation ??
      e.obBias ??
      e.orderbookBias ??
      e.bookBias ??
      ""
  ).toUpperCase();

  if (raw.includes("WITH")) return "WITH";
  if (raw.includes("AGAINST")) return "AGAINST";
  if (raw.includes("NEUTRAL")) return "NEUTRAL";

  const bullish = ["BULL", "BUY", "BID", "LONG"];
  const bearish = ["BEAR", "SELL", "ASK", "SHORT"];

  const isBull = bullish.some((w) => raw.includes(w));
  const isBear = bearish.some((w) => raw.includes(w));

  if (!isBull && !isBear) return "NEUTRAL";

  if (side === "LONG") {
    if (isBull) return "WITH";
    if (isBear) return "AGAINST";
  }

  if (side === "SHORT") {
    if (isBear) return "WITH";
    if (isBull) return "AGAINST";
  }

  return "NEUTRAL";
}

function getBtcRel(event, side) {
  const e = safeObject(event);
  const raw = String(
    e.btcRel ??
      e.btcRelation ??
      e.btcState ??
      e.btcBias ??
      e.marketBtcState ??
      ""
  ).toUpperCase();

  if (raw.includes("WITH")) return "WITH";
  if (raw.includes("COUNTER")) return "COUNTER";
  if (raw.includes("AGAINST")) return "COUNTER";
  if (raw.includes("NEUTRAL")) return "NEUTRAL";

  const bullish = ["BULL", "UP", "LONG"];
  const bearish = ["BEAR", "DOWN", "SHORT"];

  const isBull = bullish.some((w) => raw.includes(w));
  const isBear = bearish.some((w) => raw.includes(w));

  if (!isBull && !isBear) return "NEUTRAL";

  if (side === "LONG") return isBull ? "WITH" : "COUNTER";
  if (side === "SHORT") return isBear ? "WITH" : "COUNTER";

  return "NEUTRAL";
}

function getStage(event) {
  const e = safeObject(event);

  return String(e.stage ?? e.scannerStage ?? e.setupStage ?? "")
    .trim()
    .toLowerCase();
}

function getFlow(event) {
  const e = safeObject(event);

  return String(e.flow ?? e.flowState ?? e.marketFlow ?? "NEUTRAL")
    .trim()
    .toUpperCase();
}

function getRsiBucket(event, side) {
  const e = safeObject(event);
  const raw = String(e.rsiZone ?? e.rsiBucket ?? e.rsiState ?? "").toUpperCase();
  const rsi = firstNumber([e.rsi, e.rsiValue], NaN);

  if (raw.includes("LOWER")) return side === "LONG" ? "OK" : "NOISY";
  if (raw.includes("UPPER")) return side === "SHORT" ? "OK" : "NOISY";
  if (raw.includes("MID")) return "OK";

  if (Number.isFinite(rsi)) {
    if (side === "LONG") return rsi <= 60 ? "OK" : "NOISY";
    if (side === "SHORT") return rsi >= 40 ? "OK" : "NOISY";
  }

  return "ANY";
}

function isTfAligned(event) {
  const e = safeObject(event);
  const raw = String(e.tfAligned ?? e.timeframeAligned ?? e.mtfAligned ?? e.tfState ?? "").toUpperCase();

  if (["TRUE", "1", "YES", "ALIGNED", "WITH"].includes(raw)) return true;

  const tfStrength = firstNumber([e.tfStrength, Math.abs(safeNumber(e.tfScore, 0))], 0);
  return tfStrength >= 1;
}

function qualityIndex(event) {
  const conf = getConfluence(event);
  const sniper = getSniper(event);
  const rr = getRR(event);
  const score = getMoveScore(event);

  const qConf =
    conf >= 85 ? 5 :
    conf >= 75 ? 4 :
    conf >= 65 ? 3 :
    conf >= 50 ? 2 :
    1;

  const qSniper =
    sniper >= 85 ? 5 :
    sniper >= 75 ? 4 :
    sniper >= 65 ? 3 :
    sniper >= 50 ? 2 :
    1;

  const qRr =
    rr >= 2 ? 5 :
    rr >= 1.5 ? 4 :
    rr >= 1.2 ? 3 :
    rr >= 1 ? 2 :
    1;

  const qScore =
    score >= 85 ? 5 :
    score >= 75 ? 4 :
    score >= 65 ? 3 :
    score >= 50 ? 2 :
    1;

  return Math.max(1, Math.min(qConf, qSniper, qRr, qScore));
}

function marketIndex(event, side) {
  const spreadBps = getSpreadBps(event);
  const depth = getDepth(event);
  const obRel = getObRel(event, side);
  const btcRel = getBtcRel(event, side);
  const funding = getFunding(event);

  const absFunding = Math.abs(funding);

  if (
    spreadBps > 25 ||
    depth < 10_000 ||
    obRel === "AGAINST" ||
    absFunding >= 0.001
  ) {
    return 1;
  }

  if (
    spreadBps > 16 ||
    depth < 50_000 ||
    btcRel === "COUNTER" ||
    absFunding >= 0.0006
  ) {
    return 2;
  }

  if (
    spreadBps >= 8 ||
    depth < 100_000 ||
    obRel === "NEUTRAL" ||
    btcRel === "NEUTRAL"
  ) {
    return 3;
  }

  if (
    spreadBps >= 5 ||
    depth < 250_000 ||
    obRel === "NEUTRAL" ||
    btcRel === "NEUTRAL"
  ) {
    return 4;
  }

  return 5;
}

function timingIndex(event, side) {
  const stage = getStage(event);
  const flow = getFlow(event);
  const rsi = getRsiBucket(event, side);

  const stageOk = ["entry", "almost"].includes(stage);
  const flowOk = ["TREND", "BUILDING", "BREAKOUT", "BUILDUP"].includes(flow);
  const rsiOk = ["OK", "ANY"].includes(rsi);
  const tfOk = isTfAligned(event);

  return stageOk && flowOk && rsiOk && tfOk ? 2 : 1;
}

const Q_DEFS = {
  1: {
    q: "Q1_WEAK",
    conf: "CONF_0_50",
    sniper: "SNIPER_0_50",
    rr: "RR_LT_1p00",
    score: "SCORE_0_50",
  },
  2: {
    q: "Q2_LOW",
    conf: "CONF_50_65",
    sniper: "SNIPER_50_65",
    rr: "RR_1p00_1p20",
    score: "SCORE_50_65",
  },
  3: {
    q: "Q3_BASE",
    conf: "CONF_65_75",
    sniper: "SNIPER_65_75",
    rr: "RR_1p20_1p50",
    score: "SCORE_65_75",
  },
  4: {
    q: "Q4_STRONG",
    conf: "CONF_75_85",
    sniper: "SNIPER_75_85",
    rr: "RR_1p50_2p00",
    score: "SCORE_75_85",
  },
  5: {
    q: "Q5_ELITE",
    conf: "CONF_85_100",
    sniper: "SNIPER_85_100",
    rr: "RR_2p00_PLUS",
    score: "SCORE_85_100",
  },
};

const M_DEFS = {
  1: {
    m: "M1_DIRTY",
    ob: "OB_REL_AGAINST",
    spread: "SPREAD_GT_25BPS",
    depth: "DEPTH_LT_10K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_CROWDED",
  },
  2: {
    m: "M2_WEAK",
    ob: "OB_REL_AGAINST_OR_NEUTRAL",
    spread: "SPREAD_16_25BPS",
    depth: "DEPTH_10K_50K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_EDGE_WEAK",
  },
  3: {
    m: "M3_NORMAL",
    ob: "OB_REL_NEUTRAL",
    spread: "SPREAD_8_16BPS",
    depth: "DEPTH_50K_100K",
    btc: "BTC_REL_NEUTRAL",
    funding: "FUNDING_NEUTRAL",
  },
  4: {
    m: "M4_CLEAN",
    ob: "OB_REL_WITH_OR_NEUTRAL",
    spread: "SPREAD_5_12BPS",
    depth: "DEPTH_100K_250K",
    btc: "BTC_REL_WITH_OR_NEUTRAL",
    funding: "FUNDING_OK",
  },
  5: {
    m: "M5_PREMIUM",
    ob: "OB_REL_WITH",
    spread: "SPREAD_LT_8BPS",
    depth: "DEPTH_GT_250K",
    btc: "BTC_REL_WITH",
    funding: "FUNDING_OPTIMAL",
  },
};

function timingDef(timing, side) {
  if (timing === 2) {
    return {
      t: "T2_TIMED",
      stage: "STAGE_ENTRY_OR_ALMOST",
      flow: "FLOW_TREND_OR_BUILDING",
      rsi: side === "SHORT" ? "RSI_UPPER_OR_MID" : "RSI_LOWER_OR_MID",
      tf: "TF_ALIGNED",
      pullback: "PULLBACK_OR_CONFIRMATION_OK",
    };
  }

  return {
    t: "T1_EARLY_OR_NOISY",
    stage: "STAGE_ANY",
    flow: "FLOW_ANY",
    rsi: "RSI_ANY",
    tf: "TF_ANY",
    pullback: "PULLBACK_NOT_REQUIRED",
  };
}

function buildDefinition(side, qIndex, mIndex, tIndex) {
  const q = Q_DEFS[qIndex];
  const m = M_DEFS[mIndex];
  const t = timingDef(tIndex, side);

  return [
    q.q,
    m.m,
    t.t,
    q.conf,
    q.sniper,
    q.rr,
    q.score,
    t.stage,
    t.flow,
    t.rsi,
    m.ob,
    m.spread,
    m.depth,
    m.btc,
    m.funding,
    t.tf,
    t.pullback,
  ].join(" | ");
}

function familyId(side, qIndex, mIndex, tIndex) {
  const index = (qIndex - 1) * 10 + (mIndex - 1) * 2 + tIndex;
  return `${side}_${index}`;
}

function buildFamiliesForSide(side) {
  const families = [];

  for (let q = 1; q <= 5; q += 1) {
    for (let m = 1; m <= 5; m += 1) {
      for (let t = 1; t <= 2; t += 1) {
        const index = (q - 1) * 10 + (m - 1) * 2 + t;

        families.push({
          id: familyId(side, q, m, t),
          side,
          index,
          qualityIndex: q,
          marketIndex: m,
          timingIndex: t,
          definition: buildDefinition(side, q, m, t),
          qualityBucket: Q_DEFS[q].q,
          marketBucket: M_DEFS[m].m,
          timingBucket: timingDef(t, side).t,

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
        });
      }
    }
  }

  return families;
}

function classifyFamily(event) {
  const side = normalizeSide(event.side ?? event.direction);

  if (!side) return null;

  const q = qualityIndex(event);
  const m = marketIndex(event, side);
  const t = timingIndex(event, side);

  return {
    side,
    id: familyId(side, q, m, t),
    q,
    m,
    t,
  };
}

function normalizeTradeEvent(event) {
  const e = safeObject(event);
  const side = normalizeSide(e.side ?? e.direction);
  const lifecycle = normalizeLifecycle(e);

  return {
    ...e,
    side,
    lifecycle,
    symbol: firstString([e.symbol, e.coin, e.ticker], ""),
    rr: getRR(e),
    confluence: getConfluence(e),
    sniperScore: getSniper(e),
    moveScore: getMoveScore(e),
    realizedR: lifecycle === "CLOSED" ? getRealizedR(e) : 0,
    realizedPnlPct: lifecycle === "CLOSED" ? getRealizedPnlPct(e) : 0,
  };
}

function isTradeLike(event) {
  const e = safeObject(event);
  const action = normalizeAction(e.action ?? e.type ?? e.eventType);
  const hasGeometry = e.entry || e.entryPrice || e.sl || e.stopLoss || e.tp || e.takeProfit;

  if (hasGeometry) return true;
  if (["OPEN", "ENTRY", "TRADE", "POSITION", "TP", "SL", "EXIT", "CLOSE"].some((w) => action.includes(w))) return true;

  return false;
}

function updateStatus(family, minClosed) {
  if (family.observed <= 0 && family.trades <= 0) {
    family.status = "EMPTY";
    return;
  }

  if (family.closed < minClosed) {
    family.status = "COLLECTING";
    return;
  }

  if (family.winrateNum >= 62 && family.totalR > 0 && family.totalPnlPct > 0) {
    family.status = "HOT";
    return;
  }

  if (family.winrateNum >= 55 && family.totalR > 0) {
    family.status = "GOOD";
    return;
  }

  if (family.winrateNum >= 45 && family.totalR >= 0) {
    family.status = "STABLE";
    return;
  }

  family.status = "BAD";
}

function finalizeFamily(family, minClosed) {
  family.totalR = round(family.totalR, 3);
  family.totalPnlPct = round(family.totalPnlPct, 3);

  family.winrateNum = family.closed > 0 ? round((family.wins / family.closed) * 100, 3) : 0;
  family.winrate = pct(family.winrateNum, 1);

  family.avgR = family.closed > 0 ? round(family.totalR / family.closed, 3) : 0;
  family.avgPnlPct = family.closed > 0 ? round(family.totalPnlPct / family.closed, 3) : 0;

  updateStatus(family, minClosed);

  return family;
}

function statusCounts(families) {
  return families.reduce(
    (acc, family) => {
      const key = `${String(family.status || "EMPTY").toLowerCase()}Families`;
      acc[key] = safeNumber(acc[key], 0) + 1;
      return acc;
    },
    {
      hotFamilies: 0,
      goodFamilies: 0,
      stableFamilies: 0,
      badFamilies: 0,
      collectingFamilies: 0,
      emptyFamilies: 0,
    }
  );
}

function buildSummary(families) {
  const summary = families.reduce(
    (acc, family) => {
      acc.actions += family.observed;
      acc.trades += family.trades;
      acc.observed += family.observed;
      acc.open += family.open;
      acc.closed += family.closed;
      acc.wins += family.wins;
      acc.losses += family.losses;
      acc.totalR += family.totalR;
      acc.totalPnlPct += family.totalPnlPct;
      return acc;
    },
    {
      actions: 0,
      trades: 0,
      observed: 0,
      open: 0,
      closed: 0,
      wins: 0,
      losses: 0,
      totalR: 0,
      totalPnlPct: 0,
    }
  );

  summary.winrateNum = summary.closed > 0 ? round((summary.wins / summary.closed) * 100, 3) : 0;
  summary.winrate = pct(summary.winrateNum, 1);
  summary.totalR = round(summary.totalR, 3);
  summary.avgR = summary.closed > 0 ? round(summary.totalR / summary.closed, 3) : 0;
  summary.totalPnlPct = round(summary.totalPnlPct, 3);
  summary.avgPnlPct = summary.closed > 0 ? round(summary.totalPnlPct / summary.closed, 3) : 0;

  const long = families.filter((f) => f.side === "LONG");
  const short = families.filter((f) => f.side === "SHORT");

  return {
    ...summary,
    longFamilies: long.length,
    shortFamilies: short.length,
    ...statusCounts(families),
  };
}

function extractFilterLabels(families) {
  const counts = new Map();

  for (const family of families) {
    const labels = String(family.definition || "")
      .split("|")
      .map((v) => v.trim())
      .filter(Boolean);

    for (const label of labels) {
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => {
      const diff = b.count - a.count;
      if (diff !== 0) return diff;
      return a.label.localeCompare(b.label);
    });
}

function sortFamilies(families) {
  return [...families].sort((a, b) => {
    const sideDiff = a.side.localeCompare(b.side);
    if (sideDiff !== 0) return sideDiff;

    return a.index - b.index;
  });
}

export function buildAnalyzeReport(events = [], options = {}) {
  const minClosed = Math.max(0, safeNumber(options.minClosed, DEFAULT_MIN_CLOSED));

  const familyMap = new Map();

  for (const family of [...buildFamiliesForSide("LONG"), ...buildFamiliesForSide("SHORT")]) {
    familyMap.set(family.id, family);
  }

  for (const rawEvent of safeArray(events)) {
    const event = normalizeTradeEvent(rawEvent);

    if (!event.side) continue;

    const classified = classifyFamily(event);
    if (!classified?.id) continue;

    const family = familyMap.get(classified.id);
    if (!family) continue;

    family.observed += 1;

    if (isTradeLike(event)) {
      family.trades += 1;
    }

    if (event.lifecycle === "CLOSED") {
      family.closed += 1;

      const won = isWin(event);
      const lost = isLoss(event);

      if (won) family.wins += 1;
      if (lost) family.losses += 1;

      family.totalR += event.realizedR;
      family.totalPnlPct += event.realizedPnlPct;

      continue;
    }

    if (event.lifecycle === "OPEN") {
      family.open += 1;
    }
  }

  const all = sortFamilies(Array.from(familyMap.values()).map((family) => finalizeFamily(family, minClosed)));
  const long = all.filter((family) => family.side === "LONG");
  const short = all.filter((family) => family.side === "SHORT");

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      minClosed,
      familyCountLong: FAMILY_COUNT_PER_SIDE,
      familyCountShort: FAMILY_COUNT_PER_SIDE,
      totalFamilyCount: FAMILY_COUNT_PER_SIDE * 2,
    },
    summary: buildSummary(all),
    families: {
      all,
      long,
      short,
    },
    filters: extractFilterLabels(all),
  };
}