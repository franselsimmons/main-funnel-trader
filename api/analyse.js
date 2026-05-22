// api/analyse.js

const DEFAULT_MIN_CLOSED = 10;
const MAX_EVENTS = 50000;

// ================= FAMILY DEFINITIONS =================

const QUALITY_BUCKETS = [
  {
    index: 1,
    name: "Q1_WEAK",
    conf: "CONF_0_50",
    sniper: "SNIPER_0_50",
    rr: "RR_LT_1p00",
    score: "SCORE_0_50",
  },
  {
    index: 2,
    name: "Q2_LOW",
    conf: "CONF_50_65",
    sniper: "SNIPER_50_65",
    rr: "RR_1p00_1p20",
    score: "SCORE_50_65",
  },
  {
    index: 3,
    name: "Q3_BASE",
    conf: "CONF_65_75",
    sniper: "SNIPER_65_75",
    rr: "RR_1p20_1p50",
    score: "SCORE_65_75",
  },
  {
    index: 4,
    name: "Q4_STRONG",
    conf: "CONF_75_85",
    sniper: "SNIPER_75_85",
    rr: "RR_1p50_2p00",
    score: "SCORE_75_85",
  },
  {
    index: 5,
    name: "Q5_ELITE",
    conf: "CONF_85_100",
    sniper: "SNIPER_85_100",
    rr: "RR_2p00_PLUS",
    score: "SCORE_85_100",
  },
];

const MARKET_BUCKETS = [
  {
    index: 1,
    name: "M1_DIRTY",
    ob: "OB_REL_AGAINST",
    spread: "SPREAD_GT_25BPS",
    depth: "DEPTH_LT_10K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_CROWDED",
  },
  {
    index: 2,
    name: "M2_WEAK",
    ob: "OB_REL_AGAINST_OR_NEUTRAL",
    spread: "SPREAD_16_25BPS",
    depth: "DEPTH_10K_50K",
    btc: "BTC_REL_COUNTER",
    funding: "FUNDING_EDGE_WEAK",
  },
  {
    index: 3,
    name: "M3_NORMAL",
    ob: "OB_REL_NEUTRAL",
    spread: "SPREAD_8_16BPS",
    depth: "DEPTH_50K_100K",
    btc: "BTC_REL_NEUTRAL",
    funding: "FUNDING_NEUTRAL",
  },
  {
    index: 4,
    name: "M4_CLEAN",
    ob: "OB_REL_WITH_OR_NEUTRAL",
    spread: "SPREAD_5_12BPS",
    depth: "DEPTH_100K_250K",
    btc: "BTC_REL_WITH_OR_NEUTRAL",
    funding: "FUNDING_OK",
  },
  {
    index: 5,
    name: "M5_PREMIUM",
    ob: "OB_REL_WITH",
    spread: "SPREAD_LT_8BPS",
    depth: "DEPTH_GT_250K",
    btc: "BTC_REL_WITH",
    funding: "FUNDING_OPTIMAL",
  },
];

function timingBucket(side, index) {
  const isShort = side === "SHORT";

  if (index === 2) {
    return {
      index: 2,
      name: "T2_TIMED",
      stage: "STAGE_ENTRY_OR_ALMOST",
      flow: "FLOW_TREND_OR_BUILDING",
      rsi: isShort ? "RSI_UPPER_OR_MID" : "RSI_LOWER_OR_MID",
      tf: "TF_ALIGNED",
      pullback: "PULLBACK_OR_CONFIRMATION_OK",
    };
  }

  return {
    index: 1,
    name: "T1_EARLY_OR_NOISY",
    stage: "STAGE_ANY",
    flow: "FLOW_ANY",
    rsi: "RSI_ANY",
    tf: "TF_ANY",
    pullback: "PULLBACK_NOT_REQUIRED",
  };
}

