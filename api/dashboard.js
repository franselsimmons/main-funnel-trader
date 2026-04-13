// pages/api/dashboard.js

let cache = {
  lastScan: null,
  bull: null,
  bear: null
};

let scanning = false;

const symbols = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "AVAXUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT"
];

function generateSide(side) {
  const coins = symbols.map((s) => {
    const score = Math.random();

    return {
      symbol: s,
      score,
      entry: (Math.random() * 1000 + 10).toFixed(2),
      side
    };
  });

  return {
    tradeReady: coins.filter(c => c.score > 0.75),
    setup: coins.filter(c => c.score > 0.45 && c.score <= 0.75),
    warmup: coins.filter(c => c.score <= 0.45),
    trades: coins.filter(c => c.score > 0.85)
  };
}

function startScanner() {
  if (scanning) return;

  scanning = true;

  setInterval(() => {
    cache.lastScan = Date.now();
    cache.bull = generateSide("bull");
    cache.bear = generateSide("bear");
  }, 15000);

  // first immediate scan
  cache.lastScan = Date.now();
  cache.bull = generateSide("bull");
  cache.bear = generateSide("bear");
}

export default function handler(req, res) {
  const side = req.query.side || "bull";

  if (!scanning) startScanner();

  if (!cache[side]) {
    return res.status(200).json({
      lastScan: null,
      tradeReady: [],
      setup: [],
      warmup: [],
      trades: []
    });
  }

  res.status(200).json({
    lastScan: cache.lastScan,
    ...cache[side]
  });
}