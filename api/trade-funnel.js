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

function safeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
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

// ================= AANGEPASTE ADAPTIVE SELECTOR =================
function getTradeFunnelCandidates(latest) {
  const buckets = [
    ...safeArray(latest?.funnel?.bull?.entry),
    ...safeArray(latest?.funnel?.bear?.entry),
    ...safeArray(latest?.funnel?.bull?.almost),
    ...safeArray(latest?.funnel?.bear?.almost)
  ];

  const map = new Map();

  for (const coin of buckets) {
    if (!coin) continue;
    if (Boolean(coin.uiOnly)) continue;

    const symbol = String(coin.symbol || "").toUpperCase().trim();
    const side = String(coin.side || "").toLowerCase().trim();

    if (!symbol) continue;
    if (side !== "bull" && side !== "bear") continue;

    const score = Number(coin.moveScore || 0);
    const vm = Number(coin.vm || 0);
    const tfScore = Number(coin.tfScore || 0);
    const tfStrength = Math.abs(tfScore);
    const flow = String(coin.flow || "NEUTRAL").toUpperCase();
    const stage = String(coin.stage || "radar").toLowerCase();

    // Scanner‑entry = HOT kandidaat, geen echte trade‑entry.
    // TradeSystem mag alleen goede scanner‑kandidaten krijgen.
    if (stage !== "entry" && stage !== "almost") continue;
    if (score < 58) continue;
    if (vm < 0.05) continue;
    if (tfStrength < 1) continue;
    if (flow === "NEUTRAL") continue;

    const key = `${symbol}_${side}`;
    const normalized = {
      ...coin,
      symbol,
      side,
      moveScore: score,
      vm,
      tfScore,
      tfStrength,
      flow,
      scannerStage: stage
    };

    const prev = map.get(key);
    if (!prev || Number(normalized.moveScore || 0) > Number(prev.moveScore || 0)) {
      map.set(key, normalized);
    }
  }

  const result = Array.from(map.values()).sort((a, b) => {
    const stageA = a.stage === "entry" ? 1 : 0;
    const stageB = b.stage === "entry" ? 1 : 0;
    if (stageA !== stageB) return stageB - stageA;
    return Number(b.moveScore || 0) - Number(a.moveScore || 0);
  });

  console.log("TRADE FUNNEL candidates:", result.length);
  console.log("TRADE FUNNEL symbols:", result.map(c => `${c.symbol}_${c.side}`).join(", "));

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

  // 🔥 BTW: geef btc, regime en market door aan tradeSystem
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
    tradeFunnelInputSymbols: candidates.map(c => `${c.symbol}_${c.side}`),
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