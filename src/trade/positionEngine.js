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