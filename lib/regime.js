export function detectRegime(coins){

  try{

    if(!coins || coins.length === 0){
      return "LOW_VOL";
    }

    const avg =
      coins.reduce((sum, c) => {

        // 🔥 support BOTH raw & normalized data
        const val =
          c.price_change_percentage_24h ??
          c.change24 ??
          0;

        return sum + Math.abs(Number(val) || 0);

      }, 0) / coins.length;

    if(avg < 3) return "LOW_VOL";
    if(avg < 6) return "MID_VOL";
    return "HIGH_VOL";

  }catch(e){

    console.error("REGIME ERROR:", e);

    return "MID_VOL"; // 🔥 fallback → systeem blijft werken
  }
}