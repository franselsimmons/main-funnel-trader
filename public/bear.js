const el = id => document.getElementById(id);

let latestCoinsById = new Map();

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmtPrice(value) {
  const n = num(value, null);
  if (n === null) return "N/A";

  if (Math.abs(n) >= 1) return n.toFixed(4);
  if (Math.abs(n) >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

function fmtPct(value) {
  return `${num(value).toFixed(2)}%`;
}

function fmtScore(value) {
  return Math.round(num(value));
}

function fmtVm(value) {
  return num(value).toFixed(4);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function scannerStageLabel(c) {
  const stage = String(c?.scannerStage || c?.stage || "radar").toLowerCase();

  if (c?.scannerStageLabel) return c.scannerStageLabel;
  if (stage === "entry") return "HOT";
  if (stage === "almost") return "ALMOST";
  if (stage === "buildup") return "BUILDUP";
  return "RADAR";
}

function tradeIntent(c) {
  if (c?.tradeIntent) return c.tradeIntent;

  const stage = String(c?.stage || "radar").toLowerCase();

  if (c?.uiOnly) return "WATCH_ONLY";
  if (stage === "entry") return "HOT_CANDIDATE";
  if (stage === "almost") return "CANDIDATE";
  if (stage === "buildup") return "EARLY_WATCH";
  return "WATCH";
}

function sourceLabel(c) {
  if (c?.uiOnly) return "UI fallback";
  if (c?.stageSource === "filter") return "Filter";
  return c?.stageSource || "Scanner";
}

function openModalById(id) {
  const c = latestCoinsById.get(id);
  if (!c) return;

  el("m-title").innerText = c.symbol || "UNKNOWN";
  el("m-price").innerText = "$" + fmtPrice(c.price);
  el("m-score").innerText = fmtScore(c.moveScore);
  el("m-flow").innerText = c.flow || "-";
  el("m-change").innerText = fmtPct(c.change24);
  el("m-stage").innerText = scannerStageLabel(c);
  el("m-intent").innerText = tradeIntent(c);
  el("m-tf").innerText = num(c.tfScore).toFixed(2);
  el("m-vm").innerText = fmtVm(c.vm);

  el("modalOverlay").style.display = "flex";
}

function closeModal() {
  el("modalOverlay").style.display = "none";
}

function coinRow(c, index, bucket) {
  const id = `${bucket}_${index}_${String(c.symbol || "UNKNOWN")}`;
  latestCoinsById.set(id, c);

  const stageLabel = scannerStageLabel(c);
  const intent = tradeIntent(c);
  const source = sourceLabel(c);

  return `
    <div class="coinCard" onclick="openModalById('${escapeHtml(id)}')">
      <div class="c-left">
        <div class="avatar">${escapeHtml(String(c.symbol || "?").substring(0, 2))}</div>
        <div>
          <div class="c-sym">
            ${escapeHtml(c.symbol || "UNKNOWN")}
            <span class="miniTag">${escapeHtml(stageLabel)}</span>
          </div>
          <div class="c-flow">
            Flow: ${escapeHtml(c.flow || "-")} | ${escapeHtml(source)}
          </div>
          <div class="c-flow">
            Intent: ${escapeHtml(intent)}
          </div>
        </div>
      </div>
      <div class="c-right">
        <div class="c-price">$${fmtPrice(c.price)}</div>
        <div class="c-score">Score: ${fmtScore(c.moveScore)}</div>
        <div class="c-score">TF: ${num(c.tfScore).toFixed(2)}</div>
      </div>
    </div>
  `;
}

function emptyText() {
  return "<p style='color:#94a3b8'>Geen scanner-kandidaten</p>";
}

function renderBucket(id, list, bucket) {
  const rows = Array.isArray(list) ? list : [];
  el(id).innerHTML = rows.length ? rows.map((c, i) => coinRow(c, i, bucket)).join("") : emptyText();
}

async function load() {
  try {
    const res = await fetch(`/api/public-latest`);
    const data = await res.json();

    latestCoinsById = new Map();

    const btcState = data?.btc?.state || "UNKNOWN";
    const btc24 = data?.btc?.chg24 !== undefined ? ` ${num(data.btc.chg24).toFixed(2)}%` : "";
    const regime = data?.regime || "UNKNOWN";

    el("statusLine").innerText = `BTC: ${btcState}${btc24} | Regime: ${regime} | Scanner HOT ≠ echte entry`;

    const f = data?.funnel?.bear || { entry: [], almost: [], buildup: [], radar: [] };

    renderBucket("entry", f.entry, "entry");
    renderBucket("almost", f.almost, "almost");
    renderBucket("buildup", f.buildup, "buildup");
    renderBucket("radar", f.radar, "radar");
  } catch (e) {
    console.error("Fetch error", e);
    el("statusLine").innerText = "Scanner data kon niet geladen worden";
  }
}

setInterval(load, 15000);
load();