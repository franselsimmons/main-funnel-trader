// pages/api/main/scan.js
import { kv } from "@vercel/kv";

import { RUNTIME_CONFIG, requireSecret, SETTINGS } from "../../../lib/core/settings.js";
import {
  keyMainLatest,
  keyMainState,
  keyMainPositions,
  keyMainPortfolio,
  keyMainPerformance,
  keyScanLockMain,
  keyCooldownMain,
  keyEntryHistoryMain,
} from "../../../lib/keys.js";

import { n, up, safeArr, clamp, round } from "../../../lib/utils/numbers.js";
import { nowMs, nextHalfHourBoundaryMs } from "../../../lib/utils/time.js";

import { fetchCoinGeckoTopCached, pickBtcFromUniverse } from "../../../lib/data/coingecko.js";
import { getBitgetSpotUsdtSymbols, fetchBitgetOrderbook } from "../../../lib/data/bitgetPublic.js";

import { decideMainStageV6, isMainEliteStage, splitFunnels } from "../../../lib/scoring/stages.js";
import {
  computeQualityScore,
  computeLiquidityScore,
  computeTimingScore,
  computeMarketScore,
  computeBtcAlignmentScore,
  computePerfectCandidateScore,
  computeMoonProbabilities,
  computeMarketRegime,
} from "../../../lib/scoring/scores.js";

import { buildTradePlan } from "../../../lib/risk.js";
import { THRESHOLDS, buildAdaptiveThresholds } from "../../../lib/thresholds.js";

import { sendDiscordSignal } from "../../../lib/signals/discord.js";
import { pushEvent, uid } from "../../../lib/analytics.js";

import { executeEntryIfEnabled, executeExitIfEnabled } from "../../../lib/exchange/executionEngine.js";

export const config = RUNTIME_CONFIG;

// ======================================================
// Config (main)
// ======================================================
const MAX_OPEN_TRADES = 6;
const BASE_POSITION_SIZE_USD = 50;

// cooldowns
const COOLDOWN_SL_SEC = 4 * 60 * 60;
const COOLDOWN_TP_SEC = 90 * 60;
const COOLDOWN_TIMEOUT_SEC = 2 * 60 * 60;
const COOLDOWN_EARLY_EXIT_SEC = 90 * 60;

// exits
const TIMEOUT_BARS = 12; // ~6 hours if scan ~30m
const TIMEOUT_MIN_PNL_PCT = 0.3;

// entry pacing
const ENTRY_HISTORY_KEEP = 40;
const ENTRY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MIN_RECENT_ENTRIES_TARGET = 3;

// throttling universe
const UNIVERSE_TAKE = 120;

// ======================================================
// Small helpers
// ======================================================
async function safeSendSignal(payload) {
  try {
    await sendDiscordSignal(payload);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("sendDiscordSignal failed:", e?.message || e);
  }
}
async function safePushEvent(name, payload) {
  try {
    await pushEvent(name, payload);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("pushEvent failed:", name, e?.message || e);
  }
}

function scanLockKey(mode) {
  return keyScanLockMain(mode);
}

async function acquireScanLock(mode) {
  const key = scanLockKey(mode);
  const now = nowMs();
  const until = nextHalfHourBoundaryMs(now);
  const ttlSec = Math.max(60, Math.ceil((until - now) / 1000));

  const ok = await kv.set(key, { ts: now, until, mode }, { nx: true, ex: ttlSec });
  if (ok) return { ok: true, key, until };

  const cur = await kv.get(key);
  const curUntil = n(cur?.until, 0);
  if (curUntil > now) return { ok: false, key, until: curUntil };

  await kv.set(key, { ts: now, until, mode }, { ex: ttlSec });
  return { ok: true, key, until };
}

async function releaseScanLock(mode) {
  try {
    await kv.del(scanLockKey(mode));
  } catch {
    /* noop */
  }
}

function cooldownKey(mode, symbol) {
  return keyCooldownMain(mode, symbol);
}

function entryHistoryKey(mode) {
  return keyEntryHistoryMain(mode);
}

async function readRecentEntryCount(mode, lookbackMs = ENTRY_LOOKBACK_MS) {
  const key = entryHistoryKey(mode);
  const now = nowMs();
  const prev = safeArr(await kv.get(key));
  const filtered = prev.filter((ts) => n(ts, 0) >= now - lookbackMs).slice(0, ENTRY_HISTORY_KEEP);
  await kv.set(key, filtered, { ex: 60 * 60 * 24 * 3 });
  return filtered.length;
}

async function appendEntryHistory(mode) {
  const key = entryHistoryKey(mode);
  const now = nowMs();
  const prev = safeArr(await kv.get(key));
  const next = [now, ...prev].slice(0, ENTRY_HISTORY_KEEP);
  await kv.set(key, next, { ex: 60 * 60 * 24 * 3 });
}

function computePerformance(closedTrades) {
  const arr = safeArr(closedTrades);
  if (!arr.length) {
    return { trades: 0, wins: 0, losses: 0, winRate: 50, avgRR: 0, drawdown: 0, updatedAt: nowMs() };
  }

  let wins = 0;
  let totalRR = 0;

  let equity = 1000;
  let peak = 1000;
  let maxDd = 0;

  for (const t of arr) {
    const pnlPct = n(t?.pnlPct, 0);
    const rr = n(t?.rr, 0);
    if (pnlPct > 0) wins += 1;
    totalRR += rr;

    equity *= 1 + pnlPct / 100;
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDd = Math.max(maxDd, dd);
  }

  const trades = arr.length;
  const winRate = trades ? (wins / trades) * 100 : 50;
  const avgRR = trades ? totalRR / trades : 0;

  return {
    trades,
    wins,
    losses: trades - wins,
    winRate: Number(winRate.toFixed(1)),
    avgRR: Number(avgRR.toFixed(2)),
    drawdown: Number(maxDd.toFixed(1)),
    updatedAt: nowMs(),
  };
}

