let filters = null;

const stages = ["radar", "buildup", "almost", "entry"];

const DEFAULT_FILTERS = Object.freeze({
  bull: {
    radar:   { scoreMin: 18, volumeMin: 0.03, tfMin: 0, allowNeutral: true },
    buildup: { scoreMin: 36, volumeMin: 0.05, tfMin: 0, allowNeutral: true },
    almost:  { scoreMin: 52, volumeMin: 0.08, tfMin: 1, allowNeutral: false },
    entry:   { scoreMin: 64, volumeMin: 0.10, tfMin: 2, allowNeutral: false }
  },
  bear: {
    radar:   { scoreMin: 18, volumeMin: 0.03, tfMin: 0, allowNeutral: true },
    buildup: { scoreMin: 36, volumeMin: 0.05, tfMin: 0, allowNeutral: true },
    almost:  { scoreMin: 52, volumeMin: 0.08, tfMin: 1, allowNeutral: false },
    entry:   { scoreMin: 64, volumeMin: 0.10, tfMin: 2, allowNeutral: false }
  },
  trade: {
    rrMin: 1.0,
    scoreMin: 52,
    requireTrend: true,
    blockSpoof: true
  }
});


function clone(value){
  return JSON.parse(JSON.stringify(value));
}


function toNumber(value, fallback){

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function toBool(value, fallback = false){

  if(value === true || value === false){
    return value;
  }

  if(value === undefined || value === null){
    return fallback;
  }

  const s = String(value).toLowerCase();

  if(["true", "1", "yes", "on"].includes(s)) return true;
  if(["false", "0", "no", "off"].includes(s)) return false;

  return fallback;
}


function normalizeStage(stageConfig = {}, fallback = {}){

  return {
    scoreMin: toNumber(stageConfig.scoreMin, fallback.scoreMin ?? 0),
    volumeMin: toNumber(stageConfig.volumeMin, fallback.volumeMin ?? 0),
    tfMin: toNumber(stageConfig.tfMin, fallback.tfMin ?? 0),
    allowNeutral: toBool(stageConfig.allowNeutral, fallback.allowNeutral ?? false)
  };
}


// ================= INIT DEFAULTS =================
export function initDefaultFilters(force = false){

  if(!filters || force){
    filters = clone(DEFAULT_FILTERS);
  }

  return filters;
}


// ================= GET =================
export function getFilters(){

  if(!filters){
    initDefaultFilters();
  }

  return filters;
}


// ================= SET =================
export function setFilters(newFilters = {}){

  const current = getFilters();

  for(const side of ["bull", "bear"]){

    for(const stage of stages){

      const incoming = newFilters?.[side]?.[stage];
      if(!incoming) continue;

      current[side][stage] = normalizeStage(
        {
          ...current[side][stage],
          ...incoming
        },
        DEFAULT_FILTERS[side][stage]
      );
    }
  }

  if(newFilters.trade){
    current.trade = {
      rrMin: toNumber(newFilters.trade.rrMin, current.trade.rrMin),
      scoreMin: toNumber(newFilters.trade.scoreMin, current.trade.scoreMin),
      requireTrend: toBool(newFilters.trade.requireTrend, current.trade.requireTrend),
      blockSpoof: toBool(newFilters.trade.blockSpoof, current.trade.blockSpoof)
    };
  }

  return current;
}