function buildDefinition(side, q, m, t) {
  return [
    q.name,
    m.name,
    t.name,
    q.conf,
    q.sniper,
    q.rr,
    q.score,
    t.stage,
    t.flow,
    t.rsi,
    m.ob,
    m.spread,
    m.depth,
    m.btc,
    m.funding,
    t.tf,
    t.pullback,
  ].join(" | ");
}

function emptyStats() {
  return {
    observed: 0,
    open: 0,
    closed: 0,
    shadow: 0,
    wins: 0,
    losses: 0,
    winrate: "0%",
    winrateNum: 0,
    totalR: 0,
    avgR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,
    lossRate: "0.0%",
    status: "EMPTY",
  };
}

function buildFamiliesForSide(side) {
  const families = [];

  for (const q of QUALITY_BUCKETS) {
    for (const m of MARKET_BUCKETS) {
      for (const timingIndex of [1, 2]) {
        const t = timingBucket(side, timingIndex);
        const index = (q.index - 1) * 10 + (m.index - 1) * 2 + t.index;

        families.push({
          id: `${side}_${index}`,
          side,
          index,
          qualityIndex: q.index,
          marketIndex: m.index,
          timingIndex: t.index,
          definition: buildDefinition(side, q, m, t),
          qualityBucket: q.name,
          marketBucket: m.name,
          timingBucket: t.name,
          ...emptyStats(),
        });
      }
    }
  }

  return families.sort((a, b) => a.index - b.index);
}

function buildEmptyReport(minClosed = DEFAULT_MIN_CLOSED) {
  const long = buildFamiliesForSide("LONG");
  const short = buildFamiliesForSide("SHORT");
  const all = [...long, ...short];

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
      totalFamilyCount: 100,
    },
    summary: buildSummary(all),
    families: {
      all,
      long,
      short,
    },
    filters: {
      quality: QUALITY_BUCKETS,
      market: MARKET_BUCKETS,
      timing: ["T1_EARLY_OR_NOISY", "T2_TIMED"],
      trackedAxes: [
        "side",
        "qualityBucket",
        "marketBucket",
        "timingBucket",
        "confluence",
        "sniper",
        "rr",
        "score",
        "stage",
        "flow",
        "rsi",
        "obRelation",
        "spread",
        "depth",
        "btcRelation",
        "funding",
        "tfAlignment",
        "pullback",
      ],
    },
  };
}

// ================= GENERIC HELPERS =================

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 3) {
  const n = safeNumber(value, 0);
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;

  return fallback;
}

function queryValue(req, key, fallback = undefined) {
  const direct = req?.query?.[key];

  if (Array.isArray(direct)) return direct[0] ?? fallback;
  if (direct !== undefined) return direct;

  try {
    const host = req?.headers?.host || "localhost";
    const url = new URL(req?.url || "/", `https://${host}`);
    return url.searchParams.get(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeSide(value) {
  const s = String(value || "").toUpperCase().trim();

  if (["LONG", "BULL", "BUY"].includes(s)) return "LONG";
  if (["SHORT", "BEAR", "SELL"].includes(s)) return "SHORT";

  return "";
}

function normalizeStage(value) {
  const s = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/^scanner[-_]/, "");

  if (s === "entry") return "ENTRY";
  if (s === "almost") return "ALMOST";

  return "ANY";
}

function normalizeFlow(value) {
  const f = String(value || "").toUpperCase().trim();

  if (["TREND", "BREAKOUT", "RUNNING"].includes(f)) return "TREND";
  if (["BUILDING", "BUILDUP"].includes(f)) return "BUILDING";

  return "NEUTRAL";
}

function pickNumber(obj, keys, fallback = 0) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null && obj?.[key] !== "") {
      const n = Number(obj[key]);
      if (Number.isFinite(n)) return n;
    }
  }

  return fallback;
}

