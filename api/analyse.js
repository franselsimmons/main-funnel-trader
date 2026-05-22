// ================= API/ANALYSE.JS =================

import fs from "fs/promises";
import path from "path";

import {
  createAnalyzeState,
  hydrateAnalyzeState,
  ingestAnalysisBatch,
  buildAnalyzeReport
} from "../lib/analyze/familyEngine.js";

const ANALYZE_STATE_KEY = "TS_ANALYZE:FAMILY_STATE:V1";
const LOCAL_DATA_FILE = path.join(process.cwd(), "data", "analyze-state.json");

function getRedisUrl() {
  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ""
  );
}

function getRedisToken() {
  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ""
  );
}

function hasRedis() {
  return Boolean(getRedisUrl() && getRedisToken());
}

async function redisCommand(command) {
  const res = await fetch(getRedisUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getRedisToken()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || json?.error) {
    throw new Error(json?.error || text || `redis_error_${res.status}`);
  }

  return json?.result;
}

function safeJsonParse(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function loadState() {
  if (globalThis.__TS_ANALYZE_STATE__) {
    return hydrateAnalyzeState(globalThis.__TS_ANALYZE_STATE__);
  }

  if (hasRedis()) {
    const raw = await redisCommand(["GET", ANALYZE_STATE_KEY]).catch(() => null);
    const parsed = safeJsonParse(raw);

    const state = parsed
      ? hydrateAnalyzeState(parsed)
      : createAnalyzeState();

    globalThis.__TS_ANALYZE_STATE__ = state;
    return state;
  }

  const local = await fs
    .readFile(LOCAL_DATA_FILE, "utf8")
    .then(safeJsonParse)
    .catch(() => null);

  const state = local
    ? hydrateAnalyzeState(local)
    : createAnalyzeState();

  globalThis.__TS_ANALYZE_STATE__ = state;
  return state;
}

async function saveState(state) {
  const hydrated = hydrateAnalyzeState(state);
  globalThis.__TS_ANALYZE_STATE__ = hydrated;

  if (hasRedis()) {
    await redisCommand(["SET", ANALYZE_STATE_KEY, JSON.stringify(hydrated)]);
    return true;
  }

  await fs.mkdir(path.dirname(LOCAL_DATA_FILE), { recursive: true }).catch(() => null);
  await fs.writeFile(LOCAL_DATA_FILE, JSON.stringify(hydrated, null, 2), "utf8").catch(() => null);

  return true;
}

async function readJsonBody(req) {
  if (req.body) {
    return typeof req.body === "string"
      ? safeJsonParse(req.body)
      : req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return safeJsonParse(raw) || {};
}

function checkSecret(req) {
  const expected = process.env.ANALYZE_API_SECRET || "";
  if (!expected) return true;

  const provided =
    req.headers["x-analyze-secret"] ||
    req.headers["X-Analyze-Secret"];

  return provided === expected;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-analyze-secret");
      res.end();
      return;
    }

    if (req.method === "GET") {
      const state = await loadState();

      if (req.query?.raw === "1" || req.url?.includes("raw=1")) {
        send(res, 200, {
          ok: true,
          storage: hasRedis() ? "redis" : "local",
          state
        });
        return;
      }

      const report = buildAnalyzeReport(state);

      send(res, 200, {
        ok: true,
        storage: hasRedis() ? "redis" : "local",
        report
      });
      return;
    }

    if (req.method === "POST") {
      if (!checkSecret(req)) {
        send(res, 401, {
          ok: false,
          error: "ANALYZE_SECRET_INVALID"
        });
        return;
      }

      const body = await readJsonBody(req);
      const state = await loadState();
      const nextState = ingestAnalysisBatch(state, body);

      await saveState(nextState);

      const report = buildAnalyzeReport(nextState);

      send(res, 200, {
        ok: true,
        received: Array.isArray(body?.actions) ? body.actions.length : 0,
        summary: report.summary
      });
      return;
    }

    if (req.method === "DELETE") {
      if (!checkSecret(req)) {
        send(res, 401, {
          ok: false,
          error: "ANALYZE_SECRET_INVALID"
        });
        return;
      }

      const fresh = createAnalyzeState();
      await saveState(fresh);

      send(res, 200, {
        ok: true,
        reset: true,
        report: buildAnalyzeReport(fresh)
      });
      return;
    }

    send(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED"
    });
  } catch (e) {
    console.error("API_ANALYSE_ERROR:", e);

    send(res, 500, {
      ok: false,
      error: e.message
    });
  }
}