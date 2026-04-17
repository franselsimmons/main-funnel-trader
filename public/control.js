const TOKEN = prompt("Admin token:");

let currentData = null;

// ================= LOAD =================
async function load(){

  const res = await fetch("/api/filter-config",{
    headers:{ "x-admin-token": TOKEN }
  });

  const data = await res.json();

  if(data.error){
    document.getElementById("app").innerHTML =
      "<h2 style='color:red;'>❌ Unauthorized</h2>";
    return;
  }

  currentData = data;

  render(data);
}


// ================= SLIDER =================
function slider(id, value, min, max, step){

  return `
    <input 
      type="range"
      min="${min}"
      max="${max}"
      step="${step}"
      value="${value}"
      class="slider"
      oninput="updateValue('${id}', this.value)"
      id="${id}"
    />
    <span class="value" id="${id}_val">${value}</span>
  `;
}

function updateValue(id, val){
  document.getElementById(id+"_val").innerText = val;
}


// ================= STATUS =================
function status(current, recommended){

  if(recommended === undefined){
    return `<div class="status good">✅ OK</div>`;
  }

  if(current > recommended){
    return `<div class="status warn">⚠️ TE STRENG</div>`;
  }

  if(current < recommended){
    return `<div class="status warn">⚠️ TE LOS</div>`;
  }

  return `<div class="status good">✅ PERFECT</div>`;
}


// ================= BLOCK =================
function block(side, stage, f){

  return `
    <div class="stage">

      <h3>${stage.toUpperCase()}</h3>

      <div class="label">Score</div>
      ${slider(`${side}_${stage}_score`, f.scoreMin, 30, 90, 1)}

      <div class="label">Volume</div>
      ${slider(`${side}_${stage}_vol`, f.volumeMin, 0.1, 1, 0.05)}

      <div class="label">Allow Neutral</div>
      ${slider(`${side}_${stage}_flow`, f.allowNeutral ? 1 : 0, 0, 1, 1)}

    </div>
  `;
}


// ================= RENDER =================
function render(f){

  let html = "";

  for(const side of ["bull","bear"]){

    html += `<div class="section"><h2>${side.toUpperCase()}</h2>`;

    for(const stage of ["radar","buildup","almost","entry"]){

      html += block(side, stage, f[side][stage]);
    }

    html += `</div>`;
  }

  // ===== TRADE =====
  html += `
    <div class="section">
      <h2>TRADE</h2>

      <div class="label">RR</div>
      ${slider("trade_rr", f.trade.rrMin, 1, 4, 0.1)}

      <div class="label">Score</div>
      ${slider("trade_score", f.trade.scoreMin, 40, 90, 1)}

      <div class="label">Trend Required</div>
      ${slider("trade_trend", f.trade.requireTrend ? 1 : 0, 0, 1, 1)}

      <div class="label">Block Spoof</div>
      ${slider("trade_spoof", f.trade.blockSpoof ? 1 : 0, 0, 1, 1)}

    </div>
  `;

  html += `
    <button onclick="save()">💾 SAVE</button>
    <button onclick="applyAI()">🤖 APPLY AI</button>
  `;

  document.getElementById("app").innerHTML = html;
}


// ================= SAVE =================
async function save(){

  const get = id => document.getElementById(id).value;

  const body = {
    bull:{},
    bear:{},
    trade:{}
  };

  for(const side of ["bull","bear"]){
    for(const stage of ["radar","buildup","almost","entry"]){

      body[side][stage] = {
        scoreMin: Number(get(`${side}_${stage}_score`)),
        volumeMin: Number(get(`${side}_${stage}_vol`)),
        allowNeutral: get(`${side}_${stage}_flow`) == 1
      };
    }
  }

  body.trade = {
    rrMin: Number(get("trade_rr")),
    scoreMin: Number(get("trade_score")),
    requireTrend: get("trade_trend") == 1,
    blockSpoof: get("trade_spoof") == 1
  };

  await fetch("/api/filter-config",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-admin-token": TOKEN
    },
    body: JSON.stringify(body)
  });

  alert("Saved");
}


// ================= AI APPLY =================
async function applyAI(){

  const res = await fetch("/api/public-latest");
  const data = await res.json();

  if(!data.advice){
    alert("No advice available");
    return;
  }

  alert("AI advice applied manually (auto version next step)");
}


// ================= INIT =================
load();