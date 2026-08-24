import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvFiles } from "./env";

/**
 * The bug these hold shut: Next reads `.env.local` automatically and `tsx` does
 * not, so `pnpm dev` and `pnpm dev:worker` resolved different databases the
 * moment a `.env.local` existed. The web app enqueued into one and the worker
 * polled the other, and a job sat `queued` forever — no error, no attempt, and
 * a worker that was healthy and correctly idle because its own queue was empty.
 */
let dir: string;
const KEYS = ["VICEROY_TEST_A", "VICEROY_TEST_B", "VICEROY_TEST_REAL"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "viceroy-env-"));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of KEYS) delete process.env[key];
});

describe("loadEnvFiles", () => {
  it("reads .env", () => {
    writeFileSync(join(dir, ".env"), "VICEROY_TEST_A=from-env\n");
    loadEnvFiles(dir);
    expect(process.env.VICEROY_TEST_A).toBe("from-env");
  });

  it("lets .env.local win over .env, the way Next orders them", () => {
    writeFileSync(join(dir, ".env"), "VICEROY_TEST_A=from-env\n");
    writeFileSync(join(dir, ".env.local"), "VICEROY_TEST_A=from-env-local\n");
    loadEnvFiles(dir);
    expect(process.env.VICEROY_TEST_A).toBe("from-env-local");
  });

  it("merges the two rather than letting one shadow the whole file", () => {
    writeFileSync(join(dir, ".env"), "VICEROY_TEST_A=from-env\nVICEROY_TEST_B=only-in-env\n");
    writeFileSync(join(dir, ".env.local"), "VICEROY_TEST_A=from-env-local\n");
    loadEnvFiles(dir);
    expect(process.env.VICEROY_TEST_A).toBe("from-env-local");
    expect(process.env.VICEROY_TEST_B).toBe("only-in-env");
  });

  it("never overwrites a variable the process was actually started with", () => {
    // A one-off `VICEROY_DATA_DIR=... pnpm worker` has to keep working, and CI
    // sets real variables that a checked-in .env must not clobber.
    process.env.VICEROY_TEST_REAL = "from-real-env";
    writeFileSync(join(dir, ".env.local"), "VICEROY_TEST_REAL=from-file\n");
    loadEnvFiles(dir);
    expect(process.env.VICEROY_TEST_REAL).toBe("from-real-env");
  });

  it("is a no-op when neither file exists", () => {
    // `process.loadEnvFile` throws on a missing path rather than returning
    // quietly, and neither file is required — a fresh clone has neither.
    expect(() => loadEnvFiles(dir)).not.toThrow();
  });

  it("does not throw when only one of the two exists", () => {
    writeFileSync(join(dir, ".env.local"), "VICEROY_TEST_A=alone\n");
    expect(() => loadEnvFiles(dir)).not.toThrow();
    expect(process.env.VICEROY_TEST_A).toBe("alone");
  });
});
