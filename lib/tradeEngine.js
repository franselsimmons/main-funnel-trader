import { kv } from "@vercel/kv";
import { fetchOrderbook } from "./orderbook.js";

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

const ACCOUNT_KEY = "account:global";
const OPEN_PREFIX = "open:";
const EVENTS_PREFIX = "trade:events:";
const REJECT_PREFIX = "trade:rejects:";

/* ================= ACCOUNT ================= */

async function getAccount() {
  let acc = await kv.get(ACCOUNT_KEY);
  if (!acc) {
    acc = {
      equity: 10000,
      peak: 10000,
      trades: 0,
      wins: 0,
      losses: 0,
    };
    await kv.set(ACCOUNT_KEY, acc);
  }
  return acc;
}

async function updateAccount(pnl) {
  const acc = await getAccount();

  acc.equity += pnl;
  acc.trades++;

  if (pnl >= 0) acc.wins++;
  else acc.losses++;

  if (acc.equity > acc.peak) acc.peak = acc.equity;

  await kv.set(ACCOUNT_KEY, acc);
}

/* ================= EXECUTE ================= */

export async function executeTrade(mode, coin, opts = {}) {
  const m = mode === "bear" ? "bear" : "bull";
  const symbol = up(coin?.symbol);
  if (!symbol) return { ok: false, reason: "missing_symbol" };

  const openKey = OPEN_PREFIX + m;
  const open = (await kv.get(openKey)) || [];

  if (open.find((t) => t.symbol === symbol))
    return { ok: false, reason: "already_open" };

  const maxOpen = n(opts.maxOpen, 5);
  if (open.length >= maxOpen)
    return { ok: false, reason: "max_open" };

  const entry = n(coin?.tradePlan?.entry, coin?.price);
  const price = n(coin?.price);

  if (!entry || !price)
    return { ok: false, reason: "no_price" };

  const ob = await fetchOrderbook(symbol + "USDT");
  if (!ob?.valid)
    return retryReject(m, symbol, "ob_invalid");

  const spreadMax = n(opts.maxSpreadPct, 2);
  const depthMin = n(opts.minDepthUsd1p, 800);

  if (ob.spreadPct > spreadMax) {
    return retryReject(
      m,
      symbol,
      "spread_" + ob.spreadPct.toFixed(2)
    );
  }

  if (ob.depthMinUsd1p < depthMin) {
    return retryReject(
      m,
      symbol,
      "depth_" + Math.round(ob.depthMinUsd1p)
    );
  }

  const account = await getAccount();
  const riskPct = 0.02;
  const capital = account.equity * riskPct;
  const qty = capital / price;

  const row = {
    id: "T_" + symbol + "_" + now(),
    symbol,
    side: m === "bear" ? "SHORT" : "LONG",
    entry,
    qty,
    capital,
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

    let pnl = 0;
    let close = false;

    if (trade.side === "LONG") {
      if (price >= trade.tp || price <= trade.sl) {
        pnl = (price - trade.entry) * trade.qty;
        close = true;
      }
    } else {
      if (price <= trade.tp || price >= trade.sl) {
        pnl = (trade.entry - price) * trade.qty;
        close = true;
      }
    }

    if (!close && now() - trade.openedAt > 6 * 3600 * 1000) {
      pnl =
        trade.side === "LONG"
          ? (price - trade.entry) * trade.qty
          : (trade.entry - price) * trade.qty;
      close = true;
    }

    if (close) {
      await updateAccount(pnl);

      await kv.lpush(EVENTS_PREFIX + m, {
        type: "CLOSE",
        ts: now(),
        pnl,
        trade,
      });
    } else {
      remaining.push(trade);
    }
  }

  await kv.set(key, remaining, { ex: 3600 * 6 });
}

/* ================= REJECT ================= */

async function retryReject(mode, symbol, reason) {
  await kv.lpush(REJECT_PREFIX + mode, {
    ts: now(),
    symbol,
    reason,
  });

  return { ok: false, reason };
}