export function analyzeOrderBook(ob, side){

  if(!ob){
    return {
      bias:"NEUTRAL",
      strength:0
    };
  }

  const score = ob.score || 0;
  const spread = ob.spreadPct || 0;

  let bias = "NEUTRAL";
  let strength = 0;

  // ===== BULL =====
  if(side === "bull"){

    if(score > 0.07 && spread < 0.1){
      bias = "BULLISH";
      strength = 1;
    }

    if(score < 0.04){
      bias = "WEAK";
    }
  }

  // ===== BEAR =====
  if(side === "bear"){

    if(score < 0.04 && spread > 0.08){
      bias = "BEARISH";
      strength = 1;
    }

    if(score > 0.07){
      bias = "RESISTANCE";
    }
  }

  return {
    bias,
    strength,
    spread
  };
}