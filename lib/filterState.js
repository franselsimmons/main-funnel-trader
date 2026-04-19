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
    radar:   { scoreMin: 0,  volumeMin: 0.08, tfMin: 0, allowNeutral: true },   // 🔥 strenger
    buildup: { scoreMin: 45, volumeMin: 0.12, tfMin: 0, allowNeutral: false },  // 🔥 strenger
    almost:  { scoreMin: 60, volumeMin: 0.18, tfMin: 1, allowNeutral: false },  // 🔥 strenger
    entry:   { scoreMin: 75, volumeMin: 0.25, tfMin: 2, allowNeutral: false }   // 🔥 strenger
  };

  filters.bear = {
    radar:   { scoreMin: 0,  volumeMin: 0.08, tfMin: 0, allowNeutral: true },
    buildup: { scoreMin: 45, volumeMin: 0.12, tfMin: 0, allowNeutral: false },
    almost:  { scoreMin: 60, volumeMin: 0.18, tfMin: 1, allowNeutral: false },
    entry:   { scoreMin: 75, volumeMin: 0.25, tfMin: 2, allowNeutral: false }
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