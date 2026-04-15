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
      Score: ${c.moveScore}
    </div>
  `;
}

function render(data){

  const f = data.funnel;

  el("statusLine").innerText =
    `BTC: ${data.btc.state} • ENTRY ${f.entry.length} • ALMOST ${f.almost.length} • BUILDUP ${f.buildup.length} • RADAR ${f.radar.length}`;

  el("stageTradeReady").innerHTML =
    f.entry.length
      ? f.entry.map(coinRow).join("")
      : "Geen ENTRY coins";

  el("stageSkip").innerHTML =
    [...f.almost, ...f.buildup, ...f.radar]
      .map(coinRow)
      .join("");
}

// 🔥 15 min scan (swing optimal)
load();
setInterval(load, 15 * 60 * 1000);