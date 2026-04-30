// ================= CONFIG =================
const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_B || "").trim();

const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System v2 🤖";
const MAX_RETRIES = 3;

// 🔥 COOLDOWN (GEFIxt - alleen tijd gebaseerd)
const COOLDOWN_MINUTES = 25; 

// ================= STATE =================
const recentSignals = new Map();

// ================= HELPERS =================
function getWebhook(grade) {
  if (grade === "A") return WEBHOOK_A;
  if (grade === "B") return WEBHOOK_B;
  return WEBHOOK_A;
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
    timestamp: new Date().toISOString()
  };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function sendMessage(webhook, message) {
  if (!webhook || !fetchFn) return;

  let lastError = null;

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
      });

      if (res.ok) return;

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const wait = Math.ceil((data?.retry_after || 1.5) * 1000);
        await sleep(wait);
        continue;
      }

      lastError = await res.text();
    } catch (e) {
      lastError = e.message;
    }

    await sleep(1000 * i);
  }

  if (lastError) console.error("Discord error:", lastError);
}

// ================= ENTRY MESSAGE =================
function formatEntryMessage(t) {
  const isBull = String(t?.side).toUpperCase() === "BULL";
  const direction = isBull ? "📈 LONG" : "📉 SHORT";
  const grade = t.grade || "?";

  const entry = compactNumber(t.entry);
  const tp = compactNumber(t.tp);
  const sl = compactNumber(t.sl);
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

// ================= EXIT MESSAGE =================
function formatExitMessage(t) {
  const isWin = t.reason === "TP";
  const tp = compactNumber(t.tp);
  const sl = compactNumber(t.sl);
  const rr = compactNumber(t.rr);

  if (isWin) {
    return `
✅ **TP geraakt op ${toText(t.symbol)}!**

🎯 TP: \`${tp}\`
💰 RR: ${rr}

Lekker bezig 🔥
`;
  }

  return `
❌ **SL geraakt op ${toText(t.symbol)}**

🛑 SL: \`${sl}\`

Risk netjes beperkt 👍
`;
}

// ================= EXPORTS =================
export async function sendEntry(t) {
  const symbol = t.symbol || "UNKNOWN";

  const now = Date.now();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;

  const lastSent = recentSignals.get(symbol);

  // 🔥 FIX: alleen tijd check (GEEN exit afhankelijkheid meer)
  if (lastSent && (now - lastSent) < cooldownMs) {
    console.log(`⏳ ${symbol} geblokkeerd door cooldown`);
    return;
  }

  // update timestamp
  recentSignals.set(symbol, now);

  const webhook = getWebhook(t.grade || "C");
  if (!webhook) return;

  const embed = buildEmbed({
    title: `${symbol} Signal`,
    color: t.grade === "A" ? 0x00ff99 : 0xf1c40f,
    description: formatEntryMessage(t)
  });

  await sendMessage(webhook, { embeds: [embed] });
}

export async function sendExit(t) {
  const symbol = t.symbol || "UNKNOWN";

  const webhook = getWebhook(t.grade || "C");
  if (!webhook) return;

  const embed = buildEmbed({
    title: `${symbol} Exit`,
    color: t.reason === "TP" ? 0x2ecc71 : 0xe74c3c,
    description: formatExitMessage(t)
  });

  await sendMessage(webhook, { embeds: [embed] });
}