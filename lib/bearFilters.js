import { multiTFScore } from "./timeframe.js";
import { getFilters } from "./filterState.js";

export function bearFilter(c){

  const tf = multiTFScore(c);
  const f = getFilters().bear;

  // 🔥 ENTRY = alleen trend
  if(
    tf <= -f.entry.tfMin &&
    c.vm >= f.entry.volumeMin &&
    c.moveScore >= f.entry.scoreMin &&
    c.flow === "TREND"
  ) return "entry";

  // 🔥 ALMOST = geen neutral
  if(
    tf <= -f.almost.tfMin &&
    c.vm >= f.almost.volumeMin &&
    c.moveScore >= f.almost.scoreMin &&
    c.flow !== "NEUTRAL"
  ) return "almost";

  // 🔥 BUILDUP = geen neutral (grote fix)
  if(
    tf <= -f.buildup.tfMin &&
    c.vm >= f.buildup.volumeMin &&
    c.moveScore >= f.buildup.scoreMin &&
    c.flow !== "NEUTRAL"
  ) return "buildup";

  // 🔥 RADAR = minimale kwaliteit
  if(
    c.vm >= f.radar.volumeMin &&
    c.moveScore >= 30
  ) return "radar";

  return false;
}