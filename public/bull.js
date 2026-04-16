const el = id => document.getElementById(id);

function openModal(symbol, price, score, flow, change) {
  el('m-title').innerText = symbol;
  el('m-price').innerText = '$' + Number(price).toFixed(4);
  el('m-score').innerText = score;
  el('m-flow').innerText = flow;
  el('m-change').innerText = Number(change).toFixed(2) + '%';
  el('modalOverlay').style.display = 'flex';
}

function closeModal() {
  el('modalOverlay').style.display = 'none';
}

function coinRow(c){
  return `
    <div class="coinCard" onclick="openModal('${c.symbol}', ${c.price}, ${c.moveScore}, '${c.flow}', ${c.change24})">
      <div class="c-left">
        <div class="avatar">${c.symbol.substring(0,2)}</div>
        <div>
          <div class="c-sym">${c.symbol}</div>
          <div class="c-flow">Flow: ${c.flow}</div>
        </div>
      </div>
      <div class="c-right">
        <div class="c-price">$${c.price.toFixed(4)}</div>
        <div class="c-score">Score: ${c.moveScore}</div>
      </div>
    </div>
  `;
}

async function load() {
  try {
    const res = await fetch(`/api/public-latest`);
    const data = await res.json();

    el("statusLine").innerText = `BTC: ${data.btc.state} | Regime: ${data.regime}`;

    const f = data.funnel.bull;
    el("entry").innerHTML = f.entry.length ? f.entry.map(coinRow).join("") : "<p style='color:#94a3b8'>Geen signalen</p>";
    el("almost").innerHTML = f.almost.length ? f.almost.map(coinRow).join("") : "<p style='color:#94a3b8'>Geen signalen</p>";
    el("buildup").innerHTML = f.buildup.length ? f.buildup.map(coinRow).join("") : "<p style='color:#94a3b8'>Geen signalen</p>";
    el("radar").innerHTML = f.radar.length ? f.radar.map(coinRow).join("") : "<p style='color:#94a3b8'>Geen signalen</p>";
  } catch (e) {
    console.error("Fetch error", e);
  }
}

setInterval(load, 15000);
load();
