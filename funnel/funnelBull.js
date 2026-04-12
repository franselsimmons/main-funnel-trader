import { runFunnel } from "./funnelCore.js"

export function runBullFunnel({
  scannerOutput,
  openPositions,
  portfolioState
}) {
  return runFunnel({
    mode: "bull",
    scannerOutput,
    openPositions,
    portfolioState
  })
}