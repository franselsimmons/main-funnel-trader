// ================= PUBLIC/ANALYTICS.JS =================

let report = null;
let autoRefreshTimer = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

document.addEventListener("DOMContentLoaded", () => {
  bindUi();
  loadReport();
});

function bindUi() {
  $("#refreshBtn").addEventListener("click", loadReport);

  $("#resetBtn").addEventListener("click", async () => {
    const ok = confirm("Analyzer resetten? Alle analyze families/actions/trades worden gewist.");
    if (!ok) return;

    await fetch("/api/analyse", { method: "DELETE" });
    await loadReport();
  });

  $("#autoRefreshBtn").addEventListener("click", () => {
    const btn = $("#autoRefreshBtn");
    const enabled = btn.dataset.enabled === "true";

    if (enabled) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
      btn.dataset.enabled = "false";
      btn.textContent = "Auto: OFF";
      return;
    }

    autoRefreshTimer = setInterval(loadReport, 10_000);
    btn.dataset.enabled = "true";
    btn.textContent = "Auto: ON";
  });

  $$(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".tab").forEach(x => x.classList.remove("active"));
      $$(".panel").forEach(x => x.classList.remove("active"));

      btn.classList.add("active");
      $(`#panel-${btn.dataset.tab}`).classList.add("active");
    });
  });

  $("#longSearch").addEventListener("input", () => renderFamilies("long"));
  $("#shortSearch").addEventListener("input", () => renderFamilies("short"));
  $("#filterSearch").addEventListener("input", renderFilters);
  $("#tradeSearch").addEventListener("input", renderTrades);
  $("#actionSearch").addEventListener("input", renderActions);
}

async function loadReport() {
  setStatus("Loading...", "neutral");

  try {
    const res = await fetch(`/api/analyse?t=${Date.now()}`, {
      cache: "no-store"
    });

    const json = await res.json();

    if (!json.ok) {
      throw new Error(json.error || "API returned ok=false");
    }

    report = json.report;

    renderAll();
    setStatus(
      `Loaded. Storage=${json.storage}. Updated=${formatTime(report.summary.lastUpdatedAt)}.`,
      "ok"
    );
  } catch (e) {
    setStatus(`Load error: ${e.message}`, "bad");
  }
}

function renderAll() {
  renderSummary();
  renderFamilies("long");
  renderFamilies("short");
  renderFilters();
  renderTrades();
  renderActions();
}

function renderSummary() {
  const s = report?.summary || {};

  const cards = [
    ["Actions", s.actionsStored],
    ["Trades", s.tradesStored],
    ["Open", s.openTrades],
    ["Closed", s.closedTrades],
    ["Wins", s.wins],
    ["Losses", s.losses],
    ["Winrate", s.winrate],
    ["Total R", s.totalR],
    ["Avg R", s.avgR],
    ["Total PnL%", s.totalPnlPct],
    ["Long families", s.longFamilies],
    ["Short families", s.shortFamilies]
  ];

  $("#summaryCards").innerHTML = cards.map(([label, value]) => `
    <article class="card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `).join("");
}

