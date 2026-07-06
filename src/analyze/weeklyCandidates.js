// ================= FILE: src/analyze/weeklyCandidates.js =================

import { CONFIG } from '../config.js';
import { safeNumber, sideToTradeSide } from '../utils.js';
import {
  getWeeklyTradingCandidates as scoreWeeklyTradingCandidates,
  normalizeDashboardMicro
} from './scoring.js';
import { riskDecisionForEntry } from '../trade/positionSizing.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SHORT_MARKET_WEATHER_KEY_V1 = 'SHORT_MARKET_WEATHER_KEY_V1';

const PLAYBOOK_SELECTOR_VERSION = 'SHORT_CURRENT_MARKET_PLAYBOOK_SELECTOR_V1_OBSERVE';
const PLAYBOOK_REFRESH_VERSION = 'SHORT_PLAYBOOK_REFRESH_ON_WEATHER_CHANGE_V1';
const PLAYBOOK_FRESHNESS_VERSION = 'SHORT_PLAYBOOK_FRESHNESS_MAX_AGE_V1';
const FDR_VERSION = 'SHORT_MARKET_WEATHER_PLAYBOOK_FDR_FINAL_SLOTS_V1_OBSERVE';
const FEATURE_FLAGS_VERSION = 'SHORT_MARKET_WEATHER_FEATURE_FLAGS_V1_OBSERVE';

const DEFAULT_PLAYBOOK_MAX_AGE_MIN = 240;
const DEFAULT_FDR_Q = 0.1;

const SIGNAL_TYPE_TRADE_READY = 'TRADE_READY';
const SIGNAL_TYPE_WATCH_ONLY = 'WATCH_ONLY';
const SIGNAL_TYPE_OBSERVE_ONLY = 'OBSERVE_ONLY';
const SIGNAL_TYPE_BLOCKED = 'BLOCKED';

const PROOF_TIER_MICRO_MICRO_MARKET = 'MICRO_MICRO_MARKET_PROOF';
const PROOF_TIER_MICRO_MICRO_LIFETIME = 'MICRO_MICRO_LIFETIME_PROOF';
const PROOF_TIER_CHILD_75_MARKET = 'CHILD_75_MARKET_PROOF';
const PROOF_TIER_CHILD_75_LIFETIME = 'CHILD_75_LIFETIME_PROOF';
const PROOF_TIER_PARENT_15_MARKET = 'PARENT_15_MARKET_PROOF';
const PROOF_TIER_PARENT_15_LIFETIME = 'PARENT_15_LIFETIME_PROOF';
const PROOF_TIER_OBSERVATION_ONLY = 'OBSERVATION_ONLY';
const PROOF_TIER_EMPIRICAL_VETO = 'EMPIRICAL_VETO';
const PROOF_TIER_POLICY_BLOCKED = 'POLICY_BLOCKED';

const MAX_ALLOWED_RISK_BAND_HIGH = 'HIGH';
const MAX_ALLOWED_RISK_BAND_MEDIUM = 'MEDIUM';
const MAX_ALLOWED_RISK_BAND_LOW = 'LOW';
const MAX_ALLOWED_RISK_BAND_ZERO = 'ZERO';

function now() {
  return Date.now();
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text ? text.toUpperCase() : fallback;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }

  return null;
}

function round4(value) {
  return Number(safeNumber(value, 0).toFixed(4));
}

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function normalizeMarketWeatherRegime(value = '') {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  if (
    raw.includes('SQUEEZE') ||
    raw.includes('COMPRESSION') ||
    raw.includes('COMPRESS') ||
    raw.includes('COIL') ||
    raw.includes('LOW_VOL') ||
    raw.includes('TIGHT')
  ) {
    return 'SQUEEZE';
  }

  if (
    raw.includes('CHOP') ||
    raw.includes('RANGE') ||
    raw.includes('SIDEWAY') ||
    raw.includes('MIXED')
  ) {
    return 'CHOP';
  }

  if (
    raw.includes('TREND') ||
    raw.includes('MOMENTUM') ||
    raw.includes('IMPULSE') ||
    raw.includes('DIRECTIONAL')
  ) {
    return 'TREND';
  }

  return 'UNKNOWN';
}

