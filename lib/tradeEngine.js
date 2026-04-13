import { kv } from "@vercel/kv";

export async function executeTrade(mode, coin) {
  const open = await kv.get(`open:${mode}`) || [];

  open.push({
    symbol: coin.symbol,
    entry: coin.price,
    side: mode === "bear" ? "SHORT" : "LONG",
    openedAt: Date.now()
  });

  await kv.set(`open:${mode}`, open, { ex: 3600 * 6 });
}