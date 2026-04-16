let currentFilters = {
  scoreMin: 50,
  volumeMin: 0.35,
  allowNeutral: true
};

export function getFilters(){
  return currentFilters;
}

export function setFilters(newFilters){
  currentFilters = {...currentFilters, ...newFilters};
}