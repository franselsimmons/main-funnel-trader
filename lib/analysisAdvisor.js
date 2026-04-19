import { getFilters } from "./filterState.js";

export function generateAdvice(analytics){

  const filters = getFilters();
  const advice = { bull:{}, bear:{} };

  const stages = ["radar","buildup","almost","entry"];

  for(const side of ["bull","bear"]){

    for(let i = 0; i < stages.length; i++){

      const stage = stages[i];
      const next = stages[i+1];

      if(!next){
        advice[side][stage] = [];
        continue;
      }

      const current = analytics[side]?.[stage]?.total || 0;
      const nextCount = analytics[side]?.[next]?.total || 0;

      const flow = current > 0 ? (nextCount/current)*100 : 0;

      const f = filters[side][next];
      const arr = [];

      if(flow < 10){
        arr.push(`➡️ ${next} soepeler (score ${f.scoreMin - 10})`);
      }

      if(flow > 30){
        arr.push(`➡️ ${next} strenger (score ${f.scoreMin + 5})`);
      }

      advice[side][stage] = arr;
    }
  }

  return advice;
}