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