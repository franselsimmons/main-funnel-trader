// ================= FILE: src/market/marketKey.js =================

export const MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1';
export const MARKET_WEATHER_CONFIRMATION_VERSION = 'SHORT_MARKET_WEATHER_CONFIRMATION_3_OF_5_V1';
export const MARKET_WEATHER_PLAYBOOK_REFRESH_VERSION = 'SHORT_PLAYBOOK_REFRESH_ON_CONFIRMED_WEATHER_CHANGE_V1';

export const UNKNOWN_MARKET_WEATHER_VALUE = 'UNKNOWN';
export const UNKNOWN_MARKET_WEATHER_KEY = 'UNKNOWN|UNKNOWN';

export const DEFAULT_MARKET_WEATHER_SAMPLE_INTERVAL_MIN = 5;
export const DEFAULT_WEATHER_CONFIRMATION_REQUIRED = 3;
export const DEFAULT_WEATHER_CONFIRMATION_WINDOW_SAMPLES = 5;
export const DEFAULT_CONFIRMED_MARKET_WEATHER_MIN_HOLD_MIN = 90;
export const DEFAULT_PLAYBOOK_MAX_AGE_MIN = 240;

// Backward-compatible named exports expected by tradeSystem.js / weeklyCandidates.js.
export const PLAYBOOK_MAX_AGE_MIN = DEFAULT_PLAYBOOK_MAX_AGE_MIN;
export const PLAYBOOK_MAX_AGE_MS = PLAYBOOK_MAX_AGE_MIN * 60 * 1000;

const REGIME_SQUEEZE = 'SQUEEZE';
const REGIME_CHOP = 'CHOP';
const REGIME_TREND = 'TREND';
const REGIME_UNKNOWN = UNKNOWN_MARKET_WEATHER_VALUE;

const TREND_SIDE_BEARISH = 'BEARISH';
const TREND_SIDE_BULLISH = 'BULLISH';
const TREND_SIDE_NEUTRAL = 'NEUTRAL';
const TREND_SIDE_UNKNOWN = UNKNOWN_MARKET_WEATHER_VALUE;

const RAW_FIELD_ALLOWLIST = [
  'regime',
  'trendSide',
  'marketWeatherRegime',
  'marketWeatherTrendSide',
  'currentMarketWeatherRegime',
  'currentMarketWeatherTrendSide',
  'confirmedMarketWeatherRegime',
  'confirmedMarketWeatherTrendSide',
  'currentRegime',
  'currentTrendSide',
  'confirmedRegime',
  'confirmedTrendSide',

  'marketWeatherKey',
  'currentMarketWeatherKey',
  'confirmedMarketWeatherKey',
  'entryMarketWeatherKey',

  'bullishPct',
  'bearishPct',
  'neutralPct',
  'squeezePct',
  'chopPct',
  'trendPct',
  'confidence',

  'btcState',
  'btcGate',
  'btcTrend',
  'btcChange1m',
  'btcChange5m',
  'btcChange15m',
  'btcChange1h',
  'btcChange4h',
  'btcChange24h',

  'volatilityBucket',
  'breadthBucket',
  'marketBreadth',
  'atrPct',
  'atrPct15m',
  'atrPct1h',
  'atrPct4h',

  'snapshotId',
  'source',
  'createdAt',
  'updatedAt',
  'capturedAt',
  'completedAt'
];

function nowMs() {
  return Date.now();
}

function safeString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeUpperToken(value, fallback = UNKNOWN_MARKET_WEATHER_VALUE) {
  const raw = safeString(value, '');
  if (!raw) return fallback;

  const token = raw
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return token || fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return undefined;
}

function hasUsableValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function msFromMinutes(minutes) {
  const n = safeNumber(minutes, 0);
  return Math.max(0, n) * 60 * 1000;
}

function minutesBetween(fromMs, toMs = nowMs()) {
  const a = safeNumber(fromMs, null);
  const b = safeNumber(toMs, null);

  if (a === null || b === null) return null;

  return Math.max(0, (b - a) / 60000);
}

function normalizeTimestampMs(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 9999999999) return Math.round(value * 1000);
    return Math.round(value);
  }

  const parsedNumber = Number(value);
  if (Number.isFinite(parsedNumber)) {
    if (parsedNumber > 0 && parsedNumber < 9999999999) return Math.round(parsedNumber * 1000);
    return Math.round(parsedNumber);
  }

  const parsedDate = Date.parse(String(value));
  if (Number.isFinite(parsedDate)) return parsedDate;

  return fallback;
}

function compactObject(obj = {}) {
  const out = {};

  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }

  return out;
}

