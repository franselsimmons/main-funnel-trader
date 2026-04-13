import { kv } from "@vercel/kv";

const KEY = "system:config";

export async function getConfig() {
  const c = await kv.get(KEY);
  return c || {
    thresholds: {
      confMin: 30,
      spreadMax: 1.2,
      depthMin: 50000
    }
  };
}

export async function setConfig(cfg) {
  await kv.set(KEY, cfg, { ex: 60 * 60 * 24 });
}