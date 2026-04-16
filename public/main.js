const el = id => document.getElementById(id);

let MODE = "bull";

function setMode(m){
  MODE = m;
  load();
}

// 🔥 safe binding (voorkomt crash als element ontbreekt)
if(el("modeBull")) el("modeBull").onclick = ()=>setMode("bull");
if(el("modeBear")) el("modeBear").onclick = ()=>setMode("bear");


// ================= UI RENDER =================

function coinRow(c){
  return `
    <div class="coin ${c.stage?.toLowerCase() || ""}">
      <b>${c.symbol}</b> - $${Number(c.price || 0).toFixed(4)}<br/>
      24h: ${Number(c.change24 || 0).toFixed(2)}%<br/>
      Score: ${c.moveScore ?? "-"}<br/>
      Flow: ${c.flow || "-"}
    </div>
  `;
}

function tradeRow(t){
  return `
    <div class="coin trade-${t.action?.toLowerCase() || "watch"}">
      <b>${t.symbol}</b> (${t.side || "-"}) → ${t.action}<br/>
      Reason: ${t.reason}<br/>
      Flow: ${t.flow}<br/>
      Score: ${t.score}
    </div>
  `;
}


// ================= HELPERS =================

function renderList(id, arr){

  if(!el(id)) return;

  if(!arr || arr.length === 0){
    el(id).innerHTML = `<div class="coin">Geen coins</div>`;
    return;
  }

  el(id).innerHTML = arr.map(coinRow).join("");
}

function renderTrades(id, arr){

  if(!el(id)) return;

  if(!arr || arr.length === 0){
    el(id).innerHTML = `<div class="coin">Geen trades</div>`;
    return;
  }

  el(id).innerHTML = arr.map(tradeRow).join("");
}


// ================= LOAD =================

async function load(){

  try{

    if(el("statusLine")){
      el("statusLine").innerText = "Laden...";
    }

    const res = await fetch(`/api/public-latest?mode=${MODE}`);

    if(!res.ok){
      throw new Error("API error");
    }

    const data = await res.json();

    console.log("DATA:", data);

    // 🔥 safety check
    if(!data || !data.funnel){
      if(el("statusLine")){
        el("statusLine").innerText = "Geen data ontvangen";
      }
      return;
    }

    if(el("statusLine")){
      el("statusLine").innerText =
        `BTC: ${data.btc?.state || "?"} | Regime: ${data.regime} | Coins: ${data.total}`;
    }

    // ===== BULL =====
    renderList("bull_entry", data.funnel.bull?.entry);
    renderList("bull_almost", data.funnel.bull?.almost);
    renderList("bull_buildup", data.funnel.bull?.buildup);
    renderList("bull_radar", data.funnel.bull?.radar);

    // ===== BEAR =====
    renderList("bear_entry", data.funnel.bear?.entry);
    renderList("bear_almost", data.funnel.bear?.almost);
    renderList("bear_buildup", data.funnel.bear?.buildup);
    renderList("bear_radar", data.funnel.bear?.radar);

    // ===== TRADE =====
    renderTrades("trades", data.trades);

  }catch(err){

    console.error("LOAD ERROR:", err);

    if(el("statusLine")){
      el("statusLine").innerText = "Error laden";
    }
  }
}


// ================= REFRESH =================

// 🔥 stabiel voor swing trading
setInterval(load, 15000);

// eerste load
load();