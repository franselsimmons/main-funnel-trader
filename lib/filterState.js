let filters = null;

const stages = ["radar", "buildup", "almost", "entry"];

const DEFAULT_FILTERS = Object.freeze({
  bull: {
    radar:   { scoreMin: 10, volumeMin: 0.020, tfMin: 0, allowNeutral: true },   // scoreMin 14→10, volumeMin 0.025→0.020
    buildup: { scoreMin: 26, volumeMin: 0.035, tfMin: 0, allowNeutral: true },   // scoreMin 30→26, volumeMin 0.040→0.035
    almost:  { scoreMin: 42, volumeMin: 0.055, tfMin: 0.8, allowNeutral: true }, // scoreMin 46→42, volumeMin 0.060→0.055, tfMin 1→0.8, allowNeutral false→true
    entry:   { scoreMin: 54, volumeMin: 0.070, tfMin: 1.5, allowNeutral: false } // scoreMin 58→54, volumeMin 0.080→0.070, tfMin 2→1.5
  },
  bear: {
    radar:   { scoreMin: 10, volumeMin: 0.020, tfMin: 0, allowNeutral: true },
    buildup: { scoreMin: 26, volumeMin: 0.035, tfMin: 0, allowNeutral: true },
    almost:  { scoreMin: 42, volumeMin: 0.055, tfMin: 0.8, allowNeutral: true },
    entry:   { scoreMin: 54, volumeMin: 0.070, tfMin: 1.5, allowNeutral: false }
  },
  trade: {
    rrMin: 0.95,
    scoreMin: 48,
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