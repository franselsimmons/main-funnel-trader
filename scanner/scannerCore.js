import { fetchUniverse } from "./universeFetcher";
import { computeRegime } from "../core/regimeEngine";

export async function scanUniverse(mode) {
  const universe = await fetchUniverse();
  const regime = computeRegime(universe.btc);

  return {
    btc: universe.btc,
    coins: universe.coins,
    regime,
  };
}