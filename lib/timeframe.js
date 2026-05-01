// ================= TIMEFRAME ENGINE =================
// Scanner MTF-context zonder echte candles.
// Geeft:
// - score: signed tf score voor bull/bear filters
// - strength: abs(score)
// - alignment: BULLISH / BEARISH / NEUTRAL
// - atrPct15m/1h/4h/24h als DECIMAL, niet als percentagepunt
//
// Voorbeeld:
// 0.012 = 1.2%
// 0.0012 = 0.12%

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pctToDecimal(pct) {
  return Number(pct || 0) / 100;
}

function estimateAtrPcts({ ch1Abs, ch24Abs, freshness, vm }) {
  // Eerst in percentagepunten berekenen.
  const atr15Pct = clamp(
    (ch1Abs * 0.28) + (freshness * 0.02) + (vm * 0.9),
    0.12,
    2.50
  );

  const atr1hPct = clamp(
    Math.max(ch1Abs * 0.85, atr15Pct * 1.45),
    0.20,
    4.00
  );

  const atr4hPct = clamp(
    Math.max(ch24Abs * 0.30, atr1hPct * 1.60),
    0.40,
    7.50
  );

  const atr24hPct = clamp(
    Math.max(ch24Abs * 0.65, atr4hPct * 1.80),
    0.80,
    16.00
  );

  // Belangrijk: output als decimal voor compatibility met volatility/risk logic.
  return {
    atrPct15m: pctToDecimal(atr15Pct),
    atrPct1h: pctToDecimal(atr1hPct),
    atrPct4h: pctToDecimal(atr4hPct),
    atrPct24h: pctToDecimal(atr24hPct),

    // Debugvelden, handig voor dashboard/logs.
    atrPct15mDisplay: atr15Pct,
    atrPct1hDisplay: atr1hPct,
    atrPct4hDisplay: atr4hPct,
    atrPct24hDisplay: atr24hPct
  };
}

export function buildTimeframeContext(c) {
  const side = String(c?.side || "bull").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch1Raw = safeNumber(c?.change1h);
  const ch24Raw = safeNumber(c?.change24);

  const ch1 = ch1Raw * dir;
  const ch24 = ch24Raw * dir;

  const ch1Abs = Math.abs(ch1Raw);
  const ch24Abs = Math.abs(ch24Raw);

  const freshness = safeNumber(c?.freshness);
  const vm = safeNumber(c?.vm);
  const flow = String(c?.flow || "NEUTRAL").toUpperCase();

  let raw = 0;

  // ================= PRICE ALIGNMENT =================
  if (ch1 > 0.02) raw += 1;
  if (ch1 > 0.12) raw += 1;
  if (ch1 > 0.30) raw += 1;
  if (ch1 > 0.75) raw += 1;

  if (ch24 > 0.25) raw += 1;
  if (ch24 > 0.80) raw += 1;
  if (ch24 > 1.80) raw += 1;
  if (ch24 > 3.50) raw += 1;

  // ================= FLOW BONUS =================
  if (flow === "BUILDING") raw += 1;
  if (flow === "TREND") raw += 2;

  // ================= FRESHNESS BONUS =================
  if (freshness >= 4) raw += 1;
  if (freshness >= 9) raw += 1;
  if (freshness >= 15) raw += 1;

  // ================= LIQUIDITY / PARTICIPATION BONUS =================
  if (vm >= 0.03) raw += 1;
  if (vm >= 0.06) raw += 1;

  // ================= PENALTIES =================
  if (ch1 <= 0 && ch24 <= 0) raw -= 2;
  if (flow === "NEUTRAL" && freshness < 4) raw -= 1;

  // Extra penalty tegen late exhausted moves:
  // hoge 24h move, maar weinig 1h continuation.
  if (ch24 > 8 && ch1 < 0.20) raw -= 2;
  if (ch24 > 12 && ch1 < 0.35) raw -= 2;

  // Extra penalty tegen directionele mismatch.
  if (side === "bull" && ch1Raw < 0 && ch24Raw < 0) raw -= 2;
  if (side === "bear" && ch1Raw > 0 && ch24Raw > 0) raw -= 2;

  // ================= LEVEL =================
  // 0 = radar
  // 1 = buildup / almost
  // 2 = scanner-entry kandidaat
  // 3 = elite scanner kandidaat
  let level = 0;

  if (raw >= 11) level = 3;
  else if (raw >= 7) level = 2;
  else if (raw >= 3) level = 1;

  const signedScore = side === "bear"
    ? -level
    : level;

  const alignment =
    level <= 0
      ? "NEUTRAL"
      : side === "bear"
        ? "BEARISH"
        : "BULLISH";

  const atr = estimateAtrPcts({
    ch1Abs,
    ch24Abs,
    freshness,
    vm
  });

  return {
    score: signedScore,
    strength: Math.abs(signedScore),
    rawScore: raw,
    alignment,
    side,

    ch1,
    ch24,
    ch1Raw,
    ch24Raw,
    ch1Abs,
    ch24Abs,

    freshness,
    vm,
    flow,

    ...atr
  };
}

export function multiTFScore(c) {
  return buildTimeframeContext(c).score;
}