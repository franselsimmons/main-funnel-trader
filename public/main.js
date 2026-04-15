const el = id => document.getElementById(id);

let MODE = "bull";

function setMode(m){
  MODE = m;
  load();
}

el("modeBull").onclick = ()=>setMode("bull");
el("modeBear").onclick = ()=>setMode("bear");

async function load(){

  el("statusLine").innerText = "Laden...";

  const res = await fetch(`/api/public-latest?mode=${MODE}`);
  const data = await res.json();

  render(data);
}

function coinRow(c){
  return `
    <div class="coin">
      <b>${c.symbol}</b> - $${c.price}
      <br/>
      ${c.change24.toFixed(2)}%
      <br/>
      ${c.strategy}
    </div>
  `;
}

function render(data){

  el("statusLine").innerText =
    `Strategy: ${data.strategy} | Vol: ${data.volatility}`;

  const entry = data.coins.filter(c=>c.stage==="ENTRY");
  const skip = data.coins.filter(c=>c.stage!=="ENTRY");

  el("stageTradeReady").innerHTML =
    entry.map(coinRow).join("");

  el("stageSkip").innerHTML =
    skip.map(coinRow).join("");
}

load();
setInterval(load, 5000);