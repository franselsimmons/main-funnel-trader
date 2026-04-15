import { getPositions, closePosition } from "./position.js";
import { updateEquity } from "./portfolio.js";

export function updatePositions(){

  const positions = getPositions();

  for(const p of positions){

    if(p.status !== "OPEN") continue;

    const price = p.currentPrice;

    // TP hit
    if(price >= p.tp){
      const pnl = (p.tp - p.entry) * p.size;
      closePosition(p.id,pnl);
      updateEquity(pnl);
    }

    // SL hit
    if(price <= p.sl){
      const pnl = (p.sl - p.entry) * p.size;
      closePosition(p.id,pnl);
      updateEquity(pnl);
    }
  }
}