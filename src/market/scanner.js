// ================= FILE: src/market/scanner.js =================
// COMPLEET candidate scanner for SHORT opportunities

import { BitgetClient } from './bitgetClient.js';
import { 
  calculateRSI, calculateBollingerBands, calculateATR, 
  calculateMACD, calculateVolatility, calculateMomentum, calculateEMA
} from './indicators.js';
import { classifyMicroFamily } from '../analyze/microFamilies.js';
import { recordObservation } from '../analyze/analyzeEngine.js';
import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, generateShortId, safeNumber } from '../utils.js';
import { CONFIG } from '../config.js';

const client = new BitgetClient();

export async function scanForCandidates() {
  try {
    console.log('🔍 Scan starting at', new Date().toISOString());

    const redis = getRedis();
    const startTime = now();

    const tickers = await client.getTickers('usdt-futures', 500);
    if (!tickers || tickers.length === 0) {
      return { ok: false, reason: 'NO_TICKERS', candidatesCount: 0 };
    }

    const candidates = [];
    let processed = 0;
    let qualified = 0;
    let errors = 0;

    for (const ticker of tickers) {
      processed++;

      try {
        const symbol = ticker.symbol;
        if (!symbol || !symbol.includes('USDT')) continue;

        const candles = await client.getCandles(symbol, '1H', 50);
        if (!candles || candles.length < 30) continue;

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);
        const opens = candles.map(c => c.open);

        const rsi = calculateRSI(closes, 14);
        const bb = calculateBollingerBands(closes, 20, 2);
        const atr = calculateATR(highs, lows, closes, 14);
        const macd = calculateMACD(closes, 12, 26, 9);
        const volatility = calculateVolatility(closes, 20);
        const momentum = calculateMomentum(closes, 12);

        if (!rsi || !bb || !atr) continue;

        const lastClose = closes[closes.length - 1];
        const lastHigh = highs[highs.length - 1];
        const lastLow = lows[lows.length - 1];
        const lastOpen = opens[opens.length - 1];

        const setup = detectSetup(closes, highs, lows, opens, rsi, bb, atr, lastClose);
        if (setup === 'UNKNOWN') continue;

        const regime = detectRegime(closes, volatility, momentum);

        const confirmation = detectConfirmation(closes, rsi, bb, macd, lastClose);

        const entryResult = calculateEntryGeometry(
          setup,
          lastClose,
          lastHigh,
          lastLow,
          bb,
          atr,
          rsi
        );

        if (!entryResult.valid) continue;

        const rrRatio = entryResult.reward / entryResult.risk;
        if (rrRatio < CONFIG.RISK.MIN_RR_RATIO) continue;
        if (entryResult.risk > CONFIG.RISK.MAX_ACCOUNT_RISK_PERCENT) continue;

        const candidate = {
          symbol,
          setup,
          regime,
          confirmationProfile: confirmation,
          entryPrice: entryResult.entry,
          tp: entryResult.tp,
          sl: entryResult.sl,
          riskPct: entryResult.risk,
          rewardPct: entryResult.reward,
          rrRatio,
          rsi,
          volume: volumes[volumes.length - 1],
          volatility,
          momentum,
          timestamp: now(),
          scanId: generateShortId(8),
          lastClose,
          lastHigh,
          lastLow,
          atr,
          entrySize: 1
        };

        const classification = classifyMicroFamily(candidate);
        if (!classification.ok) continue;

        candidate.microFamilyId = classification.childId;
        candidate.parentMicroFamilyId = classification.parentId;

        await recordObservation(candidate);

        candidates.push(candidate);
        qualified++;

      } catch (err) {
        console.warn(`Error processing ${ticker.symbol}:`, err.message);
        errors++;
        continue;
      }

      if (processed % 50 === 0) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const snapshotId = generateShortId(16);
    const snapshot = {
      snapshotId,
      candidates,
      timestamp: startTime,
      processed,
      qualified,
      errors,
      statistics: {
        totalSymbols: tickers.length,
        processed,
        qualified,
        errors,
        qualificationRate: qualified / Math.max(1, processed),
        durationMs: now() - startTime
      }
    };

    await redis.set(keys.scanSnapshot(snapshotId), snapshot);
    await redis.set(keys.scanLatest(), snapshot);

    console.log(`✅ Scan complete: ${qualified} candidates from ${processed} symbols in ${now() - startTime}ms`);

    return {
      ok: true,
      candidatesCount: qualified,
      snapshotId,
      processed,
      errors,
      timestamp: startTime
    };

  } catch (err) {
    console.error('❌ scanForCandidates error:', err);
    return {
      ok: false,
      reason: 'SYSTEM_ERROR',
      error: err.message,
      candidatesCount: 0
    };
  }
}