function pickRawFields(source = {}) {
  const raw = {};
  const available = [];

  for (const key of RAW_FIELD_ALLOWLIST) {
    if (source[key] === undefined || source[key] === null || source[key] === '') continue;

    const value = source[key];
    raw[key] = typeof value === 'number' ? safeNumber(value) : value;
    available.push(key);
  }

  return {
    raw,
    available
  };
}

export function normalizeMarketWeatherRegime(value) {
  const raw = safeUpperToken(value);

  if (raw === UNKNOWN_MARKET_WEATHER_VALUE) return REGIME_UNKNOWN;

  if (
    raw.includes('SQUEEZE') ||
    raw.includes('COMPRESS') ||
    raw.includes('COMPRESSION') ||
    raw.includes('COIL') ||
    raw.includes('TIGHT') ||
    raw.includes('LOW_VOL')
  ) {
    return REGIME_SQUEEZE;
  }

  if (
    raw.includes('CHOP') ||
    raw.includes('RANGE') ||
    raw.includes('SIDEWAYS') ||
    raw.includes('MIXED') ||
    raw.includes('ROTATION') ||
    raw.includes('MEAN_REVERT')
  ) {
    return REGIME_CHOP;
  }

  if (
    raw.includes('TREND') ||
    raw.includes('FLOW') ||
    raw.includes('MOMENTUM') ||
    raw.includes('IMPULSE') ||
    raw.includes('EXPANSION') ||
    raw.includes('BREAKOUT')
  ) {
    return REGIME_TREND;
  }

  return raw || REGIME_UNKNOWN;
}

export function normalizeMarketWeatherTrendSide(value) {
  const raw = safeUpperToken(value);

  if (raw === UNKNOWN_MARKET_WEATHER_VALUE) return TREND_SIDE_UNKNOWN;

  if (
    raw.includes('BEAR') ||
    raw.includes('SHORT') ||
    raw.includes('DOWN') ||
    raw.includes('RED') ||
    raw.includes('SELL') ||
    raw.includes('RISK_OFF')
  ) {
    return TREND_SIDE_BEARISH;
  }

  if (
    raw.includes('BULL') ||
    raw.includes('LONG') ||
    raw.includes('UP') ||
    raw.includes('GREEN') ||
    raw.includes('BUY') ||
    raw.includes('RISK_ON')
  ) {
    return TREND_SIDE_BULLISH;
  }

  if (
    raw.includes('NEUTRAL') ||
    raw.includes('FLAT') ||
    raw.includes('BALANCED') ||
    raw.includes('NONE') ||
    raw.includes('SIDEWAYS') ||
    raw.includes('MIXED')
  ) {
    return TREND_SIDE_NEUTRAL;
  }

  return raw || TREND_SIDE_UNKNOWN;
}

export function buildEntryMarketWeatherKey(regime, trendSide) {
  const normalizedRegime = normalizeMarketWeatherRegime(regime);
  const normalizedTrendSide = normalizeMarketWeatherTrendSide(trendSide);

  return `${normalizedRegime}|${normalizedTrendSide}`;
}

export function parseMarketWeatherKey(key) {
  const raw = safeString(key, '');
  const parts = raw.split('|').map((x) => safeString(x));

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return {
      valid: false,
      key: UNKNOWN_MARKET_WEATHER_KEY,
      regime: REGIME_UNKNOWN,
      trendSide: TREND_SIDE_UNKNOWN
    };
  }

  const regime = normalizeMarketWeatherRegime(parts[0]);
  const trendSide = normalizeMarketWeatherTrendSide(parts[1]);
  const normalizedKey = buildEntryMarketWeatherKey(regime, trendSide);

  return {
    valid: normalizedKey !== UNKNOWN_MARKET_WEATHER_KEY,
    key: normalizedKey,
    regime,
    trendSide
  };
}

export function isUnknownMarketWeatherKey(key) {
  const parsed = parseMarketWeatherKey(key);
  return parsed.key === UNKNOWN_MARKET_WEATHER_KEY;
}

export function isValidMarketWeatherKey(key, { allowUnknown = false } = {}) {
  const parsed = parseMarketWeatherKey(key);
  if (allowUnknown) return Boolean(parsed.key);
  return parsed.valid && parsed.key !== UNKNOWN_MARKET_WEATHER_KEY;
}

