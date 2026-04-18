import { analyzeFlow } from "./flowEngine.js";
import { getSniperEntry } from "./sniperEntry.js";
import {
  fetchOrderBook,
  analyzeOrderBookAdvanced
} from "./orderbook.js";
import { calculateRisk } from "./riskManager.js";
import { logTrade } from "./logger.js";
import { getLiquidityZones } from "./liquidity.js";
import { getVolatility } from "./volatility.js";
import { getMarketContext } from "./marketContext.js";
import { getFilters } from "./filterState.js";

const memory = new Map();

export async function processTrades(coins, btc, mode, regime){

  const actions = [];
  const market = await getMarketContext();
  const filters = getFilters();

  const tradeF = filters.trade || {
    rrMin: 1.5,
    scoreMin: 60,
    requireTrend: true,
    blockSpoof: true
  };

  // 🔥 Parallel OB
  const obMap = {};
  await Promise.all(
    coins.map(async c=>{
      try{
        const raw = await fetchOrderBook(c.symbol+"USDT");
        obMap[c.symbol] = analyzeOrderBookAdvanced(raw);
      }catch{
        obMap[c.symbol] = { bias:"NEUTRAL", spoof:false };
      }
    })
  );

  for(const c of coins){

    const key = `${c.symbol}_${c.side}`;
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c);
    const vol = getVolatility(c);
    const ob = obMap[c.symbol];
    const liq = getLiquidityZones(c);

    // 🔥 VOLATILITY BASED RISK
    const baseRisk = calculateRisk(c);

    let rrDynamic = tradeF.rrMin;

    if(vol === "HIGH") rrDynamic = 2.2;
    else if(vol === "LOW") rrDynamic = 1.2;

    const risk = {
      ...baseRisk,
      rr: rrDynamic,
      tp: c.side === "bull"
        ? baseRisk.entry + (baseRisk.entry - baseRisk.sl) * rrDynamic
        : baseRisk.entry - (baseRisk.sl - baseRisk.entry) * rrDynamic
    };

    let action = "WATCH";
    let reason = "default";

    // ================= SKIP =================
    if(vol === "LOW"){
      action = "SKIP";
      reason = "low_vol";
    }

    // ================= ENTRY =================
    else if(!prev){

      const trendOK = !tradeF.requireTrend || flow.type === "TREND";
      const spoofOK = !tradeF.blockSpoof || !ob.spoof;

      const strongMomentum = c.moveScore > 85;

      const entryBoost =
        strongMomentum &&
        flow.type === "TREND" &&
        vol !== "LOW";

      if(
        (sniper.valid || entryBoost) &&
        trendOK &&
        spoofOK &&
        c.moveScore >= tradeF.scoreMin
      ){

        action = "ENTRY";
        reason = entryBoost ? "momentum_boost" : "sniper_entry";

        memory.set(key,{
          entry:risk.entry,
          sl:risk.sl,
          tp:risk.tp,
          partialTP: risk.entry + (risk.tp - risk.entry) * 0.5,
          movedBE:false,
          openedAt:Date.now()
        });

      } else {
        action = "WAIT";
        reason = "no_entry";
      }
    }

    // ================= OPEN POSITION =================
    else{

      const pos = prev;

      const price = c.price;

      // 🔥 PARTIAL TP
      if(!pos.partialDone){

        const hitPartial =
          (c.side === "bull" && price >= pos.partialTP) ||
          (c.side === "bear" && price <= pos.partialTP);

        if(hitPartial){
          pos.partialDone = true;

          // 🔥 MOVE SL → BE
          pos.sl = pos.entry;
          pos.movedBE = true;
        }
      }

      // 🔥 TP / SL
      const hitTP =
        (c.side === "bull" && price >= pos.tp) ||
        (c.side === "bear" && price <= pos.tp);

      const hitSL =
        (c.side === "bull" && price <= pos.sl) ||
        (c.side === "bear" && price >= pos.sl);

      if(hitTP){
        action = "EXIT";
        reason = "TP";

        logTrade({
          symbol:c.symbol,
          side:c.side,
          entry:pos.entry,
          exit:price,
          result:"WIN",
          rr:risk.rr
        });

        memory.delete(key);
      }

      else if(hitSL){
        action = "EXIT";
        reason = pos.movedBE ? "BE" : "SL";

        logTrade({
          symbol:c.symbol,
          side:c.side,
          entry:pos.entry,
          exit:price,
          result: pos.movedBE ? "BE" : "LOSS",
          rr:risk.rr
        });

        memory.delete(key);
      }

      else{
        action = "HOLD";
        reason = pos.movedBE ? "secured" : "running";
      }
    }

    actions.push({
      symbol:c.symbol,
      side:c.side,
      action,
      reason,
      stage:c.stage,
      score:c.moveScore,
      flow:flow.type,
      rr:risk.rr,
      entry:risk.entry,
      sl:risk.sl,
      tp:risk.tp,
      ob:ob.bias,
      spoof:ob.spoof,
      volatility:vol,
      macro:market.trend
    });
  }

  return actions.sort((a,b)=>b.score-a.score);
}