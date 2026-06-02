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

const NUKE_FIELD_NAMES = new Set([
  'openpositions',
  'openposition',
  'activepositions',
  'activeposition',
  'runtimeopenpositions',
  'virtualopenpositions',
  'paperopenpositions',
  'currentpositions',
  'runningpositions',
  'holdingpositions',
  'holds',
  'holding',
]);

const ZERO_COUNTER_NAMES = new Set([
  'memory',
  'openpositions',
  'opencount',
  'openpositioncount',
  'openpositionscount',
  'activeopenpositions',
  'totalopenpositions',
  'runningpositions',
  'holdingpositions',
]);

function send(res, status, payload) {
  res.status(status).json(payload);
}

function normalizeKey(key) {
  return String(key || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function getEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }

  return null;
}

function isEnabled() {
  const value = String(process.env.TS_ADMIN_FLUSH_ENABLED || '').toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function getExpectedSecret() {
  return String(
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
    throw new Error(`REDIS_NON_JSON_RESPONSE:${response.status}:${text.slice(0, 300)}`);
  }

  if (!response.ok || data?.error) {
    throw new Error(`REDIS_ERROR:${response.status}:${data?.error || text.slice(0, 300)}`);
  }

  return data.result;
}

function tryJsonParse(value) {
  if (typeof value !== 'string') return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function replacementFor(value, key) {
  const normalized = normalizeKey(key);

  if (ZERO_COUNTER_NAMES.has(normalized)) return 0;
  if (Array.isArray(value)) return [];
  if (isObject(value)) return {};
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;

  return null;
}

function hardResetOpenState(node, path = []) {
  const changes = [];

  if (!node || typeof node !== 'object') return changes;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      changes.push(...hardResetOpenState(node[i], path.concat(String(i))));
    }

    return changes;
  }

  for (const [key, value] of Object.entries(node)) {
    const normalized = normalizeKey(key);
    const currentPath = path.concat(key).join('.');

    const shouldNuke =
      NUKE_FIELD_NAMES.has(normalized) ||
      ZERO_COUNTER_NAMES.has(normalized);

    if (shouldNuke) {
      const nextValue = replacementFor(value, key);

      node[key] = nextValue;

      changes.push({
        path: currentPath,
        key,
        beforeType: Array.isArray(value) ? 'array' : typeof value,
        beforeSize: Array.isArray(value)
          ? value.length
          : isObject(value)
            ? Object.keys(value).length
            : value,
        after: nextValue,
      });

      continue;
    }

    if (value && typeof value === 'object') {
      changes.push(...hardResetOpenState(value, path.concat(key)));
    }
  }

  return changes;
}

async function scanKeys(redis, pattern) {
  const keys = [];
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

    cursor = String(result?.[0] || '0');

    const batch = Array.isArray(result?.[1]) ? result[1] : [];
    for (const key of batch) keys.push(String(key));
  } while (cursor !== '0');

  return keys;
}

async function discoverKeys(redis, strategyVersion) {
  const keys = new Set([
    `${strategyVersion}:runtime:core`,
    `${strategyVersion}:runtime`,
    `${strategyVersion}:runtime:memory`,
    `${strategyVersion}:runtime:openPositions`,
    `${strategyVersion}:runtime:open_positions`,
    `${strategyVersion}:runtime:activePositions`,
    `${strategyVersion}:runtime:active_positions`,
  ]);

  const patterns = [
    `${strategyVersion}:runtime:*`,
    `*${strategyVersion}*open*`,
    `*${strategyVersion}*position*`,
    `*${strategyVersion}*memory*`,
    `*${strategyVersion}*core*`,
  ];

  for (const pattern of patterns) {
    const found = await scanKeys(redis, pattern);
    for (const key of found) keys.add(key);
  }

  return [...keys];
}

function shouldSkipWholeKey(key) {
  const lower = String(key || '').toLowerCase();

  if (lower.includes(':closed_trades:')) return true;
  if (lower.includes(':shadow_outcomes:')) return true;
  if (lower.includes(':feature_store:')) return true;
  if (lower.includes(':recent_entries')) return true;
  if (lower.includes(':micro')) return true;
  if (lower.includes(':learning')) return true;
  if (lower.includes(':rotation')) return true;

  return false;
}

