// ================= TRADE SYSTEM DISCORD NOTIFIER =================

const WEBHOOK_A = String(
  process.env.DISCORD_WEBHOOK_TRADE_A ||
  process.env.DISCORD_WEBHOOK_A ||
  ""
).trim();

const WEBHOOK_B = String(
  process.env.DISCORD_WEBHOOK_TRADE_B ||
  process.env.DISCORD_WEBHOOK_B ||
  WEBHOOK_A ||
  ""
).trim();

const WEBHOOK_C = String(
  process.env.DISCORD_WEBHOOK_TRADE_C ||
  process.env.DISCORD_WEBHOOK_C ||
  WEBHOOK_B ||
  WEBHOOK_A ||
  ""
).trim();

const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System v2 🤖";
const MAX_RETRIES = 3;
const COOLDOWN_MINUTES = Number(process.env.TRADE_SIGNAL_COOLDOWN_MINUTES || 25);

// Discord limits.
// Field value max is 1024. Keep margin because code block chars count too.
const DISCORD_FIELD_VALUE_LIMIT = 900;
const DISCORD_FIELDS_PER_DIAGNOSTIC_EMBED = 5;

// Zet op "true" als diagnostics fire-and-forget moeten zijn.
// Default = false, dus betrouwbaarder: Discord krijgt de filterwaarden voordat sendEntry() klaar is.
const DISCORD_DIAGNOSTICS_ASYNC =
  String(process.env.DISCORD_DIAGNOSTICS_ASYNC || "false").toLowerCase() === "true";

// Alleen runtime cooldown tegen Discord-spam.
// Durable tradeSystem memory blijft leidend voor echte posities.
const recentSignals = new Map();

// ================= BASIC HELPERS =================
function toText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(8).replace(/\.?0+$/, "");
}

function compactPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return `${(n * 100).toFixed(3).replace(/\.?0+$/, "")}%`;
}

function limit(text, max) {
  const s = toText(text, "");
  if (s.length <= max) return s || "N/A";
  return `${s.slice(0, max - 1)}…`;
}

function chunkArray(rows, size) {
  const arr = Array.isArray(rows) ? rows : [];
  const n = Math.max(1, Number(size || 1));
  const chunks = [];

  for (let i = 0; i < arr.length; i += n) {
    chunks.push(arr.slice(i, i + n));
  }

  return chunks;
}

function normalizeGrade(value) {
  const g = String(value || "").toUpperCase();

  if (g === "GOD") return "GOD";
  if (g === "A" || g === "A_SHORT_EXCEPTION") return "A";
  if (g === "B" || g === "B_TREND_PROBE") return "B";

  return g || "C";
}

function normalizeSide(side) {
  const s = String(side || "").trim().toLowerCase();

  if (["bear", "short", "sell", "bearish"].includes(s)) return "bear";
  if (["bull", "long", "buy", "bullish"].includes(s)) return "bull";

  return "bull";
}

function getTradeGrade(t) {
  return normalizeGrade(
    t?.liveGrade ||
    t?.grade ||
    t?.setupClass ||
    "C"
  );
}

function getWebhook(grade) {
  const g = normalizeGrade(grade);

  if (g === "A" || g === "GOD") return WEBHOOK_A;
  if (g === "B") return WEBHOOK_B;

  return WEBHOOK_C;
}

function buildSignalKey(t) {
  const symbol = String(t?.symbol || "UNKNOWN").toUpperCase();
  const side = normalizeSide(t?.side);
  const grade = getTradeGrade(t);
  const setupClass = String(t?.setupClass || grade || "ENTRY").toUpperCase();

  return `${symbol}_${side}_${setupClass}`;
}

