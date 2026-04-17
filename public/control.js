const TOKEN = prompt("Admin token:");

let currentData = null;

// ================= LOAD =================
async function load(){
  try {
    const res = await fetch("/api/filter-config", {
      headers: { "x-admin-token": TOKEN }
    });

    const data = await res.json();

    if(data.error){
      document.getElementById("app").innerHTML = 
        "<div class='control-card' style='text-align:center; color:var(--red); padding:40px 20px;'><h2>❌ Toegang Geweigerd</h2><p>Je token is onjuist of verlopen.</p></div>";
      return;
    }

    currentData = data;
    render(data);
  } catch (err) {
    document.getElementById("app").innerHTML = "<p style='color:red; text-align:center;'>Netwerkfout.</p>";
  }
}

// ================= SLIDER GENERATOR =================
function slider(id, label, value, min, max, step){
  // Check of het een Aan/Uit schakelaar is (bereik 0 tot 1 met stappen van 1)
  const isToggle = (max == 1 && step == 1); 
  
  let valDisplay = value;
  let extraClass = "";
  if (isToggle) {
    valDisplay = value == 1 ? "AAN" : "UIT";
    extraClass = value == 1 ? "on" : "off";
  }

  return `
    <div class="control-row">
      <div class="c-label-group">
        <span>${label}</span>
        <span class="c-val ${extraClass}" id="${id}_val">${valDisplay}</span>
      </div>
      <input 
        type="range"
        min="${min}"
        max="${max}"
        step="${step}"
        value="${value}"
        class="slider ${isToggle ? 'slider-toggle' : ''}"
        oninput="updateValue('${id}', this.value, ${isToggle})"
        id="${id}"
      />
    </div>
  `;
}

// Global update functie zodat de inline oninput hem kan vinden
window.updateValue = function(id, val, isToggle){
  const valElement = document.getElementById(id + "_val");
  
  if (isToggle) {
    const isOn = val == 1;
    valElement.innerText = isOn ? "AAN" : "UIT";
    valElement.className = `c-val ${isOn ? "on" : "off"}`;
  } else {
    valElement.innerText = val;
  }
}

// ================= BLOCK GENERATOR =================
function block(side, stage, f){
  return `
    <div class="control-card">
      <div class="c-header">
        <div class="c-title">${stage.toUpperCase()}</div>
      </div>
      ${slider(`${side}_${stage}_score`, "Minimale AI Score", f.scoreMin, 30, 90, 1)}
      ${slider(`${side}_${stage}_vol`, "Minimale Volume", f.volumeMin, 0.1, 1, 0.05)}
      ${slider(`${side}_${stage}_flow`, "Sta NEUTRAL flow toe", f.allowNeutral ? 1 : 0, 0, 1, 1)}
    </div>
  `;
}

// ================= RENDER =================
function render(f){
  let html = "";

  // ===== BULL =====
  html += `<h2 class="section-title bull-title">🟢 BULL FUNNEL</h2>`;
  // Logische volgorde (Entry bovenaan)
  for(const stage of ["entry","almost","buildup","radar"]){
    html += block("bull", stage, f.bull[stage]);
  }

  // ===== BEAR =====
  html += `<h2 class="section-title bear-title">🔴 BEAR FUNNEL</h2>`;
  for(const stage of ["entry","almost","buildup","radar"]){
    html += block("bear", stage, f.bear[stage]);
  }

  // ===== TRADE =====
  html += `<h2 class="section-title trade-title">⚡ TRADE LOGIC</h2>`;
  html += `
    <div class="control-card">
      <div class="c-header">
        <div class="c-title">PARAMETERS</div>
      </div>
      ${slider("trade_rr", "Minimale Risk/Reward (RR)", f.trade.rrMin, 1, 4, 0.1)}
      ${slider("trade_score", "Minimale Trade Score", f.trade.scoreMin, 40, 90, 1)}
      ${slider("trade_trend", "Require Market Trend", f.trade.requireTrend ? 1 : 0, 0, 1, 1)}
      ${slider("trade_spoof", "Block Spoofing", f.trade.blockSpoof ? 1 : 0, 0, 1, 1)}
    </div>
  `;

  // ===== ACTIE BALK =====
  html += `
    <div class="action-bar">
      <button class="btn-save" onclick="save()">💾 OPSLAAN</button>
      <button class="btn-ai" onclick="applyAI()">🤖 APPLY AI</button>
    </div>
  `;

  document.getElementById("app").innerHTML = html;
}

// ================= SAVE =================
window.save = async function(){
  const get = id => document.getElementById(id).value;

  const body = {
    bull: {},
    bear: {},
    trade: {}
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

  try {
    await fetch("/api/filter-config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": TOKEN
      },
      body: JSON.stringify(body)
    });
    alert("✅ Instellingen succesvol opgeslagen!");
  } catch (err) {
    alert("❌ Fout bij het opslaan van de instellingen.");
  }
}

// ================= AI APPLY =================
window.applyAI = async function(){
  try {
    const res = await fetch("/api/public-latest");
    const data = await res.json();

    if(!data.advice){
      alert("❌ Geen AI advies beschikbaar op dit moment.");
      return;
    }

    alert("🤖 AI advies verwerkt (Handmatige bevestiging nodig voor live updates).");
  } catch (err) {
    alert("❌ Kan niet verbinden met de AI service.");
  }
}

// ================= INIT =================
load();
