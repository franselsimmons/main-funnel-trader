import { kv } from "@vercel/kv"

export default async function handler(req, res) {

  const qualified = await kv.get("bull:qualified") || []

  if (!qualified.length) {
    return res.json({ ok: true, transferred: 0 })
  }

  const trades = qualified.map(c => ({
    symbol: c.symbol,
    direction: "LONG",
    entry: c.price,
    stopLoss: c.price * 0.97,
    takeProfit: c.price * 1.06,
    status: "ACTIVE",
    created: Date.now()
  }))

  await kv.set("trade:active", trades)

  // scanner verliest controle
  await kv.del("bull:qualified")

  res.json({
    ok: true,
    transferred: trades.length
  })
}