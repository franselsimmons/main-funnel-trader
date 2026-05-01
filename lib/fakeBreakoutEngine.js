// fakeBreakoutEngine.js
// Sweep/reclaim detectie op basis van liquidation zones + liquidity zones + 15m candles.
// Werkt met liquidationEngine.js output: nearestAbove, nearestBelow, majorAbove, majorBelow, longZones, shortZones, clusters.

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctDistance(a, b) {
  const x = safeNumber(a);
  const y = safeNumber(b);

  if (!x || !y) return Infinity;

  return Math.abs(x - y) / y;
}

function hasZoneNearPrice(price, zone, maxDistPct = 0.018) {
  if (!price || !zone) return false;
  return pctDistance(price, zone) <= maxDistPct;
}

function getRecentHighLow(candles, lookback = 20) {
  const list = Array.isArray(candles) ? candles.slice(-lookback) : [];

  if (list.length < 5) {
    return {
      high: null,
      low: null,
      lastClose: null
    };
  }

  const highs = list
    .map(c => safeNumber(c.high))
    .filter(Boolean);

  const lows = list
    .map(c => safeNumber(c.low))
    .filter(Boolean);

  const last = list[list.length - 1];

  return {
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
    lastClose: safeNumber(last?.close, null)
  };
}

function zoneListHasNearPrice(zones, price, maxDistPct) {
  if (!Array.isArray(zones) || !zones.length) return false;

  return zones.some(z => hasZoneNearPrice(price, z, maxDistPct));
}

export function detectFakeBreakout(c, liquidation = null, liquidity = null, candles15m = [], options = {}) {
  const price = safeNumber(c?.price);
  const side = String(c?.side || "").toLowerCase();
  const isBull = side === "bull";

  if (!price || (side !== "bull" && side !== "bear")) {
    return {
      valid: false,
      type: "INVALID_INPUT",
      score: 0,
      zone: null,
      price
    };
  }

  const maxZoneDistPct = safeNumber(options.maxZoneDistPct, 0.018);
  const reclaimBufferPct = safeNumber(options.reclaimBufferPct, 0.0015);

  const recent = getRecentHighLow(candles15m, 20);

  const support = safeNumber(liquidity?.support);
  const resistance = safeNumber(liquidity?.resistance);

  const nearestBelow = safeNumber(liquidation?.nearestBelow);
  const nearestAbove = safeNumber(liquidation?.nearestAbove);
  const majorBelow = safeNumber(liquidation?.majorBelow);
  const majorAbove = safeNumber(liquidation?.majorAbove);

  let score = 0;
  let type = "NONE";
  let zone = null;

  if (isBull) {
    const sweepZone = majorBelow || nearestBelow || support;
    const reclaimLevel = support || nearestBelow || majorBelow;

    const sweptBelow =
      Boolean(recent.low) &&
      Boolean(sweepZone) &&
      recent.low <= sweepZone * (1 - reclaimBufferPct);

    const reclaimed =
      Boolean(reclaimLevel) &&
      price >= reclaimLevel * (1 + reclaimBufferPct);

    const nearZone =
      hasZoneNearPrice(price, sweepZone, maxZoneDistPct) ||
      hasZoneNearPrice(price, reclaimLevel, maxZoneDistPct);

    if (sweptBelow && reclaimed) {
      score += 70;
      type = "BULLISH_SWEEP_RECLAIM";
      zone = sweepZone;
    } else if (sweptBelow && nearZone) {
      score += 45;
      type = "BULLISH_SWEEP_PENDING_RECLAIM";
      zone = sweepZone;
    }

    if (zoneListHasNearPrice(liquidation?.longZones, price, maxZoneDistPct)) {
      score += 10;
    }

    if (support && price > support) {
      score += 10;
    }
  }

  if (!isBull) {
    const sweepZone = majorAbove || nearestAbove || resistance;
    const rejectLevel = resistance || nearestAbove || majorAbove;

    const sweptAbove =
      Boolean(recent.high) &&
      Boolean(sweepZone) &&
      recent.high >= sweepZone * (1 + reclaimBufferPct);

    const rejected =
      Boolean(rejectLevel) &&
      price <= rejectLevel * (1 - reclaimBufferPct);

    const nearZone =
      hasZoneNearPrice(price, sweepZone, maxZoneDistPct) ||
      hasZoneNearPrice(price, rejectLevel, maxZoneDistPct);

    if (sweptAbove && rejected) {
      score += 70;
      type = "BEARISH_SWEEP_REJECT";
      zone = sweepZone;
    } else if (sweptAbove && nearZone) {
      score += 45;
      type = "BEARISH_SWEEP_PENDING_REJECT";
      zone = sweepZone;
    }

    if (zoneListHasNearPrice(liquidation?.shortZones, price, maxZoneDistPct)) {
      score += 10;
    }

    if (resistance && price < resistance) {
      score += 10;
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    valid: score >= 60,
    type,
    score,
    zone,
    price,
    recentHigh: recent.high,
    recentLow: recent.low,
    nearestAbove,
    nearestBelow,
    majorAbove,
    majorBelow
  };
}