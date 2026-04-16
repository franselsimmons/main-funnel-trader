export function shouldEnter(c, flow, risk){

  if(!risk.allowEntry) return false;

  if(c.stage !== "ENTRY") return false;

  if(flow.type === "EXHAUSTION") return false;

  if(c.moveScore < 85) return false;

  return true;
}

export function shouldAdd(c, pos, risk){

  if(!pos) return false;

  if(c.moveScore < 90) return false;

  if(pos.adds >= risk.maxAdds) return false;

  return true;
}

export function shouldExit(c, flow){

  if(flow.type === "EXHAUSTION") return true;

  if(Math.abs(c.change1h) < 0.2) return true;

  if(c.stage === "RADAR") return true;

  return false;
}