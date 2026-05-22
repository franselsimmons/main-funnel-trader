import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";
import { appendAnalyzeEvents } from "../lib/analyze/analyzeStore.js";
import { buildAnalyzeReport } from "../lib/analyze/familyEngine.js";

const MAX_RESPONSE_TRADES = 250;
const LOCK_BUSY_ERROR = "TRADE_SYSTEM_DURABLE_LOCK_BUSY";

// ================= GENERIC HELPERS =================

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
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

function normalizeNotify(value, fallback = true) {
  return normalizeBoolean(value, fallback);
}

function normalizeStore(value, fallback = true) {
  return normalizeBoolean(value, fallback);
}

function normalizeFullResponse(value, fallback = false) {
  return normalizeBoolean(value, fallback);
}

function incrementCounter(map, key) {
  map[key] = Number(map[key] || 0) + 1;
}

function stageRank(stage) {
  if (stage === "entry") return 2;
  if (stage === "almost") return 1;
  return 0;
}

function flowRank(flow) {
  if (flow === "TREND") return 2;
  if (flow === "BUILDING") return 1;
  return 0;
}

function candidateQualityScore(c) {
  const score = safeNumber(c.moveScore, 0);
  const vm = safeNumber(c.vm, 0);
  const tfStrength = safeNumber(c.tfStrength, Math.abs(safeNumber(c.tfScore, 0)));
  const stage = String(c.stage || "").toLowerCase();
  const flow = String(c.flow || "NEUTRAL").toUpperCase();

  return (
    score +
    stageRank(stage) * 8 +
    flowRank(flow) * 6 +
    Math.min(tfStrength * 4, 10) +
    Math.min(vm * 40, 10)
  );
}

function normalizeText(value) {
  return String(value || "").toUpperCase().trim();
}

function normalizeTimestamp(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

// ================= NORMALISATIE HELPERS VOOR API-GATE =================

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["bull", "long", "buy"].includes(s)) return "bull";
  if (["bear", "short", "sell"].includes(s)) return "bear";

  return "";
}

function normalizeAnalyzeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["bull", "long", "buy"].includes(s)) return "LONG";
  if (["bear", "short", "sell"].includes(s)) return "SHORT";

  return "";
}

function normalizeStage(value) {
  const s = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/^scanner[-_]/, "");

  if (s === "entry") return "entry";
  if (s === "almost") return "almost";

  return "";
}

function normalizeFlow(value) {
  const f = String(value || "NEUTRAL").toUpperCase().trim();

  if (["TREND", "BREAKOUT", "RUNNING"].includes(f)) return "TREND";
  if (["BUILDING", "BUILDUP"].includes(f)) return "BUILDING";

  return "NEUTRAL";
}

function getCandidateScore(coin) {
  return safeNumber(
    coin.moveScore ??
      coin.score ??
      coin.tradeScore ??
      coin.sniperScore,
    0
  );
}

function getTradeId(action) {
  const id =
    action?.tradeId ||
    action?.positionId ||
    action?.orderId ||
    action?.id;

  return id ? String(id) : "";
}

// ================= TRADE-FUNNEL GATE =================

const TRADE_FUNNEL_MIN_SCORE = 45;
const TRADE_FUNNEL_ALMOST_MIN_SCORE = 45;

function passesTradeFunnelGate(coin) {
  const symbol = String(coin.symbol || "").toUpperCase().trim();
  const side = normalizeSide(coin.side);
  const stage = normalizeStage(coin.stage);
  const score = getCandidateScore(coin);

  if (!symbol) return { ok: false, reason: "NO_SYMBOL" };
  if (!side) return { ok: false, reason: "BAD_SIDE" };
  if (Boolean(coin.uiOnly)) return { ok: false, reason: "UI_ONLY" };
  if (!stage) return { ok: false, reason: "BAD_STAGE" };

  if (stage === "entry" && score < TRADE_FUNNEL_MIN_SCORE) {
    return { ok: false, reason: "ENTRY_SCORE_TOO_LOW" };
  }

  if (stage === "almost" && score < TRADE_FUNNEL_ALMOST_MIN_SCORE) {
    return { ok: false, reason: "ALMOST_SCORE_TOO_LOW" };
  }

  return { ok: true, reason: "OK" };
}

// ================= CANDIDATE SELECTOR =================

