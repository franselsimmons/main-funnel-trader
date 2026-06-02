export const config = {
  maxDuration: 60,
};

const DEFAULT_STRATEGY_VERSION = 'TS_V12_8_WEEKLY_MICRO_ROTATION_CLEAN';

const ANALYZE_EVENTS_KEY = 'tradesystem:analyze:store:v3:events';
const LATEST_SCAN_KEY = 'tradeSystem:latestScan:v1';

const CONFIRM_TEXT = 'RESET_OPEN_POSITIONS';

const OPEN_CONTAINER_KEY_RX =
  /^(openPositions|open_positions|openTrades|open_trades|activePositions|active_positions|runningPositions|running_positions|heldPositions|held_positions|positionMemory|position_memory|openPositionMemory|open_position_memory)$/i;

const OPEN_COUNT_KEY_RX =
  /^(openPositionCount|openPositionsCount|openTradeCount|openTradesCount|openCount|open_count)$/i;

const POSITION_CONTAINER_KEY_RX =
  /^(memory|positions|positionMap|position_map|positionsBySymbol|positions_by_symbol|openBySymbol|open_by_symbol)$/i;

function getRedisConfig() {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.REDIS_REST_URL;

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('REDIS_REST_ENV_MISSING');
  }

  return {
    url: String(url).replace(/\/$/, ''),
    token,
  };
}

async function redis(command, ...args) {
  const { url, token } = getRedisConfig();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });

  const text = await response.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`REDIS_BAD_JSON_RESPONSE:${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`REDIS_HTTP_${response.status}:${text.slice(0, 300)}`);
  }

  if (json?.error) {
    throw new Error(`REDIS_ERROR:${json.error}`);
  }

  return json?.result;
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;

  return fallback;
}

async function getPayload(req) {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `https://${host}`);

  if (req.method === 'GET') {
    return {
      secret: url.searchParams.get('secret'),
      dryRun: url.searchParams.get('dryRun'),
      confirm: url.searchParams.get('confirm'),
      strategyVersion: url.searchParams.get('strategyVersion'),
      mode: url.searchParams.get('mode'),
      maxKeys: url.searchParams.get('maxKeys'),
    };
  }

  return req.body || {};
}

function parseJsonDeep(raw) {
  let value = raw;

  for (let i = 0; i < 4; i += 1) {
    if (typeof value !== 'string') {
      return {
        ok: true,
        value,
      };
    }

    const trimmed = value.trim();

    if (!trimmed) {
      return {
        ok: false,
        error: 'EMPTY_STRING',
      };
    }

    const looksJson =
      trimmed.startsWith('{') ||
      trimmed.startsWith('[') ||
      trimmed.startsWith('"');

    if (!looksJson) {
      return {
        ok: false,
        error: 'NOT_JSON',
      };
    }

    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      return {
        ok: false,
        error: `JSON_PARSE_FAILED:${error.message}`,
      };
    }
  }

  return {
    ok: true,
    value,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function countContainerRows(value) {
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return 0;
}

function emptyLike(value) {
  if (Array.isArray(value)) return [];
  if (isPlainObject(value)) return {};
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  if (typeof value === 'string') return '';
  return value;
}

function normalizeAction(value) {
  return String(value || '').trim().toUpperCase();
}

function isOpenPositionLike(row) {
  if (!isPlainObject(row)) return false;

  const action = normalizeAction(row.action || row.analyzeLifecycle);
  const reason = normalizeAction(row.reason);
  const closed = row.closed === true || row.isClosed === true;

  if (closed) return false;
  if (action === 'EXIT') return false;
  if (reason === 'TP' || reason === 'SL' || reason === 'STOP' || reason === 'CLOSED') return false;

  const hasSymbol = typeof row.symbol === 'string' && row.symbol.trim().length > 0;
  if (!hasSymbol) return false;

  const hasEntry =
    Number.isFinite(Number(row.entry)) ||
    Number.isFinite(Number(row.entryPrice));

  const hasRiskBox =
    Number.isFinite(Number(row.sl)) ||
    Number.isFinite(Number(row.tp));

  const isRunning =
    action === 'HOLD' ||
    action === 'ENTRY' ||
    reason === 'RUNNING' ||
    row.scannerStage === 'open_position';

  return Boolean(hasEntry && hasRiskBox && isRunning);
}

function countOpenPositionLikeRows(value) {
  if (Array.isArray(value)) {
    return value.filter(isOpenPositionLike).length;
  }

  if (isPlainObject(value)) {
    return Object.values(value).filter(isOpenPositionLike).length;
  }

  return 0;
}

function scrubOpenRuntimeState(root) {
  const seen = new WeakSet();

  const stats = {
    changed: false,
    openBefore: 0,
    cleared: [],
  };

  function clearContainer(parent, key, path) {
    const before = countContainerRows(parent[key]);

    stats.openBefore += before;
    parent[key] = emptyLike(parent[key]);
    stats.changed = true;

    stats.cleared.push({
      path: [...path, key].join('.'),
      before,
    });
  }

  function walk(node, path = []) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;

    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, path);
      }
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (OPEN_CONTAINER_KEY_RX.test(key)) {
        clearContainer(node, key, path);
        continue;
      }

      if (OPEN_COUNT_KEY_RX.test(key) && typeof value === 'number') {
        stats.openBefore += Number(value) || 0;
        node[key] = 0;
        stats.changed = true;

        stats.cleared.push({
          path: [...path, key].join('.'),
          before: value,
        });

        continue;
      }

      if (POSITION_CONTAINER_KEY_RX.test(key)) {
        const openLike = countOpenPositionLikeRows(value);

        if (openLike > 0) {
          stats.openBefore += openLike;
          node[key] = emptyLike(value);
          stats.changed = true;

          stats.cleared.push({
            path: [...path, key].join('.'),
            before: openLike,
            reason: 'POSITION_LIKE_CONTAINER',
          });

          continue;
        }
      }

      walk(value, [...path, key]);
    }
  }

  walk(root);

  return stats;
}

