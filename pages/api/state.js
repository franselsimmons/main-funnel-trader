import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function getAuthHeader(req) {
  const token = process.env.CRON_SECRET || process.env.SCAN_SECRET || "";
  const header = req.headers.authorization || "";
  if (!token) return true; // no auth configured
  return header === `Bearer ${token}`;
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store, max-age=0");

  try {
    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear"
        ? "bear"
        : "bull";

    const force = String(req.query?.force || "") === "1";

    const stateKey = `state:${mode}`;
    const autoKey = `scan:auto:${mode}`;
    const accountKey = "account:global";

    /* ================= LOAD STATE ================= */

    let state = (await kv.get(stateKey)) || null;
    const auto = (await kv.get(autoKey)) || null;
    const account = (await kv.get(accountKey)) || null;

    /* ================= FORCE SCAN (ADMIN ONLY) ================= */

    if (force) {
      const authorized = getAuthHeader(req);
      if (!authorized) {
        return res.status(401).json({
          ok: false,
          error: "unauthorized_force_scan",
        });
      }

      // Call scan internally (rare manual override)
      const baseUrl =
        (req.headers["x-forwarded-proto"] || "https") +
        "://" +
        (req.headers["x-forwarded-host"] || req.headers.host);

      const scanResp = await fetch(
        `${baseUrl}/api/scan?mode=${mode}`,
        {
          headers: {
            authorization: req.headers.authorization || "",
          },
          cache: "no-store",
        }
      );

      const j = await scanResp.json();
      state = j;
    }

    /* ================= FALLBACK STATE ================= */

    if (!state) {
      state = {
        ok: true,
        mode,
        ts: 0,
        regime: { label: "UNKNOWN" },
        funnel: {
          radar: [],
          warmup: [],
          setup: [],
          entry_ready: [],
        },
      };
    }

    /* ================= NORMALIZE REGIME ================= */

    if (state?.regime && typeof state.regime === "object") {
      if (!state.regime.label) {
        state.regime.label = String(
          state.regime.regime || "NEUTRAL"
        );
      }
    }

    /* ================= RESPONSE ================= */

    return res.status(200).json({
      ok: true,
      mode,
      lastScan: auto?.lastRun || state?.ts || 0,
      nextScan: auto?.nextDue || 0,
      scanIntervalMinutes: 15,
      account: account || {
        equity: 0,
        peak: 0,
        trades: 0,
        wins: 0,
        losses: 0,
      },
      state,
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
}