// ================= TRADE SYSTEM DISCORD NOTIFIER =================

const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_TRADE_A || process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_TRADE_B || process.env.DISCORD_WEBHOOK_B || WEBHOOK_A || "").trim();
const WEBHOOK_C = String(process.env.DISCORD_WEBHOOK_TRADE_C || process.env.DISCORD_WEBHOOK_C || WEBHOOK_B || WEBHOOK_A || "").trim();

const fetchFn = globalThis.fetch;

const MAX_RETRIES = 3;
const COOLDOWN_MINUTES = Number(process.env.TRADE_SIGNAL_COOLDOWN_MINUTES || 25);

const FIELD_VALUE_LIMIT = 1024;

const recentSignals = new Map();

// ================= BASIC HELPERS =================

function toUpperText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toUpperCase();
}

function compactNumber(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

function compactPrice(value) {
  const text = compactNumber(value, 6);
  return text === "N/A" ? "N/A" : `$\`${text}\``;
}

function compactPct(value, decimals = 2) {
  const text = compactNumber(value, decimals);
  return text === "N/A" ? "N/A" : `${text}%`;
}

function normalizeSide(side) {
  const s = String(side || "").trim().toLowerCase();
  if (["bear", "short", "sell", "bearish"].includes(s)) return "SHORT";
  return "LONG";
}

function normalizeGrade(value) {
  const raw = String(value || "").toUpperCase();
  if (["GOD", "A", "A_SHORT_EXCEPTION"].includes(raw)) return "A";
  if (["B", "B_TREND_PROBE", "BULLISH_MID_TREND_PROBE"].includes(raw)) return "B";
  if (raw === "C") return "C";
  if (raw.includes("GOD") || raw.startsWith("A")) return "A";
  if (raw.startsWith("B")) return "B";
  return "C";
}

function getTradeGrade(t) {
  return normalizeGrade(t?.liveGrade || t?.setupClass || t?.grade);
}

function getSetupClass(t) {
  return toUpperText(t?.setupClass || t?.discordMetrics?.setup?.setupClass || t?.discordEntryMetrics?.setup?.setupClass, "UNKNOWN");
}

function getWebhook(grade) {
  if (grade === "A") return WEBHOOK_A;
  if (grade === "B") return WEBHOOK_B;
  return WEBHOOK_C;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function truncateText(value, max = FIELD_VALUE_LIMIT) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  if (max <= 10) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

function makeField(name, value, inline = false) {
  if (value === undefined || value === null || value === "") return null;
  if (value === "N/A" || value === "$`N/A`") return null;

  return {
    name: truncateText(name, 256),
    value: truncateText(String(value), FIELD_VALUE_LIMIT),
    inline
  };
}

function makeKv(rows) {
  return rows
    .filter(row => Array.isArray(row) && row.length >= 2)
    .filter(([, value]) => value !== undefined && value !== null && value !== "" && value !== "N/A" && value !== "$`N/A`")
    .map(([key, value]) => `**${key}:** ${value}`)
    .join("\n");
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ================= COOLDOWN =================

function buildSignalKey(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  const setupClass = getSetupClass(t);
  const reason = toUpperText(t?.entryReason || t?.entryType || t?.reason, "ENTRY");
  const entry = compactNumber(t?.entry || t?.discordMetrics?.price?.entry, 8);

  return (
    t?.tradeId ||
    t?.discordMetrics?.tradeId ||
    `${symbol}_${side}_${setupClass}_${reason}_${entry}`
  );
}

function pruneRecentSignals(now, cooldownMs) {
  const maxAge = Math.max(cooldownMs * 4, 60 * 60 * 1000);
  for (const [key, ts] of recentSignals.entries()) {
    if (now - Number(ts || 0) > maxAge) {
      recentSignals.delete(key);
    }
  }
}

// ================= DISCORD SEND LOGIC =================

async function sendMessage(webhook, message) {
  if (!webhook || !fetchFn) {
    return { ok: false, discordSent: false };
  }

  const safeMessage = {
    allowed_mentions: { parse: [] },
    ...message
  };

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(safeMessage)
      });

      if (res.ok) {
        return { ok: true, discordSent: true, status: res.status };
      }

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        await sleep(Math.ceil(Number(data?.retry_after || 1.5) * 1000));
        continue;
      }
    } catch (e) {
      console.error("TRADE DISCORD ERROR:", e.message);
    }
    await sleep(1000 * i);
  }

  return { ok: false, discordSent: false };
}

