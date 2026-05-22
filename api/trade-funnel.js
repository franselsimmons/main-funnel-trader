import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";
import { recordAnalyzeTrade } from "../lib/analyze/analyzeStore.js";

const MAX_RESPONSE_TRADES = 250;
const MAX_ANALYZE_RECORDS_PER_RUN = 500;
const LOCK_BUSY_ERROR = "TRADE_SYSTEM_DURABLE_LOCK_BUSY";

// ================= GENERIC HELPERS =================
function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return undefined;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }

  return undefined;
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

// ================= NORMALISATIE HELPERS VOOR API-GATE =================
function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["bull", "long", "buy"].includes(s)) return "bull";
  if (["bear", "short", "sell"].includes(s)) return "bear";

  return "";
}

function normalizeAnalysisSide(value) {
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

    const normalized = {
      ...coin,
      symbol,
      side,
      stage,
      scannerStage: stage,
      stageSource: coin.stageSource || "tradefunnel_adapter",
      flow,
      moveScore: score,
      vm: safeNumber(
        coin.vm ??
          coin.volumeMomentum ??
          coin.volMomentum,
        0
      ),
      tfScore: safeNumber(coin.tfScore, 0),
      tfStrength: safeNumber(
        coin.tfStrength,
        Math.abs(safeNumber(coin.tfScore, 0))
      ),
      uiOnly: false,
      tradeFunnelQuality: candidateQualityScore({
        ...coin,
        symbol,
        side,
        stage,
        flow,
        moveScore: score,
        vm: safeNumber(coin.vm ?? coin.volumeMomentum ?? coin.volMomentum, 0),
        tfScore: safeNumber(coin.tfScore, 0),
        tfStrength: safeNumber(
          coin.tfStrength,
          Math.abs(safeNumber(coin.tfScore, 0))
        ),
      }),
    };

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
      .map((c) => `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore)}`)
      .join(", ")
  );

  return {
    candidates: result,
    rawCount: buckets.length,
    rejectCounts,
  };
}

// ================= ANALYZE STORE ADAPTER =================
function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function candidateKey(item) {
  const symbol = String(item?.symbol || "").toUpperCase().trim();
  const side = normalizeAnalysisSide(item?.side);

  if (!symbol || !side) return "";

  return `${symbol}_${side}`;
}

function buildCandidateLookup(candidates) {
  const map = new Map();

  for (const candidate of safeArray(candidates)) {
    const key = candidateKey(candidate);
    if (!key) continue;

    map.set(key, candidate);
  }

  return map;
}

function isNegativeDecision(action) {
  const raw = upper(
    firstValue(
      action?.action,
      action?.decision,
      action?.type,
      action?.status,
      action?.state,
      action?.result,
      action?.outcome,
      action?.reason
    )
  );

  if (!raw) return false;

  return [
    "SKIP",
    "REJECT",
    "WAIT",
    "HOLD",
    "NO_TRADE",
    "NO TRADE",
    "IGNORE",
    "BLOCK",
    "FILTERED",
    "DENY",
    "CANCEL",
  ].some((key) => raw.includes(key));
}

function normalizeAnalyzeStatus(action, fallback = "OPEN") {
  const raw = upper(
    firstValue(
      action?.status,
      action?.state,
      action?.result,
      action?.outcome,
      action?.action,
      action?.decision,
      action?.type
    )
  );

  if (action?.closed === true || action?.isClosed === true) return "CLOSED";
  if (action?.closedAt || action?.exitTime || action?.exitPrice) return "CLOSED";

  if (["TP", "SL", "WIN", "LOSS", "CLOSED", "EXIT", "DONE", "FINISHED"].some((key) => raw.includes(key))) {
    return "CLOSED";
  }

  if (isNegativeDecision(action)) return "SHADOW";

  if (["OPEN", "ENTRY", "ENTER", "LONG", "SHORT", "BUY", "SELL", "LIVE", "ACTIVE"].some((key) => raw.includes(key))) {
    return "OPEN";
  }

  return fallback;
}

