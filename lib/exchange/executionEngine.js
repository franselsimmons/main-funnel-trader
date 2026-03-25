// exchange/executionEngine.js
// =======================================================
// Execution engine for Main Funnel (Bitget Spot)
// - Creates & manages real exchange orders (entry + OCO-style exits)
// - Stores execution state in Vercel KV
// - Safe-by-default: optional paper mode + max exposure guards
//
// REQUIREMENTS (env):
// - BITGET_API_KEY
// - BITGET_API_SECRET
// - BITGET_API_PASSPHRASE
// - API_SECRET or CRON_SECRET (for protected endpoints that call this)
// Optional env:
// - TRADE_MODE: "paper" | "live" (default: "paper")
// - TRADE_EXCHANGE: "bitget" (default)
// - TRADE_BASE_QUOTE: "USDT" (default)
// - TRADE_USE_QUOTE_SIZE: "1" to try market buy using quoteSize (USDT spend)
// - TRADE_DEFAULT_FORCE: "gtc" | "ioc" | "fok" (default: gtc)
// - TRADE_POSITION_USD_DEFAULT: number, default 50
// - TRADE_MAX_OPEN_ORDERS: default 12
// - TRADE_MAX_OPEN_POSITIONS: default 6
// - TRADE_MAX_TOTAL_EXPOSURE_USD: default 500
// - TRADE_SLIPPAGE_BPS: default 35 (0.35%) for market fallback sizing checks
// - TRADE_EXIT_POLL_GRACE_SEC: default 20 (avoid double-closing too fast)
//
// NOTE:
// Bitget spot does not provide native OCO on all endpoints.
// We implement "synthetic OCO": place entry, then place two exit orders:
// - TP: LIMIT sell (bull) or LIMIT buy (bear isn't spot-short; bear in this system is logical only)
// - SL: STOP (if supported) or a "trigger order" endpoint if available.
// If stop order endpoints are not available for your account/region, we fallback to
// "monitor and market exit" in the scanner loop.
//
// This engine is designed for LONG SPOT execution (bull mode).
// For bear mode you should run a derivatives engine; here we treat bear as "paper only" by default.

import { kv } from "@vercel/kv";
import { uid } from "../lib/analytics.js";
import { n, clamp } from "../lib/utils/numbers.js";
import { nowMs } from "../lib/utils/time.js";
import {
  normalizeBitgetSymbol,
  placeSpotOrder,
  placeSpotMarketBuyQuote,
  cancelSpotOrder,
  getSpotOrderInfo,
  getSpotOpenOrders,
  getSpotAccountAssets,
  getSpotTicker,
  quoteToBaseSize,
  formatSize,
  formatPrice,
} from "./bitgetTrade.js";

// ---------------------------
// Config
// ---------------------------
const TRADE_MODE = String(process.env.TRADE_MODE || "paper").toLowerCase(); // paper | live
const TRADE_EXCHANGE = String(process.env.TRADE_EXCHANGE || "bitget").toLowerCase();
const BASE_QUOTE = String(process.env.TRADE_BASE_QUOTE || "USDT").toUpperCase();

const USE_QUOTE_SIZE = String(process.env.TRADE_USE_QUOTE_SIZE || "1") === "1";

const MAX_OPEN_ORDERS = n(process.env.TRADE_MAX_OPEN_ORDERS, 12);
const MAX_OPEN_POSITIONS = n(process.env.TRADE_MAX_OPEN_POSITIONS, 6);
const MAX_TOTAL_EXPOSURE_USD = n(process.env.TRADE_MAX_TOTAL_EXPOSURE_USD, 500);

const DEFAULT_POSITION_USD = n(process.env.TRADE_POSITION_USD_DEFAULT, 50);
const SLIPPAGE_BPS = n(process.env.TRADE_SLIPPAGE_BPS, 35);
const EXIT_POLL_GRACE_SEC = n(process.env.TRADE_EXIT_POLL_GRACE_SEC, 20);

function isLive() {
  return TRADE_MODE === "live";
}

