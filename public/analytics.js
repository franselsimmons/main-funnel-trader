const API_URL = "/api/analyse";
const REFRESH_MS = 30000;
const DEFAULT_MIN_CLOSED = 10;

let state = {
  report: null,
  raw: null,
  activeTab: "ALL",
  auto: false,
  timer: null,
  loading: false,
};

function $(id) {
  return document.getElementById(id);
}

function firstEl(...ids) {
  for (const id of ids) {
    const el = $(id);
    if (el) return el;
  }

  return null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function escapeHtml(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtNum(value, decimals = 3) {
  const n = safeNumber(value, 0);

  if (decimals === 0) return String(Math.round(n));
  if (Number.isInteger(n)) return String(n);

  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

function fmtPct(value, decimals = 1) {
  const raw = text(value);

  if (raw.includes("%")) return raw;

  return `${fmtNum(value, decimals)}%`;
}

function signedClass(value) {
  const n = safeNumber(value, 0);

  if (n > 0) return "positive";
  if (n < 0) return "negative";

  return "";
}

function statusClass(status) {
  return `status-${text(status, "EMPTY").toLowerCase()}`;
}

function errorToText(error) {
  if (!error) return "Onbekende error.";

  if (typeof error === "string") return error;

  if (error instanceof Error) {
    return error.message || String(error);
  }

  if (typeof error === "object") {
    if (error.error?.message) return error.error.message;
    if (error.message) return error.message;
    if (error.error && typeof error.error === "string") return error.error;
    if (error.reason) return error.reason;

    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return "Niet-serialiseerbare error.";
    }
  }

  return String(error);
}

function setHidden(el, hidden) {
  if (!el) return;

  el.hidden = Boolean(hidden);
  el.classList.toggle("hidden", Boolean(hidden));
}

function setStatus(message, isError = false) {
  const status = firstEl("statusLine", "statusText");
  const box = $("errorBox");

  if (status) {
    status.textContent = message || "";
  }

  if (box) {
    setHidden(box, !isError);

    if (isError) {
      box.textContent = `Load error:\n${message}`;
    }
  }
}

function setBusy(isBusy) {
  state.loading = Boolean(isBusy);

  const refreshBtn = $("refreshBtn");
  const resetBtn = $("resetBtn");

  if (refreshBtn) refreshBtn.disabled = state.loading;
  if (resetBtn) resetBtn.disabled = state.loading;

  if (refreshBtn) {
    refreshBtn.textContent = state.loading ? "Loading..." : "Refresh";
  }
}

function getMinClosedInput() {
  return firstEl("minClosedInput", "minClosed");
}

function getMinClosedValue() {
  const input = getMinClosedInput();
  const value = safeNumber(input?.value, DEFAULT_MIN_CLOSED);

  return Math.max(0, Math.round(value));
}

function buildApiUrl(extra = {}) {
  const params = new URLSearchParams();

  params.set("minClosed", String(getMinClosedValue()));
  params.set("includeLatest", "true");
  params.set("debug", extra.debug === false ? "false" : "true");
  params.set("t", String(Date.now()));

  if (extra.reset) {
    params.set("reset", "true");
  }

  return `${API_URL}?${params.toString()}`;
}

function ensureRuntimeDefaults() {
  const minClosedInput = getMinClosedInput();

  if (minClosedInput && (minClosedInput.value === "" || minClosedInput.value === "0")) {
    minClosedInput.value = String(DEFAULT_MIN_CLOSED);
  }

  enhanceExistingDom();

  const apiLink = $("apiLink");
  if (apiLink) {
    apiLink.href = buildApiUrl({ debug: true });
  }
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("API gaf geen geldig JSON-object terug.");
  }

  if (!payload.ok) {
    throw payload;
  }

  const report = payload.report || payload;

  if (!report || typeof report !== "object") {
    throw new Error("API response mist report-object.");
  }

  const summary = report.summary || {};
  const families = report.families || {};

  return {
    raw: payload,
    report: {
      ...report,
      summary,
      diagnostics: report.diagnostics || {},
      config: report.config || {},
      families: {
        all: safeArray(families.all || families.ranked),
        long: safeArray(families.long),
        short: safeArray(families.short),
        ranked: safeArray(families.ranked || families.all),
        best: safeArray(families.best),
        worst: safeArray(families.worst),
      },
      filterValues: report.filterValues || {},
    },
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  const payload = isJson
    ? await response.json()
    : { ok: false, error: await response.text() };

  if (!response.ok) {
    throw payload;
  }

  return payload;
}

function setText(ids, value) {
  const list = Array.isArray(ids) ? ids : [ids];

  for (const id of list) {
    const el = $(id);
    if (el) el.textContent = value;
  }
}

function countStatuses(families) {
  const counts = {
    HOT: 0,
    GOOD: 0,
    STABLE: 0,
    BAD: 0,
    COLLECTING: 0,
    EMPTY: 0,
  };

  for (const family of safeArray(families)) {
    const status = text(family.status, "EMPTY").toUpperCase();

    if (counts[status] === undefined) counts[status] = 0;
    counts[status] += 1;
  }

  return counts;
}

function familyMetaText(families) {
  const c = countStatuses(families);

  return `HOT ${c.HOT} | GOOD ${c.GOOD} | STABLE ${c.STABLE} | BAD ${c.BAD} | COLLECTING ${c.COLLECTING} | EMPTY ${c.EMPTY}`;
}

function renderSummary() {
  const summary = state.report?.summary || {};
  const longFamilies = safeArray(state.report?.families?.long);
  const shortFamilies = safeArray(state.report?.families?.short);

  setText(["mActions", "kpiActions"], fmtNum(summary.actions || 0, 0));
  setText(["mTrades", "kpiTrades"], fmtNum(summary.trades || summary.observed || 0, 0));
  setText(["mOpen", "kpiOpen"], fmtNum(summary.open || 0, 0));
  setText(["mClosed", "kpiClosed"], fmtNum(summary.closed || 0, 0));
  setText(["mPending", "kpiPending"], fmtNum(summary.pendingOutcome || summary.unresolved || 0, 0));
  setText(["mWins", "kpiWins"], fmtNum(summary.wins || 0, 0));
  setText(["mLosses", "kpiLosses"], fmtNum(summary.losses || 0, 0));
  setText(["mBreakeven", "kpiBreakeven"], fmtNum(summary.breakeven || 0, 0));
  setText(["mWinrate", "kpiWinrate"], summary.winrate || fmtPct(summary.winrateNum || 0));
  setText(["mTotalR", "kpiTotalR"], fmtNum(summary.totalR || 0, 3));
  setText(["mAvgR", "kpiAvgR"], fmtNum(summary.avgR || 0, 3));
  setText(["mTotalPnl", "kpiPnl"], fmtPct(summary.totalPnlPct || 0, 3));

  setText(["mLongFamilies", "kpiLongFamilies"], fmtNum(summary.longFamilies || longFamilies.length || 50, 0));
  setText(["mShortFamilies", "kpiShortFamilies"], fmtNum(summary.shortFamilies || shortFamilies.length || 50, 0));

  setText(["mLongMeta", "longFamiliesMeta"], familyMetaText(longFamilies));
  setText(["mShortMeta", "shortFamiliesMeta"], familyMetaText(shortFamilies));
}

function renderSourceCards() {
  const raw = state.raw || {};
  const sources = raw.sources || {};
  const latest = sources.latest || {};
  const store = sources.store || {};

  setText("sourceStored", fmtNum(sources.storedEvents ?? store.count ?? 0, 0));
  setText("sourceLatest", fmtNum(sources.latestEvents ?? 0, 0));
  setText("sourceMerged", fmtNum(sources.mergedEvents ?? raw.tradesLoaded ?? 0, 0));
  setText("sourceLatency", `${fmtNum(raw.latencyMs ?? 0, 0)}ms`);

  setText("sourceStoredSub", store.path ? `store: ${store.path}` : "store: n/a");
  setText("sourceLatestSub", latest.ok ? "latest scan OK" : `latest scan ${latest.error || "missing"}`);
  setText("sourceMergedSub", `loaded: ${fmtNum(raw.tradesLoaded ?? 0, 0)}`);
  setText("sourceLatencySub", raw.generatedAt ? new Date(raw.generatedAt).toLocaleString() : "");
}

function getBaseFamilies() {
  const families = state.report?.families || {};

  if (state.activeTab === "LONG") return safeArray(families.long);
  if (state.activeTab === "SHORT") return safeArray(families.short);

  return safeArray(families.ranked || families.all);
}

function sortFamilies(rows) {
  const statusRank = {
    HOT: 6,
    GOOD: 5,
    STABLE: 4,
    COLLECTING: 3,
    BAD: 2,
    EMPTY: 1,
  };

  return [...safeArray(rows)].sort((a, b) => {
    const s = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
    if (s !== 0) return s;

    const closed = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
    if (closed !== 0) return closed;

    const observed = safeNumber(b.observed, 0) - safeNumber(a.observed, 0);
    if (observed !== 0) return observed;

    const avgR = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
    if (avgR !== 0) return avgR;

    const side = text(a.side).localeCompare(text(b.side));
    if (side !== 0) return side;

    return safeNumber(a.index, 0) - safeNumber(b.index, 0);
  });
}

function getSelectedFamilies() {
  const sideSelect = firstEl("sideSelect", "sideFilter");
  const statusSelect = firstEl("statusSelect", "statusFilter");
  const searchInput = $("searchInput");
  const hideEmptyInput = firstEl("hideEmptyInput", "hideEmpty");

  let rows = getBaseFamilies();

  const side = sideSelect?.value || state.activeTab || "ALL";
  const status = statusSelect?.value || "ALL";
  const query = String(searchInput?.value || "").toUpperCase().trim();
  const hideEmpty = Boolean(hideEmptyInput?.checked);

  if (side === "LONG") rows = rows.filter(row => row.side === "LONG");
  if (side === "SHORT") rows = rows.filter(row => row.side === "SHORT");

  if (status !== "ALL") {
    rows = rows.filter(row => row.status === status);
  }

  if (hideEmpty) {
    rows = rows.filter(row => row.status !== "EMPTY" && safeNumber(row.observed, 0) > 0);
  }

  if (query) {
    rows = rows.filter(row => {
      const haystack = [
        row.id,
        row.side,
        row.status,
        row.decision,
        row.definition,
        row.qualityBucket,
        row.marketBucket,
        row.timingBucket,
        row.winrate,
        row.totalR,
        row.avgR,
        row.totalPnlPct,
        row.pendingOutcome,
        row.unresolved,
      ].join(" ").toUpperCase();

      return haystack.includes(query);
    });
  }

  return sortFamilies(rows);
}

function renderFamilies() {
  const tbody = firstEl("familyBody", "familiesBody");
  const count = $("familyCount");
  const emptyState = $("emptyState");

  if (!tbody) return;

  const rows = getSelectedFamilies();

  if (count) {
    count.textContent = `${rows.length} families`;
  }

  setHidden(emptyState, rows.length > 0);

  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="15" class="empty-row">Geen families voor deze filters.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const status = text(row.status, "EMPTY");
    const side = text(row.side);
    const sideClass = side.toLowerCase();
    const totalRClass = signedClass(row.totalR);
    const avgRClass = signedClass(row.avgR);
    const pnlClass = signedClass(row.totalPnlPct);
    const pending = safeNumber(row.pendingOutcome ?? row.unresolved, 0);

    return `
      <tr class="${statusClass(status)}">
        <td>
          <span class="family-id">${escapeHtml(row.id)}</span>
        </td>
        <td>
          <span class="side-pill ${sideClass}">${escapeHtml(side)}</span>
        </td>
        <td class="definition">${escapeHtml(row.definition)}</td>
        <td class="num">${fmtNum(row.observed, 0)}</td>
        <td class="num">${fmtNum(row.trades, 0)}</td>
        <td class="num">${fmtNum(row.closed, 0)}</td>
        <td class="num">${fmtNum(row.open, 0)}</td>
        <td class="num pending">${fmtNum(pending, 0)}</td>
        <td class="num">${fmtNum(row.wins, 0)}</td>
        <td class="num">${fmtNum(row.losses, 0)}</td>
        <td class="num">${escapeHtml(row.winrate || "0%")}</td>
        <td class="num ${totalRClass}">${fmtNum(row.totalR, 3)}</td>
        <td class="num ${avgRClass}">${fmtNum(row.avgR, 3)}</td>
        <td class="num ${pnlClass}">${fmtPct(row.totalPnlPct, 3)}</td>
        <td>
          <span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>
        </td>
      </tr>
    `;
  }).join("");
}

