// lib/microRotationGate.js

const DEFAULTS = {
  minEntryScore: 55,
  minAlmostScore: 75,
  minConfluence: 60,
  minSniperScore: 60,
  minPlannedRR: 1.05,

  // Zet true voor harde weekly-rotation filtering.
  strictWeeklyRotation: false,

  // Laat entries door wanneer er nog geen actieve micro-family allowlist is.
  allowBootstrapWhenRotationEmpty: true,

  // false = actieve weekly micro-family lijst wordt niet omzeild door GOD.
  // true = GOD mag buiten allowlist alsnog door.
  allowGodSoftPass: false,

  // false = disabled/lege rotation mag bootstrappen.
  // true = disabled rotation blokt hard.
  blockWhenRotationDisabled: false,

  maxFamilyIdsChecked: 24,
  maxActiveFamilyIdsReturned: 250,
};

const PROFIT_FACTOR_NO_LOSS = 999;

// ================= GENERIC HELPERS =================

const toNum = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const cleanKey = value => {
  const raw = String(value ?? "UNKNOWN").trim().toUpperCase();

  return raw
    .replace(/\[object object\]/gi, "")
    .replace(/\{.*?\}/g, "")
    .replace(/[^A-Z0-9.%+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "UNKNOWN";
};

const uniq = arr => [
  ...new Set(
    (Array.isArray(arr) ? arr : [])
      .filter(Boolean)
      .map(cleanKey)
      .filter(key => key && key !== "UNKNOWN")
  )
];

const isPlainObject = value => (
  value &&
  typeof value === "object" &&
  !Array.isArray(value)
);

const normalizeRawText = value => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();

  return "";
};

const getAt = (source, path) => {
  if (!source || !path) return undefined;

  const parts = String(path).split(".");
  let current = source;

  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }

  return current;
};

