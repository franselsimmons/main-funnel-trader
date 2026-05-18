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

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_BATCH_SIZE = 300;

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
    .replace(/USDC$/, "");
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeEventType(action) {
  const a = String(action || "").toUpperCase();

  if (a === "ENTRY") return "ENTRY";
  if (a === "EXIT") return "EXIT";
  if (a === "SNAPSHOT") return "SNAPSHOT";
  if (a === "HOLD") return "SNAPSHOT";

  // WAIT wordt bewust REJECT voor analyse van filterdruk.
  if (a === "WAIT") return "REJECT";
  if (a === "REJECT") return "REJECT";

  return "SNAPSHOT";
}

function isSendableAnalysisAction(action) {
  if (!action || typeof action !== "object") return false;

  const eventType = normalizeEventType(action.action || action.event || action.eventType);

  if (!["ENTRY", "EXIT", "REJECT", "SNAPSHOT"].includes(eventType)) {
    return false;
  }

  if (!action.symbol) return false;
  if (!action.side) return false;

  return true;
}

function buildAnalysisRow(action, meta = {}) {
  const eventType = normalizeEventType(action.action || action.event || action.eventType);
  const symbol = normalizeBaseSymbol(action.symbol);
  const side = String(action.side || "").toLowerCase();

  const entry = safeNumber(action.entry ?? action.price, 0);
  const sl = safeNumber(action.sl ?? action.initialSl, 0);
  const tp = safeNumber(action.tp, 0);

  const isOpenSnapshot =
    eventType === "SNAPSHOT" ||
    action.open === true ||
    String(action.status || "").toUpperCase() === "OPEN";

  return {
    eventType,
    action: eventType,
    source: action.source || "tradesystem",

    runId: action.runId || meta.runId || null,
    tradeId:
      action.tradeId ||
      `${meta.strategyVersion || action.strategyVersion || "TS"}_${symbol}_${side}_${action.createdAt || action.ts || Date.now()}`,

    symbol,
    rawBitgetSymbol: action.rawBitgetSymbol || action.contractSymbol || `${symbol}USDT`,
    side,

    status: isOpenSnapshot ? "OPEN" : eventType,
    open: Boolean(isOpenSnapshot),

    reason:
      action.reason ||
      action.entryReason ||
      action.exitReason ||
      "UNKNOWN",

    entryReason:
      action.entryReason ||
      action.entryType ||
      action.reason ||
      "UNKNOWN",

    exitReason:
      action.exitReason ||
      (eventType === "EXIT" ? action.reason : null),

    setupClass: String(action.setupClass || "UNKNOWN").toUpperCase(),
    grade: action.grade || "N/A",
    gradePoints: safeNumber(action.gradePoints, 0),
    recommendedRisk: action.recommendedRisk || "N/A",

    entry,
    price: safeNumber(action.price ?? entry, entry),
    sl,
    initialSl: safeNumber(action.initialSl ?? sl, sl),
    tp,

    exit: safeNumber(action.exit, 0),
    executionPrice: safeNumber(action.executionPrice, 0),
    triggerPrice: safeNumber(action.triggerPrice, 0),

    rr: safeNumber(action.rr ?? action.plannedRR ?? action.finalRr, 0),
    plannedRR: safeNumber(action.plannedRR ?? action.rr ?? action.finalRr, 0),
    baseRR: safeNumber(action.baseRR, 0),
    finalRr: safeNumber(action.finalRr ?? action.plannedRR ?? action.rr, 0),
    effectiveRR: safeNumber(action.effectiveRR ?? action.finalRr ?? action.rr, 0),
    tpRewardMultiplier: safeNumber(action.tpRewardMultiplier, 1),

    exitR: action.exitR === null || action.exitR === undefined ? null : safeNumber(action.exitR, 0),
    pnlPct: action.pnlPct === null || action.pnlPct === undefined ? null : safeNumber(action.pnlPct, 0),
    triggerR: action.triggerR === null || action.triggerR === undefined ? null : safeNumber(action.triggerR, 0),
    triggerPnlPct: action.triggerPnlPct === null || action.triggerPnlPct === undefined ? null : safeNumber(action.triggerPnlPct, 0),

    currentR: safeNumber(action.currentR, 0),
    mfeR: safeNumber(action.mfeR, 0),
    maeR: safeNumber(action.maeR, 0),
    maxTpProgress: safeNumber(action.maxTpProgress, 0),
    maxSlProgress: safeNumber(action.maxSlProgress, 0),

    reachedHalfR: Boolean(action.reachedHalfR),
    reachedOneR: Boolean(action.reachedOneR),
    nearTpSeen: Boolean(action.nearTpSeen),
    directToSL: Boolean(action.directToSL),
    slAfterHalfR: Boolean(action.slAfterHalfR),
    slAfterOneR: Boolean(action.slAfterOneR),
    slAfterNearTp: Boolean(action.slAfterNearTp),

    breakEvenActivated: Boolean(action.breakEvenActivated),
    breakEvenStop: Boolean(action.breakEvenStop),
    breakEvenSl: action.breakEvenSl ?? null,
    slBeforeBreakEven: action.slBeforeBreakEven ?? null,

    ticksObserved: safeNumber(action.ticksObserved, 0),
    favorableTicks: safeNumber(action.favorableTicks, 0),
    adverseTicks: safeNumber(action.adverseTicks, 0),
    neutralTicks: safeNumber(action.neutralTicks, 0),

    score: safeNumber(action.score ?? action.moveScore, 0),
    moveScore: safeNumber(action.moveScore ?? action.score, 0),

    confluence: safeNumber(action.confluence, 0),
    rawConfluence: safeNumber(action.rawConfluence, 0),
    effectiveConfluence: safeNumber(action.effectiveConfluence ?? action.confluence, 0),

    sniper: action.sniper || "UNKNOWN",
    sniperScore: safeNumber(action.sniperScore, 0),
    rawSniperScore: safeNumber(action.rawSniperScore, 0),
    fallbackSniperScore: safeNumber(action.fallbackSniperScore, 0),

    rsi: safeNumber(action.rsi, 0),
    rsiHTF: safeNumber(action.rsiHTF, 0),
    rsiZone: String(action.rsiZone || "UNKNOWN").toUpperCase(),
    rsiEdge: action.rsiEdge || action.rsiEntryEdge || null,

    obBias: String(action.obBias || "UNKNOWN").toUpperCase(),
    spreadPct: safeNumber(action.spreadPct, 0),
    depthMinUsd1p: safeNumber(action.depthMinUsd1p, 0),

    flow: String(action.flow || "UNKNOWN").toUpperCase(),
    funding: safeNumber(action.funding, 0),
    regime: String(action.regime || meta.regime || "UNKNOWN").toUpperCase(),
    btcState: String(action.btcState || meta.btcState || "UNKNOWN").toUpperCase(),

    stage: String(action.stage || "unknown").toLowerCase(),
    scannerStage: String(action.scannerStage || action.stage || "unknown").toLowerCase(),
    stageSource: action.stageSource || "unknown",

    bullishMidTrendProbe: Boolean(action.bullishMidTrendProbe),
    bullishMidTrendProbeReason: action.bullishMidTrendProbeReason || null,

    btcBullishBearException: Boolean(action.btcBullishBearException),
    btcBullishBearExceptionReason: action.btcBullishBearExceptionReason || null,

    filterDiagnostics: action.filterDiagnostics || null,
    filterValues: action.filterValues || meta.filterValues || null,
    filterChecks: action.filterChecks || null,
    liveFilterMetrics: action.liveFilterMetrics || null,
    specialFilterChecks: action.specialFilterChecks || null,

    analysisType: action.analysisType || "TRADESYSTEM",
    strategyVersion: action.strategyVersion || meta.strategyVersion || "UNKNOWN",

    createdAt: safeNumber(action.createdAt, Date.now()),
    ts: safeNumber(action.ts, Date.now())
  };
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
      headers["authorization"] = `Bearer ${ANALYSIS_WEBHOOK_SECRET}`;
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
      json
    };
  } finally {
    clearTimeout(timeout);
  }
}

