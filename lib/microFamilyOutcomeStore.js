// lib/microFamilyOutcomeStore.js
// Weekly adaptive micro-family learning store.
// Doel:
// - Intraday: deduped coin/family observations opslaan.
// - Daily: raw coin rows compacten naar family outcomes.
// - Weekly: daily outcomes optellen, beste micro-families selecteren.
// - Daarna raw/daily buffers resetten zodat opslag klein blijft.

const DAY_MS = 86_400_000;

export const MICRO_FAMILY_KEYS = {
  meta: 'tradeSystem:microFamilies:meta:v1',
  activeRotation: 'tradeSystem:microFamilies:activeWeeklyRotation:v1',
  today: (dateKey) => `tradeSystem:microFamilies:today:${dateKey}:v1`,
  weekly: (weekId) => `tradeSystem:microFamilies:weekly:${weekId}:v1`,
  lastRotation: 'tradeSystem:microFamilies:lastRotation:v1',
};

export const DEFAULT_MICRO_FAMILY_LEARNING_CONFIG = {
  strategyVersion: 'TS_V12_7_MICRO_ROTATION_GATE',

  // shadow-outcome model
  shadowTargetR: 1.42,
  fallbackRiskPct: 0.006,
  minRiskPct: 0.0025,
  maxRiskPct: 0.025,

  // storage caps
  maxTodayRows: 2500,
  maxFamilyIdsPerCandidate: 12,

  // weekly selection
  topFamiliesPerSide: 12,
  minSamplesPerFamily: 8,
  minWinrate: 0.42,
  minExpectancyR: 0.03,
  maxAvgMaeR: 0.95,

  // reset policy
  deleteRawDayAfterRollup: true,
  deleteWeeklyStatsAfterRotation: true,

  // first week / no data behavior
  allowBootstrapWhenNoWeeklyData: true,
};

export function createMemoryJsonStore(seed = {}) {
  const map = new Map(Object.entries(seed));

  return {
    async getJson(key) {
      const raw = map.get(key);
      if (raw == null) return null;
      return structuredClone(raw);
    },

    async setJson(key, value) {
      map.set(key, structuredClone(value));
      return true;
    },

    async deleteKey(key) {
      map.delete(key);
      return true;
    },

    dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

export async function runMicroFamilyLearningCycle({
  store,
  candidates = [],
  now = Date.now(),
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };

  if (!store) {
    throw new Error('runMicroFamilyLearningCycle requires store');
  }

  const dateKey = toDateKey(now);
  const weekId = toIsoWeekId(now);

  const meta = await getJson(store, MICRO_FAMILY_KEYS.meta, createDefaultMeta({ dateKey, weekId, now }));

  const rollups = [];

  // 1. Roll oude raw day buffers op naar weekly summaries.
  const oldDayKeys = [...new Set(meta.openDayKeys || [])].filter((dayKey) => dayKey < dateKey);

  for (const oldDateKey of oldDayKeys) {
    const result = await rollupDayToWeeklyStats({
      store,
      dateKey: oldDateKey,
      config: cfg,
    });

    rollups.push(result);
  }

  meta.openDayKeys = [...new Set(meta.openDayKeys || [])].filter((dayKey) => dayKey >= dateKey);

  // 2. Nieuwe week? Bouw weekly rotation uit vorige week en reset compacte weekly stats.
  let rotationUpdated = false;
  let rotation = await getJson(store, MICRO_FAMILY_KEYS.activeRotation, null);

  if (meta.activeWeekId && meta.activeWeekId !== weekId) {
    const sourceWeekId = meta.activeWeekId;

    rotation = await buildAndSaveWeeklyRotation({
      store,
      sourceWeekId,
      targetWeekId: weekId,
      now,
      config: cfg,
    });

    rotationUpdated = true;
    meta.activeWeekId = weekId;
    meta.lastWeeklyRotationAt = now;

    if (cfg.deleteWeeklyStatsAfterRotation) {
      await deleteKey(store, MICRO_FAMILY_KEYS.weekly(sourceWeekId));
    }
  }

  if (!meta.activeWeekId) meta.activeWeekId = weekId;

  // 3. Observe huidige candidates intraday.
  let observation = null;

  if (Array.isArray(candidates) && candidates.length) {
    observation = await observeMicroFamilyCandidates({
      store,
      candidates,
      now,
      dateKey,
      config: cfg,
    });

    meta.openDayKeys = [...new Set([...(meta.openDayKeys || []), dateKey])];
    meta.lastObservedAt = now;
  }

  // 4. Active rotation fallback voor eerste week.
  rotation = await getJson(store, MICRO_FAMILY_KEYS.activeRotation, null);

  if (!rotation && cfg.allowBootstrapWhenNoWeeklyData) {
    rotation = createBootstrapRotation({
      weekId,
      now,
      strategyVersion: cfg.strategyVersion,
    });

    await setJson(store, MICRO_FAMILY_KEYS.activeRotation, rotation);
  }

  meta.activeDateKey = dateKey;
  meta.updatedAt = now;

  await setJson(store, MICRO_FAMILY_KEYS.meta, meta);

  return {
    ok: true,
    dateKey,
    weekId,
    rotationUpdated,
    activeRotation: rotation,
    observation,
    rollups,
    meta,
  };
}

export async function observeMicroFamilyCandidates({
  store,
  candidates,
  now = Date.now(),
  dateKey = toDateKey(now),
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };
  const key = MICRO_FAMILY_KEYS.today(dateKey);

  const day = await getJson(store, key, createEmptyTodayStore({ dateKey, now, strategyVersion: cfg.strategyVersion }));

  let observed = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate, cfg);

    if (!normalized) {
      skipped += 1;
      continue;
    }

    const rowKey = buildTodayRowKey(normalized);
    const previous = day.rows[rowKey];

    day.rows[rowKey] = mergeObservationRow({
      previous,
      candidate: normalized,
      now,
      config: cfg,
    });

    observed += 1;
  }

  enforceTodayCap(day, cfg.maxTodayRows);

  day.updatedAt = now;
  day.rowCount = Object.keys(day.rows).length;

  await setJson(store, key, day);

  return {
    dateKey,
    observed,
    skipped,
    rows: day.rowCount,
    key,
  };
}