function getWinnerFamilies() {
  const minClosed = Math.max(1, getMinClosedValue());
  const apiBest = safeArray(state.report?.families?.best);

  const source = apiBest.length
    ? apiBest
    : safeArray(state.report?.families?.ranked || state.report?.families?.all);

  return source
    .filter(row => ["HOT", "GOOD", "STABLE"].includes(text(row.status)))
    .filter(row => safeNumber(row.closed, 0) >= minClosed)
    .filter(row => safeNumber(row.avgR, 0) >= 0)
    .slice(0, 6);
}

function renderWinners() {
  const grid = $("winnerGrid");
  const count = $("winnerCount");

  if (!grid) return;

  const winners = getWinnerFamilies();

  if (count) {
    count.textContent = `${winners.length} winners`;
  }

  if (!winners.length) {
    grid.innerHTML = `
      <div class="winner-empty">
        Nog geen winnaar-family. Nodig: minimaal ${getMinClosedValue()} closed trades met echte outcome-data per family.
      </div>
    `;
    return;
  }

  grid.innerHTML = winners.map(row => {
    const status = text(row.status, "STABLE").toLowerCase();

    return `
      <article class="winner-card ${status}">
        <div class="winner-top">
          <span class="winner-id">${escapeHtml(row.id)}</span>
          <span class="status-pill ${statusClass(row.status)}">${escapeHtml(row.status)}</span>
        </div>

        <div class="winner-stats">
          <div class="winner-stat">
            <span>Closed</span>
            <strong>${fmtNum(row.closed, 0)}</strong>
          </div>
          <div class="winner-stat">
            <span>Winrate</span>
            <strong>${escapeHtml(row.winrate || "0%")}</strong>
          </div>
          <div class="winner-stat">
            <span>Avg R</span>
            <strong class="${signedClass(row.avgR)}">${fmtNum(row.avgR, 3)}</strong>
          </div>
          <div class="winner-stat">
            <span>PF</span>
            <strong>${fmtNum(row.profitFactorR || 0, 3)}</strong>
          </div>
        </div>

        <p class="winner-definition">${escapeHtml(row.definition)}</p>
      </article>
    `;
  }).join("");
}