function stableEventId(event) {
  const explicit =
    event?.id ||
    event?.tradeId ||
    event?.positionId ||
    event?.orderId ||
    event?.clientOrderId ||
    event?.analyzeId;

  if (explicit) return String(explicit);

  const symbol = String(event?.symbol || "NA").toUpperCase();
  const side = normalizeSide(event?.side) || "NA";
  const ts = String(
    event?.closedAt ||
      event?.openedAt ||
      event?.createdAt ||
      event?.updatedAt ||
      event?.ts ||
      event?.timestamp ||
      "NO_TS"
  );

  const raw = JSON.stringify([
    symbol,
    side,
    event?.action,
    event?.status,
    event?.entry,
    event?.sl,
    event?.tp,
    event?.rr,
    event?.confluence,
    event?.sniperScore,
    ts,
  ]);

  return `${symbol}_${side}_${ts}_${raw.length}`;
}

// ================= EVENT NORMALISATION =================

function isClosedEvent(event) {
  const status = String(event?.status || "").toUpperCase();
  const action = String(event?.action || "").toUpperCase();
  const outcome = String(event?.outcome || event?.result || "").toUpperCase();

  if (event?.closedAt || event?.exitAt || event?.exitTs) return true;

  if (["CLOSED", "WIN", "LOSS", "TP", "SL"].includes(status)) return true;
  if (["CLOSE", "CLOSED", "EXIT", "TP", "SL"].includes(action)) return true;
  if (["WIN", "LOSS", "TP", "SL"].includes(outcome)) return true;

  return false;
}

function isShadowEvent(event) {
  const status = String(event?.status || "").toUpperCase();
  const sourceType = String(event?.sourceType || "").toLowerCase();

  if (status === "SHADOW") return true;
  if (sourceType.includes("shadow")) return true;
  if (sourceType === "accepted_candidate") return true;

  return false;
}

function normalizeStatus(event) {
  if (isClosedEvent(event)) return "CLOSED";
  if (isShadowEvent(event)) return "SHADOW";

  const status = String(event?.status || "").toUpperCase();

  if (status === "OPEN") return "OPEN";

  return "OPEN";
}

function getResultR(event) {
  const direct = pickNumber(
    event,
    [
      "r",
      "R",
      "resultR",
      "realizedR",
      "finalR",
      "netR",
      "pnlR",
      "profitR",
      "rrResult",
    ],
    NaN
  );

  if (Number.isFinite(direct)) return direct;

  const outcome = String(event?.outcome || event?.result || event?.status || "").toUpperCase();
  const rr = pickNumber(event, ["rr", "baseRR", "finalRR"], 0);

  if (["WIN", "TP"].includes(outcome) && rr > 0) return rr;
  if (["LOSS", "SL"].includes(outcome)) return -1;

  return 0;
}

function getPnlPct(event) {
  return pickNumber(
    event,
    [
      "pnlPct",
      "pnlPercent",
      "netPnlPct",
      "realizedPnlPct",
      "profitPct",
      "returnPct",
    ],
    0
  );
}

function getWinLoss(event, r) {
  const outcome = String(event?.outcome || event?.result || event?.status || event?.action || "").toUpperCase();

  if (["WIN", "TP"].includes(outcome)) return { win: true, loss: false };
  if (["LOSS", "SL"].includes(outcome)) return { win: false, loss: true };

  if (r > 0) return { win: true, loss: false };
  if (r < 0) return { win: false, loss: true };

  return { win: false, loss: false };
}

