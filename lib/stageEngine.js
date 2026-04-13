export function computeStage({
  radarPass,
  warmupPass,
  setupPass,
  entryPass,
  prevStage = "UNIVERSE",
  prevCycles = 0
}) {
  let stage = "UNIVERSE";

  if (radarPass) stage = "RADAR";
  if (warmupPass) stage = "WARMUP";
  if (setupPass) stage = "SETUP";

  if (entryPass && prevStage === "SETUP" && prevCycles >= 2)
    stage = "ENTRY_READY";

  if (prevStage === "ENTRY_READY" && !entryPass)
    stage = "SETUP";

  const cycles =
    prevStage === stage ? prevCycles + 1 : 1;

  return { stage, cycles };
}