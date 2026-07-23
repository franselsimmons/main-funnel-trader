// ================= FILE: src/keys.js =================
// COMPLEET Redis key management

const PREFIX = 'SHORT:';

export function scanSnapshot(id = '') {
  return `${PREFIX}SCAN:SNAPSHOT:${id}`;
}

export function scanLatest() {
  return `${PREFIX}SCAN:LATEST`;
}

export function scanStats() {
  return `${PREFIX}SCAN:STATS`;
}

export function candidateAppearance(symbol = '', familyId = '') {
  return `${PREFIX}CANDIDATE:${symbol}:${familyId}`;
}

export function position(positionId = '') {
  return `${PREFIX}POSITION:${positionId}`;
}

export function positionsByFamily(familyId = '', positionId = '') {
  return `${PREFIX}POSITIONS:FAMILY:${familyId}:${positionId}`;
}

export function openPositions() {
  return `${PREFIX}POSITIONS:OPEN`;
}

export function completedTrade(tradeId = '') {
  return `${PREFIX}TRADE:COMPLETED:${tradeId}`;
}

export function entryRecord(positionId = '') {
  return `${PREFIX}ENTRY:RECORD:${positionId}`;
}

export function tradeHistory(positionId = '') {
  return `${PREFIX}TRADE:HISTORY:${positionId}`;
}

export function tradesByDate(date = '') {
  return `${PREFIX}TRADES:DATE:${date}`;
}

export function tradesByFamily(familyId = '') {
  return `${PREFIX}TRADES:FAMILY:${familyId}`;
}

export function microFamilyStats(familyId = '') {
  return `${PREFIX}FAMILY:STATS:${familyId}`;
}

export function microFamilyHistory(familyId = '') {
  return `${PREFIX}FAMILY:HISTORY:${familyId}`;
}

export function microFamilyList() {
  return `${PREFIX}FAMILY:LIST`;
}

export function microFamilyConfidence(familyId = '') {
  return `${PREFIX}FAMILY:CONFIDENCE:${familyId}`;
}

export function parentFamilyStats(parentId = '') {
  return `${PREFIX}PARENT_FAMILY:STATS:${parentId}`;
}

export function familyObservations(familyId = '') {
  return `${PREFIX}FAMILY:OBSERVATIONS:${familyId}`;
}

export function familyTrades(familyId = '') {
  return `${PREFIX}FAMILY:TRADES:${familyId}`;
}

export function rotationActive() {
  return `${PREFIX}ROTATION:ACTIVE`;
}

export function rotationCandidate(familyId = '') {
  return `${PREFIX}ROTATION:CANDIDATE:${familyId}`;
}

export function rotationHistory(weekKey = '') {
  return `${PREFIX}ROTATION:HISTORY:${weekKey}`;
}

export function rotationScores() {
  return `${PREFIX}ROTATION:SCORES`;
}

export function selectedFamiliesThisWeek() {
  return `${PREFIX}ROTATION:SELECTED`;
}

export function accountStats() {
  return `${PREFIX}ACCOUNT:STATS`;
}

export function portfolioStats() {
  return `${PREFIX}PORTFOLIO:STATS`;
}

export function dailyStats(date = '') {
  return `${PREFIX}STATS:DAILY:${date}`;
}

export function weeklyStats(weekKey = '') {
  return `${PREFIX}STATS:WEEKLY:${weekKey}`;
}

export function monthlyStats(month = '') {
  return `${PREFIX}STATS:MONTHLY:${month}`;
}

export function performanceMetrics() {
  return `${PREFIX}PERFORMANCE:METRICS`;
}

export function drawdownTracker() {
  return `${PREFIX}DRAWDOWN:TRACKER`;
}

export function winRateStats() {
  return `${PREFIX}WINRATE:STATS`;
}

export function marketWeather() {
  return `${PREFIX}MARKET:WEATHER`;
}

export function marketWeatherHistory(timestamp = 0) {
  return `${PREFIX}MARKET:WEATHER:HISTORY:${timestamp}`;
}

