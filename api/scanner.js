import {
  fetchCoinGeckoTopCached,
  generateShallowOb
} from "../lib/_main_shared.js";

import { bullFilter } from "../lib/bullFilters.js";
import { bearFilter } from "../lib/bearFilters.js";
import { detectRegime } from "../lib/regime.js";
import { calculateEdge } from "../lib/edge.js";
import { processTrades } from "../lib/tradeSystem.js";
import { setLatestScan } from "../lib/scanStore.js";

import {
  resetAnalytics,
  logAnalytics,
  getAnalytics
} from "../lib/analyticsEngine.js";

import { generateAdvice } from "../lib/analysisAdvisor.js";
import { autoAdjustV4 } from "../lib/autoAdjustV4.js";
import { classifyMarket } from "../lib/marketClassifier.js";

function calculateScore(c, regime, side){
  let score = 0;
  const dir = side === "bull" ? 1 : -1;

  const ch24 = Number(c.change24 || 0) * dir;
  const ch1 = Number(c.change1h || 0) * dir;

  if (ch24 > 10) score += 30;
  else if (ch24 > 6) score += 20;
  else if (ch24 > 3) score += 10;

  if (ch1 > 1.2) score += 20;
  else if (ch1 > 0.5) score += 10;

  if (c.vm > 0.6) score += 25;
  else if (c.vm > 0.35) score += 15;
  else if (c.vm > 0.2) score += 8;

  if (c.ob?.score > 0.07) score += 15;
  else if (c.ob?.score > 0.04) score += 10;

  if (regime === "LOW_VOL") score -= 10;
  if (regime === "HIGH_VOL") score += 5;

  return Math.max(0, Math.min(score, 100));
}

function detectFlow(c){
  const ch1 = Math.abs(Number(c.change1h || 0));
  const ch24 = Math.abs(Number(c.change24 || 0));

  if (ch1 > 1.2 && ch24 > 6) return "TREND";
  if (ch1 > 0.7) return "BUILDING";
  if (ch24 > 2) return "EARLY";

  return "NEUTRAL";
}

function boostStage(stage, c){
  if (c.moveScore > 85 && c.flow === "TREND") return "ENTRY";
  if (c.moveScore > 70) return "ALMOST";
  if (c.moveScore > 55) return "BUILDUP";
  return stage;
}

function normalize(raw){
  const mc = Number(raw?.market_cap || 0);
  const vol = Number(raw?.total_volume || 0);

  const change24 = Number(
    raw?.price_change_percentage_24h ??
    raw?.price_change_percentage_24h_in_currency ??
    0
  );

  const change1h = Number(
    raw?.price_change_percentage_1h_in_currency ??
    raw?.price_change_percentage_1h ??
    0
  );

  return {
    symbol: String(raw?.symbol || "").toUpperCase(),
    name: raw?.name || "",
    price: Number(raw?.current_price || 0),
    change24: Number.isFinite(change24) ? change24 : 0,
    change1h: Number.isFinite(change1h) ? change1h : 0,
    volume: vol,
    marketCap: mc,
    vm: mc > 0 ? vol / mc : 0,
    ob: generateShallowOb()
  };
}

async function buildScanPayload(){
  resetAnalytics();

  const rawCoins = await fetchCoinGeckoTopCached();
  if (!Array.isArray(rawCoins)) {
    throw new Error("API error");
  }

  const btc = {
    state: rawCoins[0]?.price_change_percentage_24h > 0 ? "BULLISH" : "BEARISH"
  };

  const regime = detectRegime(rawCoins) || "NORMAL";
  const market = classifyMarket(rawCoins);

  const funnel = {
    bull: { entry: [], almost: [], buildup: [], radar: [] },
    bear: { entry: [], almost: [], buildup: [], radar: [] }
  };

  const tradeCandidates = [];

  for (const raw of rawCoins) {
    const base = normalize(raw);
    if (!base.symbol || base.price <= 0) continue;

    const flow = detectFlow(base);

    const bs = bullFilter(base);
    if (bs) {
      const c = { ...base, side: "bull" };
      c.flow = flow;
      c.moveScore = calculateScore(c, regime, "bull");
      c.edge = calculateEdge(c, regime) || 0;
      c.stage = boostStage(bs, c);

      logAnalytics(c);
      funnel.bull[c.stage.toLowerCase()].push(c);

      if (c.stage !== "RADAR") {
        tradeCandidates.push(c);
      }
    }

    const br = bearFilter(base);
    if (br) {
      const c = { ...base, side: "bear" };
      c.flow = flow;
      c.moveScore = calculateScore(c, regime, "bear");
      c.edge = calculateEdge(c, regime) || 0;
      c.stage = boostStage(br, c);

      logAnalytics(c);
      funnel.bear[c.stage.toLowerCase()].push(c);

      if (c.stage !== "RADAR") {
        tradeCandidates.push(c);
      }
    }
  }

  for (const side of ["bull", "bear"]) {
    for (const key in funnel[side]) {
      funnel[side][key].sort((a, b) => b.moveScore - a.moveScore);
    }
  }

  const trades = await processTrades(tradeCandidates, btc, "auto", regime);
  const analytics = getAnalytics();
  const advice = generateAdvice(analytics);

  let ai = null;
  if (process.env.AUTO_AI === "true") {
    ai = autoAdjustV4(advice, market);
  }

  const payload = {
    ok: true,
    scannedAt: Date.now(),
    btc,
    regime,
    market,
    funnel,
    trades,
    analytics,
    advice,
    ai,
    total: rawCoins.length,
    candidates: tradeCandidates.length
  };

  setLatestScan(payload);

  return payload;
}

export default async function handler(req, res){
  try {
    const payload = await buildScanPayload();

    if (res && typeof res.status === "function" && typeof res.json === "function") {
      return res.status(200).json(payload);
    }

    return payload;
  } catch (e) {
    console.error("SCAN ERROR:", e);

    const errorPayload = {
      ok: false,
      error: e.message
    };

    if (res && typeof res.status === "function" && typeof res.json === "function") {
      return res.status(500).json(errorPayload);
    }

    return errorPayload;
  }
}

export { buildScanPayload };