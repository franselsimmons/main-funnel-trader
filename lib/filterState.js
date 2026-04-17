let filters = {
  bull: {
    scoreMin: 55,
    volumeMin: 0.4,
    allowNeutral: false
  },
  bear: {
    scoreMin: 45,
    volumeMin: 0.3,
    allowNeutral: true
  }
};

export function getFilters(){
  return filters;
}

export function setFilters(newFilters){

  for(const side of ["bull","bear"]){

    if(!newFilters[side]) continue;

    const f = newFilters[side];

    if(f.scoreMin !== undefined){
      filters[side].scoreMin = Number(f.scoreMin);
    }

    if(f.volumeMin !== undefined){
      filters[side].volumeMin = Number(f.volumeMin);
    }

    if(f.allowNeutral !== undefined){
      filters[side].allowNeutral =
        f.allowNeutral === true || f.allowNeutral === "true";
    }
  }

  return filters;
}