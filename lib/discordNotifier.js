// ================= CONFIG =================
const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_B || "").trim();

const MAIN_BOT_ENABLED = parseBoolean(process.env.MAIN_BOT_ENABLED, true);
const MAIN_BOT_WEBHOOK_URL = String(process.env.MAIN_BOT_WEBHOOK_URL || "").trim();
const MAIN_BOT_WEBHOOK_SECRET = String(process.env.MAIN_BOT_WEBHOOK_SECRET || "").trim();
const MAIN_BOT_DRY_RUN = parseBoolean(process.env.MAIN_BOT_DRY_RUN, true);
const MAIN_BOT_DEFAULT_RISK_PCT = parseNumber(process.env.MAIN_BOT_DEFAULT_RISK_PCT, 2);
const MAIN_BOT_DEFAULT_LEVERAGE = parseNumber(process.env.MAIN_BOT_DEFAULT_LEVERAGE, 10);

const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System v2 🤖";
const MAX_RETRIES = 3;
const COOLDOWN_MINUTES = 25;

// ================= STATE =================
const recentSignals = new Map();

// Alleen echte A/GOD mogen naar Bitget executor.
const MAIN_EXECUTABLE_GRADES = new Set(["A", "GOD"]);

const MAIN_BLOCKED_REASONS = new Set([
  "OBSERVED",
  "SCAN_OBSERVED",
  "WATCH",
  "NONE",
  "UNKNOWN",
  "LOW_RR",
  "LOW_FINAL_RR",
  "RSI_LONG_NO_EDGE",
  "RSI_SHORT_NO_EDGE",
  "COOLDOWN",
  "SYMBOL_COOLDOWN",
  "RECENT_SIGNAL_COOLDOWN",
]);

// ================= HELPERS =================
function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;

  const normalized = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;

  return fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(6).replace(/\.?0+$/, "");
}

function limit(text, max) {
  const s = toText(text, "");
  if (s.length <= max) return s || "N/A";
  return `${s.slice(0, max - 1)}…`;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeSignalId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 96);
}

function normalizeBotSymbol(symbol) {
  const clean = String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!clean) return null;
  if (clean.endsWith("USDT")) return clean;

  return `${clean}USDT`;
}

function normalizeBotSide(side) {
  const value = String(side || "").trim().toLowerCase();

  if (["long", "buy", "bull", "bullish"].includes(value)) return "long";
  if (["short", "sell", "bear", "bearish"].includes(value)) return "short";

  return null;
}

function getStrictTradeGrade(t) {
  const setupClass = String(t?.setupClass || "").toUpperCase();
  const liveGrade = String(t?.liveGrade || "").toUpperCase();
  const grade = String(t?.grade || "").toUpperCase();

  if (setupClass === "GOD" || liveGrade === "GOD" || grade === "GOD") return "GOD";
  if (setupClass === "A" || liveGrade === "A" || grade === "A") return "A";
  if (setupClass === "B" || liveGrade === "B" || grade === "B") return "B";

  return grade || setupClass || liveGrade || "";
}

function getWebhookGrade(t) {
  const setupClass = String(t?.setupClass || "").toUpperCase();
  const liveGrade = String(t?.liveGrade || "").toUpperCase();
  const grade = String(t?.grade || "").toUpperCase();

  if (setupClass === "GOD" || liveGrade === "GOD" || grade === "GOD") return "GOD";

  if (
    setupClass === "A" ||
    setupClass === "A_SHORT_EXCEPTION" ||
    liveGrade === "A" ||
    grade === "A" ||
    grade === "A_SHORT_EXCEPTION"
  ) {
    return "A";
  }

  if (
    setupClass === "B" ||
    setupClass === "B_TREND_PROBE" ||
    setupClass === "BULLISH_MID_TREND_PROBE" ||
    liveGrade === "B" ||
    grade === "B" ||
    grade === "B_TREND_PROBE"
  ) {
    return "B";
  }

  return getStrictTradeGrade(t) || "C";
}

function getDisplayGrade(t) {
  return String(t?.setupClass || t?.grade || getWebhookGrade(t) || "?").toUpperCase();
}

function getTradeReason(t) {
  return String(t?.reason || t?.oldReason || t?.entryReason || "").toUpperCase();
}

function getWebhookByGrade(grade) {
  const g = String(grade || "").toUpperCase();

  if (g === "A" || g === "GOD") return WEBHOOK_A;
  if (g === "B") return WEBHOOK_B;

  return WEBHOOK_A;
}

function getMainBotSignalUrl() {
  const url = String(MAIN_BOT_WEBHOOK_URL || "").trim();

  if (!url) return "";
  if (url.endsWith("/api/signal")) return url;

  return `${url.replace(/\/+$/, "")}/api/signal`;
}