export async function rollupDayToWeeklyStats({
  store,
  dateKey,
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };
  const todayKey = MICRO_FAMILY_KEYS.today(dateKey);

  const day = await getJson(store, todayKey, null);

  if (!day || !day.rows) {
    return {
      ok: true,
      skipped: true,
      reason: 'NO_DAY_ROWS',
      dateKey,
      rows: 0,
    };
  }

  const weekId = toIsoWeekId(new Date(`${dateKey}T12:00:00.000Z`).getTime());
  const weeklyKey = MICRO_FAMILY_KEYS.weekly(weekId);
  const weekly = await getJson(store, weeklyKey, createEmptyWeeklyStats({ weekId, strategyVersion: cfg.strategyVersion }));

  const dailySummary = createDailySummaryFromRows({
    dateKey,
    rows: Object.values(day.rows),
    config: cfg,
  });

  mergeDailySummaryIntoWeekly({
    weekly,
    dailySummary,
  });

  weekly.updatedAt = Date.now();

  await setJson(store, weeklyKey, weekly);

  if (cfg.deleteRawDayAfterRollup) {
    await deleteKey(store, todayKey);
  }

  return {
    ok: true,
    skipped: false,
    dateKey,
    weekId,
    rawRows: Object.keys(day.rows).length,
    familyRows: Object.keys(dailySummary.families).length,
    weeklyKey,
    deletedRaw: Boolean(cfg.deleteRawDayAfterRollup),
  };
}

export async function buildAndSaveWeeklyRotation({
  store,
  sourceWeekId,
  targetWeekId,
  now = Date.now(),
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };
  const weekly = await getJson(store, MICRO_FAMILY_KEYS.weekly(sourceWeekId), null);

  const rotation = buildWeeklyRotationFromStats({
    weekly,
    sourceWeekId,
    targetWeekId,
    now,
    config: cfg,
  });

  await setJson(store, MICRO_FAMILY_KEYS.activeRotation, rotation);
  await setJson(store, MICRO_FAMILY_KEYS.lastRotation, rotation);

  return rotation;
}