async function ensureFreshPerformance(mode) {
  const key = keyMainPerformance(mode);
  const perf = await kv.get(key);
  const now = nowMs();
  const MAX_AGE = 6 * 60 * 60 * 1000;

  if (!perf || now - n(perf.updatedAt, 0) > MAX_AGE) {
    const positions = (await kv.get(keyMainPositions(mode))) || { open: [], closed: [] };
    const updated = computePerformance(positions?.closed);
    await kv.set(key, updated, { ex: 60 * 60 * 24 * 7 });
    return updated;
  }
  return perf;
}

// ======================================================
// PnL + exits
// ======================================================
function calcPnlPct(entryPrice, lastPrice, mode) {
  const e = n(entryPrice, 0);
  const p = n(lastPrice, 0);
  if (!(e > 0 && p > 0)) return 0;
  const raw = ((p - e) / e) * 100;
  return mode === "bear" ? -raw : raw; // short profit if price falls
}

function calcPnlUsd(sizeUsd, pnlPct) {
  return (n(sizeUsd, 0) * n(pnlPct, 0)) / 100;
}

function hitStopOrTp(pos, lastPrice) {
  const price = n(lastPrice, 0);
  if (!(price > 0)) return { hit: false };

  const sl = n(pos?.sl, 0);
  const tp = n(pos?.tp, 0);

  if (pos.mode === "bear") {
    if (tp > 0 && price <= tp) return { hit: true, kind: "TP" };
    if (sl > 0 && price >= sl) return { hit: true, kind: "SL" };
    return { hit: false };
  }

  if (tp > 0 && price >= tp) return { hit: true, kind: "TP" };
  if (sl > 0 && price <= sl) return { hit: true, kind: "SL" };
  return { hit: false };
}

function isTimeoutExit(pos, now) {
  const entryAt = n(pos?.entryAt, 0);
  if (!entryAt) return false;
  const approxBarsHeld = Math.floor((now - entryAt) / (30 * 60 * 1000));
  if (approxBarsHeld < TIMEOUT_BARS) return false;
  return n(pos?.pnlPct, 0) < TIMEOUT_MIN_PNL_PCT;
}

function isEarlyExit(pos, now) {
  const entryAt = n(pos?.entryAt, 0);
  if (!entryAt) return false;
  if (now - entryAt > COOLDOWN_EARLY_EXIT_SEC * 1000) return false;
  return n(pos?.pnlPct, 0) <= -0.6;
}

function cooldownSecondsForExitKind(kind) {
  if (kind === "TP") return COOLDOWN_TP_SEC;
  if (kind === "SL") return COOLDOWN_SL_SEC;
  if (kind === "TIMEOUT") return COOLDOWN_TIMEOUT_SEC;
  if (kind === "EARLY_EXIT") return COOLDOWN_EARLY_EXIT_SEC;
  return COOLDOWN_TIMEOUT_SEC;
}

async function closePosition({ positions, idx, now, lastPrice, kind, reason, mode, regime, execSnapshot }) {
  const pos = positions.open[idx];
  if (!pos) return null;

  const pnlPct = calcPnlPct(pos.entryPrice, lastPrice, pos.mode);
  const pnlUsd = calcPnlUsd(pos.sizeUsd, pnlPct);

  const closed = {
    ...pos,
    status: "CLOSED",
    closedAt: now,
    exitPrice: n(lastPrice, 0),
    lastPrice: n(lastPrice, 0),
    pnlPct: Number(pnlPct.toFixed(3)),
    pnlUsd: Number(pnlUsd.toFixed(2)),
    exitKind: kind,
    exitReason: reason || kind,
    regimeAtExit: regime || pos.regime || null,
    execution: execSnapshot || pos.execution || null,
  };

  positions.open.splice(idx, 1);
  positions.closed.unshift(closed);

  // cooldown
  try {
    const cdSec = cooldownSecondsForExitKind(kind);
    const cdKey = cooldownKey(mode, pos.symbol);
    await kv.set(cdKey, now + cdSec * 1000, { ex: cdSec });
  } catch {
    /* noop */
  }

  return closed;
}

