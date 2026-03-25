// pages/api/cron.js
import mainScan from "./main/scan.js";
import { requireSecret } from "../../lib/core/settings.js";

/**
 * Run scans via one endpoint.
 *
 * - /api/cron?mode=bull&token=...
 * - /api/cron?mode=bear&token=...
 * - /api/cron?mode=both&token=...
 *
 * Notes:
 * - Uses requireSecret() so only CRON/API secret holders can trigger.
 * - Runs bull then bear sequentially for mode=both (safer for rate limits).
 */
export const config = { maxDuration: 60 };

function buildMockRes() {
  let statusCode = 200;
  let headers = {};
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader(k, v) {
      headers[String(k).toLowerCase()] = v;
    },
    json(obj) {
      body = obj;
      return this;
    },
    end(payload) {
      try {
        body = typeof payload === "string" ? JSON.parse(payload) : payload;
      } catch {
        body = payload;
      }
      return this;
    },
    getResult() {
      return { statusCode, headers, body };
    },
  };
}

async function runSingle(mode, token) {
  const req = { query: { mode, token }, headers: {} };
  const res = buildMockRes();
  await mainScan(req, res);
  return res.getResult();
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "both").toLowerCase();
    const token = req.query?.token || req.headers?.authorization?.replace("Bearer ", "");

    // Force JSON no-cache
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("content-type", "application/json; charset=utf-8");

    if (mode === "bull") {
      const bull = await runSingle("bull", token);
      return res.status(200).json({ ok: true, mode: "bull", bull });
    }

    if (mode === "bear") {
      const bear = await runSingle("bear", token);
      return res.status(200).json({ ok: true, mode: "bear", bear });
    }

    // both (default)
    const bull = await runSingle("bull", token);
    const bear = await runSingle("bear", token);

    return res.status(200).json({ ok: true, mode: "both", bull, bear });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}