// ================= TRADE SYSTEM DISCORD NOTIFIER (CLEAN VERSION) =================

const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_TRADE_A || process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_TRADE_B || process.env.DISCORD_WEBHOOK_B || WEBHOOK_A || "").trim();
const WEBHOOK_C = String(process.env.DISCORD_WEBHOOK_TRADE_C || process.env.DISCORD_WEBHOOK_C || WEBHOOK_B || WEBHOOK_A || "").trim();

const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System 🤖 | Happy Trading!";
const MAX_RETRIES = 3;
const COOLDOWN_MINUTES = Number(process.env.TRADE_SIGNAL_COOLDOWN_MINUTES || 25);
const recentSignals = new Map();

// ================= SIMPELE HELPERS =================

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
  if (["bear", "short", "sell", "bearish"].includes(s)) return "short";
  return "long";
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
  return `${symbol}_${side}_${Date.now()}`; // Simpelere unieke key
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
  const isLong = side === "long";
  const emoji = isLong ? "🚀" : "📉";
  const color = isLong ? 0x00ff99 : 0xff4444; // Groen voor long, Rood voor short

  const entryPrice = compactPrice(t?.entry || t?.liveMetrics?.entry);
  const tpPrice = compactPrice(t?.tp || t?.liveMetrics?.tp);
  const slPrice = compactPrice(t?.sl || t?.liveMetrics?.sl);
  const riskReward = compactNumber(t?.finalRr || t?.plannedRR || t?.rr);

  return {
    title: `${emoji} Nieuwe Trade Alert: ${symbol}`,
    description: `Ik heb zojuist een **${side.toUpperCase()}** positie geopend op **${symbol}**.\nLaten we kijken wat de markt doet! 🤞`,
    color: color,
    fields: [
      makeField("🎯 Entry Prijs", entryPrice, true),
      makeField("💰 Take Profit", tpPrice, true),
      makeField("🛑 Stop Loss", slPrice, true),
      makeField("⚖️ Risk/Reward", riskReward !== "N/A" ? `1 : ${riskReward}` : "N/A", false)
    ].filter(Boolean),
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
}

// ================= EXIT BERICHT =================

function buildExitEmbed(t) {
  const symbol = toUpperText(t?.symbol, "UNKNOWN");
  const side = normalizeSide(t?.side);
  const reason = toUpperText(t?.reason, "EXIT");
  
  let title = `🏁 Trade Gesloten: ${symbol}`;
  let description = `De **${side.toUpperCase()}** positie op ${symbol} is zojuist gesloten.`;
  let color = 0x3498db; // Standaard blauw

  // Maak het persoonlijk o.b.v. de reden van exit
  if (reason.includes("TP") || reason.includes("TAKE_PROFIT")) {
    title = `✅ Kassa! Winst op ${symbol}`;
    description = `Lekker bezig! De Take Profit is geraakt voor onze **${side.toUpperCase()}** trade. 🥳`;
    color = 0x2ecc71; // Groen
  } else if (reason.includes("SL") || reason.includes("STOP_LOSS")) {
    title = `❌ Helaas: Stop Loss op ${symbol}`;
    description = `Jammer, de markt zat tegen. De **${side.toUpperCase()}** trade is gestopt. Volgende keer beter! 💪`;
    color = 0xe74c3c; // Rood
  } else if (reason.includes("BE") || reason.includes("BREAK_EVEN")) {
    title = `🛡️ Break-even op ${symbol}`;
    description = `Veiligheid voorop. De trade is op break-even gesloten. Geen winst, geen verlies. 🤝`;
    color = 0xf1c40f; // Geel
  }

  const pnl = compactNumber(t?.pnlPct);
  const pnlText = pnl !== "N/A" ? `${pnl}%` : "N/A";

  return {
    title,
    description,
    color,
    fields: [
      makeField("Resultaat (PnL)", `**${pnlText}**`, true),
      makeField("Reden van Exit", reason, true),
      makeField("Duur van Trade", t?.holdMinutes ? `${compactNumber(t.holdMinutes, 0)} min` : null, false)
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