function bitgetAuthFromEnv() {
  return {
    apiKey: process.env.BITGET_API_KEY,
    apiSecret: process.env.BITGET_API_SECRET,
    passphrase: process.env.BITGET_API_PASSPHRASE,
  };
}

function mustHaveAuth() {
  const a = bitgetAuthFromEnv();
  if (!a.apiKey || !a.apiSecret || !a.passphrase) {
    throw new Error("Missing BITGET_API_KEY / BITGET_API_SECRET / BITGET_API_PASSPHRASE");
  }
  return a;
}

// ---------------------------
// KV keys
// ---------------------------
function keyExecPositions(mode) {
  return `exec:positions:${String(mode || "bull").toLowerCase()}`; // separate from scanner positions
}
function keyExecOrders(mode) {
  return `exec:orders:${String(mode || "bull").toLowerCase()}`;
}
function keyExecLocks(mode) {
  return `exec:lock:${String(mode || "bull").toLowerCase()}`;
}
function keyExecMeta() {
  return `exec:meta`;
}

// ---------------------------
// Helpers
// ---------------------------
function safeUpper(s) {
  return String(s || "").toUpperCase();
}
function safeLower(s) {
  return String(s || "").toLowerCase();
}

function assertBullOnlyForLive(mode) {
  const m = safeLower(mode);
  if (isLive() && m === "bear") {
    throw new Error("Live execution for bear mode is disabled (spot cannot short). Use paper mode or a derivatives engine.");
  }
}

function computeExposureUsd(positions) {
  const open = Array.isArray(positions?.open) ? positions.open : [];
  return open.reduce((a, p) => a + n(p.sizeUsd, 0), 0);
}

function approxBaseSizeFromUsd({ usd, lastPrice }) {
  const u = n(usd, 0);
  const p = n(lastPrice, 0);
  if (!(u > 0 && p > 0)) return 0;
  return u / p;
}

function clampToStep(value, step) {
  const v = n(value, 0);
  const s = n(step, 0);
  if (!(v > 0) || !(s > 0)) return v;
  return Math.floor(v / s) * s;
}

// ---------------------------
// Data model (stored in KV)
// ---------------------------
// positions.open[]: {
//   id, symbol, mode, exchange, status: "OPEN"|"CLOSED",
//   entryAt, entryPrice, sizeUsd, sizeBase,
//   tp, sl, rr, tpPct, slPct,
//   orders: { entryOrderId?, tpOrderId?, slOrderId? },
//   lastSyncAt, lastPrice, pnlPct, pnlUsd,
//   exitKind?, closedAt?, exitPrice?, exitReason?
// }
//
// orders[]: {
//   id, positionId, symbol, kind: "ENTRY"|"TP"|"SL", orderId, clientOid, status, createdAt
// }

// ---------------------------
// Public API
// ---------------------------

/**
 * Ensure KV structures exist
 */
export async function ensureExecStorage(mode = "bull") {
  const kPos = keyExecPositions(mode);
  const kOrd = keyExecOrders(mode);
  const [pos, ord] = await Promise.all([kv.get(kPos), kv.get(kOrd)]);
  if (!pos) await kv.set(kPos, { open: [], closed: [], updatedAt: nowMs() }, { ex: 60 * 60 * 24 * 14 });
  if (!ord) await kv.set(kOrd, { items: [], updatedAt: nowMs() }, { ex: 60 * 60 * 24 * 14 });
}

/**
 * Read exec positions
 */
export async function readExecPositions(mode = "bull") {
  await ensureExecStorage(mode);
  return (await kv.get(keyExecPositions(mode))) || { open: [], closed: [], updatedAt: nowMs() };
}

/**
 * Read exec orders
 */
export async function readExecOrders(mode = "bull") {
  await ensureExecStorage(mode);
  return (await kv.get(keyExecOrders(mode))) || { items: [], updatedAt: nowMs() };
}

/**
 * Main entry execution:
 * - creates a live/paper entry order
 * - returns updated position object
 *
 * Input "tradePlan" should be from scanner: { entry, sl, tp, rr, tpPct, slPct }
 */
