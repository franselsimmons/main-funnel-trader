const el = id => document.getElementById(id);

let MODE = "bull";

function setMode(m){
  MODE = m;
  load();
}

el("modeBull").onclick = ()=>setMode("bull");
el("modeBear").onclick = ()=>setMode("bear");


// ================= UI RENDER =================

function coinRow(c){
  return `
    <div class="coin ${c.stage.toLowerCase()}">
      <b>${c.symbol}</b> - $${c.price.toFixed(4)}<br/>
      24h: ${c.change24.toFixed(2)}%<br/>
      Score: ${c.moveScore}<br/>
      Flow: ${c.flow}
    </div>
  `;
}

function tradeRow(t){
  return `
    <div class="coin trade-${t.action.toLowerCase()}">
      <b>${t.symbol}</b> → ${t.action}<br/>
      Reason: ${t.reason}<br/>
      Flow: ${t.flow}<br/>
      Score: ${t.score}
    </div>
  `;
}


// ================= LOAD =================

async function load(){

  el("statusLine").innerText = "Laden...";

  const res = await fetch(`/api/public-latest?mode=${MODE}`);
  const data = await res.json();

  el("statusLine").innerText =
    `BTC: ${data.btc.state} | Regime: ${data.regime} | Coins: ${data.total}`;

  // ===== BULL =====
  el("bull_entry").innerHTML = data.funnel.bull.entry.map(coinRow).join("");
  el("bull_almost").innerHTML = data.funnel.bull.almost.map(coinRow).join("");
  el("bull_buildup").innerHTML = data.funnel.bull.buildup.map(coinRow).join("");
  el("bull_radar").innerHTML = data.funnel.bull.radar.map(coinRow).join("");

  // ===== BEAR =====
  el("bear_entry").innerHTML = data.funnel.bear.entry.map(coinRow).join("");
  el("bear_almost").innerHTML = data.funnel.bear.almost.map(coinRow).join("");
  el("bear_buildup").innerHTML = data.funnel.bear.buildup.map(coinRow).join("");
  el("bear_radar").innerHTML = data.funnel.bear.radar.map(coinRow).join("");

  // ===== TRADE =====
  el("trades").innerHTML =
    (data.trades || []).map(tradeRow).join("");
}


// 🔥 refresh (stabiel voor swing)
setInterval(load, 15000);
load();