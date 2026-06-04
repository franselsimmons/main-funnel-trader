// ================= FILE: src/trade/positionEngine.js =================

import { KEYS } from '../keys.js';
import { CONFIG } from '../config.js';
import { getDurableRedis, getJson, setJson, getKeys } from '../redis.js';
import { safeNumber, randomId } from '../utils.js';
import { buildOutcomeFromPosition, recordOutcome } from '../analyze/analyzeEngine.js';
import { sendExitAlert } from '../discord/discord.js';

export async function getOpenPositions() {
  const redis = getDurableRedis();
  const keys = await getKeys(redis, KEYS.trade.openPattern, 1000);
  const rows = await Promise.all(keys.map(key => getJson(redis, key, null)));
  return rows.filter(Boolean);
}

export async function getOpenPosition(symbol) {
  return getJson(getDurableRedis(), KEYS.trade.open(symbol), null);
}

export async function saveOpenPosition(position) {
  await setJson(getDurableRedis(), KEYS.trade.open(position.symbol), position);
  return position;
}

export async function deleteOpenPosition(symbol) {
  await getDurableRedis().del(KEYS.trade.open(symbol));
}

export function updatePathMetrics(position, price) {
  const isBull = position.side === 'bull';
  const entry = safeNumber(position.entry);
  const sl = safeNumber(position.initialSl || position.sl);
  const tp = safeNumber(position.tp);
  const current = safeNumber(price);
  if (!entry || !sl || !tp || !current) return position;

  const riskDist = Math.abs(entry - sl);
  const rewardDist = Math.abs(tp - entry);
  if (!riskDist || !rewardDist) return position;

  const directionalMove = isBull ? current - entry : entry - current;
  const currentR = directionalMove / riskDist;
  const tpProgress = directionalMove / rewardDist;

  position.currentR = Number(currentR.toFixed(4));
  position.mfeR = Math.max(safeNumber(position.mfeR), position.currentR);
  position.maeR = Math.min(safeNumber(position.maeR), position.currentR);
  position.maxTpProgress = Math.max(safeNumber(position.maxTpProgress), Number(tpProgress.toFixed(4)));
  position.ticksObserved = safeNumber(position.ticksObserved) + 1;
  if (currentR > 0) position.favorableTicks = safeNumber(position.favorableTicks) + 1;
  if (currentR < 0) position.adverseTicks = safeNumber(position.adverseTicks) + 1;
  if (position.mfeR >= 0.5) position.reachedHalfR = true;
  if (position.mfeR >= 1.0) position.reachedOneR = true;
  if (tpProgress >= 0.8) position.nearTpSeen = true;

  // --- Breakeven/trailing COUNTERFACTUAL (measure-only, does not move the live SL) ---
  // We record what a BE rule WOULD have done, so Analyze can later decide per micro-family
  // whether BE/trailing actually helps. Some setups need room; we must not assume.
  // Rule modelled: once mfeR >= beArmR, a virtual stop sits at beLockR.
  const beArm = CONFIG.manage.beArmR;
  const beLock = CONFIG.manage.beLockR;
  if (position.mfeR >= beArm) {
    position.beArmed = true;
    // Virtual BE stop would be hit if price pulls back to beLockR after arming.
    if (currentR <= beLock && !position.beWouldExit) {
      position.beWouldExit = true;
      position.beExitR = beLock; // net-of-nothing here; cost applied at outcome time
    }
  }
  // Giveback diagnostics: did we surrender a winner?
  if (position.reachedHalfR && currentR < 0) position.gaveBackAfterHalfR = true;
  if (position.reachedOneR && currentR < 0.35) position.gaveBackAfterOneR = true;
  if (position.nearTpSeen && currentR < 0) position.nearTpThenLoss = true;

  position.updatedAt = Date.now();
  return position;
}

export function buildOpenPositionFromEntry(entry) {
  return {
    tradeId: randomId('trade'),
    status: 'OPEN',
    openedAt: Date.now(),
    createdAt: Date.now(),
    currentR: 0,
    mfeR: 0,
    maeR: 0,
    ticksObserved: 0,
    favorableTicks: 0,
    adverseTicks: 0,
    reachedHalfR: false,
    reachedOneR: false,
    nearTpSeen: false,
    ...entry,
    initialSl: entry.sl
  };
}

export async function monitorOpenPositions({ priceFetcher }) {
  const positions = await getOpenPositions();
  const exits = [];
  const now = Date.now();

  for (const position of positions) {
    const price = await priceFetcher(position.symbol).catch(() => 0);
    if (!price) continue;
    updatePathMetrics(position, price);

    const isBull = position.side === 'bull';
    const hitTP = isBull ? price >= position.tp : price <= position.tp;
    const hitSL = isBull ? price <= position.sl : price >= position.sl;
    const expired = now - safeNumber(position.openedAt || position.createdAt) >= CONFIG.trade.positionTimeStopMin * 60 * 1000;

    if (!hitTP && !hitSL && !expired) {
      await saveOpenPosition(position);
      continue;
    }

    const exitReason = hitTP ? 'TP' : hitSL ? 'SL' : 'TIME_STOP';
    const outcome = buildOutcomeFromPosition({ position, exitPrice: price, exitReason, source: 'REAL' });
    await recordOutcome(outcome, { source: 'REAL' });
    await sendExitAlert(outcome).catch(() => null);
    await deleteOpenPosition(position.symbol);
    exits.push(outcome);
  }

  return exits;
}
