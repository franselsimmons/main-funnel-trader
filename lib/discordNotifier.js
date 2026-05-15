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
function isBlank(value) {
  return value === undefined || value === null || value === "";
}

function toText(value, fallback = "N/A") {
  if (isBlank(value)) return fallback;
  return String(value);
}

function toUpperText(value, fallback = "N/A") {
  if (isBlank(value)) return fallback;
  return String(value).toUpperCase();
}

function compactNumber(value, decimals = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";

  return n
    .toFixed(decimals)
    .replace(/\.?0+$/, "");
}

function compactPrice(value) {
  const text = compactNumber(value, 10);
  return text === "N/A" ? "N/A" : `\`${text}\``;
}

function compactScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(1).replace(/\.0$/, "");
}

function compactDepthUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "N/A";

  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;

  return `$${n.toFixed(0)}`;
}

function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);

  if (!Number.isFinite(s) || s < 0) return 0;
  if (s > 0.05) s = s / 100;

  return s;
}

function formatBps(value) {
  const n = normalizeSpread(value);
  if (!Number.isFinite(n) || n <= 0) return "N/A";

  return `${(n * 10000).toFixed(2)} bps`;
}

function formatFractionPct(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";

  return `${(n * 100).toFixed(decimals)}%`;
}

function formatMovePct(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";

  return `${n.toFixed(decimals)}%`;
}

function formatBool(value) {
  if (value === true || String(value).toLowerCase() === "true") return "yes";
  if (value === false || String(value).toLowerCase() === "false") return "no";
  return "N/A";
}

function limit(text, max) {
  const s = toText(text, "");
  if (s.length <= max) return s || "N/A";
  return `${s.slice(0, max - 1)}…`;
}

function normalizeGrade(value) {
  const g = String(value || "").toUpperCase();

  if (g === "GOD") return "GOD";
  if (g === "A" || g === "A_SHORT_EXCEPTION" || g === "BTC_BULLISH_BEAR_EXCEPTION") return "A";
  if (g === "B" || g === "B_TREND_PROBE" || g === "BULLISH_MID_TREND_PROBE") return "B";
  if (g === "C") return "C";

  return "";
}

function getTradeGrade(t) {
  const candidates = [
    t?.liveGrade,
    t?.setupClass,
    t?.grade
  ];

  for (const value of candidates) {
    const grade = normalizeGrade(value);
    if (grade) return grade;
  }

  return "C";
}

function normalizeSide(side) {
  const s = String(side || "").trim().toLowerCase();

  if (["bear", "short", "sell", "bearish"].includes(s)) return "bear";
  if (["bull", "long", "buy", "bullish"].includes(s)) return "bull";

  return "bull";
}

function getWebhook(grade) {
  const g = normalizeGrade(grade);

  if (g === "A" || g === "GOD") return WEBHOOK_A;
  if (g === "B") return WEBHOOK_B;

  return WEBHOOK_C;
}

function getLiveMetrics(t) {
  return {
    ...(t?.filterDiagnostics?.liveMetrics || {}),
    ...(t?.liveFilterMetrics || {})
  };
}

function getSpecialChecks(t) {
  return {
    ...(t?.filterDiagnostics?.specialChecks || {}),
    ...(t?.specialFilterChecks || {})
  };
}

function pickMetric(t, keys, fallback = "N/A") {
  const live = getLiveMetrics(t);

  for (const key of keys) {
    if (!isBlank(t?.[key])) return t[key];
    if (!isBlank(live?.[key])) return live[key];
  }

  return fallback;
}

function kv(label, value, formatter = toText) {
  return `**${label}:** ${formatter(value)}`;
}

function makeField(name, lines, inline = false) {
  const value = lines
    .filter(Boolean)
    .join("\n");

  return {
    name: limit(name, 256),
    value: limit(value || "N/A", 1024),
    inline
  };
}

