// ================= CONFIG =================
const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_B || "").trim();

const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System v2 🤖";
const MAX_RETRIES = 3;

// Alleen Discord cooldown. Execution gebeurt NIET hier.
const COOLDOWN_MINUTES = 25;

// ================= STATE =================
const recentSignals = new Map();

// ================= HELPERS =================
function toText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";

  return n
    .toFixed(8)
    .replace(/\.?0+$/, "");
}

function limit(text, max) {
  const s = toText(text, "");

  if (s.length <= max) {
    return s || "N/A";
  }

  return `${s.slice(0, max - 1)}…`;
}

function buildEmbed({ title, color, description }) {
  return {
    title: limit(title, 256),
    description: limit(description, 4096),
    color,
    footer: {
      text: FOOTER_TEXT,
    },
    timestamp: new Date().toISOString(),
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessage(webhook, message) {
  if (!webhook) {
    console.warn("DISCORD_WEBHOOK_MISSING");
    return {
      ok: false,
      skipped: true,
      error: "DISCORD_WEBHOOK_MISSING",
    };
  }

  if (!fetchFn) {
    console.error("FETCH_UNAVAILABLE");
    return {
      ok: false,
      skipped: true,
      error: "FETCH_UNAVAILABLE",
    };
  }

  let lastError = null;

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      if (res.ok) {
        return {
          ok: true,
          status: res.status,
        };
      }

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const waitMs = Math.ceil(Number(data?.retry_after || 1.5) * 1000);

        console.warn("DISCORD_RATE_LIMIT", JSON.stringify({
          attempt: i,
          waitMs,
        }));

        await sleep(waitMs);
        continue;
      }

      lastError = await res.text().catch(() => `HTTP_${res.status}`);

      console.error("DISCORD_HTTP_ERROR", JSON.stringify({
        attempt: i,
        status: res.status,
        error: String(lastError).slice(0, 500),
      }));
    } catch (error) {
      lastError = error.message;

      console.error("DISCORD_SEND_THROWN", JSON.stringify({
        attempt: i,
        error: error.message,
      }));
    }

    await sleep(1000 * i);
  }

  return {
    ok: false,
    error: lastError || "DISCORD_SEND_FAILED",
  };
}

function getWebhook(grade) {
  const g = String(grade || "").toUpperCase();

  if (g === "A") return WEBHOOK_A;
  if (g === "GOD") return WEBHOOK_A;

  if (g === "B") {
    return WEBHOOK_B || WEBHOOK_A;
  }

  return WEBHOOK_A;
}

function getTradeGrade(t) {
  const setupClass = String(t?.setupClass || "").toUpperCase();
  const liveGrade = String(t?.liveGrade || "").toUpperCase();
  const grade = String(t?.grade || "").toUpperCase();

  if (setupClass === "GOD" || liveGrade === "GOD" || grade === "GOD") {
    return "GOD";
  }

  if (setupClass === "A" || liveGrade === "A" || grade === "A") {
    return "A";
  }

  if (setupClass === "B" || liveGrade === "B" || grade === "B") {
    return "B";
  }

  if (setupClass === "B_TREND_PROBE") {
    return "B";
  }

  if (setupClass === "A_SHORT_EXCEPTION") {
    return "A";
  }

  return grade || setupClass || liveGrade || "C";
}

function getTradeReason(t) {
  return String(t?.reason || t?.oldReason || t?.entryReason || "UNKNOWN").toUpperCase();
}

function normalizeDisplaySide(side) {
  const value = String(side || "").trim().toLowerCase();

  if (["long", "buy", "bull", "bullish"].includes(value)) return "LONG";
  if (["short", "sell", "bear", "bearish"].includes(value)) return "SHORT";

  return value.toUpperCase() || "UNKNOWN";
}

function getCooldownKey(t, type) {
  const symbol = String(t?.symbol || "UNKNOWN").toUpperCase();
  const side = String(t?.side || "UNKNOWN").toLowerCase();
  const grade = getTradeGrade(t);

  return `${type}_${symbol}_${side}_${grade}`;
}

// ================= ENTRY MESSAGE =================
function formatEntryMessage(t) {
  const side = normalizeDisplaySide(t?.side);
  const direction = side === "LONG" ? "📈 LONG" : side === "SHORT" ? "📉 SHORT" : side;
  const grade = getTradeGrade(t);

  const entry = compactNumber(t.entry);
  const tp = compactNumber(t.tp ?? t.takeProfit);
  const sl = compactNumber(t.sl ?? t.stopLoss);
  const rr = compactNumber(t.rr);

  const cb = "```";

  return `
🟢 **${toText(t.symbol)} ${direction} (${grade})**

📥 ENTRY: \`${entry}\`
🎯 TP: \`${tp}\`
🛑 SL: \`${sl}\`

━━━━━━━━━━━━━━━
📋 **SNEL KOPIËREN**

ENTRY
${cb}${entry}${cb}

TP
${cb}${tp}${cb}

SL
${cb}${sl}${cb}

━━━━━━━━━━━━━━━
📊 RR: ${rr}
🎯 Sniper: ${toText(t.sniperScore)}
🧠 Confluence: ${toText(t.confluence)}
📌 Reason: ${getTradeReason(t)}
`;
}

