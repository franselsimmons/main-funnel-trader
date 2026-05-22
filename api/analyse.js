import { listAnalyzeTrades } from "../lib/analyze/analyzeStore.js";
import { buildFamilyReport } from "../lib/analyze/familyEngine.js";

function setJsonHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function toInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

export default async function handler(req, res) {
  setJsonHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "method_not_allowed",
      allowed: ["GET"],
    });
  }

  const started = Date.now();

  try {
    const minClosed = toInt(req.query?.minClosed, 10);
    const includeRemote = String(req.query?.remote || "true") !== "false";

    const loaded = await listAnalyzeTrades({
      includeRemote,
    });

    const report = buildFamilyReport(loaded.trades, {
      minClosed,
    });

    const payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      sources: loaded.sources || [],
      diagnostics: loaded.diagnostics || [],
      tradesLoaded: loaded.tradesLoaded || 0,
      summary: report.summary,
      report,
    };

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      error: err?.message || "analyse_failed",
      stack: process.env.NODE_ENV === "production" ? undefined : err?.stack,
      report: {
        ok: false,
        summary: {
          actions: 0,
          trades: 0,
          observed: 0,
          open: 0,
          closed: 0,
          wins: 0,
          losses: 0,
          winrate: "0.0%",
          winrateNum: 0,
          totalR: 0,
          avgR: 0,
          totalPnlPct: 0,
          avgPnlPct: 0,
          longFamilies: 0,
          shortFamilies: 0,
          hotFamilies: 0,
          stableFamilies: 0,
          badFamilies: 0,
          collectingFamilies: 0,
          emptyFamilies: 0,
        },
        families: {
          all: [],
          long: [],
          short: [],
        },
        filterValues: {},
      },
    });
  }
}