// ================= CONFLUENCE ENGINE =================

export function calculateConfluence(c, ob, liq, funding){

  let score = 0;

  // ================= FLOW =================
  if(c.flow === "TREND") score += 25;
  if(c.flow === "BUILDING") score += 15;

  // ================= MOMENTUM =================
  if(c.moveScore > 85) score += 20;
  else if(c.moveScore > 75) score += 10;

  // ================= ORDERBOOK =================
  if(c.side === "bull" && ob.bias === "BULLISH") score += 15;
  if(c.side === "bear" && ob.bias === "BEARISH") score += 15;

  if(ob.spoof) score -= 20;

  // ================= LIQUIDITY =================
  if(c.side === "bull" && c.price < liq.resistance){
    score += 10; // ruimte omhoog
  }

  if(c.side === "bear" && c.price > liq.support){
    score += 10;
  }

  // sweep zone = hoge kans
  if(c.side === "bull" && c.price < liq.resistanceSweep){
    score += 10;
  }

  if(c.side === "bear" && c.price > liq.supportSweep){
    score += 10;
  }

  // ================= FUNDING =================
  if(funding){

    // bullish maar funding negatief → short squeeze
    if(c.side === "bull" && funding.rate < 0){
      score += 10;
    }

    // bearish maar funding positief → long squeeze
    if(c.side === "bear" && funding.rate > 0){
      score += 10;
    }

    // verkeerde kant → penalty
    if(c.side === "bull" && funding.rate > 0.05){
      score -= 10;
    }

    if(c.side === "bear" && funding.rate < -0.05){
      score -= 10;
    }
  }

  return Math.max(0, Math.min(score, 100));
}