function buildEmbed({
  title,
  color,
  description,
  fields = []
}) {
  return {
    title: limit(title, 256),
    description: limit(description, 4096),
    color,
    fields: Array.isArray(fields) ? fields.slice(0, 25) : [],
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ================= DISCORD SEND =================
async function sendMessage(webhook, message) {
  if (!webhook) {
    return {
      ok: false,
      discordSent: false,
      error: "DISCORD_WEBHOOK_MISSING"
    };
  }

  if (!fetchFn) {
    return {
      ok: false,
      discordSent: false,
      error: "FETCH_UNAVAILABLE"
    };
  }

  let lastError = null;
  let lastStatus = null;

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(message)
      });

      lastStatus = res.status;

      if (res.ok) {
        return {
          ok: true,
          discordSent: true,
          status: res.status
        };
      }

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const wait = Math.ceil(Number(data?.retry_after || 1.5) * 1000);

        await sleep(wait);
        continue;
      }

      lastError = await res.text().catch(() => `discord_status_${res.status}`);
    } catch (e) {
      lastError = e?.message || "DISCORD_SEND_FAILED";
    }

    await sleep(1000 * i);
  }

  console.error("TRADE DISCORD ERROR:", lastError);

  return {
    ok: false,
    discordSent: false,
    status: lastStatus,
    error: lastError || "DISCORD_SEND_FAILED"
  };
}

// ================= ENTRY / EXIT COLORS =================
function getEntryColor(t) {
  const grade = getTradeGrade(t);

  if (grade === "A" || grade === "GOD") return 0x00ff99;
  if (grade === "B") return 0xf1c40f;

  return 0x3498db;
}

function getExitColor(t) {
  const reason = String(t?.reason || "").toUpperCase();

  if (reason === "TP" || reason === "TAKE_PROFIT") return 0x2ecc71;
  if (reason === "BE_SL" || reason === "BREAK_EVEN") return 0xf1c40f;

  return 0xe74c3c;
}

// ================= DIAGNOSTIC HELPERS =================
function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function formatDiagnosticValue(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NaN";

    if (Math.abs(value) > 0 && Math.abs(value) < 0.01) {
      return value.toFixed(8).replace(/\.?0+$/, "");
    }

    return String(Number(value.toFixed(6)));
  }

  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return safeJsonStringify(value);
  }

  if (typeof value === "object") {
    return safeJsonStringify(value);
  }

  return String(value);
}

function flattenObject(obj, prefix = "") {
  if (!obj || typeof obj !== "object") return [];

  const rows = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      rows.push(...flattenObject(value, fullKey));
      continue;
    }

    rows.push([
      fullKey,
      formatDiagnosticValue(value)
    ]);
  }

  return rows;
}

function splitLongLine(line, maxLength = DISCORD_FIELD_VALUE_LIMIT) {
  const s = String(line || "");

  if (s.length <= maxLength) {
    return [s];
  }

  const chunks = [];

  for (let i = 0; i < s.length; i += maxLength) {
    chunks.push(s.slice(i, i + maxLength));
  }

  return chunks;
}

