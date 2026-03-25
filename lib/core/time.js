// lib/core/time.js
/**
 * Time helpers for MAIN funnel repo.
 * - Centralizes timestamp math, TTL helpers, and formatting.
 * - Keeps all time in ms internally.
 */

import { n } from "./numbers.js";

/** Current unix time in ms */
export function nowMs() {
  return Date.now();
}

/** Current unix time in seconds */
export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Convert seconds -> ms */
export function secToMs(sec) {
  return Math.floor(n(sec, 0) * 1000);
}

/** Convert ms -> seconds */
export function msToSec(ms) {
  return Math.floor(n(ms, 0) / 1000);
}

/** Minutes -> ms */
export function minToMs(min) {
  return Math.floor(n(min, 0) * 60 * 1000);
}

/** Hours -> ms */
export function hourToMs(hours) {
  return Math.floor(n(hours, 0) * 60 * 60 * 1000);
}

/** Days -> ms */
export function dayToMs(days) {
  return Math.floor(n(days, 0) * 24 * 60 * 60 * 1000);
}

/**
 * Return a timestamp (ms) for the next half-hour boundary from `baseMs`.
 * Example: 10:07 -> 10:30, 10:41 -> 11:00
 */
export function nextHalfHourBoundaryMs(baseMs = Date.now()) {
  const t = new Date(n(baseMs, Date.now()));
  const d = new Date(t);

  d.setSeconds(0, 0);

  const m = d.getMinutes();
  if (m < 30) d.setMinutes(30);
  else {
    d.setMinutes(0);
    d.setHours(d.getHours() + 1);
  }
  return d.getTime();
}

/**
 * TTL in seconds from now until a target timestamp (ms).
 * Always returns at least `minTtlSec`.
 */
export function ttlUntilMs(targetMs, minTtlSec = 60) {
  const t = n(targetMs, 0);
  const diffMs = Math.max(0, t - Date.now());
  const ttl = Math.ceil(diffMs / 1000);
  return Math.max(n(minTtlSec, 60), ttl);
}

/**
 * Simple age check: is value stale given maxAgeMs?
 */
export function isStale(updatedAtMs, maxAgeMs) {
  const u = n(updatedAtMs, 0);
  const maxAge = n(maxAgeMs, 0);
  if (!u || !maxAge) return true;
  return Date.now() - u > maxAge;
}

/**
 * Convert ms to ISO string safely.
 */
export function toIso(ms) {
  const t = n(ms, 0);
  if (!t) return null;
  try {
    return new Date(t).toISOString();
  } catch {
    return null;
  }
}

/**
 * Format duration in ms to a compact human string.
 * Example: 3723000 -> "1h 2m 3s"
 */
export function formatDuration(ms) {
  let x = Math.max(0, Math.floor(n(ms, 0)));
  const s = Math.floor(x / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;

  const parts = [];
  if (hh) parts.push(`${hh}h`);
  if (mm || hh) parts.push(`${mm}m`);
  parts.push(`${ss}s`);
  return parts.join(" ");
}

/**
 * Parse a date-like input into ms.
 * Accepts:
 * - number (ms or sec if < 1e12)
 * - Date
 * - ISO string
 * Returns 0 if invalid.
 */
export function parseTimeMs(input) {
  if (input == null) return 0;

  if (typeof input === "number") {
    const x = n(input, 0);
    if (!x) return 0;
    // heuristics: if looks like seconds, convert to ms
    return x < 1e12 ? Math.floor(x * 1000) : Math.floor(x);
  }

  if (input instanceof Date) {
    const t = input.getTime();
    return Number.isFinite(t) ? t : 0;
  }

  if (typeof input === "string") {
    const t = Date.parse(input);
    return Number.isFinite(t) ? t : 0;
  }

  return 0;
}