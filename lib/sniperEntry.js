export function getSniperEntry(c){

  const dir = c.side === "bull" ? 1 : -1;

  const ch1 = (c.change1h || 0) * dir;
  const ch24 = (c.change24 || 0) * dir;

  const range = Math.abs(c.change24 || 0);

  // 🔥 volatility proxy (hoe groter move, hoe meer ruimte)
  const volFactor = Math.max(1, range / 5);

  // 🔥 dynamic thresholds
  const overExt = 1.8 * volFactor;
  const pullbackMax = 0.8 * volFactor;
  const continuationMax = 1.2 * volFactor;

  // ================= ❌ HARD FILTERS =================

  // overextended → nooit kopen
  if(ch1 > overExt){
    return { valid:false, type:"OVEREXTENDED" };
  }

  // geen echte move → geen trade
  if(ch24 < 3){
    return { valid:false, type:"NO_MOMENTUM" };
  }

  // slechte flow
  if(c.flow === "NEUTRAL"){
    return { valid:false, type:"NO_FLOW" };
  }

  // ================= 🔥 STRUCTURE LOGIC =================

  // position in move (0 = start, 1 = top)
  const position = Math.min(1, ch1 / (range || 1));

  // ================= ✅ PERFECT PULLBACK =================
  // move groot + retrace + opnieuw push

  if(
    ch24 > 6 &&
    ch1 > 0.2 &&
    ch1 < pullbackMax &&
    position < 0.35
  ){
    return {
      valid:true,
      type:"PULLBACK",
      quality:"HIGH",
      score: 90
    };
  }

  // ================= ✅ CONTINUATION =================
  // sterke trend maar niet top

  if(
    ch24 > 8 &&
    ch1 > 0.4 &&
    ch1 < continuationMax &&
    position < 0.6
  ){
    return {
      valid:true,
      type:"CONTINUATION",
      quality:"MEDIUM",
      score: 75
    };
  }

  // ================= ⚠️ LATE ENTRY =================
  // mag alleen bij extreme trend

  if(
    ch24 > 12 &&
    ch1 < overExt &&
    position < 0.8
  ){
    return {
      valid:true,
      type:"LATE_TREND",
      quality:"LOW",
      score: 60
    };
  }

  // ================= ❌ NO ENTRY =================

  return {
    valid:false,
    type:"WAIT"
  };
}