function scrubLatestScanState(root) {
  if (!isPlainObject(root)) {
    return {
      changed: false,
      cleared: [],
    };
  }

  const cleared = [];

  for (const key of ['trades', 'actions', 'openPositions', 'open_positions']) {
    if (Array.isArray(root[key]) && root[key].length > 0) {
      cleared.push({
        path: key,
        before: root[key].length,
      });

      root[key] = [];
    }
  }

  return {
    changed: cleared.length > 0,
    cleared,
  };
}

async function scanKeys(pattern, maxKeys = 1000) {
  let cursor = '0';
  const keys = [];

  do {
    const result = await redis('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100);

    cursor = String(result?.[0] ?? '0');

    const batch = Array.isArray(result?.[1]) ? result[1] : [];
    keys.push(...batch);

    if (keys.length >= maxKeys) break;
  } while (cursor !== '0');

  return [...new Set(keys)].slice(0, maxKeys);
}

async function mutateJsonKey(key, dryRun, mutator) {
  let raw;

  try {
    raw = await redis('GET', key);
  } catch (error) {
    return {
      key,
      ok: false,
      changed: false,
      error: error.message,
    };
  }

  if (raw === null || raw === undefined) {
    return {
      key,
      ok: true,
      changed: false,
      reason: 'KEY_EMPTY_OR_MISSING',
    };
  }

  const parsed = parseJsonDeep(raw);

  if (!parsed.ok) {
    return {
      key,
      ok: true,
      changed: false,
      reason: parsed.error,
    };
  }

  const value = parsed.value;
  const mutation = mutator(value);

  if (!mutation.changed) {
    return {
      key,
      ok: true,
      changed: false,
      reason: 'NO_MUTATION',
      ...mutation,
    };
  }

  if (!dryRun) {
    await redis('SET', key, JSON.stringify(value));
  }

  return {
    key,
    ok: true,
    changed: true,
    dryRun,
    ...mutation,
  };
}

function normalizeSide(side) {
  const value = String(side || '').trim().toUpperCase();

  if (value === 'BULL' || value === 'LONG') return 'LONG';
  if (value === 'BEAR' || value === 'SHORT') return 'SHORT';

  return value || 'UNKNOWN';
}

function isAnalyzeEntry(event) {
  if (!isPlainObject(event)) return false;

  const lifecycle = normalizeAction(event.analyzeLifecycle);
  const action = normalizeAction(event.action);

  return lifecycle === 'ENTRY' || action === 'ENTRY';
}

function isAnalyzeExit(event) {
  if (!isPlainObject(event)) return false;

  const lifecycle = normalizeAction(event.analyzeLifecycle);
  const action = normalizeAction(event.action);

  return lifecycle === 'EXIT' || action === 'EXIT';
}

function getAnalyzeEventKey(event) {
  const tradeId = String(event.tradeId || event.id || '').trim();

  if (tradeId) {
    return `id:${tradeId}`;
  }

  const symbol = String(event.symbol || '').trim().toUpperCase();
  const side = normalizeSide(event.side);

  if (!symbol || side === 'UNKNOWN') return null;

  return `sym:${symbol}:${side}`;
}

function getSymbolSideKey(event) {
  const symbol = String(event.symbol || '').trim().toUpperCase();
  const side = normalizeSide(event.side);

  if (!symbol || side === 'UNKNOWN') return null;

  return `sym:${symbol}:${side}`;
}

function computeOpenAnalyzeEntries(events) {
  const openByPrimaryKey = new Map();
  const openBySymbolSide = new Map();

  for (const event of events) {
    if (!isPlainObject(event)) continue;

    const primaryKey = getAnalyzeEventKey(event);
    const symbolSideKey = getSymbolSideKey(event);

    if (isAnalyzeEntry(event)) {
      if (primaryKey) openByPrimaryKey.set(primaryKey, event);
      if (symbolSideKey) openBySymbolSide.set(symbolSideKey, event);
      continue;
    }

    if (isAnalyzeExit(event)) {
      if (primaryKey) openByPrimaryKey.delete(primaryKey);
      if (symbolSideKey) openBySymbolSide.delete(symbolSideKey);
    }
  }

  const merged = new Map();

  for (const [key, event] of openByPrimaryKey.entries()) {
    merged.set(key, event);
  }

  for (const [key, event] of openBySymbolSide.entries()) {
    const primaryKey = getAnalyzeEventKey(event);
    const finalKey = primaryKey || key;

    if (!merged.has(finalKey)) {
      merged.set(finalKey, event);
    }
  }

  return [...merged.values()];
}

function buildAdminExitEvent(entry, strategyVersion, now) {
  const side = normalizeSide(entry.side);
  const symbol = String(entry.symbol || '').trim().toUpperCase();

  const entryPrice =
    Number(entry.entryPrice) ||
    Number(entry.entry) ||
    Number(entry.price) ||
    0;

  return {
    tradeId:
      entry.tradeId ||
      entry.id ||
      `ADMIN_FLUSH_${strategyVersion}_${symbol}_${side}_${now}`,

    symbol,
    side,

    action: 'EXIT',
    analyzeLifecycle: 'EXIT',

    reason: 'ADMIN_FLUSH_OPEN_RESET',
    closed: true,
    closedAt: now,

    entry: entryPrice,
    entryPrice,
    exit: entryPrice,
    exitPrice: entryPrice,

    sl: entry.sl ?? null,
    tp: entry.tp ?? null,

    rr: entry.rr ?? entry.baseRR ?? null,
    baseRR: entry.baseRR ?? entry.rr ?? null,

    realizedR: 0,
    pnlR: 0,
    exitR: 0,
    pnlPct: 0,

    familyId: entry.familyId ?? null,
    microFamilyId: entry.microFamilyId ?? null,
    setupClass: entry.setupClass ?? null,
    grade: entry.grade ?? null,

    confluence: entry.confluence ?? null,
    sniperScore: entry.sniperScore ?? null,
    score: entry.score ?? null,

    strategyVersion,
    adminFlush: true,
    ts: now,
  };
}

async function appendRedisList(key, rows) {
  const chunkSize = 100;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map((row) => JSON.stringify(row));
    await redis('RPUSH', key, ...chunk);
  }
}

