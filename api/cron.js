import { buildScanPayload } from "./scanner.js";
import { runTradeFunnel } from "./trade-funnel.js";

import { runWeeklyRotation } from "../lib/rotation/rotationRunner.js";
import { getActiveWeeklyGate } from "../lib/rotation/getActiveWeeklyGate.js";
import { getRotationStorageStatus } from "../lib/rotation/rotationStore.js";

function normalizeSide(side) {
  const s = String(side || "").toLowerCase().trim();

  if (s === "bull") return "bull";
  if (s === "bear") return "bear";
  if (s === "both") return "both";

  return null;
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;

  return fallback;
}

function normalizeJob(job) {
  const value = String(job || "").toLowerCase().trim();

  if (!value) return "scan";
  if (["scan", "scanner", "main"].includes(value)) return "scan";
  if (["weekly-rotation", "rotation", "run-weekly-rotation"].includes(value)) {
    return "weekly-rotation";
  }
  if (["rotation-status", "status", "weekly-status"].includes(value)) {
    return "rotation-status";
  }

  return value;
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseMinCompletedSequence(value) {
  const raw = String(value || "10,5,3,1");

  const parsed = raw
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((x) => Number.isFinite(x) && x > 0);

  return parsed.length ? parsed : [10, 5, 3, 1];
}

// ================= SIDE FROM MINUTE =================
// 00 / 15 / 30 / 45 = bull
// 07 / 22 / 37 / 52 = bear
// andere minuten = both
function inferSideFromMinute() {
  const minute = new Date().getUTCMinutes();

  if ([0, 15, 30, 45].includes(minute)) return "bull";
  if ([7, 22, 37, 52].includes(minute)) return "bear";

  return "both";
}

function countActions(data) {
  if (Array.isArray(data?.tradeSystemResult?.actions)) {
    return data.tradeSystemResult.actions.length;
  }

  if (Array.isArray(data?.actions)) {
    return data.actions.length;
  }

  if (Array.isArray(data?.trades)) {
    return data.trades.length;
  }

  return 0;
}

function sendJson(res, status, payload) {
  return res.status(status).json({
    ...payload,
    ts: Date.now(),
  });
}

async function handleRotationStatus(res, startedAt) {
  const [gate, storage] = await Promise.all([
    getActiveWeeklyGate(),
    getRotationStorageStatus(),
  ]);

  return sendJson(res, 200, {
    ok: true,
    source: "cron",
    job: "rotation-status",
    durationMs: Date.now() - startedAt,
    gate,
    storage,
  });
}

async function handleWeeklyRotation(req, res, startedAt) {
  const force = normalizeBoolean(req?.query?.force, true);
  const dryRun = normalizeBoolean(req?.query?.dryRun ?? req?.query?.dry, false);

  const topPerSide = normalizeNumber(
    req?.query?.topPerSide ?? process.env.WEEKLY_ROTATION_TOP_PER_SIDE,
    2
  );

  const minCompletedSequence = parseMinCompletedSequence(
    req?.query?.minCompletedSequence ??
      process.env.WEEKLY_ROTATION_MIN_COMPLETED_SEQUENCE
  );

  console.log("CRON WEEKLY ROTATION START:", {
    force,
    dryRun,
    activate: !dryRun,
    topPerSide,
    minCompletedSequence,
    at: new Date().toISOString(),
  });

  const result = await runWeeklyRotation({
    activate: !dryRun,
    force,
    config: {
      topPerSide,
      minCompletedSequence,
    },
  });

  console.log("CRON WEEKLY ROTATION DONE:", {
    ok: result?.ok,
    activate: !dryRun,
    sourceWeekKey: result?.sourceWeekKey,
    targetWeekKey: result?.targetWeekKey,
    rows: result?.rows,
    selected: result?.rotation?.selectedMicroFamilyIds?.length || 0,
    selectedLong: result?.rotation?.selectedLongMicroFamilyIds?.length || 0,
    selectedShort: result?.rotation?.selectedShortMicroFamilyIds?.length || 0,
    status: result?.rotation?.status,
    durationMs: Date.now() - startedAt,
  });

  return sendJson(res, 200, {
    ok: true,
    source: "cron",
    job: "weekly-rotation",
    dryRun,
    activate: !dryRun,
    ranAt: Date.now(),
    durationMs: Date.now() - startedAt,
    result,
  });
}

async function handleScanCron(req, res, startedAt) {
  const querySide = normalizeSide(req?.query?.side);
  const side = querySide || inferSideFromMinute();

  const notify = normalizeBoolean(req?.query?.notify, true);
  const store = normalizeBoolean(req?.query?.store, true);

  const utcMinute = new Date().getUTCMinutes();

  console.log("CRON START:", {
    job: "scan",
    side,
    querySide,
    notify,
    store,
    utcMinute,
    at: new Date().toISOString(),
  });

  // 1. Scanner draait en schrijft latest scan.
  const scanData = await buildScanPayload({
    side,
    notify,
    store,
  });

  // 2. Direct daarna trade-funnel + analyzer append.
  // latest voorkomt dat trade-funnel een oude/stale latest scan leest.
  const tradeData = await runTradeFunnel({
    latest: scanData,
    notify,
    store,
  });

  const result = {
    ok: true,
    source: "cron",
    job: "scan",
    side,
    notify,
    store,
    ranAt: Date.now(),
    durationMs: Date.now() - startedAt,

    scanner: {
      ok: Boolean(scanData?.ok),
      scanSide: scanData?.scanSide || side,
      scanMode: scanData?.scanMode || side,
      btc: scanData?.btc || null,
      regime: scanData?.regime || null,
      candidates: Number(scanData?.candidates || 0),
      candidatesBull: Number(scanData?.candidatesBull || 0),
      candidatesBear: Number(scanData?.candidatesBear || 0),
      bullCount: Number(scanData?.bullCount || 0),
      bearCount: Number(scanData?.bearCount || 0),
      funnelCount: Number(scanData?.funnelCount || 0),
      updatedAt: scanData?.updatedAt || null,
      scannerUpdatedAt: scanData?.scannerUpdatedAt || null,
    },

    tradeFunnel: {
      ok: Boolean(tradeData?.ok),
      rawCount: Number(tradeData?.tradeFunnelRawCount || 0),
      inputCount: Number(tradeData?.tradeFunnelInputCount || 0),
      rejected: tradeData?.tradeFunnelRejectCounts || {},
      inputSymbols: Array.isArray(tradeData?.tradeFunnelInputSymbols)
        ? tradeData.tradeFunnelInputSymbols.slice(0, 80)
        : [],
      actions: countActions(tradeData),
      updatedAt: tradeData?.updatedAt || null,
      tradeFunnelUpdatedAt: tradeData?.tradeFunnelUpdatedAt || null,
    },

    analyzer: tradeData?.analyzeAppendResult || null,

    lastBullScan: tradeData?.lastBullScan || scanData?.lastBullScan || null,
    lastBearScan: tradeData?.lastBearScan || scanData?.lastBearScan || null,
    updatedAt: tradeData?.updatedAt || scanData?.updatedAt || null,
  };

  console.log("CRON DONE:", result);

  return sendJson(res, 200, result);
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const job = normalizeJob(req?.query?.job);

    if (job === "weekly-rotation") {
      return await handleWeeklyRotation(req, res, startedAt);
    }

    if (job === "rotation-status") {
      return await handleRotationStatus(res, startedAt);
    }

    if (job === "scan") {
      return await handleScanCron(req, res, startedAt);
    }

    return sendJson(res, 400, {
      ok: false,
      source: "cron",
      error: "UNKNOWN_CRON_JOB",
      job,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("CRON ERROR:", err);

    return sendJson(res, 500, {
      ok: false,
      source: "cron",
      error: err?.message || "cron_failed",
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
      ranAt: Date.now(),
      durationMs: Date.now() - startedAt,
    });
  }
}
