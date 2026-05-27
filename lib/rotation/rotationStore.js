import fs from "fs/promises";
import path from "path";

const ROOT_DIR = process.cwd();
const ROTATION_DIR = path.join(ROOT_DIR, "data", "rotation");

const ACTIVE_FILE = path.join(ROTATION_DIR, "active-week.json");
const NEXT_FILE = path.join(ROTATION_DIR, "next-week.json");
const HISTORY_FILE = path.join(ROTATION_DIR, "history.json");

export const ROTATION_MODE = "WEEKLY_MICRO_CHAMPIONS";

const MS_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TS_STRATEGY_VERSION = "TS_V12_6_ROTATION_GATE";

const ROTATION_STORE_BACKEND = String(
  process.env.ROTATION_STORE_BACKEND || ""
).toLowerCase();

const TRADE_SYSTEM_STRATEGY_VERSION =
  process.env.TRADE_SYSTEM_STRATEGY_VERSION ||
  process.env.STRATEGY_VERSION ||
  DEFAULT_TS_STRATEGY_VERSION;

const ROTATION_KEY_PREFIX =
  process.env.WEEKLY_ROTATION_KEY_PREFIX ||
  `${TRADE_SYSTEM_STRATEGY_VERSION}:weekly_rotation`;

const ACTIVE_KEY = `${ROTATION_KEY_PREFIX}:active`;
const NEXT_KEY = `${ROTATION_KEY_PREFIX}:next`;
const HISTORY_KEY = `${ROTATION_KEY_PREFIX}:history`;
const BUILD_LOCK_KEY = `${ROTATION_KEY_PREFIX}:build_lock`;

const TS_CLOSED_META_KEY = `${TRADE_SYSTEM_STRATEGY_VERSION}:runtime:closed_trades:meta`;
const TS_CLOSED_CHUNK_PREFIX = `${TRADE_SYSTEM_STRATEGY_VERSION}:runtime:closed_trades:chunk:`;

const TS_SHADOW_META_KEY = `${TRADE_SYSTEM_STRATEGY_VERSION}:runtime:shadow_outcomes:meta`;
const TS_SHADOW_CHUNK_PREFIX = `${TRADE_SYSTEM_STRATEGY_VERSION}:runtime:shadow_outcomes:chunk:`;

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }

  return ["1", "true", "yes", "y", "on"].includes(String(raw).toLowerCase());
}

const AUTO_BUILD_ENABLED = envBool("WEEKLY_ROTATION_AUTO_BUILD", true);
const INCLUDE_REAL_OUTCOMES = envBool("WEEKLY_ROTATION_INCLUDE_REAL", true);
const INCLUDE_SHADOW_OUTCOMES = envBool("WEEKLY_ROTATION_INCLUDE_SHADOW", true);

const TOP_N_PER_SIDE = Math.max(1, envNumber("WEEKLY_ROTATION_TOP_N_PER_SIDE", 1));
const TOP_N_TOTAL = Math.max(0, envNumber("WEEKLY_ROTATION_TOP_N_TOTAL", 0));

const MIN_SAMPLE = Math.max(1, envNumber("WEEKLY_ROTATION_MIN_SAMPLE", 3));
const MIN_WINRATE = envNumber("WEEKLY_ROTATION_MIN_WINRATE", 0.5);
const MIN_AVG_R = envNumber("WEEKLY_ROTATION_MIN_AVG_R", 0);
const MIN_TOTAL_R = envNumber("WEEKLY_ROTATION_MIN_TOTAL_R", 0);
const MIN_PF = envNumber("WEEKLY_ROTATION_MIN_PF", 1);

const FALLBACK_TO_BEST_WHEN_NO_PASS = envBool(
  "WEEKLY_ROTATION_FALLBACK_TO_BEST_WHEN_NO_PASS",
  false
);

const AUTO_REBUILD_EMPTY = envBool("WEEKLY_ROTATION_AUTO_REBUILD_EMPTY", false);

function getRedisUrl() {
  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ""
  );
}

function getRedisToken() {
  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ""
  );
}

function hasRedis() {
  return Boolean(getRedisUrl() && getRedisToken());
}

function shouldUseRedis() {
  if (ROTATION_STORE_BACKEND === "file") return false;
  if (ROTATION_STORE_BACKEND === "redis") return true;

  return hasRedis();
}

