// Zero-dependency PostgreSQL access: shells out to the psql CLI (execFile, so no
// shell interpolation risk) and parses --csv output. SQL literals are escaped by
// `lit()` below rather than passed through a shell string, so this is safe against
// injection from the values this app itself constructs.
import { execFile } from "node:child_process";
import { parseCsv } from "./csv.js";

const PG = {
  host: process.env.PGHOST || "localhost",
  port: process.env.PGPORT || "5432",
  user: process.env.PGUSER || "pgledger",
  database: process.env.PGDATABASE || "pgledger",
  password: process.env.PGPASSWORD || "pgledger_dev_pw",
};

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

export function query(sql) {
  return new Promise((resolve, reject) => {
    execFile(
      "psql",
      ["-h", PG.host, "-p", PG.port, "-U", PG.user, "-d", PG.database, "-X", "-v", "ON_ERROR_STOP=1", "--csv", "-c", sql],
      { env: { ...process.env, PGPASSWORD: PG.password }, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(stderr || err.message)); return; }
        resolve(parseCsv(stdout));
      }
    );
  });
}

export async function one(sql) {
  const rows = await query(sql);
  return rows[0] || null;
}

// Run several statements as a single transaction (all-or-nothing).
export function tx(sql) {
  return query(`BEGIN;\n${sql}\nCOMMIT;`);
}