function analyzeTradeId(action, candidate, status, now) {
  const explicit = firstValue(
    action?.id,
    action?.tradeId,
    action?.positionId,
    action?.orderId,
    action?.clientOrderId,
    action?.signalId
  );

  if (explicit) return String(explicit);

  const symbol = String(firstValue(action?.symbol, candidate?.symbol, "NA")).toUpperCase();
  const side = normalizeAnalysisSide(firstValue(action?.side, candidate?.side)) || "NA";
  const stage = String(firstValue(action?.stage, candidate?.stage, "NA")).toUpperCase();
  const entry = firstValue(action?.entry, action?.entryPrice, candidate?.entry, "");
  const sl = firstValue(action?.sl, action?.stopLoss, candidate?.sl, "");
  const tp = firstValue(action?.tp, action?.takeProfit, candidate?.tp, "");
  const ts = firstValue(action?.ts, action?.timestamp, action?.createdAt, action?.openedAt, now);

  return `${symbol}_${side}_${status}_${stage}_${entry}_${sl}_${tp}_${ts}`;
}

function analyzeShadowId(candidate, now) {
  const symbol = String(candidate?.symbol || "NA").toUpperCase();
  const side = normalizeAnalysisSide(candidate?.side) || "NA";
  const stage = String(candidate?.stage || "NA").toUpperCase();
  const minuteBucket = Math.floor(now / 60000);

  return `${symbol}_${side}_SHADOW_${stage}_${minuteBucket}`;
}

function normalizeAnalyzeRecordFromAction(action, candidate, latest, result, now) {
  const side = normalizeAnalysisSide(firstValue(action?.side, candidate?.side));
  const symbol = String(firstValue(action?.symbol, candidate?.symbol, "")).toUpperCase().trim();

  if (!symbol || !side) return null;

  const status = normalizeAnalyzeStatus(action, "OPEN");

  return {
    id: analyzeTradeId(action, candidate, status, now),
    source: "trade-funnel",
    sourceType: status === "SHADOW" ? "decision" : "trade_action",

    symbol,
    side,
    status,

    action: action?.action,
    reason: action?.reason,
    setupClass: action?.setupClass,
    grade: action?.grade,
    strategyVersion: firstValue(action?.strategyVersion, result?.strategyVersion),

    entry: firstFinite(action?.entry, action?.entryPrice, candidate?.entry),
    sl: firstFinite(action?.sl, action?.stopLoss, candidate?.sl),
    tp: firstFinite(action?.tp, action?.takeProfit, candidate?.tp),

    rr: firstFinite(
      action?.rr,
      action?.finalRR,
      action?.baseRR,
      action?.riskReward,
      action?.riskRewardRatio,
      candidate?.rr,
      candidate?.riskReward
    ),
    baseRR: firstFinite(action?.baseRR, candidate?.baseRR),
    finalRR: firstFinite(action?.finalRR, candidate?.finalRR),

    confluence: firstFinite(
      action?.confluence,
      action?.confluenceScore,
      action?.conf,
      candidate?.confluence,
      candidate?.confluenceScore,
      candidate?.conf
    ),
    sniper: firstFinite(
      action?.sniper,
      action?.sniperScore,
      action?.entryScore,
      candidate?.sniper,
      candidate?.sniperScore,
      candidate?.entryScore
    ),
    sniperScore: firstFinite(
      action?.sniperScore,
      action?.sniper,
      candidate?.sniperScore,
      candidate?.sniper
    ),
    score: firstFinite(
      action?.score,
      action?.candidateScore,
      action?.moveScore,
      candidate?.moveScore,
      candidate?.score,
      candidate?.tradeScore,
      candidate?.sniperScore
    ),

    rsi: firstFinite(action?.rsi, candidate?.rsi),
    rsiHTF: firstFinite(action?.rsiHTF, candidate?.rsiHTF),
    rsiZone: firstValue(action?.rsiZone, candidate?.rsiZone, candidate?.rsiState),

    flow: firstValue(action?.flow, candidate?.flow),
    stage: firstValue(action?.stage, candidate?.stage),
    scannerStage: candidate?.scannerStage,
    tfAligned: firstValue(
      action?.tfAligned,
      action?.timeframeAligned,
      candidate?.tfAligned,
      candidate?.timeframeAligned
    ),
    tfScore: firstFinite(action?.tfScore, candidate?.tfScore),
    tfStrength: firstFinite(action?.tfStrength, candidate?.tfStrength),

    obBias: firstValue(action?.obBias, candidate?.obBias),
    obRelation: firstValue(
      action?.obRelation,
      action?.orderbookRelation,
      action?.obAlignment,
      candidate?.obRelation,
      candidate?.orderbookRelation,
      candidate?.obAlignment
    ),

    spreadPct: firstFinite(
      action?.spreadPct,
      candidate?.spreadPct,
      candidate?.market?.spreadPct
    ),
    spreadBps: firstFinite(
      action?.spreadBps,
      candidate?.spreadBps,
      candidate?.market?.spreadBps
    ),
    depthUsd1p: firstFinite(
      action?.depthUsd1p,
      action?.depthMinUsd1p,
      action?.minDepthUsd1p,
      candidate?.depthUsd1p,
      candidate?.depthMinUsd1p,
      candidate?.minDepthUsd1p,
      candidate?.market?.depthUsd1p
    ),

    btcState: firstValue(action?.btcState, latest?.btc?.state, latest?.btcState),
    btcRelation: firstValue(action?.btcRelation, action?.btcAlignment, candidate?.btcRelation),
    regime: firstValue(action?.regime, latest?.regime),
    market: latest?.market || null,

    fundingRate: firstFinite(
      action?.fundingRate,
      action?.funding,
      candidate?.fundingRate,
      candidate?.funding
    ),

    r: firstFinite(
      action?.r,
      action?.R,
      action?.realizedR,
      action?.pnlR,
      action?.resultR,
      action?.finalR
    ),
    pnlPct: firstFinite(
      action?.pnlPct,
      action?.pnlPercent,
      action?.realizedPnlPct,
      action?.realizedPnlPercent
    ),

    createdAt: firstValue(
      action?.createdAt,
      action?.openedAt,
      action?.entryTime,
      action?.ts,
      action?.timestamp,
      new Date(now).toISOString()
    ),
    closedAt: firstValue(action?.closedAt, action?.exitTime),

    rawAction: action,
  };
}

