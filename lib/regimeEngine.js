import { n } from "./utils";

export function computeBtcRegime(btc) {
  const chg24 = n(btc.change24, 0);
  const range24 = n(btc.range24, 0);

  let score = 50;

  score += chg24 * 3;
  score += range24 > 3 ? 5 : -5;

  score = Math.max(0, Math.min(100, score));

  let regime = "NEUTRAL";
  if (score > 65) regime = "RISK_ON";
  if (score < 35) regime = "RISK_OFF";

  return { score, regime };
}