function buildMainSignalId(t, symbol, side, grade) {
  const existingId = sanitizeSignalId(t.signalId || t.id);
  if (existingId) return existingId;

  return sanitizeSignalId([
    "main",
    symbol,
    side,
    grade || "ENTRY",
    compactNumber(t.entry),
    compactNumber(t.tp ?? t.takeProfit),
    compactNumber(t.sl ?? t.stopLoss),
  ].join("_"));
}

function maskMainPayload(payload) {
  return {
    ...payload,
    secret: "***hidden***",
  };
}

function isExecutableMainSignal(t) {
  const grade = getStrictTradeGrade(t);
  const reason = getTradeReason(t);

  if (!MAIN_BOT_ENABLED) return false;
  if (!MAIN_EXECUTABLE_GRADES.has(grade)) return false;
  if (MAIN_BLOCKED_REASONS.has(reason)) return false;

  const symbol = normalizeBotSymbol(t.symbol || t.coin);
  const side = normalizeBotSide(t.side || t.direction || t.bias);
  const stopLoss = Number(t.stopLoss ?? t.sl);
  const takeProfit = Number(t.takeProfit ?? t.tp);

  if (!symbol) return false;
  if (!side) return false;
  if (!Number.isFinite(stopLoss)) return false;
  if (!Number.isFinite(takeProfit)) return false;

  if (side === "long" && stopLoss >= takeProfit) return false;
  if (side === "short" && stopLoss <= takeProfit) return false;

  return true;
}

// ================= DISCORD =================
async function sendMessage(webhook, message) {
  if (!webhook) {
    return {
      ok: false,
      skipped: true,
      error: "Discord webhook missing",
    };
  }

  if (!fetchFn) {
    return {
      ok: false,
      skipped: true,
      error: "fetch unavailable",
    };
  }

  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });

      lastStatus = res.status;

      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          attempt,
        };
      }

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const wait = Math.ceil(Number(data?.retry_after || 1.5) * 1000);
        await sleep(wait);
        continue;
      }

      lastError = await res.text().catch(() => `discord_http_${res.status}`);
    } catch (error) {
      lastError = error?.message || "discord_fetch_failed";
    }

    await sleep(1000 * attempt);
  }

  console.error("DISCORD_SEND_FAILED", JSON.stringify({
    status: lastStatus,
    error: lastError,
  }));

  return {
    ok: false,
    status: lastStatus,
    error: lastError || "Discord send failed",
  };
}

// ================= MAIN BOT EXECUTION =================
export async function sendMainBotEntry(t, options = {}) {
  const mainBotUrl = getMainBotSignalUrl();

  if (!MAIN_BOT_ENABLED) {
    return {
      ok: false,
      skipped: true,
      error: "MAIN_BOT_ENABLED=false",
    };
  }

  if (!mainBotUrl) {
    return {
      ok: false,
      skipped: true,
      error: "MAIN_BOT_WEBHOOK_URL missing",
    };
  }

  if (!MAIN_BOT_WEBHOOK_SECRET) {
    return {
      ok: false,
      skipped: true,
      error: "MAIN_BOT_WEBHOOK_SECRET missing",
    };
  }

  if (!fetchFn) {
    return {
      ok: false,
      skipped: true,
      error: "fetch unavailable",
    };
  }

  if (!isExecutableMainSignal(t)) {
    return {
      ok: false,
      skipped: true,
      error: "Not executable main signal",
      grade: getStrictTradeGrade(t),
      reason: getTradeReason(t),
      setupClass: t?.setupClass,
      symbol: t?.symbol,
      side: t?.side,
    };
  }

  const symbol = normalizeBotSymbol(t.symbol || t.coin);
  const side = normalizeBotSide(t.side || t.direction || t.bias);
  const grade = getStrictTradeGrade(t);

  const payload = {
    secret: MAIN_BOT_WEBHOOK_SECRET,
    signalId: buildMainSignalId(t, symbol, side, grade),
    bot: "main",
    symbol,
    side,
    leverage: parseNumber(t.leverage, MAIN_BOT_DEFAULT_LEVERAGE),
    riskPct: parseNumber(t.riskPct, MAIN_BOT_DEFAULT_RISK_PCT),
    stopLoss: Number(t.stopLoss ?? t.sl),
    takeProfit: Number(t.takeProfit ?? t.tp),

    // Productie via Vercel env:
    // MAIN_BOT_DRY_RUN=false => live.
    dryRun: options.forceDryRun === true ? true : MAIN_BOT_DRY_RUN,
  };

  console.log("MAIN_BOT_CALL_START", JSON.stringify({
    url: mainBotUrl,
    grade,
    setupClass: t?.setupClass,
    reason: getTradeReason(t),
    payload: maskMainPayload(payload),
  }));

  try {
    const res = await fetchFn(mainBotUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-secret": MAIN_BOT_WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });

    const result = await res.json().catch(() => null);

    const output = {
      ok: res.ok && result?.ok !== false,
      status: res.status,
      payload: maskMainPayload(payload),
      result,
    };

    console.log("MAIN_BOT_CALL_RESULT", JSON.stringify(output));

    return output;
  } catch (error) {
    const output = {
      ok: false,
      error: error?.message || "main_bot_fetch_failed",
      payload: maskMainPayload(payload),
    };

    console.error("MAIN_BOT_CALL_ERROR", JSON.stringify(output));

    return output;
  }
}

// ================= MESSAGE FORMATTERS =================
function formatEntryMessage(t) {
  const side = String(t?.side || "").toLowerCase();
  const isBull = ["bull", "long", "buy", "bullish"].includes(side);
  const direction = isBull ? "📈 LONG" : "📉 SHORT";
  const grade = getDisplayGrade(t);

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
📊 RR: ${rr} | Sniper: ${toText(t.sniperScore)} | Conf: ${toText(t.confluence)}
`;
}

function formatExitMessage(t) {
  const isWin = String(t.reason || "").toUpperCase() === "TP";
  const tp = compactNumber(t.tp);
  const sl = compactNumber(t.sl);
  const rr = compactNumber(t.rr);

  if (isWin) {
    return `
✅ **TP geraakt op ${toText(t.symbol)}**

🎯 TP: \`${tp}\`
💰 RR: ${rr}
`;
  }

  return `
❌ **SL geraakt op ${toText(t.symbol)}**

🛑 SL: \`${sl}\`
RR: ${rr}
`;
}

