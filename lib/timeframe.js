export function multiTFScore(c) {
  let score = 0;

  if (c.change1h > 0) score += 1;
  if (c.change24 > 0) score += 3;

  if (c.change1h < 0) score -= 1;
  if (c.change24 < 0) score -= 3;

  return score;
}