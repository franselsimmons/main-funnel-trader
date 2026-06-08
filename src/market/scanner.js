// ================= FILE: src/market/scanner.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getVolatileRedis, setJson } from '../redis.js';
import {
  classifyBtcState,
  mapConcurrent,
  normalizeBaseSymbol,
  normalizeContractSymbol,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import {
  calculateAtrPct,
  classifyVolatilityRegime,
  calcVolumeExpansion
} from './indicators.js';
import { detectFakeBreakout } from './fakeBreakout.js';
import {
  fetchBitgetTickers,
  parseTicker,
  fetchCandles
} from './bitgetClient.js';

const DEFAULT_ANALYZE_SYMBOLS = 300;
const DEFAULT_MAX_CANDIDATES = 300;
const DEFAULT_MIN_QUOTE_VOLUME_24H = 50_000;
const DEFAULT_SOFT_MIN_QUOTE_VOLUME_24H = 10_000;

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_SCANNER_SIDE = 'bear';
const TARGET_DASHBOARD_SIDE = 'bear';

const OPPOSITE_TRADE_SIDE = 'LONG';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const BLOCKED_BASE_SYMBOLS = new Set([
  'USDT',
  'USDC',
  'USD',
  'BUSD',
  'FDUSD',
  'TUSD',
  'DAI',
  'EUR',
  'TRY',
  'BRL'
]);

function now() {
  return Date.now();
}

function cfgNumber(pathValue, fallback) {
  const value = safeNumber(pathValue, fallback);

  return Number.isFinite(value) ? value : fallback;
}

function cfgBoolean(pathValue, fallback = false) {
  if (pathValue === undefined || pathValue === null || pathValue === '') {
    return fallback;
  }

  const normalized = String(pathValue).trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  return fallback;
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.floor(cfgNumber(value, fallback));

  return Math.max(min, Math.min(max, n));
}

function scannerConcurrency() {
  return positiveInt(
    CONFIG.scanner?.dataConcurrency ||
    CONFIG.trade?.dataConcurrency,
    8,
    1,
    20
  );
}

function scannerMaxSymbols() {
  const configured = cfgNumber(CONFIG.scanner?.maxSymbols, 0);
  const analyzeMax = cfgNumber(
    CONFIG.scanner?.analyzeMaxSymbols ??
    CONFIG.scanner?.maxAnalyzeSymbols ??
    CONFIG.scanner?.maxUniverseSymbols,
    DEFAULT_ANALYZE_SYMBOLS
  );

  return positiveInt(
    Math.max(configured, analyzeMax, DEFAULT_ANALYZE_SYMBOLS),
    DEFAULT_ANALYZE_SYMBOLS,
    1,
    1000
  );
}

function scannerMaxCandidates() {
  const configured = cfgNumber(CONFIG.scanner?.maxCandidates, 0);
  const analyzeMax = cfgNumber(
    CONFIG.scanner?.analyzeMaxCandidates ??
    CONFIG.scanner?.maxAnalyzeCandidates,
    DEFAULT_MAX_CANDIDATES
  );

  return positiveInt(
    Math.max(configured, analyzeMax, DEFAULT_MAX_CANDIDATES),
    DEFAULT_MAX_CANDIDATES,
    1,
    1000
  );
}

function minQuoteVolume24h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.minQuoteVolume24h, DEFAULT_MIN_QUOTE_VOLUME_24H)
  );
}

function softMinQuoteVolume24h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.softMinQuoteVolume24h, DEFAULT_SOFT_MIN_QUOTE_VOLUME_24H)
  );
}

function minAbsChange1h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.minAbsChange1h, 0.12)
  );
}

function minAbsChange24h() {
  return Math.max(
    0,
    cfgNumber(CONFIG.scanner?.minAbsChange24h, 0.35)
  );
}

function strictScannerFiltersEnabled() {
  return cfgBoolean(CONFIG.scanner?.strictFilters, false);
}

function blockFakeBreakoutEnabled() {
  return cfgBoolean(CONFIG.scanner?.blockFakeBreakout, false);
}

function blockNoDirectionEnabled() {
  return cfgBoolean(CONFIG.scanner?.blockNoDirection, false);
}

function blockSmallMoveEnabled() {
  return cfgBoolean(CONFIG.scanner?.blockSmallMove, false);
}

function snapshotTtlSec() {
  return positiveInt(
    CONFIG.scanner?.snapshotTtlSec,
    30 * 60,
    60,
    24 * 3600
  );
}

function candleLimit() {
  return positiveInt(
    CONFIG.scanner?.candleLimit,
    100,
    30,
    500
  );
}

function fakeBreakoutLookback() {
  return positiveInt(
    CONFIG.scanner?.fakeBreakoutLookback,
    24,
    5,
    200
  );
}

function stripUsdtQuote(symbol = '') {
  const value = String(symbol || '').trim().toUpperCase();

  if (!value.endsWith('USDT')) return value;

  return value.slice(0, -4);
}

