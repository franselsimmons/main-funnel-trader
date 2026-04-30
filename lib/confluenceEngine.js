// ================= confluenceEngine.js (FINAL FIXED) =================
export function calculateConfluence(
  c,
  ob = {},
  liquidity = {},
  funding = { rate: 0 },
  regime = "MEDIUM",
  liquidation = null,
  rsiCtx = null
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

  if(ob?.spoof) score -= 20; // iets milder

  // ================= LIQUIDITY =================
  if(isBull){
    if(liquidity?.resistance && price < liquidity.resistance) score += 10;
    if(liquidity?.resistanceSweep && price < liquidity.resistanceSweep) score += 8;
  } else {
    if(liquidity?.support && price > liquidity.support) score += 10;
    if(liquidity?.supportSweep && price > liquidity.supportSweep) score += 8;
  }

  // ================= LIQUIDATIONS (SAFE MODE) =================
  let hasLiquidation = false;

  if(liquidation?.clusters?.length){
    hasLiquidation = true;

    for(const cl of liquidation.clusters){

      const clPrice = Number(cl.price || 0);
      if(!clPrice || !price) continue;

      const dist = Math.abs(price - clPrice) / price;
      if(dist > 0.025) continue;

      const total = Number(cl.longs || 0) + Number(cl.shorts || 0);
      if(total <= 0) continue;

      const longRatio = Number(cl.longs || 0) / total;
      const shortRatio = Number(cl.shorts || 0) / total;

      // Target liquidations
      if(isBull && clPrice > price && shortRatio > 0.55) score += 12;
      if(!isBull && clPrice < price && longRatio > 0.55) score += 12;

      // Protection zones
      if(isBull && clPrice < price && longRatio > 0.6) score += 4;
      if(!isBull && clPrice > price && shortRatio > 0.6) score += 4;
    }
  }

  // ✅ FIX: geen penalty bij missing data
  if(!hasLiquidation){
    score += 5; // kleine neutral boost i.p.v. implicit penalty
  }

  // ================= FUNDING (LESS HARSH) =================
  const rate = Number(funding?.rate || 0);

  if(isBull && rate < 0) score += 6;
  if(!isBull && rate > 0) score += 6;

  // minder straf voor extreme funding
  if(Math.abs(rate) > 0.015) score -= 5;

  // ================= VOLATILITY =================
  if(regime === "HIGH") score += 6;
  if(regime === "LOW") score -= 8;

  // ================= ANTI-STACKING (TUNED) =================
  if(c.flow === "TREND" && c.moveScore >= 90){
    score -= 4; // minder agressief
  }

  if(
    (liquidity?.resistance && liquidity?.resistanceSweep) ||
    (liquidity?.support && liquidity?.supportSweep)
  ){
    score -= 3;
  }

  // ================= RSI BOOST (IMPROVED) =================
  if(rsiCtx?.valid){
    const rsi = Number(rsiCtx.rsi || 50);
    const zones = rsiCtx.zones || {};

    if(isBull){
      if(rsi <= zones.L3) score += 14;
      else if(rsi <= zones.L2) score += 10;
      else if(rsi <= zones.L1) score += 6;
    }else{
      if(rsi >= zones.U3) score += 14;
      else if(rsi >= zones.U2) score += 10;
      else if(rsi >= zones.U1) score += 6;
    }
  } else {
    // ✅ FIX: RSI missing → geen kill
    score += 3;
  }

  // ================= FINAL NORMALIZATION =================
  return Math.max(0, Math.min(Math.round(score), 100));
}