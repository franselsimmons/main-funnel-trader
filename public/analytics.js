const API_URL = "/api/analyse";

const state = {
  report: null,
  rows: [],
  trades: [],
  filters: [],
  tab: "long",
  auto: false,
  timer: null,
  side: "ALL",
  status: "ALL",
  minClosed: 0,
  search: "",
  hideEmpty: false
};

const $ = id => document.getElementById(id);

const els = {
  refreshBtn: $("refreshBtn"),
  autoBtn: $("autoBtn"),
  errorBox: $("errorBox"),

  sideSelect: $("sideSelect"),
  statusSelect: $("statusSelect"),
  minClosedInput: $("minClosedInput"),
  searchInput: $("searchInput"),
  hideEmptyInput: $("hideEmptyInput"),

  longHead: $("longHead"),
  longBody: $("longBody"),
  shortHead: $("shortHead"),
  shortBody: $("shortBody"),
  filtersBody: $("filtersBody"),
  tradesHead: $("tradesHead"),
  tradesBody: $("tradesBody"),
  rawBox: $("rawBox")
};

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value) {
  if (typeof value === "string" && value.includes("%")) return value;
  const n = num(value, 0);
  return `${n.toFixed(1)}%`;
}

function fixed(value, decimals = 3) {
  return num(value, 0).toFixed(decimals).replace(/\.?0+$/, "");
}

function safeText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function valueClass(value) {
  const n = num(value, 0);
  if (n > 0) return "numPos";
  if (n < 0) return "numNeg";
  return "muted";
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.classList.remove("hidden");
}

function clearError() {
  els.errorBox.textContent = "";
  els.errorBox.classList.add("hidden");
}

function unwrapPayload(payload) {
  if (!payload) return {};

  if (payload.report && typeof payload.report === "object") return payload.report;
  if (payload.data?.report && typeof payload.data.report === "object") return payload.data.report;
  if (payload.analysis?.report && typeof payload.analysis.report === "object") return payload.analysis.report;
  if (payload.analysis && typeof payload.analysis === "object") return payload.analysis;

  return payload;
}

function normalizeReport(payload) {
  const report = unwrapPayload(payload);

  const summary =
    report.summary ||
    report.auditSnapshot ||
    report.snapshot ||
    report.stats ||
    report.overview ||
    {};

  return {
    ...report,
    summary
  };
}

function getFamilyArrays(report) {
  const root = report.families || report.familyReport || report.familyStats || report.buckets || {};

  let longRows =
    report.longFamilies ||
    root.long ||
    root.LONG ||
    root.longs ||
    report.long ||
    [];

  let shortRows =
    report.shortFamilies ||
    root.short ||
    root.SHORT ||
    root.shorts ||
    report.short ||
    [];

  if (Array.isArray(report.families)) {
    longRows = report.families.filter(row => detectSide(row) === "LONG");
    shortRows = report.families.filter(row => detectSide(row) === "SHORT");
  }

  if (Array.isArray(report.rows)) {
    longRows = longRows.length ? longRows : report.rows.filter(row => detectSide(row) === "LONG");
    shortRows = shortRows.length ? shortRows : report.rows.filter(row => detectSide(row) === "SHORT");
  }

  return {
    longRows: Array.isArray(longRows) ? longRows : [],
    shortRows: Array.isArray(shortRows) ? shortRows : []
  };
}

function detectSide(row) {
  const raw = String(row?.side || row?.direction || row?.family || row?.name || row?.id || "").toUpperCase();

  if (raw.includes("SHORT") || raw.includes("BEAR")) return "SHORT";
  if (raw.includes("LONG") || raw.includes("BULL")) return "LONG";

  return "UNKNOWN";
}

function detectStatus(row) {
  const explicit = String(row.status || row.state || "").toUpperCase();
  if (explicit) return explicit;

  const closed = num(row.closed);
  const open = num(row.open);
  const wins = num(row.wins);
  const losses = num(row.losses);
  const avgR = num(row.avgR);
  const winrate = num(row.winrateNum ?? row.winrate);

  if (!closed && !open) return "EMPTY";
  if (!closed && open) return "OPEN_ONLY";
  if (closed < 5) return "COLLECTING";
  if (avgR > 0 && winrate >= 55) return "HOT";
  if (avgR < 0 && losses > wins) return "BAD";

  return "COLLECTING";
}

