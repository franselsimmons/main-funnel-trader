const el = id => document.getElementById(id);

function tradeRow(t){
  const act = t.action.toLowerCase();
  
  return `
    <div class="tradeRow trade-${act}">
      <div class="t-head">
        <div>
          <span class="t-sym">${t.symbol}</span> 
          <span style="color:var(--muted); font-size:12px">(${t.side})</span>
        </div>
        <div class="t-action text-${act}">${t.action}</div>
      </div>
      
      <div class="t-details">
        <span class="chip">IN: ${t.entry?.toFixed(4) || "—"}</span>
        <span class="chip">SL: ${t.sl?.toFixed(4) || "—"}</span>
        <span class="chip">TP: ${t.tp?.toFixed(4) || "—"}</span>
      </div>
      
      <div style="font-size: 12px; color: var(--muted);">
        RR: <strong style="color:var(--text)">${t.rr}</strong> | 
        Flow: <strong style="color:var(--text)">${t.flow}</strong>
      </div>
    </div>
  `;
}

async function load(){
  try {
    const res = await fetch(`/api/public-latest`);
    const data = await res.json();

    el("statusLine").innerText = `Actieve Trades: ${data.trades.length}`;

    el("trades").innerHTML = data.trades.length 
      ? data.trades.map(tradeRow).join("") 
      : "<p style='color:#94a3b8'>Geen trades open.</p>";
  } catch (e) {
    console.error(e);
  }
}

setInterval(load, 10000);
load();
