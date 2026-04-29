// ================= CONFIG =================
const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_B || "").trim();

const fetchFn = globalThis.fetch;
const MAX_RETRIES = 3;

// ================= HELPERS =================
function getWebhook(grade) {
  if (grade === "A") return WEBHOOK_A;
  if (grade === "B") return WEBHOOK_B;
  return "";
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function sendMessage(webhook, message) {
  if (!webhook || !fetchFn) return;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
      });

      if (res.ok) return;

      // rate limit fix
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const wait = Math.ceil((data?.retry_after || 1) * 1000);
        await sleep(wait);
        continue;
      }

    } catch {}

    await sleep(1000 * attempt);
  }
}

// ================= ENTRY MESSAGE =================
// ⚠️ BELANGRIJK: GEEN EMBEDS → ANDERS GEEN COPY BUTTON
function formatEntryMessage(t) {
  const isBull = String(t?.side).toUpperCase() === "BULL";
  const grade = t?.grade || "C";
  const emoji = grade === "A" ? "🟢" : "🟡";

  return (
`${emoji} ${t.symbol} ${isBull ? "LONG 📈" : "SHORT 📉"} (${grade})

📥 ENTRY
\`\`\`
${t.entry}
\`\`\`

🎯 TAKE PROFIT
\`\`\`
${t.tp}
\`\`\`

🛑 STOP LOSS
\`\`\`
${t.sl}
\`\`\`

RR: ${t.rr} | Sniper: ${t.sniperScore} | Conf: ${t.confluence}`
  );
}

// ================= EXIT MESSAGE =================
function formatExitMessage(t) {
  const win = t?.reason === "TP";

  if (win) {
    return `✅ ${t.symbol} TP HIT 💸
RR: ${t.rr}`;
  }

  return `❌ ${t.symbol} SL HIT 🛡️`;
}

// ================= EXPORT =================
export async function sendEntry(t) {
  const webhook = getWebhook(t?.grade);
  if (!webhook) return;

  await sendMessage(webhook, {
    content: formatEntryMessage(t)
  });
}

export async function sendExit(t) {
  const webhook = getWebhook(t?.grade);
  if (!webhook) return;

  await sendMessage(webhook, {
    content: formatExitMessage(t)
  });
}