function normalizeMarketWeatherTrendSide(value = '') {
  const raw = upper(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return 'BEARISH';
  if (direct === OPPOSITE_TRADE_SIDE) return 'BULLISH';

  if (
    raw.includes('BEAR') ||
    raw.includes('SELL') ||
    raw.includes('SHORT') ||
    raw.includes('DOWN') ||
    raw.includes('RED') ||
    raw.includes('RISK_OFF')
  ) {
    return 'BEARISH';
  }

  if (
    raw.includes('BULL') ||
    raw.includes('BUY') ||
    raw.includes('LONG') ||
    raw.includes('UP') ||
    raw.includes('GREEN') ||
    raw.includes('RISK_ON')
  ) {
    return 'BULLISH';
  }

  if (
    raw.includes('NEUTRAL') ||
    raw.includes('MIXED') ||
    raw.includes('FLAT')
  ) {
    return 'NEUTRAL';
  }

  return 'UNKNOWN';
}

function buildEntryMarketWeatherKey({ regime, trendSide } = {}) {
  return `${normalizeMarketWeatherRegime(regime)}|${normalizeMarketWeatherTrendSide(trendSide)}`;
}

function compactMarketWeatherRaw(raw = null) {
  if (!raw || typeof raw !== 'object') return null;

  const out = {
    ok: raw.ok,
    available: raw.available,
    version: raw.version,
    snapshotId: raw.snapshotId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    completedAt: raw.completedAt,

    marketWeatherRegime: raw.marketWeatherRegime,
    currentRegime: raw.currentRegime,
    regime: raw.regime,

    marketWeatherTrendSide: raw.marketWeatherTrendSide,
    currentTrendSide: raw.currentTrendSide,
    trendSide: raw.trendSide,

    confidence: raw.confidence,
    bullishPct: raw.bullishPct,
    bearishPct: raw.bearishPct,
    neutralPct: raw.neutralPct,
    squeezePct: raw.squeezePct,
    chopPct: raw.chopPct,
    trendPct: raw.trendPct,

    btcState: raw.btcState,
    btcChange1h: raw.btcChange1h,
    btcChange24h: raw.btcChange24h
  };

  for (const key of Object.keys(out)) {
    if (!hasValue(out[key])) delete out[key];
  }

  return Object.keys(out).length ? out : null;
}

function rawAvailableFields(raw = null) {
  if (!raw || typeof raw !== 'object') return [];

  return Object.keys(raw)
    .filter((key) => hasValue(raw[key]))
    .sort();
}

export function buildCurrentMarketWeatherContext(input = {}) {
  const raw = compactMarketWeatherRaw(
    input.currentMarketWeather ||
      input.marketWeather ||
      input.confirmedMarketWeather ||
      input.entryMarketWeatherRaw ||
      input.entryMarketWeather ||
      null
  );

  const regime = normalizeMarketWeatherRegime(firstValue(
    input.confirmedMarketWeatherRegime,
    input.currentMarketWeatherRegime,
    input.entryMarketWeatherRegime,
    raw?.marketWeatherRegime,
    raw?.currentRegime,
    raw?.regime,
    input.regime
  ));

  const trendSide = normalizeMarketWeatherTrendSide(firstValue(
    input.confirmedMarketWeatherTrendSide,
    input.currentMarketWeatherTrendSide,
    input.entryMarketWeatherTrendSide,
    raw?.marketWeatherTrendSide,
    raw?.currentTrendSide,
    raw?.trendSide,
    input.trendSide,
    input.btcState
  ));

  const key = upper(firstValue(
    input.confirmedMarketWeatherKey,
    input.currentMarketWeatherKey,
    input.entryMarketWeatherKey,
    buildEntryMarketWeatherKey({ regime, trendSide })
  ));

  const known =
    key !== 'UNKNOWN|UNKNOWN' &&
    regime !== 'UNKNOWN' &&
    trendSide !== 'UNKNOWN';

  const ts = now();

  return {
    currentMarketWeatherKey: key,
    confirmedMarketWeatherKey: key,
    currentMarketWeatherRegime: regime,
    confirmedMarketWeatherRegime: regime,
    currentMarketWeatherTrendSide: trendSide,
    confirmedMarketWeatherTrendSide: trendSide,
    currentMarketWeatherKnown: known,
    confirmedMarketWeatherKnown: known,

    currentMarketWeatherRaw: raw,
    currentMarketWeatherRawAvailableFields: rawAvailableFields(raw),

    currentMarketWeatherKeyVersion: input.currentMarketWeatherKeyVersion || SHORT_MARKET_WEATHER_KEY_V1,
    confirmedMarketWeatherKeyVersion: input.confirmedMarketWeatherKeyVersion || SHORT_MARKET_WEATHER_KEY_V1,

    currentMarketWeatherCapturedAt: safeNumber(
      input.currentMarketWeatherCapturedAt ||
        input.confirmedMarketWeatherCapturedAt ||
        raw?.createdAt ||
        raw?.updatedAt ||
        raw?.completedAt ||
        ts,
      ts
    )
  };
}

function playbookMaxAgeMin() {
  return Math.max(
    1,
    safeNumber(
      CONFIG.short?.playbook?.maxAgeMin ??
        CONFIG.short?.selection?.playbookMaxAgeMin ??
        CONFIG.selection?.playbookMaxAgeMin ??
        DEFAULT_PLAYBOOK_MAX_AGE_MIN,
      DEFAULT_PLAYBOOK_MAX_AGE_MIN
    )
  );
}

function fdrQ() {
  return Math.min(
    0.5,
    Math.max(
      0.001,
      safeNumber(
        CONFIG.short?.selection?.marketWeatherFdrQ ??
          CONFIG.selection?.marketWeatherFdrQ ??
          DEFAULT_FDR_Q,
        DEFAULT_FDR_Q
      )
    )
  );
}

export function marketWeatherFeatureFlags() {
  return {
    version: FEATURE_FLAGS_VERSION,

    capture: 'live',
    aggregation: 'live',
    selector: 'observe',
    sizingCap: 'observe',
    fdr: 'observe',
    discordTradeReady: 'validated_only',

    captureLive: true,
    aggregationLive: true,
    selectorObserveOnly: true,
    sizingCapObserveOnly: true,
    fdrObserveOnly: true,
    discordTradeReadyValidatedOnly: true,

    playbookMaxAgeMin: playbookMaxAgeMin(),
    playbookRefreshOnConfirmedWeatherChange: true,

    signalTypeDerived: true,
    signalTypeManuallySetAllowed: false,
    riskSourceOfTruth: 'riskFractionForEntry',

    unknownWeatherNeverTradeReady: true,
    empiricalVetoBeforeFallback: true,
    noMarketConditionalVeto: true
  };
}

function asRows(microsOrRows = {}) {
  if (Array.isArray(microsOrRows)) return microsOrRows.filter(Boolean);
  if (microsOrRows && typeof microsOrRows === 'object') {
    return Object.values(microsOrRows).filter(Boolean);
  }

  return [];
}

function microId(row = {}) {
  return String(
    row.selectedFamilyId ||
      row.selectedMicroMicroFamilyId ||
      row.exactMicroMicroFamilyId ||
      row.trueMicroMicroFamilyId ||
      row.microMicroFamilyId ||
      row.learningMicroFamilyId ||
      row.learningFamilyId ||
      row.id ||
      row.key ||
      ''
  ).trim().toUpperCase();
}

function childId(row = {}) {
  return String(
    row.selectedChildTrueMicroFamilyId ||
      row.childTrueMicroFamilyId ||
      row.base75ChildTrueMicroFamilyId ||
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      ''
  ).trim().toUpperCase();
}

function parentId(row = {}) {
  return String(
    row.selectedParentTrueMicroFamilyId ||
      row.parentTrueMicroFamilyId ||
      row.coarseMicroFamilyId ||
      row.baseMicroFamilyId ||
      row.parentMicroFamilyId ||
      row.parentMacroFamilyId ||
      ''
  ).trim().toUpperCase();
}

function rowEntryWeatherKey(row = {}) {
  return upper(
    row.entryMarketWeatherKey ||
      row.currentMarketWeatherKey ||
      row.confirmedMarketWeatherKey ||
      'UNKNOWN|UNKNOWN'
  );
}

function rowMatchesCurrentWeather(row = {}, context = {}) {
  const key = rowEntryWeatherKey(row);
  const currentKey = upper(context.confirmedMarketWeatherKey || context.currentMarketWeatherKey);

  if (!currentKey || currentKey === 'UNKNOWN|UNKNOWN') return false;

  if (key === currentKey) return true;

  const regime = normalizeMarketWeatherRegime(
    row.entryMarketWeatherRegime ||
      row.currentMarketWeatherRegime ||
      row.confirmedMarketWeatherRegime
  );

  const trend = normalizeMarketWeatherTrendSide(
    row.entryMarketWeatherTrendSide ||
      row.currentMarketWeatherTrendSide ||
      row.confirmedMarketWeatherTrendSide
  );

  return buildEntryMarketWeatherKey({ regime, trend }) === currentKey;
}

function inferProofTier(row = {}) {
  const explicit = upper(row.proofTier);

  if (explicit) return explicit;

  if (row.policyBlocked) return PROOF_TIER_POLICY_BLOCKED;
  if (row.empiricalVeto) return PROOF_TIER_EMPIRICAL_VETO;

  const proofSource = upper(row.proofSource);
  const lcb = safeNumber(row.shrunkLCB95AvgR ?? row.avgRLCB95 ?? row.lcb95AvgR, 0);

  if (lcb <= 0) return PROOF_TIER_OBSERVATION_ONLY;

  if (proofSource.includes('MICRO_MICRO') && proofSource.includes('REGIME')) return PROOF_TIER_MICRO_MICRO_MARKET;
  if (proofSource.includes('MICRO_MICRO')) return PROOF_TIER_MICRO_MICRO_LIFETIME;
  if (proofSource.includes('CHILD_75') && proofSource.includes('REGIME')) return PROOF_TIER_CHILD_75_MARKET;
  if (proofSource.includes('CHILD_75')) return PROOF_TIER_CHILD_75_LIFETIME;
  if (proofSource.includes('PARENT_15') && proofSource.includes('REGIME')) return PROOF_TIER_PARENT_15_MARKET;
  if (proofSource.includes('PARENT_15')) return PROOF_TIER_PARENT_15_LIFETIME;

  return PROOF_TIER_OBSERVATION_ONLY;
}

function maxAllowedRiskBandForProofTier(proofTier = '') {
  const tier = upper(proofTier);

  if (tier === PROOF_TIER_MICRO_MICRO_MARKET || tier === PROOF_TIER_MICRO_MICRO_LIFETIME) {
    return MAX_ALLOWED_RISK_BAND_HIGH;
  }

  if (tier === PROOF_TIER_CHILD_75_MARKET || tier === PROOF_TIER_CHILD_75_LIFETIME) {
    return MAX_ALLOWED_RISK_BAND_MEDIUM;
  }

  if (tier === PROOF_TIER_PARENT_15_MARKET || tier === PROOF_TIER_PARENT_15_LIFETIME) {
    return MAX_ALLOWED_RISK_BAND_LOW;
  }

  return MAX_ALLOWED_RISK_BAND_ZERO;
}

function policyBlocked(row = {}) {
  return Boolean(
    row.policyBlocked === true ||
      row.policyBlockedGate?.blocked === true ||
      row.policyBlockedGate?.policyBlocked === true ||
      upper(row.microMicroRuntimeStatus) === 'POLICY_BLOCKED'
  );
}

function empiricalVeto(row = {}) {
  return Boolean(
    row.empiricalVeto === true ||
      row.empiricalVetoGate?.triggered === true ||
      row.empiricalVetoGate?.empiricalVeto === true ||
      upper(row.microMicroRuntimeStatus) === 'EMPIRICAL_VETO'
  );
}

function pValueForCandidate(row = {}) {
  const explicit = safeNumber(row.fdrPValue ?? row.pValue, NaN);

  if (Number.isFinite(explicit)) return Math.min(1, Math.max(0.000001, explicit));

  const lcb = safeNumber(row.shrunkLCB95AvgR ?? row.avgRLCB95 ?? row.lcb95AvgR, 0);
  const completed = safeNumber(row.completed, 0);

  if (lcb > 0 && completed >= 35) return 0.049;
  if (lcb > 0 && completed >= 20) return 0.09;
  if (lcb > 0) return 0.2;

  return 1;
}

function applyBenjaminiHochberg(candidates = [], q = fdrQ()) {
  const rows = candidates
    .map((row, index) => ({
      index,
      pValue: pValueForCandidate(row)
    }))
    .sort((a, b) => a.pValue - b.pValue);

  const m = Math.max(1, rows.length);
  let maxAcceptedRank = -1;

  rows.forEach((row, i) => {
    const threshold = ((i + 1) / m) * q;

    if (row.pValue <= threshold) {
      maxAcceptedRank = i;
    }
  });

  const accepted = new Set(
    rows.slice(0, maxAcceptedRank + 1).map((row) => row.index)
  );

  return candidates.map((row, index) => ({
    ...row,
    fdrVersion: FDR_VERSION,
    fdrQ: q,
    fdrPValue: pValueForCandidate(row),
    fdrPassed: accepted.has(index),
    fdrObserveOnly: true
  }));
}

function baseReason(row = {}, context = {}) {
  if (!context.confirmedMarketWeatherKnown) return 'MARKET_WEATHER_UNKNOWN';
  if (!row.weatherMatched) return 'NO_PROOF_FOR_CONFIRMED_WEATHER';
  if (!row.playbookFresh) return row.playbookStaleReason || 'PLAYBOOK_MISSING_OR_STALE_FOR_CONFIRMED_WEATHER';
  if (policyBlocked(row)) return row.policyBlockedReason || row.policyBlockedGate?.reason || 'POLICY_BLOCKED';
  if (empiricalVeto(row)) return row.empiricalVetoReason || row.empiricalVetoGate?.empiricalVetoReason || 'EXACT_MICRO_MICRO_LIFETIME_LCB95_NEGATIVE';

  const lcb = safeNumber(row.shrunkLCB95AvgR ?? row.avgRLCB95 ?? row.lcb95AvgR, 0);

  if (lcb <= 0) return 'NO_POSITIVE_SHRUNK_LCB95_FOR_CONFIRMED_WEATHER';
  if (!row.fdrPassed) return 'FDR_NOT_PASSED_FOR_FINAL_SLOT';
  if (safeNumber(row.riskFractionForEntry, 0) <= 0) return 'RISK_FRACTION_ZERO';

  return 'CURRENT_MARKET_TRADE_READY';
}

function preRiskCandidateAllowed(row = {}, context = {}) {
  if (!context.confirmedMarketWeatherKnown) return false;
  if (!row.weatherMatched) return false;
  if (!row.playbookFresh) return false;
  if (policyBlocked(row)) return false;
  if (empiricalVeto(row)) return false;
  if (safeNumber(row.shrunkLCB95AvgR ?? row.avgRLCB95 ?? row.lcb95AvgR, 0) <= 0) return false;
  if (row.fdrPassed !== true) return false;

  return true;
}

function safeRiskDecision(row = {}, context = {}) {
  if (!preRiskCandidateAllowed(row, context)) {
    return {
      riskFractionForEntry: 0,
      riskFraction: 0,
      reason: baseReason(row, context),
      source: 'WEEKLY_CANDIDATES_PRE_RISK_GATE'
    };
  }

  const proofTier = inferProofTier(row);
  const maxAllowedRiskBand = maxAllowedRiskBandForProofTier(proofTier);

  try {
    const decision = riskDecisionForEntry({
      ...row,
      tradeSide: TARGET_TRADE_SIDE,
      side: TARGET_DASHBOARD_SIDE,
      proofTier,
      maxAllowedRiskBand,
      shrunkLCB95AvgR: safeNumber(row.shrunkLCB95AvgR ?? row.avgRLCB95 ?? row.lcb95AvgR, 0),
      empiricalVeto: false,
      policyBlocked: false,
      signalType: SIGNAL_TYPE_TRADE_READY
    });

    const risk = safeNumber(
      decision?.riskFractionForEntry ??
        decision?.riskFraction ??
        decision?.fraction ??
        0,
      0
    );

    return {
      ...(decision || {}),
      riskFractionForEntry: Math.max(0, risk),
      riskFraction: Math.max(0, risk),
      source: decision?.source || decision?.riskFractionForEntrySource || 'positionSizing.riskDecisionForEntry'
    };
  } catch (error) {
    return {
      riskFractionForEntry: 0,
      riskFraction: 0,
      reason: 'POSITION_SIZING_ERROR',
      error: error?.message || String(error),
      source: 'positionSizing.riskDecisionForEntry'
    };
  }
}

function deriveSignalType(row = {}, context = {}) {
  if (!context.confirmedMarketWeatherKnown) return SIGNAL_TYPE_OBSERVE_ONLY;
  if (policyBlocked(row) || empiricalVeto(row)) return SIGNAL_TYPE_BLOCKED;

  if (!row.weatherMatched || !row.playbookFresh) return SIGNAL_TYPE_OBSERVE_ONLY;

  const lcb = safeNumber(row.shrunkLCB95AvgR ?? row.avgRLCB95 ?? row.lcb95AvgR, 0);
  const risk = safeNumber(row.riskFractionForEntry, 0);

  if (lcb <= 0) return SIGNAL_TYPE_OBSERVE_ONLY;
  if (row.fdrPassed !== true) return SIGNAL_TYPE_WATCH_ONLY;
  if (risk <= 0) return SIGNAL_TYPE_WATCH_ONLY;

  return SIGNAL_TYPE_TRADE_READY;
}

function signalRank(signalType = '') {
  const type = upper(signalType);

  if (type === SIGNAL_TYPE_TRADE_READY) return 0;
  if (type === SIGNAL_TYPE_WATCH_ONLY) return 1;
  if (type === SIGNAL_TYPE_OBSERVE_ONLY) return 2;
  if (type === SIGNAL_TYPE_BLOCKED) return 3;

  return 4;
}

function compareCandidates(a, b) {
  return (
    signalRank(a.signalType) - signalRank(b.signalType) ||
    Number(b.weatherMatched === true) - Number(a.weatherMatched === true) ||
    Number(b.playbookFresh === true) - Number(a.playbookFresh === true) ||
    safeNumber(b.riskFractionForEntry, 0) - safeNumber(a.riskFractionForEntry, 0) ||
    safeNumber(b.shrunkLCB95AvgR, 0) - safeNumber(a.shrunkLCB95AvgR, 0) ||
    safeNumber(b.shrunkAvgR, 0) - safeNumber(a.shrunkAvgR, 0) ||
    safeNumber(b.avgRLCB95, 0) - safeNumber(a.avgRLCB95, 0) ||
    safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0) ||
    safeNumber(b.profitFactor, 0) - safeNumber(a.profitFactor, 0) ||
    safeNumber(a.directSLPct, 0) - safeNumber(b.directSLPct, 0) ||
    safeNumber(a.avgCostR, 0) - safeNumber(b.avgCostR, 0) ||
    microId(a).localeCompare(microId(b))
  );
}

