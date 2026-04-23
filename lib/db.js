import { Pool } from "pg";

const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.NEON_DATABASE_URL ||
  "";

function shouldUseSSL(connectionString){
  if(!connectionString) return false;

  const lower = String(connectionString).toLowerCase();

  return !(
    lower.includes("localhost") ||
    lower.includes("127.0.0.1")
  );
}

let pool = null;
let initPromise = null;

function getPool(){

  if(pool) return pool;

  if(!CONNECTION_STRING){
    throw new Error(
      "Missing Postgres connection string. Set DATABASE_URL or POSTGRES_URL."
    );
  }

  pool = new Pool({
    connectionString: CONNECTION_STRING,
    ssl: shouldUseSSL(CONNECTION_STRING)
      ? { rejectUnauthorized: false }
      : false,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });

  return pool;
}

export function getDBMeta(){
  return {
    provider: "postgres",
    hasConnectionString: Boolean(CONNECTION_STRING)
  };
}

export async function query(text, params = []){

  const p = getPool();

  return p.query(text, params);
}

export async function ensureDB(){

  if(initPromise){
    return initPromise;
  }

  initPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS closed_trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        result TEXT NOT NULL,
        reason TEXT,
        grade TEXT,
        flow TEXT,
        sniper TEXT,
        ob_bias TEXT,
        regime TEXT,
        btc_state TEXT,
        score DOUBLE PRECISION DEFAULT 0,
        confluence DOUBLE PRECISION DEFAULT 0,
        rr DOUBLE PRECISION DEFAULT 0,
        pnl_pct DOUBLE PRECISION DEFAULT 0,
        entry_price DOUBLE PRECISION DEFAULT 0,
        exit_price DOUBLE PRECISION DEFAULT 0,
        sl DOUBLE PRECISION DEFAULT 0,
        tp DOUBLE PRECISION DEFAULT 0,
        funding DOUBLE PRECISION DEFAULT 0,
        grade_points DOUBLE PRECISION DEFAULT 0,
        recommended_risk TEXT,
        timestamp_ms BIGINT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_closed_trades_timestamp
      ON closed_trades(timestamp_ms DESC);

      CREATE INDEX IF NOT EXISTS idx_closed_trades_symbol_side
      ON closed_trades(symbol, side);

      CREATE TABLE IF NOT EXISTS system_logs (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        stage TEXT,
        grade TEXT,
        flow TEXT,
        sniper TEXT,
        ob_bias TEXT,
        regime TEXT,
        btc_state TEXT,
        score DOUBLE PRECISION DEFAULT 0,
        confluence DOUBLE PRECISION DEFAULT 0,
        rr DOUBLE PRECISION DEFAULT 0,
        price DOUBLE PRECISION DEFAULT 0,
        entry_price DOUBLE PRECISION DEFAULT 0,
        sl DOUBLE PRECISION DEFAULT 0,
        tp DOUBLE PRECISION DEFAULT 0,
        funding DOUBLE PRECISION DEFAULT 0,
        spread_pct DOUBLE PRECISION DEFAULT 0,
        depth_min_usd_1p DOUBLE PRECISION DEFAULT 0,
        grade_points DOUBLE PRECISION DEFAULT 0,
        recommended_risk TEXT,
        timestamp_ms BIGINT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp
      ON system_logs(timestamp_ms DESC);

      CREATE INDEX IF NOT EXISTS idx_system_logs_action
      ON system_logs(action);

      CREATE INDEX IF NOT EXISTS idx_system_logs_symbol_side
      ON system_logs(symbol, side);
    `);
  })();

  return initPromise;
}

export async function insertClosedTrade(row){

  await ensureDB();

  await query(
    `
      INSERT INTO closed_trades (
        id,
        symbol,
        side,
        result,
        reason,
        grade,
        flow,
        sniper,
        ob_bias,
        regime,
        btc_state,
        score,
        confluence,
        rr,
        pnl_pct,
        entry_price,
        exit_price,
        sl,
        tp,
        funding,
        grade_points,
        recommended_risk,
        timestamp_ms,
        payload
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24
      )
      ON CONFLICT (id) DO NOTHING
    `,
    [
      row.id,
      row.symbol,
      row.side,
      row.result,
      row.reason,
      row.grade,
      row.flow,
      row.sniper,
      row.obBias,
      row.regime,
      row.btcState,
      row.score,
      row.confluence,
      row.rr,
      row.pnlPct,
      row.entry,
      row.exit,
      row.sl,
      row.tp,
      row.funding,
      row.gradePoints,
      row.recommendedRisk,
      row.timestamp,
      JSON.stringify(row)
    ]
  );

  return row;
}

export async function insertSystemLog(row){

  await ensureDB();

  await query(
    `
      INSERT INTO system_logs (
        id,
        symbol,
        side,
        action,
        reason,
        stage,
        grade,
        flow,
        sniper,
        ob_bias,
        regime,
        btc_state,
        score,
        confluence,
        rr,
        price,
        entry_price,
        sl,
        tp,
        funding,
        spread_pct,
        depth_min_usd_1p,
        grade_points,
        recommended_risk,
        timestamp_ms,
        payload
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
        $23,$24,$25,$26
      )
      ON CONFLICT (id) DO NOTHING
    `,
    [
      row.id,
      row.symbol,
      row.side,
      row.action,
      row.reason,
      row.stage,
      row.grade,
      row.flow,
      row.sniper,
      row.obBias,
      row.regime,
      row.btcState,
      row.score,
      row.confluence,
      row.rr,
      row.price,
      row.entry,
      row.sl,
      row.tp,
      row.funding,
      row.spreadPct,
      row.depthMinUsd1p,
      row.gradePoints,
      row.recommendedRisk,
      row.timestamp,
      JSON.stringify(row)
    ]
  );

  return row;
}

export async function getClosedTrades(limit = null){

  await ensureDB();

  if(limit && Number(limit) > 0){
    const { rows } = await query(
      `
        SELECT payload
        FROM closed_trades
        ORDER BY timestamp_ms ASC
        LIMIT $1
      `,
      [Number(limit)]
    );

    return rows.map(r => r.payload);
  }

  const { rows } = await query(`
    SELECT payload
    FROM closed_trades
    ORDER BY timestamp_ms ASC
  `);

  return rows.map(r => r.payload);
}

export async function getSystemLogs(limit = null){

  await ensureDB();

  if(limit && Number(limit) > 0){
    const { rows } = await query(
      `
        SELECT payload
        FROM system_logs
        ORDER BY timestamp_ms ASC
        LIMIT $1
      `,
      [Number(limit)]
    );

    return rows.map(r => r.payload);
  }

  const { rows } = await query(`
    SELECT payload
    FROM system_logs
    ORDER BY timestamp_ms ASC
  `);

  return rows.map(r => r.payload);
}

export async function getAllLogs(limit = null){

  const [trades, system] = await Promise.all([
    getClosedTrades(limit),
    getSystemLogs(limit)
  ]);

  return [...trades, ...system].sort((a, b) => {
    return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
  });
}

export async function pruneClosedTrades(maxRows){

  await ensureDB();

  const limit = Number(maxRows || 0);

  if(limit <= 0) return;

  await query(
    `
      DELETE FROM closed_trades
      WHERE id IN (
        SELECT id
        FROM (
          SELECT id
          FROM closed_trades
          ORDER BY timestamp_ms DESC
          OFFSET $1
        ) x
      )
    `,
    [limit]
  );
}

export async function pruneSystemLogs(maxRows){

  await ensureDB();

  const limit = Number(maxRows || 0);

  if(limit <= 0) return;

  await query(
    `
      DELETE FROM system_logs
      WHERE id IN (
        SELECT id
        FROM (
          SELECT id
          FROM system_logs
          ORDER BY timestamp_ms DESC
          OFFSET $1
        ) x
      )
    `,
    [limit]
  );
}

export async function clearClosedTrades(){

  await ensureDB();
  await query(`DELETE FROM closed_trades`);
}

export async function clearSystemLogs(){

  await ensureDB();
  await query(`DELETE FROM system_logs`);
}

export async function clearAllLogs(){

  await ensureDB();

  await query(`
    DELETE FROM closed_trades;
    DELETE FROM system_logs;
  `);
}


// ================= COMPAT SHIMS =================
// Alleen voor oude code. Niet meer gebruiken voor nieuwe inserts.
export async function readDB(){
  return getAllLogs();
}

export async function writeDB(data){

  await clearAllLogs();

  const list = Array.isArray(data)
    ? data
    : [];

  for(const row of list){

    if(row?.logType === "SYSTEM"){
      await insertSystemLog(row);
    }else{
      await insertClosedTrade(row);
    }
  }

  return true;
}