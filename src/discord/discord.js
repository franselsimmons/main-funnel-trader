// ================= FILE: src/discord/discord.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, pushJsonLog } from '../redis.js';
import {
  normalizeBaseSymbol,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const TARGET_TRADE_SIDE = 'SHORT';
const TARGET_DASHBOARD_SIDE = 'bear';
const OPPOSITE_TRADE_SIDE = 'LONG';

const SOURCE_VIRTUAL = 'VIRTUAL';
const SOURCE_REAL = 'REAL';
const SOURCE_LIVE = 'LIVE';
const SOURCE_TRADE = 'TRADE';
const SOURCE_SHADOW = 'SHADOW';

const DISCORD_LIMITS = {
  fieldName: 256,
  fieldValue: 1024
};

const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'DOWN',
  'DOWNSIDE'
]);

const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'UP',
  'UPSIDE'
]);

const REAL_ORDER_SOURCES = new Set([
  SOURCE_REAL,
  SOURCE_LIVE,
  SOURCE_TRADE,
  'ENTRY',
  'ORDER',
  'BITGET'
]);

function nowIso() {
  return new Date().toISOString();
}

function discordConfig() {
  return {
    enabled: CONFIG.discord?.enabled !== false,
    webhookUrl: CONFIG.discord?.webhookUrl || '',
    timeoutMs: Math.max(500, safeNumber(CONFIG.discord?.timeoutMs, 2500)),
    logLimit: Math.max(1, Math.floor(safeNumber(CONFIG.discord?.logLimit, 250))),

    sendRotationReports: CONFIG.discord?.sendRotationReports === true,
    sendResetReports: CONFIG.discord?.sendResetReports !== false
  };
}