function normalizeEvent(input, source = "unknown") {
  const side = normalizeSide(input?.side);

  if (!side) return null;

  const symbol = String(input?.symbol || "").toUpperCase().trim();

  if (!symbol) return null;

  const status = normalizeStatus(input);
  const r = getResultR(input);
  const pnlPct = getPnlPct(input);
  const winLoss = status === "CLOSED" ? getWinLoss(input, r) : { win: false, loss: false };

  return {
    ...input,
    id: stableEventId(input),
    source,
    symbol,
    side,
    status,
    stage: normalizeStage(input?.stage || input?.scannerStage),
    flow: normalizeFlow(input?.flow),
    confluence: pickNumber(input, ["confluence", "conf", "confidence"], 0),
    sniper: pickNumber(input, ["sniper", "sniperScore", "sniper_score"], 0),
    rr: pickNumber(input, ["rr", "baseRR", "finalRR"], 0),
    score: pickNumber(input, ["score", "moveScore", "tradeScore", "setupScore"], 0),
    spreadPct: pickNumber(input, ["spreadPct", "spread", "spreadPercent"], NaN),
    spreadBps: pickNumber(input, ["spreadBps", "spread_bps"], NaN),
    depthUsd: pickNumber(
      input,
      [
        "depthMinUsd1p",
        "depthUsd1p",
        "depthUsd",
        "minDepthUsd1p",
        "liquidityUsd",
      ],
      NaN
    ),
    obBias: String(input?.obBias || input?.orderbookBias || input?.ob || "").toUpperCase(),
    btcState: String(input?.btcState || input?.btc || input?.btcBias || "").toUpperCase(),
    fundingRate: pickNumber(input, ["fundingRate", "funding", "fundingAbs"], 0),
    tfStrength: pickNumber(input, ["tfStrength", "tfScore"], 0),
    rsiZone: String(input?.rsiZone || input?.rsiBucket || "").toUpperCase(),
    pullbackOk: Boolean(input?.pullbackOk || input?.pullback || input?.confirmationOk),
    r,
    pnlPct,
    win: winLoss.win,
    loss: winLoss.loss,
  };
}

// ================= FAMILY ASSIGNMENT =================

function scoreToQualityIndex(value) {
  const n = safeNumber(value, 0);

  if (n >= 85) return 5;
  if (n >= 75) return 4;
  if (n >= 65) return 3;
  if (n >= 50) return 2;

  return 1;
}

function rrToQualityIndex(rr) {
  const n = safeNumber(rr, 0);

  if (n >= 2) return 5;
  if (n >= 1.5) return 4;
  if (n >= 1.2) return 3;
  if (n >= 1) return 2;

  return 1;
}

function qualityIndexFromEvent(event) {
  const indexes = [
    scoreToQualityIndex(event.confluence),
    scoreToQualityIndex(event.sniper),
    scoreToQualityIndex(event.score),
    rrToQualityIndex(event.rr),
  ];

  const usable = indexes.filter(n => Number.isFinite(n) && n > 0);

  if (!usable.length) return 1;

  const avg = usable.reduce((sum, n) => sum + n, 0) / usable.length;

  return Math.max(1, Math.min(5, Math.round(avg)));
}

function spreadBpsFromEvent(event) {
  if (Number.isFinite(event.spreadBps)) return event.spreadBps;

  const pct = event.spreadPct;

  if (!Number.isFinite(pct)) return NaN;

  // In jouw systeem is spreadPct meestal procent-punten:
  // 0.12 = 0.12% = 12 bps.
  if (pct <= 1) return pct * 100;

  return pct;
}

function marketIndexFromEvent(event) {
  const spreadBps = spreadBpsFromEvent(event);
  const depth = event.depthUsd;

  if (Number.isFinite(depth) && depth >= 250000 && Number.isFinite(spreadBps) && spreadBps <= 8) {
    return 5;
  }

  if (Number.isFinite(depth) && depth >= 100000 && Number.isFinite(spreadBps) && spreadBps <= 12) {
    return 4;
  }

  if (Number.isFinite(depth) && depth >= 50000 && Number.isFinite(spreadBps) && spreadBps <= 16) {
    return 3;
  }

  if (Number.isFinite(depth) && depth >= 10000 && Number.isFinite(spreadBps) && spreadBps <= 25) {
    return 2;
  }

  if (Number.isFinite(depth)) {
    if (depth >= 250000) return 5;
    if (depth >= 100000) return 4;
    if (depth >= 50000) return 3;
    if (depth >= 10000) return 2;
  }

  if (Number.isFinite(spreadBps)) {
    if (spreadBps <= 8) return 5;
    if (spreadBps <= 12) return 4;
    if (spreadBps <= 16) return 3;
    if (spreadBps <= 25) return 2;
  }

  return 1;
}

