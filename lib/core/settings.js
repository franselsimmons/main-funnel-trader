// lib/core/settings.js
/**
 * Central settings + env validation for the MAIN funnel repo.
 * - Keeps config in one place (no scattered magic numbers).
 * - Provides strict runtime checks so Vercel deploys fail fast if env is missing.
 *
 * Usage:
 *   import { SETTINGS, ENV, requireEnv, getModeFromReq } from "../core/settings.js";
 */

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function s(v, d = "") {
  return (v == null ? d : String(v)).trim();
}
function b(v, d = false) {
  const x = s(v, "");
  if (!x) return d;
  return ["1", "true", "yes", "y", "on"].includes(x.toLowerCase());
}

export const SETTINGS = {
  // ===== Universe / market data =====
  CG_TOP: 1500, // max coins (paginated)
  RADAR_LIMIT: 60, // UI radar limit (if you want)
  UNIVERSE_SCAN_LIMIT: 120, // how many coins we actually process per scan (performance)

  // ===== Networking / timeouts =====
  HTTP_TIMEOUT_MS: 8000,
  ORDERBOOK_TIMEOUT_MS: 6000,
  SLEEP_BETWEEN_COINS_MS: 10,

  // ===== Scheduler =====
  // Your scan endpoint itself uses a KV lock aligned to 00/30 minute boundaries.
  // Vercel cron should call /api/cron-bull + /api/cron-bear every 30 minutes.
  SCAN_LOCK_ALIGN_MINUTES: 30,

  // ===== Trade / portfolio =====
  BASE_POSITION_SIZE_USD: n(process.env.BASE_POSITION_SIZE_USD, 50),
  MAX_OPEN_TRADES: n(process.env.MAX_OPEN_TRADES, 6),

  // ===== Exit rules =====
  TIMEOUT_BARS: 12, // ~12 scans * 30min ≈ 6 hours
  TIMEOUT_MIN_PNL_PCT: 0.3, // exit if < 0.3% after timeout
  EARLY_EXIT_WINDOW_SEC: 90 * 60, // 90 min window
  EARLY_EXIT_CUT_PNL_PCT: -0.6, // cut losers early if <= -0.6%

  // ===== Cooldowns (seconds) =====
  COOLDOWN_SL_SEC: 4 * 60 * 60,
  COOLDOWN_TP_SEC: 90 * 60,
  COOLDOWN_TIMEOUT_SEC: 2 * 60 * 60,
  COOLDOWN_EARLY_EXIT_SEC: 90 * 60,

  // ===== Entry history =====
  ENTRY_HISTORY_KEEP: 40,
  ENTRY_LOOKBACK_MS: 24 * 60 * 60 * 1000,
  MIN_RECENT_ENTRIES_TARGET: 3,

  // ===== Scanner guardrails =====
  MIN_BITGET_SYMBOLS_SET: 20, // if fewer than this, skip Bitget filtering
  MIN_BITGET_MATCHES_TO_APPLY: 10, // only apply Bitget filter if enough matches remain
};

/**
 * Environment values (strings) normalized.
 * Keep raw env reads here (single source).
 */
export const ENV = {
  NODE_ENV: s(process.env.NODE_ENV, "production"),
  LOG_LEVEL: s(process.env.LOG_LEVEL, "info"),

  API_SECRET: s(process.env.API_SECRET),
  CRON_SECRET: s(process.env.CRON_SECRET),

  DISCORD_WEBHOOK_URL: s(process.env.DISCORD_WEBHOOK_URL),
  DISCORD_WEBHOOK_USERNAME: s(process.env.DISCORD_WEBHOOK_USERNAME, "MainFunnelBot"),
  DISCORD_WEBHOOK_AVATAR_URL: s(process.env.DISCORD_WEBHOOK_AVATAR_URL),
  DISCORD_DEFAULT_CHANNEL: s(process.env.DISCORD_DEFAULT_CHANNEL, "main-funnel"),

  // Execution
  EXECUTION_MODE: s(process.env.EXECUTION_MODE, "paper").toLowerCase(), // "paper" | "live"
  EXECUTION_QUOTE: s(process.env.EXECUTION_QUOTE, "USDT").toUpperCase(),

  BITGET_API_KEY: s(process.env.BITGET_API_KEY),
  BITGET_API_SECRET: s(process.env.BITGET_API_SECRET),
  BITGET_API_PASSPHRASE: s(process.env.BITGET_API_PASSPHRASE),
};

export function isProd() {
  return ENV.NODE_ENV === "production";
}

export function isPaper() {
  return ENV.EXECUTION_MODE !== "live";
}

/**
 * Fail-fast validation. Call once at startup of any API handler that needs env.
 */
export function requireEnv(keys = []) {
  const missing = [];
  for (const k of keys) {
    const v = ENV[k];
    if (!v) missing.push(k);
  }
  if (missing.length) {
    const msg = `Missing required env: ${missing.join(", ")}`;
    const err = new Error(msg);
    err.code = "ENV_MISSING";
    throw err;
  }
}

/**
 * Validate secrets for protected routes.
 * - token can be in query.token or Authorization: Bearer <token>
 */
export function requireSecret(req, res) {
  const token =
    req?.query?.token ||
    req?.headers?.authorization?.replace("Bearer ", "") ||
    req?.headers?.Authorization?.replace("Bearer ", "");

  const ok = token && (token === ENV.API_SECRET || token === ENV.CRON_SECRET);
  if (!ok) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

/**
 * Parse mode from request. Defaults to "bull".
 */
export function getModeFromReq(req) {
  const modeRaw = s(req?.query?.mode, "bull").toLowerCase();
  return modeRaw === "bear" ? "bear" : "bull";
}

/**
 * Simple logger with levels.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function log(level, ...args) {
  const cur = LEVELS[ENV.LOG_LEVEL] ?? 20;
  const lvl = LEVELS[level] ?? 20;
  if (lvl < cur) return;
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](...args);
}