import { kv } from "@vercel/kv";

export async function logTrade(trade) {
  const arr = await kv.get("performance") || [];
  arr.push(trade);
  await kv.set("performance", arr.slice(-5000));
}

export async function getPerformance() {
  return await kv.get("performance") || [];
}