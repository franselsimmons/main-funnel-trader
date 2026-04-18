// ================= HELPERS =================
function sigmoid(x){
  return 1 / (1 + Math.exp(-x));
}

function clamp(v, min, max){
  return Math.max(min, Math.min(max, v));
}


// ================= FEATURE VECTOR =================
function extractMetaVector(input){

  const moveScore = clamp(Number(input.moveScore || 0) / 100, 0, 1.2);
  const rr = clamp(Number(input.rr || 0) / 3, 0, 1.5);
  const vm = clamp(Number(input.vm || 0) * 2, 0, 2);
  const edge = clamp(Number(input.edge || 0) / 5, 0, 1.5);

  let flow = 0;
  if(input.flow === "TREND") flow = 1.5;
  else if(input.flow === "BUILDING") flow = 0.8;
  else if(input.flow === "EARLY") flow = 0.3;
  else flow = -0.4;

  let vol = 0;
  if(input.volatility === "HIGH") vol = 1.0;
  else if(input.volatility === "MEDIUM") vol = 0.6;
  else vol = -0.6;

  let sniper = input.sniperValid ? 1.2 : -0.8;
  let spoof = input.spoof ? -1.4 : 0.4;

  let macro = 0;
  if(input.macro === "NEUTRAL") macro = 0.4;
  else if(input.macro === "ALIGNED") macro = 0.8;
  else if(input.macro === "MISALIGNED") macro = -0.8;

  let stage = 0;
  if(input.stage === "CANDIDATE") stage = 1.0;
  else if(input.stage === "ALMOST") stage = 0.5;
  else if(input.stage === "BUILDUP") stage = 0.1;
  else stage = -0.2;

  return {
    moveScore,
    rr,
    vm,
    edge,
    flow,
    vol,
    sniper,
    spoof,
    macro,
    stage
  };
}


// ================= WEIGHTS =================
const W = {
  moveScore: 1.5,
  rr: 1.7,
  vm: 1.1,
  edge: 0.8,
  flow: 1.4,
  vol: 0.7,
  sniper: 1.6,
  spoof: 1.2,
  macro: 1.0,
  stage: 0.6
};

const BIAS = -2.2;


// ================= META MODEL =================
export function metaModel(input){

  const x = extractMetaVector(input);

  const z =
    (x.moveScore * W.moveScore) +
    (x.rr * W.rr) +
    (x.vm * W.vm) +
    (x.edge * W.edge) +
    (x.flow * W.flow) +
    (x.vol * W.vol) +
    (x.sniper * W.sniper) +
    (x.spoof * W.spoof) +
    (x.macro * W.macro) +
    (x.stage * W.stage) +
    BIAS;

  const probability = sigmoid(z);

  return {
    probability,
    rawScore: z,
    confidence:
      probability >= 0.80 ? "ELITE" :
      probability >= 0.65 ? "HIGH" :
      probability >= 0.50 ? "MEDIUM" :
      "LOW"
  };
}


// ================= META DECISION =================
export function metaDecision(meta){

  if(meta.probability >= 0.80){
    return {
      label: "EXECUTE",
      quality: "ELITE"
    };
  }

  if(meta.probability >= 0.65){
    return {
      label: "WATCH",
      quality: "HIGH"
    };
  }

  if(meta.probability >= 0.50){
    return {
      label: "MONITOR",
      quality: "MEDIUM"
    };
  }

  return {
    label: "REJECT",
    quality: "LOW"
  };
}