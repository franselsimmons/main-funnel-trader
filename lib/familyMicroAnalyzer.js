// lib/mainFamilyMicroAnalyzer.js

// ================= MAIN FAMILY MICRO ANALYZER =================
//
// Doel:
// - MAIN analyzer niet meer alleen op 50 LONG + 50 SHORT parent families laten beslissen.
// - Goede parent families verder opsplitsen in subfamilies en microfamilies.
// - MAIN rankt primair op winrate/stabiliteit.
// - Outcome-data wordt NOOIT gebruikt in de family-key.
//
// Gebruik:
// import {
//   buildMainFamilyMicroAnalysis,
//   getBestMainLongShort,
//   isMainSignalAllowedByMicroFamily
// } from "../lib/mainFamilyMicroAnalyzer.js";

const DEFAULT_MIN_PARENT_CLOSED = 20;
const DEFAULT_MIN_SUB_CLOSED = 12;
const DEFAULT_MIN_MICRO_CLOSED = 8;

const STATUS_RANK = Object.freeze({
  ELITE: 6,
  HOT: 5,
  GOOD: 4,
  STABLE: 3,
  CANDIDATE: 2,
  COLLECTING: 1,
  EMPTY: 0,
  BAD: -1
});

// ================= BASIC HELPERS =================

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

function pct(value) {
  return `${round(safeNumber(value, 0) * 100, 1)}%`;
}

function normalizeUpper(value, fallback = "UNKNOWN") {
  const out = String(value || fallback).trim().toUpperCase();
  return out || fallback;
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase();

  if (s === "long" || s === "bull") return "LONG";
  if (s === "short" || s === "bear") return "SHORT";

  return "UNKNOWN";
}