function isBlockedBaseSymbol(baseSymbol = '') {
  const base = String(baseSymbol || '').trim().toUpperCase();

  if (!base) return true;

  return BLOCKED_BASE_SYMBOLS.has(base);
}

function isValidUsdtFuturesContractSymbol(symbol = '') {
  const value = String(symbol || '').trim().toUpperCase();

  if (!value) return false;
  if (value === 'USDT') return false;
  if (!value.endsWith('USDT')) return false;
  if (!/^[A-Z0-9]+USDT$/.test(value)) return false;

  const base = stripUsdtQuote(value);

  return !isBlockedBaseSymbol(base);
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = safeNumber(value, 0);

    if (n > 0) return n;
  }

  return 0;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = safeNumber(value, NaN);

    if (Number.isFinite(n)) return n;
  }

  return 0;
}

function normalizeScannerTicker(rawTicker = {}) {
  const parsed = parseTicker(rawTicker);

  const contractSymbol = normalizeContractSymbol(
    parsed.contractSymbol ||
    parsed.symbol ||
    rawTicker.contractSymbol ||
    rawTicker.symbol ||
    rawTicker.instId ||
    rawTicker.contractCode ||
    rawTicker.symbolName
  );

  if (!isValidUsdtFuturesContractSymbol(contractSymbol)) return null;

  const derivedBaseSymbol = stripUsdtQuote(contractSymbol);

  const parsedBaseSymbol = normalizeBaseSymbol(
    parsed.baseSymbol ||
    rawTicker.baseSymbol ||
    derivedBaseSymbol
  );

  const baseSymbol = isBlockedBaseSymbol(parsedBaseSymbol)
    ? derivedBaseSymbol
    : parsedBaseSymbol;

  if (isBlockedBaseSymbol(baseSymbol)) return null;

  const price = firstPositiveNumber(
    parsed.price,
    rawTicker.price,
    rawTicker.lastPr,
    rawTicker.last,
    rawTicker.close,
    rawTicker.markPrice,
    rawTicker.indexPrice
  );

  const baseVolume = firstPositiveNumber(
    rawTicker.baseVolume,
    rawTicker.baseVol,
    rawTicker.volume,
    rawTicker.vol,
    parsed.baseVolume
  );

  const quoteVolumeRaw = firstPositiveNumber(
    parsed.volume24h,
    rawTicker.volume24h,
    rawTicker.quoteVolume,
    rawTicker.quoteVol,
    rawTicker.usdtVolume,
    rawTicker.turnover,
    rawTicker.quoteTurnover
  );

  const volume24h = quoteVolumeRaw > 0
    ? quoteVolumeRaw
    : baseVolume * price;

  const rawChange = firstFiniteNumber(
    parsed.change24h,
    rawTicker.change24h,
    rawTicker.changeUtc24h,
    rawTicker.priceChangePercent,
    rawTicker.priceChange24h,
    rawTicker.chgUtc
  );

  const change24h = Math.abs(rawChange) <= 1
    ? rawChange * 100
    : rawChange;

  return {
    ...parsed,
    symbol: contractSymbol,
    contractSymbol,
    baseSymbol,
    price,
    volume24h,
    change24h,
    raw: rawTicker.raw || rawTicker
  };
}

