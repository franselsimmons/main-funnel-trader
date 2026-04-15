export function btcDominance(btcCap,totalCap){

  if(!btcCap || !totalCap) return "NEUTRAL";

  const d = btcCap / totalCap;

  if(d > 0.55) return "BTC_STRONG";
  if(d < 0.45) return "ALTS_STRONG";

  return "NEUTRAL";
}