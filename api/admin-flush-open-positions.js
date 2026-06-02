const DEFAULT_STRATEGY_VERSION = 'TS_V12_8_WEEKLY_MICRO_ROTATION_CLEAN';

const DEFAULT_ANALYZE_KEY = 'tradesystem:analyze:store:v3:events';
const DEFAULT_LATEST_SCAN_KEY = 'tradeSystem:latestScan:v1';

const CONFIRM_TEXT = 'RESET_OPEN_POSITIONS';

const OPEN_CONTAINER_KEYS = new Set([
  'memory',
  'openpositions',
  'openposition',
  'opentrades',
  'opentrade',
  'activepositions',
  'activeposition',
  'activetrades',
  'activetrade',
  'positionsbysymbol',
  'openpositionsbysymbol',
  'openpositionbysymbol',
  'positionmemory',
]);

const POSITION_ARRAY_KEYS = new Set([
  'positions',
]);

const OPEN_COUNT_KEYS = new Set([
  'openpositionscount',
  'openpositioncount',
  'opentradescount',
  'opentradecount',
  'activepositionscount',
  'activepositioncount',
  'activetradescount',
  'activetradecount',
  'currentopenpositions',
  'currentopentrades',
  'openpositionstotal',
  'opentradestotal',
]);

const SKIP_RUNTIME_PATH_PARTS = [
  'auditcounters',
  'audit',
  'closedtrades',
  'closed_trades',
  'closed',
  'shadowoutcomes',
  'shadow_outcomes',
  'featurestore',
  'feature_store',
  'recententries',
  'recent_entries',
  'backfill',
  'topfamilies',
  'familystats',
  'families',
  'rotation',
  'learning',
  'microlearning',
];

const LATEST_SCAN_ARRAY_KEYS = new Set([
  'trades',
  'actions',
  'tradeactions',
  'rawtradeactions',
  'enrichedtradeactions',
]);

const first = (value, fallback = undefined) => {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
};

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(v)) return true;
  if (['0', 'false', 'no', 'n'].includes(v)) return false;
  return fallback;
};

const isPlainObject = (value) => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const safeJsonParse = (value) => {
  if (typeof value !== 'string') return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const json = (res, status, body) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(status).json(body);
};

const getRedisEnv = () => {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    process.env.REDIS_REST_API_URL ||
    process.env.VERCEL_KV_REST_API_URL;

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.REDIS_REST_API_TOKEN ||
    process.env.VERCEL_KV_REST_API_TOKEN;

  return { url, token };
};

const redis = async (command, ...args) => {
  const { url, token } = getRedisEnv();

  if (!url || !token) {
    throw new Error('REDIS_REST_ENV_MISSING');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });

  const text = await response.text();
  const payload = safeJsonParse(text);

  if (!response.ok) {
    throw new Error(`REDIS_HTTP_${response.status}: ${text.slice(0, 300)}`);
  }

  if (payload?.error) {
    throw new Error(`REDIS_ERROR: ${payload.error}`);
  }

  return payload?.result;
};

const chunk = (rows, size) => {
  const out = [];

  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }

  return out;
};

const lowerKey = (key) => String(key || '').toLowerCase();

const pathToString = (path) => path.filter(Boolean).join('.');

const shouldSkipRuntimePath = (path) => {
  const joined = pathToString(path).toLowerCase();

  return SKIP_RUNTIME_PATH_PARTS.some((part) => joined.includes(part));
};

const normalizeSide = (side) => {
  const s = String(side || '').toUpperCase();

  if (s === 'BULL' || s === 'LONG') return 'LONG';
  if (s === 'BEAR' || s === 'SHORT') return 'SHORT';

  return s || 'NA';
};

const numeric = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const looksLikeOpenPosition = (value) => {
  if (!isPlainObject(value)) return false;

  const action = String(value.action || value.analyzeLifecycle || '').toUpperCase();

  if (value.closed === true) return false;
  if (value.closedAt) return false;
  if (action === 'EXIT') return false;

  const hasSymbol = typeof value.symbol === 'string' && value.symbol.length > 0;
  const hasSide = Boolean(value.side || value.direction);
  const hasEntry =
    numeric(value.entry) !== null ||
    numeric(value.entryPrice) !== null ||
    numeric(value.avgEntry) !== null ||
    numeric(value.avgEntryPrice) !== null;

  const hasTradeShape =
    hasSymbol &&
    hasSide &&
    (
      hasEntry ||
      numeric(value.sl) !== null ||
      numeric(value.tp) !== null ||
      String(value.reason || '').toUpperCase() === 'RUNNING'
    );

  return hasTradeShape;
};

