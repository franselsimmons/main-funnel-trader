// ================= FILE: src/utils.js =================

import crypto from 'node:crypto';

export const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value || 0)));

export const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeBaseSymbol(raw) {
  return String(raw || '')
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$|_DMCBL$|_CMCBL$/g, '')
    .replace(/-UMCBL$|-DMCBL$|-CMCBL$/g, '')
    .replace(/USDT$|USDC$/g, '');
}

export function normalizeContractSymbol(raw) {
  let s = String(raw || '').toUpperCase().trim();
  s = s
    .replace(/_UMCBL$|_DMCBL$|_CMCBL$/g, '')
    .replace(/-UMCBL$|-DMCBL$|-CMCBL$/g, '');
  if (!s.endsWith('USDT') && !s.endsWith('USDC')) s = `${s}USDT`;
  return s;
}

export function getUtcDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function getIsoWeekKey(ts = Date.now()) {
  const date = new Date(ts);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function getNextIsoWeekKey(ts = Date.now()) {
  const d = new Date(ts);
  d.setUTCDate(d.getUTCDate() + 7);
  return getIsoWeekKey(d.getTime());
}

export function getPreviousIsoWeekKey(ts = Date.now()) {
  const d = new Date(ts);
  d.setUTCDate(d.getUTCDate() - 7);
  return getIsoWeekKey(d.getTime());
}

export function stableHash(value, length = 8) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, length).toUpperCase();
}

export function randomId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

export function sideToTradeSide(side) {
  const s = String(side || '').toLowerCase();
  if (['bull', 'buy', 'long'].includes(s)) return 'LONG';
  if (['bear', 'sell', 'short'].includes(s)) return 'SHORT';
  return 'UNKNOWN';
}

export function getObRelation(side, obBias) {
  const s = String(side || '').toLowerCase();
  const ob = String(obBias || 'NEUTRAL').toUpperCase();
  if (!['BULLISH', 'BEARISH'].includes(ob)) return 'NEUTRAL';
  if (s === 'bull' && ob === 'BULLISH') return 'WITH';
  if (s === 'bear' && ob === 'BEARISH') return 'WITH';
  return 'AGAINST';
}

export function bucketStep(value, step, prefix, decimals = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${prefix}_NA`;
  const lower = Math.floor(n / step) * step;
  const upper = lower + step;
  const clean = v => String(v.toFixed(decimals)).replace('-', 'M').replace('.', 'P');
  return `${prefix}_${clean(lower)}_${clean(upper)}`.toUpperCase();
}

export function bucketSpread(spreadPct) {
  const bps = safeNumber(spreadPct) * 10000;
  if (bps < 4) return 'SPREAD_LT_4BPS';
  if (bps < 8) return 'SPREAD_4_8BPS';
  if (bps < 12) return 'SPREAD_8_12BPS';
  if (bps < 20) return 'SPREAD_12_20BPS';
  if (bps < 35) return 'SPREAD_20_35BPS';
  return 'SPREAD_GT_35BPS';
}

export function bucketDepth(depthUsd) {
  const d = safeNumber(depthUsd);
  if (d <= 0) return 'DEPTH_NA';
  if (d < 10_000) return 'DEPTH_LT_10K';
  if (d < 50_000) return 'DEPTH_10K_50K';
  if (d < 100_000) return 'DEPTH_50K_100K';
  if (d < 250_000) return 'DEPTH_100K_250K';
  if (d < 500_000) return 'DEPTH_250K_500K';
  return 'DEPTH_GT_500K';
}

export function bucketFunding(rate) {
  const r = safeNumber(rate);
  if (r <= -0.015) return 'FUNDING_NEG_EXTREME';
  if (r <= -0.006) return 'FUNDING_NEG_HIGH';
  if (r < -0.001) return 'FUNDING_NEG';
  if (r <= 0.001) return 'FUNDING_NEUTRAL';
  if (r < 0.006) return 'FUNDING_POS';
  if (r < 0.015) return 'FUNDING_POS_HIGH';
  return 'FUNDING_POS_EXTREME';
}

export function pct(value, decimals = 1) {
  return `${(safeNumber(value) * 100).toFixed(decimals)}%`;
}

export async function mapConcurrent(items, concurrency, mapper) {
  const rows = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency || 1));
  const out = new Array(rows.length);
  let i = 0;

  async function worker() {
    while (i < rows.length) {
      const index = i++;
      out[index] = await mapper(rows[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, worker));
  return out;
}

export function classifyBtcState({ change24 = 0, change1h = 0 } = {}) {
  const ch24 = safeNumber(change24);
  const ch1 = safeNumber(change1h);
  if (ch24 > 1.5 && ch1 > 0.5) return 'STRONG_BULL';
  if (ch24 < -1.5 && ch1 < -0.5) return 'STRONG_BEAR';
  if (ch24 > 0.6 || ch1 > 0.25) return 'BULLISH';
  if (ch24 < -0.6 || ch1 < -0.25) return 'BEARISH';
  return 'NEUTRAL';
}
