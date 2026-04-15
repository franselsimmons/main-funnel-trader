import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  fetchFuturesTickers,
  fetchContractConfigs,
  generateShallowOb
} from "../lib/_main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import { detectVolatility } from "../lib/regime.js";
import { btcDominance } from "../lib/dominance.js";
import { chooseStrategy } from "../lib/strategy.js";

import { executeTrade } from "../lib/executionEngine.js";

import { hasEdge } from "../lib/edge.js";

import { updatePositions } from "../lib/lifecycle.js";
import { getPositions } from "../lib/position.js";

import { getPortfolio } from "../lib/portfolio.js";

let LAST = null;

export default async function handler(req, res){

  try {

    // ===== MODE =====
    const mode = (req.query.mode || "bull").toLowerCase();

    // ===== DATA =====
    const coins = await fetchCoinGeckoTopCached();
    const btc = await fetchBTCGateFromUniverse();

    // ===== MARKET ANALYSIS =====
    const volatility = detectVolatility(coins);

    const totalCap = coins.reduce((a,c)=>a+(c.market_cap||0),0);

    const btcCap =
      coins.find(c=>c.symbol==="btc")?.market_cap || 0;

    const dominance = btcDominance(btcCap,totalCap);

    const strategy = chooseStrategy(volatility, dominance);

    // ===== UPDATE OPEN POSITIONS =====
    updatePositions();

    // ===== FILTER COINS =====
    const filtered = coins.filter(c =>
      mode === "bull"
        ? bullFilter(c)
        : bearFilter(c)
    );

    const resultCoins = [];

    // ===== PROCESS COINS =====
    for(const c of filtered){

      // 🔥 EDGE CHECK (BELANGRIJK)
      if(!hasEdge(c)) continue;

      // ===== EXECUTE TRADE =====
      const result = executeTrade(c, strategy);

      resultCoins.push({
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        price: c.current_price,
        change24: c.price_change_percentage_24h,
        change1h: c.price_change_percentage_1h,
        volume: c.total_volume,
        marketCap: c.market_cap,
        strategy,
        result,
        stage: result === "OPENED" ? "ENTRY" : "SKIP"
      });
    }

    // ===== STATE =====
    const positions = getPositions();
    const portfolio = getPortfolio();

    LAST = {
      ts: Date.now(),
      mode,
      btc,
      volatility,
      dominance,
      strategy,
      coins: resultCoins,
      positions,
      portfolio
    };

    res.json(LAST);

  } catch (err) {

    console.error("SCANNER ERROR:", err);

    res.status(500).json({
      error: "Scanner crash",
      message: err.message
    });
  }
}