export async function executeEntry({
  mode = "bull",
  symbol,
  lastPrice,
  sizeUsd,
  tradePlan,
  meta = {},
}) {
  assertBullOnlyForLive(mode);
  if (TRADE_EXCHANGE !== "bitget") throw new Error(`Unsupported exchange: ${TRADE_EXCHANGE}`);

  const sym = normalizeBitgetSymbol(symbol, BASE_QUOTE);
  const plan = tradePlan || null;
  if (!plan) throw new Error("executeEntry: tradePlan is required");

  const price = n(lastPrice, n(plan.entry, 0));
  if (!(price > 0)) throw new Error("executeEntry: lastPrice/entry must be > 0");

  const usd = n(sizeUsd, DEFAULT_POSITION_USD);
  if (!(usd > 0)) throw new Error("executeEntry: sizeUsd must be > 0");

  // limits / safety
  const positions = await readExecPositions(mode);
  const open = Array.isArray(positions.open) ? positions.open : [];

  if (open.length >= MAX_OPEN_POSITIONS) {
    return { ok: false, skipped: true, reason: "max_open_positions", open: open.length };
  }
  const exposure = computeExposureUsd(positions);
  if (exposure + usd > MAX_TOTAL_EXPOSURE_USD) {
    return { ok: false, skipped: true, reason: "max_total_exposure", exposure, usd, max: MAX_TOTAL_EXPOSURE_USD };
  }

  // build position object
  const id = uid("pos");
  const createdAt = nowMs();
  const pos = {
    id,
    symbol: sym,
    mode: safeLower(mode),
    exchange: "bitget",
    status: "OPEN",
    entryAt: createdAt,
    entryPrice: n(plan.entry, price),
    lastPrice: price,
    sizeUsd: usd,
    sizeBase: 0,
    tp: n(plan.tp, 0),
    sl: n(plan.sl, 0),
    rr: n(plan.rr, 0),
    tpPct: n(plan.tpPct, 0),
    slPct: n(plan.slPct, 0),
    pnlPct: 0,
    pnlUsd: 0,
    orders: {},
    meta: meta || {},
    lastSyncAt: 0,
  };

  // PAPER MODE: no exchange order, assume fill at entry
  if (!isLive()) {
    pos.sizeBase = approxBaseSizeFromUsd({ usd, lastPrice: pos.entryPrice });
    // store
    positions.open.unshift(pos);
    positions.updatedAt = nowMs();
    await kv.set(keyExecPositions(mode), positions, { ex: 60 * 60 * 24 * 14 });
    await appendExecOrder(mode, {
      positionId: id,
      symbol: sym,
      kind: "ENTRY",
      status: "FILLED",
      orderId: `paper_${id}`,
      clientOid: `paper_${id}`,
    });
    return { ok: true, mode, paper: true, position: pos };
  }

  // LIVE MODE: place entry order
  const auth = mustHaveAuth();

  // Try to buy by quote amount if supported.
  // If fails, fallback to base size using ticker last price.
  let entryRes = null;

  const clientOid = safeUpper(uid("entry"));
  if (USE_QUOTE_SIZE) {
    entryRes = await placeSpotMarketBuyQuote({
      symbol: sym,
      quoteSize: usd,
      clientOid,
      auth,
    });
  }

  if (!entryRes?.ok) {
    // fallback: compute base size from ticker last
    const t = await getSpotTicker({ symbol: sym });
    const last = n(t?.data?.[0]?.lastPr, n(t?.data?.[0]?.last, price));
    const baseSizeRaw = quoteToBaseSize({ quoteSize: usd, lastPrice: last });

    // add slippage buffer: we buy slightly less base to avoid insufficient funds
    const slip = clamp(SLIPPAGE_BPS, 0, 500) / 10000;
    const baseSize = baseSizeRaw * (1 - slip);

    entryRes = await placeSpotOrder({
      symbol: sym,
      side: "buy",
      orderType: "market",
      size: formatSize(baseSize, 8),
      clientOid,
      auth,
    });
  }

  if (!entryRes?.ok) {
    return { ok: false, error: "entry_order_failed", detail: entryRes };
  }

  const entryOrderId = entryRes?.data?.orderId || entryRes?.data?.orderIdStr || null;
  pos.orders.entryOrderId = entryOrderId || null;

  // Best-effort: read order info to get filled price/size
  let filledSize = 0;
  let avgPrice = pos.entryPrice;

  if (entryOrderId) {
    const info = await getSpotOrderInfo({ symbol: sym, orderId: entryOrderId, auth }).catch(() => null);
    const d = info?.data || null;

    // Different accounts expose fields differently; try several common keys:
    filledSize = n(d?.baseVolume, n(d?.filledQty, n(d?.filledSize, n(d?.size, 0))));
    avgPrice = n(d?.priceAvg, n(d?.avgPrice, n(d?.price, avgPrice)));
  }

  // If not available, approximate:
  if (!(filledSize > 0)) filledSize = approxBaseSizeFromUsd({ usd, lastPrice: avgPrice });
  pos.sizeBase = filledSize;
  pos.entryPrice = avgPrice;
  pos.lastPrice = avgPrice;

  // store position
  positions.open.unshift(pos);
  positions.updatedAt = nowMs();
  await kv.set(keyExecPositions(mode), positions, { ex: 60 * 60 * 24 * 14 });

  await appendExecOrder(mode, {
    positionId: id,
    symbol: sym,
    kind: "ENTRY",
    status: "PLACED",
    orderId: entryOrderId || "",
    clientOid,
  });

  // place exits (best effort)
  const exits = await placeSyntheticExits({ mode, position: pos, auth }).catch((e) => ({
    ok: false,
    error: e?.message || String(e),
  }));

  return { ok: true, mode, paper: false, position: pos, exits };
}