// ======================================================
// Universe build (scores + desk status)
// ======================================================
function buildDeskStatus({ coin, mainTh }) {
  const stage = String(coin.stage || "").toUpperCase();
  const isEliteForDesk = stage === "ELITE_IGNITION" || stage === "ELITE_EXPANSION" || stage === "ELITE_CASCADE";

  const breakoutReady = !!coin?.breakout?.ready;
  const breakoutPressure = n(coin?.breakout?.pressure, 0);

  const nearEntryWatch =
    coin.superScannerCoin === true &&
    (isEliteForDesk || stage === "ALMOST") &&
    n(coin.entryQuality, 0) >= n(mainTh.nearEntryWatch.entryQuality, 70) &&
    n(coin.persistenceScore, 0) >= n(mainTh.nearEntryWatch.persistenceScore, 60) &&
    (breakoutReady || breakoutPressure >= n(mainTh.nearEntryWatch.breakoutPressure, 63)) &&
    Math.abs(n(coin.ob?.score, 0)) >= n(mainTh.filters.obScore, 0.008);

  const stableWatchReady =
    coin.prevTradeDeskStatus === "WATCH" &&
    n(coin.prevWatchScans, 0) >= 2 &&
    n(coin.entryQuality, 0) >= n(mainTh.stableWatch.entryQuality, 64) &&
    n(coin.persistenceScore, 0) >= n(mainTh.stableWatch.persistence, 56) &&
    (breakoutReady || breakoutPressure >= n(mainTh.stableWatch.breakoutPressure, 59)) &&
    n(coin.ob?.score, 0) >= n(mainTh.filters.obScore, 0.008);

  if (coin.tradeCandidate === true && (isEliteForDesk || (stage === "ALMOST" && stableWatchReady))) return "OPEN";
  if (nearEntryWatch) return "WATCH";

  // sticky watch a bit
  if (
    coin.prevTradeDeskStatus === "WATCH" &&
    n(coin.prevWatchScans, 0) >= 3 &&
    stage === "ALMOST" &&
    n(coin.entryQuality, 0) >= 62 &&
    n(coin.persistenceScore, 0) >= 54 &&
    (breakoutReady || breakoutPressure >= 52)
  ) {
    return "WATCH";
  }

  return "IGNORE";
}

async function buildUniverse({ mode, whaleFlow, btc, performance, prevState }) {
  const regime = computeMarketRegime({ btc, whaleFlow, mode });
  const adaptive = buildAdaptiveThresholds({ performance, regime });
  const mainTh = THRESHOLDS.main;

  const rawCoins = await fetchCoinGeckoTopCached();
  const bitgetSymbols = await getBitgetSpotUsdtSymbols();

  // filter stable / blocked handled inside coingecko module? keep simple here:
  const filtered1 = safeArr(rawCoins).filter((c) => !["USDT", "USDC", "DAI", "BUSD", "TUSD", "UST", "LUNA", "WETH", "WBTC", "STETH"].includes(up(c.symbol)));

  // Bitget safety fallback
  let filtered2 = filtered1;
  if (bitgetSymbols && bitgetSymbols.size > 20) {
    const m = filtered1.filter((c) => bitgetSymbols.has(up(c.symbol)));
    if (m.length > 10) filtered2 = m;
  }

  const universeInput = filtered2.slice(0, UNIVERSE_TAKE);

  const out = [];
  for (const coin of universeInput) {
    const sym = up(coin.symbol);
    const prev = prevState?.[sym] || {};

    // orderbook (only if volume)
    let ob = null;
    if (n(coin.volume, 0) >= 600_000) {
      ob = await fetchBitgetOrderbook(`${sym}USDT`);
    }

    const stageDecision = decideMainStageV6({
      mode,
      coin,
      ob,
      prev,
      btc,
      whaleFlow,
      regime,
    });

    const probs = computeMoonProbabilities({
      mode,
      coin,
      moveScore: stageDecision.moveScore,
      velocity: stageDecision.velocity,
      compression: stageDecision.compression,
      persistenceScore: stageDecision.persistenceScore,
    });

    const qualityScore = computeQualityScore({
      coin,
      moveScore: stageDecision.moveScore,
      entryQuality: stageDecision.entryQuality,
      persistenceScore: stageDecision.persistenceScore,
      velocity: stageDecision.velocity,
      compression: stageDecision.compression,
      breakout: stageDecision.breakout,
    });

    const liquidityScore = computeLiquidityScore({
      ob,
      depthOk: stageDecision.depthOk,
      spreadPct: n(ob?.spreadPct, 999),
      depthMinUsd1p: n(ob?.depthMinUsd1p, 0),
    });

    const timingScore = computeTimingScore({
      mode,
      stage: stageDecision.stage,
      breakout: stageDecision.breakout,
      volAcc: stageDecision.volAcc,
      strongScans: n(prev?.strongScans, 0),
      eliteScans: n(prev?.eliteScans, 0),
      lateEntry: stageDecision.lateEntry,
      exhausted: stageDecision.exhausted,
      bounceTrap: stageDecision.bounceTrap,
    });

    const marketScore = computeMarketScore({ btc, mode, regime, whaleFlow });
    const btcAlignmentScore = computeBtcAlignmentScore({ btc, mode, regime });
    const perfectCandidateScore = computePerfectCandidateScore({ qualityScore, liquidityScore, timingScore, marketScore });

    const superScannerCoin =
      perfectCandidateScore >= n(mainTh.superScanner.perfectCandidate, 74) &&
      qualityScore >= n(mainTh.superScanner.qualityScore, 68) &&
      ["ELITE_IGNITION", "ELITE_EXPANSION", "ELITE_CASCADE", "ALMOST"].includes(up(stageDecision.stage));

    // tradeCandidate (adaptive)
    let tradeCandidate =
      perfectCandidateScore >= n(mainTh.perfectCandidate, 76) &&
      liquidityScore >= n(mainTh.liquidityScore, 66) &&
      btcAlignmentScore >= n(mainTh.btcAlignmentScore, 55) &&
      timingScore >= n(adaptive.timing, 60) &&
      qualityScore >= n(adaptive.quality, 60) &&
      marketScore >= n(adaptive.market, 45) &&
      ["ELITE_IGNITION", "ELITE_EXPANSION", "ELITE_CASCADE", "ALMOST"].includes(up(stageDecision.stage));

    if (String(regime || "").toUpperCase() === "HEADWIND" && marketScore < n(adaptive.market, 45) + 4) {
      tradeCandidate = false;
    }

    const tradePlan = buildTradePlan({
      mode,
      price: n(coin.price, 0),
      range24: n(coin.range24, 0),
      confidence: n(stageDecision.entryQuality || stageDecision.moveScore, 0),
      depthOk: stageDecision.depthOk,
      tier: stageDecision.tier,
      regime,
      persistenceScore: stageDecision.persistenceScore,
      performance,
    });

    const deskStatus = buildDeskStatus({
      coin: {
        ...coin,
        stage: stageDecision.stage,
        superScannerCoin,
        tradeCandidate,
        entryQuality: stageDecision.entryQuality,
        persistenceScore: stageDecision.persistenceScore,
        breakout: stageDecision.breakout,
        ob,
        prevTradeDeskStatus: prev?.tradeDeskStatus || "IGNORE",
        prevWatchScans: prev?.watchScans || 0,
      },
      mainTh,
    });

    out.push({
      id: coin.id,
      symbol: sym,
      name: coin.name || "",
      image: coin.image || "",
      price: n(coin.price, 0),
      marketCap: n(coin.marketCap, 0),
      volume: n(coin.volume, 0),
      change24: n(coin.change24, 0),
      change1h: n(coin.change1h, 0),
      vm: n(coin.vm, 0),
      range24: n(coin.range24, 0),

      stage: stageDecision.stage,
      stageWhy: stageDecision.stageWhy,
      eliteType: stageDecision.eliteType,
      entryQuality: stageDecision.entryQuality,
      persistenceScore: stageDecision.persistenceScore,
      velocity: stageDecision.velocity,
      moveScore: stageDecision.moveScore,

      compression: stageDecision.compression,
      breakout: stageDecision.breakout,
      volAcc: stageDecision.volAcc,

      ob: ob
        ? {
            bestBid: round(n(ob.bestBid, 0), 8),
            bestAsk: round(n(ob.bestAsk, 0), 8),
            spreadPct: round(n(ob.spreadPct, 999), 4),
            depthBidUsd: Math.round(n(ob.depthBidUsd, 0)),
            depthAskUsd: Math.round(n(ob.depthAskUsd, 0)),
            depthMinUsd1p: Math.round(n(ob.depthMinUsd1p, 0)),
            score: round(n(ob.score, 0), 5),
            valid: !!ob.valid,
            fresh: !!ob.fresh,
            stale: !!ob.stale,
            reason: String(ob.reason || ""),
            lor: round(n(ob.lor, 0), 4),
          }
        : {
            bestBid: 0,
            bestAsk: 0,
            spreadPct: 999,
            depthBidUsd: 0,
            depthAskUsd: 0,
            depthMinUsd1p: 0,
            score: 0,
            valid: false,
            fresh: false,
            stale: true,
            reason: "missing_snapshot",
            lor: 1,
          },

      qualityScore,
      liquidityScore,
      timingScore,
      marketScore,
      btcAlignmentScore,
      perfectCandidateScore,

      moonProbability: probs.moonProbability,
      dumpProbability: probs.dumpProbability,

      superScannerCoin,
      tradeCandidate,
      tradeDeskStatus: deskStatus,
      tradePlan,

      _state: stageDecision._state, // priceHist/volHist/stageHist/depthHist etc
    });
  }

  return { regime, adaptive, coins: out };
}

