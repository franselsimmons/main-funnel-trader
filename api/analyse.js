// ================= api/analyse.js =================
// GET    /api/analyse          -> report
// POST   /api/analyse          -> store actions/events + report
// DELETE /api/analyse          -> reset analyze store
//
// Response geeft zowel `summary` top-level als `report.summary`.
// Daardoor breekt frontend niet meer op report.summary undefined.

import {
  appendAnalyzeEvents,
  readAllAnalyzeEvents,
  resetAnalyzeStore,
  getAnalyzeStoreMeta
} from "../lib/analyze/analyzeStore.js";

import {
  buildAnalyzeReport,
  ANALYZE_FAMILY_VERSION
} from "../lib/analyze/familyEngine.js";

function setJsonHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  const text = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function extractEvents(body) {
  if (Array.isArray(body)) return body;

  if (Array.isArray(body?.actions)) return body.actions;
  if (Array.isArray(body?.events)) return body.events;
  if (Array.isArray(body?.rows)) return body.rows;
  if (Array.isArray(body?.trades)) return body.trades;

  if (body?.action || body?.symbol || body?.tradeId) {
    return [body];
  }

  return [];
}

function extractMeta(body) {
  return {
    runId: body?.runId || null,
    btcState: body?.btcState || null,
    strategyVersion: body?.strategyVersion || null,
    discoveryMode: Boolean(body?.discoveryMode),
    filterValues: body?.filterValues || body?.currentFilterValues || null,
    tradeSystemFilters: body?.tradeSystemFilters || null
  };
}

async function buildResponse(req) {
  const includeLocal = String(req.query?.includeLocal || "true") !== "false";
  const minClosed = Number(req.query?.minClosed || 10);

  const events = await readAllAnalyzeEvents({
    includeLocal
  });

  const report = buildAnalyzeReport(events, {
    minClosed
  });

  return {
    ok: true,
    version: ANALYZE_FAMILY_VERSION,
    store: getAnalyzeStoreMeta(),

    summary: report.summary,
    report,

    rawRows: events.length
  };
}

export default async function handler(req, res) {
  setJsonHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "DELETE") {
      const reset = await resetAnalyzeStore();

      res.status(200).json({
        ok: true,
        reset
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const events = extractEvents(body);
      const meta = extractMeta(body);

      const stored = await appendAnalyzeEvents(events, {
        ...meta,
        source: "API_POST"
      });

      const response = await buildResponse(req);

      res.status(200).json({
        ...response,
        stored
      });
      return;
    }

    if (req.method === "GET") {
      if (String(req.query?.reset || "") === "true") {
        const reset = await resetAnalyzeStore();

        res.status(200).json({
          ok: true,
          reset
        });
        return;
      }

      const response = await buildResponse(req);

      res.status(200).json(response);
      return;
    }

    res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED"
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      stack: process.env.NODE_ENV === "production" ? undefined : e.stack
    });
  }
}