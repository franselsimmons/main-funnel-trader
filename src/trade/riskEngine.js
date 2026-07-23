// ================= FILE: src/trade/riskEngine.js =================
// Risk management and limits

import { CONFIG } from '../config.js';
import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now } from '../utils.js';

export async function checkRiskLimits(stats = {}) {
  try {
    const limits = CONFIG.RISK;
    const reasons = [];
    
    if (stats.dailyDrawdown && stats.dailyDrawdown > limits.MAX_DAILY_DRAWDOWN_PERCENT) {
      reasons.push(`Daily drawdown ${(stats.dailyDrawdown * 100).toFixed(2)}% exceeds ${(limits.MAX_DAILY_DRAWDOWN_PERCENT * 100)}%`);
    }

    if (stats.maxConcurrentTrades && stats.maxConcurrentTrades > limits.MAX_CONCURRENT_TRADES) {
      reasons.push(`${stats.maxConcurrentTrades} concurrent trades exceeds limit of ${limits.MAX_CONCURRENT_TRADES}`);
    }

    if (stats.weeklyLoss && stats.weeklyLoss > limits.MAX_WEEKLY_LOSS_PERCENT) {
      reasons.push(`Weekly loss exceeds limit`);
    }

    const shouldHalt = reasons.length > 0;

    return {
      ok: true,
      withinLimits: !shouldHalt,
      violations: reasons,
      shouldHalt
    };

  } catch (err) {
    console.error('checkRiskLimits error:', err);
    return { ok: false, withinLimits: true, error: err.message };
  }
}

export async function applyRiskBreak() {
  try {
    const redis = getRedis();
    await redis.set(keys.riskBreak(), { engaged: true, engagedAt: now() });
    return { ok: true, message: 'Risk break engaged' };
  } catch (err) {
    console.error('applyRiskBreak error:', err);
    return { ok: false, error: err.message };
  }
}

export async function isRiskBreakActive() {
  try {
    const redis = getRedis();
    const riskBreak = await redis.get(keys.riskBreak());
    return { ok: true, active: !!riskBreak };
  } catch (err) {
    return { ok: false, active: false, error: err.message };
  }
}

export async function releaseRiskBreak() {
  try {
    const redis = getRedis();
    await redis.delete(keys.riskBreak());
    return { ok: true, message: 'Risk break released' };
  } catch (err) {
    console.error('releaseRiskBreak error:', err);
    return { ok: false, error: err.message };
  }
}

export default {
  checkRiskLimits, applyRiskBreak, isRiskBreakActive, releaseRiskBreak
};
