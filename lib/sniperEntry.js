export function getSniperEntry(c){

  const dir = c.side === "bear" ? -1 : 1;

  const ch1 = Number(c.change1h || 0) * dir;
  const ch24 = Number(c.change24 || 0) * dir;
  const range = Math.abs(Number(c.change24 || 0));

  const flow = String(c.flow || "NEUTRAL").toUpperCase();
  const position = Math.min(1, ch1 / Math.max(range, 0.01));

  // ================= HARD FILTERS =================

  if(ch1 <= 0){
    return { valid: false, type: "NO_DIRECTION", score: 0 };
  }
  if(ch24 < 3){
    return { valid: false, type: "NO_MOMENTUM", score: 0 };
  }
  if(flow === "NEUTRAL"){
    return { valid: false, type: "NO_FLOW", score: 0 };
  }
  if(ch1 >= 3){
    return { valid: false, type: "OVEREXTENDED", score: 0 };
  }
  if(position >= 0.9){
    return { valid: false, type: "LATE_MOVE", score: 0 };
  }

  // ================= ELITE CONTINUATION =================
  if(
    ch24 >= 6 &&
    ch1 >= 0.45 &&
    position >= 0.08 &&
    position <= 0.68 &&
    flow === "TREND"
  ){
    return { valid: true, type: "CONTINUATION", quality: "HIGH", score: 86 };
  }

  // ================= BUILDING CONTINUATION =================
  if(
    ch24 >= 4.5 &&
    ch1 >= 0.25 &&
    position <= 0.62 &&
    (flow === "TREND" || flow === "BUILDING")
  ){
    return { valid: true, type: "BUILDING_CONTINUATION", quality: "HIGH", score: 82 };
  }

  // ================= EARLY TREND =================
  if(
    ch24 >= 4 &&
    ch1 >= 0.18 &&
    position <= 0.50 &&
    (flow === "TREND" || flow === "BUILDING")
  ){
    return { valid: true, type: "EARLY_TREND", quality: "MEDIUM", score: 76 };
  }

  // ================= PULLBACK / RE-ENTRY =================
  if(
    ch24 >= 3.5 &&
    ch1 >= 0.08 &&
    position <= 0.32 &&
    (flow === "TREND" || flow === "BUILDING")
  ){
    return { valid: true, type: "PULLBACK_REENTRY", quality: "MEDIUM", score: 72 };
  }

  // ================= LATE BUT STILL TRADEABLE =================
  if(
    ch24 >= 5 &&
    ch1 >= 0.20 &&
    position <= 0.78 &&
    flow === "TREND"
  ){
    return { valid: true, type: "LATE_CONTINUATION", quality: "LOW", score: 68 };
  }

  return { valid: false, type: "WAIT", score: 0 };
}