// ================= FILE: src/market/marketWeather.js =================
//
// Market conditions assessment
// Determines market regime and conditions for trading decisions
//

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now } from '../utils.js';

/**
 * Assess overall market weather conditions
 * Returns volatility, trend, momentum classification
 */
export async function assessMarketWeather(marketData = {}) {
  try {
    const prices = marketData.prices || [];
    const volumes = marketData.volumes || [];
    const highs = marketData.highs || [];
    const lows = marketData.lows || [];

    if (prices.length < 20) {
      return {
        ok: false,
        reason: 'INSUFFICIENT_DATA'
      };
    }

    const volatility = calculateVolatility(prices);
    const trend = calculateTrend(prices);
    const momentum = calculateMomentum(prices);
    const volumeTrend = calculateVolumeTrend(volumes);
    const rangeBound = calculateRangeBound(highs, lows);

    const weather = {
      volatility: classifyVolatility(volatility),
      volatilityValue: volatility,
      trend: classifyTrend(trend),
      trendValue: trend,
      momentum: classifyMomentum(momentum),
      momentumValue: momentum,
      volumeTrend: volumeTrend,
      condition: determineMarketCondition(volatility, trend, momentum, rangeBound),
      rangeBound: rangeBound,
      timestamp: now(),
      expires: now() + (5 * 60 * 1000) // 5 minutes
    };

    const redis = getRedis();
    await redis.set(keys.marketWeather(), weather);

    return {
      ok: true,
      weather
    };
  } catch (err) {
    console.error('assessMarketWeather error:', err);
    return {
      ok: false,
      reason: 'ASSESSMENT_FAILED',
      error: err.message
    };
  }
}

/**
 * Get current market weather
 */
