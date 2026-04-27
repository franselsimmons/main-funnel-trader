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
  if(value === undefined || value === null || value === "") return fallback;
  return escapeHtml(String(value));
}

function fmtNum(value, decimals = 2){
  const n = toNumber(value);
  if(n === null) return "—";
  return n.toFixed(decimals);
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

function fmtSign(value){
  const n = toNumber(value);
  if(n === null) return "—";
  if(n > 0) return `+${n.toFixed(2)}`;
  if(n < 0) return `${n.toFixed(2)}`;
  return "0";
}

function fmtDate(ts){
  const n = Number(ts);
  if(!Number.isFinite(n) || n <= 0) return "onbekend";
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
  if(r.startsWith("SYMBOL_ALREADY_OPEN_")) return "Symbol heeft al open positie";
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
  if(r.startsWith("SYMBOL_ALREADY_OPEN_")) return "Geen filterprobleem; voorkomt dubbele entries op dezelfde coin.";
  return advice[r] || "Controleer deze blokkade handmatig.";
}

function normalizeDashboardStats(data){
  const raw = data?.dashboardStats || {};
  return {
    startedAt: toNumber(raw.startedAt) || 0,
    lastResetAt: toNumber(raw.lastResetAt) || 0,
    lastScanAt: toNumber(raw.lastScanAt) || toNumber(data?.updatedAt) || 0,
    totalScans: toNumber(raw.totalScans) || 0,
    totalEntries: toNumber(raw.totalEntries) || 0,
    totalRejected: toNumber(raw.totalRejected) || 0,
    totalOtherTrades: toNumber(raw.totalOtherTrades) || 0,
    totalFunnelCoins: toNumber(raw.totalFunnelCoins) || 0,
    totalCandidates: toNumber(raw.totalCandidates) || 0,
    lastEntries: toNumber(raw.lastEntries) || 0,
    lastRejected: toNumber(raw.lastRejected) || 0,
    lastOtherTrades: toNumber(raw.lastOtherTrades) || 0,
    lastFunnelCoins: toNumber(raw.lastFunnelCoins) || 0,
    lastCandidates: toNumber(raw.lastCandidates) || 0,
    rejectReasonCounts: raw.rejectReasonCounts && typeof raw.rejectReasonCounts === "object" ? raw.rejectReasonCounts : {},
    actionCounts: raw.actionCounts && typeof raw.actionCounts === "object" ? raw.actionCounts : {},
    entryRows: safeArray(raw.entryRows),
    rejectedRows: safeArray(raw.rejectedRows),
    tradeRows: safeArray(raw.tradeRows)
  };
}

function withFallbackScanTs(rows, fallbackTs){
  return safeArray(rows).map(row => ({
    ...row,
    scanTs: row?.scanTs || fallbackTs || 0
  }));
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
    const stageDiff = (STAGE_ORDER[String(b.stage || "").toLowerCase()] || 0) - (STAGE_ORDER[String(a.stage || "").toLowerCase()] || 0);
    if(stageDiff !== 0) return stageDiff;
    return Number(b.moveScore || 0) - Number(a.moveScore || 0);
  });
}

function sortTrades(trades){
  return [...safeArray(trades)].sort((a, b) => {
    const actionDiff = (ACTION_ORDER[String(b.action || "").toUpperCase()] || 0) - (ACTION_ORDER[String(a.action || "").toUpperCase()] || 0);
    if(actionDiff !== 0) return actionDiff;
    return Number(b.score || 0) - Number(a.score || 0);
  });
}

