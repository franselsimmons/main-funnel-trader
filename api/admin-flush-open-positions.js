// api/admin-flush-open-positions.js

const DEFAULT_STRATEGY_VERSION = 'TS_V12_8_WEEKLY_MICRO_ROTATION_CLEAN';

const CONFIRM_TEXT = 'RESET_OPEN_POSITIONS';

const getEnv = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
};

const STRATEGY_VERSION =
  getEnv('TRADE_SYSTEM_STRATEGY_VERSION', 'STRATEGY_VERSION') ||
  DEFAULT_STRATEGY_VERSION;

const ADMIN_SECRET = getEnv('ADMIN_FLUSH_SECRET', 'FLUSH_SECRET');

const REDIS_URL = getEnv(
  'UPSTASH_REDIS_REST_URL',
  'KV_REST_API_URL',
  'REDIS_REST_URL'
);

const REDIS_TOKEN = getEnv(
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_TOKEN',
  'REDIS_REST_TOKEN'
);

const ANALYZE_KEY =
  getEnv('TRADE_ANALYZE_EVENTS_KEY', 'ANALYZE_EVENTS_KEY') ||
  'tradesystem:analyze:store:v3:events';

const LATEST_SCAN_KEY =
  getEnv('TRADE_LATEST_SCAN_KEY', 'LATEST_SCAN_KEY') ||
  'tradeSystem:latestScan:v1';

const now = () => Date.now();

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
};

const getQuery = (req) => {
  if (req.query && Object.keys(req.query).length) return req.query;

  const host = req.headers?.host || 'localhost';
  const url = new URL(req.url || '/', `https://${host}`);
  return Object.fromEntries(url.searchParams.entries());
};

const json = (res, status, body) => {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.end(JSON.stringify(body, null, 2));
};

const assertRedis = () => {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('REDIS_ENV_MISSING');
  }
};

const redis = async (command, ...args) => {
  assertRedis();

  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${REDIS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`REDIS_HTTP_${response.status}: ${JSON.stringify(payload)}`);
  }

  if (payload?.error) {
    throw new Error(`REDIS_${command}_ERROR: ${payload.error}`);
  }

  return payload?.result;
};

const parseMaybeJson = (raw) => {
  if (raw === null || raw === undefined) {
    return { ok: false, value: null, reason: 'EMPTY' };
  }

  let value = raw;

  for (let i = 0; i < 3; i += 1) {
    if (typeof value !== 'string') {
      return { ok: true, value, reason: null };
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return { ok: false, value: null, reason: 'EMPTY_STRING' };
    }

    if (
      !trimmed.startsWith('{') &&
      !trimmed.startsWith('[') &&
      !trimmed.startsWith('"')
    ) {
      return { ok: false, value: raw, reason: 'NOT_JSON_STRING' };
    }

    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      return { ok: false, value: raw, reason: `JSON_PARSE_FAILED: ${error.message}` };
    }
  }

  return { ok: true, value, reason: null };
};

const normalizeName = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isTradeLike = (value) => {
  if (!isObject(value)) return false;

  const hasSymbol = typeof value.symbol === 'string' && value.symbol.length > 0;
  const hasSide = typeof value.side === 'string' && value.side.length > 0;
  const hasTradeId = typeof value.tradeId === 'string' && value.tradeId.length > 0;
  const hasPrice =
    value.entry !== undefined ||
    value.entryPrice !== undefined ||
    value.exit !== undefined ||
    value.exitPrice !== undefined;

  return (hasSymbol && hasSide) || (hasTradeId && (hasPrice || hasSymbol));
};

const countTradeContainer = (value) => {
  if (Array.isArray(value)) {
    return value.filter((row) => isTradeLike(row) || isObject(row)).length;
  }

  if (isObject(value)) {
    const values = Object.values(value);

    if (Array.isArray(value.rows)) return countTradeContainer(value.rows);
    if (Array.isArray(value.items)) return countTradeContainer(value.items);
    if (Array.isArray(value.data)) return countTradeContainer(value.data);

    return values.filter((row) => isTradeLike(row) || isObject(row)).length;
  }

  if (typeof value === 'number') return value;

  return 0;
};

