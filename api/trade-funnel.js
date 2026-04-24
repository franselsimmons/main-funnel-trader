import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";

const MAX_STORED_ENTRY_ROWS = 250;
const MAX_STORED_REJECT_ROWS = 500;
const MAX_STORED_TRADE_ROWS = 500;


// ================= GENERIC HELPERS =================
function safeArray(value){
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeText(value, fallback = ""){
  if(value === undefined || value === null) return fallback;
  return String(value);
}

function normalizeNotify(value){
  const v = String(value || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function normalizeStore(value, fallback = true){
  if(value === undefined || value === null){
    return fallback;
  }

  const v = String(value || "").toLowerCase();

  if(v === "false" || v === "0" || v === "no"){
    return false;
  }

  if(v === "true" || v === "1" || v === "yes"){
    return true;
  }

  return fallback;
}

function normalizeCounterMap(map){
  const out = {};

  for(const [key, value] of Object.entries(map || {})){
    const n = Math.round(Number(value || 0));

    if(n > 0){
      out[String(key)] = n;
    }
  }

  return out;
}

function mergeCounterMaps(base = {}, extra = {}){
  const out = { ...normalizeCounterMap(base) };

  for(const [key, value] of Object.entries(normalizeCounterMap(extra))){
    out[key] = (out[key] || 0) + value;
  }

  return out;
}

function buildCounterMap(rows, field){
  const out = {};

  for(const row of safeArray(rows)){
    const key = safeText(row?.[field], "UNKNOWN");
    out[key] = (out[key] || 0) + 1;
  }

  return out;
}

function compactTradeRow(row, scanTs){
  const symbol = safeText(row?.symbol, "UNKNOWN");
  const side = safeText(row?.side, "unknown");
  const action = safeText(row?.action, "UNKNOWN");
  const reason = safeText(row?.reason, "UNKNOWN");
  const stage = safeText(row?.stage, "radar");

  return {
    uid: `${scanTs}_${symbol}_${side}_${action}_${reason}_${stage}`,
    scanTs,
    symbol,
    side,
    action,
    reason,
    stage,

    score: safeNumber(row?.score ?? row?.moveScore, 0),
    confluence: safeNumber(row?.confluence, 0),
    rr: safeNumber(row?.rr, 0),

    price: safeNumber(row?.price, 0),
    entry: safeNumber(row?.entry, 0),
    sl: safeNumber(row?.sl, 0),
    tp: safeNumber(row?.tp, 0),

    grade: safeText(row?.grade, "N/A"),
    flow: safeText(row?.flow, "NEUTRAL"),
    sniper: safeText(row?.sniper, "NONE"),
    obBias: safeText(row?.obBias, "NEUTRAL"),

    tfScore: safeNumber(row?.tfScore, 0),
    tfStrength: safeNumber(row?.tfStrength, 0),
    tfAlignment: safeText(row?.tfAlignment, "UNKNOWN")
  };
}

function mergeStoredRows(prevRows, nextRows, max){
  const merged = [];
  const seen = new Set();

  for(const row of [...safeArray(nextRows), ...safeArray(prevRows)]){
    const uid =
      safeText(
        row?.uid,
        `${safeNumber(row?.scanTs, 0)}_${safeText(row?.symbol)}_${safeText(row?.action)}_${safeText(row?.reason)}_${safeText(row?.side)}_${safeText(row?.stage)}`
      );

    if(seen.has(uid)) continue;

    seen.add(uid);
    merged.push({
      ...row,
      uid
    });
  }

  merged.sort((a, b) => {
    const tsDiff = safeNumber(b?.scanTs, 0) - safeNumber(a?.scanTs, 0);
    if(tsDiff !== 0) return tsDiff;

    return safeNumber(b?.score, 0) - safeNumber(a?.score, 0);
  });

  return merged.slice(0, max);
}

function emptyDashboardStats(now = Date.now()){
  return {
    startedAt: now,
    lastResetAt: now,
    lastScanAt: 0,

    totalScans: 0,
    totalEntries: 0,
    totalRejected: 0,
    totalOtherTrades: 0,
    totalFunnelCoins: 0,
    totalCandidates: 0,

    lastEntries: 0,
    lastRejected: 0,
    lastOtherTrades: 0,
    lastFunnelCoins: 0,
    lastCandidates: 0,

    rejectReasonCounts: {},
    actionCounts: {},

    entryRows: [],
    rejectedRows: [],
    tradeRows: []
  };
}

function normalizeDashboardStats(stats, now = Date.now()){
  const base = stats ? { ...stats } : emptyDashboardStats(now);

  return {
    startedAt: safeNumber(base?.startedAt, now),
    lastResetAt: safeNumber(base?.lastResetAt, safeNumber(base?.startedAt, now)),
    lastScanAt: safeNumber(base?.lastScanAt, 0),

    totalScans: safeNumber(base?.totalScans, 0),
    totalEntries: safeNumber(base?.totalEntries, 0),
    totalRejected: safeNumber(base?.totalRejected, 0),
    totalOtherTrades: safeNumber(base?.totalOtherTrades, 0),
    totalFunnelCoins: safeNumber(base?.totalFunnelCoins, 0),
    totalCandidates: safeNumber(base?.totalCandidates, 0),

    lastEntries: safeNumber(base?.lastEntries, 0),
    lastRejected: safeNumber(base?.lastRejected, 0),
    lastOtherTrades: safeNumber(base?.lastOtherTrades, 0),
    lastFunnelCoins: safeNumber(base?.lastFunnelCoins, 0),
    lastCandidates: safeNumber(base?.lastCandidates, 0),

    rejectReasonCounts: normalizeCounterMap(base?.rejectReasonCounts),
    actionCounts: normalizeCounterMap(base?.actionCounts),

    entryRows: mergeStoredRows([], safeArray(base?.entryRows), MAX_STORED_ENTRY_ROWS),
    rejectedRows: mergeStoredRows([], safeArray(base?.rejectedRows), MAX_STORED_REJECT_ROWS),
    tradeRows: mergeStoredRows([], safeArray(base?.tradeRows), MAX_STORED_TRADE_ROWS)
  };
}

function buildDashboardStats(prevStats, trades, processedCoinCount, now, resetStats = false){
  const prev = resetStats
    ? emptyDashboardStats(now)
    : normalizeDashboardStats(prevStats, now);

  const allTrades = safeArray(trades);
  const entries = allTrades.filter(t => safeText(t?.action).toUpperCase() === "ENTRY");
  const waits = allTrades.filter(t => safeText(t?.action).toUpperCase() === "WAIT");
  const otherTrades = allTrades.filter(t => {
    const action = safeText(t?.action).toUpperCase();
    return action !== "WAIT" && action !== "ENTRY";
  });

  const nonWaitTrades = allTrades.filter(t => safeText(t?.action).toUpperCase() !== "WAIT");

  return {
    startedAt: resetStats ? now : prev.startedAt,
    lastResetAt: resetStats ? now : prev.lastResetAt,
    lastScanAt: now,

    totalScans: (resetStats ? 0 : prev.totalScans) + 1,
    totalEntries: (resetStats ? 0 : prev.totalEntries) + entries.length,
    totalRejected: (resetStats ? 0 : prev.totalRejected) + waits.length,
    totalOtherTrades: (resetStats ? 0 : prev.totalOtherTrades) + otherTrades.length,
    totalFunnelCoins: (resetStats ? 0 : prev.totalFunnelCoins) + safeNumber(processedCoinCount, 0),
    totalCandidates: (resetStats ? 0 : prev.totalCandidates) + safeNumber(processedCoinCount, 0),

    lastEntries: entries.length,
    lastRejected: waits.length,
    lastOtherTrades: otherTrades.length,
    lastFunnelCoins: safeNumber(processedCoinCount, 0),
    lastCandidates: safeNumber(processedCoinCount, 0),

    rejectReasonCounts: mergeCounterMaps(
      resetStats ? {} : prev.rejectReasonCounts,
      buildCounterMap(waits, "reason")
    ),

    actionCounts: mergeCounterMaps(
      resetStats ? {} : prev.actionCounts,
      buildCounterMap(allTrades, "action")
    ),

    entryRows: mergeStoredRows(
      resetStats ? [] : prev.entryRows,
      entries.map(row => compactTradeRow(row, now)),
      MAX_STORED_ENTRY_ROWS
    ),

    rejectedRows: mergeStoredRows(
      resetStats ? [] : prev.rejectedRows,
      waits.map(row => compactTradeRow(row, now)),
      MAX_STORED_REJECT_ROWS
    ),

    tradeRows: mergeStoredRows(
      resetStats ? [] : prev.tradeRows,
      nonWaitTrades.map(row => compactTradeRow(row, now)),
      MAX_STORED_TRADE_ROWS
    )
  };
}


// ================= ANALYSIS HELPERS =================
function pct(count, total){
  if(!total) return 0;
  return Number(((count / total) * 100).toFixed(1));
}

function avg(list, field){
  const nums = list
    .map(x => Number(x?.[field] || 0))
    .filter(n => Number.isFinite(n));

  if(!nums.length) return 0;

  return Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2));
}

function groupByCount(list, field){
  const out = {};

  for(const item of list){
    const key = String(item?.[field] || "UNKNOWN");

    if(!out[key]){
      out[key] = 0;
    }

    out[key]++;
  }

  return out;
}

function toRows(group, total){
  return Object.entries(group)
    .map(([key, count]) => ({
      key,
      count,
      pct: pct(count, total)
    }))
    .sort((a, b) => b.count - a.count);
}

function getReasonAdvice(reason){
  const map = {
    MAX_OPEN_TRADES: "Max open trades bereikt. Geen filterprobleem.",
    SYMBOL_COOLDOWN: "Cooldown voorkomt dubbele entries op dezelfde coin.",
    COOLDOWN: "Cooldown actief na vorige trade.",
    OPPOSITE_POSITION_OPEN: "Tegengestelde positie wordt correct geblokkeerd.",
    DUPLICATE_PROCESSING_LOCK: "Duplicate protection werkt.",
    LOW_VOL: "Te weinig volatiliteit. Correct geblokkeerd.",
    NO_FLOW: "Geen duidelijke flow. Correct geblokkeerd.",
    LOW_CONFLUENCE: "Setup mist bevestiging. Confluence niet zomaar versoepelen.",
    LOW_RR: "Risk/reward is te zwak. Dit voorkomt late entries.",
    FAKE_BREAKOUT: "Dynamische fake breakout-bescherming werkt.",
    OB_AGAINST: "Orderboek staat tegen trade. Correct geblokkeerd.",
    NO_LIQUIDATION_ROOM: "Te weinig ruimte naar liquidation/TP-zone.",
    BAD_MARKET_QUALITY: "Spread/depth slecht. Correct geblokkeerd.",
    OB_NEUTRAL_LOW_CONF: "Orderboek neutraal. Alleen sterke uitzonderingen mogen nog door.",
    EXTREME_FUNDING: "Funding-risico. Correct geblokkeerd.",
    BULL_CROWDED_FUNDING: "Long te crowded. Correct geblokkeerd.",
    BEAR_CROWDED_FUNDING: "Short te crowded. Correct geblokkeerd.",
    BTC_BULL_BLOCK_SHORT: "Short tegen bullish BTC geblokkeerd.",
    BTC_BEAR_BLOCK_LONG: "Long tegen bearish BTC geblokkeerd.",
    COUNTERTREND_NOT_ELITE: "Countertrend is niet elite genoeg. Correct.",
    ENTRY_FILTERED: "Entry kwam niet door de laatste kwaliteitscheck.",
    ORDERBOOK_FETCH_FAILED: "Orderboek kon niet worden opgehaald. Geen blind entry zonder uitvoerbare live marktdata."
  };

  if(String(reason || "").startsWith("SYMBOL_ALREADY_OPEN_")){
    return "Er staat al een positie open op deze coin. Correct geblokkeerd.";
  }

  return map[reason] || "Geen specifieke actie nodig.";
}

function buildTradeSystemAnalysis(trades){
  const list = Array.isArray(trades)
    ? trades
    : [];

  const total = list.length;

  const entries = list.filter(t => t.action === "ENTRY");
  const waits = list.filter(t => t.action === "WAIT");
  const holds = list.filter(t => t.action === "HOLD");
  const exits = list.filter(t => t.action === "EXIT");

  const reasonGroup = groupByCount(waits, "reason");
  const gradeGroup = groupByCount(list, "grade");
  const actionGroup = groupByCount(list, "action");
  const obGroup = groupByCount(list, "obBias");
  const sideGroup = groupByCount(list, "side");

  const waitReasons = toRows(reasonGroup, waits.length).map(row => ({
    ...row,
    advice: getReasonAdvice(row.key)
  }));

  const entryRate = pct(entries.length, total);
  const waitRate = pct(waits.length, total);

  const avgConfluence = avg(list, "confluence");
  const avgRR = avg(list, "rr");
  const avgScore = avg(list, "score");

  const topReason = waitReasons[0]?.key || null;
  const topReasonPct = waitReasons[0]?.pct || 0;

  const recommendations = {
    moreTrades: [],
    higherWinrate: [],
    higherPnl: []
  };

  if(total === 0){
    recommendations.moreTrades.push(
      "Geen entry-coins uit scanner of geen trade-candidates deze run."
    );
  }

  if(total >= 8 && entryRate < 5){
    recommendations.moreTrades.push(
      "Entry-rate is laag. Grootste WAIT-reasons geven de bottleneck aan."
    );
  }

  if(topReason === "MAX_OPEN_TRADES"){
    recommendations.moreTrades.push(
      "MAX_OPEN_TRADES blokkeert trades. Alleen verhogen met goede closed-trade data."
    );
  }

  if(topReason === "SYMBOL_COOLDOWN" || topReason === "COOLDOWN"){
    recommendations.moreTrades.push(
      "Cooldown blokkeert herentries. Alleen aanpassen als dit structureel te vaak voorkomt."
    );
  }

  if(topReason === "LOW_CONFLUENCE"){
    recommendations.higherWinrate.push(
      "Confluence niet zomaar versoepelen."
    );
  }

  if(topReason === "OB_AGAINST" || topReason === "BAD_MARKET_QUALITY"){
    recommendations.higherWinrate.push(
      "Orderboek- en execution-filters beschermen kwaliteit."
    );
  }

  if(entries.length > 0 && avgRR < 1){
    recommendations.higherPnl.push(
      "Gemiddelde RR is laag. Kijk naar LOW_RR en late entries."
    );
  }

  if(recommendations.moreTrades.length === 0){
    recommendations.moreTrades.push(
      "Gebruik rejectReasonCounts om te zien welke filter de grootste bottleneck is."
    );
  }

  if(recommendations.higherWinrate.length === 0){
    recommendations.higherWinrate.push(
      "Winrate-filters ogen gezond."
    );
  }

  if(recommendations.higherPnl.length === 0){
    recommendations.higherPnl.push(
      "PnL-advies wordt sterker zodra er meer scans en closed trades zijn."
    );
  }

  let advice = "Trade funnel scan voltooid.";

  if(total === 0){
    advice = "Geen scanner-entry-coins om door trade funnel te halen.";
  }else if(entries.length === 0 && waits.length > 0){
    advice = `Geen entries. Grootste blokkade: ${topReason || "UNKNOWN"}.`;
  }

  return {
    total,
    entries: entries.length,
    waits: waits.length,
    holds: holds.length,
    partials: 0,
    exits: exits.length,

    entryRate,
    waitRate,

    avgConfluence,
    avgRR,
    avgScore,

    topReason,
    topReasonPct,

    actions: toRows(actionGroup, total),
    grades: toRows(gradeGroup, total),
    obBias: toRows(obGroup, total),
    sides: toRows(sideGroup, total),
    waitReasons,

    recommendations,
    advice
  };
}


// ================= TRADE INPUT =================
function getTradeFunnelCandidates(latest){
  const raw = [
    ...safeArray(latest?.funnel?.bull?.entry),
    ...safeArray(latest?.funnel?.bear?.entry)
  ];

  const map = new Map();

  for(const coin of raw){
    if(!coin) continue;
    if(Boolean(coin.uiOnly)) continue;
    if(String(coin.stage || "").toLowerCase() !== "entry") continue;

    const symbol = String(coin.symbol || "").toUpperCase();
    const side = String(coin.side || "").toLowerCase();

    if(!symbol) continue;
    if(side !== "bull" && side !== "bear") continue;

    const key = `${symbol}_${side}`;

    // NIEUW: expliciet exchangeSymbol en marketSymbol doorgeven
    map.set(key, {
      ...coin,
      symbol,
      side,
      stage: "entry",
      exchangeSymbol: coin.exchangeSymbol || coin.marketSymbol || `${symbol}USDT`,
      marketSymbol: coin.marketSymbol || coin.exchangeSymbol || `${symbol}USDT`
    });
  }

  return Array.from(map.values());
}


// ================= CORE =================
export async function runTradeFunnel(options = {}){
  const notify = options.notify !== false;
  const store = options.store !== false;
  const resetStats = options.resetStats === true;

  const latest = await getLatestScan();

  if(!latest?.ok){
    throw new Error("no_latest_scan_available");
  }

  const candidates = getTradeFunnelCandidates(latest);
  const now = Date.now();

  const trades = candidates.length
    ? await processTrades(
        candidates,
        latest?.btc || null,
        "auto",
        latest?.regime || null,
        {
          notify,
          log: true
        }
      )
    : [];

  const dashboardStats = buildDashboardStats(
    latest?.dashboardStats,
    trades,
    candidates.length,
    now,
    resetStats
  );

  const tradeSystemAnalysis = buildTradeSystemAnalysis(trades);

  const bullInput = candidates.filter(c => c.side === "bull").length;
  const bearInput = candidates.filter(c => c.side === "bear").length;

  const updated = {
    ...latest,
    ok: true,

    notify,
    store,
    resetStats,

    trades,
    dashboardStats,
    tradeSystemAnalysis,

    tradeFunnelInputCount: candidates.length,
    tradeFunnelInputBull: bullInput,
    tradeFunnelInputBear: bearInput,

    tradeFunnelUpdatedAt: now,
    updatedAt: now
  };

  if(store){
    await setLatestScan(updated);
  }

  return updated;
}


// ================= HANDLER =================
export default async function handler(req, res){
  try{
    const notify = normalizeNotify(req?.query?.notify);
    const store = normalizeStore(req?.query?.store, true);
    const resetStats =
      normalizeStore(req?.query?.resetStats, false) ||
      normalizeStore(req?.query?.reset, false);

    const data = await runTradeFunnel({
      notify,
      store,
      resetStats
    });

    return res.status(200).json(data);

  }catch(e){
    console.error("TRADE-FUNNEL ERROR:", e);

    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}