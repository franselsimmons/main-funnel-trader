export function adaptiveThresholds(regime) {
  let confMin = 60;
  let volAccMin = 1.2;
  let spreadMax = 0.25;
  let depthMin = 75000;

  if (regime === "RISK_ON") {
    confMin -= 10;
    volAccMin -= 0.1;
    depthMin *= 0.7;
  }

  if (regime === "RISK_OFF") {
    confMin += 15;
    spreadMax -= 0.05;
    depthMin *= 1.3;
  }

  return { confMin, volAccMin, spreadMax, depthMin };
}