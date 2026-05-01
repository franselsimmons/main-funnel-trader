// ================= RSI ENGINE (PRO VERSION - NON BLOCKING) =================

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

// ================= CORE RSI CONTEXT =================
export function getAdvancedRSIContext(candles){
  if(!candles || candles.length < 80){
    return { valid: false };
  }

  const closes = candles.map(c => c.close);

  const rsiRaw = rsiCalc(closes, 14);
  const rsiSmooth = ema(rsiRaw, 14);

  const rsi = rsiSmooth[rsiSmooth.length - 1];

  const rsiMeanArr = ema(rsiSmooth, 100);
  const rsiMean = rsiMeanArr[rsiMeanArr.length - 1];

  // 🔥 BETERE ZONES (crypto friendly)
  const ZONE_1 = 12;
  const ZONE_2 = 20;
  const ZONE_3 = 28;

  const zones = {
    U1: 50 + ZONE_1, // 62
    U2: 50 + ZONE_2, // 70
    U3: 50 + ZONE_3, // 78
    L1: 50 - ZONE_1, // 38
    L2: 50 - ZONE_2, // 30
    L3: 50 - ZONE_3  // 22
  };

  return {
    valid: true,
    rsi,
    mean: rsiMean,
    zones
  };
}

// ================= MTF =================
export function getMTFRSI({ m15, h1, h4 = null }){
  const rsi15 = getAdvancedRSIContext(m15);
  const rsi1h = getAdvancedRSIContext(h1);
  const rsi4h = h4 ? getAdvancedRSIContext(h4) : null;

  return { m15: rsi15, h1: rsi1h, h4: rsi4h };
}

// ================= SIGNAL =================
export function getRSISignal(mtfrsi, side){

  const { m15, h1, h4 } = mtfrsi;

  if(!m15?.valid || !h1?.valid){
    return { valid: false };
  }

  const isBull = side === "bull";

  // 🔥 SOFT TREND (BELANGRIJK)
  const trendLong = h1.rsi > (h1.mean - 5);
  const trendShort = h1.rsi < (h1.mean + 5);

  let strength = 0;

  if(isBull){
    if(m15.rsi <= m15.zones.L3) strength = 3;
    else if(m15.rsi <= m15.zones.L2) strength = 2;
    else if(m15.rsi <= m15.zones.L1) strength = 1;
  } else {
    if(m15.rsi >= m15.zones.U3) strength = 3;
    else if(m15.rsi >= m15.zones.U2) strength = 2;
    else if(m15.rsi >= m15.zones.U1) strength = 1;
  }

  // 🔥 ALLEEN HARD BLOCK OP EXTREME HTF
  let blocked = false;

  if(h4?.valid){
    if(isBull && h4.rsi < 35) blocked = true;
    if(!isBull && h4.rsi > 65) blocked = true;
  }

  return {
    valid: !blocked, // ❗ geen harde trend eis meer
    strength,
    trend: isBull ? trendLong : trendShort,
    blocked,
    rsi: m15.rsi,
    zones: m15.zones,
    mean1h: h1.mean
  };
}

// ================= TYPE 1 =================
export function isType1RSIEntry(rsiCtx, side){
  if(!rsiCtx?.valid) return true;

  const rsi = rsiCtx.rsi;
  const { U1, U2, L1, L2 } = rsiCtx.zones;

  if(side === "bull"){
    return rsi <= (L1 + 6) || rsi <= (L2 + 6);
  }

  if(side === "bear"){
    return rsi >= (U1 - 6) || rsi >= (U2 - 6);
  }

  return true;
}