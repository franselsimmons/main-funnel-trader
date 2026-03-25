// pages/api/exec/status.js
import { kv } from "@vercel/kv";
import { requireSecret } from "../../../lib/core/settings.js";
import { up, isNonEmptyString, n } from "../../../lib/utils/numbers.js";
import { nowTs } from "../../../lib/utils/time.js";
import { getOrderStatusViaEngine } from "../../../lib/execution/executionEngine.js";

/**
 * STATUS endpoint (Bitget spot) for:
 * - a single order (by orderId), OR
 * - recent exec logs snapshot from KV.
 *
 * GET /api/exec/status?token=...&mode=bull&symbol=ETH&orderId=123
 * GET /api/exec/status?token=...&mode=bull&clientOrderId=abc   (optional if your engine supports it)
 * GET /api/exec/status?token=...&mode=bull&logs=1&limit=50
 *
 * Notes:
 * - "symbol" is base symbol WITHOUT "USDT"
 * - Requires API_SECRET / CRON_SECRET
 */
export const config = { maxDuration: 60 };

function json(res, code, obj) {
  res.status(code).json(obj);
}
function bad(res, msg, extra = {}) {
  return json(res, 400, { ok: false, error: msg, ...extra });
}

function execLogKey(mode) {
  return `exec:logs:${mode}`;
}

async function readExecLogs(mode, limit = 100) {
  const key = execLogKey(mode);
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  return arr.slice(0, Math.max(1, Math.min(500, limit)));
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

    res.setHeader("Cache-Control", "no-store");

    const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
    const wantLogs = String(req.query?.logs || "") === "1" || String(req.query?.logs || "") === "true";
    const limit = n(req.query?.limit, 100);

    // Logs view
    if (wantLogs) {
      const logs = await readExecLogs(mode, limit);
      return json(res, 200, {
        ok: true,
        mode,
        ts: nowTs(),
        logs,
        count: logs.length,
      });
    }

    // Single order status view
    const symbol = up(req.query?.symbol || "");
    const orderId = String(req.query?.orderId || "").trim();
    const clientOrderId = String(req.query?.clientOrderId || "").trim();
    const exchange = String(req.query?.exchange || "bitget").toLowerCase();

    // allow querying by either orderId or clientOrderId (engine may ignore clientOrderId if unsupported)
    if (!isNonEmptyString(symbol)) return bad(res, "missing_symbol");
    if (!isNonEmptyString(orderId) && !isNonEmptyString(clientOrderId)) return bad(res, "missing_orderId_or_clientOrderId");

    const startedAt = nowTs();
    const result = await getOrderStatusViaEngine({
      mode,
      symbol,
      orderId: isNonEmptyString(orderId) ? orderId : null,
      clientOrderId: isNonEmptyString(clientOrderId) ? clientOrderId : null,
      exchange,
      source: "api_exec_status",
    });

    return json(res, 200, {
      ok: true,
      mode,
      ts: nowTs(),
      startedAt,
      input: { mode, symbol, orderId: orderId || null, clientOrderId: clientOrderId || null, exchange },
      result,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}