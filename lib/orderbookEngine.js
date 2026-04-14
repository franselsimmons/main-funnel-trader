import { n } from "./utils.js";

/**
 * Zorgt dat symbol altijd BITGET correct is
 * BTC → BTCUSDT
 * ETHUSDT → ETHUSDT
 */
function normalizeSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.endsWith("USDT")) return s;
  return `${s}USDT`;
}

/**
 * Bitget Spot orderbook → normalized snapshot for gates
 */
export async function fetchOrderbook(symbol) {
  const sym = normalizeSymbol(symbol);

  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 7000);

    const r = await fetch(
      `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(
        sym
      )}&type=step0&limit=20`,
      {
        headers: {
          accept: "application/json",
          "user-agent": "CryptoCrocScanner/2.0",
        },
        signal: controller.signal,
        cache: "no-store",
      }
    );

    clearTimeout(id);

    if (!r.ok) {
      return invalid(`http_${r.status}`);
    }

    const j = await r.json();

    if (String(j?.code || "") !== "00000") {
      return invalid(`bitget_code_${String(j?.code || "")}`);
    }

    const bids = Array.isArray(j?.data?.bids) ? j.data.bids : [];
    const asks = Array.isArray(j?.data?.asks) ? j.data.asks : [];

    if (!bids.length || !asks.length) {
      return invalid("empty_book");
    }

    const bestBid = n(bids[0]?.[0], 0);
    const bestAsk = n(asks[0]?.[0], 0);

    if (!(bestBid > 0) || !(bestAsk > 0)) {
      return invalid("bad_top", bestBid, bestAsk);
    }

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;

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
  } catch {
    return invalid("exception");
  }
}

/**
 * ORDERBOOK GATE LOGIC
 * Hier zat jouw crash — deze ontbrak.
 */
export function orderbookPass(ob, thresholds = {}) {
  if (!ob || !ob.valid) return false;

  const spreadMax = n(thresholds?.spreadMaxPct ?? 0.4, 0.4);
  const depthMin = n(thresholds?.depthMinUsd ?? 20000, 20000);

  const spreadOk = n(ob.spreadPct, 999) <= spreadMax;
  const depthOk = n(ob.depthMinUsd1p, 0) >= depthMin;

  return spreadOk && depthOk;
}

/**
 * Helper om altijd consistente invalid response te geven
 */
function invalid(reason, bestBid = 0, bestAsk = 0) {
  return {
    valid: false,
    reason,
    bestBid,
    bestAsk,
    spreadPct: 999,
    depthBidUsd: 0,
    depthAskUsd: 0,
    depthMinUsd1p: 0,
  };
}