export function adaptive({ regime, marketCap }) {
  let confMin = 30;
  let spreadMax = 1.2;
  let depthMin = 50000;

  if (regime === "EXPANSION") {
    confMin -= 5;
    depthMin *= 0.7;
  }

  if (regime === "HEADWIND") {
    confMin += 8;
    spreadMax -= 0.2;
  }

  if (marketCap < 200_000_000) {
    depthMin *= 0.6;
  }

  return { confMin, spreadMax, depthMin };
}