const countOpenRows = (value) => {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (looksLikeOpenPosition(value)) {
    return 1;
  }

  if (!isPlainObject(value)) {
    return 0;
  }

  let count = 0;

  for (const row of Object.values(value)) {
    if (Array.isArray(row)) {
      count += row.length;
      continue;
    }

    if (looksLikeOpenPosition(row)) {
      count += 1;
      continue;
    }

    if (isPlainObject(row)) {
      count += countOpenRows(row);
    }
  }

  return count;
};

const emptyLike = (value) => {
  if (Array.isArray(value)) return [];
  if (isPlainObject(value)) return {};
  return value;
};

const resetRuntimeObject = (root) => {
  const changes = [];

  const walk = (node, path = []) => {
    if (!isPlainObject(node) && !Array.isArray(node)) return;
    if (shouldSkipRuntimePath(path)) return;

    if (Array.isArray(node)) {
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const k = lowerKey(key);
      const nextPath = [...path, key];

      if (shouldSkipRuntimePath(nextPath)) {
        continue;
      }

      const isExplicitOpenContainer = OPEN_CONTAINER_KEYS.has(k);
      const isPositionArrayContainer =
        POSITION_ARRAY_KEYS.has(k) &&
        (Array.isArray(value) || isPlainObject(value)) &&
        countOpenRows(value) > 0;

      if (isExplicitOpenContainer || isPositionArrayContainer) {
        const before = countOpenRows(value);

        if (before > 0) {
          node[key] = emptyLike(value);

          changes.push({
            path: pathToString(nextPath),
            before,
            after: 0,
            mode: isExplicitOpenContainer ? 'OPEN_CONTAINER' : 'POSITION_CONTAINER',
          });
        }

        continue;
      }

      if (OPEN_COUNT_KEYS.has(k) && typeof value === 'number') {
        if (value !== 0) {
          node[key] = 0;

          changes.push({
            path: pathToString(nextPath),
            before: value,
            after: 0,
            mode: 'OPEN_COUNT',
          });
        }

        continue;
      }

      if (isPlainObject(value) || Array.isArray(value)) {
        walk(value, nextPath);
      }
    }
  };

  walk(root, []);

  return changes;
};

const resetRuntimeCore = async ({ strategyVersion, dryRun }) => {
  const key = `${strategyVersion}:runtime:core`;
  const type = await redis('TYPE', key).catch(() => 'none');

  if (type !== 'string') {
    return {
      ok: true,
      dryRun,
      key,
      type,
      touched: false,
      openBefore: 0,
      openAfter: 0,
      reason: 'RUNTIME_CORE_NOT_STRING_OR_MISSING',
    };
  }

  const raw = await redis('GET', key);
  const state = safeJsonParse(raw);

  if (!state) {
    return {
      ok: false,
      dryRun,
      key,
      type,
      touched: false,
      openBefore: 0,
      openAfter: 0,
      error: 'RUNTIME_CORE_NOT_JSON',
    };
  }

  const changes = resetRuntimeObject(state);
  const openBefore = changes.reduce((sum, row) => sum + Number(row.before || 0), 0);

  if (!dryRun && changes.length > 0) {
    await redis('SET', key, JSON.stringify(state));
  }

  return {
    ok: true,
    dryRun,
    key,
    type,
    touched: changes.length > 0,
    touchedKeys: changes.length > 0 ? 1 : 0,
    openBefore,
    openAfter: changes.length > 0 ? 0 : openBefore,
    changes,
  };
};

const eventAction = (event) => {
  return String(event?.analyzeLifecycle || event?.action || event?.type || '').toUpperCase();
};

const isEntryEvent = (event) => eventAction(event) === 'ENTRY';
const isExitEvent = (event) => eventAction(event) === 'EXIT';

const eventIdentity = (event) => {
  if (!event || typeof event !== 'object') return null;

  if (event.tradeId) {
    return String(event.tradeId);
  }

  const symbol = String(event.symbol || '').toUpperCase();
  const side = normalizeSide(event.side || event.direction);
  const entry = String(event.entryPrice ?? event.entry ?? event.avgEntryPrice ?? event.avgEntry ?? '');
  const family = String(event.familyId || '');

  if (!symbol || side === 'NA') return null;

  return `${symbol}:${side}:${entry}:${family}`;
};

const parseEventRows = (rows) => {
  const out = [];

  for (const row of rows || []) {
    if (typeof row === 'string') {
      const parsed = safeJsonParse(row);
      if (parsed) out.push(parsed);
      continue;
    }

    if (isPlainObject(row)) {
      out.push(row);
    }
  }

  return out;
};

const getOpenAnalyzeEntries = (events) => {
  const open = new Map();

  for (const event of events) {
    const id = eventIdentity(event);
    if (!id) continue;

    if (isEntryEvent(event)) {
      open.set(id, event);
      continue;
    }

    if (isExitEvent(event)) {
      open.delete(id);
    }
  }

  return [...open.values()];
};

