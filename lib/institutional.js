// ================= INSTITUTIONAL DETECTIE (V3.1) =================

export function detectWallPersistence(history) {
  if (history.length < 5) return { bidWallStrong: false, askWallStrong: false };

  const last = history.slice(-5);
  const getTopVolume = (side, idx) => last.map(h => Number(h[side][idx]?.[1] || 0));

  const bidWall = getTopVolume("bids", 0);
  const askWall = getTopVolume("asks", 0);

  const stable = (arr) => {
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    if (avg === 0) return false;
    const variance = arr.reduce((a, b) => a + Math.abs(b - avg), 0) / arr.length;
    return variance / avg < 0.3;
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

  const total = (side) => last.map(h =>
    h[side].slice(0, 5).reduce((a, b) => a + (Number(b[1]) || 0), 0)
  );

  const bidPressure = total("bids");
  const askPressure = total("asks");

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const bidAvg = avg(bidPressure);
  const askAvg = avg(askPressure);

  // Prijs reactie (stabiliteit)
  const prices = history.map(h => h.mid).filter(p => p > 0);
  let priceStable = false;
  if (prices.length >= 3) {
    const lastPrice = prices[prices.length - 1];
    const firstPrice = prices[prices.length - 3];
    const changePct = Math.abs((lastPrice - firstPrice) / firstPrice) * 100;
    priceStable = changePct < 0.2;   // <0.2% beweging = stabiel
  }

  const absorbingBids = (priceMove < 0 && bidAvg > askAvg * 1.2 && priceStable);
  const absorbingAsks = (priceMove > 0 && askAvg > bidAvg * 1.2 && priceStable);

  return { absorbingBids, absorbingAsks };
}

export function detectSpoofing(history) {
  if (history.length < 5) return { spoof: false };

  const last = history.slice(-5);
  const getVolumes = (side) => last.map(h => Number(h[side][0]?.[1] || 0));

  const vols = getVolumes("bids");
  let spikes = 0;
  for (let i = 1; i < vols.length; i++) {
    if (vols[i] > vols[i - 1] * 1.8) spikes++;
  }

  return { spoof: spikes >= 2 };
}