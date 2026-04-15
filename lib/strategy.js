export function chooseStrategy(volatility, dominance){

  if(volatility === "EXTREME") return "SCALP_FAST";

  if(volatility === "HIGH") return "SCALP";

  if(dominance === "BTC_STRONG") return "DEFENSIVE";

  if(dominance === "ALTS_STRONG") return "AGGRESSIVE";

  return "SWING";
}