// ================= FILE: api/admin/micro-families.js =================

async function getCurrentMarketWeatherSafe() {
  if (cache.marketWeather) {
    const age = now() - cache.marketWeather.ts;
    const cachedValue = cache.marketWeather.value;

    if (cachedValue?.available && age <= CACHE_TTL_MS) {
      return {
        ...cachedValue,
        cacheHit: true
      };
    }

    if (!cachedValue?.available && age <= MARKET_WEATHER_EMPTY_CACHE_TTL_MS) {
      return {
        ...cachedValue,
        cacheHit: true,
        emptyCacheHit: true
      };
    }
  }

  let value = normalizeMarketWeather(null, null, null);
  const attempts = [];

  try {
    const found = await withTimeout(
      readJsonFromAnyRedis(marketWeatherKeyCandidates()),
      MARKET_WEATHER_TIMEOUT_MS,
      'MARKET_WEATHER_SHORT_KEY_READ_TIMEOUT'
    );

    if (found?.normalized?.available) {
      value = {
        ...found.normalized,
        readAttempt: 'SHORT_NAMESPACED_MARKET_WEATHER'
      };
    } else {
      attempts.push('SHORT_NAMESPACED_MARKET_WEATHER_EMPTY');
    }
  } catch (error) {
    attempts.push(error?.message || String(error) || 'SHORT_NAMESPACED_MARKET_WEATHER_TIMEOUT');
  }

  if (!value.available) {
    try {
      const rawFound = await withTimeout(
        readRawMarketWeatherFallback(),
        MARKET_WEATHER_TIMEOUT_MS,
        'MARKET_WEATHER_RAW_NEUTRAL_FALLBACK_TIMEOUT'
      );

      if (rawFound?.normalized?.available) {
        value = {
          ...rawFound.normalized,
          readAttempt: 'RAW_NEUTRAL_MARKET_WEATHER_FALLBACK',
          rawNeutralFallbackUsed: true,
          copiedToShortMarketWeatherKey: true
        };
      } else {
        attempts.push('RAW_NEUTRAL_MARKET_WEATHER_EMPTY');
      }
    } catch (error) {
      attempts.push(error?.message || String(error) || 'RAW_NEUTRAL_MARKET_WEATHER_TIMEOUT');
    }
  }

  if (!value.available) {
    try {
      const builtPayload = await withTimeout(
        buildMarketWeatherDirect(),
        MARKET_WEATHER_BUILD_TIMEOUT_MS,
        'MARKET_WEATHER_SELF_HEAL_BUILD_TIMEOUT'
      );

      const builtValue = normalizeMarketWeather(
        builtPayload,
        builtPayload?.loadedFromKey || builtPayload?.sourceKey || SHORT_MARKET_WEATHER_KEY,
        'self_heal_build'
      );

      if (builtValue.available) {
        await persistMarketWeatherToShortKey(builtValue, 'self_heal_build');

        value = {
          ...builtValue,
          readAttempt: 'SELF_HEAL_MARKET_WEATHER_BUILD',
          builtFallbackUsed: true,
          copiedToShortMarketWeatherKey: true
        };
      } else {
        attempts.push(builtValue.reason || 'SELF_HEAL_BUILD_INCOMPLETE');
      }
    } catch (error) {
      attempts.push(error?.message || String(error) || 'SELF_HEAL_BUILD_FAILED');
    }
  }

  if (!value.available) {
    value = {
      ...value,
      available: false,
      ok: false,
      reason: attempts.length > 0
        ? attempts.join('|')
        : 'MARKET_WEATHER_EMPTY',
      attempts,
      currentRegime: 'UNKNOWN',
      currentTrendSide: 'UNKNOWN',
      bullishPct: null,
      bearishPct: null,
      squeezePct: null,
      confidence: 0,
      currentFitPolarity: 'BEARISH_POSITIVE_BULLISH_NEGATIVE',
      currentFitDefinition: 'SHORT_MIRRORED_CURRENT_FIT',
      shortOnly: true,
      longDisabled: true,
      redisNamespace: SHORT_NAMESPACE,
      redisKeyPrefix: SHORT_KEY_PREFIX,
      longRootTouched: false
    };
  }

  cache.marketWeather = {
    ts: now(),
    value
  };

  return value;
}}