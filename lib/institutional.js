// ================= INSTITUTIONAL DETECTIE =================

export function detectWallPersistence(history) {
  if (history.length < 5) return { bidWallStrong: false, askWallStrong: false };

  const last = history.slice(-5);

  const getTopVolume = (side, idx) =>
    last.map(h => Number(h[side][idx]?.[1] || 0));

  const bidWall = getTopVolume("bids", 0);
  const askWall = getTopVolume("asks", 0);

  const stable = (arr) => {
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    if (avg === 0) return false;
    const variance = arr.reduce((a, b) => a + Math.abs(b - avg), 0) / arr.length;
    return variance / avg < 0.3;   // <30% variatie = stabiele wall
  };

  return {
    bidWallStrong: stable(bidWall),
    askWallStrong: stable(askWall)
  };
}

export function detectAbsorption(c, history) {
  if (history.length < 5) return { absorbingBids: false, absorbingAsks: false };

  const priceMove = Number(c.change1h || 0);

  const last = history.slice(-5);

  const total = (side) =>
    last.map(h =>
      h[side].slice(0, 5).reduce((a, b) => a + (Number(b[1]) || 0), 0)
    );

  const bidPressure = total("bids");
  const askPressure = total("asks");

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  const bidAvg = avg(bidPressure);
  const askAvg = avg(askPressure);

  // LONG: prijs daalt, maar bids blijven hoog (absorption)
  const absorbingBids = priceMove < 0 && bidAvg > askAvg * 1.2;
  // SHORT: prijs stijgt, maar asks blijven hoog
  const absorbingAsks = priceMove > 0 && askAvg > bidAvg * 1.2;

  return { absorbingBids, absorbingAsks };
}