function renderFamilies(side) {
  const families = report?.families?.[side] || [];
  const query = $(`#${side}Search`)?.value?.toLowerCase()?.trim() || "";
  const tbody = $(`#${side}FamiliesBody`);

  const rows = families.filter(f => {
    if (!query) return true;

    return JSON.stringify(f).toLowerCase().includes(query);
  });

  tbody.innerHTML = rows.map(f => {
    const pnlClass = numberClass(f.totalPnlPct);
    const rClass = numberClass(f.totalR);

    const details = {
      familySlot: f.familySlot,
      familyKey: f.familyKey,
      label: f.label,
      fullFilterCombination: f.signature,
      stats: {
        observations: f.observations,
        entries: f.entries,
        openTrades: f.openTrades,
        closedTrades: f.closedTrades,
        wins: f.wins,
        losses: f.losses,
        flats: f.flats,
        winrate: f.winrate,
        totalR: f.totalR,
        avgR: f.avgR,
        totalPnlPct: f.totalPnlPct,
        avgPnlPct: f.avgPnlPct,
        directSLPct: f.directSLPct,
        nearTpPct: f.nearTpPct,
        reachedHalfRPct: f.reachedHalfRPct
      },
      numericProfile: f.numericProfile,
      topReasons: f.topReasons,
      topSymbols: f.topSymbols,
      examples: f.examples
    };

    return `
      <tr>
        <td><strong>${escapeHtml(f.familySlot)}</strong></td>
        <td class="family-label">${escapeHtml(f.label)}</td>
        <td>${num(f.observations)}</td>
        <td>${num(f.entries)}</td>
        <td>${num(f.closedTrades)}</td>
        <td>${escapeHtml(f.winrate)}</td>
        <td class="${rClass}">${num(f.totalR)}</td>
        <td class="${numberClass(f.avgR)}">${num(f.avgR)}</td>
        <td class="${pnlClass}">${num(f.totalPnlPct)}</td>
        <td>${escapeHtml(f.directSLPct)}</td>
        <td>
          <details>
            <summary>open</summary>
            <pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre>
          </details>
        </td>
      </tr>
    `;
  }).join("");

  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" class="empty">Nog geen ${side === "long" ? "long" : "short"} families met data.</td>
      </tr>
    `;
  }
}

function renderFilters() {
  const filters = report?.filters || {};
  const categories = filters.categories || {};
  const query = $("#filterSearch")?.value?.toLowerCase()?.trim() || "";

  $("#filterHealth").innerHTML = `
    <div class="mini-card">
      Expected filters: <strong>${filters.expectedCount || 0}</strong>
    </div>
    <div class="mini-card">
      Captured: <strong>${filters.capturedCount || 0}</strong>
    </div>
    <div class="mini-card ${filters.missingCount ? "warn" : "good"}">
      Missing: <strong>${filters.missingCount || 0}</strong>
    </div>
    <div class="mini-card">
      Strategy: <strong>${escapeHtml(filters.strategyVersion || "UNKNOWN")}</strong>
    </div>
  `;

  const rows = [];

  for (const [category, items] of Object.entries(categories)) {
    for (const item of items) {
      const haystack = `${category} ${item.name} ${JSON.stringify(item.value)}`.toLowerCase();
      if (query && !haystack.includes(query)) continue;

      rows.push({
        category,
        ...item
      });
    }
  }

  $("#filtersBody").innerHTML = rows.map(row => `
    <tr class="${row.captured ? "" : "missing"}">
      <td>${escapeHtml(row.category)}</td>
      <td><code>${escapeHtml(row.name)}</code></td>
      <td><code>${escapeHtml(JSON.stringify(row.value))}</code></td>
      <td>${row.captured ? "YES" : "NO"}</td>
    </tr>
  `).join("");

  if (!rows.length) {
    $("#filtersBody").innerHTML = `
      <tr>
        <td colspan="4" class="empty">Geen filters gevonden.</td>
      </tr>
    `;
  }
}

function renderTrades() {
  const rows = report?.recentTrades || [];
  const query = $("#tradeSearch")?.value?.toLowerCase()?.trim() || "";

  const filtered = rows.filter(t => {
    if (!query) return true;
    return JSON.stringify(t).toLowerCase().includes(query);
  });

  $("#tradesBody").innerHTML = filtered.map(t => {
    const family = t.entryFamilyLabel || t.exitFamilyLabel || "NA";

    const details = {
      trade: t,
      familyCombination: t.entryFamilySignature || t.exitFamilySignature || null
    };

    return `
      <tr>
        <td>${escapeHtml(t.status)}</td>
        <td><strong>${escapeHtml(t.symbol)}</strong></td>
        <td>${escapeHtml(t.side)}</td>
        <td>${escapeHtml(t.setupClass || "NA")}</td>
        <td>${num(t.entry)}</td>
        <td>${num(t.exit)}</td>
        <td class="${numberClass(t.exitR)}">${num(t.exitR)}</td>
        <td class="${numberClass(t.pnlPct)}">${num(t.pnlPct)}</td>
        <td class="family-label">${escapeHtml(family)}</td>
        <td>
          <details>
            <summary>open</summary>
            <pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre>
          </details>
        </td>
      </tr>
    `;
  }).join("");

  if (!filtered.length) {
    $("#tradesBody").innerHTML = `
      <tr>
        <td colspan="10" class="empty">Geen trades.</td>
      </tr>
    `;
  }
}

function renderActions() {
  const rows = report?.recentActions || [];
  const query = $("#actionSearch")?.value?.toLowerCase()?.trim() || "";

  const filtered = rows.filter(a => {
    if (!query) return true;
    return JSON.stringify(a).toLowerCase().includes(query);
  });

  $("#actionsBody").innerHTML = filtered.map(a => `
    <tr>
      <td>${escapeHtml(a.action)}</td>
      <td>${escapeHtml(a.reason)}</td>
      <td><strong>${escapeHtml(a.symbol)}</strong></td>
      <td>${escapeHtml(a.side)}</td>
      <td>${escapeHtml(a.setupClass || "NA")}</td>
      <td>${num(a.score)}</td>
      <td>${num(a.confluence)}</td>
      <td>${num(a.sniperScore)}</td>
      <td>${num(a.plannedRR || a.rr)}</td>
      <td class="family-label">${escapeHtml(a.familyLabel || "NA")}</td>
    </tr>
  `).join("");

  if (!filtered.length) {
    $("#actionsBody").innerHTML = `
      <tr>
        <td colspan="10" class="empty">Geen actions.</td>
      </tr>
    `;
  }
}

function setStatus(text, mode) {
  const box = $("#statusBox");
  box.textContent = text;
  box.className = `status ${mode}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "0";

  if (Math.abs(n) >= 1000) {
    return n.toLocaleString("en-US", {
      maximumFractionDigits: 2
    });
  }

  return String(Math.round(n * 1000) / 1000);
}

function numberClass(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "pos" : "neg";
}

function formatTime(ts) {
  const n = Number(ts);
  if (!n) return "never";

  return new Date(n).toLocaleString();
}