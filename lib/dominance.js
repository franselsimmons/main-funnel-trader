export function btcDominance(btcMarketCap, totalMarketCap){

  if(!btcMarketCap || !totalMarketCap) return "NEUTRAL";

  const dom = btcMarketCap / totalMarketCap;

  if(dom > 0.55) return "BTC_STRONG";
  if(dom < 0.45) return "ALTS_STRONG";

  return "NEUTRAL";
}