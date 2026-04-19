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


// ================= ENTRY TIMING (🔥 van oud systeem)
function entryTriggerOk(price, entry){
  if(!price || !entry) return false;

  const dist = Math.abs((price - entry) / entry) * 100;
  return dist < 1.2; // max 1.2% van entry
}


// ================= MAIN =================
export async function processTrades(coins, btc, mode, regime){

  const actions = [];
  const market = await getMarketContext();
  const filters = getFilters();
  const tradeF = filters.trade;

  const seen = new Set();

  // 🔥 parallel orderbook
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

    // 🔥 duplicate filter (zoals oude conflict resolver)
    if(seen.has(c.symbol)){
      continue;
    }
    seen.add(c.symbol);


    const key = `${c.symbol}_${c.side}`;
    const prev = memory.get(key);

    const flow = analyzeFlow(c);
    const sniper = getSniperEntry(c);
    const risk = calculateRisk(c);
    const vol = getVolatility(c);

    const ob = obMap[c.symbol];
    const liq = getLiquidityZones(c);

    let action = "WATCH";
    let reason = "default";


    // ================= HARD SKIP =================
    if(vol === "LOW"){
      action = "SKIP";
      reason = "low_volatility";
    }

    if(c.stage !== "entry"){
      action = "SKIP";
      reason = "not_ready";
    }


    // ================= ENTRY =================
    else if(!prev){

      const macroOK =
        market.trend === "NEUTRAL" ||
        (c.side === "bull" && market.trend !== "BTC_STRONG") ||
        (c.side === "bear" && market.trend !== "ALTS_STRONG");

      const trendOK = !tradeF.requireTrend || flow.type === "TREND";
      const spoofOK = !tradeF.blockSpoof || !ob.spoof;

      const strongMomentum =
        c.moveScore >= 90 &&
        flow.type === "TREND";

      const entryOk = entryTriggerOk(c.price, risk.entry);

      if(
        (sniper.valid || strongMomentum) &&
        trendOK &&
        macroOK &&
        spoofOK &&
        entryOk && // 🔥 NIEUW (belangrijk!)
        c.moveScore >= tradeF.scoreMin &&
        risk.rr >= tradeF.rrMin
      ){

        action = "ENTRY";
        reason = strongMomentum ? "momentum" : "sniper";

        memory.set(key,{
          entry:risk.entry,
          sl:risk.sl,
          tp:risk.tp,
          openedAt:Date.now()
        });

      } else {
        action = "WAIT";
        reason = "filters_not_met";
      }
    }


    // ================= POSITION OPEN =================
    else{

      const pos = prev;

      const hitTP =
        (c.side === "bull" && c.price >= pos.tp) ||
        (c.side === "bear" && c.price <= pos.tp);

      const hitSL =
        (c.side === "bull" && c.price <= pos.sl) ||
        (c.side === "bear" && c.price >= pos.sl);

      if(hitTP){
        action = "EXIT";
        reason = "TP";

        logTrade({
          symbol:c.symbol,
          side:c.side,
          entry:pos.entry,
          exit:c.price,
          result:"WIN",
          rr:risk.rr
        });

        memory.delete(key);
      }

      else if(hitSL){
        action = "EXIT";
        reason = "SL";

        logTrade({
          symbol:c.symbol,
          side:c.side,
          entry:pos.entry,
          exit:c.price,
          result:"LOSS",
          rr:risk.rr
        });

        memory.delete(key);
      }

      else{
        action = "HOLD";
        reason = "running";
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
      rr:Number(risk.rr).toFixed(2),
      entry:risk.entry,
      sl:risk.sl,
      tp:risk.tp,
      ob:ob.bias,
      spoof:ob.spoof,
      volatility:vol,
      macro:market.trend
    });
  }

  return actions.sort((a,b)=>Number(b.score||0)-Number(a.score||0));
}