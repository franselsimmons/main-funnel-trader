// lib/microRotationGate.js

const DEFAULTS = {
  minEntryScore: 55,
  minAlmostScore: 75,
  minConfluence: 60,
  minSniperScore: 60,
  minPlannedRR: 1.05,

  // Zet op true als je later alleen families uit weekly rotation wil toestaan.
  strictWeeklyRotation: false,

  // Laat GOD setups door wanneer er nog geen actieve family allowlist is.
  allowBootstrapWhenRotationEmpty: true,
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

  if (v.includes("ENTRY")) return "ENTRY";
  if (v.includes("ALMOST")) return "ALMOST";
  if (v.includes("HOLD")) return "HOLD";
  if (v.includes("EXIT")) return "EXIT";

  return "ENTRY";
};

const normalizeSetupClass = (value, signal = {}) => {
  const v = cleanKey(value);

  if (["GOD", "A", "B", "C", "RUNNER"].includes(v)) return v;

  const score = toNum(signal.score, 0);
  const confluence = toNum(signal.confluence ?? signal.rawConfluence, 0);
  const sniperScore = toNum(signal.sniperScore ?? signal.fallbackSniperScore, 0);

  if (score >= 90 || confluence >= 90 || sniperScore >= 88) return "GOD";
  if (score >= 80 || confluence >= 80 || sniperScore >= 80) return "A";
  if (score >= 70 || confluence >= 70 || sniperScore >= 70) return "B";

  return "C";
};

const normalizeReason = (value, stage, setupClass) => {
  const v = cleanKey(value);

  if (v !== "UNKNOWN") return v;
  if (setupClass === "GOD") return "GOD_ENTRY";
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

  if (typeof value !== "object") {
    return [];
  }

  return [
    value.microFamilyId,
    value.familyId,
    value.id,
    value.rotationId,
    value.key,
    value.name,
    ...(Array.isArray(value.microFamilyIds) ? value.microFamilyIds : []),
    ...(Array.isArray(value.familyIds) ? value.familyIds : []),
  ].filter(Boolean);
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
  const rsiEdge = cleanKey(signal?.rsiEdge ?? deriveRsiEdge(signal, side));
  const obBias = cleanKey(signal?.obBias ?? signal?.orderbookBias ?? "NEUTRAL");
  const volRegime = cleanKey(signal?.volRegime ?? signal?.volatilityRegime ?? signal?.regime ?? "MIXED");

  const spreadBucket = bucketSpread(signal?.spreadPct);
  const depthBucket = bucketDepth(signal?.depthMinUsd1p);
  const scoreBucket = bucketScore(signal?.score);

  const generated = [
    // Meest specifiek.
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

  return uniq([...existing, ...generated]);
};

export const attachMicroRotationKeys = (signal = {}, context = {}) => {
  const side = normalizeSide(signal.side);
  const rotationSide = normalizeRotationSide(signal.rotationSide, side);
  const stage = normalizeStage(signal.stage);
  const setupClass = normalizeSetupClass(signal.setupClass, signal);
  const reason = normalizeReason(signal.reason, stage, setupClass);

  const rsiZone = cleanKey(signal.rsiZone ?? deriveRsiZone(signal));
  const rsiEdge = cleanKey(signal.rsiEdge ?? deriveRsiEdge(signal, side));
  const obBias = cleanKey(signal.obBias ?? signal.orderbookBias ?? "NEUTRAL");

  const enrichedBase = {
    ...signal,
    side,
    rotationSide,
    stage: stage.toLowerCase(),
    setupClass,
    reason,
    rsiZone,
    rsiEdge,
    obBias,
  };

  const microFamilyIds = getMicroFamilyCandidates(enrichedBase);
  const microFamilyId = cleanKey(signal.microFamilyId ?? microFamilyIds[0]);

  const weekKey = cleanKey(
    context.weekKey ??
    context.rotationWeek ??
    signal.weekKey ??
    "CURRENT_WEEK"
  );

  return {
    ...enrichedBase,
    microFamilyId,
    microFamilyIds,
    familyId: signal.familyId ?? microFamilyId,
    rotationId: signal.rotationId ?? `ROT_${weekKey}_${rotationSide}_${setupClass}`,
  };
};

const getActiveMicroFamilyIds = (rotation = {}) => {
  const sources = [
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.allowedMicroFamilyIds,
    rotation.familyIds,
    rotation.activeFamilyIds,
    rotation.allowedFamilyIds,
    rotation.families,
    rotation.activeFamilies,
    rotation.allowedFamilies,
    rotation.topFamilies,
    rotation.weeklyFamilies,
    rotation.rotations,
  ];

  return uniq(sources.flatMap(flattenFamilyIds));
};

const getQuality = (signal, options) => {
  const stage = normalizeStage(signal.stage);
  const score = toNum(signal.score, 0);
  const confluence = toNum(signal.confluence ?? signal.rawConfluence, 0);
  const sniperScore = toNum(signal.sniperScore ?? signal.fallbackSniperScore, 0);
  const plannedRR = toNum(signal.plannedRR ?? signal.rr, 0);

  const minScore = stage === "ALMOST"
    ? options.minAlmostScore
    : options.minEntryScore;

  const failures = [];

  if (score < minScore) failures.push("SCORE");
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
  };
};

