// lib/familyMicroAnalyzer.js

const DEFAULT_MIN_PARENT_CLOSED = 10;
const DEFAULT_MIN_SUB_CLOSED = 8;
const DEFAULT_MIN_MICRO_CLOSED = 6;

const PROFIT_FACTOR_NO_LOSS = 999;
const EPSILON_R = 0.000001;

const FAIR_WINRATE_TARGET_CLOSED = readPositiveNumberEnv(
  "FAMILY_MICRO_FAIR_WINRATE_TARGET_CLOSED",
  100
);

const FAIR_WINRATE_WILSON_Z = readPositiveNumberEnv(
  "FAMILY_MICRO_FAIR_WINRATE_WILSON_Z",
  1.96
);

const FAIR_WINRATE_PRIOR_ALPHA = readPositiveNumberEnv(
  "FAMILY_MICRO_FAIR_WINRATE_PRIOR_ALPHA",
  8
);

const FAIR_WINRATE_PRIOR_BETA = readPositiveNumberEnv(
  "FAMILY_MICRO_FAIR_WINRATE_PRIOR_BETA",
  8
);

const LEVELS = {
  PARENT: "PARENT",
  SUB: "SUB",
  MICRO: "MICRO"
};

const STATUS_RANK = {
  ELITE: 8,
  HOT: 7,
  GOOD: 6,
  STABLE: 5,
  CANDIDATE: 4,
  COLLECTING: 3,
  EMPTY: 2,
  BAD: 1
};

const STATUS_ORDER = [
  "ELITE",
  "HOT",
  "GOOD",
  "STABLE",
  "CANDIDATE",
  "COLLECTING",
  "EMPTY",
  "BAD"
];

// ================= ENV HELPERS =================