const firstDefined = (source, paths) => {
  for (const path of Array.isArray(paths) ? paths : []) {
    const value = getAt(source, path);

    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
};

const normalizeTs = (value, fallback = Date.now()) => {
  if (value instanceof Date) return value.getTime();

  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  return fallback;
};

const getEventTs = (event, fallback = Date.now()) => {
  return normalizeTs(
    event?.analyzeUpdatedAt ??
      event?.openedAt ??
      event?.entryAt ??
      event?.entryTs ??
      event?.createdAt ??
      event?.closedAt ??
      event?.exitAt ??
      event?.exitTs ??
      event?.updatedAt ??
      event?.analyzeTs ??
      event?.ts,
    fallback
  );
};

const limitArray = (value, limit) => {
  const max = Math.max(1, toNum(limit, DEFAULTS.maxActiveFamilyIdsReturned));
  return Array.isArray(value) ? value.slice(0, max) : [];
};

// ================= ID HELPERS =================

const looksLikeFamilyId = value => {
  const key = cleanKey(value);

  return (
    key.startsWith("MICRO_") ||
    key.startsWith("MF_") ||
    key.startsWith("FAMILY_")
  );
};

const isRealMicroFamilyId = value => {
  const key = cleanKey(value);

  return (
    key.startsWith("MICRO_") &&
    key.split("_").length >= 4
  );
};

const isBroadFallbackFamilyId = value => {
  const key = cleanKey(value);

  if (/^MF_(LONG|SHORT)$/.test(key)) return true;
  if (/^MF_(LONG|SHORT)_(ENTRY|ALMOST|HOLD|EXIT)$/.test(key)) return true;
  if (/^MF_(LONG|SHORT)_(GOD|A|B|C|RUNNER)$/.test(key)) return true;
  if (/^FAMILY_(LONG|SHORT)$/.test(key)) return true;
  if (/^MICRO_(LONG|SHORT)$/.test(key)) return true;

  return false;
};

const isPreferredPrimaryFamilyId = value => {
  const key = cleanKey(value);

  if (isRealMicroFamilyId(key)) return true;

  return (
    key.startsWith("MF_") &&
    !isBroadFallbackFamilyId(key) &&
    key.split("_").length >= 6
  );
};

const normalizeFamilyIds = value => {
  if (!value) return [];
  if (Array.isArray(value)) return uniq(value.flatMap(normalizeFamilyIds));
  if (looksLikeFamilyId(value)) return [cleanKey(value)];

  return [];
};

const extractParentFamilyId = value => {
  const key = cleanKey(value);
  const match = key.match(/(?:^|_)(LONG|SHORT)_\d{1,3}(?:_|$)/);

  if (!match) return "";
  return match[0].replace(/^_+|_+$/g, "");
};

// ================= SIDE / SETUP NORMALIZATION =================

const normalizeSide = value => {
  const v = cleanKey(value);

  if (["BULL", "BUY", "LONG", "BID"].includes(v)) return "bull";
  if (["BEAR", "SELL", "SHORT", "ASK"].includes(v)) return "bear";

  if (v.includes("BULL") || v.includes("LONG")) return "bull";
  if (v.includes("BEAR") || v.includes("SHORT")) return "bear";

  return "unknown";
};

const normalizeRotationSide = (value, side = "unknown") => {
  const v = cleanKey(value);

  if (["LONG", "BULL", "BUY", "BID"].includes(v)) return "LONG";
  if (["SHORT", "BEAR", "SELL", "ASK"].includes(v)) return "SHORT";

  if (v.includes("LONG") || v.includes("BULL")) return "LONG";
  if (v.includes("SHORT") || v.includes("BEAR")) return "SHORT";

  if (side === "bull") return "LONG";
  if (side === "bear") return "SHORT";

  return "UNKNOWN";
};

const normalizeStage = value => {
  const v = cleanKey(value);

  if (v.includes("ALMOST")) return "ALMOST";
  if (v.includes("HOLD")) return "HOLD";
  if (v.includes("EXIT")) return "EXIT";
  if (v.includes("ENTRY")) return "ENTRY";
  if (v.includes("CONFIRM")) return "CONFIRMATION";
  if (v.includes("PULLBACK")) return "PULLBACK";

  return "ENTRY";
};

const normalizeSetupClass = (value, signal = {}) => {
  const v = cleanKey(value);

  if (["GOD", "A", "B", "C", "RUNNER", "A_SHORT_EXCEPTION", "B_TREND_PROBE"].includes(v)) {
    return v;
  }

  const score = toNum(signal.score ?? signal.moveScore ?? signal.entryScore ?? signal.finalScore, 0);

  const confluence = toNum(
    signal.effectiveConfluence ??
      signal.confluence ??
      signal.rawConfluence ??
      signal.fallbackConfluence,
    0
  );

  const sniperScore = toNum(
    signal.sniperScore ??
      signal.fallbackSniperScore ??
      signal.rawSniperScore,
    0
  );

  if (score >= 90 || confluence >= 90 || sniperScore >= 88) return "GOD";
  if (score >= 80 || confluence >= 80 || sniperScore >= 80) return "A";
  if (score >= 70 || confluence >= 70 || sniperScore >= 70) return "B";

  return "C";
};

const normalizeReason = (value, stage, setupClass) => {
  const v = cleanKey(value);

  if (v !== "UNKNOWN") return v;
  if (setupClass === "GOD") return "GOD_ENTRY";
  if (setupClass === "A_SHORT_EXCEPTION") return "BTC_BULLISH_BEAR_EXCEPTION";
  if (setupClass === "B_TREND_PROBE") return "BULLISH_MID_TREND_PROBE";
  if (stage === "ALMOST") return "ALMOST_ENTRY";

  return `${setupClass}_ENTRY`;
};

// ================= MICRO-ANALYZER COMPAT HELPERS =================

const parseNumbersFromText = value => {
  const raw = normalizeRawText(value)
    .replace(/(\d+)p(\d+)/gi, "$1.$2")
    .replace(/,/g, ".");

  if (!raw) return [];

  const matches = raw.match(/-?\d+(?:\.\d+)?/g) || [];

  return matches
    .map(Number)
    .filter(Number.isFinite);
};

const rangeMidpointFromText = value => {
  const nums = parseNumbersFromText(value);

  if (!nums.length) return null;
  if (nums.length === 1) return nums[0];

  return (nums[0] + nums[1]) / 2;
};

const toFiniteNumber = (value, fallback = null) => {
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

  if (isPlainObject(value)) {
    const candidates = [
      value.value,
      value.score,
      value.num,
      value.number,
      value.pct,
      value.percent,
      value.percentage,
      value.current,
      value.raw,
      value.data?.value,
      value.data?.score,
    ];

    for (const candidate of candidates) {
      const n = toFiniteNumber(candidate, null);

      if (Number.isFinite(n)) return n;
    }
  }

  return fallback;
};

const normalizeScoreNumber = value => {
  const n = toFiniteNumber(value, null);

  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return n * 100;

  return n;
};

const bucketScoreFine = (value, prefix) => {
  const n = normalizeScoreNumber(value);

  if (!Number.isFinite(n)) return `${prefix}_UNKNOWN`;
  if (n < 50) return `${prefix}_0_50`;
  if (n >= 100) return `${prefix}_95_100`;

  const floor = Math.floor(n / 5) * 5;
  const low = Math.max(50, Math.min(95, floor));
  const high = Math.min(100, low + 5);

  return `${prefix}_${low}_${high}`;
};

const bucketRR = value => {
  const n = toFiniteNumber(value, null);

  if (!Number.isFinite(n)) return "RR_UNKNOWN";
  if (n < 1) return "RR_LT_1p00";
  if (n >= 2.5) return "RR_2p50_PLUS";

  const low = Math.floor(n * 10) / 10;
  const high = low + 0.1;
  const clean = v => v.toFixed(2).replace(".", "p");

  return `RR_${clean(low)}_${clean(high)}`;
};

const getSpreadBps = signal => {
  const directBps = toFiniteNumber(
    firstDefined(signal, [
      "spreadBps",
      "spreadBP",
      "spread_bps",
      "filterSnapshot.spreadBps",
      "filterSnapshot.spreadBP",
      "orderbook.spreadBps",
      "book.spreadBps",
    ]),
    null
  );

  if (Number.isFinite(directBps)) return directBps;

  const pct = toFiniteNumber(
    firstDefined(signal, [
      "spreadPct",
      "spreadPercent",
      "spread",
      "filterSnapshot.spreadPct",
      "filterSnapshot.spreadPercent",
      "orderbook.spreadPct",
      "book.spreadPct",
    ]),
    null
  );

  if (!Number.isFinite(pct)) return null;

  const n = Math.abs(pct);

  if (n <= 0.05) return n * 10000;
  if (n <= 10) return n * 100;

  return n;
};

const getDepthUsd = signal => {
  return toFiniteNumber(
    firstDefined(signal, [
      "depthMinUsd1p",
      "depthUsd1p",
      "depthUsd",
      "minDepthUsd",
      "liquidityUsd",
      "filterSnapshot.depthMinUsd1p",
      "filterSnapshot.depthUsd1p",
      "filterSnapshot.depthUsd",
      "orderbook.depthMinUsd1p",
      "book.depthMinUsd1p",
    ]),
    null
  );
};

const bucketSpreadBps = value => {
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
};

const bucketDepthUsd = value => {
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
};

const getRRFeature = signal => {
  return firstDefined(signal, [
    "rr",
    "baseRR",
    "finalRR",
    "finalRr",
    "plannedRR",
    "setupEvalRR",
    "riskReward",
    "riskRewardRatio",
    "riskRewardR",
    "filterSnapshot.rr",
    "filterSnapshot.baseRR",
    "filterSnapshot.finalRR",
    "filterSnapshot.finalRr",
    "filterSnapshot.plannedRR",
    "filterSnapshot.setupEvalRR",
    "filterSnapshot.riskReward",
    "filterSnapshot.riskRewardRatio",
    "setup.rr",
    "entry.rr",
  ]);
};

const normalizeFlow = signal => {
  const raw = cleanKey(
    firstDefined(signal, [
      "flow",
      "flowState",
      "marketFlow",
      "filterSnapshot.flow",
      "filterSnapshot.flowState",
      "setup.flow",
    ]) ?? ""
  );

  if (!raw || raw === "UNKNOWN") return "FLOW_UNKNOWN";
  if (raw.includes("EXHAUST")) return "FLOW_EXHAUSTION";
  if (raw.includes("BUILD")) return "FLOW_BUILDING";
  if (raw.includes("TREND")) return "FLOW_TREND";
  if (raw.includes("NEUTRAL")) return "FLOW_NEUTRAL";
  if (raw.includes("ANY")) return "FLOW_ANY";

  return `FLOW_${raw}`;
};

const normalizeMicroStage = signal => {
  const raw = cleanKey(
    firstDefined(signal, [
      "stage",
      "entryStage",
      "setupStage",
      "filterSnapshot.stage",
      "filterSnapshot.entryStage",
      "setup.stage",
    ]) ?? ""
  );

  if (!raw || raw === "UNKNOWN") return "STAGE_UNKNOWN";
  if (raw.includes("ALMOST")) return "STAGE_ALMOST";
  if (raw.includes("ENTRY")) return "STAGE_ENTRY";
  if (raw.includes("CONFIRM")) return "STAGE_CONFIRMATION";
  if (raw.includes("PULLBACK")) return "STAGE_PULLBACK";
  if (raw.includes("ANY")) return "STAGE_ANY";

  return `STAGE_${raw}`;
};

const deriveRsiZone = signal => {
  const rsi = toNum(signal.rsi ?? signal.rsiValue ?? signal.rsiHTF, 50);

  if (rsi <= 25) return "LOWER_3";
  if (rsi <= 32) return "LOWER_2";
  if (rsi <= 40) return "LOWER_1";
  if (rsi >= 75) return "UPPER_3";
  if (rsi >= 68) return "UPPER_2";
  if (rsi >= 60) return "UPPER_1";

  return "MID";
};

const normalizeRsi = signal => {
  const zone = cleanKey(
    firstDefined(signal, [
      "rsiZone",
      "rsiState",
      "filterSnapshot.rsiZone",
      "filterSnapshot.rsiState",
      "rsi.zone",
    ]) ?? deriveRsiZone(signal)
  );

  if (zone.includes("LOWER")) return "RSI_LOWER";
  if (zone.includes("UPPER")) return "RSI_UPPER";
  if (zone.includes("MID")) return "RSI_MID";
  if (zone.includes("OVERBOUGHT")) return "RSI_UPPER";
  if (zone.includes("OVERSOLD")) return "RSI_LOWER";
  if (zone.includes("ANY")) return "RSI_ANY";

  const rsi = toFiniteNumber(
    firstDefined(signal, [
      "rsi",
      "rsiValue",
      "rsi14",
      "filterSnapshot.rsi",
      "filterSnapshot.rsiValue",
      "rsi.mtf",
      "rsi.value",
    ]),
    null
  );

  if (!Number.isFinite(rsi)) return "RSI_UNKNOWN";
  if (rsi <= 40) return "RSI_LOWER";
  if (rsi >= 60) return "RSI_UPPER";

  return "RSI_MID";
};

const normalizeOb = signal => {
  const raw = cleanKey(
    firstDefined(signal, [
      "obBias",
      "orderbookBias",
      "orderBookBias",
      "bookBias",
      "filterSnapshot.obBias",
      "filterSnapshot.orderbookBias",
      "orderbook.bias",
      "book.bias",
    ]) ?? ""
  );

  if (!raw || raw === "UNKNOWN") return "OB_UNKNOWN";
  if (raw.includes("BULL")) return "OB_BULLISH";
  if (raw.includes("BEAR")) return "OB_BEARISH";
  if (raw.includes("NEUTRAL")) return "OB_NEUTRAL";
  if (raw.includes("WITH")) return "OB_WITH";
  if (raw.includes("AGAINST")) return "OB_AGAINST";

  return `OB_${raw}`;
};

const normalizeBtc = signal => {
  const raw = cleanKey(
    firstDefined(signal, [
      "btcState",
      "btcRel",
      "btcRelative",
      "btcRelativeState",
      "filterSnapshot.btcState",
      "filterSnapshot.btcRel",
      "filterSnapshot.btcRelative",
      "market.btcState",
      "btc.state",
    ]) ?? ""
  );

  if (!raw || raw === "UNKNOWN") return "BTC_UNKNOWN";
  if (raw.includes("BULL")) return "BTC_BULLISH";
  if (raw.includes("BEAR")) return "BTC_BEARISH";
  if (raw.includes("COUNTER")) return "BTC_COUNTER";
  if (raw.includes("WITH")) return "BTC_WITH";
  if (raw.includes("NEUTRAL")) return "BTC_NEUTRAL";

  return `BTC_${raw}`;
};

const normalizeFunding = signal => {
  const raw = firstDefined(signal, [
    "fundingState",
    "funding",
    "fundingRate",
    "filterSnapshot.fundingState",
    "filterSnapshot.funding",
    "filterSnapshot.fundingRate",
    "market.fundingRate",
  ]);

  const key = cleanKey(raw ?? "");

  if (key && key !== "UNKNOWN") {
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
};

const normalizeTf = signal => {
  const raw = cleanKey(
    firstDefined(signal, [
      "tfStrength",
      "tfState",
      "timeframeStrength",
      "filterSnapshot.tfStrength",
      "filterSnapshot.tfState",
      "tf.strength",
    ]) ?? ""
  );

  if (raw && raw !== "UNKNOWN") {
    if (raw.includes("STRONG")) return "TF_STRONG";
    if (raw.includes("ALIGNED")) return "TF_STRONG";
    if (raw.includes("OK")) return "TF_OK";
    if (raw.includes("WEAK")) return "TF_WEAK";
    if (raw.includes("ANY")) return "TF_ANY";
  }

  const score = toFiniteNumber(
    firstDefined(signal, [
      "tfScore",
      "tfStrength",
      "timeframeScore",
      "filterSnapshot.tfScore",
      "filterSnapshot.tfStrength",
      "tf.score",
      "tf.strength",
    ]),
    null
  );

  if (!Number.isFinite(score)) return "TF_UNKNOWN";
  if (score >= 75) return "TF_STRONG";
  if (score >= 55) return "TF_OK";

  return "TF_WEAK";
};

const normalizeSession = signal => {
  const raw = cleanKey(
    firstDefined(signal, [
      "session",
      "marketSession",
      "tradeSession",
      "filterSnapshot.session",
    ]) ?? ""
  );

  if (raw && raw !== "UNKNOWN") {
    if (raw.includes("ASIA")) return "SESSION_ASIA";
    if (raw.includes("EU")) return "SESSION_EU";
    if (raw.includes("LONDON")) return "SESSION_EU";
    if (raw.includes("US")) return "SESSION_US";
    if (raw.includes("NY")) return "SESSION_US";
  }

  const hour = new Date(getEventTs(signal)).getUTCHours();

  if (hour >= 0 && hour < 7) return "SESSION_ASIA";
  if (hour >= 7 && hour < 13) return "SESSION_EU";
  if (hour >= 13 && hour < 21) return "SESSION_US";

  return "SESSION_ASIA";
};

const getParentFamilyId = signal => {
  const direct = firstDefined(signal, [
    "parentFamilyId",
    "mainFamilyId",
    "analysisFamilyId",
    "analyzeFamilyId",
    "familyId",
    "microFamilyId",
    "analyzerMicroFamilyId",
    "filterSnapshot.parentFamilyId",
    "filterSnapshot.mainFamilyId",
    "filterSnapshot.analysisFamilyId",
    "filterSnapshot.analyzeFamilyId",
    "filterSnapshot.familyId",
    "filterSnapshot.microFamilyId",
    "family.parentFamilyId",
    "family.mainFamilyId",
    "family.familyId",
    "family.id",
    "setup.familyId",
    "entry.familyId",
  ]);

  const parentFromDirect = extractParentFamilyId(direct);
  if (parentFromDirect) return parentFromDirect;

  const definition = [
    signal?.definition,
    signal?.familyDefinition,
    signal?.microDefinition,
    signal?.filterSnapshot?.definition,
    signal?.filterSnapshot?.familyDefinition,
  ].filter(Boolean).join(" | ");

  const parentFromDefinition = extractParentFamilyId(definition);
  if (parentFromDefinition) return parentFromDefinition;

  const side = normalizeRotationSide(signal?.rotationSide, normalizeSide(signal?.side));

  return side !== "UNKNOWN" ? `${side}_UNKNOWN` : "UNKNOWN_PARENT";
};

const hashString = value => {
  const text = String(value || "");
  let hash = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return Math.abs(hash >>> 0).toString(36).toUpperCase();
};

const buildMicroAnalyzerParts = signal => {
  const parentFamilyId = getParentFamilyId(signal);

  return [
    parentFamilyId,
    bucketScoreFine(
      firstDefined(signal, [
        "confluence",
        "confluenceScore",
        "confidence",
        "confidenceScore",
        "effectiveConfluence",
        "rawConfluence",
        "fallbackConfluence",
        "filterSnapshot.confluence",
        "filterSnapshot.confluenceScore",
        "filterSnapshot.confidence",
        "filterSnapshot.confidenceScore",
      ]),
      "CONF"
    ),
    bucketScoreFine(
      firstDefined(signal, [
        "sniperScore",
        "sniper",
        "fallbackSniperScore",
        "rawSniperScore",
        "filterSnapshot.sniperScore",
        "filterSnapshot.sniper",
      ]),
      "SNIPER"
    ),
    bucketScoreFine(
      firstDefined(signal, [
        "score",
        "moveScore",
        "entryScore",
        "finalScore",
        "filterSnapshot.score",
        "filterSnapshot.moveScore",
        "filterSnapshot.entryScore",
      ]),
      "SCORE"
    ),
    bucketRR(getRRFeature(signal)),
    normalizeFlow(signal),
    normalizeMicroStage(signal),
    normalizeRsi(signal),
    normalizeOb(signal),
    bucketSpreadBps(getSpreadBps(signal)),
    bucketDepthUsd(getDepthUsd(signal)),
    normalizeBtc(signal),
    normalizeFunding(signal),
    normalizeTf(signal),
    normalizeSession(signal),
  ];
};

const buildAnalyzerMicroFamilyId = signal => {
  const side = normalizeRotationSide(signal.rotationSide, normalizeSide(signal.side));

  if (!["LONG", "SHORT"].includes(side)) return null;

  const parentFamilyId = getParentFamilyId(signal);
  const definitionParts = buildMicroAnalyzerParts(signal);
  const definition = definitionParts.join(" | ");
  const hash = hashString(definition).slice(0, 8);

  return {
    id: `MICRO_${side}_${cleanKey(parentFamilyId)}_${hash}`,
    parentFamilyId,
    definition,
    definitionParts,
  };
};

// ================= LEGACY MF CANDIDATES =================

const deriveRsiEdge = (signal, side) => {
  const zone = cleanKey(signal.rsiZone ?? deriveRsiZone(signal));

  if (side === "bull" && ["LOWER_2", "LOWER_3"].includes(zone)) {
    return "RSI_STRONG_EDGE";
  }

  if (side === "bull" && zone === "LOWER_1") {
    return "RSI_EDGE";
  }

  if (side === "bear" && ["UPPER_2", "UPPER_3"].includes(zone)) {
    return "RSI_STRONG_EDGE";
  }

  if (side === "bear" && zone === "UPPER_1") {
    return "RSI_EDGE";
  }

  if (side === "bull" && zone.startsWith("UPPER")) {
    return "RSI_AGAINST";
  }

  if (side === "bear" && zone.startsWith("LOWER")) {
    return "RSI_AGAINST";
  }

  if (cleanKey(signal.rsiEdge ?? signal.rsiEntryEdge) === "RSI_NEUTRAL") {
    return "RSI_NEUTRAL";
  }

  return "RSI_CONTINUATION";
};

const bucketSpreadLegacy = value => {
  const spread = toNum(value, 0);

  if (spread <= 0.0005) return "SPREAD_TIGHT";
  if (spread <= 0.0015) return "SPREAD_OK";
  if (spread <= 0.003) return "SPREAD_WIDE";

  return "SPREAD_BAD";
};

const bucketDepthLegacy = value => {
  const depth = toNum(value, 0);

  if (depth >= 100_000) return "DEPTH_DEEP";
  if (depth >= 25_000) return "DEPTH_OK";
  if (depth >= 7_500) return "DEPTH_THIN";

  return "DEPTH_BAD";
};

const bucketScoreLegacy = value => {
  const score = toNum(value, 0);

  if (score >= 95) return "SCORE_95_PLUS";
  if (score >= 85) return "SCORE_85_PLUS";
  if (score >= 75) return "SCORE_75_PLUS";
  if (score >= 65) return "SCORE_65_PLUS";

  return "SCORE_LOW";
};

// ================= CANDIDATES =================

export const getMicroFamilyCandidates = signal => {
  const existing = [
    signal?.microFamilyId,
    signal?.familyId,
    signal?.rotationFamilyId,
    signal?.analyzerMicroFamilyId,
    signal?.microAnalyzerFamilyId,
    signal?.filterSnapshot?.microFamilyId,
    signal?.filterSnapshot?.familyId,
    ...(Array.isArray(signal?.microFamilyIds) ? signal.microFamilyIds : []),
    ...(Array.isArray(signal?.familyIds) ? signal.familyIds : []),
  ];

  const side = normalizeSide(signal?.side);
  const rotationSide = normalizeRotationSide(signal?.rotationSide, side);
  const stage = normalizeStage(signal?.stage);
  const setupClass = normalizeSetupClass(signal?.setupClass, signal);
  const reason = normalizeReason(signal?.reason, stage, setupClass);

  const analyzer = buildAnalyzerMicroFamilyId({
    ...signal,
    side,
    rotationSide,
    stage,
    setupClass,
    reason,
  });

  const rsiZone = cleanKey(signal?.rsiZone ?? deriveRsiZone(signal));
  const rsiEdge = cleanKey(signal?.rsiEdge ?? signal?.rsiEntryEdge ?? deriveRsiEdge(signal, side));
  const obBias = cleanKey(signal?.obBias ?? signal?.orderbookBias ?? "NEUTRAL");

  const volRegime = cleanKey(
    signal?.volRegime ??
      signal?.volatilityRegime ??
      signal?.regime ??
      "MIXED"
  );

  const spreadBucket = bucketSpreadLegacy(signal?.spreadPct);
  const depthBucket = bucketDepthLegacy(signal?.depthMinUsd1p);
  const scoreBucket = bucketScoreLegacy(signal?.score ?? signal?.moveScore);

  const legacyMf = [
    `MF_${rotationSide}_${setupClass}_${stage}_${reason}_${rsiEdge}_${obBias}`,
    `MF_${rotationSide}_${setupClass}_${stage}_${rsiEdge}_${obBias}`,
    `MF_${rotationSide}_${setupClass}_${reason}_${rsiZone}`,
    `MF_${rotationSide}_${setupClass}_${rsiEdge}_${obBias}`,
    `MF_${rotationSide}_${setupClass}_${obBias}_${volRegime}`,
    `MF_${rotationSide}_${setupClass}_${spreadBucket}_${depthBucket}`,
    `MF_${rotationSide}_${setupClass}_${scoreBucket}`,
    `MF_${rotationSide}_${setupClass}`,
    `MF_${rotationSide}_${stage}`,
    `MF_${rotationSide}`,
  ];

  return uniq([
    analyzer?.id,
    ...existing,
    ...legacyMf,
  ]);
};

export const attachMicroRotationKeys = (signal = {}, context = {}) => {
  const side = normalizeSide(signal.side ?? signal.direction ?? signal.tradeSide);
  const rotationSide = normalizeRotationSide(signal.rotationSide, side);
  const stage = normalizeStage(signal.stage ?? signal.entryStage ?? signal.setupStage);
  const setupClass = normalizeSetupClass(signal.setupClass, signal);
  const reason = normalizeReason(signal.reason, stage, setupClass);

  const rsiZone = cleanKey(signal.rsiZone ?? deriveRsiZone(signal));
  const rsiEdge = cleanKey(signal.rsiEdge ?? signal.rsiEntryEdge ?? deriveRsiEdge(signal, side));
  const obBias = cleanKey(signal.obBias ?? signal.orderbookBias ?? "NEUTRAL");

  const analyzer = buildAnalyzerMicroFamilyId({
    ...signal,
    side,
    rotationSide,
    stage,
    setupClass,
    reason,
    rsiZone,
    rsiEdge,
    obBias,
  });

  const analyzerMicroFamilyId = cleanKey(analyzer?.id ?? "");

  const enrichedBase = {
    ...signal,
    side,
    rotationSide,
    tradeSide: signal.tradeSide ?? rotationSide,
    parentFamilyId: signal.parentFamilyId ?? analyzer?.parentFamilyId,
    stage: stage.toLowerCase(),
    setupClass,
    reason,
    rsiZone,
    rsiEdge,
    obBias,
    analyzerMicroFamilyId: analyzer?.id,
    microDefinition: analyzer?.definition,
    microDefinitionParts: analyzer?.definitionParts,
  };

  const fallbackMicroFamilyIds = getMicroFamilyCandidates(enrichedBase);

  const microFamilyIds = uniq([
    analyzerMicroFamilyId,
    ...fallbackMicroFamilyIds,
  ]);

  const microFamilyId = isRealMicroFamilyId(analyzerMicroFamilyId)
    ? analyzerMicroFamilyId
    : (
        microFamilyIds.find(isRealMicroFamilyId) ??
        microFamilyIds.find(isPreferredPrimaryFamilyId) ??
        microFamilyIds.find(id => cleanKey(id).startsWith("MF_") && !isBroadFallbackFamilyId(id)) ??
        microFamilyIds.find(id => cleanKey(id).startsWith("MF_")) ??
        microFamilyIds[0] ??
        "MICRO_UNKNOWN"
      );

  const weekKey = cleanKey(
    context.weekKey ??
      context.rotationWeek ??
      context.weekId ??
      context.activeRotation?.weekKey ??
      context.activeRotation?.weekId ??
      context.weeklyRotation?.weekKey ??
      context.weeklyRotation?.weekId ??
      context.learningState?.activeWeekKey ??
      context.microLearningState?.activeWeekKey ??
      signal.weekKey ??
      "CURRENT_WEEK"
  );

  const originalFamilyId = signal.familyId ? cleanKey(signal.familyId) : null;

  const familyIds = uniq([
    microFamilyId,
    ...microFamilyIds,
    ...(Array.isArray(signal.familyIds) ? signal.familyIds : []),
  ]);

  return {
    ...enrichedBase,

    // Eén canonical waarheid.
    microFamilyId,
    familyId: microFamilyId,
    primaryFamilyId: microFamilyId,
    originalFamilyId,

    microFamilyIds,
    microFamilies: Array.isArray(signal.microFamilies)
      ? uniq([microFamilyId, ...signal.microFamilies, ...microFamilyIds])
      : microFamilyIds,

    familyIds,
    families: Array.isArray(signal.families)
      ? uniq([microFamilyId, ...signal.families, ...familyIds])
      : familyIds,

    rotationCandidate: {
      weekKey,
      rotationSide,
      setupClass,
      reason,
      parentFamilyId: analyzer?.parentFamilyId,
      analyzerMicroFamilyId: analyzer?.id,
      microFamilyId,
      microFamilyIds,
      familyId: microFamilyId,
      primaryFamilyId: microFamilyId,
      originalFamilyId,
      familyIds,
    },

    rotationId: signal.rotationId ?? `ROT_${weekKey}_${rotationSide}_${setupClass}`,
  };
};

// ================= ROTATION SOURCE EXTRACTION =================

const unwrapRotationSources = (rotation = {}) => {
  if (!rotation || typeof rotation !== "object") return [];

  const sources = [
    rotation,

    rotation.activeRotation,
    rotation.weeklyRotation,
    rotation.rotation,
    rotation.rotationState,
    rotation.current,
    rotation.currentRotation,
    rotation.selectedRotation,

    rotation.microLearning?.activeRotation,
    rotation.microLearningState?.activeRotation,
    rotation.learningState?.activeRotation,

    rotation.analyzerExport,
    rotation.microRotationAnalysis,
    rotation.latestMicroFamilyAnalysis,
    rotation.latestAnalysis,

    rotation.allowlists,
    rotation.allowlists?.micro,
    rotation.allowlists?.microStrict,
    rotation.allowlists?.microFallback,

    rotation.rotation?.allowlists,
    rotation.rotation?.allowlists?.micro,
    rotation.weeklyRotation?.allowlists,
    rotation.weeklyRotation?.allowlists?.micro,
  ];

  return sources.filter(Boolean);
};

const objectSideMatches = (value, wantedRotationSide = "UNKNOWN") => {
  if (!isPlainObject(value)) return true;
  if (!["LONG", "SHORT"].includes(wantedRotationSide)) return true;

  const side = normalizeRotationSide(
    value.side ??
      value.direction ??
      value.tradeSide ??
      value.rotationSide,
    "unknown"
  );

  if (!["LONG", "SHORT"].includes(side)) return true;

  return side === wantedRotationSide;
};

const flattenFamilyIds = (value, wantedRotationSide = "UNKNOWN") => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.flatMap(item => flattenFamilyIds(item, wantedRotationSide));
  }

  if (typeof value === "string") {
    return looksLikeFamilyId(value) ? [value] : [];
  }

  if (!isPlainObject(value)) {
    return [];
  }

  const rowHasOwnFamily =
    value.microFamilyId ||
    value.familyId ||
    value.id ||
    value.key ||
    value.name ||
    value.microFamilyIds ||
    value.activeMicroFamilyIds ||
    value.allowedMicroFamilyIds ||
    value.familyIds ||
    value.activeFamilyIds ||
    value.allowedFamilyIds;

  if (rowHasOwnFamily && !objectSideMatches(value, wantedRotationSide)) {
    return [];
  }

  const objectKeys = Object.keys(value)
    .filter(looksLikeFamilyId);

  const direct = [
    value.microFamilyId,
    value.familyId,
    value.id,
    value.key,
    value.name,

    ...(Array.isArray(value.microFamilyIds) ? value.microFamilyIds : []),
    ...(Array.isArray(value.activeMicroFamilyIds) ? value.activeMicroFamilyIds : []),
    ...(Array.isArray(value.allowedMicroFamilyIds) ? value.allowedMicroFamilyIds : []),

    ...(Array.isArray(value.familyIds) ? value.familyIds : []),
    ...(Array.isArray(value.activeFamilyIds) ? value.activeFamilyIds : []),
    ...(Array.isArray(value.allowedFamilyIds) ? value.allowedFamilyIds : []),

    ...objectKeys,
  ].filter(looksLikeFamilyId);

  const nestedSourceKeys = [
    "allowlist",
    "allowed",
    "active",
    "families",
    "activeFamilies",
    "allowedFamilies",
    "topFamilies",
    "weeklyFamilies",
    "selectedFamilies",
    "longFamilies",
    "shortFamilies",
    "winners",
    "familyMap",
    "selectedFamilyMap",
    "rows",
    "strictRows",
    "fallbackRows",
    "micro",
    "microStrict",
    "microFallback",
  ];

  const nested = nestedSourceKeys
    .map(key => value[key])
    .filter(item => Array.isArray(item) || isPlainObject(item))
    .flatMap(item => flattenFamilyIds(item, wantedRotationSide));

  return [...direct, ...nested];
};

