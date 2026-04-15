const el = id => document.getElementById(id);

let MODE = "bull";

async function load(){

  const data = await fetch(`/api/public-latest?mode=${MODE}`).then(r=>r.json());
  const a = await fetch(`/api/analysis`).then(r=>r.json());
  const p = await fetch(`/api/performance`).then(r=>r.json());

  el("statusLine").textContent =
    `BTC: ${data.btc.state} | VOL: ${data.volatility}`;

  el("analysisBox").innerHTML =
    `Strategy: ${a.strategy}<br>
     Regime: ${a.regime}<br>
     Confidence: ${a.confidence}`;

  el("perfBox").innerHTML =
    `Trades: ${p.total}<br>
     Winrate: ${p.winrate}%`;

  render("stageTradeReady", data.funnel.entry);
}

function render(id,list){
  el(id).innerHTML = list.map(c =>
    `<div class="coin">${c.symbol} $${c.price}</div>`
  ).join("");
}

setInterval(load, 5000);
load();