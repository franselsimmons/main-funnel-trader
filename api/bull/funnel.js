import { kv } from "@vercel/kv"

async function sendDiscord(signal) {

  if (!process.env.DISCORD_WEBHOOK_URL) return

  await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: `🚀 BULL SIGNAL: ${signal.symbol}`,
        color: 5763719,
        fields: [
          { name: "Direction", value: signal.direction, inline: true },
          { name: "Entry", value: `$${signal.entry}`, inline: true },
          { name: "Stop Loss", value: `$${signal.stopLoss}`, inline: true },
          { name: "Take Profit", value: `$${signal.takeProfit}`, inline: true },
          { name: "RR", value: signal.rr, inline: true }
        ]
      }]
    })
  })
}

export default async function handler(req, res) {

  const signals = await kv.get("bull:engine:signals") || []

  const approved = signals.slice(0, 3)

  for (const signal of approved) {
    await sendDiscord(signal)
  }

  await kv.set("bull:approved", approved)

  res.json({ ok: true })
}