function chunkLines(lines, maxLength = DISCORD_FIELD_VALUE_LIMIT) {
  const chunks = [];
  let current = "";

  for (const rawLine of Array.isArray(lines) ? lines : []) {
    const parts = splitLongLine(rawLine, maxLength);

    for (const line of parts) {
      const next = current ? `${current}\n${line}` : line;

      if (next.length > maxLength && current) {
        chunks.push(current);
        current = line;
        continue;
      }

      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function buildSectionFields(sectionName, obj) {
  if (!obj || typeof obj !== "object") return [];

  const lines = flattenObject(obj)
    .map(([key, value]) => `${key}: ${value}`);

  if (!lines.length) return [];

  const chunks = chunkLines(lines, DISCORD_FIELD_VALUE_LIMIT);

  return chunks.map((chunk, index) => ({
    name: limit(
      chunks.length > 1
        ? `${sectionName} ${index + 1}/${chunks.length}`
        : sectionName,
      256
    ),
    value: `\`\`\`txt\n${chunk}\n\`\`\``,
    inline: false
  }));
}

function normalizeDiagnosticsPayload(t) {
  const diagnostics = t?.filterDiagnostics;

  if (diagnostics && typeof diagnostics === "object") {
    return {
      filterValues: diagnostics.filterValues || t?.filterValues || null,
      liveMetrics: diagnostics.liveMetrics || t?.liveFilterMetrics || null,
      passMap: diagnostics.passMap || t?.filterChecks || null,
      specialChecks: diagnostics.specialChecks || t?.specialFilterChecks || null
    };
  }

  return {
    filterValues: t?.filterValues || null,
    liveMetrics: t?.liveFilterMetrics || null,
    passMap: t?.filterChecks || null,
    specialChecks: t?.specialFilterChecks || null
  };
}

function hasDiagnostics(t) {
  const d = normalizeDiagnosticsPayload(t);

  return Boolean(
    d.filterValues ||
    d.liveMetrics ||
    d.passMap ||
    d.specialChecks
  );
}

function buildDiagnosticFields(t) {
  const diagnostics = normalizeDiagnosticsPayload(t);

  return [
    ...buildSectionFields("📊 Live metrics", diagnostics.liveMetrics),
    ...buildSectionFields("✅ Filter checks", diagnostics.passMap),
    ...buildSectionFields("🧩 Special checks", diagnostics.specialChecks),
    ...buildSectionFields("⚙️ Filter values", diagnostics.filterValues)
  ];
}

function buildDiagnosticEmbeds(t) {
  if (!hasDiagnostics(t)) return [];

  const symbol = String(t?.symbol || "UNKNOWN").toUpperCase();
  const side = normalizeSide(t?.side);
  const direction = side === "bull" ? "LONG" : "SHORT";
  const grade = getTradeGrade(t);
  const setupClass = String(t?.setupClass || grade || "UNKNOWN").toUpperCase();
  const reason = String(t?.reason || t?.entryReason || t?.entryType || "ENTRY").toUpperCase();

  const color = getEntryColor(t);
  const fields = buildDiagnosticFields(t);

  if (!fields.length) return [];

  const chunks = chunkArray(fields, DISCORD_FIELDS_PER_DIAGNOSTIC_EMBED);

  return chunks.map((fieldChunk, index) => buildEmbed({
    title: `${symbol} Filter Diagnostics ${index + 1}/${chunks.length}`,
    color,
    description: [
      `**${symbol} ${direction} (${grade})**`,
      `Setup: **${setupClass}**`,
      `Reason: **${reason}**`,
      `Alle live filterwaardes + pass/fail checks voor deze entry.`
    ].join("\n"),
    fields: fieldChunk
  }));
}

async function sendEntryDiagnostics(webhook, t) {
  const embeds = buildDiagnosticEmbeds(t);

  if (!embeds.length) {
    return {
      attempted: false,
      sent: 0,
      failed: 0,
      total: 0,
      reason: "NO_DIAGNOSTICS"
    };
  }

  let sent = 0;
  let failed = 0;
  const results = [];

  // Eén diagnostic embed per message.
  // Dit voorkomt Discord 6000-char aggregate embed errors.
  for (const embed of embeds) {
    const result = await sendMessage(webhook, {
      embeds: [embed]
    });

    results.push({
      discordSent: Boolean(result.discordSent),
      status: result.status,
      error: result.error || null
    });

    if (result.discordSent) sent++;
    else failed++;
  }

  return {
    attempted: true,
    sent,
    failed,
    total: embeds.length,
    results
  };
}

// ================= ENTRY MESSAGE =================
function formatEntryMessage(t) {
  const side = normalizeSide(t?.side);
  const direction = side === "bull" ? "📈 LONG" : "📉 SHORT";
  const grade = getTradeGrade(t);

  const entry = compactNumber(t.entry);
  const tp = compactNumber(t.tp ?? t.takeProfit);
  const sl = compactNumber(t.sl ?? t.stopLoss);
  const rr = compactNumber(t.rr ?? t.finalRr ?? t.plannedRR);

  const baseRR = compactNumber(t.baseRR);
  const finalRR = compactNumber(t.finalRr ?? t.plannedRR ?? t.rr);

  const spreadPct = Number.isFinite(Number(t.spreadPct))
    ? compactPct(Number(t.spreadPct))
    : "N/A";

  const depth = compactNumber(t.depthMinUsd1p);
  const funding = Number.isFinite(Number(t.funding))
    ? compactPct(Number(t.funding))
    : "N/A";

  const setupClass = toText(t.setupClass || grade);
  const reason = toText(t.reason || t.entryReason || t.entryType);

  return [
    `🟢 **${toText(t.symbol)} ${direction} (${grade})**`,
    ``,
    `**Setup**`,
    `• Class: **${setupClass}**`,
    `• Reason: **${reason}**`,
    `• Stage: **${toText(t.stage)}**`,
    `• Scanner stage: **${toText(t.scannerStage)}**`,
    ``,
    `**Risk geometry**`,
    `• Entry: \`${entry}\``,
    `• TP: \`${tp}\``,
    `• SL: \`${sl}\``,
    `• RR: **${rr}**`,
    `• Base RR: **${baseRR}**`,
    `• Final RR: **${finalRR}**`,
    ``,
    `**Signal quality**`,
    `• Sniper: **${toText(t.sniperScore)}**`,
    `• Confluence: **${toText(t.confluence)}**`,
    `• Raw confluence: **${toText(t.rawConfluence)}**`,
    `• Score: **${toText(t.score)}**`,
    ``,
    `**RSI / OB / Flow**`,
    `• RSI: **${toText(t.rsi)}**`,
    `• RSI HTF: **${toText(t.rsiHTF)}**`,
    `• RSI Zone: **${toText(t.rsiZone)}**`,
    `• RSI Edge: **${toText(t.rsiEdge || t.rsiEntryEdge)}**`,
    `• OB: **${toText(t.obBias)}**`,
    `• Spread: **${spreadPct}**`,
    `• Depth 1%: **$${depth}**`,
    `• Flow: **${toText(t.flow)}**`,
    `• Funding: **${funding}**`,
    ``,
    hasDiagnostics(t)
      ? `📎 Filter diagnostics worden meegestuurd in vervolg-embeds.`
      : `📎 Geen filter diagnostics in payload.`
  ].join("\n");
}

// ================= EXIT MESSAGE =================
function formatExitMessage(t) {
  const reason = String(t.reason || "").toUpperCase();

  const isWin =
    reason === "TP" ||
    reason === "TAKE_PROFIT";

  const isBreakEven =
    reason === "BE_SL" ||
    reason === "BREAK_EVEN";

  const tp = compactNumber(t.tp);
  const sl = compactNumber(t.sl);
  const rr = compactNumber(t.rr);
  const exitR = compactNumber(t.exitR);
  const triggerR = compactNumber(t.triggerR);
  const pnlPct = compactNumber(t.pnlPct);
  const mfeR = compactNumber(t.mfeR);
  const maeR = compactNumber(t.maeR);
  const holdMinutes = compactNumber(t.holdMinutes);

  if (isWin) {
    return [
      `✅ **TP geraakt op ${toText(t.symbol)}**`,
      ``,
      `🎯 TP: \`${tp}\``,
      `💰 RR: **${rr}**`,
      `📊 Exit R: **${exitR}**`,
      `📊 Trigger R: **${triggerR}**`,
      `📈 PnL %: **${pnlPct}**`,
      `🚀 MFE R: **${mfeR}**`,
      `🧨 MAE R: **${maeR}**`,
      `⏱️ Hold: **${holdMinutes} min**`
    ].join("\n");
  }

  if (isBreakEven) {
    return [
      `🟡 **Break-even stop op ${toText(t.symbol)}**`,
      ``,
      `🛑 SL: \`${sl}\``,
      `📊 Exit R: **${exitR}**`,
      `📊 Trigger R: **${triggerR}**`,
      `📈 PnL %: **${pnlPct}**`,
      `🚀 MFE R: **${mfeR}**`,
      `🧨 MAE R: **${maeR}**`,
      `⏱️ Hold: **${holdMinutes} min**`,
      `Reason: **${toText(t.reason)}**`
    ].join("\n");
  }

  return [
    `❌ **SL / exit op ${toText(t.symbol)}**`,
    ``,
    `🛑 SL: \`${sl}\``,
    `📊 Exit R: **${exitR}**`,
    `📊 Trigger R: **${triggerR}**`,
    `📈 PnL %: **${pnlPct}**`,
    `🚀 MFE R: **${mfeR}**`,
    `🧨 MAE R: **${maeR}**`,
    `⏱️ Hold: **${holdMinutes} min**`,
    `Reason: **${toText(t.reason)}**`
  ].join("\n");
}

// ================= EXPORTS =================
export async function sendEntry(t) {
  const symbol = t?.symbol || "UNKNOWN";
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);

  const now = Date.now();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
  const key = buildSignalKey(t);

  const lastSent = recentSignals.get(key);

  if (lastSent && now - lastSent < cooldownMs) {
    console.log("TRADE DISCORD COOLDOWN:", key);

    return {
      ok: true,
      skipped: true,
      discordSent: false,
      reason: "DISCORD_COOLDOWN",
      key
    };
  }

  const embed = buildEmbed({
    title: `${symbol} Signal`,
    color: getEntryColor(t),
    description: formatEntryMessage(t)
  });

  const result = await sendMessage(webhook, {
    embeds: [embed]
  });

  let diagnosticResult = {
    attempted: false,
    sent: 0,
    failed: 0,
    total: 0,
    reason: "MAIN_ENTRY_NOT_SENT"
  };

  if (result.discordSent) {
    recentSignals.set(key, now);

    if (DISCORD_DIAGNOSTICS_ASYNC) {
      diagnosticResult = {
        attempted: true,
        queued: true,
        async: true
      };

      sendEntryDiagnostics(webhook, t)
        .then(diag => {
          console.log("TRADE_DISCORD_ENTRY_DIAGNOSTICS_RESULT", JSON.stringify({
            symbol,
            grade,
            setupClass: t?.setupClass,
            reason: t?.reason || t?.entryReason,
            key,
            ...diag
          }));
        })
        .catch(e => {
          console.error("TRADE_DISCORD_ENTRY_DIAGNOSTICS_ERROR:", JSON.stringify({
            symbol,
            grade,
            key,
            error: e?.message || "DIAGNOSTICS_SEND_FAILED"
          }));
        });
    } else {
      diagnosticResult = await sendEntryDiagnostics(webhook, t);
    }
  }

  console.log("TRADE_DISCORD_ENTRY_RESULT", JSON.stringify({
    symbol,
    grade,
    setupClass: t?.setupClass,
    reason: t?.reason || t?.entryReason,
    key,
    discordSent: result.discordSent,
    status: result.status,
    error: result.error || null,
    diagnostics: diagnosticResult
  }));

  return {
    ...result,
    symbol,
    grade,
    key,
    diagnostics: diagnosticResult
  };
}

export async function sendExit(t) {
  const symbol = t?.symbol || "UNKNOWN";
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);
  const reason = String(t?.reason || "").toUpperCase();

  const embed = buildEmbed({
    title: `${symbol} Exit`,
    color: getExitColor(t),
    description: formatExitMessage(t)
  });

  const result = await sendMessage(webhook, {
    embeds: [embed]
  });

  console.log("TRADE_DISCORD_EXIT_RESULT", JSON.stringify({
    symbol,
    grade,
    setupClass: t?.setupClass,
    reason,
    discordSent: result.discordSent,
    status: result.status,
    error: result.error || null
  }));

  return {
    ...result,
    symbol,
    grade
  };
}

export function clearDiscordCooldowns() {
  recentSignals.clear();

  return {
    ok: true,
    cleared: true,
    profile: "TRADE_SYSTEM",
    at: Date.now()
  };
}