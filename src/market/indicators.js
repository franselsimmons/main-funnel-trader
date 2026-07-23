// ================= FILE: src/market/indicators.js =================
// COMPLEET technical indicators library

export function calculateSMA(prices = [], period = 20) {
  if (!prices || prices.length < period) return null;
  const recent = prices.slice(-period).map(p => parseFloat(p));
  const sum = recent.reduce((acc, p) => acc + p, 0);
  return sum / period;
}

export function calculateEMA(prices = [], period = 12) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).map(p => parseFloat(p)).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = parseFloat(prices[i]) * k + ema * (1 - k);
  }
  return ema;
}

export function calculateRSI(prices = [], period = 14) {
  if (!prices || prices.length < period + 1) return null;
  
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(parseFloat(prices[i]) - parseFloat(prices[i - 1]));
  }

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }

  avgGain /= period;
  avgLoss /= period;

  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  let rsi = 100 - (100 / (1 + rs));

  for (let i = period; i < changes.length; i++) {
    if (changes[i] > 0) {
      avgGain = (avgGain * (period - 1) + changes[i]) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(changes[i])) / period;
    }
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi = 100 - (100 / (1 + rs));
  }

  return Math.min(100, Math.max(0, rsi));
}

export function calculateBollingerBands(prices = [], period = 20, stdDevMultiplier = 2) {
  if (!prices || prices.length < period) return null;
  
  const recent = prices.slice(-period).map(p => parseFloat(p));
  const sma = recent.reduce((a, b) => a + b, 0) / period;
  
  let variance = 0;
  for (const price of recent) {
    variance += Math.pow(price - sma, 2);
  }
  variance /= period;
  
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: sma + (stdDev * stdDevMultiplier),
    middle: sma,
    lower: sma - (stdDev * stdDevMultiplier),
    stdDev
  };
}

export function calculateATR(highs = [], lows = [], closes = [], period = 14) {
  if (!highs || !lows || !closes || highs.length < period) return null;
  
  const trueRanges = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      parseFloat(highs[i]) - parseFloat(lows[i]),
      Math.abs(parseFloat(highs[i]) - parseFloat(closes[i - 1])),
      Math.abs(parseFloat(lows[i]) - parseFloat(closes[i - 1]))
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

export function calculateMACD(prices = [], fast = 12, slow = 26, signal = 9) {
  if (!prices || prices.length < slow) return null;
  
  const fastEMA = calculateEMA(prices, fast);
  const slowEMA = calculateEMA(prices, slow);
  
  if (!fastEMA || !slowEMA) return null;
  
  const macdLine = fastEMA - slowEMA;
  const macdValues = [];
  
  for (let i = slow - 1; i < prices.length; i++) {
    const subset = prices.slice(0, i + 1);
    const fEMA = calculateEMA(subset, fast);
    const sEMA = calculateEMA(subset, slow);
    if (fEMA && sEMA) macdValues.push(fEMA - sEMA);
  }

  const signalLine = calculateEMA(macdValues, signal);
  
  return {
    macd: macdLine,
    signal: signalLine,
    histogram: signalLine ? macdLine - signalLine : null
  };
}

export function calculateStochastic(highs = [], lows = [], closes = [], period = 14, smoothK = 3) {
  if (!highs || !lows || !closes || highs.length < period) return null;
  
  const kValues = [];
  for (let i = period - 1; i < closes.length; i++) {
    const recentHighs = highs.slice(i - period + 1, i + 1).map(h => parseFloat(h));
    const recentLows = lows.slice(i - period + 1, i + 1).map(l => parseFloat(l));
    const close = parseFloat(closes[i]);
    
    const high = Math.max(...recentHighs);
    const low = Math.min(...recentLows);
    const k = (close - low) / (high - low) * 100;
    kValues.push(k);
  }

  if (kValues.length < smoothK) return null;

  const smoothed = [];
  for (let i = smoothK - 1; i < kValues.length; i++) {
    const avg = kValues.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0) / smoothK;
    smoothed.push(avg);
  }

  return {
    k: smoothed[smoothed.length - 1],
    d: smoothed.length > 1 ? smoothed[smoothed.length - 2] : smoothed[0]
  };
}

