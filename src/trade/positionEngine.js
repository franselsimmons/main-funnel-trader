// ================= FILE: src/trade/positionEngine.js =================

import { createHash } from 'crypto';
import { KEYS } from '../keys.js';
import { CONFIG } from '../config.js';
import {
  getDurableRedis,
  getJson,
  setJson,
  getKeys
} from '../redis.js';
import {
  safeNumber,
  randomId,
  sideToTradeSide,
  normalizeBaseSymbol,
  mapConcurrent
} from '../utils.js';
import {
  buildOutcomeFromPosition,
  recordOutcome
} from '../analyze/analyzeEngine.js';
import { sendExitAlert } from '../discord/discord.js';
import { applyCosts } from './costModel.js';
import {
  MARKET_WEATHER_KEY_VERSION,
  UNKNOWN_MARKET_WEATHER_KEY,
  normalizeMarketWeatherRegime,
  normalizeMarketWeatherTrendSide,
  buildEntryMarketWeatherKey,
  buildEntryMarketWeatherSnapshot,
  parseMarketWeatherKey
} from '../market/marketKey.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const TARGET_SCANNER_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_NAMESPACE = 'SHORT';
const SHORT_KEY_PREFIX = `${SHORT_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'SHORT_LIVE';

const TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_75';
const PARENT_TRUE_MICRO_SCHEMA = 'FIXED_TAXONOMY_15';
const CHILD_TRUE_MICRO_SCHEMA = TRUE_MICRO_SCHEMA;
const MICRO_MICRO_SCHEMA = 'FIXED_TAXONOMY_MICRO_MICRO_V1';

const MICRO_MICRO_SUFFIX = 'MM';
const MICRO_MICRO_HASH_LEN = 10;
const OUTCOME_IDENTITY_HASH_LEN = 24;

const LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';

const PARENT_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const MICRO_MICRO_LEARNING_GRANULARITY =
  'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_X_EXECUTION_CONTEXT_V1';

const ENTRY_MARKET_WEATHER_CAPTURE_VERSION =
  'SHORT_ENTRY_MARKET_WEATHER_CAPTURE_V5_ENTRY_IMMUTABLE_CURRENT_SEPARATE';

const MARKET_WEATHER_FEATURE_FLAGS_VERSION =
  'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V3_ENTRY_CURRENT_SEPARATED';

const MARKET_WEATHER_AGGREGATION_VERSION =
  'SHORT_MARKET_WEATHER_AGGREGATION_V1_REGIME_REGIMETREND';

const MICRO_MICRO_VERSION =
  'SHORT_PARENT_15_MICRO_75_MICRO_MICRO_ONLY_SELECTION_V6_DEADLINE_SAFE';

const RISK_PLAN_VERSION =
  'SHORT_ADAPTIVE_RR_TP_SL_V3_WEATHER_AWARE_PLAYBOOK';

const COST_MODEL_VERSION =
  'POSITION_ENGINE_SHORT_NET_COST_V18_DEADLINE_SAFE';

const MEASUREMENT_FIX_VERSION =
  'SHORT_MEASUREMENT_FIX_CANDLE_FIRST_TOUCH_MICRO_MICRO_V3_RUNTIME_SAFE';

const OBSERVATION_DEDUPE_VERSION =
  'SHORT_OBS_DEDUPE_SNAPSHOT_SYMBOL_MICRO_ENTRY_V4_MARKET_WEATHER';

const OUTCOME_DEDUPE_VERSION =
  'SHORT_OUTCOME_DEDUPE_V9_STABLE_TRADE_IDENTITY_RETRY_SAFE';

const HARD_TIME_STOP_CLEANUP_VERSION =
  'SHORT_POSITION_ENGINE_HARD_TIME_STOP_PRE_PRICE_EXIT_V2_DURABLE_RETRY_SAFE';

const OUTCOME_IDENTITY_LOCK_VERSION =
  'SHORT_OUTCOME_LEARNING_FAMILY_EQUALS_MICRO_MICRO_V3_STABLE_RETRY_IDENTITY';

const STABLE_OUTCOME_IDENTITY_VERSION =
  'SHORT_STABLE_OUTCOME_IDENTITY_V1_TRADE_SYMBOL_OPEN_MM';

const EXIT_ALERT_RUNTIME_GATE_VERSION =
  'SHORT_EXIT_ALERT_RUNTIME_GATE_APPROVED_ONLY_V5_RECOMPUTED_GATE';

const MICRO_MICRO_RUNTIME_GATE_VERSION =
  'SHORT_MM_RUNTIME_STATUS_GATE_V4_CANONICAL_RECOMPUTE_NO_STICKY_FLAGS';

const EMPIRICAL_VETO_VERSION =
  'SHORT_EXACT_MM_EMPIRICAL_VETO_LCB95_V2_CANONICAL_RECOMPUTE';

const TIMEOUT_HELPER_VERSION =
  'SHORT_TIMEOUT_HELPER_V3_REFED_WATCHDOG_DEADLINE_SAFE';

const OPEN_POSITION_PRELOAD_VERSION =
  'SHORT_MONITOR_PRELOADED_OPEN_POSITIONS_V2_ROTATING_BATCH';

const POSITION_ENGINE_RUNTIME_VERSION =
  'SHORT_POSITION_ENGINE_V18_HARD_DEADLINE_NO_RUNAWAY_WORKERS';

// ===== TOEGEVOEGD: versie om te bewijzen dat deze module wordt gebruikt =====
const POSITION_ENGINE_BINDING_FIX_VERSION =
  'SHORT_POSITION_ENGINE_LOCAL_IS_SHORT_POSITION_V1';

const SIGNAL_TYPE_TRADE_READY = 'TRADE_READY';
const SIGNAL_TYPE_WATCH_ONLY = 'WATCH_ONLY';
const SIGNAL_TYPE_OBSERVE_ONLY = 'OBSERVE_ONLY';
const SIGNAL_TYPE_BLOCKED = 'BLOCKED';

const MICRO_MICRO_STATUS_OBSERVING = 'OBSERVING';
const MICRO_MICRO_STATUS_PASSED = 'PASSED';
const MICRO_MICRO_STATUS_REJECTED = 'REJECTED';
const MICRO_MICRO_STATUS_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const MICRO_MICRO_STATUS_POLICY_BLOCKED = 'POLICY_BLOCKED';

const MICRO_MICRO_STATUS_RANK = Object.freeze({
  [MICRO_MICRO_STATUS_PASSED]: 0,
  [MICRO_MICRO_STATUS_OBSERVING]: 1,
  [MICRO_MICRO_STATUS_REJECTED]: 2,
  [MICRO_MICRO_STATUS_EMPIRICAL_VETO]: 3,
  [MICRO_MICRO_STATUS_POLICY_BLOCKED]: 4
});

const MIN_MICRO_MICRO_COMPLETED_FOR_PASSED = 35;
const MIN_MICRO_MICRO_COMPLETED_FOR_EMPIRICAL_VETO = 35;

const MIN_MICRO_MICRO_LCB95_AVG_R_FOR_PASSED = 0;
const MIN_MICRO_MICRO_AVG_R = 0;
const MIN_MICRO_MICRO_TOTAL_R = 0;
const MIN_MICRO_MICRO_PROFIT_FACTOR = 1;

const MAX_MICRO_MICRO_AVG_COST_R = 0.35;
const MAX_MICRO_MICRO_DIRECT_SL_PCT = 0.25;

const BLOCK_E_WEAK_CONTRA_FOR_MICRO_MICRO_GATE = true;

const LAYER_PARENT_15 = 'PARENT_15';
const LAYER_MICRO_75 = 'MICRO_75';
const LAYER_MICRO_MICRO = 'MICRO_MICRO';

const POSITION_SOURCE = 'VIRTUAL';
const OUTCOME_SOURCE = 'VIRTUAL';

const DEFAULT_POSITION_TIME_STOP_MIN = 720;
const MIN_COMPLETED_ACTIVE_LEARNING = 20;

/*
 * Runtime-safe defaults.
 *
 * Alles blijft actief:
 * - Redis-open-posities
 * - externe prijs
 * - Bitget 1m-candles
 * - TP/SL/time-stop
 * - outcome-learning
 * - Discord exits
 *
 * Eén invocation verwerkt alleen een begrensde batch.
 */
const DEFAULT_OPEN_POSITION_SCAN_LIMIT = 80;
const DEFAULT_OPEN_POSITION_HYDRATE_LIMIT = 30;
const DEFAULT_OPEN_POSITION_READ_CONCURRENCY = 2;
const DEFAULT_OPEN_POSITION_KEYS_TIMEOUT_MS = 600;
const DEFAULT_OPEN_POSITION_READ_TIMEOUT_MS = 800;

const DEFAULT_OPEN_POSITION_GET_TIMEOUT_MS = 600;
const DEFAULT_OPEN_POSITION_WRITE_TIMEOUT_MS = 650;
const DEFAULT_OPEN_POSITION_DELETE_TIMEOUT_MS = 500;

const DEFAULT_MONITOR_POSITION_LIMIT = 30;
const DEFAULT_MONITOR_BATCH_SIZE = 6;
const DEFAULT_MONITOR_CONCURRENCY = 2;

const DEFAULT_MONITOR_RUNTIME_MS = 4500;
const DEFAULT_MONITOR_ONE_POSITION_TIMEOUT_MS = 1600;

const DEFAULT_PRICE_FETCH_TIMEOUT_MS = 300;
const DEFAULT_CANDLE_FETCH_TIMEOUT_MS = 700;
const DEFAULT_RECORD_OUTCOME_TIMEOUT_MS = 1200;
const DEFAULT_DISCORD_EXIT_TIMEOUT_MS = 450;

const DEFAULT_MONITOR_CLOSE_RESERVE_MS = 250;

const BITGET_BASE_URL = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const BITGET_CANDLE_GRANULARITY = '1m';
const BITGET_CANDLE_MS = 60 * 1000;

const DEFAULT_RANGE_LOOKBACK_MS = 15 * 60 * 1000;
const DEFAULT_MAX_RANGE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RANGE_OVERLAP_MS = 15 * 1000;
const DEFAULT_CANDLE_FIRST_TOUCH_MIN_AGE_MS = 2 * 60 * 1000;

const SHORT_FIXED_SETUP_TYPES = new Set([
  'BREAKOUT',
  'RETEST',
  'SWEEP_REVERSAL',
  'CONTINUATION',
  'COMPRESSION'
]);

const REGIME_ORDER = Object.freeze([
  'TREND',
  'CHOP',
  'SQUEEZE'
]);

const SHORT_FIXED_REGIME_BUCKETS = new Set(
  REGIME_ORDER
);

const CONFIRMATION_PROFILE_ORDER = Object.freeze([
  'A_STRONG_ALIGN',
  'B_FLOW_ALIGN',
  'C_VOLUME_ALIGN',
  'D_MIXED_OK',
  'E_WEAK_CONTRA'
]);

const SHORT_CONFIRMATION_PROFILES = new Set(
  CONFIRMATION_PROFILE_ORDER
);

const SHORT_DIRECT = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

const LONG_DIRECT = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

function now() {
  return Date.now();
}

function upper(value) {
  return String(
    value || ''
  )
    .trim()
    .toUpperCase();
}

/**
 * Bepaalt of een opgeslagen positie een geldige SHORT-positie is.
 *
 * Expliciete sidevelden hebben voorrang.
 * Alleen als geen herkenbare side aanwezig is, worden shortOnly
 * en longDisabled als fallback gebruikt.
 */
function isShortPosition(position = {}) {
  if (
    !position ||
    typeof position !== 'object'
  ) {
    return false;
  }

  const sideCandidates = [
    position.tradeSide,
    position.positionSide,
    position.direction,
    position.analysisSide,
    position.signalSide,
    position.entrySide,
    position.side,
    position.dashboardSide,
    position.marketSide
  ];

  for (const value of sideCandidates) {
    const side = upper(value);
    if (!side) {
      continue;
    }

    if (
      SHORT_DIRECT.has(side)
    ) {
      return true;
    }

    if (
      LONG_DIRECT.has(side)
    ) {
      return false;
    }

    let convertedSide = 'UNKNOWN';
    try {
      convertedSide = upper(
        sideToTradeSide(side)
      );
    } catch {
      convertedSide = 'UNKNOWN';
    }

    if (
      convertedSide === TARGET_TRADE_SIDE
    ) {
      return true;
    }

    if (
      convertedSide === OPPOSITE_TRADE_SIDE
    ) {
      return false;
    }
  }

  return (
    position.shortOnly === true ||
    position.longDisabled === true
  );
}

function hasValue(value) {
  return (
    value !== undefined &&
    value !== null &&
    value !== ''
  );
}

function finiteNumberOrNull(value) {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    typeof value === 'boolean'
  ) {
    return null;
  }

  const number = Number(
    value
  );

  return Number.isFinite(
    number
  )
    ? number
    : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number =
      finiteNumberOrNull(
        value
      );

    if (number !== null) {
      return number;
    }
  }

  return null;
}

function chooseAliasedNumber(
  primaryValue,
  secondaryValue,
  fallback = null
) {
  const primary =
    finiteNumberOrNull(
      primaryValue
    );

  const secondary =
    finiteNumberOrNull(
      secondaryValue
    );

  if (
    primary === null &&
    secondary === null
  ) {
    return fallback;
  }

  if (primary === null) {
    return secondary;
  }

  if (secondary === null) {
    return primary;
  }

  if (
    primary === 0 &&
    secondary !== 0
  ) {
    return secondary;
  }

  if (
    secondary === 0 &&
    primary !== 0
  ) {
    return primary;
  }

  return primary;
}

function extractOutcomeNetR(
  outcome = {}
) {
  return firstFiniteNumber(
    outcome.netR,
    outcome.shortNetR,
    outcome.exitR,
    outcome.realizedNetR,
    outcome.realizedR,
    outcome.resultR,
    outcome.finalR,
    outcome.outcomeR,
    outcome.netResultR,
    outcome.pnlR,
    outcome.r
  );
}

function clamp(
  value,
  min,
  max
) {
  const x = Number(
    value
  );

  return Number.isFinite(
    x
  )
    ? Math.max(
        min,
        Math.min(
          max,
          x
        )
      )
    : min;
}

function clampInt(
  value,
  fallback,
  min,
  max
) {
  const n = Math.floor(
    safeNumber(
      value,
      fallback
    )
  );

  return Math.max(
    min,
    Math.min(
      max,
      n
    )
  );
}

function round4(value) {
  return Number(
    safeNumber(
      value,
      0
    ).toFixed(
      4
    )
  );
}

function round6(value) {
  return Number(
    safeNumber(
      value,
      0
    ).toFixed(
      6
    )
  );
}

function roundPrice(value) {
  const n = safeNumber(
    value,
    0
  );

  if (n >= 1000) {
    return Number(
      n.toFixed(
        2
      )
    );
  }

  if (n >= 1) {
    return Number(
      n.toFixed(
        6
      )
    );
  }

  return Number(
    n.toFixed(
      10
    )
  );
}

function hashText(
  value,
  length = MICRO_MICRO_HASH_LEN
) {
  return createHash(
    'sha256'
  )
    .update(
      String(
        value || ''
      )
    )
    .digest(
      'hex'
    )
    .toUpperCase()
    .slice(
      0,
      length
    );
}

function elapsedMs(
  startedAt
) {
  return Math.max(
    0,
    now() -
      safeNumber(
        startedAt,
        now()
      )
  );
}

function runtimeExceeded(
  startedAt,
  maxRuntimeMs,
  reserveMs = 150
) {
  return (
    elapsedMs(
      startedAt
    ) >=
    Math.max(
      100,
      safeNumber(
        maxRuntimeMs,
        DEFAULT_MONITOR_RUNTIME_MS
      ) -
        reserveMs
    )
  );
}

function runtimeRemainingMs(
  startedAt,
  maxRuntimeMs,
  reserveMs = 0
) {
  return Math.max(
    0,
    safeNumber(
      maxRuntimeMs,
      DEFAULT_MONITOR_RUNTIME_MS
    ) -
      elapsedMs(
        startedAt
      ) -
      Math.max(
        0,
        safeNumber(
          reserveMs,
          0
        )
      )
  );
}

async function withTimeout(
  promise,
  timeoutMs,
  label,
  fallback
) {
  const fallbackProvided =
    arguments.length >= 4;

  let timer = null;

  try {
    const safeTimeoutMs =
      Math.max(
        1,
        Math.floor(
          safeNumber(
            timeoutMs,
            1
          )
        )
      );

    const timeoutPromise =
      new Promise(
        (resolve) => {
          /*
           * Bewust geen unref().
           *
           * Deze watchdog moet altijd afgaan wanneer een Redis-
           * of netwerkpromise blijft hangen.
           */
          timer =
            setTimeout(
              () => {
                resolve({
                  __timeout:
                    true,

                  label,

                  timeoutMs:
                    safeTimeoutMs
                });
              },

              safeTimeoutMs
            );
        }
      );

    const workPromise =
      Promise
        .resolve(
          promise
        )
        .catch(
          (error) => ({
            __error:
              true,

            label,

            error:
              error?.message ||
              String(
                error
              )
          })
        );

    const result =
      await Promise.race([
        workPromise,
        timeoutPromise
      ]);

    if (
      result?.__timeout ||
      result?.__error
    ) {
      return fallbackProvided
        ? fallback
        : result;
    }

    return result;
  } finally {
    if (timer) {
      clearTimeout(
        timer
      );
    }
  }
}

function resolveRuntimeDeadlineAt(
  options = {},
  fallbackRuntimeMs =
    DEFAULT_MONITOR_RUNTIME_MS
) {
  const explicitDeadline =
    finiteNumberOrNull(
      options.deadlineAt
    );

  if (
    explicitDeadline !==
      null &&
    explicitDeadline >
      now()
  ) {
    return explicitDeadline;
  }

  const runtimeMs =
    Math.max(
      250,

      safeNumber(
        options.maxRuntimeMs ??
        options.monitorTimeoutMs,
        fallbackRuntimeMs
      )
    );

  return (
    now() +
    runtimeMs
  );
}

function deadlineRemainingMs(
  deadlineAt,
  reserveMs = 0
) {
  const deadline =
    finiteNumberOrNull(
      deadlineAt
    );

  if (
    deadline ===
    null
  ) {
    return Number
      .POSITIVE_INFINITY;
  }

  return Math.max(
    0,

    deadline -
      now() -
      Math.max(
        0,
        safeNumber(
          reserveMs,
          0
        )
      )
  );
}

function deadlineExceeded(
  deadlineAt,
  reserveMs = 0
) {
  return (
    deadlineRemainingMs(
      deadlineAt,
      reserveMs
    ) <=
    0
  );
}

function boundedOperationTimeoutMs(
  options = {},
  requestedMs,
  fallbackMs,
  reserveMs = 50
) {
  const requested =
    Math.max(
      1,

      safeNumber(
        requestedMs,
        fallbackMs
      )
    );

  const deadlineAt =
    finiteNumberOrNull(
      options.deadlineAt
    );

  if (
    deadlineAt ===
    null
  ) {
    return Math.floor(
      requested
    );
  }

  const remaining =
    deadlineRemainingMs(
      deadlineAt,
      reserveMs
    );

  return Math.max(
    1,

    Math.floor(
      Math.min(
        requested,
        remaining
      )
    )
  );
}

function resolveTradeConfig(
  options = {}
) {
  if (
    options.__tradeConfig &&
    typeof options
      .__tradeConfig ===
      'object'
  ) {
    return options
      .__tradeConfig;
  }

  return tradeConfig(
    options
  );
}

function clonePlainObject(
  value
) {
  if (
    typeof structuredClone ===
    'function'
  ) {
    return structuredClone(
      value
    );
  }

  return JSON.parse(
    JSON.stringify(
      value ?? null
    )
  );
}

function firstValue(
  ...values
) {
  for (
    const value
    of values
  ) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ''
    ) {
      return value;
    }
  }

  return null;
}

function namespacedShortKey(
  key,
  fallback
) {
  const raw = String(
    key ||
      fallback ||
      ''
  ).trim();

  if (!raw) {
    return `${SHORT_KEY_PREFIX}MISSING_KEY`;
  }

  if (
    raw.startsWith(
      SHORT_KEY_PREFIX
    )
  ) {
    return raw;
  }

  if (
    raw.startsWith(
      'LONG:'
    )
  ) {
    return (
      `${SHORT_KEY_PREFIX}` +
      raw.slice(
        'LONG:'.length
      )
    );
  }

  return `${SHORT_KEY_PREFIX}${raw}`;
}

function storageSymbol(
  input
) {
  const raw =
    typeof input ===
    'object'
      ? (
          input?.symbol ||
          input?.baseSymbol ||
          input?.contractSymbol
        )
      : input;

  const base =
    normalizeBaseSymbol(
      raw
    );

  return (
    base ||
    String(
      raw || ''
    )
      .toUpperCase()
      .trim()
  );
}

function symbolFromOpenKey(
  key = ''
) {
  const raw = String(
    key || ''
  ).trim();

  const part =
    raw
      .split(
        ':'
      )
      .pop();

  return storageSymbol(
    part
  );
}

function resolveOpenPatternKey() {
  const configured =
    KEYS.short?.trade
      ?.openPattern ||
    KEYS.trade
      ?.shortOpenPattern ||
    KEYS.trade
      ?.openPattern;

  return namespacedShortKey(
    configured,
    'TRADE:OPEN:*'
  );
}

function resolveOpenKey(
  symbol
) {
  const keySymbol =
    storageSymbol(
      symbol
    );

  if (!keySymbol) {
    return null;
  }

  if (
    typeof KEYS.short
      ?.trade?.open ===
    'function'
  ) {
    return namespacedShortKey(
      KEYS.short.trade.open(
        keySymbol
      ),
      `TRADE:OPEN:${keySymbol}`
    );
  }

  if (
    typeof KEYS.trade
      ?.shortOpen ===
    'function'
  ) {
    return namespacedShortKey(
      KEYS.trade.shortOpen(
        keySymbol
      ),
      `TRADE:OPEN:${keySymbol}`
    );
  }

  if (
    typeof KEYS.trade
      ?.open ===
    'function'
  ) {
    return namespacedShortKey(
      KEYS.trade.open(
        keySymbol
      ),
      `TRADE:OPEN:${keySymbol}`
    );
  }

  return namespacedShortKey(
    null,
    `TRADE:OPEN:${keySymbol}`
  );
}

const SHORT_KEYS = {
  trade: {
    openPattern:
      resolveOpenPatternKey(),

    open:
      resolveOpenKey
  }
};

function tradeConfig(
  options = {}
) {
  const recordOutcomeTimeoutMs =
    clampInt(
      options
        .recordOutcomeTimeoutMs ??
        CONFIG.short
          ?.trade
          ?.recordOutcomeTimeoutMs ??
        CONFIG.trade
          ?.recordOutcomeTimeoutMs,
      DEFAULT_RECORD_OUTCOME_TIMEOUT_MS,
      250,
      10000
    );

  const discordExitTimeoutMs =
    clampInt(
      options
        .discordExitTimeoutMs ??
        CONFIG.short
          ?.trade
          ?.discordExitTimeoutMs ??
        CONFIG.trade
          ?.discordExitTimeoutMs,
      DEFAULT_DISCORD_EXIT_TIMEOUT_MS,
      100,
      5000
    );

  const minimumSafeMonitorRuntimeMs =
    Math.min(
      30000,
      recordOutcomeTimeoutMs +
        discordExitTimeoutMs +
        DEFAULT_MONITOR_CLOSE_RESERVE_MS
    );

  const requestedMonitorRuntimeMs =
    clampInt(
      options.maxRuntimeMs ??
        options
          .monitorTimeoutMs ??
        CONFIG.short
          ?.trade
          ?.monitorTimeoutMs ??
        CONFIG.trade
          ?.monitorTimeoutMs,
      DEFAULT_MONITOR_RUNTIME_MS,
      500,
      30000
    );

  /*
   * De bovenliggende route is de harde bron van waarheid.
   *
   * Een routebudget van bijvoorbeeld 1800 ms mag niet meer
   * stilzwijgend worden verhoogd naar 6200 ms.
   */
  const monitorRuntimeMs =
    requestedMonitorRuntimeMs;

  const requestedOnePositionTimeoutMs =
    clampInt(
      options
        .monitorOnePositionTimeoutMs ??
        CONFIG.short
          ?.trade
          ?.monitorOnePositionTimeoutMs ??
        CONFIG.trade
          ?.monitorOnePositionTimeoutMs,
      DEFAULT_MONITOR_ONE_POSITION_TIMEOUT_MS,
      150,
      15000
    );

  const monitorOnePositionTimeoutMs =
    Math.max(
      150,

      Math.min(
        requestedOnePositionTimeoutMs,

        Math.max(
          150,

          monitorRuntimeMs -
            DEFAULT_MONITOR_CLOSE_RESERVE_MS
        )
      )
    );

  return {
    dataConcurrency:
      clampInt(
        options
          .dataConcurrency ??
          CONFIG.short
            ?.trade
            ?.dataConcurrency ??
          CONFIG.trade
            ?.dataConcurrency,
        DEFAULT_MONITOR_CONCURRENCY,
        1,
        3
      ),

    positionTimeStopMin:
      Math.max(
        1,
        safeNumber(
          options
            .positionTimeStopMin ??
            CONFIG.short
              ?.trade
              ?.positionTimeStopMin ??
            CONFIG.trade
              ?.positionTimeStopMin,
          DEFAULT_POSITION_TIME_STOP_MIN
        )
      ),

    hardTimeStopNoPriceExit:
      options
        .hardTimeStopNoPriceExit !==
        false &&
      CONFIG.short
        ?.trade
        ?.hardTimeStopNoPriceExit !==
        false &&
      CONFIG.trade
        ?.hardTimeStopNoPriceExit !==
        false,

    closeExpiredBeforePriceFetch:
      options
        .closeExpiredBeforePriceFetch !==
        false &&
      CONFIG.short
        ?.trade
        ?.closeExpiredBeforePriceFetch !==
        false &&
      CONFIG.trade
        ?.closeExpiredBeforePriceFetch !==
        false,

    openPositionScanLimit:
      clampInt(
        options.limit ??
          options
            .openPositionLimit ??
          options
            .maxOpenPositionsToRead ??
          CONFIG.short
            ?.trade
            ?.openPositionScanLimit ??
          CONFIG.trade
            ?.openPositionScanLimit,
        DEFAULT_OPEN_POSITION_SCAN_LIMIT,
        1,
        500
      ),

    hydrateLimit:
      clampInt(
        options
          .hydrateLimit ??
          options
            .openPositionHydrateLimit ??
          CONFIG.short
            ?.trade
            ?.openPositionHydrateLimit ??
          CONFIG.trade
            ?.openPositionHydrateLimit,
        DEFAULT_OPEN_POSITION_HYDRATE_LIMIT,
        0,
        300
      ),

    readConcurrency:
      clampInt(
        options
          .openPositionReadConcurrency ??
          CONFIG.short
            ?.trade
            ?.openPositionReadConcurrency ??
          CONFIG.trade
            ?.openPositionReadConcurrency,
        DEFAULT_OPEN_POSITION_READ_CONCURRENCY,
        1,
        4
      ),

    keysTimeoutMs:
      clampInt(
        options
          .openPositionKeysTimeoutMs ??
          CONFIG.short
            ?.trade
            ?.openPositionKeysTimeoutMs ??
          CONFIG.trade
            ?.openPositionKeysTimeoutMs,
        DEFAULT_OPEN_POSITION_KEYS_TIMEOUT_MS,
        100,
        3000
      ),

    readTimeoutMs:
      clampInt(
        options
          .openPositionReadTimeoutMs ??
          CONFIG.short
            ?.trade
            ?.openPositionReadTimeoutMs ??
          CONFIG.trade
            ?.openPositionReadTimeoutMs,
        DEFAULT_OPEN_POSITION_READ_TIMEOUT_MS,
        100,
        4000
      ),

    monitorPositionLimit:
      clampInt(
        options
          .maxOpenPositionsToMonitor ??
          options
            .openPositionMonitorLimit ??
          CONFIG.short
            ?.trade
            ?.openPositionMonitorLimit ??
          CONFIG.trade
            ?.openPositionMonitorLimit,
        DEFAULT_MONITOR_POSITION_LIMIT,
        1,
        150
      ),

    monitorBatchSize:
      clampInt(
        options
          .monitorBatchSize ??
          CONFIG.short
            ?.trade
            ?.monitorBatchSize ??
          CONFIG.trade
            ?.monitorBatchSize,
        DEFAULT_MONITOR_BATCH_SIZE,
        1,
        50
      ),

    monitorRuntimeMs,

    requestedMonitorRuntimeMs,

    minimumSafeMonitorRuntimeMs,

    monitorOnePositionTimeoutMs,

    requestedOnePositionTimeoutMs,

    recordOutcomeTimeoutMs,

    discordExitTimeoutMs,

    priceFetchTimeoutMs:
      clampInt(
        options
          .monitorPriceFetchTimeoutMs ??
          options
            .priceFetchTimeoutMs ??
          CONFIG.short
            ?.trade
            ?.monitorPriceFetchTimeoutMs ??
          CONFIG.trade
            ?.monitorPriceFetchTimeoutMs,
        DEFAULT_PRICE_FETCH_TIMEOUT_MS,
        50,
        2000
      ),

    candleFetchTimeoutMs:
      clampInt(
        options
          .candleFetchTimeoutMs ??
          options
            .monitorCandleFetchTimeoutMs ??
          CONFIG.short
            ?.trade
            ?.candleFetchTimeoutMs ??
          CONFIG.short
            ?.trade
            ?.monitorCandleFetchTimeoutMs ??
          CONFIG.trade
            ?.candleFetchTimeoutMs ??
          CONFIG.trade
            ?.monitorCandleFetchTimeoutMs,
        DEFAULT_CANDLE_FETCH_TIMEOUT_MS,
        100,
        4000
      ),

    monitorCandleRangeEnabled:
      options
        .monitorCandleRangeEnabled !==
        false &&
      CONFIG.short
        ?.trade
        ?.monitorCandleRangeEnabled !==
        false &&
      CONFIG.trade
        ?.monitorCandleRangeEnabled !==
        false,

    rangeLookbackMs:
      clampInt(
        options
          .rangeLookbackMs ??
          options
            .monitorRangeLookbackMs ??
          CONFIG.short
            ?.trade
            ?.rangeLookbackMs ??
          CONFIG.short
            ?.trade
            ?.monitorRangeLookbackMs ??
          CONFIG.trade
            ?.rangeLookbackMs ??
          CONFIG.trade
            ?.monitorRangeLookbackMs,
        DEFAULT_RANGE_LOOKBACK_MS,
        60 * 1000,
        DEFAULT_MAX_RANGE_LOOKBACK_MS
      ),

    maxRangeLookbackMs:
      clampInt(
        options
          .maxRangeLookbackMs ??
          options
            .monitorMaxRangeLookbackMs ??
          CONFIG.short
            ?.trade
            ?.maxRangeLookbackMs ??
          CONFIG.short
            ?.trade
            ?.monitorMaxRangeLookbackMs ??
          CONFIG.trade
            ?.maxRangeLookbackMs ??
          CONFIG.trade
            ?.monitorMaxRangeLookbackMs,
        DEFAULT_MAX_RANGE_LOOKBACK_MS,
        5 * 60 * 1000,
        24 * 60 * 60 * 1000
      ),

    rangeOverlapMs:
      clampInt(
        options
          .rangeOverlapMs ??
          options
            .monitorRangeOverlapMs ??
          CONFIG.short
            ?.trade
            ?.rangeOverlapMs ??
          CONFIG.short
            ?.trade
            ?.monitorRangeOverlapMs ??
          CONFIG.trade
            ?.rangeOverlapMs ??
          CONFIG.trade
            ?.monitorRangeOverlapMs,
        DEFAULT_RANGE_OVERLAP_MS,
        0,
        60 * 1000
      ),

    candleFirstTouchMinAgeMs:
      clampInt(
        options
          .candleFirstTouchMinAgeMs ??
          options
            .monitorCandleFirstTouchMinAgeMs ??
          CONFIG.short
            ?.trade
            ?.candleFirstTouchMinAgeMs ??
          CONFIG.short
            ?.trade
            ?.monitorCandleFirstTouchMinAgeMs ??
          CONFIG.trade
            ?.candleFirstTouchMinAgeMs ??
          CONFIG.trade
            ?.monitorCandleFirstTouchMinAgeMs,
        DEFAULT_CANDLE_FIRST_TOUCH_MIN_AGE_MS,
        0,
        10 * 60 * 1000
      ),

    persistNoPriceFailures:
      options
        .persistNoPriceFailures ===
      true,

    timeoutHelperVersion:
      TIMEOUT_HELPER_VERSION
  };
}

/*
 * De rest van jouw bestaande identiteit-, weather-, runtimegate-,
 * Net-R-, outcome- en Discordlogica blijft ongewijzigd.
 *
 * Hieronder staan de runtimekritieke functies volledig vervangen.
 *
 * BELANGRIJK:
 * Gebruik vanaf hier de resterende bestaande functies uit jouw huidige
 * bestand tot en met sortOpenPositions(), en vervang daarna de functies
 * hieronder exact.
 */

/*
 * ================= RUNTIME-SAFE REPLACEMENTS =================
 */

async function readOpenPositionRows(
  redis,
  keys = [],
  options = {}
) {
  const cfg =
    resolveTradeConfig(
      options
    );

  const deadlineAt =
    resolveRuntimeDeadlineAt(
      options,

      cfg.readTimeoutMs +
        250
    );

  const safeKeys =
    Array.isArray(
      keys
    )
      ? keys
          .filter(
            Boolean
          )
      : [];

  if (
    !safeKeys.length
  ) {
    return [];
  }

  const output =
    new Array(
      safeKeys.length
    );

  let cursor =
    0;

  const workerCount =
    Math.max(
      1,

      Math.min(
        cfg.readConcurrency,
        safeKeys.length
      )
    );

  const workers =
    Array
      .from(
        {
          length:
            workerCount
        },

        async () => {
          while (
            cursor <
            safeKeys.length
          ) {
            if (
              deadlineExceeded(
                deadlineAt,
                75
              )
            ) {
              return;
            }

            const index =
              cursor++;

            const key =
              safeKeys[
                index
              ];

            const readTimeoutMs =
              boundedOperationTimeoutMs(
                {
                  ...options,

                  deadlineAt
                },

                cfg.readTimeoutMs,

                DEFAULT_OPEN_POSITION_READ_TIMEOUT_MS,

                75
              );

            const row =
              await withTimeout(
                getJson(
                  redis,
                  key,
                  null
                ),

                readTimeoutMs,

                'OPEN_POSITION_READ_TIMEOUT',

                null
              );

            output[
              index
            ] = {
              key,

              row,

              timedOutByBudget:
                row ===
                null
            };
          }
        }
      );

  await Promise.all(
    workers
  );

  return output
    .filter(
      Boolean
    );
}

export async function getOpenPositions(
  options = {}
) {
  const redis =
    getDurableRedis();

  const cfg =
    tradeConfig(
      options
    );

  const deadlineAt =
    resolveRuntimeDeadlineAt(
      options,

      cfg.keysTimeoutMs +
        cfg.readTimeoutMs +
        400
    );

  const runtimeOptions = {
    ...options,

    deadlineAt,

    __tradeConfig:
      cfg
  };

  const requireFullRows =
    options
      .requireFullRows ===
      true ||
    options
      .monitorMode ===
      true ||
    options
      .forMonitor ===
      true;

  const monitorRead =
    options
      .monitorMode ===
      true ||
    options
      .forMonitor ===
      true;

  const includeKeyOnly =
    requireFullRows
      ? false
      : options
          .includeKeyOnly !==
        false;

  if (
    deadlineExceeded(
      deadlineAt,
      100
    )
  ) {
    return [];
  }

  const keysTimeoutMs =
    boundedOperationTimeoutMs(
      runtimeOptions,

      cfg.keysTimeoutMs,

      DEFAULT_OPEN_POSITION_KEYS_TIMEOUT_MS,

      100
    );

  const keys =
    await withTimeout(
      getKeys(
        redis,

        SHORT_KEYS
          .trade
          .openPattern,

        cfg
          .openPositionScanLimit
      ),

      keysTimeoutMs,

      'GET_OPEN_POSITION_KEYS_TIMEOUT',

      []
    );

  const safeKeys =
    Array.isArray(
      keys
    )
      ? [
          ...new Set(
            keys
          )
        ]
          .filter(
            Boolean
          )
          .slice(
            0,

            cfg
              .openPositionScanLimit
          )
      : [];

  if (
    !safeKeys.length ||
    deadlineExceeded(
      deadlineAt,
      100
    )
  ) {
    return [];
  }

  /*
   * Tijdens monitoring roteren de Redis-keys.
   * Daardoor worden bij veel posities niet steeds alleen
   * dezelfde eerste keys gehydrateerd.
   */
  const keyStart =
    monitorRead &&
    safeKeys.length >
      1
      ? (
          Math.floor(
            now() /
            (
              2 *
              60 *
              1000
            )
          ) %
          safeKeys.length
        )
      : 0;

  const orderedKeys =
    keyStart >
      0
      ? [
          ...safeKeys.slice(
            keyStart
          ),

          ...safeKeys.slice(
            0,
            keyStart
          )
        ]
      : safeKeys;

  const hydrateLimit =
    monitorRead
      ? Math.min(
          orderedKeys.length,

          cfg
            .hydrateLimit,

          Math.max(
            cfg
              .monitorBatchSize *
              3,

            cfg
              .monitorPositionLimit
          )
        )
      : Math.min(
          orderedKeys.length,

          cfg
            .hydrateLimit
        );

  const hydrateKeys =
    hydrateLimit >
      0
      ? orderedKeys
          .slice(
            0,
            hydrateLimit
          )
      : [];

  const readRows =
    hydrateKeys.length
      ? await readOpenPositionRows(
          redis,

          hydrateKeys,

          runtimeOptions
        )
      : [];

  const hydratedKeySet =
    new Set(
      readRows
        .map(
          (row) =>
            row.key
        )
    );

  const validHydratedRows =
    readRows
      .map(
        (item) =>
          item.row
      )
      .filter(
        Boolean
      )
      .filter(
        (row) =>
          String(
            row.status ||
            'OPEN'
          )
            .toUpperCase() ===
          'OPEN'
      )
      .filter(
        isShortPosition
      )
      .filter(
        (row) =>
          !isScannerFamilyRow(
            row
          )
      )
      .filter(
        (row) =>
          isExactShortChildTrueMicroId(
            rowMicroId(
              row
            )
          )
      )
      .filter(
        (row) =>
          isExactShortMicroMicroId(
            rowMicroMicroId(
              row
            )
          )
      )
      .map(
        (row) =>
          forceShortPositionFields({
            ...preserveLockedEntryWeather(
              row,
              row
            ),

            openPositionKeyOnly:
              false,

            monitorEligible:
              true,

            cleanMicroMicroPosition:
              true
          })
      );

  if (
    !includeKeyOnly
  ) {
    return validHydratedRows
      .sort(
        sortOpenPositions
      );
  }

  const hydratedSymbols =
    new Set(
      validHydratedRows
        .map(
          (row) =>
            storageSymbol(
              row
            )
        )
        .filter(
          Boolean
        )
    );

  const keyOnlyRows =
    orderedKeys
      .filter(
        (key) =>
          !hydratedKeySet
            .has(
              key
            )
      )
      .map(
        (key) =>
          buildKeyOnlyOpenPosition(
            key
          )
      )
      .filter(
        (row) =>
          row.symbol
      )
      .filter(
        (row) =>
          !hydratedSymbols
            .has(
              storageSymbol(
                row
              )
            )
      );

  return [
    ...validHydratedRows,
    ...keyOnlyRows
  ]
    .sort(
      sortOpenPositions
    );
}

export async function getOpenPosition(
  symbol,
  options = {}
) {
  const keySymbol =
    storageSymbol(
      symbol
    );

  if (
    !keySymbol
  ) {
    return null;
  }

  const timeoutMs =
    boundedOperationTimeoutMs(
      options,

      options
        .getOpenPositionTimeoutMs,

      DEFAULT_OPEN_POSITION_GET_TIMEOUT_MS,

      50
    );

  const row =
    await withTimeout(
      getJson(
        getDurableRedis(),

        SHORT_KEYS
          .trade
          .open(
            keySymbol
          ),

        null
      ),

      timeoutMs,

      'GET_SINGLE_OPEN_POSITION_TIMEOUT',

      null
    );

  if (!row) {
    return null;
  }

  if (
    String(
      row.status ||
      'OPEN'
    )
      .toUpperCase() !==
    'OPEN'
  ) {
    return null;
  }

  if (
    !isShortPosition(
      row
    )
  ) {
    return null;
  }

  if (
    isScannerFamilyRow(
      row
    )
  ) {
    return null;
  }

  if (
    !isExactShortChildTrueMicroId(
      rowMicroId(
        row
      )
    )
  ) {
    return null;
  }

  if (
    !isExactShortMicroMicroId(
      rowMicroMicroId(
        row
      )
    )
  ) {
    return null;
  }

  return forceShortPositionFields(
    preserveLockedEntryWeather(
      row,
      row
    )
  );
}

export async function saveOpenPosition(
  position,
  options = {}
) {
  assertShortInput(
    position,
    'SAVE_OPEN_POSITION'
  );

  const keySymbol =
    storageSymbol(
      position
    );

  if (
    !keySymbol
  ) {
    throw new Error(
      'OPEN_POSITION_SYMBOL_MISSING'
    );
  }

  const skipExistingRead =
    options
      .skipExistingRead ===
    true;

  const existing =
    skipExistingRead
      ? null
      : await getOpenPosition(
          keySymbol,

          options
        );

  if (
    existing &&
    existing.tradeId &&
    position.tradeId &&
    existing.tradeId !==
      position.tradeId
  ) {
    return forceShortPositionFields({
      ...existing,

      alreadyOpen:
        true,

      duplicateOpenPositionSkipped:
        true,

      skippedByExistingSymbol:
        true,

      attemptedTradeId:
        position.tradeId,

      attemptedAt:
        now(),

      reason:
        'OPEN_POSITION_SYMBOL_ALREADY_OPEN_SHORT_ONLY'
    });
  }

  const normalized =
    forceShortPositionFields(
      position
        .entryMarketWeatherKey
        ? preserveLockedEntryWeather(
            position,
            position
          )
        : attachEntryMarketWeather(
            position,

            position.openedAt ||
            position.createdAt ||
            now()
          )
    );

  const identity =
    normalizeMicroIdentity(
      normalized
    );

  const runtimeStatusGate =
    microMicroRuntimeGate({
      ...normalized,

      ...identity
    });

  const row =
    compactOpenPositionRow(
      forceShortPositionFields({
        ...normalized,

        ...identity,

        ...buildVirtualFlags({
          ...normalized,

          ...identity,

          microMicroRuntimeGate:
            runtimeStatusGate,

          microMicroRuntimeGateStatus:
            runtimeStatusGate
              .status,

          microMicroStatus:
            runtimeStatusGate
              .status
        }),

        microMicroRuntimeGate:
          runtimeStatusGate,

        microMicroRuntimeGateStatus:
          runtimeStatusGate
            .status,

        microMicroRuntimeGateVersion:
          MICRO_MICRO_RUNTIME_GATE_VERSION,

        microMicroStatus:
          runtimeStatusGate
            .status,

        symbol:
          normalized.symbol ||
          keySymbol,

        baseSymbol:
          normalized
            .baseSymbol ||
          keySymbol,

        contractSymbol:
          normalized
            .contractSymbol ||
          null,

        status:
          normalized.status ||
          'OPEN',

        strategyVersion:
          normalized
            .strategyVersion ||
          CONFIG
            .strategyVersion,

        updatedAt:
          now()
      })
    );

  assertPositionPersistable(
    row
  );

  const writeTimeoutMs =
    boundedOperationTimeoutMs(
      options,

      options
        .openPositionWriteTimeoutMs,

      DEFAULT_OPEN_POSITION_WRITE_TIMEOUT_MS,

      50
    );

  const writeResult =
    await withTimeout(
      Promise
        .resolve(
          setJson(
            getDurableRedis(),

            SHORT_KEYS
              .trade
              .open(
                keySymbol
              ),

            row
          )
        )
        .then(
          () => ({
            ok:
              true
          })
        ),

      writeTimeoutMs,

      'SAVE_OPEN_POSITION_TIMEOUT',

      {
        ok:
          false,

        timeout:
          true
      }
    );

  if (
    writeResult
      ?.ok !==
    true
  ) {
    throw new Error(
      'SAVE_OPEN_POSITION_TIMEOUT'
    );
  }

  return row;
}

export async function deleteOpenPosition(
  symbol,
  options = {}
) {
  const keySymbol =
    storageSymbol(
      symbol
    );

  if (
    !keySymbol
  ) {
    return 0;
  }

  const key =
    SHORT_KEYS
      .trade
      .open(
        keySymbol
      );

  if (!key) {
    return 0;
  }

  const timeoutMs =
    boundedOperationTimeoutMs(
      options,

      options
        .openPositionDeleteTimeoutMs,

      DEFAULT_OPEN_POSITION_DELETE_TIMEOUT_MS,

      25
    );

  return withTimeout(
    getDurableRedis()
      .del(
        key
      ),

    timeoutMs,

    'DELETE_OPEN_POSITION_TIMEOUT',

    {
      deleted:
        false,

      timeout:
        true,

      error:
        'DELETE_OPEN_POSITION_TIMEOUT'
    }
  );
}

/*
 * Gebruik jouw bestaande updatePathMetrics(),
 * buildOpenPositionFromEntry(), outcome-, weather- en
 * learningfuncties ongewijzigd.
 *
 * Vervang resolveMonitorPriceProbe() door deze versie.
 */

async function resolveMonitorPriceProbe({
  position,
  priceFetcher,
  timestamp,
  options = {}
} = {}) {
  const cfg =
    resolveTradeConfig(
      options
    );

  const deadlineAt =
    resolveRuntimeDeadlineAt(
      options,

      cfg.monitorRuntimeMs
    );

  if (
    deadlineExceeded(
      deadlineAt,
      100
    )
  ) {
    return normalizePriceProbe(
      null,
      'MONITOR_DEADLINE_REACHED_BEFORE_PRICE'
    );
  }

  const runtimeOptions = {
    ...options,

    deadlineAt,

    __tradeConfig:
      cfg
  };

  const priceTimeoutMs =
    boundedOperationTimeoutMs(
      runtimeOptions,

      cfg
        .priceFetchTimeoutMs,

      DEFAULT_PRICE_FETCH_TIMEOUT_MS,

      100
    );

  const candleTimeoutMs =
    boundedOperationTimeoutMs(
      runtimeOptions,

      cfg
        .candleFetchTimeoutMs,

      DEFAULT_CANDLE_FETCH_TIMEOUT_MS,

      100
    );

  /*
   * Beide prijsbronnen blijven aan.
   * Ze draaien parallel in plaats van achter elkaar.
   */
  const externalPromise =
    withTimeout(
      Promise
        .resolve(
          priceFetcher(
            position
              .contractSymbol ||
            position
              .symbol
          )
        )
        .catch(
          () =>
            0
        ),

      priceTimeoutMs,

      'POSITION_PRICE_FETCH_TIMEOUT',

      0
    );

  const candlePromise =
    cfg
      .monitorCandleRangeEnabled
      ? withTimeout(
          fetchBitgetCandleRange(
            position,

            timestamp,

            runtimeOptions
          ),

          candleTimeoutMs,

          'BITGET_CANDLE_RANGE_TIMEOUT',

          normalizePriceProbe(
            null,

            'BITGET_CANDLE_RANGE_TIMEOUT'
          )
        )
      : Promise.resolve(
          null
        );

  const [
    externalRaw,
    candleProbe
  ] =
    await Promise.all([
      externalPromise,
      candlePromise
    ]);

  const externalProbe =
    normalizePriceProbe(
      externalRaw,

      'EXTERNAL_PRICE_FETCHER'
    );

  if (
    !cfg
      .monitorCandleRangeEnabled
  ) {
    return externalProbe;
  }

  const freshPosition =
    isFreshPositionForCandleRange(
      position,

      timestamp,

      runtimeOptions
    );

  if (
    freshPosition
  ) {
    const last =
      safeNumber(
        externalProbe.last ||
        candleProbe?.last,

        0
      );

    return {
      ok:
        last >
        0,

      last,

      high:
        last,

      low:
        last,

      source:
        externalProbe.ok
          ? `FRESH_POSITION_LAST_ONLY_${externalProbe.source}`
          : candleProbe?.ok
            ? 'FRESH_POSITION_LAST_ONLY_BITGET_CANDLE_CLOSE'
            : candleProbe
                ?.source ||
              'FRESH_POSITION_NO_PRICE',

      firstTouch:
        null,

      rangeStart:
        candleProbe
          ?.rangeStart ||
        null,

      rangeEnd:
        candleProbe
          ?.rangeEnd ||
        null,

      candles:
        candleProbe
          ?.candles ||
        0,

      externalLast:
        externalProbe
          .last ||
        null,

      externalSource:
        externalProbe
          .source ||
        null,

      candleRangeFreshPositionSuppressed:
        true,

      candleRangeSuppressedReason:
        'AVOID_PRE_ENTRY_1M_CANDLE_CONTAMINATION',

      candleRangeFailed:
        !candleProbe?.ok,

      candleRangeFailureReason:
        candleProbe?.ok
          ? null
          : candleProbe
              ?.source ||
            null,

      candleRangeError:
        candleProbe
          ?.error ||
        null,

      candlesExcludedBeforeOpen:
        candleProbe
          ?.candlesExcludedBeforeOpen ||
        0,

      firstFullCandleTs:
        candleProbe
          ?.firstFullCandleTs ||
        null
    };
  }

  if (
    candleProbe?.ok
  ) {
    return {
      ...candleProbe,

      externalLast:
        externalProbe
          .last ||
        null,

      externalSource:
        externalProbe
          .source ||
        null
    };
  }

  return {
    ...externalProbe,

    source:
      externalProbe.ok
        ? `FALLBACK_${externalProbe.source}`
        : candleProbe
            ?.source ||
          externalProbe
            .source ||
          'NO_PRICE',

    candleRangeFailed:
      true,

    candleRangeFailureReason:
      candleProbe
        ?.source ||
      null,

    candleRangeError:
      candleProbe
        ?.error ||
      null,

    candlesExcludedBeforeOpen:
      candleProbe
        ?.candlesExcludedBeforeOpen ||
      0,

    firstFullCandleTs:
      candleProbe
        ?.firstFullCandleTs ||
      null
  };
}

/*
 * In closePosition() moet deleteOpenPosition() zo worden aangeroepen:
 *
 * await deleteOpenPosition(
 *   closedPosition.symbol ||
 *   closedPosition.contractSymbol,
 *   options
 * )
 */

/*
 * In monitorOnePosition() moet saveOpenPosition() zo worden aangeroepen:
 *
 * await saveOpenPosition(
 *   position,
 *   {
 *     ...options,
 *     skipExistingRead: true,
 *     deadlineAt: options.deadlineAt
 *   }
 * )
 */

/*
 * Vervang monitorOpenPositions() volledig door onderstaande versie.
 */

export async function monitorOpenPositions(
  options = {}
) {
  const {
    priceFetcher
  } = options;

  if (
    typeof priceFetcher !==
    'function'
  ) {
    throw new Error(
      'PRICE_FETCHER_REQUIRED'
    );
  }

  const cfg =
    tradeConfig(
      options
    );

  const startedAt =
    now();

  const timestamp =
    startedAt;

  const deadlineAt =
    resolveRuntimeDeadlineAt(
      options,

      cfg.monitorRuntimeMs
    );

  const runtimeOptions = {
    ...options,

    deadlineAt,

    __tradeConfig:
      cfg,

    maxRuntimeMs:
      cfg
        .monitorRuntimeMs,

    monitorTimeoutMs:
      cfg
        .monitorRuntimeMs,

    recordOutcomeTimeoutMs:
      Math.min(
        cfg
          .recordOutcomeTimeoutMs,

        Math.max(
          250,

          Math.floor(
            cfg
              .monitorRuntimeMs *
              0.48
          )
        )
      ),

    discordExitTimeoutMs:
      Math.min(
        cfg
          .discordExitTimeoutMs,

        Math.max(
          100,

          Math.floor(
            cfg
              .monitorRuntimeMs *
              0.20
          )
        )
      ),

    openPositionWriteTimeoutMs:
      Math.min(
        DEFAULT_OPEN_POSITION_WRITE_TIMEOUT_MS,

        Math.max(
          150,

          Math.floor(
            cfg
              .monitorRuntimeMs *
              0.30
          )
        )
      ),

    openPositionDeleteTimeoutMs:
      Math.min(
        DEFAULT_OPEN_POSITION_DELETE_TIMEOUT_MS,

        Math.max(
          100,

          Math.floor(
            cfg
              .monitorRuntimeMs *
              0.22
          )
        )
      )
  };

  const suppliedPositions =
    Array.isArray(
      options
        .preloadedPositions
    )
      ? options
          .preloadedPositions
      : Array.isArray(
          options
            .openPositions
        )
        ? options
            .openPositions
        : Array.isArray(
            options
              .preloadedOpenPositions
          )
          ? options
              .preloadedOpenPositions
          : null;

  let openPositions =
    suppliedPositions;

  if (
    !openPositions
  ) {
    openPositions =
      await getOpenPositions({
        ...runtimeOptions,

        requireFullRows:
          true,

        includeKeyOnly:
          false,

        monitorMode:
          true,

        limit:
          Math.min(
            cfg
              .openPositionScanLimit,

            Math.max(
              cfg
                .monitorPositionLimit,

              cfg
                .monitorBatchSize *
                3
            )
          ),

        hydrateLimit:
          Math.min(
            cfg
              .hydrateLimit,

            Math.max(
              cfg
                .monitorPositionLimit,

              cfg
                .monitorBatchSize *
                3
            )
          )
      });
  }

  const sourceRows =
    Array.isArray(
      openPositions
    )
      ? openPositions
      : [];

  if (
    !sourceRows.length
  ) {
    console.log(
      JSON.stringify({
        event:
          'SHORT_POSITION_MONITOR_EMPTY',

        version:
          POSITION_ENGINE_RUNTIME_VERSION,

        runtimeMs:
          elapsedMs(
            startedAt
          )
      })
    );

    return [];
  }

  const validationLimit =
    Math.min(
      sourceRows.length,

      Math.max(
        24,

        cfg
          .monitorBatchSize *
          8,

        cfg
          .monitorPositionLimit *
          2
      )
    );

  const validationStart =
    sourceRows.length >
      validationLimit
      ? (
          Math.floor(
            timestamp /
            (
              2 *
              60 *
              1000
            )
          ) *
          validationLimit
        ) %
        sourceRows.length
      : 0;

  const candidateRows = [];

  for (
    let offset = 0;

    offset <
    validationLimit;

    offset += 1
  ) {
    if (
      deadlineExceeded(
        deadlineAt,
        250
      )
    ) {
      break;
    }

    const index =
      (
        validationStart +
        offset
      ) %
      sourceRows.length;

    const row =
      sourceRows[
        index
      ];

    if (
      row
        ?.openPositionKeyOnly ===
      true
    ) {
      continue;
    }

    if (
      !isCleanMicroMicroRow(
        row
      )
    ) {
      continue;
    }

    candidateRows.push(
      forceShortPositionFields(
        preserveLockedEntryWeather(
          row,
          row
        )
      )
    );
  }

  if (
    !candidateRows.length
  ) {
    console.log(
      JSON.stringify({
        event:
          'SHORT_POSITION_MONITOR_NO_CLEAN_ROWS',

        version:
          POSITION_ENGINE_RUNTIME_VERSION,

        supplied:
          sourceRows.length,

        checked:
          validationLimit,

        runtimeMs:
          elapsedMs(
            startedAt
          )
      })
    );

    return [];
  }

  const expired = [];

  const fresh = [];

  for (
    const position
    of candidateRows
  ) {
    if (
      isTimeStopExpired(
        position,

        timestamp,

        runtimeOptions
      )
    ) {
      expired.push(
        position
      );
    } else {
      fresh.push(
        position
      );
    }
  }

  expired.sort(
    sortOpenPositions
  );

  fresh.sort(
    sortOpenPositions
  );

  const freshStart =
    fresh.length >
      0
      ? (
          Math.floor(
            timestamp /
            (
              2 *
              60 *
              1000
            )
          ) %
          fresh.length
        )
      : 0;

  const rotatedFresh =
    fresh.length >
      0
      ? [
          ...fresh.slice(
            freshStart
          ),

          ...fresh.slice(
            0,
            freshStart
          )
        ]
      : [];

  /*
   * Verlopen posities altijd eerst.
   * Daarna een roterende selectie verse posities.
   */
  const positions = [
    ...expired,
    ...rotatedFresh
  ]
    .slice(
      0,

      Math.min(
        cfg
          .monitorPositionLimit,

        cfg
          .monitorBatchSize
      )
    );

  const results = [];

  let cursor =
    0;

  const workerCount =
    Math.max(
      1,

      Math.min(
        cfg
          .dataConcurrency,

        DEFAULT_MONITOR_CONCURRENCY,

        positions.length
      )
    );

  const workers =
    Array
      .from(
        {
          length:
            workerCount
        },

        async () => {
          while (
            cursor <
            positions.length
          ) {
            if (
              deadlineExceeded(
                deadlineAt,
                DEFAULT_MONITOR_CLOSE_RESERVE_MS
              )
            ) {
              return;
            }

            const index =
              cursor++;

            const position =
              positions[
                index
              ];

            /*
             * Geen buitenste Promise.race meer.
             *
             * De interne Redis- en netwerkhandelingen hebben ieder
             * hun eigen harde timeout. Hierdoor blijft geen volledige
             * monitorworker op de achtergrond doorwerken.
             */
            const result =
              await monitorOnePosition({
                position,

                priceFetcher,

                timestamp,

                startedAt,

                options:
                  runtimeOptions
              });

            results.push(
              result
            );
          }
        }
      );

  await Promise.all(
    workers
  );

  const exits =
    results
      .filter(
        (row) =>
          row
            ?.type ===
            'EXIT' &&
          row.outcome
      )
      .map(
        (row) =>
          row.outcome
      );

  console.log(
    JSON.stringify({
      event:
        'SHORT_POSITION_MONITOR_DONE',

      version:
        POSITION_ENGINE_RUNTIME_VERSION,

      supplied:
        sourceRows.length,

      validated:
        candidateRows.length,

      selected:
        positions.length,

      expiredSelected:
        positions
          .filter(
            (row) =>
              isTimeStopExpired(
                row,

                timestamp,

                runtimeOptions
              )
          )
          .length,

      processed:
        results.length,

      exits:
        exits.length,

      runtimeMs:
        elapsedMs(
          startedAt
        ),

      runtimeBudgetMs:
        cfg
          .monitorRuntimeMs,

      minimumSafeMonitorRuntimeDiagnosticMs:
        cfg
          .minimumSafeMonitorRuntimeMs,

      deadlineReached:
        deadlineExceeded(
          deadlineAt,
          0
        ),

      allMonitoringFeaturesEnabled:
        true,

      priceFetcherEnabled:
        true,

      bitgetCandleRangeEnabled:
        cfg
          .monitorCandleRangeEnabled,

      learningEnabled:
        true,

      discordExitEnabled:
        true
    })
  );

  return exits;
}

// ===== TOEGEVOEGD: export van de versievariabele =====
export const positionEngineBindingFixVersion =
  POSITION_ENGINE_BINDING_FIX_VERSION;