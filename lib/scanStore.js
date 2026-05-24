// ================= SCAN STORE =================

const STORE_KEY = "tradeSystem:latestScan:v1";
const STAGE_MEMORY_KEY = "tradeSystem:stageMemory:v1";

const globalStore = globalThis.__TRADE_SYSTEM_SCAN_STORE__ || {
  latestScan: null,
  stageMemory: {},
  lastRedisReadAt: 0,
  lastStageMemoryReadAt: 0
};

globalThis.__TRADE_SYSTEM_SCAN_STORE__ = globalStore;

// ================= CONFIG =================

const MEMORY_CACHE_TTL_MS = 15 * 1000;

// Upstash max request size is 10MB.
// Omdat REST command JSON het payload-string opnieuw escaped,
// sturen we bewust ruim onder die grens.
const REDIS_MAX_BODY_BYTES = 8_500_000;

const MAX_ENTRY_COINS = 120;
const MAX_ALMOST_COINS = 120;
const MAX_BUILDUP_COINS = 40;
const MAX_RADAR_COINS = 20;

const MAX_LATEST_TRADES = 100;
const MAX_TRADE_ACTIONS = 100;
const MAX_DASHBOARD_ROWS = 40;
const MAX_INPUT_SYMBOLS = 250;

// ================= KV / UPSTASH CONFIG =================

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

// ================= SAFE JSON =================

function safeJsonParse(value, fallback = null) {
  if (value === undefined || value === null) return fallback;

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value) {
  const seen = new WeakSet();

  return JSON.stringify(value, (key, val) => {
    if (typeof val === "bigint") return Number(val);

    if (val && typeof val === "object") {
      if (seen.has(val)) return undefined;
      seen.add(val);
    }

    return val;
  });
}

