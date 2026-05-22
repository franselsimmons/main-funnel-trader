// ================= public/analytics.js =================

let state = {
  report: null,
  auto: false,
  timer: null
};

const $ = id => document.getElementById(id);

function safe(value, fallback = 0) {
  return value === undefined || value === null || value === "" ? fallback : value;
}

function text(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function showError(message) {
  const box = $("errorBox");
  if (!box) return;

  if (!message) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }

  box.classList.remove("hidden");
  box.textContent = message;
}

function getReportFromPayload(payload) {
  if (payload?.report?.summary) return payload.report;
  if (payload?.summary && payload?.families) return payload;

  return {
    summary: payload?.summary || {},
    families: payload?.families || {
      long: [],
      short: [],
      all: []
    },
    trackedFilters: payload?.trackedFilters || [],
    samples: payload?.samples || {
      latestRows: [],
      open: [],
      closed: []
    }
  };
}

async function loadReport() {
  showError("");

  const minClosed = Number($("minClosedInput")?.value || 0);
  const url = `/api/analyse?includeLocal=true&minClosed=${encodeURIComponent(minClosed)}&t=${Date.now()}`;

  const res = await fetch(url, {
    cache: "no-store"
  });

  const payload = await res.json();

  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }

  state.report = getReportFromPayload(payload);

  render();
}

async function resetReport() {
  const ok = confirm("Reset analyse store? Dit verwijdert Redis analyse-events. data/trades.json blijft staan.");
  if (!ok) return;

  showError("");

  const res = await fetch("/api/analyse", {
    method: "DELETE"
  });

  const payload = await res.json();

  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }

  await loadReport();
}

function formatNumber(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";

  if (Math.abs(n) >= 1000) {
    return n.toLocaleString("en-US", {
      maximumFractionDigits: decimals
    });
  }

  return String(Number(n.toFixed(decimals)));
}

function renderSummary(summary = {}) {
  text("statActions", safe(summary.actions, 0));
  text("statTrades", safe(summary.trades, 0));
  text("statObserved", safe(summary.observed, 0));
  text("statOpen", safe(summary.open, 0));
  text("statRealClosed", safe(summary.realClosed, 0));
  text("statShadowClosed", safe(summary.shadowClosed, 0));
  text("statWins", safe(summary.wins, 0));
  text("statLosses", safe(summary.losses, 0));
  text("statWinrate", safe(summary.winrate, "0.0%"));
  text("statTotalR", formatNumber(summary.totalR, 3));
  text("statAvgR", formatNumber(summary.avgR, 3));
  text("statTotalPnl", formatNumber(summary.totalPnlPct, 3));
}

function getFilteredFamilies() {
  const report = state.report || {};
  const side = $("sideFilter")?.value || "ALL";
  const status = $("statusFilter")?.value || "ALL";
  const search = String($("searchInput")?.value || "").toUpperCase().trim();
  const hideEmpty = Boolean($("hideEmptyInput")?.checked);
  const minClosed = Number($("minClosedInput")?.value || 0);

  let rows = [];

  if (side === "LONG") rows = report?.families?.long || [];
  else if (side === "SHORT") rows = report?.families?.short || [];
  else rows = report?.families?.all || [];

  return rows.filter(row => {
    if (status !== "ALL" && row.status !== status) return false;
    if (hideEmpty && row.status === "EMPTY") return false;
    if (Number(row.closed || 0) < minClosed) return false;

    if (search) {
      const haystack = [
        row.familyId,
        row.side,
        row.definition,
        row.quality,
        row.market,
        row.timing,
        row.status
      ].join(" ").toUpperCase();

      if (!haystack.includes(search)) return false;
    }

    return true;
  });
}

function badge(status) {
  const s = String(status || "EMPTY").toUpperCase();
  return `<span class="badge ${s}">${s}</span>`;
}