async function redisCommand(command) {
  const url = getRedisUrl();
  const token = getRedisToken();

  if (!url || !token) {
    throw new Error("rotation_redis_env_missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const text = await res.text();

  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || json?.error) {
    throw new Error(
      json?.error ||
      text?.slice(0, 500) ||
      `rotation_redis_error_${res.status}`
    );
  }

  return json?.result;
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function redisGetJson(key, fallback = null) {
  const result = await redisCommand(["GET", key]);
  return safeJsonParse(result, fallback);
}

async function redisSetJson(key, payload) {
  const value = JSON.stringify({
    ...payload,
    updatedAt: new Date().toISOString()
  });

  await redisCommand(["SET", key, value]);

  return safeJsonParse(value, payload);
}

async function readJsonArrayChunks(metaKey, chunkPrefix) {
  if (!hasRedis()) return [];

  const meta = await redisGetJson(metaKey, null).catch(() => null);

  if (!meta || meta.strategyVersion !== TRADE_SYSTEM_STRATEGY_VERSION) {
    return [];
  }

  const chunkCount = Number(meta.chunks || 0);

  if (!chunkCount) return [];

  const reads = [];

  for (let i = 0; i < chunkCount; i++) {
    reads.push(
      redisGetJson(`${chunkPrefix}${i}`, [])
        .then(value => Array.isArray(value) ? value : [])
        .catch(() => [])
    );
  }

  const chunks = await Promise.all(reads);

  return chunks.flat().filter(Boolean);
}

async function ensureDir() {
  await fs.mkdir(ROTATION_DIR, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath, data) {
  await ensureDir();

  const now = new Date().toISOString();
  const payload = {
    ...data,
    updatedAt: now
  };

  const tmpPath = `${filePath}.tmp`;

  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);

  return payload;
}

async function readJson(filePath, fallback) {
  await ensureDir();

  const fileExists = await exists(filePath);

  if (!fileExists) {
    await writeJsonAtomic(filePath, fallback);
    return fallback;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readStoreJson({ redisKey, filePath, fallback }) {
  if (shouldUseRedis()) {
    const existing = await redisGetJson(redisKey, null).catch(() => null);

    if (!existing) {
      await redisSetJson(redisKey, fallback);
      return fallback;
    }

    return existing;
  }

  return readJson(filePath, fallback);
}

async function writeStoreJson({ redisKey, filePath, data }) {
  if (shouldUseRedis()) {
    return redisSetJson(redisKey, data);
  }

  return writeJsonAtomic(filePath, data);
}

export function getIsoWeekId(dateInput = new Date()) {
  const date = new Date(dateInput);
  const utcDate = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));

  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utcDate - yearStart) / MS_DAY + 1) / 7);

  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function getIsoWeekWindow(dateInput = new Date()) {
  const date = new Date(dateInput);
  const utcDate = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));

  const dayNum = utcDate.getUTCDay() || 7;
  const start = new Date(utcDate);
  start.setUTCDate(utcDate.getUTCDate() - dayNum + 1);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start.getTime() + 7 * MS_DAY);

  return {
    weekId: getIsoWeekId(start),
    start: start.toISOString(),
    end: end.toISOString(),
    startMs: start.getTime(),
    endMs: end.getTime()
  };
}

export function getPreviousIsoWeekWindow(dateInput = new Date()) {
  const current = getIsoWeekWindow(dateInput);
  const previousDate = new Date(current.startMs - 1);

  return getIsoWeekWindow(previousDate);
}

export function createEmptyRotation({
  rotationId = getIsoWeekId(),
  status = "EMPTY",
  sourceWindow = null,
  allowlist = [],
  meta = {}
} = {}) {
  const now = new Date().toISOString();

  const normalizedAllowlist = Array.isArray(allowlist)
    ? allowlist.map(normalizeAllowlistItem).filter(item => item.microFamilyId)
    : [];

  return {
    rotationId,
    createdAt: now,
    updatedAt: now,
    activatedAt: null,
    status,
    mode: ROTATION_MODE,
    sourceWindow,
    allowlist: normalizedAllowlist,
    meta: {
      ...meta,
      longCount: normalizedAllowlist.filter(item => item.side === "LONG").length,
      shortCount: normalizedAllowlist.filter(item => item.side === "SHORT").length,
      totalCount: normalizedAllowlist.length
    }
  };
}

function createEmptyHistory() {
  return {
    updatedAt: new Date().toISOString(),
    rotations: []
  };
}

export async function ensureRotationFiles() {
  if (shouldUseRedis()) {
    const active = await redisGetJson(ACTIVE_KEY, null).catch(() => null);
    const next = await redisGetJson(NEXT_KEY, null).catch(() => null);
    const history = await redisGetJson(HISTORY_KEY, null).catch(() => null);

    if (!active) {
      await redisSetJson(
        ACTIVE_KEY,
        createEmptyRotation({
          status: "NO_ACTIVE_ROTATION"
        })
      );
    }

    if (!next) {
      await redisSetJson(
        NEXT_KEY,
        createEmptyRotation({
          rotationId: getIsoWeekId(new Date(Date.now() + 7 * MS_DAY)),
          status: "NO_NEXT_ROTATION"
        })
      );
    }

    if (!history) {
      await redisSetJson(HISTORY_KEY, createEmptyHistory());
    }

    return true;
  }

  await ensureDir();

  if (!(await exists(ACTIVE_FILE))) {
    await writeJsonAtomic(
      ACTIVE_FILE,
      createEmptyRotation({
        status: "NO_ACTIVE_ROTATION"
      })
    );
  }

  if (!(await exists(NEXT_FILE))) {
    await writeJsonAtomic(
      NEXT_FILE,
      createEmptyRotation({
        rotationId: getIsoWeekId(new Date(Date.now() + 7 * MS_DAY)),
        status: "NO_NEXT_ROTATION"
      })
    );
  }

  if (!(await exists(HISTORY_FILE))) {
    await writeJsonAtomic(HISTORY_FILE, createEmptyHistory());
  }

  return true;
}

async function readActiveRotationRaw() {
  await ensureRotationFiles();

  return readStoreJson({
    redisKey: ACTIVE_KEY,
    filePath: ACTIVE_FILE,
    fallback: createEmptyRotation({
      status: "NO_ACTIVE_ROTATION"
    })
  });
}

