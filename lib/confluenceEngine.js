export function calculateConfluence(c, ob, liq, funding, regime){

  let score = 0;

  const isBull = c.side === "bull";

  // ================= FLOW =================
  if(c.flow === "TREND") score += 25;
  else if(c.flow === "BUILDING") score += 15;

  // ================= MOMENTUM =================
  if(c.moveScore > 90) score += 25;
  else if(c.moveScore > 80) score += 15;

  // ================= ORDERBOOK =================
  if(isBull && ob.bias === "BULLISH") score += 15;
  if(!isBull && ob.bias === "BEARISH") score += 15;

  if(ob.spoof) score -= 30;

  // ================= LIQUIDATION =================
  if(isBull && c.price < liq.shortLiq) score += 15;
  if(!isBull && c.price > liq.longLiq) score += 15;

  // ================= FUNDING =================
  if(funding){
    if(isBull && funding.rate < 0) score += 10;
    if(!isBull && funding.rate > 0) score += 10;
  }

  // ================= VOL REGIME =================
  if(regime === "HIGH") score += 5;
  if(regime === "LOW") score -= 10;

  return Math.max(0, Math.min(score, 100));
}