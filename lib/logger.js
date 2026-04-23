import { readDB, writeDB } from "./db.js";

const MAX_RECORDS = 20000;


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


function nowTs(){
  return Date.now();
}


function makeId(prefix, symbol, side){

  const rand = Math.random().toString(36).slice(2, 8);

  return [
    prefix,
    safeString(symbol, "UNKNOWN").toUpperCase(),
    safeString(side, "unknown").toLowerCase(),
    nowTs(),
    rand
  ].join("_");
}


function calculatePnlPctFromValues(entry, exit, side){

  const e = safeNumber(entry);
  const x = safeNumber(exit);
  const s = safeString(side).toLowerCase();

  if(!e || !x){
    return 0;
  }

  if(s === "bear"){
    return ((e - x) / e) * 100;
  }

  return ((x - e) / e) * 100;
}


function calculatePnlPct(trade){
  return calculatePnlPctFromValues(
    trade?.entry,
    trade?.exit,
    trade?.side
  );
}


function normalizeResult(trade, pnlPct){

  if(trade?.result){
    return safeString(trade.result).toUpperCase();
  }

  if(pnlPct > 0) return "WIN";
  if(pnlPct < 0) return "LOSS";

  return "FLAT";
}


function isLegacyTradeRow(row){

  if(!row || typeof row !== "object") return false;
  if(row.logType) return false;

  return (
    row.symbol !== undefined &&
    row.side !== undefined &&
    row.entry !== undefined &&
    row.exit !== undefined
  );
}


function trimDb(db){

  const safeDB = Array.isArray(db)
    ? db
    : [];

  while(safeDB.length > MAX_RECORDS){
    safeDB.shift();
  }

  return safeDB;
}


function pushRow(row){

  const db = trimDb(readDB());

  db.push(row);

  writeDB(trimDb(db));

  return row;
}


// ================= NORMALIZERS =================
function normalizeTrade(trade){

  const pnlPct = calculatePnlPct(trade);
  const result = normalizeResult(trade, pnlPct);

  return {
    id: makeId("TRADE", trade?.symbol, trade?.side),
    logType: "TRADE",
    event: "EXIT",

    symbol: safeString(trade?.symbol, "UNKNOWN").toUpperCase(),
    side: safeString(trade?.side, "unknown").toLowerCase(),

    entry: safeNumber(trade?.entry),
    exit: safeNumber(trade?.exit),
    price: safeNumber(trade?.price, trade?.exit),

    sl: safeNumber(trade?.sl),
    tp: safeNumber(trade?.tp),

    result,
    pnlPct: Number(pnlPct.toFixed(4)),
    rr: safeNumber(trade?.rr),

    reason: safeString(trade?.reason, result),

    grade: safeString(trade?.grade, "N/A"),
    gradePoints: safeNumber(trade?.gradePoints),
    recommendedRisk: safeString(trade?.recommendedRisk, "N/A"),

    confluence: safeNumber(trade?.confluence),
    score: safeNumber(trade?.score),

    flow: safeString(trade?.flow, "N/A"),
    sniper: safeString(trade?.sniper, "N/A"),
    sniperScore: safeNumber(trade?.sniperScore),

    obBias: safeString(trade?.obBias, "N/A"),
    funding: safeNumber(trade?.funding),

    slSource: safeString(trade?.slSource, "N/A"),
    tpSource: safeString(trade?.tpSource, "N/A"),

    regime: safeString(trade?.regime, "N/A"),
    btcState: safeString(trade?.btcState, "N/A"),

    timestamp: nowTs()
  };
}