function timingIndexFromEvent(event) {
  const strongStage = ["ENTRY", "ALMOST"].includes(event.stage);
  const strongFlow = ["TREND", "BUILDING"].includes(event.flow);
  const tfAligned = Math.abs(safeNumber(event.tfStrength, 0)) > 0;

  if (strongStage && strongFlow) return 2;
  if (strongStage && tfAligned) return 2;

  return 1;
}

function explicitFamilyId(event) {
  const raw = String(
    event?.familyId ||
      event?.analyzeFamilyId ||
      event?.analysisFamilyId ||
      event?.family ||
      ""
  ).toUpperCase().trim();

  if (/^(LONG|SHORT)_([1-9]|[1-4][0-9]|50)$/.test(raw)) return raw;

  return "";
}

function familyIdFromEvent(event) {
  const explicit = explicitFamilyId(event);

  if (explicit) return explicit;

  const q = qualityIndexFromEvent(event);
  const m = marketIndexFromEvent(event);
  const t = timingIndexFromEvent(event);

  const index = (q - 1) * 10 + (m - 1) * 2 + t;

  return `${event.side}_${index}`;
}

// ================= AGGREGATION =================

function applyEventToFamily(family, event) {
  family.observed += 1;

  if (event.status === "SHADOW") {
    family.shadow += 1;
    return;
  }

  if (event.status === "CLOSED") {
    family.closed += 1;

    if (event.win) family.wins += 1;
    if (event.loss) family.losses += 1;

    family.totalR += event.r;
    family.totalPnlPct += event.pnlPct;

    return;
  }

  family.open += 1;
}

function finalizeFamily(family, minClosed) {
  const closed = safeNumber(family.closed, 0);
  const wins = safeNumber(family.wins, 0);
  const losses = safeNumber(family.losses, 0);

  const winrateNum = closed > 0 ? (wins / closed) * 100 : 0;
  const lossRateNum = closed > 0 ? (losses / closed) * 100 : 0;

  family.winrateNum = round(winrateNum, 2);
  family.winrate = `${round(winrateNum, 1)}%`;
  family.lossRate = `${round(lossRateNum, 1)}%`;

  family.totalR = round(family.totalR, 3);
  family.avgR = closed > 0 ? round(family.totalR / closed, 3) : 0;

  family.totalPnlPct = round(family.totalPnlPct, 3);
  family.avgPnlPct = closed > 0 ? round(family.totalPnlPct / closed, 3) : 0;

  if (family.observed <= 0) {
    family.status = "EMPTY";
    return family;
  }

  if (closed < minClosed) {
    family.status = "COLLECTING";
    return family;
  }

  if (family.winrateNum >= 58 && family.avgR > 0) {
    family.status = "GOOD";
    return family;
  }

  if (family.winrateNum >= 52 && family.avgR >= 0) {
    family.status = "STABLE";
    return family;
  }

  family.status = "BAD";
  return family;
}

