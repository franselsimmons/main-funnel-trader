export function generateSignals(trades){

  const out = [];

  for(const t of trades){

    if(t.action === "ENTRY"){
      out.push({
        symbol:t.symbol,
        signal:"ENTRY",
        entry:t.entry,
        sl:t.sl,
        tp:t.tp,
        rr:t.rr,
        reason:t.reason
      });
    }

    if(t.action === "PARTIAL_TP"){
      out.push({
        symbol:t.symbol,
        signal:"PARTIAL",
        reason:"Secure profit"
      });
    }

    if(t.action === "EXIT"){
      out.push({
        symbol:t.symbol,
        signal:"EXIT",
        reason:t.reason
      });
    }
  }

  return out;
}