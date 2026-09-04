import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "schema.sql"), "utf8");

const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);

for (const stmt of statements) {
  await query(stmt + ";");
}
console.log(`Migrated: ${statements.length} statements applied.`);
