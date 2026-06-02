const DEFAULT_STRATEGY_VERSION = 'TS_V12_8_WEEKLY_MICRO_ROTATION_CLEAN';

const REDIS_URL_KEYS = [
  'KV_REST_API_URL',
  'UPSTASH_REDIS_REST_URL',
  'REDIS_REST_API_URL',
];

const REDIS_TOKEN_KEYS = [
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
  'REDIS_REST_API_TOKEN',
];

const POSITION_CONTAINER_KEYS = new Set([
  'openpositions',
  'activepositions',
  'runtimeopenpositions',
  'virtualopenpositions',
  'paperopenpositions',
]);

function getEnvValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }

  return null;
}

function send(res, status, payload) {
  res.status(status).json(payload);
}

function isEnabled() {
  const value = String(process.env.TS_ADMIN_FLUSH_ENABLED || '').toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function getExpectedSecret() {
  return (
    process.env.TS_ADMIN_SECRET ||
    process.env.ADMIN_SECRET ||
    process.env.FLUSH_ADMIN_SECRET ||
    ''
  ).trim();
}

function getProvidedSecret(req, body) {
  return String(
    req.headers['x-admin-secret'] ||
    req.headers['x-ts-admin-secret'] ||
    body?.secret ||
    body?.adminSecret ||
    req.query?.secret ||
    ''
  ).trim();
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return await new Promise((resolve) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
    });

    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });

    req.on('error', () => resolve({}));
  });
}

function safeParseJson(value) {
  if (typeof value !== 'string') return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function countContainer(value) {
  if (Array.isArray(value)) return value.length;

  if (value && typeof value === 'object') {
    return Object.keys(value).length;
  }

  return 0;
}

function emptyLike(value) {
  if (Array.isArray(value)) return [];

  if (value && typeof value === 'object') return {};

  return [];
}

function mutateOpenPositionContainers(node, path = []) {
  const changes = [];

  if (!node || typeof node !== 'object') return changes;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      changes.push(...mutateOpenPositionContainers(node[i], path.concat(String(i))));
    }

    return changes;
  }

  for (const [key, value] of Object.entries(node)) {
    const normalizedKey = key.toLowerCase();

    if (POSITION_CONTAINER_KEYS.has(normalizedKey)) {
      const before = countContainer(value);

      node[key] = emptyLike(value);

      changes.push({
        path: path.concat(key).join('.'),
        key,
        before,
        after: 0,
      });

      continue;
    }

    if (value && typeof value === 'object') {
      changes.push(...mutateOpenPositionContainers(value, path.concat(key)));
    }
  }

  return changes;
}

async function redisCommand(redis, args) {
  const response = await fetch(redis.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${redis.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`REDIS_NON_JSON_RESPONSE:${response.status}:${text.slice(0, 200)}`);
  }

  if (!response.ok || data?.error) {
    throw new Error(`REDIS_ERROR:${response.status}:${data?.error || text.slice(0, 200)}`);
  }

  return data.result;
}

async function scanPattern(redis, pattern, maxKeys = 5000) {
  const found = [];
  let cursor = '0';

  do {
    const result = await redisCommand(redis, [
      'SCAN',
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      '250',
    ]);

    if (!Array.isArray(result) || result.length < 2) break;

    cursor = String(result[0] || '0');

    const keys = Array.isArray(result[1]) ? result[1] : [];
    for (const key of keys) {
      found.push(String(key));
      if (found.length >= maxKeys) return found;
    }
  } while (cursor !== '0');

  return found;
}

async function discoverCandidateKeys(redis, strategyVersion) {
  const patterns = [
    `${strategyVersion}*`,
    `*${strategyVersion}*`,
    `tradeSystem:*`,
    `tradesystem:*`,
    `trade-system:*`,
    `*runtime*`,
    `*durable*`,
    `*open*position*`,
  ];

  const keys = new Set();

  for (const pattern of patterns) {
    const scanned = await scanPattern(redis, pattern);

    for (const key of scanned) {
      keys.add(key);
    }
  }

  return [...keys];
}

async function getRedisString(redis, key) {
  try {
    const type = await redisCommand(redis, ['TYPE', key]);

    if (type && type !== 'string') {
      return {
        ok: false,
        skipped: true,
        reason: `NON_STRING_TYPE:${type}`,
        value: null,
      };
    }

    const value = await redisCommand(redis, ['GET', key]);

    if (typeof value !== 'string') {
      return {
        ok: false,
        skipped: true,
        reason: 'EMPTY_OR_NON_STRING_VALUE',
        value: null,
      };
    }

    return {
      ok: true,
      skipped: false,
      reason: null,
      value,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      reason: String(error?.message || error),
      value: null,
    };
  }
}

