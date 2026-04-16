export function getMarketContext(btc, regime){

  if(regime === "HIGH_VOL" && btc.state === "BULLISH"){
    return "RISK_ON";
  }

  if(regime === "LOW_VOL"){
    return "RISK_OFF";
  }

  return "NEUTRAL";
}