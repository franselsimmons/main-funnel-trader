// ================= RSI ENGINE (ADVANCED - TV STYLE) =================

// ================= HELPERS =================
function ema(values, length){
  const k = 2 / (length + 1);
  let emaArr = [];
  let prev = values[0];

  for(let i = 0; i < values.length; i++){
    const val = values[i];
    prev = i === 0 ? val : (val * k + prev * (1 - k));
    emaArr.push(prev);
  }

  return emaArr;
}

function sma(values, length){
  let res = [];
  for(let i = 0; i < values.length; i++){
    if(i < length){
      res.push(values[i]);
    }else{
      const slice = values.slice(i - length, i);
      res.push(slice.reduce((a,b)=>a+b,0)/length);
    }
  }
  return res;
}

function clamp(x, min, max){
  return Math.max(min, Math.min(max, x));
}

// ================= RSI CALC =================
function rsiCalc(closes, length = 14){
  let gains = [];
  let losses = [];

  for(let i = 1; i < closes.length; i++){
    const diff = closes[i] - closes[i-1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  const avgGain = ema(gains, length);
  const avgLoss = ema(losses, length);

  let rsi = [];

  for(let i = 0; i < avgGain.length; i++){
    const rs = avgLoss[i] === 0 ? 100 : avgGain[i] / avgLoss[i];
    rsi.push(100 - (100 / (1 + rs)));
  }

  return rsi;
}

// ================= CORE =================
export function getAdvancedRSIContext(candles){

  if(!candles || candles.length < 100){
    return { valid: false };
  }

  const closes = candles.map(c => c.close);

  // 🔥 RSI (zoals TradingView)
  const rsiRaw = rsiCalc(closes, 14);
  const rsiSmooth = ema(rsiRaw, 5);
  const rsi = rsiSmooth[rsiSmooth.length - 1];

  // 🔥 Mean (EMA 100)
  const rsiMeanArr = ema(rsiSmooth, 100);
  const rsiMean = rsiMeanArr[rsiMeanArr.length - 1];

  // ================= RSI RANGE COMPRESSIE =================
  const recent = rsiSmooth.slice(-50);
  const rHi = Math.max(...recent);
  const rLo = Math.min(...recent);
  const rRange = rHi - rLo;

  const sRSI = clamp((40 - rRange) / 30, 0, 1);

  // ================= ATR COMPRESSIE =================
  const returns = [];

  for(let i = 1; i < closes.length; i++){
    returns.push(Math.abs(closes[i] - closes[i-1]));
  }

  const atrNow = returns.slice(-14).reduce((a,b)=>a+b,0)/14;
  const atrAvg = returns.slice(-50).reduce((a,b)=>a+b,0)/50;

  const ratio = atrAvg === 0 ? 1 : atrNow / atrAvg;
  const sATR = clamp(1 - ratio, 0, 1);

  // ================= STRESS =================
  const stress = (sATR + sRSI) / 2;

  // 🔥 compressie power (zelfde als Pine)
  const tComp = Math.pow(stress, 1.0);

  // ================= ZONES =================
  const lerp = (a,b,t)=> a + (b-a)*t;

  const d1 = lerp(20, 12, tComp);
  const d2 = lerp(30, 18, tComp);
  const d3 = lerp(40, 24, tComp);

  const U1 = 50 + d1;
  const U2 = 50 + d2;
  const U3 = 50 + d3;

  const L1 = 50 - d1;
  const L2 = 50 - d2;
  const L3 = 50 - d3;

  return {
    valid: true,
    rsi,
    mean: rsiMean,
    stress,
    zones: { U1, U2, U3, L1, L2, L3 }
  };
}

// ================= TYPE 1 ENTRY FILTER =================
export function isType1RSIEntry(rsiCtx, side){

  if(!rsiCtx?.valid) return false;

  const rsi = rsiCtx.rsi;
  const { U1, U2, U3, L1, L2, L3 } = rsiCtx.zones;

  // 🔥 BELANGRIJK → zorgt voor VEEL meer trades
  const margin = 4.0;

  // ================= LONG =================
  if(side === "bull"){
    return (
      rsi <= (L1 + margin) ||
      rsi <= (L2 + margin) ||
      rsi <= (L3 + margin)
    );
  }

  // ================= SHORT =================
  if(side === "bear"){
    return (
      rsi >= (U1 - margin) ||
      rsi >= (U2 - margin) ||
      rsi >= (U3 - margin)
    );
  }

  return false;
}