const shouldClearOpenContainer = (key, value) => {
  const name = normalizeName(key);

  const exactOpenNames = new Set([
    'open',
    'opened',
    'openpositions',
    'openposition',
    'openpositionmap',
    'openpositionsmap',
    'openpositionbysymbol',
    'activepositions',
    'activepositionmap',
    'runningpositions',
    'runningpositionmap',
    'livepositions',
    'opentrades',
    'opentradesmap',
    'activetrades',
    'runningtrades',
    'livetrades',
    'holds',
    'holdpositions',
  ]);

  if (exactOpenNames.has(name)) return true;

  const hasOpenWord =
    name.includes('open') ||
    name.includes('active') ||
    name.includes('running') ||
    name.includes('live') ||
    name.includes('hold');

  const hasPositionWord =
    name.includes('position') ||
    name.includes('trade');

  if (hasOpenWord && hasPositionWord) return true;

  if (name === 'positions') {
    return countTradeContainer(value) > 0;
  }

  return false;
};

const emptyLike = (value) => {
  if (Array.isArray(value)) return [];
  if (typeof value === 'number') return 0;
  if (isObject(value)) return {};
  return null;
};

const countOpenContainers = (node, path = '') => {
  if (!isObject(node) && !Array.isArray(node)) return 0;

  let count = 0;
  const entries = Array.isArray(node)
    ? node.map((value, index) => [String(index), value])
    : Object.entries(node);

  for (const [key, value] of entries) {
    const currentPath = path ? `${path}.${key}` : key;

    if (shouldClearOpenContainer(key, value)) {
      count += countTradeContainer(value);
      continue;
    }

    if (isObject(value) || Array.isArray(value)) {
      count += countOpenContainers(value, currentPath);
    }
  }

  return count;
};

const clearOpenContainers = (node, path = '') => {
  if (!isObject(node) && !Array.isArray(node)) {
    return { changed: false, changes: [] };
  }

  let changed = false;
  const changes = [];

  const entries = Array.isArray(node)
    ? node.map((value, index) => [String(index), value])
    : Object.entries(node);

  for (const [key, value] of entries) {
    const currentPath = path ? `${path}.${key}` : key;

    if (shouldClearOpenContainer(key, value)) {
      const before = countTradeContainer(value);
      const emptyValue = emptyLike(value);

      if (emptyValue !== null && before > 0) {
        node[key] = emptyValue;
        changed = true;
        changes.push({ path: currentPath, before, after: 0 });
      }

      continue;
    }

    if (isObject(value) || Array.isArray(value)) {
      const child = clearOpenContainers(value, currentPath);
      if (child.changed) {
        changed = true;
        changes.push(...child.changes);
      }
    }
  }

  return { changed, changes };
};

const resetKnownCounters = (node, path = '') => {
  if (!isObject(node) && !Array.isArray(node)) {
    return { changed: false, changes: [] };
  }

  let changed = false;
  const changes = [];

  const counterNames = new Set([
    'openpositionscount',
    'openpositioncount',
    'opentradescount',
    'activetradescount',
    'activepositionscount',
    'runningtradescount',
    'runningpositionscount',
    'livepositionscount',
    'livetradescount',
  ]);

  for (const [key, value] of Object.entries(node)) {
    const currentPath = path ? `${path}.${key}` : key;
    const name = normalizeName(key);

    if (typeof value === 'number' && counterNames.has(name) && value !== 0) {
      node[key] = 0;
      changed = true;
      changes.push({ path: currentPath, before: value, after: 0 });
      continue;
    }

    if (isObject(value) || Array.isArray(value)) {
      const child = resetKnownCounters(value, currentPath);
      if (child.changed) {
        changed = true;
        changes.push(...child.changes);
      }
    }
  }

  return { changed, changes };
};

