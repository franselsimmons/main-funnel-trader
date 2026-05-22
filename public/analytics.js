// ================= public/analyse.js =================

let state = {
  data: null,
  families: []
};

const els = {
  summaryCards: document.getElementById("summaryCards"),
  familyRows: document.getElementById("familyRows"),
  trackedFilters: document.getElementById("trackedFilters"),
  refreshBtn: document.getElementById("refreshBtn"),
  sideFilter: document.getElementById("sideFilter"),
  statusFilter: document.getElementById("statusFilter"),
  minClosed: document.getElementById("minClosed"),
  searchBox: document.getElementById("searchBox"),
  hideEmpty: document.getElementById("hideEmpty"),
  detailsDialog: document.getElementById("detailsDialog"),
  detailsTitle: document.getElementById("detailsTitle"),
  detailsPre: document.getElementById("detailsPre"),
  closeDialog: document.getElementById("closeDialog")
};

function fmt(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

function clsNumber(value) {
  const n = Number(value);
  if (n > 0) return "good";
  if (n < 0) return "bad";
  return "";
}

function definitionText(f) {
  const d = f.definition || {};

  return [
    f.scenarioKey,
    f.qualityKey,
    `SETUP=${(d.setupClasses || []).join("/")}`,
    `STAGE=${(d.stages || []).join("/")}`,
    `FLOW=${(d.flows || []).join("/")}`,
    `RSI=${(d.rsiZones || []).join("/")}`,
    `RR=${rangeText(d.rrRange)}`,
    `CONF=${rangeText(d.confluenceRange)}`,
    `SNIPER=${rangeText(d.sniperRange)}`,
    `OB=${(d.obRelations || []).join("/")}`,
    `SPREAD_BPS=${rangeText(d.spreadBpsRange)}`,
    `DEPTH=${rangeText(d.depthUsdRange)}`,
    `BTC=${(d.btcRelations || []).join("/")}`,
    `TF=${(d.tfStrengthBuckets || []).join("/")}`,
    `FUNDING=${(d.fundingBuckets || []).join("/")}`
  ].join(" | ");
}

function rangeText(range) {
  if (!Array.isArray(range)) return "ANY";
  return `${range[0]}-${range[1]}`;
}

function renderCards(summary = {}, store = {}) {
  const cards = [
    ["Rows", summary.rawRows],
    ["Observed", summary.observed],
    ["Open", summary.open],
    ["Closed", summary.closed],
    ["Winrate", summary.winrate],
    ["Total R", fmt(summary.totalR)],
    ["Total PnL%", fmt(summary.totalPnlPct)],
    ["Storage", store.storageMode || "unknown"]
  ];

  els.summaryCards.innerHTML = cards
    .map(([label, value]) => `
      <div class="card">
        <div class="label">${label}</div>
        <div class="value">${value ?? 0}</div>
      </div>
    `)
    .join("");
}

function statusPass(f, filter) {
  if (filter === "ALL") return true;
  if (filter === "EDGE") return ["STRONG_EDGE", "USABLE_EDGE"].includes(f.status);
  if (filter === "BAD") return f.status === "BAD_EDGE";
  if (filter === "COLLECTING") return f.status === "COLLECTING";
  return true;
}

function applyFilters(families) {
  const side = els.sideFilter.value;
  const status = els.statusFilter.value;
  const minClosed = Number(els.minClosed.value || 0);
  const search = els.searchBox.value.trim().toUpperCase();
  const hideEmpty = els.hideEmpty.checked;

  return families.filter(f => {
    if (side !== "ALL" && f.side !== side) return false;
    if (!statusPass(f, status)) return false;
    if (Number(f.closed || 0) < minClosed) return false;
    if (hideEmpty && Number(f.observed || 0) === 0) return false;

    if (search) {
      const haystack = [
        f.familyId,
        f.name,
        f.label,
        f.scenarioKey,
        f.qualityKey,
        definitionText(f),
        f.status,
        f.confidence
      ].join(" ").toUpperCase();

      if (!haystack.includes(search)) return false;
    }

    return true;
  });
}

function renderFamilies() {
  const families = applyFilters(state.families);

  els.familyRows.innerHTML = families
    .map(f => {
      const avgRClass = clsNumber(f.avgR);
      const totalRClass = clsNumber(f.totalR);
      const pnlClass = clsNumber(f.totalPnlPct);

      return `
        <tr data-family="${f.familyId}">
          <td>
            <div class="family-id">${f.familyId}</div>
            <div class="badge">${f.side}</div>
          </td>
          <td class="definition">${definitionText(f)}</td>
          <td>${f.observed}</td>
          <td>${f.closed}</td>
          <td>${f.open}</td>
          <td class="good">${f.wins}</td>
          <td class="bad">${f.losses}</td>
          <td>${f.winrate}</td>
          <td class="${avgRClass}">${fmt(f.avgR)}</td>
          <td class="${totalRClass}">${fmt(f.totalR)}</td>
          <td class="${pnlClass}">${fmt(f.avgPnlPct)}</td>
          <td class="${pnlClass}">${fmt(f.totalPnlPct)}</td>
          <td>${f.directSLPct}</td>
          <td>${f.nearTpPct}</td>
          <td><span class="badge">${f.confidence}</span></td>
          <td><span class="badge">${f.status}</span></td>
        </tr>
      `;
    })
    .join("");

  for (const tr of els.familyRows.querySelectorAll("tr[data-family]")) {
    tr.addEventListener("click", () => {
      const id = tr.getAttribute("data-family");
      const family = state.families.find(f => f.familyId === id);
      showDetails(family);
    });
  }
}

function renderTrackedFilters(filters = []) {
  els.trackedFilters.innerHTML = filters
    .map(name => `<span>${name}</span>`)
    .join("");
}

function showDetails(family) {
  if (!family) return;

  els.detailsTitle.textContent = `${family.familyId} — ${family.name}`;
  els.detailsPre.textContent = JSON.stringify(family, null, 2);
  els.detailsDialog.showModal();
}

async function loadData() {
  els.refreshBtn.textContent = "Loading...";

  try {
    const res = await fetch(`/api/analyse?t=${Date.now()}`, {
      cache: "no-store"
    });

    const json = await res.json();

    if (!json.ok) {
      throw new Error(json.error || "API_ERROR");
    }

    state.data = json;
    state.families = Array.isArray(json.families) ? json.families : [];

    renderCards(json.summary, json.store);
    renderTrackedFilters(json.trackedFilters || []);
    renderFamilies();
  } catch (e) {
    els.familyRows.innerHTML = `
      <tr>
        <td colspan="16" class="bad">Analyse laden mislukt: ${e.message}</td>
      </tr>
    `;
  } finally {
    els.refreshBtn.textContent = "Refresh";
  }
}

els.refreshBtn.addEventListener("click", loadData);
els.sideFilter.addEventListener("change", renderFamilies);
els.statusFilter.addEventListener("change", renderFamilies);
els.minClosed.addEventListener("input", renderFamilies);
els.searchBox.addEventListener("input", renderFamilies);
els.hideEmpty.addEventListener("change", renderFamilies);

els.closeDialog.addEventListener("click", () => {
  els.detailsDialog.close();
});

loadData();