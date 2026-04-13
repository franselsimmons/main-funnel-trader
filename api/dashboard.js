// pages/api/dashboard.js

export default async function handler(req, res) {
  const side = req.query.side || "bull";

  // SIMULATIE
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT"];

  const generateCoins = () => {
    return symbols.map(s => ({
      symbol: s,
      score: Math.random(),
      entry: (Math.random() * 1000).toFixed(2),
      side
    }));
  };

  const all = generateCoins();

  res.status(200).json({
    lastScan: Date.now(),
    tradeReady: all.filter(c => c.score > 0.7),
    setup: all.filter(c => c.score > 0.4 && c.score <= 0.7),
    warmup: all.filter(c => c.score <= 0.4),
    trades: all.filter(c => c.score > 0.8)
  });
}