import { multiTFScore } from "./timeframe.js";
import { getFilters } from "./filterState.js";

function flowAllowed(flow, allowNeutral = false, requireTrend = false){

  if(requireTrend){
    return flow === "TREND";
  }

  if(allowNeutral){
    return true;
  }

  return flow !== "NEUTRAL";
}

export function bearFilter(c){

  const tf = multiTFScore(c);
  const f = getFilters().bear;

  if(
    tf <= -Number(f.entry.tfMin || 0) &&
    Number(c.vm || 0) >= Number(f.entry.volumeMin || 0) &&
    Number(c.moveScore || 0) >= Number(f.entry.scoreMin || 0) &&
    flowAllowed(c.flow, f.entry.allowNeutral, true)
  ){
    return "entry";
  }

  if(
    tf <= -Number(f.almost.tfMin || 0) &&
    Number(c.vm || 0) >= Number(f.almost.volumeMin || 0) &&
    Number(c.moveScore || 0) >= Number(f.almost.scoreMin || 0) &&
    flowAllowed(c.flow, f.almost.allowNeutral, false)
  ){
    return "almost";
  }

  if(
    tf <= -Number(f.buildup.tfMin || 0) &&
    Number(c.vm || 0) >= Number(f.buildup.volumeMin || 0) &&
    Number(c.moveScore || 0) >= Number(f.buildup.scoreMin || 0) &&
    flowAllowed(c.flow, f.buildup.allowNeutral, false)
  ){
    return "buildup";
  }

  if(
    Number(c.vm || 0) >= Number(f.radar.volumeMin || 0) &&
    Number(c.moveScore || 0) >= Number(f.radar.scoreMin || 0) &&
    flowAllowed(c.flow, f.radar.allowNeutral, false)
  ){
    return "radar";
  }

  return false;
}