function getTradeFunnelCandidates(latest) {
  const buckets = [
    ...safeArray(latest?.funnel?.bull?.entry),
    ...safeArray(latest?.funnel?.bear?.entry),
    ...safeArray(latest?.funnel?.bull?.almost),
    ...safeArray(latest?.funnel?.bear?.almost),
  ];

  const accepted = new Map();
  const rejectCounts = {};

  for (const coin of buckets) {
    if (!coin) continue;

    const gate = passesTradeFunnelGate(coin);

    if (!gate.ok) {
      incrementCounter(rejectCounts, gate.reason);
      continue;
    }

    const symbol = String(coin.symbol || "").toUpperCase().trim();
    const side = normalizeSide(coin.side);
    const stage = normalizeStage(coin.stage);
    const flow = normalizeFlow(coin.flow);
    const score = getCandidateScore(coin);

    const vm = safeNumber(
      coin.vm ??
        coin.volumeMomentum ??
        coin.volMomentum,
      0
    );

    const tfScore = safeNumber(coin.tfScore, 0);
    const tfStrength = safeNumber(
      coin.tfStrength,
      Math.abs(tfScore)
    );

    const normalized = {
      ...coin,
      symbol,
      side,
      stage,
      scannerStage: stage,
      stageSource: coin.stageSource || "tradefunnel_adapter",
      flow,
      moveScore: score,
      vm,
      tfScore,
      tfStrength,
      uiOnly: false,
    };

    normalized.tradeFunnelQuality = candidateQualityScore(normalized);

    const key = `${symbol}_${side}`;
    const prev = accepted.get(key);

    if (!prev) {
      accepted.set(key, normalized);
      continue;
    }

    if (candidateQualityScore(normalized) > candidateQualityScore(prev)) {
      accepted.set(key, normalized);
    }
  }

  const result = Array.from(accepted.values()).sort((a, b) => {
    const qDiff =
      safeNumber(b.tradeFunnelQuality, 0) -
      safeNumber(a.tradeFunnelQuality, 0);

    if (qDiff !== 0) return qDiff;

    const stageDiff = stageRank(b.stage) - stageRank(a.stage);
    if (stageDiff !== 0) return stageDiff;

    return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
  });

  console.log("TRADE FUNNEL raw:", buckets.length);
  console.log("TRADE FUNNEL accepted:", result.length);
  console.log("TRADE FUNNEL rejected:", rejectCounts);
  console.log(
    "TRADE FUNNEL symbols:",
    result
      .map(c => `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore)}`)
      .join(", ")
  );

  return {
    candidates: result,
    rawCount: buckets.length,
    rejectCounts,
  };
}

// ================= ANALYZE LIFECYCLE FILTER =================

function getLifecycleAction(action) {
  const text = normalizeText(
    action?.action ||
      action?.status ||
      action?.reason ||
      action?.exitReason ||
      action?.type
  );

  if (!text) return "";

  if (
    text === "WAIT" ||
    text === "HOLD" ||
    text === "RUNNING" ||
    text === "NO_TRADE" ||
    text === "SKIP" ||
    text.includes("WAIT") ||
    text.includes("HOLD") ||
    text.includes("RUNNING")
  ) {
    return "";
  }

  if (
    text === "ENTRY" ||
    text === "OPEN" ||
    text === "ENTER" ||
    text.includes("ENTRY") ||
    text.includes("OPEN_POSITION")
  ) {
    return "ENTRY";
  }

  if (
    text === "EXIT" ||
    text === "CLOSE" ||
    text === "CLOSED" ||
    text.includes("EXIT") ||
    text.includes("CLOSE") ||
    text.includes("TP") ||
    text.includes("SL") ||
    text.includes("STOP") ||
    text.includes("TAKE_PROFIT")
  ) {
    return "EXIT";
  }

  if (action?.closed === true || action?.isClosed === true) return "EXIT";
  if (action?.exitPrice !== undefined && action?.exitPrice !== null) return "EXIT";
  if (action?.closedAt || action?.exitAt || action?.exitTs) return "EXIT";

  return "";
}

function getActionTimestamp(action) {
  return normalizeTimestamp(
    action?.closedAt ??
      action?.exitAt ??
      action?.exitTs ??
      action?.updatedAt ??
      action?.createdAt ??
      action?.openedAt ??
      action?.entryTs ??
      action?.ts,
    Date.now()
  );
}

function buildAnalyzeFamilySnapshot(event) {
  try {
    const report = buildAnalyzeReport([event], {
      minClosed: 1,
      familyCountLong: 50,
      familyCountShort: 50,
    });

    const family = safeArray(report?.families?.all).find(f => safeNumber(f.observed, 0) > 0);

    if (!family) return null;

    return {
      familyId: family.id,
      side: family.side,
      index: family.index,
      qualityIndex: family.qualityIndex,
      marketIndex: family.marketIndex,
      timingIndex: family.timingIndex,
      qualityBucket: family.qualityBucket,
      marketBucket: family.marketBucket,
      timingBucket: family.timingBucket,
      definition: family.definition,
      frozenAt: Date.now(),
    };
  } catch (e) {
    console.error("ANALYZE FAMILY SNAPSHOT ERROR:", e);
    return null;
  }
}