function playbookTimestamp(row = {}, fallbackTs = now()) {
  return safeNumber(
    row.playbookUpdatedAt ||
      row.currentMarketPlaybookUpdatedAt ||
      row.rotationUpdatedAt ||
      row.selectedAt ||
      row.updatedAt ||
      row.createdAt ||
      fallbackTs,
    fallbackTs
  );
}

export function isFreshConfirmedMarketWeather(playbook = {}, options = {}) {
  const maxAgeMin = Math.max(1, safeNumber(options.maxAgeMin, playbookMaxAgeMin()));
  const ts = safeNumber(options.nowMs, now());
  const updatedAt = playbookTimestamp(playbook, 0);
  const ageMin = updatedAt > 0 ? (ts - updatedAt) / 60000 : Infinity;
  const fresh = Number.isFinite(ageMin) && ageMin <= maxAgeMin;

  return {
    version: PLAYBOOK_FRESHNESS_VERSION,
    fresh,
    playbookFresh: fresh,
    ageMin: Number.isFinite(ageMin) ? round4(ageMin) : null,
    maxAgeMin,
    updatedAt: updatedAt || null,
    reason: fresh ? 'PLAYBOOK_FRESH' : 'PLAYBOOK_STALE_OR_MISSING'
  };
}

export function needsPlaybookRefresh(previousPlaybook = {}, nextContext = {}, options = {}) {
  const maxAgeMin = Math.max(1, safeNumber(options.maxAgeMin, playbookMaxAgeMin()));
  const prevKey = upper(previousPlaybook.confirmedMarketWeatherKey || previousPlaybook.currentMarketWeatherKey);
  const nextKey = upper(nextContext.confirmedMarketWeatherKey || nextContext.currentMarketWeatherKey);
  const changed = Boolean(prevKey && nextKey && prevKey !== nextKey);

  const freshness = isFreshConfirmedMarketWeather(previousPlaybook, {
    ...options,
    maxAgeMin
  });

  return {
    version: PLAYBOOK_REFRESH_VERSION,
    refreshRequired: changed || !freshness.fresh,
    confirmedMarketWeatherChanged: changed,
    previousMarketWeatherKey: prevKey || null,
    nextMarketWeatherKey: nextKey || null,
    playbookFresh: freshness.fresh,
    playbookAgeMin: freshness.ageMin,
    maxAgeMin,
    reason: changed
      ? 'CONFIRMED_MARKET_WEATHER_CHANGED'
      : freshness.fresh
        ? 'PLAYBOOK_FRESH'
        : 'PLAYBOOK_MISSING_OR_STALE'
  };
}