function getFirstFinite(row, keys, fallback = 0) {
  for (const key of keys) {
    const n = Number(row?.[key]);
    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function normalizeSpreadPct(value) {
  let spread = safeNumber(value, 0);

  if (spread < 0) return 0;

  // Soms komt spread als procent binnen: 0.12 = 0.12%.
  // Intern willen we ratio: 0.0012.
  if (spread > 0.05) spread = spread / 100;

  return spread;
}

function getSpreadBps(row) {
  const explicit = Number(row?.spreadBps);
  if (Number.isFinite(explicit)) return explicit;

  return normalizeSpreadPct(row?.spreadPct) * 10000;
}

function getRowTimestamp(row) {
  return safeNumber(
    row?.entryTs ||
      row?.openedAt ||
      row?.createdAt ||
      row?.ts ||
      row?.closedAt ||
      row?.exitedAt,
    Date.now()
  );
}

// ================= OUTCOME HELPERS =================

function isClosedRow(row) {
  if (!row) return false;

  if (row.closed === true) return true;
  if (row.isClosed === true) return true;
  if (row.closedAt || row.exitedAt || row.completedAt) return true;

  const status = normalizeUpper(row.status || row.outcomeStatus || "");
  const exitReason = normalizeUpper(row.exitReason || row.reason || "");

  if (
    [
      "CLOSED",
      "EXIT",
      "TP",
      "SL",
      "BE",
      "BE_SL",
      "TRAIL_SL",
      "WIN",
      "LOSS",
      "BREAKEVEN"
    ].includes(status)
  ) {
    return true;
  }

  if (
    [
      "TP",
      "SL",
      "BE",
      "BE_SL",
      "TRAIL_SL",
      "WIN",
      "LOSS",
      "BREAKEVEN"
    ].includes(exitReason)
  ) {
    return true;
  }

  return Number.isFinite(
    Number(
      row.resultR ??
        row.outcomeR ??
        row.realizedR ??
        row.pnlR ??
        row.exitR ??
        row.pnlPct
    )
  );
}

function getOutcomeR(row) {
  const explicit = getFirstFinite(
    row,
    ["resultR", "outcomeR", "realizedR", "pnlR", "exitR"],
    null
  );

  if (Number.isFinite(explicit)) return explicit;

  const result = normalizeUpper(row?.result || row?.outcome || row?.exitReason || "");

  if (result === "WIN" || result === "TP") return 1;
  if (result === "LOSS" || result === "SL" || result === "TRAIL_SL") return -1;
  if (result === "BE" || result === "BE_SL" || result === "BREAKEVEN") return 0;

  return 0;
}

function getPnlPct(row) {
  return getFirstFinite(row, ["pnlPct", "pnlPercentage", "pnl", "totalPnlPct"], 0);
}

function classifyOutcome(row) {
  const result = normalizeUpper(row?.result || row?.outcome || row?.exitReason || "");
  const r = getOutcomeR(row);
  const pnlPct = getPnlPct(row);

  if (result === "WIN" || result === "TP") return "WIN";
  if (result === "LOSS" || result === "SL" || result === "TRAIL_SL") return "LOSS";
  if (result === "BE" || result === "BE_SL" || result === "BREAKEVEN") return "BREAKEVEN";

  if (r > 0) return "WIN";
  if (r < 0) return "LOSS";

  if (pnlPct > 0) return "WIN";
  if (pnlPct < 0) return "LOSS";

  return "BREAKEVEN";
}

// ================= ENTRY-KNOWN BUCKETS =================

function bucketFineRange(value, buckets, prefix) {
  const v = safeNumber(value, 0);

  for (const bucket of buckets) {
    if (v >= bucket.min && v < bucket.max) {
      return `${prefix}_${bucket.label}`;
    }
  }

  return `${prefix}_UNKNOWN`;
}

function bucketConfluence(row) {
  const v = getFirstFinite(row, ["confluence"], 0);

  return bucketFineRange(
    v,
    [
      { min: 0, max: 50, label: "0_50" },
      { min: 50, max: 55, label: "50_55" },
      { min: 55, max: 60, label: "55_60" },
      { min: 60, max: 65, label: "60_65" },
      { min: 65, max: 70, label: "65_70" },
      { min: 70, max: 75, label: "70_75" },
      { min: 75, max: 80, label: "75_80" },
      { min: 80, max: 85, label: "80_85" },
      { min: 85, max: 90, label: "85_90" },
      { min: 90, max: 95, label: "90_95" },
      { min: 95, max: 101, label: "95_100" }
    ],
    "CONF"
  );
}

function bucketSniper(row) {
  const v = getFirstFinite(row, ["sniperScore", "sniper", "sniperValue"], 0);

  return bucketFineRange(
    v,
    [
      { min: 0, max: 50, label: "0_50" },
      { min: 50, max: 55, label: "50_55" },
      { min: 55, max: 60, label: "55_60" },
      { min: 60, max: 65, label: "60_65" },
      { min: 65, max: 70, label: "65_70" },
      { min: 70, max: 75, label: "70_75" },
      { min: 75, max: 80, label: "75_80" },
      { min: 80, max: 85, label: "80_85" },
      { min: 85, max: 90, label: "85_90" },
      { min: 90, max: 95, label: "90_95" },
      { min: 95, max: 101, label: "95_100" }
    ],
    "SNIPER"
  );
}

function bucketScore(row) {
  const v = getFirstFinite(row, ["moveScore", "score"], 0);

  return bucketFineRange(
    v,
    [
      { min: 0, max: 50, label: "0_50" },
      { min: 50, max: 55, label: "50_55" },
      { min: 55, max: 60, label: "55_60" },
      { min: 60, max: 65, label: "60_65" },
      { min: 65, max: 70, label: "65_70" },
      { min: 70, max: 75, label: "70_75" },
      { min: 75, max: 80, label: "75_80" },
      { min: 80, max: 85, label: "80_85" },
      { min: 85, max: 90, label: "85_90" },
      { min: 90, max: 95, label: "90_95" },
      { min: 95, max: 101, label: "95_100" }
    ],
    "SCORE"
  );
}

function bucketRR(row) {
  const rr = getFirstFinite(row, ["plannedRR", "rr", "baseRR"], 0);

  if (rr <= 0) return "RR_UNKNOWN";
  if (rr < 1.0) return "RR_LT_1p00";
  if (rr < 1.1) return "RR_1p00_1p10";
  if (rr < 1.2) return "RR_1p10_1p20";
  if (rr < 1.3) return "RR_1p20_1p30";
  if (rr < 1.5) return "RR_1p30_1p50";
  if (rr < 1.75) return "RR_1p50_1p75";
  if (rr < 2.0) return "RR_1p75_2p00";

  return "RR_2p00_PLUS";
}

function bucketRsi(row) {
  const zone = normalizeUpper(row?.rsiZone || row?.rsiBucket || "");

  if (
    [
      "UPPER_3",
      "UPPER_2",
      "UPPER_1",
      "LOWER_3",
      "LOWER_2",
      "LOWER_1",
      "MID"
    ].includes(zone)
  ) {
    return `RSI_${zone}`;
  }

  const rsi = getFirstFinite(row, ["rsi", "rsiValue"], 50);

  if (rsi >= 82) return "RSI_UPPER_3";
  if (rsi >= 72) return "RSI_UPPER_2";
  if (rsi >= 62) return "RSI_UPPER_1";
  if (rsi > 52) return "RSI_MID_HIGH";
  if (rsi >= 48) return "RSI_MID";
  if (rsi >= 38) return "RSI_MID_LOW";
  if (rsi >= 28) return "RSI_LOWER_1";
  if (rsi >= 18) return "RSI_LOWER_2";

  return "RSI_LOWER_3";
}

function bucketSpread(row) {
  const bps = getSpreadBps(row);

  if (bps <= 0) return "SPREAD_UNKNOWN";
  if (bps < 5) return "SPREAD_LT_5BPS";
  if (bps < 8) return "SPREAD_5_8BPS";
  if (bps < 10) return "SPREAD_8_10BPS";
  if (bps < 12) return "SPREAD_10_12BPS";
  if (bps < 16) return "SPREAD_12_16BPS";
  if (bps < 20) return "SPREAD_16_20BPS";
  if (bps < 25) return "SPREAD_20_25BPS";

  return "SPREAD_GT_25BPS";
}

function bucketDepth(row) {
  const depth = getFirstFinite(row, ["depthMinUsd1p", "depthUsd", "depth"], 0);

  if (depth <= 0) return "DEPTH_UNKNOWN";
  if (depth < 10000) return "DEPTH_LT_10K";
  if (depth < 25000) return "DEPTH_10K_25K";
  if (depth < 50000) return "DEPTH_25K_50K";
  if (depth < 75000) return "DEPTH_50K_75K";
  if (depth < 100000) return "DEPTH_75K_100K";
  if (depth < 150000) return "DEPTH_100K_150K";
  if (depth < 250000) return "DEPTH_150K_250K";

  return "DEPTH_GT_250K";
}

function bucketFunding(row) {
  const f = getFirstFinite(row, ["fundingRate", "funding", "fundingRatePct"], 0);

  if (f <= -0.015) return "FUNDING_SHORT_CROWDED";
  if (f < -0.006) return "FUNDING_SHORT_EDGE";
  if (f <= 0.006) return "FUNDING_NEUTRAL";
  if (f < 0.015) return "FUNDING_LONG_EDGE";

  return "FUNDING_LONG_CROWDED";
}

function bucketBtc(row) {
  const state = normalizeUpper(row?.btcState || row?.btc || row?.btcRegime || "");

  if (
    [
      "STRONG_BULL",
      "STRONG_BEAR",
      "RUNNER_BULL",
      "RUNNER_BEAR",
      "BULLISH",
      "BEARISH",
      "NEUTRAL",
      "CHOPPY"
    ].includes(state)
  ) {
    return `BTC_${state}`;
  }

  return "BTC_UNKNOWN";
}

function bucketOb(row) {
  const bias = normalizeUpper(row?.obBias || row?.orderbookBias || "");

  if (bias === "BULLISH") return "OB_BULLISH";
  if (bias === "BEARISH") return "OB_BEARISH";
  if (bias === "NEUTRAL") return "OB_NEUTRAL";

  return "OB_UNKNOWN";
}

function bucketTf(row) {
  const strength = getFirstFinite(row, ["tfStrength"], null);
  const score = getFirstFinite(row, ["tfScore"], 0);
  const value = Number.isFinite(strength) ? strength : Math.abs(score);

  if (value < 1) return "TF_WEAK";
  if (value < 2) return "TF_OK";
  if (value < 4) return "TF_STRONG";

  return "TF_EXTREME";
}

function bucketSession(row) {
  const hour = new Date(getRowTimestamp(row)).getUTCHours();

  if (hour >= 0 && hour < 7) return "SESSION_ASIA";
  if (hour >= 7 && hour < 13) return "SESSION_EU";
  if (hour >= 13 && hour < 20) return "SESSION_US";

  return "SESSION_LATE_US";
}

function normalizeFlow(row) {
  return normalizeUpper(row?.flow || row?.scannerFlow || "UNKNOWN");
}

function normalizeStage(row) {
  return normalizeUpper(row?.stage || "UNKNOWN");
}

// ================= KEY BUILDERS =================

export function getMainParentFamilyKey(row) {
  const direct =
    row?.familyId ||
    row?.family ||
    row?.frozenFamilyId ||
    row?.entryFamilyId;

  if (direct) return normalizeUpper(direct);

  const side = normalizeSide(row?.side);
  const quality = normalizeUpper(row?.quality || row?.qualityBucket || "Q_UNKNOWN");
  const market = normalizeUpper(row?.market || row?.marketBucket || "M_UNKNOWN");
  const timing = normalizeUpper(row?.timing || row?.timingBucket || "T_UNKNOWN");

  return `${side}_${quality}_${market}_${timing}`;
}

export function getMainFamilyLabels(row) {
  return {
    side: normalizeSide(row?.side),
    parentFamily: getMainParentFamilyKey(row),

    confluence: bucketConfluence(row),
    sniper: bucketSniper(row),
    score: bucketScore(row),
    rr: bucketRR(row),

    flow: `FLOW_${normalizeFlow(row)}`,
    stage: `STAGE_${normalizeStage(row)}`,

    rsi: bucketRsi(row),
    ob: bucketOb(row),
    spread: bucketSpread(row),
    depth: bucketDepth(row),
    btc: bucketBtc(row),
    funding: bucketFunding(row),
    tf: bucketTf(row),
    session: bucketSession(row)
  };
}

export function buildMainSubFamilyKey(row) {
  const l = getMainFamilyLabels(row);

  return [
    l.parentFamily,
    l.flow,
    l.stage,
    l.rsi,
    l.ob,
    l.btc,
    l.funding,
    l.tf
  ].join(" | ");
}

export function buildMainMicroFamilyKey(row) {
  const l = getMainFamilyLabels(row);

  return [
    l.parentFamily,
    l.confluence,
    l.sniper,
    l.score,
    l.rr,
    l.flow,
    l.stage,
    l.rsi,
    l.ob,
    l.spread,
    l.depth,
    l.btc,
    l.funding,
    l.tf,
    l.session
  ].join(" | ");
}

export function getMainFamilyKeysForRow(row) {
  return {
    parent: getMainParentFamilyKey(row),
    sub: buildMainSubFamilyKey(row),
    micro: buildMainMicroFamilyKey(row),
    labels: getMainFamilyLabels(row)
  };
}

// ================= AGGREGATION =================

function createAgg(key, type, row) {
  const labels = getMainFamilyLabels(row);

  return {
    key,
    type,

    side: labels.side,
    parentFamily: labels.parentFamily,
    definition: key,
    labels,

    observed: 0,
    trades: 0,
    closed: 0,
    open: 0,
    pending: 0,

    wins: 0,
    losses: 0,
    breakeven: 0,

    winrate: "0.0%",
    winrateNum: 0,

    decisiveWinrate: "0.0%",
    decisiveWinrateNum: 0,

    nonLossRate: "0.0%",
    nonLossRateNum: 0,

    totalR: 0,
    avgR: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    grossWinR: 0,
    grossLossR: 0,
    profitFactor: 0,

    status: "EMPTY",

    examples: []
  };
}

function updateAgg(agg, row) {
  agg.observed += 1;
  agg.trades += 1;

  if (!isClosedRow(row)) {
    agg.open += 1;
    agg.pending += 1;
    return agg;
  }

  const r = getOutcomeR(row);
  const pnlPct = getPnlPct(row);
  const outcome = classifyOutcome(row);

  agg.closed += 1;
  agg.totalR += r;
  agg.totalPnlPct += pnlPct;

  if (outcome === "WIN") {
    agg.wins += 1;
    agg.grossWinR += Math.max(r, 0);
  } else if (outcome === "LOSS") {
    agg.losses += 1;
    agg.grossLossR += Math.abs(Math.min(r, 0));
  } else {
    agg.breakeven += 1;
  }

  if (agg.examples.length < 8) {
    agg.examples.push({
      symbol: row?.symbol || row?.baseSymbol || null,
      side: row?.side || null,
      parentFamily: getMainParentFamilyKey(row),
      result: outcome,
      r: round(r, 3),
      pnlPct: round(pnlPct, 3),
      exitReason: row?.exitReason || null,
      ts: getRowTimestamp(row)
    });
  }

  return agg;
}

function classifyMainStatus(agg, minClosed) {
  const closed = safeNumber(agg.closed, 0);
  const winrate = safeNumber(agg.winrateNum, 0);
  const decisiveWinrate = safeNumber(agg.decisiveWinrateNum, 0);
  const nonLossRate = safeNumber(agg.nonLossRateNum, 0);
  const avgR = safeNumber(agg.avgR, 0);
  const pf = safeNumber(agg.profitFactor, 0);

  if (!agg.observed) return "EMPTY";
  if (closed < minClosed) return "COLLECTING";

  if (
    closed >= 80 &&
    winrate >= 0.60 &&
    decisiveWinrate >= 0.68 &&
    avgR >= 0.20 &&
    pf >= 1.80
  ) {
    return "ELITE";
  }

  if (
    closed >= 50 &&
    winrate >= 0.56 &&
    decisiveWinrate >= 0.63 &&
    avgR >= 0.15 &&
    pf >= 1.50
  ) {
    return "HOT";
  }

  if (
    closed >= 25 &&
    winrate >= 0.52 &&
    decisiveWinrate >= 0.58 &&
    nonLossRate >= 0.64 &&
    avgR >= 0.08 &&
    pf >= 1.25
  ) {
    return "GOOD";
  }

  if (
    closed >= minClosed &&
    winrate >= 0.50 &&
    avgR >= 0 &&
    pf >= 1.05
  ) {
    return "STABLE";
  }

  if (avgR < 0 || pf < 0.95) return "BAD";

  return "CANDIDATE";
}

function finalizeAgg(agg, minClosed) {
  const closed = safeNumber(agg.closed, 0);
  const decisive = safeNumber(agg.wins + agg.losses, 0);

  agg.totalR = round(agg.totalR, 3);
  agg.totalPnlPct = round(agg.totalPnlPct, 3);

  agg.avgR = closed ? round(agg.totalR / closed, 3) : 0;
  agg.avgPnlPct = closed ? round(agg.totalPnlPct / closed, 3) : 0;

  agg.winrateNum = closed ? round(agg.wins / closed, 4) : 0;
  agg.winrate = pct(agg.winrateNum);

  agg.decisiveWinrateNum = decisive ? round(agg.wins / decisive, 4) : 0;
  agg.decisiveWinrate = pct(agg.decisiveWinrateNum);

  agg.nonLossRateNum = closed ? round((agg.wins + agg.breakeven) / closed, 4) : 0;
  agg.nonLossRate = pct(agg.nonLossRateNum);

  agg.profitFactor =
    agg.grossLossR > 0
      ? round(agg.grossWinR / agg.grossLossR, 3)
      : agg.grossWinR > 0
        ? 999
        : 0;

  agg.status = classifyMainStatus(agg, minClosed);

  return agg;
}

function sortMainFamilies(a, b) {
  const statusDiff = (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0);
  if (statusDiff !== 0) return statusDiff;

  const winrateDiff = safeNumber(b.winrateNum, 0) - safeNumber(a.winrateNum, 0);
  if (winrateDiff !== 0) return winrateDiff;

  const decisiveDiff = safeNumber(b.decisiveWinrateNum, 0) - safeNumber(a.decisiveWinrateNum, 0);
  if (decisiveDiff !== 0) return decisiveDiff;

  const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgRDiff !== 0) return avgRDiff;

  const pfDiff = safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0);
  if (pfDiff !== 0) return pfDiff;

  return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
}

