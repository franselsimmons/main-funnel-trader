// ================= VOLATILITY ENGINE =================

// Simpele label voor filters
export function getVolatility(c){

  const ch24 = Math.abs(Number(c.change24 || 0));
  const ch1 = Math.abs(Number(c.change1h || 0));

  // Niet te streng maken, anders krijg je snel 0 trades.
  if(ch24 < 2 && ch1 < 0.35){
    return "LOW";
  }

  if(ch24 > 10 || ch1 > 2.5){
    return "HIGH";
  }

  return "MEDIUM";
}


// Uitgebreid regime voor tradeSystem
export function getVolatilityRegime(c){

  const ch24 = Math.abs(Number(c.change24 || 0));
  const ch1 = Math.abs(Number(c.change1h || 0));

  let level = "MEDIUM";

  if(ch24 < 2 && ch1 < 0.35){
    level = "LOW";
  }

  if(ch24 > 10 || ch1 > 2.5){
    level = "HIGH";
  }

  if(level === "HIGH"){
    return {
      level: "HIGH",
      tpMultiplier: 1.25,
      slMultiplier: 1.15,
      trailPerc: 0.45
    };
  }

  if(level === "LOW"){
    return {
      level: "LOW",
      tpMultiplier: 0.85,
      slMultiplier: 0.85,
      trailPerc: 0.25
    };
  }

  return {
    level: "MEDIUM",
    tpMultiplier: 1,
    slMultiplier: 1,
    trailPerc: 0.30
  };
}