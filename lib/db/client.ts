import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "./schema";
import { resolveConfig } from "../config";

export type Db = ReturnType<typeof createDb>;

export function createSqlite(databasePath: string): Database.Database {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const sqlite = new Database(databasePath);

  // WAL lets the worker write while the Next server reads. Without it the two
  // processes serialise on a single writer lock and the UI stalls behind a
  // long-running job's transaction.
  sqlite.pragma("journal_mode = WAL");
  // Drizzle's onDelete: "cascade" is a no-op in SQLite unless this is on, and
  // it is off by default in every connection.
  sqlite.pragma("foreign_keys = ON");
  // Two processes on one file will collide; wait rather than throw SQLITE_BUSY.
  sqlite.pragma("busy_timeout = 5000");

  return sqlite;
}

export function createDb(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

let cached: { sqlite: Database.Database; db: Db } | undefined;

export function getDb(): Db {
  if (!cached) {
    const sqlite = createSqlite(resolveConfig().databasePath);
    cached = { sqlite, db: createDb(sqlite) };
  }
  return cached.db;
}

export function getSqlite(): Database.Database {
  getDb();
  return cached!.sqlite;
}
