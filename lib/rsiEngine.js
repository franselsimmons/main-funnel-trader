// ================= RSI ENGINE (PRO + MTF + SLOPE + CONTINUATION) =================
// Doel:
// - Non-blocking RSI context
// - Betere trend-continuation detectie
// - Minder binaire MID-blocks
// - Backward-compatible met tradeSystem.js:
//   gebruikt nog steeds: valid, strength, trend, blocked, rsi, zones, mean1h

// ================= CONFIG =================
const RSI_LENGTH = 14;
const RSI_SMOOTH = 14;
const RSI_FAST = 5;
const RSI_MEAN = 55;
const MIN_CANDLES = 80;

const ZONE_1 = 12; // U1 62 / L1 38
const ZONE_2 = 20; // U2 70 / L2 30
const ZONE_3 = 28; // U3 78 / L3 22

// ================= HELPERS =================
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function last(arr, fallback = null) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : fallback;
}

function ema(values, length) {
  if (!Array.isArray(values) || values.length === 0) return [];

  const k = 2 / (length + 1);
  const out = [];
  let prev = safeNumber(values[0], 0);

  for (let i = 0; i < values.length; i++) {
    const val = safeNumber(values[i], prev);
    prev = i === 0 ? val : (val * k + prev * (1 - k));
    out.push(prev);
  }

  return out;
}

function getSlope(values, bars = 3) {
  if (!Array.isArray(values) || values.length <= bars) return 0;

  const now = values[values.length - 1];
  const prev = values[values.length - 1 - bars];

  return safeNumber(now - prev, 0);
}

