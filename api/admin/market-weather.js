// ================= FILE: api/admin/market-weather.js =================

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

const LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_X_CONFIRMATION_V1';
const PARENT_LEARNING_GRANULARITY = 'SHORT_FIXED_TAXONOMY_SETUP_X_REGIME_V1';

const MARKET_WEATHER_KEY_VERSION = 'SHORT_MARKET_WEATHER_KEY_V1';
const MARKET_WEATHER_CONFIRMATION_VERSION = 'SHORT_MARKET_WEATHER_CONFIRMATION_V1';
const MARKET_WEATHER_ADMIN_ROUTE_VERSION = 'SHORT_ADMIN_MARKET_WEATHER_SAFE_ROUTE_V2_KEY_AWARE';
const MARKET_WEATHER_FEATURE_FLAGS_VERSION = 'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V1_OBSERVE';

const PLAYBOOK_MAX_AGE_MIN = 240;
const WEATHER_CONFIRMATION_REQUIRED = 3;
const WEATHER_CONFIRMATION_WINDOW_SAMPLES = 5;

const MEASUREMENT_FIX_VERSION = 'SHORT_MEASUREMENT_FIX_AVGCOST_DIRECTSL_SEEN_DEDUPE_V1';

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Admin-Market-Weather-Version', MARKET_WEATHER_ADMIN_ROUTE_VERSION);
  res.setHeader('X-Market-Weather-Key-Version', MARKET_WEATHER_KEY_VERSION);
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Only', 'true');
  res.setHeader('X-Long-Disabled', 'true');
  res.setHeader('X-Persistent-Learning-Key', PERSISTENT_LEARNING_KEY);
  res.end(JSON.stringify(data, null, 2));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function bool(value, fallback = false) {
  if (!hasValue(value)) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const raw = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;

  return fallback;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }

  return null;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function clamp(value, min = 0, max = 100) {
  const n = num(value, min);

  if (n < min) return min;
  if (n > max) return max;

  return n;
}

function pct(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) <= 1) return Number((n * 100).toFixed(2));

  return Number(n.toFixed(2));
}

function signedPct(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) <= 1) return Number((n * 100).toFixed(4));

  return Number(n.toFixed(4));
}

function ageMin(ts, nowMs = Date.now()) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, (nowMs - n) / 60000);
}

function normalizeMarketWeatherRegimeFallback(value) {
  const raw = upper(value);

  if (raw.includes('SQUEEZE')) return 'SQUEEZE';
  if (raw.includes('COMPRESSION')) return 'SQUEEZE';
  if (raw.includes('COMPRESS')) return 'SQUEEZE';
  if (raw.includes('COIL')) return 'SQUEEZE';
  if (raw.includes('LOW_VOL')) return 'SQUEEZE';

  if (raw.includes('CHOP')) return 'CHOP';
  if (raw.includes('RANGE')) return 'CHOP';
  if (raw.includes('SIDEWAYS')) return 'CHOP';
  if (raw.includes('MIXED')) return 'CHOP';

  if (raw.includes('TREND')) return 'TREND';
  if (raw.includes('FLOW')) return 'TREND';
  if (raw.includes('MOMENTUM')) return 'TREND';
  if (raw.includes('DIRECTION')) return 'TREND';

  return raw || 'UNKNOWN';
}

function normalizeMarketWeatherTrendSideFallback(value) {
  const raw = upper(value);

  if (raw.includes('BEAR')) return 'BEARISH';
  if (raw.includes('SHORT')) return 'BEARISH';
  if (raw.includes('SELL')) return 'BEARISH';
  if (raw.includes('DOWN')) return 'BEARISH';
  if (raw.includes('DOWNSIDE')) return 'BEARISH';
  if (raw.includes('RISK_OFF')) return 'BEARISH';

  if (raw.includes('BULL')) return 'BULLISH';
  if (raw.includes('LONG')) return 'BULLISH';
  if (raw.includes('BUY')) return 'BULLISH';
  if (raw.includes('UP')) return 'BULLISH';
  if (raw.includes('UPSIDE')) return 'BULLISH';
  if (raw.includes('RISK_ON')) return 'BULLISH';

  if (raw.includes('NEUTRAL')) return 'NEUTRAL';
  if (raw.includes('MIXED')) return 'NEUTRAL';
  if (raw.includes('FLAT')) return 'NEUTRAL';

  return raw || 'UNKNOWN';
}

