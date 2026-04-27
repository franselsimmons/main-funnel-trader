// ================= MARKET STRUCTURE =================

export function getStructureState(candles){

  if(!candles || candles.length < 20){
    return { trend: "UNKNOWN" };
  }

  const highs = candles.slice(-10).map(c => c.high);
  const lows  = candles.slice(-10).map(c => c.low);

  const prevHighs = candles.slice(-20, -10).map(c => c.high);
  const prevLows  = candles.slice(-20, -10).map(c => c.low);

  const HH = Math.max(...highs) > Math.max(...prevHighs);
  const HL = Math.min(...lows)  > Math.min(...prevLows);

  const LH = Math.max(...highs) < Math.max(...prevHighs);
  const LL = Math.min(...lows)  < Math.min(...prevLows);

  if(HH && HL) return { trend: "BULLISH" };
  if(LH && LL) return { trend: "BEARISH" };

  return { trend: "RANGE" };
}