// lib/core/numbers.js
/**
 * Numeric helpers used across the MAIN funnel repo.
 * Goal: safe parsing + consistent rounding/formatting.
 */

export function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export function clamp(v, min, max) {
  const x = n(v, min);
  return Math.max(min, Math.min(max, x));
}

export function round(v, decimals = 2) {
  const x = n(v, 0);
  const p = 10 ** Math.max(0, n(decimals, 0));
  return Math.round(x * p) / p;
}

export function floorTo(v, decimals = 2) {
  const x = n(v, 0);
  const p = 10 ** Math.max(0, n(decimals, 0));
  return Math.floor(x * p) / p;
}

export function ceilTo(v, decimals = 2) {
  const x = n(v, 0);
  const p = 10 ** Math.max(0, n(decimals, 0));
  return Math.ceil(x * p) / p;
}

/**
 * Convert ratio to percent with safety.
 * Example: pct(0.1234) -> 12.34
 */
export function pct(ratio, decimals = 2) {
  return round(n(ratio, 0) * 100, decimals);
}

/**
 * Percent difference: (b-a)/a * 100
 */
export function pctChange(a, b, decimals = 3) {
  const x = n(a, 0);
  const y = n(b, 0);
  if (!(x > 0) || !(y > 0)) return 0;
  return round(((y - x) / x) * 100, decimals);
}

/**
 * Safe divide, avoids Infinity/NaN.
 */
export function safeDiv(a, b, d = 0) {
  const x = n(a, 0);
  const y = n(b, 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return d;
  const v = x / y;
  return Number.isFinite(v) ? v : d;
}

/**
 * Fixed decimal number output (as Number, not string).
 * Useful for prices in API JSON.
 */
export function fixedNum(v, decimals = 8, d = 0) {
  const x = n(v, d);
  if (!Number.isFinite(x)) return d;
  return Number(x.toFixed(decimals));
}

/**
 * Sum helper for arrays
 */
export function sum(arr, mapper = (x) => x) {
  const a = Array.isArray(arr) ? arr : [];
  let s = 0;
  for (const item of a) s += n(mapper(item), 0);
  return s;
}

/**
 * Average helper for arrays
 */
export function avg(arr, mapper = (x) => x) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return 0;
  return sum(a, mapper) / a.length;
}

/**
 * Max helper for arrays
 */
export function max(arr, mapper = (x) => x, d = 0) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return d;
  let m = -Infinity;
  for (const item of a) m = Math.max(m, n(mapper(item), -Infinity));
  return Number.isFinite(m) ? m : d;
}

/**
 * Min helper for arrays
 */
export function min(arr, mapper = (x) => x, d = 0) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return d;
  let m = Infinity;
  for (const item of a) m = Math.min(m, n(mapper(item), Infinity));
  return Number.isFinite(m) ? m : d;
}

/**
 * Convert ms to seconds (int)
 */
export function msToSec(ms, d = 0) {
  const x = n(ms, d);
  if (!Number.isFinite(x)) return d;
  return Math.floor(x / 1000);
}

/**
 * Convert seconds to ms (int)
 */
export function secToMs(sec, d = 0) {
  const x = n(sec, d);
  if (!Number.isFinite(x)) return d;
  return Math.floor(x * 1000);
}