// ================= RSI FILTER =================

export function getRsiZoneDynamic(rsi, zones){

  if(!zones) return "MID";

  if(rsi >= zones.U3) return "UPPER_3";
  if(rsi >= zones.U2) return "UPPER_2";
  if(rsi >= zones.U1) return "UPPER_1";

  if(rsi <= zones.L3) return "LOWER_3";
  if(rsi <= zones.L2) return "LOWER_2";
  if(rsi <= zones.L1) return "LOWER_1";

  return "MID";
}

// 🔥 NIET MEER TE STRICT
export function isRsiAligned(isBull, zone){

  if(!zone) return true;

  // LONG → liever lower zones, maar MID ook ok
  if(isBull){
    return zone.startsWith("LOWER") || zone === "MID";
  }

  // SHORT → liever upper zones, maar MID ook ok
  return zone.startsWith("UPPER") || zone === "MID";
}