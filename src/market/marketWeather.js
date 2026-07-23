// ================= FILE: src/market/marketWeather.js =================
// COMPLEET market conditions assessment

import { getRedis } from '../redis.js';
import { keys } from '../keys.js';
import { now } from '../utils.js';

export async function assessMarketWeather(marketData = {}) {
  try {
    const prices = (marketData.prices || []).map(p => parseFloat(p));
    const volumes = (marketData.volumes || []).map(v => parseFloat(v));
    const highs = (marketData.highs || []).map(h => parseFloat(h));
    const lows = (marketData.lows || []).map(l => parseFloat(l));

    if (prices.length < 20) return { ok: false, reason: 'INSUFFICIENT_DATA' };

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
      expires: now() + (5 * 60 * 1000)
    };

    const redis = getRedis();
    await redis.set(keys.marketWeather(), weather);

    return { ok: true, weather };
  } catch (err) {
    console.error('assessMarketWeather error:', err);
    return { ok: false, reason: 'ASSESSMENT_FAILED', error: err.message };
  }
}

export async function getMarketWeather() {
  try {
    const redis = getRedis();
    const weather = await redis.get(keys.marketWeather());
    if (!weather) return { ok: false, reason: 'NO_WEATHER_DATA' };
    return { ok: true, weather };
  } catch (err) {
    console.error('getMarketWeather error:', err);
    return { ok: false, error: err.message };
  }
}

function calculateVolatility(prices = []) {
  if (!prices || prices.length < 2) return 0;
  const recent = prices.slice(-20);
  const changes = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1] > 0) changes.push(Math.abs((recent[i] - recent[i - 1]) / recent[i - 1]));
  }
  return changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
}

function calculateTrend(prices = []) {
  if (!prices || prices.length < 2) return 0;
  const start = parseFloat(prices[0]);
  const end = parseFloat(prices[prices.length - 1]);
  return start > 0 ? (end - start) / start : 0;
}

function calculateMomentum(prices = []) {
  if (!prices || prices.length < 10) return 0;
  const recent10 = prices.slice(-10).map(p => parseFloat(p));
  const avg10 = recent10.reduce((a, b) => a + b, 0) / 10;
  const prior10 = prices.slice(-20, -10);
  const avg20 = prior10.length > 0 ? prior10.map(p => parseFloat(p)).reduce((a, b) => a + b, 0) / prior10.length : avg10;
  return avg20 > 0 ? (avg10 - avg20) / avg20 : 0;
}

function calculateVolumeTrend(volumes = []) {
  if (!volumes || volumes.length < 10) return 0;
  const recent5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const prior5 = volumes.slice(-10, -5).length > 0 ? volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5 : recent5;
  return prior5 > 0 ? (recent5 - prior5) / prior5 : 0;
}

function calculateRangeBound(highs = [], lows = []) {
  if (!highs || !lows || highs.length < 20) return 0;
  const h20 = Math.max(...highs.slice(-20).map(h => parseFloat(h)));
  const l20 = Math.min(...lows.slice(-20).map(l => parseFloat(l)));
  const avg = highs.slice(-20).map(h => parseFloat(h)).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? (h20 - l20) / avg : 0;
}

function classifyVolatility(vol = 0) {
  if (vol < 0.005) return 'VERY_LOW';
  if (vol < 0.015) return 'LOW';
  if (vol < 0.03) return 'NORMAL';
  if (vol < 0.06) return 'HIGH';
  return 'VERY_HIGH';
}

function classifyTrend(trend = 0) {
  if (trend > 0.03) return 'STRONG_UP';
  if (trend > 0.01) return 'UP';
  if (trend > -0.01) return 'NEUTRAL';
  if (trend > -0.03) return 'DOWN';
  return 'STRONG_DOWN';
}

function classifyMomentum(mom = 0) {
  if (mom > 0.05) return 'STRONG_BULLISH';
  if (mom > 0.01) return 'BULLISH';
  if (mom > -0.01) return 'NEUTRAL';
  if (mom > -0.05) return 'BEARISH';
  return 'STRONG_BEARISH';
}

function determineMarketCondition(vol = 0, trend = 0, mom = 0, range = 0) {
  if (vol > 0.05 && Math.abs(trend) < 0.01) return 'CHOPPY';
  if (vol < 0.01 && range < 0.02) return 'SQUEEZE';
  if (Math.abs(trend) > 0.02 && Math.abs(mom) > 0.02) return 'TRENDING';
  if (vol > 0.01 && vol < 0.04) return 'NORMAL';
  return 'UNCERTAIN';
}

export async function isMarketSuitable(minVol = 0.005, maxVol = 0.10) {
  try {
    const result = await getMarketWeather();
    if (!result.ok) return { ok: false, suitable: false, reason: 'NO_WEATHER_DATA' };
    const vol = result.weather.volatilityValue || 0;
    const suitable = vol >= minVol && vol <= maxVol;
    return { ok: true, suitable, volatility: vol, condition: result.weather.condition };
  } catch (err) {
    console.error('isMarketSuitable error:', err);
    return { ok: false, suitable: false, error: err.message };
  }
}

export default { assessMarketWeather, getMarketWeather, isMarketSuitable };