const getActiveMicroFamilyIds = (rotation = {}, side = "unknown") => {
  const rotations = unwrapRotationSources(rotation);
  const wantedRotationSide = normalizeRotationSide(null, side);

  const sources = rotations.flatMap(item => [
    item.microFamilyIds,
    item.activeMicroFamilyIds,
    item.allowedMicroFamilyIds,

    item.familyIds,
    item.activeFamilyIds,
    item.allowedFamilyIds,

    item.allowlist,
    item.allowed,
    item.active,
    item.families,
    item.activeFamilies,
    item.allowedFamilies,
    item.topFamilies,
    item.weeklyFamilies,
    item.rotations,

    item.rows,
    item.strictRows,
    item.fallbackRows,

    item.allowlists,
    item.allowlists?.parent,
    item.allowlists?.sub,
    item.allowlists?.micro,
    item.allowlists?.microStrict,
    item.allowlists?.microFallback,

    item.bestMainLong,
    item.bestMainShort,
    item.bestMicroMain,
    item.bestMicroLong,
    item.bestMicroShort,
    item.bestLong,
    item.bestShort,

    item.winners,
    item.winners?.long,
    item.winners?.short,

    item.longFamilies,
    item.shortFamilies,
    item.selectedFamilies,
    item.selectedFamilyMap,
    item.familyMap,

    item.activeRotation,
    item.weeklyRotation,
    item.rotation,
  ]);

  return uniq(
    sources.flatMap(item => flattenFamilyIds(item, wantedRotationSide))
  )
    .filter(looksLikeFamilyId)
    .filter(id => !isBroadFallbackFamilyId(id));
};

