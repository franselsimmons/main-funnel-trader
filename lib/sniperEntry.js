export function getSniperEntry(c){

  const dir = c.side === "bull" ? 1 : -1;

  const ch1 = (c.change1h || 0) * dir;
  const ch24 = (c.change24 || 0) * dir;

  const range = Math.abs(c.change24 || 0);

  // 🔥 FILTERS iets soepeler
  if(ch24 < 4) return { valid:false };
  if(c.flow === "NEUTRAL") return { valid:false };
  if(ch1 > 1.8) return { valid:false };

  const position = Math.min(1, ch1 / (range || 1));

  // 🔥 CONTINUATION (main)
  if(
    ch24 > 6 &&
    ch1 > 0.3 &&
    position < 0.6
  ){
    return {
      valid:true,
      type:"CONTINUATION",
      score:80
    };
  }

  // 🔥 EXTRA ENTRY (meer trades)
  if(
    ch24 > 5 &&
    ch1 > 0.2 &&
    position < 0.4
  ){
    return {
      valid:true,
      type:"EARLY_TREND",
      score:75
    };
  }

  return { valid:false };
}