function buildSignalKey(t) {
  const symbol = String(t?.symbol || "UNKNOWN").toUpperCase();
  const side = normalizeSide(t?.side);
  const setupClass = String(t?.setupClass || getTradeGrade(t) || "ENTRY").toUpperCase();
  const reason = String(t?.entryReason || t?.entryType || t?.reason || "SIGNAL").toUpperCase();

  return `${symbol}_${side}_${setupClass}_${reason}`;
}

function buildEmbed({ title, color, description, fields = [] }) {
  return {
    title: limit(title, 256),
    description: limit(description, 4096),
    color,
    fields: fields
      .filter(Boolean)
      .slice(0, 25)
      .map(field => ({
        name: limit(field.name, 256),
        value: limit(field.value, 1024),
        inline: Boolean(field.inline)
      })),
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
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

function getEntryColor(t) {
  const grade = getTradeGrade(t);

  if (grade === "GOD") return 0x9b59b6;
  if (grade === "A") return 0x00ff99;
  if (grade === "B") return 0xf1c40f;

  return 0x3498db;
}

function getExitColor(t) {
  const reason = String(t?.reason || "").toUpperCase();

  if (reason === "TP" || reason === "TAKE_PROFIT") return 0x2ecc71;
  if (reason === "BE_SL" || reason === "BREAK_EVEN") return 0xf1c40f;
  if (reason.startsWith("EARLY_")) return 0xe67e22;

  return 0xe74c3c;
}

// ================= ENTRY MESSAGE =================
function buildEntryDescription(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  const direction = side === "bull" ? "📈 LONG" : "📉 SHORT";

  const setupClass = toUpperText(t?.setupClass || getTradeGrade(t), "N/A");
  const reason = toUpperText(t?.entryReason || t?.entryType || t?.reason, "N/A");
  const grade = getTradeGrade(t);

  return [
    `🟢 **${symbol} ${direction}**`,
    `Setup: **${setupClass}** | Grade: **${grade}** | Reason: **${reason}**`
  ].join("\n");
}

function buildEntryFields(t) {
  const special = getSpecialChecks(t);

  const score = pickMetric(t, ["score", "moveScore"]);
  const confluence = pickMetric(t, ["confluence", "effectiveConfluence"]);
  const rawConfluence = pickMetric(t, ["rawConfluence"]);
  const sniperScore = pickMetric(t, ["sniperScore"]);

  const entry = pickMetric(t, ["entry"]);
  const sl = pickMetric(t, ["sl", "stopLoss"]);
  const tp = pickMetric(t, ["tp", "takeProfit"]);

  const rr = pickMetric(t, ["finalRr", "plannedRR", "rr"]);
  const baseRR = pickMetric(t, ["baseRR"]);
  const tpRewardMultiplier = pickMetric(t, ["tpRewardMultiplier"]);

  const rsi = pickMetric(t, ["rsi"]);
  const rsiHTF = pickMetric(t, ["rsiHTF"]);
  const rsiZone = pickMetric(t, ["rsiZone"]);
  const rsiEdge = pickMetric(t, ["rsiEdge", "rsiEntryEdge"]);
  const rsiEdgeRank = pickMetric(t, ["rsiEdgeRank"]);
  const rsiContinuationOk = pickMetric(t, ["rsiContinuationOk"]);

  const obBias = pickMetric(t, ["obBias"]);
  const spreadPct = pickMetric(t, ["spreadPct"]);
  const depthMinUsd1p = pickMetric(t, ["depthMinUsd1p"]);
  const spoof = pickMetric(t, ["spoof"]);

  const flow = pickMetric(t, ["flow"]);
  const btcState = pickMetric(t, ["btcState"]);
  const regime = pickMetric(t, ["regime"]);
  const funding = pickMetric(t, ["funding"]);

  const change1h = pickMetric(t, ["change1h"]);
  const change24 = pickMetric(t, ["change24"]);

  const pullbackConfirmed = pickMetric(t, ["pullbackConfirmed"]);
  const sweepConfirmed = pickMetric(t, ["sweepConfirmed"]);
  const retestConfirmed = pickMetric(t, ["retestConfirmed"]);
  const distanceFromLocalHighPct = pickMetric(t, ["distanceFromLocalHighPct"]);

  const hasLiquidationData = pickMetric(t, ["hasLiquidationData"]);

  const btcBullishBearException = Boolean(t?.btcBullishBearException);
  const bullishMidTrendProbe = Boolean(t?.bullishMidTrendProbe);

  return [
    makeField("Trade plan", [ kv("Entry", entry, compactPrice),kv("SL", sl, compactPrice),kv("TP", tp, compactPrice),kv("RR", rr, value => compactNumber(value, 3)),kv("Base RR", baseRR, value => compactNumber(value, 3)),kv("TP multiplier", tpRewardMultiplier, value => compactNumber(value, 3))
    ], true),

    makeField("Signal quality", [ kv("Score", score, compactScore),kv("Confluence", confluence, compactScore),kv("Raw confluence", rawConfluence, compactScore),kv("Sniper", sniperScore, compactScore),kv("Flow", flow, toUpperText),kv("BTC", btcState, toUpperText),kv("Regime", regime, toUpperText)
    ], true),

    makeField("RSI context", [ kv("RSI", rsi, value => compactNumber(value, 2)),kv("RSI HTF", rsiHTF, value => compactNumber(value, 2)),kv("Zone", rsiZone, toUpperText),kv("Edge", rsiEdge, toUpperText),kv("Edge rank", rsiEdgeRank, value => compactNumber(value, 0)),kv("Continuation", rsiContinuationOk, formatBool)
    ], true),

    makeField("Orderbook", [ kv("OB bias", obBias, toUpperText),kv("Spread", spreadPct, formatBps),kv("Depth 1%", depthMinUsd1p, compactDepthUsd),kv("Spoof", spoof, formatBool)
    ], true),

    makeField("Market context", [kv("Funding", funding, value => formatFractionPct(value, 4)),kv("1h move", change1h, formatMovePct),kv("24h move", change24, formatMovePct),kv("Liquidation data", hasLiquidationData, formatBool)
    ], true),

    makeField("Structure", [ kv("Pullback", pullbackConfirmed, formatBool),kv("Sweep", sweepConfirmed, formatBool),kv("Retest", retestConfirmed, formatBool),kv("Distance from high", distanceFromLocalHighPct, value => formatFractionPct(value, 3))
    ], true),

    makeField("Special flags", [ kv("BTC bullish short exception", btcBullishBearException),kv("Exception reason", special?.btcBullishBearException?.reason || t?.btcBullishBearExceptionReason),kv("Bullish mid trend probe", bullishMidTrendProbe),kv("Probe reason", special?.bullishMidTrendProbe?.reason || t?.bullishMidTrendProbeReason)
    ], false)
  ];
}

// ================= EXIT MESSAGE =================
function buildExitDescription(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  const direction = side === "bull" ? "LONG" : "SHORT";
  const reason = String(t?.reason || "").toUpperCase();

  if (reason === "TP" || reason === "TAKE_PROFIT") {
    return `✅ **TP geraakt op ${symbol} ${direction}**`;
  }

  if (reason === "BE_SL" || reason === "BREAK_EVEN") {
    return `🟡 **Break-even stop op ${symbol} ${direction}**`;
  }

  if (reason.startsWith("EARLY_")) {
    return `🟠 **Early exit op ${symbol} ${direction}**`;
  }

  return `❌ **Exit op ${symbol} ${direction}**`;
}

function buildExitFields(t) {
  const reason = toUpperText(t?.reason, "N/A");

  return [
    makeField("Result", [ kv("Reason", reason),kv("Exit R", t?.exitR, value => compactNumber(value, 3)),kv("Trigger R", t?.triggerR, value => compactNumber(value, 3)),kv("PnL", t?.pnlPct, value => `${compactNumber(value, 3)}%`),kv("Trigger PnL", t?.triggerPnlPct, value => `${compactNumber(value, 3)}%`),kv("Hold", t?.holdMinutes, value => `${compactNumber(value, 1)} min`)
    ], true),

    makeField("Prices", [ kv("Entry", t?.entry, compactPrice),kv("Exit", t?.exit ?? t?.executionPrice, compactPrice),kv("Trigger", t?.triggerPrice, compactPrice),kv("SL", t?.sl, compactPrice),kv("Initial SL", t?.initialSl, compactPrice),kv("TP", t?.tp, compactPrice)
    ], true),

    makeField("Path metrics", [ kv("MFE R", t?.mfeR, value => compactNumber(value, 3)),kv("MAE R", t?.maeR, value => compactNumber(value, 3)),kv("Current R", t?.currentR, value => compactNumber(value, 3)),kv("Max TP progress", t?.maxTpProgress, value => formatFractionPct(value, 1)),kv("Max SL progress", t?.maxSlProgress, value => formatFractionPct(value, 1)),kv("Direct to SL", t?.directToSL, formatBool)
    ], true),

    makeField("Giveback / BE", [ kv("Reached 0.5R", t?.reachedHalfR, formatBool),kv("Reached 1R", t?.reachedOneR, formatBool),kv("Near TP seen", t?.nearTpSeen, formatBool),kv("SL after 0.5R", t?.slAfterHalfR, formatBool),kv("SL after 1R", t?.slAfterOneR, formatBool),kv("SL after near TP", t?.slAfterNearTp, formatBool),kv("BE active", t?.breakEvenActivated, formatBool),kv("BE stop", t?.breakEvenStop, formatBool)
    ], true),

    makeField("Timing", [ kv("Ticks observed", t?.ticksObserved, value => compactNumber(value, 0)),kv("Favorable ticks", t?.favorableTicks, value => compactNumber(value, 0)),kv("Adverse ticks", t?.adverseTicks, value => compactNumber(value, 0)),kv("Ticks to MFE", t?.ticksToMfe, value => compactNumber(value, 0)),kv("Ticks to MAE", t?.ticksToMae, value => compactNumber(value, 0))
    ], true),

    makeField("Original signal", [ kv("Setup", t?.setupClass, toUpperText),kv("Entry reason", t?.entryReason || t?.entryType, toUpperText),kv("Score", t?.score || t?.moveScore, compactScore),kv("Confluence", t?.confluence, compactScore),kv("Sniper", t?.sniperScore, compactScore),kv("RSI zone", t?.rsiZone, toUpperText),kv("OB bias", t?.obBias, toUpperText),kv("BTC", t?.btcState, toUpperText),kv("Spread", t?.spreadPct, formatBps),kv("Depth 1%", t?.depthMinUsd1p, compactDepthUsd)
    ], false)
  ];
}

// ================= EXPORTS =================
export async function sendEntry(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
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
    title: `${symbol} Entry Signal`,
    color: getEntryColor(t),
    description: buildEntryDescription(t),
    fields: buildEntryFields(t)
  });

  const result = await sendMessage(webhook, {
    embeds: [embed]
  });

  if (result.discordSent) {
    recentSignals.set(key, now);
  }

  console.log("TRADE_DISCORD_ENTRY_RESULT", JSON.stringify({
    symbol,
    grade,
    setupClass: t?.setupClass,
    reason: t?.reason || t?.entryReason || t?.entryType,
    key,
    discordSent: result.discordSent,
    status: result.status,
    error: result.error || null
  }));

  return {
    ...result,
    symbol,
    grade,
    key
  };
}

export async function sendExit(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const grade = getTradeGrade(t);
  const webhook = getWebhook(grade);
  const reason = String(t?.reason || "").toUpperCase();

  const embed = buildEmbed({
    title: `${symbol} Exit`,
    color: getExitColor(t),
    description: buildExitDescription(t),
    fields: buildExitFields(t)
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