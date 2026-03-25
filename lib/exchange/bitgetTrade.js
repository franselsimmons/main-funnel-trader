// exchange/bitgetTrade.js
// Bitget Spot trading (market/limit) + small helpers
//
// ✅ Provides:
// - placeSpotOrder({ symbol, side, orderType, size, price, force, clientOid, auth })
// - placeSpotMarketBuyQuote({ symbol, quoteSize, force, clientOid, auth })  // buy using USDT amount if supported
// - cancelSpotOrder({ symbol, orderId, clientOid, auth })
// - getSpotOrderInfo({ symbol, orderId, clientOid, auth })
// - getSpotOpenOrders({ symbol, auth })
// - getSpotAccountAssets({ coin, auth })
// - getSpotTicker({ symbol, auth })
// - normalizeBitgetSymbol("BTC") => "BTCUSDT"
//
// Notes:
// - This module assumes you trade SPOT USDT pairs, like BTCUSDT.
// - Bitget v2 endpoints are used where possible.
// - Some accounts require "size" in base coin. If you want buy by quote amount,
//   use placeSpotMarketBuyQuote; if Bitget does not support quoteSize on your account,
//   fall back: quoteSize -> size = quoteSize/lastPrice.
//
// Env in production (Vercel):
// - BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE
// - BITGET_BASE_URL (optional)
// - BITGET_TRADE_MODE (optional: "cash") default: "cash"
// - BITGET_DEFAULT_FORCE (optional: "ioc" | "fok" | "gtc") default: "gtc"

import { bitgetFetch } from "./bitgetAuth.js";
import { n, clamp } from "../lib/utils/numbers.js";

export function normalizeBitgetSymbol(sym, quote = "USDT") {
  const s = String(sym || "").toUpperCase().trim();
  if (!s) return "";
  if (s.endsWith(quote)) return s;
  return `${s}${quote}`;
}

function ensureSide(side) {
  const s = String(side || "").toLowerCase();
  if (s !== "buy" && s !== "sell") throw new Error(`Invalid side: ${side}`);
  return s;
}

function ensureOrderType(orderType) {
  const t = String(orderType || "").toLowerCase();
  // Bitget often uses: "market" | "limit"
  if (t !== "market" && t !== "limit") throw new Error(`Invalid orderType: ${orderType}`);
  return t;
}

function forceValue(force) {
  const f = String(force || process.env.BITGET_DEFAULT_FORCE || "gtc").toLowerCase();
  // Common: gtc, ioc, fok
  if (!["gtc", "ioc", "fok"].includes(f)) return "gtc";
  return f;
}

function tradeModeValue(tradeMode) {
  // Bitget spot tradeMode: "cash" is typical (spot account)
  const tm = String(tradeMode || process.env.BITGET_TRADE_MODE || "cash").toLowerCase();
  if (!tm) return "cash";
  return tm;
}

function safeClientOid(clientOid) {
  if (!clientOid) return undefined;
  const s = String(clientOid);
  // keep it short-ish
  return s.slice(0, 48);
}

/**
 * Place a spot order.
 * @param {object} p
 * @param {string} p.symbol - e.g. "BTCUSDT" or "BTC"
 * @param {"buy"|"sell"} p.side
 * @param {"market"|"limit"} p.orderType
 * @param {number|string} p.size - base coin size (e.g. BTC amount)
 * @param {number|string} [p.price] - required for limit
 * @param {"gtc"|"ioc"|"fok"} [p.force]
 * @param {string} [p.clientOid]
 * @param {object} [p.auth] - { apiKey, apiSecret, passphrase }
 * @param {string} [p.tradeMode] - default cash
 */
