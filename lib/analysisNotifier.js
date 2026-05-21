// ================= ANALYSIS NOTIFIER =================

const ANALYSIS_WEBHOOK_URL =
  process.env.ANALYSIS_WEBHOOK_URL ||
  process.env.TRADE_ANALYSIS_WEBHOOK_URL ||
  "";

const ANALYSIS_WEBHOOK_SECRET =
  process.env.ANALYSIS_WEBHOOK_SECRET ||
  process.env.WEBHOOK_SECRET ||
  process.env.TRADE_WEBHOOK_SECRET ||
  "";

const DEFAULT_TIMEOUT_MS = Number(process.env.ANALYSIS_WEBHOOK_TIMEOUT_MS || 30_000);

// Kleine batches. Geen 700KB meer.
// Dit voorkomt Vercel body/timeouts en "This operation was aborted".
const MAX_BATCH_SIZE = Number(process.env.ANALYSIS_WEBHOOK_MAX_BATCH_SIZE || 8);
const MAX_BATCH_BYTES = Number(process.env.ANALYSIS_WEBHOOK_MAX_BATCH_BYTES || 45_000);
const MAX_SINGLE_ROW_BYTES = Number(process.env.ANALYSIS_WEBHOOK_MAX_SINGLE_ROW_BYTES || 25_000);

const MAX_RETRIES = Number(process.env.ANALYSIS_WEBHOOK_MAX_RETRIES || 2);
const RETRY_DELAY_MS = Number(process.env.ANALYSIS_WEBHOOK_RETRY_DELAY_MS || 350);
const BETWEEN_BATCH_DELAY_MS = Number(process.env.ANALYSIS_WEBHOOK_BATCH_DELAY_MS || 150);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    .replace(/USDC$/, "")
    .replace(/USD$/, "");
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;

  const cleaned =
    typeof value === "string"
      ? value.replace("%", "").replace(",", ".").trim()
      : value;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const cleaned =
    typeof value === "string"
      ? value.replace("%", "").replace(",", ".").trim()
      : value;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function safeUpper(value, fallback = "UNKNOWN") {
  const result = String(value ?? fallback).trim().toUpperCase();
  return result || fallback;
}

function safeLower(value, fallback = "unknown") {
  const result = String(value ?? fallback).trim().toLowerCase();
  return result || fallback;
}

function safeBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;

  const raw = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "y", "on"].includes(raw);
}

function jsonByteLength(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);

  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(text, "utf8");
  }

  return text.length;
}

function normalizeEventType(action) {
  const a = String(action || "").toUpperCase();

  if (a.includes("ENTRY")) return "ENTRY";
  if (a.includes("ENTER")) return "ENTRY";
  if (a.includes("OPEN_TRADE")) return "ENTRY";
  if (a === "OPEN") return "ENTRY";

  if (a.includes("EXIT")) return "EXIT";
  if (a.includes("CLOSE")) return "EXIT";
  if (a.includes("CLOSED")) return "EXIT";

  if (a.includes("WAIT")) return "REJECT";
  if (a.includes("SKIP")) return "REJECT";
  if (a.includes("REJECT")) return "REJECT";
  if (a.includes("FILTER_FAIL")) return "REJECT";

  if (a.includes("HOLD")) return "SNAPSHOT";
  if (a.includes("SNAPSHOT")) return "SNAPSHOT";

  return "SNAPSHOT";
}

function isSendableAnalysisAction(action) {
  if (!action || typeof action !== "object") return false;

  const eventType = normalizeEventType(
    action.eventType ||
      action.type ||
      action.action ||
      action.event
  );

  if (!["ENTRY", "EXIT", "REJECT", "SNAPSHOT"].includes(eventType)) {
    return false;
  }

  if (!action.symbol && !action.rawBitgetSymbol && !action.contractSymbol) return false;
  if (!action.side) return false;

  return true;
}