async function readNextRotationRaw() {
  await ensureRotationFiles();

  return readStoreJson({
    redisKey: NEXT_KEY,
    filePath: NEXT_FILE,
    fallback: createEmptyRotation({
      rotationId: getIsoWeekId(new Date(Date.now() + 7 * MS_DAY)),
      status: "NO_NEXT_ROTATION"
    })
  });
}

async function readHistoryRaw() {
  await ensureRotationFiles();

  return readStoreJson({
    redisKey: HISTORY_KEY,
    filePath: HISTORY_FILE,
    fallback: createEmptyHistory()
  });
}

export async function loadActiveRotation(options = {}) {
  if (options.autoBuild === false || !AUTO_BUILD_ENABLED) {
    const raw = await readActiveRotationRaw();
    return normalizeRotation(raw);
  }

  return ensureCurrentWeekActiveRotation(options);
}

export async function loadNextRotation() {
  const raw = await readNextRotationRaw();
  return normalizeRotation(raw);
}

export async function loadRotationHistory() {
  const raw = await readHistoryRaw();

  return {
    updatedAt: raw?.updatedAt || new Date().toISOString(),
    rotations: Array.isArray(raw?.rotations) ? raw.rotations : []
  };
}

export async function saveActiveRotation(rotation) {
  if (!rotation || typeof rotation !== "object") {
    throw new Error("saveActiveRotation: rotation object missing");
  }

  const normalized = normalizeRotation(rotation);

  return writeStoreJson({
    redisKey: ACTIVE_KEY,
    filePath: ACTIVE_FILE,
    data: normalized
  });
}

export async function saveNextRotation(rotation) {
  if (!rotation || typeof rotation !== "object") {
    throw new Error("saveNextRotation: rotation object missing");
  }

  const normalized = normalizeRotation(rotation);

  return writeStoreJson({
    redisKey: NEXT_KEY,
    filePath: NEXT_FILE,
    data: normalized
  });
}

export async function saveRotationHistory(history) {
  if (!history || typeof history !== "object") {
    throw new Error("saveRotationHistory: history object missing");
  }

  const safeHistory = {
    updatedAt: new Date().toISOString(),
    rotations: Array.isArray(history.rotations) ? history.rotations : []
  };

  return writeStoreJson({
    redisKey: HISTORY_KEY,
    filePath: HISTORY_FILE,
    data: safeHistory
  });
}

export async function appendRotationHistory(rotation, extra = {}) {
  const history = await loadRotationHistory();

  const record = {
    ...rotation,
    ...extra,
    archivedAt: new Date().toISOString()
  };

  const nextHistory = {
    updatedAt: new Date().toISOString(),
    rotations: [record, ...(history.rotations || [])].slice(0, 104)
  };

  await saveRotationHistory(nextHistory);

  return record;
}

export async function promoteNextRotationToActive() {
  const active = await loadActiveRotation({ autoBuild: false });
  const next = await loadNextRotation();

  if (!Array.isArray(next.allowlist) || next.allowlist.length === 0) {
    return {
      promoted: false,
      reason: "NEXT_ROTATION_EMPTY",
      active,
      next
    };
  }

  await appendRotationHistory(active, {
    replacedBy: next.rotationId
  });

  const promoted = normalizeRotation({
    ...next,
    status: "ACTIVE",
    activatedAt: new Date().toISOString()
  });

  await saveActiveRotation(promoted);

  const freshNext = createEmptyRotation({
    rotationId: getIsoWeekId(new Date(Date.now() + 7 * MS_DAY)),
    status: "NO_NEXT_ROTATION"
  });

  await saveNextRotation(freshNext);

  return {
    promoted: true,
    reason: "NEXT_ROTATION_PROMOTED",
    active: promoted,
    next: freshNext
  };
}

export async function clearActiveRotation(reason = "MANUAL_CLEAR") {
  const active = await loadActiveRotation({ autoBuild: false });

  await appendRotationHistory(active, {
    cleared: true,
    clearReason: reason
  });

  const empty = createEmptyRotation({
    rotationId: getIsoWeekId(),
    status: "NO_ACTIVE_ROTATION"
  });

  await saveActiveRotation(empty);

  return empty;
}

export function normalizeRotationSide(side) {
  const value = String(side || "").trim().toUpperCase();

  if (value === "BULL" || value === "LONG") return "LONG";
  if (value === "BEAR" || value === "SHORT") return "SHORT";

  return value === "SHORT" ? "SHORT" : "LONG";
}

function normalizeFamilySide(side) {
  const value = String(side || "").trim().toLowerCase();

  if (value === "long") return "bull";
  if (value === "short") return "bear";
  if (value === "bull" || value === "bear") return value;

  return "unknown";
}

