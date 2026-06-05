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
  fieldValue: 1024,
  embedDescription: 4096,
  webhookContent: 2000
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

function rotationConfig() {
  return {
    minWeightedCompleted: safeNumber(CONFIG.rotation?.minWeightedCompleted, 5),
    topNPerSide: safeNumber(CONFIG.rotation?.topNPerSide, 10)
  };
}

function truncate(value, max = 1024) {
  const text = String(value ?? '');

  if (text.length <= max) return text;

  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function field(name, value, inline = false) {
  const cleanName = truncate(name || 'Field', DISCORD_LIMITS.fieldName);
  const cleanValue = truncate(value ?? 'NA', DISCORD_LIMITS.fieldValue);

  return {
    name: cleanName,
    value: cleanValue || 'NA',
    inline
  };
}

function fmt(value, decimals = 3) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return n.toFixed(decimals);
}

function fmtPctRatio(value, decimals = 1) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${(n * 100).toFixed(decimals)}%`;
}

function fmtPctRaw(value, decimals = 3) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${n.toFixed(decimals)}%`;
}

function fmtPrice(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(6);

  return n.toFixed(10);
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

function discordColorForResult(exitR) {
  const r = safeNumber(exitR, 0);

  if (r > 0) return 0x2563eb;
  if (r < 0) return 0xdc2626;

  return 0x94a3b8;
}

function coinLogoUrl(symbol) {
  const base = normalizeBaseSymbol(symbol).toLowerCase();

  if (!base) return null;

  return `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${base}.png`;
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
    exit: payload.exit ?? null,
    sl: payload.sl ?? null,
    tp: payload.tp ?? null,
    rr: payload.rr ?? null,

    exitR: payload.exitR ?? null,
    netR: payload.netR ?? null,
    grossR: payload.grossR ?? null,
    costR: payload.costR ?? null,
    pnlPct: payload.pnlPct ?? null,

    fairWinrate: payload.weeklyStats?.fairWinrate ?? payload.fairWinrate ?? null,
    avgR: payload.weeklyStats?.avgR ?? payload.avgR ?? null,
    totalR: payload.weeklyStats?.totalR ?? payload.totalR ?? null,
    balancedScore: payload.weeklyStats?.balancedScore ?? payload.balancedScore ?? null,

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
        title: `${symbol || 'UNKNOWN'} ${side}`,
        color: discordColorForSide(entry.side),
        fields: [
          field('Entry', fmtPrice(entry.entry), true),
          field('TP', fmtPrice(entry.tp), true),
          field('SL', fmtPrice(entry.sl), true)
        ]
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
  const logo = coinLogoUrl(symbol);

  const title = `TRADE EXIT — ${symbol || 'UNKNOWN'} ${side} ${outcome.exitReason || 'EXIT'}`;

  const fields = [
    field('MicroFamily', `\`${outcome.microFamilyId || 'NA'}\``, false),
    field('Family', outcome.familyId || 'NA', true),
    field('Reason', outcome.exitReason || 'NA', true),
    field('Source', outcome.source || 'REAL', true),

    field(
      'Net Result',
      [
        `exitR=${fmt(outcome.exitR, 4)}`,
        `netR=${fmt(outcome.netR, 4)}`,
        `pnl=${fmtPctRaw(outcome.pnlPct, 4)}`,
        `costR=${fmt(outcome.costR, 4)}`
      ].join('\n'),
      true
    ),

    field(
      'Gross / Cost',
      [
        `grossR=${fmt(outcome.grossR, 4)}`,
        `grossPnl=${fmtPctRaw(outcome.grossPnlPct, 4)}`,
        `cost=${fmtPctRaw(outcome.costPct, 4)}`,
        `fee=${fmtPctRaw(outcome.feePct, 4)}`,
        `slip=${fmtPctRaw(outcome.slippagePct, 4)}`
      ].join('\n'),
      true
    ),

    field(
      'Path',
      [
        `mfeR=${fmt(outcome.mfeR, 3)}`,
        `maeR=${fmt(outcome.maeR, 3)}`,
        `directSL=${Boolean(outcome.directToSL)}`,
        `nearTP=${Boolean(outcome.nearTpSeen)}`,
        `halfR=${Boolean(outcome.reachedHalfR)}`,
        `oneR=${Boolean(outcome.reachedOneR)}`
      ].join('\n'),
      true
    ),

    field(
      'Management Diagnostics',
      [
        `beArmed=${Boolean(outcome.beArmed)}`,
        `beWouldExit=${Boolean(outcome.beWouldExit)}`,
        `gaveBackHalf=${Boolean(outcome.gaveBackAfterHalfR)}`,
        `gaveBackOne=${Boolean(outcome.gaveBackAfterOneR)}`,
        `nearTpThenLoss=${Boolean(outcome.nearTpThenLoss)}`
      ].join('\n'),
      true
    )
  ];

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title,
        color: discordColorForResult(outcome.exitR),
        thumbnail: logo ? { url: logo } : undefined,
        fields,
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

  const cfg = rotationConfig();

  const microFamilies = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const top = microFamilies.slice(0, 10)
    .map((row) => {
      return [
        `#${row.rank ?? 'NA'} ${normalizeSideLabel(row.side)} ${row.familyId || 'NA'}`,
        `${row.microFamilyId || 'NA'}`,
        `completed=${row.completed ?? 0} fairWR=${fmtPctRatio(row.fairWinrate)} avgR=${fmt(row.avgR, 3)} totalR=${fmt(row.totalR, 3)} balanced=${fmt(row.balancedScore, 2)}`
      ].join('\n');
    })
    .join('\n\n');

  const summary = top || 'No active micro-families selected.';

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: label,
        color: rotation.empty ? 0xf59e0b : 0x7c3aed,
        fields: [
          field(
            'Rotation',
            [
              `id=${rotation.rotationId || 'NA'}`,
              `sourceWeek=${rotation.sourceWeekKey || 'NA'}`,
              `activeWeek=${rotation.activeWeekKey || 'NA'}`,
              `mode=${rotation.mode || 'NA'}`,
              `count=${rotation.microFamilyIds?.length || 0}`
            ].join('\n'),
            false
          ),
          field(
            'Selection',
            [
              `eligible=${rotation.eligibleCount ?? 'NA'}`,
              `ranked=${rotation.rankedCount ?? 'NA'}`,
              `minCompleted=${rotation.minWeightedCompleted ?? cfg.minWeightedCompleted}`,
              `topNPerSide=${rotation.topNPerSide ?? cfg.topNPerSide}`,
              `empty=${Boolean(rotation.empty)}`
            ].join('\n'),
            true
          ),
          field(
            'Top microFamilies',
            truncate(summary, DISCORD_LIMITS.fieldValue),
            false
          )
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
  const deleted = JSON.stringify(report.deleted || {}, null, 2);

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `RESET — ${report.type || 'UNKNOWN'}`,
        color: report.ok ? 0xf59e0b : 0xdc2626,
        fields: [
          field(
            'Result',
            [
              `ok=${Boolean(report.ok)}`,
              `reason=${report.reason || 'OK'}`,
              `force=${Boolean(report.force)}`,
              `openPositions=${report.openPositionsCount ?? 'NA'}`
            ].join('\n'),
            true
          ),
          field(
            'Preserved',
            JSON.stringify(report.preserved || {}, null, 2) || '{}',
            true
          ),
          field(
            'Deleted',
            truncate(deleted, 1000),
            false
          )
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('RESET', report, result);

  return result;
}