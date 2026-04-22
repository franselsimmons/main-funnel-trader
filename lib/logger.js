import { readDB, writeDB } from "./db.js";

const MAX_TRADES = 1000;


// ================= HELPERS =================
function safeNumber(value, fallback = 0){

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function safeString(value, fallback = ""){

  if(value === undefined || value === null){
    return fallback;
  }

  return String(value);
}


function calculatePnlPct(trade){

  const entry = safeNumber(trade.entry);
  const exit = safeNumber(trade.exit);
  const side = safeString(trade.side).toLowerCase();

  if(!entry || !exit){
    return 0;
  }

  if(side === "bear"){
    return ((entry - exit) / entry) * 100;
  }

  // default bull
  return ((exit - entry) / entry) * 100;
}


function normalizeResult(trade, pnlPct){

  if(trade.result){
    return safeString(trade.result).toUpperCase();
  }

  if(pnlPct > 0) return "WIN";
  if(pnlPct < 0) return "LOSS";

  return "FLAT";
}


function normalizeTrade(trade){

  const pnlPct = calculatePnlPct(trade);
  const result = normalizeResult(trade, pnlPct);

  return {
    id: `${safeString(trade.symbol)}_${safeString(trade.side)}_${Date.now()}`,

    // core
    symbol: safeString(trade.symbol).toUpperCase(),
    side: safeString(trade.side).toLowerCase(),

    entry: safeNumber(trade.entry),
    exit: safeNumber(trade.exit),
    sl: safeNumber(trade.sl),
    tp: safeNumber(trade.tp),

    result,
    pnlPct: Number(pnlPct.toFixed(4)),
    rr: safeNumber(trade.rr),

    // exit info
    reason: safeString(trade.reason, result),

    // setup quality
    grade: safeString(trade.grade, "N/A"),
    gradePoints: safeNumber(trade.gradePoints),
    recommendedRisk: safeString(trade.recommendedRisk, "N/A"),

    confluence: safeNumber(trade.confluence),
    score: safeNumber(trade.score),

    // signal info
    flow: safeString(trade.flow, "N/A"),
    sniper: safeString(trade.sniper, "N/A"),
    sniperScore: safeNumber(trade.sniperScore),

    // market structure
    obBias: safeString(trade.obBias, "N/A"),
    funding: safeNumber(trade.funding),

    slSource: safeString(trade.slSource, "N/A"),
    tpSource: safeString(trade.tpSource, "N/A"),

    // optional metadata
    regime: safeString(trade.regime, "N/A"),
    btcState: safeString(trade.btcState, "N/A"),

    timestamp: Date.now()
  };
}


// ================= LOG TRADE =================
export function logTrade(trade){

  const db = readDB();

  const safeDB = Array.isArray(db)
    ? db
    : [];

  const row = normalizeTrade(trade || {});

  safeDB.push(row);

  // max trades bewaren
  while(safeDB.length > MAX_TRADES){
    safeDB.shift();
  }

  writeDB(safeDB);

  return row;
}


// ================= READ HISTORY =================
export function getTradeHistory(){

  const db = readDB();

  return Array.isArray(db)
    ? db
    : [];
}


// ================= STATS =================
export function getTradeStats(){

  const trades = getTradeHistory();

  const total = trades.length;
  const wins = trades.filter(t => t.result === "WIN").length;
  const losses = trades.filter(t => t.result === "LOSS").length;
  const flats = trades.filter(t => t.result === "FLAT").length;

  const winrate = total > 0
    ? (wins / total) * 100
    : 0;

  const totalPnlPct = trades.reduce((sum, t) => {
    return sum + safeNumber(t.pnlPct);
  }, 0);

  const avgPnlPct = total > 0
    ? totalPnlPct / total
    : 0;

  const avgRR = total > 0
    ? trades.reduce((sum, t) => sum + safeNumber(t.rr), 0) / total
    : 0;

  return {
    total,
    wins,
    losses,
    flats,
    winrate: Number(winrate.toFixed(2)),
    totalPnlPct: Number(totalPnlPct.toFixed(4)),
    avgPnlPct: Number(avgPnlPct.toFixed(4)),
    avgRR: Number(avgRR.toFixed(2))
  };
}


// ================= STATS BY FIELD =================
export function getStatsBy(field){

  const trades = getTradeHistory();
  const groups = {};

  for(const trade of trades){

    const key = safeString(trade[field], "UNKNOWN");

    if(!groups[key]){
      groups[key] = {
        key,
        total: 0,
        wins: 0,
        losses: 0,
        totalPnlPct: 0
      };
    }

    groups[key].total++;

    if(trade.result === "WIN") groups[key].wins++;
    if(trade.result === "LOSS") groups[key].losses++;

    groups[key].totalPnlPct += safeNumber(trade.pnlPct);
  }

  return Object.values(groups).map(g => ({
    ...g,
    winrate: g.total > 0
      ? Number(((g.wins / g.total) * 100).toFixed(2))
      : 0,
    avgPnlPct: g.total > 0
      ? Number((g.totalPnlPct / g.total).toFixed(4))
      : 0,
    totalPnlPct: Number(g.totalPnlPct.toFixed(4))
  }));
}


// ================= CLEAR =================
export function clearTradeLog(){

  writeDB([]);

  return {
    ok: true,
    clearedAt: Date.now()
  };
}