// ================= FILE: src/discord/discord.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, pushJsonLog } from '../redis.js';
import {
  normalizeBaseSymbol,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const DISCORD_LIMITS = {
  fieldName: 256,
  fieldValue: 1024
};

function nowIso() {
  return new Date().toISOString();
}

function discordConfig() {
  return {
    enabled: CONFIG.discord?.enabled !== false,
    webhookUrl: CONFIG.discord?.webhookUrl || '',
    timeoutMs: Math.max(500, safeNumber(CONFIG.discord?.timeoutMs, 2500)),
    logLimit: Math.max(1, Math.floor(safeNumber(CONFIG.discord?.logLimit, 250)))
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

function fmtR(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;
}

function normalizeSideLabel(side) {
  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'LONG') return 'LONG';
  if (tradeSide === 'SHORT') return 'SHORT';

  return String(side || 'UNKNOWN').toUpperCase();
}

function discordColorForSide(side) {
  const tradeSide = sideToTradeSide(side);

  if (tradeSide === 'LONG') return 0x22c55e;
  if (tradeSide === 'SHORT') return 0xef4444;

  return 0x64748b;
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
    outcome.grossR ??
    null
  );
}

function compactPayload(payload = {}) {
  return {
    symbol: payload.symbol || null,
    contractSymbol: payload.contractSymbol || null,
    side: payload.side || null,
    action: payload.action || null,
    reason: payload.reason || null,
    exitReason: payload.exitReason || null,

    microFamilyId: payload.microFamilyId || null,
    familyId: payload.familyId || null,
    activeRotationId: payload.activeRotationId || null,

    entry: payload.entry ?? null,
    exit: extractExitPrice(payload),
    sl: payload.sl ?? null,
    tp: payload.tp ?? null,
    rr: payload.rr ?? null,

    exitR: payload.exitR ?? null,
    netR: payload.netR ?? null,
    grossR: payload.grossR ?? null,
    costR: payload.costR ?? null,
    pnlPct: payload.pnlPct ?? null,

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

export async function sendEntryAlert(entry = {}) {
  const symbol = normalizeBaseSymbol(entry.symbol || entry.contractSymbol);
  const side = normalizeSideLabel(entry.side);

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${symbol || 'UNKNOWN'} ${side} ENTRY`,
        color: discordColorForSide(entry.side),
        fields: [
          field('Entry', fmtPrice(entry.entry), true),
          field('TP', fmtPrice(entry.tp), true),
          field('SL', fmtPrice(entry.sl), true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('ENTRY', entry, result);

  return result;
}

export async function sendExitAlert(outcome = {}) {
  const symbol = normalizeBaseSymbol(outcome.symbol || outcome.contractSymbol);
  const side = normalizeSideLabel(outcome.side);
  const exitPrice = extractExitPrice(outcome);
  const resultR = extractResultR(outcome);

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${symbol || 'UNKNOWN'} ${side} EXIT`,
        color: discordColorForResult(resultR),
        fields: [
          field('Exit', fmtPrice(exitPrice), true),
          field('Result', fmtR(resultR), true),
          field('Reason', outcome.exitReason || 'EXIT', true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('EXIT', outcome, result);

  return result;
}

export async function sendWeeklyRotationReport(rotationInput = {}, label = 'WEEKLY_ROTATION') {
  const rotation =
    rotationInput.rotation ||
    rotationInput.activeRotation ||
    rotationInput.nextRotation ||
    rotationInput;

  const count =
    rotation.microFamilyIds?.length ||
    rotation.activeMicroFamilyIds?.length ||
    rotation.trueMicroFamilyIds?.length ||
    rotation.microFamilies?.length ||
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
        title: label,
        color: rotation.empty ? 0xf59e0b : 0x7c3aed,
        fields: [
          field('Count', String(count), true),
          field('Mode', rotation.mode || 'NA', true),
          field('Week', week, true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('WEEKLY_ROTATION', rotation, result);

  return result;
}

export async function sendResetReport(report = {}) {
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
          field('Deleted', String(deletedCount), true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('RESET', report, result);

  return result;
}