export function calculateVWAP(highs = [], lows = [], closes = [], volumes = []) {
  if (!highs || !lows || !closes || !volumes || closes.length === 0) return null;
  
  let cumulativePQ = 0;
  let cumulativeV = 0;

  for (let i = 0; i < closes.length; i++) {
    const tp = (parseFloat(highs[i]) + parseFloat(lows[i]) + parseFloat(closes[i])) / 3;
    const vol = parseFloat(volumes[i]);
    cumulativePQ += tp * vol;
    cumulativeV += vol;
  }

  return cumulativeV === 0 ? null : cumulativePQ / cumulativeV;
}

export function calculateOBV(closes = [], volumes = []) {
  if (!closes || !volumes || closes.length === 0) return null;
  
  const obvValues = [parseFloat(volumes[0]) || 0];
  for (let i = 1; i < closes.length; i++) {
    const close = parseFloat(closes[i]);
    const prevClose = parseFloat(closes[i - 1]);
    const volume = parseFloat(volumes[i]);
    
    let obv = obvValues[i - 1];
    if (close > prevClose) obv += volume;
    else if (close < prevClose) obv -= volume;
    
    obvValues.push(obv);
  }

  return obvValues[obvValues.length - 1];
}

export function calculateROC(prices = [], period = 12) {
  if (!prices || prices.length < period + 1) return null;
  
  const current = parseFloat(prices[prices.length - 1]);
  const past = parseFloat(prices[prices.length - 1 - period]);
  
  return past === 0 ? null : ((current - past) / past) * 100;
}

export function calculateMomentum(prices = [], period = 12) {
  if (!prices || prices.length < period + 1) return null;
  
  const current = parseFloat(prices[prices.length - 1]);
  const past = parseFloat(prices[prices.length - 1 - period]);
  
  return current - past;
}

export function calculateVolatility(prices = [], period = 20) {
  if (!prices || prices.length < period) return null;
  
  const recent = prices.slice(-period).map(p => parseFloat(p));
  const mean = recent.reduce((a, b) => a + b, 0) / period;
  
  let variance = 0;
  for (const price of recent) {
    variance += Math.pow(price - mean, 2);
  }
  variance /= period;
  
  return Math.sqrt(variance);
}

export function calculateADX(highs = [], lows = [], closes = [], period = 14) {
  if (!highs || !lows || !closes || highs.length < period + 1) return null;
  
  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < highs.length; i++) {
    const high = parseFloat(highs[i]);
    const low = parseFloat(lows[i]);
    const prevHigh = parseFloat(highs[i - 1]);
    const prevLow = parseFloat(lows[i - 1]);

    let plusDM = 0;
    let minusDM = 0;

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    if (upMove > 0 && upMove > downMove) plusDM = upMove;
    if (downMove > 0 && downMove > upMove) minusDM = downMove;

    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  const atr = calculateATR(highs, lows, closes, period);
  if (!atr) return null;

  let plusDI = (plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period) / atr * 100;
  let minusDI = (minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period) / atr * 100;

  let dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  let adx = dx;

  for (let i = period; i < plusDMs.length; i++) {
    const avgPlus = plusDMs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    const avgMinus = minusDMs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    
    plusDI = avgPlus / atr * 100;
    minusDI = avgMinus / atr * 100;
    dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    adx = (adx * (period - 1) + dx) / period;
  }

  return { adx, plusDI, minusDI };
}

export default {
  calculateSMA, calculateEMA, calculateRSI, calculateBollingerBands,
  calculateATR, calculateMACD, calculateStochastic, calculateVWAP,
  calculateOBV, calculateROC, calculateMomentum, calculateVolatility,
  calculateADX
};
