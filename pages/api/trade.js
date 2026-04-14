// /pages/api/trade/engine.js
import { kv } from "@vercel/kv";
import { executeTrade } from "../../lib/tradeEngine";

/**
 * Doel:
 * - Alleen ENTRY_READY coins proberen te openen
 * - Niet elke call opnieuw dezelfde coin openen (dedupe)
 * - Debug reasons teruggeven waarom iets NIET opent (te streng / geen plan / al open)
 * - Tolerances instelbaar via env (of defaults)
 *
 * Verwacht dat scanner state coins minimaal bevat:
 * { symbol, stage, tradePlan: { entry, sl, tp }, ob: { spreadPct }, side }
 */

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

function nowMs() {
  return Date.now();
}

function keyState(mode) {
  return `state:${mode}`;
}
function keyOpen(mode) {
  return `open:${mode}`;
}
function keyExecLock(mode, sym) {
  return `exec_lock:${mode}:${up(sym)}`;
}
function keyLastAttempt(mode, sym) {
  return `exec_last:${mode}:${up(sym)}`;
}

function resolveMode(raw) {
  return String(raw || "bull").toLowerCase() === "bear" ? "bear" : "bull";
}

/**
 * ENTRY trigger gate (ruimer dan jouw oude 1.25% / 1.25 spread)
 * - spreadMax: 1.6%
 * - distMax: 2.2%
 */
function entryTriggerOk({ price, entry, spreadPct, spreadMax, distMax }) {
  const p = n(price, 0);
  const e = n(entry, 0);
  if (!(p > 0 && e > 0)) return { ok: false, reason: "missing_price_or_entry" };

  const sp = n(spreadPct, 0);
  if (sp > spreadMax) return { ok: false, reason: "spread_too_high", sp, spreadMax };

  const distPct = Math.abs((p - e) / e) * 100;
  if (distPct > distMax) return { ok: false, reason: "too_far_from_entry", distPct, distMax };

  return { ok: true, reason: "ok", distPct, sp };
}

export default async function handler(req, res) {
  const mode = resolveMode(req.query.mode);
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 12)));

  // defaults (kan je in Vercel env overriden)
  const SPREAD_MAX = n(process.env.ENTRY_SPREAD_MAX_PCT, 1.6);
  const DIST_MAX = n(process.env.ENTRY_DIST_MAX_PCT, 2.2);

  // cooldown zodat hij niet elke hit dezelfde coin probeert
  const ATTEMPT_COOLDOWN_MS = n(process.env.ENTRY_ATTEMPT_COOLDOWN_MS, 25_000);
  // lock per coin zodat concurrent requests niet dubbel openen
  const EXEC_LOCK_MS = n(process.env.ENTRY_EXEC_LOCK_MS, 20_000);

  try {
    // 1) state ophalen
    const state = (await kv.get(keyState(mode))) || {};

    // 2) open positions ophalen
    const open = (await kv.get(keyOpen(mode))) || [];
    const openSet = new Set(open.map((x) => up(x?.symbol || x)));

    // 3) candidates = ENTRY_READY
    const candidates = Object.values(state)
      .filter((c) => up(c?.stage) === "ENTRY_READY")
      .filter((c) => c && c.symbol)
      .slice(0, limit);

    const debug = [];
    const executed = [];
    const skipped = [];

    for (const c of candidates) {
      const sym = up(c.symbol);

      // al open?
      if (openSet.has(sym)) {
        skipped.push({ symbol: sym, reason: "already_open" });
        continue;
      }

      // tradeplan verplicht
      const plan = c.tradePlan || {};
      const entry = n(plan.entry, 0);
      if (!(entry > 0) || !Number.isFinite(Number(plan.sl)) || !Number.isFinite(Number(plan.tp))) {
        skipped.push({ symbol: sym, reason: "missing_trade_plan" });
        continue;
      }

      // attempt cooldown (niet spammen)
      const last = (await kv.get(keyLastAttempt(mode, sym))) || 0;
      if (n(last, 0) > 0 && nowMs() - n(last, 0) < ATTEMPT_COOLDOWN_MS) {
        skipped.push({ symbol: sym, reason: "cooldown_active" });
        continue;
      }

      // per-coin exec lock
      const lockKey = keyExecLock(mode, sym);
      const lockOk = await kv.set(lockKey, { ts: nowMs() }, { nx: true, ex: Math.ceil(EXEC_LOCK_MS / 1000) });
      if (!lockOk) {
        skipped.push({ symbol: sym, reason: "exec_lock_active" });
        continue;
      }

      // attempt markeren (cooldown)
      await kv.set(keyLastAttempt(mode, sym), nowMs(), { ex: Math.ceil((ATTEMPT_COOLDOWN_MS * 3) / 1000) });

      // LET OP: serverless heeft geen betrouwbare live WS-price.
      // executeTrade moet dus óf:
      // - zelf een live prijs ophalen (exchange REST), of
      // - een entryTriggerOk check doen op basis van laatste prijs die jij opslaat in KV.
      //
      // Hier doen we entryTriggerOk op basis van:
      // - c.price als proxy
      // - c.ob.spreadPct als proxy
      const trigger = entryTriggerOk({
        price: n(c.price, 0),
        entry,
        spreadPct: n(c?.ob?.spreadPct, 0),
        spreadMax: SPREAD_MAX,
        distMax: DIST_MAX,
      });

      debug.push({
        symbol: sym,
        stage: c.stage,
        price: n(c.price, 0),
        entry,
        spreadPct: n(c?.ob?.spreadPct, 0),
        trigger,
      });

      if (!trigger.ok) {
        skipped.push({ symbol: sym, reason: trigger.reason, meta: trigger });
        // lock laten expireren vanzelf
        continue;
      }

      // 4) Execute trade
      const result = await executeTrade(mode, c);

      if (result?.ok || result?.success) {
        executed.push({ symbol: sym, result });
        openSet.add(sym);
      } else {
        skipped.push({
          symbol: sym,
          reason: "execute_failed",
          meta: { error: result?.error || "unknown", result },
        });
      }
    }

    // 5) Open trades opnieuw ophalen (executeTrade kan ze gepusht hebben)
    const openAfter = (await kv.get(keyOpen(mode))) || [];

    res.status(200).json({
      ok: true,
      mode,
      settings: {
        SPREAD_MAX_PCT: SPREAD_MAX,
        DIST_MAX_PCT: DIST_MAX,
        ATTEMPT_COOLDOWN_MS,
        EXEC_LOCK_MS,
      },
      counts: {
        entry_ready_candidates: candidates.length,
        executed: executed.length,
        skipped: skipped.length,
        open: openAfter.length,
      },
      executed,
      skipped,
      open: openAfter,
      debug: req.query.debug === "1" ? debug : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}