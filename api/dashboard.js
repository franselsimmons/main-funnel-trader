// pages/api/dashboard.js

let cache = {
  lastScan: null,
  coins: {}
};

let scanning = false;

// settings
const SCAN_INTERVAL = 20000; // 20 sec
const WARMUP_THRESHOLD = 0.4;
const SETUP_THRESHOLD = 0.6;
const TRADE_THRESHOLD = 0.8;
const MAX_COINS = 150;

// ===== FETCH COINGECKO =====

async function fetchUniverse() {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=${MAX_COINS}&page=1&sparkline=false`
    );

    const data = await res.json();

    return data
      .filter(c => c.total_volume > 10000000) // min volume
      .map(c => ({
        symbol: c.symbol.toUpperCase() + "USD",
        price: c.current_price,
        volume: c.total_volume,
        change: c.price_change_percentage_24h || 0
      }));
  } catch (e) {
    console.error("CoinGecko error", e);
    return [];
  }
}

// ===== SCORE ENGINE =====

function calculateScore(coin) {
  const volumeScore = Math.min(coin.volume / 50000000, 1);
  const momentumScore = Math.min(Math.abs(coin.change) / 10, 1);
  return (volumeScore + momentumScore) / 2;
}

// ===== PROGRESSION ENGINE =====

function updateCoins(universe) {
  universe.forEach(coin => {
    const score = calculateScore(coin);

    if (!cache.coins[coin.symbol]) {
      // Nieuwe coin start altijd in warmup
      cache.coins[coin.symbol] = {
        ...coin,
        strength: score,
        stage: "warmup",
        confirmations: 0,
        lastSeen: Date.now()
      };
    } else {
      const existing = cache.coins[coin.symbol];

      // update strength
      existing.strength = (existing.strength + score) / 2;
      existing.lastSeen = Date.now();

      // progression logic
      if (existing.stage === "warmup" && existing.strength > SETUP_THRESHOLD) {
        existing.confirmations++;
        if (existing.confirmations >= 2) {
          existing.stage = "setup";
          existing.confirmations = 0;
        }
      }

      if (existing.stage === "setup" && existing.strength > TRADE_THRESHOLD) {
        existing.confirmations++;
        if (existing.confirmations >= 2) {
          existing.stage = "tradeReady";
          existing.confirmations = 0;
        }
      }

      // degrade if weak
      if (existing.strength < WARMUP_THRESHOLD) {
        existing.stage = "warmup";
        existing.confirmations = 0;
      }
    }
  });

  // verwijder coins die 3 scans niet gezien zijn
  Object.keys(cache.coins).forEach(symbol => {
    if (Date.now() - cache.coins[symbol].lastSeen > SCAN_INTERVAL * 3) {
      delete cache.coins[symbol];
    }
  });
}

// ===== BUILD RESPONSE =====

function buildResponse() {
  const all = Object.values(cache.coins);

  return {
    lastScan: cache.lastScan,
    warmup: all.filter(c => c.stage === "warmup"),
    setup: all.filter(c => c.stage === "setup"),
    tradeReady: all.filter(c => c.stage === "tradeReady"),
    trades: all.filter(c => c.stage === "tradeReady")
  };
}

// ===== START SCANNER =====

async function startScanner() {
  if (scanning) return;
  scanning = true;

  async function scan() {
    const universe = await fetchUniverse();
    updateCoins(universe);
    cache.lastScan = Date.now();
  }

  await scan();
  setInterval(scan, SCAN_INTERVAL);
}

// ===== API HANDLER =====

export default async function handler(req, res) {
  if (!scanning) {
    await startScanner();
  }

  res.status(200).json(buildResponse());
}