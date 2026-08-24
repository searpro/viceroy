import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_SHELL } from "./page-shell";

/**
 * The drift guard for page width.
 *
 * Every screen used to set its own container, and they had already diverged:
 * the nav and two screens were `max-w-5xl` while five others were `max-w-3xl`,
 * so most of the app rendered visibly indented from the nav above it. Nothing
 * caught it because nothing was comparing them — the same shape as the
 * `DEV_CHAIN_ORDER` mirror that `dev-stages.test.ts` exists to hold in place.
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

const APP = join(process.cwd(), "app");

describe("PAGE_SHELL", () => {
  it("is the only place a page-width container is defined", () => {
    // `mx-auto` plus a max-width is the signature of a page container. Layout
    // helpers that centre something *inside* a page (a max-w-xs thumbnail, a
    // max-w-2xl paragraph) do not set both, so they are not matched here.
    const offenders = tsxFiles(APP)
      .filter((path) => !path.endsWith("page-shell.ts"))
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return [...source.matchAll(/className="[^"]*\bmx-auto\b[^"]*\bmax-w-[\w[\].%-]+/g)].map(
          (match) => `${path.replace(APP, "app")}: ${match[0].slice(11)}`,
        );
      });

    expect(offenders).toEqual([]);
  });

  it("pins the width every screen and the nav share", () => {
    // Asserted as a value, not just as "they all import it": changing this
    // string is a deliberate design decision about the whole application, and
    // should show up as a test edit rather than slip through in one screen's
    // diff.
    expect(PAGE_SHELL).toBe("mx-auto w-full max-w-5xl px-6");
  });
});
