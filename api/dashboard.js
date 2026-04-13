let cache = {
  lastScan: null,
  bull: null,
  bear: null
};

let scanning = false;

async function fetchCoinGeckoUniverse() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=false"
    );

    const data = await res.json();

    // map naar universe formaat
    return data.map(c => ({
      symbol: c.symbol.toUpperCase() + "USD",
      price: c.current_price,
      volume: c.total_volume,
      change24h: c.price_change_percentage_24h
    }));

  } catch (err) {
    console.error("CoinGecko universe fetch error", err);
    return [];
  }
}

function scoreCoin(c) {
  const score =
    (Math.min(c.volume / 10000000, 1) + Math.min(Math.abs(c.change24h) / 10, 1)) / 2;
  return score;
}

function categorize(universe) {
  const coinsWithScore = universe.map(c => ({
    symbol: c.symbol,
    score: scoreCoin(c),
    entry: c.price,
    side: null
  }));

  return {
    tradeReady: coinsWithScore.filter(c => c.score > 0.75),
    setup: coinsWithScore.filter(c => c.score > 0.45 && c.score <= 0.75),
    warmup: coinsWithScore.filter(c => c.score <= 0.45),
    trades: coinsWithScore.filter(c => c.score > 0.85)
  };
}

async function startScanner() {
  if (scanning) return;
  scanning = true;

  // first immediate scan
  cache.lastScan = Date.now();
  const universe = await fetchCoinGeckoUniverse();
  cache.bull = categorize(universe);
  cache.bear = categorize(universe);

  setInterval(async () => {
    const uni = await fetchCoinGeckoUniverse();
    cache.lastScan = Date.now();
    cache.bull = categorize(uni);
    cache.bear = categorize(uni);
  }, 30000); // scan elke 30 seconden
}

export default async function handler(req, res) {
  const side = req.query.side || "bull";

  if (!scanning) await startScanner();

  const out = cache[side] || {
    lastScan: cache.lastScan,
    tradeReady: [],
    setup: [],
    warmup: [],
    trades: []
  };

  res.status(200).json({
    lastScan: cache.lastScan,
    ...out
  });
}