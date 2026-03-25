// lib/core/keys.js
/**
 * KV key helpers for the MAIN funnel repo.
 * Keep every KV key definition in one file so:
 * - you never typo keys across modules
 * - migrations/renames are easy
 *
 * Usage:
 *   import { keyMainLatest, keyMainState, ... } from "../core/keys.js";
 */

function normMode(mode) {
  return String(mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
}
function up(x) {
  return String(x || "").toUpperCase();
}

/** Namespace prefix (handy if you ever run multiple instances). */
export const KV_NS = "main";

/** ---------- Snapshots / API payloads ---------- */
export function keyMainLatest(mode) {
  return `${KV_NS}:latest:${normMode(mode)}`;
}
export function keyMainState(mode) {
  return `${KV_NS}:state:${normMode(mode)}`;
}
export function keyMainPositions(mode) {
  return `${KV_NS}:positions:${normMode(mode)}`;
}
export function keyMainPortfolio(mode) {
  return `${KV_NS}:portfolio:${normMode(mode)}`;
}

/** ---------- Performance / analytics ---------- */
export function keyMainPerformance(mode) {
  return `${KV_NS}:performance:${normMode(mode)}`;
}

/** ---------- Scan locking ---------- */
export function keyMainScanLock(mode) {
  return `${KV_NS}:scan:lock:${normMode(mode)}`;
}

/** ---------- Cooldowns / entry history ---------- */
export function keyMainCooldown(mode, symbol) {
  return `${KV_NS}:cooldown:${normMode(mode)}:${up(symbol)}`;
}
export function keyMainEntryHistory(mode) {
  return `${KV_NS}:entry:history:${normMode(mode)}`;
}

/** ---------- External caches ---------- */
export function keyCgTopCache(cgTop) {
  // versioned by cgTop so changing CG_TOP does not reuse old cache
  return `cg:top:cache:${Number(cgTop || 0) || 0}`;
}
export function keyBitgetSymbolsUsdt() {
  return `bitget:symbols:usdt`;
}

/** ---------- Optional: audit / ops ---------- */
export function keyOpsLastError() {
  return `${KV_NS}:ops:lastError`;
}
export function keyOpsLastRun(mode) {
  return `${KV_NS}:ops:lastRun:${normMode(mode)}`;
}