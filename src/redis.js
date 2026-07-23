// ================= FILE: src/redis.js =================
// COMPLEET Redis client wrapper

import redis from 'redis';
import { CONFIG } from './config.js';

let redisClient = null;
let isConnected = false;

export async function initializeRedis() {
  try {
    if (isConnected) {
      return { ok: true, message: 'Already connected' };
    }

    const url = CONFIG.REDIS.URL;
    if (!url) {
      throw new Error('REDIS_URL not set in environment');
    }

    redisClient = redis.createClient({
      url,
      socket: {
        connectTimeout: CONFIG.REDIS.TIMEOUT_MS,
        reconnectStrategy: (retries) => {
          if (retries > CONFIG.REDIS.RETRY_ATTEMPTS) {
            console.error('❌ Redis max retries exceeded');
            return new Error('Redis max retries exceeded');
          }
          return Math.min(retries * CONFIG.REDIS.RETRY_DELAY_MS, 30000);
        }
      }
    });

    redisClient.on('connect', () => {
      console.log('✅ Redis connected');
      isConnected = true;
    });

    redisClient.on('error', (err) => {
      console.error('❌ Redis error:', err);
      isConnected = false;
    });

    redisClient.on('reconnecting', () => {
      console.log('🔄 Redis reconnecting...');
    });

    await redisClient.connect();
    isConnected = true;

    return { ok: true, message: 'Redis connected' };

  } catch (err) {
    console.error('❌ Redis initialization error:', err);
    isConnected = false;
    return { ok: false, error: err.message };
  }
}

export function getRedis() {
  if (!redisClient) {
    throw new Error('Redis not initialized. Call initializeRedis first.');
  }
  return createRedisProxy();
}

