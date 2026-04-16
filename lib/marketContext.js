export async function getMarketContext(){

  try{

    const res = await fetch(
      "https://api.coingecko.com/api/v3/global"
    );

    const data = await res.json();

    const dominance = data.data.market_cap_percentage.btc;

    let trend = "NEUTRAL";

    if(dominance > 52) trend = "BTC_STRONG";
    if(dominance < 48) trend = "ALTS_STRONG";

    return { dominance, trend };

  }catch{
    return { dominance:50, trend:"NEUTRAL" };
  }
}