// lib/rotation/rotationRunner.js

import fs from "node:fs/promises";
import path from "node:path";
import { selectWeeklyRotation } from "./weeklySelector.js";
import {
  appendRotationHistory,
  saveActiveRotation,
  saveNextRotation
} from "./rotationStore.js";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function getIsoWeekParts(dateLike = Date.now()) {
  const date = new Date(dateLike);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);

  return {
    year: utc.getUTCFullYear(),
    week
  };
}

export function getIsoWeekKey(dateLike = Date.now()) {
  const { year, week } = getIsoWeekParts(dateLike);
  return `${year}_W${pad2(week)}`;
}

export function getNextIsoWeekKey(dateLike = Date.now()) {
  return getIsoWeekKey(new Date(Number(new Date(dateLike)) + 7 * 86400000));
}

async function tryImport(modulePath) {
  try {
    return await import(modulePath);
  } catch {
    return null;
  }
}

async function loadRowsFromAnalyzeStore() {
  const mod = await tryImport("../analyze/analyzeStore.js");
  if (!mod) return [];

  const candidates = [
    "loadAnalyzeEvents",
    "getAnalyzeEvents",
    "readAnalyzeEvents",
    "loadAllAnalyzeEvents",
    "getAllEvents"
  ];

  for (const name of candidates) {
    if (typeof mod[name] !== "function") continue;

    const value = await mod[name]({ limit: 10000 });
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.events)) return value.events;
    if (Array.isArray(value?.rows)) return value.rows;
    if (Array.isArray(value?.items)) return value.items;
  }

  return [];
}

async function loadRowsFromOutcomeStore() {
  const mod = await tryImport("../microFamilyOutcomeStore.js");
  if (!mod) return [];

  const candidates = [
    "loadMicroFamilyOutcomes",
    "getMicroFamilyOutcomes",
    "loadOutcomeRows",
    "getOutcomeRows",
    "loadAllOutcomes"
  ];

  for (const name of candidates) {
    if (typeof mod[name] !== "function") continue;

    const value = await mod[name]({ limit: 10000 });
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.events)) return value.events;
    if (Array.isArray(value?.rows)) return value.rows;
    if (Array.isArray(value?.items)) return value.items;
    if (Array.isArray(value?.outcomes)) return value.outcomes;
  }

  return [];
}

async function loadRowsFromTradesJson() {
  try {
    const fullPath = path.join(process.cwd(), "data", "trades.json");
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.trades)) return parsed.trades;
    if (Array.isArray(parsed?.closedTrades)) return parsed.closedTrades;
    if (Array.isArray(parsed?.entries)) return parsed.entries;

    return [];
  } catch {
    return [];
  }
}

async function collectOutcomeRows() {
  const [analyzeRows, outcomeRows, tradesRows] = await Promise.all([
    loadRowsFromAnalyzeStore(),
    loadRowsFromOutcomeStore(),
    loadRowsFromTradesJson()
  ]);

  const merged = [
    ...outcomeRows,
    ...analyzeRows,
    ...tradesRows
  ];

  const seen = new Set();

  return merged.filter((row) => {
    const key =
      row.id ||
      row.tradeId ||
      row.eventId ||
      `${row.symbol}_${row.side}_${row.microFamilyId}_${row.closedAt || row.exitTs || row.ts || ""}_${row.pnlR ?? row.realizedR ?? row.pnl ?? ""}`;

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

export async function runWeeklyRotation({
  now = Date.now(),
  activate = true,
  sourceWeekKey = getIsoWeekKey(now),
  targetWeekKey = getNextIsoWeekKey(now),
  config = {}
} = {}) {
  const rows = await collectOutcomeRows();

  const rotation = selectWeeklyRotation({
    rows,
    sourceWeekKey,
    targetWeekKey,
    now,
    config
  });

  const savedNext = await saveNextRotation(rotation);
  const savedActive = activate ? await saveActiveRotation(rotation) : null;
  const history = await appendRotationHistory(rotation);

  return {
    ok: true,
    activate,
    sourceWeekKey,
    targetWeekKey,
    rows: rows.length,
    rotation,
    savedNext: Boolean(savedNext),
    savedActive: Boolean(savedActive),
    historyCount: history.length
  };
}

export default runWeeklyRotation;