function byteLength(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function redisCommandBodyBytes(command) {
  return byteLength(safeJsonStringify(command));
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return isPlainObject(value) ? value : {};
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLatestScan(data) {
  if (!isPlainObject(data)) return null;
  if (!data.ok) return null;

  return {
    ...data,
    restoredAt: Date.now()
  };
}

function normalizeStageMemory(memory) {
  if (!isPlainObject(memory)) return {};

  const out = {};

  for (const [key, value] of Object.entries(memory)) {
    if (!key || !isPlainObject(value)) continue;

    out[key] = {
      stage: typeof value.stage === "string" ? value.stage : "radar",
      prevStage: typeof value.prevStage === "string" ? value.prevStage : "radar",
      updatedAt: Number(value.updatedAt || value.ts || Date.now())
    };
  }

  return out;
}

// ================= COUNT HELPERS =================

function countStage(stage) {
  return safeArray(stage).length;
}

function countSide(funnel, side) {
  const bucket = funnel?.[side];

  if (!bucket) return 0;

  return (
    countStage(bucket.entry) +
    countStage(bucket.almost) +
    countStage(bucket.buildup) +
    countStage(bucket.radar)
  );
}

function countFunnel(funnel) {
  return countSide(funnel, "bull") + countSide(funnel, "bear");
}

// ================= PAYLOAD COMPACTION =================

function compactOb(ob) {
  if (!isPlainObject(ob)) return ob;

  return {
    spread: ob.spread,
    spreadPct: ob.spreadPct,
    spreadBps: ob.spreadBps,
    depth: ob.depth,
    depthUsd: ob.depthUsd,
    depthMinUsd1p: ob.depthMinUsd1p,
    imbalance: ob.imbalance,
    bias: ob.bias,
    bids: Array.isArray(ob.bids) ? ob.bids.slice(0, 10) : undefined,
    asks: Array.isArray(ob.asks) ? ob.asks.slice(0, 10) : undefined
  };
}

function compactTfContext(ctx) {
  if (!isPlainObject(ctx)) return undefined;

  return {
    score: ctx.score,
    alignment: ctx.alignment,
    trend: ctx.trend,
    strength: ctx.strength,
    state: ctx.state,
    reason: ctx.reason
  };
}

function compactMarket(market) {
  if (!isPlainObject(market)) return market || null;

  return {
    state: market.state,
    trend: market.trend,
    regime: market.regime,
    bias: market.bias,
    score: market.score,
    breadth: market.breadth,
    volatility: market.volatility,
    updatedAt: market.updatedAt
  };
}

function compactCoin(coin) {
  if (!isPlainObject(coin)) return coin;

  return {
    symbol: coin.symbol,
    name: coin.name,
    price: coin.price,

    side: coin.side,
    stage: coin.stage,
    scannerStage: coin.scannerStage,
    stageSource: coin.stageSource,
    scannerQuality: coin.scannerQuality,
    uiOnly: Boolean(coin.uiOnly),

    flow: coin.flow,
    freshness: coin.freshness,
    moveScore: coin.moveScore,
    score: coin.score,
    tradeScore: coin.tradeScore,
    edge: coin.edge,

    change24: coin.change24,
    change1h: coin.change1h,
    volume: coin.volume,
    marketCap: coin.marketCap,
    vm: coin.vm,

    symbolTradable: coin.symbolTradable,
    bitgetSymbol: coin.bitgetSymbol,
    productType: coin.productType,
    rawBitgetSymbol: coin.rawBitgetSymbol,

    tfScore: coin.tfScore,
    tfStrength: coin.tfStrength,
    tfAlignment: coin.tfAlignment,
    tfContext: compactTfContext(coin.tfContext),

    ob: compactOb(coin.ob),

    rsi: coin.rsi,
    rsiHTF: coin.rsiHTF,
    rsiZone: coin.rsiZone,

    obBias: coin.obBias,
    spreadPct: coin.spreadPct,
    spreadBps: coin.spreadBps,
    depthMinUsd1p: coin.depthMinUsd1p,
    depthUsd1p: coin.depthUsd1p,

    btcState: coin.btcState,
    fundingRate: coin.fundingRate,
    funding: coin.funding,

    confluence: coin.confluence,
    sniperScore: coin.sniperScore,

    rr: coin.rr,
    baseRR: coin.baseRR,
    finalRr: coin.finalRr,
    finalRR: coin.finalRR,
    plannedRR: coin.plannedRR,
    effectiveRR: coin.effectiveRR,

    tradeFunnelQuality: coin.tradeFunnelQuality,
    strategyVersion: coin.strategyVersion,

    ts: coin.ts,
    updatedAt: coin.updatedAt
  };
}

function compactStage(coins, max) {
  return safeArray(coins)
    .slice(0, max)
    .map(compactCoin);
}

function compactFunnel(funnel, limits = {}) {
  const entryMax = limits.entry ?? MAX_ENTRY_COINS;
  const almostMax = limits.almost ?? MAX_ALMOST_COINS;
  const buildupMax = limits.buildup ?? MAX_BUILDUP_COINS;
  const radarMax = limits.radar ?? MAX_RADAR_COINS;

  return {
    bull: {
      entry: compactStage(funnel?.bull?.entry, entryMax),
      almost: compactStage(funnel?.bull?.almost, almostMax),
      buildup: compactStage(funnel?.bull?.buildup, buildupMax),
      radar: compactStage(funnel?.bull?.radar, radarMax)
    },
    bear: {
      entry: compactStage(funnel?.bear?.entry, entryMax),
      almost: compactStage(funnel?.bear?.almost, almostMax),
      buildup: compactStage(funnel?.bear?.buildup, buildupMax),
      radar: compactStage(funnel?.bear?.radar, radarMax)
    }
  };
}

function getFamilyIdFromAction(action) {
  return (
    action?.familyId ||
    action?.analyzeFamilyId ||
    action?.analysisFamilyId ||
    action?.filterSnapshot?.familyId ||
    action?.filterSnapshot?.analyzeFamilyId ||
    null
  );
}

function compactFilterSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return undefined;

  return {
    familyId: snapshot.familyId,
    analyzeFamilyId: snapshot.analyzeFamilyId,
    side: snapshot.side,
    index: snapshot.index,

    qualityIndex: snapshot.qualityIndex,
    marketIndex: snapshot.marketIndex,
    timingIndex: snapshot.timingIndex,

    qualityBucket: snapshot.qualityBucket,
    marketBucket: snapshot.marketBucket,
    timingBucket: snapshot.timingBucket,

    definition: snapshot.definition,
    source: snapshot.source,
    frozenAt: snapshot.frozenAt,

    stage: snapshot.stage,
    scannerStage: snapshot.scannerStage,
    stageSource: snapshot.stageSource,
    flow: snapshot.flow,

    confluence: snapshot.confluence,
    sniperScore: snapshot.sniperScore,
    score: snapshot.score,
    moveScore: snapshot.moveScore,

    rr: snapshot.rr,
    baseRR: snapshot.baseRR,
    finalRR: snapshot.finalRR,
    plannedRR: snapshot.plannedRR,
    effectiveRR: snapshot.effectiveRR,

    rsi: snapshot.rsi,
    rsiHTF: snapshot.rsiHTF,
    rsiZone: snapshot.rsiZone,

    tfScore: snapshot.tfScore,
    tfStrength: snapshot.tfStrength,
    tfAlignment: snapshot.tfAlignment,

    obBias: snapshot.obBias,
    spreadPct: snapshot.spreadPct,
    spreadBps: snapshot.spreadBps,
    depthMinUsd1p: snapshot.depthMinUsd1p,

    btcState: snapshot.btcState,
    regime: snapshot.regime,
    fundingRate: snapshot.fundingRate,
    funding: snapshot.funding,

    strategyVersion: snapshot.strategyVersion
  };
}

function compactAction(action) {
  if (!isPlainObject(action)) return action;

  const familyId = getFamilyIdFromAction(action);

  return {
    tradeId:
      action.tradeId ||
      action.positionTradeId ||
      action.positionId ||
      action.orderId ||
      action.clientOrderId ||
      action.id,

    symbol: action.symbol,
    side: action.side,
    direction: action.direction,
    tradeSide: action.tradeSide,

    action: action.action,
    status: action.status,
    state: action.state,
    type: action.type,
    reason: action.reason,
    exitReason: action.exitReason,
    originalAction: action.originalAction,

    analyzeLifecycle: action.analyzeLifecycle,
    analyzeAction: action.analyzeAction,
    lifecycleAction: action.lifecycleAction,
    analyzeSource: action.analyzeSource,
    analyzeTs: action.analyzeTs,

    familyId,
    analyzeFamilyId: familyId,
    analysisFamilyId: familyId,

    filterSnapshot: compactFilterSnapshot(action.filterSnapshot),

    setupClass: action.setupClass,
    grade: action.grade,

    entry: action.entry,
    entryPrice: action.entryPrice,
    openPrice: action.openPrice,
    openedAt: action.openedAt,
    entryTs: action.entryTs,
    createdAt: action.createdAt,

    exit: action.exit,
    exitPrice: action.exitPrice,
    executionPrice: action.executionPrice,
    closed: action.closed,
    isClosed: action.isClosed,
    closedAt: action.closedAt,
    exitAt: action.exitAt,
    exitTs: action.exitTs,

    sl: action.sl,
    tp: action.tp,

    rr: action.rr,
    baseRR: action.baseRR,
    finalRr: action.finalRr,
    finalRR: action.finalRR,
    plannedRR: action.plannedRR,
    effectiveRR: action.effectiveRR,

    realizedR:
      action.realizedR ??
      action.pnlR ??
      action.exitR ??
      action.resultR ??
      action.outcomeR ??
      action.rMultiple,

    pnlR:
      action.pnlR ??
      action.realizedR ??
      action.exitR ??
      action.resultR ??
      action.outcomeR,

    exitR: action.exitR,
    resultR: action.resultR,
    outcomeR: action.outcomeR,
    rMultiple: action.rMultiple,

    pnlPct:
      action.pnlPct ??
      action.pnlPercent ??
      action.realizedPnlPct ??
      action.resultPnlPct ??
      action.profitPct,

    confluence: action.confluence,
    sniperScore: action.sniperScore,
    moveScore: action.moveScore,
    score: action.score,
    tradeScore: action.tradeScore,

    rsi: action.rsi,
    rsiHTF: action.rsiHTF,
    rsiZone: action.rsiZone,

    stage: action.stage,
    scannerStage: action.scannerStage,
    stageSource: action.stageSource,
    flow: action.flow,

    obBias: action.obBias,
    spreadPct: action.spreadPct,
    spreadBps: action.spreadBps,
    depthMinUsd1p: action.depthMinUsd1p,
    depthUsd1p: action.depthUsd1p,

    btcState: action.btcState,
    btc: action.btc,

    fundingRate: action.fundingRate,
    funding: action.funding,

    regime: action.regime,
    market: compactMarket(action.market),

    strategyVersion: action.strategyVersion,

    tradeFunnelUpdatedAt: action.tradeFunnelUpdatedAt,
    latestUpdatedAt: action.latestUpdatedAt,
    sequenceIndex: action.sequenceIndex,

    ts: action.ts,
    updatedAt: action.updatedAt
  };
}

function compactDashboardStats(stats, rowMax = MAX_DASHBOARD_ROWS) {
  const s = safeObject(stats);

  return {
    startedAt: s.startedAt,
    lastResetAt: s.lastResetAt,
    lastScanAt: s.lastScanAt,

    totalScans: safeNumber(s.totalScans, 0),
    totalEntries: safeNumber(s.totalEntries, 0),
    totalRejected: safeNumber(s.totalRejected, 0),
    totalOtherTrades: safeNumber(s.totalOtherTrades, 0),
    totalFunnelCoins: safeNumber(s.totalFunnelCoins, 0),
    totalCandidates: safeNumber(s.totalCandidates, 0),

    lastEntries: safeNumber(s.lastEntries, 0),
    lastRejected: safeNumber(s.lastRejected, 0),
    lastOtherTrades: safeNumber(s.lastOtherTrades, 0),
    lastFunnelCoins: safeNumber(s.lastFunnelCoins, 0),
    lastCandidates: safeNumber(s.lastCandidates, 0),

    rejectReasonCounts: safeObject(s.rejectReasonCounts),
    actionCounts: safeObject(s.actionCounts),

    entryRows: safeArray(s.entryRows).slice(-rowMax).map(compactCoin),
    rejectedRows: safeArray(s.rejectedRows).slice(-rowMax).map(compactCoin),
    tradeRows: safeArray(s.tradeRows).slice(-rowMax).map(compactAction)
  };
}

function compactTradeSystemResult(result, maxActions = MAX_TRADE_ACTIONS) {
  if (!isPlainObject(result)) return result || null;

  return {
    ok: result.ok,
    skipped: result.skipped,
    busy: result.busy,
    reason: result.reason,
    note: result.note,

    candidatesCount: safeNumber(result.candidatesCount, 0),
    strategyVersion: result.strategyVersion || null,
    durableEnabled: Boolean(result.durableEnabled),

    actions: safeArray(result.actions)
      .slice(-maxActions)
      .map(compactAction)
  };
}

function compactAnalyzeAppendResult(result) {
  if (!isPlainObject(result)) return result || null;

  return {
    ok: Boolean(result.ok),
    skipped: Boolean(result.skipped),
    reason: result.reason || null,
    error: result.error || null,

    received: safeNumber(result.received, 0),
    accepted: safeNumber(result.accepted, 0),
    acceptedEntries: safeNumber(result.acceptedEntries, 0),
    acceptedExits: safeNumber(result.acceptedExits, 0),
    rejected: safeNumber(result.rejected, 0),

    appended: safeNumber(result.appended ?? result.written ?? result.saved, 0),
    duplicates: safeNumber(result.duplicates ?? result.skippedDuplicates, 0),

    rejectCounts: safeObject(result.rejectCounts)
  };
}

function compactTradeSystemAnalysis(analysis) {
  if (!isPlainObject(analysis)) return null;

  // Grote family-matrix hoort niet in latestScan.
  // Analyzer kan zijn volledige matrix uit analyzeStore bouwen.
  return {
    dataState: analysis.dataState || analysis.state || null,
    status: analysis.status || null,

    updatedAt: analysis.updatedAt || analysis.generatedAt || null,
    latencyMs: analysis.latencyMs || analysis.latency || null,

    actions: safeNumber(analysis.actions, 0),
    trades: safeNumber(analysis.trades, 0),
    open: safeNumber(analysis.open, 0),
    closed: safeNumber(analysis.closed, 0),
    pendingOutcome: safeNumber(analysis.pendingOutcome, 0),

    wins: safeNumber(analysis.wins, 0),
    losses: safeNumber(analysis.losses, 0),
    breakeven: safeNumber(analysis.breakeven, 0),

    winrate: analysis.winrate || null,
    totalR: safeNumber(analysis.totalR, 0),
    avgR: safeNumber(analysis.avgR, 0),
    totalPnlPct: safeNumber(analysis.totalPnlPct, 0),
    avgPnlPct: safeNumber(analysis.avgPnlPct, 0),

    longFamilies: safeNumber(analysis.longFamilies, 0),
    shortFamilies: safeNumber(analysis.shortFamilies, 0),
    winners: safeNumber(analysis.winners, 0)
  };
}

function compactLatestScan(data, limits = {}) {
  const source = safeObject(data);

  const funnel = compactFunnel(source.funnel, {
    entry: limits.entry ?? MAX_ENTRY_COINS,
    almost: limits.almost ?? MAX_ALMOST_COINS,
    buildup: limits.buildup ?? MAX_BUILDUP_COINS,
    radar: limits.radar ?? MAX_RADAR_COINS
  });

  return {
    ok: Boolean(source.ok),

    scanSide: source.scanSide,
    scanMode: source.scanMode,
    lastSideScan: source.lastSideScan,

    notify: source.notify,
    store: source.store,

    btc: source.btc || null,
    regime: source.regime || null,
    market: compactMarket(source.market),

    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),

    analytics: source.analytics || null,
    advice: source.advice || null,

    total: safeNumber(source.total, 0),

    candidates: safeNumber(source.candidates, 0),
    candidatesBull: safeNumber(source.candidatesBull, 0),
    candidatesBear: safeNumber(source.candidatesBear, 0),

    bitgetSymbols: safeNumber(source.bitgetSymbols, 0),
    bitgetUniverseReady: Boolean(source.bitgetUniverseReady),

    stale: Boolean(source.stale),
    staleReason: source.staleReason || null,

    trades: safeArray(source.trades)
      .slice(-(limits.trades ?? MAX_LATEST_TRADES))
      .map(compactAction),

    tradeSystemResult: compactTradeSystemResult(
      source.tradeSystemResult,
      limits.actions ?? MAX_TRADE_ACTIONS
    ),

    analyzeAppendResult: compactAnalyzeAppendResult(source.analyzeAppendResult),
    tradeSystemAnalysis: compactTradeSystemAnalysis(source.tradeSystemAnalysis),

    dashboardStats: compactDashboardStats(
      source.dashboardStats,
      limits.dashboardRows ?? MAX_DASHBOARD_ROWS
    ),

    tradeFunnelRawCount: safeNumber(source.tradeFunnelRawCount, 0),
    tradeFunnelInputCount: safeNumber(source.tradeFunnelInputCount, 0),
    tradeFunnelRejectCounts: safeObject(source.tradeFunnelRejectCounts),
    tradeFunnelInputSymbols: safeArray(source.tradeFunnelInputSymbols).slice(
      0,
      limits.inputSymbols ?? MAX_INPUT_SYMBOLS
    ),

    scannerUpdatedAt: source.scannerUpdatedAt || null,
    tradeFunnelUpdatedAt: source.tradeFunnelUpdatedAt || null,

    lastBullScan: source.lastBullScan || null,
    lastBearScan: source.lastBearScan || null,

    updatedAt: source.updatedAt || Date.now(),
    servedAt: source.servedAt || null,
    storedAt: source.storedAt || Date.now()
  };
}

