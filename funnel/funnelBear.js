import { runFunnel } from "./funnelCore.js"

export function runBearFunnel({
  scannerOutput,
  openPositions,
  portfolioState
}) {
  return runFunnel({
    mode: "bear",
    scannerOutput,
    openPositions,
    portfolioState
  })
}