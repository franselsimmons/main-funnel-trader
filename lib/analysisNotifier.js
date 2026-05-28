// ================= lib/analysisNotifier.js =================
// TradeSystem gebruikt sendAnalysisActions(finalActions, meta).
// Deze versie slaat lokaal/durable op via analyzeStore.
// Externe webhook is optioneel.
//
// Aangepast voor micro-rotation winrate ranking:
// - fairWinrateNum
// - winrateLowerBoundNum
// - bayesianWinrateNum
// - sampleReliability
// - completed
// - wins
// - losses
// - rankingMode

import { appendAnalyzeEvents } from "./analyze/analyzeStore.js";

const MICRO_ROTATION_PRIOR_TRADES = Number(process.env.MICRO_ROTATION_PRIOR_TRADES || 24);
const MICRO_ROTATION_PRIOR_WINRATE = Number(process.env.MICRO_ROTATION_PRIOR_WINRATE || 0.50);
const MICRO_ROTATION_WILSON_Z = Number(process.env.MICRO_ROTATION_WILSON_Z || 1.96);

function getWebhookUrl() {
  return (
    process.env.ANALYSIS_WEBHOOK_URL ||
    process.env.ANALYZE_WEBHOOK_URL ||
    ""
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toOptionalNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cleanKey(value) {
  const raw = String(value ?? "").trim().toUpperCase();

  return raw
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniq(values) {
  return Array.from(
    new Set(
      values
        .map(cleanKey)
        .filter(Boolean)
    )
  );
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getRowMicroFamilyIds(row = {}) {
  return uniq([
    row.matchedMicroFamilyId,
    row.microFamilyId,
    row.familyId,
    row.rotationFamilyId,
    row.rotationCandidate,

    ...(Array.isArray(row.microFamilyIds) ? row.microFamilyIds : []),
    ...(Array.isArray(row.familyIds) ? row.familyIds : []),
    ...(Array.isArray(row.microFamilies) ? row.microFamilies : []),
    ...(Array.isArray(row.families) ? row.families : [])
  ]);
}

function getFamilyIdFromStats(stats = {}) {
  return cleanKey(
    stats.familyId ??
    stats.microFamilyId ??
    stats.id ??
    stats.key ??
    stats.name
  );
}

function wilsonLowerBound(wins, completed, z = MICRO_ROTATION_WILSON_Z) {
  const n = toNum(completed, 0);
  const w = toNum(wins, 0);

  if (n <= 0) return 0;

  const p = clamp(w / n, 0, 1);
  const z2 = z * z;

  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  return clamp((centre - margin) / denominator, 0, 1);
}

function bayesianWinrate(wins, completed) {
  const n = toNum(completed, 0);
  const w = toNum(wins, 0);

  const priorTrades = Math.max(0, MICRO_ROTATION_PRIOR_TRADES);
  const priorWins = priorTrades * clamp(MICRO_ROTATION_PRIOR_WINRATE, 0, 1);

  const denominator = n + priorTrades;
  if (denominator <= 0) return 0;

  return clamp((w + priorWins) / denominator, 0, 1);
}

function buildFairWinrateMeta(stats = {}) {
  const completed = Math.max(0, toNum(stats.completed, 0));
  const wins = clamp(toNum(stats.wins, 0), 0, completed);
  const seen = Math.max(0, toNum(stats.seen, 0));

  const rawWinrateNum = completed
    ? wins / completed
    : 0;

  const bayesianWinrateNum = bayesianWinrate(wins, completed);
  const winrateLowerBoundNum = wilsonLowerBound(wins, completed);

  const fairWinrateNum = completed
    ? winrateLowerBoundNum * 0.75 + bayesianWinrateNum * 0.25
    : 0;

  const sampleReliability = completed
    ? completed / (completed + MICRO_ROTATION_PRIOR_TRADES)
    : 0;

  const observationConfidence = clamp(seen / 100, 0, 1);

  return {
    winrateNum: Number(rawWinrateNum.toFixed(4)),
    bayesianWinrateNum: Number(bayesianWinrateNum.toFixed(4)),
    winrateLowerBoundNum: Number(winrateLowerBoundNum.toFixed(4)),
    fairWinrateNum: Number(fairWinrateNum.toFixed(4)),
    sampleReliability: Number(sampleReliability.toFixed(4)),
    observationConfidence: Number(observationConfidence.toFixed(4))
  };
}

function getRotationFromMeta(meta = {}) {
  return (
    meta.weeklyRotation ||
    meta.rotation ||
    meta.rotationState ||
    meta.activeRotation ||
    meta.microRotation ||
    meta.learnedWeeklyRotation ||
    null
  );
}

function getRotationCollections(rotation = {}) {
  if (!isPlainObject(rotation)) return [];

  return [
    ...normalizeArray(rotation.longFamilies),
    ...normalizeArray(rotation.shortFamilies),
    ...normalizeArray(rotation.selectedFamilies),
    ...normalizeArray(rotation.topFamilies),
    ...normalizeArray(rotation.weeklyFamilies),
    ...normalizeArray(rotation.activeFamilies),
    ...normalizeArray(rotation.allowedFamilies),
    ...normalizeArray(rotation.families)
  ].filter(isPlainObject);
}

function getMappedFamilyStats(rotation = {}, familyId) {
  if (!isPlainObject(rotation) || !familyId) return null;

  const maps = [
    rotation.selectedFamilyMap,
    rotation.familyMap,
    rotation.selectedFamiliesMap,
    rotation.activeFamilyMap,
    rotation.allowedFamilyMap
  ];

  for (const map of maps) {
    if (!isPlainObject(map)) continue;

    const direct =
      map[familyId] ||
      map[cleanKey(familyId)] ||
      map[String(familyId)];

    if (isPlainObject(direct)) {
      return direct;
    }
  }

  return null;
}

function findFamilyStatsForRow(row = {}, meta = {}) {
  const ids = getRowMicroFamilyIds(row);
  if (!ids.length) return null;

  const directStatsCandidates = [
    row.microFamilyStats,
    row.familyStats,
    row.rotationFamilyStats,
    row.rotationStats
  ].filter(isPlainObject);

  for (const stats of directStatsCandidates) {
    const statsId = getFamilyIdFromStats(stats);

    if (!statsId || ids.includes(statsId)) {
      return stats;
    }
  }

  const rotation = getRotationFromMeta(meta);
  if (!rotation) return null;

  for (const id of ids) {
    const mapped = getMappedFamilyStats(rotation, id);
    if (mapped) return mapped;
  }

  const collections = getRotationCollections(rotation);

  const matches = collections
    .filter(stats => ids.includes(getFamilyIdFromStats(stats)))
    .sort((a, b) => toNum(b.completed, 0) - toNum(a.completed, 0));

  return matches[0] || null;
}

function buildMicroRankingFields(row = {}, meta = {}) {
  const rotation = getRotationFromMeta(meta);
  const stats = findFamilyStatsForRow(row, meta);

  const fallbackStats = {
    familyId: row.microFamilyId || row.familyId || null,
    side: row.side || null,

    seen: row.seen,
    completed: row.completed,
    wins: row.wins,
    losses: row.losses,
    flats: row.flats,

    totalR: row.totalR,
    avgR: row.avgR,

    winrateNum: row.winrateNum,
    bayesianWinrateNum: row.bayesianWinrateNum,
    winrateLowerBoundNum: row.winrateLowerBoundNum,
    fairWinrateNum: row.fairWinrateNum,
    sampleReliability: row.sampleReliability,
    observationConfidence: row.observationConfidence,

    rotationScore: row.rotationScore,
    rankingMode: row.rankingMode
  };

  const source = stats || fallbackStats;

  const completed = toOptionalNum(source.completed);
  const wins = toOptionalNum(source.wins);
  const losses = toOptionalNum(source.losses);
  const flats = toOptionalNum(source.flats);

  const hasSample =
    completed !== null ||
    wins !== null ||
    losses !== null ||
    toOptionalNum(source.fairWinrateNum) !== null;

  if (!hasSample) {
    return {
      rankingMode:
        row.rankingMode ||
        rotation?.rankingMode ||
        null,

      rankingMetric:
        row.rankingMetric ||
        rotation?.rankingMetric ||
        null,

      rotationScore: toOptionalNum(row.rotationScore),

      completed: null,
      wins: null,
      losses: null,
      flats: null,

      winrateNum: toOptionalNum(row.winrateNum),
      fairWinrateNum: toOptionalNum(row.fairWinrateNum),
      winrateLowerBoundNum: toOptionalNum(row.winrateLowerBoundNum),
      bayesianWinrateNum: toOptionalNum(row.bayesianWinrateNum),
      sampleReliability: toOptionalNum(row.sampleReliability),
      observationConfidence: toOptionalNum(row.observationConfidence),

      familyStatsFound: false
    };
  }

  const fair = buildFairWinrateMeta({
    ...source,
    completed: completed ?? 0,
    wins: wins ?? 0
  });

  return {
    rankingMode:
      source.rankingMode ||
      row.rankingMode ||
      rotation?.rankingMode ||
      "WINRATE_WILSON_BAYES",

    rankingMetric:
      row.rankingMetric ||
      rotation?.rankingMetric ||
      "fairWinrateNum",

    rotationScore: toOptionalNum(source.rotationScore),

    completed: completed ?? 0,
    wins: wins ?? 0,
    losses: losses ?? 0,
    flats: flats ?? 0,

    seen: toOptionalNum(source.seen),
    avgR: toOptionalNum(source.avgR),
    totalR: toOptionalNum(source.totalR),

    winrateNum:
      toOptionalNum(source.winrateNum) ??
      fair.winrateNum,

    fairWinrateNum:
      toOptionalNum(source.fairWinrateNum) ??
      fair.fairWinrateNum,

    winrateLowerBoundNum:
      toOptionalNum(source.winrateLowerBoundNum) ??
      fair.winrateLowerBoundNum,

    bayesianWinrateNum:
      toOptionalNum(source.bayesianWinrateNum) ??
      fair.bayesianWinrateNum,

    sampleReliability:
      toOptionalNum(source.sampleReliability) ??
      fair.sampleReliability,

    observationConfidence:
      toOptionalNum(source.observationConfidence) ??
      fair.observationConfidence,

    directSL: toOptionalNum(source.directSL),
    nearTp: toOptionalNum(source.nearTp),

    familyStatsFound: Boolean(stats),
    sourceFamilyId: getFamilyIdFromStats(source) || null
  };
}

function enrichActionForAnalysis(row = {}, meta = {}) {
  const micro = buildMicroRankingFields(row, meta);

  return {
    ...row,

    // Flat fields voor analyse-site tabellen.
    rankingMode: micro.rankingMode,
    rankingMetric: micro.rankingMetric,
    rotationScore: micro.rotationScore,

    completed: micro.completed,
    wins: micro.wins,
    losses: micro.losses,
    flats: micro.flats,

    winrateNum: micro.winrateNum,
    fairWinrateNum: micro.fairWinrateNum,
    winrateLowerBoundNum: micro.winrateLowerBoundNum,
    bayesianWinrateNum: micro.bayesianWinrateNum,
    sampleReliability: micro.sampleReliability,
    observationConfidence: micro.observationConfidence,

    // Explicit micro aliases, zodat closed-trade/outcome velden later niet botsen.
    microCompleted: micro.completed,
    microWins: micro.wins,
    microLosses: micro.losses,
    microFlats: micro.flats,
    microFairWinrateNum: micro.fairWinrateNum,
    microWinrateLowerBoundNum: micro.winrateLowerBoundNum,
    microBayesianWinrateNum: micro.bayesianWinrateNum,
    microSampleReliability: micro.sampleReliability,
    microRotationScore: micro.rotationScore,

    microRanking: {
      mode: micro.rankingMode,
      metric: micro.rankingMetric,
      familyStatsFound: micro.familyStatsFound,
      sourceFamilyId: micro.sourceFamilyId,

      completed: micro.completed,
      wins: micro.wins,
      losses: micro.losses,
      flats: micro.flats,

      winrateNum: micro.winrateNum,
      fairWinrateNum: micro.fairWinrateNum,
      winrateLowerBoundNum: micro.winrateLowerBoundNum,
      bayesianWinrateNum: micro.bayesianWinrateNum,
      sampleReliability: micro.sampleReliability,
      observationConfidence: micro.observationConfidence,

      avgR: micro.avgR,
      totalR: micro.totalR,
      directSL: micro.directSL,
      nearTp: micro.nearTp,
      rotationScore: micro.rotationScore
    }
  };
}

function buildEnrichedMeta(meta = {}) {
  const rotation = getRotationFromMeta(meta);

  if (!rotation) {
    return {
      ...meta,
      analysisRanking: {
        enabled: true,
        rankingMode: "WINRATE_WILSON_BAYES",
        rankingMetric: "fairWinrateNum",
        rotationAttached: false
      }
    };
  }

  return {
    ...meta,
    analysisRanking: {
      enabled: true,
      rankingMode: rotation.rankingMode || "WINRATE_WILSON_BAYES",
      rankingMetric: rotation.rankingMetric || "fairWinrateNum",
      rotationAttached: true,
      rotationId: rotation.rotationId || null,
      weekKey: rotation.weekKey || null,
      selectedCount: Array.isArray(rotation.allowedMicroFamilyIds)
        ? rotation.allowedMicroFamilyIds.length
        : null,
      minCompleted: rotation.sample?.minCompleted ?? null,
      priorTrades: rotation.sample?.priorTrades ?? MICRO_ROTATION_PRIOR_TRADES,
      priorWinrate: rotation.sample?.priorWinrate ?? MICRO_ROTATION_PRIOR_WINRATE,
      wilsonZ: rotation.sample?.wilsonZ ?? MICRO_ROTATION_WILSON_Z
    }
  };
}

async function postOptionalWebhook(actions, meta) {
  const url = getWebhookUrl();

  if (!url) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_WEBHOOK_URL"
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      actions,
      ...meta
    })
  });

  const text = await res.text();

  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text?.slice(0, 500)
    };
  }

  return {
    ok: true,
    status: res.status,
    response: json || text
  };
}