function aggregateRows(rows, keyFn, type, minClosed) {
  const map = new Map();

  for (const row of rows) {
    if (!row) continue;

    const key = keyFn(row);

    if (!map.has(key)) {
      map.set(key, createAgg(key, type, row));
    }

    updateAgg(map.get(key), row);
  }

  return Array.from(map.values())
    .map(agg => finalizeAgg(agg, minClosed))
    .sort(sortMainFamilies);
}

function getWinners(families) {
  return families
    .filter(f => ["ELITE", "HOT", "GOOD", "STABLE"].includes(f.status))
    .filter(f => f.closed > 0)
    .filter(f => f.avgR >= 0)
    .filter(f => f.profitFactor >= 1.05)
    .sort(sortMainFamilies);
}

function buildAllowlist(families) {
  return getWinners(families).map(f => ({
    key: f.key,
    type: f.type,
    side: f.side,
    parentFamily: f.parentFamily,
    status: f.status,

    closed: f.closed,
    wins: f.wins,
    losses: f.losses,
    breakeven: f.breakeven,

    winrate: f.winrate,
    winrateNum: f.winrateNum,

    decisiveWinrate: f.decisiveWinrate,
    decisiveWinrateNum: f.decisiveWinrateNum,

    nonLossRate: f.nonLossRate,
    nonLossRateNum: f.nonLossRateNum,

    avgR: f.avgR,
    totalR: f.totalR,

    avgPnlPct: f.avgPnlPct,
    totalPnlPct: f.totalPnlPct,

    profitFactor: f.profitFactor
  }));
}