const scanKeys = async (pattern, maxKeys = 250) => {
  const keys = [];
  let cursor = '0';

  do {
    const result = await redis('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = String(result?.[0] ?? '0');

    const batch = Array.isArray(result?.[1]) ? result[1] : [];
    keys.push(...batch);

    if (keys.length >= maxKeys) break;
  } while (cursor !== '0');

  return [...new Set(keys)].slice(0, maxKeys);
};

const resetRuntimeCore = async ({ dryRun }) => {
  const coreKey = `${STRATEGY_VERSION}:runtime:core`;

  const runtimeKeys = await scanKeys(`${STRATEGY_VERSION}:runtime:*`, 300);
  const keys = [...new Set([coreKey, ...runtimeKeys])];

  let openBefore = 0;
  let openAfter = 0;
  const touched = [];
  const skipped = [];

  for (const key of keys) {
    const type = await redis('TYPE', key).catch(() => 'unknown');

    if (type !== 'string') {
      skipped.push({ key, type, reason: 'NOT_STRING' });
      continue;
    }

    const raw = await redis('GET', key);
    const parsed = parseMaybeJson(raw);

    if (!parsed.ok) {
      skipped.push({ key, type, reason: parsed.reason });
      continue;
    }

    const data = parsed.value;
    const before = countOpenContainers(data);
    openBefore += before;

    const cleared = clearOpenContainers(data);
    const counters = resetKnownCounters(data);
    const after = countOpenContainers(data);
    openAfter += after;

    const changed = cleared.changed || counters.changed;

    if (!changed) {
      skipped.push({ key, type, reason: 'NO_OPEN_CONTAINER_MATCH', before, after });
      continue;
    }

    touched.push({
      key,
      type,
      before,
      after,
      changes: [...cleared.changes, ...counters.changes].slice(0, 50),
    });

    if (!dryRun) {
      await redis('SET', key, JSON.stringify(data));
    }
  }

  return {
    ok: true,
    strategyVersion: STRATEGY_VERSION,
    dryRun,
    keysScanned: keys.length,
    touchedKeys: touched.length,
    openBefore,
    openAfter,
    touched,
    skippedSample: skipped.slice(0, 20),
  };
};

const normalizeSide = (side) => {
  const s = String(side || '').toUpperCase();
  if (s === 'LONG' || s === 'BULL') return 'LONG';
  if (s === 'SHORT' || s === 'BEAR') return 'SHORT';
  return s || 'NA';
};

const eventAction = (event) =>
  String(event?.analyzeLifecycle || event?.action || '').toUpperCase();

const eventId = (event) => {
  if (event?.tradeId) return String(event.tradeId);

  const symbol = String(event?.symbol || 'NA');
  const side = normalizeSide(event?.side);
  const setup = String(event?.setupClass || 'NA');
  const entry = String(event?.entryPrice ?? event?.entry ?? 'NA');

  return `${symbol}:${side}:${setup}:${entry}`;
};

const readAnalyzeEvents = async () => {
  const type = await redis('TYPE', ANALYZE_KEY).catch(() => 'none');

  if (type === 'none') {
    return { type, events: [] };
  }

  if (type === 'list') {
    const rows = await redis('LRANGE', ANALYZE_KEY, 0, -1);
    const events = [];

    for (const row of rows || []) {
      const parsed = parseMaybeJson(row);
      if (parsed.ok && isObject(parsed.value)) events.push(parsed.value);
    }

    return { type, events };
  }

  if (type === 'string') {
    const raw = await redis('GET', ANALYZE_KEY);
    const parsed = parseMaybeJson(raw);

    if (!parsed.ok) {
      return { type, events: [] };
    }

    if (Array.isArray(parsed.value)) {
      return { type, events: parsed.value.filter(isObject) };
    }

    if (Array.isArray(parsed.value?.events)) {
      return { type, events: parsed.value.events.filter(isObject), wrapper: parsed.value };
    }

    return { type, events: [] };
  }

  return { type, events: [] };
};

const forceCloseAnalyze = async ({ dryRun }) => {
  const { type, events, wrapper } = await readAnalyzeEvents();

  const openMap = new Map();

  for (const event of events) {
    const action = eventAction(event);
    const id = eventId(event);

    if (action === 'ENTRY') {
      openMap.set(id, event);
      continue;
    }

    if (action === 'EXIT') {
      openMap.delete(id);
    }
  }

  const timestamp = now();

  const exits = [...openMap.values()].map((entry) => {
    const exitPrice =
      Number(entry.exitPrice) ||
      Number(entry.exit) ||
      Number(entry.entryPrice) ||
      Number(entry.entry) ||
      null;

    return {
      ...entry,
      action: 'EXIT',
      analyzeLifecycle: 'EXIT',
      reason: 'ADMIN_FORCE_CLOSE',
      closed: true,
      closedAt: timestamp,
      exit: exitPrice,
      exitPrice,
      realizedR: 0,
      pnlR: 0,
      exitR: 0,
      pnlPct: 0,
      ts: timestamp,
      adminForceClose: true,
      forcedBy: 'admin-flush-open-positions',
    };
  });

  if (!dryRun && exits.length > 0) {
    if (type === 'list') {
      const chunkSize = 100;

      for (let i = 0; i < exits.length; i += chunkSize) {
        const chunk = exits.slice(i, i + chunkSize).map((event) => JSON.stringify(event));
        await redis('RPUSH', ANALYZE_KEY, ...chunk);
      }
    }

    if (type === 'string') {
      if (wrapper && Array.isArray(wrapper.events)) {
        wrapper.events.push(...exits);
        await redis('SET', ANALYZE_KEY, JSON.stringify(wrapper));
      } else if (Array.isArray(events)) {
        await redis('SET', ANALYZE_KEY, JSON.stringify([...events, ...exits]));
      }
    }
  }

  return {
    ok: true,
    key: ANALYZE_KEY,
    type,
    dryRun,
    totalEvents: events.length,
    openBefore: openMap.size,
    forceExits: exits.length,
    openAfter: dryRun ? openMap.size : 0,
    sample: exits.slice(0, 20).map((event) => ({
      tradeId: event.tradeId || null,
      symbol: event.symbol || null,
      side: event.side || null,
      action: event.action,
      reason: event.reason,
    })),
  };
};

const clearLatestScan = async ({ dryRun }) => {
  const type = await redis('TYPE', LATEST_SCAN_KEY).catch(() => 'none');

  if (type === 'none') {
    return { ok: true, key: LATEST_SCAN_KEY, dryRun, changed: false, reason: 'MISSING' };
  }

  if (type !== 'string') {
    return { ok: false, key: LATEST_SCAN_KEY, dryRun, changed: false, reason: `TYPE_${type}` };
  }

  const raw = await redis('GET', LATEST_SCAN_KEY);
  const parsed = parseMaybeJson(raw);

  if (!parsed.ok) {
    return { ok: false, key: LATEST_SCAN_KEY, dryRun, changed: false, reason: parsed.reason };
  }

  const data = parsed.value;
  const cleared = [];

  const clearArrayField = (obj, field, path = field) => {
    if (!obj || !Array.isArray(obj[field])) return;

    const before = obj[field].length;
    if (before <= 0) return;

    obj[field] = [];
    cleared.push({ path, before, after: 0 });
  };

  clearArrayField(data, 'trades');
  clearArrayField(data, 'actions');
  clearArrayField(data, 'openPositions');

  if (isObject(data.body)) {
    clearArrayField(data.body, 'trades', 'body.trades');
    clearArrayField(data.body, 'actions', 'body.actions');
    clearArrayField(data.body, 'openPositions', 'body.openPositions');
  }

  if (!dryRun && cleared.length > 0) {
    await redis('SET', LATEST_SCAN_KEY, JSON.stringify(data));
  }

  return {
    ok: true,
    key: LATEST_SCAN_KEY,
    dryRun,
    changed: cleared.length > 0,
    cleared,
  };
};

export default async function handler(req, res) {
  const startedAt = now();

  try {
    if (!['GET', 'POST'].includes(req.method)) {
      return json(res, 405, {
        ok: false,
        error: 'METHOD_NOT_ALLOWED',
        expected: 'GET_OR_POST',
      });
    }

    if (!ADMIN_SECRET) {
      return json(res, 500, {
        ok: false,
        error: 'ADMIN_FLUSH_SECRET_ENV_MISSING',
      });
    }

    if (!REDIS_URL || !REDIS_TOKEN) {
      return json(res, 500, {
        ok: false,
        error: 'REDIS_ENV_MISSING',
      });
    }

    const q = getQuery(req);
    const secret = String(q.secret || '');

    if (secret !== ADMIN_SECRET) {
      return json(res, 401, {
        ok: false,
        error: 'UNAUTHORIZED',
      });
    }

    const dryRun = toBool(q.dryRun, true);
    const confirm = String(q.confirm || '');

    if (!dryRun && confirm !== CONFIRM_TEXT) {
      return json(res, 400, {
        ok: false,
        error: 'CONFIRM_REQUIRED',
        expected: CONFIRM_TEXT,
      });
    }

    const runtime = await resetRuntimeCore({ dryRun });
    const analyze = await forceCloseAnalyze({ dryRun });
    const latestScan = await clearLatestScan({ dryRun });

    return json(res, 200, {
      ok: true,
      dryRun,
      mode: 'all',
      strategyVersion: STRATEGY_VERSION,
      runtime,
      analyze,
      latestScan,
      durationMs: now() - startedAt,
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: error?.message || String(error),
      strategyVersion: STRATEGY_VERSION,
      durationMs: now() - startedAt,
    });
  }
}