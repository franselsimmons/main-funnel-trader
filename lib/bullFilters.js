import { multiTFScore } from "./timeframe.js";
import { getFilters } from "./filterState.js";

export function bullFilter(c){

  const tf = multiTFScore(c);
  const f = getFilters().bull;

  // 🔥 ENTRY = alleen echte trend setups
  if(
    tf >= f.entry.tfMin &&
    c.vm >= f.entry.volumeMin &&
    c.moveScore >= f.entry.scoreMin &&
    c.flow === "TREND"
  ) return "entry";

  // 🔥 ALMOST = geen neutral flow meer
  if(
    tf >= f.almost.tfMin &&
    c.vm >= f.almost.volumeMin &&
    c.moveScore >= f.almost.scoreMin &&
    c.flow !== "NEUTRAL"
  ) return "almost";

  // 🔥 BUILDUP = ook geen neutral meer (grote fix)
  if(
    tf >= f.buildup.tfMin &&
    c.vm >= f.buildup.volumeMin &&
    c.moveScore >= f.buildup.scoreMin &&
    c.flow !== "NEUTRAL"
  ) return "buildup";

  // 🔥 RADAR = minimale kwaliteit (voorkomt garbage)
  if(
    c.vm >= f.radar.volumeMin &&
    c.moveScore >= 30
  ) return "radar";

  return false;
}