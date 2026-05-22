// ================= api/analyse.js =================

import {
  ingestAnalysisRows,
  loadAnalysisRows,
  resetAnalysisRows,
  getAnalyzeStoreInfo
} from "../lib/analyze/analyzeStore.js";

import {
  buildFamilyAnalysis,
  buildFamilyDefinitions,
  TRACKED_FILTERS,
  ANALYZE_ENGINE_VERSION
} from "../lib/analyze/familyEngine.js";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return await new Promise(resolve => {
    let raw = "";

    req.on("data", chunk => {
      raw += chunk;
    });

    req.on("end", () => {
      if (!raw) return resolve({});

      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });

    req.on("error", () => resolve({}));
  });
}

function getQuery(req) {
  const url = new URL(req.url || "/api/analyse", "http://localhost");
  return Object.fromEntries(url.searchParams.entries());
}

function adminAllowed(req, query) {
  const token = process.env.ANALYZE_ADMIN_TOKEN || "";
  if (!token) return true;

  const bearer = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  return bearer === token || query.token === token;
}

function buildCompatReport({ analysis, rows, store }) {
  const summary = analysis?.summary || {};

  return {
    version: analysis?.version || ANALYZE_ENGINE_VERSION,
    generatedAt: analysis?.generatedAt || Date.now(),

    summary: {
      actions: summary.actions ?? summary.normalizedRows ?? rows.length ?? 0,
      trades: summary.trades ?? summary.normalizedRows ?? rows.length ?? 0,

      open: summary.open ?? 0,
      closed: summary.closed ?? 0,

      wins: summary.wins ?? 0,
      losses: summary.losses ?? 0,
      winrate: summary.winrate ?? "0.0%",

      totalR: summary.totalR ?? 0,
      avgR: summary.avgR ?? 0,

      totalPnlPct: summary.totalPnlPct ?? 0,
      avgPnlPct: summary.avgPnlPct ?? 0,

      longFamilies: summary.longFamilies ?? 50,
      shortFamilies: summary.shortFamilies ?? 50,

      rawRows: summary.rawRows ?? rows.length ?? 0,
      normalizedRows: summary.normalizedRows ?? 0,
      observedFamilies: summary.observedFamilies ?? 0,
      families: summary.families ?? 100
    },

    longFamilies: analysis?.longFamilies || [],
    shortFamilies: analysis?.shortFamilies || [],
    families: analysis?.families || [],

    topLong: analysis?.topLong || [],
    topShort: analysis?.topShort || [],

    rows: analysis?.rows || [],
    actions: analysis?.rows || [],
    trades: analysis?.rows || [],

    trackedFilters: analysis?.trackedFilters || TRACKED_FILTERS,
    filterValues: analysis?.filterValues || null,

    store
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const query = getQuery(req);

  try {
    if (req.method === "POST") {
      const body = await parseBody(req);
      const result = await ingestAnalysisRows(body, body?.meta || {});

      return sendJson(res, 200, {
        ok: true,
        ...result,
        store: getAnalyzeStoreInfo()
      });
    }

    if (req.method === "DELETE" || query.reset === "1") {
      if (!adminAllowed(req, query)) {
        return sendJson(res, 401, {
          ok: false,
          error: "UNAUTHORIZED_RESET"
        });
      }

      const result = await resetAnalysisRows();

      return sendJson(res, 200, {
        ok: true,
        reset: true,
        ...result
      });
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, {
        ok: false,
        error: "METHOD_NOT_ALLOWED"
      });
    }

    const limit = Number(query.limit || process.env.ANALYZE_READ_LIMIT || 50_000);
    const rows = await loadAnalysisRows({ limit });
    const store = getAnalyzeStoreInfo();

    if (query.raw === "1") {
      return sendJson(res, 200, {
        ok: true,
        version: ANALYZE_ENGINE_VERSION,
        store,
        count: rows.length,
        rows
      });
    }

    if (query.definitions === "1") {
      const definitions = buildFamilyDefinitions();

      return sendJson(res, 200, {
        ok: true,
        version: ANALYZE_ENGINE_VERSION,
        trackedFilters: TRACKED_FILTERS,
        families: definitions,
        report: {
          version: ANALYZE_ENGINE_VERSION,
          summary: {
            families: definitions.length,
            longFamilies: definitions.filter(f => f.side === "LONG").length,
            shortFamilies: definitions.filter(f => f.side === "SHORT").length
          },
          trackedFilters: TRACKED_FILTERS,
          families: definitions
        }
      });
    }

    const analysis = buildFamilyAnalysis(rows, {
      limit,
      side: query.side || "ALL"
    });

    const report = buildCompatReport({
      analysis,
      rows,
      store
    });

    return sendJson(res, 200, {
      ok: true,

      // nieuwe shape
      store,
      ...analysis,

      // compat shape voor oude frontend
      report
    });
  } catch (e) {
    return sendJson(res, 500, {
      ok: false,
      error: e.message,
      stack: process.env.NODE_ENV === "development" ? e.stack : undefined,

      report: {
        summary: {
          actions: 0,
          trades: 0,
          open: 0,
          closed: 0,
          wins: 0,
          losses: 0,
          winrate: "0.0%",
          totalR: 0,
          avgR: 0,
          totalPnlPct: 0,
          avgPnlPct: 0,
          longFamilies: 50,
          shortFamilies: 50
        },
        families: [],
        longFamilies: [],
        shortFamilies: [],
        rows: [],
        actions: [],
        trades: [],
        trackedFilters: TRACKED_FILTERS,
        filterValues: null
      }
    });
  }
}