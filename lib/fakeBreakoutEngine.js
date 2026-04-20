// ================= FAKE BREAKOUT DETECTION =================

export function detectFakeBreakout(c, liq){

  const price = c.price;
  const isBull = c.side === "bull";

  // 🔥 bull trap (top kopen)
  if(isBull && price > liq.shortLiq){
    return true;
  }

  // 🔥 bear trap (bottom shorten)
  if(!isBull && price < liq.longLiq){
    return true;
  }

  return false;
}