import { kv } from "@vercel/kv";
import { updateOpenTrades } from "../../lib/tradeEngine";

export const config = { runtime: "nodejs" };

const keyProgress = (m) => `progress:${m}`;

export default async function handler(req, res) {
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
      type: "execution_only",
      ts: Date.now(),
    });

  } catch (e) {
    console.error("EXECUTION_FATAL:", e);
    return res.json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}