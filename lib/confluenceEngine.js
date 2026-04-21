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

  // ================= LIQUIDITY RANGE =================
  // Werkt met liquidityEngine.js
  if(isBull){

    if(liquidity?.resistance && price < liquidity.resistance){
      score += 10;
    }

    if(liquidity?.resistanceSweep && price < liquidity.resistanceSweep){
      score += 10;
    }

  }else{

    if(liquidity?.support && price > liquidity.support){
      score += 10;
    }

    if(liquidity?.supportSweep && price > liquidity.supportSweep){
      score += 10;
    }
  }

  // ================= REAL LIQUIDATION DATA =================
  // Werkt met liquidationEngine.js
  if(liquidation?.clusters?.length){

    for(const cl of liquidation.clusters){

      const clPrice = Number(cl.price || 0);
      if(!clPrice || !price) continue;

      const dist = Math.abs(price - clPrice) / price;

      // alleen relevante zones dichtbij
      if(dist > 0.025) continue;

      const total = Number(cl.longs || 0) + Number(cl.shorts || 0);
      if(total <= 0) continue;

      const longRatio = Number(cl.longs || 0) / total;
      const shortRatio = Number(cl.shorts || 0) / total;

      // Bull zoekt short liquidations boven prijs
      if(isBull && clPrice > price && shortRatio > 0.55){
        score += 15;
      }

      // Bear zoekt long liquidations onder prijs
      if(!isBull && clPrice < price && longRatio > 0.55){
        score += 15;
      }

      // Extra bescherming/support
      if(isBull && clPrice < price && longRatio > 0.6){
        score += 5;
      }

      // Extra weerstand voor bear
      if(!isBull && clPrice > price && shortRatio > 0.6){
        score += 5;
      }
    }
  }

  // ================= FUNDING =================
  const rate = Number(funding?.rate || 0);

  // Bull + negatieve funding = short squeeze kans
  if(isBull && rate < 0){
    score += 8;
  }

  // Bear + positieve funding = long squeeze kans
  if(!isBull && rate > 0){
    score += 8;
  }

  // Extreme funding = gevaar
  if(Math.abs(rate) > 0.01){
    score -= 8;
  }

  // ================= VOL REGIME =================
  if(regime === "HIGH") score += 5;
  if(regime === "LOW") score -= 10;

  return Math.max(0, Math.min(score, 100));
}