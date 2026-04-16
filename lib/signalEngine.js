const prev = new Map();

export function generateSignals(coins){

  const out = [];

  for(const c of coins){

    const p = prev.get(c.symbol);

    let signal = "NONE";

    if(c.stage === "ENTRY" && c.moveScore >= 85){
      signal = "ENTRY";
    }

    else if(p && (p === "ENTRY" || p === "HOLD")){
      if(c.stage !== "RADAR"){
        signal = "HOLD";
      } else {
        signal = "EXIT";
      }
    }

    prev.set(c.symbol, signal);

    if(signal !== "NONE"){
      out.push({
        symbol:c.symbol,
        signal,
        stage:c.stage,
        score:c.moveScore
      });
    }
  }

  return out;
}