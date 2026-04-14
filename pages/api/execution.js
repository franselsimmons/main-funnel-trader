import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function isAuthorized(req) {
  const token = process.env.CRON_SECRET;
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

const keyProgress = (m) => `progress:${m}`;

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false });
  }

  try {
    const modes = ["bull", "bear"];

    for (const mode of modes) {
      const keys = await kv.keys(`trade:open:${mode}:*`);
      const progress = (await kv.get(keyProgress(mode))) || {};

      for (const key of keys) {
        const trade = await kv.get(key);
        if (!trade) continue;

        const coin = progress[trade.symbol];
        if (!coin) continue;

        const price = coin.price;

        let pnl = 0;

        if (trade.side === "LONG") {
          pnl = ((price - trade.entry) / trade.entry) * 100;
        } else {
          pnl = ((trade.entry - price) / trade.entry) * 100;
        }

        await kv.set(key, {
          ...trade,
          price,
          pnl,
          updatedAt: Date.now(),
        });
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
}