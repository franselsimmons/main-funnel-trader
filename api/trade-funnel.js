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

function normalizeNotify(value) {
  const v = String(value || "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function normalizeStore(value, fallback = true) {
  if (value === undefined || value === null) return fallback;

  const v = String(value || "").toLowerCase();

  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;

  return fallback;
}

function incrementCounter(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function stageRank(stage) {
  if (stage === "entry") return 2;
  if (stage === "almost") return 1;
  return 0;
}

function flowRank(flow) {
  if (flow === "TREND") return 2;
  if (flow === "BUILDING") return 1;
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

// ================= TRADE-FUNNEL GATE =================
function passesTradeFunnelGate(coin) {
  const symbol = String(coin.symbol || "").toUpperCase().trim();
  const side = String(coin.side || "").toLowerCase().trim();
  const stage = String(coin.stage || "").toLowerCase();
  const flow = String(coin.flow || "NEUTRAL").toUpperCase();

  const score = safeNumber(coin.moveScore, 0);
  const vm = safeNumber(coin.vm, 0);
  const tfScore = safeNumber(coin.tfScore, 0);
  const tfStrength = safeNumber(coin.tfStrength, Math.abs(tfScore));

  if (!symbol) {
    return { ok: false, reason: "NO_SYMBOL" };
  }

  if (side !== "bull" && side !== "bear") {
    return { ok: false, reason: "BAD_SIDE" };
  }

  if (Boolean(coin.uiOnly)) {
    return { ok: false, reason: "UI_ONLY" };
  }

  // Scanner-entry = hot table, geen echte trade-entry.
  // TradeSystem krijgt alleen entry/almost.
  if (stage !== "entry" && stage !== "almost") {
    return { ok: false, reason: "BAD_STAGE" };
  }

  if (flow === "NEUTRAL") {
    return { ok: false, reason: "FLOW_NEUTRAL" };
  }

  // Entry mag iets lager dan almost, want entry komt al uit de sterkste scanner-bucket.
  if (stage === "entry" && score < 62) {
    return { ok: false, reason: "ENTRY_SCORE_TOO_LOW" };
  }

  if (stage === "almost" && score < 68) {
    return { ok: false, reason: "ALMOST_SCORE_TOO_LOW" };
  }

  // BUILDING is minder sterk dan TREND.
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
    ...safeArray(latest?.funnel?.bear?.almost)
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
      tradeFunnelQuality: candidateQualityScore({
        ...coin,
        symbol,
        side,
        stage,
        flow,
        moveScore: score,
        vm,
        tfScore,
        tfStrength
      })
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

  return result;
}

// ================= CORE =================
export async function runTradeFunnel(options = {}) {
  const notify = options.notify !== false;
  const store = options.store !== false;

  const latest = await getLatestScan();

  if (!latest?.ok) {
    throw new Error("no_latest_scan_available");
  }

  const candidates = getTradeFunnelCandidates(latest);
  const now = Date.now();

  const result = candidates.length
    ? await processTrades(candidates, {
        notify,
        log: true,
        btc: latest.btc,
        regime: latest.regime,
        market: latest.market
      })
    : { actions: [], candidatesCount: 0 };

  const trades = Array.isArray(result)
    ? result
    : Array.isArray(result?.actions)
      ? result.actions
      : [];

  const updated = {
    ...latest,
    ok: true,
    trades,
    tradeSystemResult: result,
    tradeFunnelInputCount: candidates.length,
    tradeFunnelInputSymbols: candidates.map(c => `${c.symbol}_${c.side}_${c.stage}_${Math.round(c.moveScore || 0)}`),
    tradeFunnelUpdatedAt: now,
    updatedAt: now
  };

  if (store) {
    await setLatestScan(updated);
  }

  return updated;
}

// ================= HANDLER =================
export default async function handler(req, res) {
  try {
    const notify = normalizeNotify(req?.query?.notify);
    const store = normalizeStore(req?.query?.store, true);

    const data = await runTradeFunnel({ notify, store });

    return res.status(200).json(data);
  } catch (e) {
    console.error("TRADE-FUNNEL ERROR:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}