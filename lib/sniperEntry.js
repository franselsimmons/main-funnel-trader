export function getSniperEntry(c){

  const dir = c.side === "bull" ? 1 : -1;

  const ch1 = Number(c.change1h || 0) * dir;
  const ch24 = Number(c.change24 || 0) * dir;

  const range = Math.abs(Number(c.change24 || 0));

  // ================= HARD FILTERS =================

  // te weinig momentum
  if(ch24 < 4){
    return {
      valid:false,
      type:"NO_MOMENTUM",
      score:0
    };
  }

  // geen flow
  if(c.flow === "NEUTRAL"){
    return {
      valid:false,
      type:"NO_FLOW",
      score:0
    };
  }

  // niet kopen/shorten na te snelle 1h move
  if(ch1 > 1.8){
    return {
      valid:false,
      type:"OVEREXTENDED",
      score:0
    };
  }

  // slechte richting
  if(ch1 <= 0){
    return {
      valid:false,
      type:"NO_DIRECTION",
      score:0
    };
  }

  const position = Math.min(1, ch1 / (range || 1));

  // ================= MAIN CONTINUATION =================

  if(
    ch24 > 6 &&
    ch1 > 0.3 &&
    position < 0.6
  ){
    return {
      valid:true,
      type:"CONTINUATION",
      quality:"HIGH",
      score:80
    };
  }

  // ================= EARLY TREND =================

  if(
    ch24 > 5 &&
    ch1 > 0.2 &&
    position < 0.4
  ){
    return {
      valid:true,
      type:"EARLY_TREND",
      quality:"MEDIUM",
      score:75
    };
  }

  // ================= PULLBACK / RE-ENTRY =================
  // iets soepeler, bedoeld om niet alles te missen na kleine reset

  if(
    ch24 > 4 &&
    ch1 > 0.15 &&
    position < 0.35
  ){
    return {
      valid:true,
      type:"PULLBACK_REENTRY",
      quality:"MEDIUM",
      score:70
    };
  }

  return {
    valid:false,
    type:"WAIT",
    score:0
  };
}