function stripHeavyFields(row) {
  if (!row || typeof row !== "object") return row;

  const {
    filterDiagnostics,
    filterValues,
    filterChecks,
    liveFilterMetrics,
    specialFilterChecks,
    payload,
    rawJson,
    payloadJson,
    orderbook,
    orderBook,
    candles,
    klines,
    ticks,
    debug,
    diagnostics,
    ...rest
  } = row;

  return {
    ...rest,
    filterDiagnostics: null,
    filterValues: null,
    filterChecks: null,
    liveFilterMetrics: null,
    specialFilterChecks: null,
    compactedForWebhook: true
  };
}

function buildTradeId(action, meta, symbol, side) {
  const existing =
    action.tradeId ||
    action.id ||
    action.signalId ||
    action.payload?.tradeId ||
    action.payload?.id;

  if (existing) return String(existing);

  return [
    meta.strategyVersion || action.strategyVersion || "TS",
    symbol || "UNKNOWN",
    side || "unknown",
    action.createdAt || action.ts || Date.now()
  ]
    .filter(Boolean)
    .join("_");
}

function buildEventId(action, eventType, meta, symbol, side, tradeId) {
  const existing =
    action.eventId ||
    action.payload?.eventId;

  if (existing) return String(existing);

  return [
    "ts",
    eventType,
    symbol || "UNKNOWN",
    side || "unknown",
    action.reason || action.entryReason || action.exitReason || "UNKNOWN",
    meta.strategyVersion || action.strategyVersion || "UNKNOWN",
    tradeId,
    action.ts || action.createdAt || Date.now()
  ]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .slice(0, 260);
}

