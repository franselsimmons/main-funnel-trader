import { fetchCoinGeckoTopCached, fetchBTCGateFromUniverse } from "../lib/_main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";

import { detectVolatility } from "../lib/regime.js";
import { btcDominance } from "../lib/dominance.js";
import { chooseStrategy } from "../lib/strategy.js";

import { executeTrade } from "../lib/executionEngine.js";

let LAST = null;

export default async function handler(req,res){

  const mode = (req.query.mode || "bull").toLowerCase();

  const coins = await fetchCoinGeckoTopCached();
  const btc = await fetchBTCGateFromUniverse();

  const volatility = detectVolatility(coins);

  const totalCap = coins.reduce((a,c)=>a+(c.market_cap||0),0);

  const btcCap =
    coins.find(c=>c.symbol==="btc")?.market_cap || 0;

  const dominance = btcDominance(btcCap,totalCap);

  const strategy = chooseStrategy(volatility,dominance);

  const filtered = coins.filter(c =>
    mode==="bull" ? bullFilter(c) : bearFilter(c)
  );

  const resultCoins = [];

  for(const c of filtered){

    const result = executeTrade(c,strategy);

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
      stage: result==="WIN" ? "ENTRY" : "SKIP"
    });
  }

  LAST = {
    ts: Date.now(),
    mode,
    btc,
    volatility,
    dominance,
    strategy,
    coins: resultCoins
  };

  res.json(LAST);
}