const rotationHasFamilyIds = rotation => {
  return getActiveMicroFamilyIds(rotation, "unknown").length > 0;
};

const hasRotationMeta = rotation => {
  if (!rotation || typeof rotation !== "object") return false;

  return Boolean(
    rotation.ok !== undefined ||
      rotation.enabled !== undefined ||
      rotation.usable !== undefined ||
      rotation.rotationId ||
      rotation.activeRotationId ||
      rotation.weekKey ||
      rotation.weekId ||
      rotation.rotationWeek ||
      rotation.source ||
      rotation.mode ||
      rotation.rankingMode ||
      rotation.rankingMetric
  );
};

const getRotationMeta = rotation => {
  const sources = unwrapRotationSources(rotation);

  const active = sources.find(item =>
    Array.isArray(item?.microFamilyIds) ||
    Array.isArray(item?.activeMicroFamilyIds) ||
    Array.isArray(item?.allowedMicroFamilyIds) ||
    Array.isArray(item?.allowlist) ||
    Array.isArray(item?.rows) ||
    Array.isArray(item?.allowlists?.micro) ||
    item?.bestMainLong ||
    item?.bestMainShort ||
    item?.winners
  ) ?? sources.find(hasRotationMeta) ?? sources[0] ?? {};

  return {
    rotationId:
      active.rotationId ??
      active.activeRotationId ??
      active.id ??
      rotation?.rotationId ??
      rotation?.activeRotationId ??
      rotation?.id ??
      null,

    weekKey:
      active.weekKey ??
      active.weekId ??
      active.rotationWeek ??
      active.targetWeekId ??
      active.nextWeekId ??
      rotation?.weekKey ??
      rotation?.weekId ??
      rotation?.rotationWeek ??
      null,

    source:
      active.source ??
      active.mode ??
      rotation?.source ??
      rotation?.mode ??
      null,

    rankingMode:
      active.rankingMode ??
      active.rankingMetric ??
      active.meta?.rankingMode ??
      active.config?.rankingMetric ??
      rotation?.rankingMode ??
      rotation?.rankingMetric ??
      rotation?.meta?.rankingMode ??
      rotation?.config?.rankingMetric ??
      "UNKNOWN",

    enabled:
      active.enabled ??
      rotation?.enabled ??
      null,

    usable:
      active.usable ??
      rotation?.usable ??
      null,

    bootstrap: Boolean(active.bootstrap ?? rotation?.bootstrap),
    meta: active.meta ?? rotation?.meta ?? null,
  };
};