function renderFilters() {
  const body = $("filtersBody");
  const count = $("filterCount");

  if (!body) return;

  const filterValues = state.report?.filterValues || {};
  const trackedFields = safeArray(filterValues.trackedFields);

  const quality = Object.values(filterValues.qualityBuckets || {});
  const market = Object.values(filterValues.marketBuckets || {});
  const timing = Object.values(filterValues.timingBuckets || {});

  const chips = [
    ...trackedFields.map(field => ({ group: "FIELD", label: field })),
    ...quality.map(bucket => ({ group: "QUALITY", label: bucket.key })),
    ...market.map(bucket => ({ group: "MARKET", label: bucket.key })),
    ...timing.map(bucket => ({ group: "TIMING", label: bucket.key })),
  ].filter(chip => chip.label);

  if (count) {
    count.textContent = `${chips.length} labels`;
  }

  body.innerHTML = chips.map(chip => `
    <span class="filter-chip">
      <b>${escapeHtml(chip.group)}</b>
      ${escapeHtml(chip.label)}
    </span>
  `).join("");
}

function renderApiMeta() {
  const meta = $("apiMeta");
  if (!meta) return;

  const raw = state.raw || {};
  const sources = raw.sources || {};

  meta.textContent = [
    `stored ${sources.storedEvents ?? 0}`,
    `latest ${sources.latestEvents ?? 0}`,
    `merged ${sources.mergedEvents ?? raw.tradesLoaded ?? 0}`,
    `latency ${raw.latencyMs ?? 0}ms`,
  ].join(" | ");
}