function readPositiveNumberEnv(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

function round(value, decimals = 3) {
  const n = safeNumber(value, 0);
  const factor = 10 ** decimals;

  return Math.round(n * factor) / factor;
}

function pct(value, decimals = 1) {
  return `${round(value, decimals)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeRawText(value) {
  if (value === undefined || value === null) return "";

  if (typeof value === "string") return value.trim();

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }

  return "";
}

function cleanToken(value, fallback = "UNKNOWN") {
  const raw = normalizeRawText(value);

  if (!raw) return fallback;

  const upper = raw
    .replace(/\[object object\]/gi, "")
    .replace(/\{.*?\}/g, "")
    .replace(/[^\w.%+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  if (!upper) return fallback;
  if (upper === "OBJECT_OBJECT") return fallback;
  if (upper.includes("OBJECT_OBJECT")) return fallback;

  return upper;
}

function toKey(value, fallback = "UNKNOWN") {
  if (value === undefined || value === null || value === "") return fallback;

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return cleanToken(value, fallback);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map(item => toKey(item, ""))
      .filter(Boolean)
      .filter(part => part !== "UNKNOWN");

    return parts.length ? cleanToken(parts.join("_"), fallback) : fallback;
  }

  if (typeof value === "object") {
    const obj = safeObject(value);

    const candidates = [
      obj.key,
      obj.id,
      obj.familyId,
      obj.parentFamilyId,
      obj.mainFamilyId,
      obj.label,
      obj.name,
      obj.value,
      obj.bucket,
      obj.status,
      obj.type,
      obj.code,
      obj.text,
      obj.title
    ];

    for (const candidate of candidates) {
      const key = toKey(candidate, "");

      if (key && key !== "UNKNOWN") return key;
    }

    return fallback;
  }

  return fallback;
}

function normalizeSide(value) {
  const s = String(value || "").toLowerCase().trim();

  if (["long", "bull", "buy", "bid"].includes(s)) return "LONG";
  if (["short", "bear", "sell", "ask"].includes(s)) return "SHORT";

  const key = toKey(value, "");
  if (key.includes("LONG")) return "LONG";
  if (key.includes("SHORT")) return "SHORT";

  return "";
}

function getAt(source, path) {
  if (!source || !path) return undefined;

  const parts = String(path).split(".");
  let current = source;

  for (const part of parts) {
    if (current === undefined || current === null) return undefined;

    current = current[part];
  }

  return current;
}

function firstDefined(source, paths) {
  for (const path of safeArray(paths)) {
    const value = getAt(source, path);

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function normalizeTs(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
}

function getEventTs(event, fallback = Date.now()) {
  return normalizeTs(
    event?.analyzeUpdatedAt ??
      event?.closedAt ??
      event?.exitAt ??
      event?.exitTs ??
      event?.updatedAt ??
      event?.openedAt ??
      event?.createdAt ??
      event?.entryTs ??
      event?.analyzeTs ??
      event?.ts,
    fallback
  );
}

function getTradeId(event) {
  const id =
    event?.tradeId ||
    event?.positionId ||
    event?.orderId ||
    event?.analyzeEventKey ||
    event?.analyzeEventId ||
    event?.eventId ||
    event?.id;

  return id ? String(id) : "";
}

function isTradeLike(event) {
  if (!event || typeof event !== "object") return false;

  const action = toKey(event.action || event.status || event.reason, "");
  const kind = toKey(event.analyzeKind || event.type, "");

  if (kind === "TRADE_RECORD") return true;
  if (kind === "UNMATCHED_EXIT") return true;

  if (
    action === "WAIT" ||
    action === "HOLD" ||
    action === "RUNNING" ||
    action === "NO_TRADE" ||
    action === "SKIP"
  ) {
    return false;
  }

  if (action.includes("ENTRY")) return true;
  if (action.includes("EXIT")) return true;
  if (action.includes("TP")) return true;
  if (action.includes("SL")) return true;
  if (event.closed === true) return true;

  return Boolean(
    event.tradeId ||
      event.positionId ||
      event.entry !== undefined ||
      event.entryPrice !== undefined ||
      event.exitPrice !== undefined
  );
}

// ================= NUMBER EXTRACTION =================

function parseNumbersFromText(value) {
  const raw = normalizeRawText(value)
    .replace(/(\d+)p(\d+)/gi, "$1.$2")
    .replace(/,/g, ".");

  if (!raw) return [];

  const matches = raw.match(/-?\d+(?:\.\d+)?/g) || [];

  return matches
    .map(Number)
    .filter(Number.isFinite);
}

function rangeMidpointFromText(value) {
  const nums = parseNumbersFromText(value);

  if (!nums.length) return null;
  if (nums.length === 1) return nums[0];

  return (nums[0] + nums[1]) / 2;
}

function toFiniteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "string") {
    const direct = Number(value);

    if (Number.isFinite(direct)) return direct;

    const parsed = rangeMidpointFromText(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  if (typeof value === "object") {
    const obj = safeObject(value);

    const candidates = [
      obj.value,
      obj.score,
      obj.num,
      obj.number,
      obj.pct,
      obj.percent,
      obj.percentage,
      obj.current,
      obj.raw,
      obj.data?.value,
      obj.data?.score
    ];

    for (const candidate of candidates) {
      const n = toFiniteNumber(candidate, null);

      if (Number.isFinite(n)) return n;
    }
  }

  return fallback;
}

function normalizeScoreNumber(value) {
  const n = toFiniteNumber(value, null);

  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return n * 100;

  return n;
}

function getDefinitionText(event) {
  const candidates = [
    event?.definition,
    event?.familyDefinition,
    event?.analyzeFamilyDefinition,
    event?.filterSnapshot?.definition,
    event?.filterSnapshot?.familyDefinition,
    event?.filterSnapshot?.labels,
    event?.filterSnapshot?.buckets
  ];

  const parts = [];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (typeof candidate === "string") {
      parts.push(candidate);
      continue;
    }

    if (Array.isArray(candidate)) {
      parts.push(candidate.map(item => toKey(item, "")).filter(Boolean).join(" | "));
      continue;
    }

    if (typeof candidate === "object") {
      const obj = safeObject(candidate);

      for (const value of Object.values(obj)) {
        const key = toKey(value, "");

        if (key && key !== "UNKNOWN") parts.push(key);
      }
    }
  }

  return parts.join(" | ");
}

function findTokenValue(event, prefix) {
  const definition = getDefinitionText(event);
  const cleanPrefix = cleanToken(prefix, "");

  if (!definition || !cleanPrefix) return null;

  const tokens = definition
    .split("|")
    .map(token => token.trim())
    .filter(Boolean);

  const match = tokens.find(token => cleanToken(token, "").startsWith(`${cleanPrefix}_`));

  if (!match) return null;

  return rangeMidpointFromText(match);
}

function getNumericFeature(event, paths, tokenPrefix = "") {
  const direct = firstDefined(event, paths);
  const directNumber = normalizeScoreNumber(direct);

  if (Number.isFinite(directNumber)) return directNumber;

  if (!tokenPrefix) return null;

  return findTokenValue(event, tokenPrefix);
}

function getRRFeature(event) {
  const direct = firstDefined(event, [
    "rr",
    "baseRR",
    "riskReward",
    "riskRewardRatio",
    "riskRewardR",
    "filterSnapshot.rr",
    "filterSnapshot.baseRR",
    "filterSnapshot.riskReward",
    "filterSnapshot.riskRewardRatio",
    "setup.rr",
    "entry.rr"
  ]);

  const n = toFiniteNumber(direct, null);

  if (Number.isFinite(n)) return n;

  return findTokenValue(event, "RR");
}

function getSpreadBps(event) {
  const directBps = toFiniteNumber(
    firstDefined(event, [
      "spreadBps",
      "spreadBP",
      "spread_bps",
      "filterSnapshot.spreadBps",
      "filterSnapshot.spreadBP",
      "orderbook.spreadBps",
      "book.spreadBps"
    ]),
    null
  );

  if (Number.isFinite(directBps)) return directBps;

  const pct = toFiniteNumber(
    firstDefined(event, [
      "spreadPct",
      "spreadPercent",
      "spread",
      "filterSnapshot.spreadPct",
      "filterSnapshot.spreadPercent",
      "orderbook.spreadPct",
      "book.spreadPct"
    ]),
    null
  );

  if (!Number.isFinite(pct)) return null;

  const n = Math.abs(pct);

  // tradeSystem spreadPct is meestal decimal-ratio: 0.001 = 10 bps.
  if (n <= 0.05) return n * 10000;
  if (n <= 10) return n * 100;

  return n;
}

function getDepthUsd(event) {
  return toFiniteNumber(
    firstDefined(event, [
      "depthMinUsd1p",
      "depthUsd",
      "minDepthUsd",
      "liquidityUsd",
      "filterSnapshot.depthMinUsd1p",
      "filterSnapshot.depthUsd",
      "orderbook.depthMinUsd1p",
      "book.depthMinUsd1p"
    ]),
    null
  );
}

function getRsiValue(event) {
  return toFiniteNumber(
    firstDefined(event, [
      "rsi",
      "rsiValue",
      "rsi14",
      "filterSnapshot.rsi",
      "filterSnapshot.rsiValue",
      "rsi.mtf",
      "rsi.value"
    ]),
    null
  );
}

function getTfScore(event) {
  return toFiniteNumber(
    firstDefined(event, [
      "tfScore",
      "tfStrength",
      "timeframeScore",
      "filterSnapshot.tfScore",
      "filterSnapshot.tfStrength",
      "tf.score",
      "tf.strength"
    ]),
    null
  );
}

// ================= OUTCOME FIELD HELPERS =================

const R_RESULT_PATHS = [
  "realizedR",
  "pnlR",
  "closedR",
  "exitR",
  "resultR",
  "outcomeR",
  "netR",
  "rMultiple",
  "r",
  "realized.r",
  "result.r",
  "pnl.r"
];

const PNL_RESULT_PATHS = [
  "pnlPct",
  "pnlPercent",
  "realizedPnlPct",
  "closedPnlPct",
  "exitPnlPct",
  "resultPnlPct",
  "profitPct",
  "netPnlPct",
  "pnl",
  "realized.pnlPct",
  "result.pnlPct"
];

function getRawR(event) {
  const value = firstDefined(event, R_RESULT_PATHS);
  return toFiniteNumber(value, null);
}

function getRawPnlPct(event) {
  const value = firstDefined(event, PNL_RESULT_PATHS);
  return toFiniteNumber(value, null);
}

function hasNumericOutcome(event) {
  return getRawR(event) !== null || getRawPnlPct(event) !== null;
}

function hasExitSignal(event) {
  if (!event || typeof event !== "object") return false;

  if (event.closed === true) return true;
  if (event.isClosed === true) return true;
  if (event.exitPrice !== undefined && event.exitPrice !== null) return true;
  if (event.exit !== undefined && event.exit !== null) return true;
  if (event.closedAt || event.exitAt || event.exitTs) return true;

  const status = toKey(event?.status || event?.action || event?.exitReason || event?.reason, "");

  return (
    status.includes("CLOSED") ||
    status.includes("EXIT") ||
    status.includes("TP") ||
    status.includes("SL") ||
    status.includes("STOP") ||
    status.includes("BREAK_EVEN") ||
    status.includes("BREAKEVEN")
  );
}

function isClosed(event) {
  if (!isTradeLike(event)) return false;

  // Hard rule: exit-signaal zonder numerieke outcome telt niet als closed.
  // Voorkomt fake 0R / breakeven vervuiling.
  return hasExitSignal(event) && hasNumericOutcome(event);
}

// ================= FAIR WINRATE =================

function wilsonLowerBound(wins, total, z = FAIR_WINRATE_WILSON_Z) {
  const n = safeNumber(total, 0);
  const w = safeNumber(wins, 0);

  if (n <= 0) return 0;

  const p = clamp(w / n, 0, 1);
  const z2 = z * z;

  const numerator =
    p +
    z2 / (2 * n) -
    z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  const denominator = 1 + z2 / n;

  return clamp(numerator / denominator, 0, 1);
}

function bayesianAdjustedWinrate(wins, total) {
  const w = safeNumber(wins, 0);
  const n = safeNumber(total, 0);

  return (
    (w + FAIR_WINRATE_PRIOR_ALPHA) /
    (n + FAIR_WINRATE_PRIOR_ALPHA + FAIR_WINRATE_PRIOR_BETA)
  );
}

function calculateFairWinrateMeta({ wins, closed }) {
  const n = safeNumber(closed, 0);
  const w = safeNumber(wins, 0);

  if (n <= 0) {
    return {
      rawWinrateNum: 0,
      adjustedWinrateNum: 0,
      wilsonLowerBoundNum: 0,
      sampleConfidenceNum: 0,
      fairWinrateScore: 0
    };
  }

  const raw = clamp(w / n, 0, 1);
  const adjusted = bayesianAdjustedWinrate(w, n);
  const wilson = wilsonLowerBound(w, n);
  const sampleConfidence = clamp(n / FAIR_WINRATE_TARGET_CLOSED, 0, 1);

  const fairWinrateScore =
    wilson * 72 +
    adjusted * 20 +
    raw * 8;

  return {
    rawWinrateNum: round(raw * 100, 3),
    adjustedWinrateNum: round(adjusted * 100, 3),
    wilsonLowerBoundNum: round(wilson * 100, 3),
    sampleConfidenceNum: round(sampleConfidence * 100, 3),
    fairWinrateScore: round(fairWinrateScore, 3)
  };
}

// ================= BUCKETS =================

function bucketScore(value, prefix) {
  const n = normalizeScoreNumber(value);

  if (!Number.isFinite(n)) return `${prefix}_UNKNOWN`;
  if (n < 50) return `${prefix}_0_50`;
  if (n >= 100) return `${prefix}_95_100`;

  const floor = Math.floor(n / 5) * 5;
  const low = Math.max(50, Math.min(95, floor));
  const high = Math.min(100, low + 5);

  return `${prefix}_${low}_${high}`;
}

function bucketRR(value) {
  const n = toFiniteNumber(value, null);

  if (!Number.isFinite(n)) return "RR_UNKNOWN";
  if (n < 1) return "RR_LT_1p00";
  if (n >= 2.5) return "RR_2p50_PLUS";

  const low = Math.floor(n * 10) / 10;
  const high = low + 0.1;

  const clean = v => v.toFixed(2).replace(".", "p");

  return `RR_${clean(low)}_${clean(high)}`;
}

function bucketSpreadBps(value) {
  const n = toFiniteNumber(value, null);

  if (!Number.isFinite(n)) return "SPREAD_UNKNOWN";
  if (n < 5) return "SPREAD_LT_5BPS";
  if (n < 8) return "SPREAD_5_8BPS";
  if (n < 10) return "SPREAD_8_10BPS";
  if (n < 12) return "SPREAD_10_12BPS";
  if (n < 16) return "SPREAD_12_16BPS";
  if (n < 20) return "SPREAD_16_20BPS";
  if (n < 25) return "SPREAD_20_25BPS";

  return "SPREAD_GT_25BPS";
}

function bucketDepthUsd(value) {
  const n = toFiniteNumber(value, null);

  if (!Number.isFinite(n)) return "DEPTH_UNKNOWN";
  if (n < 10_000) return "DEPTH_LT_10K";
  if (n < 25_000) return "DEPTH_10K_25K";
  if (n < 50_000) return "DEPTH_25K_50K";
  if (n < 75_000) return "DEPTH_50K_75K";
  if (n < 100_000) return "DEPTH_75K_100K";
  if (n < 150_000) return "DEPTH_100K_150K";
  if (n < 250_000) return "DEPTH_150K_250K";

  return "DEPTH_GT_250K";
}

function normalizeFlow(event) {
  const raw = toKey(
    firstDefined(event, [
      "flow",
      "flowState",
      "marketFlow",
      "filterSnapshot.flow",
      "filterSnapshot.flowState",
      "setup.flow"
    ]),
    ""
  );

  if (!raw) return "FLOW_UNKNOWN";
  if (raw.includes("EXHAUST")) return "FLOW_EXHAUSTION";
  if (raw.includes("BUILD")) return "FLOW_BUILDING";
  if (raw.includes("TREND")) return "FLOW_TREND";
  if (raw.includes("NEUTRAL")) return "FLOW_NEUTRAL";
  if (raw.includes("ANY")) return "FLOW_ANY";

  return `FLOW_${raw}`;
}

function normalizeStage(event) {
  const raw = toKey(
    firstDefined(event, [
      "stage",
      "entryStage",
      "setupStage",
      "filterSnapshot.stage",
      "filterSnapshot.entryStage",
      "setup.stage"
    ]),
    ""
  );

  if (!raw) return "STAGE_UNKNOWN";
  if (raw.includes("ALMOST")) return "STAGE_ALMOST";
  if (raw.includes("ENTRY")) return "STAGE_ENTRY";
  if (raw.includes("CONFIRM")) return "STAGE_CONFIRMATION";
  if (raw.includes("PULLBACK")) return "STAGE_PULLBACK";
  if (raw.includes("ANY")) return "STAGE_ANY";

  return `STAGE_${raw}`;
}

function normalizeRsi(event) {
  const zone = toKey(
    firstDefined(event, [
      "rsiZone",
      "rsiState",
      "filterSnapshot.rsiZone",
      "filterSnapshot.rsiState",
      "rsi.zone"
    ]),
    ""
  );

  if (zone) {
    if (zone.includes("LOWER")) return "RSI_LOWER";
    if (zone.includes("UPPER")) return "RSI_UPPER";
    if (zone.includes("MID")) return "RSI_MID";
    if (zone.includes("OVERBOUGHT")) return "RSI_UPPER";
    if (zone.includes("OVERSOLD")) return "RSI_LOWER";
    if (zone.includes("ANY")) return "RSI_ANY";
  }

  const rsi = getRsiValue(event);

  if (!Number.isFinite(rsi)) return "RSI_UNKNOWN";
  if (rsi <= 35) return "RSI_LOWER";
  if (rsi >= 65) return "RSI_UPPER";

  return "RSI_MID";
}

function normalizeOb(event) {
  const raw = toKey(
    firstDefined(event, [
      "obBias",
      "orderbookBias",
      "orderBookBias",
      "bookBias",
      "filterSnapshot.obBias",
      "filterSnapshot.orderbookBias",
      "orderbook.bias",
      "book.bias"
    ]),
    ""
  );

  if (!raw) return "OB_UNKNOWN";
  if (raw.includes("BULL")) return "OB_BULLISH";
  if (raw.includes("BEAR")) return "OB_BEARISH";
  if (raw.includes("NEUTRAL")) return "OB_NEUTRAL";
  if (raw.includes("WITH")) return "OB_WITH";
  if (raw.includes("AGAINST")) return "OB_AGAINST";

  return `OB_${raw}`;
}

function normalizeBtc(event) {
  const raw = toKey(
    firstDefined(event, [
      "btcState",
      "btcRel",
      "btcRelative",
      "btcRelativeState",
      "filterSnapshot.btcState",
      "filterSnapshot.btcRel",
      "filterSnapshot.btcRelative",
      "market.btcState"
    ]),
    ""
  );

  if (!raw) return "BTC_UNKNOWN";
  if (raw.includes("BULL")) return "BTC_BULLISH";
  if (raw.includes("BEAR")) return "BTC_BEARISH";
  if (raw.includes("COUNTER")) return "BTC_COUNTER";
  if (raw.includes("WITH")) return "BTC_WITH";
  if (raw.includes("NEUTRAL")) return "BTC_NEUTRAL";

  return `BTC_${raw}`;
}

function normalizeFunding(event) {
  const raw = firstDefined(event, [
    "fundingState",
    "funding",
    "fundingRate",
    "filterSnapshot.fundingState",
    "filterSnapshot.funding",
    "filterSnapshot.fundingRate",
    "market.fundingRate"
  ]);

  const key = toKey(raw, "");

  if (key) {
    if (key.includes("OPTIMAL")) return "FUNDING_OPTIMAL";
    if (key.includes("CROWDED")) return "FUNDING_CROWDED";
    if (key.includes("EDGE_WEAK")) return "FUNDING_EDGE_WEAK";
    if (key.includes("OK")) return "FUNDING_OK";
    if (key.includes("NEUTRAL")) return "FUNDING_NEUTRAL";
  }

  const n = toFiniteNumber(raw, null);

  if (!Number.isFinite(n)) return "FUNDING_UNKNOWN";
  if (n >= 0.0008) return "FUNDING_POS_HIGH";
  if (n <= -0.0008) return "FUNDING_NEG_HIGH";
  if (Math.abs(n) <= 0.0002) return "FUNDING_NEUTRAL";

  return n > 0 ? "FUNDING_POS" : "FUNDING_NEG";
}

function normalizeTf(event) {
  const raw = toKey(
    firstDefined(event, [
      "tfStrength",
      "tfState",
      "timeframeStrength",
      "filterSnapshot.tfStrength",
      "filterSnapshot.tfState",
      "tf.strength"
    ]),
    ""
  );

  if (raw) {
    if (raw.includes("STRONG")) return "TF_STRONG";
    if (raw.includes("ALIGNED")) return "TF_STRONG";
    if (raw.includes("OK")) return "TF_OK";
    if (raw.includes("WEAK")) return "TF_WEAK";
    if (raw.includes("ANY")) return "TF_ANY";
  }

  const score = getTfScore(event);

  if (!Number.isFinite(score)) return "TF_UNKNOWN";
  if (score >= 75) return "TF_STRONG";
  if (score >= 55) return "TF_OK";

  return "TF_WEAK";
}

function normalizeSession(event) {
  const raw = toKey(
    firstDefined(event, [
      "session",
      "marketSession",
      "tradeSession",
      "filterSnapshot.session"
    ]),
    ""
  );

  if (raw) {
    if (raw.includes("ASIA")) return "SESSION_ASIA";
    if (raw.includes("EU")) return "SESSION_EU";
    if (raw.includes("LONDON")) return "SESSION_EU";
    if (raw.includes("US")) return "SESSION_US";
    if (raw.includes("NY")) return "SESSION_US";
  }

  const hour = new Date(getEventTs(event)).getUTCHours();

  if (hour >= 0 && hour < 7) return "SESSION_ASIA";
  if (hour >= 7 && hour < 13) return "SESSION_EU";
  if (hour >= 13 && hour < 21) return "SESSION_US";

  return "SESSION_ASIA";
}

// ================= FAMILY / PARENT EXTRACTION =================

function parseParentFromDefinition(event) {
  const definition = getDefinitionText(event);
  const match = definition.match(/\b(LONG|SHORT)_\d{1,3}\b/i);

  return match ? match[0].toUpperCase() : "";
}

function getParentFamilyId(event) {
  const direct = firstDefined(event, [
    "parentFamilyId",
    "mainFamilyId",
    "familyId",
    "analyzeFamilyId",
    "filterSnapshot.parentFamilyId",
    "filterSnapshot.mainFamilyId",
    "filterSnapshot.familyId",
    "filterSnapshot.family.id",
    "family.parentFamilyId",
    "family.mainFamilyId",
    "family.familyId",
    "family.id",
    "setup.familyId",
    "entry.familyId"
  ]);

  const directKey = toKey(direct, "");

  if (directKey && /\b(LONG|SHORT)_\d{1,3}\b/.test(directKey)) {
    return directKey.match(/\b(LONG|SHORT)_\d{1,3}\b/)?.[0] || directKey;
  }

  const parsed = parseParentFromDefinition(event);
  if (parsed) return parsed;

  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);

  return side ? `${side}_UNKNOWN` : "UNKNOWN_PARENT";
}

function getSide(event, parentFamilyId = "") {
  const side = normalizeSide(event?.side || event?.direction || event?.tradeSide);

  if (side) return side;
  if (parentFamilyId.startsWith("LONG")) return "LONG";
  if (parentFamilyId.startsWith("SHORT")) return "SHORT";

  return "";
}

function getParentDefinition(event, parentFamilyId) {
  const definition = getDefinitionText(event);

  if (definition) return definition;

  return parentFamilyId || "UNKNOWN_PARENT";
}

function getConfluenceBucket(event) {
  return bucketScore(
    getNumericFeature(
      event,
      [
        "confluence",
        "confluenceScore",
        "confidence",
        "confidenceScore",
        "filterSnapshot.confluence",
        "filterSnapshot.confluenceScore",
        "filterSnapshot.confidence",
        "filterSnapshot.confidenceScore",
        "scores.confluence",
        "scores.confidence",
        "setup.confluence"
      ],
      "CONF"
    ),
    "CONF"
  );
}

function getSniperBucket(event) {
  return bucketScore(
    getNumericFeature(
      event,
      [
        "sniperScore",
        "sniper",
        "filterSnapshot.sniperScore",
        "filterSnapshot.sniper",
        "scores.sniperScore",
        "scores.sniper",
        "setup.sniperScore"
      ],
      "SNIPER"
    ),
    "SNIPER"
  );
}

function getScoreBucket(event) {
  return bucketScore(
    getNumericFeature(
      event,
      [
        "score",
        "moveScore",
        "entryScore",
        "finalScore",
        "filterSnapshot.score",
        "filterSnapshot.moveScore",
        "filterSnapshot.entryScore",
        "scores.total",
        "scores.moveScore",
        "setup.score"
      ],
      "SCORE"
    ),
    "SCORE"
  );
}

function buildSubParts(event, parentFamilyId) {
  return [
    parentFamilyId,
    getConfluenceBucket(event),
    getSniperBucket(event),
    getScoreBucket(event),
    bucketRR(getRRFeature(event)),
    normalizeFlow(event),
    normalizeStage(event),
    normalizeBtc(event),
    normalizeFunding(event),
    normalizeTf(event),
    normalizeSession(event)
  ];
}

function buildMicroParts(event, parentFamilyId) {
  return [
    parentFamilyId,
    getConfluenceBucket(event),
    getSniperBucket(event),
    getScoreBucket(event),
    bucketRR(getRRFeature(event)),
    normalizeFlow(event),
    normalizeStage(event),
    normalizeRsi(event),
    normalizeOb(event),
    bucketSpreadBps(getSpreadBps(event)),
    bucketDepthUsd(getDepthUsd(event)),
    normalizeBtc(event),
    normalizeFunding(event),
    normalizeTf(event),
    normalizeSession(event)
  ];
}

function hashString(value) {
  const text = String(value || "");
  let hash = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return Math.abs(hash >>> 0).toString(36).toUpperCase();
}

function buildRowId({ level, side, parentFamilyId, definition }) {
  const cleanSide = side || "NA";
  const cleanParent = cleanToken(parentFamilyId, "UNKNOWN_PARENT");
  const hash = hashString(definition).slice(0, 8);

  return `${level}_${cleanSide}_${cleanParent}_${hash}`;
}

// ================= OUTCOME =================

function getRealizedR(event) {
  const direct = getRawR(event);

  if (direct !== null) return direct;

  const exitReason = toKey(event?.exitReason || event?.reason || event?.status, "");

  if (exitReason.includes("BE") || exitReason.includes("BREAKEVEN")) return 0;

  return 0;
}

function getPnlPct(event) {
  return getRawPnlPct(event) ?? 0;
}

function classifyOutcome(event) {
  if (!isClosed(event)) {
    return {
      closed: false,
      r: 0,
      pnlPct: 0,
      win: false,
      loss: false,
      breakeven: false
    };
  }

  const r = getRealizedR(event);
  const pnlPct = getPnlPct(event);

  if (r > EPSILON_R || pnlPct > EPSILON_R) {
    return {
      closed: true,
      r,
      pnlPct,
      win: true,
      loss: false,
      breakeven: false
    };
  }

  if (r < -EPSILON_R || pnlPct < -EPSILON_R) {
    return {
      closed: true,
      r,
      pnlPct,
      win: false,
      loss: true,
      breakeven: false
    };
  }

  return {
    closed: true,
    r: 0,
    pnlPct,
    win: false,
    loss: false,
    breakeven: true
  };
}

// ================= GROUPING =================

function createAccumulator({ id, level, side, parentFamilyId, definition, definitionParts }) {
  return {
    id,
    familyId: id,
    level,
    side,
    parent: parentFamilyId,
    parentFamilyId,
    definition,
    definitionParts,

    observed: 0,
    trades: 0,
    closed: 0,
    open: 0,
    pendingOutcome: 0,
    unresolved: 0,

    wins: 0,
    losses: 0,
    breakeven: 0,

    totalR: 0,
    grossWinR: 0,
    grossLossR: 0,

    totalPnlPct: 0,

    firstTs: null,
    lastTs: null,

    tradeIds: new Set()
  };
}

function touchAccumulator(acc, event) {
  const ts = getEventTs(event);
  const tradeId = getTradeId(event);
  const outcome = classifyOutcome(event);

  acc.observed += 1;
  acc.trades += 1;

  if (tradeId) acc.tradeIds.add(tradeId);

  if (!acc.firstTs || ts < acc.firstTs) acc.firstTs = ts;
  if (!acc.lastTs || ts > acc.lastTs) acc.lastTs = ts;

  if (!outcome.closed) {
    acc.open += 1;

    if (hasExitSignal(event) && !hasNumericOutcome(event)) {
      acc.pendingOutcome += 1;
      acc.unresolved += 1;
    }

    return acc;
  }

  acc.closed += 1;
  acc.totalR += outcome.r;
  acc.totalPnlPct += outcome.pnlPct;

  if (outcome.win) {
    acc.wins += 1;
    acc.grossWinR += Math.max(0, outcome.r);
    return acc;
  }

  if (outcome.loss) {
    acc.losses += 1;
    acc.grossLossR += Math.abs(outcome.r);
    return acc;
  }

  acc.breakeven += 1;
  return acc;
}

function applySampleCap(status, closed) {
  const rank = STATUS_RANK[status] || 0;

  if (closed < 20 && rank > STATUS_RANK.STABLE) return "STABLE";
  if (closed < 50 && rank > STATUS_RANK.GOOD) return "GOOD";
  if (closed < 100 && rank > STATUS_RANK.HOT) return "HOT";

  return status;
}

function classifyStatus(row, minClosed) {
  const observed = safeNumber(row.observed, 0);
  const closed = safeNumber(row.closed, 0);
  const winrateNum = safeNumber(row.winrateNum, 0);
  const fairScore = safeNumber(row.fairWinrateScore, 0);
  const wilson = safeNumber(row.wilsonLowerBoundNum, 0);

  if (observed <= 0) return "EMPTY";
  if (closed < minClosed) return "COLLECTING";

  let status = "BAD";

  // Status is winrate-first. avgR/PF blijven diagnostiek en tie-break, geen primaire gate.
  if (fairScore >= 72 && wilson >= 62 && winrateNum >= 72) {
    status = "ELITE";
  } else if (fairScore >= 62 && wilson >= 54 && winrateNum >= 62) {
    status = "HOT";
  } else if (fairScore >= 54 && wilson >= 46 && winrateNum >= 56) {
    status = "GOOD";
  } else if (fairScore >= 48 && winrateNum >= 50) {
    status = "STABLE";
  } else if (fairScore >= 42 && winrateNum >= 45) {
    status = "CANDIDATE";
  }

  if (status === "BAD") return status;

  return applySampleCap(status, closed);
}

function finalizeAccumulator(acc, minClosed) {
  const closed = safeNumber(acc.closed, 0);
  const wins = safeNumber(acc.wins, 0);
  const grossWinR = safeNumber(acc.grossWinR, 0);
  const grossLossR = safeNumber(acc.grossLossR, 0);

  const winrateNum = closed > 0 ? (wins / closed) * 100 : 0;
  const avgR = closed > 0 ? acc.totalR / closed : 0;
  const avgPnlPct = closed > 0 ? acc.totalPnlPct / closed : 0;

  let profitFactor = 0;

  if (grossLossR > 0) {
    profitFactor = grossWinR / grossLossR;
  } else if (grossWinR > 0) {
    profitFactor = PROFIT_FACTOR_NO_LOSS;
  }

  const fair = calculateFairWinrateMeta({
    wins,
    closed
  });

  const row = {
    ...acc,

    tradeCountUnique: acc.tradeIds.size,

    totalR: round(acc.totalR, 3),
    avgR: round(avgR, 3),
    grossWinR: round(grossWinR, 3),
    grossLossR: round(grossLossR, 3),

    totalPnlPct: round(acc.totalPnlPct, 3),
    avgPnlPct: round(avgPnlPct, 3),

    winrateNum: round(winrateNum, 3),
    winrate: pct(winrateNum, 1),

    adjustedWinrateNum: fair.adjustedWinrateNum,
    adjustedWinrate: pct(fair.adjustedWinrateNum, 1),

    wilsonLowerBoundNum: fair.wilsonLowerBoundNum,
    wilsonLowerBound: pct(fair.wilsonLowerBoundNum, 1),

    sampleConfidenceNum: fair.sampleConfidenceNum,
    sampleConfidence: pct(fair.sampleConfidenceNum, 1),

    fairWinrateScore: fair.fairWinrateScore,
    rankingMetric: "FAIR_WINRATE_WILSON_BAYES",

    profitFactor: round(profitFactor, 3),
    profitFactorR: round(profitFactor, 3),

    sampleReady: closed >= minClosed
  };

  row.status = classifyStatus(row, minClosed);
  row.statusRank = STATUS_RANK[row.status] || 0;

  delete row.tradeIds;

  return row;
}

function sortRows(a, b) {
  const statusDiff = safeNumber(b.statusRank, 0) - safeNumber(a.statusRank, 0);
  if (statusDiff !== 0) return statusDiff;

  const fairDiff = safeNumber(b.fairWinrateScore, 0) - safeNumber(a.fairWinrateScore, 0);
  if (fairDiff !== 0) return fairDiff;

  const wilsonDiff = safeNumber(b.wilsonLowerBoundNum, 0) - safeNumber(a.wilsonLowerBoundNum, 0);
  if (wilsonDiff !== 0) return wilsonDiff;

  const adjustedDiff = safeNumber(b.adjustedWinrateNum, 0) - safeNumber(a.adjustedWinrateNum, 0);
  if (adjustedDiff !== 0) return adjustedDiff;

  const winrateDiff = safeNumber(b.winrateNum, 0) - safeNumber(a.winrateNum, 0);
  if (winrateDiff !== 0) return winrateDiff;

  const confidenceDiff = safeNumber(b.sampleConfidenceNum, 0) - safeNumber(a.sampleConfidenceNum, 0);
  if (confidenceDiff !== 0) return confidenceDiff;

  const closedDiff = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  if (closedDiff !== 0) return closedDiff;

  // Tie-breaks only.
  const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
  if (avgRDiff !== 0) return avgRDiff;

  const pfDiff = safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0);
  if (pfDiff !== 0) return pfDiff;

  const totalRDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
  if (totalRDiff !== 0) return totalRDiff;

  return String(a.id).localeCompare(String(b.id));
}

function buildLevelRows(events, level, minClosed) {
  const groups = new Map();

  for (const event of safeArray(events)) {
    if (!isTradeLike(event)) continue;

    const parentFamilyId = getParentFamilyId(event);
    const side = getSide(event, parentFamilyId) || "UNKNOWN";

    let definitionParts = [];
    let definition = "";
    let key = "";

    if (level === LEVELS.PARENT) {
      definitionParts = [parentFamilyId];
      definition = getParentDefinition(event, parentFamilyId);
      key = `${level}|${side}|${parentFamilyId}`;
    }

    if (level === LEVELS.SUB) {
      definitionParts = buildSubParts(event, parentFamilyId);
      definition = definitionParts.join(" | ");
      key = `${level}|${side}|${definition}`;
    }

    if (level === LEVELS.MICRO) {
      definitionParts = buildMicroParts(event, parentFamilyId);
      definition = definitionParts.join(" | ");
      key = `${level}|${side}|${definition}`;
    }

    if (!key) continue;

    const existing = groups.get(key);

    if (existing) {
      touchAccumulator(existing, event);
      continue;
    }

    const id = buildRowId({
      level,
      side,
      parentFamilyId,
      definition
    });

    const acc = createAccumulator({
      id,
      level,
      side,
      parentFamilyId,
      definition,
      definitionParts
    });

    touchAccumulator(acc, event);
    groups.set(key, acc);
  }

  return Array.from(groups.values())
    .map(acc => finalizeAccumulator(acc, minClosed))
    .sort(sortRows);
}

// ================= ALLOWLIST / BEST =================

function minStatusRank(status) {
  return STATUS_RANK[toKey(status, "STABLE")] || STATUS_RANK.STABLE;
}

function getRowsForLevel(analysis, level = "micro") {
  const normalized = toKey(level, "MICRO");

  if (normalized === "PARENT") return safeArray(analysis?.parentFamilies);
  if (normalized === "SUB") return safeArray(analysis?.subFamilies);
  if (normalized === "ALLOWLIST") return safeArray(analysis?.allowlists?.micro);

  return safeArray(analysis?.microFamilies);
}

function isAllowedRow(row, options = {}) {
  const minStatus = toKey(options.minStatus || "STABLE", "STABLE");
  const minClosed = safeNumber(options.minClosed, 0);

  // Winrate-first default:
  // avgR/PF zijn optionele hard filters, niet standaard actief.
  const minAvgR = options.minAvgR === undefined
    ? -999
    : safeNumber(options.minAvgR, -999);

  const minProfitFactor = options.minProfitFactor === undefined
    ? 0
    : safeNumber(options.minProfitFactor, 0);

  const minFairWinrateScore = options.minFairWinrateScore === undefined
    ? 0
    : safeNumber(options.minFairWinrateScore, 0);

  if (!row) return false;
  if (safeNumber(row.closed, 0) < minClosed) return false;
  if ((STATUS_RANK[row.status] || 0) < minStatusRank(minStatus)) return false;
  if (safeNumber(row.fairWinrateScore, 0) < minFairWinrateScore) return false;
  if (safeNumber(row.avgR, 0) < minAvgR) return false;
  if (safeNumber(row.profitFactor, 0) < minProfitFactor) return false;

  return true;
}

function bestRow(rows, side, options = {}) {
  const minClosed = safeNumber(options.minClosed, 0);
  const minStatus = options.minStatus || "STABLE";

  return safeArray(rows)
    .filter(row => normalizeSide(row.side) === side)
    .filter(row => isAllowedRow(row, { ...options, minClosed, minStatus }))
    .sort(sortRows)[0] || null;
}

export function getBestMainLongShort(analysis, options = {}) {
  const level = options.level || "micro";
  const rows = getRowsForLevel(analysis, level);

  const minClosed = safeNumber(
    options.minClosed,
    level === "parent"
      ? analysis?.config?.minParentClosed
      : level === "sub"
        ? analysis?.config?.minSubClosed
        : analysis?.config?.minMicroClosed
  );

  return {
    ok: Boolean(analysis?.ok),
    mode: "MAIN",
    level,
    minClosed,
    rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
    optimizeFor: "WINRATE",
    pnlIsPrimary: false,

    bestLong: bestRow(rows, "LONG", {
      minClosed,
      minStatus: options.minStatus || "STABLE",
      minAvgR: options.minAvgR,
      minProfitFactor: options.minProfitFactor,
      minFairWinrateScore: options.minFairWinrateScore
    }),

    bestShort: bestRow(rows, "SHORT", {
      minClosed,
      minStatus: options.minStatus || "STABLE",
      minAvgR: options.minAvgR,
      minProfitFactor: options.minProfitFactor,
      minFairWinrateScore: options.minFairWinrateScore
    })
  };
}

export function buildMainDiscordAllowlist(analysis, options = {}) {
  const level = options.level || "micro";
  const rows = getRowsForLevel(analysis, level);

  const minClosed = safeNumber(
    options.minClosed,
    level === "parent"
      ? analysis?.config?.minParentClosed
      : level === "sub"
        ? analysis?.config?.minSubClosed
        : analysis?.config?.minMicroClosed
  );

  const limit = Math.max(1, safeNumber(options.limit, 25));

  return safeArray(rows)
    .filter(row => isAllowedRow(row, {
      minClosed,
      minStatus: options.minStatus || "STABLE",
      minAvgR: options.minAvgR,
      minProfitFactor: options.minProfitFactor,
      minFairWinrateScore: options.minFairWinrateScore
    }))
    .sort(sortRows)
    .slice(0, limit)
    .map(row => ({
      id: row.id,
      familyId: row.familyId,
      parentFamilyId: row.parentFamilyId,
      parent: row.parent,
      level: row.level,
      side: row.side,
      status: row.status,

      closed: row.closed,
      wins: row.wins,
      losses: row.losses,
      breakeven: row.breakeven,

      winrate: row.winrate,
      winrateNum: row.winrateNum,

      adjustedWinrate: row.adjustedWinrate,
      adjustedWinrateNum: row.adjustedWinrateNum,
      wilsonLowerBound: row.wilsonLowerBound,
      wilsonLowerBoundNum: row.wilsonLowerBoundNum,
      sampleConfidence: row.sampleConfidence,
      sampleConfidenceNum: row.sampleConfidenceNum,
      fairWinrateScore: row.fairWinrateScore,
      rankingMetric: row.rankingMetric,

      totalR: row.totalR,
      avgR: row.avgR,
      profitFactor: row.profitFactor,
      profitFactorR: row.profitFactorR,
      totalPnlPct: row.totalPnlPct,

      definition: row.definition,
      definitionParts: row.definitionParts
    }));
}

// ================= SUMMARY =================

function countByStatus(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map(status => [status, 0]));

  for (const row of safeArray(rows)) {
    const status = toKey(row.status, "EMPTY");

    counts[status] = safeNumber(counts[status], 0) + 1;
  }

  return counts;
}

function summarizeEvents(events) {
  const summary = {
    observed: 0,
    trades: 0,
    closed: 0,
    open: 0,
    pendingOutcome: 0,
    unresolved: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    totalR: 0,
    totalPnlPct: 0
  };

  for (const event of safeArray(events)) {
    if (!isTradeLike(event)) continue;

    const outcome = classifyOutcome(event);

    summary.observed += 1;
    summary.trades += 1;

    if (!outcome.closed) {
      summary.open += 1;

      if (hasExitSignal(event) && !hasNumericOutcome(event)) {
        summary.pendingOutcome += 1;
        summary.unresolved += 1;
      }

      continue;
    }

    summary.closed += 1;
    summary.totalR += outcome.r;
    summary.totalPnlPct += outcome.pnlPct;

    if (outcome.win) summary.wins += 1;
    else if (outcome.loss) summary.losses += 1;
    else summary.breakeven += 1;
  }

  const closed = safeNumber(summary.closed, 0);
  const winrateNum = closed > 0 ? (summary.wins / closed) * 100 : 0;
  const fair = calculateFairWinrateMeta({
    wins: summary.wins,
    closed
  });

  return {
    ...summary,
    totalR: round(summary.totalR, 3),
    avgR: closed > 0 ? round(summary.totalR / closed, 3) : 0,
    totalPnlPct: round(summary.totalPnlPct, 3),
    avgPnlPct: closed > 0 ? round(summary.totalPnlPct / closed, 3) : 0,

    winrateNum: round(winrateNum, 3),
    winrate: pct(winrateNum, 1),

    adjustedWinrateNum: fair.adjustedWinrateNum,
    adjustedWinrate: pct(fair.adjustedWinrateNum, 1),
    wilsonLowerBoundNum: fair.wilsonLowerBoundNum,
    wilsonLowerBound: pct(fair.wilsonLowerBoundNum, 1),
    sampleConfidenceNum: fair.sampleConfidenceNum,
    sampleConfidence: pct(fair.sampleConfidenceNum, 1),
    fairWinrateScore: fair.fairWinrateScore,

    trueWinLossWinrateNum:
      summary.wins + summary.losses > 0
        ? round((summary.wins / (summary.wins + summary.losses)) * 100, 3)
        : 0
  };
}

// ================= MAIN BUILDER =================

export function buildMainFamilyMicroAnalysis(events, options = {}) {
  const selectedEvents = safeArray(events).filter(isTradeLike);

  const minParentClosed = Math.max(
    1,
    Math.round(safeNumber(options.minParentClosed, options.minClosed ?? DEFAULT_MIN_PARENT_CLOSED))
  );

  const minSubClosed = Math.max(
    1,
    Math.round(safeNumber(options.minSubClosed, DEFAULT_MIN_SUB_CLOSED))
  );

  const minMicroClosed = Math.max(
    1,
    Math.round(safeNumber(options.minMicroClosed, DEFAULT_MIN_MICRO_CLOSED))
  );

  const parentFamilies = buildLevelRows(selectedEvents, LEVELS.PARENT, minParentClosed);
  const subFamilies = buildLevelRows(selectedEvents, LEVELS.SUB, minSubClosed);
  const microFamilies = buildLevelRows(selectedEvents, LEVELS.MICRO, minMicroClosed);

  const analysis = {
    ok: true,
    enabled: true,
    mode: options.mode || "MAIN",
    profile: options.profile || "MAIN",
    generatedAt: new Date().toISOString(),

    config: {
      minParentClosed,
      minSubClosed,
      minMicroClosed,
      familyCountLong: safeNumber(options.familyCountLong, 50),
      familyCountShort: safeNumber(options.familyCountShort, 50),

      rankingMetric: "FAIR_WINRATE_WILSON_BAYES",
      optimizeFor: "WINRATE",
      pnlIsPrimary: false,

      fairWinrate: {
        targetClosed: FAIR_WINRATE_TARGET_CLOSED,
        wilsonZ: FAIR_WINRATE_WILSON_Z,
        priorAlpha: FAIR_WINRATE_PRIOR_ALPHA,
        priorBeta: FAIR_WINRATE_PRIOR_BETA,
        formula: "fairWinrateScore = wilsonLowerBound*72 + bayesianAdjustedWinrate*20 + rawWinrate*8"
      },

      note: "Microfamilies gebruiken alleen entry-known velden. Outcome-data wordt gebruikt voor fair-winrate ranking/statistiek. avgR/PF zijn tie-breaks, niet primair."
    },

    summary: {
      ...summarizeEvents(selectedEvents),
      parentFamilies: parentFamilies.length,
      subFamilies: subFamilies.length,
      microFamilies: microFamilies.length,
      parentStatusCounts: countByStatus(parentFamilies),
      subStatusCounts: countByStatus(subFamilies),
      microStatusCounts: countByStatus(microFamilies)
    },

    parentFamilies,
    subFamilies,
    microFamilies,

    allowlists: {
      parent: [],
      sub: [],
      micro: []
    }
  };

  analysis.allowlists.parent = buildMainDiscordAllowlist(analysis, {
    level: "parent",
    minClosed: minParentClosed,
    minStatus: "STABLE",
    limit: 25
  });

  analysis.allowlists.sub = buildMainDiscordAllowlist(analysis, {
    level: "sub",
    minClosed: minSubClosed,
    minStatus: "STABLE",
    limit: 25
  });

  analysis.allowlists.micro = buildMainDiscordAllowlist(analysis, {
    level: "micro",
    minClosed: minMicroClosed,
    minStatus: "STABLE",
    limit: 25
  });

  return analysis;
}

// ================= BACKWARD-COMPAT EXPORTS =================

export const buildFamilyMicroAnalysis = buildMainFamilyMicroAnalysis;
export const buildMicroFamilyAnalysis = buildMainFamilyMicroAnalysis;
export const buildFamilyMicroReport = buildMainFamilyMicroAnalysis;
export const buildMicroReport = buildMainFamilyMicroAnalysis;

export const getBestLongShort = getBestMainLongShort;
export const getBestMicroLongShort = getBestMainLongShort;

export const buildDiscordAllowlist = buildMainDiscordAllowlist;
export const buildMicroAllowlist = buildMainDiscordAllowlist;

export default {
  buildMainFamilyMicroAnalysis,
  buildFamilyMicroAnalysis,
  buildMicroFamilyAnalysis,
  buildFamilyMicroReport,
  buildMicroReport,
  getBestMainLongShort,
  getBestLongShort,
  getBestMicroLongShort,
  buildMainDiscordAllowlist,
  buildDiscordAllowlist,
  buildMicroAllowlist
};