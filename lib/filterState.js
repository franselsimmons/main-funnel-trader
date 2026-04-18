let filters = {
  bull: {},
  bear: {},
  trade: {
    rrMin: 1.5,
    scoreMin: 60,
    requireTrend: true,
    blockSpoof: true
  }
};

const defaults = {
  scoreMin: 50,
  volumeMin: 0.25,
  allowNeutral: true
};

const stages = ["radar","buildup","almost","entry"];

export function getFilters(){

  for(const side of ["bull","bear"]){

    if(!filters[side]) filters[side] = {};

    for(const stage of stages){

      if(!filters[side][stage]){
        filters[side][stage] = {...defaults};
      }
    }
  }

  return filters;
}

export function setFilters(newFilters){

  for(const side of ["bull","bear"]){

    for(const stage of stages){

      const f = newFilters?.[side]?.[stage];
      if(!f) continue;

      if(!filters[side][stage]){
        filters[side][stage] = {...defaults};
      }

      if(f.scoreMin !== undefined){
        filters[side][stage].scoreMin =
          Math.max(10, Math.min(100, Number(f.scoreMin)));
      }

      if(f.volumeMin !== undefined){
        filters[side][stage].volumeMin =
          Math.max(0.01, Math.min(1, Number(f.volumeMin)));
      }

      if(f.allowNeutral !== undefined){
        filters[side][stage].allowNeutral =
          f.allowNeutral === true || f.allowNeutral === "true";
      }
    }
  }

  if(newFilters.trade){
    filters.trade = {
      rrMin: Number(newFilters.trade.rrMin || 1.5),
      scoreMin: Number(newFilters.trade.scoreMin || 60),
      requireTrend:
        newFilters.trade.requireTrend === true ||
        newFilters.trade.requireTrend === "true",
      blockSpoof:
        newFilters.trade.blockSpoof === true ||
        newFilters.trade.blockSpoof === "true"
    };
  }

  return filters;
}