function blockedCandidate(reason = 'NO_CANDIDATES', context = {}) {
  return {
    id: 'NO_CURRENT_MARKET_PLAYBOOK_CANDIDATE',
    key: 'NO_CURRENT_MARKET_PLAYBOOK_CANDIDATE',

    selectedFamilyId: null,
    selectedMicroMicroFamilyId: null,
    selectedChildTrueMicroFamilyId: null,
    selectedParentTrueMicroFamilyId: null,

    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true,

    currentMarketWeatherKey: context.currentMarketWeatherKey || 'UNKNOWN|UNKNOWN',
    confirmedMarketWeatherKey: context.confirmedMarketWeatherKey || context.currentMarketWeatherKey || 'UNKNOWN|UNKNOWN',
    currentMarketWeatherRegime: context.currentMarketWeatherRegime || 'UNKNOWN',
    confirmedMarketWeatherRegime: context.confirmedMarketWeatherRegime || context.currentMarketWeatherRegime || 'UNKNOWN',
    currentMarketWeatherTrendSide: context.currentMarketWeatherTrendSide || 'UNKNOWN',
    confirmedMarketWeatherTrendSide: context.confirmedMarketWeatherTrendSide || context.currentMarketWeatherTrendSide || 'UNKNOWN',
    confirmedMarketWeatherKnown: Boolean(context.confirmedMarketWeatherKnown),

    familyResolution: 'NONE',
    marketResolution: 'NONE',
    proofSource: 'NO_PROOF',
    proofTier: PROOF_TIER_OBSERVATION_ONLY,

    signalType: context.confirmedMarketWeatherKnown ? SIGNAL_TYPE_BLOCKED : SIGNAL_TYPE_OBSERVE_ONLY,
    shrunkAvgR: 0,
    shrunkLCB95AvgR: 0,

    empiricalVeto: false,
    policyBlocked: context.confirmedMarketWeatherKnown,
    riskFractionForEntry: 0,
    riskFractionForEntrySource: 'NO_CANDIDATE',

    weatherMatched: false,
    playbookFresh: false,
    fdrPassed: false,

    reason,
    whySelected: null,
    whyBlocked: reason,

    selectorMode: 'OBSERVE',
    discordAllowed: false,
    discordReason: reason,

    alwaysReturnBestCandidate: true,
    alwaysReturnBestCandidateDoesNotMeanAlwaysTrade: true,

    marketWeatherFeatureFlags: marketWeatherFeatureFlags(),
    playbookSelectorVersion: PLAYBOOK_SELECTOR_VERSION
  };
}

