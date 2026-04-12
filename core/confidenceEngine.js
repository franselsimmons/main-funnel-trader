export function computeConfidence({
  momentumScore,
  liquidityScore,
  regimeScore,
  betaPenalty
}) {
  return (
    momentumScore * 0.4 +
    liquidityScore * 0.3 +
    regimeScore * 0.2 -
    betaPenalty * 20
  )
}