export async function getMarketWeather() {
  try {
    const redis = getRedis();
    const weather = await redis.get(keys.marketWeather());

    if (!weather) {
      return {
        ok: false,
        reason: 'NO_WEATHER_DATA'
      };
    }

    return {
      ok: true,
      weather
    };
  } catch (err) {
    console.error('getMarketWeather error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

/**
 * Calculate volatility (percentage-based)
 */
function calculateVolatility(prices = []) {
  if (!prices || prices.length < 2) {
    return 0;
  }

  const recentPrices = prices.slice(-20);
  const changes = [];

  for (let i = 1; i < recentPrices.length; i++) {
    const prev = parseFloat(recentPrices[i - 1]);
    const curr = parseFloat(recentPrices[i]);
    if (prev > 0) {
      changes.push(Math.abs((curr - prev) / prev));
    }
  }

  if (changes.length === 0) {
    return 0;
  }

  const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
  return avgChange;
}

/**
 * Calculate trend direction
 */
function calculateTrend(prices = []) {
  if (!prices || prices.length < 2) {
    return 0;
  }

  const startPrice = parseFloat(prices[0]);
  const endPrice = parseFloat(prices[prices.length - 1]);

  if (startPrice <= 0) {
    return 0;
  }

  return (endPrice - startPrice) / startPrice;
}

/**
 * Calculate momentum
 */
function calculateMomentum(prices = []) {
  if (!prices || prices.length < 10) {
    return 0;
  }

  const recent10 = prices.slice(-10).map(p => parseFloat(p));
  const avg10 = recent10.reduce((a, b) => a + b, 0) / 10;

  const prior10 = prices.slice(-20, -10).map(p => parseFloat(p));
  const avg20minus10 = prior10.length > 0 ? prior10.reduce((a, b) => a + b, 0) / prior10.length : avg10;

  if (avg20minus10 <= 0) {
    return 0;
  }

  return (avg10 - avg20minus10) / avg20minus10;
}

/**
 * Calculate volume trend
 */
function calculateVolumeTrend(volumes = []) {
  if (!volumes || volumes.length < 10) {
    return 0;
  }

  const recent5 = volumes.slice(-5).map(v => parseFloat(v));
  const avg5 = recent5.reduce((a, b) => a + b, 0) / 5;

  const prior5 = volumes.slice(-10, -5).map(v => parseFloat(v));
  const avg10minus5 = prior5.length > 0 ? prior5.reduce((a, b) => a + b, 0) / prior5.length : avg5;

  if (avg10minus5 <= 0) {
    return 0;
  }

  return (avg5 - avg10minus5) / avg10minus5;
}

/**
 * Calculate range-bound level
 */
function calculateRangeBound(highs = [], lows = []) {
  if (!highs || !lows || highs.length < 20) {
    return 0;
  }

  const recent20Highs = highs.slice(-20).map(h => parseFloat(h));
  const recent20Lows = lows.slice(-20).map(l => parseFloat(l));

  const highest = Math.max(...recent20Highs);
  const lowest = Math.min(...recent20Lows);
  const range = highest - lowest;
  const midpoint = (highest + lowest) / 2;

  const avgPrice = recent20Highs.reduce((a, b) => a + b, 0) / recent20Highs.length;

  if (range <= 0) {
    return 0;
  }

  return range / avgPrice;
}

/**
 * Classify volatility level
 */
function classifyVolatility(volatility = 0) {
  if (volatility < 0.005) return 'VERY_LOW';
  if (volatility < 0.015) return 'LOW';
  if (volatility < 0.03) return 'NORMAL';
  if (volatility < 0.06) return 'HIGH';
  return 'VERY_HIGH';
}

/**
 * Classify trend direction
 */
function classifyTrend(trend = 0) {
  if (trend > 0.03) return 'STRONG_UP';
  if (trend > 0.01) return 'UP';
  if (trend > -0.01) return 'NEUTRAL';
  if (trend > -0.03) return 'DOWN';
  return 'STRONG_DOWN';
}

/**
 * Classify momentum
 */
function classifyMomentum(momentum = 0) {
  if (momentum > 0.05) return 'STRONG_BULLISH';
  if (momentum > 0.01) return 'BULLISH';
  if (momentum > -0.01) return 'NEUTRAL';
  if (momentum > -0.05) return 'BEARISH';
  return 'STRONG_BEARISH';
}

/**
 * Determine overall market condition
 */
function determineMarketCondition(volatility = 0, trend = 0, momentum = 0, rangeBound = 0) {
  // Very high volatility + no clear trend = chop
  if (volatility > 0.05 && Math.abs(trend) < 0.01) {
    return 'CHOPPY';
  }

  // Low volatility + small range = tight/squeeze
  if (volatility < 0.01 && rangeBound < 0.02) {
    return 'SQUEEZE';
  }

  // Clear trend + strong momentum = trending
  if (Math.abs(trend) > 0.02 && Math.abs(momentum) > 0.02) {
    return 'TRENDING';
  }

  // Moderate volatility + mixed signals = normal
  if (volatility > 0.01 && volatility < 0.04) {
    return 'NORMAL';
  }

  // Default
  return 'UNCERTAIN';
}

/**
 * Check if market is suitable for trading
 */
export async function isMarketSuitable(minVolatility = 0.005, maxVolatility = 0.10) {
  try {
    const weatherResult = await getMarketWeather();

    if (!weatherResult.ok) {
      return {
        ok: false,
        suitable: false,
        reason: 'NO_WEATHER_DATA'
      };
    }

    const weather = weatherResult.weather;
    const vol = weather.volatilityValue || 0;

    const suitable = vol >= minVolatility && vol <= maxVolatility;

    return {
      ok: true,
      suitable,
      volatility: weather.volatilityValue,
      condition: weather.condition,
      reason: suitable ? 'SUITABLE' : (vol < minVolatility ? 'LOW_VOLATILITY' : 'HIGH_VOLATILITY')
    };
  } catch (err) {
    console.error('isMarketSuitable error:', err);
    return {
      ok: false,
      suitable: false,
      error: err.message
    };
  }
}

/**
 * Save market weather history
 */
export async function saveWeatherHistory(weather = {}) {
  try {
    const redis = getRedis();
    const timestamp = now();
    const historyKey = keys.marketWeatherHistory(timestamp);

    await redis.set(historyKey, {
      ...weather,
      timestamp
    });

    return {
      ok: true,
      key: historyKey
    };
  } catch (err) {
    console.error('saveWeatherHistory error:', err);
    return {
      ok: false,
      error: err.message
    };
  }
}

export default {
  assessMarketWeather,
  getMarketWeather,
  isMarketSuitable,
  saveWeatherHistory
};