function normalizeAnalyzeRecordFromCandidate(candidate, latest, now) {
  const side = normalizeAnalysisSide(candidate?.side);
  const symbol = String(candidate?.symbol || "").toUpperCase().trim();

  if (!symbol || !side) return null;

  return {
    id: analyzeShadowId(candidate, now),
    source: "trade-funnel",
    sourceType: "accepted_candidate",
    symbol,
    side,
    status: "SHADOW",

    action: "SHADOW_CANDIDATE",
    reason: "NO_TRADE_SYSTEM_ACTION",

    stage: candidate?.stage,
    scannerStage: candidate?.scannerStage,
    flow: candidate?.flow,

    rr: firstFinite(candidate?.rr, candidate?.riskReward, candidate?.finalRR, candidate?.baseRR),
    confluence: firstFinite(candidate?.confluence, candidate?.confluenceScore, candidate?.conf),
    sniper: firstFinite(candidate?.sniper, candidate?.sniperScore, candidate?.entryScore),
    sniperScore: firstFinite(candidate?.sniperScore, candidate?.sniper),
    score: firstFinite(candidate?.moveScore, candidate?.score, candidate?.tradeScore, candidate?.sniperScore),

    rsi: firstFinite(candidate?.rsi),
    rsiHTF: firstFinite(candidate?.rsiHTF),
    rsiZone: firstValue(candidate?.rsiZone, candidate?.rsiState),

    tfAligned: firstValue(candidate?.tfAligned, candidate?.timeframeAligned),
    tfScore: firstFinite(candidate?.tfScore),
    tfStrength: firstFinite(candidate?.tfStrength),

    obBias: candidate?.obBias,
    obRelation: firstValue(candidate?.obRelation, candidate?.orderbookRelation, candidate?.obAlignment),

    spreadPct: firstFinite(candidate?.spreadPct, candidate?.market?.spreadPct),
    spreadBps: firstFinite(candidate?.spreadBps, candidate?.market?.spreadBps),
    depthUsd1p: firstFinite(
      candidate?.depthUsd1p,
      candidate?.depthMinUsd1p,
      candidate?.minDepthUsd1p,
      candidate?.market?.depthUsd1p
    ),

    btcState: firstValue(latest?.btc?.state, latest?.btcState),
    btcRelation: candidate?.btcRelation,
    regime: latest?.regime,
    market: latest?.market || null,

    fundingRate: firstFinite(candidate?.fundingRate, candidate?.funding),

    createdAt: new Date(now).toISOString(),
    rawCandidate: candidate,
  };
}