export async function sendAnalysisActions(actions = [], meta = {}) {
  const rows = Array.isArray(actions) ? actions : [];

  if (!rows.length) {
    return {
      ok: true,
      sent: 0,
      stored: 0,
      total: 0,
      skipped: true,
      reason: "NO_ACTIONS"
    };
  }

  const enrichedMeta = buildEnrichedMeta(meta);

  const enrichedRows = rows.map(row => enrichActionForAnalysis(row, enrichedMeta));

  const storeResult = await appendAnalyzeEvents(enrichedRows, {
    ...enrichedMeta,
    source: "TRADE_SYSTEM_ACTION"
  });

  const webhookResult = await postOptionalWebhook(enrichedRows, enrichedMeta).catch(e => ({
    ok: false,
    error: e.message
  }));

  const ok = Boolean(storeResult?.ok) && Boolean(webhookResult?.ok);

  return {
    ok,
    total: enrichedRows.length,

    sent: webhookResult?.ok && !webhookResult?.skipped ? enrichedRows.length : 0,
    failed: webhookResult?.ok ? 0 : enrichedRows.length,

    stored: Number(storeResult?.stored || 0),

    store: storeResult,
    webhook: webhookResult,

    skipped: Boolean(webhookResult?.skipped),
    reason: webhookResult?.reason || null,
    error: webhookResult?.error || null
  };
}