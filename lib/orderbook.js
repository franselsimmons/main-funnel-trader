import { n } from "./utils";

export async function fetchOrderbook(symbol) {
  try {
    const r = await fetch(
      `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${symbol}&type=step0&limit=20`
    );
    const j = await r.json();
    if (j.code !== "00000") return null;

    const bids = j.data.bids;
    const asks = j.data.asks;

    const bestBid = n(bids[0][0]);
    const bestAsk = n(asks[0][0]);
    const spread = ((bestAsk - bestBid) / bestBid) * 100;

    const depthBid = bids.slice(0, 8)
      .reduce((a,b)=>a+n(b[0])*n(b[1]),0);
    const depthAsk = asks.slice(0, 8)
      .reduce((a,b)=>a+n(b[0])*n(b[1]),0);

    return {
      spreadPct: spread,
      depthMin: Math.min(depthBid, depthAsk)
    };
  } catch {
    return null;
  }
}