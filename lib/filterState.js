let filters = {
  bull: {
    radar: { scoreMin: 35, volumeMin: 0.15, allowNeutral: true },
    buildup: { scoreMin: 40, volumeMin: 0.2, allowNeutral: true },
    almost: { scoreMin: 45, volumeMin: 0.25, allowNeutral: true },
    entry: { scoreMin: 50, volumeMin: 0.25, allowNeutral: false }
  },
  bear: {
    radar: { scoreMin: 30, volumeMin: 0.15, allowNeutral: true },
    buildup: { scoreMin: 35, volumeMin: 0.2, allowNeutral: true },
    almost: { scoreMin: 40, volumeMin: 0.25, allowNeutral: true },
    entry: { scoreMin: 45, volumeMin: 0.25, allowNeutral: false }
  },
  trade: {
    rrMin: 1.2, // 🔥 lager → meer trades
    scoreMin: 50,
    requireTrend: false, // 🔥 belangrijk
    blockSpoof: true
  }
};

export function getFilters(){
  return filters;
}

export function setFilters(newFilters){

  for(const side of ["bull","bear"]){

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

      filters[side][stage].scoreMin = Number(f.scoreMin);
      filters[side][stage].volumeMin = Number(f.volumeMin);
      filters[side][stage].allowNeutral =
        f.allowNeutral === true || f.allowNeutral === "true";
    }
  }

  if(newFilters.trade){
    filters.trade = {
      rrMin: Number(newFilters.trade.rrMin || 1.2),
      scoreMin: Number(newFilters.trade.scoreMin || 50),
      requireTrend: newFilters.trade.requireTrend === true || newFilters.trade.requireTrend === "true",
      blockSpoof: newFilters.trade.blockSpoof === true || newFilters.trade.blockSpoof === "true"
    };
  }

  return filters;
}