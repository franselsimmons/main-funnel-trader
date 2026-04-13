const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export async function fetchOrderbook(symbol) {
  try {
    const r = await fetch(
      `${BITGET_OB}?symbol=${symbol}USDT&type=step0&limit=15`
    );
    const j = await r.json();

    if (j.code !== "00000") return null;

    const bids = j.data.bids || [];
    const asks = j.data.asks || [];

    if (!bids.length || !asks.length) return null;

    const bestBid = n(bids[0][0]);
    const bestAsk = n(asks[0][0]);
    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;

    const bidDepth = bids.slice(0, 8)
      .reduce((a, b) => a + n(b[0]) * n(b[1]), 0);

    const askDepth = asks.slice(0, 8)
      .reduce((a, b) => a + n(b[0]) * n(b[1]), 0);

    const imbalance = (bidDepth - askDepth) / (bidDepth + askDepth);

    return {
      spreadPct,
      depthUsd: Math.min(bidDepth, askDepth),
      imbalance,
      valid: true
    };

  } catch {
    return null;
  }
}

export function orderbookPass(ob, thresholds) {
  if (!ob?.valid) return false;
  if (ob.spreadPct > thresholds.spreadMax) return false;
  if (ob.depthUsd < thresholds.depthMin) return false;
  return true;
}