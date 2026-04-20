// ================= CORE =================
export async function buildScanPayload(){

  initDefaultFilters();
  resetAnalytics();

  const rawCoins = await fetchCoinGeckoTopCached();
  if(!Array.isArray(rawCoins)) throw new Error("API error");

  const btc = {
    state: rawCoins[0]?.price_change_percentage_24h > 0
      ? "BULLISH"
      : "BEARISH"
  };

  const regime = detectRegime(rawCoins) || "NORMAL";
  const market = classifyMarket(rawCoins);

  const funnel = {
    bull:{ entry:[], almost:[], buildup:[], radar:[] },
    bear:{ entry:[], almost:[], buildup:[], radar:[] }
  };

  const tradeCandidates = [];

  let memory = await loadStageMemory();
  const activeSymbols = [];

  for(const raw of rawCoins){

    const base = normalize(raw);
    if(!base.symbol || base.price <= 0) continue;

    activeSymbols.push(base.symbol);

    const direction = decideDirection(base);
    if(direction === "none") continue;

    // 🔥 BETERE PREFILTER
    if(base.vm < 0.12) continue;
    if(Math.abs(base.change24) < 3) continue;

    const flow = detectFlow(base);
    const score = calculateScore(base, regime);
    const edge = calculateEdge(base, regime) || 0;

    const coin = {
      ...base,
      side: direction,
      flow,
      moveScore: score,
      edge
    };

    const key = base.symbol + "_" + direction;
    const prev = memory[key] || { stage:"radar" };

    const filterStage =
      direction === "bull"
        ? bullFilter(coin)
        : bearFilter(coin);

    if(!filterStage) continue;

    const newStage = mergeStage(prev.stage, filterStage);

    memory[key] = { stage:newStage };
    coin.stage = newStage;

    funnel[direction][newStage].push(coin);
    logAnalytics(coin);

    // 🔥 BESTE VAN BESTE
    if(
      newStage === "entry" &&
      score > 75 &&
      flow === "TREND"
    ){
      tradeCandidates.push(coin);
    }
  }

  memory = cleanMemory(memory, activeSymbols);
  await saveStageMemory(memory);

  for(const side of ["bull","bear"]){
    for(const k in funnel[side]){
      funnel[side][k].sort((a,b)=>b.moveScore-a.moveScore);
    }
  }

  const trades = await processTrades(
    tradeCandidates,
    btc,
    "auto",
    regime
  );

  const analytics = getAnalytics();
  const advice = generateAdvice(analytics);

  const payload = {
    ok:true,
    btc,
    regime,
    market,
    funnel,
    trades,
    analytics,
    advice,
    total: rawCoins.length,
    candidates: tradeCandidates.length
  };

  setLatestScan(payload);

  return payload;
}