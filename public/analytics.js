const API_URL = "/api/analyse";
const REFRESH_MS = 30000;

let state = {
  report: null,
  raw: null,
  activeTab: "ALL",
  auto: false,
  timer: null,
};

function $(id) {
  return document.getElementById(id);
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

function fmtNum(value, decimals = 3) {
  const n = safeNumber(value, 0);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

function fmtPct(value, decimals = 1) {
  const raw = text(value);

  if (raw.includes("%")) return raw;

  return `${fmtNum(value, decimals)}%`;
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

function setStatus(message, isError = false) {
  const status = $("statusText");
  const box = $("errorBox");

  if (status) {
    status.textContent = message || "";
  }

  if (box) {
    box.hidden = !isError;

    if (isError) {
      box.textContent = `Load error:\n${message}`;
    }
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
      families: {
        all: safeArray(families.all || families.ranked),
        long: safeArray(families.long),
        short: safeArray(families.short),
        ranked: safeArray(families.ranked || families.all),
      },
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

function kpi(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function renderSummary() {
  const summary = state.report?.summary || {};

  kpi("kpiActions", fmtNum(summary.actions || 0, 0));
  kpi("kpiTrades", fmtNum(summary.trades || summary.observed || 0, 0));
  kpi("kpiOpen", fmtNum(summary.open || 0, 0));
  kpi("kpiClosed", fmtNum(summary.closed || 0, 0));
  kpi("kpiWins", fmtNum(summary.wins || 0, 0));
  kpi("kpiLosses", fmtNum(summary.losses || 0, 0));
  kpi("kpiWinrate", summary.winrate || fmtPct(summary.winrateNum || 0));
  kpi("kpiTotalR", fmtNum(summary.totalR || 0, 3));
  kpi("kpiAvgR", fmtNum(summary.avgR || 0, 3));
  kpi("kpiPnl", fmtPct(summary.totalPnlPct || 0, 3));

  kpi("kpiLongFamilies", fmtNum(summary.longFamilies || 50, 0));
  kpi("kpiShortFamilies", fmtNum(summary.shortFamilies || 50, 0));

  const longMeta = $("longFamiliesMeta");
  const shortMeta = $("shortFamiliesMeta");

  if (longMeta) {
    const longFamilies = safeArray(state.report?.families?.long);
    const hot = longFamilies.filter(f => f.status === "HOT").length;
    const bad = longFamilies.filter(f => f.status === "BAD").length;
    const collecting = longFamilies.filter(f => f.status === "COLLECTING").length;
    const empty = longFamilies.filter(f => f.status === "EMPTY").length;

    longMeta.textContent = `HOT ${hot} | BAD ${bad} | COLLECTING ${collecting} | EMPTY ${empty}`;
  }

  if (shortMeta) {
    const shortFamilies = safeArray(state.report?.families?.short);
    const hot = shortFamilies.filter(f => f.status === "HOT").length;
    const bad = shortFamilies.filter(f => f.status === "BAD").length;
    const collecting = shortFamilies.filter(f => f.status === "COLLECTING").length;
    const empty = shortFamilies.filter(f => f.status === "EMPTY").length;

    shortMeta.textContent = `HOT ${hot} | BAD ${bad} | COLLECTING ${collecting} | EMPTY ${empty}`;
  }
}

function getSelectedFamilies() {
  const families = state.report?.families || {};
  const sideSelect = $("sideFilter");
  const statusSelect = $("statusFilter");
  const minClosedInput = $("minClosed");
  const searchInput = $("searchInput");
  const hideEmptyInput = $("hideEmpty");

  let rows = safeArray(families.ranked || families.all);

  const side = sideSelect?.value || state.activeTab || "ALL";
  const status = statusSelect?.value || "ALL";
  const minClosed = safeNumber(minClosedInput?.value, 0);
  const query = String(searchInput?.value || "").toUpperCase().trim();
  const hideEmpty = Boolean(hideEmptyInput?.checked);

  if (state.activeTab === "LONG") rows = safeArray(families.long);
  if (state.activeTab === "SHORT") rows = safeArray(families.short);

  if (side === "LONG") rows = rows.filter(row => row.side === "LONG");
  if (side === "SHORT") rows = rows.filter(row => row.side === "SHORT");

  if (status !== "ALL") {
    rows = rows.filter(row => row.status === status);
  }

  if (minClosed > 0) {
    rows = rows.filter(row => safeNumber(row.closed, 0) >= minClosed || safeNumber(row.observed, 0) > 0);
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
        row.definition,
        row.qualityBucket,
        row.marketBucket,
        row.timingBucket,
      ].join(" ").toUpperCase();

      return haystack.includes(query);
    });
  }

  return rows;
}

function renderFamilies() {
  const tbody = $("familiesBody");
  const count = $("familyCount");

  if (!tbody) return;

  const rows = getSelectedFamilies();

  if (count) {
    count.textContent = `${rows.length} families`;
  }

  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="13" class="empty-row">Geen families voor deze filters.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows.map(row => `
    <tr class="status-${text(row.status).toLowerCase()}">
      <td class="mono strong">${row.id}</td>
      <td>${row.side}</td>
      <td class="definition">${row.definition}</td>
      <td>${fmtNum(row.observed, 0)}</td>
      <td>${fmtNum(row.trades, 0)}</td>
      <td>${fmtNum(row.open, 0)}</td>
      <td>${fmtNum(row.closed, 0)}</td>
      <td>${fmtNum(row.wins, 0)}</td>
      <td>${fmtNum(row.losses, 0)}</td>
      <td>${row.winrate || "0%"}</td>
      <td>${fmtNum(row.totalR, 3)}</td>
      <td>${fmtPct(row.totalPnlPct, 3)}</td>
      <td><span class="pill">${row.status}</span></td>
    </tr>
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

function render() {
  if (!state.report) return;

  renderSummary();
  renderFamilies();
  renderApiMeta();
}

async function loadAnalytics() {
  setStatus("Laden...", false);

  const minClosed = safeNumber($("minClosed")?.value, 10);
  const url = `${API_URL}?minClosed=${encodeURIComponent(minClosed)}&debug=true&t=${Date.now()}`;

  try {
    const payload = await fetchJson(url);
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
  }
}

async function resetAnalytics() {
  setStatus("Reset bezig...", false);

  try {
    const payload = await fetchJson(`${API_URL}?reset=true&debug=true&t=${Date.now()}`);

    if (!payload.ok) {
      throw payload;
    }

    await loadAnalytics();
  } catch (error) {
    const message = errorToText(error);
    setStatus(message, true);
    console.error("ANALYTICS RESET ERROR:", error);
  }
}

function setTab(tab) {
  state.activeTab = tab;

  document.querySelectorAll("[data-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });

  const sideFilter = $("sideFilter");

  if (sideFilter) {
    if (tab === "LONG") sideFilter.value = "LONG";
    else if (tab === "SHORT") sideFilter.value = "SHORT";
    else sideFilter.value = "ALL";
  }

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

function wireEvents() {
  $("refreshBtn")?.addEventListener("click", loadAnalytics);
  $("resetBtn")?.addEventListener("click", resetAnalytics);
  $("autoBtn")?.addEventListener("click", toggleAuto);
  $("apiBtn")?.addEventListener("click", () => {
    window.open(`${API_URL}?debug=true`, "_blank");
  });

  document.querySelectorAll("[data-tab]").forEach(button => {
    button.addEventListener("click", () => setTab(button.dataset.tab || "ALL"));
  });

  ["sideFilter", "statusFilter", "minClosed", "searchInput", "hideEmpty"].forEach(id => {
    $(id)?.addEventListener("input", renderFamilies);
    $(id)?.addEventListener("change", renderFamilies);
  });
}

function ensureDom() {
  if ($("analyticsApp")) return;

  document.body.innerHTML = `
    <main id="analyticsApp" class="analytics-app">
      <section class="hero">
        <h1>TradeSystem Analyse</h1>
        <p>50 LONG families + 50 SHORT families. Broad buckets. Closed/open/shadow gescheiden.</p>

        <div class="actions">
          <button id="refreshBtn">Refresh</button>
          <button id="autoBtn">Auto: OFF</button>
          <button id="resetBtn" class="danger">Reset</button>
          <button id="apiBtn">API</button>
        </div>

        <div id="statusText" class="status">Nog niet geladen.</div>
        <pre id="errorBox" class="error-box" hidden></pre>
      </section>

      <section class="kpi-grid">
        <article><span>ACTIONS</span><strong id="kpiActions">0</strong></article>
        <article><span>TRADES</span><strong id="kpiTrades">0</strong></article>
        <article><span>OPEN</span><strong id="kpiOpen">0</strong></article>
        <article><span>CLOSED</span><strong id="kpiClosed">0</strong></article>
        <article><span>WINS</span><strong id="kpiWins">0</strong></article>
        <article><span>LOSSES</span><strong id="kpiLosses">0</strong></article>
        <article><span>WINRATE</span><strong id="kpiWinrate">0%</strong></article>
        <article><span>TOTAL R</span><strong id="kpiTotalR">0</strong></article>
        <article><span>AVG R</span><strong id="kpiAvgR">0</strong></article>
        <article><span>TOTAL PNL%</span><strong id="kpiPnl">0%</strong></article>
        <article>
          <span>LONG FAMILIES</span>
          <strong id="kpiLongFamilies">50</strong>
          <small id="longFamiliesMeta">HOT 0 | BAD 0 | COLLECTING 0 | EMPTY 50</small>
        </article>
        <article>
          <span>SHORT FAMILIES</span>
          <strong id="kpiShortFamilies">50</strong>
          <small id="shortFamiliesMeta">HOT 0 | BAD 0 | COLLECTING 0 | EMPTY 50</small>
        </article>
      </section>

      <section class="panel">
        <div class="tabs">
          <button data-tab="ALL" class="active">All families</button>
          <button data-tab="LONG">Long families</button>
          <button data-tab="SHORT">Short families</button>
        </div>

        <div class="filters">
          <label>
            SIDE
            <select id="sideFilter">
              <option value="ALL">ALL</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </label>

          <label>
            STATUS
            <select id="statusFilter">
              <option value="ALL">ALL</option>
              <option value="HOT">HOT</option>
              <option value="GOOD">GOOD</option>
              <option value="STABLE">STABLE</option>
              <option value="COLLECTING">COLLECTING</option>
              <option value="BAD">BAD</option>
              <option value="EMPTY">EMPTY</option>
            </select>
          </label>

          <label>
            MIN CLOSED
            <input id="minClosed" type="number" value="10" min="0" step="1" />
          </label>

          <label>
            SEARCH
            <input id="searchInput" type="search" placeholder="LONG_4, MID, COUNTER, DEPTH..." />
          </label>

          <label class="check">
            <input id="hideEmpty" type="checkbox" />
            Hide empty
          </label>
        </div>

        <div class="table-head">
          <strong id="familyCount">0 families</strong>
          <span id="apiMeta"></span>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Side</th>
                <th>Definition</th>
                <th>Observed</th>
                <th>Trades</th>
                <th>Open</th>
                <th>Closed</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Winrate</th>
                <th>Total R</th>
                <th>PnL%</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="familiesBody">
              <tr>
                <td colspan="13" class="empty-row">Nog geen data geladen.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  `;
}

document.addEventListener("DOMContentLoaded", async () => {
  ensureDom();
  wireEvents();
  await loadAnalytics();
});