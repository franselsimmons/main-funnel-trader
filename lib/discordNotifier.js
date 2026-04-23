const WEBHOOK = String(process.env.DISCORD_WEBHOOK_URL |

| "").trim();
const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Trade System v2 🤖";
const MAX_RETRIES = 3;

// ================= HELPERS =================
function hasWebhook(){
  return WEBHOOK.length > 0;
}

function toText(value, fallback = "N/A"){
  if(value === undefined |

| value === null |
| value === "") return fallback;
  return String(value);
}

function toUpper(value, fallback = "N/A"){
  return toText(value, fallback).toUpperCase();
}

function compactNumber(value, fallback = "N/A"){
  const n = Number(value);
  if(!Number.isFinite(n)) return fallback;
  if(Math.abs(n) >= 1000) return n.toFixed(2);
  if(Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function limit(text, max){
  const s = toText(text, "");
  return s.length <= max? (s |

| "N/A") : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function buildEmbed({ title, color, description }){
  const embed = {
    title: limit(title, 256),
    color,
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
  
  if(description) {
    embed.description = limit(description, 4096);
  }
  
  return embed;
}

async function send(message){
  if(!hasWebhook()) return;
  if(!fetchFn){
    console.error("Discord error: fetch is not available in this Node runtime");
    return;
  }

  let lastError = null;

  for(let attempt = 1; attempt <= MAX_RETRIES; attempt++){
    try{
      const res = await fetchFn(WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
      });

      if(res.ok) return;

      if(res.status === 429){
        let waitMs = 1500;
        try{
          const data = await res.json();
          if(Number.isFinite(Number(data?.retry_after))){
            waitMs = Math.ceil(Number(data.retry_after) * 1000);
          }
        }catch{
          // ignore json parse error
        }
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      const body = await res.text().catch(() => "");
      lastError = `Discord webhook failed (${res.status}): ${body |

| res.statusText}`;
    }catch(e){
      lastError = e?.message |

| "unknown_discord_error";
    }

    if(attempt < MAX_RETRIES){
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  if(lastError){
    console.error("Discord error:", lastError);
  }
}

// ================= ENTRY =================
export async function sendEntry(t){
  const isBull = toUpper(t.side) === "BULL";
  const directionText = isBull? "📈 We gaan LONG" : "📉 We gaan SHORT";
  const color = t.grade === "A"? 0x00ff99 : 0xf1c40f;

  const description = 
    `**${directionText} op ${toText(t.symbol, "UNKNOWN")}!**\n\n` +
    `De scanner heeft een sterke Grade ${toText(t.grade)} setup gevonden. De bot stapt nu in.\n\n` +
    `📍 **Entry:** ${compactNumber(t.entry)}\n` +
    `🛡️ **SL:** ${compactNumber(t.sl)}\n` +
    `🎯 **TP:** ${compactNumber(t.tp)}\n\n` +
    `*Als we onze TP halen, is de RR ${toText(t.rr)}.* 🤑`;

  await send({
    embeds:
  });
}

// ================= HOLD =================
export async function sendHold(t){
  const description = 
    `Geen paniek, we zitten nog steeds in de trade voor **${toText(t.symbol, "UNKNOWN")}**. 🧘‍♂️\n\n` +
    `De trend is momenteel **${toText(t.flow)}**. We houden deze positie vast en wachten rustig af.`;

  await send({
    embeds:
  });
}

// ================= PARTIAL =================
export async function sendPartial(t){
  const description = 
    `We hebben een eerste mijlpaal bereikt op de prijs **${compactNumber(t.price)}**! 🎉\n\n` +
    `**Wat is er zojuist gebeurd?**\n` +
    `De bot heeft nu de helft van de positie met winst verkocht om dat geld alvast veilig in je zak te steken. Dit heet een 'Partial TP'.\n\n` +
    `Daarnaast is de **SL** nu verplaatst naar **${compactNumber(t.sl)}** (je instapprijs).\n\n` +
    `**Kortom:** Je hebt nu al winst gepakt, én je kunt op de rest van deze trade geen geld meer verliezen! We laten de rest lekker meeliften. 🏄‍♂️`;

  await send({
    embeds:
  });
}

// ================= EXIT =================
export async function sendExit(t){
  const isWin = t.reason === "TP";
  const color = isWin? 0x2ecc71 : 0xe74c3c;
  
  let description = "";
  
  if (isWin) {
    description = `**BAM! TP geraakt!** 🎯\n\nDe trade op **${toText(t.symbol, "UNKNOWN")}** is perfect uitgespeeld en we hebben ons doel gehaald. We hebben een RR van ${toText(t.rr)} verdiend! 💸`;
  } else {
    description = `De markt keerde helaas om, dus onze **SL** heeft ons uit **${toText(t.symbol, "UNKNOWN")}** gehaald. 🛡️\n\nGelukkig is het risico netjes beperkt gebleven. Op naar de volgende setup! 💪`;
  }

  await send({
    embeds:
  });
}