export function buildWeeklyRotationFromStats({
  weekly,
  sourceWeekId,
  targetWeekId,
  now = Date.now(),
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };

  if (!weekly || !weekly.families || !Object.keys(weekly.families).length) {
    return createBootstrapRotation({
      weekId: targetWeekId,
      sourceWeekId,
      now,
      strategyVersion: cfg.strategyVersion,
      reason: 'NO_WEEKLY_STATS',
    });
  }

  const ranked = Object.values(weekly.families)
    .map((family) => scoreWeeklyFamily(family, cfg))
    .sort((a, b) => b.rankScore - a.rankScore);

  const eligible = ranked.filter((family) => {
    if (family.samples < cfg.minSamplesPerFamily) return false;
    if (family.winrate < cfg.minWinrate) return false;
    if (family.expectancyR < cfg.minExpectancyR) return false;
    if (family.avgMaeR > cfg.maxAvgMaeR) return false;
    return true;
  });

  const source = eligible.length ? eligible : ranked.slice(0, Math.min(6, ranked.length));

  const longFamilies = source
    .filter((family) => family.side === 'LONG')
    .slice(0, cfg.topFamiliesPerSide);

  const shortFamilies = source
    .filter((family) => family.side === 'SHORT')
    .slice(0, cfg.topFamiliesPerSide);

  const selected = [...longFamilies, ...shortFamilies];

  if (!selected.length) {
    return createBootstrapRotation({
      weekId: targetWeekId,
      sourceWeekId,
      now,
      strategyVersion: cfg.strategyVersion,
      reason: 'NO_SELECTED_FAMILIES',
    });
  }

  const selectedFamilyMap = {};

  for (const family of selected) {
    selectedFamilyMap[family.microFamilyId] = {
      microFamilyId: family.microFamilyId,
      side: family.side,
      setupClass: family.setupClass,
      samples: family.samples,
      winrate: round4(family.winrate),
      expectancyR: round4(family.expectancyR),
      avgR: round4(family.avgR),
      avgMfeR: round4(family.avgMfeR),
      avgMaeR: round4(family.avgMaeR),
      rankScore: round4(family.rankScore),
      selected: true,
    };
  }

  return {
    schemaVersion: 1,
    strategyVersion: cfg.strategyVersion,
    mode: eligible.length ? 'SELECTED' : 'FALLBACK_TOP_RANKED',

    weekId: targetWeekId,
    sourceWeekId,
    selectedAt: now,

    rotationIdBySide: {
      LONG: `ROT_${targetWeekId}_LONG_GOD`,
      SHORT: `ROT_${targetWeekId}_SHORT_GOD`,
    },

    longFamilies,
    shortFamilies,

    allowedMicroFamilyIds: selected.map((family) => family.microFamilyId),
    selectedFamilyMap,

    sourceStats: {
      totalFamilies: ranked.length,
      eligibleFamilies: eligible.length,
      selectedFamilies: selected.length,
      totalSamples: ranked.reduce((sum, family) => sum + family.samples, 0),
    },
  };
}

export function createDailySummaryFromRows({
  dateKey,
  rows,
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };

  const daily = {
    schemaVersion: 1,
    dateKey,
    createdAt: Date.now(),
    families: {},
  };

  for (const row of rows) {
    const finalized = finalizeObservationRow(row, cfg);

    if (!finalized) continue;

    const key = finalized.microFamilyId;

    if (!daily.families[key]) {
      daily.families[key] = createEmptyFamilyStats({
        microFamilyId: finalized.microFamilyId,
        side: finalized.side,
        setupClass: finalized.setupClass,
        reason: finalized.reason,
      });
    }

    addOutcomeToFamilyStats(daily.families[key], finalized);
  }

  for (const family of Object.values(daily.families)) {
    finalizeFamilyStats(family);
  }

  return daily;
}

