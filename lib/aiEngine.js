import { n } from "./utils";

export function computeAiScore({
  momentum,
  volAcc,
  compression,
  obScore,
  rr
}) {
  let score = 0;

  score += n(momentum) * 2;
  score += n(volAcc) * 10;
  score += compression ? 15 : 0;
  score += n(obScore) * 100;
  score += n(rr) * 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}