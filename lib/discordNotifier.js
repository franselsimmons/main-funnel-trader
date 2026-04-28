const WEBHOOK_A = String(process.env.DISCORD_WEBHOOK_A || "").trim();
const WEBHOOK_B = String(process.env.DISCORD_WEBHOOK_B || "").trim();
const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System v2 🤖";
const MAX_RETRIES = 3;

// ================= HELPERS =================
function hasWebhook(grade) {
  if (grade === "A") return WEBHOOK_A.length > 0;
  if (grade === "B") return WEBHOOK_B.length > 0;
  return false;
}

function getWebhook(grade) {
  if (grade === "A") return WEBHOOK_A;
  if (grade === "B") return WEBHOOK_B;
  return "";
}

function toText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function toUpper(value, fallback = "N/A") {
  return toText(value, fallback).toUpperCase();
}

function compactNumber(value, fallback = "N/A") {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function limit(text, max) {
  const s = toText(text, "");
  if (s.length <= max) return s || "N/A";
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function buildEmbed({ title, color, description }) {
  const embed = {
    title: limit(title, 256),
    color,
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
  if (description) embed.description = limit(description, 4096);
  return embed;
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

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
      const body = await res.text().catch(() => "");
      lastError = `Discord webhook failed (${res.status}): ${body || res.statusText}`;
    } catch (e) {
      lastError = e?.message || "unknown_discord_error";
    }
    if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
  }
  if (lastError) console.error("Discord error:", lastError);
}

function formatEntryMessage(t) {
  const isBull = toUpper(t?.side) === "BULL";
  const directionText = isBull ? "📈 We gaan LONG" : "📉 We gaan SHORT";
  const grade = t.grade || "?";
  const gradeEmoji = grade === "A" ? "🟢" : "🟡";
  return (
    `${gradeEmoji} **${grade}-grade** ${directionText} op ${toText(t?.symbol, "UNKNOWN")}!\n\n` +
    `🚀 **Entry:** ${compactNumber(t?.entry)}\n` +
    `🛡️ **SL:** ${compactNumber(t?.sl)}\n` +
    `🎯 **TP:** ${compactNumber(t?.tp)}\n` +
    `📊 **RR:** ${toText(t?.rr)}\n` +
    `🧠 **Sniper:** ${toText(t?.sniperScore)} | **Confluence:** ${toText(t?.confluence)}`
  );
}

// ================= EXPORT =================
export async function sendEntry(t) {
  const grade = t.grade || "C";
  const webhook = getWebhook(grade);
  if (!webhook) return;

  const description = formatEntryMessage(t);
  const color = grade === "A" ? 0x00ff99 : (grade === "B" ? 0xf1c40f : 0x95a5a6);

  await sendMessage(webhook, {
    embeds: [buildEmbed({
      title: `🚀 ENTRY - ${toText(t?.symbol, "UNKNOWN")} (${grade})`,
      color,
      description
    })]
  });
}

export async function sendHold(t) {
  const webhook = WEBHOOK_A;
  if (!webhook) return;
  const description = `Geen paniek, we zitten nog steeds in de trade voor **${toText(t?.symbol, "UNKNOWN")}**. 🧘‍♂️\n\nDe trend is momenteel **${toText(t?.flow)}**. We houden deze positie vast en wachten rustig af.`;
  await sendMessage(webhook, {
    embeds: [buildEmbed({
      title: `📈 HOLD - ${toText(t?.symbol, "UNKNOWN")}`,
      color: 0x3498db,
      description
    })]
  });
}

export async function sendPartial(t) {
  const webhook = WEBHOOK_A;
  if (!webhook) return;
  const description = `We hebben een eerste mijlpaal bereikt op de prijs **${compactNumber(t?.price)}**! 🎉\n\nWat er gebeurde: de helft van de positie is met winst verkocht (partial TP). SL is verplaatst naar **${compactNumber(t?.sl)}** (instapprijs).\n\nKortom: winst veilig, geen risico meer op restant.`;
  await sendMessage(webhook, {
    embeds: [buildEmbed({
      title: `💰 PARTIAL TP - ${toText(t?.symbol, "UNKNOWN")}`,
      color: 0xf1c40f,
      description
    })]
  });
}

export async function sendExit(t) {
  const webhook = WEBHOOK_A;
  if (!webhook) return;
  const isWin = t?.reason === "TP";
  const color = isWin ? 0x2ecc71 : 0xe74c3c;
  const description = isWin
    ? `**BAM! TP geraakt!** 🎯\n\nTrade op **${toText(t?.symbol, "UNKNOWN")}** is perfect uitgespeeld. RR = ${toText(t?.rr)}.`
    : `De markt keerde helaas om → SL gehaald. 🛡️\n\nTrade op **${toText(t?.symbol, "UNKNOWN")}** is gesloten. Risico beperkt gebleven.`;
  await sendMessage(webhook, {
    embeds: [buildEmbed({
      title: `❌ EXIT - ${toText(t?.symbol, "UNKNOWN")}`,
      color,
      description
    })]
  });
}