// ======================================================
// Entry gating
// ======================================================
function canPromoteBalancedEntry(coin, mode, regime) {
  if (!coin?.tradePlan) return false;
  if (up(coin.stage) !== "ALMOST") return false;
  if (String(regime || "").toUpperCase() === "HEADWIND") return false;

  const eq = n(coin.entryQuality, 0);
  const ps = n(coin.persistenceScore, 0);
  const br = !!coin?.breakout?.ready;
  const v1 = n(coin?.volAcc?.short, 1);
  const v2 = n(coin?.volAcc?.medium, 1);
  const ob = n(coin?.ob?.score, 0);

  if (eq < 70) return false;
  if (ps < 60) return false;
  if (!br) return false;
  if (v1 < 1.04 && v2 < 1.08) return false;
  if (mode === "bull" && ob < -0.01) return false;
  if (mode === "bear" && ob > 0.01) return false;
  return true;
}

function applyFunnelBalancer({ funnel, mode, regime, openCount, recentEntryCount }) {
  if (!funnel) return funnel;
  if (openCount >= MAX_OPEN_TRADES) return funnel;
  if (recentEntryCount >= MIN_RECENT_ENTRIES_TARGET) return funnel;

  const eliteCount = (funnel.elite_expansion?.length || 0) + (funnel.elite_ignition?.length || 0);
  if (eliteCount > 0) return funnel;

  const almost = safeArr(funnel.almost);
  if (!almost.length) return funnel;

  const idx = almost.findIndex((c) => canPromoteBalancedEntry(c, mode, regime));
  if (idx === -1) return funnel;

  const promoted = { ...almost[idx], stage: "ELITE_IGNITION", eliteType: "ignition", stageWhy: "funnel_balancer_promoted" };
  const nextAlmost = [...almost];
  nextAlmost.splice(idx, 1);

  return {
    ...funnel,
    almost: nextAlmost,
    elite_ignition: [promoted, ...safeArr(funnel.elite_ignition)].slice(0, 12),
  };
}

