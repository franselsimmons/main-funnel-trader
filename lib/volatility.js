// ================= VOLATILITY REGIME =================

export function getVolatilityRegime(c){

  const vol = Math.abs(c.change24 || 0);

  if(vol > 10) return "HIGH";
  if(vol > 5) return "MEDIUM";
  return "LOW";
}