function buildAnalysisRow(action, meta = {}) {
  const eventType = normalizeEventType(
    action.eventType ||
      action.type ||
      action.action ||
      action.event
  );

  const symbol = normalizeBaseSymbol(
    action.symbol ||
      action.rawBitgetSymbol ||
      action.contractSymbol ||
      action.payload?.symbol
  );

  const side = safeLower(action.side || action.payload?.side);
  const tradeId = buildTradeId(action, meta, symbol, side);
  const eventId = buildEventId(action, eventType, meta, symbol, side, tradeId);

  const entry = nullableNumber(action.entry ?? action.entryPrice ?? action.price);
  const price = nullableNumber(action.price ?? action.entry ?? action.entryPrice);
  const sl = nullableNumber(action.sl ?? action.slPrice ?? action.initialSl);
  const initialSl = nullableNumber(action.initialSl ?? action.sl ?? action.slPrice);
  const tp = nullableNumber(action.tp ?? action.tpPrice);

  const exit = nullableNumber(action.exit ?? action.exitPrice ?? action.executionPrice);
  const executionPrice = nullableNumber(action.executionPrice ?? action.exit ?? action.exitPrice);

  const isOpenSnapshot =
    eventType === "SNAPSHOT" ||
    safeBool(action.open) ||
    safeUpper(action.status, "") === "OPEN";

  const row = {
    eventId,
    eventType,
    action: eventType,
    source: action.source || "tradesystem",

    runId: action.runId || meta.runId || null,
    tradeId,

    symbol,
    rawBitgetSymbol:
      action.rawBitgetSymbol ||
      action.contractSymbol ||
      action.payload?.rawBitgetSymbol ||
      (symbol ? `${symbol}USDT` : null),

    side,

    status: isOpenSnapshot ? "OPEN" : eventType,
    open: Boolean(isOpenSnapshot),

    reason: safeUpper(
      action.reason ||
        action.entryReason ||
        action.exitReason ||
        action.rejectReason ||
        "UNKNOWN"
    ),

    entryReason: safeUpper(
      action.entryReason ||
        action.entryType ||
        action.reason ||
        "UNKNOWN"
    ),

    exitReason:
      eventType === "EXIT"
        ? safeUpper(action.exitReason || action.reason || "UNKNOWN")
        : action.exitReason || null,

    rejectReason:
      eventType === "REJECT"
        ? safeUpper(action.rejectReason || action.reason || "UNKNOWN")
        : action.rejectReason || null,

    setupClass: safeUpper(action.setupClass || "UNKNOWN"),
    grade: action.grade || null,
    gradePoints: safeNumber(action.gradePoints, 0),
    recommendedRisk: action.recommendedRisk || null,

    entry,
    price,
    entryPrice: entry,

    sl,
    slPrice: sl,
    initialSl,

    tp,
    tpPrice: tp,

    exit,
    exitPrice: exit,
    executionPrice,
    triggerPrice: nullableNumber(action.triggerPrice),

    rr: nullableNumber(action.rr ?? action.plannedRR ?? action.finalRr ?? action.finalRR),
    plannedRR: nullableNumber(action.plannedRR ?? action.rr ?? action.finalRr ?? action.finalRR),
    baseRR: nullableNumber(action.baseRR),
    finalRr: nullableNumber(action.finalRr ?? action.finalRR ?? action.plannedRR ?? action.rr),
    finalRR: nullableNumber(action.finalRR ?? action.finalRr ?? action.plannedRR ?? action.rr),
    effectiveRR: nullableNumber(action.effectiveRR ?? action.finalRr ?? action.finalRR ?? action.rr),
    tpRewardMultiplier: safeNumber(action.tpRewardMultiplier, 1),

    exitR: nullableNumber(action.exitR),
    pnlPct: nullableNumber(action.pnlPct ?? action.pnl),
    triggerR: nullableNumber(action.triggerR),
    triggerPnlPct: nullableNumber(action.triggerPnlPct),

    currentR: nullableNumber(action.currentR),
    mfeR: nullableNumber(action.mfeR),
    maeR: nullableNumber(action.maeR),
    maxTpProgress: nullableNumber(action.maxTpProgress),
    maxSlProgress: nullableNumber(action.maxSlProgress),

    reachedHalfR: safeBool(action.reachedHalfR),
    reachedOneR: safeBool(action.reachedOneR),
    nearTpSeen: safeBool(action.nearTpSeen),
    directToSL: safeBool(action.directToSL),
    slAfterHalfR: safeBool(action.slAfterHalfR),
    slAfterOneR: safeBool(action.slAfterOneR),
    slAfterNearTp: safeBool(action.slAfterNearTp),

    breakEvenActivated: safeBool(action.breakEvenActivated),
    breakEvenStop: safeBool(action.breakEvenStop),
    breakEvenSl: nullableNumber(action.breakEvenSl),
    slBeforeBreakEven: nullableNumber(action.slBeforeBreakEven),

    ticksObserved: safeNumber(action.ticksObserved, 0),
    favorableTicks: safeNumber(action.favorableTicks, 0),
    adverseTicks: safeNumber(action.adverseTicks, 0),
    neutralTicks: safeNumber(action.neutralTicks, 0),

    score: safeNumber(action.score ?? action.moveScore, 0),
    moveScore: safeNumber(action.moveScore ?? action.score, 0),

    confluence: safeNumber(action.confluence ?? action.effectiveConfluence, 0),
    rawConfluence: safeNumber(action.rawConfluence ?? action.confluence, 0),
    effectiveConfluence: safeNumber(action.effectiveConfluence ?? action.confluence, 0),

    sniper: action.sniper || null,
    sniperScore: safeNumber(action.sniperScore ?? action.fallbackSniperScore, 0),
    rawSniperScore: safeNumber(action.rawSniperScore ?? action.sniperScore, 0),
    fallbackSniperScore: safeNumber(action.fallbackSniperScore ?? action.sniperScore, 0),

    rsi: nullableNumber(action.rsi),
    rsiHTF: nullableNumber(action.rsiHTF),
    rsiZone: safeUpper(action.rsiZone || "UNKNOWN"),
    rsiEdge: action.rsiEdge || action.rsiEntryEdge || null,

    obBias: safeUpper(action.obBias || "UNKNOWN"),
    obRelation: action.obRelation ? safeUpper(action.obRelation) : null,

    spreadPct: nullableNumber(action.spreadPct),
    spreadBps: nullableNumber(action.spreadBps),
    depthMinUsd1p: nullableNumber(action.depthMinUsd1p ?? action.depthUsd1p),
    depthUsd1p: nullableNumber(action.depthUsd1p ?? action.depthMinUsd1p),

    spreadBucket: action.spreadBucket || null,
    depthBucket: action.depthBucket || null,

    flow: safeUpper(action.flow || "UNKNOWN"),
    funding: nullableNumber(action.funding),
    regime: safeUpper(action.regime || meta.regime || "UNKNOWN"),
    btcState: safeUpper(action.btcState || meta.btcState || "UNKNOWN"),

    stage: safeLower(action.stage || "unknown"),
    scannerStage: safeLower(action.scannerStage || action.stage || "unknown"),
    stageSource: action.stageSource || "unknown",

    bullishMidTrendProbe: safeBool(action.bullishMidTrendProbe),
    bullishMidTrendProbeReason: action.bullishMidTrendProbeReason || null,

    btcBullishBearException: safeBool(action.btcBullishBearException),
    btcBullishBearExceptionReason: action.btcBullishBearExceptionReason || null,

    // Bewust compact voor stabiliteit. Dit dashboard gebruikt vooral top-level velden.
    filterDiagnostics: null,
    filterValues: null,
    filterChecks: null,
    liveFilterMetrics: null,
    specialFilterChecks: null,

    analysisType: action.analysisType || meta.analysisType || "TRADESYSTEM",
    strategyVersion: action.strategyVersion || meta.strategyVersion || "UNKNOWN",
    discoveryMode: Boolean(action.discoveryMode ?? meta.discoveryMode),

    createdAt: safeNumber(action.createdAt, Date.now()),
    ts: safeNumber(action.ts ?? action.createdAt, Date.now()),
    receivedAt: Date.now()
  };

  if (jsonByteLength(row) > MAX_SINGLE_ROW_BYTES) {
    return stripHeavyFields(row);
  }

  return row;
}