// ================= ENTRY EMBED (SUPER SIMPEL) =================

function buildEntryEmbed(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  const color = side === "LONG" ? 0x00ff99 : 0xff4444;

  const entryPrice = compactPrice(t?.entry || t?.discordMetrics?.price?.entry);
  const tpPrice = compactPrice(t?.tp || t?.discordMetrics?.price?.tp);
  const slPrice = compactPrice(t?.sl || t?.discordMetrics?.price?.sl);

  const fields = [
    makeField("Prijzen", makeKv([
      ["Entry", entryPrice],
      ["Take Profit", tpPrice],
      ["Stop Loss", slPrice]
    ]), false)
  ].filter(Boolean);

  return {
    title: `🟢 ENTRY: ${symbol} ${side}`,
    color,
    fields,
    timestamp: new Date().toISOString()
  };
}

// ================= EXIT EMBED (SUPER SIMPEL) =================

function buildExitEmbed(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  
  const m = t?.discordOutcomeMetrics && typeof t.discordOutcomeMetrics === "object" ? t.discordOutcomeMetrics : {};
  const reason = toUpperText(m?.outcome?.exitReason || t?.reason || t?.exitReason, "EXIT");
  const pnlPct = safeNumber(m?.outcome?.pnlPct ?? t?.pnlPct, 0);

  let status = "GESLOTEN";
  let color = 0x3498db; // Blauw

  if (reason.includes("BE") || reason.includes("BREAK_EVEN")) {
    status = "BREAK EVEN";
    color = 0xf1c40f; // Geel
  } else if (reason.includes("TP") || reason.includes("TAKE_PROFIT")) {
    status = "TP GERAAKT";
    color = 0x2ecc71; // Groen
  } else if (reason.includes("SL") || reason.includes("STOP_LOSS")) {
    status = "SL GERAAKT";
    color = 0xe74c3c; // Rood
  }

  const fields = [
    makeField("Overzicht", makeKv([
      ["Entry", compactPrice(t?.entry)],
      ["Exit", compactPrice(t?.exit || t?.executionPrice)],
      ["Resultaat", compactPct(pnlPct, 2)]
    ]), false)
  ].filter(Boolean);

  return {
    title: `🔴 EXIT: ${symbol} ${side} | ${status}`,
    color,
    fields,
    timestamp: new Date().toISOString()
  };
}

// ================= MAIN FUNCTIONS =================

export async function sendEntry(t) {
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);

  const key = buildSignalKey(t);
  const now = Date.now();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

  pruneRecentSignals(now, cooldownMs);

  if (recentSignals.has(key) && (now - recentSignals.get(key)) < cooldownMs) {
    return {
      ok: true,
      discordSent: false,
      skipped: true,
      reason: "COOLDOWN",
      key
    };
  }

  const embed = buildEntryEmbed(t);
  const result = await sendMessage(webhook, { embeds: [embed] });

  if (result.discordSent) {
    recentSignals.set(key, now);
  }

  return {
    ...result,
    symbol: t?.symbol,
    grade,
    key
  };
}

export async function sendExit(t) {
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);

  const embed = buildExitEmbed(t);
  const result = await sendMessage(webhook, { embeds: [embed] });

  return {
    ...result,
    symbol: t?.symbol,
    grade,
    tradeId: t?.tradeId || t?.discordOutcomeMetrics?.tradeId || null
  };
}

export function clearDiscordCooldowns() {
  recentSignals.clear();
  return { ok: true, cleared: true };
}