const resolveRotation = (signal = {}, context = {}) => {
  const candidates = [
    context.weeklyRotation,
    context.activeRotation,
    context.rotation,
    context.rotationState,

    context.microLearningState?.activeRotation,
    context.learningState?.activeRotation,
    context.microLearning?.activeRotation,

    context.analyzerExport,
    context.microRotationAnalysis,
    context.latestMicroFamilyAnalysis,
    context.latestAnalysis,

    signal.weeklyRotation,
    signal.activeRotation,
    signal.rotation,
  ].filter(item => item && typeof item === "object");

  const withIds = candidates.find(rotationHasFamilyIds);
  if (withIds) return withIds;

  const withMeta = candidates.find(hasRotationMeta);
  if (withMeta) return withMeta;

  return {};
};

// ================= QUALITY GATE =================

const getQuality = (signal, options) => {
  const stage = normalizeStage(signal.stage);
  const score = toNum(signal.score ?? signal.moveScore ?? signal.entryScore ?? signal.finalScore, 0);

  const confluence = toNum(
    signal.effectiveConfluence ??
      signal.confluence ??
      signal.rawConfluence ??
      signal.fallbackConfluence,
    0
  );

  const sniperScore = toNum(
    signal.sniperScore ??
      signal.fallbackSniperScore ??
      signal.rawSniperScore,
    0
  );

  const plannedRR = toNum(
    signal.plannedRR ??
      signal.finalRr ??
      signal.finalRR ??
      signal.setupEvalRR ??
      signal.baseRR ??
      signal.rr,
    0
  );

  const minScore = stage === "ALMOST"
    ? options.minAlmostScore
    : options.minEntryScore;

  const failures = [];

  if (stage === "ALMOST") {
    if (score < options.minAlmostScore) failures.push("SCORE");
  } else if (score < options.minEntryScore) {
    failures.push("SCORE");
  }

  if (confluence < options.minConfluence) failures.push("CONFLUENCE");
  if (sniperScore < options.minSniperScore) failures.push("SNIPER");
  if (plannedRR < options.minPlannedRR) failures.push("RR");

  return {
    ok: failures.length === 0,
    failures,
    stage,
    score,
    confluence,
    sniperScore,
    plannedRR,
    minScore,
    minEntryScore: options.minEntryScore,
    minAlmostScore: options.minAlmostScore,
    minConfluence: options.minConfluence,
    minSniperScore: options.minSniperScore,
    minPlannedRR: options.minPlannedRR,
  };
};