function renderDebug() {
  const debugJson = $("debugJson");
  if (!debugJson) return;

  debugJson.textContent = JSON.stringify({
    sources: state.raw?.sources || null,
    summary: state.report?.summary || null,
    diagnostics: state.report?.diagnostics || null,
    config: state.report?.config || null,
  }, null, 2);
}

function render() {
  if (!state.report) return;

  renderSummary();
  renderSourceCards();
  renderWinners();
  renderFamilies();
  renderFilters();
  renderApiMeta();
  renderDebug();

  const apiLink = $("apiLink");
  if (apiLink) {
    apiLink.href = buildApiUrl({ debug: true });
  }
}

async function loadAnalytics({ force = false } = {}) {
  if (state.loading && !force) return;

  setBusy(true);
  setStatus("Laden...", false);

  try {
    const payload = await fetchJson(buildApiUrl({ debug: true }));
    const normalized = normalizePayload(payload);

    state.raw = normalized.raw;
    state.report = normalized.report;

    const updated = normalized.raw?.generatedAt
      ? new Date(normalized.raw.generatedAt).toLocaleString()
      : new Date().toLocaleString();

    setStatus(`Laatste update: ${updated}`, false);
    render();
  } catch (error) {
    const message = errorToText(error);

    setStatus(message, true);
    console.error("ANALYTICS LOAD ERROR:", error);
  } finally {
    setBusy(false);
  }
}

