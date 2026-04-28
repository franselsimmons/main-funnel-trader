// ================= SNIPER ENGINE (ELITE: MOMENTUM + OB + RSI) =================

export function getSniperEntry(c, ob = null, rsiSignal = null) {
  const dir = c.side === "bear" ? -1 : 1;

  const ch1 = Number(c.change1h || 0) * dir;
  const ch24 = Number(c.change24 || 0) * dir;
  const range = Math.abs(Number(c.change24 || 0));

  const flow = String(c.flow || "NEUTRAL").toUpperCase();
  const position = Math.min(1, ch1 / Math.max(range, 0.01));

  // ================= HARD FILTERS (blijven) =================
  if (ch1 <= 0) {
    return { valid: false, type: "NO_DIRECTION", score: 0 };
  }
  if (ch24 < 3) {
    return { valid: false, type: "NO_MOMENTUM", score: 0 };
  }
  if (flow === "NEUTRAL") {
    return { valid: false, type: "NO_FLOW", score: 0 };
  }
  if (ch1 >= 3) {
    return { valid: false, type: "OVEREXTENDED", score: 0 };
  }
  if (position >= 0.9) {
    return { valid: false, type: "LATE_MOVE", score: 0 };
  }

  // ================= EXTRA SNIPER POWER (orderbook + RSI) =================
  let extraScore = 0;

  // --- Orderbook metrics ---
  const spread = Number(ob?.spreadPct || 0);
  const goodSpread = spread <= 0.003;
  if (goodSpread) extraScore += 1;

  let imbalance = 1;
  if (ob?.bids && ob?.asks) {
    const sum = (arr) => arr.slice(0, 10).reduce((a, b) => a + (Number(b[1]) || 0), 0);
    const bidVol = sum(ob.bids);
    const askVol = sum(ob.asks);
    imbalance = bidVol / (askVol || 1);
  }

  if (dir === 1) { // long
    if (imbalance > 1.1) extraScore += 1;
  } else { // short
    if (imbalance < 0.9) extraScore += 1;
  }

  // --- RSI timing (MTF signaal) ---
  const rsiOK = rsiSignal?.valid && rsiSignal?.strength >= 1;
  if (rsiOK) extraScore += 2;

  // ================= ORIGINELE RETURNS MET BOOST =================
  const baseScore = (type) => {
    if (type === "CONTINUATION") return 86;
    if (type === "BUILDING_CONTINUATION") return 82;
    if (type === "EARLY_TREND") return 76;
    if (type === "PULLBACK_REENTRY") return 72;
    if (type === "LATE_CONTINUATION") return 68;
    return 0;
  };

  // ELITE CONTINUATION
  if (
    ch24 >= 6 &&
    ch1 >= 0.45 &&
    position >= 0.08 &&
    position <= 0.68 &&
    flow === "TREND"
  ) {
    const score = baseScore("CONTINUATION") + extraScore;
    return { valid: true, type: "CONTINUATION", quality: "HIGH", score, extraScore };
  }

  // BUILDING CONTINUATION
  if (
    ch24 >= 4.5 &&
    ch1 >= 0.25 &&
    position <= 0.62 &&
    (flow === "TREND" || flow === "BUILDING")
  ) {
    const score = baseScore("BUILDING_CONTINUATION") + extraScore;
    return { valid: true, type: "BUILDING_CONTINUATION", quality: "HIGH", score, extraScore };
  }

  // EARLY TREND
  if (
    ch24 >= 4 &&
    ch1 >= 0.18 &&
    position <= 0.50 &&
    (flow === "TREND" || flow === "BUILDING")
  ) {
    const score = baseScore("EARLY_TREND") + extraScore;
    return { valid: true, type: "EARLY_TREND", quality: "MEDIUM", score, extraScore };
  }

  // PULLBACK / RE-ENTRY
  if (
    ch24 >= 3.5 &&
    ch1 >= 0.08 &&
    position <= 0.32 &&
    (flow === "TREND" || flow === "BUILDING")
  ) {
    const score = baseScore("PULLBACK_REENTRY") + extraScore;
    return { valid: true, type: "PULLBACK_REENTRY", quality: "MEDIUM", score, extraScore };
  }

  // LATE BUT STILL TRADEABLE
  if (
    ch24 >= 5 &&
    ch1 >= 0.20 &&
    position <= 0.78 &&
    flow === "TREND"
  ) {
    const score = baseScore("LATE_CONTINUATION") + extraScore;
    return { valid: true, type: "LATE_CONTINUATION", quality: "LOW", score, extraScore };
  }

  return { valid: false, type: "WAIT", score: 0 };
}