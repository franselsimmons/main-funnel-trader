// ================= FILE: src/analyze/rotationEngine.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import { getIsoWeekKey, getNextIsoWeekKey, randomId } from '../utils.js';
import { getWeekMicros, saveWeekMicros } from './analyzeEngine.js';
import { rankMicros } from './scoring.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';

function selectTopPerSide(ranked, topN) {
  const longs = ranked.filter(r => r.side === 'bull' || r.familyId?.startsWith('LONG_')).slice(0, topN);
  const shorts = ranked.filter(r => r.side === 'bear' || r.familyId?.startsWith('SHORT_')).slice(0, topN);
  return [...longs, ...shorts];
}

export async function buildRotationFromWeek({ weekKey = getIsoWeekKey(), activeWeekKey = getNextIsoWeekKey(), mode = CONFIG.rotation.mode } = {}) {
  const micros = await getWeekMicros(weekKey);
  const ranked = rankMicros(micros, mode)
    .filter(row => Number(row.completed || 0) >= CONFIG.rotation.minWeightedCompleted);
  const selected = selectTopPerSide(ranked, CONFIG.rotation.topNPerSide);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}`),
    source: 'ANALYZE_WEEKLY_RANKING',
    mode,
    sourceWeekKey: weekKey,
    activeWeekKey,
    generatedAt: Date.now(),
    minWeightedCompleted: CONFIG.rotation.minWeightedCompleted,
    topNPerSide: CONFIG.rotation.topNPerSide,
    microFamilyIds: selected.map(row => row.microFamilyId),
    microFamilies: selected.map((row, index) => ({
      rank: index + 1,
      microFamilyId: row.microFamilyId,
      familyId: row.familyId,
      side: row.side,
      seen: row.seen,
      completed: row.completed,
      realCompleted: row.realCompleted,
      shadowCompleted: row.shadowCompleted,
      winrate: row.winrate,
      fairWinrate: row.fairWinrate,
      avgR: row.avgR,
      totalR: row.totalR,
      profitFactor: row.profitFactor,
      directSLPct: row.directSLPct,
      balancedScore: row.balancedScore,
      definitionParts: row.definitionParts
    })),
    rankings: {
      balanced: rankMicros(micros, 'balanced').slice(0, 50),
      winrate: rankMicros(micros, 'winrate').slice(0, 50),
      totalR: rankMicros(micros, 'totalR').slice(0, 50),
      avgR: rankMicros(micros, 'avgR').slice(0, 50),
      directSL: rankMicros(micros, 'directSL').slice(0, 50),
      observed: rankMicros(micros, 'observed').slice(0, 50)
    }
  };
}

export async function freezeWeeklyRotation({ weekKey = getIsoWeekKey(), activeWeekKey = getNextIsoWeekKey(), mode = CONFIG.rotation.mode } = {}) {
  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);
  await saveWeekMicros(weekKey, micros);
  const rotation = await buildRotationFromWeek({ weekKey, activeWeekKey, mode });
  await setJson(redis, KEYS.analyze.nextRotation, rotation);
  await setJson(redis, KEYS.analyze.rotationValidFrom, {
    validFrom: `${activeWeekKey}_MONDAY_00_UTC`,
    ts: Date.now(),
    sourceWeekKey: weekKey,
    activeWeekKey
  });
  await sendWeeklyRotationReport(rotation, 'NEXT_ROTATION_READY').catch(() => null);
  return rotation;
}

export async function activateNextRotation() {
  const redis = getDurableRedis();
  const next = await getJson(redis, KEYS.analyze.nextRotation, null);
  if (!next) return { ok: false, reason: 'NEXT_ROTATION_MISSING' };
  const active = { ...next, activatedAt: Date.now(), source: 'ANALYZE_NEXT_ROTATION_ACTIVATED' };
  await setJson(redis, KEYS.analyze.activeRotation, active);
  await sendWeeklyRotationReport(active, 'ACTIVE_ROTATION_ACTIVATED').catch(() => null);
  return { ok: true, activeRotation: active };
}

export async function getActiveRotation() {
  const redis = getDurableRedis();
  return await getJson(redis, KEYS.analyze.activeRotation, null);
}

export async function activateSelectedMicroFamilies({ microFamilyIds = [], weekKey = getIsoWeekKey(), mode = 'manual' }) {
  const redis = getDurableRedis();
  const micros = await getWeekMicros(weekKey);
  const selected = microFamilyIds.map(id => micros[id]).filter(Boolean);
  const active = {
    rotationId: randomId(`ROT_${weekKey}_manual`),
    source: 'ADMIN_MANUAL_SELECTION',
    mode,
    sourceWeekKey: weekKey,
    activeWeekKey: getIsoWeekKey(),
    generatedAt: Date.now(),
    activatedAt: Date.now(),
    microFamilyIds: selected.map(row => row.microFamilyId),
    microFamilies: selected
  };
  await setJson(redis, KEYS.analyze.activeRotation, active);
  return active;
}

export async function getRotationDashboard() {
  const redis = getDurableRedis();
  const [active, next, validFrom] = await Promise.all([
    getJson(redis, KEYS.analyze.activeRotation, null),
    getJson(redis, KEYS.analyze.nextRotation, null),
    getJson(redis, KEYS.analyze.rotationValidFrom, null)
  ]);
  return { active, next, validFrom };
}