function normalizeCandidate(row = {}, context = {}, options = {}) {
  const ts = safeNumber(options.nowMs, now());
  const weatherMatched = rowMatchesCurrentWeather(row, context);
  const proofTier = inferProofTier(row);
  const maxAllowedRiskBand = maxAllowedRiskBandForProofTier(proofTier);

  const freshness = isFreshConfirmedMarketWeather(row, {
    nowMs: ts,
    maxAgeMin: options.playbookMaxAgeMin || playbookMaxAgeMin()
  });

  const base = {
    ...row,

    selectedFamilyId: microId(row) || null,
    selectedMicroMicroFamilyId: microId(row) || null,
    selectedChildTrueMicroFamilyId: childId(row) || null,
    selectedParentTrueMicroFamilyId: parentId(row) || null,

    tradeSide: TARGET_TRADE_SIDE,
    side: TARGET_DASHBOARD_SIDE,
    shortOnly: true,
    longDisabled: true,

    currentMarketWeatherKey: context.currentMarketWeatherKey,
    confirmedMarketWeatherKey: context.confirmedMarketWeatherKey,
    currentMarketWeatherRegime: context.currentMarketWeatherRegime,
    confirmedMarketWeatherRegime: context.confirmedMarketWeatherRegime,
    currentMarketWeatherTrendSide: context.currentMarketWeatherTrendSide,
    confirmedMarketWeatherTrendSide: context.confirmedMarketWeatherTrendSide,
    confirmedMarketWeatherKnown: context.confirmedMarketWeatherKnown,

    entryMarketWeatherKey: row.entryMarketWeatherKey || row.currentMarketWeatherKey || 'UNKNOWN|UNKNOWN',
    entryMarketWeatherRegime: row.entryMarketWeatherRegime || row.currentMarketWeatherRegime || 'UNKNOWN',
    entryMarketWeatherTrendSide: row.entryMarketWeatherTrendSide || row.currentMarketWeatherTrendSide || 'UNKNOWN',

    weatherMatched,
    weatherMatchReason: weatherMatched ? 'MATCHES_CONFIRMED_MARKET_WEATHER' : 'DOES_NOT_MATCH_CONFIRMED_MARKET_WEATHER',

    playbookFresh: freshness.fresh,
    playbookAgeMin: freshness.ageMin,
    playbookMaxAgeMin: freshness.maxAgeMin,
    playbookUpdatedAt: freshness.updatedAt,
    playbookFreshnessVersion: PLAYBOOK_FRESHNESS_VERSION,
    playbookStaleReason: freshness.fresh ? null : freshness.reason,

    familyResolution: row.familyResolution || 'MICRO_MICRO',
    marketResolution: row.marketResolution || (weatherMatched ? 'REGIME_TREND' : 'LIFETIME'),
    proofSource: row.proofSource || 'UNKNOWN_PROOF_SOURCE',
    proofTier,
    maxAllowedRiskBand,

    shrunkAvgR: round6(row.shrunkAvgR ?? row.avgR ?? 0),
    shrunkLCB95AvgR: round6(row.shrunkLCB95AvgR ?? row.avgRLCB95 ?? row.lcb95AvgR ?? 0),

    empiricalVeto: empiricalVeto(row),
    empiricalVetoReason: row.empiricalVetoReason || row.empiricalVetoGate?.empiricalVetoReason || null,
    policyBlocked: policyBlocked(row),
    policyBlockedReason: row.policyBlockedReason || row.policyBlockedGate?.reason || null,

    selectorMode: 'OBSERVE',
    sizingCapMode: 'OBSERVE',
    fdrMode: 'OBSERVE',
    discordTradeReadyMode: 'VALIDATION_REQUIRED',

    playbookSelectorVersion: PLAYBOOK_SELECTOR_VERSION,
    marketWeatherFeatureFlags: marketWeatherFeatureFlags()
  };

  const riskDecision = safeRiskDecision(base, context);

  const withRisk = {
    ...base,
    riskDecision,
    riskFractionForEntry: round6(riskDecision.riskFractionForEntry),
    riskFractionForEntrySource: riskDecision.source || 'positionSizing.riskDecisionForEntry'
  };

  const signalType = deriveSignalType(withRisk, context);
  const reason = baseReason(
    {
      ...withRisk,
      signalType
    },
    context
  );

  return {
    ...withRisk,

    signalType,
    reason,

    whySelected: signalType === SIGNAL_TYPE_TRADE_READY
      ? 'BEST_CONFIRMED_MARKET_WEATHER_TRADE_READY'
      : signalType === SIGNAL_TYPE_WATCH_ONLY
        ? 'BEST_CONFIRMED_MARKET_WEATHER_WATCH_ONLY'
        : signalType === SIGNAL_TYPE_OBSERVE_ONLY
          ? 'BEST_CONFIRMED_MARKET_WEATHER_OBSERVE_ONLY'
          : null,

    whyBlocked: signalType === SIGNAL_TYPE_BLOCKED || reason !== 'CURRENT_MARKET_TRADE_READY'
      ? reason
      : null,

    discordAllowed:
      signalType === SIGNAL_TYPE_TRADE_READY &&
      withRisk.riskFractionForEntry > 0 &&
      withRisk.weatherMatched === true &&
      withRisk.playbookFresh === true &&
      withRisk.fdrPassed === true &&
      withRisk.policyBlocked !== true &&
      withRisk.empiricalVeto !== true,

    discordReason:
      signalType === SIGNAL_TYPE_TRADE_READY
        ? 'VALIDATED_TRADE_READY_CURRENT_MARKET'
        : reason,

    signalTypeDerived: true,
    signalTypeManuallySetAllowed: false,
    riskSourceOfTruth: 'riskFractionForEntry',
    noForcedSignals: true
  };
}

