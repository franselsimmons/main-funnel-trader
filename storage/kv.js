import { kv } from "@vercel/kv"

export async function setKey(key, value) {
  await kv.set(key, value)
}

export async function getKey(key) {
  return await kv.get(key)
}

export async function deleteKey(key) {
  await kv.del(key)
}