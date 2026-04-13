import { kv } from "@vercel/kv";

export async function trackFlow(mode, state) {
  const key = `flow:${mode}`;
  const prev = await kv.get(key) || { history: [] };

  const counts = { radar:0,warmup:0,setup:0,entry:0 };

  for (const s in state) {
    const st = state[s].stage;
    if (st === "RADAR") counts.radar++;
    if (st === "WARMUP") counts.warmup++;
    if (st === "SETUP") counts.setup++;
    if (st === "ENTRY_READY") counts.entry++;
  }

  prev.history.push({ ts: Date.now(), counts });

  await kv.set(key, { history: prev.history.slice(-500) });
}