// api/admin-flush-open-positions.js

const STRATEGY_VERSION =
  process.env.TRADE_SYSTEM_STRATEGY_VERSION ||
  process.env.STRATEGY_VERSION ||
  'TS_V12_8_WEEKLY_MICRO_ROTATION_CLEAN';

const ADMIN_SECRET =
  process.env.ADMIN_FLUSH_SECRET ||
  process.env.FLUSH_SECRET ||
  'flush';

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN;

const ANALYZE_KEY =
  process.env.TRADE_ANALYZE_EVENTS_KEY ||
  'tradesystem:analyze:store:v3:events';

const LATEST_SCAN_KEY =
  process.env.TRADE_LATEST_SCAN_KEY ||
  'tradeSystem:latestScan:v1';

const CONFIRM = 'RESET_OPEN_POSITIONS';

const json = (res, status, body) => {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body, null, 2));
};

const getQuery = (req) => {
  const host = req.headers?.host || 'localhost';
  const url = new URL(req.url || '/', `https://${host}`);
  return Object.fromEntries(url.searchParams.entries());
};

const toBool = (v) => ['1', 'true', 'yes', 'y'].includes(String(v || '').toLowerCase());

const redis = async (command, ...args) => {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('REDIS_ENV_MISSING');

  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${REDIS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });

  const payload = await r.json().catch(() => null);

  if (!r.ok) throw new Error(`REDIS_HTTP_${r.status}`);
  if (payload?.error) throw new Error(payload.error);

  return payload?.result;
};

