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
      <b>${c.symbol}</b> - $${c.price}<br/>
      ${c.change24.toFixed(2)}%<br/>
      Score: ${c.moveScore}
    </div>
  `;
}

function renderTrades(trades){
  if(!trades.length) return "Geen trades";

  return trades.map(t => `
    <div class="coin">
      <b>${t.symbol}</b><br/>
      Entry: $${t.entry}<br/>
      SL: $${t.sl}<br/>
      TP: $${t.tp}<br/>
      Status: ${t.status}
    </div>
  `).join("");
}

function render(data){

  const f = data.funnel;

  el("statusLine").innerText =
    `BTC: ${data.btc.state} • ENTRY ${f.entry.length} • ALMOST ${f.almost.length} • BUILDUP ${f.buildup.length} • RADAR ${f.radar.length}`;

  el("stageTradeReady").innerHTML =
    f.entry.map(coinRow).join("") || "Geen ENTRY";

  el("stageAlmost").innerHTML =
    f.almost.map(coinRow).join("") || "Geen ALMOST";

  el("stageBuildup").innerHTML =
    f.buildup.map(coinRow).join("") || "Geen BUILDUP";

  el("stageRadar").innerHTML =
    f.radar.map(coinRow).join("") || "Geen RADAR";

  el("stageTrades").innerHTML =
    renderTrades(data.trades || []);
}

load();

// 🔥 15 min refresh (perfect voor swing)
setInterval(load, 15 * 60 * 1000);