// ================= DECISION BUILDERS =================

const buildDecision = ({
  status,
  reason,
  signal,
  rotationMeta,
  matchedMicroFamilyId = null,
  activeMicroFamilyIds = [],
  realActiveMicroFamilyIds = [],
  checkedMicroFamilyIds = [],
  quality = null,
  bootstrap = false,
  softAllow = false,
  hasRealMicroAllowlist = false,
  rotationDisabled = false,
}) => ({
  status,
  reason,
  gateReason: reason,

  rotationId: rotationMeta?.rotationId ?? signal.rotationId ?? null,
  activeRotationId: rotationMeta?.rotationId ?? signal.rotationId ?? null,
  weekKey: rotationMeta?.weekKey ?? null,
  source: rotationMeta?.source ?? null,
  rankingMode: rotationMeta?.rankingMode ?? "UNKNOWN",

  rotationEnabled: rotationMeta?.enabled ?? null,
  rotationUsable: rotationMeta?.usable ?? null,
  rotationDisabled,

  matchedMicroFamilyId,

  // Canonical family blijft altijd signal.microFamilyId.
  // matchedMicroFamilyId is alleen diagnostiek/matchbewijs.
  microFamilyId: signal.microFamilyId,

  checkedMicroFamilyIds,
  activeMicroFamilyIds,
  realActiveMicroFamilyIds,
  hasRealMicroAllowlist,

  quality,
  bootstrap,
  softAllow,

  signal,
});