/**
 * Sync & manage exits for all open positions:
 * - updates lastPrice/pnl using provided priceMap or ticker fallback
 * - checks if TP/SL orders filled (if we have orderIds)
 * - if no stop-order support: optionally market-exit when SL hit (synthetic)
 */
export async function syncAndManageOpenPositions({
  mode = "bull",
  priceMap = new Map(), // symbol->price from scanner
  allowMarketStopFallback = true,
}) {
  assertBullOnlyForLive(mode);
  const positions = await readExecPositions(mode);
  const open = Array.isArray(positions.open) ? positions.open : [];
  if (!open.length) return { ok: true, open: 0, closed: 0 };

  const auth = isLive() ? mustHaveAuth() : null;
  const now = nowMs();

  let closedCount = 0;

  for (let i = open.length - 1; i >= 0; i--) {
    const pos = open[i];
    if (!pos || pos.status !== "OPEN") continue;

    const sym = pos.symbol;
    const price = n(priceMap.get(sym), n(pos.lastPrice, 0));
    let last = price;

    // fallback to ticker if no scanner price
    if (!(last > 0)) {
      const t = await getSpotTicker({ symbol: sym }).catch(() => null);
      last = n(t?.data?.[0]?.lastPr, n(t?.data?.[0]?.last, 0));
    }

    if (last > 0) pos.lastPrice = last;

    // update pnl (bull long)
    const entry = n(pos.entryPrice, 0);
    const pnlPct = entry > 0 && last > 0 ? ((last - entry) / entry) * 100 : 0;
    pos.pnlPct = Number(pnlPct.toFixed(3));
    pos.pnlUsd = Number(((n(pos.sizeUsd, 0) * pnlPct) / 100).toFixed(2));

    // Avoid double close loops
    const lastSync = n(pos.lastSyncAt, 0);
    pos.lastSyncAt = now;

    // PAPER: close if hits tp/sl based on price
    if (!isLive()) {
      const ht = hitPlan(pos, last);
      if (ht.hit) {
        const closed = closeLocalPosition(positions, i, {
          exitKind: ht.kind,
          exitPrice: last,
          exitReason: ht.kind === "TP" ? "take_profit" : "stop_loss",
        });
        if (closed) closedCount++;
      }
      continue;
    }

    // LIVE: if we have tp/sl order ids, poll their status
    const tpId = pos?.orders?.tpOrderId || null;
    const slId = pos?.orders?.slOrderId || null;

    // If recently synced, avoid spamming
    const graceMs = clamp(EXIT_POLL_GRACE_SEC, 5, 120) * 1000;
    const canPoll = now - lastSync >= graceMs;

    if (canPoll && (tpId || slId)) {
      // if tp filled -> close
      if (tpId) {
        const info = await getSpotOrderInfo({ symbol: sym, orderId: tpId, auth }).catch(() => null);
        if (isFilled(info?.data)) {
          // cancel SL
          if (slId) await cancelSpotOrder({ symbol: sym, orderId: slId, auth }).catch(() => {});
          const avgExit = n(info?.data?.priceAvg, n(info?.data?.avgPrice, last));
          const closed = await closeExecPositionKV(mode, positions, i, {
            exitKind: "TP",
            exitPrice: avgExit,
            exitReason: "tp_filled",
          });
          if (closed) closedCount++;
          continue;
        }
      }
      if (slId) {
        const info = await getSpotOrderInfo({ symbol: sym, orderId: slId, auth }).catch(() => null);
        if (isFilled(info?.data)) {
          // cancel TP
          if (tpId) await cancelSpotOrder({ symbol: sym, orderId: tpId, auth }).catch(() => {});
          const avgExit = n(info?.data?.priceAvg, n(info?.data?.avgPrice, last));
          const closed = await closeExecPositionKV(mode, positions, i, {
            exitKind: "SL",
            exitPrice: avgExit,
            exitReason: "sl_filled",
          });
          if (closed) closedCount++;
          continue;
        }
      }
    }

    // If no SL order (or stop unsupported) => fallback: market exit when SL hit
    if (allowMarketStopFallback) {
      const ht = hitPlan(pos, last);
      if (ht.hit && ht.kind === "SL") {
        // cancel TP if exists
        if (tpId) await cancelSpotOrder({ symbol: sym, orderId: tpId, auth }).catch(() => {});
        // market sell base size
        const sellRes = await placeSpotOrder({
          symbol: sym,
          side: "sell",
          orderType: "market",
          size: formatSize(n(pos.sizeBase, 0), 8),
          clientOid: safeUpper(uid("mkt_sl")),
          auth,
        }).catch((e) => ({ ok: false, error: e?.message || String(e) }));

        if (sellRes?.ok) {
          const closed = await closeExecPositionKV(mode, positions, i, {
            exitKind: "SL",
            exitPrice: last,
            exitReason: "market_stop_fallback",
          });
          if (closed) closedCount++;
          continue;
        }
      }
    }
  }

  // persist
  positions.updatedAt = nowMs();
  await kv.set(keyExecPositions(mode), positions, { ex: 60 * 60 * 24 * 14 });

  return { ok: true, open: positions.open.length, closed: closedCount };
}

