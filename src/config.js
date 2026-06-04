// ================= FILE: src/config.js =================

export const env = process.env;

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() !== 'false';
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const CONFIG = Object.freeze({
  strategyVersion: 'CLEAN_MF_TS_V1',

  bitget: {
    baseUrl: env.BITGET_API_BASE_URL || 'https://api.bitget.com',
    productType: env.BITGET_PRODUCT_TYPE || 'usdt-futures',
    timeoutMs: num(env.BITGET_TIMEOUT_MS, 8000)
  },

  scanner: {
    maxSymbols: num(env.SCANNER_MAX_SYMBOLS, 80),
    minQuoteVolume24h: num(env.SCANNER_MIN_QUOTE_VOLUME_24H, 5_000_000),
    minAbsChange1h: num(env.SCANNER_MIN_ABS_CHANGE_1H, 0.35),
    minAbsChange24h: num(env.SCANNER_MIN_ABS_CHANGE_24H, 1.00),
    snapshotTtlSec: num(env.SCANNER_SNAPSHOT_TTL_SEC, 30 * 60),
    candleLimit: num(env.SCANNER_CANDLE_LIMIT, 80),
    fakeBreakoutLookback: num(env.SCANNER_FAKE_BREAKOUT_LOOKBACK, 24),
    lockTtlSec: num(env.SCANNER_LOCK_TTL_SEC, 240)
  },

  trade: {
    lockTtlSec: num(env.TRADE_LOCK_TTL_SEC, 180),
    maxCandidatesPerSnapshot: num(env.TRADE_MAX_CANDIDATES_PER_SNAPSHOT, 80),
    maxSnapshotAgeSec: num(env.TRADE_MAX_SNAPSHOT_AGE_SEC, 8 * 60),
    dataConcurrency: num(env.TRADE_DATA_CONCURRENCY, 5),
    maxOpenPositions: num(env.TRADE_MAX_OPEN_POSITIONS, 30),
    maxOpenSameSide: num(env.TRADE_MAX_OPEN_SAME_SIDE, 15),
    positionTimeStopMin: num(env.TRADE_POSITION_TIME_STOP_MIN, 12 * 60),
    minRR: num(env.TRADE_MIN_RR, 0.50),
    defaultRR: num(env.TRADE_DEFAULT_RR, 1.50),
    maxSpreadPct: num(env.TRADE_MAX_SPREAD_PCT, 0.015),
    candleTtlSec: num(env.TRADE_CANDLE_CACHE_TTL_SEC, 90),
    orderbookTtlSec: num(env.TRADE_ORDERBOOK_CACHE_TTL_SEC, 12),
    fundingTtlSec: num(env.TRADE_FUNDING_CACHE_TTL_SEC, 120)
  },

  analyze: {
    schema: env.MICRO_FAMILY_SCHEMA || 'MF_V1',
    shadowEnabled: bool(env.ANALYZE_SHADOW_ENABLED, true),
    shadowHorizonMin: num(env.ANALYZE_SHADOW_HORIZON_MIN, 6 * 60),
    shadowWeight: num(env.ANALYZE_SHADOW_WEIGHT, 0.35),
    obsDedupeTtlSec: num(env.ANALYZE_OBS_DEDUPE_TTL_SEC, 14 * 24 * 3600),
    shadowDedupeTtlSec: num(env.ANALYZE_SHADOW_DEDUPE_TTL_SEC, 48 * 3600),
    maxShadowMonitorsPerRun: num(env.ANALYZE_MAX_SHADOW_MONITORS_PER_RUN, 80),
    freezeLockTtlSec: num(env.ANALYZE_FREEZE_LOCK_TTL_SEC, 600),
    activateLockTtlSec: num(env.ANALYZE_ACTIVATE_LOCK_TTL_SEC, 600)
  },

  rotation: {
    mode: env.ROTATION_MODE || 'balanced',
    topNPerSide: num(env.ROTATION_TOP_N_PER_SIDE, 10),
    minWeightedCompleted: num(env.ROTATION_MIN_WEIGHTED_COMPLETED, 5),
    priorTrades: num(env.ROTATION_PRIOR_TRADES, 24),
    priorWinrate: num(env.ROTATION_PRIOR_WINRATE, 0.50),
    wilsonZ: num(env.ROTATION_WILSON_Z, 1.96)
  },

  discord: {
    enabled: bool(env.DISCORD_ENABLED, true),
    webhookUrl: env.DISCORD_WEBHOOK_URL || '',
    timeoutMs: num(env.DISCORD_TIMEOUT_MS, 2500),
    logLimit: num(env.DISCORD_LOG_LIMIT, 250)
  },

  reset: {
    confirmText: env.RESET_CONFIRM_TEXT || 'FACTORY_RESET_CONFIRMED'
  },

  // Position sizing + portfolio risk caps (fractions of equity). These ARE enforced —
  // correlation is the real danger here, not exit timing. baseRiskPct is risk-per-trade
  // at neutral confidence; strong+well-sampled families scale up to maxMult, thin ones down.
  sizing: {
    enabled: bool(env.SIZING_ENABLED, true),
    baseRiskPct: num(env.SIZING_BASE_RISK_PCT, 0.0025),         // 0.25% equity per trade
    minMult: num(env.SIZING_MIN_MULT, 0.5),
    maxMult: num(env.SIZING_MAX_MULT, 1.25),
    maxTotalRiskPct: num(env.SIZING_MAX_TOTAL_RISK_PCT, 0.03),   // 3% equity at risk across all open
    maxSameSideRiskPct: num(env.SIZING_MAX_SAME_SIDE_RISK_PCT, 0.015), // 1.5% per direction
    maxCounterBtcRiskPct: num(env.SIZING_MAX_COUNTER_BTC_RISK_PCT, 0.0075) // 0.75% fighting BTC
  },

  // Trade management. Phase 1 = MEASURE ONLY (counterfactual flags on every position).
  // Once Analyze shows BE/trailing improves net R for a micro-family, flip applyLive on
  // and gate it per active micro-family — never blindly everywhere.
  manage: {
    applyLive: bool(env.MANAGE_APPLY_LIVE, false),
    beArmR: num(env.MANAGE_BE_ARM_R, 0.70),   // arm breakeven once trade reaches +0.70R
    beLockR: num(env.MANAGE_BE_LOCK_R, 0.05), // lock virtual stop at +0.05R
    trailArmR: num(env.MANAGE_TRAIL_ARM_R, 1.00),
    trailLockR: num(env.MANAGE_TRAIL_LOCK_R, 0.35)
  },

  // Execution cost model. Defaults are Bitget USDT-futures TAKER on both legs.
  // Conservative on purpose: if a family is net-positive here it is genuinely robust.
  cost: {
    takerFeePct: num(env.COST_TAKER_FEE_PCT, 0.0006),       // 0.06% per side
    makerFeePct: num(env.COST_MAKER_FEE_PCT, 0.0002),       // 0.02% per side (reference, unused in taker model)
    marketImpactPct: num(env.COST_MARKET_IMPACT_PCT, 0.0003), // extra adverse fill beyond quoted spread
    fallbackSpreadPct: num(env.COST_FALLBACK_SPREAD_PCT, 0.0008) // assumed spread when book is missing
  }
});
