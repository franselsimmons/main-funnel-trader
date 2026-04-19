let filters = {
  bull: {},
  bear: {},
  trade: {
    rrMin: 1.3,
    scoreMin: 55,
    requireTrend: true,
    blockSpoof: true
  }
};

const stages = ["radar","buildup","almost","entry"];

const defaults = {
  scoreMin: 50,
  volumeMin: 0.1,
  allowNeutral: false,
  tfMin: 1
};


// ================= INIT DEFAULTS =================
export function initDefaultFilters(){

  filters.bull = {
    radar:   { scoreMin: 0,  volumeMin: 0.05, tfMin: 0, allowNeutral: true },
    buildup: { scoreMin: 40, volumeMin: 0.1,  tfMin: 0, allowNeutral: true },
    almost:  { scoreMin: 55, volumeMin: 0.15, tfMin: 1, allowNeutral: false },
    entry:   { scoreMin: 70, volumeMin: 0.2,  tfMin: 2, allowNeutral: false }
  };

  filters.bear = {
    radar:   { scoreMin: 0,  volumeMin: 0.05, tfMin: 0, allowNeutral: true },
    buildup: { scoreMin: 40, volumeMin: 0.1,  tfMin: 0, allowNeutral: true },
    almost:  { scoreMin: 55, volumeMin: 0.15, tfMin: 1, allowNeutral: false },
    entry:   { scoreMin: 70, volumeMin: 0.2,  tfMin: 2, allowNeutral: false }
  };

  return filters;
}


// ================= GET =================
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


// ================= SET =================
export function setFilters(newFilters){

  for(const side of ["bull","bear"]){

    for(const stage of stages){

      const f = newFilters?.[side]?.[stage];
      if(!f) continue;

      if(!filters[side][stage]){
        filters[side][stage] = {...defaults};
      }

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

      if(f.tfMin !== undefined){
        filters[side][stage].tfMin = Number(f.tfMin);
      }
    }
  }

  // trade filters
  if(newFilters.trade){
    filters.trade = {
      rrMin: Number(newFilters.trade.rrMin || 1.3),
      scoreMin: Number(newFilters.trade.scoreMin || 55),
      requireTrend: newFilters.trade.requireTrend === true,
      blockSpoof: newFilters.trade.blockSpoof === true
    };
  }

  return filters;
}