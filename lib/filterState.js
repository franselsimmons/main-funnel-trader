let filters = {
  bull: {
    radar:   { scoreMin: 40, volumeMin: 0.25, allowNeutral: true },
    buildup: { scoreMin: 50, volumeMin: 0.3,  allowNeutral: true },
    almost:  { scoreMin: 60, volumeMin: 0.35, allowNeutral: false },
    entry:   { scoreMin: 70, volumeMin: 0.4,  allowNeutral: false }
  },
  bear: {
    radar:   { scoreMin: 35, volumeMin: 0.2,  allowNeutral: true },
    buildup: { scoreMin: 45, volumeMin: 0.25, allowNeutral: true },
    almost:  { scoreMin: 55, volumeMin: 0.3,  allowNeutral: false },
    entry:   { scoreMin: 65, volumeMin: 0.35, allowNeutral: false }
  },
  trade: {
    rrMin: 1.5,
    scoreMin: 60,
    requireTrend: true,
    blockSpoof: true
  }
};

export function getFilters(){
  return filters;
}

export function setFilters(newFilters){

  for(const side of ["bull","bear"]){

    if(!newFilters[side]) continue;

    for(const stage of ["radar","buildup","almost","entry"]){

      if(!newFilters[side][stage]) continue;

      const f = newFilters[side][stage];

      if(f.scoreMin !== undefined)
        filters[side][stage].scoreMin = Number(f.scoreMin);

      if(f.volumeMin !== undefined)
        filters[side][stage].volumeMin = Number(f.volumeMin);

      if(f.allowNeutral !== undefined)
        filters[side][stage].allowNeutral =
          f.allowNeutral === true || f.allowNeutral === "true";
    }
  }

  // ===== TRADE =====
  if(newFilters.trade){
    const t = newFilters.trade;

    if(t.rrMin !== undefined)
      filters.trade.rrMin = Number(t.rrMin);

    if(t.scoreMin !== undefined)
      filters.trade.scoreMin = Number(t.scoreMin);

    if(t.requireTrend !== undefined)
      filters.trade.requireTrend = t.requireTrend === true || t.requireTrend === "true";

    if(t.blockSpoof !== undefined)
      filters.trade.blockSpoof = t.blockSpoof === true || t.blockSpoof === "true";
  }

  return filters;
}