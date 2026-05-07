import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";

const MAX_STORED_ENTRY_ROWS = 250;
const MAX_STORED_REJECT_ROWS = 500;
const MAX_STORED_TRADE_ROWS = 500;

// ================= GENERIC HELPERS =================
function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// FIX: default moet TRUE zijn.
// /api/trade-funnel = notify aan
// /api/trade-funnel?notify=false = notify uit
function normalizeNotify(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;

  return fallback;
}

function normalizeStore(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();

  if (["false", "0", "no", "n"].includes(v)) return false;
  if (["true", "1", "yes", "y"].includes(v)) return true;

  return fallback;
}

function incrementCounter(map, key) {
  map[key] = Number(map[key] || 0) + 1;
}

function stageRank(stage) {
  const s = String(stage || "").toLowerCase();

  if (s === "entry") return 2;
  if (s === "almost") return 1;

  return 0;
}

function flowRank(flow) {
  const f = String(flow || "").toUpperCase();

  if (f === "TREND") return 2;
  if (f === "BUILDING") return 1;

  return 0;
}

function candidateQualityScore(c) {
  const score = safeNumber(c.moveScore, 0);
  const vm = safeNumber(c.vm, 0);
  const tfStrength = safeNumber(c.tfStrength, Math.abs(safeNumber(c.tfScore, 0)));
  const stage = String(c.stage || "").toLowerCase();
  const flow = String(c.flow || "NEUTRAL").toUpperCase();

  return (
    score +
    stageRank(stage) * 8 +
    flowRank(flow) * 6 +
    Math.min(tfStrength * 4, 10) +
    Math.min(vm * 40, 10)
  );
}

function trimArray(rows, max) {
  if (!Array.isArray(rows)) return [];
  if (rows.length <= max) return rows;
  return rows.slice(-max);
}

function buildActionSummary(actions) {
  const rows = safeArray(actions);

  const actionCounts = {};
  const waitReasonCounts = {};
  const entryRows = [];

  for (const row of rows) {
    const action = String(row?.action || "UNKNOWN").toUpperCase();
    const reason = String(row?.reason || "UNKNOWN").toUpperCase();

    incrementCounter(actionCounts, action);

    if (action === "WAIT") {
      incrementCounter(waitReasonCounts, reason);
    }

    if (action === "ENTRY") {
      entryRows.push({
        symbol: row.symbol,
        side: row.side,
        setupClass: row.setupClass,
        reason: row.reason,
        score: row.score,
        confluence: row.confluence,
        sniperScore: row.sniperScore,
        rr: row.rr,
        entry: row.entry,
        sl: row.sl,
        tp: row.tp,
      });
    }
  }

  const topWaitReasons = Object.entries(waitReasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    totalActions: rows.length,
    actionCounts,
    entries: entryRows.length,
    entryRows,
    topWaitReasons,
  };
}

// ================= TRADE-FUNNEL GATE =================
function passesTradeFunnelGate(coin) {
  const symbol = String(coin?.symbol || "").toUpperCase().trim();
  const side = String(coin?.side || "").toLowerCase().trim();
  const stage = String(coin?.stage || "").toLowerCase();
  const flow = String(coin?.flow || "NEUTRAL").toUpperCase();

  const score = safeNumber(coin?.moveScore, 0);
  const vm = safeNumber(coin?.vm, 0);
  const tfScore = safeNumber(coin?.tfScore, 0);
  const tfStrength = safeNumber(coin?.tfStrength, Math.abs(tfScore));

  if (!symbol) {
    return { ok: false, reason: "NO_SYMBOL" };
  }

  if (side !== "bull" && side !== "bear") {
    return { ok: false, reason: "BAD_SIDE" };
  }

  if (Boolean(coin.uiOnly)) {
    return { ok: false, reason: "UI_ONLY" };
  }

  if (stage !== "entry" && stage !== "almost") {
    return { ok: false, reason: "BAD_STAGE" };
  }

  if (flow === "NEUTRAL") {
    return { ok: false, reason: "FLOW_NEUTRAL" };
  }

  if (stage === "entry" && score < 62) {
    return { ok: false, reason: "ENTRY_SCORE_TOO_LOW" };
  }

  if (stage === "almost" && score < 68) {
    return { ok: false, reason: "ALMOST_SCORE_TOO_LOW" };
  }

  if (flow === "BUILDING" && score < 70) {
    return { ok: false, reason: "BUILDING_SCORE_TOO_LOW" };
  }

  if (vm < 0.055) {
    return { ok: false, reason: "VM_TOO_LOW" };
  }

  if (tfStrength < 1) {
    return { ok: false, reason: "TF_TOO_WEAK" };
  }

  if (flow === "BUILDING" && tfStrength < 1.4) {
    return { ok: false, reason: "BUILDING_TF_TOO_WEAK" };
  }

  return { ok: true, reason: "OK" };
}

