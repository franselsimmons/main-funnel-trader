// ================= CONFIG =================
const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_B || "").trim();

const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System v2 🤖";
const MAX_RETRIES = 3;

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
  return n.toFixed(6); // 🔥 mooie getallen
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

  return `
🟢 **${toText(t.symbol)} ${direction} (${grade})**

📥 **ENTRY**
\`\`\`
${compactNumber(t.entry)}
\`\`\`

🎯 **TAKE PROFIT**
\`\`\`
${compactNumber(t.tp)}
\`\`\`

🛑 **STOP LOSS**
\`\`\`
${compactNumber(t.sl)}
\`\`\`

📊 RR: ${toText(t.rr)} | Sniper: ${toText(t.sniperScore)} | Conf: ${toText(t.confluence)}
`;
}

// ================= EXIT MESSAGE =================
function formatExitMessage(t) {
  const isWin = t.reason === "TP";

  if (isWin) {
    return `
✅ **TP geraakt op ${toText(t.symbol)}!**

🎯 TP: ${compactNumber(t.tp)}
💰 RR: ${toText(t.rr)}

Lekker bezig 🔥
`;
  }

  return `
❌ **SL geraakt op ${toText(t.symbol)}**

🛑 SL: ${compactNumber(t.sl)}

Risk netjes beperkt 👍
`;
}

// ================= EXPORTS =================
export async function sendEntry(t) {
  const webhook = getWebhook(t.grade || "C");
  if (!webhook) return;

  const embed = buildEmbed({
    title: `${t.symbol} Signal`,
    color: t.grade === "A" ? 0x00ff99 : 0xf1c40f,
    description: formatEntryMessage(t)
  });

  await sendMessage(webhook, { embeds: [embed] });
}

export async function sendExit(t) {
  const webhook = getWebhook(t.grade || "C");
  if (!webhook) return;

  const embed = buildEmbed({
    title: `${t.symbol} Exit`,
    color: t.reason === "TP" ? 0x2ecc71 : 0xe74c3c,
    description: formatExitMessage(t)
  });

  await sendMessage(webhook, { embeds: [embed] });
}