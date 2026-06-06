// ================= FILE: src/config.js =================

export const env = process.env;

const ROOT_TRADE_SIDE = 'SHORT';
const ROOT_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

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

const csv = (value, fallback = []) => {
  if (value === undefined || value === null || value === '') return fallback;

  const values = String(value)
    .split(/[\s,|;]+/g)
    .map((part) => part.trim())
    .filter(Boolean);

  return values.length ? values : fallback;
};

const positiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const n = int(value, fallback);

  return Math.max(min, Math.min(max, n));
};

const boundedNum = (value, fallback, min = -Infinity, max = Infinity) => {
  const n = num(value, fallback);

  return Math.max(min, Math.min(max, n));
};

/*
  SHORT root guard.

  Deze root mag nooit per ongeluk LONG gaan draaien door oude Vercel env values zoals:
  - PRIMARY_TRADE_SIDE=LONG
  - ALLOWED_TRADE_SIDES=LONG
  - SCANNER_ALLOWED_TRADE_SIDES=LONG
  - TRADE_ALLOWED_TRADE_SIDES=LONG
  - ANALYZE_ALLOWED_TRADE_SIDES=LONG
  - ROTATION_ALLOWED_TRADE_SIDES=LONG

  Daarom worden allowed sides hier hard gecleand naar alleen SHORT.
*/
const shortOnlySides = () => [ROOT_TRADE_SIDE];

const rootSide = () => ROOT_TRADE_SIDE;

const rootMode = () => 'SHORT_ONLY';

