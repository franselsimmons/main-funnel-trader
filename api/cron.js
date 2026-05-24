import { buildScanPayload } from "./scanner.js";
import { runTradeFunnel } from "./trade-funnel.js";

function normalizeSide(side) {
  const s = String(side || "").toLowerCase().trim();

  if (s === "bull") return "bull";
  if (s === "bear") return "bear";
  if (s === "both") return "both";

  return null;
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;

  return fallback;
}

// ================= SIDE FROM MINUTE =================
// 00 / 15 / 30 / 45 = bull
// 07 / 22 / 37 / 52 = bear
// andere minuten = both
function inferSideFromMinute() {
  const minute = new Date().getUTCMinutes();

  if ([0, 15, 30, 45].includes(minute)) return "bull";
  if ([7, 22, 37, 52].includes(minute)) return "bear";

  return "both";
}

function countActions(data) {
  if (Array.isArray(data?.tradeSystemResult?.actions)) {
    return data.tradeSystemResult.actions.length;
  }

  if (Array.isArray(data?.trades)) {
    return data.trades.length;
  }

  return 0;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const querySide = normalizeSide(req?.query?.side);
    const side = querySide || inferSideFromMinute();

    const notify = normalizeBoolean(req?.query?.notify, true);
    const store = normalizeBoolean(req?.query?.store, true);

    const utcMinute = new Date().getUTCMinutes();

    console.log("CRON START:", {
      side,
      querySide,
      notify,
      store,
      utcMinute,
      at: new Date().toISOString(),
    });

    // 1. Scanner draait en schrijft latest scan.
    const scanData = await buildScanPayload({
      side,
      notify,
      store,
    });

    // 2. Direct daarna trade-funnel + analyzer append.
    // latestOverride voorkomt dat trade-funnel een oude/stale latest scan leest.
    const tradeData = await runTradeFunnel({
      latest: scanData,
      notify,
      store,
    });

    const result = {
      ok: true,
      source: "cron",
      side,
      notify,
      store,
      ranAt: Date.now(),
      durationMs: Date.now() - startedAt,

      scanner: {
        ok: Boolean(scanData?.ok),
        scanSide: scanData?.scanSide || side,
        scanMode: scanData?.scanMode || side,
        btc: scanData?.btc || null,
        regime: scanData?.regime || null,
        candidates: Number(scanData?.candidates || 0),
        candidatesBull: Number(scanData?.candidatesBull || 0),
        candidatesBear: Number(scanData?.candidatesBear || 0),
        bullCount: Number(scanData?.bullCount || 0),
        bearCount: Number(scanData?.bearCount || 0),
        funnelCount: Number(scanData?.funnelCount || 0),
        updatedAt: scanData?.updatedAt || null,
        scannerUpdatedAt: scanData?.scannerUpdatedAt || null,
      },

      tradeFunnel: {
        ok: Boolean(tradeData?.ok),
        rawCount: Number(tradeData?.tradeFunnelRawCount || 0),
        inputCount: Number(tradeData?.tradeFunnelInputCount || 0),
        rejected: tradeData?.tradeFunnelRejectCounts || {},
        inputSymbols: Array.isArray(tradeData?.tradeFunnelInputSymbols)
          ? tradeData.tradeFunnelInputSymbols.slice(0, 80)
          : [],
        actions: countActions(tradeData),
        updatedAt: tradeData?.updatedAt || null,
        tradeFunnelUpdatedAt: tradeData?.tradeFunnelUpdatedAt || null,
      },

      analyzer: tradeData?.analyzeAppendResult || null,

      lastBullScan: tradeData?.lastBullScan || scanData?.lastBullScan || null,
      lastBearScan: tradeData?.lastBearScan || scanData?.lastBearScan || null,
      updatedAt: tradeData?.updatedAt || scanData?.updatedAt || null,
    };

    console.log("CRON DONE:", result);

    return res.status(200).json(result);
  } catch (err) {
    console.error("CRON ERROR:", err);

    return res.status(500).json({
      ok: false,
      source: "cron",
      error: err?.message || "cron_failed",
      ranAt: Date.now(),
      durationMs: Date.now() - startedAt,
    });
  }
}