// ================= CANDIDATE SELECTOR =================
function getTradeFunnelCandidates(latest) {
  const buckets = [
    ...safeArray(latest?.funnel?.bull?.entry),
    ...safeArray(latest?.funnel?.bear?.entry),
    ...safeArray(latest?.funnel?.bull?.almost),
    ...safeArray(latest?.funnel?.bear?.almost),
  ];

  const accepted = new Map();
  const rejectCounts = {};

  for (const coin of buckets) {
    if (!coin) continue;

    const gate = passesTradeFunnelGate(coin);

    if (!gate.ok) {
      incrementCounter(rejectCounts, gate.reason);
      continue;
    }

    const symbol = String(coin.symbol || "").toUpperCase().trim();
    const side = String(coin.side || "").toLowerCase().trim();
    const stage = String(coin.stage || "radar").toLowerCase();
    const flow = String(coin.flow || "NEUTRAL").toUpperCase();

    const score = safeNumber(coin.moveScore, 0);
    const vm = safeNumber(coin.vm, 0);
    const tfScore = safeNumber(coin.tfScore, 0);
    const tfStrength = safeNumber(coin.tfStrength, Math.abs(tfScore));

    const normalized = {
      ...coin,

      symbol,
      side,
      stage,
      scannerStage: stage,
      flow,

      moveScore: score,
      vm,
      tfScore,
      tfStrength,

      uiOnly: false,

      tradeFunnelQuality: candidateQualityScore({
        ...coin,
        symbol,
        side,
        stage,
        flow,
        moveScore: score,
        vm,
        tfScore,
        tfStrength,
      }),
    };

    const key = `${symbol}_${side}`;
    const prev = accepted.get(key);

    if (!prev) {
      accepted.set(key, normalized);
      continue;
    }

    if (candidateQualityScore(normalized) > candidateQualityScore(prev)) {
      accepted.set(key, normalized);
    }
  }

  const result = Array.from(accepted.values()).sort((a, b) => {
    const qDiff = safeNumber(b.tradeFunnelQuality, 0) - safeNumber(a.tradeFunnelQuality, 0);
    if (qDiff !== 0) return qDiff;

    const stageDiff = stageRank(b.stage) - stageRank(a.stage);
    if (stageDiff !== 0) return stageDiff;

    return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
  });

  console.log("TRADE FUNNEL raw:", buckets.length);
  console.log("TRADE FUNNEL accepted:", result.length);
  console.log("TRADE FUNNEL rejected:", rejectCounts);
  console.log(
    "TRADE FUNNEL symbols:",
    result.map(c => `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore)}`).join(", ")
  );

  return {
    candidates: result,
    rawCount: buckets.length,
    rejected: rejectCounts,
  };
}

// ================= CORE =================
export async function runTradeFunnel(options = {}) {
  const notify = options.notify !== false;
  const store = options.store !== false;

  const latest = await getLatestScan();

  if (!latest?.ok) {
    throw new Error("no_latest_scan_available");
  }

  const {
    candidates,
    rawCount,
    rejected,
  } = getTradeFunnelCandidates(latest);

  const now = Date.now();

  const result = candidates.length
    ? await processTrades(candidates, {
        notify,
        log: true,
        analyze: false,
        certaintyMode: "aggressive",
        btc: latest.btc,
        regime: latest.regime,
        market: latest.market,
      })
    : {
        actions: [],
        candidatesCount: 0,
        strategyVersion: "NO_CANDIDATES",
      };

  const trades = Array.isArray(result)
    ? result
    : Array.isArray(result?.actions)
      ? result.actions
      : [];

  const summary = buildActionSummary(trades);

  console.log("TRADE_FUNNEL_RESULT_SUMMARY", JSON.stringify({
    notify,
    store,
    rawCount,
    accepted: candidates.length,
    rejected,
    candidatesCount: result?.candidatesCount ?? candidates.length,
    ...summary,
  }));

  const updated = {
    ...latest,

    ok: true,

    trades: trimArray(trades, MAX_STORED_TRADE_ROWS),
    tradeSystemResult: {
      ...result,
      actions: trimArray(trades, MAX_STORED_TRADE_ROWS),
    },

    tradeFunnelInputCount: candidates.length,
    tradeFunnelRawCount: rawCount,
    tradeFunnelRejected: rejected,

    tradeFunnelInputSymbols: candidates
      .slice(0, MAX_STORED_ENTRY_ROWS)
      .map(c => `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore || 0)}`),

    tradeFunnelActionSummary: summary,

    tradeFunnelUpdatedAt: now,
    updatedAt: now,
  };

  if (store) {
    await setLatestScan(updated);
  }

  return updated;
}

// ================= HANDLER =================
export default async function handler(req, res) {
  try {
    // FIX: standaard TRUE.
    // Gewoon /api/trade-funnel draaien = Discord aan.
    // Alleen /api/trade-funnel?notify=false zet Discord uit.
    const notify = normalizeNotify(req?.query?.notify, true);
    const store = normalizeStore(req?.query?.store, true);

    console.log("TRADE_FUNNEL_HANDLER_START", JSON.stringify({
      notify,
      store,
      query: req?.query || {},
    }));

    const data = await runTradeFunnel({
      notify,
      store,
    });

    return res.status(200).json(data);
  } catch (e) {
    console.error("TRADE-FUNNEL ERROR:", {
      message: e.message,
      stack: e.stack,
    });

    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
}