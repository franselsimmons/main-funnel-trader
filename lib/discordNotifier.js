// ================= TRADE SYSTEM DISCORD NOTIFIER =================

const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_TRADE_A || process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_TRADE_B || process.env.DISCORD_WEBHOOK_B || WEBHOOK_A || "").trim();
const WEBHOOK_C = String(process.env.DISCORD_WEBHOOK_TRADE_C || process.env.DISCORD_WEBHOOK_C || WEBHOOK_B || WEBHOOK_A || "").trim();

const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System";
const MAX_RETRIES = 3;
const COOLDOWN_MINUTES = Number(process.env.TRADE_SIGNAL_COOLDOWN_MINUTES || 25);
const recentSignals = new Map();

// ================= HELPERS =================

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

function normalizeSide(side) {
  const s = String(side || "").trim().toLowerCase();
  if (["bear", "short", "sell", "bearish"].includes(s)) return "SHORT";
  return "LONG";
}

function getTradeGrade(t) {
  return toUpperText(t?.liveGrade || t?.setupClass || t?.grade, "C");
}

function getWebhook(grade) {
  if (grade === "A" || grade === "GOD") return WEBHOOK_A;
  if (grade === "B") return WEBHOOK_B;
  return WEBHOOK_C;
}

function makeField(name, value, inline = false) {
  if (!value || value === "N/A" || value === "$`N/A`") return null;
  return { name, value: String(value), inline };
}

function buildSignalKey(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  return `${symbol}_${side}_${Date.now()}`;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ================= DISCORD VERZEND LOGICA =================

async function sendMessage(webhook, message) {
  if (!webhook || !fetchFn) return { ok: false, discordSent: false };

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
      });

      if (res.ok) return { ok: true, discordSent: true, status: res.status };

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

// ================= ENTRY BERICHT =================

function buildEntryEmbed(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  const color = side === "LONG" ? 0x00ff99 : 0xff4444;

  const entryPrice = compactPrice(t?.entry || t?.liveMetrics?.entry);
  const tpPrice = compactPrice(t?.tp || t?.liveMetrics?.tp);
  const slPrice = compactPrice(t?.sl || t?.liveMetrics?.sl);

  return {
    title: `Signaal: ${symbol} ${side}`,
    color: color,
    fields: [
      makeField("Entry", entryPrice, true),
      makeField("TP", tpPrice, true),
      makeField("SL", slPrice, true)
    ].filter(Boolean),
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
}

// ================= EXIT BERICHT =================

function buildExitEmbed(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const reason = toUpperText(t?.reason, "EXIT");
  
  let status = "Gesloten";
  let color = 0x3498db; // Standaard blauw

  if (reason.includes("TP") || reason.includes("TAKE_PROFIT")) {
    status = "TP Geraakt";
    color = 0x2ecc71; // Groen
  } else if (reason.includes("SL") || reason.includes("STOP_LOSS")) {
    status = "SL Geraakt";
    color = 0xe74c3c; // Rood
  } else if (reason.includes("BE") || reason.includes("BREAK_EVEN")) {
    status = "Break Even";
    color = 0xf1c40f; // Geel
  }

  const pnl = compactNumber(t?.pnlPct);
  const pnlText = pnl !== "N/A" ? `${pnl}%` : "N/A";

  return {
    title: `${symbol}: ${status}`,
    color: color,
    fields: [
      makeField("PnL", `**${pnlText}**`, true)
    ].filter(Boolean),
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
}

// ================= HOOFD FUNCTIES =================

export async function sendEntry(t) {
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);
  const key = buildSignalKey(t);
  const now = Date.now();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

  if (recentSignals.has(key) && (now - recentSignals.get(key)) < cooldownMs) {
    return { ok: true, skipped: true, reason: "COOLDOWN" };
  }

  const embed = buildEntryEmbed(t);
  const result = await sendMessage(webhook, { embeds: [embed] });

  if (result.discordSent) recentSignals.set(key, now);

  return { ...result, symbol: t?.symbol, grade, key };
}

export async function sendExit(t) {
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);

  const embed = buildExitEmbed(t);
  const result = await sendMessage(webhook, { embeds: [embed] });

  return { ...result, symbol: t?.symbol, grade };
}

export function clearDiscordCooldowns() {
  recentSignals.clear();
  return { ok: true, cleared: true };
}
