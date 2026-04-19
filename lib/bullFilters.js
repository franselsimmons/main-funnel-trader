import { multiTFScore } from "./timeframe.js";
import { getFilters } from "./filterState.js";

export function bullFilter(c){

  const tf = multiTFScore(c);
  const f = getFilters().bull;

  if(
    tf >= f.entry.tfMin &&
    c.vm >= f.entry.volumeMin &&
    c.moveScore >= f.entry.scoreMin &&
    (f.entry.allowNeutral || c.flow !== "NEUTRAL")
  ) return "entry";

  if(
    tf >= f.almost.tfMin &&
    c.vm >= f.almost.volumeMin &&
    c.moveScore >= f.almost.scoreMin &&
    (f.almost.allowNeutral || c.flow !== "NEUTRAL")
  ) return "almost";

  if(
    tf >= f.buildup.tfMin &&
    c.vm >= f.buildup.volumeMin &&
    c.moveScore >= f.buildup.scoreMin
  ) return "buildup";

  if(c.vm >= f.radar.volumeMin) return "radar";

  return false;
}