// ======================================================
// Main handler
// ======================================================
export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    if (!requireSecret(req, res)) return;
    res.setHeader("Cache-Control", "no-store");

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const lock = await acquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(keyMainLatest(mode));
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      if (latest) {
        return res.end(
          JSON.stringify({
            ...latest,
            meta: { ...(latest.meta || {}), scanLock: { active: true, until: lock.until || null } },
          })
        );
      }
      return res.end(JSON.stringify({ ok: true, skipped: true, reason: "scan_lock_active", mode, until: lock.until || null }));
    }
    lockAcquired = true;

    const now = nowMs();

    // WhaleFlow proxy (kept simple: optional, safe default)
    // You can replace this with a stronger flow model later.
    let whaleFlow = 0;
    try {
      const cached = await kv.get("main:whaleFlow:last");
      whaleFlow = n(cached?.value, 0);
      if (now - n(cached?.ts, 0) > 10 * 60 * 1000) {
        // soft refresh: just keep last known value (avoid extra vendor calls here)
        await kv.set("main:whaleFlow:last", { ts: now, value: whaleFlow }, { ex: 60 * 60 });
      }
    } catch {
      whaleFlow = 0;
    }

    const prevState = (await kv.get(keyMainState(mode))) || {};
    const prevPositions = (await kv.get(keyMainPositions(mode))) || { open: [], closed: [] };

    const positions = {
      open: safeArr(prevPositions?.open).map((p) => ({ ...p })),
      closed: safeArr(prevPositions?.closed).map((p) => ({ ...p })),
    };

    const performance = await ensureFreshPerformance(mode);

    // Build BTC snapshot from universe (fast + consistent)
    const cgUniverse = await fetchCoinGeckoTopCached();
    const btc = pickBtcFromUniverse(cgUniverse);

    // Build universe (scores, stages, candidates)
    const built = await buildUniverse({ mode, whaleFlow, btc, performance, prevState });
    const universe = built.coins;
    const regime = built.regime;
    const adaptive = built.adaptive;

    const universeMap = new Map(universe.map((c) => [up(c.symbol), c]));
    const openMap = new Map(positions.open.map((p) => [up(p.symbol), p]));

    // Funnel
    let funnel = splitFunnels(universe);
    const recentEntryCount = await readRecentEntryCount(mode);
    funnel = applyFunnelBalancer({
      funnel,
      mode,
      regime,
      openCount: positions.open.length,
      recentEntryCount,
    });

    // Next state
    const nextState = {};

    // ------------------------------------------------------------
    // 1) Update state for non-open coins + send signals
    // ------------------------------------------------------------
    for (const coin of universe) {
      const sym = up(coin.symbol);
      const prev = prevState?.[sym] || {};
      if (openMap.has(sym)) continue;

      const rawStage = up(coin.stage);
      let strongScans = 0;
      let weakScans = n(prev?.weakScans, 0);
      let thesisInvalidScans = n(prev?.thesisInvalidScans, 0);
      let entryLocked = !!prev?.entryLocked;
      let eliteScans = 0;
      let candidateSince = prev?.candidateSince || null;
      let eliteSince = prev?.eliteSince || null;
      let watchScans = n(prev?.watchScans, 0);

      if (rawStage === "RADAR") {
        weakScans = 0;
        thesisInvalidScans = 0;
        candidateSince = null;
        eliteSince = null;
        entryLocked = false;
        watchScans = 0;
      } else {
        if (isMainEliteStage(rawStage)) {
          strongScans = n(prev?.strongScans, 0) + 1;
          eliteScans = n(prev?.eliteScans, 0) + 1;
        } else {
          strongScans = 0;
          eliteScans = 0;
        }

        if (rawStage === "RADAR") weakScans = n(prev?.weakScans, 0) + 1;
        else if (rawStage === "BUILDUP") weakScans = n(prev?.weakScans, 0);
        else weakScans = 0;

        if (rawStage === "RADAR") {
          candidateSince = null;
        } else if (!candidateSince && (rawStage === "BUILDUP" || rawStage === "ALMOST" || isMainEliteStage(rawStage))) {
          candidateSince = now;
        }

        if (isMainEliteStage(rawStage)) {
          if (!prev?.eliteSince || !isMainEliteStage(prev?.stage || "")) eliteSince = now;
          else eliteSince = prev.eliteSince;
        } else {
          eliteSince = null;
        }

        entryLocked = !!prev?.entryLocked;
        thesisInvalidScans = n(prev?.thesisInvalidScans, 0);

        if (coin.tradeDeskStatus === "WATCH") watchScans += 1;
        else if (prev?.tradeDeskStatus === "WATCH" && rawStage === "ALMOST" && n(coin.entryQuality, 0) >= 62) {
          watchScans = Math.max(0, n(prev?.watchScans, 0) - 1);
        } else {
          watchScans = 0;
        }
      }

      // entryReady (adaptive)
      let entryReady = false;
      if (!openMap.has(sym)) {
        const er = THRESHOLDS.main.entryReady;

        const timingNeed = Math.max(n(er.timingScore, 0), n(adaptive.timing, 0));
        const qualityNeed = Math.max(n(er.qualityScore, 0), n(adaptive.quality, 0));
        const marketNeed = Math.max(n(er.marketScore, 0), n(adaptive.market, 0) + (String(regime).toUpperCase() === "HEADWIND" ? 4 : 0));

        entryReady =
          coin.tradeDeskStatus === "OPEN" &&
          coin.tradeCandidate === true &&
          entryLocked === false &&
          thesisInvalidScans <= 2 &&
          coin.tradePlan != null &&
          coin.ob?.valid === true &&
          coin.ob?.fresh === true &&
          (coin.breakout?.ready === true || n(coin.breakout?.pressure, 0) >= n(er.breakoutPressure, 54)) &&
          Math.abs(n(coin.ob?.score, 0)) >= n(THRESHOLDS.main.filters.obScore, 0.008) &&
          n(coin.perfectCandidateScore, 0) >= n(er.perfectCandidate, 70) &&
          n(coin.qualityScore, 0) >= qualityNeed &&
          n(coin.timingScore, 0) >= timingNeed &&
          n(coin.liquidityScore, 0) >= n(er.liquidityScore, 58) &&
          n(coin.marketScore, 0) >= marketNeed;
      }

      nextState[sym] = {
        ...prev,

        stage: rawStage,
        stageWhy: coin.stageWhy,
        eliteType: coin.eliteType,

        price: coin.price,
        marketCap: coin.marketCap,
        volume: coin.volume,
        change24: coin.change24,
        change1h: coin.change1h,
        vm: coin.vm,
        range24: coin.range24,

        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
        moveScore: coin.moveScore,
        velocity: coin.velocity,

        compression: coin.compression,
        breakout: coin.breakout,
        volAcc: coin.volAcc,

        ob: coin.ob,
        tradePlan: coin.tradePlan,

        strongScans,
        weakScans,
        thesisInvalidScans,
        eliteScans,
        candidateSince,
        eliteSince,
        entryLocked,
        entryReady,
        watchScans,

        qualityScore: coin.qualityScore,
        liquidityScore: coin.liquidityScore,
        timingScore: coin.timingScore,
        marketScore: coin.marketScore,
        btcAlignmentScore: coin.btcAlignmentScore,
        perfectCandidateScore: coin.perfectCandidateScore,

        superScannerCoin: !!coin.superScannerCoin,
        tradeCandidate: !!coin.tradeCandidate,
        tradeDeskStatus: coin.tradeDeskStatus || "IGNORE",

        name: coin.name,
        image: coin.image,

        lastSeen: now,

        _state: coin._state || prev._state || {},
      };

      // Signals
      const isElitePreTrade = coin.tradeDeskStatus === "WATCH" && watchScans >= 2;
      const isRegularFunnelSignal = rawStage === "RADAR" || rawStage === "BUILDUP";

      if (isRegularFunnelSignal) {
        await safeSendSignal({
          source: "main",
          kind: "signal",
          mode,
          stage: rawStage,
          btcState: btc?.state || "NEUTRAL",
          reason: rawStage === "BUILDUP" ? "setup bouwt op" : "nieuwe radar setup",
          coin,
        });
      }

      if (isElitePreTrade) {
        await safeSendSignal({
          source: "main",
          kind: "elite_watch",
          mode,
          stage: rawStage,
          btcState: btc?.state || "NEUTRAL",
          reason: "bijna entry klaar — zet hem klaar",
          coin,
        });
      }

      if (coin.tradeDeskStatus === "OPEN") {
        await safeSendSignal({
          source: "main",
          kind: "signal",
          mode,
          stage: "ENTRY",
          btcState: btc?.state || "NEUTRAL",
          reason: "Main scanner entry window OPEN",
          coin,
        });
      }
    }

    // ------------------------------------------------------------
    // 2) Open new entries
    // ------------------------------------------------------------
    const entryCandidates = [];
    for (const sym of Object.keys(nextState)) {
      const s = nextState[sym];
      if (!s?.entryReady) continue;
      if (s.tradeCandidate !== true) continue;
      if (s.tradeDeskStatus !== "OPEN") continue;
      if (openMap.has(sym)) continue;

      const coin = universeMap.get(sym);
      if (!coin?.tradePlan) continue;

      const cdUntil = await kv.get(cooldownKey(mode, sym));
      if (n(cdUntil, 0) > now) continue;

      entryCandidates.push({ sym, state: s, coin });
    }

    entryCandidates.sort((a, b) => n(b.coin.entryQuality, 0) - n(a.coin.entryQuality, 0));

    const slotsLeft = MAX_OPEN_TRADES - positions.open.length;
    const toOpen = entryCandidates.slice(0, Math.max(0, slotsLeft));

    for (const c of toOpen) {
      const { sym, coin, state } = c;
      const id = uid("main");

      // Optional real execution (Bitget): handled inside executeEntryIfEnabled()
      const exec = await executeEntryIfEnabled({
        mode,
        symbol: sym,
        side: mode === "bear" ? "sell" : "buy",
        quoteSizeUsd: BASE_POSITION_SIZE_USD,
        clientOrderId: id,
      });

      const newPos = {
        id,
        symbol: sym,
        mode,
        status: "OPEN",

        entryAt: now,
        entryPrice: n(exec?.fillPrice, 0) > 0 ? n(exec.fillPrice, 0) : n(coin.tradePlan.entry, 0),
        lastPrice: n(coin.price, 0),

        sizeUsd: BASE_POSITION_SIZE_USD,
        pnlPct: 0,
        pnlUsd: 0,

        tp: n(coin.tradePlan.tp, 0),
        sl: n(coin.tradePlan.sl, 0),
        rr: n(coin.tradePlan.rr, 0),

        tpPct: n(coin.tradePlan.tpPct, 0),
        slPct: n(coin.tradePlan.slPct, 0),

        entryQuality: n(coin.entryQuality, 0),
        persistenceScore: n(coin.persistenceScore, 0),
        regime,
        stage: coin.stage,
        eliteType: coin.eliteType || null,

        execution: exec || null,
      };

      positions.open.push(newPos);
      openMap.set(sym, newPos);

      nextState[sym] = {
        ...state,
        entryActive: true,
        entryLocked: true,
        entryReady: false,
        lastEntryAt: now,
      };

      await appendEntryHistory(mode);

      await safePushEvent("trade_opened", {
        id,
        mode,
        symbol: sym,
        entry: newPos.entryPrice,
        sizeUsd: newPos.sizeUsd,
        tp: newPos.tp,
        sl: newPos.sl,
        rr: newPos.rr,
        stage: newPos.stage,
        eliteType: newPos.eliteType,
        execution: exec || null,
      });

      await safeSendSignal({
        source: "main",
        kind: "trade_opened",
        mode,
        stage: coin.stage,
        btcState: btc?.state || "NEUTRAL",
        reason: exec?.ok ? "order geplaatst" : "paper entry (execution disabled/fallback)",
        coin,
        position: newPos,
      });
    }

    // ------------------------------------------------------------
    // 2B) Update open positions + exits (TP/SL/TIMEOUT/EARLY)
    // ------------------------------------------------------------
    for (let i = positions.open.length - 1; i >= 0; i--) {
      const pos = positions.open[i];
      const sym = up(pos.symbol);
      const coin = universeMap.get(sym);

      const lastPrice = coin ? n(coin.price, n(pos.lastPrice, 0)) : n(pos.lastPrice, 0);
      pos.lastPrice = lastPrice;

      const pnlPct = calcPnlPct(pos.entryPrice, lastPrice, pos.mode);
      const pnlUsd = calcPnlUsd(pos.sizeUsd, pnlPct);
      pos.pnlPct = Number(pnlPct.toFixed(3));
      pos.pnlUsd = Number(pnlUsd.toFixed(2));

      // Hard exit TP/SL
      const ht = hitStopOrTp(pos, lastPrice);
      if (ht.hit) {
        const exitExec = await executeExitIfEnabled({
          mode,
          symbol: sym,
          side: pos.mode === "bear" ? "buy" : "sell",
          clientOrderId: `${pos.id}_${ht.kind}`,
        });

        const closed = await closePosition({
          positions,
          idx: i,
          now,
          lastPrice: n(exitExec?.fillPrice, 0) > 0 ? n(exitExec.fillPrice, 0) : lastPrice,
          kind: ht.kind,
          reason: ht.kind === "TP" ? "take_profit" : "stop_loss",
          mode,
          regime,
          execSnapshot: exitExec || null,
        });

        if (closed) {
          await safePushEvent("trade_closed", {
            id: closed.id,
            mode,
            symbol: closed.symbol,
            exitKind: closed.exitKind,
            pnlPct: closed.pnlPct,
            pnlUsd: closed.pnlUsd,
            entry: closed.entryPrice,
            exit: closed.exitPrice,
            execution: exitExec || null,
          });

          await safeSendSignal({
            source: "main",
            kind: "trade_closed",
            mode,
            stage: "EXIT",
            btcState: btc?.state || "NEUTRAL",
            reason: `${closed.exitKind} • pnl ${closed.pnlPct.toFixed(2)}%`,
            coin: coin || { symbol: closed.symbol, price: closed.exitPrice },
            position: closed,
          });
        }
        continue;
      }

      // TIMEOUT exit
      if (isTimeoutExit(pos, now)) {
        const exitExec = await executeExitIfEnabled({
          mode,
          symbol: sym,
          side: pos.mode === "bear" ? "buy" : "sell",
          clientOrderId: `${pos.id}_TIMEOUT`,
        });

        const closed = await closePosition({
          positions,
          idx: i,
          now,
          lastPrice: n(exitExec?.fillPrice, 0) > 0 ? n(exitExec.fillPrice, 0) : lastPrice,
          kind: "TIMEOUT",
          reason: "timeout_no_progress",
          mode,
          regime,
          execSnapshot: exitExec || null,
        });

        if (closed) {
          await safePushEvent("trade_closed", {
            id: closed.id,
            mode,
            symbol: closed.symbol,
            exitKind: closed.exitKind,
            pnlPct: closed.pnlPct,
            pnlUsd: closed.pnlUsd,
            entry: closed.entryPrice,
            exit: closed.exitPrice,
            execution: exitExec || null,
          });

          await safeSendSignal({
            source: "main",
            kind: "trade_closed",
            mode,
            stage: "EXIT",
            btcState: btc?.state || "NEUTRAL",
            reason: `TIMEOUT • pnl ${closed.pnlPct.toFixed(2)}%`,
            coin: coin || { symbol: closed.symbol, price: closed.exitPrice },
            position: closed,
          });
        }
        continue;
      }

      // EARLY_EXIT
      if (isEarlyExit(pos, now)) {
        const exitExec = await executeExitIfEnabled({
          mode,
          symbol: sym,
          side: pos.mode === "bear" ? "buy" : "sell",
          clientOrderId: `${pos.id}_EARLY`,
        });

        const closed = await closePosition({
          positions,
          idx: i,
          now,
          lastPrice: n(exitExec?.fillPrice, 0) > 0 ? n(exitExec.fillPrice, 0) : lastPrice,
          kind: "EARLY_EXIT",
          reason: "early_exit_cut",
          mode,
          regime,
          execSnapshot: exitExec || null,
        });

        if (closed) {
          await safePushEvent("trade_closed", {
            id: closed.id,
            mode,
            symbol: closed.symbol,
            exitKind: closed.exitKind,
            pnlPct: closed.pnlPct,
            pnlUsd: closed.pnlUsd,
            entry: closed.entryPrice,
            exit: closed.exitPrice,
            execution: exitExec || null,
          });

          await safeSendSignal({
            source: "main",
            kind: "trade_closed",
            mode,
            stage: "EXIT",
            btcState: btc?.state || "NEUTRAL",
            reason: `EARLY_EXIT • pnl ${closed.pnlPct.toFixed(2)}%`,
            coin: coin || { symbol: closed.symbol, price: closed.exitPrice },
            position: closed,
          });
        }
        continue;
      }
    }

    // ------------------------------------------------------------
    // 3) Portfolio + persistence
    // ------------------------------------------------------------
    // Keep only last 1000 closed
    positions.closed = positions.closed.slice(0, 1000);

    const portfolio = {
      mode,
      posUsd: BASE_POSITION_SIZE_USD,
      openCount: positions.open.length,
      closedCount: positions.closed.length,
      realizedUsd: Number(positions.closed.reduce((a, b) => a + n(b.pnlUsd, 0), 0).toFixed(2)),
      avgRealizedPct: Number(
        (positions.closed.length
          ? positions.closed.reduce((a, b) => a + n(b.pnlPct, 0), 0) / positions.closed.length
          : 0
        ).toFixed(2)
      ),
      updatedAt: now,
    };

    await kv.set(keyMainPortfolio(mode), portfolio, { ex: 60 * 60 * 24 * 7 });
    await kv.set(keyMainState(mode), nextState, { ex: 60 * 60 * 24 * 3 });
    await kv.set(keyMainPositions(mode), positions, { ex: 60 * 60 * 24 * 7 });

    // refresh performance after exits
    const updatedPerf = computePerformance(positions.closed);
    await kv.set(keyMainPerformance(mode), updatedPerf, { ex: 60 * 60 * 24 * 7 });

    // ------------------------------------------------------------
    // 4) Latest payload
    // ------------------------------------------------------------
    const responseFunnel = { ...funnel, hold: [], sell: [] };

    const premiumCandidates = universe
      .filter((c) => c.superScannerCoin === true)
      .sort((a, b) => n(b.perfectCandidateScore, 0) - n(a.perfectCandidateScore, 0))
      .slice(0, 12);

    const tradeReadyCandidates = universe
      .filter((c) => c.tradeDeskStatus === "OPEN")
      .sort((a, b) => n(b.perfectCandidateScore, 0) - n(a.perfectCandidateScore, 0))
      .slice(0, 20);

    const watchCandidates = universe
      .filter((c) => c.tradeDeskStatus === "WATCH")
      .sort((a, b) => n(b.perfectCandidateScore, 0) - n(a.perfectCandidateScore, 0))
      .slice(0, 20);

    const scannerOnlyCandidates = universe
      .filter((c) => c.superScannerCoin !== true)
      .sort((a, b) => n(b.perfectCandidateScore, 0) - n(a.perfectCandidateScore, 0))
      .slice(0, 20);

    const latest = {
      ok: true,
      mode,
      regime,
      btc: {
        price: n(btc?.price, 0),
        chg24: n(btc?.chg24, 0),
        chg1h: n(btc?.chg1h, 0),
        range24: n(btc?.range24, 0),
        state: String(btc?.state || "NEUTRAL").toUpperCase(),
      },
      whaleFlow: n(whaleFlow, 0),
      funnel: responseFunnel,
      counts: {
        elite_expansion: responseFunnel.elite_expansion?.length || 0,
        elite_ignition: responseFunnel.elite_ignition?.length || 0,
        almost: responseFunnel.almost?.length || 0,
        buildup: responseFunnel.buildup?.length || 0,
        radar: responseFunnel.radar?.length || 0,
        hold: 0,
        sell: 0,
      },
      candidates: {
        premium: premiumCandidates,
        tradeReady: tradeReadyCandidates,
        watch: watchCandidates,
        scannerOnly: scannerOnlyCandidates,
      },
      portfolio,
      positions: { open: positions.open.length, closed: positions.closed.length },
      meta: {
        performance: updatedPerf,
        positionSizeUsd: BASE_POSITION_SIZE_USD,
        adaptiveThresholds: adaptive,
        thresholdsCurrent: THRESHOLDS.main,
        settings: { CG_TOP: SETTINGS.CG_TOP, RADAR_LIMIT: SETTINGS.RADAR_LIMIT },
        scanLock: { active: false, until: null },
      },
      ts: now,
      scannedAt: now,
    };

    await kv.set(keyMainLatest(mode), latest, { ex: 60 * 60 });

    return res.status(200).json(latest);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("main scan error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  } finally {
    if (lockAcquired) await releaseScanLock(mode);
  }
}