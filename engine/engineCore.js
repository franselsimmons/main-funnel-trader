import { SHARED_CONFIG } from "../config/shared.js"

export function runEngine({
  mode,
  funnelOutput,
  openPositions,
  marketLiveData,
  regime
}) {

  const newPositions = []
  const updatedPositions = []

  // 1️⃣ ENTRY LOGIC
  for (const candidate of funnelOutput.approved || []) {

    if (openPositions.find(p => p.symbol === candidate.symbol))
      continue

    newPositions.push(createPosition(candidate, regime))
  }

  // 2️⃣ POSITION MANAGEMENT
  for (const pos of openPositions) {

    const live = marketLiveData[pos.symbol]
    if (!live) continue

    const updated = managePosition(pos, live, regime)

    if (!updated.closed)
      updatedPositions.push(updated)
  }

  return {
    newPositions,
    updatedPositions
  }
}