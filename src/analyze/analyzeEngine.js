// ================= FILE: src/analyze/analyzeEngine.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import { getIsoWeekKey, randomId, safeNumber } from '../utils.js';
import { classifyMicroFamily } from './microFamilies.js';
import { createMicroStats, updateObservation, updateOutcome, refreshStats } from './scoring.js';
import { applyCosts } from '../trade/costModel.js';

function getOrCreateMicro(micros, classified, side) {
  if (!micros[classified.microFamilyId]) {
    micros[classified.microFamilyId] = createMicroStats({
      microFamilyId: classified.microFamilyId,
      familyId: classified.familyId,
      side,
      definitionParts: classified.definitionParts
    });
  }
  return micros[classified.microFamilyId];
}

export async function getWeekMicros(weekKey = getIsoWeekKey()) {
  const redis = getDurableRedis();
  return await getJson(redis, KEYS.analyze.weekMicros(weekKey), {});
}

export async function saveWeekMicros(weekKey, micros) {
  const redis = getDurableRedis();
  const clean = Object.fromEntries(Object.entries(micros || {}).map(([id, row]) => [id, refreshStats(row)]));
  await setJson(redis, KEYS.analyze.weekMicros(weekKey), clean);
  await setJson(redis, KEYS.analyze.weekMeta(weekKey), {
    weekKey,
    updatedAt: Date.now(),
    microFamilies: Object.keys(clean).length,
    schema: CONFIG.analyze.schema
  });
  return clean;
}

export async function analyzeCandidatesBatch(metricsRows = [], { weekKey = getIsoWeekKey() } = {}) {
  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);
  const analyzed = [];

  for (const metrics of metricsRows) {
    const classified = classifyMicroFamily(metrics);
    const obsKey = KEYS.analyze.obsLast(metrics.snapshotId || 'NO_SNAPSHOT', metrics.symbol, classified.microFamilyId);
    const firstObservation = await redis.set(obsKey, '1', { nx: true, ex: CONFIG.analyze.obsDedupeTtlSec });

    const micro = getOrCreateMicro(micros, classified, metrics.side);
    if (firstObservation) {
      updateObservation(micro, { ...metrics, ...classified });
    }

    analyzed.push({
      ...metrics,
      ...classified,
      analysisType: 'OBSERVATION',
      observationRecorded: Boolean(firstObservation),
      weekKey
    });
  }

  await saveWeekMicros(weekKey, micros);
  return analyzed;
}

export async function recordOutcome(outcome = {}, { source = 'REAL', weekKey = getIsoWeekKey(outcome.closedAt || Date.now()) } = {}) {
  if (!outcome.microFamilyId || !outcome.familyId) {
    const classified = classifyMicroFamily(outcome);
    outcome = { ...outcome, ...classified };
  }

  const micros = await getWeekMicros(weekKey);
  const micro = getOrCreateMicro(micros, {
    microFamilyId: outcome.microFamilyId,
    familyId: outcome.familyId,
    definitionParts: outcome.definitionParts || []
  }, outcome.side);

  updateOutcome(micro, outcome, source);
  await saveWeekMicros(weekKey, micros);
  return { ...outcome, source, weekKey, recordedAt: Date.now() };
}

export async function createShadowPosition(metrics = {}) {
  if (!CONFIG.analyze.shadowEnabled) return { skipped: true, reason: 'SHADOW_DISABLED' };
  if (!metrics.microFamilyId) return { skipped: true, reason: 'MICRO_MISSING' };
  if (!metrics.entry || !metrics.sl || !metrics.tp) return { skipped: true, reason: 'RISK_MISSING' };

  const redis = getDurableRedis();
  const dedupeKey = KEYS.analyze.shadowLast(metrics.symbol, metrics.microFamilyId);
  const first = await redis.set(dedupeKey, '1', { nx: true, ex: CONFIG.analyze.shadowDedupeTtlSec });
  if (!first) return { skipped: true, reason: 'SHADOW_DEDUPED' };

  const id = randomId('shadow');
  const row = {
    id,
    source: 'SHADOW',
    status: 'OPEN',
    createdAt: Date.now(),
    monitorUntil: Date.now() + CONFIG.analyze.shadowHorizonMin * 60 * 1000,
    ticks: 0,
    maxPnlPct: 0,
    minPnlPct: 0,
    mfeR: 0,
    maeR: 0,
    ...metrics
  };

  await setJson(redis, KEYS.analyze.shadowOpen(id), row, { ex: Math.ceil(CONFIG.analyze.shadowHorizonMin * 60 * 1.2) });
  return { ok: true, shadowId: id };
}

