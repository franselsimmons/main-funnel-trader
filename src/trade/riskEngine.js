// ================= FILE: src/trade/riskEngine.js =================

import { CONFIG } from '../config.js';
import { calculateAtrPct, calculateRsi, getRsiSlope, getRsiZone, classifyFlow } from '../market/indicators.js';
import { clamp, getObRelation, safeNumber } from '../utils.js';

export function calculateRR({ entry, sl, tp, side }) {
  const e = safeNumber(entry);
  const s = safeNumber(sl);
  const t = safeNumber(tp);
  if (!e || !s || !t) return 0;
  const risk = Math.abs(e - s);
  if (!risk) return 0;
  const reward = side === 'bull' ? t - e : e - t;
  return reward > 0 ? reward / risk : 0;
}

export function buildRiskGeometry({ candidate, ob, candles15m }) {
  const side = String(candidate.side || '').toLowerCase();
  const entry = safeNumber(ob?.mid || candidate.price);
  if (!entry) return null;

  const atrPct = calculateAtrPct(candles15m, 14);
  const spread = safeNumber(ob?.spreadPct);
  const riskPct = clamp(Math.max(0.005, atrPct * 1.2, spread * 5), 0.004, 0.025);
  const rewardPct = riskPct * CONFIG.trade.defaultRR;

  const sl = side === 'bull' ? entry * (1 - riskPct) : entry * (1 + riskPct);
  const tp = side === 'bull' ? entry * (1 + rewardPct) : entry * (1 - rewardPct);
  const rr = calculateRR({ entry, sl, tp, side });

  return {
    entry: Number(entry.toFixed(8)),
    sl: Number(sl.toFixed(8)),
    tp: Number(tp.toFixed(8)),
    rr: Number(rr.toFixed(4)),
    slSource: 'ATR_SPREAD_FALLBACK',
    tpSource: 'DEFAULT_RR_TARGET',
    riskPct: Number(riskPct.toFixed(6))
  };
}

export function buildLiveMetrics({ candidate, ob, funding, candles15m, candles1h, btcState, regime, risk }) {
  const rsi = calculateRsi(candles15m, 14) ?? 50;
  const rsiHTF = calculateRsi(candles1h, 14) ?? rsi;
  const rsiZone = getRsiZone(rsi);
  const rsiSlope = getRsiSlope(candles15m);
  const flow = classifyFlow({ side: candidate.side, change1h: candidate.change1h, change24h: candidate.change24h, candles15m });
  const obRelation = getObRelation(candidate.side, ob?.bias);

  let confluence = 0;
  confluence += clamp(candidate.scannerScore || candidate.moveScore, 0, 100) * 0.32;
  confluence += flow === 'TREND' ? 18 : flow === 'BUILDING' ? 10 : 3;
  confluence += obRelation === 'WITH' ? 15 : obRelation === 'NEUTRAL' ? 4 : -12;
  confluence += risk?.rr >= 1.5 ? 10 : risk?.rr >= 1 ? 6 : 0;
  confluence += candidate.pullbackConfirmed ? 8 : 0;
  confluence += candidate.fakeBreakoutRisk ? -10 : 0;
  confluence += Math.abs(rsiSlope) > 2 ? 4 : 0;
  confluence = Math.round(clamp(confluence, 0, 100));

  let sniperScore = 0;
  sniperScore += clamp(candidate.moveScore || candidate.scannerScore, 0, 100) * 0.35;
  sniperScore += obRelation === 'WITH' ? 18 : obRelation === 'NEUTRAL' ? 6 : -15;
  sniperScore += flow === 'TREND' ? 18 : flow === 'BUILDING' ? 10 : 2;
  sniperScore += risk?.rr >= 1.5 ? 10 : 4;
  if (candidate.side === 'bull' && rsiZone.startsWith('LOWER')) sniperScore += 10;
  if (candidate.side === 'bear' && rsiZone.startsWith('UPPER')) sniperScore += 10;
  if (rsiZone === 'MID') sniperScore += 4;
  sniperScore = Math.round(clamp(sniperScore, 0, 100));

  return {
    ...candidate,
    confluence,
    sniperScore,
    rr: risk?.rr || 0,
    rsi: Number(rsi.toFixed(2)),
    rsiHTF: Number(rsiHTF.toFixed(2)),
    rsiZone,
    rsiSlope,
    rsiContinuationScore: Math.abs(rsiSlope),
    flow,
    obBias: ob?.bias || 'NEUTRAL',
    obRelation,
    spreadPct: safeNumber(ob?.spreadPct),
    depthMinUsd1p: safeNumber(ob?.depthMinUsd1p),
    fundingRate: safeNumber(funding?.rate),
    btcState,
    regime,
    entry: risk.entry,
    sl: risk.sl,
    tp: risk.tp,
    riskPct: risk.riskPct,
    ts: Date.now()
  };
}

export function isValidRiskGeometry(risk, side) {
  if (!risk) return false;
  const entry = safeNumber(risk.entry);
  const sl = safeNumber(risk.sl);
  const tp = safeNumber(risk.tp);
  if (!entry || !sl || !tp) return false;
  if (side === 'bull' && !(sl < entry && tp > entry)) return false;
  if (side === 'bear' && !(sl > entry && tp < entry)) return false;
  return calculateRR({ entry, sl, tp, side }) >= CONFIG.trade.minRR;
}
