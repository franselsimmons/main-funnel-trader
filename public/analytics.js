const API_URL = "/api/analyse";
const AUTO_REFRESH_MS = 30_000;

const state = {
  raw: null,
  report: null,
  families: [],
  activeSide: "ALL",
  auto: false,
  timer: null,
};

const $ = (id) => document.getElementById(id);

const dom = {
  refreshBtn: $("refreshBtn"),
  autoBtn: $("autoBtn"),
  resetBtn: $("resetBtn"),
  apiLink: $("apiLink"),
  statusLine: $("statusLine"),
  errorBox: $("errorBox"),

  mActions: $("mActions"),
  mTrades: $("mTrades"),
  mOpen: $("mOpen"),
  mClosed: $("mClosed"),
  mWins: $("mWins"),
  mLosses: $("mLosses"),
  mWinrate: $("mWinrate"),
  mTotalR: $("mTotalR"),
  mAvgR: $("mAvgR"),
  mTotalPnl: $("mTotalPnl"),
  mLongFamilies: $("mLongFamilies"),
  mLongMeta: $("mLongMeta"),
  mShortFamilies: $("mShortFamilies"),
  mShortMeta: $("mShortMeta"),

  tabAll: $("tabAll"),
  tabLong: $("tabLong"),
  tabShort: $("tabShort"),

  sideSelect: $("sideSelect"),
  statusSelect: $("statusSelect"),
  minClosedInput: $("minClosedInput"),
  searchInput: $("searchInput"),
  hideEmptyInput: $("hideEmptyInput"),

  familyCount: $("familyCount"),
  familyBody: $("familyBody"),
  emptyState: $("emptyState"),

  filterCount: $("filterCount"),
  filtersBody: $("filtersBody"),
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;

  if (typeof value === "string") {
    const cleaned = value.replace("%", "").replace(",", ".").trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstNumber(values, fallback = 0) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;

    const n = safeNumber(value, NaN);
    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function firstString(values, fallback = "") {
  for (const value of values) {
    if (value === null || value === undefined) continue;

    const s = String(value).trim();
    if (s) return s;
  }

  return fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function round(value, digits = 3) {
  const n = safeNumber(value, 0);
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function fmtNumber(value, digits = 3) {
  const n = round(value, digits);

  if (Object.is(n, -0)) return "0";
  if (Number.isInteger(n)) return String(n);

  return String(n);
}

function fmtPct(value, digits = 1) {
  if (typeof value === "string" && value.trim().endsWith("%")) {
    const n = safeNumber(value, 0);
    return `${fmtNumber(n, digits)}%`;
  }

  return `${fmtNumber(value, digits)}%`;
}

function normalizeSide(value, id = "") {
  const raw = String(value || "").trim().toUpperCase();

  if (["LONG", "BULL", "BUY"].includes(raw)) return "LONG";
  if (["SHORT", "BEAR", "SELL"].includes(raw)) return "SHORT";

  const familyId = String(id || "").toUpperCase();

  if (familyId.startsWith("LONG_")) return "LONG";
  if (familyId.startsWith("SHORT_")) return "SHORT";

  return "UNKNOWN";
}

function normalizeStatus(value, family) {
  const raw = String(value || "").trim().toUpperCase();

  if (["HOT", "GOOD", "STABLE", "COLLECTING", "BAD", "EMPTY"].includes(raw)) {
    return raw;
  }

  if (safeNumber(family?.observed, 0) <= 0 && safeNumber(family?.trades, 0) <= 0) {
    return "EMPTY";
  }

  if (safeNumber(family?.closed, 0) <= 0) {
    return "COLLECTING";
  }

  const winrate = safeNumber(family?.winrateNum, 0);
  const totalR = safeNumber(family?.totalR, 0);

  if (winrate >= 60 && totalR > 0) return "GOOD";
  if (winrate >= 45 && totalR >= 0) return "STABLE";

  return "BAD";
}

function parseDefinition(value, fallback = "") {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean).join(" | ");
  }

  const s = String(value || "").trim();
  return s || fallback;
}

function normalizeFamily(input, index = 0) {
  const src = safeObject(input);

  const id = firstString(
    [
      src.id,
      src.family,
      src.familyId,
      src.name,
      src.key,
      src.bucket,
      src.label,
    ],
    `FAMILY_${index + 1}`
  ).toUpperCase();

  const side = normalizeSide(src.side ?? src.direction, id);

  const definition = parseDefinition(
    src.definition ??
      src.familyDefinition ??
      src.filters ??
      src.filterLabels ??
      src.bucketDefinition ??
      src.key,
    id
  );

  const observed = firstNumber(
    [
      src.observed,
      src.actions,
      src.actionCount,
      src.seen,
      src.count,
      src.total,
      src.totalCount,
      src.samples,
    ],
    0
  );

  const trades = firstNumber(
    [
      src.trades,
      src.tradeCount,
      src.executed,
      src.executedTrades,
      src.totalTrades,
      observed,
    ],
    0
  );

  const closed = firstNumber(
    [
      src.closed,
      src.closedTrades,
      src.completed,
      src.completedTrades,
      src.finished,
    ],
    0
  );

  const open = firstNumber(
    [
      src.open,
      src.openTrades,
      src.active,
      src.activeTrades,
    ],
    0
  );

  const wins = firstNumber([src.wins, src.win, src.tp, src.tpCount], 0);
  const losses = firstNumber([src.losses, src.loss, src.sl, src.slCount], 0);

  const winrateNum = firstNumber(
    [
      src.winrateNum,
      src.winRateNum,
      src.winratePct,
      src.winRatePct,
      src.winrate,
      src.winRate,
      closed > 0 ? (wins / closed) * 100 : 0,
    ],
    0
  );

  const totalR = firstNumber([src.totalR, src.rTotal, src.sumR, src.pnlR], 0);
  const avgR = firstNumber(
    [
      src.avgR,
      src.averageR,
      src.meanR,
      closed > 0 ? totalR / closed : 0,
    ],
    0
  );

  const totalPnlPct = firstNumber(
    [
      src.totalPnlPct,
      src.totalPnLPct,
      src.pnlPct,
      src.totalPnl,
      src.pnl,
    ],
    0
  );

  const avgPnlPct = firstNumber(
    [
      src.avgPnlPct,
      src.averagePnlPct,
      closed > 0 ? totalPnlPct / closed : 0,
    ],
    0
  );

  const family = {
    raw: src,
    id,
    side,
    index: safeNumber(src.index, index + 1),
    definition,
    observed,
    trades,
    closed,
    open,
    wins,
    losses,
    winrateNum,
    winrate: fmtPct(winrateNum, 1),
    totalR,
    avgR,
    totalPnlPct,
    avgPnlPct,
    qualityBucket: src.qualityBucket || "",
    marketBucket: src.marketBucket || "",
    timingBucket: src.timingBucket || "",
  };

  family.status = normalizeStatus(src.status, family);

  return family;
}

function extractFamilies(report) {
  const familiesNode = report?.families;

  if (Array.isArray(familiesNode)) {
    return familiesNode.map(normalizeFamily);
  }

  const f = safeObject(familiesNode);

  const all = [
    ...safeArray(f.all),
    ...safeArray(f.long),
    ...safeArray(f.short),
    ...safeArray(f.LONG),
    ...safeArray(f.SHORT),
  ];

  if (all.length) {
    const seen = new Set();

    return all
      .map(normalizeFamily)
      .filter((family) => {
        const key = `${family.id}_${family.side}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  return safeArray(report?.familyStats).map(normalizeFamily);
}

function unwrapPayload(payload) {
  const root = safeObject(payload);

  const report =
    root.report && typeof root.report === "object"
      ? root.report
      : root.data?.report && typeof root.data.report === "object"
        ? root.data.report
        : root;

  const families = extractFamilies(report);

  return {
    raw: root,
    report,
    families,
  };
}

function sideStats(families, side) {
  const rows = families.filter((family) => family.side === side);

  const count = (statuses) => {
    const wanted = new Set(statuses);
    return rows.filter((family) => wanted.has(family.status)).length;
  };

  return {
    total: rows.length,
    hot: count(["HOT", "GOOD"]),
    stable: count(["STABLE"]),
    bad: count(["BAD"]),
    collecting: count(["COLLECTING"]),
    empty: count(["EMPTY"]),
  };
}

function aggregateFromFamilies(families) {
  const closed = families.reduce((sum, family) => sum + safeNumber(family.closed, 0), 0);
  const open = families.reduce((sum, family) => sum + safeNumber(family.open, 0), 0);
  const trades = families.reduce((sum, family) => sum + safeNumber(family.trades, 0), 0);
  const observed = families.reduce((sum, family) => sum + safeNumber(family.observed, 0), 0);
  const wins = families.reduce((sum, family) => sum + safeNumber(family.wins, 0), 0);
  const losses = families.reduce((sum, family) => sum + safeNumber(family.losses, 0), 0);
  const totalR = families.reduce((sum, family) => sum + safeNumber(family.totalR, 0), 0);
  const totalPnlPct = families.reduce((sum, family) => sum + safeNumber(family.totalPnlPct, 0), 0);

  return {
    actions: observed,
    trades,
    open,
    closed,
    wins,
    losses,
    winrateNum: closed > 0 ? (wins / closed) * 100 : 0,
    totalR,
    avgR: closed > 0 ? totalR / closed : 0,
    totalPnlPct,
  };
}

function metric(summary, fallback, keys) {
  return firstNumber(keys.map((key) => summary?.[key]), fallback);
}

function renderSummary() {
  const report = safeObject(state.report);
  const summary = safeObject(report.summary);
  const fallback = aggregateFromFamilies(state.families);

  const longStats = sideStats(state.families, "LONG");
  const shortStats = sideStats(state.families, "SHORT");

  const actions = metric(summary, fallback.actions, ["actions", "observed", "signals"]);
  const trades = metric(summary, fallback.trades, ["trades", "tradeCount"]);
  const open = metric(summary, fallback.open, ["open", "openTrades"]);
  const closed = metric(summary, fallback.closed, ["closed", "closedTrades"]);
  const wins = metric(summary, fallback.wins, ["wins"]);
  const losses = metric(summary, fallback.losses, ["losses"]);
  const winrateNum = metric(summary, fallback.winrateNum, ["winrateNum", "winRateNum", "winrate", "winRate"]);
  const totalR = metric(summary, fallback.totalR, ["totalR", "sumR"]);
  const avgR = metric(summary, fallback.avgR, ["avgR", "averageR"]);
  const totalPnlPct = metric(summary, fallback.totalPnlPct, ["totalPnlPct", "totalPnLPct", "pnlPct"]);

  dom.mActions.textContent = fmtNumber(actions, 0);
  dom.mTrades.textContent = fmtNumber(trades, 0);
  dom.mOpen.textContent = fmtNumber(open, 0);
  dom.mClosed.textContent = fmtNumber(closed, 0);
  dom.mWins.textContent = fmtNumber(wins, 0);
  dom.mLosses.textContent = fmtNumber(losses, 0);
  dom.mWinrate.textContent = fmtPct(winrateNum, 1);
  dom.mTotalR.textContent = fmtNumber(totalR, 3);
  dom.mAvgR.textContent = fmtNumber(avgR, 3);
  dom.mTotalPnl.textContent = fmtPct(totalPnlPct, 3);

  dom.mLongFamilies.textContent = fmtNumber(longStats.total, 0);
  dom.mLongMeta.textContent =
    `HOT ${longStats.hot} | STABLE ${longStats.stable} | BAD ${longStats.bad} | COLLECTING ${longStats.collecting} | EMPTY ${longStats.empty}`;

  dom.mShortFamilies.textContent = fmtNumber(shortStats.total, 0);
  dom.mShortMeta.textContent =
    `HOT ${shortStats.hot} | STABLE ${shortStats.stable} | BAD ${shortStats.bad} | COLLECTING ${shortStats.collecting} | EMPTY ${shortStats.empty}`;
}

function statusRank(status) {
  const ranks = {
    HOT: 1,
    GOOD: 1,
    STABLE: 2,
    COLLECTING: 3,
    BAD: 4,
    EMPTY: 5,
  };

  return ranks[status] || 9;
}

function filteredFamilies() {
  const side = String(dom.sideSelect.value || "ALL").toUpperCase();
  const status = String(dom.statusSelect.value || "ALL").toUpperCase();
  const minClosed = Math.max(0, safeNumber(dom.minClosedInput.value, 0));
  const q = String(dom.searchInput.value || "").trim().toLowerCase();
  const hideEmpty = Boolean(dom.hideEmptyInput.checked);

  return state.families
    .filter((family) => {
      if (side !== "ALL" && family.side !== side) return false;
      if (status !== "ALL" && family.status !== status) return false;
      if (minClosed > 0 && safeNumber(family.closed, 0) < minClosed) return false;
      if (hideEmpty && family.status === "EMPTY") return false;

      if (!q) return true;

      const haystack = [
        family.id,
        family.side,
        family.status,
        family.definition,
        family.qualityBucket,
        family.marketBucket,
        family.timingBucket,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(q);
    })
    .sort((a, b) => {
      const statusDiff = statusRank(a.status) - statusRank(b.status);
      if (statusDiff !== 0) return statusDiff;

      const closedDiff = safeNumber(b.closed, 0) - safeNumber(a.closed, 0);
      if (closedDiff !== 0) return closedDiff;

      const observedDiff = safeNumber(b.observed, 0) - safeNumber(a.observed, 0);
      if (observedDiff !== 0) return observedDiff;

      const totalRDiff = safeNumber(b.totalR, 0) - safeNumber(a.totalR, 0);
      if (totalRDiff !== 0) return totalRDiff;

      return a.id.localeCompare(b.id, "en", { numeric: true });
    });
}

function sideClass(side) {
  if (side === "LONG") return "long";
  if (side === "SHORT") return "short";
  return "";
}

function statusClass(status) {
  return `status-${String(status || "").toLowerCase()}`;
}

function renderFamilies() {
  const rows = filteredFamilies();

  dom.familyCount.textContent = `${rows.length} rows`;
  dom.emptyState.classList.toggle("hidden", rows.length > 0);

  dom.familyBody.innerHTML = rows
    .map((family) => {
      return `
        <tr>
          <td><span class="family-id">${escapeHtml(family.id)}</span></td>
          <td><span class="side-pill ${sideClass(family.side)}">${escapeHtml(family.side)}</span></td>
          <td class="definition">${escapeHtml(family.definition)}</td>
          <td class="num">${fmtNumber(family.observed, 0)}</td>
          <td class="num">${fmtNumber(family.trades, 0)}</td>
          <td class="num">${fmtNumber(family.closed, 0)}</td>
          <td class="num">${fmtNumber(family.open, 0)}</td>
          <td class="num">${fmtNumber(family.wins, 0)}</td>
          <td class="num">${fmtNumber(family.losses, 0)}</td>
          <td class="num">${escapeHtml(family.winrate)}</td>
          <td class="num">${fmtNumber(family.totalR, 3)}</td>
          <td class="num">${fmtNumber(family.avgR, 3)}</td>
          <td class="num">${fmtPct(family.totalPnlPct, 3)}</td>
          <td><span class="status-pill ${statusClass(family.status)}">${escapeHtml(family.status)}</span></td>
        </tr>
      `;
    })
    .join("");
}

function extractFilterLabels() {
  const counts = new Map();

  for (const family of state.families) {
    const parts = String(family.definition || "")
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);

    for (const part of parts) {
      counts.set(part, (counts.get(part) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => {
      const diff = b.count - a.count;
      if (diff !== 0) return diff;
      return a.label.localeCompare(b.label);
    });
}

function renderTrackedFilters() {
  const labels = extractFilterLabels();

  dom.filterCount.textContent = `${labels.length} labels`;

  dom.filtersBody.innerHTML = labels
    .map((item) => {
      return `
        <span class="filter-chip">
          ${escapeHtml(item.label)}
          <b>${fmtNumber(item.count, 0)}</b>
        </span>
      `;
    })
    .join("");
}

function setActiveSide(side) {
  const normalized = ["ALL", "LONG", "SHORT"].includes(side) ? side : "ALL";

  state.activeSide = normalized;
  dom.sideSelect.value = normalized;

  for (const btn of [dom.tabAll, dom.tabLong, dom.tabShort]) {
    btn.classList.toggle("active", btn.dataset.side === normalized);
  }

  renderFamilies();
}

function clearError() {
  dom.errorBox.textContent = "";
  dom.errorBox.classList.add("hidden");
}

function showError(error) {
  const message =
    error?.message ||
    error?.error ||
    (typeof error === "string" ? error : JSON.stringify(error, null, 2)) ||
    "Unknown error";

  dom.errorBox.textContent = `Load error:\n${message}`;
  dom.errorBox.classList.remove("hidden");
  dom.statusLine.textContent = "Laden mislukt.";
}

function formatDateTime(value) {
  const raw = value || Date.now();
  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) return String(raw);

  return date.toLocaleString("nl-NL", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  const text = await res.text();

  let json = null;

  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${url}. HTTP ${res.status}. Body: ${text.slice(0, 260)}`);
  }

  if (!res.ok) {
    throw new Error(json?.error || json?.message || `HTTP ${res.status}`);
  }

  if (json?.ok === false) {
    throw new Error(json?.error || json?.message || "API returned ok=false");
  }

  return json;
}

async function load() {
  clearError();

  dom.statusLine.textContent = "Laden...";
  dom.refreshBtn.disabled = true;

  try {
    const payload = await fetchJson(`${API_URL}?_=${Date.now()}`);
    const normalized = unwrapPayload(payload);

    state.raw = normalized.raw;
    state.report = normalized.report;
    state.families = normalized.families;

    renderSummary();
    renderFamilies();
    renderTrackedFilters();

    const generatedAt =
      normalized.report?.generatedAt ||
      normalized.raw?.generatedAt ||
      normalized.report?.updatedAt ||
      normalized.raw?.updatedAt ||
      Date.now();

    dom.statusLine.textContent = `Laatste update: ${formatDateTime(generatedAt)}`;
  } catch (error) {
    console.error("ANALYTICS LOAD ERROR:", error);
    showError(error);
  } finally {
    dom.refreshBtn.disabled = false;
  }
}

function resetFilters() {
  dom.statusSelect.value = "ALL";
  dom.minClosedInput.value = "0";
  dom.searchInput.value = "";
  dom.hideEmptyInput.checked = false;

  setActiveSide("ALL");
  renderFamilies();
}

function toggleAuto() {
  state.auto = !state.auto;

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  if (state.auto) {
    state.timer = setInterval(load, AUTO_REFRESH_MS);
  }

  dom.autoBtn.textContent = state.auto ? "Auto: ON" : "Auto: OFF";
}

function bindEvents() {
  dom.refreshBtn.addEventListener("click", load);
  dom.resetBtn.addEventListener("click", resetFilters);
  dom.autoBtn.addEventListener("click", toggleAuto);

  dom.tabAll.addEventListener("click", () => setActiveSide("ALL"));
  dom.tabLong.addEventListener("click", () => setActiveSide("LONG"));
  dom.tabShort.addEventListener("click", () => setActiveSide("SHORT"));

  dom.sideSelect.addEventListener("change", () => setActiveSide(dom.sideSelect.value));

  dom.statusSelect.addEventListener("change", renderFamilies);
  dom.minClosedInput.addEventListener("input", renderFamilies);
  dom.searchInput.addEventListener("input", renderFamilies);
  dom.hideEmptyInput.addEventListener("change", renderFamilies);
}

bindEvents();
load();