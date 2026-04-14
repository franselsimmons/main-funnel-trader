import { kv } from "@vercel/kv";

// --- helpers
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

function pctDist(a, b) {
  const aa = n(a, 0);
  const bb = n(b, 0);
  if (!(aa > 0) || !(bb > 0)) return 999;
  return Math.abs((aa - bb) / bb) * 100;
}

// Entry trigger:
// - price must be within tolerancePct of entry
// - spread must be <= spreadMax
function entryTriggerOk({ price, entry, spreadPct, tolerancePct, spreadMax }) {
  const dist = pctDist(price, entry);
  if (dist > tolerancePct) return { ok: false, reason: `dist_${dist.toFixed(2)}%` };
  if (Number.isFinite(spreadPct) && spreadPct > spreadMax)
    return { ok: false, reason: `spread_${spreadPct.toFixed(3)}%` };
  return { ok: true, reason: "ok" };
}

// fake execution (paper) – you can later connect Bitget API
async function executePaperFill({ symbol, price, side }) {
  return { ok: true, fillPrice: n(price, 0), side, symbol };
}

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const side = mode === "bear" ? "SHORT" : "LONG";
  const now = Date.now();

  // IMPORTANT knobs (your issue is here: too strict)
  const TOLERANCE_PCT = n(req.query?.tol, 2.25); // was likely ~1.25
  const SPREAD_MAX = n(req.query?.spreadMax, 1.5); // allow a bit more (serverless)
  const MAX_OPEN = n(req.query?.maxOpen, 4);
  const COIN_COOLDOWN_MS = 90 * 1000; // 90s cooldown per symbol between attempts

  try {
    const state = (await kv.get(`state:${mode}`)) || null;
    if (!state?.funnel) {
      return res.json({ ok: true, mode, note: "no_state_yet", open: [], debug: [] });
    }

    const entryReady = Array.isArray(state?.funnel?.entry_ready) ? state.funnel.entry_ready : [];

    // open trades list
    const open = (await kv.get(`open:${mode}`)) || [];
    const openSet = new Set(open.map((t) => up(t.symbol)));

    // per-coin cooldown store
    const cooldownKey = `trade:cooldown:${mode}`;
    const cooldownMap = (await kv.get(cooldownKey)) || {};

    const debug = [];
    let opened = 0;

    // sort best first
    const ranked = [...entryReady].sort((a, b) => n(b.aiScore, 0) - n(a.aiScore, 0));

    for (const c of ranked) {
      if (opened >= MAX_OPEN) break;

      const sym = up(c.symbol);
      if (!sym) continue;

      if (openSet.has(sym)) {
        debug.push({ sym, skip: "already_open" });
        continue;
      }

      // cooldown
      const lastTry = n(cooldownMap?.[sym], 0);
      if (lastTry && now - lastTry < COIN_COOLDOWN_MS) {
        debug.push({ sym, skip: "cooldown" });
        continue;
      }

      const livePrice = n(c.price, 0); // serverless has no live WS; use latest scan price
      const entry = n(c?.tradePlan?.entry ?? c?.tradePlan?.Entry ?? c?.price, 0);

      // spread from ob snapshot (may be null)
      const spreadPct = n(c?.ob?.spreadPct ?? c?.orderbook?.spreadPct, NaN);

      const trig = entryTriggerOk({
        price: livePrice,
        entry,
        spreadPct,
        tolerancePct: TOLERANCE_PCT,
        spreadMax: SPREAD_MAX,
      });

      cooldownMap[sym] = now;

      if (!trig.ok) {
        debug.push({
          sym,
          decision: "NO_OPEN",
          reason: trig.reason,
          entry,
          price: livePrice,
          spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
        });
        continue;
      }

      // open paper trade
      const fill = await executePaperFill({ symbol: sym, price: livePrice, side });

      if (fill.ok) {
        open.push({
          symbol: sym,
          side,
          entry: fill.fillPrice,
          tp: n(c?.tradePlan?.tp, 0),
          sl: n(c?.tradePlan?.sl, 0),
          rr: n(c?.tradePlan?.rr, 0),
          openedAt: now,
          src: "paper",
          trigger: {
            tolPct: TOLERANCE_PCT,
            spreadMax: SPREAD_MAX,
            spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
          },
        });

        openSet.add(sym);
        opened += 1;

        debug.push({ sym, decision: "OPEN", entry, price: livePrice });
      }
    }

    // persist
    await kv.set(`open:${mode}`, open, { ex: 60 * 60 * 6 });
    await kv.set(cooldownKey, cooldownMap, { ex: 60 * 60 * 24 });

    return res.json({
      ok: true,
      mode,
      entryReady: entryReady.length,
      openedNow: opened,
      openCount: open.length,
      knobs: { tolPct: TOLERANCE_PCT, spreadMax: SPREAD_MAX, maxOpen: MAX_OPEN },
      debug: debug.slice(0, 30),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, mode, error: String(e?.message || e) });
  }
}