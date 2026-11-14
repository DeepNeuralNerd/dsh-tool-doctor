import { describe, expect, it } from "vitest";
import os from "node:os";
import { normalizePathShapes } from "../src/repair/path-normalize.ts";

/** Does THIS machine's home use drive-letter/backslash style? */
const homeIsWindows = /^[a-zA-Z]:[\\/]/.test(os.homedir()) || os.homedir().startsWith("\\\\");

describe("normalizePathShapes", () => {
  // A session cwd whose style MATCHES this machine's home (expansion allowed)
  // and one with the foreign style (home unknown → ~ must survive untouched).
  const matchingCwd = homeIsWindows ? "C:\\work" : "/home/user/workspace";
  const foreignCwd = homeIsWindows ? "/remote/work" : "C:\\work";

  it("expands tilde ~/notes.md when home style matches the session world", () => {
    const result = normalizePathShapes("edit", { path: "~/notes.md" }, matchingCwd);
    expect(result).toBeDefined();
    expect(result?.changes).toContain("expanded ~ to home directory");
    const rest = homeIsWindows ? "\\notes.md" : "/notes.md";
    expect((result!.args as Record<string, unknown>).path).toBe(`${os.homedir()}${rest}`);
  });

  it("expands a bare ~ when home style matches", () => {
    const result = normalizePathShapes("edit", { path: "~" }, matchingCwd);
    expect((result!.args as Record<string, unknown>).path).toBe(os.homedir());
  });

  it("leaves ~ untouched when the session world has the foreign style", () => {
    // Reviewer case: a Windows plugin driving a POSIX session must NOT
    // rewrite ~/notes into C:\Users/<plugin-user>/notes.
    expect(normalizePathShapes("edit", { path: "~/notes.md" }, foreignCwd)).toBeUndefined();
  });

  it("does NOT rewrite backslash path when cwd hints Windows", () => {
    // When cwd includes backslashes (Windows hint), separators are never rewritten.
    const result = normalizePathShapes("edit", { path: "C:\\a\\b" }, "C:\\work");
    expect(result).toBeUndefined(); // No changes expected on Windows-style cwd
  });

  it("rewrites backslash posix path with cwd hinting POSIX", () => {
    // On POSIX (cwd without backslashes), a single backslash in the value gets normalized.
    const result = normalizePathShapes("edit", { path: "/home/u\\dir\\f.txt" }, "/home/user");
    expect(result).toBeDefined();
    expect(result?.changes).toContain("normalized path separators to host style");
    expect((result!.args as Record<string, unknown>).path).toBe("/home/u/dir/f.txt");
  });

  it("returns undefined for already-clean path", () => {
    const result = normalizePathShapes("edit", { path: "/clean/path/file.txt" }, matchingCwd);
    expect(result).toBeUndefined(); // No changes → no-op
  });

  it("leaves non-string path value untouched", () => {
    const result = normalizePathShapes("edit", { path: 123 as unknown as string }, matchingCwd);
    expect(result).toBeUndefined(); // Skip non-string values
  });

  it("handles object args with two path keys where only one changes", () => {
    const result = normalizePathShapes(
      "edit",
      {
        file_path: "~/file.txt",
        TargetFile: "/absolute/path/file.md",
      },
      matchingCwd,
    );
    expect(result).toBeDefined();
    expect(result?.changes.length).toBeGreaterThanOrEqual(1);
    // Only the tilde path should change.
    const args = result!.args as Record<string, unknown>;
    expect(args.file_path).toContain(os.homedir());
    expect(args.TargetFile).toBe("/absolute/path/file.md"); // unchanged
  });
});
