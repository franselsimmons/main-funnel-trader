import { kv } from "@vercel/kv";

export async function loadState(mode) {
  return (await kv.get(`main:v6:state:${mode}`)) || {};
}

export async function saveState(mode, state) {
  await kv.set(`main:v6:state:${mode}`, state, { ex: 60 * 60 * 24 * 3 });
}

export function updateCoinState(prev = {}, nextStage, now) {
  const prevStage = prev.stage || "UNIVERSE";
  const cycles =
    prevStage === nextStage
      ? (prev.cycles || 0) + 1
      : 1;

  return {
    ...prev,
    stage: nextStage,
    cycles,
    lastUpdate: now,
  };
}