function detectSetup(closes = [], highs = [], lows = [], opens = [], rsi = 50, bb = null, atr = 0, lastClose = 0) {
  if (closes.length < 20) return 'UNKNOWN';

  const recent5 = closes.slice(-5).map(c => parseFloat(c));
  const prev15 = closes.slice(-20, -5).map(c => parseFloat(c));
  const recent10 = closes.slice(-10).map(c => parseFloat(c));

  if (lastClose < Math.min(...prev15) * 0.995) {
    return 'BREAKOUT';
  }

  const support = Math.min(...closes.slice(-20));
  if (lastClose > support && lastClose < support * 1.02 && Math.max(...recent5.slice(0, 3)) < support) {
    return 'RETEST';
  }

  const range = Math.max(...recent10) - Math.min(...recent10);
  const avgClose = recent10.reduce((a, b) => a + b, 0) / 10;
  if (range > avgClose * 0.04) {
    return 'SWEEP_REVERSAL';
  }

  if (recent5[0] > recent5[1] && recent5[1] > recent5[2] && recent5[2] > recent5[3]) {
    return 'CONTINUATION';
  }

  if (range / avgClose < 0.015) {
    return 'COMPRESSION';
  }

  return 'UNKNOWN';
}

function detectRegime(closes = [], volatility = 0, momentum = 0) {
  if (closes.length < 20) return 'UNKNOWN';

  const recent20 = closes.slice(-20).map(c => parseFloat(c));
  const high = Math.max(...recent20);
  const low = Math.min(...recent20);
  const range = (high - low) / (recent20.reduce((a, b) => a + b, 0) / 20);

  if (range > 0.05 && Math.abs(momentum) > 0.02) {
    return 'TREND';
  }

  if (range < 0.01) {
    return 'SQUEEZE';
  }

  return 'CHOP';
}

function detectConfirmation(closes = [], rsi = 50, bb = null, macd = null, lastClose = 0) {
  const rsiVal = safeNumber(rsi, 50);

  if (rsiVal > 70 && bb && lastClose < bb.lower) {
    return 'A_STRONG_ALIGN';
  }

  if (rsiVal > 60 && rsiVal <= 70) {
    return 'B_FLOW_ALIGN';
  }

  if (rsiVal > 50 && rsiVal <= 60) {
    return 'C_VOLUME_ALIGN';
  }

  if (rsiVal >= 40 && rsiVal <= 50) {
    return 'D_MIXED_OK';
  }

  return 'E_WEAK_CONTRA';
}

function calculateEntryGeometry(setup = '', lastClose = 0, lastHigh = 0, lastLow = 0, bb = null, atr = 0, rsi = 50) {
  const close = safeNumber(lastClose, 0);
  const high = safeNumber(lastHigh, 0);
  const low = safeNumber(lastLow, 0);

  if (close <= 0) return { valid: false };

  let entry, tp, sl;

  if (setup === 'BREAKOUT') {
    entry = close * 0.998;
    tp = close * 0.96;
    sl = close * 1.02;
  } else if (setup === 'RETEST') {
    entry = close * 0.998;
    tp = low * 0.98;
    sl = high * 1.01;
  } else if (setup === 'SWEEP_REVERSAL') {
    entry = close * 0.998;
    tp = low * 0.98;
    sl = high * 1.02;
  } else if (setup === 'CONTINUATION') {
    entry = close * 0.998;
    tp = close * 0.97;
    sl = high * 1.015;
  } else if (setup === 'COMPRESSION') {
    entry = close * 0.998;
    tp = close * 0.97;
    sl = close * 1.025;
  } else {
    return { valid: false };
  }

  if (sl <= entry || tp >= entry) {
    return { valid: false };
  }

  const risk = Math.abs(sl - entry) / entry;
  const reward = Math.abs(entry - tp) / entry;

  if (risk <= 0 || reward <= 0) {
    return { valid: false };
  }

  return {
    valid: true,
    entry,
    tp,
    sl,
    risk,
    reward
  };
}

export default { scanForCandidates };