export function mergeDailySummaryIntoWeekly({
  weekly,
  dailySummary,
} = {}) {
  if (!weekly || !dailySummary?.families) return weekly;

  weekly.dailyKeys = [...new Set([...(weekly.dailyKeys || []), dailySummary.dateKey])];

  for (const family of Object.values(dailySummary.families)) {
    if (!weekly.families[family.microFamilyId]) {
      weekly.families[family.microFamilyId] = createEmptyFamilyStats({
        microFamilyId: family.microFamilyId,
        side: family.side,
        setupClass: family.setupClass,
        reason: family.reason,
      });

      weekly.families[family.microFamilyId].days = [];
    }

    const target = weekly.families[family.microFamilyId];

    target.samples += family.samples;
    target.wins += family.wins;
    target.losses += family.losses;
    target.tpHits += family.tpHits;
    target.slHits += family.slHits;
    target.timeoutExits += family.timeoutExits;

    target.sumR += family.sumR;
    target.sumMfeR += family.sumMfeR;
    target.sumMaeR += family.sumMaeR;

    target.bestR = Math.max(target.bestR, family.bestR);
    target.worstR = Math.min(target.worstR, family.worstR);

    target.days.push({
      dateKey: dailySummary.dateKey,
      samples: family.samples,
      wins: family.wins,
      losses: family.losses,
      avgR: family.avgR,
      expectancyR: family.expectancyR,
    });

    finalizeFamilyStats(target);
  }

  return weekly;
}

export function scoreWeeklyFamily(family, config = {}) {
  const cfg = { ...DEFAULT_MICRO_FAMILY_LEARNING_CONFIG, ...config };

  const samples = Number(family.samples || 0);
  const winrate = samples > 0 ? family.wins / samples : 0;
  const avgR = samples > 0 ? family.sumR / samples : 0;
  const avgMfeR = samples > 0 ? family.sumMfeR / samples : 0;
  const avgMaeR = samples > 0 ? family.sumMaeR / samples : 0;

  const sampleConfidence = Math.min(
    1,
    Math.log10(samples + 1) / Math.log10((cfg.minSamplesPerFamily * 4) + 1),
  );

  const dayCount = Array.isArray(family.days) ? family.days.length : 0;
  const losingDays = Array.isArray(family.days)
    ? family.days.filter((day) => Number(day.avgR || 0) < 0).length
    : 0;

  const lossClusterPenalty = dayCount > 0 ? losingDays / dayCount : 0;

  const rankScore =
    avgR * 40 +
    winrate * 25 +
    avgMfeR * 15 -
    avgMaeR * 15 +
    sampleConfidence * 10 -
    lossClusterPenalty * 20;

  return {
    ...family,
    samples,
    winrate,
    avgR,
    expectancyR: avgR,
    avgMfeR,
    avgMaeR,
    sampleConfidence,
    lossClusterPenalty,
    rankScore,
  };
}

function normalizeCandidate(candidate, config) {
  const symbol = String(candidate?.symbol || candidate?.baseSymbol || '').trim().toUpperCase();
  const side = normalizeSide(candidate?.side || candidate?.direction || candidate?.rotationSide);
  const stage = normalizeStage(candidate?.stage);
  const setupClass = sanitizeId(candidate?.setupClass || candidate?.setup || 'UNKNOWN');
  const reason = sanitizeId(candidate?.reason || candidate?.entryReason || 'UNKNOWN');

  if (!symbol || !side) return null;

  const microFamilyIds = normalizeMicroFamilyIds(candidate, config);
  const microFamilyId = microFamilyIds[0];

  if (!microFamilyId) return null;

  const entryPrice = firstFinite([
    candidate.entryPrice,
    candidate.entry,
    candidate.price,
    candidate.markPrice,
    candidate.lastPrice,
    candidate.currentPrice,
    candidate.close,
  ]);

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  const currentPrice = firstFinite([
    candidate.currentPrice,
    candidate.markPrice,
    candidate.lastPrice,
    candidate.price,
    candidate.close,
    entryPrice,
  ]);

  const stopPrice = firstFinite([
    candidate.stopLoss,
    candidate.sl,
    candidate.stop,
    candidate.slPrice,
  ]);

  const plannedRR = firstFinite([
    candidate.finalRr,
    candidate.finalRR,
    candidate.plannedRR,
    candidate.rr,
    candidate.baseRR,
    config.shadowTargetR,
  ]);

  const riskAbs = resolveRiskAbs({
    side,
    entryPrice,
    stopPrice,
    spreadPct: Number(candidate.spreadPct),
    atrPct: Number(candidate.atrPct || candidate.volatilityPct),
    config,
  });

  return {
    raw: candidate,

    symbol,
    side,
    stage,
    setupClass,
    reason,

    microFamilyId,
    microFamilyIds,

    entryPrice,
    currentPrice,
    stopPrice: Number.isFinite(stopPrice) ? stopPrice : null,
    riskAbs,

    targetR: clamp(Number(plannedRR || config.shadowTargetR), 0.6, 3.5),

    score: num(candidate.score),
    confluence: num(candidate.effectiveConfluence ?? candidate.confluence ?? candidate.rawConfluence),
    rawConfluence: num(candidate.rawConfluence ?? candidate.confluence),
    sniperScore: num(candidate.sniperScore),
    rsi: num(candidate.rsi),
    rsiHTF: num(candidate.rsiHTF),
    rsiZone: sanitizeId(candidate.rsiZone || 'NA'),
    rsiEdge: sanitizeId(candidate.rsiEntryEdge || candidate.rsiEdge || 'NA'),
    obBias: sanitizeId(candidate.obBias || 'NA'),
    spreadPct: num(candidate.spreadPct),
    depthMinUsd1p: num(candidate.depthMinUsd1p),
  };
}

