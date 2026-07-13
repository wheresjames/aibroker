import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@aibroker/core";
import { createPool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "migrations");

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = createPool(connectionString);
  try {
    await pool.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const existing = await pool.query("select 1 from schema_migrations where id = $1", [file]);
      if (existing.rowCount) continue;
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await pool.query("begin");
      try {
        await pool.query(sql);
        await pool.query("insert into schema_migrations (id) values ($1)", [file]);
        await pool.query("commit");
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await pool.query("rollback");
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  await runMigrations(config.databaseUrl);
}
