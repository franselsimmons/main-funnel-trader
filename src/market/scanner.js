// ================= FILE: src/market/scanner.js =================
//
// Complete candidate scanner
// Finds SHORT setup opportunities in USDT perpetuals
//

import { BitgetClient } from './bitgetClient.js';
import { calculateRSI, calculateBollingerBands } from './indicators.js';
import { classifyMicroFamily } from '../analyze/microFamilies.js';
import { recordObservation } from '../analyze/analyzeEngine.js';
import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now, generateShortId } from '../utils.js';

const client = new BitgetClient(
  process.env.BITGET_API_KEY || '',
  process.env.BITGET_SECRET_KEY || '',
  process.env.BITGET_PASSPHRASE || ''
);

/**
 * Main scan function - finds all qualified candidates
 */
export async function scanForCandidates() {
  try {
    console.log('🔍 Starting candidate scan at', new Date().toISOString());

    // Get all USDT perpetuals tickers
    const tickers = await client.getTickers('usdt-futures', 500);
    if (!tickers || tickers.length === 0) {
      return {
        ok: false,
        reason: 'NO_TICKERS',
        candidatesCount: 0
      };
    }

    const candidates = [];
    let processed = 0;
    let qualified = 0;
    let errors = 0;

    // Process each symbol
    for (const ticker of tickers) {
      processed++;

      try {
        const symbol = ticker.symbol;
        if (!symbol || !symbol.includes('USDT')) continue;

        // Get 50 1H candles for analysis
        const candles = await client.getCandles(symbol, '1H', 50);
        if (!candles || candles.length < 30) {
          continue;
        }

        const closes = candles.map(c => parseFloat(c.close));
        const highs = candles.map(c => parseFloat(c.high));
        const lows = candles.map(c => parseFloat(c.low));
        const volumes = candles.map(c => parseFloat(c.volume));

        // Calculate technical indicators
        const rsi = calculateRSI(closes, 14);
        const bb = calculateBollingerBands(closes, 20, 2);
        
        if (rsi === null || bb === null) {
          continue;
        }

        const lastClose = closes[closes.length - 1];
        const lastHigh = highs[highs.length - 1];
        const lastLow = lows[lows.length - 1];

        // Detect setup, regime, confirmation
        const setup = detectSetup(closes, highs, lows);
        const regime = detectRegime(closes);
        const confirmationProfile = detectConfirmation(closes, rsi, bb, lastClose);

        // Calculate entry/TP/SL for SHORT positions
        let entryPrice = null;
        let tp = null;
        let sl = null;

        if (setup === 'BREAKOUT') {
          if (lastClose < bb.lower) {
            entryPrice = lastClose * 0.998;
            tp = lastClose * 0.96;
            sl = lastClose * 1.02;
          }
        } else if (setup === 'RETEST') {
          if (lastClose > bb.middle && lastLow < bb.lower) {
            entryPrice = lastClose * 0.998;
            tp = lastLow * 0.98;
            sl = lastHigh * 1.01;
          }
        } else if (setup === 'SWEEP_REVERSAL') {
          const recent10 = closes.slice(-10);
          const high10 = Math.max(...recent10);
          const low10 = Math.min(...recent10);
          if (lastLow < low10 * 0.99 && lastClose > low10 * 1.005) {
            entryPrice = lastClose * 0.998;
            tp = low10 * 0.98;
            sl = high10 * 1.02;
          }
        } else if (setup === 'CONTINUATION') {
          if (rsi > 60 && lastClose < closes[closes.length - 2]) {
            entryPrice = lastClose * 0.998;
            tp = lastClose * 0.97;
            sl = lastHigh * 1.015;
          }
        } else if (setup === 'COMPRESSION') {
          const recent5 = closes.slice(-5);
          const range = Math.max(...recent5) - Math.min(...recent5);
          const avgClose = recent5.reduce((a, b) => a + b, 0) / 5;
          if (range / avgClose < 0.005 && Math.abs(rsi - 50) > 10) {
            entryPrice = lastClose * 0.998;
            tp = lastClose * 0.97;
            sl = lastClose * 1.025;
          }
        }

        if (!entryPrice || !tp || !sl) {
          continue;
        }

        // Validate risk/reward
        const riskPct = (sl - entryPrice) / entryPrice;
        const rewardPct = (entryPrice - tp) / entryPrice;
        
        if (riskPct <= 0 || rewardPct <= 0) {
          continue;
        }

        const rrRatio = rewardPct / riskPct;
        
        // Must have at least 1.5:1 risk/reward
        if (rrRatio < 1.5) {
          continue;
        }

        // Risk can't exceed 5%
        if (riskPct > 0.05) {
          continue;
        }

        // Create candidate object
        const candidate = {
          symbol,
          setup,
          regime,
          confirmationProfile,
          entryPrice,
          tp,
          sl,
          riskPct: Math.abs(riskPct),
          rewardPct,
          rrRatio,
          rsi,
          lastClose,
          volume: volumes[volumes.length - 1],
          timestamp: now(),
          scanId: generateShortId(8)
        };

        // Classify micro-family
        const classification = classifyMicroFamily(candidate);
        if (!classification.ok) {
          continue;
        }

        candidate.microFamilyId = classification.childId;
        candidate.parentMicroFamilyId = classification.parentId;

        // Record observation in analytics
        await recordObservation(candidate);

        candidates.push(candidate);
        qualified++;

      } catch (err) {
        console.warn(`⚠️  Error processing ${ticker.symbol}:`, err.message);
        errors++;
        continue;
      }

      // Rate limit - pause every 50 symbols
      if (processed % 50 === 0) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Create and save snapshot
    const snapshotId = generateShortId(16);
    const snapshot = {
      snapshotId,
      candidates,
      timestamp: now(),
      processed,
      qualified,
      errors,
      statistics: {
        totalSymbols: tickers.length,
        processed,
        qualified,
        errors,
        qualificationRate: qualified / Math.max(1, processed)
      }
    };

    const redis = getRedis();
    await redis.set(keys.scanSnapshot(snapshotId), snapshot);
    await redis.set(keys.scanLatest(), snapshot);

    console.log(`✅ Scan complete: ${qualified} qualified candidates from ${processed} processed (${errors} errors)`);

    return {
      ok: true,
      candidatesCount: qualified,
      snapshotId,
      processed,
      errors,
      timestamp: now()
    };

  } catch (err) {
    console.error('❌ scanForCandidates error:', err);
    return {
      ok: false,
      reason: 'SCAN_ERROR',
      error: err.message,
      candidatesCount: 0
    };
  }
}

/**
 * Detect setup type from price action
 */
function detectSetup(closes = [], highs = [], lows = []) {
  if (!closes || closes.length < 20) {
    return 'UNKNOWN';
  }

  const recent5 = closes.slice(-5).map(c => parseFloat(c));
  const prev15 = closes.slice(-20, -5).map(c => parseFloat(c));
  const lastClose = closes[closes.length - 1];

  // BREAKOUT: price breaks below recent support
  if (lastClose < Math.min(...prev15) * 0.995) {
    return 'BREAKOUT';
  }

  // RETEST: price touches support and bounces
  const prev20Low = Math.min(...closes.slice(-20));
  if (lastClose > prev20Low && Math.max(...recent5.slice(0, 3)) < prev20Low) {
    return 'RETEST';
  }

  // SWEEP_REVERSAL: strong move then reversal
  const allRecent = closes.slice(-10).map(c => parseFloat(c));
  const range = Math.max(...allRecent) - Math.min(...allRecent);
  const avgClose = allRecent.reduce((a, b) => a + b, 0) / allRecent.length;
  if (range > avgClose * 0.04) {
    return 'SWEEP_REVERSAL';
  }

  // CONTINUATION: continuing trend
  const recent3 = closes.slice(-3).map(c => parseFloat(c));
  if (recent3[0] > recent3[1] && recent3[1] > recent3[2]) {
    return 'CONTINUATION';
  }

  // COMPRESSION: low volatility before move
  const rangePct = (Math.max(...recent5) - Math.min(...recent5)) / (closes[closes.length - 2] || 1);
  if (rangePct < 0.015 && rangePct > 0) {
    return 'COMPRESSION';
  }

  return 'UNKNOWN';
}

/**
 * Detect market regime
 */
function detectRegime(closes = []) {
  if (!closes || closes.length < 20) {
    return 'UNKNOWN';
  }

  const recent20 = closes.slice(-20).map(c => parseFloat(c));
  const high = Math.max(...recent20);
  const low = Math.min(...recent20);
  const avg = recent20.reduce((a, b) => a + b, 0) / 20;
  const range = (high - low) / avg;

  // TREND: large range with clear direction
  if (range > 0.05) {
    const downCount = recent20.filter((c, i) => i > 0 && c < recent20[i - 1]).length;
    return downCount > 12 ? 'TREND' : 'TREND';
  }

  // SQUEEZE: very tight range
  if (range < 0.01) {
    return 'SQUEEZE';
  }

  // CHOP: mid-range, sideways
  return 'CHOP';
}

/**
 * Detect confirmation profile
 */
function detectConfirmation(closes = [], rsi = 50, bb = null, lastClose = 0) {
  // A_STRONG_ALIGN: Strong confluence signals
  if (rsi > 70 && lastClose < (bb?.lower || 0)) {
    return 'A_STRONG_ALIGN';
  }

  // B_FLOW_ALIGN: Flow alignment
  if (rsi > 60 && rsi <= 70) {
    return 'B_FLOW_ALIGN';
  }

  // C_VOLUME_ALIGN: Volume confirmation
  if (rsi > 50 && rsi <= 60) {
    return 'C_VOLUME_ALIGN';
  }

  // D_MIXED_OK: Mixed signals but acceptable
  if (rsi >= 40 && rsi <= 50) {
    return 'D_MIXED_OK';
  }

  // E_WEAK_CONTRA: Weak or contra signals
  return 'E_WEAK_CONTRA';
}

export default {
  scanForCandidates
};
