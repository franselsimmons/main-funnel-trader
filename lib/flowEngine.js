export function analyzeFlow(c) {
  const momentum = Math.abs(Number(c.change1h || 0));
  const trend = Number(c.change24 || 0);

  // 🚀 continuation
  if (momentum > 1 && trend > 5) {
    return {
      type: "TREND_CONTINUATION",
      strength: "high"
    };
  }

  // ⚠️ exhaustion
  if (momentum < 0.2 && trend > 8) {
    return {
      type: "EXHAUSTION",
      strength: "high"
    };
  }

  return {
    type: "NEUTRAL",
    strength: "low"
  };
}