function buildHardMinimalLatestScan(data) {
  const source = safeObject(data);

  const funnel = compactFunnel(source.funnel, {
    entry: 50,
    almost: 50,
    buildup: 0,
    radar: 0
  });

  return {
    ok: Boolean(source.ok),

    scanSide: source.scanSide,
    scanMode: source.scanMode,
    lastSideScan: source.lastSideScan,

    notify: source.notify,
    store: source.store,

    btc: source.btc || null,
    regime: source.regime || null,
    market: compactMarket(source.market),

    funnel,
    funnelCount: countFunnel(funnel),
    bullCount: countSide(funnel, "bull"),
    bearCount: countSide(funnel, "bear"),

    total: safeNumber(source.total, 0),

    candidates: safeNumber(source.candidates, 0),
    candidatesBull: safeNumber(source.candidatesBull, 0),
    candidatesBear: safeNumber(source.candidatesBear, 0),

    bitgetSymbols: safeNumber(source.bitgetSymbols, 0),
    bitgetUniverseReady: Boolean(source.bitgetUniverseReady),

    trades: [],
    tradeSystemResult: {
      candidatesCount: safeNumber(source.tradeSystemResult?.candidatesCount, 0),
      strategyVersion: source.tradeSystemResult?.strategyVersion || null,
      durableEnabled: Boolean(source.tradeSystemResult?.durableEnabled),
      actions: []
    },

    analyzeAppendResult: compactAnalyzeAppendResult(source.analyzeAppendResult),

    tradeFunnelRawCount: safeNumber(source.tradeFunnelRawCount, 0),
    tradeFunnelInputCount: safeNumber(source.tradeFunnelInputCount, 0),
    tradeFunnelRejectCounts: safeObject(source.tradeFunnelRejectCounts),
    tradeFunnelInputSymbols: safeArray(source.tradeFunnelInputSymbols).slice(0, 100),

    scannerUpdatedAt: source.scannerUpdatedAt || null,
    tradeFunnelUpdatedAt: source.tradeFunnelUpdatedAt || null,

    lastBullScan: source.lastBullScan || null,
    lastBearScan: source.lastBearScan || null,

    updatedAt: source.updatedAt || Date.now(),
    storedAt: source.storedAt || Date.now(),

    compacted: true,
    compactedMode: "hard_minimal"
  };
}