function normalizeAnalyzeEvent(action, latest, context = {}, index = 0) {
  const lifecycleAction = getLifecycleAction(action);
  if (!lifecycleAction) return null;

  const tradeId = getTradeId(action);
  if (!tradeId) return null;

  const symbol = String(action.symbol || "").toUpperCase().trim();
  const side = normalizeAnalyzeSide(action.side || action.direction || action.tradeSide);

  if (!symbol || !side) return null;

  const ts = getActionTimestamp(action);

  const base = {
    ...action,

    tradeId,
    symbol,
    side,

    action: lifecycleAction,
    originalAction: action.action || action.status || action.reason || null,
    analyzeLifecycle: lifecycleAction,
    analyzeSource: "api_trade_funnel",
    analyzeTs: ts,
    ts,

    closed: lifecycleAction === "EXIT"
      ? true
      : Boolean(action.closed || action.isClosed),

    btc: action.btc ?? latest?.btc ?? null,
    regime: action.regime ?? latest?.regime ?? null,
    market: action.market ?? latest?.market ?? null,

    tradeFunnelUpdatedAt: context.tradeFunnelUpdatedAt || Date.now(),
    latestUpdatedAt: latest?.updatedAt || null,
    sequenceIndex: index,
  };

  const snapshot =
    safeObject(action.filterSnapshot).familyId
      ? safeObject(action.filterSnapshot)
      : buildAnalyzeFamilySnapshot(base);

  return {
    ...base,

    familyId:
      action.familyId ||
      action.analyzeFamilyId ||
      snapshot?.familyId ||
      null,

    analyzeFamilyId:
      action.analyzeFamilyId ||
      action.familyId ||
      snapshot?.familyId ||
      null,

    filterSnapshot: snapshot || action.filterSnapshot || null,
  };
}

function buildAnalyzeEvents(actions, latest, context = {}) {
  const received = safeArray(actions);
  const events = [];
  const rejectCounts = {};

  received.forEach((action, index) => {
    if (!action || typeof action !== "object") {
      incrementCounter(rejectCounts, "BAD_ACTION");
      return;
    }

    const lifecycleAction = getLifecycleAction(action);

    if (!lifecycleAction) {
      incrementCounter(rejectCounts, "NOT_ENTRY_OR_EXIT");
      return;
    }

    if (!getTradeId(action)) {
      incrementCounter(rejectCounts, "NO_TRADE_ID");
      return;
    }

    const normalized = normalizeAnalyzeEvent(action, latest, context, index);

    if (!normalized) {
      incrementCounter(rejectCounts, "NORMALIZE_FAILED");
      return;
    }

    events.push(normalized);
  });

  return {
    events,
    stats: {
      received: received.length,
      accepted: events.length,
      acceptedEntries: events.filter(e => e.action === "ENTRY").length,
      acceptedExits: events.filter(e => e.action === "EXIT").length,
      rejected: received.length - events.length,
      rejectCounts,
    },
  };
}

// ================= ANALYZE APPEND =================

async function appendTradesToAnalyzer(trades, latest, context = {}) {
  const actions = safeArray(trades);

  if (!actions.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ACTIONS",
      received: 0,
      accepted: 0,
      acceptedEntries: 0,
      acceptedExits: 0,
      rejected: 0,
      rejectCounts: {},
    };
  }

  const { events, stats } = buildAnalyzeEvents(actions, latest, {
    tradeFunnelUpdatedAt: Date.now(),
    ...context,
  });

  if (!events.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ENTRY_OR_EXIT_EVENTS",
      ...stats,
    };
  }

  try {
    const result = await appendAnalyzeEvents(events, {
      source: "api_trade_funnel",
      tradeFunnelUpdatedAt: Date.now(),
      latestUpdatedAt: latest?.updatedAt || null,
      btc: latest?.btc || null,
      regime: latest?.regime || null,
      market: latest?.market || null,
      ...context,
    });

    return {
      ...result,
      ...stats,
    };
  } catch (e) {
    console.error("ANALYZE APPEND ERROR:", e);

    return {
      ok: false,
      error: e?.message || "analyze_append_failed",
      ...stats,
    };
  }
}

// ================= RESPONSE COMPACTION =================

