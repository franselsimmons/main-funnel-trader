// ================= CONFLUENCE ENGINE (OPTIMIZED) =================

export function calculateConfluence(
  c,
  ob = {},
  liquidity = {},
  funding = { rate: 0 },
  regime = "MEDIUM",
  liquidation = null,
  rsiCtx = null // 🔥 NIEUW (optioneel)
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
  else if(c.moveScore >= 65) score += 10; // 🔥 iets verhoogd

  // ================= ORDERBOOK =================
  if(isBull && ob?.bias === "BULLISH") score += 15;
  if(!isBull && ob?.bias === "BEARISH") score += 15;

  if(ob?.bias === "NEUTRAL") score += 4; // 🔥 NIEUW → neutraal is niet slecht

  if(ob?.spoof) score -= 20; // 🔥 minder hard (was -25)

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
      if(dist > 0.03) continue; // 🔥 iets ruimer (was 0.025)

      const total = Number(cl.longs || 0) + Number(cl.shorts || 0);
      if(total <= 0) continue;

      const longRatio = Number(cl.longs || 0) / total;
      const shortRatio = Number(cl.shorts || 0) / total;

      if(isBull && clPrice > price && shortRatio > 0.55) score += 15;
      if(!isBull && clPrice < price && longRatio > 0.55) score += 15;

      if(isBull && clPrice < price && longRatio > 0.6) score += 6; // 🔥 +1
      if(!isBull && clPrice > price && shortRatio > 0.6) score += 6;
    }
  }

  // ================= FUNDING =================
  const rate = Number(funding?.rate || 0);

  if(isBull && rate < 0) score += 8;
  if(!isBull && rate > 0) score += 8;

  if(Math.abs(rate) > 0.015) score -= 6; // 🔥 minder streng

  // ================= VOL =================
  if(regime === "HIGH") score += 5;
  if(regime === "LOW") score -= 8; // 🔥 minder straf

  // ================= RSI BOOST (🔥 NIEUW) =================
  if(rsiCtx?.valid){

    const rsi = rsiCtx.rsi;
    const { U1, U2, U3, L1, L2, L3 } = rsiCtx.zones;

    // LONG
    if(isBull){
      if(rsi <= L3) score += 10;       // extreme
      else if(rsi <= L2) score += 7;
      else if(rsi <= L1) score += 4;
    }

    // SHORT
    if(!isBull){
      if(rsi >= U3) score += 10;
      else if(rsi >= U2) score += 7;
      else if(rsi >= U1) score += 4;
    }
  }

  // ================= ANTI-STACKING (SMARTER) =================
  if(c.flow === "TREND" && c.moveScore >= 85){
    score -= 4; // 🔥 minder agressief
  }

  if(
    (liquidity?.resistance && liquidity?.resistanceSweep) ||
    (liquidity?.support && liquidity?.supportSweep)
  ){
    score -= 3; // 🔥 minder straf
  }

  // ================= SOFT FLOOR BOOST =================
  // voorkomt dat goede setups net onder threshold vallen
  if(score >= 45 && score < 55){
    score += 3;
  }

  return Math.max(0, Math.min(score, 100));
}