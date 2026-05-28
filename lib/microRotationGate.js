// lib/microRotationGate.js

const DEFAULTS = {
  minEntryScore: 55,
  minAlmostScore: 75,
  minConfluence: 60,
  minSniperScore: 60,
  minPlannedRR: 1.05,

  // Zet true voor harde weekly-rotation filtering.
  strictWeeklyRotation: false,

  // Laat entries door wanneer er nog geen actieve family allowlist is.
  allowBootstrapWhenRotationEmpty: true,

  // Belangrijk:
  // false = actieve weekly winrate-family lijst wordt niet omzeild door GOD.
  // true = GOD mag buiten allowlist alsnog door.
  allowGodSoftPass: false,

  maxFamilyIdsChecked: 16,
};

const toNum = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const cleanKey = value => {
  const raw = String(value ?? "UNKNOWN").trim().toUpperCase();

  return raw
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "UNKNOWN";
};

const uniq = arr => [...new Set(arr.filter(Boolean).map(cleanKey))];

const isPlainObject = value => (
  value &&
  typeof value === "object" &&
  !Array.isArray(value)
);

const looksLikeFamilyId = value => {
  const key = cleanKey(value);

  return (
    key.startsWith("MF_") ||
    key.startsWith("MICRO_") ||
    key.startsWith("FAMILY_")
  );
};

const isBroadFallbackFamilyId = value => {
  const key = cleanKey(value);

  if (!key.startsWith("MF_")) return false;

  return (
    /^MF_(LONG|SHORT)$/.test(key) ||
    /^MF_(LONG|SHORT)_(ENTRY|ALMOST|HOLD|EXIT)$/.test(key) ||
    /^MF_(LONG|SHORT)_(GOD|A|B|C|RUNNER)$/.test(key)
  );
};

const isPreferredPrimaryFamilyId = value => {
  const key = cleanKey(value);

  return (
    key.startsWith("MF_") &&
    !isBroadFallbackFamilyId(key) &&
    key.split("_").length >= 6
  );
};

const normalizeSide = value => {
  const v = cleanKey(value);

  if (["BULL", "BUY", "LONG"].includes(v)) return "bull";
  if (["BEAR", "SELL", "SHORT"].includes(v)) return "bear";

  return "unknown";
};

const normalizeRotationSide = (value, side) => {
  const v = cleanKey(value);

  if (["LONG", "BULL", "BUY"].includes(v)) return "LONG";
  if (["SHORT", "BEAR", "SELL"].includes(v)) return "SHORT";

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

  return "ENTRY";
};

const normalizeSetupClass = (value, signal = {}) => {
  const v = cleanKey(value);

  if (["GOD", "A", "B", "C", "RUNNER", "A_SHORT_EXCEPTION", "B_TREND_PROBE"].includes(v)) {
    return v;
  }

  const score = toNum(signal.score ?? signal.moveScore, 0);

  const confluence = toNum(
    signal.effectiveConfluence ??
    signal.confluence ??
    signal.rawConfluence,
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

const deriveRsiZone = signal => {
  const rsi = toNum(signal.rsi ?? signal.rsiHTF, 50);

  if (rsi <= 25) return "LOWER_3";
  if (rsi <= 32) return "LOWER_2";
  if (rsi <= 40) return "LOWER_1";
  if (rsi >= 75) return "UPPER_3";
  if (rsi >= 68) return "UPPER_2";
  if (rsi >= 60) return "UPPER_1";

  return "MID";
};

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

const bucketSpread = value => {
  const spread = toNum(value, 0);

  if (spread <= 0.0005) return "SPREAD_TIGHT";
  if (spread <= 0.0015) return "SPREAD_OK";
  if (spread <= 0.003) return "SPREAD_WIDE";

  return "SPREAD_BAD";
};

const bucketDepth = value => {
  const depth = toNum(value, 0);

  if (depth >= 100_000) return "DEPTH_DEEP";
  if (depth >= 25_000) return "DEPTH_OK";
  if (depth >= 7_500) return "DEPTH_THIN";

  return "DEPTH_BAD";
};

const bucketScore = value => {
  const score = toNum(value, 0);

  if (score >= 95) return "SCORE_95_PLUS";
  if (score >= 85) return "SCORE_85_PLUS";
  if (score >= 75) return "SCORE_75_PLUS";
  if (score >= 65) return "SCORE_65_PLUS";

  return "SCORE_LOW";
};

const flattenFamilyIds = value => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.flatMap(flattenFamilyIds);
  }

  if (typeof value === "string") {
    return [value];
  }

  if (!isPlainObject(value)) {
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
  ].filter(Boolean);

  const nested = Object.values(value)
    .filter(item => Array.isArray(item) || isPlainObject(item))
    .flatMap(flattenFamilyIds);

  return [...direct, ...nested];
};

