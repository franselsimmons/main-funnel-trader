// lib/rotation/weeklySelector.js

import { classifyAnalyzeEvent } from "../familyMicroAnalyzer.js";

const DEFAULT_CONFIG = {
  topPerSide: 2,
  minCompletedSequence: [10, 5, 3, 1],
  minWinRate: 0,
  minExpectancyR: -999,
  maxFamiliesPerSide: 2
};

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isWin(row) {
  const result = String(row.result ?? row.outcome ?? row.status ?? "").toUpperCase();

  if (["WIN", "WON", "TP", "PROFIT", "GREEN"].includes(result)) return true;
  if (["LOSS", "LOST", "SL", "RED"].includes(result)) return false;

  const pnl =
    row.pnlR ??
    row.realizedR ??
    row.profitR ??
    row.rrResult ??
    row.pnl ??
    row.realizedPnl ??
    row.netPnl;

  if (pnl == null) return null;

  return toNumber(pnl) > 0;
}

function extractR(row) {
  const direct =
    row.pnlR ??
    row.realizedR ??
    row.profitR ??
    row.rMultiple ??
    row.rrResult ??
    row.netR;

  if (direct != null && Number.isFinite(Number(direct))) return Number(direct);

  const win = isWin(row);
  if (win === true) return 1;
  if (win === false) return -1;

  const pnl = row.pnl ?? row.realizedPnl ?? row.netPnl;
  if (pnl != null && Number.isFinite(Number(pnl))) {
    const n = Number(pnl);
    if (n > 0) return 1;
    if (n < 0) return -1;
  }

  return null;
}

function isCompletedRow(row) {
  if (!row || typeof row !== "object") return false;

  if (row.closed === true) return true;
  if (row.isClosed === true) return true;
  if (row.exitTs || row.closedAt || row.exitAt) return true;

  const type = String(row.type ?? row.action ?? row.actionType ?? "").toUpperCase();
  if (type.includes("EXIT") || type.includes("CLOSE")) return true;

  return extractR(row) !== null && isWin(row) !== null;
}

function normalizeOutcomeRow(row, opts = {}) {
  if (!isCompletedRow(row)) return null;

  const family = classifyAnalyzeEvent(row, opts);
  if (!family?.ok || !family.microFamilyId) return null;

  const r = extractR(row);
  if (r === null) return null;

  const win = isWin(row);
  if (win === null) return null;

  return {
    raw: row,
    side: family.side,
    microFamilyId: row.microFamilyId || family.microFamilyId,
    parentFamilyId: row.parentFamilyId || family.parentFamilyId,
    setupClass: family.setupClass,
    scannerStage: family.scannerStage,
    reason: family.reason,
    rsiEdge: family.rsiEdge,
    rsiBias: family.rsiBias,
    symbol: row.symbol ?? family.symbol,
    win,
    r,
    ts: toNumber(row.exitTs ?? row.closedAt ?? row.exitAt ?? row.ts ?? row.createdAt, 0)
  };
}

function groupRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const current = map.get(row.microFamilyId) ?? {
      microFamilyId: row.microFamilyId,
      parentFamilyId: row.parentFamilyId,
      side: row.side,
      setupClass: row.setupClass,
      scannerStage: row.scannerStage,
      reason: row.reason,
      rsiEdge: row.rsiEdge,
      rsiBias: row.rsiBias,
      completed: 0,
      wins: 0,
      losses: 0,
      totalR: 0,
      grossWinR: 0,
      grossLossR: 0,
      lastTs: 0,
      symbols: new Set()
    };

    current.completed += 1;
    current.wins += row.win ? 1 : 0;
    current.losses += row.win ? 0 : 1;
    current.totalR += row.r;

    if (row.r > 0) current.grossWinR += row.r;
    if (row.r < 0) current.grossLossR += Math.abs(row.r);

    current.lastTs = Math.max(current.lastTs, row.ts || 0);
    if (row.symbol) current.symbols.add(row.symbol);

    map.set(row.microFamilyId, current);
  }

  return [...map.values()].map((family) => {
    const completed = family.completed;
    const winRate = completed > 0 ? family.wins / completed : 0;
    const expectancyR = completed > 0 ? family.totalR / completed : 0;
    const profitFactor =
      family.grossLossR > 0
        ? family.grossWinR / family.grossLossR
        : family.grossWinR > 0
          ? 99
          : 0;

    const stability = Math.log1p(completed);
    const pfScore = Math.min(profitFactor, 5) * 4;

    const score =
      expectancyR * 100 +
      winRate * 25 +
      pfScore +
      stability * 6;

    return {
      ...family,
      symbols: [...family.symbols].slice(0, 20),
      winRate,
      expectancyR,
      profitFactor,
      score
    };
  });
}

function selectSide(families, side, config) {
  const sideFamilies = families
    .filter((f) => f.side === side)
    .sort((a, b) => b.score - a.score);

  for (const minCompleted of config.minCompletedSequence) {
    const eligible = sideFamilies.filter((family) => {
      if (family.completed < minCompleted) return false;
      if (family.winRate < config.minWinRate) return false;
      if (family.expectancyR < config.minExpectancyR) return false;
      return true;
    });

    if (eligible.length > 0) {
      return {
        side,
        minCompletedUsed: minCompleted,
        microFamilyIds: eligible
          .slice(0, config.topPerSide)
          .map((family) => family.microFamilyId),
        topFamilies: eligible.slice(0, config.topPerSide)
      };
    }
  }

  return {
    side,
    minCompletedUsed: null,
    microFamilyIds: [],
    topFamilies: []
  };
}

export function selectWeeklyRotation({
  rows = [],
  sourceWeekKey,
  targetWeekKey,
  now = Date.now(),
  config: userConfig = {}
} = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...userConfig
  };

  const normalized = rows
    .map((row) => normalizeOutcomeRow(row, { weekKey: targetWeekKey }))
    .filter(Boolean);

  const families = groupRows(normalized);

  const long = selectSide(families, "LONG", config);
  const short = selectSide(families, "SHORT", config);

  const selectedMicroFamilyIds = [
    ...long.microFamilyIds,
    ...short.microFamilyIds
  ];

  const usable = selectedMicroFamilyIds.length > 0;

  return {
    schemaVersion: "WR_V2_TOP2_LONG_SHORT",
    rotationId: `WR_${targetWeekKey}_${now}`,
    status: usable ? "ACTIVE" : "NO_DATA_BYPASS",
    enabled: usable,
    strict: usable,
    usable,
    createdAt: now,
    sourceWeekKey,
    targetWeekKey,
    selectedMicroFamilyIds,
    selectedLongMicroFamilyIds: long.microFamilyIds,
    selectedShortMicroFamilyIds: short.microFamilyIds,
    selection: {
      long,
      short
    },
    stats: {
      rowsReceived: rows.length,
      completedRows: normalized.length,
      totalFamilies: families.length,
      longFamilies: families.filter((f) => f.side === "LONG").length,
      shortFamilies: families.filter((f) => f.side === "SHORT").length
    },
    config,
    topFamilies: families.slice().sort((a, b) => b.score - a.score).slice(0, 20)
  };
}