// =======================================================
// Internal: exits, closing, orders
// =======================================================

function hitPlan(pos, lastPrice) {
  const p = n(lastPrice, 0);
  if (!(p > 0)) return { hit: false };

  const tp = n(pos.tp, 0);
  const sl = n(pos.sl, 0);

  // bull long only
  if (tp > 0 && p >= tp) return { hit: true, kind: "TP" };
  if (sl > 0 && p <= sl) return { hit: true, kind: "SL" };
  return { hit: false };
}

function isFilled(orderData) {
  const st = String(orderData?.status || orderData?.state || "").toLowerCase();
  // common: filled, full_fill, success
  if (["filled", "full_fill", "success"].includes(st)) return true;
  const filledQty = n(orderData?.baseVolume, n(orderData?.filledQty, n(orderData?.filledSize, 0)));
  const size = n(orderData?.size, 0);
  if (size > 0 && filledQty >= size * 0.999) return true;
  return false;
}

/**
 * Place synthetic TP/SL orders for a position.
 * - TP: limit sell at tp
 * - SL: try stop/trigger endpoint; if unavailable, skip and rely on market fallback.
 */
async function placeSyntheticExits({ mode, position, auth }) {
  const m = safeLower(mode);
  if (m !== "bull") return { ok: false, skipped: true, reason: "bear_not_supported_spot" };

  const sym = position.symbol;
  const sizeBase = n(position.sizeBase, 0);
  if (!(sizeBase > 0)) throw new Error("placeSyntheticExits: position.sizeBase must be > 0");

  const tp = n(position.tp, 0);
  const sl = n(position.sl, 0);

  const out = { ok: true, tp: null, sl: null };

  // TP order (limit sell)
  if (tp > 0) {
    const clientOid = safeUpper(uid("tp"));
    const tpRes = await placeSpotOrder({
      symbol: sym,
      side: "sell",
      orderType: "limit",
      size: formatSize(sizeBase, 8),
      price: formatPrice(tp, 8),
      force: process.env.TRADE_DEFAULT_FORCE || "gtc",
      clientOid,
      auth,
    });

    out.tp = tpRes;
    if (tpRes?.ok) {
      const tpOrderId = tpRes?.data?.orderId || null;
      position.orders.tpOrderId = tpOrderId;
      await appendExecOrder(m, {
        positionId: position.id,
        symbol: sym,
        kind: "TP",
        status: "PLACED",
        orderId: tpOrderId || "",
        clientOid,
      });
    }
  }

  // SL order (best-effort):
  // Many Bitget Spot setups use "place-plan-order" or "place-trigger-order".
  // We'll try a known v2 path; if it fails, we skip (market fallback in sync loop).
  if (sl > 0) {
    const clientOid = safeUpper(uid("sl"));
    const slRes = await placeSpotStopLossBestEffort({
      symbol: sym,
      sizeBase,
      triggerPrice: sl,
      clientOid,
      auth,
    });

    out.sl = slRes;
    if (slRes?.ok) {
      const slOrderId = slRes?.data?.orderId || slRes?.data?.planOrderId || null;
      position.orders.slOrderId = slOrderId;
      await appendExecOrder(m, {
        positionId: position.id,
        symbol: sym,
        kind: "SL",
        status: "PLACED",
        orderId: slOrderId || "",
        clientOid,
      });
    } else {
      out.sl = { ...slRes, skipped: true, reason: "stop_not_supported_using_market_fallback" };
    }
  }

  // persist the position update (tp/sl ids) by rewriting positions
  const positions = await readExecPositions(m);
  const idx = positions.open.findIndex((p) => p.id === position.id);
  if (idx >= 0) positions.open[idx] = position;
  positions.updatedAt = nowMs();
  await kv.set(keyExecPositions(m), positions, { ex: 60 * 60 * 24 * 14 });

  return out;
}

