export function dynamicThreshold(base, lossCluster, slopePenalty) {
  return base + lossCluster * 2 + slopePenalty
}