export function normalizeAllowlistItem(item) {
  const microFamilyId = String(
    item?.microFamilyId ||
    item?.familyId ||
    item?.cohortKey ||
    ""
  ).trim();

  const side = normalizeRotationSide(item?.side || item?.tradeSide || item?.rotationSide);

  return {
    microFamilyId,
    familyId: microFamilyId,
    parentFamilyId: item?.parentFamilyId || item?.parent || null,
    side,
    tradeSide: side,
    status: item?.status || "ACTIVE",

    closed: Number(item?.closed || item?.sample || item?.completed || 0),
    wins: Number(item?.wins || 0),
    losses: Number(item?.losses || 0),

    winrate: Number(item?.winrate || item?.winrateNum || 0),
    avgR: Number(item?.avgR || 0),
    totalR: Number(item?.totalR || 0),
    pf: Number(item?.pf || item?.profitFactorR || 0),
    score: Number(item?.score || item?.rotationScore || 0),

    sourceWeekId: item?.sourceWeekId || null,
    sourceWindow: item?.sourceWindow || null,

    definition: Array.isArray(item?.definition)
      ? item.definition
      : typeof item?.definition === "string"
        ? item.definition.split("|").map(part => part.trim()).filter(Boolean)
        : microFamilyId.split("|").map(part => part.trim()).filter(Boolean),

    examples: Array.isArray(item?.examples) ? item.examples.slice(0, 12) : [],

    selectedAt: item?.selectedAt || new Date().toISOString()
  };
}

export function normalizeRotation(rotation) {
  const allowlist = Array.isArray(rotation?.allowlist)
    ? rotation.allowlist
        .filter(Boolean)
        .map(normalizeAllowlistItem)
        .filter(item => item.microFamilyId)
    : [];

  return {
    rotationId: rotation?.rotationId || getIsoWeekId(),
    createdAt: rotation?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activatedAt: rotation?.activatedAt || null,
    status: rotation?.status || "READY",
    mode: rotation?.mode || ROTATION_MODE,
    sourceWindow: rotation?.sourceWindow || null,
    allowlist,
    meta: {
      ...(rotation?.meta || {}),
      longCount: allowlist.filter(item => item.side === "LONG").length,
      shortCount: allowlist.filter(item => item.side === "SHORT").length,
      totalCount: allowlist.length
    }
  };
}

export function getActiveMicroFamilyIds(rotation, side = null) {
  if (!rotation || !Array.isArray(rotation.allowlist)) return [];

  const normalizedSide = side ? normalizeRotationSide(side) : null;

  return rotation.allowlist
    .filter(item => String(item.status || "ACTIVE").toUpperCase() === "ACTIVE")
    .filter(item => !normalizedSide || item.side === normalizedSide)
    .map(item => item.microFamilyId)
    .filter(Boolean);
}

export function isMicroFamilyActive(rotation, microFamilyId, side = null) {
  if (!rotation || !microFamilyId) return false;
  if (!Array.isArray(rotation.allowlist)) return false;

  const normalizedSide = side ? normalizeRotationSide(side) : null;
  const familyId = String(microFamilyId || "").trim();

  return rotation.allowlist.some(item => {
    if (String(item.status || "ACTIVE").toUpperCase() !== "ACTIVE") return false;
    if (item.microFamilyId !== familyId && item.familyId !== familyId) return false;
    if (normalizedSide && item.side !== normalizedSide) return false;

    return true;
  });
}

function roundNumber(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bucketByStep(value, step, label, decimals = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) return `${label}_NA`;

  const lower = Math.floor(n / step) * step;
  const upper = lower + step;

  return String(`${label}_${lower.toFixed(decimals)}_${upper.toFixed(decimals)}`)
    .replace(/\./g, "p")
    .replace(/-/g, "m")
    .replace(/\s+/g, "_")
    .toUpperCase();
}

function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);

  if (!Number.isFinite(s) || s < 0) return 0.001;
  if (s > 0.05) s = s / 100;

  return s;
}

function bucketDepthUsd(depth) {
  const d = Number(depth || 0);

  if (d < 10000) return "DEPTH_LT_10K";
  if (d < 50000) return "DEPTH_10K_50K";
  if (d < 100000) return "DEPTH_50K_100K";
  if (d < 200000) return "DEPTH_100K_200K";
  if (d < 500000) return "DEPTH_200K_500K";

  return "DEPTH_GT_500K";
}

function bucketSpreadPct(spreadPct) {
  const bps = normalizeSpread(spreadPct) * 10000;

  if (bps < 8) return "SPREAD_LT_8BPS";
  if (bps < 12) return "SPREAD_8_12BPS";
  if (bps < 16) return "SPREAD_12_16BPS";
  if (bps < 22) return "SPREAD_16_22BPS";
  if (bps < 30) return "SPREAD_22_30BPS";

  return "SPREAD_GT_30BPS";
}

function bucketFunding(rate) {
  const r = Number(rate || 0);

  if (r <= -0.015) return "FUNDING_NEG_EXTREME";
  if (r <= -0.008) return "FUNDING_NEG_HIGH";
  if (r < -0.002) return "FUNDING_NEG";
  if (r <= 0.002) return "FUNDING_NEUTRAL";
  if (r < 0.008) return "FUNDING_POS";
  if (r < 0.015) return "FUNDING_POS_HIGH";

  return "FUNDING_POS_EXTREME";
}