export function buildOutcomeFromPosition({ position, exitPrice, exitReason, source = 'REAL' }) {
  const isBull = String(position.side).toLowerCase() === 'bull';
  const entry = safeNumber(position.entry);
  const sl = safeNumber(position.initialSl || position.sl);
  const exit = safeNumber(exitPrice);
  const riskDist = Math.abs(entry - sl);
  const move = isBull ? exit - entry : entry - exit;

  // directToSL was previously never set, so the directSLPct penalty in balancedScore was dead.
  // Derive it from the path the trade actually took: stopped out, never showed meaningful
  // favourable excursion (mfeR), and went adverse fast (maeR). This is the worst signal type.
  const mfeR = safeNumber(position.mfeR);
  const maeR = safeNumber(position.maeR);
  const directToSL = Boolean(position.directToSL) ||
    (exitReason === 'SL' && mfeR < 0.25 && maeR <= -0.8);

  // Net outcome after fees + slippage. This is what Analyze must learn from.
  // riskPct (|entry-SL| as fraction of entry) defines what 1R is worth in price terms.
  const riskPct = safeNumber(position.riskPct) || (entry > 0 ? riskDist / entry : 0);
  const grossMovePct = entry > 0 ? move / entry : 0;
  const cost = applyCosts({
    grossMovePct,
    riskPct,
    entrySpreadPct: safeNumber(position.spreadPct),
    exitSpreadPct: safeNumber(position.exitSpreadPct ?? position.spreadPct)
  });

  return {
    type: 'OUTCOME',
    source,
    tradeId: position.tradeId,
    symbol: position.symbol,
    side: position.side,
    familyId: position.familyId,
    microFamilyId: position.microFamilyId,
    definitionParts: position.definitionParts || [],
    entry,
    exit,
    sl: safeNumber(position.sl),
    initialSl: sl,
    tp: safeNumber(position.tp),
    exitReason,
    // Gross (price-only) kept for transparency...
    grossR: cost.grossR,
    grossPnlPct: cost.grossPnlPct,
    // ...but exitR / pnlPct now carry the NET values, so all existing scoring that reads
    // exitR automatically learns net. This is the single most important change for real PnL.
    exitR: cost.netR,
    pnlPct: cost.netPnlPct,
    netR: cost.netR,
    netPnlPct: cost.netPnlPct,
    costR: cost.costR,
    costPct: cost.costPct,
    feePct: cost.feePct,
    slippagePct: cost.slippagePct,
    mfeR: safeNumber(position.mfeR),
    maeR: safeNumber(position.maeR),
    directToSL: directToSL,
    nearTpSeen: Boolean(position.nearTpSeen),
    reachedHalfR: Boolean(position.reachedHalfR),
    reachedOneR: Boolean(position.reachedOneR),
    // BE/trailing counterfactual + giveback diagnostics (measure-only for now).
    beArmed: Boolean(position.beArmed),
    beWouldExit: Boolean(position.beWouldExit),
    beExitR: safeNumber(position.beExitR),
    gaveBackAfterHalfR: Boolean(position.gaveBackAfterHalfR),
    gaveBackAfterOneR: Boolean(position.gaveBackAfterOneR),
    nearTpThenLoss: Boolean(position.nearTpThenLoss),
    closedAt: Date.now()
  };
}