/**
 * Best-effort Stop Loss placement.
 * If Bitget endpoint differs, this returns {ok:false, ...} and sync loop will use market fallback.
 */
async function placeSpotStopLossBestEffort({ symbol, sizeBase, triggerPrice, clientOid, auth }) {
  // Try common plan/trigger endpoint variants.
  // 1) /api/v2/spot/trade/place-plan-order
  // 2) /api/v2/spot/trade/place-trigger-order
  //
  // Payloads vary per region. We'll attempt a generic one:
  // - planType: "loss_plan"
  // - triggerType: "mark_price" or "fill_price"
  //
  // If your Bitget spot stop endpoint requires different fields,
  // update this function accordingly.

  const sym = normalizeBitgetSymbol(symbol, BASE_QUOTE);
  const sz = n(sizeBase, 0);
  const tp = n(triggerPrice, 0);
  if (!(sz > 0 && tp > 0)) return { ok: false, error: "invalid_stop_params" };

  const attempts = [
    {
      path: "/api/v2/spot/trade/place-plan-order",
      body: {
        symbol: sym,
        side: "sell",
        orderType: "market",
        size: String(sz),
        triggerPrice: String(tp),
        planType: "loss_plan",
        triggerType: "fill_price",
        clientOid,
      },
    },
    {
      path: "/api/v2/spot/trade/place-trigger-order",
      body: {
        symbol: sym,
        side: "sell",
        orderType: "market",
        size: String(sz),
        triggerPrice: String(tp),
        triggerType: "fill_price",
        clientOid,
      },
    },
  ];

  for (const a of attempts) {
    const r = await safeBitgetSignedPost(a.path, a.body, auth);
    if (r?.ok) return r;
  }

  return { ok: false, error: "stop_order_not_placed" };
}

