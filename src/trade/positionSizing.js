// ================= FILE: src/trade/positionSizing.js =================
//
// Short-only position sizing.
// Risk contribution = fraction of equity lost if position hits initial SL.
// Example: 0.0025 = 0.25% equity risk.

import { CONFIG } from '../config.js';
import {
  clamp,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const TARGET_TRADE_SIDE = 'SHORT';

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function sizingConfig() {
  return {
    enabled: CONFIG.sizing?.enabled !== false,
    baseRiskPct: Math.max(0, safeNumber(CONFIG.sizing?.baseRiskPct, 0.0025)),
    minMult: Math.max(0, safeNumber(CONFIG.sizing?.minMult, 0.5)),
    maxMult: Math.max(0, safeNumber(CONFIG.sizing?.maxMult, 1.25)),
    maxTotalRiskPct: Math.max(0, safeNumber(CONFIG.sizing?.maxTotalRiskPct, 0.03)),
    maxSameSideRiskPct: Math.max(0, safeNumber(CONFIG.sizing?.maxSameSideRiskPct, 0.015)),
    maxCounterBtcRiskPct: Math.max(0, safeNumber(CONFIG.sizing?.maxCounterBtcRiskPct, 0.0075))
  };
}

function normalizeTradeSide(value) {
  const direct = sideToTradeSide(value);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  const raw = String(value || '').trim().toUpperCase();

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromIds(row = {}) {
  const haystack = [
    row.tradeSide,
    row.side,
    row.positionSide,
    row.direction,

    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
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
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .filter(Boolean)
    .join('|');

  if (!haystack) return 'UNKNOWN';

  if (
    haystack.includes('SHORT') ||
    haystack.includes('BEAR') ||
    haystack.includes('SELL') ||
    haystack.includes('MICRO_SHORT_') ||
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR')
  ) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSide(row);
  }

  const direct = normalizeTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.actualScannerSide ||
    row.analysisSide
  );

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  return inferTradeSideFromIds(row);
}

function normalizeBtcRelation(value) {
  const relation = String(value || '').toUpperCase();

  if (relation === 'BTC_WITH') return 'BTC_WITH';
  if (relation === 'BTC_AGAINST') return 'BTC_AGAINST';
  if (relation === 'BTC_NEUTRAL') return 'BTC_NEUTRAL';
  if (relation === 'BTC_UNKNOWN') return 'BTC_UNKNOWN';

  return 'BTC_UNKNOWN';
}

function relationFromDefinitionParts(definitionParts = []) {
  const parts = Array.isArray(definitionParts) ? definitionParts : [];

  const match = parts.find((part) => (
    String(part || '').toUpperCase().startsWith('BTCRELATION=')
  ));

  if (!match) return 'BTC_UNKNOWN';

  return normalizeBtcRelation(String(match).split('=').at(1));
}

function btcRelationFromRow(row = {}) {
  return normalizeBtcRelation(
    row.btcRelation ||
    row.btcStateRelation ||
    relationFromDefinitionParts(row.definitionParts)
  );
}

function positionRiskFraction(position = {}) {
  const cfg = sizingConfig();
  const direct = safeNumber(position.riskFraction, NaN);

  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  return cfg.baseRiskPct;
}

function normalizeRiskFraction(value) {
  const cfg = sizingConfig();
  const risk = safeNumber(value, cfg.baseRiskPct);

  return clamp(
    risk,
    0,
    Math.max(
      cfg.maxTotalRiskPct,
      cfg.baseRiskPct,
      0
    )
  );
}

export function riskFractionForEntry({ weeklyStats } = {}) {
  const cfg = sizingConfig();

  if (!cfg.enabled) {
    return round6(cfg.baseRiskPct);
  }

  const statsSide = inferTradeSide(weeklyStats || {});

  if (weeklyStats && statsSide !== TARGET_TRADE_SIDE) {
    return round6(cfg.baseRiskPct * cfg.minMult);
  }

  const completed = safeNumber(weeklyStats?.completed, 0);
  const balanced = safeNumber(
    weeklyStats?.balancedScore ??
    weeklyStats?.dashboardBalancedScore,
    0
  );
  const fairWinrate = safeNumber(
    weeklyStats?.fairWinrate ??
    weeklyStats?.sampleAdjustedWinrate,
    0
  );

  const sampleConf = clamp(
    completed / Math.max(1, safeNumber(CONFIG.rotation?.priorTrades, 24)),
    0,
    1
  );

  const qualityConf = clamp(balanced / 100, 0, 1);

  const winrateConf = fairWinrate > 0
    ? clamp((fairWinrate - 0.45) / 0.25, 0, 1)
    : 0;

  const confidence =
    sampleConf * 0.40 +
    qualityConf * 0.40 +
    winrateConf * 0.20;

  const maxMult = Math.max(cfg.minMult, cfg.maxMult);

  const mult = clamp(
    cfg.minMult + (maxMult - cfg.minMult) * confidence,
    cfg.minMult,
    maxMult
  );

  return round6(cfg.baseRiskPct * mult);
}

export function summarizeOpenRisk(openPositions = []) {
  const rows = Array.isArray(openPositions) ? openPositions : [];

  let total = 0;
  let shortRisk = 0;
  let nonShortRisk = 0;
  let unknownSideRisk = 0;
  let counterBtcRisk = 0;

  for (const position of rows) {
    const risk = positionRiskFraction(position);
    const tradeSide = inferTradeSide(position);

    total += risk;

    if (tradeSide === TARGET_TRADE_SIDE) {
      shortRisk += risk;
    } else if (tradeSide === 'UNKNOWN') {
      unknownSideRisk += risk;
      nonShortRisk += risk;
    } else {
      nonShortRisk += risk;
    }

    if (btcRelationFromRow(position) === 'BTC_AGAINST') {
      counterBtcRisk += risk;
    }
  }

  return {
    total: round6(total),

    shortRisk: round6(shortRisk),

    // Backward-compatible keys. Long wordt niet meer gebruikt voor nieuwe sizing.
    longRisk: 0,

    nonShortRisk: round6(nonShortRisk),
    unknownSideRisk: round6(unknownSideRisk),
    counterBtcRisk: round6(counterBtcRisk),

    shortOnly: true,
    longDisabled: true
  };
}

export function checkRiskCaps({
  openPositions = [],
  side,
  btcRelation,
  riskFraction
} = {}) {
  const cfg = sizingConfig();
  const want = normalizeRiskFraction(riskFraction);
  const open = summarizeOpenRisk(openPositions);
  const tradeSide = inferTradeSide({ side, tradeSide: side });
  const relation = normalizeBtcRelation(btcRelation);

  if (tradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'SHORT_ONLY_SYSTEM_REJECTED_NON_SHORT_RISK',
      side,
      tradeSide,
      want,
      riskState: open,
      shortOnly: true,
      longDisabled: true
    };
  }

  if (!cfg.enabled) {
    return {
      ok: true,
      reason: 'SIZING_DISABLED',
      riskFraction: want,
      openRiskBefore: open.total,
      openRiskAfter: round6(open.total + want),
      sideRiskAfter: round6(open.shortRisk + want),
      riskState: open,
      shortOnly: true,
      longDisabled: true
    };
  }

  if (open.total + want > cfg.maxTotalRiskPct) {
    return {
      ok: false,
      reason: 'MAX_TOTAL_RISK',
      open: open.total,
      want,
      cap: cfg.maxTotalRiskPct,
      riskState: open,
      shortOnly: true,
      longDisabled: true
    };
  }

  if (open.shortRisk + want > cfg.maxSameSideRiskPct) {
    return {
      ok: false,
      reason: 'MAX_SHORT_SIDE_RISK',
      side: TARGET_TRADE_SIDE,
      open: open.shortRisk,
      want,
      cap: cfg.maxSameSideRiskPct,
      riskState: open,
      shortOnly: true,
      longDisabled: true
    };
  }

  if (
    relation === 'BTC_AGAINST' &&
    open.counterBtcRisk + want > cfg.maxCounterBtcRiskPct
  ) {
    return {
      ok: false,
      reason: 'MAX_COUNTER_BTC_RISK',
      open: open.counterBtcRisk,
      want,
      cap: cfg.maxCounterBtcRiskPct,
      riskState: open,
      shortOnly: true,
      longDisabled: true
    };
  }

  return {
    ok: true,
    riskFraction: want,
    openRiskBefore: open.total,
    openRiskAfter: round6(open.total + want),
    sideRiskAfter: round6(open.shortRisk + want),
    counterBtcRiskAfter: relation === 'BTC_AGAINST'
      ? round6(open.counterBtcRisk + want)
      : open.counterBtcRisk,
    riskState: open,
    shortOnly: true,
    longDisabled: true
  };
}