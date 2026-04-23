export function getSniperEntry(c){

  const dir = c.side === "bear" ? -1 : 1;

  const ch1 = Number(c.change1h || 0) * dir;
  const ch24 = Number(c.change24 || 0) * dir;
  const range = Math.abs(Number(c.change24 || 0));

  const flow = String(c.flow || "NEUTRAL").toUpperCase();
  const position = Math.min(1, ch1 / Math.max(range, 0.01));

  // ================= HARD FILTERS =================

  // slechte richting
  if(ch1 <= 0){
    return {
      valid: false,
      type: "NO_DIRECTION",
      score: 0
    };
  }

  // te weinig totaal momentum
  if(ch24 < 3){
    return {
      valid: false,
      type: "NO_MOMENTUM",
      score: 0
    };
  }

  // geen duidelijke flow
  if(flow === "NEUTRAL"){
    return {
      valid: false,
      type: "NO_FLOW",
      score: 0
    };
  }

  // veel te snelle move in 1h = vaak late chase
  if(ch1 >= 3){
    return {
      valid: false,
      type: "OVEREXTENDED",
      score: 0
    };
  }

  // bijna hele 24h move al in laatste uur gebeurd
  if(position >= 0.9){
    return {
      valid: false,
      type: "LATE_MOVE",
      score: 0
    };
  }

  // ================= ELITE CONTINUATION =================
  // sterke trend, maar nog niet te laat

  if(
    ch24 >= 6 &&
    ch1 >= 0.45 &&
    position >= 0.08 &&
    position <= 0.68 &&
    flow === "TREND"
  ){
    return {
      valid: true,
      type: "CONTINUATION",
      quality: "HIGH",
      score: 84
    };
  }

  // ================= BUILDING CONTINUATION =================
  // trend bouwt op, nog voor de echte versnelling

  if(
    ch24 >= 4.5 &&
    ch1 >= 0.25 &&
    position <= 0.62 &&
    (flow === "TREND" || flow === "BUILDING")
  ){
    return {
      valid: true,
      type: "BUILDING_CONTINUATION",
      quality: "HIGH",
      score: 80
    };
  }

  // ================= EARLY TREND =================
  // verse continuation, liever vroeger dan te laat

  if(
    ch24 >= 4 &&
    ch1 >= 0.18 &&
    position <= 0.50 &&
    (flow === "TREND" || flow === "BUILDING")
  ){
    return {
      valid: true,
      type: "EARLY_TREND",
      quality: "MEDIUM",
      score: 76
    };
  }

  // ================= PULLBACK / RE-ENTRY =================
  // kleine reset binnen bestaande move, mag iets ruimer

  if(
    ch24 >= 3.5 &&
    ch1 >= 0.08 &&
    position <= 0.32 &&
    (flow === "TREND" || flow === "BUILDING")
  ){
    return {
      valid: true,
      type: "PULLBACK_REENTRY",
      quality: "MEDIUM",
      score: 72
    };
  }

  // ================= LATE BUT STILL TRADEABLE =================
  // geen topkwaliteit, maar wel bruikbaar als confluence sterk is

  if(
    ch24 >= 5 &&
    ch1 >= 0.20 &&
    position <= 0.78 &&
    flow === "TREND"
  ){
    return {
      valid: true,
      type: "LATE_CONTINUATION",
      quality: "LOW",
      score: 68
    };
  }

  return {
    valid: false,
    type: "WAIT",
    score: 0
  };
}