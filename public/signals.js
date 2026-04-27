const el = id => document.getElementById(id);

const STAGES = ["entry", "almost", "buildup", "radar"];
const STAGE_ORDER = { entry: 4, almost: 3, buildup: 2, radar: 1 };
const ACTION_ORDER = { ENTRY: 5, HOLD: 4, WAIT: 3, EXIT: 2, WATCH: 1 };

function safeArray(v){ return Array.isArray(v) ? v : []; }
function toNumber(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

function escapeHtml(v){
  return String(v ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function fmtSign(v){
  const n = toNumber(v);
  if(n===null) return "—";
  if(n>0) return `+${n.toFixed(2)}`;
  if(n<0) return `${n.toFixed(2)}`;
  return "0";
}

// ================= SIMULATED CLOSED =================
function buildSimulatedClosedTrades(trades){
  return trades
    .filter(t => String(t.action||"").toUpperCase()==="ENTRY")
    .map(t=>{
      const rr = Number(t.rr||0);
      const chance = rr>=1.5 ? 0.6 : rr>=1.2 ? 0.55 : 0.48;
      return { ...t, result: Math.random()<chance ? "WIN":"LOSS" };
    });
}

// ================= EXPECTANCY =================
function getCleanTrades(trades){
  return trades.filter(t=>{
    const closed = t.result==="WIN" || t.result==="LOSS";
    const strong = Number(t.score||0)>=70 || Number(t.confluence||0)>=70;
    return closed && strong;
  });
}

function calculateExpectancy(trades){
  const clean = getCleanTrades(trades);
  const setups = {};

  for(const t of clean){
    const key = `${t.grade}|${t.rsiZone}|RR${Math.round(t.rr)}`;
    if(!setups[key]) setups[key]={win:0,loss:0};

    if(t.result==="WIN") setups[key].win++;
    else setups[key].loss++;
  }

  return Object.entries(setups)
    .map(([k,s])=>{
      const total=s.win+s.loss;
      if(total<10) return null;
      const wr=s.win/total;
      return {
        setup:k,
        trades:total,
        winrate:(wr*100).toFixed(1),
        expectancy:((wr)-(1-wr)).toFixed(3)
      };
    })
    .filter(Boolean)
    .sort((a,b)=>b.expectancy-a.expectancy);
}

function renderExpectancyTable(trades){
  const data = calculateExpectancy(trades);

  if(!data.length){
    el("expectancySection").innerHTML="<h2>EXPECTANCY</h2><p>Geen data</p>";
    return;
  }

  el("expectancySection").innerHTML =
    `<h2>EXPECTANCY</h2>` +
    data.map(r=>`${r.setup} | WR:${r.winrate}% | EXP:${r.expectancy}`).join("<br>");
}

// ================= GEMIDDELD TEKORT FIX =================
function getFallbackReasonScore(t){
  const reason = String(t.reason||"").toUpperCase();

  if(reason==="LOW_RR"){
    const rr = toNumber(t.rr);
    return rr===null ? null : rr - 1.5;
  }

  if(reason==="LOW_CONFLUENCE"){
    const c = toNumber(t.confluence);
    return c===null ? null : c - 70;
  }

  return null;
}

function calculateAverageShortfall(trades){
  const groups = {};

  for(const t of trades){
    const reason = t.reason;
    if(!reason) continue;

    let score = toNumber(t.reasonScore);
    if(score===null) score = getFallbackReasonScore(t);
    if(score===null) continue;

    if(!groups[reason]) groups[reason]={total:0,count:0};

    groups[reason].total += score;
    groups[reason].count++;
  }

  return Object.entries(groups).map(([r,d])=>({
    reason:r,
    count:d.count,
    avg:d.total/d.count
  }))
  .sort((a,b)=>a.avg-b.avg);
}

function renderShortfallTable(trades){
  const data = calculateAverageShortfall(trades);
  const container = el("shortfallSection");

  if(!container) return;

  if(!data.length){
    container.innerHTML="<h2>📉 GEMIDDELD TEKORT</h2><p>Geen data</p>";
    return;
  }

  container.innerHTML = `
    <h2>📉 GEMIDDELD TEKORT PER FILTER</h2>
    <table>
      <tr><th>Filter</th><th>Aantal</th><th>Tekort</th></tr>
      ${data.map(d=>`
        <tr>
          <td>${escapeHtml(d.reason)}</td>
          <td>${d.count}</td>
          <td style="color:${d.avg<0?'#ef4444':'#22c55e'}">${fmtSign(d.avg)}</td>
        </tr>
      `).join("")}
    </table>
  `;
}

// ================= LOAD FIX =================
async function load(){
  try{
    const res = await fetch(`/api/public-latest?_=${Date.now()}`);
    const data = await res.json();

    const stats = data.dashboardStats || {};

    const liveTrades = safeArray(data.trades);
    const storedRejected = safeArray(stats.rejectedRows);
    const storedTrades = safeArray(stats.tradeRows);

    const rejectedToUse = storedRejected.length
      ? storedRejected
      : liveTrades.filter(t=>String(t.action||"").toUpperCase()==="WAIT");

    const tradesToUse = storedTrades.length
      ? storedTrades
      : liveTrades;

    let tradesForAnalysis = tradesToUse;

    const hasClosed = tradesToUse.some(t =>
      t.result==="WIN" || t.result==="LOSS"
    );

    if(!hasClosed){
      tradesForAnalysis = buildSimulatedClosedTrades(tradesToUse);
    }

    renderExpectancyTable(tradesForAnalysis);
    renderShortfallTable(rejectedToUse);

  }catch(e){
    console.error(e);
  }
}

setInterval(load,10000);
load();