function normalizeMicroFamilyIds(candidate, config) {
  const source = [];

  if (candidate?.microFamilyId) source.push(candidate.microFamilyId);
  if (candidate?.familyId) source.push(candidate.familyId);

  if (Array.isArray(candidate?.microFamilyIds)) {
    source.push(...candidate.microFamilyIds);
  }

  const derived = deriveMicroFamilyId(candidate);
  if (derived) source.push(derived);

  return [...new Set(source.map(sanitizeId).filter(Boolean))]
    .slice(0, config.maxFamilyIdsPerCandidate);
}

function deriveMicroFamilyId(candidate) {
  const side = normalizeSide(candidate?.side || candidate?.direction || candidate?.rotationSide);
  if (!side) return null;

  const stage = normalizeStage(candidate?.stage);
  const setupClass = sanitizeId(candidate?.setupClass || 'UNKNOWN');
  const reason = sanitizeId(candidate?.reason || 'UNKNOWN');
  const rsiEdge = sanitizeId(candidate?.rsiEntryEdge || candidate?.rsiEdge || 'NA');
  const obBias = sanitizeId(candidate?.obBias || 'NA');

  return sanitizeId(`MF_${side}_${setupClass}_${stage}_${reason}_${rsiEdge}_${obBias}`);
}

function mergeObservationRow({
  previous,
  candidate,
  now,
  config,
}) {
  const row = previous || {
    rowVersion: 1,

    symbol: candidate.symbol,
    side: candidate.side,
    stage: candidate.stage,
    setupClass: candidate.setupClass,
    reason: candidate.reason,

    microFamilyId: candidate.microFamilyId,
    microFamilyIds: candidate.microFamilyIds,

    firstSeenAt: now,
    lastSeenAt: now,
    seen: 0,

    entryPrice: candidate.entryPrice,
    lastPrice: candidate.currentPrice,
    riskAbs: candidate.riskAbs,
    targetR: candidate.targetR,

    maxR: 0,
    minR: 0,
    lastR: 0,

    terminal: null,
    terminalAt: null,
    outcomeR: null,

    maxScore: 0,
    maxConfluence: 0,
    maxSniperScore: 0,

    rsiZone: candidate.rsiZone,
    rsiEdge: candidate.rsiEdge,
    obBias: candidate.obBias,
    spreadPct: candidate.spreadPct,
    depthMinUsd1p: candidate.depthMinUsd1p,
  };

  row.seen += 1;
  row.lastSeenAt = now;
  row.lastPrice = candidate.currentPrice;

  row.stage = candidate.stage || row.stage;
  row.reason = candidate.reason || row.reason;
  row.rsiZone = candidate.rsiZone || row.rsiZone;
  row.rsiEdge = candidate.rsiEdge || row.rsiEdge;
  row.obBias = candidate.obBias || row.obBias;

  row.microFamilyIds = [...new Set([...(row.microFamilyIds || []), ...(candidate.microFamilyIds || [])])]
    .slice(0, config.maxFamilyIdsPerCandidate);

  row.maxScore = Math.max(num(row.maxScore), num(candidate.score));
  row.maxConfluence = Math.max(num(row.maxConfluence), num(candidate.confluence));
  row.maxSniperScore = Math.max(num(row.maxSniperScore), num(candidate.sniperScore));

  updateRPath(row, candidate.currentPrice, now);

  return row;
}

