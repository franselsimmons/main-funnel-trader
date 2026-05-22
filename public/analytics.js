// public/analytics.js

(() => {
  const state = {
    report: null,
    tab: "families",
    auto: false,
    timer: null,
  };

  const $ = (id) => document.getElementById(id);

  const fmt = {
    int(value) {
      const n = Number(value || 0);
      return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    },

    num(value, decimals = 3) {
      const n = Number(value || 0);
      return n.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
      });
    },

    pct(value) {
      if (typeof value === "string") return value;
      const n = Number(value || 0);
      return `${(n * 100).toFixed(1)}%`;
    },
  };

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value);
  }

  function setError(message = "") {
    const box = $("errorBox");
    if (!box) return;

    if (!message) {
      box.textContent = "";
      box.classList.remove("show");
      return;
    }

    box.textContent = message;
    box.classList.add("show");
  }

  function setStatus(message) {
    setText("statusLine", message);
  }

  function normalizeReport(payload) {
    const report = payload?.report || payload?.data?.report || payload?.data || payload;

    if (!report || typeof report !== "object") {
      throw new Error("API response mist report object.");
    }

    const familiesObject = report.families || {};
    const allFamilies = Array.isArray(familiesObject.all)
      ? familiesObject.all
      : [
          ...(Array.isArray(familiesObject.long) ? familiesObject.long : []),
          ...(Array.isArray(familiesObject.short) ? familiesObject.short : []),
        ];

    const longFamilies = Array.isArray(familiesObject.long)
      ? familiesObject.long
      : allFamilies.filter((family) => family.side === "LONG");

    const shortFamilies = Array.isArray(familiesObject.short)
      ? familiesObject.short
      : allFamilies.filter((family) => family.side === "SHORT");

    const summary = report.summary || buildSummary(allFamilies);

    return {
      ...report,
      summary,
      families: {
        all: allFamilies,
        long: longFamilies,
        short: shortFamilies,
      },
      filterKeys: Array.isArray(report.filterKeys) ? report.filterKeys : [],
      trades: {
        total: Number(report.trades?.total || report.trades?.items?.length || 0),
        items: Array.isArray(report.trades?.items) ? report.trades.items : [],
      },
    };
  }

  function buildSummary(families = []) {
    const summary = {
      actions: 0,
      trades: 0,
      observed: 0,
      open: 0,
      closed: 0,
      wins: 0,
      losses: 0,
      winrate: "0.0%",
      totalR: 0,
      avgR: 0,
      totalPnlPct: 0,
      avgPnlPct: 0,
      longFamilies: 0,
      shortFamilies: 0,
      hotFamilies: 0,
      stableFamilies: 0,
      badFamilies: 0,
      collectingFamilies: 0,
      emptyFamilies: 0,
    };

    for (const family of families) {
      summary.actions += Number(family.actions || 0);
      summary.trades += Number(family.trades || 0);
      summary.observed += Number(family.observed || 0);
      summary.open += Number(family.open || 0);
      summary.closed += Number(family.closed || 0);
      summary.wins += Number(family.wins || 0);
      summary.losses += Number(family.losses || 0);
      summary.totalR += Number(family.totalR || 0);
      summary.totalPnlPct += Number(family.totalPnlPct || 0);

      if (family.side === "LONG") summary.longFamilies += 1;
      if (family.side === "SHORT") summary.shortFamilies += 1;

      if (family.status === "HOT") summary.hotFamilies += 1;
      if (family.status === "STABLE") summary.stableFamilies += 1;
      if (family.status === "BAD") summary.badFamilies += 1;
      if (family.status === "COLLECTING") summary.collectingFamilies += 1;
      if (family.status === "EMPTY") summary.emptyFamilies += 1;
    }

    const completed = summary.wins + summary.losses;
    summary.winrate = completed > 0
      ? `${((summary.wins / completed) * 100).toFixed(1)}%`
      : "0.0%";

    summary.avgR = summary.closed > 0 ? summary.totalR / summary.closed : 0;
    summary.avgPnlPct = summary.closed > 0 ? summary.totalPnlPct / summary.closed : 0;

    return summary;
  }

  function getMinClosed() {
    return Math.max(1, Number($("minClosedInput")?.value || 10));
  }

  function getApiUrl() {
    const minClosed = getMinClosed();
    return `/api/analyse?minClosed=${encodeURIComponent(minClosed)}`;
  }

  async function loadReport() {
    setError("");
    setStatus("Laden...");

    const apiUrl = getApiUrl();
    const apiLink = $("apiLink");

    if (apiLink) apiLink.href = apiUrl;

    const response = await fetch(`${apiUrl}&t=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    const text = await response.text();

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`API gaf geen JSON terug.\nStatus: ${response.status}\nBody: ${text.slice(0, 500)}`);
    }

    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || payload?.message || `API error ${response.status}`);
    }

    state.report = normalizeReport(payload);
    window.__ANALYZE_REPORT__ = state.report;

    renderAll();

    const generatedAt = state.report.generatedAt
      ? new Date(state.report.generatedAt).toLocaleString()
      : new Date().toLocaleString();

    setStatus(`Laatste update: ${generatedAt}`);
  }

  async function safeLoadReport() {
    try {
      await loadReport();
    } catch (error) {
      setError(`Load error: ${error?.message || error}`);
      setStatus("Laden mislukt.");
      renderAll();
    }
  }

  function renderSummary() {
    const summary = state.report?.summary || {};

    setText("sumActions", fmt.int(summary.actions));
    setText("sumTrades", fmt.int(summary.trades));
    setText("sumOpen", fmt.int(summary.open));
    setText("sumClosed", fmt.int(summary.closed));
    setText("sumWins", fmt.int(summary.wins));
    setText("sumLosses", fmt.int(summary.losses));
    setText("sumWinrate", summary.winrate || "0.0%");
    setText("sumTotalR", fmt.num(summary.totalR, 3));
    setText("sumAvgR", fmt.num(summary.avgR, 3));
    setText("sumTotalPnl", `${fmt.num(summary.totalPnlPct, 3)}%`);
    setText("sumLongFamilies", fmt.int(summary.longFamilies));
    setText("sumShortFamilies", fmt.int(summary.shortFamilies));

    setText(
      "sumLongSub",
      `HOT ${summary.hotFamilies || 0} | BAD ${summary.badFamilies || 0}`
    );

    setText(
      "sumShortSub",
      `COLLECTING ${summary.collectingFamilies || 0} | EMPTY ${summary.emptyFamilies || 0}`
    );
  }

  function getBaseFamilies() {
    const families = state.report?.families || {
      all: [],
      long: [],
      short: [],
    };

    if (state.tab === "long") return families.long || [];
    if (state.tab === "short") return families.short || [];

    return families.all || [];
  }

  function getFilteredFamilies() {
    const search = String($("familySearch")?.value || "").trim().toUpperCase();
    const side = $("sideFilter")?.value || "ALL";
    const status = $("statusFilter")?.value || "ALL";
    const hideEmpty = Boolean($("hideEmptyInput")?.checked);
    const minClosed = Math.max(0, Number($("minClosedInput")?.value || 0));

    return getBaseFamilies().filter((family) => {
      if (side !== "ALL" && family.side !== side) return false;
      if (status !== "ALL" && family.status !== status) return false;
      if (hideEmpty && family.status === "EMPTY") return false;
      if (minClosed > 0 && Number(family.closed || 0) > 0 && Number(family.closed || 0) < minClosed) {
        return false;
      }

      if (!search) return true;

      const haystack = [
        family.id,
        family.side,
        family.status,
        family.definition,
        ...Object.values(family.buckets || {}),
      ]
        .join(" ")
        .toUpperCase();

      return haystack.includes(search);
    });
  }

  function familyRow(family) {
    const statusClass = `status-${family.status || "EMPTY"}`;

    return `
      <tr>
        <td class="family-id">${escapeHtml(family.id)}</td>
        <td>${escapeHtml(family.side)}</td>
        <td class="definition">${escapeHtml(family.definition)}</td>
        <td class="num">${fmt.int(family.observed)}</td>
        <td class="num">${fmt.int(family.trades)}</td>
        <td class="num">${fmt.int(family.open)}</td>
        <td class="num">${fmt.int(family.closed)}</td>
        <td class="num">${fmt.int(family.wins)}</td>
        <td class="num">${fmt.int(family.losses)}</td>
        <td class="num">${escapeHtml(family.winrate || "0.0%")}</td>
        <td class="num">${fmt.num(family.totalR, 3)}</td>
        <td class="num">${fmt.num(family.avgR, 3)}</td>
        <td class="num">${fmt.num(family.totalPnlPct, 3)}%</td>
        <td class="num">${escapeHtml(family.directSLPct || "0.0%")}</td>
        <td><span class="status-pill ${statusClass}">${escapeHtml(family.status || "EMPTY")}</span></td>
      </tr>
    `;
  }

  function renderFamilies() {
    const body = $("familiesBody");
    const families = getFilteredFamilies();

    if (!body) return;

    body.innerHTML = families.length
      ? families.map(familyRow).join("")
      : `<tr><td colspan="15">Geen families gevonden.</td></tr>`;

    const title = state.tab === "long"
      ? "LONG families"
      : state.tab === "short"
        ? "SHORT families"
        : "All families";

    setText("panelTitle", title);
    setText("panelMeta", `${families.length} zichtbaar`);
  }

  function renderFilters() {
    const holder = $("filterChips");
    if (!holder) return;

    const families = state.report?.families?.all || [];
    const values = new Set();

    for (const key of state.report?.filterKeys || []) {
      values.add(key);
    }

    for (const family of families) {
      for (const value of Object.values(family.buckets || {})) {
        values.add(value);
      }
    }

    holder.innerHTML = [...values]
      .filter(Boolean)
      .sort()
      .map((value) => `<span class="chip">${escapeHtml(value)}</span>`)
      .join("");
  }

  function renderTrades() {
    const body = $("tradesBody");
    if (!body) return;

    const trades = state.report?.trades?.items || [];

    setText("tradesMeta", `${trades.length} recent getoond`);

    body.innerHTML = trades.length
      ? trades.map((trade) => `
          <tr>
            <td>${escapeHtml(trade.symbol || "")}</td>
            <td>${escapeHtml(trade.side || "")}</td>
            <td class="family-id">${escapeHtml(trade.familyId || "")}</td>
            <td>${escapeHtml(trade.status || "")}</td>
            <td class="num">${fmt.num(trade.r, 3)}</td>
            <td class="num">${fmt.num(trade.pnlPct, 3)}%</td>
            <td class="num">${fmt.num(trade.confluence, 2)}</td>
            <td class="num">${fmt.num(trade.sniper, 2)}</td>
            <td class="num">${fmt.num(trade.rr, 3)}</td>
            <td class="num">${fmt.num(trade.score, 2)}</td>
            <td class="num">${fmt.num(trade.spreadBps, 2)}</td>
            <td class="num">${fmt.int(trade.depthUsd)}</td>
            <td>${escapeHtml(trade.createdAt || "")}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="13">Geen recente trades in report.</td></tr>`;
  }

  function renderPanels() {
    const familiesPanel = $("familiesPanel");
    const filtersPanel = $("filtersPanel");
    const tradesPanel = $("tradesPanel");

    familiesPanel?.classList.toggle(
      "hidden",
      !["families", "long", "short"].includes(state.tab)
    );

    filtersPanel?.classList.toggle("hidden", state.tab !== "filters");
    tradesPanel?.classList.toggle("hidden", state.tab !== "trades");
  }

  function renderTabs() {
    document.querySelectorAll(".tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === state.tab);
    });
  }

  function renderAll() {
    renderSummary();
    renderPanels();
    renderTabs();
    renderFamilies();
    renderFilters();
    renderTrades();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setAuto(enabled) {
    state.auto = Boolean(enabled);

    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }

    if (state.auto) {
      state.timer = setInterval(safeLoadReport, 30000);
    }

    setText("autoBtn", state.auto ? "Auto: ON" : "Auto: OFF");
  }

  async function resetAnalyze() {
    const confirmed = window.confirm("Analyse resetten? Dit vraagt /api/analyse?reset=true aan.");
    if (!confirmed) return;

    try {
      setError("");
      setStatus("Reset uitvoeren...");

      const response = await fetch(`/api/analyse?reset=true&t=${Date.now()}`, {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Reset failed: ${response.status}`);
      }

      await safeLoadReport();
    } catch (error) {
      setError(`Reset error: ${error?.message || error}`);
      setStatus("Reset mislukt.");
    }
  }

  function bindEvents() {
    $("refreshBtn")?.addEventListener("click", safeLoadReport);
    $("autoBtn")?.addEventListener("click", () => setAuto(!state.auto));
    $("resetBtn")?.addEventListener("click", resetAnalyze);

    $("sideFilter")?.addEventListener("change", renderFamilies);
    $("statusFilter")?.addEventListener("change", renderFamilies);
    $("hideEmptyInput")?.addEventListener("change", renderFamilies);
    $("familySearch")?.addEventListener("input", renderFamilies);

    $("minClosedInput")?.addEventListener("change", () => {
      const input = $("minClosedInput");
      if (input) input.value = String(getMinClosed());
      safeLoadReport();
    });

    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        state.tab = button.dataset.tab || "families";

        if (state.tab === "long") {
          const side = $("sideFilter");
          if (side) side.value = "LONG";
        }

        if (state.tab === "short") {
          const side = $("sideFilter");
          if (side) side.value = "SHORT";
        }

        if (state.tab === "families") {
          const side = $("sideFilter");
          if (side) side.value = "ALL";
        }

        renderAll();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    safeLoadReport();
  });
})();