export const getMicroFamilyCandidates = signal => {
  const existing = [
    signal?.microFamilyId,
    signal?.familyId,
    signal?.rotationFamilyId,
    ...(Array.isArray(signal?.microFamilyIds) ? signal.microFamilyIds : []),
    ...(Array.isArray(signal?.familyIds) ? signal.familyIds : []),
  ];

  const side = normalizeSide(signal?.side);
  const rotationSide = normalizeRotationSide(signal?.rotationSide, side);
  const stage = normalizeStage(signal?.stage);
  const setupClass = normalizeSetupClass(signal?.setupClass, signal);
  const reason = normalizeReason(signal?.reason, stage, setupClass);

  const rsiZone = cleanKey(signal?.rsiZone ?? deriveRsiZone(signal));
  const rsiEdge = cleanKey(signal?.rsiEdge ?? signal?.rsiEntryEdge ?? deriveRsiEdge(signal, side));
  const obBias = cleanKey(signal?.obBias ?? signal?.orderbookBias ?? "NEUTRAL");

  const volRegime = cleanKey(
    signal?.volRegime ??
    signal?.volatilityRegime ??
    signal?.regime ??
    "MIXED"
  );

  const spreadBucket = bucketSpread(signal?.spreadPct);
  const depthBucket = bucketDepth(signal?.depthMinUsd1p);
  const scoreBucket = bucketScore(signal?.score ?? signal?.moveScore);

  const generated = [
    // Meest specifiek. Deze moet de learning/ranking key worden.
    `MF_${rotationSide}_${setupClass}_${stage}_${reason}_${rsiEdge}_${obBias}`,

    // Zelfde setup, minder fragiel.
    `MF_${rotationSide}_${setupClass}_${stage}_${rsiEdge}_${obBias}`,
    `MF_${rotationSide}_${setupClass}_${reason}_${rsiZone}`,
    `MF_${rotationSide}_${setupClass}_${rsiEdge}_${obBias}`,

    // Market-structure families.
    `MF_${rotationSide}_${setupClass}_${obBias}_${volRegime}`,
    `MF_${rotationSide}_${setupClass}_${spreadBucket}_${depthBucket}`,

    // Score-bucket families.
    `MF_${rotationSide}_${setupClass}_${scoreBucket}`,

    // Fallback families.
    `MF_${rotationSide}_${setupClass}`,
    `MF_${rotationSide}_${stage}`,
    `MF_${rotationSide}`,
  ];

  // Generated eerst, zodat learning niet op oude MICRO_* scanner keys draait.
  // Oude keys blijven achteraan beschikbaar voor backward-compatible matching.
  return uniq([...generated, ...existing]);
};