function renderFamilyTable() {
  const tbody = $("familyTableBody");
  if (!tbody) return;

  const rows = getFilteredFamilies();

  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="15" class="definition">Geen families gevonden met deze filters.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows.map(row => `
    <tr>
      <td><span class="familyId">${row.familyId}</span></td>
      <td>${row.side}</td>
      <td class="definition">${row.definition}</td>
      <td class="num">${safe(row.observed, 0)}</td>
      <td class="num">${safe(row.open, 0)}</td>
      <td class="num">${safe(row.realClosed, 0)}</td>
      <td class="num">${safe(row.shadowClosed, 0)}</td>
      <td class="num">${safe(row.wins, 0)}</td>
      <td class="num">${safe(row.losses, 0)}</td>
      <td class="num">${safe(row.winrate, "0.0%")}</td>
      <td class="num">${formatNumber(row.totalR, 3)}</td>
      <td class="num">${formatNumber(row.avgR, 3)}</td>
      <td class="num">${formatNumber(row.totalPnlPct, 3)}</td>
      <td class="num">${safe(row.directSLPct, "0.0%")}</td>
      <td>${badge(row.status)}</td>
    </tr>
  `).join("");
}

function renderTrackedFilters() {
  const box = $("trackedFilters");
  if (!box) return;

  const filters = state.report?.trackedFilters || [];

  box.innerHTML = filters.map(name => (
    `<span class="chip">${name}</span>`
  )).join("");
}

function renderCards(id, rows) {
  const box = $(id);
  if (!box) return;

  const safeRows = Array.isArray(rows) ? rows : [];

  if (!safeRows.length) {
    box.innerHTML = `<article class="card"><h3>Geen samples</h3><pre>Geen data voor deze sectie.</pre></article>`;
    return;
  }

  box.innerHTML = safeRows.slice(-30).reverse().map(row => `
    <article class="card">
      <h3>${row.symbol || "UNKNOWN"} ${row.side || ""} ${row.familyId || ""}</h3>
      <pre>${escapeHtml(JSON.stringify(row, null, 2))}</pre>
    </article>
  `).join("");
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderSamples() {
  const samples = state.report?.samples || {};
  renderCards("openSamples", samples.open || []);
  renderCards("closedSamples", samples.closed || []);
}

function renderFooter() {
  const summary = state.report?.summary || {};

  text("lastUpdated", summary.generatedAt
    ? `Laatste update: ${new Date(summary.generatedAt).toLocaleString()}`
    : "Niet geladen"
  );

  text("storeInfo", `Version: ${state.report?.version || "n/a"}`);
}

function render() {
  const report = state.report || {};
  renderSummary(report.summary || {});
  renderFamilyTable();
  renderTrackedFilters();
  renderSamples();
  renderFooter();
}

function setActiveTab(tabName) {
  for (const btn of document.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  }

  const panels = {
    families: $("familiesPanel"),
    tracked: $("trackedPanel"),
    open: $("openPanel"),
    closed: $("closedPanel")
  };

  for (const [name, el] of Object.entries(panels)) {
    if (!el) continue;
    el.classList.toggle("active", name === tabName);
  }
}

function toggleAuto() {
  state.auto = !state.auto;

  const btn = $("autoBtn");
  if (btn) btn.textContent = state.auto ? "Auto: ON" : "Auto: OFF";

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  if (state.auto) {
    state.timer = setInterval(() => {
      loadReport().catch(e => showError(`Load error: ${e.message}`));
    }, 15000);
  }
}

function bindEvents() {
  $("refreshBtn")?.addEventListener("click", () => {
    loadReport().catch(e => showError(`Load error: ${e.message}`));
  });

  $("resetBtn")?.addEventListener("click", () => {
    resetReport().catch(e => showError(`Reset error: ${e.message}`));
  });

  $("autoBtn")?.addEventListener("click", toggleAuto);

  $("sideFilter")?.addEventListener("change", renderFamilyTable);
  $("statusFilter")?.addEventListener("change", renderFamilyTable);
  $("searchInput")?.addEventListener("input", renderFamilyTable);
  $("hideEmptyInput")?.addEventListener("change", renderFamilyTable);

  $("minClosedInput")?.addEventListener("change", () => {
    loadReport().catch(e => showError(`Load error: ${e.message}`));
  });

  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => {
      setActiveTab(btn.dataset.tab);
    });
  }
}

bindEvents();

loadReport().catch(e => {
  showError(`Load error: ${e.message}`);
  render();
});