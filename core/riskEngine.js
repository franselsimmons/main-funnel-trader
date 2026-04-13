let rollingExpectancy = 0
let tradeCount = 0

export function updateExpectancy(rMultiple) {
  tradeCount++
  rollingExpectancy =
    ((rollingExpectancy * (tradeCount - 1)) + rMultiple) / tradeCount
}

export function getRiskMultiplier() {
  if (rollingExpectancy < -0.2) return 0.5
  if (rollingExpectancy < 0) return 0.7
  return 1
}