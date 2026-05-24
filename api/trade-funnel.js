import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";
import { appendAnalyzeEvents } from "../lib/analyze/analyzeStore.js";
import {
  classifyAnalyzeEvent,
  createAnalyzeFamilies,
} from "../lib/analyze/familyEngine.js";

const MAX_RESPONSE_TRADES = readNumberEnv("TRADE_FUNNEL_MAX_RESPONSE_TRADES", 250);
const MAX_TRADE_FUNNEL_INPUT = readNumberEnv("TRADE_FUNNEL_MAX_INPUT", 180);
const MAX_ANALYZE_SYNTHETIC_ENTRIES = readNumberEnv("ANALYZE_SYNTHETIC_ENTRY_MAX", 60);
const ANALYZE_SYNTHETIC_MIN_SCORE = readNumberEnv("ANALYZE_SYNTHETIC_MIN_SCORE", 45);
const ANALYZE_ENTRY_WINDOW_MS = readNumberEnv("ANALYZE_ENTRY_WINDOW_MS", 2 * 60 * 1000);

const ANALYZE_COLLECT_CANDIDATE_ENTRIES = readBooleanEnv(
  "ANALYZE_COLLECT_CANDIDATE_ENTRIES",
  true
);

const LOCK_BUSY_ERROR = "TRADE_SYSTEM_DURABLE_LOCK_BUSY";

const FAMILY_BY_ID = new Map(
  createAnalyzeFamilies().all.map(family => [family.id, family])
);

// ================= ENV HELPERS =================

function readNumberEnv(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = process.env[key];

  if (raw === undefined || raw === null || raw === "") return fallback;

  const v = String(raw).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return fallback;
}

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

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
  const k = key || "UNKNOWN";
  map[k] = Number(map[k] || 0) + 1;
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
  if (s === "buildup") return "buildup";

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
    action?.positionTradeId ||
    action?.positionId ||
    action?.orderId ||
    action?.clientOrderId ||
    action?.id;

  return id ? String(id) : "";
}

// ================= TRADE-FUNNEL GATE =================

const TRADE_FUNNEL_MIN_SCORE = readNumberEnv("TRADE_FUNNEL_ENTRY_MIN_SCORE", 45);
const TRADE_FUNNEL_ALMOST_MIN_SCORE = readNumberEnv("TRADE_FUNNEL_ALMOST_MIN_SCORE", 45);

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

  if (stage === "buildup") {
    return { ok: false, reason: "BUILDUP_NOT_TRADE_FUNNEL" };
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

  const sorted = Array.from(accepted.values()).sort((a, b) => {
    const qDiff =
      safeNumber(b.tradeFunnelQuality, 0) -
      safeNumber(a.tradeFunnelQuality, 0);

    if (qDiff !== 0) return qDiff;

    const stageDiff = stageRank(b.stage) - stageRank(a.stage);
    if (stageDiff !== 0) return stageDiff;

    return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
  });

  const result = sorted.slice(0, MAX_TRADE_FUNNEL_INPUT);

  if (sorted.length > result.length) {
    rejectCounts.CAPPED_INPUT = sorted.length - result.length;
  }

  console.log("TRADE FUNNEL raw:", buckets.length);
  console.log("TRADE FUNNEL accepted before cap:", sorted.length);
  console.log("TRADE FUNNEL accepted after cap:", result.length);
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
    acceptedBeforeCap: sorted.length,
    rejectCounts,
  };
}

// ================= ANALYZE LIFECYCLE FILTER =================

function getActionCandidates(action) {
  return [
    action?.analyzeLifecycle,
    action?.analyzeAction,
    action?.lifecycleAction,
    action?.tradeAction,
    action?.action,
    action?.status,
    action?.state,
    action?.type,
    action?.decision,
    action?.reason,
    action?.exitReason,
  ]
    .map(normalizeText)
    .filter(Boolean);
}

