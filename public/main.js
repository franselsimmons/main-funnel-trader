const el = (id) => document.getElementById(id);

let MODE = "bull";

function setMode(mode) {
  MODE = mode === "bear" ? "bear" : "bull";
  load();
}

const bullBtn = el("modeBull");
const bearBtn = el("modeBear");

if (bullBtn) bullBtn.onclick = () => setMode("bull");
if (bearBtn) bearBtn.onclick = () => setMode("bear");

function coinRow(c) {
  const price = Number(c?.price || 0);
  const change24 = Number(c?.change24 || 0);
  const score = Number(c?.moveScore || 0);
  const stage = String(c?.stage || "—");

  return `
    <div class="coin">
      <div><b>${c?.symbol || "—"}</b> - $${price.toFixed(6)}</div>
      <div>24h: ${change24.toFixed(2)}%</div>
      <div>Score: ${score}</div>
      <div>Stage: ${stage}</div>
    </div>
  `;
}

function ageLabel(ts) {
  const x = Number(ts || 0);
  if (!x) return "tijd onbekend";

  const diffMin = Math.floor((Date.now() - x) / 60000);

  if (diffMin < 1) return "live";
  if (diffMin < 60) return `${diffMin}m oud`;

  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return `${h}u ${m}m oud`;
}

function render(data) {
  const funnel = data?.funnel || {};

  const entry = Array.isArray(funnel.entry) ? funnel.entry : [];
  const almost = Array.isArray(funnel.almost) ? funnel.almost : [];
  const buildup = Array.isArray(funnel.buildup) ? funnel.buildup : [];
  const radar = Array.isArray(funnel.radar) ? funnel.radar : [];

  const status = el("statusLine");
  if (status) {
    status.innerText =
      `BTC: ${data?.btc?.state || "—"} • ` +
      `ENTRY ${entry.length} • ` +
      `ALMOST ${almost.length} • ` +
      `BUILDUP ${buildup.length} • ` +
      `RADAR ${radar.length} • ` +
      `${ageLabel(data?.scannedAt)}`;
  }

  const tradeReady = el("stageTradeReady");
  if (tradeReady) {
    tradeReady.innerHTML = entry.length
      ? entry.map(coinRow).join("")
      : "Geen ENTRY coins";
  }

  const almostBox = el("stageAlmost");
  if (almostBox) {
    almostBox.innerHTML = almost.length
      ? almost.map(coinRow).join("")
      : "Geen ALMOST";
  }

  const buildupBox = el("stageBuildup");
  if (buildupBox) {
    buildupBox.innerHTML = buildup.length
      ? buildup.map(coinRow).join("")
      : "Geen BUILDUP";
  }

  const radarBox = el("stageRadar");
  if (radarBox) {
    radarBox.innerHTML = radar.length
      ? radar.map(coinRow).join("")
      : "Geen RADAR";
  }
}

async function load() {
  const status = el("statusLine");
  if (status) status.innerText = "Laden...";

  try {
    const res = await fetch(`/api/public-latest?mode=${MODE}`, {
      cache: "no-store",
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || "request_failed");
    }

    render(data);
  } catch (err) {
    if (status) {
      status.innerText = `Fout: ${String(err?.message || err)}`;
    }
  }
}

load();

/*
  Swing trading:
  - backend scan via cron: elke 15 min
  - frontend refresh: elke 60 sec is prima
*/
setInterval(load, 60000);