// ================= EXPORTS =================
export async function sendEntry(t) {
  const symbol = String(t?.symbol || "UNKNOWN").toUpperCase();
  const webhookGrade = getWebhookGrade(t);
  const strictGrade = getStrictTradeGrade(t);
  const webhook = getWebhookByGrade(webhookGrade);

  const now = Date.now();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
  const cooldownKey = symbol;
  const lastSent = recentSignals.get(cooldownKey);

  if (lastSent && now - lastSent < cooldownMs) {
    const skipped = {
      ok: false,
      skipped: true,
      discordSent: false,
      error: "Discord cooldown active",
      symbol,
      webhookGrade,
      strictGrade,
      cooldownMinutes: COOLDOWN_MINUTES,
    };

    console.log("DISCORD_ENTRY_SKIPPED", JSON.stringify(skipped));
    return skipped;
  }

  console.log("SEND_ENTRY_CALLED", JSON.stringify({
    symbol,
    side: t?.side,
    webhookGrade,
    strictGrade,
    setupClass: t?.setupClass,
    reason: getTradeReason(t),
    entry: t?.entry,
    sl: t?.sl ?? t?.stopLoss,
    tp: t?.tp ?? t?.takeProfit,
    rr: t?.rr,
    hasWebhook: Boolean(webhook),
    MAIN_BOT_ENABLED,
    mainBotUrl: getMainBotSignalUrl(),
    hasMainBotSecret: Boolean(MAIN_BOT_WEBHOOK_SECRET),
    mainBotDryRun: MAIN_BOT_DRY_RUN,
  }));

  const embed = buildEmbed({
    title: `${symbol} Signal`,
    color: webhookGrade === "A" || webhookGrade === "GOD" ? 0x00ff99 : 0xf1c40f,
    description: formatEntryMessage(t),
  });

  const discordResult = await sendMessage(webhook, { embeds: [embed] });

  if (discordResult.ok) {
    recentSignals.set(cooldownKey, now);
  }

  let mainBotResult = null;

  if (isExecutableMainSignal(t)) {
    mainBotResult = await sendMainBotEntry(t);
  } else {
    mainBotResult = {
      ok: false,
      skipped: true,
      error: "Not sent to main bot",
      grade: strictGrade,
      reason: getTradeReason(t),
      setupClass: t?.setupClass,
    };

    console.log("MAIN_BOT_NOT_EXECUTED", JSON.stringify({
      symbol,
      strictGrade,
      webhookGrade,
      setupClass: t?.setupClass,
      reason: getTradeReason(t),
    }));
  }

  return {
    ok: Boolean(discordResult.ok),
    discordSent: Boolean(discordResult.ok),
    discordResult,
    mainBotResult,
    symbol,
    webhookGrade,
    strictGrade,
  };
}

export async function sendExit(t) {
  const symbol = String(t?.symbol || "UNKNOWN").toUpperCase();
  const webhookGrade = getWebhookGrade(t);
  const webhook = getWebhookByGrade(webhookGrade);

  const embed = buildEmbed({
    title: `${symbol} Exit`,
    color: String(t.reason || "").toUpperCase() === "TP" ? 0x2ecc71 : 0xe74c3c,
    description: formatExitMessage(t),
  });

  const discordResult = await sendMessage(webhook, { embeds: [embed] });

  return {
    ok: Boolean(discordResult.ok),
    discordSent: Boolean(discordResult.ok),
    discordResult,
    symbol,
    webhookGrade,
  };
}