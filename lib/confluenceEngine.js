// ================= CONFLUENCE ENGINE =================

export function calculateConfluence(c, ob, liq, funding){

  let score = 0;

  // ================= FLOW =================
  if(c.flow === "TREND") score += 25;
  else if(c.flow === "BUILDING") score += 15;

  // ================= MOMENTUM =================
  if(c.moveScore > 90) score += 25;
  else if(c.moveScore > 80) score += 15;
  else if(c.moveScore > 70) score += 10;

  // ================= ORDERBOOK =================
  if(c.side === "bull" && ob.bias === "BULLISH") score += 15;
  if(c.side === "bear" && ob.bias === "BEARISH") score += 15;

  // spoof = heavy penalty
  if(ob.spoof) score -= 25;

  // ================= LIQUIDITY =================
  if(c.side === "bull"){
    if(c.price < liq.resistance) score += 10;
    if(c.price < liq.resistanceSweep) score += 10;
  }

  if(c.side === "bear"){
    if(c.price > liq.support) score += 10;
    if(c.price > liq.supportSweep) score += 10;
  }

  // ================= FUNDING =================
  if(funding){

    const rate = Number(funding.rate || 0);

    // squeeze setups
    if(c.side === "bull" && rate < 0) score += 10;
    if(c.side === "bear" && rate > 0) score += 10;

    // extreme funding = danger
    if(rate > 0.08) score -= 15;
    if(rate < -0.08) score -= 15;
  }

  return Math.max(0, Math.min(score, 100));
}