async function resetAnalytics() {
  const ok = window.confirm("Analyse-store resetten? Dit wist de opgeslagen family-history.");

  if (!ok) return;
  if (state.loading) return;

  setBusy(true);
  setStatus("Reset bezig...", false);

  try {
    const payload = await fetchJson(buildApiUrl({ reset: true, debug: true }));

    if (!payload.ok) {
      throw payload;
    }

    state.raw = null;
    state.report = null;

    setBusy(false);
    await loadAnalytics({ force: true });
  } catch (error) {
    const message = errorToText(error);

    setStatus(message, true);
    console.error("ANALYTICS RESET ERROR:", error);
  } finally {
    setBusy(false);
  }
}

function syncTabs() {
  document.querySelectorAll("[data-side], [data-tab]").forEach(button => {
    const value = button.dataset.side || button.dataset.tab || "ALL";
    button.classList.toggle("active", value === state.activeTab);
  });
}

function setTab(tab) {
  state.activeTab = tab || "ALL";

  const sideSelect = firstEl("sideSelect", "sideFilter");

  if (sideSelect) {
    sideSelect.value = state.activeTab;
  }

  syncTabs();
  renderFamilies();
}

function toggleAuto() {
  state.auto = !state.auto;

  const button = $("autoBtn");
  if (button) button.textContent = `Auto: ${state.auto ? "ON" : "OFF"}`;

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  if (state.auto) {
    state.timer = setInterval(loadAnalytics, REFRESH_MS);
  }
}

let reloadDebounce = null;

function scheduleReload() {
  if (reloadDebounce) {
    clearTimeout(reloadDebounce);
  }

  reloadDebounce = setTimeout(() => {
    loadAnalytics();
  }, 350);
}

