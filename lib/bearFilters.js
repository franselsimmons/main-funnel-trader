import { multiTFScore } from "./timeframe.js";

export function bearFilter(c) {

  const tf = multiTFScore(c);

  // 🔥 RADAR
  if (tf <= 0 && c.vm > 0.05) return "RADAR";

  // 🔥 BUILDUP
  if (
    tf <= -1 &&
    c.change24 < -1.5 &&
    c.vm > 0.1
  ) return "BUILDUP";

  // 🔥 ALMOST
  if (
    tf <= -2 &&
    c.change24 < -3 &&
    c.vm > 0.2
  ) return "ALMOST";

  // 🔥 ENTRY
  if (
    tf <= -3 &&
    c.change24 < -5 &&
    c.vm > 0.3
  ) return "ENTRY";

  return false;
}