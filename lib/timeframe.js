function safeNumber(value){
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max){
  return Math.max(min, Math.min(max, value));
}

export function multiTFScore(c){

  const side = String(c?.side || "bull").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch1 = safeNumber(c?.change1h) * dir;
  const ch24 = safeNumber(c?.change24) * dir;
  const freshness = safeNumber(c?.freshness);
  const vm = safeNumber(c?.vm);
  const flow = String(c?.flow || "NEUTRAL").toUpperCase();

  let raw = 0;

  // ================= PRICE ALIGNMENT =================
  // Zacht genoeg zodat scanner funnel niet leegloopt,
  // maar nog steeds richting bevestigt.
  if(ch1 > 0.05) raw += 1;
  if(ch1 > 0.20) raw += 1;
  if(ch1 > 0.45) raw += 1;
  if(ch1 > 1.00) raw += 1;

  if(ch24 > 0.50) raw += 1;
  if(ch24 > 1.50) raw += 1;
  if(ch24 > 2.50) raw += 1;
  if(ch24 > 4.00) raw += 1;

  // ================= FLOW BONUS =================
  if(flow === "BUILDING") raw += 1;
  if(flow === "TREND") raw += 2;

  // ================= FRESHNESS BONUS =================
  if(freshness >= 5) raw += 1;
  if(freshness >= 10) raw += 1;
  if(freshness >= 16) raw += 1;

  // ================= LIQUIDITY BONUS =================
  if(vm >= 0.04) raw += 1;
  if(vm >= 0.08) raw += 1;

  // ================= COMPRESS TO FILTER LEVEL =================
  // Output blijft compact zodat bull/bear filters logisch blijven:
  // 0 = radar/buildup mogelijk
  // 1 = almost kwaliteit
  // 2 = entry kwaliteit
  // 3 = elite entry
  let level = 0;

  if(raw >= 12) level = 3;
  else if(raw >= 8) level = 2;
  else if(raw >= 4) level = 1;
  else level = 0;

  return side === "bear"
    ? -level
    : level;
}