function wireEvents() {
  $("refreshBtn")?.addEventListener("click", () => loadAnalytics());
  $("resetBtn")?.addEventListener("click", resetAnalytics);
  $("autoBtn")?.addEventListener("click", toggleAuto);

  $("apiBtn")?.addEventListener("click", () => {
    window.open(buildApiUrl({ debug: true }), "_blank", "noopener");
  });

  document.querySelectorAll("[data-side], [data-tab]").forEach(button => {
    button.addEventListener("click", () => {
      setTab(button.dataset.side || button.dataset.tab || "ALL");
    });
  });

  const sideSelect = firstEl("sideSelect", "sideFilter");
  const statusSelect = firstEl("statusSelect", "statusFilter");
  const minClosedInput = getMinClosedInput();
  const searchInput = $("searchInput");
  const hideEmptyInput = firstEl("hideEmptyInput", "hideEmpty");

  sideSelect?.addEventListener("change", () => {
    state.activeTab = sideSelect.value || "ALL";
    syncTabs();
    renderFamilies();
  });

  statusSelect?.addEventListener("change", renderFamilies);
  searchInput?.addEventListener("input", renderFamilies);
  hideEmptyInput?.addEventListener("change", renderFamilies);

  minClosedInput?.addEventListener("input", () => {
    renderFamilies();
    renderWinners();
    scheduleReload();
  });

  minClosedInput?.addEventListener("change", () => {
    renderFamilies();
    renderWinners();
    scheduleReload();
  });
}

// ================= DOM ENHANCERS =================

function createMetricCard(id, label, value = "0") {
  const article = document.createElement("article");
  article.className = "metric-card";
  article.innerHTML = `
    <span class="metric-label">${escapeHtml(label)}</span>
    <strong id="${escapeHtml(id)}" class="metric-value">${escapeHtml(value)}</strong>
  `;
  return article;
}

function enhanceMetricGrid() {
  const grid = document.querySelector(".metric-grid");
  if (!grid) return;

  if (!$("mPending")) {
    const closedCard = $("mClosed")?.closest(".metric-card");
    const card = createMetricCard("mPending", "Pending outcome", "0");

    if (closedCard?.nextSibling) {
      grid.insertBefore(card, closedCard.nextSibling);
    } else {
      grid.appendChild(card);
    }
  }

  if (!$("mBreakeven")) {
    const lossesCard = $("mLosses")?.closest(".metric-card");
    const card = createMetricCard("mBreakeven", "Breakeven", "0");

    if (lossesCard?.nextSibling) {
      grid.insertBefore(card, lossesCard.nextSibling);
    } else {
      grid.appendChild(card);
    }
  }
}

function enhanceSourceCards() {
  if ($("sourceStored")) return;

  const heroInner = document.querySelector(".hero-inner") || document.querySelector(".hero");
  if (!heroInner) return;

  const grid = document.createElement("div");
  grid.className = "hero-status-grid";
  grid.innerHTML = `
    <article class="status-card">
      <span>Stored</span>
      <strong id="sourceStored">0</strong>
      <small id="sourceStoredSub">store: n/a</small>
    </article>
    <article class="status-card">
      <span>Latest</span>
      <strong id="sourceLatest">0</strong>
      <small id="sourceLatestSub">latest scan n/a</small>
    </article>
    <article class="status-card">
      <span>Merged</span>
      <strong id="sourceMerged">0</strong>
      <small id="sourceMergedSub">loaded: 0</small>
    </article>
    <article class="status-card">
      <span>Latency</span>
      <strong id="sourceLatency">0ms</strong>
      <small id="sourceLatencySub"></small>
    </article>
  `;

  const statusLine = firstEl("statusLine", "statusText");
  if (statusLine?.nextSibling) {
    heroInner.insertBefore(grid, statusLine.nextSibling);
  } else {
    heroInner.appendChild(grid);
  }
}

function enhanceWinnerPanel() {
  if ($("winnerGrid")) return;

  const familyPanel =
    document.querySelector(".family-panel") ||
    firstEl("familyBody", "familiesBody")?.closest(".panel");

  const panel = document.createElement("section");
  panel.className = "panel winner-panel";
  panel.innerHTML = `
    <div class="table-header">
      <div>
        <h2>Winner families</h2>
        <p class="panel-subtitle">
          Alleen HOT/GOOD/STABLE families met voldoende closed trades en positieve Avg R.
        </p>
      </div>
      <span id="winnerCount">0 winners</span>
    </div>
    <div id="winnerGrid" class="winner-grid"></div>
  `;

  if (familyPanel?.parentNode) {
    familyPanel.parentNode.insertBefore(panel, familyPanel);
  } else {
    document.querySelector("main")?.appendChild(panel);
  }
}