async function inspectAndMaybeFlushKey(redis, key, dryRun) {
  const loaded = await getRedisString(redis, key);

  if (!loaded.ok) {
    return {
      key,
      touched: false,
      skipped: true,
      reason: loaded.reason,
      openBefore: 0,
      openAfter: 0,
      changes: [],
    };
  }

  const parsed = safeParseJson(loaded.value);

  if (!parsed || typeof parsed !== 'object') {
    return {
      key,
      touched: false,
      skipped: true,
      reason: 'NOT_JSON_OBJECT',
      openBefore: 0,
      openAfter: 0,
      changes: [],
    };
  }

  const changes = mutateOpenPositionContainers(parsed);
  const openBefore = changes.reduce((sum, change) => sum + change.before, 0);

  if (!changes.length || openBefore <= 0) {
    return {
      key,
      touched: false,
      skipped: false,
      reason: 'NO_OPEN_POSITION_CONTAINER_WITH_ROWS',
      openBefore: 0,
      openAfter: 0,
      changes,
    };
  }

  if (!dryRun) {
    await redisCommand(redis, ['SET', key, JSON.stringify(parsed)]);
  }

  return {
    key,
    touched: true,
    skipped: false,
    reason: dryRun ? 'DRY_RUN_MATCHED' : 'FLUSHED',
    openBefore,
    openAfter: 0,
    changes,
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    if (req.method !== 'POST') {
      send(res, 405, {
        ok: false,
        error: 'METHOD_NOT_ALLOWED',
        expected: 'POST',
      });
      return;
    }

    if (!isEnabled()) {
      send(res, 403, {
        ok: false,
        error: 'ADMIN_FLUSH_DISABLED',
        requiredEnv: 'TS_ADMIN_FLUSH_ENABLED=true',
      });
      return;
    }

    const body = await readBody(req);

    const expectedSecret = getExpectedSecret();
    const providedSecret = getProvidedSecret(req, body);

    if (!expectedSecret) {
      send(res, 500, {
        ok: false,
        error: 'ADMIN_SECRET_ENV_MISSING',
        acceptedEnvNames: [
          'TS_ADMIN_SECRET',
          'ADMIN_SECRET',
          'FLUSH_ADMIN_SECRET',
        ],
      });
      return;
    }

    if (!providedSecret || providedSecret !== expectedSecret) {
      send(res, 401, {
        ok: false,
        error: 'UNAUTHORIZED',
      });
      return;
    }

    const redisUrl = getEnvValue(REDIS_URL_KEYS);
    const redisToken = getEnvValue(REDIS_TOKEN_KEYS);

    if (!redisUrl || !redisToken) {
      send(res, 500, {
        ok: false,
        error: 'REDIS_ENV_MISSING',
        requiredOneOfUrl: REDIS_URL_KEYS,
        requiredOneOfToken: REDIS_TOKEN_KEYS,
      });
      return;
    }

    const redis = {
      url: redisUrl.replace(/\/+$/, ''),
      token: redisToken,
    };

    const dryRun = body?.dryRun !== false;
    const strategyVersion = String(
      body?.strategyVersion ||
      process.env.STRATEGY_VERSION ||
      process.env.TRADE_SYSTEM_STRATEGY_VERSION ||
      DEFAULT_STRATEGY_VERSION
    ).trim();

    const keys = await discoverCandidateKeys(redis, strategyVersion);

    const inspected = [];
    for (const key of keys) {
      const result = await inspectAndMaybeFlushKey(redis, key, dryRun);
      inspected.push(result);
    }

    const touched = inspected.filter((item) => item.touched);
    const openBefore = touched.reduce((sum, item) => sum + item.openBefore, 0);
    const openAfter = touched.reduce((sum, item) => sum + item.openAfter, 0);

    send(res, 200, {
      ok: true,
      dryRun,
      strategyVersion,
      keysScanned: keys.length,
      touchedKeys: touched.length,
      openBefore,
      openAfter,
      durationMs: Date.now() - startedAt,
      touched: touched.map((item) => ({
        key: item.key,
        openBefore: item.openBefore,
        openAfter: item.openAfter,
        reason: item.reason,
        changes: item.changes,
      })),
      skippedSample: inspected
        .filter((item) => !item.touched)
        .slice(0, 20)
        .map((item) => ({
          key: item.key,
          reason: item.reason,
        })),
    });
  } catch (error) {
    send(res, 500, {
      ok: false,
      error: String(error?.message || error),
      stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
    });
  }
}