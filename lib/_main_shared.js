// CORE DATA PROVIDERS (ELITE READY)

// ================= BTC REGIME =================
export async function fetchBTCGateFromUniverse() {
  return {
    state: "BULLISH", // BULLISH | BEARISH | NEUTRAL
    chg24: 2.3,
    range24: 4.8,
    dominance: 52.1
  };
}

// ================= MARKET DATA =================
export async function fetchCoinGeckoTopCached() {
  return [
    {
      id: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      current_price: 64000,
      market_cap: 1_200_000_000_000,
      total_volume: 32_000_000_000,
      price_change_percentage_24h: 3.1,
      price_change_percentage_1h: 0.6,
      high_24h: 65000,
      low_24h: 62000
    },
    {
      id: "solana",
      symbol: "SOL",
      name: "Solana",
      current_price: 150,
      market_cap: 65_000_000_000,
      total_volume: 4_000_000_000,
      price_change_percentage_24h: 8.5,
      price_change_percentage_1h: 1.2,
      high_24h: 155,
      low_24h: 138
    }
  ];
}

// ================= FUTURES DATA =================
export async function fetchFuturesTickers() {
  const map = new Map();

  map.set("BTCUSDT", {
    spreadPct: 0.01,
    score: 0.12,
    depthMinUsd1p: 1_500_000
  });

  map.set("SOLUSDT", {
    spreadPct: 0.05,
    score: 0.08,
    depthMinUsd1p: 500_000
  });

  return map;
}

// ================= CONTRACT CONFIG =================
export async function fetchContractConfigs() {
  const map = new Map();

  map.set("BTCUSDT", {
    minSize: 0.001,
    tickSize: 0.1
  });

  map.set("SOLUSDT", {
    minSize: 0.1,
    tickSize: 0.01
  });

  return map;
}

// ================= ORDERBOOK =================
export function generateShallowOb(ticker) {
  if (!ticker) {
    return {
      spreadPct: 99,
      score: 0,
      depthMinUsd1p: 0
    };
  }

  return {
    spreadPct: ticker.spreadPct ?? 0.1,
    score: ticker.score ?? 0,
    depthMinUsd1p: ticker.depthMinUsd1p ?? 0
  };
}

// ================= POSITION SIZE =================
export function calculateFuturesSize(entry, sl, riskUsd, config) {
  if (!entry || !sl || !config) return 0;

  const riskPct = Math.abs((entry - sl) / entry);
  if (riskPct === 0) return 0;

  let size = riskUsd / (entry * riskPct);

  if (size < config.minSize) return 0;

  return Number(size.toFixed(3));
}