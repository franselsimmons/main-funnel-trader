// ================= RSI FILTER =================
// Backward-compatible filter helpers
// Gebruik deze voor clean zone-detectie en alignment checks.

export function getRsiZoneDynamic(rsi, zones) {
  const value = Number(rsi);

  if (!Number.isFinite(value) || !zones) return "MID";

  if (value >= zones.U3) return "UPPER_3";
  if (value >= zones.U2) return "UPPER_2";
  if (value >= zones.U1) return "UPPER_1";

  if (value <= zones.L3) return "LOWER_3";
  if (value <= zones.L2) return "LOWER_2";
  if (value <= zones.L1) return "LOWER_1";

  return "MID";
}

export function isLowerRsiZone(zone) {
  return String(zone || "").startsWith("LOWER");
}

export function isUpperRsiZone(zone) {
  return String(zone || "").startsWith("UPPER");
}

export function isMidRsiZone(zone) {
  return String(zone || "") === "MID";
}

// Directional alignment:
// - LONG wil lower pullback of MID-continuation
// - SHORT wil upper pullback of MID-continuation
// - Geen zone = false, niet blind true
export function isRsiAligned(isBull, zone) {
  if (!zone) return false;

  if (isBull) {
    return isLowerRsiZone(zone) || isMidRsiZone(zone);
  }

  return isUpperRsiZone(zone) || isMidRsiZone(zone);
}

// Hard exhaustion block:
// - Long niet kopen in UPPER_2/UPPER_3
// - Short niet shorten in LOWER_2/LOWER_3
export function isRsiExhaustedAgainstSide(isBull, zone) {
  if (!zone) return false;

  if (isBull) {
    return zone === "UPPER_2" || zone === "UPPER_3";
  }

  return zone === "LOWER_2" || zone === "LOWER_3";
}

// Softere trend-continuation check
export function isRsiContinuationAllowed({ isBull, zone, rsiSignal, confluence = 0, sniperScore = 0, rr = 0, flow = "NEUTRAL" }) {
  if (!zone || !rsiSignal?.valid) return false;
  if (flow !== "TREND") return false;
  if (rr < 1.05) return false;

  const continuationScore = Number(rsiSignal?.continuationScore || 0);
  const slope3 = Number(rsiSignal?.slope3 || 0);

  if (isBull) {
    if (zone === "MID") {
      return (
        (confluence >= 72 && sniperScore >= 50 && continuationScore >= 5) ||
        (confluence >= 78 && sniperScore >= 45 && slope3 >= -0.25)
      );
    }

    if (zone === "LOWER_1") {
      return (
        (confluence >= 68 && sniperScore >= 50) ||
        (confluence >= 75 && slope3 > -0.5)
      );
    }

    return false;
  }

  if (zone === "MID") {
    return (
      (confluence >= 72 && sniperScore >= 50 && continuationScore >= 5) ||
      (confluence >= 78 && sniperScore >= 45 && slope3 <= 0.25)
    );
  }

  if (zone === "UPPER_1") {
    return (
      (confluence >= 68 && sniperScore >= 50) ||
      (confluence >= 75 && slope3 < 0.5)
    );
  }

  return false;
}

// Pullback entry check:
// - LONG: LOWER zones
// - SHORT: UPPER zones
export function isRsiPullbackEntry({ isBull, zone, rsiSignal, sniperScore = 0 }) {
  if (!zone || !rsiSignal?.valid) return false;

  if (isBull) {
    if (zone === "LOWER_3") return true;
    if (zone === "LOWER_2") return true;
    if (zone === "LOWER_1") return sniperScore >= 70 || rsiSignal?.rising;
    return false;
  }

  if (zone === "UPPER_3") return true;
  if (zone === "UPPER_2") return true;
  if (zone === "UPPER_1") return sniperScore >= 70 || rsiSignal?.falling;

  return false;
}