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
  return "";
}

function toText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function compactNumber(value, fallback = "N/A") {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function buildEmbed({ title, color, description }) {
  return {
    title,
    color,
    description,
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ================= DISCORD SENDER =================
async function sendMessage(webhook, message) {
  if (!webhook || !fetchFn) return;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
      });

      if (res.ok) return;

      // Rate limit
      if (res.status === 429) {
        let waitMs = 1500;
        try {
          const data = await res.json();
          if (Number.isFinite(Number(data?.retry_after))) {
            waitMs = Math.ceil(Number(data.retry_after) * 1000);
          }
        } catch {}

        await sleep(waitMs);
        continue;
      }

      const text = await res.text().catch(() => "");
      lastError = `Discord error (${res.status}): ${text || res.statusText}`;
    } catch (e) {
      lastError = e?.message || "unknown_error";
    }

    if (attempt < MAX_RETRIES) {
      await sleep(1000 * attempt);
    }
  }

  if (lastError) {
    console.error("❌ Discord send failed:", lastError);
  }
}

// ================= ENTRY MESSAGE =================
function formatEntryMessage(t) {
  const isBull = String(t?.side).toUpperCase() === "BULL";
  const grade = t?.grade || "C";
  const emoji = grade === "A" ? "🟢" : "🟡";

  return (
`${emoji} **${toText(t.symbol, "UNKNOWN")} ${isBull ? "LONG 📈" : "SHORT 📉"} (${grade})**\n\n` +

`📥 ENTRY\n` +
"```" +
`\n${compactNumber(t.entry)}\n` +
"```\n" +

`🎯 TAKE PROFIT\n` +
"```" +
`\n${compactNumber(t.tp)}\n` +
"```\n" +

`🛑 STOP LOSS\n` +
"```" +
`\n${compactNumber(t.sl)}\n` +
"```\n\n" +

`RR: ${toText(t.rr)} | Sniper: ${toText(t.sniperScore)} | Conf: ${toText(t.confluence)}`
  );
}

// ================= EXIT MESSAGE =================
function formatExitMessage(t) {
  const isWin = t?.reason === "TP";

  if (isWin) {
    return (
`✅ **${toText(t.symbol)} TP HIT**\n\n` +
`Profit gepakt 💸\n` +
`RR: ${toText(t.rr)}`
    );
  }

  return (
`❌ **${toText(t.symbol)} SL HIT**\n\n` +
`Risk managed 🛡️`
  );
}

// ================= EXPORT =================
export async function sendEntry(t) {
  const grade = t?.grade || "C";
  const webhook = getWebhook(grade);
  if (!webhook) return;

  const description = formatEntryMessage(t);
  const color =
    grade === "A" ? 0x00ff99 :
    grade === "B" ? 0xf1c40f :
    0x95a5a6;

  await sendMessage(webhook, {
    embeds: [
      buildEmbed({
        title: `${toText(t.symbol)} Signal`,
        color,
        description
      })
    ]
  });
}

export async function sendExit(t) {
  const grade = t?.grade || "C";
  const webhook = getWebhook(grade);
  if (!webhook) return;

  const description = formatExitMessage(t);
  const color = t?.reason === "TP" ? 0x2ecc71 : 0xe74c3c;

  await sendMessage(webhook, {
    embeds: [
      buildEmbed({
        title: `${toText(t.symbol)} Closed`,
        color,
        description
      })
    ]
  });
}