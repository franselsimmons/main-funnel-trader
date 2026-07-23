// ================= FILE: src/trade/costModel.js =================
// Trade cost calculations

import { CONFIG } from '../config.js';
import { roundTo } from '../utils.js';

export function calculateOpeningCosts(entryPrice = 0, size = 0) {
  const takerFeeEntry = entryPrice * size * CONFIG.TRADE.BITGET_TAKER_FEE;
  const entrySlippage = entryPrice * size * CONFIG.TRADE.ENTRY_SLIPPAGE;
  const totalCost = takerFeeEntry + entrySlippage;
  
  return {
    takerFee: roundTo(takerFeeEntry, 8),
    slippage: roundTo(entrySlippage, 8),
    total: roundTo(totalCost, 8),
    costPerContract: roundTo(totalCost / size, 8)
  };
}

export function calculateClosingCosts(exitPrice = 0, size = 0) {
  const takerFeeExit = exitPrice * size * CONFIG.TRADE.BITGET_TAKER_FEE;
  const exitSlippage = exitPrice * size * CONFIG.TRADE.EXIT_SLIPPAGE;
  const totalCost = takerFeeExit + exitSlippage;
  
  return {
    takerFee: roundTo(takerFeeExit, 8),
    slippage: roundTo(exitSlippage, 8),
    total: roundTo(totalCost, 8),
    costPerContract: roundTo(totalCost / size, 8)
  };
}

export function calculateTotalCosts(entryPrice = 0, exitPrice = 0, size = 0) {
  const openCosts = calculateOpeningCosts(entryPrice, size);
  const closeCosts = calculateClosingCosts(exitPrice, size);
  
  return {
    opening: openCosts,
    closing: closeCosts,
    totalCosts: roundTo(openCosts.total + closeCosts.total, 8),
    costPercentOfEntry: roundTo((openCosts.total + closeCosts.total) / (entryPrice * size), 4)
  };
}

export function calculateNetPnL(entryPrice = 0, exitPrice = 0, size = 0, positionType = 'SHORT') {
  const grossPnL = positionType === 'SHORT' 
    ? (entryPrice - exitPrice) * size 
    : (exitPrice - entryPrice) * size;
  
  const costs = calculateTotalCosts(entryPrice, exitPrice, size);
  const netPnL = grossPnL - costs.totalCosts;
  
  return {
    grossPnL: roundTo(grossPnL, 8),
    costs: costs.totalCosts,
    netPnL: roundTo(netPnL, 8),
    netPercentage: roundTo((netPnL / (entryPrice * size)) * 100, 4)
  };
}

export function breakEvenPrice(entryPrice = 0, positionType = 'SHORT') {
  const fullCostRatio = (2 * CONFIG.TRADE.BITGET_TAKER_FEE) + CONFIG.TRADE.ENTRY_SLIPPAGE + CONFIG.TRADE.EXIT_SLIPPAGE;
  
  if (positionType === 'SHORT') {
    return roundTo(entryPrice * (1 + fullCostRatio), 8);
  }
  return roundTo(entryPrice * (1 - fullCostRatio), 8);
}

export function costAdjustedRiskReward(entryPrice = 0, slPrice = 0, tpPrice = 0, size = 0) {
  const costs = calculateTotalCosts(entryPrice, (entryPrice + slPrice) / 2, size);
  const costPerContract = costs.costPercentOfEntry;
  
  const rawRisk = Math.abs(entryPrice - slPrice) / entryPrice;
  const rawReward = Math.abs(entryPrice - tpPrice) / entryPrice;
  
  const adjustedRisk = rawRisk + costPerContract;
  const adjustedReward = rawReward - costPerContract;
  
  return {
    rawRR: roundTo(rawReward / rawRisk, 2),
    costAdjustedRR: roundTo(adjustedReward / adjustedRisk, 2),
    costImpact: roundTo((1 - (adjustedReward / adjustedRisk) / (rawReward / rawRisk)) * 100, 2)
  };
}

export default {
  calculateOpeningCosts, calculateClosingCosts, calculateTotalCosts,
  calculateNetPnL, breakEvenPrice, costAdjustedRiskReward
};