function buildRedisSafeLatestScan(data) {
  const base = {
    ...(data || {}),
    storedAt: Date.now()
  };

  const attempts = [
    {
      mode: "normal",
      payload: compactLatestScan(base)
    },
    {
      mode: "reduced_history",
      payload: compactLatestScan(base, {
        trades: 40,
        actions: 40,
        dashboardRows: 20,
        inputSymbols: 180
      })
    },
    {
      mode: "reduced_funnel",
      payload: compactLatestScan(base, {
        entry: 80,
        almost: 80,
        buildup: 15,
        radar: 5,
        trades: 25,
        actions: 25,
        dashboardRows: 10,
        inputSymbols: 120
      })
    },
    {
      mode: "minimal",
      payload: compactLatestScan(base, {
        entry: 60,
        almost: 60,
        buildup: 0,
        radar: 0,
        trades: 10,
        actions: 10,
        dashboardRows: 5,
        inputSymbols: 80
      })
    },
    {
      mode: "hard_minimal",
      payload: buildHardMinimalLatestScan(base)
    }
  ];

  for (const attempt of attempts) {
    const json = safeJsonStringify({
      ...attempt.payload,
      compacted: attempt.mode !== "normal",
      compactedMode: attempt.mode
    });

    const bodyBytes = redisCommandBodyBytes([
      "SET",
      STORE_KEY,
      json
    ]);

    if (bodyBytes <= REDIS_MAX_BODY_BYTES) {
      const payload = {
        ...attempt.payload,
        compacted: attempt.mode !== "normal",
        compactedMode: attempt.mode,
        compactedBytes: byteLength(json),
        redisBodyBytes: bodyBytes
      };

      return {
        payload,
        json: safeJsonStringify(payload),
        mode: attempt.mode,
        bytes: byteLength(safeJsonStringify(payload)),
        bodyBytes
      };
    }
  }

  const payload = buildHardMinimalLatestScan(base);
  const json = safeJsonStringify(payload);

  return {
    payload,
    json,
    mode: "hard_minimal_forced",
    bytes: byteLength(json),
    bodyBytes: redisCommandBodyBytes(["SET", STORE_KEY, json])
  };
}