function buildEntryMarketWeatherKeyFallback(input = {}) {
  if (typeof input === 'string') {
    const raw = upper(input);

    if (raw.includes('|')) {
      const [regimeRaw, trendRaw] = raw.split('|');

      return `${normalizeMarketWeatherRegimeFallback(regimeRaw)}|${normalizeMarketWeatherTrendSideFallback(trendRaw)}`;
    }

    return 'UNKNOWN|UNKNOWN';
  }

  const directKey = upper(
    input.entryMarketWeatherKey ||
      input.currentMarketWeatherKey ||
      input.confirmedMarketWeatherKey ||
      input.marketWeatherKey ||
      ''
  );

  if (directKey.includes('|')) return buildEntryMarketWeatherKeyFallback(directKey);

  const regime = normalizeMarketWeatherRegimeFallback(
    input.entryMarketWeatherRegime ||
      input.currentMarketWeatherRegime ||
      input.confirmedMarketWeatherRegime ||
      input.marketWeatherRegime ||
      input.currentRegime ||
      input.regime ||
      input.marketRegime
  );

  const trendSide = normalizeMarketWeatherTrendSideFallback(
    input.entryMarketWeatherTrendSide ||
      input.currentMarketWeatherTrendSide ||
      input.confirmedMarketWeatherTrendSide ||
      input.marketWeatherTrendSide ||
      input.currentTrendSide ||
      input.trendSide ||
      input.marketTrendSide ||
      input.marketSide ||
      input.side ||
      input.direction
  );

  return `${regime}|${trendSide}`;
}

function parseMarketWeatherKey(key = '') {
  const normalized = buildEntryMarketWeatherKeyFallback(key);

  const [regimeRaw, trendRaw] = normalized.split('|');

  const regime = normalizeMarketWeatherRegimeFallback(regimeRaw);
  const trendSide = normalizeMarketWeatherTrendSideFallback(trendRaw);

  return {
    key: `${regime}|${trendSide}`,
    regime,
    trendSide,
    known: regime !== 'UNKNOWN' && trendSide !== 'UNKNOWN'
  };
}

function makeFallbackWeather(reason = 'NO_MARKET_WEATHER') {
  const key = 'UNKNOWN|UNKNOWN';

  return {
    ok: false,
    available: false,
    reason,

    currentMarketWeatherKey: key,
    confirmedMarketWeatherKey: key,
    currentMarketWeatherRegime: 'UNKNOWN',
    currentMarketWeatherTrendSide: 'UNKNOWN',
    confirmedMarketWeatherRegime: 'UNKNOWN',
    confirmedMarketWeatherTrendSide: 'UNKNOWN',
    currentMarketWeatherKnown: false,
    confirmedMarketWeatherKnown: false,

    currentRegime: 'UNKNOWN',
    regime: 'UNKNOWN',

    currentTrendSide: 'UNKNOWN',
    trendSide: 'UNKNOWN',
    marketTrendSide: 'UNKNOWN',

    confidence: 0,
    weatherConfidence: 0,
    currentMarketFitConfidence: 0,

    currentFit: 0,
    shortCurrentFit: 0,
    bearCurrentFit: 0,
    bearishCurrentFit: 0,
    bullishCurrentFit: 0,
    longCurrentFit: 0,

    bullishPct: null,
    bearishPct: null,
    neutralPct: null,
    squeezePct: null,

    sampleSize: 0,
    universeSize: 0,
    universeCount: 0,
    count: 0,

    breadth: {},
    btc: {},
    symbols: [],
    rows: [],
    universe: []
  };
}