function buildCounterMapFromRows(rows, field){
  const out = {};
  for(const row of safeArray(rows)){
    const key = String(row?.[field] || "UNKNOWN");
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// ========== TOP CANDIDATE FILTER ==========
function isTopCandidate(r){
  return (
    Number(r.score || 0) >= 70 ||
    Number(r.confluence || 0) >= 70 ||
    r.grade === "A" ||
    r.grade === "B"
  );
}

// ========== REJECT OVERVIEW (gemiddeld tekort) ==========
function renderRejectOverviewFromRows(rejectedRows){
  const filtered = rejectedRows.filter(isTopCandidate);
  const map = {};
  for(const r of filtered){
    const reason = r.reason || "UNKNOWN";
    if(!map[reason]){
      map[reason] = { count: 0, totalScore: 0, samples: 0 };
    }
    map[reason].count++;
    const reasonScore = toNumber(r.reasonScore);
    if(reasonScore !== null && Number.isFinite(reasonScore)){
      map[reason].totalScore += reasonScore;
      map[reason].samples++;
    }
  }
  const result = Object.entries(map).map(([reason, data]) => {
    const avgScore = data.samples > 0 ? data.totalScore / data.samples : null;
    return {
      reason,
      label: reasonLabel(reason),
      count: data.count,
      avgScore: avgScore !== null ? Number(avgScore.toFixed(2)) : null,
      advice: reasonAdvice(reason)
    };
  });
  result.sort((a,b) => b.count - a.count);
  const columns = [
    { label: "Filter", render: r => `<strong>${escapeHtml(r.label)}</strong>` },
    { label: "Aantal (TOP coins)", render: r => fmtInt(r.count) },
    { label: "Gem. tekort", render: r => r.avgScore !== null ? fmtSign(r.avgScore) : "—" },
    { label: "Interpretatie", render: r => escapeHtml(r.advice) }
  ];
  const tableHtmlContent = (result.length === 0)
    ? `<div class="emptyState">Geen afgekeurde top‑candidates sinds reset.</div>`
    : `<div class="tableWrap"><table class="signalTable"><thead><tr>${columns.map(col => `<th>${escapeHtml(col.label)}</th>`).join("")}</tr></thead><tbody>${result.map(r => `<tr class="row-wait">${columns.map(col => `<td>${col.render(r)}</td>`).join("")}<tr>`).join("")}</tbody></table></div>`;
  el("rejectOverviewTable").innerHTML = tableHtmlContent;
}

// ========== ALGEMENE TABLE HELPER ==========
function tableHtml(columns, rows, emptyText, rowClassFn = null){
  if(!rows.length) return `<div class="emptyState">${escapeHtml(emptyText)}</div>`;
  const head = `<thead><tr>${columns.map(col => `<th>${escapeHtml(col.label)}</th>`).join("")}</tr></thead>`;
  const body = rows.map(row => {
    const rowClass = rowClassFn ? rowClassFn(row) : "";
    return `<tr class="${escapeHtml(rowClass)}">${columns.map(col => `<td>${col.render ? col.render(row) : fmtText(row[col.key])}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="tableWrap"><table class="signalTable">${head}<tbody>${body}</tbody></table></div>`;
}

// ========== BESTAANDE RENDER FUNCTIES ==========
function renderEntries(entries){
  const rows = [...entries].sort((a, b) => {
    const tsDiff = Number(b.scanTs || 0) - Number(a.scanTs || 0);
    if(tsDiff !== 0) return tsDiff;
    return Number(b.score || 0) - Number(a.score || 0);
  });
  const columns = [
    { label: "Scan tijd", render: r => fmtText(fmtDate(r.scanTs)) },
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
  el("entriesTable").innerHTML = tableHtml(columns, rows, "Nog geen entry-signalen beschikbaar.", () => "row-entry");
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
  el("funnelTable").innerHTML = tableHtml(columns, funnelRows, "Geen scanner/funnel data beschikbaar.", r => `row-stage-${String(r.stage || "").toLowerCase()}`);
}

function renderRejectedTrades(waitRows){
  const rows = [...waitRows].sort((a, b) => {
    const tsDiff = Number(b.scanTs || 0) - Number(a.scanTs || 0);
    if(tsDiff !== 0) return tsDiff;
    return Number(b.score || 0) - Number(a.score || 0);
  });
  const columns = [
    { label: "Scan tijd", render: r => fmtText(fmtDate(r.scanTs)) },
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
  el("rejectedTradesTable").innerHTML = tableHtml(columns, rows, "Nog geen afgekeurde trade-candidates beschikbaar.", () => "row-wait");
}

function renderTradeResults(nonWaitTrades){
  const rows = [...nonWaitTrades].sort((a, b) => {
    const tsDiff = Number(b.scanTs || 0) - Number(a.scanTs || 0);
    if(tsDiff !== 0) return tsDiff;
    const actionDiff = (ACTION_ORDER[String(b.action || "").toUpperCase()] || 0) - (ACTION_ORDER[String(a.action || "").toUpperCase()] || 0);
    if(actionDiff !== 0) return actionDiff;
    return Number(b.score || 0) - Number(a.score || 0);
  });
  const columns = [
    { label: "Scan tijd", render: r => fmtText(fmtDate(r.scanTs)) },
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
  el("tradeResultsTable").innerHTML = tableHtml(columns, rows, "Nog geen trade-resultaten beschikbaar.", r => `row-${String(r.action || "").toLowerCase()}`);
}

function renderStatus(data, stats, liveEntries, liveWaitRows, liveNonWaitTrades, funnelRows){
  const hasStoredScans = Number(stats.totalScans || 0) > 0;
  const shownEntries = hasStoredScans ? Number(stats.lastEntries || 0) : liveEntries.length;
  const shownRejected = hasStoredScans ? Number(stats.lastRejected || 0) : liveWaitRows.length;
  const shownOtherTrades = hasStoredScans ? Number(stats.lastOtherTrades || 0) : liveNonWaitTrades.length;
  const shownFunnel = hasStoredScans ? Number(stats.lastFunnelCoins || funnelRows.length) : funnelRows.length;
  const liveLabel = hasStoredScans ? "LIVE + OPSLAG" : "LIVE (nog geen scan opgeslagen sinds reset)";
  const statusLine = `${liveLabel} | Laatste update: ${fmtDate(stats.lastScanAt || data?.updatedAt)} | Entries: ${fmtInt(shownEntries)} | Afgekeurd: ${fmtInt(shownRejected)} | Overige trades: ${fmtInt(shownOtherTrades)} | Funnel coins: ${fmtInt(shownFunnel)}`;
  if(el("statusLine")) el("statusLine").innerText = statusLine;
  if(el("statsInfo")) el("statsInfo").innerText = hasStoredScans ? `Sinds reset: scans ${fmtInt(stats.totalScans)} | candidates ${fmtInt(stats.totalCandidates)} | reset op ${fmtDate(stats.lastResetAt)}` : `Nog geen nieuwe opgeslagen scan sinds reset | reset op ${fmtDate(stats.lastResetAt)}`;
  if(el("entriesCount")) el("entriesCount").innerText = hasStoredScans ? fmtInt(stats.totalEntries) : fmtInt(liveEntries.length);
  if(el("rejectCount")) el("rejectCount").innerText = hasStoredScans ? fmtInt(stats.totalRejected) : fmtInt(liveWaitRows.length);
  if(el("tradeCount")) el("tradeCount").innerText = hasStoredScans ? fmtInt(stats.totalOtherTrades) : fmtInt(liveNonWaitTrades.length);
  if(el("funnelCount")) el("funnelCount").innerText = hasStoredScans ? fmtInt(stats.totalFunnelCoins) : fmtInt(funnelRows.length);
}

// ========== LEVEL 2 FUNCTIES ==========
function buildFilterCombinations(rows){
  const filtered = rows.filter(isTopCandidate);
  const map = {};
  for(const r of filtered){
    const reason = r.reason || "UNKNOWN";
    map[reason] = (map[reason] || 0) + 1;
  }
  return Object.entries(map).map(([combo, count]) => ({ combo, count })).sort((a,b) => b.count - a.count);
}

function renderFilterCombos(rows){
  const data = buildFilterCombinations(rows);
  const columns = [
    { label: "Filter", render: r => `<strong>${reasonLabel(r.combo)}</strong>` },
    { label: "Aantal (TOP coins)", render: r => fmtInt(r.count) }
  ];
  const html = tableHtml(columns, data, "Geen top‑candidates afgekeurd sinds reset.");
  let container = document.getElementById("filterCombosSection");
  if(!container){
    container = document.createElement("div");
    container.id = "filterCombosSection";
    container.className = "trade-section";
    document.querySelector(".pageShell").appendChild(container);
  }
  container.innerHTML = `<h2>🔗 FILTER COMBINATIES (TOP COINS)</h2>${html}`;
}

function buildNearMiss(rows){
  const filtered = rows.filter(isTopCandidate);
  return filtered
    .filter(r => {
      const rrMiss = r.reason === "LOW_RR" && toNumber(r.reasonScore) > -0.15;
      const confMiss = r.reason === "LOW_CONFLUENCE" && toNumber(r.reasonScore) > -10;
      return rrMiss || confMiss;
    })
    .sort((a,b) => (b.score || 0) - (a.score || 0))
    .slice(0, 20);
}

function renderNearMiss(rows){
  const data = buildNearMiss(rows);
  const columns = [
    { label: "Coin", render: r => `<strong>${fmtText(r.symbol)}</strong>` },
    { label: "Reason", render: r => reasonLabel(r.reason) },
    { label: "Hoe ver", render: r => fmtSign(r.reasonScore) },
    { label: "Score", render: r => fmtInt(r.score) },
    { label: "RR", render: r => fmtNum(r.rr) },
    { label: "Confluence", render: r => fmtInt(r.confluence) }
  ];
  const html = tableHtml(columns, data, "Geen near misses sinds reset.");
  let container = document.getElementById("nearMissSection");
  if(!container){
    container = document.createElement("div");
    container.id = "nearMissSection";
    container.className = "trade-section";
    document.querySelector(".pageShell").appendChild(container);
  }
  container.innerHTML = `<h2>🔥 NEAR MISS (BIJNA TRADES)</h2>${html}`;
}

function generateInsights(rows){
  const filtered = rows.filter(isTopCandidate);
  let rrMisses = [], confMisses = [];
  for(const r of filtered){
    if(r.reason === "LOW_RR" && typeof toNumber(r.reasonScore) === "number"){
      rrMisses.push(toNumber(r.reasonScore));
    }
    if(r.reason === "LOW_CONFLUENCE" && typeof toNumber(r.reasonScore) === "number"){
      confMisses.push(toNumber(r.reasonScore));
    }
  }
  const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
  const rrAvg = avg(rrMisses);
  const confAvg = avg(confMisses);
  const insights = [];
  if(rrAvg !== null && rrAvg > -0.1){
    insights.push(`📉 RR filter is waarschijnlijk TE streng (gemiddeld tekort = ${fmtSign(rrAvg)}). Overweeg RR eis met 0.05 te verlagen.`);
  } else if(rrAvg !== null && rrAvg <= -0.15){
    insights.push(`✅ RR filter werkt goed (gemiddeld tekort = ${fmtSign(rrAvg)}). Houd vast.`);
  }
  if(confAvg !== null && confAvg < -10){
    insights.push(`✅ Confluence filter is GOED (slechte setups worden geblokkeerd, gemiddeld tekort = ${fmtSign(confAvg)}).`);
  } else if(confAvg !== null && confAvg > -5){
    insights.push(`⚠️ Confluence filter is mogelijk te streng (gemiddeld tekort = ${fmtSign(confAvg)}). Overweeg drempel met 2-3 punten te verlagen.`);
  }
  if(insights.length === 0) insights.push("Nog onvoldoende data om betrouwbare insights te genereren.");
  return insights;
}

function renderInsights(rows){
  const insights = generateInsights(rows);
  let container = document.getElementById("insightsSection");
  if(!container){
    container = document.createElement("div");
    container.id = "insightsSection";
    container.className = "trade-section";
    document.querySelector(".pageShell").appendChild(container);
  }
  container.innerHTML = `<h2>🧠 SYSTEEM INSIGHTS</h2><ul>${insights.map(i => `<li>${i}</li>`).join("")}</ul>`;
}

// ========== LEVEL 10: PURE DATA ENGINE (RSI & RR & INSIGHTS) ==========
function getCleanTrades(trades){
  return trades.filter(t => {
    const isClosed = t.result === "WIN" || t.result === "LOSS";
    const isStrong = Number(t.score || 0) >= 70 || Number(t.confluence || 0) >= 70;
    return isClosed && isStrong;
  });
}

function isReliable(sampleSize){
  return sampleSize >= 30;
}

function buildRSIInsights(trades){
  const clean = getCleanTrades(trades);
  const map = {};
  for(const t of clean){
    const zone = t.rsiZone || "UNKNOWN";
    if(!map[zone]) map[zone] = { win: 0, loss: 0 };
    if(t.result === "WIN") map[zone].win++;
    else map[zone].loss++;
  }
  const result = [];
  for(const zone in map){
    const total = map[zone].win + map[zone].loss;
    if(!isReliable(total)) continue;
    const wr = (map[zone].win / total) * 100;
    result.push({
      zone,
      trades: total,
      winrate: Number(wr.toFixed(1))
    });
  }
  return result.sort((a,b) => b.winrate - a.winrate);
}

function buildRRInsights(trades){
  const clean = getCleanTrades(trades);
  const buckets = {
    LOW: { win: 0, loss: 0 },
    MID: { win: 0, loss: 0 },
    HIGH: { win: 0, loss: 0 }
  };
  for(const t of clean){
    const rr = Number(t.rr || 0);
    const key = rr < 1.2 ? "LOW" : rr < 1.5 ? "MID" : "HIGH";
    if(t.result === "WIN") buckets[key].win++;
    else buckets[key].loss++;
  }
  const out = [];
  for(const k of ["LOW", "MID", "HIGH"]){
    const total = buckets[k].win + buckets[k].loss;
    if(!isReliable(total)) continue;
    const wr = (buckets[k].win / total) * 100;
    out.push({
      bucket: k === "LOW" ? "1.0–1.2" : (k === "MID" ? "1.2–1.5" : "1.5+"),
      trades: total,
      winrate: Number(wr.toFixed(1))
    });
  }
  return out.sort((a,b) => b.winrate - a.winrate);
}

function generateRealInsights(trades){
  const insights = [];
  const rsiData = buildRSIInsights(trades);
  const rrData = buildRRInsights(trades);

  for(const z of rsiData){
    if(z.winrate < 50){
      insights.push(`RSI ${z.zone} verliest geld (${z.winrate}% winrate over ${z.trades} trades)`);
    } else if(z.winrate > 60){
      insights.push(`RSI ${z.zone} sterke zone (${z.winrate}% winrate over ${z.trades} trades)`);
    }
  }

  if(rrData.length){
    const bestRR = rrData[0];
    insights.push(`Beste RR range = ${bestRR.bucket} (${bestRR.winrate}% winrate over ${bestRR.trades} trades)`);
  }

  if(insights.length === 0){
    insights.push("Onvoldoende betrouwbare data (minimaal 30 trades per categorie vereist).");
  }
  return insights;
}

function renderRealInsights(trades){
  const insights = generateRealInsights(trades);
  let container = document.getElementById("dataInsightsSection");
  if(!container){
    container = document.createElement("div");
    container.id = "dataInsightsSection";
    container.className = "trade-section";
    document.querySelector(".pageShell").appendChild(container);
  }
  container.innerHTML = `<h2>🧠 DATA INSIGHTS (REAL ONLY)</h2><ul>${insights.map(i => `<li>${i}</li>`).join("")}</ul>`;
}

// ========== LEVEL 10 – EXPECTANCY PER SETUP (PnL EDGE) ==========
function getRRBucket(rr){
  const r = Number(rr || 0);
  if(r < 1.2) return "LOW";
  if(r < 1.5) return "MID";
  return "HIGH";
}

function calculateExpectancy(trades){
  const clean = getCleanTrades(trades);
  const setups = {};

  for(const t of clean){
    const key = [
      `RSI:${t.rsiZone || "X"}`,
      `RR:${getRRBucket(t.rr)}`,
      `GRADE:${t.grade || "X"}`
    ].join(" | ");

    if(!setups[key]){
      setups[key] = { wins: 0, losses: 0, winRR: [], lossRR: [] };
    }

    if(t.result === "WIN"){
      setups[key].wins++;
      setups[key].winRR.push(Number(t.rr || 0));
    } else {
      setups[key].losses++;
      setups[key].lossRR.push(Number(t.rr || 0));
    }
  }

  const results = [];
  for(const key in setups){
    const s = setups[key];
    const total = s.wins + s.losses;
    if(total < 30) continue; // alleen betrouwbare samples

    const winrate = s.wins / total;
    const avgWin = s.winRR.length ? s.winRR.reduce((a,b)=>a+b,0) / s.winRR.length : 0;
    const avgLoss = s.lossRR.length ? s.lossRR.reduce((a,b)=>a+b,0) / s.lossRR.length : 0;

    const expectancy = (winrate * avgWin) - ((1 - winrate) * avgLoss);

    results.push({
      setup: key,
      trades: total,
      winrate: Number((winrate * 100).toFixed(1)),
      expectancy: Number(expectancy.toFixed(4)),
      avgWin: Number(avgWin.toFixed(2)),
      avgLoss: Number(avgLoss.toFixed(2))
    });
  }

  return results.sort((a,b) => b.expectancy - a.expectancy);
}

function renderExpectancyTable(trades){
  const clean = getCleanTrades(trades);
  const data = calculateExpectancy(clean);
  if(!data.length){
    const emptyMsg = `<div class="emptyState">Onvoldoende data (minder dan 30 trades per setup combinatie).</div>`;
    let container = document.getElementById("expectancySection");
    if(!container){
      container = document.createElement("div");
      container.id = "expectancySection";
      container.className = "trade-section";
      document.querySelector(".pageShell").appendChild(container);
    }
    container.innerHTML = `<h2>💰 EXPECTANCY (REAL DATA)</h2><p class="sectionSub">Alleen echte trades, alleen sterke setups, alleen ≥30 trades per combinatie.</p>${emptyMsg}`;
    return;
  }

  const rows = data.slice(0, 15); // toon top 15 setups
  const columns = [
    { label: "Setup", render: r => `<strong>${escapeHtml(r.setup)}</strong>` },
    { label: "Trades", render: r => fmtInt(r.trades) },
    { label: "Winrate", render: r => `${r.winrate}%` },
    { label: "Expectancy", render: r => `<span style="color:${r.expectancy >= 0 ? '#22c55e' : '#ef4444'}">${fmtNum(r.expectancy, 4)}</span>` },
    { label: "Avg Win (RR)", render: r => fmtNum(r.avgWin, 2) },
    { label: "Avg Loss (RR)", render: r => fmtNum(r.avgLoss, 2) }
  ];

  const html = tableHtml(columns, rows, "Geen expectancy data beschikbaar.");
  let container = document.getElementById("expectancySection");
  if(!container){
    container = document.createElement("div");
    container.id = "expectancySection";
    container.className = "trade-section";
    document.querySelector(".pageShell").appendChild(container);
  }
  container.innerHTML = `<h2>💰 EXPECTANCY (REAL DATA)</h2><p class="sectionSub">Alleen echte trades, alleen sterke setups, alleen ≥30 trades per combinatie.</p>${html}`;
}

// ========== RESET & LOAD ==========
async function resetStats(){
  const ok = window.confirm("Weet je zeker dat je alle opgeslagen tellerstanden en tabellen wilt resetten?");
  if(!ok) return;
  try{
    const res = await fetch("/api/public-latest?action=resetStats", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify({ action: "resetStats" })
    });
    const data = await res.json();
    if(!res.ok || data?.ok === false) throw new Error(data?.error || "reset_failed");
    await load();
  }catch(err){
    console.error(err);
    alert("Reset mislukt.");
  }
}

async function load(){
  try{
    const res = await fetch(`/api/public-latest?_=${Date.now()}`, { cache: "no-store", headers: { "Cache-Control": "no-cache" } });
    const data = await res.json();
    const stats = normalizeDashboardStats(data);
    const liveScanTs = stats.lastScanAt || toNumber(data?.updatedAt) || Date.now();

    const latestTrades = withFallbackScanTs(sortTrades(data?.trades), liveScanTs);
    const latestFunnelRows = flattenFunnel(data?.funnel);

    const liveEntries = latestTrades.filter(t => String(t?.action || "").toUpperCase() === "ENTRY");
    const liveWaitRows = latestTrades.filter(t => String(t?.action || "").toUpperCase() === "WAIT");
    const liveNonWaitTrades = latestTrades.filter(t => String(t?.action || "").toUpperCase() !== "WAIT");

    const storedEntries = withFallbackScanTs(stats.entryRows, liveScanTs);
    const storedRejected = withFallbackScanTs(stats.rejectedRows, liveScanTs);
    const storedTrades = withFallbackScanTs(stats.tradeRows, liveScanTs);

    const entriesToShow = storedEntries.length ? storedEntries : liveEntries;
    const rejectedToShow = storedRejected.length ? storedRejected : liveWaitRows;
    const tradeResultsToShow = storedTrades.length ? storedTrades : liveNonWaitTrades;

    // Basis weergaves
    renderRejectOverviewFromRows(rejectedToShow);
    renderStatus(data, stats, liveEntries, liveWaitRows, liveNonWaitTrades, latestFunnelRows);
    renderEntries(entriesToShow);
    renderFunnel(latestFunnelRows);
    renderRejectedTrades(rejectedToShow);
    renderTradeResults(tradeResultsToShow);

    // LEVEL 2
    renderFilterCombos(rejectedToShow);
    renderNearMiss(rejectedToShow);
    renderInsights(rejectedToShow);

    // LEVEL 10 – Pure Data Engine
    renderRealInsights(tradeResultsToShow);

    // LEVEL 10 – Expectancy (PnL edge)
    renderExpectancyTable(tradeResultsToShow);

    // Verwijder eventuele oude Level 3 secties (voorkom dubbele)
    ["rsiPerformanceSection","rrPerformanceSection","autoTuningSection"].forEach(id => {
      const sec = document.getElementById(id);
      if(sec) sec.remove();
    });

  }catch(e){
    console.error(e);
    if(el("statusLine")) el("statusLine").innerText = "Fout bij laden van signalen.";
    if(el("statsInfo")) el("statsInfo").innerText = "";
    const fail = `<div class="emptyState">Kon data niet laden.</div>`;
    if(el("entriesTable")) el("entriesTable").innerHTML = fail;
    if(el("funnelTable")) el("funnelTable").innerHTML = fail;
    if(el("rejectOverviewTable")) el("rejectOverviewTable").innerHTML = fail;
    if(el("rejectedTradesTable")) el("rejectedTradesTable").innerHTML = fail;
    if(el("tradeResultsTable")) el("tradeResultsTable").innerHTML = fail;
    ["filterCombosSection","nearMissSection","insightsSection","dataInsightsSection","expectancySection"].forEach(id => {
      const sec = document.getElementById(id);
      if(sec) sec.remove();
    });
  }
}

if(el("refreshBtn")) el("refreshBtn").addEventListener("click", () => load());
if(el("resetStatsBtn")) el("resetStatsBtn").addEventListener("click", () => resetStats());

setInterval(load, 10000);
load();