async function resetStringJsonKey(redis, key, dryRun) {
  if (shouldSkipWholeKey(key)) {
    return {
      key,
      touched: false,
      reason: 'SKIPPED_HISTORY_OR_LEARNING_KEY',
      changes: [],
    };
  }

  const type = await redisCommand(redis, ['TYPE', key]);

  if (type !== 'string') {
    return {
      key,
      touched: false,
      reason: `SKIPPED_NON_STRING:${type}`,
      changes: [],
    };
  }

  const raw = await redisCommand(redis, ['GET', key]);

  if (typeof raw !== 'string') {
    return {
      key,
      touched: false,
      reason: 'EMPTY',
      changes: [],
    };
  }

  const parsed = tryJsonParse(raw);

  if (!parsed || typeof parsed !== 'object') {
    return {
      key,
      touched: false,
      reason: 'NOT_JSON',
      changes: [],
    };
  }

  const changes = hardResetOpenState(parsed);

  if (changes.length === 0) {
    return {
      key,
      touched: false,
      reason: 'NO_OPEN_FIELDS_FOUND',
      changes: [],
    };
  }

  if (!dryRun) {
    await redisCommand(redis, ['SET', key, JSON.stringify(parsed)]);
  }

  return {
    key,
    touched: true,
    reason: dryRun ? 'DRY_RUN_RESET_MATCH' : 'RESET_DONE',
    changes,
  };
}

async function deleteDedicatedOpenKeys(redis, key, dryRun) {
  const normalized = normalizeKey(key);

  const isDedicatedOpenKey =
    normalized.includes('openpositions') ||
    normalized.includes('openposition') ||
    normalized.includes('activepositions') ||
    normalized.includes('activeposition') ||
    normalized.endsWith('memory');

  if (!isDedicatedOpenKey) {
    return {
      key,
      touched: false,
      reason: 'NOT_DEDICATED_OPEN_KEY',
      changes: [],
    };
  }

  if (shouldSkipWholeKey(key)) {
    return {
      key,
      touched: false,
      reason: 'SKIPPED_HISTORY_OR_LEARNING_KEY',
      changes: [],
    };
  }

  if (!dryRun) {
    await redisCommand(redis, ['DEL', key]);
  }

  return {
    key,
    touched: true,
    reason: dryRun ? 'DRY_RUN_DELETE_DEDICATED_KEY' : 'DELETED_DEDICATED_KEY',
    changes: [
      {
        path: key,
        action: 'DEL',
      },
    ],
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
      });
      return;
    }

    if (providedSecret !== expectedSecret) {
      send(res, 401, {
        ok: false,
        error: 'UNAUTHORIZED',
      });
      return;
    }

    const redisUrl = getEnv(REDIS_URL_KEYS);
    const redisToken = getEnv(REDIS_TOKEN_KEYS);

    if (!redisUrl || !redisToken) {
      send(res, 500, {
        ok: false,
        error: 'REDIS_ENV_MISSING',
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

    const keys = await discoverKeys(redis, strategyVersion);

    const results = [];

    for (const key of keys) {
      const jsonResult = await resetStringJsonKey(redis, key, dryRun);
      results.push(jsonResult);

      if (!jsonResult.touched) {
        const deleteResult = await deleteDedicatedOpenKeys(redis, key, dryRun);
        if (deleteResult.touched) results.push(deleteResult);
      }
    }

    const touched = results.filter((item) => item.touched);

    send(res, 200, {
      ok: true,
      dryRun,
      strategyVersion,
      keysScanned: keys.length,
      touchedKeys: touched.length,
      durationMs: Date.now() - startedAt,
      touched: touched.map((item) => ({
        key: item.key,
        reason: item.reason,
        changes: item.changes.slice(0, 100),
      })),
      skippedSample: results
        .filter((item) => !item.touched)
        .slice(0, 30)
        .map((item) => ({
          key: item.key,
          reason: item.reason,
        })),
    });
  } catch (error) {
    send(res, 500, {
      ok: false,
      error: String(error?.message || error),
    });
  }
}