// ================= FILE: src/config.js =================

export const env = process.env;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;

  const normalized = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  return fallback;
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
};

const str = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;

  const normalized = String(value).trim();
  return normalized || fallback;
};

export const CONFIG = Object.freeze({
  strategyVersion: str(env.STRATEGY_VERSION, 'CLEAN_MF_TS_V1'),

  app: {
    name: str(env.APP_NAME, 'Micro-Family Trading Admin'),
    baseUrl: str(env.APP_BASE_URL, env.VERCEL_URL ? `https://${env.VERCEL_URL}` : ''),
    adminPath: str(env.ADMIN_PATH, '/admin.html')
  },

  bitget: {
    baseUrl: str(env.BITGET_API_BASE_URL, 'https://api.bitget.com'),
    productType: str(env.BITGET_PRODUCT_TYPE, 'usdt-futures'),
    timeoutMs: int(env.BITGET_TIMEOUT_MS, 8000)
  },

  scanner: {
    // Universe cap after ticker volume filter.
    // Bitget raw tickers are all fetched; this controls how many symbols get candle analysis.
    maxSymbols: int(env.SCANNER_MAX_SYMBOLS, 200),

    // Candle-fetch concurrency for scanner. Main bottleneck = candles, not tickers.
    dataConcurrency: int(env.SCANNER_DATA_CONCURRENCY, 8),

    minQuoteVolume24h: num(env.SCANNER_MIN_QUOTE_VOLUME_24H, 5_000_000),
    minAbsChange1h: num(env.SCANNER_MIN_ABS_CHANGE_1H, 0.35),
    minAbsChange24h: num(env.SCANNER_MIN_ABS_CHANGE_24H, 1.00),

    snapshotTtlSec: int(env.SCANNER_SNAPSHOT_TTL_SEC, 30 * 60),
    candleLimit: int(env.SCANNER_CANDLE_LIMIT, 80),
    fakeBreakoutLookback: int(env.SCANNER_FAKE_BREAKOUT_LOOKBACK, 24),

    // Higher because 200 symbols can need materially longer than the old 80-symbol run.
    lockTtlSec: int(env.SCANNER_LOCK_TTL_SEC, 420)
  },

  trade: {
    lockTtlSec: int(env.TRADE_LOCK_TTL_SEC, 180),

    // More scanner candidates now possible because scanner universe increased 80 -> 200.
    maxCandidatesPerSnapshot: int(env.TRADE_MAX_CANDIDATES_PER_SNAPSHOT, 120),

    // Scanner draait elke 5 min. Entries op snapshots ouder dan 8 min worden geskipt.
    // Open positions blijven wel gemonitord.
    maxSnapshotAgeSec: int(env.TRADE_MAX_SNAPSHOT_AGE_SEC, 8 * 60),

    // Live validation uses orderbook + funding + 15m candles + 1h candles.
    dataConcurrency: int(env.TRADE_DATA_CONCURRENCY, 6),

    maxOpenPositions: int(env.TRADE_MAX_OPEN_POSITIONS, 30),
    maxOpenSameSide: int(env.TRADE_MAX_OPEN_SAME_SIDE, 15),

    positionTimeStopMin: int(env.TRADE_POSITION_TIME_STOP_MIN, 12 * 60),

    minRR: num(env.TRADE_MIN_RR, 0.50),
    defaultRR: num(env.TRADE_DEFAULT_RR, 1.50),

    // Decimal ratio. 0.0015 = 0.15%.
    // Oude 0.015 was 1.5% en veel te ruim voor futures execution.
    maxSpreadPct: num(env.TRADE_MAX_SPREAD_PCT, 0.0015),

    candleTtlSec: int(env.TRADE_CANDLE_CACHE_TTL_SEC, 90),
    orderbookTtlSec: int(env.TRADE_ORDERBOOK_CACHE_TTL_SEC, 12),
    fundingTtlSec: int(env.TRADE_FUNDING_CACHE_TTL_SEC, 120)
  },

  analyze: {
    schema: str(env.MICRO_FAMILY_SCHEMA, 'MF_V1'),

    shadowEnabled: bool(env.ANALYZE_SHADOW_ENABLED, true),
    shadowHorizonMin: int(env.ANALYZE_SHADOW_HORIZON_MIN, 6 * 60),
    shadowWeight: num(env.ANALYZE_SHADOW_WEIGHT, 0.35),

    obsDedupeTtlSec: int(env.ANALYZE_OBS_DEDUPE_TTL_SEC, 14 * 24 * 3600),
    shadowDedupeTtlSec: int(env.ANALYZE_SHADOW_DEDUPE_TTL_SEC, 48 * 3600),

    maxShadowMonitorsPerRun: int(env.ANALYZE_MAX_SHADOW_MONITORS_PER_RUN, 80),

    freezeLockTtlSec: int(env.ANALYZE_FREEZE_LOCK_TTL_SEC, 600),
    activateLockTtlSec: int(env.ANALYZE_ACTIVATE_LOCK_TTL_SEC, 600)
  },

  rotation: {
    mode: str(env.ROTATION_MODE, 'balanced'),
    topNPerSide: int(env.ROTATION_TOP_N_PER_SIDE, 10),

    // Minimum weighted completed trades per micro-family before it can enter rotation.
    minWeightedCompleted: num(env.ROTATION_MIN_WEIGHTED_COMPLETED, 5),

    priorTrades: num(env.ROTATION_PRIOR_TRADES, 24),
    priorWinrate: num(env.ROTATION_PRIOR_WINRATE, 0.50),
    wilsonZ: num(env.ROTATION_WILSON_Z, 1.96)
  },

  discord: {
    enabled: bool(env.DISCORD_ENABLED, true),
    webhookUrl: str(env.DISCORD_WEBHOOK_URL, ''),
    timeoutMs: int(env.DISCORD_TIMEOUT_MS, 2500),
    logLimit: int(env.DISCORD_LOG_LIMIT, 250)
  },

  reset: {
    confirmText: str(env.RESET_CONFIRM_TEXT, 'FACTORY_RESET_CONFIRMED')
  },

  sizing: {
    enabled: bool(env.SIZING_ENABLED, true),

    // Risk per trade at neutral confidence.
    baseRiskPct: num(env.SIZING_BASE_RISK_PCT, 0.0025),

    minMult: num(env.SIZING_MIN_MULT, 0.5),
    maxMult: num(env.SIZING_MAX_MULT, 1.25),

    // Portfolio caps.
    maxTotalRiskPct: num(env.SIZING_MAX_TOTAL_RISK_PCT, 0.03),
    maxSameSideRiskPct: num(env.SIZING_MAX_SAME_SIDE_RISK_PCT, 0.015),
    maxCounterBtcRiskPct: num(env.SIZING_MAX_COUNTER_BTC_RISK_PCT, 0.0075)
  },

  manage: {
    // Phase 1: false = only measure counterfactual BE/trailing behavior.
    // Later true only when Analyze proves it improves net R.
    applyLive: bool(env.MANAGE_APPLY_LIVE, false),

    beArmR: num(env.MANAGE_BE_ARM_R, 0.70),
    beLockR: num(env.MANAGE_BE_LOCK_R, 0.05),

    trailArmR: num(env.MANAGE_TRAIL_ARM_R, 1.00),
    trailLockR: num(env.MANAGE_TRAIL_LOCK_R, 0.35)
  },

  cost: {
    // Decimal ratio. 0.0006 = 0.06% per side.
    takerFeePct: num(env.COST_TAKER_FEE_PCT, 0.0006),
    makerFeePct: num(env.COST_MAKER_FEE_PCT, 0.0002),

    // Extra adverse fill beyond quoted spread.
    marketImpactPct: num(env.COST_MARKET_IMPACT_PCT, 0.0003),

    // Used when orderbook/spread is missing.
    fallbackSpreadPct: num(env.COST_FALLBACK_SPREAD_PCT, 0.0008)
  }
});