// ================= REDIS COMMAND =================

async function redisCommand(command) {
  const url = getRedisUrl();
  const token = getRedisToken();

  if (!url || !token) {
    throw new Error("Redis env missing");
  }

  const body = safeJsonStringify(command);
  const bodyBytes = byteLength(body);

  if (bodyBytes > REDIS_MAX_BODY_BYTES) {
    throw new Error(
      `Redis command too large: ${bodyBytes}/${REDIS_MAX_BODY_BYTES}`
    );
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || json?.error) {
    throw new Error(json?.error || `Redis error ${res.status}`);
  }

  return json?.result;
}

// ================= LATEST SCAN =================

export async function setLatestScan(data) {
  const compacted = buildRedisSafeLatestScan(data);
  const payload = compacted.payload;

  globalStore.latestScan = payload;

  console.log("SCAN STORE SET PREPARED:", {
    key: STORE_KEY,
    mode: compacted.mode,
    bytes: compacted.bytes,
    bodyBytes: compacted.bodyBytes,
    mb: Number((compacted.bodyBytes / 1024 / 1024).toFixed(2)),
    funnelCount: payload.funnelCount,
    bullCount: payload.bullCount,
    bearCount: payload.bearCount,
    trades: safeArray(payload.trades).length,
    actions: safeArray(payload.tradeSystemResult?.actions).length
  });

  if (hasRedis()) {
    try {
      await redisCommand([
        "SET",
        STORE_KEY,
        compacted.json
      ]);
    } catch (e) {
      console.error("SCAN STORE SET ERROR:", e.message);
    }
  }

  return payload;
}

