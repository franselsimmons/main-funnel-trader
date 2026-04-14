import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function getBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  return `${proto}://${host}`;
}

function getAuthHeader() {
  const token = process.env.CRON_SECRET || process.env.SCAN_SECRET || "";
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function safeJsonFetch(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    j = { ok: false, error: `bad_json: ${text.slice(0, 180)}` };
  }
  return { ok: r.ok, status: r.status, json: j };
}

async function acquireLock(key, ttlSec = 20) {
  const ok = await kv.set(key, { ts: Date.now() }, { nx: true, ex: ttlSec });
  return !!ok;
}

export default async function handler(req, res) {
  const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
  const autopilot = String(req.query?.autopilot || "1") !== "0";

  // stale policy
  const STALE_MS = n(req.query?.staleMs, 60_000); // 60s
  const now = Date.now();

  res.setHeader("cache-control", "no-store, max-age=0");

  try {
    const base = getBaseUrl(req);
    const auth = getAuthHeader();

    const lockKey = `lock:autopilot:${mode}`;
    const stateKey = `state:${mode}`;

    let state = (await kv.get(stateKey)) || null;
    const ts = n(state?.ts || state?.scannedAt || 0);
    const isStale = !ts || now - ts > STALE_MS;

    const info = {
      mode,
      autopilot,
      staleMs: STALE_MS,
      hadState: !!state,
      stateTs: ts || 0,
      isStale,
      didScan: false,
      didTradeTick: false,
      scanError: null,
      tradeError: null,
    };

    if (autopilot) {
      const gotLock = await acquireLock(lockKey, 20);

      if (gotLock) {
        // 1) Trigger scan if stale (or missing)
        if (isStale) {
          const scanUrl = `${base}/api/scan?mode=${encodeURIComponent(mode)}`;
          const scanResp = await safeJsonFetch(scanUrl, { headers: auth });
          if (!scanResp.ok) info.scanError = scanResp.json?.error || `scan_http_${scanResp.status}`;
          info.didScan = true;

          // reload state after scan
          state = (await kv.get(stateKey)) || state;
        }

        // 2) If ENTRY_READY exists, trigger trade tick
        const entryReady = Array.isArray(state?.funnel?.entry_ready) ? state.funnel.entry_ready : [];
        if (entryReady.length > 0) {
          const tradeUrl =
            `${base}/api/trade?mode=${encodeURIComponent(mode)}` +
            `&tol=${encodeURIComponent(req.query?.tol || "2.25")}` +
            `&spreadMax=${encodeURIComponent(req.query?.spreadMax || "1.5")}` +
            `&maxOpen=${encodeURIComponent(req.query?.maxOpen || "4")}`;

          const tradeResp = await safeJsonFetch(tradeUrl, { headers: auth });
          if (!tradeResp.ok) info.tradeError = tradeResp.json?.error || `trade_http_${tradeResp.status}`;
          info.didTradeTick = true;

          // no need to reload state; trade writes open:mode
        }
      } else {
        info.locked = true;
      }
    }

    // final load
    state = (await kv.get(stateKey)) || state || { ok: true, mode, ts: 0, funnel: {} };

    // fix “[OBJECT OBJECT]” pain: ensure regime has label
    if (state?.regime && typeof state.regime === "object") {
      if (!state.regime.label) state.regime.label = String(state.regime.regime || "NEUTRAL");
    }

    res.status(200).json({
      ok: true,
      ...state,
      autopilot: info,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}