function compactAction(action) {
  if (!action || typeof action !== "object") return action;

  return {
    tradeId: action.tradeId,
    symbol: action.symbol,
    side: action.side,
    action: action.action,
    reason: action.reason,
    exitReason: action.exitReason,

    familyId: action.familyId || action.analyzeFamilyId || action.filterSnapshot?.familyId || null,

    setupClass: action.setupClass,
    grade: action.grade,

    entry: action.entry,
    exit: action.exit,
    exitPrice: action.exitPrice,
    sl: action.sl,
    tp: action.tp,

    rr: action.rr,
    baseRR: action.baseRR,
    realizedR: action.realizedR,
    pnlR: action.pnlR,
    pnlPct: action.pnlPct,

    confluence: action.confluence,
    sniperScore: action.sniperScore,
    moveScore: action.moveScore,
    score: action.score,

    rsi: action.rsi,
    rsiHTF: action.rsiHTF,
    rsiZone: action.rsiZone,

    stage: action.stage,
    scannerStage: action.scannerStage,
    flow: action.flow,

    obBias: action.obBias,
    spreadPct: action.spreadPct,
    depthMinUsd1p: action.depthMinUsd1p,
    btcState: action.btcState,
    fundingRate: action.fundingRate,

    regime: action.regime,
    strategyVersion: action.strategyVersion,
    ts: action.ts,
  };
}

function compactResponse(data) {
  const actions = Array.isArray(data?.tradeSystemResult?.actions)
    ? data.tradeSystemResult.actions
    : safeArray(data?.trades);

  return {
    ok: Boolean(data?.ok),
    updatedAt: data?.updatedAt || Date.now(),
    tradeFunnelUpdatedAt: data?.tradeFunnelUpdatedAt || null,

    btc: data?.btc || null,
    regime: data?.regime || null,
    market: data?.market || null,

    tradeFunnelRawCount: safeNumber(data?.tradeFunnelRawCount, 0),
    tradeFunnelRejectCounts: data?.tradeFunnelRejectCounts || {},
    tradeFunnelInputCount: safeNumber(data?.tradeFunnelInputCount, 0),
    tradeFunnelInputSymbols: safeArray(data?.tradeFunnelInputSymbols).slice(0, 250),

    analyzeAppendResult: data?.analyzeAppendResult || null,

    trades: actions.slice(0, MAX_RESPONSE_TRADES).map(compactAction),

    tradeSystemResult: {
      candidatesCount: safeNumber(data?.tradeSystemResult?.candidatesCount, 0),
      strategyVersion: data?.tradeSystemResult?.strategyVersion || null,
      durableEnabled: Boolean(data?.tradeSystemResult?.durableEnabled),
      actions: actions.slice(0, MAX_RESPONSE_TRADES).map(compactAction),
    },
  };
}

// ================= CORE =================

export async function runTradeFunnel(options = {}) {
  const notify = options.notify !== false;
  const store = options.store !== false;

  const latest = await getLatestScan();

  if (!latest?.ok) {
    throw new Error("no_latest_scan_available");
  }

  const tradeFunnel = getTradeFunnelCandidates(latest);
  const candidates = tradeFunnel.candidates;
  const now = Date.now();

  const result = candidates.length
    ? await processTrades(candidates, {
        notify,
        log: true,
        btc: latest.btc,
        regime: latest.regime,
        market: latest.market,
      })
    : { actions: [], candidatesCount: 0 };

  const trades = Array.isArray(result)
    ? result
    : Array.isArray(result?.actions)
      ? result.actions
      : [];

  const analyzeAppendResult = store
    ? await appendTradesToAnalyzer(trades, latest, {
        notify,
        store,
      })
    : {
        ok: true,
        skipped: true,
        reason: "STORE_FALSE",
        received: trades.length,
        accepted: 0,
        acceptedEntries: 0,
        acceptedExits: 0,
        rejected: trades.length,
        rejectCounts: {
          STORE_FALSE: trades.length,
        },
      };

  const updated = {
    ...latest,
    ok: true,
    trades,
    tradeSystemResult: result,
    analyzeAppendResult,

    tradeFunnelRawCount: tradeFunnel.rawCount,
    tradeFunnelInputCount: candidates.length,
    tradeFunnelRejectCounts: tradeFunnel.rejectCounts,
    tradeFunnelInputSymbols: candidates.map(c =>
      `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore || 0)}`
    ),

    tradeFunnelUpdatedAt: now,
    updatedAt: now,
  };

  if (store) {
    await setLatestScan(updated);
  }

  return updated;
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const notify = normalizeNotify(req?.query?.notify, true);
  const store = normalizeStore(req?.query?.store, true);
  const full = normalizeFullResponse(req?.query?.full, false);

  try {
    const data = await runTradeFunnel({ notify, store });

    return res.status(200).json(full ? data : compactResponse(data));
  } catch (e) {
    const message = e?.message || "unknown_error";

    if (message === LOCK_BUSY_ERROR) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        busy: true,
        reason: LOCK_BUSY_ERROR,
        note: "Another trade-funnel run is still active. This tick was skipped.",
        notify,
        store,
        ts: Date.now(),
      });
    }

    console.error("TRADE-FUNNEL ERROR:", e);

    return res.status(500).json({
      ok: false,
      error: message,
      notify,
      store,
      ts: Date.now(),
    });
  }
}