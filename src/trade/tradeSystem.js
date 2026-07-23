// ================= FILE: src/trade/tradeSystem.js =================
// COMPLEET SHORT trade system orchestration

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, generateShortId, safeNumber } from '../utils.js';
import { openPosition, closePosition, getOpenPositions, evaluatePositions } from './positionEngine.js';
import { checkRiskLimits, applyRiskBreak, isRiskBreakActive } from './riskEngine.js';
import { scanForCandidates } from '../market/scanner.js';
import { getMarketWeather } from '../market/marketWeather.js';
import { BitgetClient } from '../market/bitgetClient.js';
import { sendEntryAlert, sendExitAlert, sendHaltAlert } from '../discord/discord.js';
import { CONFIG } from '../config.js';

const client = new BitgetClient();

export async function runTradeSystem() {
  try {
    console.log('📊 Trade system running at', new Date().toISOString());

    // Check risk break
    const riskBreakCheck = await isRiskBreakActive();
    if (riskBreakCheck.active) {
      console.log('⛔ Risk break is active - system halted');
      return { ok: true, reason: 'RISK_BREAK_ACTIVE', message: 'System halted' };
    }

    // Scan for candidates
    const scanResult = await scanForCandidates();
    if (!scanResult.ok || scanResult.candidatesCount === 0) {
      console.log('⚠️ No candidates found');
      return {
        ok: true,
        candidatesProcessed: 0,
        tradesOpened: 0,
        tradesClosed: 0,
        message: 'No candidates'
      };
    }

    // Get latest snapshot
    const redis = getRedis();
    const snapshot = await redis.get(keys.scanLatest());
    if (!snapshot || !snapshot.candidates) {
      return { ok: false, reason: 'NO_SNAPSHOT' };
    }

    const candidates = snapshot.candidates;

    // Check market conditions
    const weatherResult = await getMarketWeather();
    const weather = weatherResult.weather?.condition || 'UNKNOWN';

    // Process candidates for entry
    let tradesOpened = 0;
    const openedTrades = [];

    for (const candidate of candidates) {
      try {
        const entryCheck = await validateCandidateEntry(candidate, weather);
        if (!entryCheck.valid) {
          continue;
        }

        const openResult = await openPosition({
          symbol: candidate.symbol,
          entryPrice: candidate.entryPrice,
          tp: candidate.tp,
          sl: candidate.sl,
          entrySize: candidate.entrySize,
          microFamilyId: candidate.microFamilyId,
          setup: candidate.setup,
          regime: candidate.regime
        });

        if (openResult.ok) {
          tradesOpened++;
          openedTrades.push(openResult.position);

          await sendEntryAlert(openResult.position);
        }

      } catch (err) {
        console.error(`Error opening trade for ${candidate.symbol}:`, err.message);
        continue;
      }
    }

    // Evaluate open positions
    const openResult = await getOpenPositions();
    const openPositions = openResult.positions || [];

    if (openPositions.length > 0) {
      const currentPrices = {};
      for (const pos of openPositions) {
        const priceResult = await client.getPrice(pos.symbol);
        if (priceResult) {
          currentPrices[pos.symbol] = priceResult.last;
        }
      }

      const evalResult = await evaluatePositions(currentPrices);
      const evaluations = evalResult.evaluations || [];
      
      let tradesClosed = 0;
      for (const eval of evaluations) {
        if (eval.action.shouldClose) {
          const closeResult = await closePosition(eval.positionId, eval.currentPrice, eval.action.reason);
          if (closeResult.ok) {
            tradesClosed++;
            await sendExitAlert(closeResult.position);
          }
        }
      }

      // Check system risk limits
      const riskCheckResult = await checkSystemRisks(openPositions);
      if (!riskCheckResult.withinLimits) {
        await applyRiskBreak();
        await sendHaltAlert(riskCheckResult.violations);
        console.log('❌ Risk limits exceeded - halting system');

        return {
          ok: true,
          halted: true,
          violations: riskCheckResult.violations,
          tradesOpened,
          tradesClosed,
          candidatesProcessed: candidates.length
        };
      }

      return {
        ok: true,
        candidatesProcessed: candidates.length,
        tradesOpened,
        tradesClosed,
        activePositions: openPositions.length,
        timestamp: now()
      };
    }

    return {
      ok: true,
      candidatesProcessed: candidates.length,
      tradesOpened,
      tradesClosed: 0,
      activePositions: 0,
      timestamp: now()
    };

  } catch (err) {
    console.error('❌ runTradeSystem error:', err);
    return { ok: false, error: err.message };
  }
}

async function validateCandidateEntry(candidate = {}, weather = 'UNKNOWN') {
  try {
    if (!candidate.symbol || !candidate.entryPrice) {
      return { valid: false, reason: 'MISSING_DATA' };
    }

    // Check if already open
    const redis = getRedis();
    const openResult = await getOpenPositions();
    const alreadyOpen = openResult.positions?.some(p => p.symbol === candidate.symbol);
    if (alreadyOpen) {
      return { valid: false, reason: 'ALREADY_OPEN' };
    }

    // Check confirmation strength
    if (candidate.confirmationProfile === 'E_WEAK_CONTRA') {
      return { valid: false, reason: 'WEAK_CONFIRMATION' };
    }

    // Check R/R
    if (candidate.rrRatio < CONFIG.RISK.MIN_RR_RATIO) {
      return { valid: false, reason: 'POOR_RR' };
    }

    // Check market conditions
    if (weather === 'CHOPPY' && candidate.setup !== 'COMPRESSION') {
      return { valid: false, reason: 'CHOPPY_MARKET' };
    }

    return { valid: true };

  } catch (err) {
    console.error('validateCandidateEntry error:', err);
    return { valid: false, reason: 'VALIDATION_ERROR' };
  }
}

async function checkSystemRisks(openPositions = []) {
  try {
    const totalLoss = openPositions
      .filter(p => (p.pnl || 0) < 0)
      .reduce((sum, p) => sum + (p.pnl || 0), 0);

    const violations = [];
    const limits = CONFIG.RISK;

    if (openPositions.length > limits.MAX_CONCURRENT_TRADES) {
      violations.push(`${openPositions.length} open positions exceeds limit of ${limits.MAX_CONCURRENT_TRADES}`);
    }

    if (totalLoss < limits.MAX_LOSS_THRESHOLD) {
      violations.push(`Total loss $${Math.abs(totalLoss)} exceeds threshold`);
    }

    return {
      withinLimits: violations.length === 0,
      violations
    };

  } catch (err) {
    console.error('checkSystemRisks error:', err);
    return { withinLimits: true, violations: [] };
  }
}

export default { runTradeSystem };