// ================= EXIT MESSAGE =================
function formatExitMessage(t) {
  const reason = String(t?.reason || "").toUpperCase();

  const entry = compactNumber(t.entry);
  const exit = compactNumber(t.exit ?? t.executionPrice);
  const tp = compactNumber(t.tp);
  const sl = compactNumber(t.sl);
  const rr = compactNumber(t.rr);
  const exitR = compactNumber(t.exitR);
  const pnlPct = compactNumber(t.pnlPct);

  if (reason === "TP") {
    return `
✅ **TP geraakt op ${toText(t.symbol)}**

📥 ENTRY: \`${entry}\`
🎯 TP: \`${tp}\`
📤 EXIT: \`${exit}\`

━━━━━━━━━━━━━━━
📊 RR: ${rr}
💰 Exit R: ${exitR}
📈 PnL %: ${pnlPct}
`;
  }

  if (reason === "BE_SL") {
    return `
🟡 **Break-even stop geraakt op ${toText(t.symbol)}**

📥 ENTRY: \`${entry}\`
🛑 SL: \`${sl}\`
📤 EXIT: \`${exit}\`

━━━━━━━━━━━━━━━
📊 RR: ${rr}
💰 Exit R: ${exitR}
📈 PnL %: ${pnlPct}
`;
  }

  return `
❌ **SL geraakt op ${toText(t.symbol)}**

📥 ENTRY: \`${entry}\`
🛑 SL: \`${sl}\`
📤 EXIT: \`${exit}\`

━━━━━━━━━━━━━━━
📊 RR: ${rr}
💰 Exit R: ${exitR}
📉 PnL %: ${pnlPct}
`;
}

// ================= EXPORTS =================
// BELANGRIJK:
// Deze file doet GEEN Bitget execution.
// Execution gebeurt in tradeSystem.js via:
// executeTradeSystemEntryViaSignalRoute() -> /api/signal
export async function sendEntry(t) {
  const symbol = String(t?.symbol || "UNKNOWN").toUpperCase();
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);

  const now = Date.now();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
  const cooldownKey = getCooldownKey(t, "ENTRY");
  const lastSent = recentSignals.get(cooldownKey);

  if (lastSent && now - lastSent < cooldownMs) {
    console.log("DISCORD_ENTRY_COOLDOWN", JSON.stringify({
      symbol,
      grade,
      cooldownKey,
      remainingMs: cooldownMs - (now - lastSent),
    }));

    return {
      ok: false,
      skipped: true,
      error: "DISCORD_ENTRY_COOLDOWN",
      symbol,
      grade,
    };
  }

  console.log("SEND_ENTRY_DISCORD_ONLY", JSON.stringify({
    symbol,
    side: t?.side,
    grade,
    setupClass: t?.setupClass,
    reason: getTradeReason(t),
    entry: t?.entry,
    sl: t?.sl ?? t?.stopLoss,
    tp: t?.tp ?? t?.takeProfit,
    rr: t?.rr,
    confluence: t?.confluence,
    sniperScore: t?.sniperScore,
  }));

  const embed = buildEmbed({
    title: `${symbol} Entry Signal`,
    color: grade === "A" || grade === "GOD" ? 0x00ff99 : 0xf1c40f,
    description: formatEntryMessage(t),
  });

  const result = await sendMessage(webhook, {
    embeds: [embed],
  });

  if (result.ok) {
    recentSignals.set(cooldownKey, now);
  }

  return {
    ok: result.ok,
    discordSent: result.ok,
    symbol,
    grade,
    result,
  };
}

export async function sendExit(t) {
  const symbol = String(t?.symbol || "UNKNOWN").toUpperCase();
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);

  console.log("SEND_EXIT_DISCORD_ONLY", JSON.stringify({
    symbol,
    side: t?.side,
    grade,
    setupClass: t?.setupClass,
    reason: t?.reason,
    entry: t?.entry,
    exit: t?.exit ?? t?.executionPrice,
    sl: t?.sl,
    tp: t?.tp,
    rr: t?.rr,
    exitR: t?.exitR,
    pnlPct: t?.pnlPct,
  }));

  const reason = String(t?.reason || "").toUpperCase();

  const embed = buildEmbed({
    title: `${symbol} Exit`,
    color: reason === "TP" ? 0x2ecc71 : reason === "BE_SL" ? 0xf1c40f : 0xe74c3c,
    description: formatExitMessage(t),
  });

  const result = await sendMessage(webhook, {
    embeds: [embed],
  });

  return {
    ok: result.ok,
    discordSent: result.ok,
    symbol,
    grade,
    result,
  };
}