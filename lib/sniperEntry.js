export function getSniperEntry(c){

  const dir = c.side === "bull" ? 1 : -1;

  const ch1 = (c.change1h || 0) * dir;
  const ch24 = (c.change24 || 0) * dir;

  const range = Math.abs(c.change24 || 0);

  // 🔥 HARD FILTERS
  if(ch24 < 5) return { valid:false };
  if(c.flow !== "TREND") return { valid:false };
  if(ch1 > 1.5) return { valid:false };

  const position = Math.min(1, ch1 / (range || 1));

  // 🔥 ONLY CONTINUATION
  if(
    ch24 > 7 &&
    ch1 > 0.4 &&
    position < 0.5
  ){
    return {
      valid:true,
      type:"CONTINUATION",
      score:90
    };
  }

  return { valid:false };
}