// ================= SUPER SIGNAL ENGINE =================

function isStrong(c){
  return c.moveScore >= 85;
}

function isValid(c){
  return c.moveScore >= 70;
}

function isWeak(c){
  return c.moveScore < 60;
}

function momentumLost(c){
  return Math.abs(c.change1h) < 0.2;
}

function liquidityBad(c){
  return !c.ob || c.ob.score < 0.04;
}

function stageDrop(c, prevStage){
  const order = ["RADAR","BUILDUP","ALMOST","ENTRY"];
  return order.indexOf(c.stage) < order.indexOf(prevStage);
}

// ================= MAIN =================

export function generateSignals(coins, prevState = new Map()){

  const signals = [];

  for(const c of coins){

    const prev = prevState.get(c.symbol);

    // ================= ENTRY =================
    if(c.stage === "ENTRY" && isValid(c)){

      signals.push({
        symbol: c.symbol,
        signal: "ENTRY",
        reason: "Strong setup + ENTRY stage",
        strength: isStrong(c) ? "strong" : "normal"
      });

      continue;
    }

    // ================= HOLD =================
    if(prev && prev.signal === "ENTRY"){

      if(
        !momentumLost(c) &&
        !liquidityBad(c) &&
        !stageDrop(c, prev.stage)
      ){
        signals.push({
          symbol: c.symbol,
          signal: "HOLD",
          reason: "Trade still valid",
          strength: isStrong(c) ? "strong" : "normal"
        });
        continue;
      }
    }

    // ================= EXIT =================
    if(prev && prev.signal === "ENTRY"){

      signals.push({
        symbol: c.symbol,
        signal: "EXIT",
        reason: "Invalidation detected",
        strength: "weak"
      });

      continue;
    }

    // ================= DEFAULT =================
    signals.push({
      symbol: c.symbol,
      signal: "NONE",
      reason: "No setup",
      strength: "weak"
    });
  }

  return signals;
}