function tableHasHeader(label) {
  const headers = Array.from(document.querySelectorAll(".family-table thead th, table thead th"));
  return headers.some(th => th.textContent.trim().toUpperCase() === label.toUpperCase());
}

function enhanceFamilyTableHeader() {
  if (tableHasHeader("Pending")) return;

  const table =
    firstEl("familyBody", "familiesBody")?.closest("table") ||
    document.querySelector(".family-table");

  const headerRow = table?.querySelector("thead tr");
  if (!headerRow) return;

  const th = document.createElement("th");
  th.textContent = "Pending";

  const headers = Array.from(headerRow.children);
  const openIndex = headers.findIndex(cell => cell.textContent.trim().toUpperCase() === "OPEN");

  if (openIndex >= 0 && headers[openIndex]?.nextSibling) {
    headerRow.insertBefore(th, headers[openIndex].nextSibling);
  } else {
    headerRow.appendChild(th);
  }
}

function enhanceDebugPanel() {
  if ($("debugJson")) return;

  const main = document.querySelector("main");
  if (!main) return;

  const panel = document.createElement("section");
  panel.className = "panel debug-panel";
  panel.innerHTML = `
    <details>
      <summary>Debug payload</summary>
      <pre id="debugJson" class="debug-json"></pre>
    </details>
  `;

  main.appendChild(panel);
}

function enhanceExistingDom() {
  enhanceMetricGrid();
  enhanceSourceCards();
  enhanceWinnerPanel();
  enhanceFamilyTableHeader();
  enhanceDebugPanel();
}