function getZone(rsi, zones) {
  if (!Number.isFinite(Number(rsi)) || !zones) return "MID";

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

// ================= RSI CALC =================
function rsiCalc(closes, length = RSI_LENGTH) {
  if (!Array.isArray(closes) || closes.length < length + 2) return [];

  const gains = [];
  const losses = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = safeNumber(closes[i], 0) - safeNumber(closes[i - 1], 0);
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  const avgGain = ema(gains, length);
  const avgLoss = ema(losses, length);

  const rsi = [];

  for (let i = 0; i < avgGain.length; i++) {
    const gain = safeNumber(avgGain[i], 0);
    const loss = safeNumber(avgLoss[i], 0);

    if (loss === 0 && gain === 0) {
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
    rsi.push(100 - (100 / (1 + rs)));
  }

  return rsi;
}

// ================= CORE RSI CONTEXT =================
export function getAdvancedRSIContext(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    return { valid: false };
  }

  const closes = candles
    .map(c => safeNumber(c?.close, 0))
    .filter(v => v > 0);

  if (closes.length < MIN_CANDLES) {
    return { valid: false };
  }

  const rsiRaw = rsiCalc(closes, RSI_LENGTH);

  if (rsiRaw.length < 20) {
    return { valid: false };
  }

  const rsiSmooth = ema(rsiRaw, RSI_SMOOTH);
  const rsiFast = ema(rsiRaw, RSI_FAST);
  const rsiMeanArr = ema(rsiSmooth, RSI_MEAN);

  const rsi = last(rsiSmooth, 50);
  const fast = last(rsiFast, rsi);
  const mean = last(rsiMeanArr, 50);

  const slope1 = getSlope(rsiSmooth, 1);
  const slope3 = getSlope(rsiSmooth, 3);
  const fastSlope3 = getSlope(rsiFast, 3);

  const zones = {
    U1: 50 + ZONE_1,
    U2: 50 + ZONE_2,
    U3: 50 + ZONE_3,
    L1: 50 - ZONE_1,
    L2: 50 - ZONE_2,
    L3: 50 - ZONE_3
  };

  const zone = getZone(rsi, zones);

  const recent = rsiSmooth.slice(-20);
  const recentHigh = recent.length ? Math.max(...recent) : rsi;
  const recentLow = recent.length ? Math.min(...recent) : rsi;
  const range20 = recentHigh - recentLow;

  const distanceFromMean = rsi - mean;

  const rising = slope3 > 0.75 || fastSlope3 > 1.0;
  const falling = slope3 < -0.75 || fastSlope3 < -1.0;

  const reclaimFromLower =
    (zone === "LOWER_1" || zone === "MID") &&
    fast > rsi &&
    slope3 > 0;

  const rejectionFromUpper =
    (zone === "UPPER_1" || zone === "MID") &&
    fast < rsi &&
    slope3 < 0;

  return {
    valid: true,

    // Backward-compatible
    rsi,
    mean,
    zones,

    // Extra context
    fast,
    zone,
    slope1,
    slope3,
    fastSlope3,
    rising,
    falling,
    reclaimFromLower,
    rejectionFromUpper,
    distanceFromMean,
    range20,

    // Debug
    recentHigh,
    recentLow
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
  const h1Distance = h1.rsi - h1.mean;

  // Soft HTF trend
  const trendLong = h1.rsi > (h1.mean - 5);
  const trendShort = h1.rsi < (h1.mean + 5);

  // Hard HTF block alleen bij extreme mismatch
  let blocked = false;

  if (h4?.valid) {
    if (isBull && h4.rsi < 35 && h4.slope3 < 0) blocked = true;
    if (!isBull && h4.rsi > 65 && h4.slope3 > 0) blocked = true;
  }

  let strength = 0;

  if (isBull) {
    if (m15.rsi <= m15.zones.L3) strength = 3;
    else if (m15.rsi <= m15.zones.L2) strength = 2;
    else if (m15.rsi <= m15.zones.L1) strength = 1;
  } else {
    if (m15.rsi >= m15.zones.U3) strength = 3;
    else if (m15.rsi >= m15.zones.U2) strength = 2;
    else if (m15.rsi >= m15.zones.U1) strength = 1;
  }

  // Continuation-score: gebruikt door tradeSystem als je hem wilt toevoegen
  let continuationScore = 0;

  if (isBull) {
    if (trendLong) continuationScore += 2;
    if (m15Zone === "MID") continuationScore += 1;
    if (m15Zone === "LOWER_1") continuationScore += 2;
    if (m15.rising) continuationScore += 2;
    if (m15.reclaimFromLower) continuationScore += 2;
    if (h1.slope3 > -1) continuationScore += 1;
    if (isUpperZone(m15Zone)) continuationScore -= 4;
  } else {
    if (trendShort) continuationScore += 2;
    if (m15Zone === "MID") continuationScore += 1;
    if (m15Zone === "UPPER_1") continuationScore += 2;
    if (m15.falling) continuationScore += 2;
    if (m15.rejectionFromUpper) continuationScore += 2;
    if (h1.slope3 < 1) continuationScore += 1;
    if (isLowerZone(m15Zone)) continuationScore -= 4;
  }

  continuationScore = clamp(continuationScore, 0, 10);

  const pullbackOK = isBull
    ? ["LOWER_1", "LOWER_2", "LOWER_3"].includes(m15Zone)
    : ["UPPER_1", "UPPER_2", "UPPER_3"].includes(m15Zone);

  const continuationOK = continuationScore >= 5;

  const exhaustion = isBull
    ? ["UPPER_2", "UPPER_3"].includes(m15Zone) && m15.slope3 > 0
    : ["LOWER_2", "LOWER_3"].includes(m15Zone) && m15.slope3 < 0;

  return {
    valid: !blocked,

    // Backward-compatible
    strength,
    trend: isBull ? trendLong : trendShort,
    blocked,
    rsi: m15.rsi,
    zones: m15.zones,
    mean1h: h1.mean,

    // Extra
    zone: m15Zone,
    m15,
    h1,
    h4,
    h1Distance,
    slope3: m15.slope3,
    fastSlope3: m15.fastSlope3,
    rising: m15.rising,
    falling: m15.falling,
    pullbackOK,
    continuationOK,
    continuationScore,
    exhaustion
  };
}

// ================= TYPE 1 =================
export function isType1RSIEntry(rsiCtx, side) {
  if (!rsiCtx?.valid) return false;

  const rsi = Number(rsiCtx.rsi);
  const zones = rsiCtx.zones;

  if (!Number.isFinite(rsi) || !zones) return false;

  if (side === "bull") {
    return (
      rsi <= zones.L2 + 6 ||
      (rsi <= zones.L1 + 4 && Number(rsiCtx.slope3 || 0) > 0)
    );
  }

  if (side === "bear") {
    return (
      rsi >= zones.U2 - 6 ||
      (rsi >= zones.U1 - 4 && Number(rsiCtx.slope3 || 0) < 0)
    );
  }

  return false;
}