const TOKEN = prompt("Admin token:");

async function load(){

  const res = await fetch("/api/filter-config",{
    headers:{ "x-admin-token": TOKEN }
  });

  const f = await res.json();

  render(f);
}

function render(f){

  document.getElementById("app").innerHTML = `
  
  <h2>BULL</h2>
  Score: <input id="bullScore" value="${f.bull.scoreMin}"/><br/>
  Volume: <input id="bullVol" value="${f.bull.volumeMin}"/><br/>
  Flow: <input id="bullFlow" value="${f.bull.allowNeutral}"/><br/>

  <h2>BEAR</h2>
  Score: <input id="bearScore" value="${f.bear.scoreMin}"/><br/>
  Volume: <input id="bearVol" value="${f.bear.volumeMin}"/><br/>
  Flow: <input id="bearFlow" value="${f.bear.allowNeutral}"/><br/>

  <button onclick="save()">SAVE</button>
  `;
}

async function save(){

  const body = {
    bull:{
      scoreMin: document.getElementById("bullScore").value,
      volumeMin: document.getElementById("bullVol").value,
      allowNeutral: document.getElementById("bullFlow").value
    },
    bear:{
      scoreMin: document.getElementById("bearScore").value,
      volumeMin: document.getElementById("bearVol").value,
      allowNeutral: document.getElementById("bearFlow").value
    }
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