function ensureDom() {
  if ($("familyBody") || $("familiesBody") || $("analyticsApp")) {
    enhanceExistingDom();
    return;
  }

  document.body.innerHTML = `
    <main id="analyticsApp" class="page">
      <section class="hero">
        <div class="hero-inner">
          <div class="hero-copy">
            <p class="eyebrow">TradeSystem Analyzer</p>
            <h1>TradeSystem Analyse</h1>
            <p class="hero-text">
              50 LONG families + 50 SHORT families. Alleen ENTRY/EXIT trades worden geteld.
              Winrate/PnL komt uit closed trades met echte outcome-data per frozen family.
            </p>
          </div>

          <div class="top-actions">
            <button id="refreshBtn" type="button">Refresh</button>
            <button id="autoBtn" type="button">Auto: OFF</button>
            <button id="resetBtn" type="button" class="danger">Reset</button>
            <button id="apiBtn" type="button">API</button>
            <a id="apiLink" href="/api/analyse" target="_blank" rel="noopener">API JSON</a>
          </div>

          <div id="statusLine" class="status-line">Nog niet geladen.</div>

          <div class="hero-status-grid">
            <article class="status-card">
              <span>Stored</span>
              <strong id="sourceStored">0</strong>
              <small id="sourceStoredSub">store: n/a</small>
            </article>
            <article class="status-card">
              <span>Latest</span>
              <strong id="sourceLatest">0</strong>
              <small id="sourceLatestSub">latest scan n/a</small>
            </article>
            <article class="status-card">
              <span>Merged</span>
              <strong id="sourceMerged">0</strong>
              <small id="sourceMergedSub">loaded: 0</small>
            </article>
            <article class="status-card">
              <span>Latency</span>
              <strong id="sourceLatency">0ms</strong>
              <small id="sourceLatencySub"></small>
            </article>
          </div>
        </div>
      </section>

      <section id="errorBox" class="error-box hidden"></section>

      <section class="metric-grid" aria-label="Analyse samenvatting">
        <article class="metric-card"><span class="metric-label">Actions</span><strong id="mActions" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Trades</span><strong id="mTrades" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Open</span><strong id="mOpen" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Closed</span><strong id="mClosed" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Pending outcome</span><strong id="mPending" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Wins</span><strong id="mWins" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Losses</span><strong id="mLosses" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Breakeven</span><strong id="mBreakeven" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Winrate</span><strong id="mWinrate" class="metric-value">0%</strong></article>
        <article class="metric-card"><span class="metric-label">Total R</span><strong id="mTotalR" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Avg R</span><strong id="mAvgR" class="metric-value">0</strong></article>
        <article class="metric-card"><span class="metric-label">Total PnL%</span><strong id="mTotalPnl" class="metric-value">0%</strong></article>
        <article class="metric-card family-card">
          <span class="metric-label">Long families</span>
          <strong id="mLongFamilies" class="metric-value">50</strong>
          <small id="mLongMeta" class="metric-sub">HOT 0 | GOOD 0 | STABLE 0 | BAD 0 | COLLECTING 0 | EMPTY 50</small>
        </article>
        <article class="metric-card family-card">
          <span class="metric-label">Short families</span>
          <strong id="mShortFamilies" class="metric-value">50</strong>
          <small id="mShortMeta" class="metric-sub">HOT 0 | GOOD 0 | STABLE 0 | BAD 0 | COLLECTING 0 | EMPTY 50</small>
        </article>
      </section>

      <section class="panel winner-panel">
        <div class="table-header">
          <div>
            <h2>Winner families</h2>
            <p class="panel-subtitle">
              Alleen HOT/GOOD/STABLE families met voldoende closed trades en positieve Avg R.
            </p>
          </div>
          <span id="winnerCount">0 winners</span>
        </div>
        <div id="winnerGrid" class="winner-grid"></div>
      </section>

      <section class="panel family-panel">
        <div class="tab-row" role="tablist" aria-label="Family side tabs">
          <button type="button" class="tab active" data-side="ALL">All families</button>
          <button type="button" class="tab" data-side="LONG">Long families</button>
          <button type="button" class="tab" data-side="SHORT">Short families</button>
        </div>

        <div class="filter-grid">
          <label class="field">
            <span>Side</span>
            <select id="sideSelect">
              <option value="ALL">ALL</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </label>

          <label class="field">
            <span>Status</span>
            <select id="statusSelect">
              <option value="ALL">ALL</option>
              <option value="HOT">HOT</option>
              <option value="GOOD">GOOD</option>
              <option value="STABLE">STABLE</option>
              <option value="COLLECTING">COLLECTING</option>
              <option value="BAD">BAD</option>
              <option value="EMPTY">EMPTY</option>
            </select>
          </label>

          <label class="field">
            <span>Min closed</span>
            <input id="minClosedInput" type="number" min="0" step="1" value="10" inputmode="numeric" />
          </label>

          <label class="field search-field">
            <span>Search</span>
            <input id="searchInput" type="search" placeholder="LONG_4, MID, COUNTER, DEPTH..." autocomplete="off" />
          </label>

          <label class="check-field">
            <input id="hideEmptyInput" type="checkbox" />
            <span>Hide empty</span>
          </label>
        </div>

        <div class="table-header">
          <h2>Families</h2>
          <span id="familyCount">0 rows</span>
        </div>

        <div class="table-wrap">
          <table class="family-table">
            <thead>
              <tr>
                <th>Family</th>
                <th>Side</th>
                <th>Definition</th>
                <th>Observed</th>
                <th>Trades</th>
                <th>Closed</th>
                <th>Open</th>
                <th>Pending</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Winrate</th>
                <th>Total R</th>
                <th>Avg R</th>
                <th>Total PnL%</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="familyBody">
              <tr>
                <td colspan="15" class="empty-row">Nog geen data geladen.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div id="emptyState" class="empty-state hidden">
          Geen families voor deze filterselectie.
        </div>
      </section>

      <section class="panel filters-panel">
        <div class="table-header">
          <h2>Tracked filters</h2>
          <span id="filterCount">0 labels</span>
        </div>
        <div id="filtersBody" class="filter-chip-grid"></div>
      </section>

      <section class="panel debug-panel">
        <details>
          <summary>Debug payload</summary>
          <pre id="debugJson" class="debug-json"></pre>
        </details>
      </section>
    </main>
  `;
}

document.addEventListener("DOMContentLoaded", async () => {
  ensureDom();
  ensureRuntimeDefaults();
  wireEvents();
  syncTabs();
  await loadAnalytics();
});