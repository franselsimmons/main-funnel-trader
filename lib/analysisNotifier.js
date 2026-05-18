// ================= ANALYSIS NOTIFIER =================

const ANALYSIS_WEBHOOK_PATH =
  process.env.ANALYSIS_WEBHOOK_PATH || "/api/webhooks/tradesystem";

const ANALYSIS_WEBHOOK_BASE_URL =
  process.env.ANALYSIS_BASE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://crypto-voorspeller.vercel.app");

function buildDefaultAnalysisWebhookUrl() {
  const base = String(ANALYSIS_WEBHOOK_BASE_URL || "").replace(/\/+$/, "");
  const path = String(
    ANALYSIS_WEBHOOK_PATH || "/api/webhooks/tradesystem"
  ).startsWith("/")
    ? ANALYSIS_WEBHOOK_PATH
    : `/${ANALYSIS_WEBHOOK_PATH}`;

  if (!base) return "";
  return `${base}${path}`;
}

const ANALYSIS_WEBHOOK_URL = String(
  process.env.ANALYSIS_WEBHOOK_URL || buildDefaultAnalysisWebhookUrl()
).trim();

const ENABLE_ANALYSIS_WEBHOOK =
  ANALYSIS_WEBHOOK_URL.length > 0 &&
  String(process.env.ENABLE_ANALYSIS_WEBHOOK ?? "true").toLowerCase() !== "false";

const ANALYSIS_WEBHOOK_SECRET =
  process.env.ANALYSIS_WEBHOOK_SECRET ||
  process.env.WEBHOOK_SECRET ||
  process.env.TRADE_WEBHOOK_SECRET ||
  "";

const REQUIRE_ANALYSIS_WEBHOOK_SECRET =
  String(process.env.REQUIRE_ANALYSIS_WEBHOOK_SECRET || "false").toLowerCase() === "true";

const ANALYSIS_WEBHOOK_CONCURRENCY = Math.max(
  1,
  Number(process.env.ANALYSIS_WEBHOOK_CONCURRENCY || 8)
);

const ANALYSIS_WEBHOOK_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.ANALYSIS_WEBHOOK_TIMEOUT_MS || 7000)
);

const ANALYSIS_WEBHOOK_PAYLOAD_MAX_CHARS = Math.max(
  4000,
  Number(process.env.ANALYSIS_WEBHOOK_PAYLOAD_MAX_CHARS || 120000)
);

console.log("TS_ANALYSIS_WEBHOOK_CONFIG:", JSON.stringify({
  enabled: ENABLE_ANALYSIS_WEBHOOK,
  urlConfigured: Boolean(ANALYSIS_WEBHOOK_URL),
  secretConfigured: Boolean(ANALYSIS_WEBHOOK_SECRET),
  requireSecret: REQUIRE_ANALYSIS_WEBHOOK_SECRET,
  concurrency: ANALYSIS_WEBHOOK_CONCURRENCY,
  timeoutMs: ANALYSIS_WEBHOOK_TIMEOUT_MS
}));

function safeWebhookString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;

  if (typeof value === "string") return value;

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function truncateWebhookString(value, maxChars = 4000) {
  const text = safeWebhookString(value);

  if (text.length <= maxChars) return text;

  return text.slice(0, maxChars);
}

function sanitizeWebhookPayload(payload, maxChars = 4000) {
  if (!payload || typeof payload !== "object") return {};

  const out = {};

  for (const [key, value] of Object.entries(payload)) {
    out[key] = truncateWebhookString(value, maxChars);
  }

  return out;
}

function webhookSlug(value, fallback = "x", maxChars = 80) {
  const text = safeWebhookString(value, fallback)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "");

  return (text || fallback).slice(0, maxChars);
}