function normalizeFamilyRow(row, side, index) {
  const wins = num(row.wins ?? row.win);
  const losses = num(row.losses ?? row.loss);
  const closed = num(row.closed ?? row.completed ?? row.exits ?? row.closedTrades ?? wins + losses);
  const open = num(row.open ?? row.active ?? row.openTrades);
  const observed = num(row.observed ?? row.actions ?? row.total ?? row.sample ?? row.count ?? row.trades ?? closed + open);

  const winrateNum = closed > 0
    ? (wins / Math.max(1, wins + losses)) * 100
    : num(row.winrateNum ?? row.winrate);

  const normalized = {
    id: safeText(row.id || row.familyId || row.family || row.name || `${side}_${index + 1}`),
    side,
    definition: safeText(row.definition || row.familyDefinition || row.key || row.familyKey || row.combo || row.label),
    setupClass: safeText(row.setupClass || row.grade || row.class || ""),
    observed,
    closed,
    open,
    wins,
    losses,
    winrate: pct(winrateNum),
    winrateNum,
    totalR: num(row.totalR ?? row.rTotal ?? row.sumR),
    avgR: num(row.avgR ?? row.expectancyR),
    pnlPct: num(row.totalPnlPct ?? row.pnlPctTotal ?? row.pnlPct),
    directSLPct: safeText(row.directSLPct || row.directSlPct || "0%"),
    score: num(row.score ?? row.decisionScore ?? row.edgeScore),
    raw: row
  };

  normalized.status = detectStatus(normalized);
  return normalized;
}

function extractRows(report) {
  const { longRows, shortRows } = getFamilyArrays(report);

  const longs = longRows.map((row, i) => normalizeFamilyRow(row, "LONG", i));
  const shorts = shortRows.map((row, i) => normalizeFamilyRow(row, "SHORT", i));

  return [...longs, ...shorts];
}

function extractTrades(report) {
  const rows =
    report.trades ||
    report.tradeRows ||
    report.recentTrades ||
    report.closedTrades ||
    report.openPositions ||
    report.actions ||
    report.auditSnapshot?.closedTrades ||
    [];

  return Array.isArray(rows) ? rows.slice(-300).reverse() : [];
}

function flattenFilters(obj, prefix = "", out = []) {
  if (!obj || typeof obj !== "object") return out;

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenFilters(value, path, out);
      continue;
    }

    const parts = path.split(".");
    out.push({
      category: parts.length > 1 ? parts.slice(0, -1).join(".") : "root",
      key: parts[parts.length - 1],
      value: Array.isArray(value) ? value.join(", ") : safeText(value)
    });
  }

  return out;
}

function extractFilters(report) {
  const source =
    report.trackedFilters ||
    report.filterValues ||
    report.currentFilterValues ||
    report.tradeSystemFilters ||
    report.filters ||
    report.summary?.currentFilterValues ||
    {};

  return flattenFilters(source).sort((a, b) => {
    const c = a.category.localeCompare(b.category);
    if (c !== 0) return c;
    return a.key.localeCompare(b.key);
  });
}