export function extractMarketWeatherInput(input = {}) {
  const source =
    input.marketWeather ||
    input.marketWeatherContext ||
    input.weather ||
    input.market ||
    input;

  const scannerRow =
    input.scannerRow ||
    input.row ||
    input.candidate ||
    input.tradeCandidate ||
    {};

  const merged = {
    ...scannerRow,
    ...source,
    ...input
  };

  const explicitKey = firstDefined(
    merged.entryMarketWeatherKey,
    merged.confirmedMarketWeatherKey,
    merged.currentMarketWeatherKey,
    merged.marketWeatherKey
  );

  const parsedKey = parseMarketWeatherKey(explicitKey);

  const regime = parsedKey.valid
    ? parsedKey.regime
    : normalizeMarketWeatherRegime(firstDefined(
        merged.entryMarketWeatherRegime,
        merged.confirmedMarketWeatherRegime,
        merged.currentMarketWeatherRegime,
        merged.marketWeatherRegime,
        merged.confirmedRegime,
        merged.currentRegime,
        merged.regime
      ));

  const trendSide = parsedKey.valid
    ? parsedKey.trendSide
    : normalizeMarketWeatherTrendSide(firstDefined(
        merged.entryMarketWeatherTrendSide,
        merged.confirmedMarketWeatherTrendSide,
        merged.currentMarketWeatherTrendSide,
        merged.marketWeatherTrendSide,
        merged.confirmedTrendSide,
        merged.currentTrendSide,
        merged.trendSide
      ));

  return compactObject({
    ...merged,
    marketWeatherRegime: regime,
    marketWeatherTrendSide: trendSide,
    marketWeatherKey: buildEntryMarketWeatherKey(regime, trendSide)
  });
}

export function buildEntryMarketWeatherSnapshot(input = {}, capturedAt = nowMs()) {
  const weatherInput = extractMarketWeatherInput(input);

  const entryMarketWeatherRegime = normalizeMarketWeatherRegime(
    weatherInput.marketWeatherRegime
  );

  const entryMarketWeatherTrendSide = normalizeMarketWeatherTrendSide(
    weatherInput.marketWeatherTrendSide
  );

  const entryMarketWeatherKey = buildEntryMarketWeatherKey(
    entryMarketWeatherRegime,
    entryMarketWeatherTrendSide
  );

  const { raw, available } = pickRawFields({
    ...weatherInput,
    entryMarketWeatherKey,
    entryMarketWeatherRegime,
    entryMarketWeatherTrendSide
  });

  const capturedAtMs = normalizeTimestampMs(capturedAt, nowMs());

  return {
    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    entryMarketWeatherKey,
    entryMarketWeatherRegime,
    entryMarketWeatherTrendSide,
    entryMarketWeatherCapturedAt: capturedAtMs,
    entryMarketWeatherRaw: raw,
    entryMarketWeatherRawAvailableFields: available,

    entryMarketWeatherResolutionKeys: {
      lifetime: 'LIFETIME',
      regime: entryMarketWeatherRegime,
      regimeTrend: entryMarketWeatherKey,
      fullV1: entryMarketWeatherKey
    },

    entryMarketWeatherSnapshotLocked: true,
    entryMarketWeatherIsUnknown: entryMarketWeatherKey === UNKNOWN_MARKET_WEATHER_KEY
  };
}

export function attachEntryMarketWeatherSnapshot(target = {}, input = {}, capturedAt = nowMs()) {
  const hasExistingEntryKey = hasUsableValue(target.entryMarketWeatherKey);
  const existing = parseMarketWeatherKey(target.entryMarketWeatherKey);

  if (hasExistingEntryKey && target.entryMarketWeatherSnapshotLocked) {
    return {
      ...target,
      entryMarketWeatherKeyVersion: target.entryMarketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
      entryMarketWeatherKey: existing.key,
      entryMarketWeatherRegime: existing.regime,
      entryMarketWeatherTrendSide: existing.trendSide,
      entryMarketWeatherCapturedAt: normalizeTimestampMs(
        target.entryMarketWeatherCapturedAt,
        normalizeTimestampMs(capturedAt, nowMs())
      ),
      entryMarketWeatherRaw: target.entryMarketWeatherRaw || {},
      entryMarketWeatherRawAvailableFields: target.entryMarketWeatherRawAvailableFields || [],
      entryMarketWeatherResolutionKeys: target.entryMarketWeatherResolutionKeys || {
        lifetime: 'LIFETIME',
        regime: existing.regime,
        regimeTrend: existing.key,
        fullV1: existing.key
      },
      entryMarketWeatherSnapshotLocked: true,
      entryMarketWeatherIsUnknown: existing.key === UNKNOWN_MARKET_WEATHER_KEY
    };
  }

  if (hasExistingEntryKey && (existing.valid || existing.key === UNKNOWN_MARKET_WEATHER_KEY)) {
    return {
      ...target,
      entryMarketWeatherKeyVersion: target.entryMarketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
      entryMarketWeatherKey: existing.key,
      entryMarketWeatherRegime: existing.regime,
      entryMarketWeatherTrendSide: existing.trendSide,
      entryMarketWeatherCapturedAt: target.entryMarketWeatherCapturedAt || normalizeTimestampMs(capturedAt, nowMs()),
      entryMarketWeatherRaw: target.entryMarketWeatherRaw || {},
      entryMarketWeatherRawAvailableFields: target.entryMarketWeatherRawAvailableFields || [],
      entryMarketWeatherResolutionKeys: target.entryMarketWeatherResolutionKeys || {
        lifetime: 'LIFETIME',
        regime: existing.regime,
        regimeTrend: existing.key,
        fullV1: existing.key
      },
      entryMarketWeatherSnapshotLocked: true,
      entryMarketWeatherIsUnknown: existing.key === UNKNOWN_MARKET_WEATHER_KEY
    };
  }

  return {
    ...target,
    ...buildEntryMarketWeatherSnapshot(input, capturedAt)
  };
}

