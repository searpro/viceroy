import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createSqlite, createDb, type Db } from "./client";
import { resolveConfig } from "../config";
import { loadEnvFiles } from "../env";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Run directly via tsx, which does not read .env files the way Next does —
  // without this, `pnpm db:migrate` and `pnpm db:seed` operate on the default
  // database while the app runs on the configured one.
  loadEnvFiles();
  const config = resolveConfig();
  const sqlite = createSqlite(config.databasePath);
  runMigrations(createDb(sqlite));
  sqlite.close();
  console.log(`migrations applied to ${config.databasePath}`);
}
