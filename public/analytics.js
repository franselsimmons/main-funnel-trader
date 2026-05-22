// ================= public/analyze.js =================

const API_URL = "/api/analyse";

let state = {
  report: null,
  auto: false,
  timer: null
};

const $ = id => document.getElementById(id);

function setText(id, value) {
  const el = $(id);
  if (!el) return;
  el.textContent = value ?? "-";
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

function safeReport(data) {
  const report = data?.report || data || {};
  const summary = report?.summary || data?.summary || {};

  return {
    ...report,
    summary,
    longFamilies: report?.longFamilies || data?.longFamilies || [],
    shortFamilies: report?.shortFamilies || data?.shortFamilies || [],
    families: report?.families || data?.families || [],
    rows: report?.rows || report?.trades || report?.actions || data?.rows || [],
    trackedFilters: report?.trackedFilters || data?.trackedFilters || [],
    filterValues: report?.filterValues || data?.filterValues || null
  };
}

function val(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return value;
}

function numClass(value) {
  const n = Number(value || 0);
  if (n > 0) return "positive";
  if (n < 0) return "negative";
  return "";
}

function renderSummary(report) {
  const s = report?.summary || {};

  setText("sActions", val(s.actions));
  setText("sTrades", val(s.trades));
  setText("sOpen", val(s.open));
  setText("sClosed", val(s.closed));
  setText("sWins", val(s.wins));
  setText("sLosses", val(s.losses));
  setText("sWinrate", val(s.winrate));
  setText("sTotalR", val(s.totalR));
  setText("sAvgR", val(s.avgR));
  setText("sTotalPnl", val(s.totalPnlPct));
  setText("sLongFamilies", val(s.longFamilies));
  setText("sShortFamilies", val(s.shortFamilies));
}

function familyRow(f) {
  return `
    <tr>
      <td><strong>${f.id}</strong></td>
      <td class="combo">${f.label || "-"}</td>
      <td>${f.actions ?? 0}</td>
      <td>${f.entries ?? 0}</td>
      <td>${f.open ?? 0}</td>
      <td>${f.closed ?? 0}</td>
      <td>${f.wins ?? 0}</td>
      <td>${f.losses ?? 0}</td>
      <td>${f.winrate || "0.0%"}</td>
      <td class="${numClass(f.totalR)}">${f.totalR ?? 0}</td>
      <td class="${numClass(f.avgR)}">${f.avgR ?? 0}</td>
      <td class="${numClass(f.totalPnlPct)}">${f.totalPnlPct ?? 0}</td>
      <td>${f.directSLPct || "0.0%"}</td>
      <td><span class="badge">${f.status || "empty"}</span></td>
    </tr>
  `;
}

function renderFamilies(report) {
  const longRows = report.longFamilies || [];
  const shortRows = report.shortFamilies || [];

  $("longBody").innerHTML = longRows.map(familyRow).join("");
  $("shortBody").innerHTML = shortRows.map(familyRow).join("");
}

function stringifyValue(value) {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderFilters(report) {
  const tracked = report.trackedFilters || [];
  const values = report.filterValues || {};
  const query = String($("filterSearch")?.value || "").toLowerCase();

  const html = tracked.map(group => {
    const items = (group.keys || [])
      .filter(key => {
        const haystack = `${group.category} ${key} ${stringifyValue(values?.[key])}`.toLowerCase();
        return !query || haystack.includes(query);
      })
      .map(key => `
        <div class="filterItem">
          <code>${key}</code>
          <span>${stringifyValue(values?.[key])}</span>
        </div>
      `)
      .join("");

    if (!items) return "";

    return `
      <div class="filterGroup">
        <h3>${group.category}</h3>
        ${items}
      </div>
    `;
  }).join("");

  $("filtersBox").innerHTML = html || `<div class="filterGroup">Geen filterwaarden ontvangen. Controleer of tradeSystem via analysisNotifier naar /api/analyse post.</div>`;
}

function rowMatches(row, query) {
  if (!query) return true;
  return JSON.stringify(row).toLowerCase().includes(query.toLowerCase());
}

function renderTrades(report) {
  const rows = report.rows || [];
  const query = $("tradesSearch")?.value || "";

  $("tradesBody").innerHTML = rows
    .filter(row => rowMatches(row, query))
    .slice(0, 500)
    .map(row => `
      <tr>
        <td><strong>${row.symbol || "-"}</strong></td>
        <td>${row.side || "-"}</td>
        <td>${row.action || "-"}</td>
        <td>${row.reason || "-"}</td>
        <td>${row.familyId || "-"}</td>
        <td>${row.setupClass || "-"}</td>
        <td>${row.stage || "-"}</td>
        <td>${row.flow || "-"}</td>
        <td>${row.rsiZone || "-"}</td>
        <td>${row.rr ?? "-"}</td>
        <td>${row.confluence ?? "-"}</td>
        <td>${row.sniperScore ?? "-"}</td>
        <td>${row.obBias || "-"} / ${row.obRel || "-"}</td>
        <td>${row.btcState || "-"} / ${row.btcRel || "-"}</td>
        <td class="${numClass(row.exitR)}">${row.exitR ?? "-"}</td>
        <td class="${numClass(row.pnlPct)}">${row.pnlPct ?? "-"}</td>
      </tr>
    `)
    .join("");
}

function renderActions(report) {
  const rows = report.rows || [];
  const query = $("actionsSearch")?.value || "";

  $("actionsBody").innerHTML = rows
    .filter(row => rowMatches(row, query))
    .slice(0, 500)
    .map(row => `
      <tr>
        <td><strong>${row.symbol || "-"}</strong></td>
        <td>${row.side || "-"}</td>
        <td>${row.action || "-"}</td>
        <td>${row.reason || "-"}</td>
        <td>${row.setupClass || "-"}</td>
        <td>${row.familyId || "-"}</td>
        <td>${row.open ? "yes" : "no"}</td>
        <td>${row.closed ? "yes" : "no"}</td>
        <td>${row.win ? "yes" : "no"}</td>
        <td>${row.loss ? "yes" : "no"}</td>
      </tr>
    `)
    .join("");
}

function applySearchToFamilies() {
  const report = state.report;
  if (!report) return;

  const longQuery = String($("longSearch")?.value || "").toLowerCase();
  const shortQuery = String($("shortSearch")?.value || "").toLowerCase();

  const longRows = (report.longFamilies || []).filter(f => !longQuery || JSON.stringify(f).toLowerCase().includes(longQuery));
  const shortRows = (report.shortFamilies || []).filter(f => !shortQuery || JSON.stringify(f).toLowerCase().includes(shortQuery));

  $("longBody").innerHTML = longRows.map(familyRow).join("");
  $("shortBody").innerHTML = shortRows.map(familyRow).join("");
}

function renderRaw(report) {
  $("rawBox").textContent = JSON.stringify(report, null, 2);
}

function render(report) {
  state.report = report;

  renderSummary(report);
  renderFamilies(report);
  renderFilters(report);
  renderTrades(report);
  renderActions(report);
  renderRaw(report);
}

async function loadReport() {
  showError("");

  try {
    const res = await fetch(`${API_URL}?t=${Date.now()}`, {
      cache: "no-store"
    });

    const data = await res.json();

    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    const report = safeReport(data);

    render(report);
  } catch (e) {
    showError(`Load error: ${e.message}`);
  }
}

async function resetReport() {
  const ok = confirm("Reset alle analyse data?");
  if (!ok) return;

  showError("");

  try {
    const res = await fetch(`${API_URL}?reset=1&t=${Date.now()}`, {
      method: "DELETE",
      cache: "no-store"
    });

    const data = await res.json();

    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    await loadReport();
  } catch (e) {
    showError(`Reset error: ${e.message}`);
  }
}

function setActiveTab(name) {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });

  document.querySelectorAll(".panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === `tab-${name}`);
  });
}

function toggleAuto() {
  state.auto = !state.auto;

  $("autoBtn").textContent = state.auto ? "Auto: ON" : "Auto: OFF";

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  if (state.auto) {
    state.timer = setInterval(loadReport, 10_000);
  }
}

function bindEvents() {
  $("refreshBtn")?.addEventListener("click", loadReport);
  $("resetBtn")?.addEventListener("click", resetReport);
  $("autoBtn")?.addEventListener("click", toggleAuto);

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });

  $("longSearch")?.addEventListener("input", applySearchToFamilies);
  $("shortSearch")?.addEventListener("input", applySearchToFamilies);

  $("filterSearch")?.addEventListener("input", () => {
    if (state.report) renderFilters(state.report);
  });

  $("tradesSearch")?.addEventListener("input", () => {
    if (state.report) renderTrades(state.report);
  });

  $("actionsSearch")?.addEventListener("input", () => {
    if (state.report) renderActions(state.report);
  });
}

bindEvents();
loadReport();