function safeNumber(value){
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max){
  return Math.max(min, Math.min(max, value));
}

function estimateAtrPcts({ ch1Abs, ch24Abs, freshness, vm }){

  const atrPct15m = clamp(
    (ch1Abs * 0.28) + (freshness * 0.02) + (vm * 0.9),
    0.12,
    2.50
  );

  const atrPct1h = clamp(
    Math.max(ch1Abs * 0.85, atrPct15m * 1.45),
    0.20,
    4.00
  );

  const atrPct4h = clamp(
    Math.max((ch24Abs * 0.30), atrPct1h * 1.60),
    0.40,
    7.50
  );

  const atrPct24h = clamp(
    Math.max(ch24Abs * 0.65, atrPct4h * 1.80),
    0.80,
    16.00
  );

  return {
    atrPct15m,
    atrPct1h,
    atrPct4h,
    atrPct24h
  };
}

export function buildTimeframeContext(c){

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
  // Iets soepeler zodat funnel niet leegloopt
  if(ch1 > 0.02) raw += 1;
  if(ch1 > 0.12) raw += 1;
  if(ch1 > 0.30) raw += 1;
  if(ch1 > 0.75) raw += 1;

  if(ch24 > 0.25) raw += 1;
  if(ch24 > 0.80) raw += 1;
  if(ch24 > 1.80) raw += 1;
  if(ch24 > 3.50) raw += 1;

  // ================= FLOW BONUS =================
  if(flow === "BUILDING") raw += 1;
  if(flow === "TREND") raw += 2;

  // ================= FRESHNESS BONUS =================
  if(freshness >= 4) raw += 1;
  if(freshness >= 9) raw += 1;
  if(freshness >= 15) raw += 1;

  // ================= LIQUIDITY BONUS =================
  if(vm >= 0.03) raw += 1;
  if(vm >= 0.06) raw += 1;

  // ================= LEVEL =================
  // 0 = radar
  // 1 = buildup/almost
  // 2 = entry
  // 3 = elite
  let level = 0;

  if(raw >= 11) level = 3;
  else if(raw >= 7) level = 2;
  else if(raw >= 3) level = 1;
  else level = 0;

  const signedScore = side === "bear"
    ? -level
    : level;

  const alignment =
    level <= 0
      ? "NEUTRAL"
      : side === "bear"
        ? "BEARISH"
        : "BULLISH";

  return {
    score: signedScore,
    strength: Math.abs(signedScore),
    rawScore: raw,
    alignment,
    side,
    ...estimateAtrPcts({
      ch1Abs,
      ch24Abs,
      freshness,
      vm
    })
  };
}

export function multiTFScore(c){
  return buildTimeframeContext(c).score;
}