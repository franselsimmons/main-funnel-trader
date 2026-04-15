import { multiTFScore } from "./timeframe.js";

export function bullFilter(c){

  const tf = multiTFScore(c);

  // HARD FAILS
  if (c.volume < 500000) return false;
  if (c.marketCap < 20_000_000) return false;

  // ================= ENTRY =================
  if (
    tf >= 4 &&
    c.change24 >= 6 &&
    c.change1h > 1 &&
    c.vm > 0.4
  ) return "ENTRY";

  // ================= ALMOST =================
  if (
    tf >= 3 &&
    c.change24 >= 4 &&
    c.vm > 0.3
  ) return "ALMOST";

  // ================= BUILDUP =================
  if (
    tf >= 1 &&
    c.change24 >= 2
  ) return "BUILDUP";

  // ================= RADAR =================
  if (tf >= 0) return "RADAR";

  return false;
}