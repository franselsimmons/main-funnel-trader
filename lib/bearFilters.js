import { getFilters } from "./filterState.js";
import { multiTFScore } from "./timeframe.js";

export function bearFilter(c){

  const f = getFilters().bear;
  const tf = multiTFScore(c);

  if(
    tf <= -3 &&
    c.moveScore >= f.entry.scoreMin &&
    c.vm >= f.entry.volumeMin &&
    (f.entry.allowNeutral || c.flow !== "NEUTRAL")
  ) return "ENTRY";

  if(
    tf <= -2 &&
    c.moveScore >= f.almost.scoreMin &&
    c.vm >= f.almost.volumeMin
  ) return "ALMOST";

  if(
    tf <= -1 &&
    c.moveScore >= f.buildup.scoreMin &&
    c.vm >= f.buildup.volumeMin
  ) return "BUILDUP";

  if(c.vm > 0.05) return "RADAR";

  return false;
}