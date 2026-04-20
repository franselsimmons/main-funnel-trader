export function getSniperEntry(c){

  const dir = c.side === "bull" ? 1 : -1;

  const ch1 = (c.change1h || 0) * dir;
  const ch24 = (c.change24 || 0) * dir;

  const range = Math.abs(c.change24 || 0);
  const volFactor = Math.max(1, range / 5);

  const overExt = 1.8 * volFactor;
  const continuationMax = 1.2 * volFactor;

  if(ch1 > overExt){
    return { valid:false, type:"OVEREXTENDED" };
  }

  if(ch24 < 4){
    return { valid:false, type:"NO_MOMENTUM" };
  }

  if(c.flow !== "TREND"){
    return { valid:false, type:"NO_FLOW" };
  }

  const position = Math.min(1, ch1 / (range || 1));

  // 🔥 BEST ONLY (winrate ↑)
  if(
    ch24 > 7 &&
    ch1 > 0.5 &&
    ch1 < continuationMax &&
    position < 0.5
  ){
    return {
      valid:true,
      type:"CONTINUATION",
      score:85
    };
  }

  return { valid:false, type:"WAIT" };
}