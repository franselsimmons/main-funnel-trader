import { kv } from "@vercel/kv";

function up(x) {
  return String(x || "").toUpperCase();
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function now() {
  return Date.now();
}

const OPEN_PREFIX = "open:";
const EVENTS_PREFIX = "trade:events:";
const REJECT_PREFIX = "trade:rejects:";

/* ================= EXECUTE ================= */

export async function executeTrade(mode, coin, opts = {}) {
  const m = mode === "bear" ? "bear" : "bull";
  const symbol = up(coin?.symbol);
  if (!symbol) return { ok: false, reason: "missing_symbol" };

  const openKey = OPEN_PREFIX + m;
  const open = (await kv.get(openKey)) || [];

  if (open.find((t) => t.symbol === symbol))
    return { ok: false, reason: "already_open" };

  const entry = n(coin?.tradePlan?.entry, coin?.price);
  const price = n(coin?.price);

  if (!entry || !price)
    return reject(m, symbol, "no_price");

  // ✅ FIX: gebruik OB van scan
  const ob = opts.ob;

  if (!ob) {
    return reject(m, symbol, "no_ob");
  }

  // ✅ SOFT FILTERS (veel minder strict)
  const spreadMax = n(opts.maxSpreadPct, 3); // was 2 → nu 3
  const depthMin = n(opts.minDepthUsd1p, 300); // was 800 → nu 300

  if (ob.spreadPct > spreadMax) {
    return reject(m, symbol, "spread_" + ob.spreadPct.toFixed(2));
  }

  if (ob.depthMinUsd1p < depthMin) {
    return reject(m, symbol, "depth_" + Math.round(ob.depthMinUsd1p));
  }

  const capital = 100; // simpele fixed size
  const qty = capital / price;

  const row = {
    id: "T_" + symbol + "_" + now(),
    symbol,
    side: m === "bear" ? "SHORT" : "LONG",
    entry,
    qty,
    tp: coin?.tradePlan?.tp,
    sl: coin?.tradePlan?.sl,
    openedAt: now(),
  };

  open.push(row);
  await kv.set(openKey, open, { ex: 3600 * 6 });

  await kv.lpush(EVENTS_PREFIX + m, {
    type: "OPEN",
    ts: now(),
    row,
  });

  return { ok: true, opened: true };
}

/* ================= AUTO CLOSE ================= */

export async function updateOpenTrades(mode, latestPrices) {
  const m = mode === "bear" ? "bear" : "bull";
  const key = OPEN_PREFIX + m;
  const open = (await kv.get(key)) || [];
  const remaining = [];

  for (const trade of open) {
    const price = n(latestPrices?.[trade.symbol], trade.entry);

    let close = false;

    if (trade.side === "LONG") {
      if (price >= trade.tp || price <= trade.sl) close = true;
    } else {
      if (price <= trade.tp || price >= trade.sl) close = true;
    }

    if (close) {
      await kv.lpush(EVENTS_PREFIX + m, {
        type: "CLOSE",
        ts: now(),
        trade,
      });
    } else {
      remaining.push(trade);
    }
  }

  await kv.set(key, remaining, { ex: 3600 * 6 });
}

/* ================= REJECT ================= */

async function reject(mode, symbol, reason) {
  await kv.lpush(REJECT_PREFIX + mode, {
    ts: now(),
    symbol,
    reason,
  });

  return { ok: false, reason };
}