const buildAdminExit = (entry, now) => {
  const exitPrice =
    numeric(entry.currentPrice) ??
    numeric(entry.markPrice) ??
    numeric(entry.exitPrice) ??
    numeric(entry.exit) ??
    numeric(entry.entryPrice) ??
    numeric(entry.entry) ??
    0;

  return {
    ...entry,
    action: 'EXIT',
    analyzeLifecycle: 'EXIT',
    reason: 'ADMIN_FORCE_CLOSE',
    closed: true,
    closedAt: now,
    exit: exitPrice,
    exitPrice,
    realizedR: 0,
    pnlR: 0,
    exitR: 0,
    pnlPct: 0,
    adminForceClosed: true,
    adminFlush: true,
    ts: now,
  };
};

const appendListRows = async (key, rows) => {
  if (!rows.length) return;

  const serialized = rows.map((row) => JSON.stringify(row));

  for (const part of chunk(serialized, 50)) {
    await redis('RPUSH', key, ...part);
  }
};

const resetAnalyzeList = async ({ key, dryRun }) => {
  const type = await redis('TYPE', key).catch(() => 'none');

  if (type === 'none') {
    return {
      ok: true,
      dryRun,
      key,
      type,
      totalEvents: 0,
      openBefore: 0,
      forceExits: 0,
      openAfter: 0,
      reason: 'ANALYZE_KEY_MISSING',
    };
  }

  if (type === 'list') {
    const rawRows = await redis('LRANGE', key, 0, -1);
    const events = parseEventRows(rawRows);
    const openEntries = getOpenAnalyzeEntries(events);

    const now = Date.now();
    const exits = openEntries.map((entry) => buildAdminExit(entry, now));

    if (!dryRun) {
      await appendListRows(key, exits);
    }

    return {
      ok: true,
      dryRun,
      key,
      type,
      totalEvents: events.length,
      openBefore: openEntries.length,
      forceExits: exits.length,
      openAfter: dryRun ? openEntries.length : 0,
      wouldOpenAfter: 0,
      sample: exits.slice(0, 20).map((row) => ({
        tradeId: row.tradeId ?? null,
        symbol: row.symbol ?? null,
        side: row.side ?? null,
        action: row.action,
        reason: row.reason,
      })),
    };
  }

  if (type === 'string') {
    const raw = await redis('GET', key);
    const parsed = safeJsonParse(raw);

    if (!parsed) {
      return {
        ok: false,
        dryRun,
        key,
        type,
        error: 'ANALYZE_STRING_NOT_JSON',
      };
    }

    const events = Array.isArray(parsed)
      ? parsed
      : parsed.events || parsed.records || parsed.data || [];

    const openEntries = getOpenAnalyzeEntries(parseEventRows(events));
    const now = Date.now();
    const exits = openEntries.map((entry) => buildAdminExit(entry, now));

    if (!dryRun && exits.length > 0) {
      if (Array.isArray(parsed)) {
        await redis('SET', key, JSON.stringify([...parsed, ...exits]));
      } else if (Array.isArray(parsed.events)) {
        parsed.events.push(...exits);
        await redis('SET', key, JSON.stringify(parsed));
      } else if (Array.isArray(parsed.records)) {
        parsed.records.push(...exits);
        await redis('SET', key, JSON.stringify(parsed));
      } else if (Array.isArray(parsed.data)) {
        parsed.data.push(...exits);
        await redis('SET', key, JSON.stringify(parsed));
      }
    }

    return {
      ok: true,
      dryRun,
      key,
      type,
      totalEvents: events.length,
      openBefore: openEntries.length,
      forceExits: exits.length,
      openAfter: dryRun ? openEntries.length : 0,
      wouldOpenAfter: 0,
      sample: exits.slice(0, 20).map((row) => ({
        tradeId: row.tradeId ?? null,
        symbol: row.symbol ?? null,
        side: row.side ?? null,
        action: row.action,
        reason: row.reason,
      })),
    };
  }

  return {
    ok: true,
    dryRun,
    key,
    type,
    totalEvents: 0,
    openBefore: 0,
    forceExits: 0,
    openAfter: 0,
    reason: 'ANALYZE_KEY_UNSUPPORTED_TYPE',
  };
};

