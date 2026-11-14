import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOverrides, saveOverrides, validateTogglePatch } from "../src/support/config-overrides.ts";

// Hermetic DSH_HOME: the live profile has a real tool-doctor-config.json that
// must never leak into these tests.
let originalHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalHome = process.env.DSH_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "doctor-home-"));
  process.env.DSH_HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("validateTogglePatch", () => {
  it("accepts a valid boolean patch", () => {
    const result = validateTogglePatch({ errorHints: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch).toEqual({ errorHints: false });
  });

  it("rejects non-object bodies", () => {
    expect(validateTogglePatch(null).ok).toBe(false);
    expect(validateTogglePatch([true]).ok).toBe(false);
    expect(validateTogglePatch("x").ok).toBe(false);
  });

  it("rejects an empty patch", () => {
    const result = validateTogglePatch({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("empty");
  });

  it("rejects unknown keys with the key named", () => {
    const result = validateTogglePatch({ notAFlag: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("notAFlag");
  });

  it("rejects non-boolean values with the key named", () => {
    const result = validateTogglePatch({ errorHints: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("errorHints");
  });

  it("accepts all eight flags together", () => {
    const result = validateTogglePatch({
      autoWrapRunCode: true,
      autoBridgeDirectTools: false,
      autoObserveFiles: true,
      autoClampRanges: false,
      injectPrompt: true,
      errorHints: false,
      persistPassthrough: true,
      healResponseTools: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe("loadOverrides / saveOverrides", () => {
  // Resolved per test: tempHome only exists inside beforeEach.
  const file = (): string => join(tempHome, "tool-doctor-config.json");

  it("loads an empty object when no file exists (hermetic home)", () => {
    expect(loadOverrides()).toEqual({});
  });

  it("round-trips a saved patch through the durable file", () => {
    saveOverrides({ errorHints: false }, file());
    expect(loadOverrides(file())).toMatchObject({ errorHints: false });
  });

  it("merges over previously saved flags instead of replacing them", () => {
    saveOverrides({ errorHints: false }, file());
    saveOverrides({ injectPrompt: false }, file());
    const loaded = loadOverrides(); // default path resolves under the hermetic DSH_HOME
    expect(loaded).toMatchObject({ errorHints: false, injectPrompt: false });
  });

  it("degrades to an empty object on a corrupt file", () => {
    writeFileSync(file(), "{not json");
    expect(loadOverrides()).toEqual({});
  });

  it("creates the parent directory when saving into a fresh path", () => {
    const nestedFile = join(tempHome, "nested", "home", "tool-doctor-config.json");
    saveOverrides({ autoClampRanges: false }, nestedFile);
    expect(loadOverrides(nestedFile)).toMatchObject({ autoClampRanges: false });
  });
});