export function buildCurrentMarketPlaybook(microsOrRows = {}, options = {}) {
  const ts = safeNumber(options.nowMs, now());
  const context = buildCurrentMarketWeatherContext(options);

  const sourceCandidates = options.preRankedCandidates
    ? asRows(options.preRankedCandidates)
    : scoreWeeklyTradingCandidates(microsOrRows, {
        ...options,
        currentMarketWeatherKey: context.confirmedMarketWeatherKey,
        currentMarketWeatherRegime: context.confirmedMarketWeatherRegime,
        currentMarketWeatherTrendSide: context.confirmedMarketWeatherTrendSide,
        hardTradeReadyOnly: false,
        requireFdrForTradeReady: false
      });

  const rows = asRows(sourceCandidates);

  if (!rows.length) {
    const fallback = blockedCandidate('NO_MICRO_MICRO_CANDIDATES_AVAILABLE', context);

    return {
      version: PLAYBOOK_SELECTOR_VERSION,
      createdAt: ts,
      updatedAt: ts,

      ...context,

      playbookFresh: false,
      playbookAgeMin: null,
      playbookMaxAgeMin: playbookMaxAgeMin(),

      selectedFamilyId: null,
      selectedCandidate: fallback,
      bestForCurrentMarket: fallback,
      candidates: [fallback],

      tradeReady: null,
      watchOnly: null,
      observeOnly: fallback,
      blocked: fallback,

      reason: fallback.reason,
      selectorMode: 'OBSERVE',
      marketWeatherFeatureFlags: marketWeatherFeatureFlags()
    };
  }

  const weatherFilteredRows = rows
    .filter((row) => !options.onlyWeatherMatched || rowMatchesCurrentWeather(row, context));

  const fdrRows = applyBenjaminiHochberg(
    weatherFilteredRows.length ? weatherFilteredRows : rows,
    safeNumber(options.fdrQ, fdrQ())
  );

  const normalized = fdrRows
    .map((row) => normalizeCandidate(row, context, { ...options, nowMs: ts }))
    .sort(compareCandidates)
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));

  const best = normalized[0] || blockedCandidate('NO_CANDIDATE_AFTER_NORMALIZATION', context);

  const tradeReady = normalized.find((row) => row.signalType === SIGNAL_TYPE_TRADE_READY) || null;
  const watchOnly = normalized.find((row) => row.signalType === SIGNAL_TYPE_WATCH_ONLY) || null;
  const observeOnly = normalized.find((row) => row.signalType === SIGNAL_TYPE_OBSERVE_ONLY) || null;
  const blocked = normalized.find((row) => row.signalType === SIGNAL_TYPE_BLOCKED) || null;

  const selectedCandidate = tradeReady || watchOnly || observeOnly || blocked || best;

  return {
    version: PLAYBOOK_SELECTOR_VERSION,
    refreshVersion: PLAYBOOK_REFRESH_VERSION,
    createdAt: ts,
    updatedAt: ts,

    ...context,

    playbookFresh: Boolean(selectedCandidate?.playbookFresh),
    playbookAgeMin: selectedCandidate?.playbookAgeMin ?? null,
    playbookMaxAgeMin: playbookMaxAgeMin(),
    playbookUpdatedAt: selectedCandidate?.playbookUpdatedAt ?? null,

    selectedFamilyId: selectedCandidate?.selectedFamilyId || null,
    selectedMicroMicroFamilyId: selectedCandidate?.selectedMicroMicroFamilyId || null,
    selectedChildTrueMicroFamilyId: selectedCandidate?.selectedChildTrueMicroFamilyId || null,
    selectedParentTrueMicroFamilyId: selectedCandidate?.selectedParentTrueMicroFamilyId || null,

    familyResolution: selectedCandidate?.familyResolution || 'NONE',
    marketResolution: selectedCandidate?.marketResolution || 'NONE',
    proofSource: selectedCandidate?.proofSource || 'NO_PROOF',
    proofTier: selectedCandidate?.proofTier || PROOF_TIER_OBSERVATION_ONLY,
    signalType: selectedCandidate?.signalType || SIGNAL_TYPE_OBSERVE_ONLY,
    shrunkAvgR: selectedCandidate?.shrunkAvgR ?? 0,
    shrunkLCB95AvgR: selectedCandidate?.shrunkLCB95AvgR ?? 0,
    empiricalVeto: Boolean(selectedCandidate?.empiricalVeto),
    policyBlocked: Boolean(selectedCandidate?.policyBlocked),
    riskFractionForEntry: selectedCandidate?.riskFractionForEntry ?? 0,
    reason: selectedCandidate?.reason || 'NO_REASON',

    selectedCandidate,
    bestForCurrentMarket: selectedCandidate,

    tradeReady,
    watchOnly,
    observeOnly,
    blocked,

    candidates: normalized,

    counts: {
      total: normalized.length,
      weatherMatched: normalized.filter((row) => row.weatherMatched).length,
      tradeReady: normalized.filter((row) => row.signalType === SIGNAL_TYPE_TRADE_READY).length,
      watchOnly: normalized.filter((row) => row.signalType === SIGNAL_TYPE_WATCH_ONLY).length,
      observeOnly: normalized.filter((row) => row.signalType === SIGNAL_TYPE_OBSERVE_ONLY).length,
      blocked: normalized.filter((row) => row.signalType === SIGNAL_TYPE_BLOCKED).length,
      empiricalVeto: normalized.filter((row) => row.empiricalVeto).length,
      policyBlocked: normalized.filter((row) => row.policyBlocked).length
    },

    selectorMode: 'OBSERVE',
    sizingCapMode: 'OBSERVE',
    fdrMode: 'OBSERVE',
    discordTradeReadyMode: 'VALIDATION_REQUIRED',
    discordAllowed: Boolean(selectedCandidate?.discordAllowed),
    discordReason: selectedCandidate?.discordReason || selectedCandidate?.reason || 'NO_CANDIDATE',

    noForcedSignals: true,
    alwaysReturnBestCandidate: true,
    alwaysReturnBestCandidateDoesNotMeanAlwaysTrade: true,

    marketWeatherFeatureFlags: marketWeatherFeatureFlags()
  };
}

