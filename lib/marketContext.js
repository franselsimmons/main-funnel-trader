export async function getMarketContext(){

  try{

    const btcRes = await fetch(
      "https://api.coingecko.com/api/v3/coins/bitcoin"
    );

    const btc = await btcRes.json();

    const dominance = btc.market_data.market_cap_percentage.usd || 50;

    let trend = "NEUTRAL";

    if(dominance > 52) trend = "BTC_STRONG";
    if(dominance < 48) trend = "ALTS_STRONG";

    return {
      dominance,
      trend
    };

  }catch{
    return {
      dominance:50,
      trend:"NEUTRAL"
    };
  }
}