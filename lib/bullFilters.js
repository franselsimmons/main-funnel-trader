import { getFilters } from "./filterState.js";
import { multiTFScore } from "./timeframe.js";

export function bullFilter(c){

  const f = getFilters().bull;
  const tf = multiTFScore(c);

  if(
    tf >= f.entry.tfMin &&
    c.moveScore >= f.entry.scoreMin &&
    c.vm >= f.entry.volumeMin &&
    (f.entry.allowNeutral || c.flow !== "NEUTRAL")
  ) return "ENTRY";

  if(
    tf >= f.almost.tfMin &&
    c.moveScore >= f.almost.scoreMin &&
    c.vm >= f.almost.volumeMin
  ) return "ALMOST";

  if(
    tf >= f.buildup.tfMin &&
    c.moveScore >= f.buildup.scoreMin &&
    c.vm >= f.buildup.volumeMin
  ) return "BUILDUP";

  return "RADAR";
}