function chunkArray(rows, size) {
  const result = [];

  for (let i = 0; i < rows.length; i += size) {
    result.push(rows.slice(i, i + size));
  }

  return result;
}

export async function sendAnalysisActions(actions = [], meta = {}) {
  const rows = Array.isArray(actions)
    ? actions.filter(isSendableAnalysisAction).map(action => buildAnalysisRow(action, meta))
    : [];

  const counts = rows.reduce((acc, row) => {
    acc[row.eventType.toLowerCase()] = Number(acc[row.eventType.toLowerCase()] || 0) + 1;
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
    secretConfigured: Boolean(ANALYSIS_WEBHOOK_SECRET)
  }));

  if (!ANALYSIS_WEBHOOK_URL) {
    return {
      ok: false,
      skipped: true,
      reason: "ANALYSIS_WEBHOOK_URL_MISSING",
      total: rows.length,
      sent: 0,
      failed: rows.length
    };
  }

  if (!rows.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ANALYSIS_ROWS",
      total: 0,
      sent: 0,
      failed: 0
    };
  }

  let sent = 0;
  let failed = 0;

  const batches = chunkArray(rows, MAX_BATCH_SIZE);

  for (const batch of batches) {
    const payload = {
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

    const result = await postJson(ANALYSIS_WEBHOOK_URL, payload);

    if (result.ok) {
      sent += batch.length;

      console.log("TS_ANALYSIS_WEBHOOK_SENT_BATCH:", JSON.stringify({
        status: result.status,
        count: batch.length,
        entries: batch.filter(row => row.eventType === "ENTRY").length,
        exits: batch.filter(row => row.eventType === "EXIT").length,
        rejects: batch.filter(row => row.eventType === "REJECT").length,
        snapshots: batch.filter(row => row.eventType === "SNAPSHOT").length
      }));

      continue;
    }

    failed += batch.length;

    console.warn("TS_ANALYSIS_WEBHOOK_BATCH_FAILED:", JSON.stringify({
      status: result.status,
      count: batch.length,
      response: String(result.text || "").slice(0, 1000)
    }));

    await sleep(250);
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
    url: ANALYSIS_WEBHOOK_URL
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