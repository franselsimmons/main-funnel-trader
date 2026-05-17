// ================= RSI FILTER — CRYPTOCROC COMPATIBLE =================

// ================= ZONE HELPERS =================
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

export function getRsiZoneDepth(zone) {
  const z = String(zone || "MID").toUpperCase();

  if (z.endsWith("_3")) return 3;
  if (z.endsWith("_2")) return 2;
  if (z.endsWith("_1")) return 1;

  return 0;
}

// ================= ANCHOR HELPERS =================
export function getAnchorEdgeScore({ isBull, anchorZone, anchorValue = 50 }) {
  const zone = String(anchorZone || "MID").toUpperCase();
  const anchor = Number(anchorValue);

  if (isBull) {
    if (zone === "LOWER_3") return 3;
    if (zone === "LOWER_2") return 2.5;
    if (zone === "LOWER_1") return 2;
    if (Number.isFinite(anchor) && anchor < 50) return 1;

    if (zone === "UPPER_1") return -1;
    if (zone === "UPPER_2") return -2;
    if (zone === "UPPER_3") return -3;

    return 0;
  }

  if (zone === "UPPER_3") return 3;
  if (zone === "UPPER_2") return 2.5;
  if (zone === "UPPER_1") return 2;
  if (Number.isFinite(anchor) && anchor > 50) return 1;

  if (zone === "LOWER_1") return -1;
  if (zone === "LOWER_2") return -2;
  if (zone === "LOWER_3") return -3;

  return 0;
}

export function getSignalAnchorEdgeScore(isBull, rsiSignal) {
  if (!rsiSignal?.valid) return 0;

  const anchorZone =
    rsiSignal.anchorZone ||
    rsiSignal?.m15?.anchorZone ||
    getRsiZoneDynamic(
      rsiSignal?.m15?.mean ?? rsiSignal?.mean,
      rsiSignal?.zones || rsiSignal?.m15?.zones
    );

  const anchorValue =
    Number(rsiSignal?.m15?.mean ?? rsiSignal?.mean ?? rsiSignal?.rsiAnchorBlue ?? 50);

  return getAnchorEdgeScore({
    isBull,
    anchorZone,
    anchorValue
  });
}

// ================= ALIGNMENT =================
// Basale directional alignment.
// MID is hier toegestaan voor backward-compatibility,
// maar echte continuation moet via isRsiContinuationAllowed().
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

// ================= CONTINUATION =================
export function isRsiContinuationAllowed({
  isBull,
  zone,
  rsiSignal,
  confluence = 0,
  sniperScore = 0,
  rr = 0,
  flow = "NEUTRAL"
}) {
  if (!zone || !rsiSignal?.valid) return false;
  if (flow !== "TREND") return false;
  if (rr < 1.05) return false;

  const continuationScore = Number(rsiSignal?.continuationScore || 0);
  const slope3 = Number(rsiSignal?.slope3 || 0);
  const anchorEdgeScore = Number(
    rsiSignal?.anchorEdgeScore ?? getSignalAnchorEdgeScore(isBull, rsiSignal)
  );

  if (isBull) {
    if (zone === "MID") {
      return (
        (confluence >= 72 && sniperScore >= 50 && continuationScore >= 5 && anchorEdgeScore >= 0) ||
        (confluence >= 78 && sniperScore >= 45 && slope3 >= -0.25 && anchorEdgeScore >= 1)
      );
    }

    if (zone === "LOWER_1") {
      return (
        (confluence >= 68 && sniperScore >= 50 && anchorEdgeScore >= 0) ||
        (confluence >= 75 && slope3 > -0.5)
      );
    }

    return false;
  }

  if (zone === "MID") {
    return (
      (confluence >= 72 && sniperScore >= 50 && continuationScore >= 5 && anchorEdgeScore >= 0) ||
      (confluence >= 78 && sniperScore >= 45 && slope3 <= 0.25 && anchorEdgeScore >= 1)
    );
  }

  if (zone === "UPPER_1") {
    return (
      (confluence >= 68 && sniperScore >= 50 && anchorEdgeScore >= 0) ||
      (confluence >= 75 && slope3 < 0.5)
    );
  }

  return false;
}

// ================= PULLBACK ENTRY =================
// Dit is jouw hoofdlogica:
// - LONG: witte RSI in lower zones.
// - SHORT: witte RSI in upper zones.
// - Anchor in dezelfde extreme richting geeft extra edge.
export function isRsiPullbackEntry({
  isBull,
  zone,
  rsiSignal,
  sniperScore = 0
}) {
  if (!zone || !rsiSignal?.valid) return false;

  const anchorEdgeScore = Number(
    rsiSignal?.anchorEdgeScore ?? getSignalAnchorEdgeScore(isBull, rsiSignal)
  );

  if (isBull) {
    if (zone === "LOWER_3") return anchorEdgeScore >= -1;
    if (zone === "LOWER_2") return anchorEdgeScore >= -1;

    if (zone === "LOWER_1") {
      return (
        sniperScore >= 70 ||
        rsiSignal?.rising ||
        anchorEdgeScore >= 1
      );
    }

    return false;
  }

  if (zone === "UPPER_3") return anchorEdgeScore >= -1;
  if (zone === "UPPER_2") return anchorEdgeScore >= -1;

  if (zone === "UPPER_1") {
    return (
      sniperScore >= 70 ||
      rsiSignal?.falling ||
      anchorEdgeScore >= 1
    );
  }

  return false;
}

// ================= PERFECT RSI SETUP =================
export function isPerfectRsiSetup({
  isBull,
  zone,
  rsiSignal
}) {
  if (!zone || !rsiSignal?.valid) return false;

  const anchorEdgeScore = Number(
    rsiSignal?.anchorEdgeScore ?? getSignalAnchorEdgeScore(isBull, rsiSignal)
  );

  if (isBull) {
    return (
      ["LOWER_2", "LOWER_3"].includes(zone) &&
      anchorEdgeScore >= 2
    );
  }

  return (
    ["UPPER_2", "UPPER_3"].includes(zone) &&
    anchorEdgeScore >= 2
  );
}