function updateRPath(row, price, now) {
  if (!Number.isFinite(price) || price <= 0) return row;
  if (!Number.isFinite(row.entryPrice) || !Number.isFinite(row.riskAbs) || row.riskAbs <= 0) return row;

  const r =
    row.side === 'LONG'
      ? (price - row.entryPrice) / row.riskAbs
      : (row.entryPrice - price) / row.riskAbs;

  row.lastR = r;
  row.maxR = Math.max(Number(row.maxR || 0), r);
  row.minR = Math.min(Number(row.minR || 0), r);

  if (!row.terminal && r <= -1) {
    row.terminal = 'SL';
    row.terminalAt = now;
    row.outcomeR = -1;
  }

  if (!row.terminal && r >= row.targetR) {
    row.terminal = 'TP';
    row.terminalAt = now;
    row.outcomeR = row.targetR;
  }

  return row;
}

function finalizeObservationRow(row, config) {
  if (!row?.microFamilyId || !row?.side) return null;

  const targetR = Number(row.targetR || config.shadowTargetR);
  const terminal = row.terminal || 'TIMEOUT';

  let outcomeR;

  if (Number.isFinite(row.outcomeR)) {
    outcomeR = row.outcomeR;
  } else {
    outcomeR = clamp(Number(row.lastR || 0), -1, targetR);
  }

  return {
    symbol: row.symbol,
    side: row.side,
    setupClass: row.setupClass,
    reason: row.reason,
    microFamilyId: row.microFamilyId,

    terminal,
    outcomeR,

    mfeR: Math.max(0, Number(row.maxR || 0)),
    maeR: Math.abs(Math.min(0, Number(row.minR || 0))),

    score: Number(row.maxScore || 0),
    confluence: Number(row.maxConfluence || 0),
    sniperScore: Number(row.maxSniperScore || 0),
  };
}

function addOutcomeToFamilyStats(family, outcome) {
  family.samples += 1;

  if (outcome.outcomeR > 0) family.wins += 1;
  else family.losses += 1;

  if (outcome.terminal === 'TP') family.tpHits += 1;
  else if (outcome.terminal === 'SL') family.slHits += 1;
  else family.timeoutExits += 1;

  family.sumR += outcome.outcomeR;
  family.sumMfeR += outcome.mfeR;
  family.sumMaeR += outcome.maeR;

  family.bestR = Math.max(family.bestR, outcome.outcomeR);
  family.worstR = Math.min(family.worstR, outcome.outcomeR);
}

function finalizeFamilyStats(family) {
  const samples = Number(family.samples || 0);

  family.winrate = samples > 0 ? family.wins / samples : 0;
  family.avgR = samples > 0 ? family.sumR / samples : 0;
  family.expectancyR = family.avgR;
  family.avgMfeR = samples > 0 ? family.sumMfeR / samples : 0;
  family.avgMaeR = samples > 0 ? family.sumMaeR / samples : 0;

  return family;
}

function createDefaultMeta({ dateKey, weekId, now }) {
  return {
    schemaVersion: 1,
    activeDateKey: dateKey,
    activeWeekId: weekId,
    openDayKeys: [],
    createdAt: now,
    updatedAt: now,
    lastObservedAt: null,
    lastWeeklyRotationAt: null,
  };
}

function createEmptyTodayStore({ dateKey, now, strategyVersion }) {
  return {
    schemaVersion: 1,
    strategyVersion,
    dateKey,
    createdAt: now,
    updatedAt: now,
    rowCount: 0,
    rows: {},
  };
}

function createEmptyWeeklyStats({ weekId, strategyVersion }) {
  return {
    schemaVersion: 1,
    strategyVersion,
    weekId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dailyKeys: [],
    families: {},
  };
}

function createEmptyFamilyStats({
  microFamilyId,
  side,
  setupClass,
  reason,
}) {
  return {
    microFamilyId,
    side,
    setupClass,
    reason,

    samples: 0,
    wins: 0,
    losses: 0,

    tpHits: 0,
    slHits: 0,
    timeoutExits: 0,

    sumR: 0,
    sumMfeR: 0,
    sumMaeR: 0,

    bestR: -Infinity,
    worstR: Infinity,

    winrate: 0,
    avgR: 0,
    expectancyR: 0,
    avgMfeR: 0,
    avgMaeR: 0,
  };
}