function buildSummary(families) {
  const summary = {
    actions: 0,
    trades: 0,
    observed: 0,
    open: 0,
    closed: 0,
    shadow: 0,
    wins: 0,
    losses: 0,
    winrate: "0.0%",
    winrateNum: 0,
    totalR: 0,
    avgR: 0,
    totalPnlPct: 0,
    avgPnlPct: 0,
    longFamilies: 50,
    shortFamilies: 50,
    hotFamilies: 0,
    stableFamilies: 0,
    badFamilies: 0,
    collectingFamilies: 0,
    emptyFamilies: 0,
  };

  for (const f of families) {
    summary.observed += safeNumber(f.observed, 0);
    summary.open += safeNumber(f.open, 0);
    summary.closed += safeNumber(f.closed, 0);
    summary.shadow += safeNumber(f.shadow, 0);
    summary.wins += safeNumber(f.wins, 0);
    summary.losses += safeNumber(f.losses, 0);
    summary.totalR += safeNumber(f.totalR, 0);
    summary.totalPnlPct += safeNumber(f.totalPnlPct, 0);

    if (f.status === "GOOD") summary.hotFamilies += 1;
    if (f.status === "STABLE") summary.stableFamilies += 1;
    if (f.status === "BAD") summary.badFamilies += 1;
    if (f.status === "COLLECTING") summary.collectingFamilies += 1;
    if (f.status === "EMPTY") summary.emptyFamilies += 1;
  }

  summary.actions = summary.observed;
  summary.trades = summary.observed;

  summary.totalR = round(summary.totalR, 3);
  summary.avgR = summary.closed > 0 ? round(summary.totalR / summary.closed, 3) : 0;

  summary.totalPnlPct = round(summary.totalPnlPct, 3);
  summary.avgPnlPct = summary.closed > 0 ? round(summary.totalPnlPct / summary.closed, 3) : 0;

  summary.winrateNum = summary.closed > 0 ? round((summary.wins / summary.closed) * 100, 2) : 0;
  summary.winrate = `${round(summary.winrateNum, 1)}%`;

  return summary;
}

function buildReport(events, minClosed = DEFAULT_MIN_CLOSED) {
  const long = buildFamiliesForSide("LONG");
  const short = buildFamiliesForSide("SHORT");
  const all = [...long, ...short];

  const familyMap = new Map(all.map(f => [f.id, f]));

  for (const event of events) {
    const familyId = familyIdFromEvent(event);
    const family = familyMap.get(familyId);

    if (!family) continue;

    applyEventToFamily(family, event);
  }

  for (const family of all) {
    finalizeFamily(family, minClosed);
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: {
      minClosed,
      familyCountLong: 50,
      familyCountShort: 50,
      totalFamilyCount: 100,
    },
    summary: buildSummary(all),
    families: {
      all,
      long,
      short,
    },
    filters: {
      quality: QUALITY_BUCKETS,
      market: MARKET_BUCKETS,
      timing: ["T1_EARLY_OR_NOISY", "T2_TIMED"],
      trackedAxes: [
        "side",
        "qualityBucket",
        "marketBucket",
        "timingBucket",
        "confluence",
        "sniper",
        "rr",
        "score",
        "stage",
        "flow",
        "rsi",
        "obRelation",
        "spread",
        "depth",
        "btcRelation",
        "funding",
        "tfAlignment",
        "pullback",
      ],
    },
  };
}

// ================= DATA LOADERS =================

async function loadAnalyzeStoreEvents() {
  try {
    const mod = await import("../lib/analyze/analyzeStore.js");

    const fn =
      mod.getAnalyzeEvents ||
      mod.readAnalyzeEvents ||
      mod.getAnalyzeRecords ||
      mod.default?.getAnalyzeEvents ||
      mod.default?.readAnalyzeEvents;

    if (typeof fn !== "function") {
      return {
        ok: false,
        source: "analyzeStore",
        reason: "NO_READER_EXPORT",
        events: [],
      };
    }

    const result = await fn({ limit: MAX_EVENTS });

    const rawEvents =
      result?.events ||
      result?.records ||
      result?.trades ||
      result?.data ||
      [];

    return {
      ok: true,
      source: "analyzeStore",
      count: safeArray(rawEvents).length,
      events: safeArray(rawEvents),
    };
  } catch (error) {
    return {
      ok: false,
      source: "analyzeStore",
      reason: error?.message || "ANALYZE_STORE_LOAD_FAILED",
      events: [],
    };
  }
}

