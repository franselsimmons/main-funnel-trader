export function getSniperEntry(c){

  const dir = c.side === "bull" ? 1 : -1;

  const ch1 = (c.change1h || 0) * dir;
  const ch24 = (c.change24 || 0) * dir;

  const range = Math.abs(c.change24 || 0);
  const volFactor = Math.max(1, range / 5);

  const overExt = 1.8 * volFactor;
  const pullbackMax = 0.8 * volFactor;
  const continuationMax = 1.2 * volFactor;

  if(ch1 > overExt){
    return { valid:false, type:"OVEREXTENDED" };
  }

  if(ch24 < 3){
    return { valid:false, type:"NO_MOMENTUM" };
  }

  if(c.flow === "NEUTRAL"){
    return { valid:false, type:"NO_FLOW" };
  }

  const position = Math.min(1, ch1 / (range || 1));

  if(ch24 > 6 && ch1 > 0.2 && ch1 < pullbackMax && position < 0.35){
    return { valid:true, type:"PULLBACK", score:90 };
  }

  if(ch24 > 8 && ch1 > 0.4 && ch1 < continuationMax && position < 0.6){
    return { valid:true, type:"CONTINUATION", score:75 };
  }

  if(ch24 > 12 && ch1 < overExt && position < 0.8){
    return { valid:true, type:"LATE_TREND", score:60 };
  }

  return { valid:false, type:"WAIT" };
}