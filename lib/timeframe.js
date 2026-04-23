function safeNumber(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max){
  return Math.max(min, Math.min(max, value));
}

function getDirectionMultiplier(side){
  return String(side || "").toLowerCase() === "bear"
    ? -1
    : 1;
}

function directionalValue(value, side){
  return safeNumber(value) * getDirectionMultiplier(side);
}

function absPct(value){
  return Math.abs(safeNumber(value));
}

function derive15mChange(change1h, change24){
  const ch1 = safeNumber(change1h);
  const ch24 = safeNumber(change24);

  const projected = ch1 * 0.38;
  const capped = clamp(projected, -Math.max(0.25, Math.abs(ch24)), Math.max(0.25, Math.abs(ch24)));

  return capped;
}

function derive4hChange(change1h, change24){
  const ch1 = safeNumber(change1h);
  const ch24 = safeNumber(change24);

  const projected = ch1 * 2.2;
  const hardCap = Math.max(Math.abs(ch24) * 1.15, 2.5);

  return clamp(projected, -hardCap, hardCap);
}

function deriveAtrPct15m(c){
  const abs1h = absPct(c.change1h);
  const vm = safeNumber(c.vm);

  return clamp(
    0.18 + (abs1h * 0.42) + (vm * 1.25),
    0.18,
    5.5
  );
}

function deriveAtrPct1h(c){
  const abs1h = absPct(c.change1h);
  const abs24h = absPct(c.change24);
  const vm = safeNumber(c.vm);

  return clamp(
    0.28 + (abs1h * 0.85) + (abs24h * 0.06) + (vm * 1.75),
    0.28,
    8.5
  );
}

function deriveAtrPct4h(c){
  const abs1h = absPct(c.change1h);
  const abs24h = absPct(c.change24);
  const vm = safeNumber(c.vm);

  return clamp(
    0.55 + (abs1h * 1.45) + (abs24h * 0.18) + (vm * 2.2),
    0.55,
    12
  );
}

function deriveAtrPct24h(c){
  const abs24h = absPct(c.change24);
  const vm = safeNumber(c.vm);

  return clamp(
    1 + (abs24h * 0.35) + (vm * 3),
    1,
    20
  );
}

export function buildTimeframeContext(c = {}){
  const side = String(c.side || "bull").toLowerCase();

  const m15 = directionalValue(derive15mChange(c.change1h, c.change24), side);
  const h1 = directionalValue(c.change1h, side);
  const h4 = directionalValue(derive4hChange(c.change1h, c.change24), side);
  const h24 = directionalValue(c.change24, side);

  let score = 0;

  if(m15 > 0.12) score += 1;
  else if(m15 < -0.12) score -= 1;

  if(h1 > 0.35) score += 2;
  else if(h1 > 0.10) score += 1;
  else if(h1 < -0.35) score -= 2;
  else if(h1 < -0.10) score -= 1;

  if(h4 > 1.0) score += 2;
  else if(h4 > 0.35) score += 1;
  else if(h4 < -1.0) score -= 2;
  else if(h4 < -0.35) score -= 1;

  if(h24 > 5) score += 3;
  else if(h24 > 3) score += 2;
  else if(h24 > 1) score += 1;
  else if(h24 < -5) score -= 3;
  else if(h24 < -3) score -= 2;
  else if(h24 < -1) score -= 1;

  const alignedCount = [m15, h1, h4, h24].filter(v => v > 0).length;
  const oppositeCount = [m15, h1, h4, h24].filter(v => v < 0).length;

  if(alignedCount >= 4) score += 1;
  if(oppositeCount >= 3) score -= 1;

  let alignment = "MIXED";
  if(alignedCount >= 4 && score >= 5) alignment = "STRONG";
  else if(alignedCount >= 3 && score >= 2) alignment = "GOOD";
  else if(oppositeCount >= 3 || score <= -2) alignment = "WEAK";

  const atrPct15m = deriveAtrPct15m(c);
  const atrPct1h = deriveAtrPct1h(c);
  const atrPct4h = deriveAtrPct4h(c);
  const atrPct24h = deriveAtrPct24h(c);

  return {
    m15,
    h1,
    h4,
    h24,
    score,
    alignedCount,
    oppositeCount,
    alignment,
    atrPct15m,
    atrPct1h,
    atrPct4h,
    atrPct24h
  };
}

export function multiTFScore(c){
  return buildTimeframeContext(c).score;
}

export function getAtrContext(c){
  const ctx = buildTimeframeContext(c);

  return {
    atrPct15m: ctx.atrPct15m,
    atrPct1h: ctx.atrPct1h,
    atrPct4h: ctx.atrPct4h,
    atrPct24h: ctx.atrPct24h
  };
}

export function isMultiTfAligned(c, minScore = 2){
  const ctx = buildTimeframeContext(c);
  return ctx.score >= minScore;
}