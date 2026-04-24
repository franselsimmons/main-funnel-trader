const el = id => document.getElementById(id);

const STAGES = ["entry", "almost", "buildup", "radar"];
const STAGE_ORDER = {
  entry: 4,
  almost: 3,
  buildup: 2,
  radar: 1
};

const ACTION_ORDER = {
  ENTRY: 5,
  HOLD: 4,
  WAIT: 3,
  EXIT: 2,
  WATCH: 1
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

function fmtPct(value){
  const n = toNumber(value);
  return n === null ? "0%" : `${n.toFixed(1)}%`;
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

function reasonLabel(reason){
  const r = String(reason || "UNKNOWN");

  const labels = {
    MAX_OPEN_TRADES: "Max open trades bereikt",
    SYMBOL_COOLDOWN: "Symbol cooldown",
    COOLDOWN: "Cooldown actief",
    OPPOSITE_POSITION_OPEN: "Tegengestelde positie open",
    DUPLICATE_PROCESSING_LOCK: "Duplicate processing lock",
    LOW_VOL: "Te lage volatiliteit",
    NO_FLOW: "Geen flow",
    LOW_CONFLUENCE: "Te lage confluence",
    LOW_RR: "Te lage RR",
    FAKE_BREAKOUT: "Fake breakout",
    OB_AGAINST: "Orderboek tegen trade",
    NO_LIQUIDATION_ROOM: "Geen liquidation room",
    BAD_MARKET_QUALITY: "Slechte market quality",
    OB_NEUTRAL_LOW_CONF: "Neutraal orderboek + lage confirmatie",
    EXTREME_FUNDING: "Extreme funding",
    BULL_CROWDED_FUNDING: "Long te crowded",
    BEAR_CROWDED_FUNDING: "Short te crowded",
    BTC_BULL_BLOCK_SHORT: "BTC bullish blokkeert short",
    BTC_BEAR_BLOCK_LONG: "BTC bearish blokkeert long",
    COUNTERTREND_NOT_ELITE: "Countertrend niet elite genoeg",
    ENTRY_FILTERED: "Laatste entry-check afgekeurd",
    ORDERBOOK_FETCH_FAILED: "Orderboek ophalen mislukt",
    WATCH: "Watch"
  };

  if(r.startsWith("SYMBOL_ALREADY_OPEN_")){
    return "Symbol heeft al open positie";
  }

  return labels[r] || r;
}

function reasonAdvice(reason){
  const r = String(reason || "UNKNOWN");

  const advice = {
    MAX_OPEN_TRADES: "Niet per se te streng. Eerst kijken of dit bewust risicobeheer is.",
    SYMBOL_COOLDOWN: "Alleen aanpassen als je bewust sneller wilt re-enteren.",
    COOLDOWN: "Alleen versoepelen als cooldown echt te vaak blokkeert.",
    OPPOSITE_POSITION_OPEN: "Meestal gezond; voorkomt dubbele tegenstrijdige posities.",
    DUPLICATE_PROCESSING_LOCK: "Geen filterprobleem maar bescherming tegen dubbel verwerken.",
    LOW_VOL: "Mogelijk te streng als bijna alles hierop stukloopt.",
    NO_FLOW: "Check of flow-detectie te streng staat.",
    LOW_CONFLUENCE: "Sterke kwaliteitsfilter; niet blind losser zetten.",
    LOW_RR: "Belangrijk voor PnL, meestal niet zomaar versoepelen.",
    FAKE_BREAKOUT: "Beschermt tegen late entries; alleen versoepelen na testen.",
    OB_AGAINST: "Vaak gezond; orderboek tegen de richting is belangrijk.",
    NO_LIQUIDATION_ROOM: "Belangrijk voor TP-potentieel.",
    BAD_MARKET_QUALITY: "Niet snel losser zetten; dit beschermt execution.",
    OB_NEUTRAL_LOW_CONF: "Kan een bottleneck zijn als deze heel vaak voorkomt.",
    EXTREME_FUNDING: "Beschermt tegen crowded markt.",
    BULL_CROWDED_FUNDING: "Long filter; alleen losser als data dat ondersteunt.",
    BEAR_CROWDED_FUNDING: "Short filter; alleen losser als data dat ondersteunt.",
    BTC_BULL_BLOCK_SHORT: "Marktregime blokkeert short. Vaak gezond.",
    BTC_BEAR_BLOCK_LONG: "Marktregime blokkeert long. Vaak gezond.",
    COUNTERTREND_NOT_ELITE: "Meestal gezond; countertrend hoort streng te zijn.",
    ENTRY_FILTERED: "Grote kans op te strenge eindcheck als dit bovenaan staat.",
    ORDERBOOK_FETCH_FAILED: "Geen filter maar datakwaliteit/exchange probleem."
  };

  if(r.startsWith("SYMBOL_ALREADY_OPEN_")){
    return "Geen filterprobleem; voorkomt dubbele entries op dezelfde coin.";
  }

  return advice[r] || "Controleer deze blokkade handmatig.";
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

function buildRejectOverview(waitRows){
  const grouped = new Map();

  for(const row of waitRows){
    const key = String(row?.reason || "UNKNOWN");

    if(!grouped.has(key)){
      grouped.set(key, {
        reason: key,
        count: 0
      });
    }

    grouped.get(key).count += 1;
  }

  const total = waitRows.length || 1;

  return Array.from(grouped.values())
    .map(item => ({
      ...item,
      label: reasonLabel(item.reason),
      advice: reasonAdvice(item.reason),
      pct: Number(((item.count / total) * 100).toFixed(1))
    }))
    .sort((a, b) => b.count - a.count);
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
    { label: "Coin", render: r => `<strong>${fmtText(r.symbol)}</strong>` },
    { label: "Side", render: r => sideBadge(r.side) },
    { label: "Stage", render: r => stageBadge(r.stage) },
    { label: "Score", render: r => fmtInt(r.score) },
    { label: "Grade", render: r => fmtText(r.grade) },
    { label: "Confluence", render: r => fmtInt(r.confluence) },
    { label: "RR", render: r => fmtNum(r.rr) },
    { label: "Entry", render: r => fmtNum(r.entry) },
    { label: "SL", render: r => fmtNum(r.sl) },
    { label: "TP", render: r => fmtNum(r.tp) },
    { label: "Flow", render: r => fmtText(r.flow) },
    { label: "Sniper", render: r => fmtText(r.sniper) },
    { label: "OB", render: r => fmtText(r.obBias) },
    { label: "TF", render: r => fmtText(r.tfStrength) }
  ];

  el("entriesTable").innerHTML = tableHtml(
    columns,
    rows,
    "Geen entry-signalen in deze scan.",
    () => "row-entry"
  );
}

function renderFunnel(funnelRows){
  const columns = [
    { label: "Coin", render: r => `<strong>${fmtText(r.symbol)}</strong>` },
    { label: "Side", render: r => sideBadge(r.side) },
    { label: "Stage", render: r => stageBadge(r.stage) },
    { label: "Score", render: r => fmtInt(r.moveScore) },
    { label: "Flow", render: r => fmtText(r.flow) },
    { label: "Freshness", render: r => fmtInt(r.freshness) },
    { label: "TF Score", render: r => fmtText(r.tfScore) },
    { label: "TF Strength", render: r => fmtText(r.tfStrength) },
    { label: "TF Align", render: r => fmtText(r.tfAlignment) },
    { label: "VM", render: r => fmtNum(r.vm) },
    { label: "Source", render: r => fmtText(r.stageSource) },
    { label: "UI only", render: r => fmtBool(Boolean(r.uiOnly)) }
  ];

  el("funnelTable").innerHTML = tableHtml(
    columns,
    funnelRows,
    "Geen scanner/funnel data beschikbaar.",
    r => `row-stage-${String(r.stage || "").toLowerCase()}`
  );
}

function renderRejectOverview(waitRows){
  const rows = buildRejectOverview(waitRows);

  const columns = [
    { label: "Filter / Reason", render: r => `<strong>${fmtText(r.label)}</strong>` },
    { label: "Code", render: r => fmtText(r.reason) },
    { label: "Aantal", render: r => fmtInt(r.count) },
    { label: "Aandeel", render: r => fmtPct(r.pct) },
    { label: "Interpretatie", render: r => fmtText(r.advice) }
  ];

  el("rejectOverviewTable").innerHTML = tableHtml(
    columns,
    rows,
    "Geen afgekeurde trade-candidates in deze scan.",
    () => "row-wait"
  );
}

function renderRejectedTrades(waitRows){
  const rows = [...waitRows].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  const columns = [
    { label: "Coin", render: r => `<strong>${fmtText(r.symbol)}</strong>` },
    { label: "Side", render: r => sideBadge(r.side) },
    { label: "Action", render: r => actionBadge(r.action) },
    { label: "Stage", render: r => stageBadge(r.stage) },
    { label: "Afgekeurd op", render: r => `<strong>${fmtText(reasonLabel(r.reason))}</strong>` },
    { label: "Code", render: r => fmtText(r.reason) },
    { label: "Score", render: r => fmtInt(r.score) },
    { label: "Flow", render: r => fmtText(r.flow) },
    { label: "Confluence", render: r => fmtInt(r.confluence) },
    { label: "RR", render: r => fmtNum(r.rr) },
    { label: "Entry", render: r => fmtNum(r.entry) },
    { label: "SL", render: r => fmtNum(r.sl) },
    { label: "TP", render: r => fmtNum(r.tp) },
    { label: "Grade", render: r => fmtText(r.grade) },
    { label: "OB", render: r => fmtText(r.obBias) },
    { label: "TF", render: r => fmtText(r.tfStrength) }
  ];

  el("rejectedTradesTable").innerHTML = tableHtml(
    columns,
    rows,
    "Geen afgekeurde trade-candidates gevonden.",
    () => "row-wait"
  );
}

function renderTradeResults(nonWaitTrades){
  const columns = [
    { label: "Coin", render: r => `<strong>${fmtText(r.symbol)}</strong>` },
    { label: "Side", render: r => sideBadge(r.side) },
    { label: "Action", render: r => actionBadge(r.action) },
    { label: "Stage", render: r => stageBadge(r.stage) },
    { label: "Reason", render: r => fmtText(r.reason) },
    { label: "Score", render: r => fmtInt(r.score) },
    { label: "Flow", render: r => fmtText(r.flow) },
    { label: "Confluence", render: r => fmtInt(r.confluence) },
    { label: "RR", render: r => fmtNum(r.rr) },
    { label: "Entry", render: r => fmtNum(r.entry) },
    { label: "SL", render: r => fmtNum(r.sl) },
    { label: "TP", render: r => fmtNum(r.tp) },
    { label: "Grade", render: r => fmtText(r.grade) },
    { label: "OB", render: r => fmtText(r.obBias) },
    { label: "TF", render: r => fmtText(r.tfStrength) }
  ];

  el("tradeResultsTable").innerHTML = tableHtml(
    columns,
    nonWaitTrades,
    "Geen actieve of afgeronde trade-resultaten beschikbaar.",
    r => `row-${String(r.action || "").toLowerCase()}`
  );
}

function renderStatus(data, entries, waitRows, nonWaitTrades, funnelRows){
  const updated = fmtDate(data?.updatedAt || data?.servedAt);

  if(el("statusLine")){
    el("statusLine").innerText =
      `Laatste update: ${updated} | Entries: ${entries.length} | Afgekeurd: ${waitRows.length} | Overige trades: ${nonWaitTrades.length} | Funnel coins: ${funnelRows.length}`;
  }

  if(el("entriesCount")) el("entriesCount").innerText = String(entries.length);
  if(el("rejectCount")) el("rejectCount").innerText = String(waitRows.length);
  if(el("tradeCount")) el("tradeCount").innerText = String(nonWaitTrades.length);
  if(el("funnelCount")) el("funnelCount").innerText = String(funnelRows.length);
}

async function load(){
  try{
    const res = await fetch("/api/public-latest");
    const data = await res.json();

    const trades = sortTrades(data?.trades);
    const entries = trades.filter(t => String(t?.action || "").toUpperCase() === "ENTRY");
    const waitRows = trades.filter(t => String(t?.action || "").toUpperCase() === "WAIT");
    const nonWaitTrades = trades.filter(t => String(t?.action || "").toUpperCase() !== "WAIT");
    const funnelRows = flattenFunnel(data?.funnel);

    renderStatus(data, entries, waitRows, nonWaitTrades, funnelRows);
    renderEntries(entries);
    renderFunnel(funnelRows);
    renderRejectOverview(waitRows);
    renderRejectedTrades(waitRows);
    renderTradeResults(nonWaitTrades);
  }catch(e){
    console.error(e);

    if(el("statusLine")){
      el("statusLine").innerText = "Fout bij laden van signalen.";
    }

    const fail = `<div class="emptyState">Kon data niet laden.</div>`;

    if(el("entriesTable")) el("entriesTable").innerHTML = fail;
    if(el("funnelTable")) el("funnelTable").innerHTML = fail;
    if(el("rejectOverviewTable")) el("rejectOverviewTable").innerHTML = fail;
    if(el("rejectedTradesTable")) el("rejectedTradesTable").innerHTML = fail;
    if(el("tradeResultsTable")) el("tradeResultsTable").innerHTML = fail;
  }
}

setInterval(load, 10000);
load();