function normalizeSystemEvent(event){

  return {
    id: makeId("SYSTEM", event?.symbol, event?.side),
    logType: "SYSTEM",
    event: safeString(event?.action || event?.event, "UNKNOWN"),
    action: safeString(event?.action, "UNKNOWN"),

    symbol: safeString(event?.symbol, "UNKNOWN").toUpperCase(),
    side: safeString(event?.side, "unknown").toLowerCase(),

    reason: safeString(event?.reason, "N/A"),
    stage: safeString(event?.stage, "N/A"),

    grade: safeString(event?.grade, "N/A"),
    gradePoints: safeNumber(event?.gradePoints),
    recommendedRisk: safeString(event?.recommendedRisk, "N/A"),

    score: safeNumber(event?.score),
    confluence: safeNumber(event?.confluence),
    rr: safeNumber(event?.rr),

    price: safeNumber(event?.price),
    entry: safeNumber(event?.entry),
    sl: safeNumber(event?.sl),
    tp: safeNumber(event?.tp),

    flow: safeString(event?.flow, "N/A"),
    sniper: safeString(event?.sniper, "N/A"),
    sniperScore: safeNumber(event?.sniperScore),

    obBias: safeString(event?.obBias, "N/A"),
    funding: safeNumber(event?.funding),

    spreadPct: safeNumber(event?.spreadPct),
    depthMinUsd1p: safeNumber(event?.depthMinUsd1p),

    slSource: safeString(event?.slSource, "N/A"),
    tpSource: safeString(event?.tpSource, "N/A"),

    regime: safeString(event?.regime, "N/A"),
    btcState: safeString(event?.btcState, "N/A"),

    timestamp: nowTs()
  };
}


// ================= LOGGERS =================
export function logTrade(trade){

  const row = normalizeTrade(trade || {});
  return pushRow(row);
}


export function logSystemEvent(event){

  const row = normalizeSystemEvent(event || {});
  return pushRow(row);
}


// ================= READERS =================
export function getAllHistory(){

  const db = readDB();

  return Array.isArray(db)
    ? db
    : [];
}


export function getTradeHistory(){

  const db = getAllHistory();

  return db.filter(row => {
    return row?.logType === "TRADE" || isLegacyTradeRow(row);
  });
}


export function getSystemHistory(){

  const db = getAllHistory();

  return db.filter(row => row?.logType === "SYSTEM");
}


// ================= TRADE STATS =================
export function getTradeStats(){

  const trades = getTradeHistory();

  const total = trades.length;
  const wins = trades.filter(t => safeString(t.result).toUpperCase() === "WIN").length;
  const losses = trades.filter(t => safeString(t.result).toUpperCase() === "LOSS").length;
  const flats = trades.filter(t => safeString(t.result).toUpperCase() === "FLAT").length;

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

    const key = safeString(trade?.[field], "UNKNOWN");

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

    if(safeString(trade.result).toUpperCase() === "WIN") groups[key].wins++;
    if(safeString(trade.result).toUpperCase() === "LOSS") groups[key].losses++;

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


// ================= SYSTEM STATS =================
export function getSystemStats(){

  const rows = getSystemHistory();

  const total = rows.length;

  const byActionMap = {};
  const byReasonMap = {};

  for(const row of rows){

    const actionKey = safeString(row.action || row.event, "UNKNOWN");
    const reasonKey = safeString(row.reason, "N/A");

    if(!byActionMap[actionKey]){
      byActionMap[actionKey] = 0;
    }

    if(!byReasonMap[reasonKey]){
      byReasonMap[reasonKey] = 0;
    }

    byActionMap[actionKey]++;
    byReasonMap[reasonKey]++;
  }

  const byAction = Object.entries(byActionMap)
    .map(([key, count]) => ({
      key,
      count,
      pct: total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0
    }))
    .sort((a,b) => b.count - a.count);

  const byReason = Object.entries(byReasonMap)
    .map(([key, count]) => ({
      key,
      count,
      pct: total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0
    }))
    .sort((a,b) => b.count - a.count);

  return {
    total,
    byAction,
    byReason
  };
}


// ================= CLEAR =================
export function clearTradeLog(){

  writeDB([]);

  return {
    ok: true,
    clearedAt: nowTs()
  };
}