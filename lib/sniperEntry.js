import { detectWallPersistence, detectAbsorption, detectSpoofing } from "./institutional.js";
import { getOrderbookHistory } from "./orderbookMemory.js";

export function getSniperEntry(c, ob, rsiSignal) {
  const symbol = c.symbol;
  const dir = c.side === "bear" ? -1 : 1;

  const history = getOrderbookHistory(symbol);
  const walls = detectWallPersistence(history);
  const absorption = detectAbsorption(c, history);
  const spoof = detectSpoofing(history);

  const rsi = Number(rsiSignal?.rsi || 50);
  const rsiOK = rsiSignal?.valid;

  // ================= SPOOF FILTER =================
  if (spoof.spoof) {
    return { valid: false, type: "SPOOF_DETECTED", score: 0 };
  }

  // ================= ELITE SETUPS =================
  if (dir === 1 && absorption.absorbingBids && walls.bidWallStrong && rsiOK) {
    return { valid: true, type: "INSTITUTIONAL_LONG", quality: "ELITE", score: 95 };
  }

  if (dir === -1 && absorption.absorbingAsks && walls.askWallStrong && rsiOK) {
    return { valid: true, type: "INSTITUTIONAL_SHORT", quality: "ELITE", score: 95 };
  }

  // ================= FALLBACK SCORING =================
  let score = 0;

  const confluence = Number(c.confluence || 0);
  const flow = c.flow || "NEUTRAL";

  // 🔥 base
  score += confluence * 0.5;

  // 🔥 flow
  if (flow === "TREND") score += 10;
  if (flow === "BUILDING") score += 5;

  // 🔥 orderbook bias
  if (dir === 1 && ob.bias === "BULLISH") score += 10;
  if (dir === -1 && ob.bias === "BEARISH") score += 10;

  if (dir === 1 && ob.bias === "BEARISH") score -= 10;
  if (dir === -1 && ob.bias === "BULLISH") score -= 10;

  // 🔥 walls light influence (niet alleen ELITE)
  if (walls.bidWallStrong || walls.askWallStrong) score += 5;

  // 🔥 RSI softer logic
  if (rsiOK) {
    if (dir === 1) {
      if (rsi < 40) score += 10;
      else if (rsi < 55) score += 5;
    } else {
      if (rsi > 60) score += 10;
      else if (rsi > 45) score += 5;
    }
  } else {
    score += 3; // fallback als RSI niet werkt
  }

  // 🔥 momentum
  const ch1 = Math.abs(Number(c.change1h || 0));
  if (ch1 > 1) score += 8;
  else if (ch1 > 0.5) score += 4;

  // clamp
  score = Math.max(0, Math.min(100, Math.round(score)));

  // ================= VALID =================
  let valid = false;

  if (score >= 80) valid = true;
  else if (score >= 70 && confluence >= 70) valid = true;
  else if (score >= 65 && flow === "TREND") valid = true;

  return {
    valid,
    score,
    type:
      score >= 85
        ? "SNIPER_ELITE"
        : score >= 75
        ? "SNIPER_STRONG"
        : score >= 65
        ? "SNIPER_OK"
        : "SNIPER_WEAK"
  };
}