function computeSummary(rows, trades, report) {
  const s = report.summary || {};

  const observed = rows.reduce((sum, row) => sum + row.observed, 0);
  const closed = rows.reduce((sum, row) => sum + row.closed, 0);
  const open = rows.reduce((sum, row) => sum + row.open, 0);
  const wins = rows.reduce((sum, row) => sum + row.wins, 0);
  const losses = rows.reduce((sum, row) => sum + row.losses, 0);
  const totalR = rows.reduce((sum, row) => sum + row.totalR, 0);
  const pnlPct = rows.reduce((sum, row) => sum + row.pnlPct, 0);
  const completed = wins + losses;

  return {
    actions: num(s.actions ?? s.actionsCount ?? report.actionsCount ?? observed),
    trades: num(s.trades ?? s.tradesCount ?? trades.length ?? observed),
    open: num(s.open ?? s.openPositions ?? open),
    closed: num(s.closed ?? s.closedTrades ?? closed),
    wins: num(s.wins ?? wins),
    losses: num(s.losses ?? losses),
    winrate: s.winrate || pct(completed ? (wins / completed) * 100 : 0),
    totalR: num(s.totalR ?? s.rTotal ?? totalR),
    avgR: num(s.avgR ?? (closed ? totalR / closed : 0)),
    pnlPct: num(s.totalPnlPct ?? s.pnlPctTotal ?? pnlPct),
    longFamilies: rows.filter(row => row.side === "LONG").length,
    shortFamilies: rows.filter(row => row.side === "SHORT").length
  };
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function renderSummary() {
  const summary = computeSummary(state.rows, state.trades, state.report || {});

  setText("kpiActions", fixed(summary.actions, 0));
  setText("kpiTrades", fixed(summary.trades, 0));
  setText("kpiOpen", fixed(summary.open, 0));
  setText("kpiClosed", fixed(summary.closed, 0));
  setText("kpiWins", fixed(summary.wins, 0));
  setText("kpiLosses", fixed(summary.losses, 0));
  setText("kpiWinrate", summary.winrate);
  setText("kpiTotalR", fixed(summary.totalR, 3));
  setText("kpiAvgR", fixed(summary.avgR, 3));
  setText("kpiPnl", `${fixed(summary.pnlPct, 3)}%`);
  setText("kpiLong", fixed(summary.longFamilies, 0));
  setText("kpiShort", fixed(summary.shortFamilies, 0));
}

function rowMatchesFilters(row, side) {
  if (side && row.side !== side) return false;

  if (state.side !== "ALL" && row.side !== state.side) return false;
  if (state.status !== "ALL" && row.status !== state.status) return false;
  if (row.closed < state.minClosed) return false;
  if (state.hideEmpty && row.observed <= 0) return false;

  const haystack = [
    row.id,
    row.side,
    row.status,
    row.definition,
    row.setupClass,
    row.winrate,
    row.totalR,
    row.avgR,
    row.pnlPct
  ].join(" ").toUpperCase();

  if (state.search && !haystack.includes(state.search.toUpperCase())) return false;

  return true;
}

function renderFamilyTable(headEl, bodyEl, side) {
  headEl.innerHTML = `
    <tr>
      <th>Family</th>
      <th>Side</th>
      <th>Definition</th>
      <th>Observed</th>
      <th>Closed</th>
      <th>Open</th>
      <th>Wins</th>
      <th>Losses</th>
      <th>Winrate</th>
      <th>Total R</th>
      <th>Avg R</th>
      <th>PnL%</th>
      <th>Direct SL</th>
      <th>Score</th>
      <th>Status</th>
    </tr>
  `;

  const rows = state.rows
    .filter(row => rowMatchesFilters(row, side))
    .sort((a, b) => {
      const closedDiff = b.closed - a.closed;
      if (closedDiff !== 0) return closedDiff;

      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;

      return b.totalR - a.totalR;
    });

  if (!rows.length) {
    bodyEl.innerHTML = `<tr><td class="empty" colspan="15">Geen families gevonden voor deze filters.</td></tr>`;
    return;
  }

  bodyEl.innerHTML = rows.map(row => {
    const sideClass = row.side === "LONG" ? "long" : "short";
    const statusClass =
      row.status === "HOT" ? "hot" :
      row.status === "BAD" ? "bad" :
      row.status === "OPEN_ONLY" ? "open" :
      row.status === "EMPTY" ? "collecting" :
      "collecting";

    return `
      <tr>
        <td><b>${row.id}</b></td>
        <td><span class="badge ${sideClass}">${row.side}</span></td>
        <td class="definition">${row.definition || "<span class='muted'>No definition</span>"}</td>
        <td>${fixed(row.observed, 0)}</td>
        <td>${fixed(row.closed, 0)}</td>
        <td>${fixed(row.open, 0)}</td>
        <td>${fixed(row.wins, 0)}</td>
        <td>${fixed(row.losses, 0)}</td>
        <td>${row.winrate}</td>
        <td class="${valueClass(row.totalR)}">${fixed(row.totalR, 3)}</td>
        <td class="${valueClass(row.avgR)}">${fixed(row.avgR, 3)}</td>
        <td class="${valueClass(row.pnlPct)}">${fixed(row.pnlPct, 3)}%</td>
        <td>${row.directSLPct}</td>
        <td>${fixed(row.score, 3)}</td>
        <td><span class="badge ${statusClass}">${row.status}</span></td>
      </tr>
    `;
  }).join("");
}

function renderFilters() {
  if (!state.filters.length) {
    els.filtersBody.innerHTML = `<tr><td class="empty" colspan="3">Geen filterwaarden ontvangen van API.</td></tr>`;
    return;
  }

  els.filtersBody.innerHTML = state.filters.map(row => `
    <tr>
      <td>${row.category}</td>
      <td><b>${row.key}</b></td>
      <td>${row.value}</td>
    </tr>
  `).join("");
}

function renderTrades() {
  els.tradesHead.innerHTML = `
    <tr>
      <th>Symbol</th>
      <th>Side</th>
      <th>Status</th>
      <th>Family</th>
      <th>Setup</th>
      <th>Entry</th>
      <th>Exit</th>
      <th>R</th>
      <th>PnL%</th>
      <th>Reason</th>
      <th>RSI</th>
      <th>OB</th>
      <th>BTC</th>
    </tr>
  `;

  if (!state.trades.length) {
    els.tradesBody.innerHTML = `<tr><td class="empty" colspan="13">Nog geen trades/observations ontvangen.</td></tr>`;
    return;
  }

  els.tradesBody.innerHTML = state.trades.map(t => {
    const side = String(t.side || t.direction || "").toUpperCase();
    const sideClass = side.includes("BEAR") || side.includes("SHORT") ? "short" : "long";
    const r = num(t.exitR ?? t.r ?? t.currentR ?? t.pnlR);

    return `
      <tr>
        <td><b>${safeText(t.symbol || "-")}</b></td>
        <td><span class="badge ${sideClass}">${safeText(t.side || "-")}</span></td>
        <td>${safeText(t.status || t.action || t.exitReason || "-")}</td>
        <td>${safeText(t.familyId || t.family || t.bucket || "-")}</td>
        <td>${safeText(t.setupClass || t.grade || "-")}</td>
        <td>${safeText(t.entry ?? "-")}</td>
        <td>${safeText(t.exit ?? "-")}</td>
        <td class="${valueClass(r)}">${fixed(r, 3)}</td>
        <td class="${valueClass(t.pnlPct)}">${fixed(t.pnlPct, 3)}%</td>
        <td>${safeText(t.reason || t.entryReason || t.exitReason || "-")}</td>
        <td>${safeText(t.rsiZone || t.rsi || "-")}</td>
        <td>${safeText(t.obBias || "-")}</td>
        <td>${safeText(t.btcState || "-")}</td>
      </tr>
    `;
  }).join("");
}

function renderRaw() {
  els.rawBox.textContent = JSON.stringify(state.report || {}, null, 2);
}

function setActiveTab(tab) {
  state.tab = tab;

  document.querySelectorAll(".tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  document.querySelectorAll(".panel").forEach(panel => {
    panel.classList.remove("active");
  });

  const panelId = {
    long: "panelLong",
    short: "panelShort",
    filters: "panelFilters",
    trades: "panelTrades",
    raw: "panelRaw"
  }[tab];

  $(panelId)?.classList.add("active");
}

