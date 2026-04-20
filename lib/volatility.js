// ================= VOLATILITY ENGINE (FINAL) =================

// 🔥 simpele label (voor filters)
export function getVolatility(c){

  const vol = Math.abs(c.change24 || 0);

  if(vol > 10) return "HIGH";
  if(vol > 5) return "MEDIUM";
  return "LOW";
}


// 🔥 uitgebreid regime (voor tradeSystem)
export function getVolatilityRegime(c){

  const vol = Math.abs(c.change24 || 0);

  if(vol > 12){
    return {
      level: "HIGH",
      tpMultiplier: 1.3,
      slMultiplier: 1.2,
      trailPerc: 0.5
    };
  }

  if(vol > 6){
    return {
      level: "MEDIUM",
      tpMultiplier: 1,
      slMultiplier: 1,
      trailPerc: 0.35
    };
  }

  return {
    level: "LOW",
    tpMultiplier: 0.8,
    slMultiplier: 0.8,
    trailPerc: 0.25
  };
}