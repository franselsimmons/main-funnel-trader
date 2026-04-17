let filters = {
  bull: {},
  bear: {},
  trade: {}
};

export function getFilters(){
  return filters;
}

export function setFilters(newFilters){

  for(const side of ["bull","bear"]){

    if(!filters[side]) filters[side] = {};

    for(const stage of ["radar","buildup","almost","entry"]){

      if(!filters[side][stage]){
        filters[side][stage] = {
          scoreMin: 40,
          volumeMin: 0.2,
          allowNeutral: true
        };
      }

      const f = newFilters?.[side]?.[stage];
      if(!f) continue;

      if(f.scoreMin !== undefined){
        filters[side][stage].scoreMin = Number(f.scoreMin);
      }

      if(f.volumeMin !== undefined){
        filters[side][stage].volumeMin = Number(f.volumeMin);
      }

      if(f.allowNeutral !== undefined){
        filters[side][stage].allowNeutral =
          f.allowNeutral === true || f.allowNeutral === "true";
      }
    }
  }

  // TRADE FILTERS
  if(newFilters.trade){
    filters.trade = {
      rrMin: Number(newFilters.trade.rrMin || 1.5),
      scoreMin: Number(newFilters.trade.scoreMin || 60),
      requireTrend: newFilters.trade.requireTrend === true || newFilters.trade.requireTrend === "true",
      blockSpoof: newFilters.trade.blockSpoof === true || newFilters.trade.blockSpoof === "true"
    };
  }

  return filters;
}