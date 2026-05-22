// api/analyse.js

import fs from "node:fs/promises";
import path from "node:path";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(JSON.stringify(payload, null, 2));
}

function serializeError(error) {
  if (!error) return { message: "Unknown error" };

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
    };
  }

  if (typeof error === "string") {
    return { message: error };
  }

  try {
    return {
      message: JSON.stringify(error),
      raw: error,
    };
  } catch {
    return {
      message: String(error),
    };
  }
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw);
}

function extractTrades(payload) {
  if (Array.isArray(payload)) return payload;

  if (!payload || typeof payload !== "object") return [];

  const candidates = [
    payload.trades,
    payload.items,
    payload.data,
    payload.history,
    payload.closedTrades,
    payload.openTrades,
    payload.positions,
    payload.records,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

async function loadTrades() {
  const root = process.cwd();

  const files = [
    path.join(root, "data", "trades.json"),
    path.join(root, "data", "trade-history.json"),
    path.join(root, "data", "trades-history.json"),
  ];

  const trades = [];
  const sources = [];

  for (const file of files) {
    try {
      const payload = await readJsonFile(file);
      const extracted = extractTrades(payload);

      if (extracted.length > 0) {
        trades.push(...extracted);
        sources.push({
          file: path.relative(root, file),
          count: extracted.length,
        });
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;

      throw new Error(
        `Kan data-file niet lezen: ${path.relative(root, file)} -> ${error.message}`
      );
    }
  }

  return {
    trades,
    sources,
  };
}

async function loadEngine() {
  const engine = await import("../lib/analyze/familyEngine.js");

  const buildAnalyzeReport =
    engine.buildAnalyzeReport ||
    engine.buildReport ||
    engine.default?.buildAnalyzeReport ||
    engine.default?.buildReport;

  if (typeof buildAnalyzeReport !== "function") {
    throw new Error(
      "familyEngine.js export mist: buildAnalyzeReport of buildReport niet gevonden."
    );
  }

  return {
    buildAnalyzeReport,
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    const minClosed = Math.max(
      1,
      safeNumber(url.searchParams.get("minClosed"), 10)
    );

    const { buildAnalyzeReport } = await loadEngine();
    const { trades, sources } = await loadTrades();

    const report = buildAnalyzeReport(trades, {
      minClosed,
    });

    return sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      sources,
      tradesLoaded: trades.length,
      report,
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: serializeError(error),
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
          totalR: 0,
          avgR: 0,
          totalPnlPct: 0,
          avgPnlPct: 0,
          longFamilies: 0,
          shortFamilies: 0,
        },
        families: {
          all: [],
          long: [],
          short: [],
        },
        filterKeys: [],
        trades: {
          total: 0,
          items: [],
        },
      },
    });
  }
}