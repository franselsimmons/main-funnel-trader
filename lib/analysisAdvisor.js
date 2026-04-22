import { getFilters } from "./filterState.js";

const STAGES = ["radar", "buildup", "almost", "entry"];

function safeNumber(v, fallback = 0){

  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function getStageTotal(analytics, side, stage){

  return safeNumber(analytics?.[side]?.[stage]?.total || 0);
}


export function generateAdvice(analytics){

  const filters = getFilters();
  const advice = { bull:{}, bear:{} };

  for(const side of ["bull", "bear"]){

    for(let i = 0; i < STAGES.length; i++){

      const stage = STAGES[i];
      const next = STAGES[i + 1];

      const arr = [];

      if(!next){
        advice[side][stage] = arr;
        continue;
      }

      const current = getStageTotal(analytics, side, stage);
      const nextCount = getStageTotal(analytics, side, next);

      // Belangrijk:
      // analytics bevat nu alleen echte filter-coins.
      // UI fallback/radar-vulling telt niet meer mee.
      if(current < 5){
        advice[side][stage] = [
          "ℹ️ Te weinig echte filter-data voor betrouwbaar advies."
        ];
        continue;
      }

      const flow = current > 0
        ? (nextCount / current) * 100
        : 0;

      const f = filters?.[side]?.[next] || {};
      const scoreMin = safeNumber(f.scoreMin, 0);

      if(flow < 8){
        arr.push(`➡️ ${next} iets soepeler testen (score ${Math.max(0, scoreMin - 5)})`);
      }

      if(flow > 35){
        arr.push(`➡️ ${next} iets strenger testen (score ${scoreMin + 5})`);
      }

      if(arr.length === 0){
        arr.push("✅ Flow is gezond. Geen specifiek advies.");
      }

      advice[side][stage] = arr;
    }
  }

  return advice;
}