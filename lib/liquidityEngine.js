// ================= REAL LIQUIDATION ENGINE =================

export async function fetchLiquidations(symbol){

  try{
    const res = await fetch(
      `https://open-api.coinglass.com/public/v2/liquidation_map?symbol=${symbol}`
    );

    const json = await res.json();

    const data = json?.data || [];

    if(!data.length){
      return null;
    }

    // 🔥 pak grootste clusters
    const sorted = data.sort((a,b)=>b.liquidation_value - a.liquidation_value);

    const top = sorted.slice(0,5);

    const longs = top.filter(x => x.side === "long");
    const shorts = top.filter(x => x.side === "short");

    return {
      longZones: longs.map(x => Number(x.price)),
      shortZones: shorts.map(x => Number(x.price))
    };

  }catch(e){
    return null;
  }
}