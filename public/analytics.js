const el = id => document.getElementById(id);

function block(title,data){

  return `
    <div class="coin">
      <h3>${title}</h3>
      Total: ${data.total}<br/>
      LowScore: ${data.reasons.lowScore}<br/>
      WeakFlow: ${data.reasons.weakFlow}<br/>
      LowVolume: ${data.reasons.lowVolume}<br/>
      BadOB: ${data.reasons.badOB}<br/>
      Good: ${data.reasons.good}<br/>
      <br/>
      <b>Advice:</b><br/>
      ${data.advice.join("<br/>")}
    </div>
  `;
}

async function load(){

  const res = await fetch("/api/public-latest");
  const data = await res.json();

  const a = data.analytics;

  let html = "";

  for(const side of ["bull","bear"]){

    html += `<h2>${side.toUpperCase()}</h2>`;

    for(const stage of ["entry","almost","buildup","radar"]){

      html += block(`${stage.toUpperCase()}`, a[side][stage]);
    }
  }

  el("analytics").innerHTML = html;
}

setInterval(load,15000);
load();