const allow = (reason, signal, extra = {}) => {
  const rotationMeta = extra.rotationMeta ?? {};

  const decision = buildDecision({
    status: "ALLOW",
    reason,
    signal,
    rotationMeta,
    matchedMicroFamilyId: extra.matchedMicroFamilyId ?? signal.microFamilyId,
    activeMicroFamilyIds: extra.activeMicroFamilyIds ?? [],
    realActiveMicroFamilyIds: extra.realActiveMicroFamilyIds ?? [],
    checkedMicroFamilyIds: extra.checkedMicroFamilyIds ?? signal.microFamilyIds ?? [],
    quality: extra.quality ?? null,
    bootstrap: Boolean(extra.bootstrap),
    softAllow: Boolean(extra.softAllow),
    hasRealMicroAllowlist: Boolean(extra.hasRealMicroAllowlist),
    rotationDisabled: Boolean(extra.rotationDisabled),
  });

  return {
    ok: true,
    pass: true,
    allowed: true,
    action: "ENTRY",

    decision,
    decisionStatus: "ALLOW",

    reason,
    gateReason: reason,
    waitReason: null,

    signal,
    enrichedSignal: signal,

    microFamilyId: decision.microFamilyId,
    familyId: decision.microFamilyId,
    primaryFamilyId: decision.microFamilyId,
    microFamilyIds: signal.microFamilyIds,
    matchedMicroFamilyId: decision.matchedMicroFamilyId,

    rotationId: decision.rotationId,
    activeMicroFamilyIds: decision.activeMicroFamilyIds,
    realActiveMicroFamilyIds: decision.realActiveMicroFamilyIds,
    checkedMicroFamilyIds: decision.checkedMicroFamilyIds,
    hasRealMicroAllowlist: decision.hasRealMicroAllowlist,

    bootstrap: decision.bootstrap,
    softAllow: decision.softAllow,
    rotationDisabled: decision.rotationDisabled,

    ...extra,
  };
};

const block = (reason, signal, extra = {}) => {
  const rotationMeta = extra.rotationMeta ?? {};

  const decision = buildDecision({
    status: "WAIT",
    reason,
    signal,
    rotationMeta,
    matchedMicroFamilyId: null,
    activeMicroFamilyIds: extra.activeMicroFamilyIds ?? [],
    realActiveMicroFamilyIds: extra.realActiveMicroFamilyIds ?? [],
    checkedMicroFamilyIds: extra.checkedMicroFamilyIds ?? signal.microFamilyIds ?? [],
    quality: extra.quality ?? null,
    bootstrap: Boolean(extra.bootstrap),
    softAllow: false,
    hasRealMicroAllowlist: Boolean(extra.hasRealMicroAllowlist),
    rotationDisabled: Boolean(extra.rotationDisabled),
  });

  return {
    ok: false,
    pass: false,
    allowed: false,
    action: "WAIT",

    decision,
    decisionStatus: "WAIT",

    reason,
    gateReason: reason,
    waitReason: `WEEKLY_ROTATION_${reason}`,

    signal,
    enrichedSignal: signal,

    microFamilyId: signal.microFamilyId,
    familyId: signal.microFamilyId,
    primaryFamilyId: signal.microFamilyId,
    microFamilyIds: signal.microFamilyIds,

    rotationId: decision.rotationId,
    activeMicroFamilyIds: decision.activeMicroFamilyIds,
    realActiveMicroFamilyIds: decision.realActiveMicroFamilyIds,
    checkedMicroFamilyIds: decision.checkedMicroFamilyIds,
    hasRealMicroAllowlist: decision.hasRealMicroAllowlist,

    rotationDisabled: decision.rotationDisabled,

    ...extra,
  };
};

