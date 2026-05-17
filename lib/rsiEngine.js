// ================= RSI ENGINE — CRYPTOCROC 15M MATCH =================

// ================= CONFIG =================
const RSI_LENGTH = 14;
const RSI_SMOOTH = 5;

// Blauwe anchor uit TradingView
const RSI_MEAN = 100;
const RSI_MEAN_TYPE = "EMA";

// Candles
const MIN_CANDLES = 80;

// ATR compressie
const USE_ATR_COMP = true;
const ATR_LENGTH = 14;
const ATR_COMP_LOOKBACK = 50;

// RSI range compressie
const USE_RSI_COMP = true;
const RSI_RANGE_LOOKBACK = 50;

const COMPRESS_POWER = 1.0;

// Jouw zichtbare TradingView filterwaardes
// Base afstand Zone 1 = 10
// Base afstand Zone 2 = 17
// Base afstand Zone 3 = 24
// Min afstand Zone 1 = 12
// Min afstand Zone 2 = 18
// Min afstand Zone 3 = 24
const BASE_D1 = 10;
const BASE_D2 = 17;
const BASE_D3 = 24;

const MIN_D1 = 12;
const MIN_D2 = 18;
const MIN_D3 = 24;

// ================= HELPERS =================
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function last(arr, fallback = null) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : fallback;
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return [];

  return candles
    .map(c => ({
      openTime: safeNumber(c?.openTime ?? c?.time ?? c?.timestamp, 0),
      open: safeNumber(c?.open, 0),
      high: safeNumber(c?.high, safeNumber(c?.close, 0)),
      low: safeNumber(c?.low, safeNumber(c?.close, 0)),
      close: safeNumber(c?.close, 0),
      volume: safeNumber(c?.volume, 0)
    }))
    .filter(c => c.close > 0 && c.high > 0 && c.low > 0)
    .sort((a, b) => {
      if (!a.openTime || !b.openTime) return 0;
      return a.openTime - b.openTime;
    });
}

function ema(values, length) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const len = Math.max(1, Number(length || 1));
  const k = 2 / (len + 1);
  const out = [];

  let prev = safeNumber(values[0], 0);

  for (let i = 0; i < values.length; i++) {
    const val = safeNumber(values[i], prev);
    prev = i === 0 ? val : val * k + prev * (1 - k);
    out.push(prev);
  }

  return out;
}

function sma(values, length) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const len = Math.max(1, Number(length || 1));
  const out = [];

  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    const val = safeNumber(values[i], 0);
    sum += val;

    if (i >= len) {
      sum -= safeNumber(values[i - len], 0);
    }

    const divisor = Math.min(i + 1, len);
    out.push(sum / divisor);
  }

  return out;
}

function rma(values, length) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const len = Math.max(1, Number(length || 1));
  const out = [];

  let sum = 0;
  let prev = safeNumber(values[0], 0);

  for (let i = 0; i < values.length; i++) {
    const val = safeNumber(values[i], prev);

    if (i < len) {
      sum += val;
      prev = sum / (i + 1);
    } else {
      prev = (prev * (len - 1) + val) / len;
    }

    out.push(prev);
  }

  return out;
}

function meanByType(values, length, type = RSI_MEAN_TYPE) {
  const t = String(type || "EMA").toUpperCase();

  if (t === "SMA") return sma(values, length);
  if (t === "RMA") return rma(values, length);

  return ema(values, length);
}

function getSlope(values, bars = 3) {
  if (!Array.isArray(values) || values.length <= bars) return 0;

  const now = safeNumber(values[values.length - 1], 0);
  const prev = safeNumber(values[values.length - 1 - bars], now);

  return safeNumber(now - prev, 0);
}

function getRecentRange(values, lookback) {
  if (!Array.isArray(values) || values.length === 0) {
    return {
      high: 0,
      low: 0,
      range: 0
    };
  }

  const recent = values.slice(-lookback).map(v => safeNumber(v, 50));
  const high = Math.max(...recent);
  const low = Math.min(...recent);

  return {
    high,
    low,
    range: high - low
  };
}

