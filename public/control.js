const TOKEN = prompt("Admin token:");

async function load(){

  const res = await fetch("/api/filter-config",{
    headers:{ "x-admin-token": TOKEN }
  });

  const f = await res.json();

  render(f);
}

function input(id, value){
  return `<input id="${id}" value="${value}" style="width:80px"/>`;
}

function block(side, stage, f){
  return `
    <h4>${stage.toUpperCase()}</h4>
    Score: ${input(`${side}_${stage}_score`, f.scoreMin)}
    Volume: ${input(`${side}_${stage}_vol`, f.volumeMin)}
    Flow: ${input(`${side}_${stage}_flow`, f.allowNeutral)}
    <br/><br/>
  `;
}

function render(f){

  let html = "";

  for(const side of ["bull","bear"]){

    html += `<h2>${side.toUpperCase()}</h2>`;

    for(const stage of ["radar","buildup","almost","entry"]){
      html += block(side, stage, f[side][stage]);
    }
  }

  html += `
    <h2>TRADE</h2>
    RR: ${input("trade_rr", f.trade.rrMin)}
    Score: ${input("trade_score", f.trade.scoreMin)}
    Trend: ${input("trade_trend", f.trade.requireTrend)}
    Spoof: ${input("trade_spoof", f.trade.blockSpoof)}
    <br/><br/>
  `;

  html += `<button onclick="save()">SAVE</button>`;

  document.getElementById("app").innerHTML = html;
}

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
        scoreMin: get(`${side}_${stage}_score`),
        volumeMin: get(`${side}_${stage}_vol`),
        allowNeutral: get(`${side}_${stage}_flow`)
      };
    }
  }

  body.trade = {
    rrMin: get("trade_rr"),
    scoreMin: get("trade_score"),
    requireTrend: get("trade_trend"),
    blockSpoof: get("trade_spoof")
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

load();