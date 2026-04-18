import { getFilters } from "./filterState.js";
import { multiTFScore } from "./timeframe.js";

export function bullFilter(c){

  const f = getFilters().bull;
  const tf = multiTFScore(c);

  // ENTRY
  if(
    tf >= 3 &&
    c.moveScore >= f.entry.scoreMin &&
    c.vm >= f.entry.volumeMin &&
    (f.entry.allowNeutral || c.flow !== "NEUTRAL")
  ) return "ENTRY";

  // ALMOST
  if(
    tf >= 2 &&
    c.moveScore >= f.almost.scoreMin &&
    c.vm >= f.almost.volumeMin
  ) return "ALMOST";

  // BUILDUP
  if(
    tf >= 1 &&
    c.moveScore >= f.buildup.scoreMin &&
    c.vm >= f.buildup.volumeMin
  ) return "BUILDUP";

  // RADAR (altijd licht)
  if(c.vm > 0.05) return "RADAR";

  return false;
}