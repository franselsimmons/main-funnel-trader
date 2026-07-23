// ================= FILE: src/trade/positionEngine.js =================
// Virtual position management

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, generateShortId, roundTo, safeNumber } from '../utils.js';
import { calculateNetPnL } from './costModel.js';

export async function openPosition(trade = {}) {
  try {
    const redis = getRedis();
    const positionId = generateShortId(16);

    const position = {
      positionId,
      symbol: trade.symbol,
      side: 'SHORT',
      entryPrice: safeNumber(trade.entryPrice, 0),
      tp: safeNumber(trade.tp, 0),
      sl: safeNumber(trade.sl, 0),
      size: safeNumber(trade.entrySize, 1),
      entryTime: now(),
      openedAt: now(),
      microFamilyId: trade.microFamilyId,
      setup: trade.setup,
      regime: trade.regime,
      weekKey: getWeekKey(),
      status: 'OPEN',
      pnl: 0,
      pnlPercent: 0,
      pnlR: 0
    };

    const key = keys.position(positionId);
    await redis.set(key, position);

    // Add to active positions set
    await redis.lpush(keys.activePositions(), positionId);

    return {
      ok: true,
      positionId,
      position
    };

  } catch (err) {
    console.error('openPosition error:', err);
    return { ok: false, error: err.message };
  }
}

export async function closePosition(positionId = '', exitPrice = 0, exitReason = 'MANUAL_CLOSE') {
  try {
    const redis = getRedis();
    const key = keys.position(positionId);
    const position = await redis.get(key);

    if (!position) {
      return { ok: false, reason: 'POSITION_NOT_FOUND' };
    }

    const durationSeconds = Math.floor((now() - position.entryTime) / 1000);
    const pnlCalc = calculateNetPnL(position.entryPrice, exitPrice, position.size, 'SHORT');

    position.exitPrice = exitPrice;
    position.exitTime = now();
    position.closedAt = now();
    position.exitReason = exitReason;
    position.durationSeconds = durationSeconds;
    position.status = 'CLOSED';
    position.pnl = pnlCalc.netPnL;
    position.pnlPercent = pnlCalc.netPercentage;
    position.pnlR = (pnlCalc.netPnL) / Math.abs(position.entryPrice - position.sl);

    await redis.set(key, position);

    // Move from active to closed
    const closedKey = keys.closedPosition(positionId);
    await redis.set(closedKey, position);

    // Also save to family trade history
    const familyTradeKey = keys.familyTrade(position.microFamilyId, positionId);
    await redis.set(familyTradeKey, position);

    return {
      ok: true,
      positionId,
      pnl: position.pnl,
      pnlR: position.pnlR,
      exitReason,
      position
    };

  } catch (err) {
    console.error('closePosition error:', err);
    return { ok: false, error: err.message };
  }
}

export async function getPosition(positionId = '') {
  try {
    const redis = getRedis();
    const position = await redis.get(keys.position(positionId));
    return { ok: true, position };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function getOpenPositions() {
  try {
    const redis = getRedis();
    const positionIds = await redis.lrange(keys.activePositions(), 0, -1);
    
    const positions = [];
    for (const posId of positionIds) {
      const pos = await redis.get(keys.position(posId));
      if (pos && pos.status === 'OPEN') {
        positions.push(pos);
      }
    }

    return { ok: true, positions, count: positions.length };
  } catch (err) {
    return { ok: false, error: err.message, positions: [] };
  }
}

export async function updatePosition(positionId = '', currentPrice = 0) {
  try {
    const redis = getRedis();
    const position = await redis.get(keys.position(positionId));

    if (!position || position.status !== 'OPEN') {
      return { ok: false, reason: 'POSITION_NOT_FOUND' };
    }

    const pnlCalc = calculateNetPnL(position.entryPrice, currentPrice, position.size, 'SHORT');
    position.pnl = pnlCalc.netPnL;
    position.pnlPercent = pnlCalc.netPercentage;
    position.lastUpdate = now();

    await redis.set(keys.position(positionId), position);

    return { ok: true, position, pnl: position.pnl };

  } catch (err) {
    console.error('updatePosition error:', err);
    return { ok: false, error: err.message };
  }
}

export async function evaluatePositions(currentPrices = {}) {
  try {
    const openResult = await getOpenPositions();
    if (!openResult.ok) return { ok: false, error: openResult.error };

    const evaluations = [];

    for (const position of openResult.positions) {
      const currentPrice = currentPrices[position.symbol];
      if (!currentPrice) continue;

      const action = evaluatePosition(position, currentPrice);
      evaluations.push({
        positionId: position.positionId,
        symbol: position.symbol,
        currentPrice,
        action
      });

      if (action.shouldClose) {
        await closePosition(position.positionId, currentPrice, action.reason);
      }
    }

    return { ok: true, evaluations };

  } catch (err) {
    console.error('evaluatePositions error:', err);
    return { ok: false, error: err.message };
  }
}

function evaluatePosition(position = {}, currentPrice = 0) {
  let shouldClose = false;
  let reason = 'OPEN';

  if (currentPrice <= position.tp) {
    shouldClose = true;
    reason = 'TAKE_PROFIT_HIT';
  } else if (currentPrice >= position.sl) {
    shouldClose = true;
    reason = 'STOP_LOSS_HIT';
  }

  return { shouldClose, reason };
}

function getWeekKey() {
  const date = new Date();
  const year = date.getFullYear();
  const dayNum = date.getUTCDay() || 7;
  const firstDay = new Date(Date.UTC(year, 0, 1));
  const adjustedDate = new Date(date);
  adjustedDate.setUTCDate(adjustedDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(adjustedDate.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((adjustedDate - yearStart) / 86400000) + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

export default {
  openPosition, closePosition, getPosition, getOpenPositions, updatePosition, evaluatePositions
};
