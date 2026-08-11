import { createDb, createSqlite, type Db } from "./client";
import { runMigrations } from "./migrate";

/**
 * A migrated, isolated database for one test.
 *
 * Runs the real migrations rather than pushing the schema, so a migration that
 * doesn't apply cleanly fails the test suite instead of surfacing in
 * production.
 */
export function createTestDb(): { db: Db; close: () => void } {
  const sqlite = createSqlite(":memory:");
  const db = createDb(sqlite);
  runMigrations(db);
  return { db, close: () => sqlite.close() };
}
