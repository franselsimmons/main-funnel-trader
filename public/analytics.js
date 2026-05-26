const API_URL = "/api/analyse";
const REFRESH_MS = 30000;

const DEFAULT_MIN_CLOSED = 10;
const DEFAULT_MIN_PARENT_CLOSED = 10;
const DEFAULT_MIN_SUB_CLOSED = 8;
const DEFAULT_MIN_MICRO_CLOSED = 6;

let state = {
  report: null,
  raw: null,
  activeTab: "ALL",
  activeMicroLevel: "MICRO",
  auto: false,
  timer: null,
  loading: false,
};

// ================= DOM HELPERS =================

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

function setHidden(el, hidden) {
  if (!el) return;

  el.hidden = Boolean(hidden);
  el.classList.toggle("hidden", Boolean(hidden));
}

function setText(ids, value) {
  const list = Array.isArray(ids) ? ids : [ids];

  for (const id of list) {
    const el = $(id);
    if (el) el.textContent = value;
  }
}

// ================= SAFE HELPERS =================

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function normalizeText(value) {
  return text(value).toUpperCase().trim();
}

function normalizeSide(value) {
  const s = text(value).toUpperCase().trim();

  if (["LONG", "BULL", "BUY"].includes(s)) return "LONG";
  if (["SHORT", "BEAR", "SELL"].includes(s)) return "SHORT";

  return s || "";
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

function sideClass(side) {
  return text(side).toLowerCase();
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

// ================= INPUT HELPERS =================

function getMinClosedInput() {
  return firstEl("minClosedInput", "minClosed");
}

function getMinParentClosedInput() {
  return firstEl("minParentClosedInput", "minParentClosed");
}

function getMinSubClosedInput() {
  return firstEl("minSubClosedInput", "minSubClosed");
}

function getMinMicroClosedInput() {
  return firstEl("minMicroClosedInput", "minMicroClosed");
}

function getMinClosedValue() {
  const input = getMinClosedInput();
  const value = safeNumber(input?.value, DEFAULT_MIN_CLOSED);

  return Math.max(0, Math.round(value));
}

function getMinParentClosedValue() {
  const input = getMinParentClosedInput();
  const value = safeNumber(input?.value, getMinClosedValue() || DEFAULT_MIN_PARENT_CLOSED);

  return Math.max(0, Math.round(value));
}

function getMinSubClosedValue() {
  const input = getMinSubClosedInput();
  const value = safeNumber(input?.value, DEFAULT_MIN_SUB_CLOSED);

  return Math.max(0, Math.round(value));
}

function getMinMicroClosedValue() {
  const input = getMinMicroClosedInput();
  const value = safeNumber(input?.value, DEFAULT_MIN_MICRO_CLOSED);

  return Math.max(0, Math.round(value));
}

function buildApiUrl(extra = {}) {
  const params = new URLSearchParams();

  params.set("source", extra.source || "merged");
  params.set("minClosed", String(getMinClosedValue()));
  params.set("minParentClosed", String(getMinParentClosedValue()));
  params.set("minSubClosed", String(getMinSubClosedValue()));
  params.set("minMicroClosed", String(getMinMicroClosedValue()));
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
  const minParentClosedInput = getMinParentClosedInput();
  const minSubClosedInput = getMinSubClosedInput();
  const minMicroClosedInput = getMinMicroClosedInput();

  if (minClosedInput && (minClosedInput.value === "" || minClosedInput.value === "0")) {
    minClosedInput.value = String(DEFAULT_MIN_CLOSED);
  }

  if (minParentClosedInput && minParentClosedInput.value === "") {
    minParentClosedInput.value = String(DEFAULT_MIN_PARENT_CLOSED);
  }

  if (minSubClosedInput && minSubClosedInput.value === "") {
    minSubClosedInput.value = String(DEFAULT_MIN_SUB_CLOSED);
  }

  if (minMicroClosedInput && minMicroClosedInput.value === "") {
    minMicroClosedInput.value = String(DEFAULT_MIN_MICRO_CLOSED);
  }

  enhanceExistingDom();

  const apiLink = $("apiLink");
  if (apiLink) {
    apiLink.href = buildApiUrl({ debug: true });
  }
}

// ================= PAYLOAD NORMALIZER =================

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

  const microAnalysis =
    payload.microAnalysis ||
    report.microAnalysis ||
    null;

  const bestMicroMain =
    payload.bestMicroMain ||
    report.bestMicroMain ||
    microAnalysis?.bestMicroMain ||
    null;

  const mainDiscordAllowlist =
    safeArray(payload.mainDiscordAllowlist).length
      ? safeArray(payload.mainDiscordAllowlist)
      : safeArray(report.mainDiscordAllowlist).length
        ? safeArray(report.mainDiscordAllowlist)
        : safeArray(microAnalysis?.mainDiscordAllowlist);

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

      microAnalysis,
      bestMicroMain,
      mainDiscordAllowlist,
      microConfig: report.microConfig || {},
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

// ================= MAIN FAMILY RENDER =================

function countStatuses(families) {
  const counts = {
    ELITE: 0,
    HOT: 0,
    GOOD: 0,
    STABLE: 0,
    CANDIDATE: 0,
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
  const selected = sources.selectedEvents ?? raw.tradesLoaded ?? 0;

  setText("sourceStored", fmtNum(sources.storedEvents ?? store.count ?? 0, 0));
  setText("sourceLatest", fmtNum(sources.latestEvents ?? 0, 0));
  setText("sourceMerged", fmtNum(selected, 0));
  setText("sourceLatency", `${fmtNum(raw.latencyMs ?? 0, 0)}ms`);

  setText("sourceStoredSub", store.path ? `store: ${store.path}` : "store: n/a");
  setText("sourceLatestSub", latest.ok ? "latest scan OK" : `latest scan ${latest.error || "missing"}`);
  setText("sourceMergedSub", `loaded: ${fmtNum(selected, 0)}`);
  setText("sourceLatencySub", raw.generatedAt ? new Date(raw.generatedAt).toLocaleString() : "");
}

function getBaseFamilies() {
  const families = state.report?.families || {};

  if (state.activeTab === "LONG") return safeArray(families.long);
  if (state.activeTab === "SHORT") return safeArray(families.short);

  return safeArray(families.ranked || families.all);
}

function getStatusRank(status) {
  const s = normalizeText(status);

  if (s === "ELITE") return 7;
  if (s === "HOT") return 6;
  if (s === "GOOD") return 5;
  if (s === "STABLE") return 4;
  if (s === "CANDIDATE") return 3;
  if (s === "COLLECTING") return 2;
  if (s === "EMPTY") return 1;
  if (s === "BAD") return 0;

  return 0;
}

function sortFamilies(rows) {
  return [...safeArray(rows)].sort((a, b) => {
    const s = getStatusRank(b.status) - getStatusRank(a.status);
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

  if (side === "LONG") rows = rows.filter(row => normalizeSide(row.side) === "LONG");
  if (side === "SHORT") rows = rows.filter(row => normalizeSide(row.side) === "SHORT");

  if (status !== "ALL") {
    rows = rows.filter(row => normalizeText(row.status) === status);
  }

  if (hideEmpty) {
    rows = rows.filter(row => normalizeText(row.status) !== "EMPTY" && safeNumber(row.observed, 0) > 0);
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
    const side = normalizeSide(row.side);
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
          <span class="side-pill ${sideClass(side)}">${escapeHtml(side)}</span>
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
    .filter(row => ["HOT", "GOOD", "STABLE"].includes(normalizeText(row.status)))
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
            <strong>${fmtNum(row.profitFactorR || row.profitFactor || row.pf || 0, 3)}</strong>
          </div>
        </div>

        <p class="winner-definition">${escapeHtml(row.definition)}</p>
      </article>
    `;
  }).join("");
}

// ================= MICRO FAMILY HELPERS =================

function getMicroAnalysis() {
  return state.report?.microAnalysis || null;
}

function getMicroRowId(row) {
  return (
    row?.id ||
    row?.microFamilyId ||
    row?.microId ||
    row?.subFamilyId ||
    row?.subId ||
    row?.parentFamilyId ||
    row?.familyId ||
    row?.name ||
    ""
  );
}

function getMicroParentId(row) {
  return (
    row?.parentFamilyId ||
    row?.parentId ||
    row?.familyId ||
    row?.baseFamilyId ||
    row?.parent ||
    ""
  );
}

function getMicroLevel(row, fallback = "") {
  return normalizeText(row?.level || row?.familyLevel || row?.type || fallback);
}

function getMicroDefinition(row) {
  const labels = safeArray(row?.labels || row?.segments || row?.parts);

  return (
    row?.definition ||
    row?.microDefinition ||
    row?.subDefinition ||
    row?.signature ||
    row?.key ||
    (labels.length ? labels.join(" | ") : "")
  );
}

function getMicroProfitFactor(row) {
  return safeNumber(
    row?.profitFactor ??
      row?.profitFactorR ??
      row?.pf ??
      row?.PF,
    0
  );
}

function getMicroWinrateNum(row) {
  if (row?.winrateNum !== undefined) return safeNumber(row.winrateNum, 0);

  const winrate = text(row?.winrate);
  if (winrate.includes("%")) {
    return safeNumber(winrate.replace("%", ""), 0);
  }

  const closed = safeNumber(row?.closed, 0);
  if (closed <= 0) return 0;

  return (safeNumber(row?.wins, 0) / closed) * 100;
}

function getMicroRows(level = state.activeMicroLevel) {
  const micro = getMicroAnalysis();
  const normalizedLevel = normalizeText(level || "MICRO");

  if (!micro?.ok && !micro) return [];

  if (normalizedLevel === "PARENT") {
    return safeArray(
      micro?.parentFamilies ||
        micro?.parents ||
        micro?.families?.parent ||
        micro?.families?.parents
    );
  }

  if (normalizedLevel === "SUB") {
    return safeArray(
      micro?.subFamilies ||
        micro?.subs ||
        micro?.families?.sub ||
        micro?.families?.subs
    );
  }

  if (normalizedLevel === "ALLOWLIST") {
    return safeArray(state.report?.mainDiscordAllowlist);
  }

  return safeArray(
    micro?.microFamilies ||
      micro?.micros ||
      micro?.families?.micro ||
      micro?.families?.micros
  );
}

function sortMicroRows(rows) {
  return [...safeArray(rows)].sort((a, b) => {
    const statusDiff = getStatusRank(b.status) - getStatusRank(a.status);
    if (statusDiff !== 0) return statusDiff;

    const winrateDiff = getMicroWinrateNum(b) - getMicroWinrateNum(a);
    if (winrateDiff !== 0) return winrateDiff;

    const avgRDiff = safeNumber(b.avgR, 0) - safeNumber(a.avgR, 0);
    if (avgRDiff !== 0) return avgRDiff;

    const pfDiff = getMicroProfitFactor(b) - getMicroProfitFactor(a);
    if (pfDiff !== 0) return pfDiff;

    return safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
  });
}

function getSelectedMicroRows() {
  const sideSelect = firstEl("microSideSelect", "microSideFilter");
  const statusSelect = firstEl("microStatusSelect", "microStatusFilter");
  const searchInput = firstEl("microSearchInput", "microSearch");
  const hideBadInput = firstEl("hideMicroBadInput", "hideMicroBad");

  const side = sideSelect?.value || "ALL";
  const status = statusSelect?.value || "ALL";
  const query = normalizeText(searchInput?.value || "");
  const hideBad = Boolean(hideBadInput?.checked);

  let rows = getMicroRows(state.activeMicroLevel);

  if (side === "LONG") rows = rows.filter(row => normalizeSide(row.side) === "LONG");
  if (side === "SHORT") rows = rows.filter(row => normalizeSide(row.side) === "SHORT");

  if (status !== "ALL") {
    rows = rows.filter(row => normalizeText(row.status) === status);
  }

  if (hideBad) {
    rows = rows.filter(row => !["BAD", "EMPTY"].includes(normalizeText(row.status)));
  }

  if (query) {
    rows = rows.filter(row => {
      const haystack = [
        getMicroRowId(row),
        getMicroParentId(row),
        row.side,
        row.status,
        getMicroLevel(row),
        getMicroDefinition(row),
        row.winrate,
        row.avgR,
        row.totalR,
        row.totalPnlPct,
        row.closed,
        row.tags,
      ].join(" ").toUpperCase();

      return haystack.includes(query);
    });
  }

  return sortMicroRows(rows);
}

function renderMicroSummary() {
  const micro = getMicroAnalysis();
  const best = state.report?.bestMicroMain || {};

  const parentRows = getMicroRows("PARENT");
  const subRows = getMicroRows("SUB");
  const microRows = getMicroRows("MICRO");
  const allowlist = safeArray(state.report?.mainDiscordAllowlist);

  setText("microParentCount", fmtNum(parentRows.length, 0));
  setText("microSubCount", fmtNum(subRows.length, 0));
  setText("microFamilyCount", fmtNum(microRows.length, 0));
  setText("microAllowlistCount", fmtNum(allowlist.length, 0));

  setText("microStatus", micro?.ok ? "READY" : "NOT READY");
  setText("microStatusSub", micro?.ok ? "microfamily analysis active" : (micro?.error || "geen micro-data"));

  setText("bestMicroLongId", getMicroRowId(best?.bestLong) || "-");
  setText("bestMicroShortId", getMicroRowId(best?.bestShort) || "-");
}

function renderBestMicroCard(targetId, row, label) {
  const target = $(targetId);
  if (!target) return;

  if (!row) {
    target.innerHTML = `
      <div class="winner-empty">
        Nog geen ${escapeHtml(label)} micro-winner.
      </div>
    `;
    return;
  }

  const side = normalizeSide(row.side);
  const status = text(row.status, "COLLECTING");
  const pf = getMicroProfitFactor(row);

  target.innerHTML = `
    <article class="winner-card micro ${status.toLowerCase()}">
      <div class="winner-top">
        <span class="winner-id">${escapeHtml(getMicroRowId(row))}</span>
        <span class="side-pill ${sideClass(side)}">${escapeHtml(side)}</span>
        <span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>
      </div>

      <div class="winner-stats">
        <div class="winner-stat">
          <span>Closed</span>
          <strong>${fmtNum(row.closed, 0)}</strong>
        </div>
        <div class="winner-stat">
          <span>Winrate</span>
          <strong>${escapeHtml(row.winrate || fmtPct(getMicroWinrateNum(row), 1))}</strong>
        </div>
        <div class="winner-stat">
          <span>Avg R</span>
          <strong class="${signedClass(row.avgR)}">${fmtNum(row.avgR, 3)}</strong>
        </div>
        <div class="winner-stat">
          <span>PF</span>
          <strong>${fmtNum(pf, 3)}</strong>
        </div>
      </div>

      <p class="winner-definition">${escapeHtml(getMicroDefinition(row))}</p>

      <small class="micro-parent">
        Parent: ${escapeHtml(getMicroParentId(row) || "-")}
      </small>
    </article>
  `;
}

function renderBestMicroMain() {
  const best = state.report?.bestMicroMain || {};

  renderBestMicroCard("bestMicroLong", best.bestLong, "LONG");
  renderBestMicroCard("bestMicroShort", best.bestShort, "SHORT");
}

function renderMicroFamilies() {
  const tbody = $("microFamilyBody");
  const count = $("microFamilyRowsCount");
  const levelLabel = $("microLevelLabel");

  if (!tbody) return;

  const rows = getSelectedMicroRows();

  if (count) {
    count.textContent = `${rows.length} rows`;
  }

  if (levelLabel) {
    levelLabel.textContent = state.activeMicroLevel;
  }

  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="14" class="empty-row">
          Geen microfamilies voor deze selectie.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const id = getMicroRowId(row);
    const parentId = getMicroParentId(row);
    const level = getMicroLevel(row, state.activeMicroLevel);
    const side = normalizeSide(row.side);
    const status = text(row.status, "COLLECTING");
    const totalR = safeNumber(row.totalR, 0);
    const avgR = safeNumber(row.avgR, 0);
    const pnl = safeNumber(row.totalPnlPct, 0);
    const pf = getMicroProfitFactor(row);

    return `
      <tr class="${statusClass(status)}">
        <td>
          <span class="family-id">${escapeHtml(id)}</span>
        </td>
        <td>${escapeHtml(parentId || "-")}</td>
        <td>${escapeHtml(level || "-")}</td>
        <td>
          <span class="side-pill ${sideClass(side)}">${escapeHtml(side)}</span>
        </td>
        <td class="num">${fmtNum(row.observed, 0)}</td>
        <td class="num">${fmtNum(row.trades, 0)}</td>
        <td class="num">${fmtNum(row.closed, 0)}</td>
        <td class="num">${fmtNum(row.wins, 0)}</td>
        <td class="num">${fmtNum(row.losses, 0)}</td>
        <td class="num">${escapeHtml(row.winrate || fmtPct(getMicroWinrateNum(row), 1))}</td>
        <td class="num ${signedClass(totalR)}">${fmtNum(totalR, 3)}</td>
        <td class="num ${signedClass(avgR)}">${fmtNum(avgR, 3)}</td>
        <td class="num">${fmtNum(pf, 3)}</td>
        <td>
          <span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>
        </td>
      </tr>
      <tr class="micro-definition-row">
        <td></td>
        <td colspan="13" class="definition">
          ${escapeHtml(getMicroDefinition(row))}
        </td>
      </tr>
    `;
  }).join("");
}

function renderDiscordAllowlist() {
  const grid = $("allowlistGrid");
  const count = $("allowlistCount");

  if (!grid) return;

  const rows = sortMicroRows(safeArray(state.report?.mainDiscordAllowlist));

  if (count) {
    count.textContent = `${rows.length} allowed`;
  }

  if (!rows.length) {
    grid.innerHTML = `
      <div class="winner-empty">
        Nog geen MAIN Discord allowlist. Microfamilies moeten eerst genoeg closed trades verzamelen.
      </div>
    `;
    return;
  }

  grid.innerHTML = rows.slice(0, 24).map(row => {
    const side = normalizeSide(row.side);
    const status = text(row.status, "STABLE");

    return `
      <article class="allow-card ${status.toLowerCase()}">
        <div class="winner-top">
          <span class="winner-id">${escapeHtml(getMicroRowId(row))}</span>
          <span class="side-pill ${sideClass(side)}">${escapeHtml(side)}</span>
          <span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>
        </div>

        <div class="winner-stats compact">
          <div class="winner-stat">
            <span>Closed</span>
            <strong>${fmtNum(row.closed, 0)}</strong>
          </div>
          <div class="winner-stat">
            <span>WR</span>
            <strong>${escapeHtml(row.winrate || fmtPct(getMicroWinrateNum(row), 1))}</strong>
          </div>
          <div class="winner-stat">
            <span>Avg R</span>
            <strong class="${signedClass(row.avgR)}">${fmtNum(row.avgR, 3)}</strong>
          </div>
        </div>

        <p class="winner-definition">${escapeHtml(getMicroDefinition(row))}</p>
      </article>
    `;
  }).join("");
}

function setMicroLevel(level) {
  state.activeMicroLevel = normalizeText(level || "MICRO");

  const select = $("microLevelSelect");
  if (select) {
    select.value = state.activeMicroLevel;
  }

  document.querySelectorAll("[data-micro-level]").forEach(button => {
    button.classList.toggle("active", normalizeText(button.dataset.microLevel) === state.activeMicroLevel);
  });

  renderMicroFamilies();
}

function renderMicro() {
  renderMicroSummary();
  renderBestMicroMain();
  renderMicroFamilies();
  renderDiscordAllowlist();
}

// ================= FILTERS / DEBUG =================

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
  const selected = sources.selectedEvents ?? raw.tradesLoaded ?? 0;

  meta.textContent = [
    `source ${raw.mode?.source || "merged"}`,
    `stored ${sources.storedEvents ?? 0}`,
    `latest ${sources.latestEvents ?? 0}`,
    `selected ${selected}`,
    `latency ${raw.latencyMs ?? 0}ms`,
  ].join(" | ");
}

function renderDebug() {
  const debugJson = $("debugJson");
  if (!debugJson) return;

  debugJson.textContent = JSON.stringify({
    mode: state.raw?.mode || null,
    sources: state.raw?.sources || null,
    summary: state.report?.summary || null,
    diagnostics: state.report?.diagnostics || null,
    config: state.report?.config || null,
    microConfig: state.report?.microConfig || null,
    bestMicroMain: state.report?.bestMicroMain || null,
    mainDiscordAllowlistCount: safeArray(state.report?.mainDiscordAllowlist).length,
    microAnalysisMeta: {
      ok: state.report?.microAnalysis?.ok ?? null,
      parentFamilies: getMicroRows("PARENT").length,
      subFamilies: getMicroRows("SUB").length,
      microFamilies: getMicroRows("MICRO").length,
    },
  }, null, 2);
}

// ================= MAIN RENDER =================

function render() {
  if (!state.report) return;

  renderSummary();
  renderSourceCards();
  renderWinners();
  renderFamilies();
  renderMicro();
  renderFilters();
  renderApiMeta();
  renderDebug();

  const apiLink = $("apiLink");
  if (apiLink) {
    apiLink.href = buildApiUrl({ debug: true });
  }
}

// ================= LOAD / RESET =================

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

// ================= EVENTS =================

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

  document.querySelectorAll("[data-micro-level]").forEach(button => {
    button.addEventListener("click", () => {
      setMicroLevel(button.dataset.microLevel || "MICRO");
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

  const microLevelSelect = $("microLevelSelect");
  const microSideSelect = firstEl("microSideSelect", "microSideFilter");
  const microStatusSelect = firstEl("microStatusSelect", "microStatusFilter");
  const microSearchInput = firstEl("microSearchInput", "microSearch");
  const hideMicroBadInput = firstEl("hideMicroBadInput", "hideMicroBad");

  microLevelSelect?.addEventListener("change", () => {
    setMicroLevel(microLevelSelect.value || "MICRO");
  });

  microSideSelect?.addEventListener("change", renderMicroFamilies);
  microStatusSelect?.addEventListener("change", renderMicroFamilies);
  microSearchInput?.addEventListener("input", renderMicroFamilies);
  hideMicroBadInput?.addEventListener("change", renderMicroFamilies);

  [
    getMinParentClosedInput(),
    getMinSubClosedInput(),
    getMinMicroClosedInput(),
  ].forEach(input => {
    input?.addEventListener("input", scheduleReload);
    input?.addEventListener("change", scheduleReload);
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

function enhanceMicroPanel() {
  if ($("microFamilyBody")) return;

  const familyPanel =
    document.querySelector(".family-panel") ||
    firstEl("familyBody", "familiesBody")?.closest(".panel");

  const panel = document.createElement("section");
  panel.className = "panel micro-panel";
  panel.innerHTML = `
    <div class="table-header">
      <div>
        <h2>Main Microfamily Analyzer</h2>
        <p class="panel-subtitle">
          Splitst bestaande MAIN families verder op. Doel: beste long/short op winrate, Avg R en PF.
        </p>
      </div>
      <div class="micro-status-box">
        <strong id="microStatus">NOT READY</strong>
        <small id="microStatusSub">geen micro-data</small>
      </div>
    </div>

    <div class="hero-status-grid micro-status-grid">
      <article class="status-card">
        <span>Parent</span>
        <strong id="microParentCount">0</strong>
        <small>oude family-laag</small>
      </article>
      <article class="status-card">
        <span>Sub</span>
        <strong id="microSubCount">0</strong>
        <small>verfijnde setup-laag</small>
      </article>
      <article class="status-card">
        <span>Micro</span>
        <strong id="microFamilyCount">0</strong>
        <small>beste-van-beste laag</small>
      </article>
      <article class="status-card">
        <span>Allowlist</span>
        <strong id="microAllowlistCount">0</strong>
        <small>Discord-ready</small>
      </article>
    </div>

    <div class="micro-best-grid">
      <section>
        <div class="mini-title">
          <span>Best MAIN LONG</span>
          <strong id="bestMicroLongId">-</strong>
        </div>
        <div id="bestMicroLong"></div>
      </section>

      <section>
        <div class="mini-title">
          <span>Best MAIN SHORT</span>
          <strong id="bestMicroShortId">-</strong>
        </div>
        <div id="bestMicroShort"></div>
      </section>
    </div>

    <div class="tab-row micro-tab-row" role="tablist" aria-label="Microfamily level tabs">
      <button type="button" class="tab active" data-micro-level="MICRO">Micro families</button>
      <button type="button" class="tab" data-micro-level="SUB">Sub families</button>
      <button type="button" class="tab" data-micro-level="PARENT">Parent families</button>
      <button type="button" class="tab" data-micro-level="ALLOWLIST">Discord allowlist</button>
    </div>

    <div class="filter-grid micro-filter-grid">
      <label class="field">
        <span>Level</span>
        <select id="microLevelSelect">
          <option value="MICRO">MICRO</option>
          <option value="SUB">SUB</option>
          <option value="PARENT">PARENT</option>
          <option value="ALLOWLIST">ALLOWLIST</option>
        </select>
      </label>

      <label class="field">
        <span>Side</span>
        <select id="microSideSelect">
          <option value="ALL">ALL</option>
          <option value="LONG">LONG</option>
          <option value="SHORT">SHORT</option>
        </select>
      </label>

      <label class="field">
        <span>Status</span>
        <select id="microStatusSelect">
          <option value="ALL">ALL</option>
          <option value="ELITE">ELITE</option>
          <option value="HOT">HOT</option>
          <option value="GOOD">GOOD</option>
          <option value="STABLE">STABLE</option>
          <option value="CANDIDATE">CANDIDATE</option>
          <option value="COLLECTING">COLLECTING</option>
          <option value="BAD">BAD</option>
          <option value="EMPTY">EMPTY</option>
        </select>
      </label>

      <label class="field">
        <span>Parent min</span>
        <input id="minParentClosedInput" type="number" min="0" step="1" value="${DEFAULT_MIN_PARENT_CLOSED}" inputmode="numeric" />
      </label>

      <label class="field">
        <span>Sub min</span>
        <input id="minSubClosedInput" type="number" min="0" step="1" value="${DEFAULT_MIN_SUB_CLOSED}" inputmode="numeric" />
      </label>

      <label class="field">
        <span>Micro min</span>
        <input id="minMicroClosedInput" type="number" min="0" step="1" value="${DEFAULT_MIN_MICRO_CLOSED}" inputmode="numeric" />
      </label>

      <label class="field search-field">
        <span>Search micro</span>
        <input id="microSearchInput" type="search" placeholder="LONG_36, RSI, BTC_REL, HTF..." autocomplete="off" />
      </label>

      <label class="check-field">
        <input id="hideMicroBadInput" type="checkbox" checked />
        <span>Hide bad/empty</span>
      </label>
    </div>

    <div class="table-header">
      <h2><span id="microLevelLabel">MICRO</span> rows</h2>
      <span id="microFamilyRowsCount">0 rows</span>
    </div>

    <div class="table-wrap">
      <table class="family-table micro-family-table">
        <thead>
          <tr>
            <th>Family</th>
            <th>Parent</th>
            <th>Level</th>
            <th>Side</th>
            <th>Observed</th>
            <th>Trades</th>
            <th>Closed</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>Winrate</th>
            <th>Total R</th>
            <th>Avg R</th>
            <th>PF</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="microFamilyBody">
          <tr>
            <td colspan="14" class="empty-row">Nog geen micro-data geladen.</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;

  if (familyPanel?.parentNode) {
    familyPanel.parentNode.insertBefore(panel, familyPanel);
  } else {
    document.querySelector("main")?.appendChild(panel);
  }
}

function enhanceAllowlistPanel() {
  if ($("allowlistGrid")) return;

  const microPanel = document.querySelector(".micro-panel");

  const panel = document.createElement("section");
  panel.className = "panel allowlist-panel";
  panel.innerHTML = `
    <div class="table-header">
      <div>
        <h2>Main Discord allowlist</h2>
        <p class="panel-subtitle">
          Deze lijst gebruik je later als harde doorgang voor je MAIN Discord-signalen.
        </p>
      </div>
      <span id="allowlistCount">0 allowed</span>
    </div>
    <div id="allowlistGrid" class="allowlist-grid"></div>
  `;

  if (microPanel?.parentNode) {
    microPanel.parentNode.insertBefore(panel, microPanel.nextSibling);
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
  enhanceMicroPanel();
  enhanceAllowlistPanel();
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
              50 LONG families + 50 SHORT families. Elke trade wordt op entry vastgezet in één frozen filter-family.
              Microfamilies splitsen deze families verder op voor betere MAIN signal filtering.
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

  enhanceExistingDom();
}

// ================= BOOT =================

document.addEventListener("DOMContentLoaded", async () => {
  ensureDom();
  ensureRuntimeDefaults();
  wireEvents();
  syncTabs();
  setMicroLevel("MICRO");
  await loadAnalytics();
});