async function closeAnalyzeOpenEntries({ strategyVersion, dryRun }) {
  let rawRows;

  try {
    rawRows = await redis('LRANGE', ANALYZE_EVENTS_KEY, 0, -1);
  } catch (error) {
    return {
      ok: false,
      key: ANALYZE_EVENTS_KEY,
      error: error.message,
      openBefore: null,
      openAfter: null,
      forceExits: 0,
    };
  }

  if (!Array.isArray(rawRows)) {
    return {
      ok: false,
      key: ANALYZE_EVENTS_KEY,
      error: 'ANALYZE_EVENTS_NOT_A_REDIS_LIST',
      openBefore: null,
      openAfter: null,
      forceExits: 0,
    };
  }

  const events = [];

  for (const raw of rawRows) {
    const parsed = parseJsonDeep(raw);
    if (parsed.ok && isPlainObject(parsed.value)) {
      events.push(parsed.value);
    }
  }

  const openEntries = computeOpenAnalyzeEntries(events);
  const now = Date.now();

  const exitEvents = openEntries.map((entry) =>
    buildAdminExitEvent(entry, strategyVersion, now)
  );

  if (!dryRun && exitEvents.length > 0) {
    await appendRedisList(ANALYZE_EVENTS_KEY, exitEvents);
  }

  return {
    ok: true,
    key: ANALYZE_EVENTS_KEY,
    dryRun,
    totalEvents: events.length,
    openBefore: openEntries.length,
    forceExits: exitEvents.length,
    openAfter: dryRun ? openEntries.length : 0,
    sample: openEntries.slice(0, 20).map((entry) => ({
      tradeId: entry.tradeId || null,
      symbol: entry.symbol,
      side: entry.side,
      action: entry.action,
      reason: entry.reason,
    })),
  };
}

