import { describe, expect, it } from "vitest";
import os from "node:os";
import { normalizePathShapes } from "../src/repair/path-normalize.ts";

describe("normalizePathShapes", () => {
  const cwd = "/home/user/workspace";

  it("expands tilde ~/notes.md to home directory", () => {
    const result = normalizePathShapes(
      "edit",
      { path: "~/notes.md" },
      cwd,
    );
    expect(result).toBeDefined();
    expect(result?.changes).toContain("expanded ~ to home directory");
    // Use os.homedir() in expectation.
    const expected = `${os.homedir()}/notes.md`;
    expect((result!.args as Record<string, unknown>).path).toBe(expected);
  });

  it("expands tilde ~ alone to home directory", () => {
    const result = normalizePathShapes(
      "edit",
      { path: "~" },
      cwd,
    );
    expect(result).toBeDefined();
    expect(result?.changes).toContain("expanded ~ to home directory");
    const expected = os.homedir();
    expect((result!.args as Record<string, unknown>).path).toBe(expected);
  });

  it("does NOT rewrite backslash path when cwd hints Windows", () => {
    // When cwd includes backslashes (Windows hint), separators are never rewritten.
    const result = normalizePathShapes(
      "edit",
      { path: "C:\\a\\b" },
      "C:\\work",
    );
    expect(result).toBeUndefined(); // No changes expected on Windows-style cwd
  });

  it("rewrites backslash posix path with cwd hinting POSIX", () => {
    // On POSIX (cwd without backslashes), a single backslash in the value gets normalized.
    const result = normalizePathShapes(
      "edit",
      { path: "/home/u\\dir\\f.txt" },
      "/home/user",
    );
    expect(result).toBeDefined();
    expect(result?.changes).toContain("normalized path separators to host style");
    expect((result!.args as Record<string, unknown>).path).toBe("/home/u/dir/f.txt");
  });

  it("returns undefined for already-clean path", () => {
    const result = normalizePathShapes(
      "edit",
      { path: "/clean/path/file.txt" },
      cwd,
    );
    expect(result).toBeUndefined(); // No changes → no-op
  });

  it("leaves non-string path value untouched", () => {
    const result = normalizePathShapes(
      "edit",
      { path: 123 as any },
      cwd,
    );
    expect(result).toBeUndefined(); // Skip non-string values
  });

  it("handles object args with two path keys where only one changes", () => {
    const result = normalizePathShapes(
      "edit",
      {
        file_path: "~/file.txt",
        TargetFile: "/absolute/path/file.md",
      },
      cwd,
    );
    expect(result).toBeDefined();
    expect(result?.changes.length).toBeGreaterThanOrEqual(1);
    // Only the tilde path should change.
    const args = result!.args as Record<string, unknown>;
    expect(args.file_path).toContain(os.homedir());
    expect(args.TargetFile).toBe("/absolute/path/file.md"); // unchanged
  });
});
