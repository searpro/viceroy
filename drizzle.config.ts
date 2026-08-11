import { defineConfig } from "drizzle-kit";
import { resolveConfig } from "./lib/config";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: resolveConfig().databasePath },
});
