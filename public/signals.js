const el = id => document.getElementById(id);

// ================= CONSTANTS =================
const STAGES = ["entry","almost","buildup","radar"];

const ACTION_ORDER = {
  ENTRY:5, HOLD:4, WAIT:3, EXIT:2, WATCH:1
};

// ================= HELPERS =================
const safeArray = v => Array.isArray(v) ? v : [];

const toNumber = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const fmt = {
  text: (v,f="—") => (v===undefined||v===null||v==="")?f:String(v),
  num: (v,d=2) => toNumber(v)===null?"—":Number(v).toFixed(d),
  int: v => toNumber(v)===null?"0":String(Math.round(v)),
  sign: v => {
    const n = toNumber(v);
    if(n===null) return "—";
    if(n>0) return `+${n.toFixed(2)}`;
    if(n<0) return n.toFixed(2);
    return "0";
  },
  date: ts => {
    const n = Number(ts);
    return !n?"—":new Date(n).toLocaleString("nl-NL");
  }
};

// ================= CORE =================
function isTop(r){
  return r &&
    (r.score>=70 || r.confluence>=70 || r.grade==="A" || r.grade==="B");
}

// ================= TABLE =================
function table(columns, rows, empty){
  if(!rows.length) return `<div class="emptyState">${empty}</div>`;
  return `
  <div class="tableWrap">
    <table class="signalTable">
      <thead><tr>${columns.map(c=>`<th>${c.label}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map(r=>`
          <tr>
            ${columns.map(c=>`<td>${c.render(r)}</td>`).join("")}
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>`;
}

// ================= RENDER =================
function renderEntries(rows){
  const data = safeArray(rows).sort((a,b)=>b.score-a.score);

  el("entriesTable").innerHTML = table([
    {label:"Coin", render:r=>`<b>${fmt.text(r.symbol)}</b>`},
    {label:"Side", render:r=>fmt.text(r.side)},
    {label:"Score", render:r=>fmt.int(r.score)},
    {label:"RR", render:r=>fmt.num(r.rr)},
    {label:"Entry", render:r=>fmt.num(r.entry)},
    {label:"SL", render:r=>fmt.num(r.sl)},
    {label:"TP", render:r=>fmt.num(r.tp)}
  ], data, "Geen entries");
}

function renderRejected(rows){
  const data = safeArray(rows);

  el("rejectedTradesTable").innerHTML = table([
    {label:"Coin", render:r=>r.symbol},
    {label:"Reason", render:r=>r.reason},
    {label:"Score", render:r=>fmt.int(r.score)},
    {label:"RR", render:r=>fmt.num(r.rr)}
  ], data, "Geen rejected");
}

function renderTrades(rows){
  const data = safeArray(rows);

  el("tradeResultsTable").innerHTML = table([
    {label:"Coin", render:r=>r.symbol},
    {label:"Result", render:r=>r.result || "-"},
    {label:"Score", render:r=>fmt.int(r.score)},
    {label:"RR", render:r=>fmt.num(r.rr)}
  ], data, "Geen trades");
}

// ================= EXPECTANCY =================
function cleanTrades(trades){
  return trades.filter(t =>
    (t.result==="WIN" || t.result==="LOSS") &&
    isTop(t)
  );
}

function rrBucket(rr){
  if(rr<1.2) return "LOW";
  if(rr<1.5) return "MID";
  return "HIGH";
}

function expectancy(trades){
  const map = {};

  for(const t of cleanTrades(trades)){
    const key = `${t.rsiZone}|${rrBucket(t.rr)}|${t.grade}`;

    if(!map[key]) map[key]={w:0,l:0,wr:[],lr:[]};

    if(t.result==="WIN"){
      map[key].w++;
      map[key].wr.push(t.rr);
    }else{
      map[key].l++;
      map[key].lr.push(Math.abs(t.rr));
    }
  }

  const out=[];

  for(const k in map){
    const s = map[k];
    const total = s.w+s.l;
    if(total<30) continue;

    const winrate = s.w/total;
    const avgWin = s.wr.reduce((a,b)=>a+b,0)/s.wr.length || 0;
    const avgLoss = s.lr.reduce((a,b)=>a+b,0)/s.lr.length || 0;

    const exp = (winrate*avgWin) - ((1-winrate)*avgLoss);

    out.push({
      setup:k,
      trades:total,
      winrate:(winrate*100).toFixed(1),
      expectancy:exp.toFixed(4),
      avgWin:avgWin.toFixed(2),
      avgLoss:avgLoss.toFixed(2)
    });
  }

  return out.sort((a,b)=>b.expectancy-a.expectancy);
}

function renderExpectancy(trades){
  const data = expectancy(trades);

  if(!data.length){
    el("expectancySection").innerHTML =
      `<div class="emptyState">Geen expectancy (min 30 trades)</div>`;
    return;
  }

  el("expectancySection").innerHTML = table([
    {label:"Setup", render:r=>r.setup},
    {label:"Trades", render:r=>r.trades},
    {label:"Winrate", render:r=>r.winrate+"%"},
    {label:"Exp", render:r=>r.expectancy},
    {label:"Avg Win", render:r=>r.avgWin},
    {label:"Avg Loss", render:r=>r.avgLoss}
  ], data.slice(0,15), "Geen data");
}

// ================= LOAD =================
async function load(){
  try{
    const res = await fetch(`/api/public-latest?_=${Date.now()}`);

    if(!res.ok) throw new Error("API fail");

    const data = await res.json();

    if(!data || data.ok===false){
      throw new Error("bad data");
    }

    const trades = safeArray(data.trades);

    const entries = trades.filter(t=>t.action==="ENTRY");
    const rejected = trades.filter(t=>t.action==="WAIT");
    const others = trades.filter(t=>t.action!=="WAIT");

    renderEntries(entries);
    renderRejected(rejected);
    renderTrades(others);
    renderExpectancy(others);

  }catch(e){
    console.error(e);

    const fail = `<div class="emptyState">Kon data niet laden</div>`;

    ["entriesTable","rejectedTradesTable","tradeResultsTable","expectancySection"]
      .forEach(id=>{
        if(el(id)) el(id).innerHTML = fail;
      });
  }
}

// ================= INIT =================
setInterval(load, 10000);
load();