import { runEngine } from "./engineCore.js"

export function runBearEngine({
  funnelOutput,
  openPositions,
  marketLiveData
}) {
  return runEngine({
    mode: "bear",
    funnelOutput,
    openPositions,
    marketLiveData,
    regime: funnelOutput.regime
  })
}