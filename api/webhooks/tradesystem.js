const SECRET =
  process.env.ANALYZER_WEBHOOK_SECRET ||
  process.env.TRADE_ANALYZER_WEBHOOK_SECRET ||
  "090117";

const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  "";

const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  "";

const TRADES_KEY = "tradesystem:events:v1";
const MAX_EVENTS = 10000;

function hasRedis() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisCommand(command) {
  if (!hasRedis()) {
    throw new Error("REDIS_ENV_MISSING");
  }

  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
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
    throw new Error(json?.error || text || `REDIS_ERROR_${res.status}`);
  }

  return json.result;
}

function getSecretFromReq(req) {
  const querySecret = req.query?.secret;
  const headerSecret =
    req.headers["x-analyzer-secret"] ||
    req.headers["x-webhook-secret"];

  return String(querySecret || headerSecret || "");
}

function normalizeAction(action) {
  const a = String(action || "").toUpperCase();

  if (a === "ENTRY") return "ENTRY";
  if (a === "EXIT") return "EXIT";
  if (a === "HOLD") return "HOLD";
  if (a === "WAIT") return "WAIT";

  return a || "UNKNOWN";
}

function extractRows(body) {
  if (Array.isArray(body)) return body;

  if (!body || typeof body !== "object") return [];

  if (Array.isArray(body.actions)) return body.actions;
  if (Array.isArray(body.events)) return body.events;
  if (Array.isArray(body.rows)) return body.rows;
  if (Array.isArray(body.data)) return body.data;

  if (body.payload && Array.isArray(body.payload.actions)) {
    return body.payload.actions;
  }

  return [body];
}

function buildEvent(row, index, meta) {
  const ts = Number(row.ts || Date.now());
  const action = normalizeAction(row.action || row.eventType);
  const symbol = String(row.symbol || "UNKNOWN").toUpperCase();
  const side = String(row.side || "unknown").toLowerCase();
  const runId = String(row.runId || meta.runId || `run_${Date.now()}`);

  return {
    ...row,

    id:
      row.id ||
      row.eventId ||
      `${runId}_${action}_${symbol}_${side}_${ts}_${index}`,

    eventId:
      row.eventId ||
      row.id ||
      `${runId}_${action}_${symbol}_${side}_${ts}_${index}`,

    eventType: action,
    action,

    symbol,
    side,
    runId,

    strategyVersion:
      row.strategyVersion ||
      meta.strategyVersion ||
      null,

    btcState:
      row.btcState ||
      meta.btcState ||
      null,

    discoveryMode:
      row.discoveryMode ??
      meta.discoveryMode ??
      null,

    receivedAt: Date.now(),
    ts,

    webhookMeta: meta
  };
}

async function storeEvents(events) {
  if (!events.length) {
    return {
      stored: 0
    };
  }

  const serialized = events.map(event => JSON.stringify(event));

  await redisCommand(["LPUSH", TRADES_KEY, ...serialized]);
  await redisCommand(["LTRIM", TRADES_KEY, 0, MAX_EVENTS - 1]);

  return {
    stored: events.length
  };
}

async function getCount() {
  if (!hasRedis()) return 0;
  return Number(await redisCommand(["LLEN", TRADES_KEY]));
}

export default async function handler(req, res) {
  const incomingSecret = getSecretFromReq(req);

  if (SECRET && incomingSecret !== SECRET) {
    return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED"
    });
  }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "root-api-webhooks-tradesystem-online",
      redis: hasRedis(),
      count: await getCount()
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED"
    });
  }

  if (!hasRedis()) {
    return res.status(500).json({
      ok: false,
      error: "REDIS_ENV_MISSING"
    });
  }

  const body = req.body || {};
  const rows = extractRows(body);

  if (!rows.length) {
    return res.status(400).json({
      ok: false,
      error: "NO_ROWS"
    });
  }

  const meta = {
    runId: body.runId || null,
    btcState: body.btcState || null,
    strategyVersion: body.strategyVersion || null,
    discoveryMode: body.discoveryMode ?? null,
    filterValues: body.filterValues || null,
    currentFilterValues: body.currentFilterValues || null,
    tradeSystemFilters: body.tradeSystemFilters || null
  };

  const events = rows.map((row, index) => buildEvent(row, index, meta));

  const result = await storeEvents(events);
  const count = await getCount();

  return res.status(200).json({
    ok: true,
    route: "root-api-webhooks-tradesystem-stored",
    redis: true,
    received: rows.length,
    stored: result.stored,
    count
  });
}