function hasExitFields(action) {
  return (
    action?.closed === true ||
    action?.isClosed === true ||
    action?.exitPrice !== undefined ||
    action?.exit !== undefined ||
    action?.executionPrice !== undefined ||
    action?.closedAt ||
    action?.exitAt ||
    action?.exitTs ||
    action?.realizedR !== undefined ||
    action?.pnlR !== undefined ||
    action?.exitR !== undefined ||
    action?.resultR !== undefined ||
    action?.outcomeR !== undefined ||
    action?.pnlPct !== undefined
  );
}

function hasEntryFields(action) {
  return (
    action?.entry !== undefined ||
    action?.entryPrice !== undefined ||
    action?.openPrice !== undefined ||
    action?.sl !== undefined ||
    action?.tp !== undefined ||
    action?.rr !== undefined ||
    action?.baseRR !== undefined
  );
}

function getLifecycleAction(action) {
  const candidates = getActionCandidates(action);

  for (const value of candidates) {
    if (
      value === "EXIT" ||
      value === "CLOSE" ||
      value === "CLOSED" ||
      value === "TP" ||
      value === "SL" ||
      value === "STOP" ||
      value === "STOP_LOSS" ||
      value === "TAKE_PROFIT" ||
      value.includes("EXIT") ||
      value.includes("CLOSE") ||
      value.includes("TAKE_PROFIT") ||
      value.includes("STOP_LOSS")
    ) {
      return "EXIT";
    }
  }

  if (hasExitFields(action)) return "EXIT";

  for (const value of candidates) {
    if (
      value === "ENTRY" ||
      value === "OPEN" ||
      value === "OPENED" ||
      value === "ENTER" ||
      value === "FILLED" ||
      value === "PLACE_ORDER" ||
      value === "OPEN_LONG" ||
      value === "OPEN_SHORT" ||
      value === "LONG_ENTRY" ||
      value === "SHORT_ENTRY" ||
      value.includes("ENTRY") ||
      value.includes("OPEN_POSITION")
    ) {
      return "ENTRY";
    }
  }

  if (hasEntryFields(action)) return "ENTRY";

  for (const value of candidates) {
    if (
      value === "WAIT" ||
      value === "HOLD" ||
      value === "RUNNING" ||
      value === "NO_TRADE" ||
      value === "SKIP" ||
      value === "IGNORE" ||
      value.includes("WAIT") ||
      value.includes("HOLD") ||
      value.includes("RUNNING") ||
      value.includes("REJECT")
    ) {
      return "";
    }
  }

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

function getEntryTimestamp(action) {
  return normalizeTimestamp(
    action?.openedAt ??
      action?.entryTs ??
      action?.createdAt ??
      action?.ts,
    Date.now()
  );
}

// ================= FAMILY SNAPSHOT =================

function buildAnalyzeFamilySnapshot(event) {
  try {
    const classified = classifyAnalyzeEvent({
      ...event,
      closed: false,
      action: "ENTRY",
      analyzeLifecycle: "ENTRY",
    });

    if (!classified?.familyId) return null;

    const family = FAMILY_BY_ID.get(classified.familyId);

    return {
      familyId: classified.familyId,
      analyzeFamilyId: classified.familyId,
      side: classified.side,
      index: classified.index,
      qualityIndex: classified.qualityIndex,
      marketIndex: classified.marketIndex,
      timingIndex: classified.timingIndex,
      qualityBucket: family?.qualityBucket || null,
      marketBucket: family?.marketBucket || null,
      timingBucket: family?.timingBucket || null,
      definition: family?.definition || null,
      source: classified.source || "CLASSIFIED_FROM_FILTER_SNAPSHOT",
      frozenAt: Date.now(),
    };
  } catch (e) {
    console.error("ANALYZE FAMILY SNAPSHOT ERROR:", e);
    return null;
  }
}

function buildBaseFilterSnapshot(action) {
  return {
    ...safeObject(action?.filterSnapshot),
    ...safeObject(action?.filters),
    ...safeObject(action?.filterValues),
    ...safeObject(action?.analysisFilters),

    setupClass: action?.setupClass,
    grade: action?.grade,

    score: action?.score ?? action?.moveScore ?? action?.tradeScore,
    moveScore: action?.moveScore ?? action?.score ?? action?.tradeScore,
    confluence: action?.confluence,
    sniperScore: action?.sniperScore,

    rr: action?.rr,
    baseRR: action?.baseRR,
    finalRR: action?.finalRr ?? action?.finalRR,
    plannedRR: action?.plannedRR,
    effectiveRR: action?.effectiveRR,

    stage: action?.stage,
    scannerStage: action?.scannerStage,
    stageSource: action?.stageSource,
    flow: action?.flow,

    rsi: action?.rsi,
    rsiHTF: action?.rsiHTF,
    rsiZone: action?.rsiZone,
    tfScore: action?.tfScore,
    tfStrength: action?.tfStrength,
    tfAlignment: action?.tfAlignment,

    obBias: action?.obBias,
    spreadPct: action?.spreadPct,
    spreadBps: action?.spreadBps,
    depthMinUsd1p: action?.depthMinUsd1p,
    depthUsd1p: action?.depthUsd1p,

    btcState: action?.btcState,
    regime: action?.regime,
    market: action?.market,
    fundingRate: action?.fundingRate,
    funding: action?.funding,

    pullbackConfirmed: action?.pullbackConfirmed,
    sweepConfirmed: action?.sweepConfirmed,
    retestConfirmed: action?.retestConfirmed,
    distanceFromLocalHighPct: action?.distanceFromLocalHighPct,
    pullbackFromHighPct: action?.pullbackFromHighPct,

    strategyVersion: action?.strategyVersion,
  };
}

function cleanObject(object) {
  return Object.fromEntries(
    Object.entries(safeObject(object)).filter(([, value]) => {
      return value !== undefined && value !== null && value !== "";
    })
  );
}

function normalizeAnalyzeEvent(action, latest, context = {}, index = 0) {
  const lifecycleAction = getLifecycleAction(action);
  if (!lifecycleAction) return null;

  const tradeId = getTradeId(action);
  if (!tradeId) return null;

  const symbol = String(action.symbol || "").toUpperCase().trim();
  const side = normalizeAnalyzeSide(action.side || action.direction || action.tradeSide);

  if (lifecycleAction === "ENTRY" && (!symbol || !side)) return null;

  const ts = getActionTimestamp(action);
  const openedAt = getEntryTimestamp(action);

  const realizedR = nullableNumber(
    action.realizedR ??
      action.pnlR ??
      action.exitR ??
      action.resultR ??
      action.outcomeR ??
      action.rMultiple ??
      action.r
  );

  const pnlPct = nullableNumber(
    action.pnlPct ??
      action.pnlPercent ??
      action.realizedPnlPct ??
      action.resultPnlPct ??
      action.profitPct
  );

  const base = {
    ...action,

    tradeId,
    symbol,
    side,

    action: lifecycleAction,
    originalAction: action.action || action.status || action.reason || null,
    analyzeLifecycle: lifecycleAction,
    analyzeSource: action.analyzeSource || "api_trade_funnel",
    analyzeTs: ts,
    ts,

    openedAt: lifecycleAction === "ENTRY" ? openedAt : action.openedAt ?? null,
    entryTs: lifecycleAction === "ENTRY" ? openedAt : action.entryTs ?? null,

    closed: lifecycleAction === "EXIT"
      ? true
      : Boolean(action.closed || action.isClosed),

    closedAt: lifecycleAction === "EXIT"
      ? normalizeTimestamp(action.closedAt ?? action.exitAt ?? action.exitTs ?? ts, ts)
      : action.closedAt ?? null,

    exitPrice: lifecycleAction === "EXIT"
      ? nullableNumber(action.exitPrice ?? action.exit ?? action.executionPrice ?? action.price)
      : nullableNumber(action.exitPrice ?? action.exit),

    exit: lifecycleAction === "EXIT"
      ? nullableNumber(action.exit ?? action.exitPrice ?? action.executionPrice ?? action.price)
      : nullableNumber(action.exit),

    realizedR,
    pnlR: realizedR,
    resultR: realizedR,
    outcomeR: realizedR,
    rMultiple: realizedR,
    pnlPct,

    btc: action.btc ?? latest?.btc ?? null,
    btcState: action.btcState ?? latest?.btc?.state ?? null,
    regime: action.regime ?? latest?.regime ?? null,
    market: action.market ?? latest?.market ?? null,

    tradeFunnelUpdatedAt: context.tradeFunnelUpdatedAt || Date.now(),
    latestUpdatedAt: latest?.updatedAt || null,
    sequenceIndex: index,
  };

  const baseSnapshot = cleanObject(buildBaseFilterSnapshot(base));

  if (lifecycleAction === "EXIT") {
    return {
      ...base,
      filterSnapshot: baseSnapshot,
      familyId:
        action.familyId ||
        action.analyzeFamilyId ||
        action.analysisFamilyId ||
        action.filterSnapshot?.familyId ||
        null,
      analyzeFamilyId:
        action.analyzeFamilyId ||
        action.familyId ||
        action.analysisFamilyId ||
        action.filterSnapshot?.familyId ||
        null,
    };
  }

  const existingFamilyId =
    action.familyId ||
    action.analyzeFamilyId ||
    action.analysisFamilyId ||
    baseSnapshot.familyId ||
    baseSnapshot.analyzeFamilyId ||
    null;

  const familySnapshot = existingFamilyId
    ? {
        familyId: String(existingFamilyId).toUpperCase(),
        analyzeFamilyId: String(existingFamilyId).toUpperCase(),
        frozenAt: Date.now(),
        source: "EXISTING_FAMILY_ID",
      }
    : buildAnalyzeFamilySnapshot({
        ...base,
        filterSnapshot: baseSnapshot,
      });

  const familyId = familySnapshot?.familyId || null;

  return {
    ...base,

    familyId,
    analyzeFamilyId: familyId,
    analysisFamilyId: familyId,

    filterSnapshot: cleanObject({
      ...baseSnapshot,
      ...familySnapshot,
      familyId,
      analyzeFamilyId: familyId,
    }),
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

// ================= SYNTHETIC ANALYZE ENTRIES =================
// Doel: als processTrades veel WAIT/HOLD teruggeeft, verzamelen we alsnog
// paper-analyze entries uit de beste scanner/trade-funnel candidates.
// Daardoor groeit de family matrix per scan.

function inferRRFromCandidate(candidate) {
  const direct = nullableNumber(
    candidate.rr ??
      candidate.baseRR ??
      candidate.finalRR ??
      candidate.finalRr ??
      candidate.plannedRR
  );

  if (direct !== null && direct > 0) return direct;

  const score = getCandidateScore(candidate);

  if (score >= 85) return 2.0;
  if (score >= 75) return 1.65;
  if (score >= 65) return 1.35;
  if (score >= 50) return 1.15;

  return 1.0;
}

function buildSyntheticTradeId(candidate, bucket) {
  const symbol = String(candidate.symbol || "").toUpperCase().trim();
  const side = normalizeSide(candidate.side);
  const stage = normalizeStage(candidate.stage) || "unknown";
  const score = Math.round(getCandidateScore(candidate));

  return `COLLECT_${bucket}_${symbol}_${side}_${stage}_${score}`;
}

function buildSyntheticAnalyzeEntry(candidate, latest, context, index) {
  const symbol = String(candidate.symbol || "").toUpperCase().trim();
  const side = normalizeSide(candidate.side);
  const stage = normalizeStage(candidate.stage);

  if (!symbol || !side || !stage) return null;

  const score = getCandidateScore(candidate);
  if (score < ANALYZE_SYNTHETIC_MIN_SCORE) return null;

  const now = context.tradeFunnelUpdatedAt || Date.now();
  const bucket = Math.floor(now / ANALYZE_ENTRY_WINDOW_MS);
  const price = nullableNumber(candidate.entryPrice ?? candidate.entry ?? candidate.price);

  if (price === null || price <= 0) return null;

  const rr = inferRRFromCandidate(candidate);
  const analyzeSide = normalizeAnalyzeSide(side);

  return {
    tradeId: buildSyntheticTradeId(candidate, bucket),

    symbol,
    side,
    tradeSide: analyzeSide,

    action: "ENTRY",
    analyzeLifecycle: "ENTRY",
    analyzeSource: "synthetic_candidate_entry",
    syntheticAnalyzeEntry: true,

    reason: "COLLECT_CANDIDATE_ENTRY",

    entry: price,
    entryPrice: price,
    openPrice: price,

    rr,
    baseRR: rr,
    plannedRR: rr,

    stage,
    scannerStage: stage,
    stageSource: candidate.stageSource || "scanner_filter",
    flow: normalizeFlow(candidate.flow),

    score,
    moveScore: score,
    tradeScore: score,
    confluence: nullableNumber(candidate.confluence) ?? score,
    sniperScore: nullableNumber(candidate.sniperScore) ?? score,

    rsi: nullableNumber(candidate.rsi),
    rsiHTF: nullableNumber(candidate.rsiHTF),
    rsiZone:
      candidate.rsiZone ||
      (side === "bull" ? "RSI_LOWER_OR_MID" : "RSI_UPPER_OR_MID"),

    obBias: candidate.obBias || "NEUTRAL",
    spreadPct: nullableNumber(candidate.spreadPct),
    spreadBps: nullableNumber(candidate.spreadBps),
    depthMinUsd1p: nullableNumber(candidate.depthMinUsd1p ?? candidate.depthUsd1p),

    btcState: latest?.btc?.state,
    btc: latest?.btc || null,
    regime: latest?.regime || null,
    market: latest?.market || null,

    fundingRate: nullableNumber(candidate.fundingRate),
    funding: candidate.funding,

    tfScore: nullableNumber(candidate.tfScore),
    tfStrength: nullableNumber(candidate.tfStrength),
    tfAlignment: candidate.tfAlignment,

    openedAt: now,
    entryTs: now,
    ts: now,
    createdAt: now,

    sequenceIndex: index,
    strategyVersion: candidate.strategyVersion || "collector-v1",

    filterSnapshot: cleanObject({
      setupClass: candidate.setupClass,
      grade: candidate.grade,

      stage,
      scannerStage: stage,
      stageSource: candidate.stageSource || "scanner_filter",
      flow: normalizeFlow(candidate.flow),

      confluence: nullableNumber(candidate.confluence) ?? score,
      sniperScore: nullableNumber(candidate.sniperScore) ?? score,
      score,
      moveScore: score,

      rr,
      baseRR: rr,

      rsi: nullableNumber(candidate.rsi),
      rsiHTF: nullableNumber(candidate.rsiHTF),
      rsiZone:
        candidate.rsiZone ||
        (side === "bull" ? "RSI_LOWER_OR_MID" : "RSI_UPPER_OR_MID"),

      obBias: candidate.obBias || "NEUTRAL",
      spreadPct: nullableNumber(candidate.spreadPct),
      spreadBps: nullableNumber(candidate.spreadBps),
      depthMinUsd1p: nullableNumber(candidate.depthMinUsd1p ?? candidate.depthUsd1p),

      btcState: latest?.btc?.state,
      regime: latest?.regime,

      fundingRate: nullableNumber(candidate.fundingRate),
      funding: candidate.funding,

      tfScore: nullableNumber(candidate.tfScore),
      tfStrength: nullableNumber(candidate.tfStrength),
      tfAlignment: candidate.tfAlignment,

      strategyVersion: candidate.strategyVersion || "collector-v1",
    }),
  };
}

function hasRealEntryForSymbolSide(actions) {
  const out = new Set();

  for (const action of safeArray(actions)) {
    if (getLifecycleAction(action) !== "ENTRY") continue;

    const symbol = String(action.symbol || "").toUpperCase().trim();
    const side = normalizeSide(action.side || action.direction || action.tradeSide);

    if (symbol && side) {
      out.add(`${symbol}_${side}`);
    }
  }

  return out;
}

function createSyntheticCandidateEntries(candidates, latest, context = {}, realActions = []) {
  if (!ANALYZE_COLLECT_CANDIDATE_ENTRIES) return [];

  const realEntryKeys = hasRealEntryForSymbolSide(realActions);
  const out = [];

  for (const candidate of safeArray(candidates)) {
    if (out.length >= MAX_ANALYZE_SYNTHETIC_ENTRIES) break;

    const symbol = String(candidate.symbol || "").toUpperCase().trim();
    const side = normalizeSide(candidate.side);
    const stage = normalizeStage(candidate.stage);
    const score = getCandidateScore(candidate);

    if (!symbol || !side) continue;
    if (realEntryKeys.has(`${symbol}_${side}`)) continue;
    if (stage !== "entry" && stage !== "almost") continue;
    if (score < ANALYZE_SYNTHETIC_MIN_SCORE) continue;

    const synthetic = buildSyntheticAnalyzeEntry(candidate, latest, context, out.length);
    if (!synthetic) continue;

    out.push(synthetic);
  }

  return out;
}

// ================= ANALYZE APPEND =================

async function appendTradesToAnalyzer(trades, latest, context = {}) {
  const actions = safeArray(trades);
  const syntheticEntries = createSyntheticCandidateEntries(
    context.candidates,
    latest,
    context,
    actions
  );

  const analyzeActions = [
    ...actions,
    ...syntheticEntries,
  ];

  if (!analyzeActions.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ACTIONS",
      received: 0,
      accepted: 0,
      acceptedEntries: 0,
      acceptedExits: 0,
      syntheticEntries: 0,
      rejected: 0,
      rejectCounts: {},
    };
  }

  const { events, stats } = buildAnalyzeEvents(analyzeActions, latest, {
    tradeFunnelUpdatedAt: Date.now(),
    ...context,
  });

  if (!events.length) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_ENTRY_OR_EXIT_EVENTS",
      syntheticEntries: syntheticEntries.length,
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

      received: stats.received,
      accepted: stats.accepted,
      acceptedEntries: stats.acceptedEntries,
      acceptedExits: stats.acceptedExits,
      rejected: stats.rejected,
      rejectCounts: stats.rejectCounts,

      syntheticEntries: syntheticEntries.length,
      realActions: actions.length,
      normalizedEvents: events.length,
    };
  } catch (e) {
    console.error("ANALYZE APPEND ERROR:", e);

    return {
      ok: false,
      error: e?.message || "analyze_append_failed",
      syntheticEntries: syntheticEntries.length,
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
    analyzeLifecycle: action.analyzeLifecycle,
    reason: action.reason,
    exitReason: action.exitReason,

    syntheticAnalyzeEntry: Boolean(action.syntheticAnalyzeEntry),

    familyId:
      action.familyId ||
      action.analyzeFamilyId ||
      action.analysisFamilyId ||
      action.filterSnapshot?.familyId ||
      null,

    setupClass: action.setupClass,
    grade: action.grade,

    entry: action.entry,
    entryPrice: action.entryPrice,
    openedAt: action.openedAt,
    entryTs: action.entryTs,

    exit: action.exit,
    exitPrice: action.exitPrice,
    closed: action.closed,
    closedAt: action.closedAt,

    sl: action.sl,
    tp: action.tp,

    rr: action.rr,
    baseRR: action.baseRR,
    finalRr: action.finalRr,
    plannedRR: action.plannedRR,

    realizedR: action.realizedR ?? action.pnlR ?? action.exitR,
    pnlR: action.pnlR ?? action.realizedR ?? action.exitR,
    exitR: action.exitR,
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
    spreadBps: action.spreadBps,
    depthMinUsd1p: action.depthMinUsd1p,
    btcState: action.btcState,
    fundingRate: action.fundingRate,
    funding: action.funding,

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
    tradeFunnelAcceptedBeforeCap: safeNumber(data?.tradeFunnelAcceptedBeforeCap, 0),
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
        analyze: true,
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
        candidates,
      })
    : {
        ok: true,
        skipped: true,
        reason: "STORE_FALSE",
        received: trades.length,
        accepted: 0,
        acceptedEntries: 0,
        acceptedExits: 0,
        syntheticEntries: 0,
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
    tradeFunnelAcceptedBeforeCap: tradeFunnel.acceptedBeforeCap,
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
    const data = await runTradeFunnel({
      notify,
      store,
    });

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