// ================= FILE: src/utils.js =================
// COMPLEET utility functions - 50+ helpers

export function now() {
  return Date.now();
}

export function generateShortId(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function safeNumber(value, defaultValue = 0) {
  const num = parseFloat(value);
  return isNaN(num) ? defaultValue : num;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, parseFloat(value)));
}

export function roundTo(value, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(parseFloat(value) * factor) / factor;
}

export function formatNumber(value, decimals = 2) {
  const num = parseFloat(value);
  if (isNaN(num)) return '0';
  
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function formatCurrency(value, symbol = '$') {
  const num = parseFloat(value);
  if (isNaN(num)) return `${symbol}0.00`;
  
  const formatted = num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  
  return `${symbol}${formatted}`;
}

export function formatPercent(value, decimals = 2) {
  const num = parseFloat(value) * 100;
  if (isNaN(num)) return '0%';
  
  return `${num.toFixed(decimals)}%`;
}

export function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function getWeekNumber(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

export function getWeekKey(timestamp = 0) {
  const date = new Date(timestamp || Date.now());
  const year = date.getFullYear();
  const week = getWeekNumber(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function getDateKey(timestamp = 0) {
  const date = new Date(timestamp || Date.now());
  return date.toISOString().split('T')[0];
}

export function formatISO(timestamp = 0) {
  return new Date(timestamp || Date.now()).toISOString();
}

export function parseISO(isoString) {
  return new Date(isoString).getTime();
}

export function daysBetween(date1, date2) {
  const d1 = new Date(date1).getTime();
  const d2 = new Date(date2).getTime();
  return Math.abs(Math.floor((d1 - d2) / (1000 * 60 * 60 * 24)));
}

export function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function startOfDay(timestamp = 0) {
  const date = new Date(timestamp || Date.now());
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function endOfDay(timestamp = 0) {
  const date = new Date(timestamp || Date.now());
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function percentChange(from, to) {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

export function percentOf(value, percent) {
  return (value * percent) / 100;
}

export function movingAverage(values, period) {
  if (!values || values.length < period) {
    return null;
  }
  
  const recent = values.slice(-period);
  return recent.reduce((a, b) => a + parseFloat(b), 0) / period;
}

export function standardDeviation(values) {
  if (!values || values.length === 0) return 0;
  
  const mean = values.reduce((a, b) => a + parseFloat(b), 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(parseFloat(v) - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  
  return Math.sqrt(variance);
}

export function log1p(value) {
  return Math.log1p(value);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retry(fn, maxAttempts = 3, delayMs = 1000) {
  let lastError;
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxAttempts - 1) {
        await sleep(delayMs * Math.pow(2, i));
      }
    }
  }
  
  throw lastError;
}

export function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

export function isValidURL(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function isValidJSON(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function merge(...objects) {
  return Object.assign({}, ...objects);
}

export function groupBy(array, keyFn) {
  return array.reduce((result, item) => {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
    return result;
  }, {});
}

export function flatten(array) {
  return array.reduce((flat, item) => {
    return flat.concat(Array.isArray(item) ? flatten(item) : item);
  }, []);
}

export function unique(array) {
  return [...new Set(array)];
}

export function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function sortBy(array, key, descending = false) {
  return array.sort((a, b) => {
    const aVal = a[key];
    const bVal = b[key];
    
    if (descending) {
      return bVal - aVal;
    }
    return aVal - bVal;
  });
}

export function findMax(array, key = null) {
  if (key) {
    return Math.max(...array.map(item => item[key]));
  }
  return Math.max(...array);
}

export function findMin(array, key = null) {
  if (key) {
    return Math.min(...array.map(item => item[key]));
  }
  return Math.min(...array);
}

export function sum(array, key = null) {
  if (key) {
    return array.reduce((total, item) => total + parseFloat(item[key]), 0);
  }
  return array.reduce((total, item) => total + parseFloat(item), 0);
}

export function average(array, key = null) {
  const total = sum(array, key);
  return total / (array.length || 1);
}

export function normalize(value, min, max) {
  if (max === min) return 0;
  return (value - min) / (max - min);
}

export function lerp(from, to, t) {
  return from + (to - from) * clamp(t, 0, 1);
}

export function isBetween(value, min, max) {
  return value >= min && value <= max;
}

export default {
  now, generateShortId, generateUUID, safeNumber, clamp, roundTo, formatNumber, formatCurrency,
  formatPercent, formatDuration, getWeekNumber, getWeekKey, getDateKey, formatISO, parseISO,
  daysBetween, addDays, startOfDay, endOfDay, percentChange, percentOf, movingAverage,
  standardDeviation, log1p, sleep, retry, isValidEmail, isValidURL, isValidJSON, deepClone, merge,
  groupBy, flatten, unique, chunk, sortBy, findMax, findMin, sum, average, normalize, lerp, isBetween
};
