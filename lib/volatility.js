// ================= VOLATILITY ENGINE =================
// Compatibel met tradeSystem:
// - getVolatility(c) => "LOW" | "MEDIUM" | "HIGH"
// - getVolatilityRegime(c) => object met level/tpMultiplier/slMultiplier/trailPerc
//
// Doel:
// - Niet te streng, anders krijg je te weinig trades.
// - Wel beter dan alleen 1h/24h change.
// - Gebruikt ATR-data als die beschikbaar is vanuit tradeSystem/timeframe.
// - Fallback werkt gewoon met change1h/change24.

// ================= HELPERS =================
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function absNum(value, fallback = 0) {
  return Math.abs(num(value, fallback));
}

// ATR kan soms als decimal komen: 0.012 = 1.2%
// En soms als percentage: 1.2 = 1.2%
// Deze normalizer geeft altijd percentagepunten terug.
function normalizeAtrPct(value) {
  const n = absNum(value, 0);
  if (!n) return 0;

  // 0.012 => 1.2%
  if (n > 0 && n < 0.30) return n * 100;

  // 1.2 => 1.2%
  return n;
}

function getAtrComposite(c = {}) {
  const atr15 = normalizeAtrPct(c.atrPct15m);
  const atr1h = normalizeAtrPct(c.atrPct1h);
  const atr4h = normalizeAtrPct(c.atrPct4h);
  const atr24 = normalizeAtrPct(c.atrPct24h);

  const values = [];

  if (atr15 > 0) values.push({ value: atr15, weight: 0.40 });
  if (atr1h > 0) values.push({ value: atr1h, weight: 0.35 });
  if (atr4h > 0) values.push({ value: atr4h, weight: 0.15 });
  if (atr24 > 0) values.push({ value: atr24, weight: 0.10 });

  if (!values.length) return 0;

  const weightSum = values.reduce((sum, x) => sum + x.weight, 0);
  const weighted = values.reduce((sum, x) => sum + x.value * x.weight, 0);

  return weighted / weightSum;
}

function getVolatilityScore(c = {}) {
  const ch1 = absNum(c.change1h);
  const ch24 = absNum(c.change24);
  const vm = num(c.vm, 0);
  const moveScore = num(c.moveScore, 0);
  const atr = getAtrComposite(c);

  let score = 0;

  // 1h impulse
  if (ch1 >= 3.0) score += 35;
  else if (ch1 >= 2.0) score += 28;
  else if (ch1 >= 1.2) score += 20;
  else if (ch1 >= 0.65) score += 13;
  else if (ch1 >= 0.30) score += 7;
  else if (ch1 >= 0.12) score += 3;

  // 24h expansion
  if (ch24 >= 15) score += 30;
  else if (ch24 >= 10) score += 24;
  else if (ch24 >= 6) score += 17;
  else if (ch24 >= 3) score += 10;
  else if (ch24 >= 1.5) score += 5;

  // ATR expansion
  if (atr >= 4.0) score += 24;
  else if (atr >= 2.5) score += 18;
  else if (atr >= 1.5) score += 11;
  else if (atr >= 0.8) score += 6;
  else if (atr >= 0.4) score += 3;

  // Volume/mcap active participation
  if (vm >= 0.30) score += 10;
  else if (vm >= 0.18) score += 7;
  else if (vm >= 0.10) score += 4;
  else if (vm >= 0.05) score += 2;

  // Scanner already sees movement quality
  if (moveScore >= 90) score += 8;
  else if (moveScore >= 80) score += 5;
  else if (moveScore >= 70) score += 3;

  return clamp(Math.round(score), 0, 100);
}

function classifyVolatility(c = {}) {
  const ch1 = absNum(c.change1h);
  const ch24 = absNum(c.change24);
  const atr = getAtrComposite(c);
  const volScore = getVolatilityScore(c);

  // HIGH: echte expansion. Niet alleen 1 losse metric.
  if (
    volScore >= 58 ||
    ch1 >= 2.5 ||
    ch24 >= 10 ||
    atr >= 3.5
  ) {
    return "HIGH";
  }

  // LOW: alleen als alles rustig is.
  // Dit voorkomt dat een coin met rustige 24h maar nette 1h expansion onterecht LOW krijgt.
  if (
    volScore <= 18 &&
    ch1 < 0.25 &&
    ch24 < 1.5 &&
    atr < 0.75
  ) {
    return "LOW";
  }

  return "MEDIUM";
}

// ================= PUBLIC API =================

// Simpele label voor filters
export function getVolatility(c) {
  return classifyVolatility(c);
}

// Uitgebreid regime voor tradeSystem
export function getVolatilityRegime(c) {
  const level = classifyVolatility(c);
  const score = getVolatilityScore(c);
  const atrPct = getAtrComposite(c);

  if (level === "HIGH") {
    return {
      level: "HIGH",
      score,
      atrPct,

      // TP iets ruimer, SL iets ruimer.
      // Niet te agressief, want je riskManager bouwt al ATR-based SL/TP.
      tpMultiplier: 1.18,
      slMultiplier: 1.10,
      trailPerc: 0.45,

      // Handig voor logging/debug, breekt niks.
      entryAggression: "selective",
      reason: "VOL_EXPANSION"
    };
  }

  if (level === "LOW") {
    return {
      level: "LOW",
      score,
      atrPct,

      // LOW vol: TP compacter, SL ook compacter.
      // Je tradeSystem laat LOW alleen toe als confluence goed genoeg is.
      tpMultiplier: 0.90,
      slMultiplier: 0.90,
      trailPerc: 0.25,

      entryAggression: "strict",
      reason: "LOW_ACTIVITY"
    };
  }

  return {
    level: "MEDIUM",
    score,
    atrPct,

    tpMultiplier: 1.00,
    slMultiplier: 1.00,
    trailPerc: 0.30,

    entryAggression: "normal",
    reason: "NORMAL_ACTIVITY"
  };
}

// Optioneel bruikbaar voor dashboard/debug
export function getVolatilityDebug(c) {
  return {
    level: classifyVolatility(c),
    score: getVolatilityScore(c),
    atrPct: getAtrComposite(c),
    change1hAbs: absNum(c.change1h),
    change24Abs: absNum(c.change24),
    vm: num(c.vm, 0),
    moveScore: num(c.moveScore, 0)
  };
}