function createBootstrapRotation({
  weekId,
  sourceWeekId = null,
  now,
  strategyVersion,
  reason = 'BOOTSTRAP_NO_WEEKLY_DATA',
}) {
  return {
    schemaVersion: 1,
    strategyVersion,
    mode: 'BOOTSTRAP_ALLOW_ALL',

    reason,
    weekId,
    sourceWeekId,
    selectedAt: now,

    rotationIdBySide: {
      LONG: `ROT_${weekId}_LONG_BOOTSTRAP`,
      SHORT: `ROT_${weekId}_SHORT_BOOTSTRAP`,
    },

    longFamilies: [],
    shortFamilies: [],
    allowedMicroFamilyIds: [],
    selectedFamilyMap: {},

    sourceStats: {
      totalFamilies: 0,
      eligibleFamilies: 0,
      selectedFamilies: 0,
      totalSamples: 0,
    },
  };
}

function enforceTodayCap(day, maxRows) {
  const rows = Object.entries(day.rows || {});
  if (rows.length <= maxRows) return;

  rows.sort((a, b) => {
    const rowA = a[1];
    const rowB = b[1];

    const qualityA = Number(rowA.maxConfluence || 0) + Number(rowA.maxSniperScore || 0) + Number(rowA.maxScore || 0);
    const qualityB = Number(rowB.maxConfluence || 0) + Number(rowB.maxSniperScore || 0) + Number(rowB.maxScore || 0);

    return qualityB - qualityA;
  });

  day.rows = Object.fromEntries(rows.slice(0, maxRows));
  day.capped = true;
}

function buildTodayRowKey(candidate) {
  return [
    candidate.symbol,
    candidate.side,
    candidate.microFamilyId,
  ].join('|');
}

function resolveRiskAbs({
  side,
  entryPrice,
  stopPrice,
  spreadPct,
  atrPct,
  config,
}) {
  if (Number.isFinite(stopPrice) && stopPrice > 0) {
    const stopRisk = Math.abs(entryPrice - stopPrice);
    if (stopRisk > 0) return stopRisk;
  }

  const dynamicRiskPct = firstFinite([
    atrPct,
    Number.isFinite(spreadPct) ? spreadPct * 4 : null,
    config.fallbackRiskPct,
  ]);

  const riskPct = clamp(dynamicRiskPct, config.minRiskPct, config.maxRiskPct);
  return entryPrice * riskPct;
}

function normalizeSide(value) {
  const side = String(value || '').trim().toUpperCase();

  if (side === 'BULL' || side === 'LONG') return 'LONG';
  if (side === 'BEAR' || side === 'SHORT') return 'SHORT';

  return null;
}

function normalizeStage(value) {
  const stage = String(value || 'entry').trim().toUpperCase();

  if (stage === 'ALMOST') return 'ALMOST';
  if (stage === 'ENTRY') return 'ENTRY';

  return sanitizeId(stage || 'ENTRY');
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function firstFinite(values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round4(value) {
  return Math.round(Number(value || 0) * 10_000) / 10_000;
}

function toDateKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function toIsoWeekId(ts = Date.now()) {
  const date = new Date(ts);
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / DAY_MS) + 1) / 7);

  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

async function getJson(store, key, fallback = null) {
  if (typeof store.getJson === 'function') {
    const value = await store.getJson(key);
    return value == null ? fallback : value;
  }

  if (typeof store.get === 'function') {
    const value = await store.get(key);
    if (value == null) return fallback;
    if (typeof value === 'string') return JSON.parse(value);
    return value;
  }

  throw new Error('Store must expose getJson(key) or get(key)');
}

async function setJson(store, key, value) {
  if (typeof store.setJson === 'function') {
    return store.setJson(key, value);
  }

  if (typeof store.set === 'function') {
    return store.set(key, JSON.stringify(value));
  }

  throw new Error('Store must expose setJson(key, value) or set(key, value)');
}

async function deleteKey(store, key) {
  if (typeof store.deleteKey === 'function') {
    return store.deleteKey(key);
  }

  if (typeof store.del === 'function') {
    return store.del(key);
  }

  if (typeof store.delete === 'function') {
    return store.delete(key);
  }

  return false;
}