import { getLatestScan } from "../lib/scanStore.js";
import {
  clearAnalyzeEvents,
  getAnalyzeStoreInfo,
  readAnalyzeEvents,
} from "../lib/analyze/analyzeStore.js";
import { buildAnalyzeReport } from "../lib/analyze/familyEngine.js";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;

  return fallback;
}

function normalizeLatestEvent(event, source, fallbackTs) {
  const e = safeObject(event);

  return {
    ...e,
    source: e.source || source,
    analyzeTs: safeNumber(e.analyzeTs ?? e.ts ?? e.updatedAt ?? fallbackTs, Date.now()),
  };
}

function extractLatestEvents(latest) {
  const root = safeObject(latest);
  const ts = safeNumber(root.tradeFunnelUpdatedAt ?? root.updatedAt, Date.now());

  return [
    ...safeArray(root.trades).map((x) => normalizeLatestEvent(x, "latest.trades", ts)),
    ...safeArray(root.actions).map((x) => normalizeLatestEvent(x, "latest.actions", ts)),
    ...safeArray(root.tradeSystemResult?.actions).map((x) =>
      normalizeLatestEvent(x, "latest.tradeSystemResult.actions", ts)
    ),
    ...safeArray(root.openPositions).map((x) => normalizeLatestEvent(x, "latest.openPositions", ts)),
    ...safeArray(root.closedTrades).map((x) => normalizeLatestEvent(x, "latest.closedTrades", ts)),
    ...safeArray(root.tradeHistory).map((x) => normalizeLatestEvent(x, "latest.tradeHistory", ts)),
    ...safeArray(root.history).map((x) => normalizeLatestEvent(x, "latest.history", ts)),
  ];
}

function eventSignature(event) {
  const e = safeObject(event);

  return [
    e.id,
    e.tradeId,
    e.positionId,
    e.orderId,
    e.symbol,
    e.side,
    e.action,
    e.status,
    e.outcome,
    e.result,
    e.entry,
    e.entryPrice,
    e.exitPrice,
    e.ts,
    e.analyzeTs,
  ]
    .filter((v) => v !== undefined && v !== null && v !== "")
    .join("|");
}

function mergeEvents(primary, secondary) {
  const out = [];
  const seen = new Set();

  for (const event of [...safeArray(primary), ...safeArray(secondary)]) {
    const sig = eventSignature(event);

    if (sig && seen.has(sig)) continue;
    if (sig) seen.add(sig);

    out.push(event);
  }

  return out;
}

export default async function handler(req, res) {
  const started = Date.now();

  const reset = normalizeBoolean(req?.query?.reset, false);
  const includeLatest = normalizeBoolean(req?.query?.includeLatest, true);
  const minClosed = safeNumber(req?.query?.minClosed, 10);
  const limit = safeNumber(req?.query?.limit, 50_000);

  try {
    if (reset) {
      const cleared = await clearAnalyzeEvents();

      return res.status(200).json({
        ok: true,
        reset: true,
        cleared,
        generatedAt: new Date().toISOString(),
      });
    }

    const storedEvents = await readAnalyzeEvents({ limit });

    let latestEvents = [];
    let latestMeta = null;

    if (includeLatest) {
      try {
        const latest = await getLatestScan();
        latestMeta = {
          ok: Boolean(latest?.ok),
          updatedAt: latest?.updatedAt || null,
          tradeFunnelUpdatedAt: latest?.tradeFunnelUpdatedAt || null,
        };

        latestEvents = extractLatestEvents(latest);
      } catch {
        latestMeta = {
          ok: false,
          note: "latest_scan_unavailable",
        };
      }
    }

    const events = mergeEvents(storedEvents, latestEvents);
    const report = buildAnalyzeReport(events, { minClosed });
    const store = await getAnalyzeStoreInfo();

    return res.status(200).json({
      ok: true,
      generatedAt: report.generatedAt,
      latencyMs: Date.now() - started,
      sources: {
        storedEvents: storedEvents.length,
        latestEvents: latestEvents.length,
        mergedEvents: events.length,
        store,
        latest: latestMeta,
      },
      tradesLoaded: events.length,
      report,
    });
  } catch (error) {
    console.error("ANALYSE API ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: error?.message || "unknown_analyse_error",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    });
  }
}