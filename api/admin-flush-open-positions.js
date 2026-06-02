const DEFAULT_STRATEGY_VERSION = 'TS_V12_8_WEEKLY_MICRO_ROTATION_CLEAN';
const DEFAULT_ANALYZE_KEY = 'tradesystem:analyze:store:v3:events';

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

function send(res, status, payload) {
  res.status(status).json(payload);
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

function normalize(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isHistoryOrLearningKey(key) {
  const lower = String(key || '').toLowerCase();

  return (
    lower.includes(':closed_trades:') ||
    lower.includes(':shadow_outcomes:') ||
    lower.includes(':feature_store:') ||
    lower.includes(':recent_entries') ||
    lower.includes(':learning') ||
    lower.includes(':rotation') ||
    lower.includes(':micro')
  );
}

function isDedicatedOpenKey(key) {
  const lower = normalize(key);

  return (
    lower.includes('openposition') ||
    lower.includes('openpositions') ||
    lower.includes('activeposition') ||
    lower.includes('activepositions') ||
    lower.includes('runningposition') ||
    lower.includes('holdingposition') ||
    lower.includes('portfolioopen') ||
    lower.endsWith('memory')
  );
}

function isPositionLike(row) {
  if (!isObject(row)) return false;

  const hasSymbol = typeof row.symbol === 'string' && row.symbol.length > 0;
  const hasSide = typeof row.side === 'string' && row.side.length > 0;
  const hasEntry =
    Number.isFinite(Number(row.entry)) ||
    Number.isFinite(Number(row.entryPrice)) ||
    Number.isFinite(Number(row.openPrice));

  if (!hasSymbol || !hasSide || !hasEntry) return false;

  const action = String(row.action || '').toUpperCase();
  const reason = String(row.reason || '').toUpperCase();
  const stage = String(row.scannerStage || row.stage || '').toLowerCase();

  if (action === 'HOLD') return true;
  if (reason === 'RUNNING') return true;
  if (reason === 'HOLD_RUNNING') return true;
  if (stage === 'open_position') return true;
  if (row.closed === false) return true;
  if (!row.closedAt && !row.exit && !row.exitPrice && !row.realizedR) return true;

  return false;
}

function isExitLike(row) {
  if (!isObject(row)) return false;

  const action = String(row.action || row.analyzeLifecycle || '').toUpperCase();

  return (
    action === 'EXIT' ||
    row.closed === true ||
    Boolean(row.closedAt) ||
    Number.isFinite(Number(row.exit)) ||
    Number.isFinite(Number(row.exitPrice))
  );
}

function isEntryLike(row) {
  if (!isObject(row)) return false;

  const action = String(row.action || row.analyzeLifecycle || '').toUpperCase();

  return (
    action === 'ENTRY' ||
    action === 'OPEN' ||
    action === 'HOLD' ||
    isPositionLike(row)
  );
}

function getTradeKey(row) {
  if (!isObject(row)) return null;

  if (row.tradeId) return `id:${row.tradeId}`;

  const symbol = String(row.symbol || '').toUpperCase();
  const side = String(row.side || '').toUpperCase();

  if (!symbol || !side) return null;

  return `sym:${symbol}:${side}`;
}

function shouldResetArrayByName(path, key) {
  const p = normalize(`${path}.${key}`);

  return (
    p.includes('openpositions') ||
    p.includes('activepositions') ||
    p.includes('runningpositions') ||
    p.includes('holdingpositions') ||
    p.includes('portfolio.positions') ||
    p.includes('runtime.positions') ||
    p.includes('state.positions') ||
    p.includes('paper.positions') ||
    p.includes('sim.positions')
  );
}

function shouldResetObjectByName(path, key) {
  const p = normalize(`${path}.${key}`);

  return (
    p.includes('openpositions') ||
    p.includes('activepositions') ||
    p.includes('runningpositions') ||
    p.includes('holdingpositions') ||
    p.includes('openpositionmap') ||
    p.includes('positionmap') ||
    p.endsWith('positions')
  );
}

function resetOpenStateDeep(node, path = '') {
  const changes = [];

  if (!node || typeof node !== 'object') return changes;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      changes.push(...resetOpenStateDeep(node[i], `${path}.${i}`));
    }

    return changes;
  }

  for (const [key, value] of Object.entries(node)) {
    const fullPath = path ? `${path}.${key}` : key;
    const normalizedKey = normalize(key);

    if (
      normalizedKey === 'opencount' ||
      normalizedKey === 'openpositioncount' ||
      normalizedKey === 'openpositionscount' ||
      normalizedKey === 'activeopenpositions' ||
      normalizedKey === 'totalopenpositions' ||
      normalizedKey === 'runningpositionscount' ||
      normalizedKey === 'holdingpositionscount'
    ) {
      node[key] = 0;
      changes.push({
        path: fullPath,
        action: 'ZERO_COUNTER',
      });
      continue;
    }

    if (Array.isArray(value)) {
      const positionLikeCount = value.filter(isPositionLike).length;
      const shouldReset =
        shouldResetArrayByName(path, key) ||
        (value.length > 0 && positionLikeCount > 0 && positionLikeCount / value.length >= 0.5);

      if (shouldReset) {
        node[key] = [];
        changes.push({
          path: fullPath,
          action: 'RESET_ARRAY',
          beforeLength: value.length,
          positionLikeCount,
        });
        continue;
      }

      for (let i = 0; i < value.length; i += 1) {
        changes.push(...resetOpenStateDeep(value[i], `${fullPath}.${i}`));
      }

      continue;
    }

    if (isObject(value)) {
      const values = Object.values(value);
      const positionLikeCount = values.filter(isPositionLike).length;

      const shouldReset =
        shouldResetObjectByName(path, key) ||
        (values.length > 0 && positionLikeCount > 0 && positionLikeCount / values.length >= 0.5);

      if (shouldReset) {
        node[key] = {};
        changes.push({
          path: fullPath,
          action: 'RESET_OBJECT',
          beforeKeys: values.length,
          positionLikeCount,
        });
        continue;
      }

      changes.push(...resetOpenStateDeep(value, fullPath));
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

async function discoverRuntimeKeys(redis, strategyVersion) {
  const keys = new Set([
    `${strategyVersion}:runtime`,
    `${strategyVersion}:runtime:core`,
    `${strategyVersion}:runtime:memory`,
    `${strategyVersion}:runtime:openPositions`,
    `${strategyVersion}:runtime:open_positions`,
    `${strategyVersion}:runtime:activePositions`,
    `${strategyVersion}:runtime:active_positions`,
    `${strategyVersion}:runtime:positions`,
    `${strategyVersion}:runtime:portfolio`,
  ]);

  const patterns = [
    `${strategyVersion}:runtime:*`,
    `*${strategyVersion}*runtime*`,
    `*${strategyVersion}*position*`,
    `*${strategyVersion}*open*`,
    `*${strategyVersion}*portfolio*`,
    `*${strategyVersion}*memory*`,
    `*${strategyVersion}*core*`,
  ];

  for (const pattern of patterns) {
    const found = await scanKeys(redis, pattern);
    for (const key of found) keys.add(key);
  }

  return [...keys];
}

async function resetRuntimeJsonKey(redis, key, dryRun) {
  if (isHistoryOrLearningKey(key)) {
    return {
      key,
      touched: false,
      reason: 'SKIPPED_HISTORY_OR_LEARNING_KEY',
      changes: [],
    };
  }

  const type = await redisCommand(redis, ['TYPE', key]);

  if (type === 'none') {
    return {
      key,
      touched: false,
      reason: 'KEY_NOT_FOUND',
      changes: [],
    };
  }

  if (isDedicatedOpenKey(key)) {
    if (!dryRun) await redisCommand(redis, ['DEL', key]);

    return {
      key,
      touched: true,
      reason: dryRun ? 'DRY_RUN_DELETE_DEDICATED_OPEN_KEY' : 'DELETED_DEDICATED_OPEN_KEY',
      changes: [{ path: key, action: 'DEL' }],
    };
  }

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

  const changes = resetOpenStateDeep(parsed);

  if (changes.length === 0) {
    return {
      key,
      touched: false,
      reason: 'NO_OPEN_RUNTIME_STATE_FOUND',
      changes: [],
    };
  }

  if (!dryRun) {
    await redisCommand(redis, ['SET', key, JSON.stringify(parsed)]);
  }

  return {
    key,
    touched: true,
    reason: dryRun ? 'DRY_RUN_RUNTIME_RESET_MATCH' : 'RUNTIME_RESET_DONE',
    changes,
  };
}

async function resetAnalyzeStoreOpenEntries(redis, analyzeKey, dryRun) {
  const type = await redisCommand(redis, ['TYPE', analyzeKey]);

  if (type === 'none') {
    return {
      key: analyzeKey,
      touched: false,
      reason: 'ANALYZE_KEY_NOT_FOUND',
      before: 0,
      after: 0,
      removed: 0,
    };
  }

  if (type !== 'list') {
    return {
      key: analyzeKey,
      touched: false,
      reason: `ANALYZE_KEY_NOT_LIST:${type}`,
      before: 0,
      after: 0,
      removed: 0,
    };
  }

  const rawItems = await redisCommand(redis, ['LRANGE', analyzeKey, '0', '-1']);
  const items = Array.isArray(rawItems) ? rawItems : [];

  const parsedRows = items.map((raw, index) => ({
    index,
    raw,
    parsed: tryJsonParse(raw),
  }));

  const closedKeys = new Set();

  for (const item of parsedRows) {
    const row = item.parsed;
    if (!row || !isExitLike(row)) continue;

    const key = getTradeKey(row);
    if (key) closedKeys.add(key);
  }

  const keep = [];
  const removed = [];

  for (const item of parsedRows) {
    const row = item.parsed;

    if (!row || !isEntryLike(row)) {
      keep.push(item.raw);
      continue;
    }

    const key = getTradeKey(row);

    if (!key) {
      keep.push(item.raw);
      continue;
    }

    if (closedKeys.has(key) || isExitLike(row)) {
      keep.push(item.raw);
      continue;
    }

    removed.push({
      index: item.index,
      key,
      symbol: row.symbol || null,
      side: row.side || null,
      action: row.action || row.analyzeLifecycle || null,
      reason: row.reason || null,
    });
  }

  if (removed.length === 0) {
    return {
      key: analyzeKey,
      touched: false,
      reason: 'NO_OPEN_ANALYZE_ENTRIES_FOUND',
      before: items.length,
      after: keep.length,
      removed: 0,
    };
  }

  if (!dryRun) {
    await redisCommand(redis, ['DEL', analyzeKey]);

    if (keep.length > 0) {
      const chunkSize = 250;

      for (let i = 0; i < keep.length; i += chunkSize) {
        const chunk = keep.slice(i, i + chunkSize);
        await redisCommand(redis, ['RPUSH', analyzeKey, ...chunk]);
      }
    }
  }

  return {
    key: analyzeKey,
    touched: true,
    reason: dryRun ? 'DRY_RUN_ANALYZE_OPEN_ENTRIES_REMOVED' : 'ANALYZE_OPEN_ENTRIES_REMOVED',
    before: items.length,
    after: keep.length,
    removed: removed.length,
    removedSample: removed.slice(0, 50),
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

    const analyzeKey = String(body?.analyzeKey || DEFAULT_ANALYZE_KEY).trim();

    const runtimeKeys = await discoverRuntimeKeys(redis, strategyVersion);

    const runtimeResults = [];

    for (const key of runtimeKeys) {
      const result = await resetRuntimeJsonKey(redis, key, dryRun);
      runtimeResults.push(result);
    }

    const analyzeResult = await resetAnalyzeStoreOpenEntries(redis, analyzeKey, dryRun);

    const touchedRuntime = runtimeResults.filter((item) => item.touched);

    send(res, 200, {
      ok: true,
      dryRun,
      strategyVersion,
      analyzeKey,
      runtimeKeysScanned: runtimeKeys.length,
      runtimeTouchedKeys: touchedRuntime.length,
      analyzeTouched: analyzeResult.touched,
      durationMs: Date.now() - startedAt,
      runtimeTouched: touchedRuntime.map((item) => ({
        key: item.key,
        reason: item.reason,
        changes: item.changes.slice(0, 100),
      })),
      analyzeResult,
      skippedSample: runtimeResults
        .filter((item) => !item.touched)
        .slice(0, 40)
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