export const CONFIG = Object.freeze({
  strategyVersion: str(env.STRATEGY_VERSION, 'COARSE_MF_TS_SHORT_ONLY_STABLE_V3'),

  root: {
    tradeSide: ROOT_TRADE_SIDE,
    dashboardSide: ROOT_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    shortDisabled: false,
    blockLong: true,
    blockShort: false
  },

  direction: {
    mode: rootMode(),
    primaryTradeSide: rootSide(),
    allowedTradeSides: shortOnlySides(),

    shortEnabled: true,
    longEnabled: false,

    blockLong: true,
    blockShort: false,

    dashboardSide: ROOT_DASHBOARD_SIDE,
    targetDashboardSide: ROOT_DASHBOARD_SIDE
  },

  app: {
    name: str(env.APP_NAME, 'SHORT Micro-Family Trading Admin'),
    baseUrl: str(env.APP_BASE_URL, env.VERCEL_URL ? `https://${env.VERCEL_URL}` : ''),
    adminPath: str(env.ADMIN_PATH, '/admin.html')
  },

  redis: {
    maxRequestBytes: positiveInt(env.REDIS_MAX_REQUEST_BYTES, 9_500_000, 1_000_000, 50_000_000)
  },

  bitget: {
    baseUrl: str(env.BITGET_API_BASE_URL, 'https://api.bitget.com'),
    productType: str(env.BITGET_PRODUCT_TYPE, 'usdt-futures'),
    timeoutMs: positiveInt(env.BITGET_TIMEOUT_MS, 8000, 1000, 30000)
  },

  scanner: {
    mode: rootMode(),
    allowedTradeSides: shortOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    dashboardSide: ROOT_DASHBOARD_SIDE,

    shortEnabled: true,
    longEnabled: false,

    discardLongCandidates: true,
    discardShortCandidates: false,

    maxSymbols: positiveInt(env.SCANNER_MAX_SYMBOLS, 300, 1, 1000),
    maxCandidates: positiveInt(env.SCANNER_MAX_CANDIDATES, 300, 1, 1000),
    analyzeMaxCandidates: positiveInt(env.SCANNER_ANALYZE_MAX_CANDIDATES, 300, 1, 1000),

    dataConcurrency: positiveInt(env.SCANNER_DATA_CONCURRENCY, 12, 1, 30),

    minQuoteVolume24h: boundedNum(env.SCANNER_MIN_QUOTE_VOLUME_24H, 1_500_000, 0),
    softMinQuoteVolume24h: boundedNum(env.SCANNER_SOFT_MIN_QUOTE_VOLUME_24H, 10_000, 0),

    minAbsChange1h: boundedNum(env.SCANNER_MIN_ABS_CHANGE_1H, 0.12, 0),
    minAbsChange24h: boundedNum(env.SCANNER_MIN_ABS_CHANGE_24H, 0.35, 0),

    strictFilters: bool(env.SCANNER_STRICT_FILTERS, false),

    /*
      Voor SHORT root: fake breakout-rommel standaard wegfilteren.
      Zet alleen uit met SCANNER_BLOCK_FAKE_BREAKOUT=false als je bewust discovery breder wilt.
    */
    blockFakeBreakout: bool(env.SCANNER_BLOCK_FAKE_BREAKOUT, true),
    blockNoDirection: bool(env.SCANNER_BLOCK_NO_DIRECTION, false),
    blockSmallMove: bool(env.SCANNER_BLOCK_SMALL_MOVE, false),

    snapshotTtlSec: positiveInt(env.SCANNER_SNAPSHOT_TTL_SEC, 30 * 60, 60, 24 * 3600),
    candleLimit: positiveInt(env.SCANNER_CANDLE_LIMIT, 100, 30, 500),
    fakeBreakoutLookback: positiveInt(env.SCANNER_FAKE_BREAKOUT_LOOKBACK, 24, 5, 200),

    lockTtlSec: positiveInt(env.SCANNER_LOCK_TTL_SEC, 540, 30, 1800)
  },

  trade: {
    mode: rootMode(),
    allowedTradeSides: shortOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    dashboardSide: ROOT_DASHBOARD_SIDE,

    shortEnabled: true,
    longEnabled: false,

    blockLongEntries: true,
    blockShortEntries: false,

    lockTtlSec: positiveInt(env.TRADE_LOCK_TTL_SEC, 180, 30, 1800),

    maxCandidatesPerSnapshot: positiveInt(env.TRADE_MAX_CANDIDATES_PER_SNAPSHOT, 300, 1, 1000),
    analyzeMaxCandidatesPerSnapshot: positiveInt(env.TRADE_ANALYZE_MAX_CANDIDATES_PER_SNAPSHOT, 300, 1, 1000),
    maxAnalyzeCandidatesPerSnapshot: positiveInt(env.TRADE_MAX_ANALYZE_CANDIDATES_PER_SNAPSHOT, 300, 1, 1000),

    maxSnapshotAgeSec: positiveInt(env.TRADE_MAX_SNAPSHOT_AGE_SEC, 8 * 60, 30, 24 * 3600),

    dataConcurrency: positiveInt(env.TRADE_DATA_CONCURRENCY, 8, 1, 30),

    maxOpenPositions: positiveInt(env.TRADE_MAX_OPEN_POSITIONS, 30, 1, 500),
    maxOpenSameSide: positiveInt(env.TRADE_MAX_OPEN_SAME_SIDE, 30, 1, 500),

    positionTimeStopMin: positiveInt(env.TRADE_POSITION_TIME_STOP_MIN, 12 * 60, 5, 7 * 24 * 60),

    minRR: boundedNum(env.TRADE_MIN_RR, 0.50, 0.1, 10),
    defaultRR: boundedNum(env.TRADE_DEFAULT_RR, 1.50, 0.1, 20),

    maxSpreadPct: boundedNum(env.TRADE_MAX_SPREAD_PCT, 0.0015, 0, 0.05),

    minRiskPct: boundedNum(env.TRADE_MIN_RISK_PCT, 0.004, 0.0001, 0.25),
    maxRiskPct: boundedNum(env.TRADE_MAX_RISK_PCT, 0.025, 0.0001, 0.50),
    fallbackRiskPct: boundedNum(env.TRADE_FALLBACK_RISK_PCT, 0.005, 0.0001, 0.25),

    atrRiskMult: boundedNum(env.TRADE_ATR_RISK_MULT, 1.2, 0.1, 20),
    spreadRiskMult: boundedNum(env.TRADE_SPREAD_RISK_MULT, 5, 0.1, 100),

    requireScannerGateForLiveEntries: bool(env.TRADE_REQUIRE_SCANNER_GATE_FOR_LIVE_ENTRIES, true),
    blockDiscoveryOnlyLiveEntries: bool(env.TRADE_BLOCK_DISCOVERY_ONLY_LIVE_ENTRIES, true),
    allowFakeBreakoutLiveEntries: bool(env.TRADE_ALLOW_FAKE_BREAKOUT_LIVE_ENTRIES, false),
    allowLowConfidenceLiveEntries: bool(env.TRADE_ALLOW_LOW_CONFIDENCE_LIVE_ENTRIES, false),
    minLiveScannerScore: boundedNum(env.TRADE_MIN_LIVE_SCANNER_SCORE, 0, 0, 100),

    allowLegacyMacroLiveEntries: bool(env.TRADE_ALLOW_LEGACY_MACRO_LIVE_ENTRIES, false),

    /*
      Belangrijk voor coarse clustering:
      true = live entry mag matchen op coarse MF_V2 alias als refined id niet actief is.
      Dit voorkomt dat een goede SHORT micro niet matcht omdat de exacte fine id net anders is.
    */
    allowCoarseMicroAliasLiveEntries: bool(env.TRADE_ALLOW_COARSE_MICRO_ALIAS_LIVE_ENTRIES, true),

    candleTtlSec: positiveInt(env.TRADE_CANDLE_CACHE_TTL_SEC, 90, 5, 3600),
    orderbookTtlSec: positiveInt(env.TRADE_ORDERBOOK_CACHE_TTL_SEC, 12, 2, 300),
    fundingTtlSec: positiveInt(env.TRADE_FUNDING_CACHE_TTL_SEC, 120, 10, 3600)
  },

  analyze: {
    mode: rootMode(),
    allowedTradeSides: shortOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    dashboardSide: ROOT_DASHBOARD_SIDE,

    shortEnabled: true,
    longEnabled: false,

    discardLongObservations: true,
    discardShortObservations: false,

    schema: str(env.ANALYZE_SCHEMA || env.MICRO_FAMILY_SCHEMA, 'MF_V2'),
    legacySchema: str(env.ANALYZE_LEGACY_SCHEMA, 'MF_V1'),
    macroSchema: str(env.ANALYZE_MACRO_SCHEMA, 'MF_V1'),
    microSchema: str(env.ANALYZE_MICRO_SCHEMA, 'MF_V2'),

    /*
      Kritieke SHORT fix:
      false = geen _XR_ micro id per coin/fine bucket.
      Daardoor clusteren dezelfde SHORT setups over meerdere coins.
      Sample blijft dan niet dood op 1 of 0.
    */
    refineExecutionMicroIds: false,

    /*
      Alleen diagnostisch.
      Oude Vercel env ANALYZE_REFINE_EXECUTION_MICRO_IDS=true wordt bewust genegeerd.
    */
    refineExecutionMicroIdsEnvRequested: bool(env.ANALYZE_REFINE_EXECUTION_MICRO_IDS, false),

    /*
      Safe flags voor analyzer-code die coarse micro clustering ondersteunt.
      Als analyzer deze velden nog niet leest, breken ze niets.
    */
    preferCoarseMicroIdsForLearning: true,
    includeSymbolClassInMicroId: false,
    includeFineBucketsInMicroId: false,
    mergeRefinedExecutionMicros: true,

    shadowEnabled: bool(env.ANALYZE_SHADOW_ENABLED, true),
    shadowHorizonMin: positiveInt(env.ANALYZE_SHADOW_HORIZON_MIN, 6 * 60, 5, 7 * 24 * 60),
    shadowWeight: boundedNum(env.ANALYZE_SHADOW_WEIGHT, 0.35, 0, 1),

    obsDedupeTtlSec: positiveInt(env.ANALYZE_OBS_DEDUPE_TTL_SEC, 14 * 24 * 3600, 60, 90 * 24 * 3600),

    /*
      Lager dan 48h.
      Dit zorgt dat dezelfde SHORT micro sneller extra shadow/completed samples kan bouwen.
    */
    shadowDedupeTtlSec: positiveInt(env.ANALYZE_SHADOW_DEDUPE_TTL_SEC, 3 * 3600, 60, 14 * 24 * 3600),

    maxShadowMonitorsPerRun: positiveInt(env.ANALYZE_MAX_SHADOW_MONITORS_PER_RUN, 120, 1, 1000),

    freezeLockTtlSec: positiveInt(env.ANALYZE_FREEZE_LOCK_TTL_SEC, 600, 30, 3600),
    activateLockTtlSec: positiveInt(env.ANALYZE_ACTIVATE_LOCK_TTL_SEC, 600, 30, 3600),

    weekMicrosCompressionEnabled: bool(env.ANALYZE_WEEK_MICROS_COMPRESSION_ENABLED, true),
    weekMicrosCompressionLevel: positiveInt(env.ANALYZE_WEEK_MICROS_COMPRESSION_LEVEL, 6, 0, 9),
    maxMicroRowSetBytes: positiveInt(env.ANALYZE_MAX_MICRO_ROW_SET_BYTES, 250_000, 50_000, 5_000_000),

    weekMicrosTtlSec: positiveInt(env.ANALYZE_WEEK_MICROS_TTL_SEC, 21 * 24 * 3600, 24 * 3600, 365 * 24 * 3600),
    weekMetaTtlSec: positiveInt(env.ANALYZE_WEEK_META_TTL_SEC, 90 * 24 * 3600, 24 * 3600, 365 * 24 * 3600),

    storageConcurrency: positiveInt(env.ANALYZE_STORAGE_CONCURRENCY, 8, 1, 30),

    topMicrosSnapshotLimit: positiveInt(env.ANALYZE_TOP_MICROS_SNAPSHOT_LIMIT, 300, 1, 5000),
    maxFullReadMicroRows: positiveInt(env.ANALYZE_MAX_FULL_READ_MICRO_ROWS, 1_500, 100, 50_000),
    fullReadSoftTimeoutMs: positiveInt(env.ANALYZE_FULL_READ_SOFT_TIMEOUT_MS, 2_400, 250, 30_000),
    preferTopSnapshotOnLargeIndex: bool(env.ANALYZE_PREFER_TOP_SNAPSHOT_ON_LARGE_INDEX, true),

    maxExamplesPerMicro: positiveInt(env.ANALYZE_MAX_EXAMPLES_PER_MICRO, 8, 1, 100),
    maxRecentOutcomesPerMicro: positiveInt(env.ANALYZE_MAX_RECENT_OUTCOMES_PER_MICRO, 8, 1, 100),
    maxDefinitionPartsPerMicro: positiveInt(env.ANALYZE_MAX_DEFINITION_PARTS_PER_MICRO, 64, 8, 512),
    maxParentDefinitionPartsPerMicro: positiveInt(env.ANALYZE_MAX_PARENT_DEFINITION_PARTS_PER_MICRO, 48, 8, 512),
    maxCounterKeysPerMicro: positiveInt(env.ANALYZE_MAX_COUNTER_KEYS_PER_MICRO, 18, 1, 100),
    maxCounterValuesPerCounter: positiveInt(env.ANALYZE_MAX_COUNTER_VALUES_PER_COUNTER, 24, 1, 250),
    maxStoredStringLength: positiveInt(env.ANALYZE_MAX_STORED_STRING_LENGTH, 480, 64, 5000)
  },

  rotation: {
    mode: str(env.ROTATION_MODE, 'balanced'),
    directionMode: rootMode(),
    allowedTradeSides: shortOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    dashboardSide: ROOT_DASHBOARD_SIDE,

    shortEnabled: true,
    longEnabled: false,

    blockLongActivation: true,
    blockShortActivation: false,

    topNPerSide: positiveInt(env.ROTATION_TOP_N_PER_SIDE, 1, 1, 50),
    topNShort: positiveInt(env.ROTATION_TOP_N_SHORT, 1, 1, 50),
    topNLong: 0,

    /*
      0.35 betekent: shadow weighted completed mag al activeren.
      Niet op 1.0 zetten, anders wacht je onnodig lang.
    */
    minWeightedCompleted: boundedNum(env.ROTATION_MIN_WEIGHTED_COMPLETED, 0.35, 0, 100),

    enforceMaxPerMacroFamily: bool(env.ROTATION_ENFORCE_MAX_PER_MACRO_FAMILY, true),
    maxPerMacroFamily: positiveInt(env.ROTATION_MAX_PER_MACRO_FAMILY, 1, 1, 50),

    minPrimaryRowsForPreviousMerge: positiveInt(env.ROTATION_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE, 25, 0, 10_000),

    allowLegacyMacroActivation: bool(env.ROTATION_ALLOW_LEGACY_MACRO_ACTIVATION, false),

    allowSoftRotationFallback: bool(env.ROTATION_ALLOW_SOFT_ROTATION_FALLBACK, true),
    allowObservationRotationFallback: bool(env.ROTATION_ALLOW_OBSERVATION_ROTATION_FALLBACK, true),
    allowRawRotationFallback: bool(env.ROTATION_ALLOW_RAW_ROTATION_FALLBACK, true),

    allowManualUnknownTrueMicroIds: bool(env.ROTATION_ALLOW_MANUAL_UNKNOWN_TRUE_MICRO_IDS, true),
    allowManualBelowMinCompleted: bool(env.ROTATION_ALLOW_MANUAL_BELOW_MIN_COMPLETED, true),

    priorTrades: boundedNum(env.ROTATION_PRIOR_TRADES, 24, 0, 1000),
    priorWinrate: boundedNum(env.ROTATION_PRIOR_WINRATE, 0.50, 0, 1),
    wilsonZ: boundedNum(env.ROTATION_WILSON_Z, 1.96, 0, 5),

    sampleReliabilityCap: boundedNum(env.ROTATION_SAMPLE_RELIABILITY_CAP, 50, 1, 10_000),
    avgRCap: boundedNum(env.ROTATION_AVG_R_CAP, 5, 0.1, 100),
    avgRSampleExponent: boundedNum(env.ROTATION_AVG_R_SAMPLE_EXPONENT, 1.35, 0.1, 5)
  },

  discord: {
    enabled: bool(env.DISCORD_ENABLED, true),
    webhookUrl: str(env.DISCORD_WEBHOOK_URL, ''),
    timeoutMs: positiveInt(env.DISCORD_TIMEOUT_MS, 2500, 250, 30000),
    logLimit: positiveInt(env.DISCORD_LOG_LIMIT, 250, 10, 5000),

    allowedTradeSides: shortOnlySides(),
    primaryTradeSide: rootSide(),
    targetTradeSide: rootSide(),
    dashboardSide: ROOT_DASHBOARD_SIDE,

    shortEnabled: true,
    longEnabled: false
  },

  reset: {
    confirmText: str(env.RESET_CONFIRM_TEXT, 'FACTORY_RESET_CONFIRMED')
  },

  sizing: {
    enabled: bool(env.SIZING_ENABLED, true),

    baseRiskPct: boundedNum(env.SIZING_BASE_RISK_PCT, 0.0025, 0.00001, 0.25),

    minMult: boundedNum(env.SIZING_MIN_MULT, 0.5, 0.01, 10),
    maxMult: boundedNum(env.SIZING_MAX_MULT, 1.25, 0.01, 10),

    maxTotalRiskPct: boundedNum(env.SIZING_MAX_TOTAL_RISK_PCT, 0.03, 0.0001, 1),
    maxSameSideRiskPct: boundedNum(env.SIZING_MAX_SAME_SIDE_RISK_PCT, 0.03, 0.0001, 1),

    maxCounterBtcRiskPct: boundedNum(env.SIZING_MAX_COUNTER_BTC_RISK_PCT, 0.0075, 0.0001, 1)
  },

  manage: {
    applyLive: bool(env.MANAGE_APPLY_LIVE, false),

    beArmR: boundedNum(env.MANAGE_BE_ARM_R, 0.70, 0, 10),
    beLockR: boundedNum(env.MANAGE_BE_LOCK_R, 0.05, -5, 10),

    trailArmR: boundedNum(env.MANAGE_TRAIL_ARM_R, 1.00, 0, 20),
    trailLockR: boundedNum(env.MANAGE_TRAIL_LOCK_R, 0.35, -5, 20)
  },

  cost: {
    takerFeePct: boundedNum(env.COST_TAKER_FEE_PCT, 0.0006, 0, 0.05),
    makerFeePct: boundedNum(env.COST_MAKER_FEE_PCT, 0.0002, 0, 0.05),

    marketImpactPct: boundedNum(env.COST_MARKET_IMPACT_PCT, 0.0003, 0, 0.05),

    fallbackSpreadPct: boundedNum(env.COST_FALLBACK_SPREAD_PCT, 0.0008, 0, 0.05)
  }
});