export async function getLatestScan() {
  const now = Date.now();

  // Warm cache als Redis net gelezen is.
  if (
    globalStore.latestScan &&
    now - Number(globalStore.lastRedisReadAt || 0) < MEMORY_CACHE_TTL_MS
  ) {
    return globalStore.latestScan;
  }

  if (hasRedis()) {
    try {
      const result = await redisCommand([
        "GET",
        STORE_KEY
      ]);

      const parsed = safeJsonParse(result, null);
      const normalized = normalizeLatestScan(parsed);

      if (normalized) {
        globalStore.latestScan = normalized;
        globalStore.lastRedisReadAt = now;
        return normalized;
      }
    } catch (e) {
      console.error("SCAN STORE GET ERROR:", e.message);
    }
  }

  return globalStore.latestScan;
}

export async function clearLatestScan() {
  globalStore.latestScan = null;
  globalStore.lastRedisReadAt = 0;

  if (hasRedis()) {
    try {
      await redisCommand([
        "DEL",
        STORE_KEY
      ]);
    } catch (e) {
      console.error("SCAN STORE CLEAR ERROR:", e.message);
    }
  }
}

// ================= STAGE MEMORY =================
// Sync functies blijven bestaan zodat bestaande stageMemory.js niet breekt.
// Extra: stageMemory wordt ook naar Redis geschreven.