export async function placeSpotOrder({
  symbol,
  side,
  orderType,
  size,
  price,
  force,
  clientOid,
  auth,
  tradeMode,
}) {
  const sym = normalizeBitgetSymbol(symbol);
  const s = ensureSide(side);
  const ot = ensureOrderType(orderType);

  const sz = n(size, 0);
  if (!(sz > 0)) throw new Error(`placeSpotOrder: size must be > 0 (got ${size})`);

  if (ot === "limit") {
    const pr = n(price, 0);
    if (!(pr > 0)) throw new Error("placeSpotOrder: limit order requires price > 0");
  }

  // Bitget v2 endpoint (spot place order)
  // Common path in docs: /api/v2/spot/trade/place-order
  const path = "/api/v2/spot/trade/place-order";

  const body = {
    symbol: sym,
    side: s, // buy/sell
    orderType: ot, // market/limit
    force: forceValue(force), // gtc/ioc/fok
    size: String(sz),
    tradeMode: tradeModeValue(tradeMode),
  };

  const coid = safeClientOid(clientOid);
  if (coid) body.clientOid = coid;

  if (ot === "limit") body.price = String(n(price, 0));

  const r = await bitgetFetch({
    method: "POST",
    path,
    body,
    auth,
  });

  // Standard Bitget response: { code:"00000", msg:"success", data:{ orderId, clientOid } }
  const code = String(r?.json?.code || "");
  const ok = r.ok && code === "00000";
  return {
    ok,
    status: r.status,
    code,
    msg: r?.json?.msg || r?.text || "",
    data: r?.json?.data || null,
    raw: r,
    request: { path, body },
  };
}

/**
 * Market BUY by quote amount (e.g. spend 50 USDT on BTC)
 * Some Bitget accounts/endpoints support quoteSize; if not, fallback needed upstream.
 */
export async function placeSpotMarketBuyQuote({
  symbol,
  quoteSize,
  force,
  clientOid,
  auth,
  tradeMode,
}) {
  const sym = normalizeBitgetSymbol(symbol);
  const qs = n(quoteSize, 0);
  if (!(qs > 0)) throw new Error("placeSpotMarketBuyQuote: quoteSize must be > 0");

  const path = "/api/v2/spot/trade/place-order";
  const body = {
    symbol: sym,
    side: "buy",
    orderType: "market",
    force: forceValue(force),
    tradeMode: tradeModeValue(tradeMode),
    // Many APIs: quoteSize or amount. We'll send quoteSize as string.
    quoteSize: String(qs),
  };

  const coid = safeClientOid(clientOid);
  if (coid) body.clientOid = coid;

  const r = await bitgetFetch({
    method: "POST",
    path,
    body,
    auth,
  });

  const code = String(r?.json?.code || "");
  const ok = r.ok && code === "00000";
  return {
    ok,
    status: r.status,
    code,
    msg: r?.json?.msg || r?.text || "",
    data: r?.json?.data || null,
    raw: r,
    request: { path, body },
  };
}

/**
 * Cancel an order (spot)
 * You can cancel by orderId or clientOid. Provide at least one.
 */
export async function cancelSpotOrder({ symbol, orderId, clientOid, auth }) {
  const sym = normalizeBitgetSymbol(symbol);
  const oid = orderId ? String(orderId) : "";
  const coid = clientOid ? String(clientOid) : "";

  if (!oid && !coid) throw new Error("cancelSpotOrder: provide orderId or clientOid");

  const path = "/api/v2/spot/trade/cancel-order";
  const body = {
    symbol: sym,
  };
  if (oid) body.orderId = oid;
  if (coid) body.clientOid = safeClientOid(coid);

  const r = await bitgetFetch({
    method: "POST",
    path,
    body,
    auth,
  });

  const code = String(r?.json?.code || "");
  const ok = r.ok && code === "00000";
  return {
    ok,
    status: r.status,
    code,
    msg: r?.json?.msg || r?.text || "",
    data: r?.json?.data || null,
    raw: r,
    request: { path, body },
  };
}

/**
 * Get order info (spot)
 */
