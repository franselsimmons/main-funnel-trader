import { kv } from "@vercel/kv";
import { computeStage } from "../../lib/stageEngine";
import { computeRegime } from "../../lib/regimeEngine";
import { adaptive } from "../../lib/adaptiveEngine";
import { aiScore } from "../../lib/aiEngine";
import { fetchOrderbook } from "../../lib/orderbook";
import { getConfig } from "../../lib/configStore";
import { trackFlow } from "../../lib/flowTracker";
import { n } from "../../lib/utils";

const CG="https://api.coingecko.com/api/v3/coins/markets";

export default async function handler(req,res){
  const mode=req.query.mode==="bear"?"bear":"bull";
  const config=await getConfig();

  const raw=await fetch(`${CG}?vs_currency=usd&order=market_cap_desc&per_page=150&page=1&sparkline=false&price_change_percentage=1h,24h`).then(r=>r.json());

  const btcRow=raw.find(c=>c.id==="bitcoin");
  const regime=computeRegime(n(btcRow?.price_change_percentage_24h));

  const prev=await kv.get(`state:${mode}`)||{};
  const next={};
  const funnel={entry_ready:[],setup:[],warmup:[],radar:[]};

  for(const coin of raw){
    const sym=coin.symbol.toUpperCase();
    const p=prev[sym]||{};

    const confidence=Math.abs(n(coin.price_change_percentage_24h));

    const radarPass=confidence>10;
    const warmupPass=confidence>18;
    const setupPass=confidence>28;

    const ob=await fetchOrderbook(sym+"USDT");
    const thresholds=adaptive({regime,marketCap:n(coin.market_cap)});

    const entryPass=
      setupPass &&
      ob &&
      confidence>config.thresholds.confMin &&
      ob.spreadPct<config.thresholds.spreadMax &&
      ob.depthMin>config.thresholds.depthMin;

    const stageData=computeStage({
      radarPass,warmupPass,setupPass,entryPass,
      prevStage:p.stage,prevCycles:p.cycles
    });

    const ai=aiScore({
      confidence,
      depth:ob?.depthMin||0,
      spread:ob?.spreadPct||2
    });

    const out={
      symbol:sym,
      price:n(coin.current_price),
      confidence,
      stage:stageData.stage,
      cycles:stageData.cycles,
      aiScore:ai
    };

    next[sym]=out;

    if(out.stage==="ENTRY_READY")funnel.entry_ready.push(out);
    else if(out.stage==="SETUP")funnel.setup.push(out);
    else if(out.stage==="WARMUP")funnel.warmup.push(out);
    else if(out.stage==="RADAR")funnel.radar.push(out);
  }

  await kv.set(`state:${mode}`,next,{ex:3600});
  await trackFlow(mode,next);

  res.json({ok:true,mode,regime,funnel});
}