function getObSideRelation(side, obBias) {
  const s = normalizeFamilySide(side);
  const ob = String(obBias || "NEUTRAL").toUpperCase();

  if (ob === "NEUTRAL" || ob === "UNKNOWN") return "NEUTRAL";

  if (
    (s === "bull" && ob === "BULLISH") ||
    (s === "bear" && ob === "BEARISH")
  ) {
    return "WITH";
  }

  if (
    (s === "bull" && ob === "BEARISH") ||
    (s === "bear" && ob === "BULLISH")
  ) {
    return "AGAINST";
  }

  return "NEUTRAL";
}

function getFeatureCohortKeys(row) {
  const side = normalizeFamilySide(row?.side || row?.tradeSide || row?.rotationSide);
  const setup = String(row?.setupClass || "NONE").toUpperCase();
  const reason = String(row?.entryReason || row?.reason || "UNKNOWN").toUpperCase();
  const rsiZone = String(row?.rsiZone || "UNKNOWN").toUpperCase();
  const btc = String(row?.btcState || "UNKNOWN").toUpperCase();
  const flow = String(row?.flow || "UNKNOWN").toUpperCase();
  const regime = String(row?.regime || "UNKNOWN").toUpperCase();
  const ob = String(row?.obBias || "UNKNOWN").toUpperCase();
  const obRel = getObSideRelation(side, ob);

  const confluence = safeNumber(row?.confluence, 0);
  const sniperScore = safeNumber(row?.sniperScore, 0);
  const score = safeNumber(row?.score ?? row?.moveScore, 0);
  const plannedRR = safeNumber(row?.plannedRR ?? row?.rr ?? row?.baseRR, 0);
  const finalRr = safeNumber(row?.finalRr ?? row?.plannedRR ?? row?.rr, plannedRR);
  const tfStrength = safeNumber(row?.tfStrength, 0);
  const rsi = safeNumber(row?.rsi, 0);
  const funding = safeNumber(row?.funding, 0);
  const spreadPct = normalizeSpread(row?.spreadPct);
  const depthMinUsd1p = safeNumber(row?.depthMinUsd1p, 0);

  const confBucket = bucketByStep(confluence, 5, "CONF", 0);
  const sniperBucket = bucketByStep(sniperScore, 5, "SNIPER", 0);
  const scoreBucket = bucketByStep(score, 5, "SCORE", 0);
  const rrBucket = bucketByStep(plannedRR, 0.25, "RR", 2);
  const finalRrBucket = bucketByStep(finalRr, 0.25, "FINAL_RR", 2);
  const tfBucket = bucketByStep(tfStrength, 0.5, "TF", 1);
  const rsiValueBucket = bucketByStep(rsi, 5, "RSI", 0);
  const spreadBucket = bucketSpreadPct(spreadPct);
  const depthBucket = bucketDepthUsd(depthMinUsd1p);
  const fundingBucket = bucketFunding(funding);

  return Array.from(new Set([
    `SETUP=${setup}|SIDE=${side}|RSI=${rsiZone}|OB_REL=${obRel}|BTC=${btc}`,
    `REASON=${reason}|SIDE=${side}|RSI=${rsiZone}|BTC=${btc}`,
    `CONF=${confBucket}|SNIPER=${sniperBucket}|RR=${rrBucket}|RSI=${rsiZone}`,
    `SIDE=${side}|FLOW=${flow}|RSI=${rsiZone}|CONF=${confBucket}`,
    `OB=${ob}|OB_REL=${obRel}|SPREAD=${spreadBucket}|DEPTH=${depthBucket}|SIDE=${side}`,
    `TF=${tfBucket}|REGIME=${regime}|FLOW=${flow}|SIDE=${side}`,
    `FUNDING=${fundingBucket}|SIDE=${side}|BTC=${btc}`,
    `SCORE=${scoreBucket}|CONF=${confBucket}|SNIPER=${sniperBucket}`,
    `FINAL_RR=${finalRrBucket}|SIDE=${side}|RSI=${rsiZone}`,
    `RSI_VALUE=${rsiValueBucket}|SIDE=${side}|FLOW=${flow}`
  ]));
}

function getExplicitFamilyIds(row) {
  const raw = [
    ...(Array.isArray(row?.microFamilyIds) ? row.microFamilyIds : []),
    ...(Array.isArray(row?.familyIds) ? row.familyIds : []),
    ...(Array.isArray(row?.microFamilies) ? row.microFamilies : []),
    ...(Array.isArray(row?.families) ? row.families : []),
    row?.microFamilyId,
    row?.familyId,
    row?.cohortKey
  ];

  return raw
    .map(value => String(value || "").trim())
    .filter(Boolean);
}

function getOutcomeFamilyIds(row) {
  return Array.from(new Set([
    ...getExplicitFamilyIds(row),
    ...getFeatureCohortKeys(row)
  ])).filter(Boolean);
}

function getOutcomeTimestamp(row) {
  return safeNumber(
    row?.completedAt ??
    row?.exitedAt ??
    row?.closedAt ??
    row?.exitAt ??
    row?.exitTs ??
    row?.createdAt ??
    row?.ts,
    0
  );
}

