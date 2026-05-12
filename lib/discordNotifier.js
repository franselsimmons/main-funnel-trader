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

// Alleen runtime cooldown tegen Discord-spam.
// Durable tradeSystem memory blijft leidend voor echte posities.
const recentSignals = new Map();

// ================= HELPERS =================
function toText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(8).replace(/\.?0+$/, "");
}

function limit(text, max) {
  const s = toText(text, "");
  if (s.length <= max) return s || "N/A";
  return `${s.slice(0, max - 1)}…`;
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

function buildEmbed({ title, color, description }) {
  return {
    title: limit(title, 256),
    description: limit(description, 4096),
    color,
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString(),
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendMessage(webhook, message) {
  if (!webhook) {
    return {
      ok: false,
      discordSent: false,
      error: "DISCORD_WEBHOOK_MISSING",
    };
  }

  if (!fetchFn) {
    return {
      ok: false,
      discordSent: false,
      error: "FETCH_UNAVAILABLE",
    };
  }

  let lastError = null;
  let lastStatus = null;

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      lastStatus = res.status;

      if (res.ok) {
        return {
          ok: true,
          discordSent: true,
          status: res.status,
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
    error: lastError || "DISCORD_SEND_FAILED",
  };
}

function getEntryColor(t) {
  const grade = getTradeGrade(t);

  if (grade === "A" || grade === "GOD") return 0x00ff99;
  if (grade === "B") return 0xf1c40f;

  return 0x3498db;
}

// ================= ENTRY MESSAGE =================
function formatEntryMessage(t) {
  const side = normalizeSide(t?.side);
  const direction = side === "bull" ? "📈 LONG" : "📉 SHORT";
  const grade = getTradeGrade(t);

  const entry = compactNumber(t.entry);
  const tp = compactNumber(t.tp ?? t.takeProfit);
  const sl = compactNumber(t.sl ?? t.stopLoss);
  const rr = compactNumber(t.rr);

  const cb = "```";

  return `
🟢 **${toText(t.symbol)} ${direction} (${grade})**
📊 RR: **${rr}**🎯 Sniper: **${toText(t.sniperScore)}**🧲 Conf: **${toText(t.confluence)}**📉 RSI: **${toText(t.rsi)}**📍 RSI Zone: **${toText(t.rsiZone)}**📚 OB: **${toText(t.obBias)}**
Setup: **${toText(t.setupClass || grade)}**
Reason: **${toText(t.reason || t.entryReason || "ENTRY")}**
📥 ENTRY: \`${entry}\`
🎯 TP: \`${tp}\`
🛑 SL: \`${sl}\`

━━━━━━━━━━━━━━━

ENTRY
${cb}${entry}${cb}

TP
${cb}${tp}${cb}

SL
${cb}${sl}${cb}

━━━━━━━━━━━━━━━
📊 RR: **${rr}**
🎯 Sniper: **${toText(t.sniperScore)}**
🧲 Conf: **${toText(t.confluence)}**
📉 RSI: **${toText(t.rsi)}**
📍 RSI Zone: **${toText(t.rsiZone)}**
📚 OB: **${toText(t.obBias)}**
`;
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
  const pnlPct = compactNumber(t.pnlPct);

  if (isWin) {
    return `
✅ **TP geraakt op ${toText(t.symbol)}**

🎯 TP: \`${tp}\`
💰 RR: **${rr}**
📊 Exit R: **${exitR}**
📈 PnL %: **${pnlPct}**
`;
  }

  if (isBreakEven) {
    return `
🟡 **Break-even stop op ${toText(t.symbol)}**

🛑 SL: \`${sl}\`
📊 Exit R: **${exitR}**
📈 PnL %: **${pnlPct}**
Reason: **${toText(t.reason)}**
`;
  }

  return `
❌ **SL geraakt op ${toText(t.symbol)}**

🛑 SL: \`${sl}\`
📊 Exit R: **${exitR}**
📈 PnL %: **${pnlPct}**
Reason: **${toText(t.reason)}**
`;
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
      key,
    };
  }

  const embed = buildEmbed({
    title: `${symbol} Signal`,
    color: getEntryColor(t),
    description: formatEntryMessage(t),
  });

  const result = await sendMessage(webhook, {
    embeds: [embed],
  });

  if (result.discordSent) {
    recentSignals.set(key, now);
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
  }));

  return {
    ...result,
    symbol,
    grade,
    key,
  };
}

export async function sendExit(t) {
  const symbol = t?.symbol || "UNKNOWN";
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);
  const reason = String(t?.reason || "").toUpperCase();

  const embed = buildEmbed({
    title: `${symbol} Exit`,
    color: reason === "TP" || reason === "TAKE_PROFIT" ? 0x2ecc71 : 0xe74c3c,
    description: formatExitMessage(t),
  });

  const result = await sendMessage(webhook, {
    embeds: [embed],
  });

  console.log("TRADE_DISCORD_EXIT_RESULT", JSON.stringify({
    symbol,
    grade,
    setupClass: t?.setupClass,
    reason,
    discordSent: result.discordSent,
    status: result.status,
    error: result.error || null,
  }));

  return {
    ...result,
    symbol,
    grade,
  };
}

export function clearDiscordCooldowns() {
  recentSignals.clear();

  return {
    ok: true,
    cleared: true,
    profile: "TRADE_SYSTEM",
    at: Date.now(),
  };
}