const allow = (reason, signal, extra = {}) => ({
  ok: true,
  pass: true,
  allowed: true,
  action: "ENTRY",
  decision: "ALLOW",
  reason,
  gateReason: reason,
  waitReason: null,
  signal,
  enrichedSignal: signal,
  ...extra,
});

const block = (reason, signal, extra = {}) => ({
  ok: false,
  pass: false,
  allowed: false,
  action: "WAIT",
  decision: "WAIT",
  reason,
  gateReason: reason,
  waitReason: `WEEKLY_ROTATION_${reason}`,
  signal,
  enrichedSignal: signal,
  ...extra,
});

export const checkTradeSignalAgainstRotation = async (signal = {}, context = {}) => {
  const options = {
    ...DEFAULTS,
    ...context,
  };

  const enriched = attachMicroRotationKeys(signal, context);

  if (!enriched.symbol) {
    return block("ENTRY_SYMBOL_MISSING", enriched);
  }

  if (!["bull", "bear"].includes(enriched.side)) {
    return block("ENTRY_SIDE_MISSING", enriched);
  }

  const quality = getQuality(enriched, options);

  if (!quality.ok) {
    return block("LOW_ENTRY_QUALITY", enriched, { quality });
  }

  const rotation =
    context.weeklyRotation ??
    context.rotation ??
    context.activeRotation ??
    context.rotationState ??
    signal.weeklyRotation ??
    signal.rotation ??
    {};

  const activeMicroFamilyIds = getActiveMicroFamilyIds(rotation);
  const activeSet = new Set(activeMicroFamilyIds);
  const matchedMicroFamilyId = enriched.microFamilyIds.find(id => activeSet.has(id));

  if (matchedMicroFamilyId) {
    return allow("WEEKLY_ROTATION_MICRO_FAMILY_MATCH", enriched, {
      matchedMicroFamilyId,
      activeMicroFamilyIds,
    });
  }

  const rotationIsEmpty = activeMicroFamilyIds.length === 0;

  if (rotationIsEmpty && options.allowBootstrapWhenRotationEmpty) {
    return allow("WEEKLY_ROTATION_BOOTSTRAP_EMPTY_ALLOWLIST", enriched, {
      activeMicroFamilyIds,
      bootstrap: true,
    });
  }

  if (!options.strictWeeklyRotation && enriched.setupClass === "GOD") {
    return allow("WEEKLY_ROTATION_GOD_SOFT_ALLOW", enriched, {
      activeMicroFamilyIds,
      bootstrap: false,
      softAllow: true,
    });
  }

  return block("MICRO_FAMILY_NOT_IN_ACTIVE_ROTATION", enriched, {
    activeMicroFamilyIds,
  });
};

export default {
  attachMicroRotationKeys,
  getMicroFamilyCandidates,
  checkTradeSignalAgainstRotation,
};