// ================= FILE: src/trade/positionEngine.js =================
//
// Virtual position engine for SHORT positions
// Manages entry, exit, P&L tracking
//

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, generateShortId } from '../utils.js';

/**
 * Create a new virtual SHORT position
 */
export async function createPosition({
  microFamilyId = '',
  symbol = '',
  entryPrice = 0,
  entrySize = 1,
  stopLoss = 0,
  takeProfit = 0,
  setup = '',
  regime = '',
  confirmationProfile = '',
  scanId = ''
} = {}) {
  try {
    const positionId = generateShortId(12);
    const timestamp = now();

    const position = {
      positionId,
      microFamilyId,
      symbol,
      side: 'SHORT',
      entryPrice: parseFloat(entryPrice),
      entrySize: parseInt(entrySize),
      stopLoss: parseFloat(stopLoss),
      takeProfit: parseFloat(takeProfit),
      setup,
      regime,
      confirmationProfile,
      scanId,
      status: 'OPEN',
      createdAt: timestamp,
      enteredAt: null,
      closedAt: null,
      pnl: 0,
      pnlPercent: 0,
      exitPrice: null,
      exitReason: null,
      currentPrice: entryPrice,
      highPrice: entryPrice,
      lowPrice: entryPrice,
      trades: []
    };

    const redis = getRedis();
    await redis.set(keys.position(positionId), position);
    await redis.set(keys.positionsByFamily(microFamilyId, positionId), positionId);

    return {
      ok: true,
      positionId,
      position
    };
  } catch (err) {
    console.error('createPosition error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Get position details
 */
export async function getPosition(positionId = '') {
  try {
    const redis = getRedis();
    const position = await redis.get(keys.position(positionId));

    if (!position) {
      return {
        ok: false,
        reason: 'NOT_FOUND'
      };
    }

    return {
      ok: true,
      position
    };
  } catch (err) {
    console.error('getPosition error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Update position with current price
 */
export async function updatePositionPrice(positionId = '', currentPrice = 0) {
  try {
    const posResult = await getPosition(positionId);
    if (!posResult.ok) {
      return posResult;
    }

    const position = posResult.position;
    const price = parseFloat(currentPrice);

    if (price <= 0) {
      return { ok: false, reason: 'INVALID_PRICE' };
    }

    // Update price tracking
    position.currentPrice = price;
    position.highPrice = Math.max(position.highPrice, price);
    position.lowPrice = Math.min(position.lowPrice, price);

    // Calculate P&L for SHORT
    const pnl = (position.entryPrice - price) * position.entrySize;
    position.pnl = pnl;
    position.pnlPercent = ((position.entryPrice - price) / position.entryPrice) * 100;

    const redis = getRedis();
    await redis.set(keys.position(positionId), position);

    return {
      ok: true,
      position,
      pnl,
      pnlPercent: position.pnlPercent
    };
  } catch (err) {
    console.error('updatePositionPrice error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Close a position at specific price
 */
export async function closePosition(
  positionId = '',
  exitPrice = 0,
  exitReason = 'MANUAL'
) {
  try {
    const posResult = await getPosition(positionId);
    if (!posResult.ok) {
      return posResult;
    }

    const position = posResult.position;
    const price = parseFloat(exitPrice);

    if (price <= 0) {
      return { ok: false, reason: 'INVALID_EXIT_PRICE' };
    }

    // Calculate final P&L
    const pnl = (position.entryPrice - price) * position.entrySize;
    const pnlPercent = ((position.entryPrice - price) / position.entryPrice) * 100;

    // Close the position
    position.status = 'CLOSED';
    position.exitPrice = price;
    position.exitReason = exitReason;
    position.closedAt = now();
    position.pnl = pnl;
    position.pnlPercent = pnlPercent;

    const redis = getRedis();
    await redis.set(keys.position(positionId), position);

    // Record to analytics
    const trade = {
      positionId,
      microFamilyId: position.microFamilyId,
      symbol: position.symbol,
      setup: position.setup,
      regime: position.regime,
      confirmationProfile: position.confirmationProfile,
      side: 'SHORT',
      entryPrice: position.entryPrice,
      exitPrice: price,
      entrySize: position.entrySize,
      pnl,
      pnlPercent,
      pnlR: pnlPercent / 100,
      exitReason,
      durationSeconds: position.closedAt - position.createdAt,
      createdAt: position.createdAt,
      closedAt: position.closedAt
    };

    await redis.set(keys.completedTrade(positionId), trade);

    return {
      ok: true,
      position,
      trade,
      pnl,
      pnlPercent,
      pnlR: pnlPercent / 100
    };
  } catch (err) {
    console.error('closePosition error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Check if position hit TP, SL, or other exit conditions
 */
export async function checkExitConditions(positionId = '', currentPrice = 0) {
  try {
    const posResult = await getPosition(positionId);
    if (!posResult.ok) {
      return { ok: false, ...posResult };
    }

    const position = posResult.position;
    const price = parseFloat(currentPrice);

    // Already closed?
    if (position.status !== 'OPEN') {
      return { ok: true, shouldExit: false, reason: 'POSITION_CLOSED' };
    }

    const price_fl = parseFloat(currentPrice);
    const tp_fl = parseFloat(position.takeProfit);
    const sl_fl = parseFloat(position.stopLoss);

    // SHORT: TP is lower, SL is higher
    if (price_fl <= tp_fl) {
      return {
        ok: true,
        shouldExit: true,
        reason: 'TAKE_PROFIT_HIT',
        exitPrice: tp_fl,
        pnlPercent: ((position.entryPrice - tp_fl) / position.entryPrice) * 100
      };
    }

    if (price_fl >= sl_fl) {
      return {
        ok: true,
        shouldExit: true,
        reason: 'STOP_LOSS_HIT',
        exitPrice: sl_fl,
        pnlPercent: ((position.entryPrice - sl_fl) / position.entryPrice) * 100
      };
    }

    // No exit condition
    return {
      ok: true,
      shouldExit: false,
      reason: 'NO_EXIT_CONDITION',
      currentPrice: price
    };
  } catch (err) {
    console.error('checkExitConditions error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Get all open positions
 */
export async function getOpenPositions() {
  try {
    const redis = getRedis();
    const pattern = 'POSITION:*';
    const keys_list = await redis.keys(pattern);

    const positions = [];

    for (const key of keys_list) {
      const pos = await redis.get(key);
      if (pos && pos.status === 'OPEN') {
        positions.push(pos);
      }
    }

    return {
      ok: true,
      positions,
      count: positions.length
    };
  } catch (err) {
    console.error('getOpenPositions error:', err);
    return {
      ok: false,
      positions: [],
      error: err.message
    };
  }
}

/**
 * Get positions by micro-family
 */
export async function getPositionsByFamily(microFamilyId = '') {
  try {
    const redis = getRedis();
    const patternKey = `POSITIONS:FAMILY:${microFamilyId}:*`;
    const positionIds = await redis.keys(patternKey);

    const positions = [];

    for (const key of positionIds) {
      const id = key.split(':')[3];
      const pos = await redis.get(`POSITION:${id}`);
      if (pos) {
        positions.push(pos);
      }
    }

    return {
      ok: true,
      microFamilyId,
      positions,
      openCount: positions.filter(p => p.status === 'OPEN').length,
      closedCount: positions.filter(p => p.status === 'CLOSED').length
    };
  } catch (err) {
    console.error('getPositionsByFamily error:', err);
    return {
      ok: false,
      error: err.message,
      positions: []
    };
  }
}

/**
 * Calculate portfolio P&L
 */
export async function calculatePortfolioPnL() {
  try {
    const openResult = await getOpenPositions();
    if (!openResult.ok) {
      return { ok: false, error: openResult.error };
    }

    let totalPnl = 0;
    let totalPnlPercent = 0;
    let winCount = 0;
    let lossCount = 0;

    for (const pos of openResult.positions) {
      totalPnl += pos.pnl || 0;

      if (pos.pnl > 0) {
        winCount++;
      } else if (pos.pnl < 0) {
        lossCount++;
      }
    }

    const winRate = (winCount / Math.max(1, winCount + lossCount)) * 100;

    return {
      ok: true,
      totalPnl,
      positionCount: openResult.positions.length,
      winCount,
      lossCount,
      winRate: winRate.toFixed(2),
      statistics: {
        avgPnl: openResult.positions.length > 0 ? totalPnl / openResult.positions.length : 0,
        largestWin: Math.max(...openResult.positions.map(p => p.pnl || 0)),
        largestLoss: Math.min(...openResult.positions.map(p => p.pnl || 0))
      }
    };
  } catch (err) {
    console.error('calculatePortfolioPnL error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export default {
  createPosition,
  getPosition,
  updatePositionPrice,
  closePosition,
  checkExitConditions,
  getOpenPositions,
  getPositionsByFamily,
  calculatePortfolioPnL
};