function normalizeBaseSymbol(raw) {
  return String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function getAnalysisEventType(action) {
  const a = String(action?.action || "").toUpperCase();

  if (a === "ENTRY") return "ENTRY";
  if (a === "EXIT") return "EXIT";
  if (a === "WAIT") return "REJECT";
  if (a === "REJECT") return "REJECT";
  if (a === "HOLD") return "HOLD";

  return "SNAPSHOT";
}

function getWebhookReason(payload = {}) {
  return safeWebhookString(
    payload.rejectReason ||
      payload.exitReason ||
      payload.entryReason ||
      payload.reason ||
      payload.entryType ||
      "UNKNOWN",
    "UNKNOWN"
  );
}

function buildAnalysisTradeId(action, runId, index, strategyVersion) {
  if (action?.tradeId) return String(action.tradeId);

  const symbol = normalizeBaseSymbol(action?.symbol || "UNKNOWN");
  const side = String(action?.side || "unknown").toLowerCase();
  const createdAt = action?.createdAt || action?.ts || Date.now();

  if (String(action?.action || "").toUpperCase() === "ENTRY") {
    return `${strategyVersion}_${symbol}_${side}_${createdAt}`;
  }

  return `${strategyVersion}_${symbol}_${side}_${runId}_${index}`;
}

function assertFlatStringBody(bodyObj) {
  const badFields = Object.entries(bodyObj || {})
    .filter(([, value]) => typeof value !== "string")
    .map(([key, value]) => ({
      key,
      type: Array.isArray(value) ? "array" : typeof value
    }));

  if (!badFields.length) return;

  throw new Error(
    `ANALYSIS_WEBHOOK_BODY_NOT_FLAT_STRING_ONLY: ${JSON.stringify(badFields.slice(0, 30))}`
  );
}

function getWebhookSignatureValue() {
  return safeWebhookString(ANALYSIS_WEBHOOK_SECRET || "", "");
}

function buildAnalysisWebhookEvent(action, meta = {}) {
  const {
    runId = "",
    btcState = "UNKNOWN",
    index = 0,
    strategyVersion = "UNKNOWN_STRATEGY",
    discoveryMode = false,
    filterValues = null,
    currentFilterValues = null,
    tradeSystemFilters = null
  } = meta;

  const eventType = getAnalysisEventType(action);
  const tradeId = buildAnalysisTradeId(action, runId, index, strategyVersion);
  const signature = getWebhookSignatureValue();

  const rawPayload = {
    ...action,

    source: "TRADE_SYSTEM",
    strategyVersion,
    runId,
    tradeId,

    eventType,
    action: String(action?.action || eventType).toUpperCase(),

    rejectReason:
      eventType === "REJECT"
        ? String(action?.reason || "UNKNOWN")
        : "",

    exitReason:
      eventType === "EXIT"
        ? String(action?.reason || action?.exitReason || "UNKNOWN")
        : "",

    entryReason:
      eventType === "ENTRY"
        ? String(action?.reason || action?.entryReason || action?.entryType || "UNKNOWN")
        : "",

    btcState: action?.btcState || btcState || "UNKNOWN",

    filterValues: action?.filterValues || filterValues || {},
    currentFilterValues: currentFilterValues || {},
    tradeSystemFilters: tradeSystemFilters || {},

    discoveryMode,
    analysisSchema: "TS_DISCOVERY_V2_FLAT_STRING_ONLY",

    // Compat met ingest-routes die signature uit body lezen.
    signature,
    webhookSignature: signature,
    webhookSecret: signature,

    ts: Number(action?.ts || Date.now())
  };

  const payload = sanitizeWebhookPayload(rawPayload);

  const symbol = safeWebhookString(payload.symbol || action?.symbol || "UNKNOWN", "UNKNOWN");
  const side = safeWebhookString(payload.side || action?.side || "unknown", "unknown");

  const reason = safeWebhookString(
    payload.rejectReason ||
      payload.exitReason ||
      payload.entryReason ||
      payload.reason ||
      action?.reason ||
      "UNKNOWN",
    "UNKNOWN"
  );

  return {
    eventId: [
      "ts",
      webhookSlug(strategyVersion),
      webhookSlug(runId),
      webhookSlug(index),
      webhookSlug(eventType),
      webhookSlug(symbol),
      webhookSlug(side),
      webhookSlug(reason)
    ].join("_"),

    eventType,
    source: "TRADE_SYSTEM",
    strategyVersion,
    runId,
    tradeId,

    symbol,
    side,
    action: safeWebhookString(payload.action || eventType, eventType),
    reason,

    payload
  };
}

function buildStrictFlatAnalysisWebhookBody(event) {
  const payload = sanitizeWebhookPayload(event?.payload || {});
  const signature = getWebhookSignatureValue();

  const eventType = safeWebhookString(
    event?.eventType || payload.eventType || "SNAPSHOT",
    "SNAPSHOT"
  );

  const symbol = safeWebhookString(
    event?.symbol || payload.symbol || "UNKNOWN",
    "UNKNOWN"
  );

  const side = safeWebhookString(
    event?.side || payload.side || "unknown",
    "unknown"
  );

  const action = safeWebhookString(
    event?.action || payload.action || eventType,
    eventType
  );

  const reason = safeWebhookString(
    event?.reason || getWebhookReason(payload),
    "UNKNOWN"
  );

  const base = {
    eventId: safeWebhookString(event?.eventId),
    eventType,
    source: safeWebhookString(event?.source || "TRADE_SYSTEM", "TRADE_SYSTEM"),
    strategyVersion: safeWebhookString(event?.strategyVersion || ""),
    runId: safeWebhookString(event?.runId),
    tradeId: safeWebhookString(event?.tradeId),

    symbol,
    side,
    action,
    reason,

    rejectReason: safeWebhookString(payload.rejectReason || ""),
    exitReason: safeWebhookString(payload.exitReason || ""),
    entryReason: safeWebhookString(payload.entryReason || ""),

    // Hard fix voor WEBHOOK_SIGNATURE_MISSING.
    signature,
    webhookSignature: signature,
    webhookSecret: signature,

    payloadJson: truncateWebhookString(payload, ANALYSIS_WEBHOOK_PAYLOAD_MAX_CHARS)
  };

  for (const [key, value] of Object.entries(payload)) {
    if (Object.prototype.hasOwnProperty.call(base, key)) continue;
    base[key] = truncateWebhookString(value);
  }

  const bodyObj = sanitizeWebhookPayload(base, ANALYSIS_WEBHOOK_PAYLOAD_MAX_CHARS);

  assertFlatStringBody(bodyObj);

  return bodyObj;
}

function buildAnalysisWebhookHeaders() {
  const headers = {
    "Content-Type": "application/json"
  };

  const signature = getWebhookSignatureValue();

  if (!signature) {
    return headers;
  }

  // Legacy secret headers.
  headers["x-webhook-secret"] = signature;
  headers["x-trade-webhook-secret"] = signature;
  headers["x-analysis-webhook-secret"] = signature;

  // Required by routes / ingest implementations that check signature headers.
  headers["x-webhook-signature"] = signature;
  headers["x-trade-webhook-signature"] = signature;
  headers["x-analysis-webhook-signature"] = signature;

  headers.Authorization = `Bearer ${signature}`;

  return headers;
}

async function postAnalysisWebhookBody(bodyObj) {
  const flatBodyObj = sanitizeWebhookPayload(
    bodyObj,
    ANALYSIS_WEBHOOK_PAYLOAD_MAX_CHARS
  );

  assertFlatStringBody(flatBodyObj);

  const body = JSON.stringify(flatBodyObj);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ANALYSIS_WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(ANALYSIS_WEBHOOK_URL, {
      method: "POST",
      headers: buildAnalysisWebhookHeaders(),
      body,
      signal: controller.signal
    });

    const text = await res.text();

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      text,
      bodyObj: flatBodyObj
    };
  } catch (e) {
    const isAbort =
      e?.name === "AbortError" ||
      String(e?.message || "").toLowerCase().includes("aborted");

    return {
      ok: false,
      status: 0,
      statusText: isAbort ? "TIMEOUT" : "FETCH_ERROR",
      text: isAbort
        ? `TIMEOUT_${ANALYSIS_WEBHOOK_TIMEOUT_MS}MS`
        : safeWebhookString(e?.message, "unknown_fetch_error"),
      bodyObj: flatBodyObj
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendAnalysisWebhookEvent(event) {
  if (!ENABLE_ANALYSIS_WEBHOOK) {
    return {
      ok: false,
      skipped: true,
      reason: "disabled"
    };
  }

  if (!ANALYSIS_WEBHOOK_URL) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_url"
    };
  }

  if (REQUIRE_ANALYSIS_WEBHOOK_SECRET && !ANALYSIS_WEBHOOK_SECRET) {
    console.warn("TS_ANALYSIS_WEBHOOK_SKIPPED:", JSON.stringify({
      reason: "missing_secret_required",
      eventType: event?.eventType,
      symbol: event?.symbol || event?.payload?.symbol,
      side: event?.side || event?.payload?.side
    }));

    return {
      ok: false,
      skipped: true,
      reason: "missing_secret_required"
    };
  }

  const bodyObj = buildStrictFlatAnalysisWebhookBody(event);

  if (process.env.TS_DEBUG_ANALYSIS_WEBHOOK === "true") {
    console.log("TS_ANALYSIS_WEBHOOK_BODY_TYPES:", JSON.stringify({
      eventType: bodyObj.eventType,
      symbol: bodyObj.symbol,
      side: bodyObj.side,
      reason: bodyObj.reason,
      hasSignature: Boolean(bodyObj.signature),
      nonStringFields: Object.entries(bodyObj)
        .filter(([, value]) => typeof value !== "string")
        .map(([key, value]) => ({
          key,
          type: Array.isArray(value) ? "array" : typeof value
        })),
      keys: Object.keys(bodyObj).slice(0, 80)
    }));
  }

  const result = await postAnalysisWebhookBody(bodyObj);
  const sentBody = result.bodyObj || bodyObj;

  if (!result.ok) {
    console.warn("TS_ANALYSIS_WEBHOOK_FAILED:", JSON.stringify({
      status: result.status,
      statusText: result.statusText,
      eventType: sentBody.eventType,
      symbol: sentBody.symbol,
      side: sentBody.side,
      reason: sentBody.reason,
      response: String(result.text || "").slice(0, 500)
    }));

    return {
      ok: false,
      status: result.status,
      text: result.text
    };
  }

  console.log("TS_ANALYSIS_WEBHOOK_SENT:", JSON.stringify({
    status: result.status,
    eventType: sentBody.eventType,
    symbol: sentBody.symbol,
    side: sentBody.side,
    reason: sentBody.reason
  }));

  return {
    ok: true,
    status: result.status
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const rows = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency || 1));
  const results = [];

  let index = 0;

  async function worker() {
    while (index < rows.length) {
      const currentIndex = index++;
      results[currentIndex] = await mapper(rows[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, rows.length) },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

export async function sendAnalysisActions(actions, meta = {}) {
  if (!ENABLE_ANALYSIS_WEBHOOK || !ANALYSIS_WEBHOOK_URL) {
    return {
      ok: false,
      skipped: true,
      reason: "analysis_webhook_disabled_or_missing_url"
    };
  }

  const rows = Array.isArray(actions)
    ? actions.filter(action => {
        if (!action?.symbol || !action?.side) return false;

        const actionType = String(action?.action || "").toUpperCase();

        if (
          actionType === "HOLD" &&
          process.env.ANALYSIS_WEBHOOK_SEND_HOLDS !== "true"
        ) {
          return false;
        }

        return true;
      })
    : [];

  console.log("TS_ANALYSIS_WEBHOOK_ATTEMPT:", JSON.stringify({
    runId: meta.runId,
    actions: Array.isArray(actions) ? actions.length : 0,
    analysisRows: rows.length,
    entries: rows.filter(a => String(a.action || "").toUpperCase() === "ENTRY").length,
    exits: rows.filter(a => String(a.action || "").toUpperCase() === "EXIT").length,
    waits: rows.filter(a => String(a.action || "").toUpperCase() === "WAIT").length,
    rejects: rows.filter(a => String(a.action || "").toUpperCase() === "REJECT").length,
    holds: rows.filter(a => String(a.action || "").toUpperCase() === "HOLD").length,
    urlConfigured: Boolean(ANALYSIS_WEBHOOK_URL),
    secretConfigured: Boolean(ANALYSIS_WEBHOOK_SECRET)
  }));

  if (!rows.length) {
    return {
      ok: true,
      total: 0,
      sent: 0,
      failed: 0
    };
  }

  let sent = 0;
  let failed = 0;

  await mapConcurrent(
    rows,
    ANALYSIS_WEBHOOK_CONCURRENCY,
    async (action, index) => {
      const event = buildAnalysisWebhookEvent(action, {
        ...meta,
        index
      });

      const result = await sendAnalysisWebhookEvent(event);

      if (result.ok) {
        sent++;
        return;
      }

      failed++;
    }
  );

  console.log("TS_ANALYSIS_WEBHOOK_SUMMARY:", JSON.stringify({
    runId: meta.runId,
    total: rows.length,
    sent,
    failed,
    url: ANALYSIS_WEBHOOK_URL
  }));

  return {
    ok: failed === 0,
    total: rows.length,
    sent,
    failed
  };
}