function createRedisProxy() {
  return {
    async get(key) {
      try {
        if (!key) throw new Error('Key is required');
        const value = await redisClient.get(key);
        if (!value) return null;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      } catch (err) {
        console.error('Redis GET error:', err);
        throw err;
      }
    },

    async set(key, value, expirationSeconds = null) {
      try {
        if (!key) throw new Error('Key is required');
        const jsonValue = typeof value === 'string' ? value : JSON.stringify(value);
        
        if (expirationSeconds) {
          await redisClient.setEx(key, expirationSeconds, jsonValue);
        } else {
          await redisClient.set(key, jsonValue);
        }
        
        return { ok: true };
      } catch (err) {
        console.error('Redis SET error:', err);
        throw err;
      }
    },

    async delete(key) {
      try {
        if (!key) throw new Error('Key is required');
        const result = await redisClient.del(key);
        return { ok: true, deleted: result > 0 };
      } catch (err) {
        console.error('Redis DEL error:', err);
        throw err;
      }
    },

    async exists(key) {
      try {
        if (!key) throw new Error('Key is required');
        const result = await redisClient.exists(key);
        return result === 1;
      } catch (err) {
        console.error('Redis EXISTS error:', err);
        throw err;
      }
    },

    async expire(key, seconds) {
      try {
        if (!key) throw new Error('Key is required');
        await redisClient.expire(key, seconds);
        return { ok: true };
      } catch (err) {
        console.error('Redis EXPIRE error:', err);
        throw err;
      }
    },

    async ttl(key) {
      try {
        if (!key) throw new Error('Key is required');
        const ttl = await redisClient.ttl(key);
        return ttl;
      } catch (err) {
        console.error('Redis TTL error:', err);
        throw err;
      }
    },

    async keys(pattern) {
      try {
        if (!pattern) throw new Error('Pattern is required');
        const keys = await redisClient.keys(pattern);
        return keys || [];
      } catch (err) {
        console.error('Redis KEYS error:', err);
        throw err;
      }
    },

    async increment(key, amount = 1) {
      try {
        if (!key) throw new Error('Key is required');
        const result = await redisClient.incrBy(key, amount);
        return result;
      } catch (err) {
        console.error('Redis INCR error:', err);
        throw err;
      }
    },

    async decrement(key, amount = 1) {
      try {
        if (!key) throw new Error('Key is required');
        const result = await redisClient.decrBy(key, amount);
        return result;
      } catch (err) {
        console.error('Redis DECR error:', err);
        throw err;
      }
    },

    async lpush(key, value) {
      try {
        if (!key) throw new Error('Key is required');
        const jsonValue = typeof value === 'string' ? value : JSON.stringify(value);
        await redisClient.lPush(key, jsonValue);
        return { ok: true };
      } catch (err) {
        console.error('Redis LPUSH error:', err);
        throw err;
      }
    },

    async lrange(key, start = 0, stop = -1) {
      try {
        if (!key) throw new Error('Key is required');
        const values = await redisClient.lRange(key, start, stop);
        return (values || []).map(v => {
          try {
            return JSON.parse(v);
          } catch {
            return v;
          }
        });
      } catch (err) {
        console.error('Redis LRANGE error:', err);
        throw err;
      }
    },

    async hset(key, field, value) {
      try {
        if (!key || !field) throw new Error('Key and field are required');
        const jsonValue = typeof value === 'string' ? value : JSON.stringify(value);
        await redisClient.hSet(key, field, jsonValue);
        return { ok: true };
      } catch (err) {
        console.error('Redis HSET error:', err);
        throw err;
      }
    },

    async hget(key, field) {
      try {
        if (!key || !field) throw new Error('Key and field are required');
        const value = await redisClient.hGet(key, field);
        if (!value) return null;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      } catch (err) {
        console.error('Redis HGET error:', err);
        throw err;
      }
    },

    async hgetall(key) {
      try {
        if (!key) throw new Error('Key is required');
        const obj = await redisClient.hGetAll(key);
        if (!obj || Object.keys(obj).length === 0) return null;
        const result = {};
        for (const [k, v] of Object.entries(obj)) {
          try {
            result[k] = JSON.parse(v);
          } catch {
            result[k] = v;
          }
        }
        return result;
      } catch (err) {
        console.error('Redis HGETALL error:', err);
        throw err;
      }
    },

    async zadd(key, score, member) {
      try {
        if (!key) throw new Error('Key is required');
        await redisClient.zAdd(key, { score, value: member });
        return { ok: true };
      } catch (err) {
        console.error('Redis ZADD error:', err);
        throw err;
      }
    },

    async zrange(key, start = 0, stop = -1, withScores = false) {
      try {
        if (!key) throw new Error('Key is required');
        const options = withScores ? { withScores: true } : {};
        const values = await redisClient.zRange(key, start, stop, options);
        return values || [];
      } catch (err) {
        console.error('Redis ZRANGE error:', err);
        throw err;
      }
    },

    async ping() {
      try {
        const result = await redisClient.ping();
        return { ok: true, pong: result };
      } catch (err) {
        console.error('Redis PING error:', err);
        return { ok: false, error: err.message };
      }
    },

    async flushdb() {
      try {
        await redisClient.flushDb();
        return { ok: true, message: 'Database flushed' };
      } catch (err) {
        console.error('Redis FLUSHDB error:', err);
        throw err;
      }
    },

    async raw() {
      return redisClient;
    }
  };
}

export async function checkRedisHealth() {
  try {
    if (!isConnected) {
      return {
        ok: false,
        status: 'DISCONNECTED',
        message: 'Redis not connected'
      };
    }

    const redis = getRedis();
    const pingResult = await redis.ping();

    if (!pingResult.ok) {
      return {
        ok: false,
        status: 'ERROR',
        message: pingResult.error
      };
    }

    return {
      ok: true,
      status: 'HEALTHY',
      message: 'Redis connection OK'
    };

  } catch (err) {
    return {
      ok: false,
      status: 'ERROR',
      message: err.message
    };
  }
}

export async function closeRedis() {
  try {
    if (redisClient) {
      await redisClient.quit();
      isConnected = false;
      return { ok: true, message: 'Redis connection closed' };
    }
    return { ok: true, message: 'Redis already closed' };
  } catch (err) {
    console.error('Error closing Redis:', err);
    return { ok: false, error: err.message };
  }
}

export default {
  initializeRedis,
  getRedis,
  checkRedisHealth,
  closeRedis
};
