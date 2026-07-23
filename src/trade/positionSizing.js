// ================= FILE: src/trade/positionSizing.js =================
// Position sizing with Kelly & EVK

import { CONFIG } from '../config.js';
import { roundTo } from '../utils.js';

export function calculateKellyFraction(winRate = 0.5, winLoss = 1, totalEdgeR = 0.1) {
  const b = winLoss;
  const p = winRate;
  const q = 1 - p;
  
  const kellyPct = (p * b - q) / b;
  return Math.max(0, Math.min(kellyPct, 0.25));
}

export function calculatePositionSize(
  accountSize = 10000,
  winRate = 0.5,
  avgWinSize = 1,
  avgLossSize = 1,
  riskPct = 0.02,
  method = 'KELLY'
) {
  if (method === 'KELLY') {
    const kellyFraction = calculateKellyFraction(winRate, avgWinSize / avgLossSize);
    const fractionalKelly = kellyFraction * 0.25;
    return roundTo(accountSize * fractionalKelly / avgLossSize, 0);
  }
  
  // Fixed risk method
  return roundTo((accountSize * riskPct) / avgLossSize, 0);
}

export function calculateFractionalKelly(accountSize = 10000, kellyFraction = 0.25, fraction = 0.25) {
  return roundTo(accountSize * (kellyFraction * fraction), 2);
}

export function calculateBankroll(
  baseSize = 1,
  numConcurrentTrades = 5,
  riskPerTrade = 0.02,
  slSize = 0.02
) {
  const totalRisk = numConcurrentTrades * riskPerTrade;
  const riskPerUnit = slSize;
  return roundTo(baseSize / (totalRisk / riskPerUnit), 2);
}

export default {
  calculateKellyFraction, calculatePositionSize, calculateFractionalKelly, calculateBankroll
};
