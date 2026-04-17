const TOKEN = prompt("Admin token:");

// ================= LOAD =================
async function load(){

  try{

    const res = await fetch("/api/filter-config",{
      headers:{ "x-admin-token": TOKEN }
    });

    const text = await res.text();
    console.log("RAW:", text);

    let f;

    try{
      f = JSON.parse(text);
    }catch{
      document.getElementById("app").innerHTML =
        "<h2 style='color:red;'>❌ API geeft geen JSON terug</h2>";
      return;
    }

    // ❗ unauthorized
    if(f.error){
      document.getElementById("app").innerHTML =
        "<h2 style='color:red;'>❌ Unauthorized → verkeerde token</h2>";
      return;
    }

    // ❗ structuur check
    if(!f.bull || !f.bear){
      document.getElementById("app").innerHTML =
        "<h2 style='color:red;'>❌ Verkeerde data structuur</h2><pre>" +
        JSON.stringify(f,null,2) +
        "</pre>";
      return;
    }

    render(f);

  }catch(e){

    console.error(e);

    document.getElementById("app").innerHTML =
      "<h2 style='color:red;'>❌ Crash bij laden</h2>";
  }
}


// ================= INPUT =================
function input(id, value){
  return `<input id="${id}" value="${value ?? ""}" style="width:80px"/>`;
}


// ================= BLOCK =================
function block(side, stage, f){

  // 🔥 fallback zodat hij nooit crasht
  f = f || {
    scoreMin: 0,
    volumeMin: 0,
    allowNeutral: false
  };

  return `
    <div style="margin-bottom:20px;">
      <h4>${stage.toUpperCase()}</h4>

      Score: ${input(`${side}_${stage}_score`, f.scoreMin)}
      Volume: ${input(`${side}_${stage}_vol`, f.volumeMin)}
      Flow: ${input(`${side}_${stage}_flow`, f.allowNeutral)}

    </div>
  `;
}


// ================= RENDER =================
function render(f){

  let html = "";

  for(const side of ["bull","bear"]){

    html += `<h2>${side.toUpperCase()}</h2>`;

    for(const stage of ["radar","buildup","almost","entry"]){

      html += block(
        side,
        stage,
        f?.[side]?.[stage] // 🔥 safe access
      );
    }
  }

  // ===== TRADE =====
  const trade = f.trade || {};

  html += `
    <h2>TRADE</h2>

    RR: ${input("trade_rr", trade.rrMin)}
    Score: ${input("trade_score", trade.scoreMin)}
    Trend: ${input("trade_trend", trade.requireTrend)}
    Spoof: ${input("trade_spoof", trade.blockSpoof)}

    <br/><br/>
  `;

  html += `<button onclick="save()">💾 SAVE</button>`;

  document.getElementById("app").innerHTML = html;
}


// ================= SAVE =================
async function save(){

  try{

    const get = id => document.getElementById(id)?.value;

    const body = {
      bull:{},
      bear:{},
      trade:{}
    };

    for(const side of ["bull","bear"]){

      for(const stage of ["radar","buildup","almost","entry"]){

        body[side][stage] = {
          scoreMin: Number(get(`${side}_${stage}_score`) || 0),
          volumeMin: Number(get(`${side}_${stage}_vol`) || 0),
          allowNeutral:
            get(`${side}_${stage}_flow`) === "true" ||
            get(`${side}_${stage}_flow`) === true
        };
      }
    }

    body.trade = {
      rrMin: Number(get("trade_rr") || 0),
      scoreMin: Number(get("trade_score") || 0),
      requireTrend:
        get("trade_trend") === "true" ||
        get("trade_trend") === true,
      blockSpoof:
        get("trade_spoof") === "true" ||
        get("trade_spoof") === true
    };

    const res = await fetch("/api/filter-config",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-admin-token": TOKEN
      },
      body: JSON.stringify(body)
    });

    if(!res.ok){
      alert("❌ Save failed");
      return;
    }

    alert("✅ Saved");

  }catch(e){

    console.error(e);
    alert("❌ Crash bij save");
  }
}


// ================= INIT =================
load();