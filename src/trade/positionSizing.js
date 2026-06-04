// ================= FILE: src/trade/positionSizing.js =================
//
// Decides how much risk a new entry may take, and whether portfolio-level risk
// caps allow it at all.
//
// Risk contribution = fraction of equity lost if position hits initial SL.
// Example: 0.0025 = 0.25% equity risk.

import { CONFIG } from '../config.js';
import {
  clamp,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

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

  const completed = safeNumber(weeklyStats?.completed, 0);
  const balanced = safeNumber(weeklyStats?.balancedScore, 0);
  const fairWinrate = safeNumber(weeklyStats?.fairWinrate, 0);

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
  let longRisk = 0;
  let shortRisk = 0;
  let unknownSideRisk = 0;
  let counterBtcRisk = 0;

  for (const position of rows) {
    const risk = positionRiskFraction(position);
    const tradeSide = sideToTradeSide(position.side);

    total += risk;

    if (tradeSide === 'LONG') {
      longRisk += risk;
    } else if (tradeSide === 'SHORT') {
      shortRisk += risk;
    } else {
      unknownSideRisk += risk;
    }

    if (btcRelationFromRow(position) === 'BTC_AGAINST') {
      counterBtcRisk += risk;
    }
  }

  return {
    total: round6(total),
    longRisk: round6(longRisk),
    shortRisk: round6(shortRisk),
    unknownSideRisk: round6(unknownSideRisk),
    counterBtcRisk: round6(counterBtcRisk)
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
  const tradeSide = sideToTradeSide(side);
  const relation = normalizeBtcRelation(btcRelation);

  if (!cfg.enabled) {
    return {
      ok: true,
      reason: 'SIZING_DISABLED',
      riskFraction: want,
      openRiskBefore: open.total,
      openRiskAfter: round6(open.total + want),
      riskState: open
    };
  }

  if (tradeSide === 'UNKNOWN') {
    return {
      ok: false,
      reason: 'UNKNOWN_SIDE_FOR_RISK_CAP',
      side,
      want,
      riskState: open
    };
  }

  if (open.total + want > cfg.maxTotalRiskPct) {
    return {
      ok: false,
      reason: 'MAX_TOTAL_RISK',
      open: open.total,
      want,
      cap: cfg.maxTotalRiskPct,
      riskState: open
    };
  }

  const sideRisk = tradeSide === 'LONG'
    ? open.longRisk
    : open.shortRisk;

  if (sideRisk + want > cfg.maxSameSideRiskPct) {
    return {
      ok: false,
      reason: 'MAX_SAME_SIDE_RISK',
      side: tradeSide,
      open: sideRisk,
      want,
      cap: cfg.maxSameSideRiskPct,
      riskState: open
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
      riskState: open
    };
  }

  return {
    ok: true,
    riskFraction: want,
    openRiskBefore: open.total,
    openRiskAfter: round6(open.total + want),
    sideRiskAfter: round6(sideRisk + want),
    counterBtcRiskAfter: relation === 'BTC_AGAINST'
      ? round6(open.counterBtcRisk + want)
      : open.counterBtcRisk,
    riskState: open
  };
}