export function marketSnapshot(symbol = '') {
  return `${PREFIX}MARKET:SNAPSHOT:${symbol}`;
}

export function marketCandles(symbol = '') {
  return `${PREFIX}MARKET:CANDLES:${symbol}`;
}

export function marketIndicators(symbol = '') {
  return `${PREFIX}MARKET:INDICATORS:${symbol}`;
}

export function allSymbols() {
  return `${PREFIX}MARKET:SYMBOLS:ALL`;
}

export function tradeSession(sessionId = '') {
  return `${PREFIX}SESSION:TRADE:${sessionId}`;
}

export function scanSession(sessionId = '') {
  return `${PREFIX}SESSION:SCAN:${sessionId}`;
}

export function tradeSystemStats() {
  return `${PREFIX}SYSTEM:STATS:TRADE`;
}

export function systemConfig() {
  return `${PREFIX}SYSTEM:CONFIG`;
}

export function systemStatus() {
  return `${PREFIX}SYSTEM:STATUS`;
}

export function discordLog(timestamp = 0) {
  return `${PREFIX}DISCORD:LOG:${timestamp}`;
}

export function discordLogs() {
  return `${PREFIX}DISCORD:LOGS`;
}

export function alertQueue() {
  return `${PREFIX}ALERTS:QUEUE`;
}

export function lock(resource = '') {
  return `${PREFIX}LOCK:${resource}`;
}

export function scanLock() {
  return `${PREFIX}LOCK:SCANNER`;
}

export function tradeLock() {
  return `${PREFIX}LOCK:TRADER`;
}

export function rotationLock() {
  return `${PREFIX}LOCK:ROTATION`;
}

export function freezeLock() {
  return `${PREFIX}LOCK:FREEZE`;
}

export function adminAction(actionId = '') {
  return `${PREFIX}ADMIN:ACTION:${actionId}`;
}

export function factoryResetFlag() {
  return `${PREFIX}ADMIN:FACTORY_RESET`;
}

export function resetLearningFlag() {
  return `${PREFIX}ADMIN:RESET_LEARNING`;
}

export function resetRotationFlag() {
  return `${PREFIX}ADMIN:RESET_ROTATION`;
}

export function cronLastRun(cronName = '') {
  return `${PREFIX}CRON:LAST_RUN:${cronName}`;
}

export function cronNextRun(cronName = '') {
  return `${PREFIX}CRON:NEXT_RUN:${cronName}`;
}

export function cronStatus() {
  return `${PREFIX}CRON:STATUS`;
}

export function featureFlag(flagName = '') {
  return `${PREFIX}FEATURE:${flagName}`;
}

export function configValue(configKey = '') {
  return `${PREFIX}CONFIG:${configKey}`;
}

export function systemHealth() {
  return `${PREFIX}HEALTH:SYSTEM`;
}

export function apiHealth() {
  return `${PREFIX}HEALTH:API`;
}

export const keys = {
  scanSnapshot, scanLatest, scanStats, candidateAppearance,
  position, positionsByFamily, openPositions, completedTrade, entryRecord, tradeHistory, tradesByDate, tradesByFamily,
  microFamilyStats, microFamilyHistory, microFamilyList, microFamilyConfidence, parentFamilyStats, familyObservations, familyTrades,
  rotationActive, rotationCandidate, rotationHistory, rotationScores, selectedFamiliesThisWeek,
  accountStats, portfolioStats, dailyStats, weeklyStats, monthlyStats, performanceMetrics, drawdownTracker, winRateStats,
  marketWeather, marketWeatherHistory, marketSnapshot, marketCandles, marketIndicators, allSymbols,
  tradeSession, scanSession, tradeSystemStats, systemConfig, systemStatus,
  discordLog, discordLogs, alertQueue,
  lock, scanLock, tradeLock, rotationLock, freezeLock,
  adminAction, factoryResetFlag, resetLearningFlag, resetRotationFlag,
  cronLastRun, cronNextRun, cronStatus,
  featureFlag, configValue, systemHealth, apiHealth
};

export default keys;
