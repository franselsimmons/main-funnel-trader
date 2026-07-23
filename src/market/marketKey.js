// ================= FILE: src/market/marketKey.js =================
//
// Market key management - manages keys for market data storage
//

export function getMarketSnapshotKey(symbol = '') {
  return `MARKET:SNAPSHOT:${symbol}`;
}

export function getMarketHistoryKey(symbol = '', timeframe = '1H') {
  return `MARKET:HISTORY:${symbol}:${timeframe}`;
}

export function getMarketCandlesKey(symbol = '') {
  return `MARKET:CANDLES:${symbol}`;
}

export function getMarketIndicesKey(symbol = '') {
  return `MARKET:INDICES:${symbol}`;
}

export function getAllMarketsKey() {
  return 'MARKET:ALL:SYMBOLS';
}

export function getMarketAlertKey(symbol = '') {
  return `MARKET:ALERT:${symbol}`;
}

export default {
  getMarketSnapshotKey,
  getMarketHistoryKey,
  getMarketCandlesKey,
  getMarketIndicesKey,
  getAllMarketsKey,
  getMarketAlertKey
};
