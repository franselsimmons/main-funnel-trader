import { n } from "./utils.js";

/**
 * Bitget Spot orderbook → normalized snapshot for gates
 * Returns:
 * {
 *   valid: boolean,
 *   bestBid, bestAsk,
 *   spreadPct,
 *   depthBidUsd, depthAskUsd,
 *   depthMinUsd1p
 * }
 */
export async function fetchOrderbook(symbol) {
  try {
    const r = await fetch(
      `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(
        symbol
      )}&type=step0&limit=20`,
      { headers: { accept: "application/json" } }
    );

    if (!r.ok) {
      return {
        valid: false,
        reason: `http_${r.status}`,
        bestBid: 0,
        bestAsk: 0,
        spreadPct: 999,
        depthBidUsd: 0,
        depthAskUsd: 0,
        depthMinUsd1p: 0,
      };
    }

    const j = await r.json();
    if (String(j?.code || "") !== "00000") {
      return {
        valid: false,
        reason: `bitget_code_${String(j?.code || "")}`,
        bestBid: 0,
        bestAsk: 0,
        spreadPct: 999,
        depthBidUsd: 0,
        depthAskUsd: 0,
        depthMinUsd1p: 0,
      };
    }

    const bids = Array.isArray(j?.data?.bids) ? j.data.bids : [];
    const asks = Array.isArray(j?.data?.asks) ? j.data.asks : [];

    if (!bids.length || !asks.length) {
      return {
        valid: false,
        reason: "empty_book",
        bestBid: 0,
        bestAsk: 0,
        spreadPct: 999,
        depthBidUsd: 0,
        depthAskUsd: 0,
        depthMinUsd1p: 0,
      };
    }

    const bestBid = n(bids[0]?.[0], 0);
    const bestAsk = n(asks[0]?.[0], 0);

    if (!(bestBid > 0) || !(bestAsk > 0)) {
      return {
        valid: false,
        reason: "bad_top",
        bestBid,
        bestAsk,
        spreadPct: 999,
        depthBidUsd: 0,
        depthAskUsd: 0,
        depthMinUsd1p: 0,
      };
    }

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;

    // USD depth = price * size
    const depthBidUsd = bids
      .slice(0, 8)
      .reduce((a, b) => a + n(b?.[0]) * n(b?.[1]), 0);

    const depthAskUsd = asks
      .slice(0, 8)
      .reduce((a, b) => a + n(b?.[0]) * n(b?.[1]), 0);

    return {
      valid: true,
      reason: "",
      bestBid,
      bestAsk,
      spreadPct,
      depthBidUsd,
      depthAskUsd,
      depthMinUsd1p: Math.min(depthBidUsd, depthAskUsd),
    };
  } catch (e) {
    return {
      valid: false,
      reason: "exception",
      bestBid: 0,
      bestAsk: 0,
      spreadPct: 999,
      depthBidUsd: 0,
      depthAskUsd: 0,
      depthMinUsd1p: 0,
    };
  }
}