export function getStageMemory() {
  return globalStore.stageMemory || {};
}

export function setStageMemory(newMemory) {
  const normalized = normalizeStageMemory(newMemory || {});

  globalStore.stageMemory = normalized;
  globalStore.lastStageMemoryReadAt = Date.now();

  if (hasRedis()) {
    void redisCommand([
      "SET",
      STAGE_MEMORY_KEY,
      safeJsonStringify(normalized)
    ]).catch(e => {
      console.error("STAGE MEMORY SET ERROR:", e.message);
    });
  }

  return globalStore.stageMemory;
}

export function clearStageMemory() {
  globalStore.stageMemory = {};
  globalStore.lastStageMemoryReadAt = 0;

  if (hasRedis()) {
    void redisCommand([
      "DEL",
      STAGE_MEMORY_KEY
    ]).catch(e => {
      console.error("STAGE MEMORY CLEAR ERROR:", e.message);
    });
  }
}

// ================= ASYNC STAGE MEMORY =================
// Gebruik deze in stageMemory.js als je het echt strak wilt maken.

export async function loadStageMemoryFromStore() {
  const now = Date.now();

  if (
    globalStore.stageMemory &&
    Object.keys(globalStore.stageMemory).length > 0 &&
    now - Number(globalStore.lastStageMemoryReadAt || 0) < MEMORY_CACHE_TTL_MS
  ) {
    return globalStore.stageMemory;
  }

  if (hasRedis()) {
    try {
      const result = await redisCommand([
        "GET",
        STAGE_MEMORY_KEY
      ]);

      const parsed = safeJsonParse(result, {});
      const normalized = normalizeStageMemory(parsed);

      globalStore.stageMemory = normalized;
      globalStore.lastStageMemoryReadAt = now;

      return normalized;
    } catch (e) {
      console.error("STAGE MEMORY GET ERROR:", e.message);
    }
  }

  return globalStore.stageMemory || {};
}

export async function saveStageMemoryToStore(newMemory) {
  const normalized = normalizeStageMemory(newMemory || {});

  globalStore.stageMemory = normalized;
  globalStore.lastStageMemoryReadAt = Date.now();

  if (hasRedis()) {
    try {
      await redisCommand([
        "SET",
        STAGE_MEMORY_KEY,
        safeJsonStringify(normalized)
      ]);
    } catch (e) {
      console.error("STAGE MEMORY SAVE ERROR:", e.message);
    }
  }

  return normalized;
}