function render() {
  renderSummary();
  renderFamilyTable(els.longHead, els.longBody, "LONG");
  renderFamilyTable(els.shortHead, els.shortBody, "SHORT");
  renderFilters();
  renderTrades();
  renderRaw();
}

async function loadReport() {
  clearError();
  els.refreshBtn.textContent = "Loading...";

  try {
    const res = await fetch(`${API_URL}?t=${Date.now()}`, {
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });

    if (!res.ok) {
      throw new Error(`API ${res.status}: ${res.statusText}`);
    }

    const payload = await res.json();
    const report = normalizeReport(payload);

    state.report = report;
    state.rows = extractRows(report);
    state.trades = extractTrades(report);
    state.filters = extractFilters(report);

    render();
  } catch (e) {
    showError(`Load error: ${e.message}`);
  } finally {
    els.refreshBtn.textContent = "Refresh";
  }
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", loadReport);

  els.autoBtn.addEventListener("click", () => {
    state.auto = !state.auto;
    els.autoBtn.textContent = state.auto ? "Auto: ON" : "Auto: OFF";

    if (state.timer) clearInterval(state.timer);
    state.timer = state.auto ? setInterval(loadReport, 15000) : null;
  });

  els.sideSelect.addEventListener("change", e => {
    state.side = e.target.value;
    render();
  });

  els.statusSelect.addEventListener("change", e => {
    state.status = e.target.value;
    render();
  });

  els.minClosedInput.addEventListener("input", e => {
    state.minClosed = num(e.target.value);
    render();
  });

  els.searchInput.addEventListener("input", e => {
    state.search = e.target.value.trim();
    render();
  });

  els.hideEmptyInput.addEventListener("change", e => {
    state.hideEmpty = e.target.checked;
    render();
  });

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
}

bindEvents();
loadReport();