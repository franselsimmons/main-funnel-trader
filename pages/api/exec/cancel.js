// pages/api/exec/cancel.js
import { kv } from "@vercel/kv";
import { requireSecret } from "../../../lib/core/settings.js";
import { n, up, isNonEmptyString } from "../../../lib/utils/numbers.js";
import { nowTs } from "../../../lib/utils/time.js";
import { cancelOrderViaEngine } from "../../../lib/execution/executionEngine.js";
import { sendDiscordSignal } from "../../../lib/signals/discord.js";
import { pushEvent, uid } from "../../../lib/analytics.js";

/**
 * CANCEL order endpoint (Bitget spot).
 *
 * POST /api/exec/cancel?token=...
 * Body JSON:
 *  {
 *    "mode": "bull" | "bear",
 *    "symbol": "ETH",                 // base symbol, WITHOUT "USDT"
 *    "orderId": "1234567890",         // Bitget orderId (preferred)
 *    "clientOrderId": "my-idem-key",  // optional, used for idempotency/logging
 *    "dryRun": false,
 *    "reason": "optional note"
 *  }
 *
 * Behavior:
 * - Cancels the open order on Bitget for symbolUSDT + orderId.
 * - Stores idempotency response when clientOrderId is provided.
 */
export const config = { maxDuration: 60 };

function json(res, code, obj) {
  res.status(code).json(obj);
}
function bad(res, msg, extra = {}) {
  return json(res, 400, { ok: false, error: msg, ...extra });
}
function methodNotAllowed(res) {
  return json(res, 405, { ok: false, error: "method_not_allowed" });
}
function parseBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function normalize(body) {
  const mode = String(body.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const symbol = up(body.symbol || "");
  const orderId = String(body.orderId || "").trim();
  const dryRun = !!body.dryRun;
  const reason = String(body.reason || "");
  const clientOrderId = String(body.clientOrderId || "").trim() || uid("cancel");
  return { mode, symbol, orderId, clientOrderId, dryRun, reason };
}

function validate(x) {
  if (!isNonEmptyString(x.symbol)) return "missing_symbol";
  if (!isNonEmptyString(x.orderId)) return "missing_orderId";
  return null;
}

function idempotencyKey(mode, clientOrderId) {
  return `exec:cancel:idempotency:${mode}:${clientOrderId}`;
}

function execLogKey(mode) {
  return `exec:logs:${mode}`;
}

async function appendExecLog(mode, entry, keep = 200) {
  const key = execLogKey(mode);
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  const next = [entry, ...arr].slice(0, keep);
  await kv.set(key, next, { ex: 60 * 60 * 24 * 14 }); // 2 weeks
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;
    if (req.method !== "POST") return methodNotAllowed(res);

    res.setHeader("Cache-Control", "no-store");

    const body = parseBody(req);
    const input = normalize(body);

    const vErr = validate(input);
    if (vErr) return bad(res, vErr, { input });

    // Idempotency (if provided)
    const idemKey = idempotencyKey(input.mode, input.clientOrderId);
    const existing = await kv.get(idemKey);
    if (existing && typeof existing === "object") {
      return json(res, 200, { ok: true, idempotent: true, ...existing });
    }

    const startedAt = nowTs();
    const result = await cancelOrderViaEngine({
      mode: input.mode,
      symbol: input.symbol,
      orderId: input.orderId,
      clientOrderId: input.clientOrderId,
      dryRun: input.dryRun,
      reason: input.reason || "manual_cancel",
      source: "api_exec_cancel",
    });

    const payload = {
      ok: true,
      idempotent: false,
      startedAt,
      finishedAt: nowTs(),
      input,
      result,
    };

    await kv.set(idemKey, payload, { ex: 60 * 60 * 24 * 2 }); // 2 days

    const logEntry = {
      ts: payload.finishedAt,
      kind: "CANCEL",
      mode: input.mode,
      symbol: input.symbol,
      orderId: input.orderId,
      dryRun: input.dryRun,
      clientOrderId: input.clientOrderId,
      ok: !!result?.ok,
      exchange: result?.exchange || "bitget",
      status: result?.status || null,
      error: result?.error || null,
      reason: input.reason || null,
    };

    await appendExecLog(input.mode, logEntry);

    await pushEvent("exec_cancel", logEntry);

    await sendDiscordSignal({
      source: "main",
      stage: "EXEC_CANCEL",
      mode: input.mode,
      kind: input.dryRun ? "dry_run" : "order_cancel",
      btcState: null,
      reason: `${input.dryRun ? "DRY" : "LIVE"} CANCEL ${input.symbol} • order ${input.orderId} • ${result?.ok ? "ok" : "failed"}`,
      meta: {
        clientOrderId: input.clientOrderId,
        orderId: input.orderId,
        status: result?.status || null,
        error: result?.error || null,
      },
    });

    return json(res, 200, payload);
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}