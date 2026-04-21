// ================= LIQUIDITY WRAPPER =================

import { getLiquidationZones } from "./liquidationEngine.js";

export async function getLiquidity(symbol, price){
  return await getLiquidationZones(symbol, price);
}