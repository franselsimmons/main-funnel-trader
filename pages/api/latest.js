// pages/api/latest.js
import { kv } from "@vercel/kv";
import { keyMainLatest } from "../../lib/keys.js";
import { RUNTIME_CONFIG } from "../../lib/core/settings.js";
import { n, safeArr } from "../../lib/utils/numbers.js";

export const config = RUNTIME_CONFIG;

/**
 * GET /api/latest?mode=bull|bear
 *
 * Returns the latest main-funnel snapshot from KV.
 * - Safe defaults if not present
 * - Normalizes funnel arrays + counts
 * - Adds meta.scanLock if present in stored snapshot
 */
export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
    const latest = (await kv.get(keyMainLatest(mode))) || null;

    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        btc: { state: "NEUTRAL", chg24: 0, chg1h: 0, range24: 0, price: 0 },
        whaleFlow: 0,
        funnel: {
          elite_expansion: [],
          elite_ignition: [],
          almost: [],
          buildup: [],
          radar: [],
          hold: [],
          sell: [],
        },
        counts: {
          elite_expansion: 0,
          elite_ignition: 0,
          almost: 0,
          buildup: 0,
          radar: 0,
          hold: 0,
          sell: 0,
          entry: 0,
        },
        candidates: { premium: [], tradeReady: [], watch: [], scannerOnly: [] },
        portfolio: { openCount: 0, closedCount: 0, realizedUsd: 0, avgRealizedPct: 0, updatedAt: 0 },
        positions: { open: 0, closed: 0 },
        meta: { scanLock: { active: false, until: null } },
      });
    }

    const f = latest?.funnel || {};
    const elite_expansion = safeArr(f.elite_expansion);
    const elite_ignition = safeArr(f.elite_ignition);
    const almost = safeArr(f.almost);
    const buildup = safeArr(f.buildup);
    const radar = safeArr(f.radar);
    const hold = safeArr(f.hold);
    const sell = safeArr(f.sell);

    const ts = n(latest?.ts, n(latest?.scannedAt, 0));
    const scannedAt = n(latest?.scannedAt, ts);

    return res.status(200).json({
      ...latest,
      ok: true,
      mode,
      ts,
      scannedAt,
      btc: latest?.btc || { state: "NEUTRAL", chg24: 0, chg1h: 0, range24: 0, price: 0 },
      funnel: { elite_expansion, elite_ignition, almost, buildup, radar, hold, sell },
      counts: {
        elite_expansion: elite_expansion.length,
        elite_ignition: elite_ignition.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
        hold: hold.length,
        sell: sell.length,
        entry: elite_expansion.length + elite_ignition.length,
      },
      positions: latest?.positions || { open: n(latest?.portfolio?.openCount, 0), closed: n(latest?.portfolio?.closedCount, 0) },
      meta: {
        ...(latest?.meta || {}),
        scanLock: latest?.meta?.scanLock || { active: false, until: null },
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("api/latest error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "latest_failed" });
  }
}