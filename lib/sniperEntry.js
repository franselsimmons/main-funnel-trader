export function getSniperEntry(c){

  const dir = c.side === "bull" ? 1 : -1;

  const ch1 = (c.change1h || 0) * dir;
  const ch24 = (c.change24 || 0) * dir;

  const range = Math.abs(c.change24 || 0);

  // 🔥 dynamic overextension
  if(ch1 > (range * 0.35)){
    return { valid:false, type:"OVEREXTENDED" };
  }

  // 🔥 weak market
  if(ch24 < 3){
    return { valid:false, type:"NO_MOMENTUM" };
  }

  // ✅ PULLBACK (echter)
  if(
    ch24 > 6 &&
    ch1 > 0.2 &&
    ch1 < 1 &&
    c.flow !== "NEUTRAL"
  ){
    return {
      valid:true,
      type:"PULLBACK",
      quality: "HIGH"
    };
  }

  // ✅ CONTINUATION (sterk momentum maar niet top)
  if(
    ch24 > 8 &&
    ch1 > 0.5 &&
    ch1 < (range * 0.25)
  ){
    return {
      valid:true,
      type:"CONTINUATION",
      quality: "MEDIUM"
    };
  }

  return { valid:false, type:"WAIT" };
}