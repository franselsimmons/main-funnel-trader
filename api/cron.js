import { buildScanPayload } from "./scanner.js";
import { runTradeFunnel } from "./trade-funnel.js";

const LOCK_BUSY_ERROR = "TRADE_SYSTEM_DURABLE_LOCK_BUSY";

function normalizeSide(side) {
  const s = String(side || "").toLowerCase().trim();

  if (s === "bull") return "bull";
  if (s === "bear") return "bear";
  if (s === "both") return "both";

  return null;
}

// ================= SIDE FROM UTC 2-MIN SLOT =================
// Bij cron */2:
// 00 = bull
// 02 = bear
// 04 = bull
// 06 = bear
// enz.
function inferSideFromMinute() {
  const minute = new Date().getUTCMinutes();
  const slot = Math.floor(minute / 2);

  return slot % 2 === 0 ? "bull" : "bear";
}

function normalizeTradeSide(side) {
  const s = String(side || "").toLowerCase().trim();

  if (["bull", "long", "buy"].includes(s)) return "bull";
  if (["bear", "short", "sell"].includes(s)) return "bear";

  return "";
}

function countTradesBySide(trades, side) {
  if (!Array.isArray(trades)) return 0;

  return trades.filter(t => normalizeTradeSide(t?.side) === side).length;
}

function getTrades(data) {
  if (Array.isArray(data?.trades)) return data.trades;
  if (Array.isArray(data?.tradeSystemResult?.actions)) return data.tradeSystemResult.actions;
  return [];
}

function compactAnalyzeResult(result) {
  if (!result || typeof result !== "object") return null;

  return {
    ok: Boolean(result.ok),
    skipped: Boolean(result.skipped),
    reason: result.reason || null,

    received: Number(result.received || 0),
    accepted: Number(result.accepted || 0),
    acceptedEntries: Number(result.acceptedEntries || 0),
    acceptedExits: Number(result.acceptedExits || 0),
    rejected: Number(result.rejected || 0),

    appended: Number(result.appended || result.written || result.saved || 0),
    duplicates: Number(result.duplicates || result.duplicate || result.skippedDuplicates || 0),

    rejectCounts: result.rejectCounts || {},
  };
}

function compactScanner(scanData, side) {
  return {
    ok: Boolean(scanData?.ok),
    scanSide: scanData?.scanSide || side,
    scanMode: scanData?.scanMode || side,

    btc: scanData?.btc || null,
    regime: scanData?.regime || null,
    market: scanData?.market || null,

    funnelCount: Number(scanData?.funnelCount || 0),
    bullCount: Number(scanData?.bullCount || 0),
    bearCount: Number(scanData?.bearCount || 0),

    candidates: Number(scanData?.candidates || 0),
    candidatesBull: Number(scanData?.candidatesBull || 0),
    candidatesBear: Number(scanData?.candidatesBear || 0),

    scannerUpdatedAt: scanData?.scannerUpdatedAt || null,
    tradeFunnelUpdatedAt: scanData?.tradeFunnelUpdatedAt || null,
    updatedAt: scanData?.updatedAt || null,

    lastBullScan: scanData?.lastBullScan || null,
    lastBearScan: scanData?.lastBearScan || null,
  };
}

function compactTradeFunnel(funnelData) {
  const trades = getTrades(funnelData);

  return {
    ok: Boolean(funnelData?.ok),

    rawCount: Number(funnelData?.tradeFunnelRawCount || 0),
    inputCount: Number(funnelData?.tradeFunnelInputCount || 0),
    rejectCounts: funnelData?.tradeFunnelRejectCounts || {},

    inputSymbols: Array.isArray(funnelData?.tradeFunnelInputSymbols)
      ? funnelData.tradeFunnelInputSymbols.slice(0, 150)
      : [],

    trades: trades.length,
    bullTrades: countTradesBySide(trades, "bull"),
    bearTrades: countTradesBySide(trades, "bear"),

    analyzeAppendResult: compactAnalyzeResult(funnelData?.analyzeAppendResult),

    tradeFunnelUpdatedAt: funnelData?.tradeFunnelUpdatedAt || null,
    updatedAt: funnelData?.updatedAt || null,
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  let scanData = null;

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const querySide = normalizeSide(req?.query?.side);
    const side = querySide || inferSideFromMinute();

    const utcMinute = new Date().getUTCMinutes();

    console.log("CRON START:", {
      side,
      querySide,
      utcMinute,
      at: new Date().toISOString(),
    });

    // 1. Scanner draait eerst en schrijft latest scan.
    scanData = await buildScanPayload({
      side,
      notify: true,
      store: true,
    });

    // 2. Trade-funnel draait direct daarna op dezelfde latest payload.
    // Hierdoor groeit analyzer automatisch.
    const funnelData = await runTradeFunnel({
      notify: true,
      store: true,
      latest: scanData,
    });

    const result = {
      ok: true,
      source: "scanner_plus_trade_funnel_cron",
      side,
      querySide,
      utcMinute,

      ranAt: Date.now(),
      durationMs: Date.now() - startedAt,

      scanner: compactScanner(scanData, side),
      tradeFunnel: compactTradeFunnel(funnelData),
    };

    console.log("CRON DONE:", result);

    return res.status(200).json(result);
  } catch (err) {
    const message = err?.message || "cron_failed";

    if (message === LOCK_BUSY_ERROR) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        busy: true,
        source: "scanner_plus_trade_funnel_cron",
        reason: LOCK_BUSY_ERROR,
        note: "Scanner ran, but trade-funnel was still busy. This trade-funnel tick was skipped.",
        scanner: scanData ? compactScanner(scanData, scanData?.scanSide || "unknown") : null,
        ranAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
    }

    console.error("CRON ERROR:", err);

    return res.status(500).json({
      ok: false,
      source: "scanner_plus_trade_funnel_cron",
      error: message,
      ranAt: Date.now(),
      durationMs: Date.now() - startedAt,
    });
  }
}