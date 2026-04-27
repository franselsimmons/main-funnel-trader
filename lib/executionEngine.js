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

// ================= LIQUIDITY SWEEP =================
export function isLiquiditySweep(c, liquidity, side){

  const price = c.price;

  if(side === "bull"){
    return (
      liquidity?.support &&
      price < liquidity.support * 0.995
    );
  }

  if(side === "bear"){
    return (
      liquidity?.resistance &&
      price > liquidity.resistance * 1.005
    );
  }

  return false;
}