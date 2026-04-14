import { kv } from "@vercel/kv";
import { executeTrade } from "../../lib/tradeEngine";
import { fetchOrderbook } from "../../lib/orderbook";

function arr(x) {
  return Array.isArray(x) ? x : [];
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    // JOUW STRUCTUUR: state:bull bevat entry_ready/setup/warmup/radar arrays
    const state = (await kv.get(`state:${mode}`)) || {};
    const entryReady = arr(state?.entry_ready);

    // open trades lijst
    const open = arr(await kv.get(`open:${mode}`));

    // snelle lookup om duplicates te voorkomen
    const openSet = new Set(open.map(t => String(t.symbol || "").toUpperCase()));

    let openedNow = 0;
    let skippedDuplicate = 0;
    let skippedLiquidity = 0;

    // Alleen ENTRY_READY coins proberen te openen
    for (const c of entryReady) {
      const sym = String(c?.symbol || "").toUpperCase();
      if (!sym) continue;

      // geen duplicate opens
      if (openSet.has(sym)) {
        skippedDuplicate++;
        continue;
      }

      // OPTIONAL: echte orderbook gate vóór open
      // (als je dit weglaat opent hij altijd)
      const ob = await fetchOrderbook(`${sym}USDT`);

      // Als OB faalt: skip
      if (!ob) {
        skippedLiquidity++;
        continue;
      }

      // Spread / depth gating (tune dit!)
      const spreadMax = 1.25;      // % max spread
      const depthMinUsd = 1500;    // minimale depth

      if ((ob.spreadPct || 999) > spreadMax || (ob.depthMin || 0) < depthMinUsd) {
        skippedLiquidity++;
        continue;
      }

      // Open trade
      await executeTrade(mode, {
        ...c,
        ob,
      });

      openSet.add(sym);
      openedNow++;
    }

    const openAfter = arr(await kv.get(`open:${mode}`));

    res.json({
      ok: true,
      mode,
      entryReadyCount: entryReady.length,
      openedNow,
      skippedDuplicate,
      skippedLiquidity,
      open: openAfter,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}