// ================= PUBLIC API =================

export function buildMainFamilyMicroAnalysis(rowsInput = [], options = {}) {
  const rows = Array.isArray(rowsInput)
    ? rowsInput.filter(Boolean)
    : [];

  const minParentClosed = safeNumber(options.minParentClosed, DEFAULT_MIN_PARENT_CLOSED);
  const minSubClosed = safeNumber(options.minSubClosed, DEFAULT_MIN_SUB_CLOSED);
  const minMicroClosed = safeNumber(options.minMicroClosed, DEFAULT_MIN_MICRO_CLOSED);

  const parentFamilies = aggregateRows(
    rows,
    getMainParentFamilyKey,
    "PARENT",
    minParentClosed
  );

  const subFamilies = aggregateRows(
    rows,
    buildMainSubFamilyKey,
    "SUB",
    minSubClosed
  );

  const microFamilies = aggregateRows(
    rows,
    buildMainMicroFamilyKey,
    "MICRO",
    minMicroClosed
  );

  const parentWinners = getWinners(parentFamilies);
  const subWinners = getWinners(subFamilies);
  const microWinners = getWinners(microFamilies);

  return {
    ok: true,
    tag: "MAIN_FAMILY_MICRO_ANALYSIS",
    mode: "MAIN",
    generatedAt: Date.now(),

    sample: {
      rows: rows.length,
      closed: rows.filter(isClosedRow).length,
      open: rows.filter(row => !isClosedRow(row)).length,
      minParentClosed,
      minSubClosed,
      minMicroClosed
    },

    summary: {
      parentFamilies: parentFamilies.length,
      subFamilies: subFamilies.length,
      microFamilies: microFamilies.length,

      parentWinners: parentWinners.length,
      subWinners: subWinners.length,
      microWinners: microWinners.length
    },

    parentFamilies,
    subFamilies,
    microFamilies,

    winners: {
      parent: parentWinners,
      sub: subWinners,
      micro: microWinners
    },

    allowlists: {
      parent: buildAllowlist(parentFamilies),
      sub: buildAllowlist(subFamilies),
      micro: buildAllowlist(microFamilies)
    }
  };
}