async function resetAnalyzeStore() {
  try {
    const mod = await import("../lib/analyze/analyzeStore.js");

    const fn =
      mod.resetAnalyzeEvents ||
      mod.default?.resetAnalyzeEvents;

    if (typeof fn !== "function") {
      return {
        ok: false,
        source: "analyzeStore",
        reason: "NO_RESET_EXPORT",
      };
    }

    const result = await fn();

    return {
      ok: true,
      source: "analyzeStore",
      result,
    };
  } catch (error) {
    return {
      ok: false,
      source: "analyzeStore",
      reason: error?.message || "RESET_FAILED",
    };
  }
}

async function loadLatestScanEvents() {
  try {
    const mod = await import("../lib/scanStore.js");

    if (typeof mod.getLatestScan !== "function") {
      return {
        ok: false,
        source: "latestScan",
        reason: "NO_GET_LATEST_SCAN_EXPORT",
        events: [],
      };
    }

    const latest = await mod.getLatestScan();

    if (!latest) {
      return {
        ok: false,
        source: "latestScan",
        reason: "NO_LATEST_SCAN",
        events: [],
      };
    }

    const events = [
      ...safeArray(latest?.trades),
      ...safeArray(latest?.tradeSystemResult?.actions),
      ...safeArray(latest?.tradeSystemResult?.trades),
      ...safeArray(latest?.actions),
    ];

    return {
      ok: true,
      source: "latestScan",
      count: events.length,
      updatedAt: latest?.updatedAt || latest?.tradeFunnelUpdatedAt || null,
      events,
    };
  } catch (error) {
    return {
      ok: false,
      source: "latestScan",
      reason: error?.message || "LATEST_SCAN_LOAD_FAILED",
      events: [],
    };
  }
}

function dedupeNormalizeEvents(sourceResults) {
  const map = new Map();

  for (const sourceResult of sourceResults) {
    const source = sourceResult?.source || "unknown";

    for (const raw of safeArray(sourceResult?.events)) {
      const event = normalizeEvent(raw, source);

      if (!event) continue;

      map.set(event.id, {
        ...map.get(event.id),
        ...event,
      });
    }
  }

  return Array.from(map.values()).slice(-MAX_EVENTS);
}

// ================= RESPONSE =================

function sendJson(res, status, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  return res.status(status).json(payload);
}

// ================= HANDLER =================

export default async function handler(req, res) {
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const minClosed = Math.max(
    0,
    Math.floor(safeNumber(queryValue(req, "minClosed", DEFAULT_MIN_CLOSED), DEFAULT_MIN_CLOSED))
  );

  const reset = normalizeBoolean(queryValue(req, "reset", false), false);

  try {
    const resetResult = reset ? await resetAnalyzeStore() : null;

    const sources = await Promise.all([
      loadAnalyzeStoreEvents(),
      loadLatestScanEvents(),
    ]);

    const events = dedupeNormalizeEvents(sources);
    const report = buildReport(events, minClosed);

    const payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      reset,
      resetResult,
      sources: sources.map(source => ({
        ok: Boolean(source.ok),
        source: source.source,
        count: safeNumber(source.count, safeArray(source.events).length),
        reason: source.reason || null,
        updatedAt: source.updatedAt || null,
      })),
      tradesLoaded: events.length,
      report,

      // Compatibiliteit voor oudere analytics.js versies:
      summary: report.summary,
      families: report.families,
      filters: report.filters,
    };

    return sendJson(res, 200, payload);
  } catch (error) {
    const report = buildEmptyReport(minClosed);

    return sendJson(res, 200, {
      ok: true,
      degraded: true,
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: error?.message || "ANALYSE_API_RECOVERED_FROM_ERROR",
      tradesLoaded: 0,
      report,

      // Compatibiliteit voor oudere analytics.js versies:
      summary: report.summary,
      families: report.families,
      filters: report.filters,
    });
  }
}