// ================= MAIN GATE =================

export const checkTradeSignalAgainstRotation = async (signal = {}, context = {}) => {
  const options = {
    ...DEFAULTS,
    ...context,
  };

  const enriched = attachMicroRotationKeys(signal, context);

  if (!enriched.symbol) {
    return block("ENTRY_SYMBOL_MISSING", enriched, {
      rotationMeta: {},
    });
  }

  if (!["bull", "bear"].includes(enriched.side)) {
    return block("ENTRY_SIDE_MISSING", enriched, {
      rotationMeta: {},
    });
  }

  const quality = getQuality(enriched, options);

  if (!quality.ok) {
    return block("LOW_ENTRY_QUALITY", enriched, {
      quality,
      rotationMeta: {},
    });
  }

  const rotation = resolveRotation(signal, context);
  const rotationMeta = getRotationMeta(rotation);

  const rawActiveMicroFamilyIds = getActiveMicroFamilyIds(rotation, enriched.side);
  const realActiveMicroFamilyIds = rawActiveMicroFamilyIds.filter(isRealMicroFamilyId);
  const hasRealMicroAllowlist = realActiveMicroFamilyIds.length > 0;

  const activeMicroFamilyIds = hasRealMicroAllowlist
    ? realActiveMicroFamilyIds
    : rawActiveMicroFamilyIds;

  const activeSet = new Set(activeMicroFamilyIds.map(cleanKey));

  const maxFamilyIdsChecked = Math.max(
    1,
    toNum(options.maxFamilyIdsChecked, DEFAULTS.maxFamilyIdsChecked)
  );

  const checkedMicroFamilyIds = hasRealMicroAllowlist
    ? uniq([
        enriched.microFamilyId,
        enriched.analyzerMicroFamilyId,
      ])
        .filter(isRealMicroFamilyId)
        .slice(0, maxFamilyIdsChecked)
    : uniq(enriched.microFamilyIds)
        .filter(id => !isBroadFallbackFamilyId(id))
        .slice(0, maxFamilyIdsChecked);

  const matchedMicroFamilyId = checkedMicroFamilyIds.find(id => activeSet.has(cleanKey(id)));

  if (matchedMicroFamilyId) {
    return allow(
      hasRealMicroAllowlist
        ? "WEEKLY_ROTATION_REAL_MICRO_FAMILY_MATCH"
        : "WEEKLY_ROTATION_MICRO_FAMILY_MATCH",
      enriched,
      {
        matchedMicroFamilyId: cleanKey(matchedMicroFamilyId),
        activeMicroFamilyIds: limitArray(activeMicroFamilyIds, options.maxActiveFamilyIdsReturned),
        realActiveMicroFamilyIds: limitArray(realActiveMicroFamilyIds, options.maxActiveFamilyIdsReturned),
        checkedMicroFamilyIds,
        quality,
        rotationMeta,
        bootstrap: false,
        softAllow: false,
        hasRealMicroAllowlist,
      }
    );
  }

  const rotationIsEmpty = activeMicroFamilyIds.length === 0;
  const rotationDisabled = rotationMeta.enabled === false || rotationMeta.usable === false;

  if (rotationDisabled && options.blockWhenRotationDisabled) {
    return block("ROTATION_DISABLED", enriched, {
      activeMicroFamilyIds: limitArray(activeMicroFamilyIds, options.maxActiveFamilyIdsReturned),
      realActiveMicroFamilyIds: limitArray(realActiveMicroFamilyIds, options.maxActiveFamilyIdsReturned),
      checkedMicroFamilyIds,
      quality,
      rotationMeta,
      hasRealMicroAllowlist,
      rotationDisabled: true,
    });
  }

  if (rotationIsEmpty && options.allowBootstrapWhenRotationEmpty) {
    return allow(
      rotationDisabled
        ? "WEEKLY_ROTATION_DISABLED_EMPTY_BOOTSTRAP"
        : "WEEKLY_ROTATION_BOOTSTRAP_EMPTY_ALLOWLIST",
      enriched,
      {
        activeMicroFamilyIds,
        realActiveMicroFamilyIds,
        checkedMicroFamilyIds,
        quality,
        rotationMeta,
        bootstrap: true,
        softAllow: false,
        hasRealMicroAllowlist,
        rotationDisabled,
      }
    );
  }

  if (
    !hasRealMicroAllowlist &&
    !options.strictWeeklyRotation &&
    options.allowGodSoftPass &&
    enriched.setupClass === "GOD"
  ) {
    return allow("WEEKLY_ROTATION_GOD_SOFT_ALLOW", enriched, {
      activeMicroFamilyIds: limitArray(activeMicroFamilyIds, options.maxActiveFamilyIdsReturned),
      realActiveMicroFamilyIds: limitArray(realActiveMicroFamilyIds, options.maxActiveFamilyIdsReturned),
      checkedMicroFamilyIds,
      quality,
      rotationMeta,
      bootstrap: false,
      softAllow: true,
      hasRealMicroAllowlist,
      rotationDisabled,
    });
  }

  return block(
    hasRealMicroAllowlist
      ? "REAL_MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION"
      : "MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION",
    enriched,
    {
      activeMicroFamilyIds: limitArray(activeMicroFamilyIds, options.maxActiveFamilyIdsReturned),
      realActiveMicroFamilyIds: limitArray(realActiveMicroFamilyIds, options.maxActiveFamilyIdsReturned),
      checkedMicroFamilyIds,
      quality,
      rotationMeta,
      hasRealMicroAllowlist,
      rotationDisabled,
    }
  );
};

// Backward-compatible alias voor eerdere tradeSystem imports.
export const evaluateMicroRotationGate = (signal = {}, activeRotation = {}, options = {}) => {
  return checkTradeSignalAgainstRotation(signal, {
    ...options,
    activeRotation,
  });
};

// Backward-compatible helpernamen.
export const extractCandidateMicroFamilyIds = signal => getMicroFamilyCandidates(signal);

export const deriveMicroFamilyId = signal => {
  const enriched = attachMicroRotationKeys(signal);
  return enriched.microFamilyId ?? null;
};

export default {
  attachMicroRotationKeys,
  getMicroFamilyCandidates,
  checkTradeSignalAgainstRotation,
  evaluateMicroRotationGate,
  extractCandidateMicroFamilyIds,
  deriveMicroFamilyId,
};