// ================= RSI CALC — TradingView style =================
function rsiCalc(closes, length = RSI_LENGTH) {
  if (!Array.isArray(closes) || closes.length < length + 2) return [];

  const gains = [];
  const losses = [];

  for (let i = 1; i < closes.length; i++) {
    const current = safeNumber(closes[i], 0);
    const prev = safeNumber(closes[i - 1], current);
    const diff = current - prev;

    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  const avgGain = rma(gains, length);
  const avgLoss = rma(losses, length);

  const rsi = [];

  for (let i = 0; i < avgGain.length; i++) {
    const gain = safeNumber(avgGain[i], 0);
    const loss = safeNumber(avgLoss[i], 0);

    if (gain === 0 && loss === 0) {
      rsi.push(50);
      continue;
    }

    if (loss === 0) {
      rsi.push(100);
      continue;
    }

    if (gain === 0) {
      rsi.push(0);
      continue;
    }

    const rs = gain / loss;
    rsi.push(100 - 100 / (1 + rs));
  }

  return rsi;
}

// ================= ATR / COMPRESSIE =================
function trueRangeSeries(candles) {
  const rows = normalizeCandles(candles);
  if (!rows.length) return [];

  const out = [];

  for (let i = 0; i < rows.length; i++) {
    const high = safeNumber(rows[i].high, rows[i].close);
    const low = safeNumber(rows[i].low, rows[i].close);
    const prevClose = i > 0
      ? safeNumber(rows[i - 1].close, rows[i].close)
      : safeNumber(rows[i].close, 0);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    out.push(tr);
  }

  return out;
}

function getAtrCompression(candles) {
  if (!USE_ATR_COMP) return 0;

  const tr = trueRangeSeries(candles);
  if (tr.length < ATR_LENGTH + 2) return 0;

  const atrArr = rma(tr, ATR_LENGTH);
  const atrVal = safeNumber(last(atrArr), 0);
  const atrAvgArr = sma(atrArr, ATR_COMP_LOOKBACK);
  const atrAvg = safeNumber(last(atrAvgArr), atrVal);

  if (!atrVal || !atrAvg) return 0;

  const ratio = atrVal / atrAvg;

  return clamp01(1 - ratio);
}

function getRsiRangeCompression(rsiWhiteSeries) {
  if (!USE_RSI_COMP) return 0;

  const { range } = getRecentRange(rsiWhiteSeries, RSI_RANGE_LOOKBACK);

  return clamp01((40 - range) / 30);
}

function buildDynamicZones({ candles, rsiWhiteSeries }) {
  const sATR = getAtrCompression(candles);
  const sRSI = getRsiRangeCompression(rsiWhiteSeries);

  const stress =
    USE_ATR_COMP && USE_RSI_COMP
      ? (sATR + sRSI) / 2
      : USE_ATR_COMP
        ? sATR
        : USE_RSI_COMP
          ? sRSI
          : 0;

  const tComp = Math.pow(clamp01(stress), COMPRESS_POWER);

  const d1 = lerp(BASE_D1, MIN_D1, tComp);
  const d2 = lerp(BASE_D2, MIN_D2, tComp);
  const d3 = lerp(BASE_D3, MIN_D3, tComp);

  return {
    U1: 50 + d1,
    U2: 50 + d2,
    U3: 50 + d3,

    L1: 50 - d1,
    L2: 50 - d2,
    L3: 50 - d3,

    stress,
    sATR,
    sRSI,
    tComp,

    d1,
    d2,
    d3
  };
}

// ================= ZONES =================
function getZone(value, zones) {
  const rsi = Number(value);

  if (!Number.isFinite(rsi) || !zones) return "MID";

  if (rsi >= zones.U3) return "UPPER_3";
  if (rsi >= zones.U2) return "UPPER_2";
  if (rsi >= zones.U1) return "UPPER_1";

  if (rsi <= zones.L3) return "LOWER_3";
  if (rsi <= zones.L2) return "LOWER_2";
  if (rsi <= zones.L1) return "LOWER_1";

  return "MID";
}

function isLowerZone(zone) {
  return String(zone || "").startsWith("LOWER");
}

function isUpperZone(zone) {
  return String(zone || "").startsWith("UPPER");
}

function getZoneDepth(zone) {
  const z = String(zone || "MID").toUpperCase();

  if (z.endsWith("_3")) return 3;
  if (z.endsWith("_2")) return 2;
  if (z.endsWith("_1")) return 1;

  return 0;
}

function getDirectionalRank({ isBull, zone }) {
  const z = String(zone || "MID").toUpperCase();

  if (isBull) {
    if (z === "LOWER_3") return 3;
    if (z === "LOWER_2") return 2;
    if (z === "LOWER_1") return 1;
    if (z === "MID") return 0;
    if (z === "UPPER_1") return -1;
    if (z === "UPPER_2") return -2;
    if (z === "UPPER_3") return -3;
  }

  if (z === "UPPER_3") return 3;
  if (z === "UPPER_2") return 2;
  if (z === "UPPER_1") return 1;
  if (z === "MID") return 0;
  if (z === "LOWER_1") return -1;
  if (z === "LOWER_2") return -2;
  if (z === "LOWER_3") return -3;

  return 0;
}

function getAnchorEdgeScore({ isBull, anchorZone, mean }) {
  const zone = String(anchorZone || "MID").toUpperCase();
  const anchor = safeNumber(mean, 50);

  if (isBull) {
    if (zone === "LOWER_3") return 3;
    if (zone === "LOWER_2") return 2.5;
    if (zone === "LOWER_1") return 2;
    if (anchor < 50) return 1;
    if (zone === "UPPER_1") return -1;
    if (zone === "UPPER_2") return -2;
    if (zone === "UPPER_3") return -3;
    return 0;
  }

  if (zone === "UPPER_3") return 3;
  if (zone === "UPPER_2") return 2.5;
  if (zone === "UPPER_1") return 2;
  if (anchor > 50) return 1;
  if (zone === "LOWER_1") return -1;
  if (zone === "LOWER_2") return -2;
  if (zone === "LOWER_3") return -3;

  return 0;
}

// ================= CORE RSI CONTEXT =================
export function getAdvancedRSIContext(candles) {
  const rows = normalizeCandles(candles);

  if (rows.length < MIN_CANDLES) {
    return { valid: false };
  }

  const closes = rows.map(c => c.close).filter(v => v > 0);

  if (closes.length < MIN_CANDLES) {
    return { valid: false };
  }

  const rsiRaw = rsiCalc(closes, RSI_LENGTH);

  if (rsiRaw.length < 20) {
    return { valid: false };
  }

  // WITTE lijn in jouw TradingView
  const rsiWhiteSeries = ema(rsiRaw, RSI_SMOOTH);

  // BLAUWE lijn in jouw TradingView
  const rsiAnchorSeries = meanByType(rsiWhiteSeries, RSI_MEAN, RSI_MEAN_TYPE);

  const rsi = safeNumber(last(rsiWhiteSeries), 50);
  const raw = safeNumber(last(rsiRaw), rsi);
  const mean = safeNumber(last(rsiAnchorSeries), 50);

  const zones = buildDynamicZones({
    candles: rows,
    rsiWhiteSeries
  });

  const zone = getZone(rsi, zones);
  const anchorZone = getZone(mean, zones);

  const slope1 = getSlope(rsiWhiteSeries, 1);
  const slope3 = getSlope(rsiWhiteSeries, 3);
  const rawSlope3 = getSlope(rsiRaw, 3);
  const anchorSlope3 = getSlope(rsiAnchorSeries, 3);

  const recent = getRecentRange(rsiWhiteSeries, 20);

  const rising = slope3 > 0.75 || rawSlope3 > 1.0;
  const falling = slope3 < -0.75 || rawSlope3 < -1.0;

  const reclaimFromLower =
    (isLowerZone(zone) || zone === "MID") &&
    raw >= rsi &&
    slope3 > 0;

  const rejectionFromUpper =
    (isUpperZone(zone) || zone === "MID") &&
    raw <= rsi &&
    slope3 < 0;

  return {
    valid: true,

    // Backward-compatible: rsi = WITTE lijn
    rsi,

    // Blauwe lijn / anchor
    mean,
    rsiMean: mean,
    anchor: mean,

    // Explicit names voor logging/debug
    rsiWhite: rsi,
    rsiWhiteRaw: raw,
    rsiAnchorBlue: mean,

    zones,

    // Extra context
    raw,
    fast: raw,
    zone,
    anchorZone,

    slope1,
    slope3,
    fastSlope3: rawSlope3,
    rawSlope3,
    anchorSlope3,

    rising,
    falling,
    reclaimFromLower,
    rejectionFromUpper,

    distanceFromMean: rsi - mean,
    whiteAboveAnchor: rsi > mean,
    whiteBelowAnchor: rsi < mean,

    range20: recent.range,
    recentHigh: recent.high,
    recentLow: recent.low,

    zoneDepth: getZoneDepth(zone),

    compression: {
      stress: zones.stress,
      sATR: zones.sATR,
      sRSI: zones.sRSI,
      tComp: zones.tComp
    }
  };
}

// ================= MTF =================
export function getMTFRSI({ m15, h1, h4 = null }) {
  const rsi15 = getAdvancedRSIContext(m15);
  const rsi1h = getAdvancedRSIContext(h1);
  const rsi4h = h4 ? getAdvancedRSIContext(h4) : null;

  return {
    m15: rsi15,
    h1: rsi1h,
    h4: rsi4h
  };
}

// ================= SIGNAL =================
export function getRSISignal(mtfrsi, side) {
  const { m15, h1, h4 } = mtfrsi || {};

  if (!m15?.valid || !h1?.valid) {
    return { valid: false };
  }

  const isBull = side === "bull";

  const m15Zone = m15.zone || getZone(m15.rsi, m15.zones);
  const h1Zone = h1.zone || getZone(h1.rsi, h1.zones);

  const anchorZone = m15.anchorZone || getZone(m15.mean, m15.zones);
  const anchorEdgeScore = getAnchorEdgeScore({
    isBull,
    anchorZone,
    mean: m15.mean
  });

  const rank = getDirectionalRank({
    isBull,
    zone: m15Zone
  });

  let strength = 0;

  if (rank > 0) {
    strength = rank;
  }

  // HTF trend is bewust soft.
  // We willen geen goede 15m pullback entries killen door 1h ruis.
  const trendLong =
    h1.rsi > h1.mean - 7 ||
    h1.mean <= 50 ||
    h1.slope3 > -1.25;

  const trendShort =
    h1.rsi < h1.mean + 7 ||
    h1.mean >= 50 ||
    h1.slope3 < 1.25;

  let blocked = false;

  // Alleen hard blokkeren bij extreme H4 mismatch.
  if (h4?.valid) {
    if (isBull && h4.rsi < h4.zones.L2 && h4.slope3 < -0.75) {
      blocked = true;
    }

    if (!isBull && h4.rsi > h4.zones.U2 && h4.slope3 > 0.75) {
      blocked = true;
    }
  }

  let continuationScore = 0;

  if (isBull) {
    if (trendLong) continuationScore += 2;

    if (m15Zone === "LOWER_3") continuationScore += 5;
    else if (m15Zone === "LOWER_2") continuationScore += 4;
    else if (m15Zone === "LOWER_1") continuationScore += 3;
    else if (m15Zone === "MID") continuationScore += 1;

    if (m15.rising) continuationScore += 2;
    if (m15.reclaimFromLower) continuationScore += 2;
    if (m15.slope3 > 0) continuationScore += 1;

    if (anchorEdgeScore >= 2) continuationScore += 3;
    else if (anchorEdgeScore >= 1) continuationScore += 2;
    else if (anchorEdgeScore < 0) continuationScore += Math.floor(anchorEdgeScore);

    if (h1.slope3 > -1) continuationScore += 1;

    if (isUpperZone(m15Zone)) continuationScore -= 5;
  } else {
    if (trendShort) continuationScore += 2;

    if (m15Zone === "UPPER_3") continuationScore += 5;
    else if (m15Zone === "UPPER_2") continuationScore += 4;
    else if (m15Zone === "UPPER_1") continuationScore += 3;
    else if (m15Zone === "MID") continuationScore += 1;

    if (m15.falling) continuationScore += 2;
    if (m15.rejectionFromUpper) continuationScore += 2;
    if (m15.slope3 < 0) continuationScore += 1;

    if (anchorEdgeScore >= 2) continuationScore += 3;
    else if (anchorEdgeScore >= 1) continuationScore += 2;
    else if (anchorEdgeScore < 0) continuationScore += Math.floor(anchorEdgeScore);

    if (h1.slope3 < 1) continuationScore += 1;

    if (isLowerZone(m15Zone)) continuationScore -= 5;
  }

  continuationScore = clamp(continuationScore, 0, 10);

  const pullbackOK = isBull
    ? isLowerZone(m15Zone)
    : isUpperZone(m15Zone);

  const continuationOK = continuationScore >= 5;

  const exhaustion = isBull
    ? ["UPPER_2", "UPPER_3"].includes(m15Zone) && m15.slope3 > 0
    : ["LOWER_2", "LOWER_3"].includes(m15Zone) && m15.slope3 < 0;

  const perfectRsiSetup =
    pullbackOK &&
    anchorEdgeScore >= 2 &&
    (
      isBull
        ? m15Zone === "LOWER_2" || m15Zone === "LOWER_3" || m15.rising
        : m15Zone === "UPPER_2" || m15Zone === "UPPER_3" || m15.falling
    );

  return {
    valid: !blocked,

    // Backward-compatible
    strength,
    trend: isBull ? trendLong : trendShort,
    blocked,

    // WITTE lijn
    rsi: m15.rsi,

    // Blauwe anchor
    mean: m15.mean,
    mean1h: h1.mean,

    zones: m15.zones,

    // Extra
    zone: m15Zone,
    h1Zone,
    anchorZone,
    anchorEdgeScore,

    m15,
    h1,
    h4,

    h1Distance: h1.rsi - h1.mean,

    slope3: m15.slope3,
    fastSlope3: m15.fastSlope3,
    anchorSlope3: m15.anchorSlope3,

    rising: m15.rising,
    falling: m15.falling,

    pullbackOK,
    continuationOK,
    continuationOk: continuationOK,
    continuationScore,

    exhaustion,
    perfectRsiSetup,

    rsiWhite: m15.rsiWhite,
    rsiAnchorBlue: m15.rsiAnchorBlue,
    distanceFromMean: m15.distanceFromMean,
    whiteAboveAnchor: m15.whiteAboveAnchor,
    whiteBelowAnchor: m15.whiteBelowAnchor
  };
}

// ================= TYPE 1 =================
export function isType1RSIEntry(rsiCtx, side) {
  if (!rsiCtx?.valid) return false;

  const rsi = Number(rsiCtx.rsi);
  const zones = rsiCtx.zones;
  const zone = rsiCtx.zone || getZone(rsi, zones);

  if (!Number.isFinite(rsi) || !zones) return false;

  if (side === "bull") {
    return (
      zone === "LOWER_3" ||
      zone === "LOWER_2" ||
      (zone === "LOWER_1" && Number(rsiCtx.slope3 || 0) > 0)
    );
  }

  if (side === "bear") {
    return (
      zone === "UPPER_3" ||
      zone === "UPPER_2" ||
      (zone === "UPPER_1" && Number(rsiCtx.slope3 || 0) < 0)
    );
  }

  return false;
}

// Optional exports voor tests/debug
export {
  getZone,
  isLowerZone,
  isUpperZone,
  getDirectionalRank
};