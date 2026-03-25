// pages/api/exec/place.js
import { kv } from "@vercel/kv";
import { requireSecret } from "../../../lib/core/settings.js";
import { n, isNonEmptyString, up } from "../../../lib/utils/numbers.js";
import { nowTs } from "../../../lib/utils/time.js";
import { placeTradeViaEngine } from "../../../lib/execution/executionEngine.js";
import { sendDiscordSignal } from "../../../lib/signals/discord.js";
import { pushEvent, uid } from "../../../lib/analytics.js";

/**
 * PLACE (manual / external) execution endpoint.
 *
 * POST /api/exec/place?token=...
 * Body JSON:
 *  {
 *    "mode": "bull" | "bear",
 *    "symbol": "ETH",              // base symbol (without USDT)
 *    "side": "BUY" | "SELL",       // for spot; engine maps bear-mode appropriately if you use "mode"
 *    "type": "MARKET" | "LIMIT",
 *    "price": 123.45,              // required for LIMIT
 *    "sizeUsd": 50,                // one of sizeUsd or sizeQty
 *    "sizeQty": 0.01,
 *    "clientOrderId": "optional-idempotency-key",
 *    "dryRun": false,
 *    "reason": "optional note"
 *  }
 *
 * Notes:
 * - Designed for Bitget SPOT USDT pairs.
 * - Idempotent: if clientOrderId already executed, returns prior result.
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
  // Next.js API parses JSON automatically when content-type is application/json
  return req.body && typeof req.body === "object" ? req.body : {};
}

function normalizeOrderInput(body) {
  const mode = String(body.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const symbol = up(body.symbol || "");
  const side = up(body.side || "BUY");
  const type = up(body.type || "MARKET");
  const price = n(body.price, 0);
  const sizeUsd = n(body.sizeUsd, 0);
  const sizeQty = n(body.sizeQty, 0);
  const dryRun = !!body.dryRun;
  const reason = String(body.reason || "");
  const clientOrderId = String(body.clientOrderId || "").trim() || uid("manual");

  return { mode, symbol, side, type, price, sizeUsd, sizeQty, dryRun, reason, clientOrderId };
}

function validateInput(x) {
  if (!isNonEmptyString(x.symbol)) return "missing_symbol";
  if (x.symbol.length < 2) return "invalid_symbol";
  if (x.side !== "BUY" && x.side !== "SELL") return "invalid_side";
  if (x.type !== "MARKET" && x.type !== "LIMIT") return "invalid_type";
  if (x.type === "LIMIT" && !(x.price > 0)) return "limit_requires_price";
  const hasUsd = x.sizeUsd > 0;
  const hasQty = x.sizeQty > 0;
  if (!hasUsd && !hasQty) return "missing_size";
  if (hasUsd && hasQty) return "provide_only_one_of_sizeUsd_or_sizeQty";
  return null;
}

function idempotencyKey(mode, clientOrderId) {
  return `exec:place:idempotency:${mode}:${clientOrderId}`;
}

function execLogKey(mode) {
  return `exec:logs:${mode}`;
}

async function appendExecLog(mode, entry, keep = 200) {
  const key = execLogKey(mode);
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  const next = [entry, ...arr].slice(0, keep);
  await kv.set(key, next, { ex: 60 * 60 * 24 * 14 }); // keep 2 weeks
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;
    if (req.method !== "POST") return methodNotAllowed(res);

    res.setHeader("Cache-Control", "no-store");

    const body = parseBody(req);
    const input = normalizeOrderInput(body);

    const vErr = validateInput(input);
    if (vErr) return bad(res, vErr, { input });

    // Idempotency (prevents accidental double orders)
    const idemKey = idempotencyKey(input.mode, input.clientOrderId);
    const existing = await kv.get(idemKey);
    if (existing && typeof existing === "object") {
      return json(res, 200, { ok: true, idempotent: true, ...existing });
    }

    // Execute
    const startedAt = nowTs();
    const result = await placeTradeViaEngine({
      mode: input.mode,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      price: input.price > 0 ? input.price : undefined,
      sizeUsd: input.sizeUsd > 0 ? input.sizeUsd : undefined,
      sizeQty: input.sizeQty > 0 ? input.sizeQty : undefined,
      clientOrderId: input.clientOrderId,
      dryRun: input.dryRun,
      reason: input.reason || "manual_place",
      source: "api_exec_place",
    });

    const payload = {
      ok: true,
      idempotent: false,
      startedAt,
      finishedAt: nowTs(),
      input,
      result,
    };

    // Persist idempotency result (even if dryRun)
    await kv.set(idemKey, payload, { ex: 60 * 60 * 24 * 2 }); // 2 days

    // Log + analytics + discord
    const logEntry = {
      ts: payload.finishedAt,
      kind: "PLACE",
      mode: input.mode,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      sizeUsd: input.sizeUsd || null,
      sizeQty: input.sizeQty || null,
      price: input.type === "LIMIT" ? input.price : null,
      dryRun: input.dryRun,
      clientOrderId: input.clientOrderId,
      ok: !!result?.ok,
      exchange: result?.exchange || "bitget",
      orderId: result?.orderId || null,
      status: result?.status || null,
      error: result?.error || null,
      reason: input.reason || null,
    };

    await appendExecLog(input.mode, logEntry);

    await pushEvent("exec_place", {
      ...logEntry,
      filledQty: result?.filledQty ?? null,
      avgFillPrice: result?.avgFillPrice ?? null,
    });

    // Discord (non-blocking-ish — but we await so failures are caught in try/catch)
    await sendDiscordSignal({
      source: "main",
      stage: "EXEC_PLACE",
      mode: input.mode,
      kind: input.dryRun ? "dry_run" : "order_placed",
      btcState: null,
      reason: `${input.dryRun ? "DRY" : "LIVE"} ${input.side} ${input.symbol} ${input.type} ${input.sizeUsd ? `$${input.sizeUsd}` : input.sizeQty} ${
        input.type === "LIMIT" ? `@ ${input.price}` : ""
      }`,
      meta: {
        clientOrderId: input.clientOrderId,
        orderId: result?.orderId || null,
        status: result?.status || null,
        filledQty: result?.filledQty ?? null,
        avgFillPrice: result?.avgFillPrice ?? null,
      },
    });

    return json(res, 200, payload);
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}