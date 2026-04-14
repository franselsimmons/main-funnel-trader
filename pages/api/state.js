// pages/api/state.js

import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, max-age=0, s-maxage=30, stale-while-revalidate=30");

  try {
    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear"
        ? "bear"
        : "bull";

    const stateKey = `state:${mode}`;
    const autoKey = `scan:auto:${mode}`;
    const accountKey = "account:global";

    const state = await kv.get(stateKey);
    const auto = await kv.get(autoKey);
    const account = await kv.get(accountKey);

    /* ================= FALLBACK ================= */

    const safeState = state || {
      ts: 0,
      regime: { label: "NEUTRAL", score: 0 },
      funnel: {
        radar: [],
        warmup: [],
        setup: [],
        entry_ready: [],
      },
    };

    /* ================= NORMALIZE REGIME ================= */

    const regimeObj = safeState.regime || {};
    const regime = {
      label: String(regimeObj.label || regimeObj.regime || "NEUTRAL"),
      score: n(regimeObj.score, 0),
    };

    /* ================= RESPONSE ================= */

    return res.status(200).json({
      ok: true,
      mode,
      ts: n(safeState.ts, 0),
      lastScan: n(auto?.lastRun || safeState.ts, 0),
      nextScan: n(auto?.nextDue, 0),
      scanIntervalMinutes: 15,
      account: account || {
        equity: 0,
        peak: 0,
        trades: 0,
        wins: 0,
        losses: 0,
      },
      regime,
      funnel: safeState.funnel || {
        radar: [],
        warmup: [],
        setup: [],
        entry_ready: [],
      },
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}