export function preserveEntryMarketWeatherSnapshot(position = {}, fallbackInput = {}) {
  const hasExistingEntryKey = hasUsableValue(position.entryMarketWeatherKey);
  const existing = parseMarketWeatherKey(position.entryMarketWeatherKey);

  if (hasExistingEntryKey && (existing.valid || existing.key === UNKNOWN_MARKET_WEATHER_KEY)) {
    return {
      entryMarketWeatherKeyVersion: position.entryMarketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
      entryMarketWeatherKey: existing.key,
      entryMarketWeatherRegime: existing.regime,
      entryMarketWeatherTrendSide: existing.trendSide,
      entryMarketWeatherCapturedAt: normalizeTimestampMs(
        position.entryMarketWeatherCapturedAt,
        nowMs()
      ),
      entryMarketWeatherRaw: position.entryMarketWeatherRaw || {},
      entryMarketWeatherRawAvailableFields: position.entryMarketWeatherRawAvailableFields || [],
      entryMarketWeatherResolutionKeys: position.entryMarketWeatherResolutionKeys || {
        lifetime: 'LIFETIME',
        regime: existing.regime,
        regimeTrend: existing.key,
        fullV1: existing.key
      },
      entryMarketWeatherSnapshotLocked: true,
      entryMarketWeatherIsUnknown: existing.key === UNKNOWN_MARKET_WEATHER_KEY
    };
  }

  return buildEntryMarketWeatherSnapshot(fallbackInput, nowMs());
}

export function marketWeatherResolutionKeysFromSnapshot(snapshot = {}) {
  const parsed = parseMarketWeatherKey(snapshot.entryMarketWeatherKey);

  return {
    lifetime: 'LIFETIME',
    regime: parsed.regime,
    regimeTrend: parsed.key,
    fullV1: parsed.key
  };
}

export function currentMarketWeatherFromInput(input = {}) {
  const weatherInput = extractMarketWeatherInput(input);

  const currentMarketWeatherKey = buildEntryMarketWeatherKey(
    weatherInput.marketWeatherRegime,
    weatherInput.marketWeatherTrendSide
  );

  const parsed = parseMarketWeatherKey(currentMarketWeatherKey);

  return {
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherKey: parsed.key,
    currentMarketWeatherRegime: parsed.regime,
    currentMarketWeatherTrendSide: parsed.trendSide,
    currentMarketWeatherIsUnknown: parsed.key === UNKNOWN_MARKET_WEATHER_KEY
  };
}

export function confirmedMarketWeatherFromInput(input = {}) {
  const source =
    input.confirmedMarketWeather ||
    input.marketWeather ||
    input.marketWeatherContext ||
    input.weather ||
    input;

  const explicitKey = firstDefined(
    source.confirmedMarketWeatherKey,
    source.currentMarketWeatherKey,
    source.marketWeatherKey,
    input.confirmedMarketWeatherKey,
    input.currentMarketWeatherKey,
    input.marketWeatherKey
  );

  const parsedExplicit = parseMarketWeatherKey(explicitKey);

  if (hasUsableValue(explicitKey) && (parsedExplicit.valid || parsedExplicit.key === UNKNOWN_MARKET_WEATHER_KEY)) {
    return {
      confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
      confirmedMarketWeatherKey: parsedExplicit.key,
      confirmedMarketWeatherRegime: parsedExplicit.regime,
      confirmedMarketWeatherTrendSide: parsedExplicit.trendSide,
      confirmedMarketWeatherIsUnknown: parsedExplicit.key === UNKNOWN_MARKET_WEATHER_KEY,
      confirmedMarketWeatherAt: normalizeTimestampMs(
        firstDefined(source.confirmedMarketWeatherAt, source.capturedAt, input.confirmedMarketWeatherAt),
        nowMs()
      )
    };
  }

  const regime = normalizeMarketWeatherRegime(firstDefined(
    source.confirmedMarketWeatherRegime,
    source.currentMarketWeatherRegime,
    source.marketWeatherRegime,
    source.confirmedRegime,
    source.currentRegime,
    source.regime,
    input.confirmedMarketWeatherRegime,
    input.currentMarketWeatherRegime,
    input.marketWeatherRegime
  ));

  const trendSide = normalizeMarketWeatherTrendSide(firstDefined(
    source.confirmedMarketWeatherTrendSide,
    source.currentMarketWeatherTrendSide,
    source.marketWeatherTrendSide,
    source.confirmedTrendSide,
    source.currentTrendSide,
    source.trendSide,
    input.confirmedMarketWeatherTrendSide,
    input.currentMarketWeatherTrendSide,
    input.marketWeatherTrendSide
  ));

  const key = buildEntryMarketWeatherKey(regime, trendSide);

  return {
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKey: key,
    confirmedMarketWeatherRegime: regime,
    confirmedMarketWeatherTrendSide: trendSide,
    confirmedMarketWeatherIsUnknown: key === UNKNOWN_MARKET_WEATHER_KEY,
    confirmedMarketWeatherAt: normalizeTimestampMs(
      firstDefined(source.confirmedMarketWeatherAt, source.capturedAt, input.confirmedMarketWeatherAt),
      nowMs()
    )
  };
}