function dashboardTrendSide(value) {
  const side = normalizeMarketWeatherTrendSideFallback(value);

  if (side === 'BULLISH') return 'BULL';
  if (side === 'BEARISH') return 'BEAR';
  if (side === 'NEUTRAL') return 'MIXED';

  return 'UNKNOWN';
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONGDISABLED_FALSE', '')
    .replaceAll('BLOCK_LONG_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORTDISABLED_FALSE', '')
    .replaceAll('BLOCK_SHORT_FALSE', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('LONGDISABLED_SHORT_ONLY', 'SHORT')
    .replaceAll('BLOCK_LONG', 'SHORT')
    .replaceAll('LONG_DISABLED', 'SHORT')
    .replaceAll('LONGDISABLED', 'SHORT')
    .replaceAll('SHORT_DISABLED_LONG_ONLY', 'LONG')
    .replaceAll('SHORTDISABLED_LONG_ONLY', 'LONG')
    .replaceAll('BLOCK_SHORT', 'LONG')
    .replaceAll('SHORT_DISABLED', 'LONG')
    .replaceAll('SHORTDISABLED', 'LONG')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeSignalText(value = '') {
  return cleanSideText(value)
    .replace(/[^A-Z0-9=:_|]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasSignalPattern(value = '', patterns = []) {
  const text = normalizeSignalText(value);

  if (!text) return false;

  return patterns.some((pattern) => (
    text === pattern ||
    text.startsWith(`${pattern}_`) ||
    text.endsWith(`_${pattern}`) ||
    text.includes(`_${pattern}_`) ||
    text.includes(`=${pattern}`) ||
    text.includes(`:${pattern}`) ||
    text.includes(`|${pattern}|`)
  ));
}

function hasLongSignal(text = '') {
  return hasSignalPattern(text, [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'UP',
    'UPSIDE',
    'MICRO_LONG',
    'SIDE_LONG',
    'SIDE_BULL',
    'SIDE_BUY',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'DIRECTION_BULL',
    'DIRECTION_BUY'
  ]);
}

function hasShortSignal(text = '') {
  return hasSignalPattern(text, [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'DOWN',
    'DOWNSIDE',
    'MICRO_SHORT',
    'SIDE_SHORT',
    'SIDE_BEAR',
    'SIDE_SELL',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'DIRECTION_BEAR',
    'DIRECTION_SELL'
  ]);
}

function marketBiasText(weather = {}, breadth = {}) {
  return [
    weather.currentTrendSide,
    weather.trendSide,
    weather.marketTrendSide,
    weather.marketSide,
    weather.side,
    weather.direction,
    weather.bias,
    weather.marketBias,
    weather.currentMarketBias,
    weather.regime,
    weather.currentRegime,
    weather.marketRegime,
    weather.breadthRegime,

    breadth.currentTrendSide,
    breadth.trendSide,
    breadth.marketTrendSide,
    breadth.marketSide,
    breadth.side,
    breadth.direction,
    breadth.bias,
    breadth.marketBias,
    breadth.currentMarketBias,
    breadth.regime
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join(' | ');
}

function resolveShortCurrentFit({
  weather = {},
  breadth = {},
  currentMarketWeatherTrendSide = 'UNKNOWN',
  bullishPct = null,
  bearishPct = null
} = {}) {
  const explicitShortFit = firstFinite(
    weather.shortCurrentFit,
    weather.currentShortFit,
    weather.bearCurrentFit,
    weather.bearishCurrentFit,
    weather.shortFit,
    weather.bearFit,
    weather.bearishFit,
    breadth.shortCurrentFit,
    breadth.currentShortFit,
    breadth.bearCurrentFit,
    breadth.bearishCurrentFit
  );

  if (explicitShortFit !== null) return signedPct(explicitShortFit);

  const explicitLongFit = firstFinite(
    weather.longCurrentFit,
    weather.currentLongFit,
    weather.bullCurrentFit,
    weather.bullishCurrentFit,
    weather.longFit,
    weather.bullFit,
    weather.bullishFit,
    breadth.longCurrentFit,
    breadth.currentLongFit,
    breadth.bullCurrentFit,
    breadth.bullishCurrentFit
  );

  if (explicitLongFit !== null) return signedPct(-explicitLongFit);

  const rawFit = firstFinite(
    weather.currentFit,
    weather.marketCurrentFit,
    weather.marketFit,
    weather.fitScore,
    breadth.currentFit,
    breadth.marketCurrentFit,
    breadth.marketFit,
    breadth.fitScore
  );

  const normalizedSide = normalizeMarketWeatherTrendSideFallback(currentMarketWeatherTrendSide);

  if (rawFit !== null) {
    if (normalizedSide === 'BEARISH') return signedPct(Math.abs(rawFit));
    if (normalizedSide === 'BULLISH') return signedPct(-Math.abs(rawFit));

    const text = marketBiasText(weather, breadth);
    const bearish = hasShortSignal(text);
    const bullish = hasLongSignal(text);

    if (bearish && !bullish) return signedPct(Math.abs(rawFit));
    if (bullish && !bearish) return signedPct(-Math.abs(rawFit));

    return signedPct(-rawFit);
  }

  if (bearishPct !== null || bullishPct !== null) {
    return Number((num(bearishPct, 0) - num(bullishPct, 0)).toFixed(4));
  }

  if (normalizedSide === 'BEARISH') return 1;
  if (normalizedSide === 'BULLISH') return -1;

  return 0;
}

function normalizeWeatherForAdmin(weatherInput = {}, helpers = {}) {
  const weather = weatherInput && typeof weatherInput === 'object'
    ? weatherInput
    : makeFallbackWeather('INVALID_WEATHER');

  const breadth = weather.breadth || {};

  const normalizeRegime = helpers.normalizeMarketWeatherRegime || normalizeMarketWeatherRegimeFallback;
  const normalizeTrendSide = helpers.normalizeMarketWeatherTrendSide || normalizeMarketWeatherTrendSideFallback;
  const buildKey = helpers.buildEntryMarketWeatherKey || buildEntryMarketWeatherKeyFallback;

  const directKey = firstValue(
    weather.confirmedMarketWeatherKey,
    weather.currentMarketWeatherKey,
    weather.entryMarketWeatherKey,
    weather.marketWeatherKey
  );

  const currentMarketWeatherKey = buildKey({
    currentMarketWeatherKey: directKey,
    currentMarketWeatherRegime: firstValue(
      weather.currentMarketWeatherRegime,
      weather.confirmedMarketWeatherRegime,
      weather.marketWeatherRegime,
      weather.currentRegime,
      weather.regime,
      weather.marketRegime,
      weather.breadthRegime
    ),
    currentMarketWeatherTrendSide: firstValue(
      weather.currentMarketWeatherTrendSide,
      weather.confirmedMarketWeatherTrendSide,
      weather.marketWeatherTrendSide,
      weather.currentTrendSide,
      weather.trendSide,
      weather.marketTrendSide,
      weather.marketSide,
      weather.side,
      weather.direction
    )
  });

  const parsedKey = parseMarketWeatherKey(currentMarketWeatherKey);

  const currentMarketWeatherRegime = normalizeRegime(parsedKey.regime);
  const currentMarketWeatherTrendSide = normalizeTrendSide(parsedKey.trendSide);
  const normalizedKey = `${currentMarketWeatherRegime}|${currentMarketWeatherTrendSide}`;
  const known = currentMarketWeatherRegime !== 'UNKNOWN' && currentMarketWeatherTrendSide !== 'UNKNOWN';

  const confidence = clamp(
    weather.currentMarketFitConfidence ??
      weather.confidence ??
      weather.weatherConfidence ??
      weather.currentTrendConfidence,
    0,
    100
  );

  const sampleSize = num(
    weather.sampleSize ??
      weather.universeSize ??
      weather.universeCount ??
      weather.count,
    0
  );

  const createdAt = firstFinite(
    weather.generatedAt,
    weather.updatedAt,
    weather.savedAt,
    weather.loadedAt,
    weather.completedAt,
    weather.createdAt,
    weather.ts
  );

  const bullishPct = pct(firstFinite(
    weather.bullishPct,
    weather.longPct,
    weather.upPct,
    weather.breadthBullishPct,
    breadth.bullishPct,
    breadth.longPct,
    breadth.upPct,
    breadth.advancePct,
    breadth.advanceRatio
  ));

  const bearishPct = pct(firstFinite(
    weather.bearishPct,
    weather.shortPct,
    weather.downPct,
    weather.breadthBearishPct,
    breadth.bearishPct,
    breadth.shortPct,
    breadth.downPct,
    breadth.declinePct,
    breadth.declineRatio
  ));

  const neutralPct = pct(firstFinite(
    weather.neutralPct,
    weather.flatPct,
    breadth.neutralPct,
    breadth.flatPct,
    breadth.neutralRatio
  ));

  const squeezePct = pct(firstFinite(
    weather.squeezePct,
    weather.compressionPct,
    breadth.squeezePct,
    breadth.compressionPct
  ));

  const shortCurrentFit = resolveShortCurrentFit({
    weather,
    breadth,
    currentMarketWeatherTrendSide,
    bullishPct,
    bearishPct
  });

  const ok =
    weather.ok === true ||
    weather.available === true ||
    sampleSize > 0 ||
    known;

  const nowMs = Date.now();
  const marketWeatherAgeMin = ageMin(firstFinite(weather.updatedAt, weather.savedAt, weather.generatedAt, createdAt), nowMs);

  const confirmedMarketWeather = helpers.confirmMarketWeatherKey
    ? helpers.confirmMarketWeatherKey({
        samples: weather.samples || weather.recentSamples || weather.confirmationSamples || [],
        currentMarketWeatherKey: normalizedKey,
        previousConfirmedMarketWeatherKey: weather.previousConfirmedMarketWeatherKey || weather.confirmedMarketWeatherKey,
        requiredConfirmations: WEATHER_CONFIRMATION_REQUIRED,
        windowSamples: WEATHER_CONFIRMATION_WINDOW_SAMPLES
      })
    : null;

  const confirmedMarketWeatherKey = confirmedMarketWeather?.confirmedMarketWeatherKey ||
    weather.confirmedMarketWeatherKey ||
    normalizedKey;

  const confirmedParsed = parseMarketWeatherKey(confirmedMarketWeatherKey);

  const playbookUpdatedAt = firstFinite(
    weather.playbookUpdatedAt,
    weather.currentMarketPlaybookUpdatedAt,
    weather.playbook?.updatedAt,
    weather.currentMarketPlaybook?.updatedAt
  );

  const playbookAgeMin = ageMin(playbookUpdatedAt, nowMs);
  const playbookFresh = playbookAgeMin !== null
    ? playbookAgeMin <= PLAYBOOK_MAX_AGE_MIN
    : false;

  return {
    ...weather,

    ok,
    available: ok,

    adminRouteVersion: MARKET_WEATHER_ADMIN_ROUTE_VERSION,
    file: 'src/market/marketWeather.js',
    apiRoute: '/api/admin/market-weather',

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    currentMarketWeatherKey: normalizedKey,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherRegime,
    currentMarketWeatherTrendSide,
    currentMarketWeatherKnown: known,

    confirmedMarketWeatherKey: confirmedParsed.key,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherRegime: confirmedParsed.regime,
    confirmedMarketWeatherTrendSide: confirmedParsed.trendSide,
    confirmedMarketWeatherKnown: confirmedParsed.known,

    currentRegime: currentMarketWeatherRegime,
    regime: currentMarketWeatherRegime,

    currentTrendSide: currentMarketWeatherTrendSide,
    trendSide: dashboardTrendSide(currentMarketWeatherTrendSide),
    marketTrendSide: dashboardTrendSide(currentMarketWeatherTrendSide),

    confidence,
    weatherConfidence: confidence,
    currentMarketFitConfidence: confidence,

    currentFit: shortCurrentFit,
    shortCurrentFit,
    bearCurrentFit: shortCurrentFit,
    bearishCurrentFit: shortCurrentFit,
    bullishCurrentFit: Number((-shortCurrentFit).toFixed(4)),
    longCurrentFit: Number((-shortCurrentFit).toFixed(4)),
    currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
    currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',

    bullishPct,
    bearishPct,
    neutralPct,
    squeezePct,

    sampleSize,
    universeSize: num(weather.universeSize ?? weather.universeCount ?? weather.count, sampleSize),
    universeCount: num(weather.universeCount ?? weather.universeSize ?? weather.count, sampleSize),
    count: num(weather.count ?? sampleSize, sampleSize),

    createdAt: createdAt || null,
    updatedAt: firstFinite(weather.updatedAt, weather.savedAt, weather.generatedAt, createdAt) || null,
    generatedAt: firstFinite(weather.generatedAt, weather.updatedAt, weather.savedAt, createdAt) || null,

    marketWeatherAgeMin,
    stale: marketWeatherAgeMin !== null ? marketWeatherAgeMin > PLAYBOOK_MAX_AGE_MIN : !ok,

    playbookUpdatedAt: playbookUpdatedAt || null,
    playbookAgeMin,
    playbookFresh,
    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,
    playbookStatus: playbookFresh ? 'FRESH' : 'MISSING_OR_STALE',
    playbookMissingReason: playbookFresh ? null : 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER',

    confirmation: {
      version: MARKET_WEATHER_CONFIRMATION_VERSION,
      requiredConfirmations: WEATHER_CONFIRMATION_REQUIRED,
      windowSamples: WEATHER_CONFIRMATION_WINDOW_SAMPLES,
      confirmedMarketWeatherKey: confirmedParsed.key,
      confirmedMarketWeatherRegime: confirmedParsed.regime,
      confirmedMarketWeatherTrendSide: confirmedParsed.trendSide,
      confirmedMarketWeatherKnown: confirmedParsed.known,
      changed: Boolean(confirmedMarketWeather?.changed),
      reason: confirmedMarketWeather?.reason || null,
      samples: weather.samples || weather.recentSamples || weather.confirmationSamples || []
    },

    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitMisfitIsPolicyBlock: false,
    learningRemainsBroad: true,

    unknownWeatherPolicy: {
      key: 'UNKNOWN|UNKNOWN',
      signalType: 'OBSERVE_ONLY',
      riskFractionForEntry: 0,
      reason: 'MARKET_WEATHER_UNKNOWN',
      learningAllowed: true,
      discordAllowed: false,
      tradeReadyAllowed: false
    },

    featureFlags: {
      version: MARKET_WEATHER_FEATURE_FLAGS_VERSION,
      capture: 'live',
      aggregation: 'live',
      selector: 'observe',
      sizingCap: 'observe',
      fdr: 'observe',
      discordTradeReady: 'validated_only'
    },

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    parentDiversificationBuilt: false,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    measurementFixVersion: MEASUREMENT_FIX_VERSION
  };
}

function buildResponse(weather, extra = {}, helpers = {}) {
  const normalized = normalizeWeatherForAdmin(weather, helpers);

  const universe =
    Array.isArray(normalized.universe) ? normalized.universe :
    Array.isArray(normalized.rows) ? normalized.rows :
    [];

  return {
    ok: normalized.ok,
    available: normalized.available,

    route: '/api/admin/market-weather',
    adminRouteVersion: MARKET_WEATHER_ADMIN_ROUTE_VERSION,
    file: 'src/market/marketWeather.js',

    ...extra,

    currentMarketWeatherKey: normalized.currentMarketWeatherKey,
    currentMarketWeatherKeyVersion: normalized.currentMarketWeatherKeyVersion,
    currentMarketWeatherRegime: normalized.currentMarketWeatherRegime,
    currentMarketWeatherTrendSide: normalized.currentMarketWeatherTrendSide,
    currentMarketWeatherKnown: normalized.currentMarketWeatherKnown,

    confirmedMarketWeatherKey: normalized.confirmedMarketWeatherKey,
    confirmedMarketWeatherKeyVersion: normalized.confirmedMarketWeatherKeyVersion,
    confirmedMarketWeatherRegime: normalized.confirmedMarketWeatherRegime,
    confirmedMarketWeatherTrendSide: normalized.confirmedMarketWeatherTrendSide,
    confirmedMarketWeatherKnown: normalized.confirmedMarketWeatherKnown,

    currentRegime: normalized.currentRegime,
    currentTrendSide: normalized.currentTrendSide,
    regime: normalized.regime,
    trendSide: normalized.trendSide,
    marketTrendSide: normalized.marketTrendSide,

    confidence: normalized.confidence,
    weatherConfidence: normalized.weatherConfidence,
    currentMarketFitConfidence: normalized.currentMarketFitConfidence,

    currentFit: normalized.currentFit,
    shortCurrentFit: normalized.shortCurrentFit,
    bearCurrentFit: normalized.bearCurrentFit,
    bearishCurrentFit: normalized.bearishCurrentFit,
    bullishCurrentFit: normalized.bullishCurrentFit,
    longCurrentFit: normalized.longCurrentFit,
    currentFitPolarity: normalized.currentFitPolarity,
    currentFitDefinition: normalized.currentFitDefinition,
    currentFitSoftOnly: true,
    currentFitBlocksLearning: false,
    currentFitBlocksVirtualLearning: false,
    currentFitBlocksShadowLearning: false,
    currentFitMisfitIsPolicyBlock: false,

    bullishPct: normalized.bullishPct,
    bearishPct: normalized.bearishPct,
    neutralPct: normalized.neutralPct,
    squeezePct: normalized.squeezePct,

    sampleSize: normalized.sampleSize,
    universeSize: normalized.universeSize,
    universeCount: normalized.universeCount,
    count: normalized.count,

    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    generatedAt: normalized.generatedAt,
    marketWeatherAgeMin: normalized.marketWeatherAgeMin,
    stale: normalized.stale,

    playbookUpdatedAt: normalized.playbookUpdatedAt,
    playbookAgeMin: normalized.playbookAgeMin,
    playbookFresh: normalized.playbookFresh,
    playbookMaxAgeMin: normalized.playbookMaxAgeMin,
    playbookStatus: normalized.playbookStatus,
    playbookMissingReason: normalized.playbookMissingReason,

    confirmation: normalized.confirmation,

    breadth: normalized.breadth || {},
    btc: normalized.btc || {},
    symbols: normalized.symbols || [],

    marketUniverse: universe,
    universe,

    unknownWeatherPolicy: normalized.unknownWeatherPolicy,
    featureFlags: normalized.featureFlags,

    adaptiveLayerBuilt: false,
    adaptiveScoreBuilt: false,
    recentMomentumScoreBuilt: false,
    parentDiversificationBuilt: false,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    virtualLearning: true,
    virtualLearningForced: true,
    virtualOutcomesIncluded: true,
    shadowOutcomesIncluded: true,
    realOutcomesExcluded: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    riskTradeSide: TARGET_TRADE_SIDE,
    riskGeometryRule: 'SHORT: tp < entry < sl',
    tpHitRule: 'SHORT: price <= tp',
    slHitRule: 'SHORT: price >= sl',
    grossRFormula: '(entry - exitPrice) / (initialSl - entry)',
    currentRFormula: '(entry - currentPrice) / (initialSl - entry)',

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    exactTrueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,

    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    redisKeysSeparatedFromLongRoot: true,
    longRootTouched: false,

    measurementFixVersion: MEASUREMENT_FIX_VERSION,

    marketWeather: normalized,
    weather: normalized,
    currentMarketWeather: normalized,
    latest: normalized,
    snapshot: normalized,

    raw: normalized
  };
}

function buildMarketWeatherOptions({
  redis,
  save,
  refresh = false
} = {}) {
  return {
    redis,
    save,
    refresh,
    allowStale: true,

    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,

    namespace: SHORT_NAMESPACE,
    keyPrefix: SHORT_KEY_PREFIX,
    redisNamespace: SHORT_NAMESPACE,
    redisKeyPrefix: SHORT_KEY_PREFIX,

    weekKey: PERSISTENT_LEARNING_KEY,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,

    trueMicroFamilySchema: TRUE_MICRO_SCHEMA,
    childTrueMicroFamilySchema: CHILD_TRUE_MICRO_SCHEMA,
    parentTrueMicroFamilySchema: PARENT_TRUE_MICRO_SCHEMA,
    learningGranularity: LEARNING_GRANULARITY,
    parentLearningGranularity: PARENT_LEARNING_GRANULARITY,

    entryMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    currentMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    confirmedMarketWeatherKeyVersion: MARKET_WEATHER_KEY_VERSION,
    playbookMaxAgeMin: PLAYBOOK_MAX_AGE_MIN,

    shortOnly: true,
    longDisabled: true,
    virtualLearning: true,
    virtualLearningForced: true,
    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    realOutcomesExcluded: true
  };
}

async function importMarketKeyHelpers() {
  try {
    const module = await import('../../src/market/marketKey.js');

    return {
      importOk: true,
      module,
      normalizeMarketWeatherRegime: module.normalizeMarketWeatherRegime || normalizeMarketWeatherRegimeFallback,
      normalizeMarketWeatherTrendSide: module.normalizeMarketWeatherTrendSide || normalizeMarketWeatherTrendSideFallback,
      buildEntryMarketWeatherKey: module.buildEntryMarketWeatherKey || buildEntryMarketWeatherKeyFallback,
      buildEntryMarketWeatherSnapshot: module.buildEntryMarketWeatherSnapshot || null,
      confirmMarketWeatherKey: module.confirmMarketWeatherKey || null,
      isFreshConfirmedMarketWeather: module.isFreshConfirmedMarketWeather || null
    };
  } catch (error) {
    return {
      importOk: false,
      importError: error?.message || String(error),
      normalizeMarketWeatherRegime: normalizeMarketWeatherRegimeFallback,
      normalizeMarketWeatherTrendSide: normalizeMarketWeatherTrendSideFallback,
      buildEntryMarketWeatherKey: buildEntryMarketWeatherKeyFallback,
      buildEntryMarketWeatherSnapshot: null,
      confirmMarketWeatherKey: null,
      isFreshConfirmedMarketWeather: null
    };
  }
}

async function readBody(req) {
  if (req.body) return req.body;

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function applyRequestOverride(weather = {}, req = {}, body = {}) {
  const query = req?.query || {};

  const overrideKey = firstValue(
    body.currentMarketWeatherKey,
    body.confirmedMarketWeatherKey,
    query.currentMarketWeatherKey,
    query.confirmedMarketWeatherKey
  );

  const overrideRegime = firstValue(
    body.currentMarketWeatherRegime,
    body.confirmedMarketWeatherRegime,
    query.currentMarketWeatherRegime,
    query.confirmedMarketWeatherRegime
  );

  const overrideTrendSide = firstValue(
    body.currentMarketWeatherTrendSide,
    body.confirmedMarketWeatherTrendSide,
    query.currentMarketWeatherTrendSide,
    query.confirmedMarketWeatherTrendSide
  );

  if (!overrideKey && !overrideRegime && !overrideTrendSide) return weather;

  return {
    ...weather,
    currentMarketWeatherKey: overrideKey || weather.currentMarketWeatherKey,
    confirmedMarketWeatherKey: overrideKey || weather.confirmedMarketWeatherKey,
    currentMarketWeatherRegime: overrideRegime || weather.currentMarketWeatherRegime,
    confirmedMarketWeatherRegime: overrideRegime || weather.confirmedMarketWeatherRegime,
    currentMarketWeatherTrendSide: overrideTrendSide || weather.currentMarketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: overrideTrendSide || weather.confirmedMarketWeatherTrendSide,
    overrideApplied: true,
    overrideSource: 'api/admin/market-weather request'
  };
}

export default async function handler(req, res) {
  const method = String(req?.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return sendJson(res, 200, { ok: true });
  }

  if (!['GET', 'POST'].includes(method)) {
    return sendJson(res, 405, {
      ok: false,
      available: false,
      error: 'METHOD_NOT_ALLOWED',
      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      scannerSide: TARGET_SCANNER_SIDE,
      redisNamespace: SHORT_NAMESPACE,
      persistentLearningKey: PERSISTENT_LEARNING_KEY,
      longRootTouched: false
    });
  }

  try {
    const query = req?.query || {};
    const body = method === 'POST' ? await readBody(req) : {};

    const refresh = bool(query.refresh, false) ||
      bool(query.force, false) ||
      bool(body.refresh, false) ||
      bool(body.force, false);

    const save = query.save === undefined && body.save === undefined
      ? true
      : bool(query.save ?? body.save, true);

    const keyHelpers = await importMarketKeyHelpers();

    let marketModule;
    let redisModule;

    try {
      marketModule = await import('../../src/market/marketWeather.js');
    } catch (error) {
      return sendJson(res, 200, buildResponse(makeFallbackWeather('IMPORT_MARKET_WEATHER_FAILED'), {
        importOk: false,
        marketWeatherImportOk: false,
        marketKeyImportOk: keyHelpers.importOk,
        marketKeyImportError: keyHelpers.importError || null,
        importError: error?.message || String(error),
        importStack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
      }, keyHelpers));
    }

    try {
      redisModule = await import('../../src/redis.js');
    } catch (error) {
      return sendJson(res, 200, buildResponse(makeFallbackWeather('IMPORT_REDIS_FAILED'), {
        importOk: false,
        marketWeatherImportOk: true,
        marketKeyImportOk: keyHelpers.importOk,
        marketKeyImportError: keyHelpers.importError || null,
        importError: error?.message || String(error),
        importStack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
      }, keyHelpers));
    }

    const redis = redisModule.getDurableRedis
      ? redisModule.getDurableRedis()
      : undefined;

    let weather;
    let source;

    try {
      const options = buildMarketWeatherOptions({
        redis,
        save,
        refresh
      });

      if (refresh && typeof marketModule.buildMarketWeather === 'function') {
        weather = await marketModule.buildMarketWeather(options);
        source = 'buildMarketWeather';
      } else if (typeof marketModule.getMarketWeather === 'function') {
        weather = await marketModule.getMarketWeather(options);
        source = 'getMarketWeather';
      } else if (typeof marketModule.loadMarketWeather === 'function') {
        weather = await marketModule.loadMarketWeather(options);
        source = 'loadMarketWeather';
      } else if (typeof marketModule.default === 'function') {
        weather = await marketModule.default(options);
        source = 'default';
      } else {
        weather = makeFallbackWeather('NO_MARKET_WEATHER_EXPORT_FOUND');
        source = 'fallback';
      }
    } catch (error) {
      return sendJson(res, 200, buildResponse(makeFallbackWeather('MARKET_WEATHER_FUNCTION_FAILED'), {
        importOk: true,
        marketWeatherImportOk: true,
        marketKeyImportOk: keyHelpers.importOk,
        marketKeyImportError: keyHelpers.importError || null,
        source: 'error',
        functionError: error?.message || String(error),
        functionStack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
      }, keyHelpers));
    }

    const withOverride = applyRequestOverride(weather, req, body);

    return sendJson(res, 200, buildResponse(withOverride, {
      importOk: true,
      marketWeatherImportOk: true,
      marketKeyImportOk: keyHelpers.importOk,
      marketKeyImportError: keyHelpers.importError || null,
      source,
      refreshed: refresh,
      saved: save,
      requestOverrideApplied: Boolean(withOverride?.overrideApplied)
    }, keyHelpers));
  } catch (error) {
    return sendJson(res, 200, buildResponse(makeFallbackWeather('ADMIN_ROUTE_FAILED'), {
      routeError: error?.message || String(error),
      routeStack: process.env.NODE_ENV === 'production' ? undefined : error?.stack
    }));
  }
}