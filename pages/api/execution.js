import { kv } from "@vercel/kv";
import { updateOpenTrades } from "../../lib/tradeEngine";

export const config = { runtime: "nodejs" };

function isAuthorized(req) {
  const token = process.env.CRON_SECRET;
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

const keyProgress = (m) => `progress:${m}`;

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const modes = ["bull", "bear"];

    for (const mode of modes) {
      const state = (await kv.get(keyProgress(mode))) || {};
      const latestPrices = {};

      for (const coin of Object.values(state)) {
        latestPrices[coin.symbol] = coin.price;
      }

      await updateOpenTrades(mode, latestPrices);
    }

    return res.json({
      ok: true,
      type: "execution_loop",
      ts: Date.now(),
    });

  } catch (e) {
    console.error("EXECUTION_FATAL:", e);
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}