export function getBestMainLongShort(report, options = {}) {
  const level = normalizeUpper(options.level || "MICRO").toLowerCase();
  const minClosed = safeNumber(
    options.minClosed,
    level === "parent"
      ? DEFAULT_MIN_PARENT_CLOSED
      : level === "sub"
        ? DEFAULT_MIN_SUB_CLOSED
        : DEFAULT_MIN_MICRO_CLOSED
  );

  const source =
    level === "parent"
      ? report?.parentFamilies
      : level === "sub"
        ? report?.subFamilies
        : report?.microFamilies;

  const rows = Array.isArray(source)
    ? source
        .filter(f => f.closed >= minClosed)
        .filter(f => f.avgR >= 0)
        .filter(f => f.profitFactor >= 1.05)
        .sort(sortMainFamilies)
    : [];

  const bestLong = rows.find(f => f.side === "LONG") || null;
  const bestShort = rows.find(f => f.side === "SHORT") || null;

  return {
    mode: "MAIN",
    level,
    minClosed,
    bestLong,
    bestShort
  };
}

export function buildMainDiscordAllowlist(report, options = {}) {
  const level = normalizeUpper(options.level || "MICRO").toLowerCase();
  const minStatus = normalizeUpper(options.minStatus || "STABLE");
  const minRank = STATUS_RANK[minStatus] ?? STATUS_RANK.STABLE;

  const source =
    level === "parent"
      ? report?.allowlists?.parent
      : level === "sub"
        ? report?.allowlists?.sub
        : report?.allowlists?.micro;

  return Array.isArray(source)
    ? source.filter(item => (STATUS_RANK[item.status] || 0) >= minRank)
    : [];
}

export function isMainSignalAllowedByMicroFamily(row, report, options = {}) {
  if (!row || !report) return false;

  const level = normalizeUpper(options.level || "MICRO").toLowerCase();
  const minStatus = normalizeUpper(options.minStatus || "STABLE");
  const minRank = STATUS_RANK[minStatus] ?? STATUS_RANK.STABLE;

  const key =
    level === "parent"
      ? getMainParentFamilyKey(row)
      : level === "sub"
        ? buildMainSubFamilyKey(row)
        : buildMainMicroFamilyKey(row);

  const allowlist = buildMainDiscordAllowlist(report, {
    level,
    minStatus
  });

  const match = allowlist.find(item => item.key === key);

  if (!match) return false;

  return (STATUS_RANK[match.status] || 0) >= minRank;
}