async function resetRuntimeOpenPositions({ strategyVersion, dryRun, maxKeys }) {
  const directKeys = [
    `${strategyVersion}:runtime:core`,
    `${strategyVersion}:runtime:recent_entries`,
  ];

  const scannedKeys = await scanKeys(`${strategyVersion}:runtime:*`, maxKeys);

  const keys = [...new Set([...directKeys, ...scannedKeys])];

  const results = [];

  for (const key of keys) {
    const result = await mutateJsonKey(key, dryRun, scrubOpenRuntimeState);

    if (result.changed || result.openBefore > 0 || result.error) {
      results.push(result);
    }
  }

  const openBefore = results.reduce((sum, item) => {
    return sum + (Number(item.openBefore) || 0);
  }, 0);

  return {
    ok: true,
    strategyVersion,
    dryRun,
    keysScanned: keys.length,
    touchedKeys: results.filter((item) => item.changed).length,
    openBefore,
    openAfter: dryRun ? openBefore : 0,
    touched: results,
  };
}

async function clearLatestScan({ dryRun }) {
  return mutateJsonKey(LATEST_SCAN_KEY, dryRun, scrubLatestScanState);
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (!['GET', 'POST'].includes(req.method)) {
      return res.status(405).json({
        ok: false,
        error: 'METHOD_NOT_ALLOWED',
        expected: 'GET_OR_POST',
      });
    }

    const payload = await getPayload(req);

    const secret = String(payload.secret || '').trim();
    const expectedSecret = String(process.env.ADMIN_FLUSH_SECRET || '').trim();

    if (!expectedSecret) {
      return res.status(500).json({
        ok: false,
        error: 'ADMIN_FLUSH_SECRET_ENV_MISSING',
      });
    }

    if (!secret || secret !== expectedSecret) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
      });
    }

    const dryRun = asBool(payload.dryRun, true);
    const confirm = String(payload.confirm || '').trim();

    if (!dryRun && confirm !== CONFIRM_TEXT) {
      return res.status(400).json({
        ok: false,
        error: 'CONFIRM_REQUIRED',
        expected: `confirm=${CONFIRM_TEXT}`,
        dryRun,
      });
    }

    const strategyVersion =
      String(payload.strategyVersion || '').trim() || DEFAULT_STRATEGY_VERSION;

    const mode = String(payload.mode || 'all').trim().toLowerCase();
    const maxKeys = Math.max(50, Math.min(Number(payload.maxKeys) || 1000, 5000));

    const output = {
      ok: true,
      dryRun,
      mode,
      strategyVersion,
      runtime: null,
      analyze: null,
      latestScan: null,
      durationMs: null,
    };

    if (mode === 'all' || mode === 'runtime') {
      output.runtime = await resetRuntimeOpenPositions({
        strategyVersion,
        dryRun,
        maxKeys,
      });
    }

    if (mode === 'all' || mode === 'analyze') {
      output.analyze = await closeAnalyzeOpenEntries({
        strategyVersion,
        dryRun,
      });
    }

    if (mode === 'all' || mode === 'latest') {
      output.latestScan = await clearLatestScan({
        dryRun,
      });
    }

    output.durationMs = Date.now() - startedAt;

    return res.status(200).json(output);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      durationMs: Date.now() - startedAt,
    });
  }
}