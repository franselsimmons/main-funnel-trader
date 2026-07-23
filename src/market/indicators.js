// ================= FILE: src/market/indicators.js =================
//
// Complete technical indicators library
// All calculations used by scanner for setup/regime detection
//

/**
 * Simple Moving Average
 */
export function calculateSMA(prices = [], period = 20) {
  if (!prices || prices.length < period) {
    return null;
  }

  const recentPrices = prices.slice(-period);
  const sum = recentPrices.reduce((acc, price) => acc + parseFloat(price), 0);
  return sum / period;
}

/**
 * Exponential Moving Average
 */
export function calculateEMA(prices = [], period = 12) {
  if (!prices || prices.length < period) {
    return null;
  }

  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((acc, p) => acc + parseFloat(p), 0) / period;

  for (let i = period; i < prices.length; i++) {
    ema = parseFloat(prices[i]) * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Relative Strength Index (RSI)
 */
export function calculateRSI(prices = [], period = 14) {
  if (!prices || prices.length < period + 1) {
    return null;
  }

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(parseFloat(prices[i]) - parseFloat(prices[i - 1]));
  }

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < period; i++) {
    const change = changes[i];
    if (change > 0) {
      avgGain += change;
    } else {
      avgLoss += Math.abs(change);
    }
  }

  avgGain /= period;
  avgLoss /= period;

  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  let rsi = 100 - (100 / (1 + rs));

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }

    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi = 100 - (100 / (1 + rs));
  }

  return Math.min(100, Math.max(0, rsi));
}

/**
 * Bollinger Bands
 */
export function calculateBollingerBands(prices = [], period = 20, stdDevMultiplier = 2) {
  if (!prices || prices.length < period) {
    return null;
  }

  const recentPrices = prices.slice(-period);
  const sma = recentPrices.reduce((acc, p) => acc + parseFloat(p), 0) / period;

  let variance = 0;
  for (const price of recentPrices) {
    const diff = parseFloat(price) - sma;
    variance += diff * diff;
  }
  variance /= period;

  const stdDev = Math.sqrt(variance);

  return {
    upper: sma + (stdDev * stdDevMultiplier),
    middle: sma,
    lower: sma - (stdDev * stdDevMultiplier),
    stdDev: stdDev
  };
}

/**
 * Average True Range (ATR)
 */
