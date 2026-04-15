// ================= BTC STATE =================
export async function fetchBTCGateFromUniverse() {
  try {
    return {
      state: "BULLISH",
      chg24: 2.1,
      range24: 4.2
    };
  } catch (e) {
    return { state: "NEUTRAL" };
  }
}

// ================= COIN SELECTOR ELITE =================
export async function fetchCoinGeckoTopCached() {

  const pages = [1, 2, 3]; // 🔥 300 coins
  let all = [];

  try {

    for (const p of pages) {

      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=${p}&sparkline=false&price_change_percentage=1h,24h`,
        {
          headers: {
            "accept": "application/json"
          }
        }
      );

      if (!res.ok) continue;

      const data = await res.json();

      if (Array.isArray(data)) {
        all = all.concat(data);
      }
    }

    // ================= FILTER =================
    // 🔥 verwijder garbage coins
    all = all.filter(c =>
      c &&
      c.symbol &&
      c.current_price &&
      c.total_volume &&
      c.market_cap &&
      c.total_volume > 500000 &&      // volume filter
      c.market_cap > 5_000_000        // market cap filter
    );

    // ================= DEDUP =================
    const seen = new Set();
    all = all.filter(c => {
      const key = c.symbol;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ================= SORT =================
    all.sort((a, b) => b.total_volume - a.total_volume);

    // ================= LIMIT =================
    return all.slice(0, 300);

  } catch (err) {

    console.error("CoinGecko error:", err.message);

    // 🔥 FAILSAFE (NOOIT CRASH)
    return [
      {
        symbol: "BTC",
        name: "Bitcoin",
        current_price: 60000,
        market_cap: 1000000000000,
        total_volume: 30000000000,
        price_change_percentage_24h: 2,
        price_change_percentage_1h: 0.5
      },
      {
        symbol: "ETH",
        name: "Ethereum",
        current_price: 3000,
        market_cap: 400000000000,
        total_volume: 15000000000,
        price_change_percentage_24h: 3,
        price_change_percentage_1h: 0.8
      }
    ];
  }
}

// ================= FUTURES (OPTIONAL MOCK) =================
export async function fetchFuturesTickers() {
  return new Map();
}

// ================= ORDERBOOK =================
export function generateShallowOb() {
  return {
    spreadPct: 0.05,
    score: 0.05,
    depthMinUsd1p: 100000
  };
}