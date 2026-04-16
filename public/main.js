const el = (id) => document.getElementById(id);

let MODE = "bull";

function setMode(mode) {
  MODE = mode === "bear" ? "bear" : "bull";
  load();
}

if (el("modeBull")) el("modeBull").onclick = () => setMode("bull");
if (el("modeBear")) el("modeBear").onclick = () => setMode("bear");

function coinRow(c) {
  return `
    <div class="coin ${String(c.stage || "").toLowerCase()}">
      <b>${c.symbol}</b> - $${Number(c.price || 0).toFixed(4)}<br/>
      24h: ${Number(c.change24 || 0).toFixed(2)}%<br/>
      Score: ${c.moveScore ?? "-"}<br/>
      Flow: ${c.flow || "-"}
    </div>
  `;
}

function tradeRow(t) {
  return `
    <div class="coin trade-${String(t.action || "watch").toLowerCase()}">
      <b>${t.symbol}</b> (${t.side || "-"}) → ${t.action || "-"}<br/>
      Reason: ${t.reason || "-"}<br/>
      Flow: ${t.flow || "-"}<br/>
      Score: ${t.score ?? "-"}
    </div>
  `;
}

function renderList(id, arr) {
  const node = el(id);
  if (!node) return;

  if (!Array.isArray(arr) || arr.length === 0) {
    node.innerHTML = `<div class="coin">Geen coins</div>`;
    return;
  }

  node.innerHTML = arr.map(coinRow).join("");
}

function renderTrades(id, arr) {
  const node = el(id);
  if (!node) return;

  if (!Array.isArray(arr) || arr.length === 0) {
    node.innerHTML = `<div class="coin">Geen trades</div>`;
    return;
  }

  node.innerHTML = arr.map(tradeRow).join("");
}

async function load() {
  try {
    if (el("statusLine")) {
      el("statusLine").innerText = "Laden...";
    }

    const res = await fetch(`/api/public-latest?mode=${MODE}`);
    const data = await res.json();

    console.log("DATA:", data);

    if (!res.ok || !data?.funnel) {
      throw new Error(data?.error || "Geen geldige data ontvangen");
    }

    if (el("statusLine")) {
      el("statusLine").innerText =
        `BTC: ${data.btc?.state || "?"} | Regime: ${data.regime || "?"} | Coins: ${data.total ?? 0} | Candidates: ${data.candidates ?? 0}`;
    }

    renderList("bull_entry", data.funnel.bull?.entry);
    renderList("bull_almost", data.funnel.bull?.almost);
    renderList("bull_buildup", data.funnel.bull?.buildup);
    renderList("bull_radar", data.funnel.bull?.radar);

    renderList("bear_entry", data.funnel.bear?.entry);
    renderList("bear_almost", data.funnel.bear?.almost);
    renderList("bear_buildup", data.funnel.bear?.buildup);
    renderList("bear_radar", data.funnel.bear?.radar);

    renderTrades("trades", data.trades);
  } catch (err) {
    console.error("LOAD ERROR:", err);

    if (el("statusLine")) {
      el("statusLine").innerText = `Error laden: ${err.message}`;
    }
  }
}

load();
setInterval(load, 15000);