export function buildMarketWeatherSample(input = {}, sampledAt = nowMs()) {
  const current = currentMarketWeatherFromInput(input);
  const sampledAtMs = normalizeTimestampMs(sampledAt, nowMs());

  return {
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherKey: current.currentMarketWeatherKey,
    marketWeatherRegime: current.currentMarketWeatherRegime,
    marketWeatherTrendSide: current.currentMarketWeatherTrendSide,
    marketWeatherIsUnknown: current.currentMarketWeatherIsUnknown,
    sampledAt: sampledAtMs
  };
}

export function normalizeMarketWeatherSamples(samples = []) {
  if (!Array.isArray(samples)) return [];

  return samples
    .map((sample) => {
      if (!sample) return null;

      if (typeof sample === 'string') {
        const parsed = parseMarketWeatherKey(sample);
        return {
          marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
          marketWeatherKey: parsed.key,
          marketWeatherRegime: parsed.regime,
          marketWeatherTrendSide: parsed.trendSide,
          marketWeatherIsUnknown: parsed.key === UNKNOWN_MARKET_WEATHER_KEY,
          sampledAt: nowMs()
        };
      }

      const explicitKey = firstDefined(
        sample.marketWeatherKey,
        sample.currentMarketWeatherKey,
        sample.confirmedMarketWeatherKey,
        sample.entryMarketWeatherKey
      );

      const parsed = parseMarketWeatherKey(explicitKey);

      if (hasUsableValue(explicitKey) && (parsed.valid || parsed.key === UNKNOWN_MARKET_WEATHER_KEY)) {
        return {
          marketWeatherKeyVersion: sample.marketWeatherKeyVersion || MARKET_WEATHER_KEY_VERSION,
          marketWeatherKey: parsed.key,
          marketWeatherRegime: parsed.regime,
          marketWeatherTrendSide: parsed.trendSide,
          marketWeatherIsUnknown: parsed.key === UNKNOWN_MARKET_WEATHER_KEY,
          sampledAt: normalizeTimestampMs(sample.sampledAt || sample.capturedAt || sample.createdAt, nowMs())
        };
      }

      return buildMarketWeatherSample(sample, sample.sampledAt || sample.capturedAt || nowMs());
    })
    .filter(Boolean)
    .sort((a, b) => safeNumber(a.sampledAt, 0) - safeNumber(b.sampledAt, 0));
}

