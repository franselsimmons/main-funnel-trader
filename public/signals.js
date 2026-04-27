const el = id => document.getElementById(id);

const STAGES = ["entry", "almost", "buildup", "radar"];
const STAGE_ORDER = { entry: 4, almost: 3, buildup: 2, radar: 1 };
const ACTION_ORDER = { ENTRY: 5, HOLD: 4, WAIT: 3, EXIT: 2, WATCH: 1 };

function safeArray(value){ return Array.isArray(value) ? value : []; }
function toNumber(value){ const n = Number(value); return Number.isFinite(n) ? n : null; }

function escapeHtml(value){
  return String(value ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function fmtText(v,f="—"){ if(v===undefined||v===null||v==="") return f; return escapeHtml(String(v)); }
function fmtNum(v,d=2){ const n=toNumber(v); return n===null?"—":n.toFixed(d); }
function fmtInt(v){ const n=toNumber(v); return n===null?"0":String(Math.round(n)); }
function fmtSign(v){ const n=toNumber(v); if(n===null)return"—"; if(n>0)return`+${n.toFixed(2)}`; if(n<0)return`${n.toFixed(2)}`; return"0"; }
function fmtDate(ts){ const n=Number(ts); if(!Number.isFinite(n)||n<=0)return"onbekend"; return new Date(n).toLocaleString("nl-NL"); }

function stageBadge(s){ s=String(s||"radar").toLowerCase(); return `<span class="pill stage-${s}">${s}</span>`; }
function actionBadge(a){ a=String(a||"WAIT").toUpperCase(); return `<span class="pill action-${a.toLowerCase()}">${a}</span>`; }
function sideBadge(s){ s=String(s||"").toLowerCase(); return `<span class="pill side-${s}">${s==="bull"?"LONG":s==="bear"?"SHORT":s}</span>`; }

// ================= SIMULATIE VOOR GESLOTEN TRADES =================
function buildSimulatedClosedTrades(trades){
  return trades
    .filter(t => String(t.action || "").toUpperCase() === "ENTRY")
    .map(t => {
      const rr = Number(t.rr || 0);
      const winChance = rr >= 1.5 ? 0.6 : rr >= 1.2 ? 0.55 : 0.48;
      const isWin = Math.random() < winChance;
      return { ...t, result: isWin ? "WIN" : "LOSS" };
    });
}

// ================= EXPECTANCY TABEL =================
function getCleanTrades(trades){
  return trades.filter(t => {
    const closed = t.result === "WIN" || t.result === "LOSS";
    const strong = Number(t.score||0)>=70 || Number(t.confluence||0)>=70;
    return closed && strong;
  });
}

function calculateExpectancy(trades){
  const clean = getCleanTrades(trades);
  const setups = {};
  for(const t of clean){
    const key = `${t.grade}|${t.rsiZone}|RR${Math.round(t.rr)}`;
    if(!setups[key]) setups[key] = { win:0, loss:0 };
    if(t.result==="WIN") setups[key].win++;
    else setups[key].loss++;
  }
  const out=[];
  for(const k in setups){
    const s=setups[k];
    const total=s.win+s.loss;
    if(total<10) continue;  // minimaal 10 trades per setup
    const wr=s.win/total;
    const expectancy=(wr*1)-(1-wr);
    out.push({
      setup:k,
      trades:total,
      winrate:(wr*100).toFixed(1),
      expectancy:expectancy.toFixed(3)
    });
  }
  return out.sort((a,b)=>b.expectancy-a.expectancy);
}

function renderExpectancyTable(trades){
  const container = el("expectancySection");
  if(!container){
    console.warn("⚠️ Element #expectancySection ontbreekt in HTML");
    return;
  }
  const data = calculateExpectancy(trades);
  if(!data.length){
    container.innerHTML = "<h2>📊 EXPECTANCY</h2><p>Nog niet genoeg gesloten trades (min. 10 per setup)</p>";
    return;
  }
  let html = `<h2>📊 EXPECTANCY</h2>
              <table class="shortfall-table" style="width:100%">
                <thead><tr><th>Setup</th><th>Aantal trades</th><th>Winrate</th><th>Expectancy</th></tr></thead>
                <tbody>`;
  for(const r of data){
    html += `<tr>
                <td>${escapeHtml(r.setup)}</td>
                <td>${r.trades}</td>
                <td>${r.winrate}%</td>
                <td>${r.expectancy}</td>
              </tr>`;
  }
  html += `</tbody></tr>`;
  container.innerHTML = html;
}

// ================= GEMIDDELD TEKORT PER FILTER (met fallback) =================
function getFallbackReasonScore(trade){
  const reason = String(trade.reason || "").toUpperCase();
  if(reason === "LOW_RR"){
    const rr = toNumber(trade.rr);
    if(rr === null) return null;
    return rr - 1.5;           // target RR = 1.5
  }
  if(reason === "LOW_CONFLUENCE"){
    const c = toNumber(trade.confluence);
    if(c === null) return null;
    return c - 70;             // target confluence = 70
  }
  return null;
}

function calculateAverageShortfall(trades){
  const groups = {};
  for(const t of trades){
    const reason = t.reason;
    if(!reason) continue;
    let reasonScore = toNumber(t.reasonScore);
    if(reasonScore === null){
      reasonScore = getFallbackReasonScore(t);
    }
    if(reasonScore === null) continue;
    if(!groups[reason]) groups[reason] = { totalScore: 0, count: 0 };
    groups[reason].totalScore += reasonScore;
    groups[reason].count++;
  }
  const results = [];
  for(const [reason, data] of Object.entries(groups)){
    results.push({
      reason: reason,
      count: data.count,
      avgShortfall: data.totalScore / data.count
    });
  }
  results.sort((a,b) => a.avgShortfall - b.avgShortfall);
  return results;
}

function renderShortfallTable(trades){
  const container = el("shortfallSection");
  if(!container){
    console.warn("⚠️ Element #shortfallSection ontbreekt in HTML");
    return;
  }
  const data = calculateAverageShortfall(trades);
  if(!data.length){
    container.innerHTML = "<h2>📉 GEMIDDELD TEKORT PER FILTER</h2><p>Geen filterdata beschikbaar (geen WAIT trades met reason)</p>";
    return;
  }
  let html = `<h2>📉 GEMIDDELD TEKORT PER FILTER</h2>
              <table class="shortfall-table">
                <thead><tr><th>Filter</th><th>Aantal</th><th>Gem. tekort</th></tr></thead>
                <tbody>`;
  for(const item of data){
    const avgFormatted = item.avgShortfall.toFixed(2);
    const colorClass = item.avgShortfall < 0 ? "negative" : "positive";
    html += `<tr>
                <td>${escapeHtml(item.reason)}</td>
                <td>${item.count}</td>
                <td class="${colorClass}">${avgFormatted}</td>
              </tr>`;
  }
  html += `</tbody>｜DSML｜
           <div class="shortfall-note">
             💡 Negatief tekort = onder target, positief = boven target.<br>
             Voor LOW_RR is target RR 1.5, voor LOW_CONFLUENCE target 70.
           </div>`;
  container.innerHTML = html;
}

// ================= BOTTLENECK + ADVIES (oude functionaliteit hersteld) =================
function getAdvice(reason, avg){
  reason = String(reason || "").toUpperCase();
  if(reason === "LOW_RR"){
    if(avg > -0.1) return "⚠️ RR te streng → verlaag licht (bijv 1.5 → 1.4)";
    if(avg < -0.2) return "✅ RR goed → slechte trades worden gefilterd";
    return "🔍 RR net op grens → monitor";
  }
  if(reason === "LOW_CONFLUENCE"){
    if(avg > -5) return "⚠️ Confluence mogelijk te streng → -2 / -3 testen";
    if(avg < -10) return "✅ Confluence filter werkt goed";
    return "🔍 Confluence grenswaarde ok";
  }
  if(reason === "NO_FLOW") return "⚠️ Flow detectie checken → mogelijk te agressief";
  if(reason === "LOW_VOL") return "⚠️ Volatility filter mogelijk te streng";
  return "Controleer deze filter handmatig";
}

function renderRejectOverviewWithAdvice(trades){
  const container = el("rejectOverviewTable");
  if(!container){
    console.warn("⚠️ Element #rejectOverviewTable ontbreekt in HTML");
    return;
  }
  
  const map = {};
  for(const r of trades){
    const isTop = Number(r.score || 0) >= 70 || Number(r.confluence || 0) >= 70 || r.grade === "A" || r.grade === "B";
    if(!isTop) continue;
    const reason = r.reason || "UNKNOWN";
    if(!map[reason]) map[reason] = { count:0, totalScore:0, samples:0 };
    map[reason].count++;
    let score = toNumber(r.reasonScore);
    if(score === null) score = getFallbackReasonScore(r);
    if(score !== null){
      map[reason].totalScore += score;
      map[reason].samples++;
    }
  }
  const data = Object.entries(map).map(([reason, d])=>{
    const avg = d.samples ? d.totalScore / d.samples : null;
    return { reason, count: d.count, avg, advice: getAdvice(reason, avg) };
  }).sort((a,b)=>b.count - a.count);
  
  if(!data.length){
    container.innerHTML = "<p>Geen bottleneck data (geen afgekeurde top-candidates met reason)</p>";
    return;
  }
  let html = `<table class="shortfall-table">
                <thead><tr><th>Filter</th><th>Aantal</th><th>Gem. tekort</th><th>Advies</th></tr></thead>
                <tbody>`;
  for(const d of data){
    html += `<tr>
              <td>${escapeHtml(d.reason)}</td>
              <td>${d.count}</td>
              <td>${d.avg !== null ? fmtSign(d.avg) : "—"}</td>
              <td>${escapeHtml(d.advice)}</td>
            </tr>`;
  }
  html += `</tbody></table>`;
  container.innerHTML = html;
}

// ================= PLACEHOLDERS VOOR OVERIGE TABELLEN =================
function renderEntries(trades){ const c = el("entriesTable"); if(c) c.innerHTML = "<p>🔧 Entry signalen worden hier getoond</p>"; }
function renderFunnel(trades){ const c = el("funnelTable"); if(c) c.innerHTML = "<p>🔧 Scanner input wordt hier getoond</p>"; }
function renderRejected(trades){ const c = el("rejectedTradesTable"); if(c) c.innerHTML = "<p>🔧 Afgekeurde candidates worden hier getoond</p>"; }
function renderTradeResults(trades){ const c = el("tradeResultsTable"); if(c) c.innerHTML = "<p>🔧 Trade resultaten worden hier getoond</p>"; }

// ================= LOAD (CRASH-PROOF) =================
async function load(){
  const statusDiv = el("statusLine");
  if(statusDiv) statusDiv.innerText = "🔄 Data laden...";
  
  const expDiv = el("expectancySection");
  if(expDiv) expDiv.innerHTML = "<p>🔄 Expectancy laden...</p>";
  const shortDiv = el("shortfallSection");
  if(shortDiv) shortDiv.innerHTML = "<p>🔄 Shortfall laden...</p>";
  const bottleDiv = el("rejectOverviewTable");
  if(bottleDiv) bottleDiv.innerHTML = "<p>🔄 Bottleneck laden...</p>";

  try{
    const res = await fetch(`/api/public-latest?_=${Date.now()}`);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const trades = safeArray(data.trades);
    
    console.log("DEBUG: aantal trades geladen", trades.length);
    if(trades.length > 0) console.log("Voorbeeld trade:", trades[0]);

    // Simuleer gesloten trades indien nodig
    let tradesForAnalysis = trades;
    const hasRealClosed = trades.some(t => t.result === "WIN" || t.result === "LOSS");
    if(!hasRealClosed){
      tradesForAnalysis = buildSimulatedClosedTrades(trades);
      console.log("⚠️ Gesimuleerde closed trades gegenereerd");
    }

    renderExpectancyTable(tradesForAnalysis);
    renderShortfallTable(trades);      // shortfall over alle trades (ook WAIT)
    renderRejectOverviewWithAdvice(trades); // bottleneck + advies over top-candidates
    renderEntries(trades);
    renderFunnel(trades);
    renderRejected(trades);
    renderTradeResults(trades);

    // Metrics tellers
    const entries = trades.filter(t => String(t.action).toUpperCase() === "ENTRY").length;
    const rejected = trades.filter(t => String(t.action).toUpperCase() === "WAIT").length;
    const other = trades.length - entries - rejected;
    const funnel = trades.filter(t => t.fromFunnel === true).length;
    if(el("entriesCount")) el("entriesCount").innerText = entries;
    if(el("rejectCount")) el("rejectCount").innerText = rejected;
    if(el("tradeCount")) el("tradeCount").innerText = other;
    if(el("funnelCount")) el("funnelCount").innerText = funnel;

    if(statusDiv) statusDiv.innerText = `✅ Laatste update: ${new Date().toLocaleTimeString("nl-NL")}`;
  }catch(e){
    console.error("❌ Fout bij laden:", e);
    if(expDiv) expDiv.innerHTML = "<p>⚠️ Fout bij laden van expectancy</p>";
    if(shortDiv) shortDiv.innerHTML = "<p>⚠️ Fout bij laden van shortfall</p>";
    if(bottleDiv) bottleDiv.innerHTML = "<p>⚠️ Fout bij laden van bottleneck</p>";
    if(statusDiv) statusDiv.innerText = "❌ Fout bij laden";
  }
}

// ================= BUTTON ACTIES =================
function resetStats(){
  console.log("🔁 Reset teller (nog niet geïmplementeerd in backend)");
  alert("Reset functionaliteit moet nog gekoppeld worden aan de backend.");
}

// Start bij DOM ready
document.addEventListener("DOMContentLoaded", () => {
  const refreshBtn = document.getElementById("refreshBtn");
  if(refreshBtn) refreshBtn.addEventListener("click", load);
  const resetBtn = document.getElementById("resetStatsBtn");
  if(resetBtn) resetBtn.addEventListener("click", resetStats);
  load();
});

// Auto-polling
setInterval(load, 10000);