const el = id => document.getElementById(id);

let MODE = "bull";

function setMode(m){
  MODE = m;
  load();
}

function row(s){

  let color = "white";

  if(s.signal === "ENTRY") color = "green";
  if(s.signal === "HOLD") color = "orange";
  if(s.signal === "EXIT") color = "red";

  return `
    <div style="border:1px solid #333;margin:5px;padding:10px;color:${color}">
      <b>${s.symbol}</b> → ${s.signal}
      <br/>
      ${s.reason}
      <br/>
      strength: ${s.strength}
    </div>
  `;
}

async function load(){

  const res = await fetch(`/api/public-latest?mode=${MODE}`);
  const data = await res.json();

  el("signals").innerHTML =
    data.signals.map(row).join("");
}

load();
setInterval(load, 60_000);