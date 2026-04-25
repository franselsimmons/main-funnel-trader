// ================= CONFLUENCE ENGINE (IMPROVED) =================

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
  if(c.flow === "TREND") score += 20;
  else if(c.flow === "BUILDING") score += 10;

  // ================= MOMENTUM (LICHT VERLAAGD) =================
  if(c.moveScore >= 90) score += 20;
  else if(c.moveScore >= 85) score += 16;
  else if(c.moveScore >= 75) score += 12;
  else if(c.moveScore >= 65) score += 6;

  // ================= ORDERBOOK =================
  if(isBull && ob?.bias === "BULLISH") score += 12;
  if(!isBull && ob?.bias === "BEARISH") score += 12;

  if(ob?.spoof) score -= 20;

  // ================= LIQUIDITY (GECLUST, GEEN DOUBLE STACK) =================
  let liquidityScore = 0;

  if(isBull){
    if(liquidity?.resistance && price < liquidity.resistance){
      liquidityScore += 8;
    }
    if(liquidity?.resistanceSweep && price < liquidity.resistanceSweep){
      liquidityScore += 6;
    }
  }else{
    if(liquidity?.support && price > liquidity.support){
      liquidityScore += 8;
    }
    if(liquidity?.supportSweep && price > liquidity.supportSweep){
      liquidityScore += 6;
    }
  }

  score += Math.min(liquidityScore, 12); // cap voorkomt stacking

  // ================= LIQUIDATION (BELANGRIJKSTE FIX) =================
  let bestLiquidationScore = 0;

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

      let localScore = 0;

      if(isBull && clPrice > price && shortRatio > 0.55){
        localScore = 12;
      }

      if(!isBull && clPrice < price && longRatio > 0.55){
        localScore = 12;
      }

      if(isBull && clPrice < price && longRatio > 0.6){
        localScore = 5;
      }

      if(!isBull && clPrice > price && shortRatio > 0.6){
        localScore = 5;
      }

      // 🔥 alleen beste cluster telt
      if(localScore > bestLiquidationScore){
        bestLiquidationScore = localScore;
      }
    }
  }

  score += bestLiquidationScore;

  // ================= FUNDING (SMOOTHER) =================
  const rate = Number(funding?.rate || 0);

  if(isBull && rate < 0){
    score += 6;
  }

  if(!isBull && rate > 0){
    score += 6;
  }

  if(Math.abs(rate) > 0.01){
    score -= 6;
  }

  // ================= REGIME =================
  if(regime === "HIGH") score += 5;
  if(regime === "LOW") score -= 8;

  return Math.max(0, Math.min(score, 100));
}