function truncate(value, max = 1024) {
  const text = String(value ?? '');

  if (text.length <= max) return text;

  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function field(name, value, inline = true) {
  return {
    name: truncate(name || 'Field', DISCORD_LIMITS.fieldName),
    value: truncate(value ?? 'NA', DISCORD_LIMITS.fieldValue) || 'NA',
    inline
  };
}

function fmtPrice(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(6);

  return n.toFixed(10);
}

function fmtPct(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${(n * 100).toFixed(2)}%`;
}

function fmtPctSmart(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  const ratio = Math.abs(n) > 1 ? n / 100 : n;

  return `${(ratio * 100).toFixed(1)}%`;
}

function fmtR(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;
}

function fmtNumber(value, decimals = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return n.toFixed(decimals);
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('LONG_DISABLED', '')
    .replaceAll('LONGDISABLED', '')
    .replaceAll('BLOCK_LONG', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('SHORT_DISABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_MODE', 'SHORT')
    .replaceAll('SHORT_ONLY', 'SHORT')
    .replaceAll('SHORT-ONLY', 'SHORT');
}

function normalizeSource(value) {
  const raw = upper(value || SOURCE_VIRTUAL, SOURCE_VIRTUAL);

  if (raw === SOURCE_VIRTUAL) return SOURCE_VIRTUAL;
  if (raw === SOURCE_SHADOW) return SOURCE_SHADOW;
  if (raw === SOURCE_REAL) return SOURCE_REAL;
  if (raw === SOURCE_LIVE) return SOURCE_LIVE;
  if (raw === SOURCE_TRADE) return SOURCE_TRADE;

  return raw;
}

function normalizeSideToken(value) {
  const direct = sideToTradeSide(value);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';
  if (SHORT_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (LONG_TOKENS.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const shortPatterns = [
    'SHORT',
    'BEAR',
    'BEARISH',
    'SELL',
    'SIDE_SHORT',
    'TRADE_SIDE_SHORT',
    'TRADESIDE_SHORT',
    'POSITION_SIDE_SHORT',
    'POSITIONSIDE_SHORT',
    'DIRECTION_SHORT',
    'SIDE_BEAR',
    'TRADE_SIDE_BEAR',
    'DIRECTION_BEAR',
    'SIDE_SELL',
    'DIRECTION_SELL',
    'MICRO_SHORT',
    'FAMILY_SHORT'
  ];

  const longPatterns = [
    'LONG',
    'BULL',
    'BULLISH',
    'BUY',
    'SIDE_LONG',
    'TRADE_SIDE_LONG',
    'TRADESIDE_LONG',
    'POSITION_SIDE_LONG',
    'POSITIONSIDE_LONG',
    'DIRECTION_LONG',
    'SIDE_BULL',
    'TRADE_SIDE_BULL',
    'DIRECTION_BULL',
    'SIDE_BUY',
    'DIRECTION_BUY',
    'MICRO_LONG',
    'FAMILY_LONG'
  ];

  const hit = (patterns) => patterns.some((pattern) => (
    normalized === pattern ||
    normalized.startsWith(`${pattern}_`) ||
    normalized.endsWith(`_${pattern}`) ||
    normalized.includes(`_${pattern}_`)
  ));

  const longHit = hit(longPatterns);
  const shortHit = hit(shortPatterns);

  if (longHit && !shortHit) return OPPOSITE_TRADE_SIDE;
  if (shortHit && !longHit) return TARGET_TRADE_SIDE;

  if (shortHit && longHit) {
    if (raw.includes('TRADE_SIDE=SHORT') || raw.includes('TRADESIDE=SHORT')) return TARGET_TRADE_SIDE;
    if (raw.includes('TRADE_SIDE=LONG') || raw.includes('TRADESIDE=LONG')) return OPPOSITE_TRADE_SIDE;
    if (raw.includes('MICRO_SHORT_')) return TARGET_TRADE_SIDE;
    if (raw.includes('MICRO_LONG_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function definitionParts(payload = {}) {
  return [
    payload.definition,
    payload.microDefinition,
    payload.macroDefinition,
    payload.parentDefinition,

    ...(Array.isArray(payload.definitionParts) ? payload.definitionParts : []),
    ...(Array.isArray(payload.microDefinitionParts) ? payload.microDefinitionParts : []),
    ...(Array.isArray(payload.macroDefinitionParts) ? payload.macroDefinitionParts : []),
    ...(Array.isArray(payload.parentDefinitionParts) ? payload.parentDefinitionParts : []),
    ...(Array.isArray(payload.executionFingerprintParts) ? payload.executionFingerprintParts : [])
  ]
    .map((value) => upper(value))
    .filter(Boolean);
}

function idHaystack(payload = {}) {
  return [
    payload.familyId,
    payload.family,
    payload.baseFamilyId,

    payload.microFamilyId,
    payload.trueMicroFamilyId,
    payload.id,
    payload.key,

    payload.coarseMicroFamilyId,
    payload.baseMicroFamilyId,
    payload.legacyMicroFamilyId,

    payload.macroFamilyId,
    payload.parentMacroFamilyId,
    payload.parentMicroFamilyId,
    payload.parentFamilyId,
    payload.macroId,
    payload.activeMacroFamilyId
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function hasShortIdSignal(value = '') {
  const raw = upper(value);

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.startsWith('SHORT_') ||
    raw.includes('_SHORT_') ||
    raw.endsWith('_SHORT') ||
    raw.includes('|SHORT_') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT') ||
    raw.includes('SIDE=SELL') ||
    raw.includes('DIRECTION=SELL')
  );
}

function hasLongIdSignal(value = '') {
  const raw = upper(value);

  return (
    raw.includes('MICRO_LONG_') ||
    raw.startsWith('LONG_') ||
    raw.includes('_LONG_') ||
    raw.endsWith('_LONG') ||
    raw.includes('|LONG_') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY')
  );
}

function hasShortDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL') ||
    haystack.includes('MICRO_SHORT_')
  );
}

function hasLongDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY') ||
    haystack.includes('MICRO_LONG_')
  );
}

function inferTradeSide(payload = {}) {
  if (typeof payload !== 'object' || payload === null) {
    return normalizeSideToken(payload);
  }

  const directSources = [
    payload.tradeSide,
    payload.positionSide,
    payload.direction,
    payload.signalSide,
    payload.scannerSide,
    payload.actualScannerSide,
    payload.analysisSide,
    payload.entrySide,
    payload.side
  ];

  for (const value of directSources) {
    const side = normalizeSideToken(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) {
      return side;
    }
  }

  const ids = idHaystack(payload);
  const longId = hasLongIdSignal(ids);
  const shortId = hasShortIdSignal(ids);

  if (longId && !shortId) return OPPOSITE_TRADE_SIDE;
  if (shortId && !longId) return TARGET_TRADE_SIDE;
  if (shortId) return TARGET_TRADE_SIDE;
  if (longId) return OPPOSITE_TRADE_SIDE;

  const parts = definitionParts(payload);
  const longDefinition = hasLongDefinitionSignal(parts);
  const shortDefinition = hasShortDefinitionSignal(parts);

  if (longDefinition && !shortDefinition) return OPPOSITE_TRADE_SIDE;
  if (shortDefinition && !longDefinition) return TARGET_TRADE_SIDE;
  if (shortDefinition) return TARGET_TRADE_SIDE;
  if (longDefinition) return OPPOSITE_TRADE_SIDE;

  if (payload.shortOnly === true || payload.longDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isShortPayload(payload = {}) {
  return inferTradeSide(payload) === TARGET_TRADE_SIDE;
}

function normalizeSideLabel(payload = {}) {
  return isShortPayload(payload) ? TARGET_TRADE_SIDE : 'NON_SHORT_SKIPPED';
}

function discordColorForSide(payload = {}) {
  return isShortPayload(payload) ? 0xef4444 : 0x64748b;
}

function discordColorForResult(value) {
  const r = safeNumber(value, 0);

  if (r > 0) return 0x2563eb;
  if (r < 0) return 0xdc2626;

  return 0x94a3b8;
}

function extractExitPrice(outcome = {}) {
  return (
    outcome.exit ??
    outcome.exitPrice ??
    outcome.close ??
    outcome.closePrice ??
    outcome.price ??
    outcome.lastPrice ??
    null
  );
}

function extractResultR(outcome = {}) {
  return (
    outcome.netR ??
    outcome.exitR ??
    outcome.realizedNetR ??
    outcome.realizedR ??
    outcome.r ??
    null
  );
}

function microFamilyId(payload = {}) {
  return payload.microFamilyId || payload.trueMicroFamilyId || null;
}

function macroFamilyId(payload = {}) {
  return (
    payload.activeMacroFamilyId ||
    payload.parentMacroFamilyId ||
    payload.parentMicroFamilyId ||
    payload.macroFamilyId ||
    null
  );
}

function weeklyStats(payload = {}) {
  return payload.weeklyStats || payload.microStats || payload.stats || {};
}

function statValue(payload = {}, key, fallbackKey = null) {
  const stats = weeklyStats(payload);

  return (
    stats?.[key] ??
    (fallbackKey ? stats?.[fallbackKey] : undefined) ??
    payload?.[key] ??
    (fallbackKey ? payload?.[fallbackKey] : undefined) ??
    null
  );
}

function completedSample(payload = {}) {
  return (
    statValue(payload, 'completed') ??
    statValue(payload, 'winrateSample') ??
    statValue(payload, 'virtualCompleted') ??
    statValue(payload, 'realCompleted') ??
    statValue(payload, 'shadowCompleted') ??
    0
  );
}

function bestWinrate(payload = {}) {
  return (
    statValue(payload, 'fairWinrate') ??
    statValue(payload, 'sampleAdjustedWinrate') ??
    statValue(payload, 'bayesianWinrate') ??
    statValue(payload, 'wilsonLowerBound') ??
    statValue(payload, 'winrate') ??
    0
  );
}

function fingerprint(payload = {}) {
  return (
    payload.executionFingerprintHash ||
    payload.fingerprintHash ||
    payload.microFingerprintHash ||
    'NA'
  );
}

function isRealOrderSource(payload = {}) {
  const source = normalizeSource(payload.source);

  return REAL_ORDER_SOURCES.has(source);
}

function isVirtualSource(payload = {}) {
  const source = normalizeSource(payload.source);

  return (
    source === SOURCE_VIRTUAL ||
    payload.virtualOnly === true ||
    payload.virtualTracked === true ||
    payload.sourceMode === SOURCE_VIRTUAL
  );
}

function isMirrorPayload(payload = {}) {
  const source = normalizeSource(payload.source);

  return Boolean(
    source === SOURCE_SHADOW ||
    payload.observationMirror === true ||
    payload.analysisMirror === true ||
    payload.mirrorAnalysisOnly === true ||
    payload.isMirrorMicroFamily === true ||
    payload.mirrorOfSide
  );
}

function isShadowPayload(payload = {}) {
  return isMirrorPayload(payload);
}

function isAnalysisOnlyPayload(payload = {}) {
  return Boolean(
    payload.observationOnly === true ||
    payload.analysisInputOnly === true ||
    payload.learningOnly === true ||
    payload.analyzeOnly === true ||
    payload.discoveryOnly === true ||
    payload.tradeDiscoveryOnly === true
  );
}

function hasValidShortTradeShape(entry = {}) {
  const entryPrice = safeNumber(entry.entry, 0);
  const sl = safeNumber(entry.sl ?? entry.stopLoss, 0);
  const tp = safeNumber(entry.tp ?? entry.takeProfit, 0);

  if (entryPrice <= 0) return false;
  if (sl <= entryPrice) return false;
  if (tp <= 0 || tp >= entryPrice) return false;

  return true;
}

function matchTypeIsTrueMicro(entry = {}) {
  const matchType = upper(entry.rotationMatchType || '');

  if (!matchType) {
    return Boolean(
      entry.discordAlertEligible === true ||
      entry.selectedForDiscord === true
    );
  }

  return (
    matchType === 'TRUE_MICRO_EXACT' ||
    matchType.includes('TRUE_MICRO') ||
    matchType.includes('MICRO_EXACT')
  );
}

function hasSelectedMicroRotationMatch(entry = {}) {
  const microId = microFamilyId(entry);

  if (!microId) return false;
  if (!entry.activeRotationId) return false;

  const selected = Boolean(
    entry.discordAlertEligible === true ||
    entry.selectedForDiscord === true ||
    entry.liveEligible === true
  );

  if (!selected) return false;

  return matchTypeIsTrueMicro(entry);
}

function shouldSendEntryAlert(entry = {}) {
  if (!isShortPayload(entry)) return false;
  if (isMirrorPayload(entry)) return false;
  if (isAnalysisOnlyPayload(entry)) return false;
  if (isRealOrderSource(entry)) return false;
  if (!isVirtualSource(entry)) return false;

  if (entry.action && upper(entry.action) !== 'ENTRY') return false;

  if (!hasSelectedMicroRotationMatch(entry)) return false;
  if (!hasValidShortTradeShape(entry)) return false;

  return true;
}

function shouldSendExitAlert(outcome = {}) {
  if (!isShortPayload(outcome)) return false;
  if (isMirrorPayload(outcome)) return false;
  if (isAnalysisOnlyPayload(outcome)) return false;
  if (isRealOrderSource(outcome)) return false;
  if (!isVirtualSource(outcome)) return false;

  if (!microFamilyId(outcome)) return false;
  if (!hasSelectedMicroRotationMatch(outcome)) return false;

  return true;
}

function compactPayload(payload = {}) {
  const tradeSide = inferTradeSide(payload);

  return {
    symbol: payload.symbol || null,
    contractSymbol: payload.contractSymbol || null,

    side: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_DASHBOARD_SIDE
      : payload.side || null,

    tradeSide,

    action: payload.action || null,
    reason: payload.reason || null,
    exitReason: payload.exitReason || null,

    source: normalizeSource(payload.source),
    sourceMode: payload.sourceMode || null,

    liveEligible: Boolean(payload.liveEligible),
    discordAlertEligible: Boolean(payload.discordAlertEligible),
    selectedForDiscord: Boolean(payload.selectedForDiscord),

    virtualOnly: payload.virtualOnly !== false,
    virtualTracked: payload.virtualTracked !== false,
    shadowOnly: Boolean(payload.shadowOnly),

    observationOnly: Boolean(payload.observationOnly),
    analysisInputOnly: Boolean(payload.analysisInputOnly),
    learningOnly: Boolean(payload.learningOnly),

    rotationMatchType: payload.rotationMatchType || null,

    microFamilyId: microFamilyId(payload),
    familyId: payload.familyId || null,
    macroFamilyId: macroFamilyId(payload),

    activeRotationId: payload.activeRotationId || null,

    executionFingerprintHash: payload.executionFingerprintHash || null,

    entry: payload.entry ?? null,
    exit: extractExitPrice(payload),
    sl: payload.sl ?? null,
    tp: payload.tp ?? null,
    rr: payload.rr ?? null,

    winrate: bestWinrate(payload),
    completed: completedSample(payload),
    avgR: statValue(payload, 'avgR'),
    totalR: statValue(payload, 'totalR'),
    profitFactor: statValue(payload, 'profitFactor'),

    exitR: payload.exitR ?? null,
    netR: payload.netR ?? null,
    grossR: payload.grossR ?? null,
    costR: payload.costR ?? null,
    pnlPct: payload.pnlPct ?? payload.netPnlPct ?? null,

    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false,

    ts: Date.now()
  };
}

async function postDiscord(content) {
  const cfg = discordConfig();

  if (!cfg.enabled || !cfg.webhookUrl) {
    return {
      ok: true,
      skipped: true,
      reason: 'DISCORD_DISABLED'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const response = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(content),
      signal: controller.signal
    });

    const responseText = await response.text().catch(() => '');

    return {
      ok: response.ok,
      status: response.status,
      response: response.ok ? undefined : truncate(responseText, 500)
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === 'AbortError'
        ? 'DISCORD_TIMEOUT'
        : error?.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function logDiscord(type, payload, result) {
  try {
    const cfg = discordConfig();
    const redis = getDurableRedis();

    await pushJsonLog(
      redis,
      KEYS.discord.logList,
      {
        type,
        payload: compactPayload(payload),
        result,
        ts: Date.now()
      },
      cfg.logLimit
    );
  } catch {
    // Discord logging mag trade execution nooit blokkeren.
  }
}

async function skipDiscord(type, payload = {}, reason = 'DISCORD_SKIPPED') {
  const result = {
    ok: true,
    skipped: true,
    reason,
    detectedTradeSide: inferTradeSide(payload),
    source: normalizeSource(payload.source),
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  };

  await logDiscord(type, payload, result);

  return result;
}

function entrySkipReason(entry = {}) {
  if (!isShortPayload(entry)) return 'DISCORD_SHORT_ONLY_SKIPPED_NON_SHORT';
  if (isMirrorPayload(entry)) return 'DISCORD_SKIPPED_MIRROR_PAYLOAD';
  if (isAnalysisOnlyPayload(entry)) return 'DISCORD_SKIPPED_ANALYSIS_ONLY';
  if (isRealOrderSource(entry)) return 'DISCORD_REAL_ORDER_SOURCE_BLOCKED';
  if (!isVirtualSource(entry)) return 'DISCORD_VIRTUAL_SOURCE_REQUIRED';
  if (entry.action && upper(entry.action) !== 'ENTRY') return 'DISCORD_SKIPPED_NOT_ENTRY_ACTION';
  if (!hasSelectedMicroRotationMatch(entry)) return 'ENTRY_NOT_SELECTED_MANUAL_TRUE_MICRO_MATCH';
  if (!hasValidShortTradeShape(entry)) return 'ENTRY_INVALID_SHORT_TRADE_SHAPE';

  return 'ENTRY_NOT_ELIGIBLE';
}

function exitSkipReason(outcome = {}) {
  if (!isShortPayload(outcome)) return 'DISCORD_SHORT_ONLY_SKIPPED_NON_SHORT';
  if (isMirrorPayload(outcome)) return 'DISCORD_SKIPPED_MIRROR_PAYLOAD';
  if (isAnalysisOnlyPayload(outcome)) return 'DISCORD_SKIPPED_ANALYSIS_ONLY';
  if (isRealOrderSource(outcome)) return 'DISCORD_REAL_ORDER_SOURCE_BLOCKED';
  if (!isVirtualSource(outcome)) return 'DISCORD_VIRTUAL_SOURCE_REQUIRED';
  if (!microFamilyId(outcome)) return 'EXIT_MICRO_FAMILY_ID_MISSING';
  if (!hasSelectedMicroRotationMatch(outcome)) return 'EXIT_NOT_SELECTED_MANUAL_TRUE_MICRO_MATCH';

  return 'EXIT_NOT_ELIGIBLE';
}

function entryReasonText(entry = {}) {
  const statsSample = completedSample(entry);
  const wr = bestWinrate(entry);
  const avgR = statValue(entry, 'avgR');
  const totalR = statValue(entry, 'totalR');

  return [
    'MANUAL_TRUE_MICRO_MATCH',
    `SOURCE=${SOURCE_VIRTUAL}`,
    `WR=${fmtPctSmart(wr)}`,
    `SAMPLE=${fmtNumber(statsSample, 2)}`,
    `AVG_R=${fmtR(avgR)}`,
    `TOTAL_R=${fmtR(totalR)}`
  ].join(' | ');
}

export async function sendEntryAlert(entry = {}) {
  if (!shouldSendEntryAlert(entry)) {
    return skipDiscord(
      'ENTRY_SKIPPED',
      entry,
      entrySkipReason(entry)
    );
  }

  const symbol = normalizeBaseSymbol(entry.symbol || entry.contractSymbol);
  const side = normalizeSideLabel(entry);

  const stats = weeklyStats(entry);
  const sample = completedSample(entry);
  const wr = bestWinrate(entry);
  const avgR = statValue(entry, 'avgR');
  const totalR = statValue(entry, 'totalR');
  const profitFactor = statValue(entry, 'profitFactor');
  const directSLPct = statValue(entry, 'directSLPct');
  const sampleReliability = statValue(entry, 'sampleReliability');

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${symbol || 'UNKNOWN'} ${side} VIRTUAL SNIPER ENTRY`,
        color: discordColorForSide(entry),
        description: truncate(entryReasonText(entry), 300),
        fields: [
          field('Source', SOURCE_VIRTUAL, true),
          field('Entry', fmtPrice(entry.entry), true),
          field('TP', fmtPrice(entry.tp), true),
          field('SL', fmtPrice(entry.sl), true),
          field('RR', fmtR(entry.rr), true),
          field('Risk', fmtPct(entry.riskPct), true),
          field('Spread', fmtPct(entry.spreadPct ?? entry.liveSpreadPct), true),

          field('Micro', microFamilyId(entry) || 'NA', false),
          field('Macro', macroFamilyId(entry) || 'NA', false),
          field('Fingerprint', fingerprint(entry), true),
          field('Rotation', entry.activeRotationId || 'NA', true),
          field('Match', entry.rotationMatchType || 'TRUE_MICRO_EXACT', true),

          field('Winrate', fmtPctSmart(wr), true),
          field('Sample', fmtNumber(sample, 2), true),
          field('Reliability', fmtPctSmart(sampleReliability), true),
          field('Avg R', fmtR(avgR), true),
          field('Total R', fmtR(totalR), true),
          field('Profit factor', fmtNumber(profitFactor, 2), true),
          field('Direct SL', fmtPctSmart(directSLPct), true),

          field(
            'Confluence',
            [
              `RSI=${entry.rsiZone || stats.rsiZone || 'NA'}`,
              `FLOW=${entry.flow || stats.flow || 'NA'}`,
              `OB=${entry.obRelation || stats.obRelation || 'NA'}`,
              `BTC=${entry.btcRelation || stats.btcRelation || 'NA'}`,
              `REGIME=${entry.regime || stats.regime || 'NA'}`
            ].join(' | '),
            false
          )
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('ENTRY', {
    ...entry,
    source: SOURCE_VIRTUAL,
    virtualOnly: true,
    virtualTracked: true,
    shortOnly: true,
    longDisabled: true
  }, result);

  return result;
}

export async function sendExitAlert(outcome = {}) {
  if (!shouldSendExitAlert(outcome)) {
    return skipDiscord(
      'EXIT_SKIPPED',
      outcome,
      exitSkipReason(outcome)
    );
  }

  const symbol = normalizeBaseSymbol(outcome.symbol || outcome.contractSymbol);
  const side = normalizeSideLabel(outcome);
  const exitPrice = extractExitPrice(outcome);
  const resultR = extractResultR(outcome);

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${symbol || 'UNKNOWN'} ${side} VIRTUAL EXIT`,
        color: discordColorForResult(resultR),
        fields: [
          field('Source', SOURCE_VIRTUAL, true),
          field('Exit', fmtPrice(exitPrice), true),
          field('Result net', fmtR(resultR), true),
          field('Reason', outcome.exitReason || 'EXIT', true),
          field('Cost', fmtR(outcome.costR), true),
          field('PnL net', fmtPct(outcome.pnlPct ?? outcome.netPnlPct), true),
          field('Gross R', fmtR(outcome.grossR), true),
          field('MFE', fmtR(outcome.mfeR), true),
          field('MAE', fmtR(outcome.maeR), true),
          field('Micro', microFamilyId(outcome) || 'NA', false),
          field('Macro', macroFamilyId(outcome) || 'NA', false),
          field('Fingerprint', fingerprint(outcome), true),
          field('Rotation', outcome.activeRotationId || 'NA', true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('EXIT', {
    ...outcome,
    source: SOURCE_VIRTUAL,
    virtualOnly: true,
    virtualTracked: true,
    shortOnly: true,
    longDisabled: true
  }, result);

  return result;
}

function bestShortId(rotation = {}) {
  return (
    rotation.bestShort?.microFamilyId ||
    rotation.selectedMicroFamilyId ||
    rotation.microFamilyIds?.[0] ||
    rotation.activeMicroFamilyIds?.[0] ||
    rotation.trueMicroFamilyIds?.[0] ||
    'NA'
  );
}

function shouldSendRotationReport(rotation = {}, label = '') {
  const cfg = discordConfig();

  if (!cfg.sendRotationReports) return false;

  const normalizedLabel = upper(label);

  if (normalizedLabel.includes('NEXT_ROTATION_READY')) return false;
  if (rotation.autoRotation === true && rotation.liveSelectable !== true) return false;
  if (rotation.empty === true) return false;

  return Boolean(
    rotation.manualOnly === true ||
    rotation.adminSelected === true ||
    rotation.liveSelectable === true
  );
}

export async function sendWeeklyRotationReport(rotationInput = {}, label = 'WEEKLY_ROTATION') {
  const rotation =
    rotationInput.rotation ||
    rotationInput.activeRotation ||
    rotationInput.nextRotation ||
    rotationInput;

  if (!shouldSendRotationReport(rotation, label)) {
    return skipDiscord(
      'WEEKLY_ROTATION_SKIPPED',
      {
        ...rotation,
        bestLong: null,
        shortOnly: true,
        longDisabled: true,
        longOnly: false,
        shortDisabled: false
      },
      'ROTATION_REPORT_DISABLED_OR_NOT_MANUAL_LIVE_SELECTABLE'
    );
  }

  const microCount =
    rotation.microFamilyIds?.length ||
    rotation.activeMicroFamilyIds?.length ||
    rotation.trueMicroFamilyIds?.length ||
    rotation.microFamilies?.length ||
    0;

  const macroCount =
    rotation.macroFamilyIds?.length ||
    rotation.activeMacroFamilyIds?.length ||
    0;

  const week =
    rotation.sourceWeekKey ||
    rotation.activeWeekKey ||
    rotation.weekKey ||
    'NA';

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${label} SHORT MANUAL MICRO SET`,
        color: 0x7c3aed,
        fields: [
          field('Micro count', String(microCount), true),
          field('Macro count', String(macroCount), true),
          field('Mode', rotation.mode || 'NA', true),
          field('Week', week, true),
          field('Best SHORT', bestShortId(rotation), false),
          field('Manual only', String(Boolean(rotation.manualOnly)), true),
          field('Live selectable', String(Boolean(rotation.liveSelectable)), true),
          field('Long disabled', 'true', true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('WEEKLY_ROTATION', {
    ...rotation,
    bestLong: null,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  }, result);

  return result;
}

export async function sendResetReport(report = {}) {
  const cfg = discordConfig();

  if (!cfg.sendResetReports) {
    return skipDiscord('RESET_SKIPPED', report, 'RESET_REPORTS_DISABLED');
  }

  const deletedCount = Object.keys(report.deleted || {}).length;

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `RESET ${report.type || 'UNKNOWN'}`,
        color: report.ok ? 0xf59e0b : 0xdc2626,
        fields: [
          field('OK', String(Boolean(report.ok)), true),
          field('Reason', report.reason || 'OK', true),
          field('Deleted', String(deletedCount), true),
          field('Short only', 'true', true),
          field('Long disabled', 'true', true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('RESET', {
    ...report,
    shortOnly: true,
    longDisabled: true,
    longOnly: false,
    shortDisabled: false
  }, result);

  return result;
}