async function safeBitgetSignedPost(path, body, auth) {
  // Use bitgetFetch indirectly via bitgetTrade helpers? We don’t have it exported here.
  // We can call placeSpotOrder only, but stop endpoints need raw signing.
  // bitgetAuth.js exports bitgetFetch, so we import dynamically to avoid circular deps risk.
  try {
    const mod = await import("./bitgetAuth.js");
    const bitgetFetch = mod?.bitgetFetch;
    if (!bitgetFetch) return { ok: false, error: "bitgetFetch_missing" };

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
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function appendExecOrder(mode, { positionId, symbol, kind, orderId, clientOid, status }) {
  const k = keyExecOrders(mode);
  const cur = (await kv.get(k)) || { items: [], updatedAt: nowMs() };
  const items = Array.isArray(cur.items) ? cur.items : [];

  items.unshift({
    id: uid("ord"),
    positionId,
    symbol,
    kind,
    orderId: orderId || "",
    clientOid: clientOid || "",
    status: status || "PLACED",
    createdAt: nowMs(),
  });

  // keep latest 500
  const next = { items: items.slice(0, 500), updatedAt: nowMs() };
  await kv.set(k, next, { ex: 60 * 60 * 24 * 14 });
}

/**
 * Close in KV (live or paper) and move to closed array
 */
async function closeExecPositionKV(mode, positions, idx, { exitKind, exitPrice, exitReason }) {
  const now = nowMs();
  const pos = positions.open[idx];
  if (!pos) return null;

  const closed = {
    ...pos,
    status: "CLOSED",
    closedAt: now,
    exitKind: exitKind || "EXIT",
    exitPrice: n(exitPrice, n(pos.lastPrice, 0)),
    exitReason: exitReason || "exit",
  };

  positions.open.splice(idx, 1);
  positions.closed.unshift(closed);
  positions.closed = positions.closed.slice(0, 2000);

  await kv.set(keyExecPositions(mode), { ...positions, updatedAt: now }, { ex: 60 * 60 * 24 * 14 });
  return closed;
}

function closeLocalPosition(positions, idx, { exitKind, exitPrice, exitReason }) {
  const now = nowMs();
  const pos = positions.open[idx];
  if (!pos) return null;

  const closed = {
    ...pos,
    status: "CLOSED",
    closedAt: now,
    exitKind,
    exitPrice: n(exitPrice, n(pos.lastPrice, 0)),
    exitReason,
  };

  positions.open.splice(idx, 1);
  positions.closed.unshift(closed);
  positions.closed = positions.closed.slice(0, 2000);
  return closed;
}

// =======================================================
// Optional: simple safety audit helpers
// =======================================================

/**
 * Quick account check: does the account have enough USDT for a buy?
 */
export async function checkQuoteBalance({ minUsd = 10, auth } = {}) {
  if (!isLive()) return { ok: true, paper: true, has: 999999 };
  const a = auth || mustHaveAuth();
  const res = await getSpotAccountAssets({ coin: BASE_QUOTE, auth: a });
  if (!res.ok) return { ok: false, error: res };
  const item = Array.isArray(res.data) ? res.data[0] : res.data;
  const available = n(item?.available, n(item?.availBal, n(item?.free, 0)));
  return { ok: available >= minUsd, has: available };
}

/**
 * Optional: cancel all open orders for a symbol (manual tool)
 */
export async function cancelAllOpenOrdersForSymbol({ symbol, auth } = {}) {
  if (!isLive()) return { ok: true, paper: true };
  const a = auth || mustHaveAuth();
  const sym = normalizeBitgetSymbol(symbol, BASE_QUOTE);
  const open = await getSpotOpenOrders({ symbol: sym, auth: a });
  if (!open.ok) return { ok: false, error: open };
  const items = Array.isArray(open.data) ? open.data : [];
  const results = [];
  for (const o of items) {
    const orderId = o?.orderId || o?.orderIdStr || o?.id;
    if (!orderId) continue;
    const r = await cancelSpotOrder({ symbol: sym, orderId, auth: a }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
    results.push({ orderId, ok: !!r.ok, detail: r });
  }
  return { ok: true, cancelled: results.length, results };
}