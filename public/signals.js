const el = id => document.getElementById(id);

const STAGES = ["entry", "almost", "buildup", "radar"];
const STAGE_ORDER = {
  entry: 4,
  almost: 3,
  buildup: 2,
  radar: 1
};

const ACTION_ORDER = {
  ENTRY: 4,
  HOLD: 3,
  WAIT: 2,
  EXIT: 1
};

function safeArray(value){
  return Array.isArray(value) ? value : [];
}

function toNumber(value){
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(value){
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtText(value, fallback = "—"){
  if(value === undefined || value === null || value === ""){
    return fallback;
  }

  return escapeHtml(String(value));
}

function fmtNum(value){
  const n = toNumber(value);

  if(n === null) return "—";

  const abs = Math.abs(n);

  if(abs >= 1000) return n.toFixed(2);
  if(abs >= 1) return n.toFixed(4);
  if(abs >= 0.01) return n.toFixed(5);
  if(abs === 0) return "0";

  return n.toFixed(8);
}

function fmtInt(value){
  const n = toNumber(value);
  return n === null ? "0" : String(Math.round(n));
}

function fmtBool(value){
  return value ? "ja" : "nee";
}

function fmtDate(ts){
  const n = Number(ts);

  if(!Number.isFinite(n)) return "onbekend";

  return new Date(n).toLocaleString("nl-NL");
}

function stageBadge(stage){
  const s = String(stage || "radar").toLowerCase();
  return `<span class="pill pill-stage stage-${escapeHtml(s)}">${escapeHtml(s)}</span>`;
}

function actionBadge(action){
  const a = String(action || "WAIT").toUpperCase();
  const cls = a.toLowerCase();
  return `<span class="pill pill-action action-${escapeHtml(cls)}">${escapeHtml(a)}</span>`;
}

function sideBadge(side){
  const s = String(side || "").toLowerCase();
  const label = s === "bull" ? "LONG" : s === "bear" ? "SHORT" : s.toUpperCase();
  return `<span class="pill pill-side side-${escapeHtml(s)}">${escapeHtml(label)}</span>`;
}

function flattenFunnel(funnel){
  const rows = [];

  for(const side of ["bull", "bear"]){
    for(const stage of STAGES){
      for(const coin of safeArray(funnel?.[side]?.[stage])){
        rows.push({
          ...coin,
          side: coin?.side || side,
          stage: coin?.stage || stage
        });
      }
    }
  }

  return rows.sort((a, b) => {
    const stageDiff =
      (STAGE_ORDER[String(b.stage || "").toLowerCase()] || 0) -
      (STAGE_ORDER[String(a.stage || "").toLowerCase()] || 0);

    if(stageDiff !== 0) return stageDiff;

    return Number(b.moveScore || 0) - Number(a.moveScore || 0);
  });
}

function sortTrades(trades){
  return [...safeArray(trades)].sort((a, b) => {
    const actionDiff =
      (ACTION_ORDER[String(b.action || "").toUpperCase()] || 0) -
      (ACTION_ORDER[String(a.action || "").toUpperCase()] || 0);

    if(actionDiff !== 0) return actionDiff;

    return Number(b.score || 0) - Number(a.score || 0);
  });
}

function tableHtml(columns, rows, emptyText, rowClassFn = null){
  if(!rows.length){
    return `<div class="emptyState">${escapeHtml(emptyText)}</div>`;
  }

  const head = `
    <thead>
      <tr>
        ${columns.map(col => `<th>${escapeHtml(col.label)}</th>`).join("")}
      </tr>
    </thead>
  `;

  const body = rows.map(row => {
    const rowClass = rowClassFn ? rowClassFn(row) : "";

    return `
      <tr class="${escapeHtml(rowClass)}">
        ${columns.map(col => {
          const cell = col.render ? col.render(row) : fmtText(row[col.key]);
          return `<td>${cell}</td>`;
        }).join("")}
      </tr>
    `;
  }).join("");

  return `
    <div class="tableWrap">
      <table class="signalTable">
        ${head}
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function renderEntries(entries){
  const rows = [...entries].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  const columns = [
    {
      label: "Coin",
      render: r => `<strong>${fmtText(r.symbol)}</strong>`
    },
    {
      label: "Side",
      render: r => sideBadge(r.side)
    },
    {
      label: "Stage",
      render: r => stageBadge(r.stage)
    },
    {
      label: "Score",
      render: r => fmtInt(r.score)
    },
    {
      label: "Grade",
      render: r => fmtText(r.grade)
    },
    {
      label: "Confluence",
      render: r => fmtInt(r.confluence)
    },
    {
      label: "RR",
      render: r => fmtNum(r.rr)
    },
    {
      label: "Entry",
      render: r => fmtNum(r.entry)
    },
    {
      label: "SL",
      render: r => fmtNum(r.sl)
    },
    {
      label: "TP",
      render: r => fmtNum(r.tp)
    },
    {
      label: "Flow",
      render: r => fmtText(r.flow)
    },
    {
      label: "Sniper",
      render: r => fmtText(r.sniper)
    },
    {
      label: "OB",
      render: r => fmtText(r.obBias)
    },
    {
      label: "TF",
      render: r => fmtText(r.tfStrength)
    }
  ];

  el("entriesTable").innerHTML = tableHtml(
    columns,
    rows,
    "Geen entry-signalen in deze scan.",
    () => "row-entry"
  );
}

function renderTradeResults(trades){
  const columns = [
    {
      label: "Coin",
      render: r => `<strong>${fmtText(r.symbol)}</strong>`
    },
    {
      label: "Side",
      render: r => sideBadge(r.side)
    },
    {
      label: "Action",
      render: r => actionBadge(r.action)
    },
    {
      label: "Stage",
      render: r => stageBadge(r.stage)
    },
    {
      label: "Reason",
      render: r => fmtText(r.reason)
    },
    {
      label: "Score",
      render: r => fmtInt(r.score)
    },
    {
      label: "Flow",
      render: r => fmtText(r.flow)
    },
    {
      label: "Confluence",
      render: r => fmtInt(r.confluence)
    },
    {
      label: "RR",
      render: r => fmtNum(r.rr)
    },
    {
      label: "Entry",
      render: r => fmtNum(r.entry)
    },
    {
      label: "SL",
      render: r => fmtNum(r.sl)
    },
    {
      label: "TP",
      render: r => fmtNum(r.tp)
    },
    {
      label: "Grade",
      render: r => fmtText(r.grade)
    },
    {
      label: "OB",
      render: r => fmtText(r.obBias)
    },
    {
      label: "TF",
      render: r => fmtText(r.tfStrength)
    }
  ];

  el("tradeResultsTable").innerHTML = tableHtml(
    columns,
    trades,
    "Geen trade-resultaten beschikbaar.",
    r => `row-${String(r.action || "").toLowerCase()}`
  );
}

function renderFunnel(funnelRows){
  const columns = [
    {
      label: "Coin",
      render: r => `<strong>${fmtText(r.symbol)}</strong>`
    },
    {
      label: "Side",
      render: r => sideBadge(r.side)
    },
    {
      label: "Stage",
      render: r => stageBadge(r.stage)
    },
    {
      label: "Score",
      render: r => fmtInt(r.moveScore)
    },
    {
      label: "Flow",
      render: r => fmtText(r.flow)
    },
    {
      label: "Freshness",
      render: r => fmtInt(r.freshness)
    },
    {
      label: "TF Score",
      render: r => fmtText(r.tfScore)
    },
    {
      label: "TF Strength",
      render: r => fmtText(r.tfStrength)
    },
    {
      label: "TF Align",
      render: r => fmtText(r.tfAlignment)
    },
    {
      label: "VM",
      render: r => fmtNum(r.vm)
    },
    {
      label: "Source",
      render: r => fmtText(r.stageSource)
    },
    {
      label: "UI only",
      render: r => fmtBool(Boolean(r.uiOnly))
    }
  ];

  el("funnelTable").innerHTML = tableHtml(
    columns,
    funnelRows,
    "Geen scanner/funnel data beschikbaar.",
    r => `row-stage-${String(r.stage || "").toLowerCase()}`
  );
}

function renderStatus(data, entries, trades, funnelRows){
  const updated = fmtDate(data?.updatedAt || data?.servedAt);

  if(el("statusLine")){
    el("statusLine").innerText =
      `Laatste update: ${updated} | Entries: ${entries.length} | Trade regels: ${trades.length} | Funnel coins: ${funnelRows.length}`;
  }

  if(el("entriesCount")) el("entriesCount").innerText = String(entries.length);
  if(el("tradeCount")) el("tradeCount").innerText = String(trades.length);
  if(el("funnelCount")) el("funnelCount").innerText = String(funnelRows.length);
}

async function load(){
  try{
    const res = await fetch("/api/public-latest");
    const data = await res.json();

    const trades = sortTrades(data?.trades);
    const entries = trades.filter(t => String(t?.action || "").toUpperCase() === "ENTRY");
    const funnelRows = flattenFunnel(data?.funnel);

    renderStatus(data, entries, trades, funnelRows);
    renderEntries(entries);
    renderTradeResults(trades);
    renderFunnel(funnelRows);
  }catch(e){
    console.error(e);

    if(el("statusLine")){
      el("statusLine").innerText = "Fout bij laden van signalen.";
    }

    if(el("entriesTable")){
      el("entriesTable").innerHTML = `<div class="emptyState">Kon entry-signalen niet laden.</div>`;
    }

    if(el("tradeResultsTable")){
      el("tradeResultsTable").innerHTML = `<div class="emptyState">Kon trade-resultaten niet laden.</div>`;
    }

    if(el("funnelTable")){
      el("funnelTable").innerHTML = `<div class="emptyState">Kon funnel-data niet laden.</div>`;
    }
  }
}

setInterval(load, 10000);
load();