export function calculateATR(highs = [], lows = [], closes = [], period = 14) {
  if (!highs || !lows || !closes || highs.length < period) {
    return null;
  }

  const trueRanges = [];

  for (let i = 1; i < highs.length; i++) {
    const high = parseFloat(highs[i]);
    const low = parseFloat(lows[i]);
    const prevClose = parseFloat(closes[i - 1]);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return null;
  }

  let atr = trueRanges.slice(0, period).reduce((acc, tr) => acc + tr, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

/**
 * MACD (Moving Average Convergence Divergence)
 */
export function calculateMACD(prices = [], fast = 12, slow = 26, signal = 9) {
  if (!prices || prices.length < slow) {
    return null;
  }

  const fastEMA = calculateEMA(prices, fast);
  const slowEMA = calculateEMA(prices, slow);

  if (fastEMA === null || slowEMA === null) {
    return null;
  }

  const macdLine = fastEMA - slowEMA;

  // Calculate signal line (EMA of MACD)
  const macdValues = [];
  for (let i = slow - 1; i < prices.length; i++) {
    const pricesSubset = prices.slice(0, i + 1);
    const fastEMALocal = calculateEMA(pricesSubset, fast);
    const slowEMALocal = calculateEMA(pricesSubset, slow);
    if (fastEMALocal !== null && slowEMALocal !== null) {
      macdValues.push(fastEMALocal - slowEMALocal);
    }
  }

  const signalLine = calculateEMA(macdValues, signal);

  return {
    macd: macdLine,
    signal: signalLine,
    histogram: signalLine !== null ? macdLine - signalLine : null,
    fast: fastEMA,
    slow: slowEMA
  };
}

/**
 * Stochastic Oscillator
 */
export function calculateStochastic(highs = [], lows = [], closes = [], period = 14, smoothK = 3, smoothD = 3) {
  if (!highs || !lows || !closes || highs.length < period) {
    return null;
  }

  const kValues = [];

  for (let i = period - 1; i < closes.length; i++) {
    const recentHighs = highs.slice(i - period + 1, i + 1);
    const recentLows = lows.slice(i - period + 1, i + 1);
    const close = parseFloat(closes[i]);

    const highestHigh = Math.max(...recentHighs.map(h => parseFloat(h)));
    const lowestLow = Math.min(...recentLows.map(l => parseFloat(l)));

    const k = (close - lowestLow) / (highestHigh - lowestLow) * 100;
    kValues.push(k);
  }

  if (kValues.length < smoothK) {
    return null;
  }

  const smothKValues = [];
  for (let i = smoothK - 1; i < kValues.length; i++) {
    const avg = kValues.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0) / smoothK;
    smothKValues.push(avg);
  }

  const dValues = [];
  for (let i = smoothD - 1; i < smothKValues.length; i++) {
    const avg = smothKValues.slice(i - smoothD + 1, i + 1).reduce((a, b) => a + b, 0) / smoothD;
    dValues.push(avg);
  }

  const k = smothKValues[smothKValues.length - 1];
  const d = dValues[dValues.length - 1];

  return {
    k: k,
    d: d,
    histogram: k - d
  };
}

/**
 * Volume Weighted Average Price (VWAP)
 */
export function calculateVWAP(highs = [], lows = [], closes = [], volumes = []) {
  if (!highs || !lows || !closes || !volumes || highs.length === 0) {
    return null;
  }

  let cumulativePQ = 0;
  let cumulativeV = 0;

  for (let i = 0; i < closes.length; i++) {
    const typicalPrice = (parseFloat(highs[i]) + parseFloat(lows[i]) + parseFloat(closes[i])) / 3;
    const volume = parseFloat(volumes[i]);

    cumulativePQ += typicalPrice * volume;
    cumulativeV += volume;
  }

  if (cumulativeV === 0) {
    return null;
  }

  return cumulativePQ / cumulativeV;
}

/**
 * Average Directional Index (ADX)
 */
export function calculateADX(highs = [], lows = [], closes = [], period = 14) {
  if (!highs || !lows || !closes || highs.length < period + 1) {
    return null;
  }

  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < highs.length; i++) {
    const high = parseFloat(highs[i]);
    const low = parseFloat(lows[i]);
    const prevHigh = parseFloat(highs[i - 1]);
    const prevLow = parseFloat(lows[i - 1]);

    let plusDM = 0;
    let minusDM = 0;

    const highDiff = high - prevHigh;
    const lowDiff = prevLow - low;

    if (highDiff > 0 && highDiff > lowDiff) {
      plusDM = highDiff;
    }

    if (lowDiff > 0 && lowDiff > highDiff) {
      minusDM = lowDiff;
    }

    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  const atr = calculateATR(highs, lows, closes, period);
  if (atr === null) {
    return null;
  }

  let plusDI = (plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period) / atr * 100;
  let minusDI = (minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period) / atr * 100;

  let dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  let adx = dx;

  for (let i = period; i < plusDMs.length; i++) {
    const avgPlusDM = (plusDMs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0)) / period;
    const avgMinusDM = (minusDMs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0)) / period;

    plusDI = avgPlusDM / atr * 100;
    minusDI = avgMinusDM / atr * 100;

    dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    adx = (adx * (period - 1) + dx) / period;
  }

  return {
    adx: adx,
    plusDI: plusDI,
    minusDI: minusDI
  };
}

/**
 * On Balance Volume (OBV)
 */
export function calculateOBV(closes = [], volumes = []) {
  if (!closes || !volumes || closes.length === 0) {
    return null;
  }

  const obvValues = [parseFloat(volumes[0]) || 0];

  for (let i = 1; i < closes.length; i++) {
    const close = parseFloat(closes[i]);
    const prevClose = parseFloat(closes[i - 1]);
    const volume = parseFloat(volumes[i]);

    let obv = obvValues[i - 1];

    if (close > prevClose) {
      obv += volume;
    } else if (close < prevClose) {
      obv -= volume;
    }

    obvValues.push(obv);
  }

  return obvValues[obvValues.length - 1];
}

/**
 * Rate of Change (ROC)
 */
export function calculateROC(prices = [], period = 12) {
  if (!prices || prices.length < period + 1) {
    return null;
  }

  const currentPrice = parseFloat(prices[prices.length - 1]);
  const pastPrice = parseFloat(prices[prices.length - 1 - period]);

  if (pastPrice === 0) {
    return null;
  }

  return ((currentPrice - pastPrice) / pastPrice) * 100;
}

/**
 * Momentum
 */
export function calculateMomentum(prices = [], period = 12) {
  if (!prices || prices.length < period + 1) {
    return null;
  }

  const currentPrice = parseFloat(prices[prices.length - 1]);
  const pastPrice = parseFloat(prices[prices.length - 1 - period]);

  return currentPrice - pastPrice;
}

/**
 * Volatility (Standard Deviation)
 */
export function calculateVolatility(prices = [], period = 20) {
  if (!prices || prices.length < period) {
    return null;
  }

  const recentPrices = prices.slice(-period).map(p => parseFloat(p));
  const mean = recentPrices.reduce((a, b) => a + b, 0) / period;

  let variance = 0;
  for (const price of recentPrices) {
    variance += Math.pow(price - mean, 2);
  }
  variance /= period;

  return Math.sqrt(variance);
}

export default {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateBollingerBands,
  calculateATR,
  calculateMACD,
  calculateStochastic,
  calculateVWAP,
  calculateADX,
  calculateOBV,
  calculateROC,
  calculateMomentum,
  calculateVolatility
};
