import { kv } from "@vercel/kv";
import { fetchOrderbook } from "./orderbook.js";

function up(x) {
  return String(x || "").toUpperCase();
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function nowTs() {
  return Date.now();
}

/**
 * Trade execution: paper/open-log in KV
 * - uses orderbook gating (spread + depth)
 * - dedupes open trades
 * - logs rejects for debug/analyse
 */
export async function executeTrade(mode, coin, opts = {}) {
  const m = String(mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const symbol = up(coin?.symbol);
  if (!symbol) return { ok: false, reason: "missing_symbol" };

  // ---- config defaults (kan later uit KV configStore komen) ----
  const maxOpen = n(opts.maxOpen, 3);
  const entryTolerancePct = n(opts.entryTolerancePct, 2.5); // FIX: was vaak te strak
  const maxSpreadPct = n(opts.maxSpreadPct, 1.25);
  const minDepthUsd1p = n(opts.minDepthUsd1p, 1200);

  // ---- load open positions ----
  const openKey = `open:${m}`;
  const open = (await kv.get(openKey)) || [];
  const openArr = Array.isArray(open) ? open : [];

  // already open?
  if (openArr.some((p) => up(p?.symbol) === symbol)) {
    return { ok: true, skipped: true, reason: "already_open" };
  }

  if (openArr.length >= maxOpen) {
    await logReject(m, symbol, "max_open_reached", { maxOpen });
    return { ok: false, reason: "max_open_reached" };
  }

  // ---- compute entry reference ----
  // prefer tradePlan.entry if available; else use coin.price snapshot
  const entry = n(coin?.tradePlan?.entry, n(coin?.price, 0));
  const price = n(coin?.price, 0);

  if (!(entry > 0) || !(price > 0)) {
    await logReject(m, symbol, "missing_price_or_entry", { entry, price });
    return { ok: false, reason: "missing_price_or_entry" };
  }

  // ---- orderbook gating ----
  const obSymbol = `${symbol}USDT`;
  const ob = await fetchOrderbook(obSymbol);

  if (!ob || !ob.valid) {
    // Als OB faalt: liever NIET traden (anders koop je rommel).
    await logReject(m, symbol, "orderbook_missing", { ob });
    return { ok: false, reason: "orderbook_missing" };
  }

  if (n(ob.spreadPct, 999) > maxSpreadPct) {
    await logReject(m, symbol, "spread_too_high", {
      spreadPct: ob.spreadPct,
      maxSpreadPct,
    });
    return { ok: false, reason: "spread_too_high" };
  }

  if (n(ob.depthMinUsd1p, 0) < minDepthUsd1p) {
    await logReject(m, symbol, "depth_too_low", {
      depthMinUsd1p: ob.depthMinUsd1p,
      minDepthUsd1p,
    });
    return { ok: false, reason: "depth_too_low" };
  }

  // ---- entry tolerance gate ----
  // Price vs Entry must be within tolerance, otherwise you never trigger.
  const distPct = Math.abs((price - entry) / entry) * 100;
  if (distPct > entryTolerancePct) {
    await logReject(m, symbol, "entry_too_far", {
      price,
      entry,
      distPct,
      entryTolerancePct,
    });
    return { ok: false, reason: "entry_too_far" };
  }

  // ---- "execution" (paper) ----
  const side = m === "bear" ? "SHORT" : "LONG";

  const row = {
    id: `T_${symbol}_${nowTs()}`,
    symbol,
    side,
    entry,
    priceAtOpen: price,
    spreadPct: n(ob.spreadPct, 999),
    depthMinUsd1p: Math.round(n(ob.depthMinUsd1p, 0)),
    openedAt: nowTs(),

    // optional plan
    tp: n(coin?.tradePlan?.tp, 0),
    sl: n(coin?.tradePlan?.sl, 0),
    tpPct: n(coin?.tradePlan?.tpPct, 0),
    slPct: n(coin?.tradePlan?.slPct, 0),
    rr: n(coin?.tradePlan?.rr, 0),

    // useful debug
    stage: String(coin?.stage || coin?.pipelineStage || ""),
    confidence: n(coin?.confidence, n(coin?.entryQuality, 0)),
  };

  openArr.push(row);
  await kv.set(openKey, openArr, { ex: 3600 * 6 });

  // log event stream (voor analyse)
  await kv.lpush(`trade:events:${m}`, {
    type: "OPEN",
    symbol,
    ts: nowTs(),
    row,
  });

  return { ok: true, opened: true, row };
}

async function logReject(mode, symbol, reason, meta = {}) {
  try {
    const m = String(mode || "bull");
    const key = `trade:rejects:${m}`;
    const item = { ts: nowTs(), symbol, reason, meta };
    await kv.lpush(key, item);
    // keep list bounded
    await kv.ltrim(key, 0, 300);
  } catch {}
}