function cleanSideText(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE', 'RED'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE', 'GREEN'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromText(value) {
  const text = cleanSideText(value);

  if (!text) return 'UNKNOWN';

  const shortHit = (
    text.includes('MICRO_SHORT_') ||
    text.includes('TRADESIDE=SHORT') ||
    text.includes('TRADE_SIDE=SHORT') ||
    text.includes('POSITION_SIDE=SHORT') ||
    text.includes('POSITIONSIDE=SHORT') ||
    text.includes('SIDE=SHORT') ||
    text.includes('SIDE=BEAR') ||
    text.includes('DIRECTION=SHORT') ||
    text.includes('DIRECTION=BEAR') ||
    text.includes('SIDE=SELL') ||
    text.includes('DIRECTION=SELL') ||
    text.startsWith('SHORT_') ||
    text.includes('_SHORT_') ||
    text.endsWith('_SHORT') ||
    text.startsWith('BEAR_') ||
    text.includes('_BEAR_') ||
    text.endsWith('_BEAR') ||
    text.startsWith('SELL_') ||
    text.includes('_SELL_') ||
    text.endsWith('_SELL')
  );

  const longHit = (
    text.includes('MICRO_LONG_') ||
    text.includes('TRADESIDE=LONG') ||
    text.includes('TRADE_SIDE=LONG') ||
    text.includes('POSITION_SIDE=LONG') ||
    text.includes('POSITIONSIDE=LONG') ||
    text.includes('SIDE=LONG') ||
    text.includes('SIDE=BULL') ||
    text.includes('DIRECTION=LONG') ||
    text.includes('DIRECTION=BULL') ||
    text.includes('SIDE=BUY') ||
    text.includes('DIRECTION=BUY') ||
    text.startsWith('LONG_') ||
    text.includes('_LONG_') ||
    text.endsWith('_LONG') ||
    text.startsWith('BULL_') ||
    text.includes('_BULL_') ||
    text.endsWith('_BULL') ||
    text.startsWith('BUY_') ||
    text.includes('_BUY_') ||
    text.endsWith('_BUY')
  );

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit) return TARGET_TRADE_SIDE;
  if (longHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function inferRowTradeSide(row = {}) {
  if (typeof row === 'string') return inferTradeSideFromText(row);
  if (!row || typeof row !== 'object') return 'UNKNOWN';

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.positionSide ||
    row.direction ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide ||
    row.signalSide ||
    row.entrySide ||
    row.side
  );

  if (direct !== 'UNKNOWN') return direct;

  const haystack = [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.liveMicroFamilyId,
    row.realMicroFamilyId,
    row.executionMicroFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId,

    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => cleanSideText(value))
    .filter(Boolean)
    .join('|');

  return inferTradeSideFromText(haystack);
}

function isTargetCandidate(candidate = {}) {
  return inferRowTradeSide(candidate) === TARGET_TRADE_SIDE;
}

function isOppositeCandidate(candidate = {}) {
  return inferRowTradeSide(candidate) === OPPOSITE_TRADE_SIDE;
}

function calcChangePct(first, last) {
  const a = safeNumber(first, 0);
  const b = safeNumber(last, 0);

  if (a <= 0 || b <= 0) return 0;

  return ((b - a) / a) * 100;
}

function calcOneHourChange(candles15m) {
  const rows = Array.isArray(candles15m) ? candles15m : [];

  if (rows.length < 5) return 0;

  const first = rows.at(-5)?.close;
  const last = rows.at(-1)?.close;

  return calcChangePct(first, last);
}

function isRisingMove({ change1h, change24h }) {
  return safeNumber(change1h, 0) > 0 || safeNumber(change24h, 0) > 0;
}

function inferSide({ change1h, change24h, btcState }) {
  const ch1 = safeNumber(change1h, 0);
  const ch24 = safeNumber(change24h, 0);

  if (isRisingMove({ change1h: ch1, change24h: ch24 })) {
    return 'neutral';
  }

  const min1 = minAbsChange1h();
  const min24 = minAbsChange24h();

  if (ch1 <= -min1) return TARGET_SCANNER_SIDE;
  if (ch24 <= -min24) return TARGET_SCANNER_SIDE;

  if (ch1 < 0 && ch24 <= 0) return TARGET_SCANNER_SIDE;
  if (ch24 < 0 && ch1 <= 0) return TARGET_SCANNER_SIDE;

  const state = String(btcState || '').toUpperCase();

  if (state.includes('BEAR') && (ch1 < 0 || ch24 < 0)) {
    return TARGET_SCANNER_SIDE;
  }

  return 'neutral';
}

function sideConfidence({ side, change1h, change24h }) {
  if (side !== TARGET_SCANNER_SIDE) return 'LOW';

  const down1h = Math.max(0, -safeNumber(change1h, 0));
  const down24h = Math.max(0, -safeNumber(change24h, 0));

  if (down1h >= minAbsChange1h() * 2 || down24h >= minAbsChange24h() * 2) return 'HIGH';
  if (down1h >= minAbsChange1h() || down24h >= minAbsChange24h()) return 'MID';

  return 'LOW';
}

function safeToken(value, fallback = 'NA') {
  const token = String(value || fallback)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return token || fallback;
}

function bucketSignedChange(value, prefix = 'MOVE') {
  const n = safeNumber(value, 0);
  const abs = Math.abs(n);
  const direction = n < 0 ? 'DOWN' : n > 0 ? 'UP' : 'FLAT';

  if (abs >= 5) return `${prefix}_${direction}_XL`;
  if (abs >= 2.5) return `${prefix}_${direction}_L`;
  if (abs >= 1) return `${prefix}_${direction}_M`;
  if (abs >= 0.35) return `${prefix}_${direction}_S`;

  return `${prefix}_${direction}_XS`;
}

function bucketVolumeExpansion(value) {
  const n = safeNumber(value, 1);

  if (n >= 2) return 'VOL_EXP_XL';
  if (n >= 1.5) return 'VOL_EXP_L';
  if (n >= 1.25) return 'VOL_EXP_M';
  if (n >= 1.15) return 'VOL_EXP_S';

  return 'VOL_EXP_LOW';
}

function buildScannerFingerprint({
  baseSymbol,
  scannerReason,
  sideConfidenceLevel,
  change1h,
  change24h,
  volumeExpansion,
  btcState,
  regime,
  fakeBreakout,
  fakeBreakoutRisk,
  breakoutType,
  pullbackConfirmed,
  retestConfirmed,
  sweepConfirmed,
  scannerGatePassed,
  analyzeEligible,
  tradeDiscoveryOnly
}) {
  const symbol = safeToken(baseSymbol, 'COIN');
  const reason = safeToken(scannerReason, 'SHORT_ANALYZE_DISCOVERY');
  const confidence = safeToken(sideConfidenceLevel, 'LOW');
  const btc = safeToken(btcState, 'BTC_NEUTRAL');
  const volRegime = safeToken(regime, 'NORMAL_VOL');

  const move1h = bucketSignedChange(change1h, 'M1H');
  const move24h = bucketSignedChange(change24h, 'M24H');
  const vol = bucketVolumeExpansion(volumeExpansion);

  const fakeState = fakeBreakout
    ? 'FAKE_BREAKOUT'
    : fakeBreakoutRisk
      ? 'FAKE_RISK'
      : 'FAKE_CLEAN';

  const breakout = safeToken(breakoutType, 'NO_BREAKOUT');
  const pullback = pullbackConfirmed ? 'PULLBACK' : 'NO_PULLBACK';
  const retest = retestConfirmed ? 'RETEST' : 'NO_RETEST';
  const sweep = sweepConfirmed ? 'SWEEP' : 'NO_SWEEP';

  const gate = scannerGatePassed
    ? 'SCANNER_GATE_PASS'
    : analyzeEligible
      ? 'ANALYZE_ONLY'
      : 'DISCOVERY_ONLY';

  const familyId = `SHORT_SCANNER_${reason}`;

  const macroFamilyId = [
    'MICRO_SHORT_SCANNER',
    reason,
    confidence,
    btc,
    volRegime
  ].join('__');

  const microFamilyId = [
    macroFamilyId,
    move1h,
    move24h,
    vol,
    fakeState,
    breakout,
    pullback,
    retest,
    sweep,
    gate
  ].join('__');

  const macroDefinitionParts = [
    'tradeSide=SHORT',
    'side=SHORT',
    'scannerSide=bear',
    `scannerReason=${reason}`,
    `sideConfidence=${confidence}`,
    `btcState=${btc}`,
    `regime=${volRegime}`
  ];

  const microDefinitionParts = [
    ...macroDefinitionParts,
    `symbol=${symbol}`,
    `change1hBucket=${move1h}`,
    `change24hBucket=${move24h}`,
    `volumeExpansionBucket=${vol}`,
    `fakeState=${fakeState}`,
    `breakout=${breakout}`,
    pullback,
    retest,
    sweep,
    gate,
    tradeDiscoveryOnly ? 'tradeDiscoveryOnly=true' : 'tradeDiscoveryOnly=false'
  ];

  return {
    familyId,
    baseFamilyId: familyId,

    macroFamilyId,
    parentMacroFamilyId: macroFamilyId,
    parentMicroFamilyId: macroFamilyId,
    macroId: macroFamilyId,

    microFamilyId,
    trueMicroFamilyId: microFamilyId,

    definition: microFamilyId,
    microDefinition: microFamilyId,
    macroDefinition: macroFamilyId,
    parentDefinition: macroFamilyId,

    definitionParts: microDefinitionParts,
    microDefinitionParts,
    macroDefinitionParts,
    parentDefinitionParts: macroDefinitionParts,

    executionFingerprintParts: microDefinitionParts,

    scannerFingerprintVersion: 'short_scanner_v3',
    scannerFamilySource: 'SCANNER_DISCOVERY'
  };
}

function calcScannerScore({
  change1h,
  change24h,
  volume24h,
  volumeExpansion,
  fakeBreakoutRisk,
  fakeBreakout,
  pullbackConfirmed,
  sweepConfirmed,
  retestConfirmed,
  breakoutType,
  sideConfidenceLevel
}) {
  let score = 0;

  const down1h = Math.max(0, -safeNumber(change1h, 0));
  const down24h = Math.max(0, -safeNumber(change24h, 0));

  score += Math.min(35, down1h * 12);
  score += Math.min(22, down24h * 2.7);
  score += Math.min(20, Math.log10(Math.max(10, safeNumber(volume24h, 0))) * 2.0);

  if (safeNumber(volumeExpansion, 1) >= 1.15) score += 3;
  if (safeNumber(volumeExpansion, 1) >= 1.25) score += 6;
  if (safeNumber(volumeExpansion, 1) >= 1.75) score += 4;

  if (pullbackConfirmed) score += 7;
  if (retestConfirmed) score += 5;
  if (sweepConfirmed) score += 3;
  if (breakoutType === 'VALID_BREAKOUT') score += 4;

  if (sideConfidenceLevel === 'HIGH') score += 5;
  if (sideConfidenceLevel === 'MID') score += 2;
  if (sideConfidenceLevel === 'LOW') score -= 2;

  if (fakeBreakoutRisk) score -= 8;
  if (fakeBreakout) score -= 7;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scannerReasonFrom({
  fake,
  volumeExpansion,
  passesMoveFilter,
  sideConfidenceLevel
}) {
  if (fake?.pullbackConfirmed && fake?.retestConfirmed) return 'SHORT_MOMENTUM_PULLBACK_RETEST';
  if (fake?.pullbackConfirmed) return 'SHORT_MOMENTUM_PULLBACK';
  if (fake?.breakoutType === 'VALID_BREAKOUT') return 'SHORT_VALID_BREAKOUT';
  if (volumeExpansion >= 1.5) return 'SHORT_VOLUME_EXPANSION';
  if (passesMoveFilter) return 'SHORT_MOMENTUM_EXPANSION';
  if (sideConfidenceLevel === 'LOW') return 'SHORT_WEAK_DIRECTION_ANALYZE_ONLY';

  return 'SHORT_ANALYZE_DISCOVERY';
}

function cleanFakeResult(fake = {}) {
  return {
    fakeBreakout: Boolean(fake.fakeBreakout),
    fakeBreakoutRisk: Boolean(fake.fakeBreakoutRisk),
    fakeBreakoutReason: fake.fakeBreakoutReason || null,
    breakoutType: fake.breakoutType || 'UNKNOWN',
    pullbackConfirmed: Boolean(fake.pullbackConfirmed),
    sweepConfirmed: Boolean(fake.sweepConfirmed),
    retestConfirmed: Boolean(fake.retestConfirmed)
  };
}

function isTradableTicker(ticker) {
  if (!ticker?.symbol) return false;
  if (!ticker?.contractSymbol) return false;
  if (!ticker?.baseSymbol) return false;

  if (!isValidUsdtFuturesContractSymbol(ticker.contractSymbol)) return false;
  if (isBlockedBaseSymbol(ticker.baseSymbol)) return false;

  if (safeNumber(ticker.price, 0) <= 0) return false;

  const volume24h = safeNumber(ticker.volume24h, 0);
  const hardMinVolume = strictScannerFiltersEnabled()
    ? minQuoteVolume24h()
    : softMinQuoteVolume24h();

  return volume24h >= hardMinVolume;
}

function dedupeByBaseSymbol(tickers) {
  const byBase = new Map();

  for (const ticker of tickers) {
    const normalized = normalizeScannerTicker(ticker);

    if (!normalized) continue;

    const baseSymbol = normalized.baseSymbol;
    const contractSymbol = normalized.contractSymbol;

    if (!baseSymbol || !contractSymbol) continue;
    if (isBlockedBaseSymbol(baseSymbol)) continue;
    if (!isValidUsdtFuturesContractSymbol(contractSymbol)) continue;

    const existing = byBase.get(baseSymbol);

    if (!existing || safeNumber(normalized.volume24h, 0) > safeNumber(existing.volume24h, 0)) {
      byBase.set(baseSymbol, normalized);
    }
  }

  return [...byBase.values()];
}

function shortUniverseScore(ticker = {}) {
  const change24h = safeNumber(ticker.change24h, 0);
  const volume24h = safeNumber(ticker.volume24h, 0);

  if (change24h > 0) return -1_000_000 - change24h;

  const bearishPressure = Math.abs(change24h) * 120;
  const volumeScore = Math.log10(Math.max(10, volume24h)) * 4;

  return bearishPressure + volumeScore;
}

function sortShortUniverse(a, b) {
  const scoreDelta = shortUniverseScore(b) - shortUniverseScore(a);

  if (scoreDelta !== 0) return scoreDelta;

  return safeNumber(b.volume24h, 0) - safeNumber(a.volume24h, 0);
}

function buildTickerUniverse(rawTickers) {
  return dedupeByBaseSymbol(
    (Array.isArray(rawTickers) ? rawTickers : [])
      .map(normalizeScannerTicker)
      .filter(Boolean)
      .filter(isTradableTicker)
      .filter((ticker) => safeNumber(ticker.change24h, 0) <= 0)
  )
    .sort(sortShortUniverse)
    .slice(0, scannerMaxSymbols());
}

function createCandleCache() {
  const cache = new Map();

  return async function getCandles(symbol, timeframe = '15m', limit = candleLimit()) {
    const contractSymbol = normalizeContractSymbol(symbol);
    const requestedLimit = Math.max(30, Math.floor(safeNumber(limit, candleLimit())));

    if (!isValidUsdtFuturesContractSymbol(contractSymbol)) {
      return [];
    }

    const key = `${contractSymbol}:${timeframe}:${requestedLimit}`;

    if (cache.has(key)) return cache.get(key);

    const promise = fetchCandles(contractSymbol, timeframe, requestedLimit).catch(() => []);
    cache.set(key, promise);

    return promise;
  };
}

async function buildBtcContext({ universe, getCandles }) {
  const btcTicker =
    universe.find((row) => row.baseSymbol === 'BTC') ||
    normalizeScannerTicker({
      symbol: 'BTCUSDT',
      last: 0,
      quoteVolume: 0,
      change24h: 0
    }) ||
    {
      symbol: 'BTCUSDT',
      contractSymbol: 'BTCUSDT',
      baseSymbol: 'BTC',
      price: 0,
      volume24h: 0,
      change24h: 0
    };

  const btcCandles15m = await getCandles(
    'BTCUSDT',
    '15m',
    candleLimit()
  );

  const btcChange1h = calcOneHourChange(btcCandles15m);
  const btcChange24h = safeNumber(btcTicker.change24h, 0);

  const btcState = classifyBtcState({
    change24: btcChange24h,
    change1h: btcChange1h
  });

  const btcAtrPct = calculateAtrPct(btcCandles15m, 14);
  const volRegime = classifyVolatilityRegime(btcCandles15m, btcAtrPct);

  const regime =
    volRegime === 'EXTREME_VOL' ? 'HIGH_VOL' :
    volRegime === 'HIGH_VOL' ? 'HIGH_VOL' :
    volRegime === 'LOW_VOL' ? 'LOW_VOL' :
    'NORMAL_VOL';

  return {
    btcState,
    regime,
    btcChange1h: Number(btcChange1h.toFixed(3)),
    btcChange24h: Number(btcChange24h.toFixed(3)),
    btcAtrPct: Number(btcAtrPct.toFixed(6))
  };
}

function buildGateFlags({
  change1h,
  change24h,
  fake,
  side,
  volume24h
}) {
  const ch1 = safeNumber(change1h, 0);
  const ch24 = safeNumber(change24h, 0);

  const passesMoveFilter =
    ch1 <= -minAbsChange1h() ||
    ch24 <= -minAbsChange24h();

  const passesVolumeFilter = safeNumber(volume24h, 0) >= minQuoteVolume24h();
  const hasDirectionalSide = side === TARGET_SCANNER_SIDE;
  const risingMove = isRisingMove({ change1h: ch1, change24h: ch24 });

  const hardBlockedByDirection =
    blockNoDirectionEnabled() &&
    (!hasDirectionalSide || risingMove);

  const hardBlockedByMove =
    blockSmallMoveEnabled() &&
    !passesMoveFilter;

  const hardBlockedByFake =
    blockFakeBreakoutEnabled() &&
    Boolean(fake.fakeBreakout);

  const hardBlocked =
    hardBlockedByDirection ||
    hardBlockedByMove ||
    hardBlockedByFake;

  const scannerGatePassed =
    !hardBlocked &&
    !risingMove &&
    passesMoveFilter &&
    hasDirectionalSide &&
    !fake.fakeBreakout;

  const analyzeEligible =
    !hardBlocked &&
    !risingMove &&
    hasDirectionalSide;

  const tradeDiscoveryOnly =
    !scannerGatePassed;

  return {
    passesMoveFilter,
    passesVolumeFilter,
    hasDirectionalSide,
    risingMove,

    hardBlocked,
    hardBlockedByDirection,
    hardBlockedByMove,
    hardBlockedByFake,

    scannerGatePassed,
    analyzeEligible,
    tradeDiscoveryOnly,
    discoveryOnly: tradeDiscoveryOnly,
    analyzeOnly: tradeDiscoveryOnly
  };
}

function normalizeShortCandidate(candidate = {}) {
  return {
    ...candidate,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    scannerSide: TARGET_TRADE_SIDE,
    actualScannerSide: TARGET_TRADE_SIDE,
    analysisSide: TARGET_TRADE_SIDE,

    directionalSide: TARGET_DASHBOARD_SIDE,
    inferredDirectionalSide: TARGET_DASHBOARD_SIDE,
    marketSide: TARGET_DASHBOARD_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    isMirrorMicroFamily: false,
    observationMirror: false,
    analysisMirror: false,
    mirrorAnalysisOnly: false
  };
}

async function analyzeTickerCandidate({
  ticker,
  snapshotId,
  startedAt,
  btcState,
  regime,
  getCandles
}) {
  const normalizedTicker = normalizeScannerTicker(ticker);

  if (!normalizedTicker) {
    return {
      candidate: null,
      skippedReason: 'INVALID_SYMBOL',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  const contractSymbol = normalizedTicker.contractSymbol;
  const baseSymbol = normalizedTicker.baseSymbol;

  if (!isValidUsdtFuturesContractSymbol(contractSymbol)) {
    return {
      candidate: null,
      skippedReason: 'INVALID_CONTRACT_SYMBOL',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  if (isBlockedBaseSymbol(baseSymbol)) {
    return {
      candidate: null,
      skippedReason: 'BLOCKED_BASE_SYMBOL',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  const candles15m = await getCandles(
    contractSymbol,
    '15m',
    candleLimit()
  );

  if (candles15m.length < 30) {
    return {
      candidate: null,
      skippedReason: 'INSUFFICIENT_CANDLES',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  const change1h = calcOneHourChange(candles15m);
  const change24h = safeNumber(normalizedTicker.change24h, 0);

  if (isRisingMove({ change1h, change24h })) {
    return {
      candidate: null,
      skippedReason: 'SHORT_ONLY_RISING_COIN_BLOCKED',
      skippedTradeSide: OPPOSITE_TRADE_SIDE
    };
  }

  const side = inferSide({
    change1h,
    change24h,
    btcState
  });

  if (side !== TARGET_SCANNER_SIDE) {
    return {
      candidate: null,
      skippedReason: 'SHORT_ONLY_NOT_BEARISH',
      skippedTradeSide: 'UNKNOWN'
    };
  }

  const fakeRaw = detectFakeBreakout({
    side,
    candles15m,
    btcState,
    lookback: fakeBreakoutLookback()
  });

  const fake = cleanFakeResult(fakeRaw);

  const gates = buildGateFlags({
    change1h,
    change24h,
    fake,
    side,
    volume24h: normalizedTicker.volume24h
  });

  if (gates.hardBlocked) {
    return {
      candidate: null,
      skippedReason: gates.hardBlockedByDirection
        ? 'NO_SHORT_DIRECTION'
        : gates.hardBlockedByMove
          ? 'SHORT_MOVE_TOO_SMALL'
          : 'SHORT_FAKE_BREAKOUT',
      skippedTradeSide: gates.risingMove ? OPPOSITE_TRADE_SIDE : TARGET_TRADE_SIDE
    };
  }

  const volumeExpansion = calcVolumeExpansion(candles15m, 20);

  const sideConfidenceLevel = sideConfidence({
    side,
    change1h,
    change24h
  });

  const scannerScore = calcScannerScore({
    change1h,
    change24h,
    volume24h: normalizedTicker.volume24h,
    volumeExpansion,
    sideConfidenceLevel,
    ...fake
  });

  const scannerReason = scannerReasonFrom({
    fake,
    volumeExpansion,
    passesMoveFilter: gates.passesMoveFilter,
    sideConfidenceLevel
  });

  const fingerprint = buildScannerFingerprint({
    baseSymbol,
    scannerReason,
    sideConfidenceLevel,
    change1h,
    change24h,
    volumeExpansion,
    btcState,
    regime,
    scannerGatePassed: gates.scannerGatePassed,
    analyzeEligible: gates.analyzeEligible,
    tradeDiscoveryOnly: gates.tradeDiscoveryOnly,
    ...fake
  });

  const lastClose = safeNumber(candles15m.at(-1)?.close, 0);
  const price = lastClose > 0
    ? lastClose
    : safeNumber(normalizedTicker.price, 0);

  const candidate = normalizeShortCandidate({
    snapshotId,

    symbol: baseSymbol,
    baseSymbol,
    contractSymbol,

    price,

    scannerScore,
    moveScore: scannerScore,

    change1h: Number(change1h.toFixed(3)),
    change24h: Number(change24h.toFixed(3)),

    volume24h: safeNumber(normalizedTicker.volume24h, 0),
    tickerVolume24h: safeNumber(normalizedTicker.tickerVolume24h ?? normalizedTicker.volume24h, 0),
    candleVolume24h: safeNumber(normalizedTicker.candleVolume24h ?? normalizedTicker.volume24h, 0),
    volumeSource: normalizedTicker.volumeSource || 'TICKER',

    volumeExpansion: Number(volumeExpansion.toFixed(3)),

    btcState,
    regime,

    sideConfidence: sideConfidenceLevel,

    scannerReason,
    ...fingerprint,

    ...fake,
    ...gates,

    scannerTs: startedAt
  });

  return {
    candidate,
    skippedReason: null,
    skippedTradeSide: null
  };
}

function countSkipped(results) {
  return results.reduce((acc, row) => {
    const reason = row?.skippedReason || (row?.candidate ? 'SELECTED' : 'UNKNOWN');

    acc[reason] = (acc[reason] || 0) + 1;

    return acc;
  }, {});
}

function sortCandidates(candidates = []) {
  return [...candidates].sort((a, b) => {
    const gateDelta = Number(Boolean(b.scannerGatePassed)) - Number(Boolean(a.scannerGatePassed));
    if (gateDelta !== 0) return gateDelta;

    const scoreDelta = safeNumber(b.scannerScore, 0) - safeNumber(a.scannerScore, 0);
    if (scoreDelta !== 0) return scoreDelta;

    const changeDelta = Math.max(0, -safeNumber(b.change1h, 0)) - Math.max(0, -safeNumber(a.change1h, 0));
    if (changeDelta !== 0) return changeDelta;

    const change24Delta = Math.max(0, -safeNumber(b.change24h, 0)) - Math.max(0, -safeNumber(a.change24h, 0));
    if (change24Delta !== 0) return change24Delta;

    return safeNumber(b.volume24h, 0) - safeNumber(a.volume24h, 0);
  });
}

function buildSnapshotSummary(snapshot) {
  return {
    ok: true,

    sideMode: 'SHORT_ONLY',
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    snapshotId: snapshot.snapshotId,
    createdAt: snapshot.createdAt,
    completedAt: snapshot.completedAt,
    durationMs: snapshot.durationMs,

    btcState: snapshot.btcState,
    regime: snapshot.regime,
    btcChange1h: snapshot.btcChange1h,
    btcChange24h: snapshot.btcChange24h,
    btcAtrPct: snapshot.btcAtrPct,

    rawCount: snapshot.rawCount,
    filteredUniverse: snapshot.filteredUniverse,

    candidatesCount: snapshot.candidatesCount,
    scannerGateCandidatesCount: snapshot.scannerGateCandidatesCount,
    analyzeOnlyCandidatesCount: snapshot.analyzeOnlyCandidatesCount,

    shortCandidatesCount: snapshot.shortCandidatesCount,
    longCandidatesCount: 0,

    maxSymbols: snapshot.maxSymbols,
    maxCandidates: snapshot.maxCandidates,

    strictFilters: snapshot.strictFilters,
    blockFakeBreakout: snapshot.blockFakeBreakout,
    blockNoDirection: snapshot.blockNoDirection,
    blockSmallMove: snapshot.blockSmallMove,

    minQuoteVolume24h: snapshot.minQuoteVolume24h,
    softMinQuoteVolume24h: snapshot.softMinQuoteVolume24h,
    minAbsChange1h: snapshot.minAbsChange1h,
    minAbsChange24h: snapshot.minAbsChange24h,

    skippedCounts: snapshot.skippedCounts,

    topSymbols: snapshot.topSymbols,
    scannerGateSymbols: snapshot.scannerGateSymbols,
    analyzeOnlySymbols: snapshot.analyzeOnlySymbols,

    candidates: snapshot.candidates
  };
}

export async function runScanner(options = {}) {
  const redis = getVolatileRedis();

  const startedAt = now();
  const snapshotId = randomId('scan_short');
  const getCandles = createCandleCache();

  const rawTickers = await fetchBitgetTickers();
  const universe = buildTickerUniverse(rawTickers);

  const btcContext = await buildBtcContext({
    universe,
    getCandles
  });

  const results = await mapConcurrent(
    universe,
    scannerConcurrency(),
    async (ticker) => analyzeTickerCandidate({
      ticker,
      snapshotId,
      startedAt,
      btcState: btcContext.btcState,
      regime: btcContext.regime,
      getCandles
    })
  );

  const allCandidates = results
    .map((row) => row?.candidate)
    .filter(Boolean)
    .filter(isTargetCandidate)
    .map(normalizeShortCandidate);

  const cleanCandidates = sortCandidates(allCandidates)
    .slice(0, scannerMaxCandidates());

  const scannerGateCandidates = cleanCandidates.filter((candidate) => candidate.scannerGatePassed);
  const analyzeOnlyCandidates = cleanCandidates.filter((candidate) => (
    candidate.tradeDiscoveryOnly ||
    candidate.discoveryOnly ||
    candidate.analyzeOnly ||
    !candidate.scannerGatePassed
  ));

  const completedAt = now();

  const rawLongCandidatesIgnored =
    results.filter((row) => row?.skippedTradeSide === OPPOSITE_TRADE_SIDE).length +
    results
      .map((row) => row?.candidate)
      .filter(Boolean)
      .filter(isOppositeCandidate)
      .length;

  const snapshot = {
    ok: true,
    persisted: true,

    sideMode: 'SHORT_ONLY',
    targetTradeSide: TARGET_TRADE_SIDE,
    targetScannerSide: TARGET_SCANNER_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    force: Boolean(options.force || options.forced),

    snapshotId,
    createdAt: startedAt,
    completedAt,
    durationMs: completedAt - startedAt,

    btcState: btcContext.btcState,
    regime: btcContext.regime,
    btcChange1h: btcContext.btcChange1h,
    btcChange24h: btcContext.btcChange24h,
    btcAtrPct: btcContext.btcAtrPct,

    rawCount: Array.isArray(rawTickers) ? rawTickers.length : 0,
    filteredUniverse: universe.length,

    candidatesCount: cleanCandidates.length,
    scannerGateCandidatesCount: scannerGateCandidates.length,
    analyzeOnlyCandidatesCount: analyzeOnlyCandidates.length,

    shortCandidatesCount: cleanCandidates.length,
    longCandidatesCount: 0,

    rawLongCandidatesIgnored,

    maxSymbols: scannerMaxSymbols(),
    maxCandidates: scannerMaxCandidates(),

    strictFilters: strictScannerFiltersEnabled(),
    blockFakeBreakout: blockFakeBreakoutEnabled(),
    blockNoDirection: blockNoDirectionEnabled(),
    blockSmallMove: blockSmallMoveEnabled(),

    minQuoteVolume24h: minQuoteVolume24h(),
    softMinQuoteVolume24h: softMinQuoteVolume24h(),
    minAbsChange1h: minAbsChange1h(),
    minAbsChange24h: minAbsChange24h(),

    skippedCounts: countSkipped(results),

    topSymbols: cleanCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    scannerGateSymbols: scannerGateCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    analyzeOnlySymbols: analyzeOnlyCandidates
      .slice(0, 20)
      .map((candidate) => candidate.symbol)
      .filter(Boolean),

    candidates: cleanCandidates
  };

  await setJson(
    redis,
    KEYS.scan.snapshot(snapshotId),
    snapshot,
    {
      ex: snapshotTtlSec()
    }
  );

  await setJson(
    redis,
    KEYS.scan.latest,
    buildSnapshotSummary(snapshot),
    {
      ex: snapshotTtlSec()
    }
  );

  return snapshot;
}