import { getLatestScan, setLatestScan } from "../lib/scanStore.js";
import { processTrades } from "../lib/tradeSystem.js";

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

function normalizeSymbol(value) {
  return String(value || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "")
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeSide(value) {
  const side = String(value || "").toLowerCase().trim();
  if (side === "bull") return "bull";
  if (side === "bear") return "bear";
  return null;
}

function normalizeStage(value) {
  const stage = String(value || "").toLowerCase().trim();
  if (stage === "entry") return "entry";
  if (stage === "almost") return "almost";
  if (stage === "buildup") return "buildup";
  if (stage === "radar") return "radar";
  return "radar";
}

function stageRank(stage) {
  if (stage === "entry") return 4;
  if (stage === "almost") return 3;
  if (stage === "buildup") return 2;
  if (stage === "radar") return 1;
  return 0;
}

function getDirectionalMove(coin, side) {
  const dir = side === "bear" ? -1 : 1;

  return {
    change1hDir: safeNumber(coin.change1h, 0) * dir,
    change24Dir: safeNumber(coin.change24, 0) * dir
  };
}

function getTfStrength(coin) {
  const rawStrength = Number(coin?.tfStrength);

  if (Number.isFinite(rawStrength)) {
    return Math.abs(rawStrength);
  }

  const tfScore = safeNumber(coin?.tfScore, 0);
  return Math.abs(tfScore);
}

function getTradeFunnelRank(c) {
  const stageBonus = c.scannerStage === "entry" ? 25 : 10;
  const flowBonus = c.flow === "TREND" ? 12 : c.flow === "BUILDING" ? 6 : 0;
  const tfBonus = Math.min(20, safeNumber(c.tfStrength, 0) * 6);
  const vmBonus = Math.min(15, safeNumber(c.vm, 0) * 120);
  const freshnessBonus = Math.min(10, safeNumber(c.freshness, 0) * 0.5);

  return (
    safeNumber(c.moveScore, 0) +
    stageBonus +
    flowBonus +
    tfBonus +
    vmBonus +
    freshnessBonus
  );
}

// ================= CANDIDATE QUALITY GATE =================
function passesTradeFunnelGate(coin) {
  const stage = normalizeStage(coin.stage);
  const side = normalizeSide(coin.side);
  const score = safeNumber(coin.moveScore, 0);
  const vm = safeNumber(coin.vm, 0);
  const tfStrength = getTfStrength(coin);
  const flow = String(coin.flow || "NEUTRAL").toUpperCase();
  const { change1hDir, change24Dir } = getDirectionalMove(coin, side);

  if (stage !== "entry" && stage !== "almost") {
    return {
      ok: false,
      reason: "STAGE_NOT_HOT"
    };
  }

  if (score < 54) {
    return {
      ok: false,
      reason: "SCORE_TOO_LOW"
    };
  }

  if (stage === "almost" && score < 56) {
    return {
      ok: false,
      reason: "ALMOST_SCORE_TOO_LOW"
    };
  }

  if (vm < 0.045) {
    return {
      ok: false,
      reason: "VM_TOO_LOW"
    };
  }

  if (tfStrength < 1) {
    return {
      ok: false,
      reason: "TF_TOO_WEAK"
    };
  }

  if (flow === "NEUTRAL") {
    return {
      ok: false,
      reason: "FLOW_NEUTRAL"
    };
  }

  // Voorkomt dat oude/stale scanner-stage zonder richting wordt doorgestuurd.
  // Niet te streng: sterke reversal/scalp candidates mogen nog door als score hoog is.
  if (change1hDir < -0.35 && change24Dir < -1.2 && score < 72) {
    return {
      ok: false,
      reason: "DIRECTION_AGAINST"
    };
  }

  return {
    ok: true,
    reason: "OK"
  };
}

// ================= ADAPTIVE SELECTOR =================
function getTradeFunnelCandidates(latest) {
  const buckets = [
    ...safeArray(latest?.funnel?.bull?.entry),
    ...safeArray(latest?.funnel?.bear?.entry),
    ...safeArray(latest?.funnel?.bull?.almost),
    ...safeArray(latest?.funnel?.bear?.almost)
  ];

  const map = new Map();

  const debug = {
    raw: buckets.length,
    accepted: 0,
    rejected: {}
  };

  for (const coin of buckets) {
    if (!coin) continue;

    if (Boolean(coin.uiOnly)) {
      debug.rejected.UI_ONLY = (debug.rejected.UI_ONLY || 0) + 1;
      continue;
    }

    const symbol = normalizeSymbol(coin.symbol);
    const side = normalizeSide(coin.side);
    const stage = normalizeStage(coin.stage);

    if (!symbol) {
      debug.rejected.NO_SYMBOL = (debug.rejected.NO_SYMBOL || 0) + 1;
      continue;
    }

    if (!side) {
      debug.rejected.INVALID_SIDE = (debug.rejected.INVALID_SIDE || 0) + 1;
      continue;
    }

    const tfScore = safeNumber(coin.tfScore, 0);
    const tfStrength = getTfStrength(coin);
    const flow = String(coin.flow || "NEUTRAL").toUpperCase();
    const score = safeNumber(coin.moveScore, 0);
    const vm = safeNumber(coin.vm, 0);

    const normalized = {
      ...coin,

      symbol,
      side,

      stage,
      scannerStage: stage,

      moveScore: score,
      vm,

      tfScore,
      tfStrength,
      flow,

      change1h: safeNumber(coin.change1h, 0),
      change24: safeNumber(coin.change24, 0),
      freshness: safeNumber(coin.freshness, 0),

      rawBitgetSymbol: coin.rawBitgetSymbol || coin.bitgetSymbol || `${symbol}USDT`,
      bitgetSymbol: coin.bitgetSymbol || coin.rawBitgetSymbol || `${symbol}USDT`,

      tradeFunnelSource: "scanner_hot_table"
    };

    const gate = passesTradeFunnelGate(normalized);

    if (!gate.ok) {
      debug.rejected[gate.reason] = (debug.rejected[gate.reason] || 0) + 1;
      continue;
    }

    normalized.tradeFunnelRank = getTradeFunnelRank(normalized);

    const key = `${symbol}_${side}`;
    const prev = map.get(key);

    if (!prev) {
      map.set(key, normalized);
      debug.accepted++;
      continue;
    }

    const prevStageRank = stageRank(prev.scannerStage);
    const nextStageRank = stageRank(normalized.scannerStage);

    if (nextStageRank > prevStageRank) {
      map.set(key, normalized);
      continue;
    }

    if (
      nextStageRank === prevStageRank &&
      safeNumber(normalized.tradeFunnelRank, 0) > safeNumber(prev.tradeFunnelRank, 0)
    ) {
      map.set(key, normalized);
    }
  }

  const result = Array.from(map.values()).sort((a, b) => {
    const stageDiff = stageRank(b.scannerStage) - stageRank(a.scannerStage);
    if (stageDiff !== 0) return stageDiff;

    const rankDiff = safeNumber(b.tradeFunnelRank, 0) - safeNumber(a.tradeFunnelRank, 0);
    if (rankDiff !== 0) return rankDiff;

    return safeNumber(b.moveScore, 0) - safeNumber(a.moveScore, 0);
  });

  console.log("TRADE FUNNEL DEBUG:", {
    raw: debug.raw,
    accepted: result.length,
    rejected: debug.rejected
  });

  console.log(
    "TRADE FUNNEL symbols:",
    result.map(c => `${c.symbol}_${c.side}_${c.scannerStage}_${Math.round(c.moveScore)}`).join(", ")
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
    : {
        actions: [],
        candidatesCount: 0
      };

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
    tradeFunnelInputSymbols: candidates.map(c => `${c.symbol}_${c.side}`),
    tradeFunnelInputRows: candidates.map(c => ({
      symbol: c.symbol,
      side: c.side,
      scannerStage: c.scannerStage,
      score: c.moveScore,
      vm: c.vm,
      tfStrength: c.tfStrength,
      flow: c.flow,
      rank: c.tradeFunnelRank
    })),

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

    const data = await runTradeFunnel({
      notify,
      store
    });

    return res.status(200).json(data);
  } catch (e) {
    console.error("TRADE-FUNNEL ERROR:", e);
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}