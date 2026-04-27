// ================= RSI CALCULATION =================
export function calculateRSI(candles, period = 14){

  if(!Array.isArray(candles) || candles.length < period + 1){
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for(let i = candles.length - period; i < candles.length; i++){

    const prev = Number(candles[i - 1]?.close || 0);
    const curr = Number(candles[i]?.close || 0);

    const diff = curr - prev;

    if(diff >= 0){
      gains += diff;
    }else{
      losses -= diff;
    }
  }

  const rs = gains / (losses || 1);
  const rsi = 100 - (100 / (1 + rs));

  return Number.isFinite(rsi) ? rsi : 50;
}


// ================= RSI ZONES =================
export function getRsiZone(rsi){

  const r = Number(rsi || 50);

  if(r >= 72) return "UPPER_3";
  if(r >= 64) return "UPPER_2";
  if(r >= 57) return "UPPER_1";

  if(r <= 28) return "LOWER_3";
  if(r <= 36) return "LOWER_2";
  if(r <= 44) return "LOWER_1";

  return "MID";
}


// ================= ALIGNMENT =================
export function isRsiAligned(isBull, rsiZone){

  if(!rsiZone) return false;

  if(isBull){
    return rsiZone.startsWith("LOWER");
  }

  return rsiZone.startsWith("UPPER");
}