function buildAnalyzeRecords({ actions, candidates, latest, result, now }) {
  const candidateLookup = buildCandidateLookup(candidates);
  const usedCandidateKeys = new Set();
  const records = [];

  for (const action of safeArray(actions)) {
    if (!action || typeof action !== "object") continue;

    const key = candidateKey(action);
    const candidate = candidateLookup.get(key);

    if (key) usedCandidateKeys.add(key);

    const record = normalizeAnalyzeRecordFromAction(
      action,
      candidate,
      latest,
      result,
      now
    );

    if (!record) continue;

    records.push(record);
  }

  for (const candidate of safeArray(candidates)) {
    const key = candidateKey(candidate);
    if (!key) continue;
    if (usedCandidateKeys.has(key)) continue;

    const record = normalizeAnalyzeRecordFromCandidate(candidate, latest, now);
    if (!record) continue;

    records.push(record);
  }

  return records.slice(0, MAX_ANALYZE_RECORDS_PER_RUN);
}

async function recordAnalyzeRecords(records) {
  let recorded = 0;
  const errors = [];

  for (const record of safeArray(records)) {
    try {
      await recordAnalyzeTrade(record);
      recorded += 1;
    } catch (err) {
      errors.push({
        symbol: record?.symbol,
        side: record?.side,
        error: err?.message || "record_failed",
      });
    }
  }

  return {
    attempted: safeArray(records).length,
    recorded,
    errors,
    ok: errors.length === 0,
  };
}

// ================= RESPONSE COMPACTION =================
function compactAction(action) {
  if (!action || typeof action !== "object") return action;

  return {
    symbol: action.symbol,
    side: action.side,
    action: action.action,
    reason: action.reason,
    setupClass: action.setupClass,
    grade: action.grade,
    entry: action.entry,
    sl: action.sl,
    tp: action.tp,
    rr: action.rr,
    baseRR: action.baseRR,
    confluence: action.confluence,
    sniperScore: action.sniperScore,
    rsi: action.rsi,
    rsiHTF: action.rsiHTF,
    rsiZone: action.rsiZone,
    flow: action.flow,
    obBias: action.obBias,
    spreadPct: action.spreadPct,
    depthMinUsd1p: action.depthMinUsd1p,
    btcState: action.btcState,
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

    analyzeRecordsAttempted: safeNumber(data?.analyzeRecordsAttempted, 0),
    analyzeRecordsStored: safeNumber(data?.analyzeRecordsStored, 0),
    analyzeRecordErrors: safeArray(data?.analyzeRecordErrors).slice(0, 10),

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

  const analyzeRecords = buildAnalyzeRecords({
    actions: trades,
    candidates,
    latest,
    result,
    now,
  });

  const analyzeStoreResult = await recordAnalyzeRecords(analyzeRecords);

  const updated = {
    ...latest,
    ok: true,
    trades,
    tradeSystemResult: result,

    tradeFunnelRawCount: tradeFunnel.rawCount,
    tradeFunnelInputCount: candidates.length,
    tradeFunnelRejectCounts: tradeFunnel.rejectCounts,
    tradeFunnelInputSymbols: candidates.map((c) =>
      `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore || 0)}`
    ),

    analyzeRecordsAttempted: analyzeStoreResult.attempted,
    analyzeRecordsStored: analyzeStoreResult.recorded,
    analyzeRecordErrors: analyzeStoreResult.errors,

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