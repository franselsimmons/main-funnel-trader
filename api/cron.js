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
// Origineel gedrag blijft bestaan.
// 00 / 15 / 30 / 45 = bull
// 07 / 22 / 37 / 52 = bear
// Overige minuten = both
function inferSideFromMinute() {
  const minute = new Date().getUTCMinutes();

  if ([0, 15, 30, 45].includes(minute)) {
    return "bull";
  }

  if ([7, 22, 37, 52].includes(minute)) {
    return "bear";
  }

  return "both";
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function compactTradeFunnelResult(data) {
  const actions = Array.isArray(data?.tradeSystemResult?.actions)
    ? data.tradeSystemResult.actions
    : safeArray(data?.trades);

  return {
    ok: Boolean(data?.ok),
    updatedAt: data?.updatedAt || null,
    tradeFunnelUpdatedAt: data?.tradeFunnelUpdatedAt || null,

    tradeFunnelRawCount: safeNumber(data?.tradeFunnelRawCount, 0),
    tradeFunnelInputCount: safeNumber(data?.tradeFunnelInputCount, 0),
    tradeFunnelRejectCounts: data?.tradeFunnelRejectCounts || {},
    tradeFunnelInputSymbols: safeArray(data?.tradeFunnelInputSymbols).slice(0, 150),

    candidatesCount: safeNumber(data?.tradeSystemResult?.candidatesCount, 0),
    actions: actions.length,

    analyzeAppendResult: data?.analyzeAppendResult || null,
  };
}

function compactScannerResult(data, side) {
  return {
    ok: Boolean(data?.ok),
    side,
    scanSide: data?.scanSide || side,
    scanMode: data?.scanMode || side,

    btc: data?.btc || null,
    regime: data?.regime || null,
    market: data?.market || null,

    candidates: safeNumber(data?.candidates, 0),
    candidatesBull: safeNumber(data?.candidatesBull, 0),
    candidatesBear: safeNumber(data?.candidatesBear, 0),

    funnelCount: safeNumber(data?.funnelCount, 0),
    bullCount: safeNumber(data?.bullCount, 0),
    bearCount: safeNumber(data?.bearCount, 0),

    trades: Array.isArray(data?.trades) ? data.trades.length : 0,

    lastBullScan: data?.lastBullScan || null,
    lastBearScan: data?.lastBearScan || null,

    scannerUpdatedAt: data?.scannerUpdatedAt || null,
    tradeFunnelUpdatedAt: data?.tradeFunnelUpdatedAt || null,
    updatedAt: data?.updatedAt || null,
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

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

  let scannerData = null;
  let tradeFunnelData = null;

  try {
    // ================= STEP 1: SCANNER =================
    // Schrijft latest scan via setLatestScan().
    scannerData = await buildScanPayload({
      side,
      notify,
      store,
    });

    const scannerSummary = compactScannerResult(scannerData, side);

    console.log("CRON SCANNER DONE:", scannerSummary);

    // ================= STEP 2: TRADE FUNNEL + ANALYZER =================
    // Leest latest scan, draait processTrades(), appendt analyzer-events,
    // en schrijft daarna latest scan opnieuw met tradeFunnelUpdatedAt.
    tradeFunnelData = await runTradeFunnel({
      notify,
      store,
    });

    const tradeFunnelSummary = compactTradeFunnelResult(tradeFunnelData);

    console.log("CRON TRADE FUNNEL DONE:", tradeFunnelSummary);

    const result = {
      ok: true,
      source: "cron",
      side,
      querySide,
      notify,
      store,

      ranAt: Date.now(),
      durationMs: Date.now() - startedAt,

      scanner: scannerSummary,
      tradeFunnel: tradeFunnelSummary,

      latest: {
        updatedAt: tradeFunnelData?.updatedAt || scannerData?.updatedAt || null,
        scannerUpdatedAt: scannerData?.scannerUpdatedAt || null,
        tradeFunnelUpdatedAt: tradeFunnelData?.tradeFunnelUpdatedAt || null,
      },
    };

    console.log("CRON DONE:", result);

    return res.status(200).json(result);
  } catch (err) {
    const message = err?.message || "cron_failed";

    console.error("CRON ERROR:", {
      error: message,
      stack: err?.stack || null,
      scannerOk: Boolean(scannerData?.ok),
      tradeFunnelOk: Boolean(tradeFunnelData?.ok),
      durationMs: Date.now() - startedAt,
    });

    return res.status(500).json({
      ok: false,
      source: "cron",
      side,
      querySide,
      notify,
      store,

      error: message,
      ranAt: Date.now(),
      durationMs: Date.now() - startedAt,

      scanner: scannerData
        ? compactScannerResult(scannerData, side)
        : null,

      tradeFunnel: tradeFunnelData
        ? compactTradeFunnelResult(tradeFunnelData)
        : null,
    });
  }
}