export function confirmMarketWeatherKey(samples = [], options = {}) {
  const required = Math.max(
    1,
    Math.floor(safeNumber(options.required, DEFAULT_WEATHER_CONFIRMATION_REQUIRED))
  );

  const windowSamples = Math.max(
    required,
    Math.floor(safeNumber(options.windowSamples, DEFAULT_WEATHER_CONFIRMATION_WINDOW_SAMPLES))
  );

  const sampleIntervalMin = Math.max(
    1,
    safeNumber(options.sampleIntervalMin, DEFAULT_MARKET_WEATHER_SAMPLE_INTERVAL_MIN)
  );

  const previousConfirmedKey = firstDefined(
    options.previousConfirmedMarketWeatherKey,
    options.previousConfirmedKey
  );

  const previousConfirmedAt = normalizeTimestampMs(
    firstDefined(options.previousConfirmedMarketWeatherAt, options.previousConfirmedAt),
    null
  );

  const minHoldMin = Math.max(
    0,
    safeNumber(options.minHoldMin, DEFAULT_CONFIRMED_MARKET_WEATHER_MIN_HOLD_MIN)
  );

  const asOfMs = normalizeTimestampMs(options.asOf, nowMs());

  const normalized = normalizeMarketWeatherSamples(samples);
  const recent = normalized.slice(-windowSamples);

  const counts = new Map();

  for (const sample of recent) {
    const key = parseMarketWeatherKey(sample.marketWeatherKey).key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let winningKey = UNKNOWN_MARKET_WEATHER_KEY;
  let winningCount = 0;

  for (const [key, count] of counts.entries()) {
    if (count > winningCount) {
      winningKey = key;
      winningCount = count;
    }
  }

  const parsedWinning = parseMarketWeatherKey(winningKey);
  const enoughSamples = recent.length >= required;
  const confirmedBySamples = enoughSamples && winningCount >= required;
  const unknown = parsedWinning.key === UNKNOWN_MARKET_WEATHER_KEY;

  const previousParsed = parseMarketWeatherKey(previousConfirmedKey);
  const previousKey = previousParsed.key;
  const previousKnown = previousParsed.valid && previousKey !== UNKNOWN_MARKET_WEATHER_KEY;

  const holdAgeMin = previousConfirmedAt ? minutesBetween(previousConfirmedAt, asOfMs) : null;
  const holdSatisfied =
    !previousKnown ||
    previousKey === parsedWinning.key ||
    holdAgeMin === null ||
    holdAgeMin >= minHoldMin;

  const confirmed =
    confirmedBySamples &&
    !unknown &&
    holdSatisfied;

  const confirmedKey = confirmed
    ? parsedWinning.key
    : previousKnown
      ? previousKey
      : UNKNOWN_MARKET_WEATHER_KEY;

  const confirmedParsed = parseMarketWeatherKey(confirmedKey);

  const changed =
    confirmed &&
    previousKnown &&
    previousKey !== parsedWinning.key;

  const confirmationWindowMin = windowSamples * sampleIntervalMin;

  return {
    marketWeatherConfirmationVersion: MARKET_WEATHER_CONFIRMATION_VERSION,
    confirmed,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKey: confirmedParsed.key,
    confirmedMarketWeatherRegime: confirmedParsed.regime,
    confirmedMarketWeatherTrendSide: confirmedParsed.trendSide,
    confirmedMarketWeatherIsUnknown: confirmedParsed.key === UNKNOWN_MARKET_WEATHER_KEY,
    confirmedMarketWeatherAt: confirmed ? asOfMs : previousConfirmedAt || null,

    candidateMarketWeatherKey: parsedWinning.key,
    candidateMarketWeatherRegime: parsedWinning.regime,
    candidateMarketWeatherTrendSide: parsedWinning.trendSide,

    confirmedMarketWeatherChanged: Boolean(changed),
    forcePlaybookRefresh: Boolean(changed),

    required,
    windowSamples,
    sampleIntervalMin,
    confirmationWindowMin,
    recentSamples: recent,
    sampleCounts: Object.fromEntries(counts.entries()),
    winningCount,
    enoughSamples,
    holdSatisfied,
    holdAgeMin,
    minHoldMin,

    reason: !confirmedBySamples
      ? 'WEATHER_CONFIRMATION_NOT_ENOUGH_MATCHING_SAMPLES'
      : unknown
        ? 'WEATHER_CONFIRMATION_UNKNOWN_KEY'
        : !holdSatisfied
          ? 'WEATHER_CONFIRMATION_MIN_HOLD_NOT_SATISFIED'
          : 'WEATHER_CONFIRMED'
  };
}

export function isFreshConfirmedMarketWeather(confirmedWeather = {}, options = {}) {
  const maxAgeMin = Math.max(
    0,
    safeNumber(options.maxAgeMin, DEFAULT_CONFIRMED_MARKET_WEATHER_MIN_HOLD_MIN)
  );

  const asOfMs = normalizeTimestampMs(options.asOf, nowMs());

  const key = firstDefined(
    confirmedWeather.confirmedMarketWeatherKey,
    confirmedWeather.currentMarketWeatherKey,
    confirmedWeather.marketWeatherKey
  );

  const parsed = parseMarketWeatherKey(key);

  const confirmedAt = normalizeTimestampMs(
    firstDefined(
      confirmedWeather.confirmedMarketWeatherAt,
      confirmedWeather.confirmedAt,
      confirmedWeather.capturedAt,
      confirmedWeather.updatedAt
    ),
    null
  );

  const ageMin = confirmedAt === null ? null : minutesBetween(confirmedAt, asOfMs);

  const fresh =
    parsed.valid &&
    parsed.key !== UNKNOWN_MARKET_WEATHER_KEY &&
    ageMin !== null &&
    ageMin <= maxAgeMin;

  return {
    fresh,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKey: parsed.key,
    confirmedMarketWeatherRegime: parsed.regime,
    confirmedMarketWeatherTrendSide: parsed.trendSide,
    confirmedMarketWeatherIsUnknown: parsed.key === UNKNOWN_MARKET_WEATHER_KEY,
    confirmedMarketWeatherAt: confirmedAt,
    ageMin,
    maxAgeMin,
    reason: fresh
      ? 'CONFIRMED_MARKET_WEATHER_FRESH'
      : parsed.key === UNKNOWN_MARKET_WEATHER_KEY
        ? 'CONFIRMED_MARKET_WEATHER_UNKNOWN'
        : ageMin === null
          ? 'CONFIRMED_MARKET_WEATHER_MISSING_TIMESTAMP'
          : 'CONFIRMED_MARKET_WEATHER_STALE'
  };
}

export function isPlaybookFreshForConfirmedWeather(playbook = {}, confirmedWeather = {}, options = {}) {
  const maxAgeMin = Math.max(
    1,
    safeNumber(options.maxAgeMin, PLAYBOOK_MAX_AGE_MIN)
  );

  const asOfMs = normalizeTimestampMs(options.asOf, nowMs());

  const confirmed = confirmedMarketWeatherFromInput(confirmedWeather);

  const playbookKey = firstDefined(
    playbook.currentMarketWeatherKey,
    playbook.confirmedMarketWeatherKey,
    playbook.marketWeatherKey
  );

  const parsedPlaybookKey = parseMarketWeatherKey(playbookKey);

  const playbookAt = normalizeTimestampMs(
    firstDefined(
      playbook.playbookBuiltAt,
      playbook.builtAt,
      playbook.createdAt,
      playbook.updatedAt,
      playbook.rotationCreatedAt
    ),
    null
  );

  const ageMin = playbookAt === null ? null : minutesBetween(playbookAt, asOfMs);

  const weatherMatched =
    parsedPlaybookKey.valid &&
    parsedPlaybookKey.key === confirmed.confirmedMarketWeatherKey &&
    confirmed.confirmedMarketWeatherKey !== UNKNOWN_MARKET_WEATHER_KEY;

  const fresh =
    weatherMatched &&
    ageMin !== null &&
    ageMin <= maxAgeMin;

  return {
    marketWeatherPlaybookRefreshVersion: MARKET_WEATHER_PLAYBOOK_REFRESH_VERSION,
    fresh,
    weatherMatched,
    playbookMarketWeatherKey: parsedPlaybookKey.key,
    confirmedMarketWeatherKey: confirmed.confirmedMarketWeatherKey,
    playbookBuiltAt: playbookAt,
    ageMin,
    maxAgeMin,
    forceRefreshRequired: !fresh,
    reason: fresh
      ? 'PLAYBOOK_FRESH_FOR_CONFIRMED_WEATHER'
      : !weatherMatched
        ? 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER'
        : ageMin === null
          ? 'PLAYBOOK_MISSING_TIMESTAMP'
          : 'PLAYBOOK_STALE_FOR_CONFIRMED_WEATHER'
  };
}

export function shouldForcePlaybookRefreshOnWeatherChange(previousWeather = {}, nextWeather = {}) {
  const previous = confirmedMarketWeatherFromInput(previousWeather);
  const next = confirmedMarketWeatherFromInput(nextWeather);

  const changed =
    previous.confirmedMarketWeatherKey !== UNKNOWN_MARKET_WEATHER_KEY &&
    next.confirmedMarketWeatherKey !== UNKNOWN_MARKET_WEATHER_KEY &&
    previous.confirmedMarketWeatherKey !== next.confirmedMarketWeatherKey;

  return {
    marketWeatherPlaybookRefreshVersion: MARKET_WEATHER_PLAYBOOK_REFRESH_VERSION,
    forcePlaybookRefresh: Boolean(changed),
    previousMarketWeatherKey: previous.confirmedMarketWeatherKey,
    nextMarketWeatherKey: next.confirmedMarketWeatherKey,
    reason: changed
      ? 'CONFIRMED_MARKET_WEATHER_CHANGED_FORCE_PLAYBOOK_REFRESH'
      : 'CONFIRMED_MARKET_WEATHER_UNCHANGED'
  };
}

export function marketWeatherTradeReadinessGate(input = {}) {
  const key = firstDefined(
    input.currentMarketWeatherKey,
    input.confirmedMarketWeatherKey,
    input.entryMarketWeatherKey,
    input.marketWeatherKey
  );

  const parsed = parseMarketWeatherKey(key);

  const blocked = parsed.key === UNKNOWN_MARKET_WEATHER_KEY;

  return {
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherKey: parsed.key,
    marketWeatherRegime: parsed.regime,
    marketWeatherTrendSide: parsed.trendSide,
    marketWeatherUnknown: blocked,
    tradeReadyAllowedByMarketWeather: !blocked,
    reason: blocked
      ? 'MARKET_WEATHER_UNKNOWN'
      : 'MARKET_WEATHER_KNOWN'
  };
}

export function sameMarketWeatherKey(a, b) {
  return parseMarketWeatherKey(a).key === parseMarketWeatherKey(b).key;
}

export function marketWeatherMatchesEntry(entry = {}, current = {}) {
  const entryKey = firstDefined(entry.entryMarketWeatherKey, entry.marketWeatherKey);
  const currentKey = firstDefined(
    current.currentMarketWeatherKey,
    current.confirmedMarketWeatherKey,
    current.marketWeatherKey
  );

  const parsedEntry = parseMarketWeatherKey(entryKey);
  const parsedCurrent = parseMarketWeatherKey(currentKey);

  const matched =
    parsedEntry.valid &&
    parsedCurrent.valid &&
    parsedEntry.key === parsedCurrent.key;

  return {
    matched,
    entryMarketWeatherKey: parsedEntry.key,
    currentMarketWeatherKey: parsedCurrent.key,
    reason: matched
      ? 'ENTRY_WEATHER_MATCHES_CURRENT_WEATHER'
      : 'ENTRY_WEATHER_DOES_NOT_MATCH_CURRENT_WEATHER'
  };
}

export function marketWeatherFeatureFlags() {
  return {
    marketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    marketWeatherConfirmationVersion: MARKET_WEATHER_CONFIRMATION_VERSION,
    marketWeatherPlaybookRefreshVersion: MARKET_WEATHER_PLAYBOOK_REFRESH_VERSION,

    capture: 'live',
    aggregation: 'live',
    selector: 'observe',
    sizingCap: 'observe',
    fdr: 'observe',
    discordTradeReady: 'validated_only',

    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,
    playbookMaxAgeMs: PLAYBOOK_MAX_AGE_MS,
    forcePlaybookRefreshOnConfirmedWeatherChange: true,
    weatherConfirmationRequired: DEFAULT_WEATHER_CONFIRMATION_REQUIRED,
    weatherConfirmationWindowSamples: DEFAULT_WEATHER_CONFIRMATION_WINDOW_SAMPLES,
    weatherSampleIntervalMin: DEFAULT_MARKET_WEATHER_SAMPLE_INTERVAL_MIN,
    confirmedMarketWeatherMinHoldMin: DEFAULT_CONFIRMED_MARKET_WEATHER_MIN_HOLD_MIN
  };
}

export default {
  MARKET_WEATHER_KEY_VERSION,
  MARKET_WEATHER_CONFIRMATION_VERSION,
  MARKET_WEATHER_PLAYBOOK_REFRESH_VERSION,
  UNKNOWN_MARKET_WEATHER_VALUE,
  UNKNOWN_MARKET_WEATHER_KEY,

  DEFAULT_MARKET_WEATHER_SAMPLE_INTERVAL_MIN,
  DEFAULT_WEATHER_CONFIRMATION_REQUIRED,
  DEFAULT_WEATHER_CONFIRMATION_WINDOW_SAMPLES,
  DEFAULT_CONFIRMED_MARKET_WEATHER_MIN_HOLD_MIN,
  DEFAULT_PLAYBOOK_MAX_AGE_MIN,
  PLAYBOOK_MAX_AGE_MIN,
  PLAYBOOK_MAX_AGE_MS,

  normalizeMarketWeatherRegime,
  normalizeMarketWeatherTrendSide,
  buildEntryMarketWeatherKey,
  parseMarketWeatherKey,
  isUnknownMarketWeatherKey,
  isValidMarketWeatherKey,

  extractMarketWeatherInput,
  buildEntryMarketWeatherSnapshot,
  attachEntryMarketWeatherSnapshot,
  preserveEntryMarketWeatherSnapshot,
  marketWeatherResolutionKeysFromSnapshot,

  currentMarketWeatherFromInput,
  confirmedMarketWeatherFromInput,
  buildMarketWeatherSample,
  normalizeMarketWeatherSamples,
  confirmMarketWeatherKey,
  isFreshConfirmedMarketWeather,
  isPlaybookFreshForConfirmedWeather,
  shouldForcePlaybookRefreshOnWeatherChange,

  marketWeatherTradeReadinessGate,
  sameMarketWeatherKey,
  marketWeatherMatchesEntry,
  marketWeatherFeatureFlags
};