export async function getSpotOrderInfo({ symbol, orderId, clientOid, auth }) {
  const sym = normalizeBitgetSymbol(symbol);
  const oid = orderId ? String(orderId) : "";
  const coid = clientOid ? String(clientOid) : "";

  if (!oid && !coid) throw new Error("getSpotOrderInfo: provide orderId or clientOid");

  // Common path: /api/v2/spot/trade/orderInfo
  const path = "/api/v2/spot/trade/orderInfo";
  const query = { symbol: sym };
  if (oid) query.orderId = oid;
  if (coid) query.clientOid = safeClientOid(coid);

  const r = await bitgetFetch({
    method: "GET",
    path,
    query,
    auth,
  });

  const code = String(r?.json?.code || "");
  const ok = r.ok && code === "00000";
  return {
    ok,
    status: r.status,
    code,
    msg: r?.json?.msg || r?.text || "",
    data: r?.json?.data || null,
    raw: r,
    request: { path, query },
  };
}

/**
 * List open orders (spot)
 */
export async function getSpotOpenOrders({ symbol, auth }) {
  const sym = symbol ? normalizeBitgetSymbol(symbol) : "";
  const path = "/api/v2/spot/trade/open-orders";
  const query = {};
  if (sym) query.symbol = sym;

  const r = await bitgetFetch({
    method: "GET",
    path,
    query,
    auth,
  });

  const code = String(r?.json?.code || "");
  const ok = r.ok && code === "00000";
  return {
    ok,
    status: r.status,
    code,
    msg: r?.json?.msg || r?.text || "",
    data: r?.json?.data || null,
    raw: r,
    request: { path, query },
  };
}

/**
 * Get spot account assets (balances)
 * If coin is provided, filter for that coin (e.g. "USDT")
 */
export async function getSpotAccountAssets({ coin, auth }) {
  const path = "/api/v2/spot/account/assets";
  const query = {};
  if (coin) query.coin = String(coin).toUpperCase();

  const r = await bitgetFetch({
    method: "GET",
    path,
    query,
    auth,
  });

  const code = String(r?.json?.code || "");
  const ok = r.ok && code === "00000";
  return {
    ok,
    status: r.status,
    code,
    msg: r?.json?.msg || r?.text || "",
    data: r?.json?.data || null,
    raw: r,
    request: { path, query },
  };
}

/**
 * Public ticker (no auth) — helpful for fallback quoteSize->size
 */
export async function getSpotTicker({ symbol, auth } = {}) {
  const sym = normalizeBitgetSymbol(symbol);
  const path = "/api/v2/spot/market/tickers";
  const query = { symbol: sym };

  // Public endpoint usually doesn't require auth. We call bitgetFetch without auth by
  // providing empty keys would fail. So do a plain fetch here:
  const base = process.env.BITGET_BASE_URL || "https://api.bitget.com";
  const url = `${base}${path}?symbol=${encodeURIComponent(sym)}`;

  const controller = new AbortController();
  const tms = n(process.env.BITGET_TIMEOUT_MS, 8000);
  const id = setTimeout(() => controller.abort(), tms);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = String(json?.code || "");
    const ok = res.ok && code === "00000";
    return {
      ok,
      status: res.status,
      code,
      msg: json?.msg || text || "",
      data: json?.data || null,
      raw: { url, text, json },
      request: { url },
    };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : e?.message || String(e);
    return { ok: false, status: 0, code: "", msg, data: null, raw: { msg }, request: { url } };
  } finally {
    clearTimeout(id);
  }
}

/**
 * Helper: compute base size for market BUY given quoteSize (USDT) and lastPrice.
 * You still must respect exchange min size steps elsewhere.
 */
export function quoteToBaseSize({ quoteSize, lastPrice, minBase = 0 }) {
  const qs = n(quoteSize, 0);
  const p = n(lastPrice, 0);
  if (!(qs > 0 && p > 0)) return 0;
  const raw = qs / p;
  return Math.max(raw, n(minBase, 0));
}

/**
 * Optional: clamp and format size/price as strings
 */
export function formatSize(size, decimals = 8) {
  const v = n(size, 0);
  if (!(v > 0)) return "0";
  const d = clamp(n(decimals, 8), 0, 18);
  return v.toFixed(d).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatPrice(price, decimals = 8) {
  const v = n(price, 0);
  if (!(v > 0)) return "0";
  const d = clamp(n(decimals, 8), 0, 18);
  return v.toFixed(d).replace(/0+$/, "").replace(/\.$/, "");
}