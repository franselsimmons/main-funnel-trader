import {
  openPosition,
  addPosition,
  closePosition,
  getPosition,
  getAllPositions
} from "./position.js";

export function handleEntry(c){
  if(getPosition(c.symbol)) return;

  openPosition(c.symbol, c.price);
}

export function handleAdd(c){
  addPosition(c.symbol, c.price);
}

export function handleExit(c){
  closePosition(c.symbol);
}

export function getPositions(){
  return getAllPositions();
}