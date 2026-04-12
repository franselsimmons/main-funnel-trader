import { runEngine } from "./engineCore.js"

export function runBullEngine({
  funnelOutput,
  openPositions,
  marketLiveData
}) {
  return runEngine({
    mode: "bull",
    funnelOutput,
    openPositions,
    marketLiveData,
    regime: funnelOutput.regime
  })
}