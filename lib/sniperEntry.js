export function getSniperEntry(c){

  const dir = c.side === "bull" ? 1 : -1;

  const ch1 = (c.change1h || 0) * dir;
  const ch24 = (c.change24 || 0) * dir;

  // ❌ overextension
  if(ch1 > 2.5){
    return { valid:false, type:"OVEREXTENDED" };
  }

  // ✅ pullback entry
  if(ch24 > 5 && ch1 > 0.3 && ch1 < 1.5){
    return { valid:true, type:"PULLBACK" };
  }

  // ✅ continuation
  if(ch24 > 8 && ch1 > 0.5 && ch1 < 2){
    return { valid:true, type:"CONTINUATION" };
  }

  return { valid:false, type:"WAIT" };
}