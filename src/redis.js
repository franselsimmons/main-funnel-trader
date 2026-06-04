// ================= FILE: src/redis.js =================

import { Redis } from '@upstash/redis';

function makeRedis(url, token, label) {
  if (!url || !token) {
    throw new Error(`${label}_REDIS_ENV_MISSING`);
  }
  return new Redis({ url, token });
}

let volatileRedis = null;
let durableRedis = null;

export function getVolatileRedis() {
  if (!volatileRedis) {
    const url = process.env.VOLATILE_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.VOLATILE_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    volatileRedis = makeRedis(url, token, 'VOLATILE');
  }
  return volatileRedis;
}

export function getDurableRedis() {
  if (!durableRedis) {
    const url = process.env.DURABLE_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.DURABLE_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    durableRedis = makeRedis(url, token, 'DURABLE');
  }
  return durableRedis;
}

export function hasRedisEnv() {
  return Boolean(
    (process.env.DURABLE_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.DURABLE_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
  );
}

export async function getJson(redis, key, fallback = null) {
  const value = await redis.get(key);
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

export async function setJson(redis, key, value, options = undefined) {
  return redis.set(key, JSON.stringify(value), options);
}

export async function setNxJson(redis, key, value, options = {}) {
  return redis.set(key, JSON.stringify(value), { ...options, nx: true });
}

export async function delPattern(redis, pattern, max = 5000) {
  let cursor = 0;
  let deleted = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
    cursor = Number(nextCursor);
    const batch = Array.isArray(keys) ? keys.slice(0, Math.max(0, max - deleted)) : [];
    if (batch.length) {
      await redis.del(...batch);
      deleted += batch.length;
    }
    if (deleted >= max) break;
  } while (cursor !== 0);

  return deleted;
}

export async function getKeys(redis, pattern, max = 1000) {
  let cursor = 0;
  const out = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
    cursor = Number(nextCursor);
    if (Array.isArray(keys)) out.push(...keys);
    if (out.length >= max) break;
  } while (cursor !== 0);

  return out.slice(0, max);
}

export async function pushJsonLog(redis, key, value, limit = 250) {
  await redis.lpush(key, JSON.stringify(value));
  await redis.ltrim(key, 0, Math.max(0, limit - 1));
}

export async function readJsonLogs(redis, key, limit = 100) {
  const rows = await redis.lrange(key, 0, Math.max(0, limit - 1));
  return (Array.isArray(rows) ? rows : []).map(row => {
    if (typeof row !== 'string') return row;
    try { return JSON.parse(row); } catch { return { raw: row }; }
  });
}
