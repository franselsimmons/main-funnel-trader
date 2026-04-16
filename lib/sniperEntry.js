export function getSniperEntry(c){

  const ch1 = Math.abs(c.change1h || 0);
  const ch24 = Math.abs(c.change24 || 0);

  const dir = c.side === "bull" ? 1 : -1;

  const move1h = (c.change1h || 0) * dir;
  const move24 = (c.change24 || 0) * dir;

  let valid = false;
  let type = "WAIT";
  let reason = "none";

  // ❌ OVEREXTENDED (geldt voor beide)
  if(move1h > 2.5){
    return {
      valid:false,
      type:"OVEREXTENDED",
      reason:"too_fast"
    };
  }

  // ===== BULL =====
  if(c.side === "bull"){

    // pullback entry
    if(move24 > 5 && move1h > 0.3 && move1h < 1.5){
      valid = true;
      type = "SNIPER";
      reason = "bull_pullback";
    }

    // continuation
    if(move24 > 8 && move1h > 0.5 && move1h < 2){
      valid = true;
      type = "SNIPER";
      reason = "bull_continuation";
    }
  }

  // ===== BEAR =====
  if(c.side === "bear"){

    // dump continuation
    if(move24 > 5 && move1h > 0.3 && move1h < 1.5){
      valid = true;
      type = "SNIPER";
      reason = "bear_continuation";
    }

    // bounce short
    if(move24 > 8 && move1h < 1.2){
      valid = true;
      type = "SNIPER";
      reason = "bear_bounce_short";
    }
  }

  return {
    valid,
    type,
    reason
  };
}