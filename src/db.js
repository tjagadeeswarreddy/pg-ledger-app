// PostgreSQL access via a pooled `pg` client instead of shelling out to psql
// per query. Every column comes back as the raw text the server sends — same
// as psql's default output — never pg's auto-parsed JS types (numbers as JS
// numbers, dates as Date objects, etc). That keeps this drop-in for every
// existing call site: callers already do `Number(row.foo)` and rely on
// hasValue()'s '' / NULL blur, exactly as psql --csv produced.
import pg from "pg";

const { Pool } = pg;

const PG = {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || "pgledger",
  database: process.env.PGDATABASE || "pgledger",
  password: process.env.PGPASSWORD || "pgledger_dev_pw",
};

// Disable pg's type parsing entirely — every column value comes back as the
// raw wire-protocol text (identical to what psql's text/--csv output shows,
// since both come from the server's own text output functions).
const rawTextTypes = { getTypeParser: () => (value) => value };

const pool = new Pool({ ...PG, types: rawTextTypes, max: 10, idleTimeoutMillis: 30000 });

// An idle pooled client can emit an error (e.g. the server restarting) after
// its query has already resolved. Without this handler that crashes the
// whole process; log it instead and let the pool recycle the connection.
pool.on("error", (err) => {
  console.error("[db] unexpected error on idle client", err);
});

// psql's --csv output can't be told apart from an actual empty string once parsed —
// a NULL column and a column holding '' both come back as "". So "was this ever
// set?" has to mean "is it non-null AND non-empty", everywhere in this app that
// checks an optional column (original_amount, waived_reason, etc.) rather than
// just displaying it. Use this instead of `!== null` for that kind of check.
export function hasValue(v) {
  return v !== null && v !== undefined && v !== "";
}

export function lit(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in SQL literal");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  // Dates, strings, everything else: quote as a SQL string literal.
  const s = String(value);
  return "'" + s.replace(/'/g, "''") + "'";
}

// Match psql --csv's NULL-becomes-empty-string behavior so every existing
// caller (hasValue, `row.x || fallback`, etc.) keeps working unchanged.
function normalizeRow(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    out[k] = row[k] === null ? "" : row[k];
  }
  return out;
}

export async function query(sql) {
  const result = await pool.query(sql);
  return result.rows.map(normalizeRow);
}

export async function one(sql) {
  const rows = await query(sql);
  return rows[0] || null;
}

// Run several statements as a single transaction (all-or-nothing). Grabs a
// dedicated client so BEGIN/COMMIT land on the same connection.
export async function tx(sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(sql);
    await client.query("COMMIT");
    return result.rows ? result.rows.map(normalizeRow) : [];
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection is already dead / transaction already aborted — nothing more to do
    }
    throw err;
  } finally {
    client.release();
  }
}