const parseJson = (raw) => {
  if (!raw || typeof raw !== 'string') return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const norm = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const hasTradeShape = (v) => {
  if (!isObj(v)) return false;

  const keys = Object.keys(v).map(norm);

  const hasSymbol = keys.includes('symbol');
  const hasSide = keys.includes('side');
  const hasTradeFields =
    keys.includes('tradeid') ||
    keys.includes('action') ||
    keys.includes('entry') ||
    keys.includes('entryprice') ||
    keys.includes('sl') ||
    keys.includes('tp') ||
    keys.includes('rr') ||
    keys.includes('setupclass');

  return hasSymbol && hasSide && hasTradeFields;
};

const shouldSkipPath = (path) => {
  const p = norm(path);

  return (
    p.includes('microlearning') ||
    p.includes('rotation') ||
    p.includes('topfamilies') ||
    p.includes('auditcounters') ||
    p.includes('closedtrades') ||
    p.includes('shadowoutcomes') ||
    p.includes('featurestore')
  );
};

const forceClearKeys = new Set([
  'openpositions',
  'openpositionmap',
  'openpositionsmap',
  'positions',
  'positionsmap',
  'activepositions',
  'runningpositions',
  'livetrades',
  'opentrades',
  'trades',
  'actions',
  'entries',
  'exits',
  'holds',
  'memory',
  'recententries',
  'recent',
]);

const forceZeroKeys = new Set([
  'openpositionscount',
  'opentradescount',
  'activepositionscount',
  'runningpositionscount',
  'livepositionscount',
]);

const deepResetRuntime = (node, path = '') => {
  const changes = [];

  if (!isObj(node) && !Array.isArray(node)) return changes;

  if (Array.isArray(node)) {
    const tradeRows = node.filter(hasTradeShape).length;

    if (tradeRows > 0) {
      node.length = 0;
      changes.push({
        path,
        type: 'TRADE_ARRAY_CLEAR',
        before: tradeRows,
        after: 0,
      });
    }

    return changes;
  }

  for (const [key, value] of Object.entries(node)) {
    const currentPath = path ? `${path}.${key}` : key;
    const k = norm(key);

    if (shouldSkipPath(currentPath)) continue;

    if (forceClearKeys.has(k)) {
      const before = Array.isArray(value)
        ? value.length
        : isObj(value)
          ? Object.keys(value).length
          : typeof value === 'number'
            ? value
            : 0;

      if (before > 0) {
        if (Array.isArray(value)) node[key] = [];
        else if (isObj(value)) node[key] = {};
        else if (typeof value === 'number') node[key] = 0;

        changes.push({
          path: currentPath,
          type: 'FORCE_KEY_CLEAR',
          before,
          after: 0,
        });
      }

      continue;
    }

    if (forceZeroKeys.has(k) && typeof value === 'number' && value !== 0) {
      node[key] = 0;
      changes.push({
        path: currentPath,
        type: 'FORCE_COUNTER_ZERO',
        before: value,
        after: 0,
      });

      continue;
    }

    if (Array.isArray(value)) {
      const tradeRows = value.filter(hasTradeShape).length;

      if (tradeRows > 0) {
        node[key] = [];
        changes.push({
          path: currentPath,
          type: 'TRADE_ARRAY_CLEAR',
          before: tradeRows,
          after: 0,
        });
      }

      continue;
    }

    if (isObj(value)) {
      const rows = Object.values(value);
      const tradeRows = rows.filter(hasTradeShape).length;

      if (tradeRows > 0 && tradeRows >= Math.max(1, Math.floor(rows.length * 0.5))) {
        node[key] = {};
        changes.push({
          path: currentPath,
          type: 'TRADE_MAP_CLEAR',
          before: tradeRows,
          after: 0,
        });

        continue;
      }

      changes.push(...deepResetRuntime(value, currentPath));
    }
  }

  return changes;
};

const scanKeys = async (pattern) => {
  const out = [];
  let cursor = '0';

  do {
    const result = await redis('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = String(result?.[0] ?? '0');

    const keys = Array.isArray(result?.[1]) ? result[1] : [];
    out.push(...keys);
  } while (cursor !== '0' && out.length < 1000);

  return [...new Set(out)];
};

const resetRuntime = async ({ dryRun }) => {
  const keys = await scanKeys(`${STRATEGY_VERSION}:runtime:*`);
  const touched = [];
  const skipped = [];

  for (const key of keys) {
    const type = await redis('TYPE', key).catch(() => 'none');

    if (type !== 'string') {
      skipped.push({ key, type, reason: 'NOT_STRING' });
      continue;
    }

    const raw = await redis('GET', key);
    const obj = parseJson(raw);

    if (!obj) {
      skipped.push({ key, type, reason: 'NOT_JSON' });
      continue;
    }

    const changes = deepResetRuntime(obj);

    if (!changes.length) {
      skipped.push({ key, type, reason: 'NO_RUNTIME_TRADE_ROWS_FOUND' });
      continue;
    }

    if (!dryRun) {
      await redis('SET', key, JSON.stringify(obj));
    }

    touched.push({
      key,
      type,
      changes,
    });
  }

  return {
    ok: true,
    keysScanned: keys.length,
    touchedKeys: touched.length,
    touched,
    skippedSample: skipped.slice(0, 25),
  };
};

const resetAnalyze = async ({ dryRun }) => {
  const type = await redis('TYPE', ANALYZE_KEY).catch(() => 'none');

  if (type === 'none') {
    return {
      ok: true,
      key: ANALYZE_KEY,
      type,
      deleted: false,
      reason: 'MISSING',
    };
  }

  let before = null;

  if (type === 'list') before = await redis('LLEN', ANALYZE_KEY).catch(() => null);
  if (type === 'string') before = String(await redis('GET', ANALYZE_KEY) || '').length;

  if (!dryRun) {
    await redis('DEL', ANALYZE_KEY);
  }

  return {
    ok: true,
    key: ANALYZE_KEY,
    type,
    before,
    deleted: !dryRun,
    dryRun,
  };
};

const resetLatestScan = async ({ dryRun }) => {
  const raw = await redis('GET', LATEST_SCAN_KEY).catch(() => null);
  const obj = parseJson(raw);

  if (!obj) {
    return {
      ok: true,
      key: LATEST_SCAN_KEY,
      changed: false,
      reason: 'NO_JSON_LATEST_SCAN',
    };
  }

  const cleared = [];

  for (const key of ['trades', 'actions', 'tradeActions', 'enrichedTradeActions']) {
    if (Array.isArray(obj[key]) && obj[key].length) {
      cleared.push({ path: key, before: obj[key].length, after: 0 });
      obj[key] = [];
    }
  }

  if (isObj(obj.body)) {
    for (const key of ['trades', 'actions', 'tradeActions', 'enrichedTradeActions']) {
      if (Array.isArray(obj.body[key]) && obj.body[key].length) {
        cleared.push({ path: `body.${key}`, before: obj.body[key].length, after: 0 });
        obj.body[key] = [];
      }
    }
  }

  if (cleared.length && !dryRun) {
    await redis('SET', LATEST_SCAN_KEY, JSON.stringify(obj));
  }

  return {
    ok: true,
    key: LATEST_SCAN_KEY,
    changed: cleared.length > 0,
    dryRun,
    cleared,
  };
};

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    const q = getQuery(req);

    if (q.secret !== ADMIN_SECRET) {
      return json(res, 401, {
        ok: false,
        error: 'UNAUTHORIZED',
      });
    }

    const dryRun = toBool(q.dryRun);

    if (!dryRun && q.confirm !== CONFIRM) {
      return json(res, 400, {
        ok: false,
        error: 'CONFIRM_REQUIRED',
        expected: CONFIRM,
      });
    }

    const runtime = await resetRuntime({ dryRun });
    const analyze = await resetAnalyze({ dryRun });
    const latestScan = await resetLatestScan({ dryRun });

    return json(res, 200, {
      ok: true,
      dryRun,
      strategyVersion: STRATEGY_VERSION,
      runtime,
      analyze,
      latestScan,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: error?.message || String(error),
      strategyVersion: STRATEGY_VERSION,
      durationMs: Date.now() - startedAt,
    });
  }
}