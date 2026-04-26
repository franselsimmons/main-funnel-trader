// ================= CONFLUENCE ENGINE =================

export function calculateConfluence(
  c,
  ob = {},
  liquidity = {},
  funding = { rate: 0 },
  regime = "MEDIUM",
  liquidation = null
){

  let score = 0;

  const isBull = c.side === "bull";
  const price = Number(c.price || 0);

  // ================= FLOW =================
  if(c.flow === "TREND") score += 25;
  else if(c.flow === "BUILDING") score += 15;

  // ================= MOMENTUM =================
  if(c.moveScore >= 90) score += 25;
  else if(c.moveScore >= 85) score += 20;
  else if(c.moveScore >= 75) score += 15;
  else if(c.moveScore >= 65) score += 8;

  // ================= ORDERBOOK =================
  if(isBull && ob?.bias === "BULLISH") score += 15;
  if(!isBull && ob?.bias === "BEARISH") score += 15;

  if(ob?.spoof) score -= 25;

  // ================= LIQUIDITY =================
  if(isBull){
    if(liquidity?.resistance && price < liquidity.resistance) score += 10;
    if(liquidity?.resistanceSweep && price < liquidity.resistanceSweep) score += 10;
  } else {
    if(liquidity?.support && price > liquidity.support) score += 10;
    if(liquidity?.supportSweep && price > liquidity.supportSweep) score += 10;
  }

  // ================= LIQUIDATIONS =================
  if(liquidation?.clusters?.length){
    for(const cl of liquidation.clusters){

      const clPrice = Number(cl.price || 0);
      if(!clPrice || !price) continue;

      const dist = Math.abs(price - clPrice) / price;
      if(dist > 0.025) continue;

      const total = Number(cl.longs || 0) + Number(cl.shorts || 0);
      if(total <= 0) continue;

      const longRatio = Number(cl.longs || 0) / total;
      const shortRatio = Number(cl.shorts || 0) / total;

      if(isBull && clPrice > price && shortRatio > 0.55) score += 15;
      if(!isBull && clPrice < price && longRatio > 0.55) score += 15;

      if(isBull && clPrice < price && longRatio > 0.6) score += 5;
      if(!isBull && clPrice > price && shortRatio > 0.6) score += 5;
    }
  }

  // ================= FUNDING =================
  const rate = Number(funding?.rate || 0);

  if(isBull && rate < 0) score += 8;
  if(!isBull && rate > 0) score += 8;

  if(Math.abs(rate) > 0.01) score -= 8;

  // ================= VOL =================
  if(regime === "HIGH") score += 5;
  if(regime === "LOW") score -= 10;

  // ================= 🔥 ANTI-STACKING =================
  if(c.flow === "TREND" && c.moveScore >= 85){
    score -= 10;
  }

  if(
    (liquidity?.resistance && liquidity?.resistanceSweep) ||
    (liquidity?.support && liquidity?.supportSweep)
  ){
    score -= 5;
  }

  return Math.max(0, Math.min(score, 100));
}