import { describe, expect, it } from "vitest";
import os from "node:os";
import { normalizePathShapes } from "../src/repair/path-normalize.ts";

/** Does THIS machine's home use drive-letter/backslash style? */
const home = os.homedir();
const homeIsWindows = /^[a-zA-Z]:[\\/]/.test(home) || home.startsWith("\\\\");
const homeRoot = home.replace(/[\\/]+$/, "");
const sep = homeIsWindows ? "\\" : "/";

describe("normalizePathShapes", () => {
  // A cwd INSIDE this machine's home — the only world where ~ expansion is
  // known-safe. Everything else must leave ~ untouched.
  const underHomeCwd = `${homeRoot}${sep}project`;
  // Same path style, different (or unknown) home: a same-OS remote session
  // (Windows: another volume; POSIX: another user) — must NOT expand.
  const sameStyleRemoteCwd = homeIsWindows ? "D:\\work" : "/home/someone-else/work";
  const foreignStyleCwd = homeIsWindows ? "/remote/work" : "C:\\work";

  it("expands tilde ~/notes.md when the session cwd sits under the home", () => {
    const result = normalizePathShapes("edit", { path: "~/notes.md" }, underHomeCwd);
    expect(result).toBeDefined();
    expect(result?.changes).toContain("expanded ~ to home directory");
    expect((result!.args as Record<string, unknown>).path).toBe(`${home}${sep}notes.md`);
  });

  it("expands a bare ~ when the session cwd IS the home", () => {
    const result = normalizePathShapes("edit", { path: "~" }, homeRoot);
    expect((result!.args as Record<string, unknown>).path).toBe(home);
  });

  it("leaves ~ untouched for a same-style remote session (different home)", () => {
    // Reviewer case: matching style is not evidence of a shared home.
    expect(normalizePathShapes("edit", { path: "~/notes.md" }, sameStyleRemoteCwd)).toBeUndefined();
  });

  it("leaves ~ untouched for the foreign path style", () => {
    expect(normalizePathShapes("edit", { path: "~/notes.md" }, foreignStyleCwd)).toBeUndefined();
  });

  it("leaves ~ untouched when the cwd is unknown", () => {
    expect(normalizePathShapes("edit", { path: "~/notes.md" }, undefined)).toBeUndefined();
  });

  it("requires a separator boundary, not just a string prefix", () => {
    // cwd "/home/user-project" starts with home "/home/user" textually,
    // but is NOT inside the home — expansion would be a guess.
    expect(
      normalizePathShapes("edit", { path: "~/notes.md" }, `${homeRoot}${sep}elsewhere`),
    ).toBeDefined(); // sanity: a real subdir still expands
    expect(
      normalizePathShapes("edit", { path: "~/notes.md" }, `${homeRoot}-extra`),
    ).toBeUndefined();
  });

  // Reviewer round (4th): containment must run on the RESOLVED cwd, not the
  // raw string — "." and ".." segments change which directory a cwd names.
  describe("cwd containment resolves . and .. before checking", () => {
    it("does NOT expand for a cwd whose .. segments escape the home", () => {
      // Home C:\Users\Srini + cwd C:\Users\Srini\project\..\..\elsewhere
      // resolves to C:\Users\elsewhere — outside the home.
      const escapingCwd = `${homeRoot}${sep}project${sep}..${sep}..${sep}elsewhere`;
      expect(normalizePathShapes("edit", { path: "~/notes.md" }, escapingCwd)).toBeUndefined();
    });

    it("expands when . segments keep the cwd under the home", () => {
      const dottedCwd = `${homeRoot}${sep}.${sep}sub`;
      const result = normalizePathShapes("edit", { path: "~/notes.md" }, dottedCwd);
      expect(result).toBeDefined();
      expect((result!.args as Record<string, unknown>).path).toBe(`${home}${sep}notes.md`);
    });

    it("expands when .. segments stay inside the home", () => {
      const wobblingCwd = `${homeRoot}${sep}sub${sep}..${sep}sub2`; // resolves to home/sub2
      expect(
        normalizePathShapes("edit", { path: "~/notes.md" }, wobblingCwd),
      ).toBeDefined();
    });

    it("clamps .. at the filesystem root instead of popping the root token", () => {
      // More leading .. than there are directories: resolves to the root,
      // which is not inside the home (home is never the root here).
      const beyond = homeIsWindows
        ? `${homeRoot}${sep}..${sep}..${sep}..${sep}..`
        : `${homeRoot}/../../..`;
      expect(normalizePathShapes("edit", { path: "~/notes.md" }, beyond)).toBeUndefined();
    });
  });

  it("does NOT rewrite backslash path when cwd hints Windows", () => {
    const result = normalizePathShapes("edit", { path: "C:\\a\\b" }, "C:\\work");
    expect(result).toBeUndefined(); // No changes expected on Windows-style cwd
  });

  it("rewrites backslash posix path with cwd hinting POSIX", () => {
    // Separator normalization is independent of the home-trust rule.
    const result = normalizePathShapes("edit", { path: "/home/u\\dir\\f.txt" }, "/home/user");
    expect(result).toBeDefined();
    expect(result?.changes).toContain("normalized path separators to host style");
    expect((result!.args as Record<string, unknown>).path).toBe("/home/u/dir/f.txt");
  });

  it("returns undefined for already-clean path", () => {
    const result = normalizePathShapes("edit", { path: "/clean/path/file.txt" }, underHomeCwd);
    expect(result).toBeUndefined();
  });

  it("leaves non-string path value untouched", () => {
    const result = normalizePathShapes("edit", { path: 123 as unknown as string }, underHomeCwd);
    expect(result).toBeUndefined();
  });

  it("handles object args with two path keys where only one changes", () => {
    const result = normalizePathShapes(
      "edit",
      {
        file_path: "~/file.txt",
        TargetFile: "/absolute/path/file.md",
      },
      underHomeCwd,
    );
    expect(result).toBeDefined();
    const args = result!.args as Record<string, unknown>;
    expect(args.file_path).toContain(home);
    expect(args.TargetFile).toBe("/absolute/path/file.md"); // unchanged
  });
});