export const attachMicroRotationKeys = (signal = {}, context = {}) => {
  const side = normalizeSide(signal.side);
  const rotationSide = normalizeRotationSide(signal.rotationSide, side);
  const stage = normalizeStage(signal.stage);
  const setupClass = normalizeSetupClass(signal.setupClass, signal);
  const reason = normalizeReason(signal.reason, stage, setupClass);

  const rsiZone = cleanKey(signal.rsiZone ?? deriveRsiZone(signal));
  const rsiEdge = cleanKey(signal.rsiEdge ?? signal.rsiEntryEdge ?? deriveRsiEdge(signal, side));
  const obBias = cleanKey(signal.obBias ?? signal.orderbookBias ?? "NEUTRAL");

  const enrichedBase = {
    ...signal,
    side,
    rotationSide,
    tradeSide: signal.tradeSide ?? rotationSide,
    stage: stage.toLowerCase(),
    setupClass,
    reason,
    rsiZone,
    rsiEdge,
    obBias,
  };

  const microFamilyIds = getMicroFamilyCandidates(enrichedBase);

  const preferredPrimary =
    microFamilyIds.find(isPreferredPrimaryFamilyId) ??
    microFamilyIds.find(id => cleanKey(id).startsWith("MF_")) ??
    microFamilyIds[0] ??
    signal.microFamilyId ??
    signal.familyId ??
    "MF_UNKNOWN";

  const microFamilyId = cleanKey(preferredPrimary);

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

  const familyIds = uniq([
    ...(Array.isArray(signal.familyIds) ? signal.familyIds : []),
    microFamilyId,
    ...microFamilyIds,
  ]);

  return {
    ...enrichedBase,

    microFamilyId,
    microFamilyIds,
    microFamilies: Array.isArray(signal.microFamilies)
      ? uniq([...signal.microFamilies, ...microFamilyIds])
      : microFamilyIds,

    familyId: cleanKey(signal.familyId ?? microFamilyId),
    familyIds,
    families: Array.isArray(signal.families)
      ? uniq([...signal.families, ...familyIds])
      : familyIds,

    rotationCandidate: {
      weekKey,
      rotationSide,
      setupClass,
      reason,
      microFamilyId,
      microFamilyIds,
      familyId: cleanKey(signal.familyId ?? microFamilyId),
      familyIds,
    },

    rotationId: signal.rotationId ?? `ROT_${weekKey}_${rotationSide}_${setupClass}`,
  };
};

const unwrapRotationSources = (rotation = {}) => {
  if (!rotation || typeof rotation !== "object") return [];

  return [
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
  ].filter(Boolean);
};

const getActiveMicroFamilyIds = (rotation = {}) => {
  const rotations = unwrapRotationSources(rotation);

  const sources = rotations.flatMap(item => [
    item.microFamilyIds,
    item.activeMicroFamilyIds,
    item.allowedMicroFamilyIds,

    item.familyIds,
    item.activeFamilyIds,
    item.allowedFamilyIds,

    item.families,
    item.activeFamilies,
    item.allowedFamilies,
    item.topFamilies,
    item.weeklyFamilies,
    item.rotations,

    item.longFamilies,
    item.shortFamilies,
    item.selectedFamilies,
    item.selectedFamilyMap,
    item.familyMap,

    item.activeRotation,
  ]);

  return uniq(sources.flatMap(flattenFamilyIds))
    .filter(id => looksLikeFamilyId(id));
};

const getRotationMeta = rotation => {
  const sources = unwrapRotationSources(rotation);
  const active = sources.find(item =>
    Array.isArray(item?.microFamilyIds) ||
    Array.isArray(item?.activeMicroFamilyIds) ||
    Array.isArray(item?.allowedMicroFamilyIds) ||
    Array.isArray(item?.families)
  ) ?? sources[0] ?? {};

  return {
    rotationId:
      active.rotationId ??
      active.activeRotationId ??
      active.id ??
      null,

    weekKey:
      active.weekKey ??
      active.weekId ??
      active.rotationWeek ??
      null,

    source:
      active.source ??
      active.mode ??
      null,

    rankingMode:
      active.rankingMode ??
      active.meta?.rankingMode ??
      "UNKNOWN",

    bootstrap:
      Boolean(active.bootstrap),

    meta: active.meta ?? null,
  };
};

