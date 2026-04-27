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
    if(total<10) continue;
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
    container.innerHTML = "<h2>EXPECTANCY</h2><p>Nog niet genoeg gesloten trades (min. 10 per setup)</p>";
    return;
  }
  container.innerHTML = `<h2>📊 EXPECTANCY</h2>` +
    data.map(r => `${r.setup} | WR:${r.winrate}% | EXP:${r.expectancy}`).join("<br>");
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
    container.innerHTML = "<h2>📉 GEMIDDELD TEKORT PER FILTER</h2><p>Geen filterdata beschikbaar</p>";
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
  html += `</tbody></table>
           <div class="shortfall-note">
             💡 Negatief tekort = onder target, positief = boven target.<br>
             Voor LOW_RR is target RR 1.5, voor LOW_CONFLUENCE target 70.
           </div>`;
  container.innerHTML = html;
}

// ================= LOAD (CRASH-PROOF) =================
async function load(){
  // Toon loading status in beide secties (als ze bestaan)
  const expDiv = el("expectancySection");
  if(expDiv) expDiv.innerHTML = "<p>🔄 Laden...</p>";
  const shortDiv = el("shortfallSection");
  if(shortDiv) shortDiv.innerHTML = "<p>🔄 Laden...</p>";

  try{
    const res = await fetch(`/api/public-latest?_=${Date.now()}`);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const trades = safeArray(data.trades);

    // Simuleer gesloten trades als die er nog niet zijn
    let tradesForAnalysis = trades;
    const hasRealClosed = trades.some(t => t.result === "WIN" || t.result === "LOSS");
    if(!hasRealClosed){
      tradesForAnalysis = buildSimulatedClosedTrades(trades);
    }

    renderExpectancyTable(tradesForAnalysis);
    renderShortfallTable(tradesForAnalysis);

  }catch(e){
    console.error("❌ Fout bij laden van data:", e);
    const expDiv = el("expectancySection");
    if(expDiv) expDiv.innerHTML = "<p>⚠️ Fout bij laden van trades</p>";
    const shortDiv = el("shortfallSection");
    if(shortDiv) shortDiv.innerHTML = "<p>⚠️ Fout bij laden van filters</p>";
  }
}

// Start polling (elke 10 sec) en direct laden
setInterval(load, 10000);
load();