const clearLatestScanArrays = (root) => {
  const cleared = [];

  const walk = (node, path = [], depth = 0) => {
    if (!isPlainObject(node) || depth > 4) return;

    for (const [key, value] of Object.entries(node)) {
      const k = lowerKey(key);
      const nextPath = [...path, key];

      if (LATEST_SCAN_ARRAY_KEYS.has(k) && Array.isArray(value)) {
        if (value.length > 0) {
          cleared.push({
            path: pathToString(nextPath),
            before: value.length,
            after: 0,
          });

          node[key] = [];
        }

        continue;
      }

      if (isPlainObject(value)) {
        walk(value, nextPath, depth + 1);
      }
    }
  };

  walk(root, []);

  return cleared;
};

const resetLatestScan = async ({ key, dryRun }) => {
  const type = await redis('TYPE', key).catch(() => 'none');

  if (type !== 'string') {
    return {
      ok: true,
      dryRun,
      key,
      type,
      changed: false,
      cleared: [],
      reason: 'LATEST_SCAN_NOT_STRING_OR_MISSING',
    };
  }

  const raw = await redis('GET', key);
  const parsed = safeJsonParse(raw);

  if (!parsed) {
    return {
      ok: false,
      dryRun,
      key,
      type,
      changed: false,
      error: 'LATEST_SCAN_NOT_JSON',
    };
  }

  const cleared = clearLatestScanArrays(parsed);

  if (!dryRun && cleared.length > 0) {
    await redis('SET', key, JSON.stringify(parsed));
  }

  return {
    ok: true,
    dryRun,
    key,
    type,
    changed: cleared.length > 0,
    cleared,
  };
};

const validateAuth = (req) => {
  const expected =
    process.env.ADMIN_FLUSH_SECRET ||
    process.env.FLUSH_SECRET ||
    process.env.ADMIN_SECRET ||
    process.env.ADMIN_RESET_SECRET;

  if (!expected) {
    return {
      ok: false,
      status: 500,
      error: 'ADMIN_FLUSH_SECRET_ENV_MISSING',
      expectedEnvNames: [
        'ADMIN_FLUSH_SECRET',
        'FLUSH_SECRET',
        'ADMIN_SECRET',
        'ADMIN_RESET_SECRET',
      ],
    };
  }

  const supplied =
    first(req.query?.secret) ||
    first(req.headers?.['x-admin-secret']) ||
    first(req.headers?.['x-flush-secret']);

  if (String(supplied || '') !== String(expected)) {
    return {
      ok: false,
      status: 401,
      error: 'UNAUTHORIZED',
    };
  }

  return { ok: true };
};

export default async function handler(req, res) {
  const startedAt = Date.now();

  if (!['GET', 'POST'].includes(req.method)) {
    return json(res, 405, {
      ok: false,
      error: 'METHOD_NOT_ALLOWED',
      expected: 'GET_OR_POST',
    });
  }

  const auth = validateAuth(req);

  if (!auth.ok) {
    return json(res, auth.status, auth);
  }

  const body = isPlainObject(req.body) ? req.body : {};

  const strategyVersion =
    first(req.query?.strategyVersion) ||
    body.strategyVersion ||
    DEFAULT_STRATEGY_VERSION;

  const analyzeKey =
    first(req.query?.analyzeKey) ||
    body.analyzeKey ||
    DEFAULT_ANALYZE_KEY;

  const latestScanKey =
    first(req.query?.latestScanKey) ||
    body.latestScanKey ||
    DEFAULT_LATEST_SCAN_KEY;

  const mode = String(first(req.query?.mode) || body.mode || 'all').toLowerCase();
  const dryRun = toBool(first(req.query?.dryRun) ?? body.dryRun, true);
  const confirm = first(req.query?.confirm) || body.confirm || '';

  if (!dryRun && confirm !== CONFIRM_TEXT) {
    return json(res, 400, {
      ok: false,
      dryRun,
      error: 'CONFIRM_REQUIRED',
      expectedConfirm: CONFIRM_TEXT,
      example: `?secret=***&dryRun=false&confirm=${CONFIRM_TEXT}`,
    });
  }

  try {
    const result = {
      ok: true,
      dryRun,
      mode,
      strategyVersion,
      runtime: null,
      analyze: null,
      latestScan: null,
    };

    if (mode === 'all' || mode === 'runtime') {
      result.runtime = await resetRuntimeCore({
        strategyVersion,
        dryRun,
      });
    }

    if (mode === 'all' || mode === 'analyze') {
      result.analyze = await resetAnalyzeList({
        key: analyzeKey,
        dryRun,
      });
    }

    if (mode === 'all' || mode === 'latestscan' || mode === 'latest_scan') {
      result.latestScan = await resetLatestScan({
        key: latestScanKey,
        dryRun,
      });
    }

    result.durationMs = Date.now() - startedAt;

    return json(res, 200, result);
  } catch (error) {
    return json(res, 500, {
      ok: false,
      dryRun,
      mode,
      strategyVersion,
      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
    });
  }
}