// lib/familyMicroAnalyzer.js

// ================= FAMILY MICRO ANALYZER =================
//
// Doel:
// - Parent families behouden.
// - Binnen parent families subfamilies en microfamilies maken.
// - Main rangschikken op winrate / stabiliteit.
// - Runner rangschikken op avg PnL / avg R / asymmetrische upside.
//
// Belangrijk:
// - Alleen entry-known features gebruiken voor keys.
// - Outcome-data alleen gebruiken voor performance stats.
// - Geen mfe/mae/exit/pnl in family-key stoppen.

const DEFAULT_MIN_CLOSED_PARENT = 20;
const DEFAULT_MIN_CLOSED_SUB = 15;
const DEFAULT_MIN_CLOSED_MICRO = 10;

const STATUS_RANK = {
  ELITE: 6,
  HOT: 5,
  GOOD: 4,
  STABLE: 3,
  CANDIDATE: 2,
  COLLECTING: 1,
  EMPTY: 0,
  BAD: -1
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

function pct(value) {
  return `${round(safeNumber(value, 0) * 100, 1)}%`;
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase();
  if (s === "short" || s === "bear") return "SHORT";
  if (s === "long" || s === "bull") return "LONG";
  return "UNKNOWN";
}

function normalizeUpper(value, fallback = "UNKNOWN") {
  const out = String(value || fallback).trim().toUpperCase();
  return out || fallback;
}

function getFirstFinite(row, keys, fallback = 0) {
  for (const key of keys) {
    const n = Number(row?.[key]);
    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function getParentFamilyId(row) {
  const direct =
    row?.familyId ||
    row?.family ||
    row?.frozenFamilyId ||
    row?.entryFamilyId ||
    row?.runnerFamilyId;

  if (direct) return normalizeUpper(direct);

  const side = normalizeSide(row?.side);
  const quality = normalizeUpper(row?.quality || row?.qualityBucket || "Q_UNKNOWN");
  const market = normalizeUpper(row?.market || row?.marketBucket || "M_UNKNOWN");
  const timing = normalizeUpper(row?.timing || row?.timingBucket || "T_UNKNOWN");

  return `${side}_${quality}_${market}_${timing}`;
}

function getActionType(row) {
  return normalizeUpper(row?.action || row?.type || row?.status || "UNKNOWN");
}

function isTradeLikeRow(row) {
  if (!row) return false;

  const action = getActionType(row);

  if (
    action === "ENTRY" ||
    action === "TRADE" ||
    action === "EXIT" ||
    action === "CLOSED"
  ) {
    return true;
  }

  if (row?.familyId || row?.entryFamilyId || row?.runnerFamilyId) return true;
  if (row?.entry || row?.entryPrice) return true;

  return false;
}

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
      "HIT_SL",
      "HORIZON_DONE",
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

  const hasOutcomeR = Number.isFinite(Number(
    row.resultR ??
    row.outcomeR ??
    row.realizedR ??
    row.pnlR ??
    row.exitR
  ));

  const hasPnl = Number.isFinite(Number(row.pnlPct ?? row.pnlPercentage));

  return hasOutcomeR || hasPnl;
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
  const r = getOutcomeR(row);
  const pnlPct = getPnlPct(row);

  const result = normalizeUpper(row?.result || row?.outcome || row?.exitReason || "");

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

function bucketPressure(value) {
  const v = safeNumber(value, 0);

  if (v < -1.5) return "PRESSURE_COUNTER_HARD";
  if (v < -0.25) return "PRESSURE_COUNTER";
  if (v < 0.25) return "PRESSURE_FLAT";
  if (v < 0.75) return "PRESSURE_LOW";
  if (v < 1.5) return "PRESSURE_MID";
  if (v < 3.0) return "PRESSURE_HIGH";

  return "PRESSURE_EXTREME";
}

function bucketAcceleration(value) {
  const v = safeNumber(value, 0);

  if (v < -0.75) return "ACCEL_NEG_HARD";
  if (v < -0.2) return "ACCEL_NEG";
  if (v < 0.2) return "ACCEL_FLAT";
  if (v < 0.75) return "ACCEL_POS";
  if (v < 1.5) return "ACCEL_STRONG";

  return "ACCEL_EXTREME";
}

function bucketChange1h(value) {
  const v = safeNumber(value, 0);

  if (v < -3) return "CH1_COUNTER_HARD";
  if (v < -0.5) return "CH1_COUNTER";
  if (v < 0.25) return "CH1_FLAT";
  if (v < 0.75) return "CH1_LOW";
  if (v < 1.5) return "CH1_MID";
  if (v < 3) return "CH1_HIGH";

  return "CH1_EXTREME";
}

function bucketChange24h(value) {
  const v = safeNumber(value, 0);

  if (v < -12) return "CH24_COUNTER_HARD";
  if (v < -3) return "CH24_COUNTER";
  if (v < 1) return "CH24_FLAT";
  if (v < 4) return "CH24_LOW";
  if (v < 10) return "CH24_MID";
  if (v < 20) return "CH24_HIGH";

  return "CH24_EXTREME";
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

function normalizeSpreadPct(raw) {
  let v = safeNumber(raw, 0);

  if (v < 0) return 0;
  if (v > 0.05) v = v / 100;

  return v;
}

function getSpreadBps(row) {
  const explicit = Number(row?.spreadBps);
  if (Number.isFinite(explicit)) return explicit;

  return normalizeSpreadPct(row?.spreadPct) * 10000;
}

function bucketSpreadMicro(row) {
  const bps = getSpreadBps(row);

  if (bps <= 0) return "SPREAD_UNKNOWN";
  if (bps < 5) return "SPREAD_LT_5BPS";
  if (bps < 8) return "SPREAD_5_8BPS";
  if (bps < 10) return "SPREAD_8_10BPS";
  if (bps < 12) return "SPREAD_10_12BPS";
  if (bps < 14) return "SPREAD_12_14BPS";
  if (bps < 16) return "SPREAD_14_16BPS";
  if (bps < 20) return "SPREAD_16_20BPS";
  if (bps < 25) return "SPREAD_20_25BPS";

  return "SPREAD_GT_25BPS";
}

function bucketDepthMicro(row) {
  const d = getFirstFinite(row, ["depthMinUsd1p", "depthUsd", "depth"], 0);

  if (d <= 0) return "DEPTH_UNKNOWN";
  if (d < 10000) return "DEPTH_LT_10K";
  if (d < 25000) return "DEPTH_10K_25K";
  if (d < 50000) return "DEPTH_25K_50K";
  if (d < 65000) return "DEPTH_50K_65K";
  if (d < 80000) return "DEPTH_65K_80K";
  if (d < 100000) return "DEPTH_80K_100K";
  if (d < 150000) return "DEPTH_100K_150K";
  if (d < 250000) return "DEPTH_150K_250K";

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

  const btc1h = getFirstFinite(row, ["btcChange1h", "btcCh1h"], 0);
  const btc24 = getFirstFinite(row, ["btcChange24", "btcCh24"], 0);
  const pressure = btc1h * 0.78 + btc24 * 0.22;

  if (pressure > 1.5) return "BTC_FAST_UP";
  if (pressure > 0.35) return "BTC_SLOW_UP";
  if (pressure < -1.5) return "BTC_FAST_DOWN";
  if (pressure < -0.35) return "BTC_SLOW_DOWN";

  return "BTC_FLAT";
}

function bucketSession(ts = Date.now()) {
  const date = new Date(safeNumber(ts, Date.now()));
  const hour = date.getUTCHours();

  if (hour >= 0 && hour < 7) return "SESSION_ASIA";
  if (hour >= 7 && hour < 13) return "SESSION_EU";
  if (hour >= 13 && hour < 20) return "SESSION_US";

  return "SESSION_LATE_US";
}

function bucketOb(row) {
  const bias = normalizeUpper(row?.obBias || row?.orderbookBias || "UNKNOWN");

  if (bias === "BULLISH") return "OB_BULLISH";
  if (bias === "BEARISH") return "OB_BEARISH";
  if (bias === "NEUTRAL") return "OB_NEUTRAL";

  return "OB_UNKNOWN";
}

function bucketTf(row) {
  const strength = getFirstFinite(row, ["tfStrength"], null);
  const score = getFirstFinite(row, ["tfScore"], 0);
  const s = Number.isFinite(strength) ? strength : Math.abs(score);

  if (s < 1) return "TF_WEAK";
  if (s < 2) return "TF_OK";
  if (s < 4) return "TF_STRONG";

  return "TF_EXTREME";
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

// ================= FAMILY KEY BUILDERS =================

export function buildFamilyLabels(row) {
  const side = normalizeSide(row?.side);
  const parentFamily = getParentFamilyId(row);

  const pressure = bucketPressure(
    getFirstFinite(row, ["runnerPressure", "pressure", "directionalPressure"], 0)
  );

  const acceleration = bucketAcceleration(
    getFirstFinite(row, ["runnerAcceleration", "acceleration"], 0)
  );

  const change1h = bucketChange1h(
    getFirstFinite(row, ["change1h", "change1H", "chg1h"], 0)
  );

  const change24h = bucketChange24h(
    getFirstFinite(row, ["change24", "change24h", "chg24h"], 0)
  );

  return {
    side,
    parentFamily,

    pressure,
    acceleration,
    change1h,
    change24h,

    rsiMicro: bucketRsi(row),
    spreadMicro: bucketSpreadMicro(row),
    depthMicro: bucketDepthMicro(row),
    fundingMicro: bucketFunding(row),
    btcMicro: bucketBtc(row),
    session: bucketSession(getRowTimestamp(row)),
    obMicro: bucketOb(row),
    tfMicro: bucketTf(row),

    flow: normalizeUpper(row?.flow || row?.scannerFlow || "UNKNOWN"),
    stage: normalizeUpper(row?.stage || "UNKNOWN")
  };
}

export function buildSubfamilyKey(row) {
  const l = buildFamilyLabels(row);

  return [
    l.parentFamily,
    l.pressure,
    l.acceleration,
    l.rsiMicro,
    l.btcMicro,
    l.session
  ].join(" | ");
}

export function buildMicrofamilyKey(row) {
  const l = buildFamilyLabels(row);

  return [
    l.parentFamily,
    l.pressure,
    l.acceleration,
    l.rsiMicro,
    l.spreadMicro,
    l.depthMicro,
    l.fundingMicro,
    l.btcMicro,
    l.session,
    l.obMicro,
    l.tfMicro
  ].join(" | ");
}

function createAgg(key, type, row) {
  const labels = buildFamilyLabels(row);

  return {
    key,
    type,

    side: labels.side,
    parentFamily: labels.parentFamily,

    definition: key,

    observed: 0,
    trades: 0,
    closed: 0,
    open: 0,
    pending: 0,

    wins: 0,
    losses: 0,
    breakeven: 0,

    totalR: 0,
    avgR: 0,

    totalPnlPct: 0,
    avgPnlPct: 0,

    grossWinR: 0,
    grossLossR: 0,
    profitFactor: 0,

    winrateInclBE: "0.0%",
    winrateInclBENum: 0,

    winrateExBE: "0.0%",
    winrateExBENum: 0,

    status: "EMPTY",

    examples: []
  };
}

function updateAgg(agg, row) {
  agg.observed += 1;

  if (isTradeLikeRow(row)) {
    agg.trades += 1;
  }

  const closed = isClosedRow(row);

  if (!closed) {
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
      familyId: getParentFamilyId(row),
      r: round(r, 3),
      pnlPct: round(pnlPct, 3),
      result: outcome,
      ts: getRowTimestamp(row)
    });
  }

  return agg;
}

function finalizeAgg(agg, mode = "MAIN", minClosed = DEFAULT_MIN_CLOSED_MICRO) {
  const closed = safeNumber(agg.closed, 0);
  const decisive = agg.wins + agg.losses;

  agg.totalR = round(agg.totalR, 3);
  agg.totalPnlPct = round(agg.totalPnlPct, 3);

  agg.avgR = closed ? round(agg.totalR / closed, 3) : 0;
  agg.avgPnlPct = closed ? round(agg.totalPnlPct / closed, 3) : 0;

  agg.winrateInclBENum = closed ? round(agg.wins / closed, 4) : 0;
  agg.winrateInclBE = pct(agg.winrateInclBENum);

  agg.winrateExBENum = decisive ? round(agg.wins / decisive, 4) : 0;
  agg.winrateExBE = pct(agg.winrateExBENum);

  agg.profitFactor =
    agg.grossLossR > 0
      ? round(agg.grossWinR / agg.grossLossR, 3)
      : agg.grossWinR > 0
        ? 999
        : 0;

  agg.status = classifyFamilyStatus(agg, mode, minClosed);

  return agg;
}

function classifyFamilyStatus(agg, mode = "MAIN", minClosed = DEFAULT_MIN_CLOSED_MICRO) {
  const closed = safeNumber(agg.closed, 0);
  const avgR = safeNumber(agg.avgR, 0);
  const avgPnlPct = safeNumber(agg.avgPnlPct, 0);
  const pf = safeNumber(agg.profitFactor, 0);
  const wrIncl = safeNumber(agg.winrateInclBENum, 0);
  const wrEx = safeNumber(agg.winrateExBENum, 0);

  if (!agg.observed) return "EMPTY";
  if (closed < minClosed) return "COLLECTING";

  if (mode === "RUNNER") {
    if (closed >= 80 && avgPnlPct >= 2.0 && avgR >= 0.75 && pf >= 3.0) return "ELITE";
    if (closed >= 40 && avgPnlPct >= 1.25 && avgR >= 0.45 && pf >= 2.0) return "HOT";
    if (closed >= 20 && avgPnlPct > 0 && avgR > 0.15 && pf >= 1.35) return "GOOD";
    if (avgPnlPct > 0 && avgR > 0 && pf >= 1.1) return "STABLE";
    if (avgPnlPct < 0 || avgR < 0) return "BAD";

    return "CANDIDATE";
  }

  // MAIN = winrate first.
  if (closed >= 120 && wrIncl >= 0.62 && wrEx >= 0.68 && avgR > 0.2 && pf >= 1.8) return "ELITE";
  if (closed >= 75 && wrIncl >= 0.58 && wrEx >= 0.64 && avgR > 0.15 && pf >= 1.5) return "HOT";
  if (closed >= 40 && wrIncl >= 0.54 && wrEx >= 0.60 && avgR > 0.08 && pf >= 1.25) return "GOOD";
  if (closed >= minClosed && wrIncl >= 0.50 && avgR >= 0 && pf >= 1.05) return "STABLE";
  if (avgR < 0 || pf < 0.95) return "BAD";

  return "CANDIDATE";
}

function sortFamilies(a, b, mode = "MAIN") {
  const statusDiff = (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0);
  if (statusDiff !== 0) return statusDiff;

  if (mode === "RUNNER") {
    const avgPnlDiff = safeNumber(b.avgPnlPct, 0) - safeNumber(a.avgPnlPct, 0);
    if (avgPnlDiff !== 0) return avgPnlDiff;

    const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
    if (avgRDiff !== 0) return avgRDiff;

    const totalPnlDiff = safeNumber(b.totalPnlPct, 0) - safeNumber(a.totalPnlPct, 0);
    if (totalPnlDiff !== 0) return totalPnlDiff;

    return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  }

  const wrInclDiff = safeNumber(b.winrateInclBENum, 0) - safeNumber(a.winrateInclBENum, 0);
  if (wrInclDiff !== 0) return wrInclDiff;

  const wrExDiff = safeNumber(b.winrateExBENum, 0) - safeNumber(a.winrateExBENum, 0);
  if (wrExDiff !== 0) return wrExDiff;

  const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgRDiff !== 0) return avgRDiff;

  const pfDiff = safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0);
  if (pfDiff !== 0) return pfDiff;

  return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
}

function aggregateRows(rows, keyFn, type, mode, minClosed) {
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
    .map(agg => finalizeAgg(agg, mode, minClosed))
    .sort((a, b) => sortFamilies(a, b, mode));
}

function buildWinnerList(families, mode, max = 50) {
  return families
    .filter(f => ["ELITE", "HOT", "GOOD", "STABLE"].includes(f.status))
    .filter(f => f.closed > 0)
    .filter(f => {
      if (mode === "RUNNER") {
        return f.avgPnlPct > 0 && f.avgR > 0 && f.profitFactor >= 1.1;
      }

      return f.winrateInclBENum >= 0.5 && f.avgR >= 0 && f.profitFactor >= 1.05;
    })
    .sort((a, b) => sortFamilies(a, b, mode))
    .slice(0, max);
}

function buildAllowlist(winners) {
  return winners.map(f => ({
    key: f.key,
    type: f.type,
    side: f.side,
    parentFamily: f.parentFamily,
    status: f.status,
    closed: f.closed,
    winrateInclBE: f.winrateInclBE,
    winrateExBE: f.winrateExBE,
    avgR: f.avgR,
    avgPnlPct: f.avgPnlPct,
    profitFactor: f.profitFactor
  }));
}

export function buildFamilyMicroAnalysis(rowsInput = [], options = {}) {
  const rows = Array.isArray(rowsInput)
    ? rowsInput.filter(Boolean)
    : [];

  const mode = normalizeUpper(options.mode || options.profile || "MAIN") === "RUNNER"
    ? "RUNNER"
    : "MAIN";

  const minClosedParent = safeNumber(options.minClosedParent, DEFAULT_MIN_CLOSED_PARENT);
  const minClosedSub = safeNumber(options.minClosedSub, DEFAULT_MIN_CLOSED_SUB);
  const minClosedMicro = safeNumber(options.minClosedMicro, DEFAULT_MIN_CLOSED_MICRO);

  const parentFamilies = aggregateRows(
    rows,
    getParentFamilyId,
    "PARENT",
    mode,
    minClosedParent
  );

  const subFamilies = aggregateRows(
    rows,
    buildSubfamilyKey,
    "SUB",
    mode,
    minClosedSub
  );

  const microFamilies = aggregateRows(
    rows,
    buildMicrofamilyKey,
    "MICRO",
    mode,
    minClosedMicro
  );

  const parentWinners = buildWinnerList(parentFamilies, mode);
  const subWinners = buildWinnerList(subFamilies, mode);
  const microWinners = buildWinnerList(microFamilies, mode);

  return {
    ok: true,
    tag: "FAMILY_MICRO_ANALYSIS",
    mode,
    generatedAt: Date.now(),

    sample: {
      rows: rows.length,
      closed: rows.filter(isClosedRow).length,
      open: rows.filter(row => !isClosedRow(row)).length,
      minClosedParent,
      minClosedSub,
      minClosedMicro
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
      parent: buildAllowlist(parentWinners),
      sub: buildAllowlist(subWinners),
      micro: buildAllowlist(microWinners)
    }
  };
}

export function getBestLongShortFromMicroAnalysis(report, options = {}) {
  const level = normalizeUpper(options.level || "MICRO").toLowerCase();
  const mode = normalizeUpper(options.mode || report?.mode || "MAIN") === "RUNNER"
    ? "RUNNER"
    : "MAIN";

  const minClosed = safeNumber(options.minClosed, level === "micro" ? 10 : 20);

  const source =
    level === "parent"
      ? report?.parentFamilies
      : level === "sub"
        ? report?.subFamilies
        : report?.microFamilies;

  const rows = Array.isArray(source)
    ? source
        .filter(f => f.closed >= minClosed)
        .filter(f => ["ELITE", "HOT", "GOOD", "STABLE", "CANDIDATE"].includes(f.status))
    : [];

  const longs = rows
    .filter(f => f.side === "LONG")
    .sort((a, b) => sortFamilies(a, b, mode));

  const shorts = rows
    .filter(f => f.side === "SHORT")
    .sort((a, b) => sortFamilies(a, b, mode));

  return {
    mode,
    level,
    minClosed,
    bestLong: longs[0] || null,
    bestShort: shorts[0] || null
  };
}

export function isAllowedByMicrofamily(row, report, options = {}) {
  if (!row || !report) return false;

  const level = normalizeUpper(options.level || "MICRO").toLowerCase();
  const minStatusRank = STATUS_RANK[normalizeUpper(options.minStatus || "STABLE")] ?? STATUS_RANK.STABLE;

  const key =
    level === "parent"
      ? getParentFamilyId(row)
      : level === "sub"
        ? buildSubfamilyKey(row)
        : buildMicrofamilyKey(row);

  const allowlist =
    level === "parent"
      ? report?.allowlists?.parent
      : level === "sub"
        ? report?.allowlists?.sub
        : report?.allowlists?.micro;

  const match = Array.isArray(allowlist)
    ? allowlist.find(item => item.key === key)
    : null;

  if (!match) return false;

  return (STATUS_RANK[match.status] || 0) >= minStatusRank;
}