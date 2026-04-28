// ================= INSTITUTIONAL SNIPER (LEVEL 3) =================
import { detectWallPersistence, detectAbsorption } from "./institutional.js";
import { getOrderbookHistory } from "./orderbookMemory.js";

export function getSniperEntry(c, ob, rsiSignal) {
  const symbol = c.symbol;
  const dir = c.side === "bear" ? -1 : 1;

  const history = getOrderbookHistory(symbol);
  const walls = detectWallPersistence(history);
  const absorption = detectAbsorption(c, history);
  const rsiOK = rsiSignal?.valid && rsiSignal?.strength >= 1;

  // ========== LIQUIDITY TRAP + ABSORPTION (elite) ==========
  if (dir === 1 && absorption.absorbingBids && walls.bidWallStrong && rsiOK) {
    return {
      valid: true,
      type: "INSTITUTIONAL_LONG",
      quality: "ELITE",
      score: 95
    };
  }

  if (dir === -1 && absorption.absorbingAsks && walls.askWallStrong && rsiOK) {
    return {
      valid: true,
      type: "INSTITUTIONAL_SHORT",
      quality: "ELITE",
      score: 95
    };
  }

  // ========== WALL SUPPORT / RESISTANCE ==========
  if (dir === 1 && walls.bidWallStrong && rsiOK) {
    return {
      valid: true,
      type: "WALL_SUPPORT_LONG",
      quality: "HIGH",
      score: 85
    };
  }

  if (dir === -1 && walls.askWallStrong && rsiOK) {
    return {
      valid: true,
      type: "WALL_RESIST_SHORT",
      quality: "HIGH",
      score: 85
    };
  }

  // ========== FALLBACK (geen institutionele setup) ==========
  return { valid: false, type: "WAIT", score: 0 };
}