const getQuality = (signal, options) => {
  const stage = normalizeStage(signal.stage);
  const score = toNum(signal.score ?? signal.moveScore, 0);

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

  if (score < options.minEntryScore && stage !== "ALMOST") failures.push("SCORE");
  if (stage === "ALMOST" && score < minScore) failures.push("SCORE");
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

const buildDecision = ({
  status,
  reason,
  signal,
  rotationMeta,
  matchedMicroFamilyId = null,
  activeMicroFamilyIds = [],
  checkedMicroFamilyIds = [],
  quality = null,
  bootstrap = false,
  softAllow = false,
}) => ({
  status,
  reason,
  gateReason: reason,

  rotationId: rotationMeta?.rotationId ?? signal.rotationId ?? null,
  activeRotationId: rotationMeta?.rotationId ?? signal.rotationId ?? null,
  weekKey: rotationMeta?.weekKey ?? null,
  source: rotationMeta?.source ?? null,
  rankingMode: rotationMeta?.rankingMode ?? "UNKNOWN",

  matchedMicroFamilyId,
  microFamilyId: matchedMicroFamilyId ?? signal.microFamilyId,
  checkedMicroFamilyIds,
  activeMicroFamilyIds,

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
    checkedMicroFamilyIds: extra.checkedMicroFamilyIds ?? signal.microFamilyIds ?? [],
    quality: extra.quality ?? null,
    bootstrap: Boolean(extra.bootstrap),
    softAllow: Boolean(extra.softAllow),
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
    microFamilyIds: signal.microFamilyIds,
    matchedMicroFamilyId: decision.matchedMicroFamilyId,

    rotationId: decision.rotationId,
    activeMicroFamilyIds: decision.activeMicroFamilyIds,
    checkedMicroFamilyIds: decision.checkedMicroFamilyIds,

    bootstrap: decision.bootstrap,
    softAllow: decision.softAllow,

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
    checkedMicroFamilyIds: extra.checkedMicroFamilyIds ?? signal.microFamilyIds ?? [],
    quality: extra.quality ?? null,
    bootstrap: Boolean(extra.bootstrap),
    softAllow: false,
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
    microFamilyIds: signal.microFamilyIds,

    rotationId: decision.rotationId,
    activeMicroFamilyIds: decision.activeMicroFamilyIds,
    checkedMicroFamilyIds: decision.checkedMicroFamilyIds,

    ...extra,
  };
};

const resolveRotation = (signal = {}, context = {}) => {
  return (
    context.weeklyRotation ??
    context.activeRotation ??
    context.rotation ??
    context.rotationState ??
    context.microLearningState?.activeRotation ??
    context.learningState?.activeRotation ??
    context.microLearning?.activeRotation ??
    signal.weeklyRotation ??
    signal.activeRotation ??
    signal.rotation ??
    {}
  );
};

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

  const activeMicroFamilyIds = getActiveMicroFamilyIds(rotation);
  const activeSet = new Set(activeMicroFamilyIds);

  const maxFamilyIdsChecked = Math.max(1, toNum(options.maxFamilyIdsChecked, DEFAULTS.maxFamilyIdsChecked));

  const checkedMicroFamilyIds = Array.isArray(enriched.microFamilyIds)
    ? enriched.microFamilyIds.slice(0, maxFamilyIdsChecked)
    : [];

  const matchedMicroFamilyId = checkedMicroFamilyIds.find(id => activeSet.has(id));

  if (matchedMicroFamilyId) {
    return allow("WEEKLY_ROTATION_MICRO_FAMILY_MATCH", enriched, {
      matchedMicroFamilyId,
      activeMicroFamilyIds,
      checkedMicroFamilyIds,
      quality,
      rotationMeta,
      bootstrap: false,
      softAllow: false,
    });
  }

  const rotationIsEmpty = activeMicroFamilyIds.length === 0;

  if (rotationIsEmpty && options.allowBootstrapWhenRotationEmpty) {
    return allow("WEEKLY_ROTATION_BOOTSTRAP_EMPTY_ALLOWLIST", enriched, {
      activeMicroFamilyIds,
      checkedMicroFamilyIds,
      quality,
      rotationMeta,
      bootstrap: true,
      softAllow: false,
    });
  }

  if (
    !options.strictWeeklyRotation &&
    options.allowGodSoftPass &&
    enriched.setupClass === "GOD"
  ) {
    return allow("WEEKLY_ROTATION_GOD_SOFT_ALLOW", enriched, {
      activeMicroFamilyIds,
      checkedMicroFamilyIds,
      quality,
      rotationMeta,
      bootstrap: false,
      softAllow: true,
    });
  }

  return block("MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION", enriched, {
    activeMicroFamilyIds,
    checkedMicroFamilyIds,
    quality,
    rotationMeta,
  });
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
  const ids = getMicroFamilyCandidates(signal);
  return ids[0] ?? null;
};

export default {
  attachMicroRotationKeys,
  getMicroFamilyCandidates,
  checkTradeSignalAgainstRotation,
  evaluateMicroRotationGate,
  extractCandidateMicroFamilyIds,
  deriveMicroFamilyId,
};