function getOutcomeExitR(row) {
  const value =
    row?.exitR ??
    row?.realizedR ??
    row?.pnlR ??
    row?.resultR ??
    row?.outcomeR ??
    row?.rMultiple;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isCompletedOutcome(row) {
  if (!row) return false;

  const status = String(row?.status || "").toUpperCase();
  if (status === "OPEN") return false;

  return Number.isFinite(Number(getOutcomeExitR(row)));
}

async function loadTradeSystemOutcomeRows() {
  if (!hasRedis()) {
    return {
      rows: [],
      source: "NO_REDIS"
    };
  }

  const [closedTrades, shadowOutcomes] = await Promise.all([
    INCLUDE_REAL_OUTCOMES
      ? readJsonArrayChunks(TS_CLOSED_META_KEY, TS_CLOSED_CHUNK_PREFIX)
      : Promise.resolve([]),

    INCLUDE_SHADOW_OUTCOMES
      ? readJsonArrayChunks(TS_SHADOW_META_KEY, TS_SHADOW_CHUNK_PREFIX)
      : Promise.resolve([])
  ]);

  const realRows = closedTrades.map(row => ({
    ...row,
    source: "REAL"
  }));

  const shadowRows = shadowOutcomes
    .filter(row => String(row?.status || "OPEN").toUpperCase() !== "OPEN")
    .map(row => ({
      ...row,
      source: String(row?.source || "SHADOW").toUpperCase()
    }));

  return {
    rows: [...realRows, ...shadowRows].filter(isCompletedOutcome),
    source: "REDIS_SPLIT_RUNTIME",
    counts: {
      realRows: realRows.length,
      shadowRows: shadowRows.length
    }
  };
}

function getProfitFactor(grossWinR, grossLossRAbs) {
  if (!grossLossRAbs) {
    return grossWinR > 0 ? 999 : 0;
  }

  return grossWinR / grossLossRAbs;
}

function scoreFamilyStats(stats) {
  const closed = safeNumber(stats.closed, 0);
  const winrate = safeNumber(stats.winrate, 0);
  const avgR = safeNumber(stats.avgR, 0);
  const totalR = safeNumber(stats.totalR, 0);
  const pf = Math.min(safeNumber(stats.pf, 0), 5);
  const sampleFactor = Math.min(closed / Math.max(1, MIN_SAMPLE), 3);

  const raw =
    winrate * 40 +
    avgR * 35 +
    totalR * 4 +
    pf * 6 +
    sampleFactor * 5;

  return roundNumber(raw, 4);
}

function buildMicroFamilyStats(rows, sourceWindow) {
  const startMs = Number(sourceWindow.startMs || 0);
  const endMs = Number(sourceWindow.endMs || 0);

  const map = new Map();

  for (const row of rows) {
    const ts = getOutcomeTimestamp(row);

    if (!ts || ts < startMs || ts >= endMs) {
      continue;
    }

    const side = normalizeRotationSide(row?.rotationSide || row?.tradeSide || row?.side);
    const familyIds = getOutcomeFamilyIds(row);
    const exitR = getOutcomeExitR(row);
    const pnlPct = safeNumber(row?.pnlPct, 0);
    const symbol = String(row?.symbol || "UNKNOWN").toUpperCase();

    if (!Number.isFinite(exitR)) continue;
    if (!familyIds.length) continue;

    for (const familyId of familyIds) {
      const key = `${side}|${familyId}`;

      if (!map.has(key)) {
        map.set(key, {
          microFamilyId: familyId,
          familyId,
          side,
          tradeSide: side,
          sourceWeekId: sourceWindow.weekId,
          sourceWindow: {
            weekId: sourceWindow.weekId,
            start: sourceWindow.start,
            end: sourceWindow.end
          },

          closed: 0,
          wins: 0,
          losses: 0,
          flats: 0,

          totalR: 0,
          grossWinR: 0,
          grossLossRAbs: 0,
          totalPnlPct: 0,

          avgR: 0,
          winrate: 0,
          pf: 0,
          score: 0,

          definition: familyId.split("|").map(part => part.trim()).filter(Boolean),
          examples: []
        });
      }

      const stats = map.get(key);

      stats.closed++;
      stats.totalR += exitR;
      stats.totalPnlPct += pnlPct;

      if (exitR > 0) {
        stats.wins++;
        stats.grossWinR += exitR;
      } else if (exitR < 0) {
        stats.losses++;
        stats.grossLossRAbs += Math.abs(exitR);
      } else {
        stats.flats++;
      }

      if (stats.examples.length < 12) {
        stats.examples.push({
          source: row.source || "UNKNOWN",
          symbol,
          exitR: roundNumber(exitR, 3),
          pnlPct: roundNumber(pnlPct, 3),
          setupClass: row.setupClass || null,
          reason: row.entryReason || row.reason || null,
          rsiZone: row.rsiZone || null,
          obBias: row.obBias || null,
          btcState: row.btcState || null
        });
      }
    }
  }

  return Array.from(map.values())
    .map(stats => {
      const completed = stats.wins + stats.losses;

      stats.totalR = roundNumber(stats.totalR, 4);
      stats.totalPnlPct = roundNumber(stats.totalPnlPct, 4);
      stats.avgR = stats.closed ? roundNumber(stats.totalR / stats.closed, 4) : 0;
      stats.winrate = completed ? roundNumber(stats.wins / completed, 4) : 0;
      stats.pf = roundNumber(getProfitFactor(stats.grossWinR, stats.grossLossRAbs), 4);
      stats.score = scoreFamilyStats(stats);

      delete stats.grossWinR;
      delete stats.grossLossRAbs;

      return stats;
    })
    .sort((a, b) => b.score - a.score);
}

function passesRotationThresholds(stats) {
  if (safeNumber(stats.closed, 0) < MIN_SAMPLE) return false;
  if (safeNumber(stats.winrate, 0) < MIN_WINRATE) return false;
  if (safeNumber(stats.avgR, 0) < MIN_AVG_R) return false;
  if (safeNumber(stats.totalR, 0) < MIN_TOTAL_R) return false;
  if (safeNumber(stats.pf, 0) < MIN_PF) return false;

  return true;
}

function selectBestFamilies(familyStats) {
  const withSample = familyStats
    .filter(row => safeNumber(row.closed, 0) >= MIN_SAMPLE)
    .sort((a, b) => b.score - a.score);

  let eligible = withSample.filter(passesRotationThresholds);

  if (!eligible.length && FALLBACK_TO_BEST_WHEN_NO_PASS) {
    eligible = withSample;
  }

  if (TOP_N_TOTAL > 0) {
    return eligible.slice(0, TOP_N_TOTAL);
  }

  const longs = eligible
    .filter(row => row.side === "LONG")
    .slice(0, TOP_N_PER_SIDE);

  const shorts = eligible
    .filter(row => row.side === "SHORT")
    .slice(0, TOP_N_PER_SIDE);

  return [...longs, ...shorts].sort((a, b) => b.score - a.score);
}

async function acquireBuildLock(owner) {
  if (!shouldUseRedis() || !hasRedis()) return true;

  const result = await redisCommand([
    "SET",
    BUILD_LOCK_KEY,
    owner,
    "NX",
    "PX",
    60_000
  ]).catch(() => null);

  return result === "OK";
}

async function releaseBuildLock(owner) {
  if (!shouldUseRedis() || !hasRedis()) return false;

  try {
    const currentOwner = await redisCommand(["GET", BUILD_LOCK_KEY]);

    if (currentOwner === owner) {
      await redisCommand(["DEL", BUILD_LOCK_KEY]);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export async function buildRotationFromPreviousWeek(options = {}) {
  const date = options.date ? new Date(options.date) : new Date();
  const sourceWindow = getPreviousIsoWeekWindow(date);
  const targetWeek = getIsoWeekWindow(date);
  const buildId = `rotation_build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const lockOk = await acquireBuildLock(buildId);

  if (!lockOk) {
    const active = await loadActiveRotation({ autoBuild: false });

    return {
      built: false,
      reason: "BUILD_LOCK_BUSY",
      rotation: active,
      sourceWindow,
      selected: [],
      candidates: []
    };
  }

  try {
    const outcomeLoad = await loadTradeSystemOutcomeRows();
    const familyStats = buildMicroFamilyStats(outcomeLoad.rows, sourceWindow);
    const selected = selectBestFamilies(familyStats);

    const allowlist = selected.map(row => normalizeAllowlistItem({
      ...row,
      status: "ACTIVE",
      selectedAt: new Date().toISOString()
    }));

    const status = allowlist.length
      ? "ACTIVE"
      : "NO_ELIGIBLE_PREVIOUS_WEEK_FAMILIES";

    const rotation = normalizeRotation({
      rotationId: targetWeek.weekId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activatedAt: options.activate === true ? new Date().toISOString() : null,
      status,
      mode: ROTATION_MODE,
      sourceWindow: {
        weekId: sourceWindow.weekId,
        start: sourceWindow.start,
        end: sourceWindow.end
      },
      allowlist,
      meta: {
        buildId,
        builtAt: new Date().toISOString(),
        targetWeekId: targetWeek.weekId,
        sourceWeekId: sourceWindow.weekId,

        backend: shouldUseRedis() ? "redis" : "file",
        outcomeSource: outcomeLoad.source,
        outcomeCounts: outcomeLoad.counts || {},

        totalOutcomeRowsLoaded: outcomeLoad.rows.length,
        candidateFamilies: familyStats.length,
        eligibleFamilies: familyStats.filter(passesRotationThresholds).length,
        selectedFamilies: allowlist.length,

        selection: {
          topNPerSide: TOP_N_PER_SIDE,
          topNTotal: TOP_N_TOTAL,
          minSample: MIN_SAMPLE,
          minWinrate: MIN_WINRATE,
          minAvgR: MIN_AVG_R,
          minTotalR: MIN_TOTAL_R,
          minPf: MIN_PF,
          fallbackToBestWhenNoPass: FALLBACK_TO_BEST_WHEN_NO_PASS
        },

        topCandidates: familyStats.slice(0, 25)
      }
    });

    if (options.activate === true) {
      const previousActive = await loadActiveRotation({ autoBuild: false });

      if (
        previousActive &&
        previousActive.rotationId !== rotation.rotationId &&
        Array.isArray(previousActive.allowlist) &&
        previousActive.allowlist.length > 0
      ) {
        await appendRotationHistory(previousActive, {
          replacedBy: rotation.rotationId,
          replaceReason: "AUTO_PREVIOUS_WEEK_MICRO_FAMILY_SELECTION"
        });
      }

      await saveActiveRotation(rotation);
    } else if (options.saveNext === true) {
      await saveNextRotation(rotation);
    }

    return {
      built: true,
      reason: allowlist.length
        ? "PREVIOUS_WEEK_BEST_MICRO_FAMILIES_SELECTED"
        : "NO_ELIGIBLE_PREVIOUS_WEEK_FAMILIES",
      rotation,
      sourceWindow,
      selected,
      candidates: familyStats
    };
  } finally {
    await releaseBuildLock(buildId);
  }
}

export async function ensureCurrentWeekActiveRotation(options = {}) {
  const date = options.date ? new Date(options.date) : new Date();
  const currentWeekId = getIsoWeekId(date);

  const active = normalizeRotation(await readActiveRotationRaw());
  const activeStatus = String(active.status || "").toUpperCase();
  const activeHasAllowlist = Array.isArray(active.allowlist) && active.allowlist.length > 0;

  const currentActiveOk =
    active.rotationId === currentWeekId &&
    activeStatus === "ACTIVE" &&
    activeHasAllowlist;

  const currentEmptyAlreadyBuilt =
    active.rotationId === currentWeekId &&
    activeStatus === "NO_ELIGIBLE_PREVIOUS_WEEK_FAMILIES" &&
    !AUTO_REBUILD_EMPTY;

  if (currentActiveOk || currentEmptyAlreadyBuilt) {
    return active;
  }

  const result = await buildRotationFromPreviousWeek({
    date,
    activate: true
  });

  return result.rotation;
}

export async function rebuildActiveRotationFromPreviousWeek(options = {}) {
  const result = await buildRotationFromPreviousWeek({
    ...options,
    activate: true
  });

  return result.rotation;
}

export async function buildNextRotationFromPreviousWeek(options = {}) {
  const result = await buildRotationFromPreviousWeek({
    ...options,
    saveNext: true,
    activate: false
  });

  return result.rotation;
}

export async function getRotationDebugSnapshot() {
  const [active, next, history] = await Promise.all([
    loadActiveRotation({ autoBuild: false }),
    loadNextRotation(),
    loadRotationHistory()
  ]);

  return {
    mode: ROTATION_MODE,
    strategyVersion: TRADE_SYSTEM_STRATEGY_VERSION,
    backend: shouldUseRedis() ? "redis" : "file",
    redisAvailable: hasRedis(),

    keys: {
      active: shouldUseRedis() ? ACTIVE_KEY : ACTIVE_FILE,
      next: shouldUseRedis() ? NEXT_KEY : NEXT_FILE,
      history: shouldUseRedis() ? HISTORY_KEY : HISTORY_FILE,
      closedTradesMeta: TS_CLOSED_META_KEY,
      shadowOutcomesMeta: TS_SHADOW_META_KEY
    },

    selection: {
      autoBuildEnabled: AUTO_BUILD_ENABLED,
      includeRealOutcomes: INCLUDE_REAL_OUTCOMES,
      includeShadowOutcomes: INCLUDE_SHADOW_OUTCOMES,
      topNPerSide: TOP_N_PER_SIDE,
      topNTotal: TOP_N_TOTAL,
      minSample: MIN_SAMPLE,
      minWinrate: MIN_WINRATE,
      minAvgR: MIN_AVG_R,
      minTotalR: MIN_TOTAL_R,
      minPf: MIN_PF,
      fallbackToBestWhenNoPass: FALLBACK_TO_BEST_WHEN_NO_PASS
    },

    active,
    next,
    historyCount: history.rotations.length,
    ts: Date.now()
  };
}

// Compatibility exports expected by rotationTradeAdapter.js variants.
export async function loadRotationStatus() {
  return loadActiveRotation();
}

export async function getRotationStatus() {
  return loadActiveRotation();
}

export async function readRotationStatus() {
  return loadActiveRotation();
}

export async function loadWeeklyRotationStatus() {
  return loadActiveRotation();
}

export async function getWeeklyRotationStatus() {
  return loadActiveRotation();
}

export async function readWeeklyRotationStatus() {
  return loadActiveRotation();
}

export async function loadActiveRotationStatus() {
  return loadActiveRotation();
}

export async function getActiveRotationStatus() {
  return loadActiveRotation();
}

export async function loadRotationState() {
  const [active, next, history] = await Promise.all([
    loadActiveRotation(),
    loadNextRotation(),
    loadRotationHistory()
  ]);

  return {
    active,
    next,
    history,
    status: active?.status || "UNKNOWN",
    rotationId: active?.rotationId || null,
    activeRotationId: active?.rotationId || null
  };
}

export async function getRotationState() {
  return loadRotationState();
}

export async function readRotationState() {
  return loadRotationState();
}

export const rotationPaths = {
  dir: ROTATION_DIR,
  active: ACTIVE_FILE,
  next: NEXT_FILE,
  history: HISTORY_FILE,

  redis: {
    active: ACTIVE_KEY,
    next: NEXT_KEY,
    history: HISTORY_KEY,
    buildLock: BUILD_LOCK_KEY
  },

  tradeSystemRuntime: {
    strategyVersion: TRADE_SYSTEM_STRATEGY_VERSION,
    closedMeta: TS_CLOSED_META_KEY,
    closedChunkPrefix: TS_CLOSED_CHUNK_PREFIX,
    shadowMeta: TS_SHADOW_META_KEY,
    shadowChunkPrefix: TS_SHADOW_CHUNK_PREFIX
  }
};