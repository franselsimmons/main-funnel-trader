import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const mode = req.query.mode === "bear" ? "bear" : "bull";

  try {
    const coins = await fetchUniverse();
    const scored = scoreCoins(coins, mode);
    const funnel = buildFunnel(scored);

    await kv.set(`state:${mode}`, {
      funnel,
      lastScan: Date.now()
    });

    res.json({ ok: true, count: scored.length });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

async function fetchUniverse() {
  const r = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1"
  );
  return r.json();
}

function scoreCoins(coins, mode) {
  return coins.map(c => {
    const momentum = c.price_change_percentage_24h || 0;

    const confidence =
      mode === "bull"
        ? Math.max(0, momentum)
        : Math.max(0, -momentum);

    const aiScore = confidence + Math.random() * 10;

    return {
      symbol: c.symbol.toUpperCase(),
      price: c.current_price,
      confidence: confidence.toFixed(2),
      aiScore: aiScore.toFixed(2)
    };
  });
}

function buildFunnel(coins) {
  return {
    entry_ready: coins.filter(c => c.confidence > 8),
    setup: coins.filter(c => c.confidence > 4 && c.confidence <= 8),
    warmup: coins.filter(c => c.confidence > 1 && c.confidence <= 4),
    radar: coins.filter(c => c.confidence <= 1)
  };
}