async function postJson(url, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      "Content-Type": "application/json"
    };

    if (ANALYSIS_WEBHOOK_SECRET) {
      headers["x-webhook-secret"] = ANALYSIS_WEBHOOK_SECRET;
      headers["x-analysis-webhook-secret"] = ANALYSIS_WEBHOOK_SECRET;
      headers.authorization = `Bearer ${ANALYSIS_WEBHOOK_SECRET}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await res.text();

    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return {
      ok: res.ok,
      status: res.status,
      text,
      json,
      aborted: false,
      error: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted =
      error?.name === "AbortError" ||
      /abort|aborted|timeout/i.test(message);

    return {
      ok: false,
      status: aborted ? 408 : 0,
      text: "",
      json: null,
      aborted,
      error: message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildBatchPayload(batch, meta = {}) {
  return {
    source: "tradesystem",
    eventType: "BATCH",
    type: "BATCH",

    runId: meta.runId || null,
    strategyVersion: meta.strategyVersion || "UNKNOWN",
    btcState: meta.btcState || "UNKNOWN",
    discoveryMode: Boolean(meta.discoveryMode),

    actions: batch,
    rows: batch,
    data: batch,

    count: batch.length,
    ts: Date.now()
  };
}

function chunkRowsByPayloadSize(rows, meta = {}) {
  const chunks = [];
  let current = [];

  for (const rawRow of rows) {
    let row = rawRow;

    if (jsonByteLength(row) > MAX_SINGLE_ROW_BYTES) {
      row = stripHeavyFields(row);
    }

    const testChunk = [...current, row];
    const testPayload = buildBatchPayload(testChunk, meta);
    const testBytes = jsonByteLength(testPayload);

    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_SIZE || testBytes > MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [row];
      continue;
    }

    current = testChunk;
  }

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

function splitBatchInHalf(batch) {
  const mid = Math.max(1, Math.floor(batch.length / 2));

  return [
    batch.slice(0, mid),
    batch.slice(mid)
  ].filter(part => part.length > 0);
}

function shouldRetry(result) {
  if (!result) return true;
  if (result.ok) return false;
  if (result.aborted) return true;
  if (result.status === 0) return true;
  if (result.status === 408) return true;
  if (result.status === 429) return true;
  if (result.status >= 500) return true;

  return false;
}

function isPayloadTooLarge(result) {
  return (
    result?.status === 413 ||
    /payload|entity|too large|FUNCTION_PAYLOAD_TOO_LARGE|request body/i.test(
      String(result?.text || result?.error || "")
    )
  );
}

async function postWithRetry(payload) {
  let lastResult = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const timeoutMs = DEFAULT_TIMEOUT_MS + attempt * 10_000;
    const result = await postJson(ANALYSIS_WEBHOOK_URL, payload, timeoutMs);

    lastResult = result;

    if (result.ok) return result;
    if (!shouldRetry(result)) return result;

    await sleep(RETRY_DELAY_MS * (attempt + 1));
  }

  return lastResult;
}

async function sendSingleCompactedRow(row, meta = {}) {
  const compactedBatch = [stripHeavyFields(row)];
  const compactPayload = buildBatchPayload(compactedBatch, meta);
  const compactBytes = jsonByteLength(compactPayload);
  const compactResult = await postWithRetry(compactPayload);

  if (compactResult.ok) {
    console.log("TS_ANALYSIS_WEBHOOK_SENT_COMPACT_ROW:", JSON.stringify({
      status: compactResult.status,
      count: 1,
      bytes: compactBytes,
      eventType: compactedBatch[0]?.eventType,
      symbol: compactedBatch[0]?.symbol,
      side: compactedBatch[0]?.side
    }));

    return {
      sent: 1,
      failed: 0
    };
  }

  console.warn("TS_ANALYSIS_WEBHOOK_COMPACT_ROW_FAILED:", JSON.stringify({
    status: compactResult.status,
    bytes: compactBytes,
    eventType: compactedBatch[0]?.eventType,
    symbol: compactedBatch[0]?.symbol,
    side: compactedBatch[0]?.side,
    error: compactResult.error || null,
    response: String(compactResult.text || "").slice(0, 1000)
  }));

  return {
    sent: 0,
    failed: 1
  };
}

async function sendBatchWithAutoSplit(batch, meta = {}) {
  const payload = buildBatchPayload(batch, meta);
  const bytes = jsonByteLength(payload);

  const result = await postWithRetry(payload);

  if (result.ok) {
    console.log("TS_ANALYSIS_WEBHOOK_SENT_BATCH:", JSON.stringify({
      status: result.status,
      count: batch.length,
      bytes,
      entries: batch.filter(row => row.eventType === "ENTRY").length,
      exits: batch.filter(row => row.eventType === "EXIT").length,
      rejects: batch.filter(row => row.eventType === "REJECT").length,
      snapshots: batch.filter(row => row.eventType === "SNAPSHOT").length
    }));

    return {
      sent: batch.length,
      failed: 0
    };
  }

  const shouldSplit =
    batch.length > 1 &&
    (
      isPayloadTooLarge(result) ||
      result.aborted ||
      result.status === 408 ||
      result.status === 429 ||
      result.status >= 500 ||
      result.status === 0
    );

  if (shouldSplit) {
    console.warn("TS_ANALYSIS_WEBHOOK_SPLIT_BATCH:", JSON.stringify({
      status: result.status,
      count: batch.length,
      bytes,
      aborted: result.aborted,
      error: result.error || null,
      response: String(result.text || "").slice(0, 500)
    }));

    const [left, right] = splitBatchInHalf(batch);

    const leftResult = await sendBatchWithAutoSplit(left, meta);
    await sleep(BETWEEN_BATCH_DELAY_MS);
    const rightResult = await sendBatchWithAutoSplit(right, meta);

    return {
      sent: leftResult.sent + rightResult.sent,
      failed: leftResult.failed + rightResult.failed
    };
  }

  if (batch.length === 1) {
    return sendSingleCompactedRow(batch[0], meta);
  }

  console.warn("TS_ANALYSIS_WEBHOOK_BATCH_FAILED:", JSON.stringify({
    status: result.status,
    count: batch.length,
    bytes,
    aborted: result.aborted,
    error: result.error || null,
    response: String(result.text || "").slice(0, 1000)
  }));

  return {
    sent: 0,
    failed: batch.length
  };
}

export async function sendAnalysisActions(actions = [], meta = {}) {
  const rows = Array.isArray(actions)
    ? actions
        .filter(isSendableAnalysisAction)
        .map(action => buildAnalysisRow(action, meta))
    : [];

  const counts = rows.reduce((acc, row) => {
    const key = String(row.eventType || "UNKNOWN").toLowerCase();
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});

  console.log("TS_ANALYSIS_WEBHOOK_ATTEMPT:", JSON.stringify({
    runId: meta.runId || null,
    actions: Array.isArray(actions) ? actions.length : 0,
    analysisRows: rows.length,
    entries: counts.entry || 0,
    exits: counts.exit || 0,
    waits: counts.reject || 0,
    rejects: counts.reject || 0,
    snapshots: counts.snapshot || 0,
    holds: 0,
    urlConfigured: Boolean(ANALYSIS_WEBHOOK_URL),
    secretConfigured: Boolean(ANALYSIS_WEBHOOK_SECRET),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBatchSize: MAX_BATCH_SIZE,
    maxBatchBytes: MAX_BATCH_BYTES,
    maxSingleRowBytes: MAX_SINGLE_ROW_BYTES
  }));

  if (!ANALYSIS_WEBHOOK_URL) {
    return {
      ok: false,
      skipped: true,
      reason: "ANALYSIS_WEBHOOK_URL_MISSING",
      error: "ANALYSIS_WEBHOOK_URL_MISSING",
      total: rows.length,
      sent: 0,
      failed: rows.length,
      counts
    };
  }

  if (!rows.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ANALYSIS_ROWS",
      error: null,
      total: 0,
      sent: 0,
      failed: 0,
      counts
    };
  }

  let sent = 0;
  let failed = 0;

  const batches = chunkRowsByPayloadSize(rows, meta);

  console.log("TS_ANALYSIS_WEBHOOK_BATCH_PLAN:", JSON.stringify({
    runId: meta.runId || null,
    totalRows: rows.length,
    batches: batches.length,
    batchSizes: batches.map(batch => batch.length),
    estimatedBytes: batches.map(batch =>
      jsonByteLength(buildBatchPayload(batch, meta))
    )
  }));

  for (const batch of batches) {
    const result = await sendBatchWithAutoSplit(batch, meta);

    sent += result.sent;
    failed += result.failed;

    await sleep(BETWEEN_BATCH_DELAY_MS);
  }

  console.log("TS_ANALYSIS_WEBHOOK_SUMMARY:", JSON.stringify({
    runId: meta.runId || null,
    total: rows.length,
    sent,
    failed,
    entries: counts.entry || 0,
    exits: counts.exit || 0,
    rejects: counts.reject || 0,
    snapshots: counts.snapshot || 0,
    urlConfigured: Boolean(ANALYSIS_WEBHOOK_URL)
  }));

  return {
    ok: failed === 0,
    skipped: false,
    reason: null,
    error: failed > 0 ? "SOME_ANALYSIS_BATCHES_FAILED" : null,
    total: rows.length,
    sent,
    failed,
    counts
  };
}