export function refreshPlaybookIfNeeded(previousPlaybook = {}, microsOrRows = {}, options = {}) {
  const context = buildCurrentMarketWeatherContext(options);
  const refresh = needsPlaybookRefresh(previousPlaybook, context, options);

  if (!refresh.refreshRequired) {
    return {
      refreshed: false,
      refresh,
      playbook: {
        ...previousPlaybook,
        refresh,
        playbookFresh: true
      }
    };
  }

  try {
    const playbook = buildCurrentMarketPlaybook(microsOrRows, {
      ...options,
      ...context
    });

    return {
      refreshed: true,
      refresh,
      playbook
    };
  } catch (error) {
    const failed = {
      ...blockedCandidate('PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER', context),
      error: error?.message || String(error),
      playbookFresh: false,
      signalType: SIGNAL_TYPE_OBSERVE_ONLY,
      riskFractionForEntry: 0,
      discordAllowed: false,
      discordReason: 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER'
    };

    return {
      refreshed: false,
      refresh: {
        ...refresh,
        refreshFailed: true,
        reason: 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER'
      },
      playbook: {
        version: PLAYBOOK_SELECTOR_VERSION,
        ...context,
        selectedCandidate: failed,
        bestForCurrentMarket: failed,
        candidates: [failed],
        signalType: SIGNAL_TYPE_OBSERVE_ONLY,
        riskFractionForEntry: 0,
        reason: 'PLAYBOOK_MISSING_FOR_CONFIRMED_WEATHER',
        playbookFresh: false,
        discordAllowed: false
      }
    };
  }
}

export function selectBestForCurrentMarket(microsOrRows = {}, options = {}) {
  return buildCurrentMarketPlaybook(microsOrRows, options).selectedCandidate;
}

export function buildWeeklyCandidates(microsOrRows = {}, options = {}) {
  const playbook = buildCurrentMarketPlaybook(microsOrRows, options);

  return {
    ...playbook,
    rows: playbook.candidates,
    best: playbook.selectedCandidate,
    bestForCurrentMarket: playbook.bestForCurrentMarket
  };
}

export function getWeeklyTradingCandidates(microsOrRows = {}, options = {}) {
  const playbook = buildCurrentMarketPlaybook(microsOrRows, options);

  return playbook.candidates.map((row, index) => {
    try {
      return normalizeDashboardMicro(row, index + 1);
    } catch {
      return {
        ...row,
        rank: index + 1
      };
    }
  });
}

export default {
  buildCurrentMarketWeatherContext,
  buildCurrentMarketPlaybook,
  buildWeeklyCandidates,
  getWeeklyTradingCandidates,
  selectBestForCurrentMarket,
  refreshPlaybookIfNeeded,
  needsPlaybookRefresh,
  isFreshConfirmedMarketWeather,
  marketWeatherFeatureFlags
};