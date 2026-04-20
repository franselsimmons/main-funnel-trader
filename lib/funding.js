// ================= FUNDING DATA =================

export async function fetchFunding(symbol){

  try{
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`
    );

    const data = await res.json();

    return {
      rate: Number(data.lastFundingRate || 0)
    };

  }catch{
    return { rate: 0 };
  }
}