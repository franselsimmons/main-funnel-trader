import { multiTFScore } from "./timeframe.js";
import { getFilters } from "./filterState.js";

export function bullFilter(c){

  const tf = multiTFScore(c);
  const filters = getFilters().bull;

  // ===== ENTRY =====
  const fEntry = filters.entry;
  if(
    tf >= fEntry.tfMin &&
    c.vm >= fEntry.volumeMin &&
    c.moveScore >= fEntry.scoreMin &&
    (fEntry.allowNeutral || c.flow !== "NEUTRAL")
  ){
    return "entry";
  }

  // ===== ALMOST =====
  const fAlmost = filters.almost;
  if(
    tf >= fAlmost.tfMin &&
    c.vm >= fAlmost.volumeMin &&
    c.moveScore >= fAlmost.scoreMin &&
    (fAlmost.allowNeutral || c.flow !== "NEUTRAL")
  ){
    return "almost";
  }

  // ===== BUILDUP =====
  const fBuild = filters.buildup;
  if(
    tf >= fBuild.tfMin &&
    c.vm >= fBuild.volumeMin &&
    c.moveScore >= fBuild.scoreMin
  ){
    return "buildup";
  }

  // ===== RADAR =====
  const fRadar = filters.radar;
  if(
    c.vm >= fRadar.volumeMin
  ){
    return "radar";
  }

  return false;
}