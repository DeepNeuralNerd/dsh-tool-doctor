import { describe, expect, it } from "vitest";
import { pruneWorkspaceSourcePaths } from "../src/repair/source-path-scope.ts";

const workspace = process.cwd();

describe("pruneWorkspaceSourcePaths", () => {
  it("drops absolute paths outside the workspace (case-insensitive)", () => {
    const inside = `${workspace}\\sub\\doc.md`;
    const outside = "C:\\Windows\\System32\\drivers\\etc\\hosts";
    const out = pruneWorkspaceSourcePaths(
      "mnemon_document_create",
      { title: "t", content: "c", sourcePaths: [inside, outside] },
      workspace,
    );
    expect(out).toBeDefined();
    const paths = (out as Record<string, unknown>).sourcePaths as string[];
    expect(paths.length).toBe(1);
    expect(paths[0].toLowerCase()).toBe(inside.toLowerCase());
  });

  it("keeps relative entries that resolve inside the workspace", () => {
    const out = pruneWorkspaceSourcePaths(
      "mnemon_document_manage",
      { action: "create", title: "t", content: "c", sourcePaths: ["notes.md"] },
      workspace,
    );
    expect(out).toBeUndefined(); // unchanged → no-op
  });

  it("deletes the property when every entry is outside", () => {
    const out = pruneWorkspaceSourcePaths(
      "mnemon_document_create",
      { title: "t", content: "c", sourcePaths: ["C:\\Other\\x.md"] },
      workspace,
    );
    expect(out).toBeDefined();
    expect("sourcePaths" in (out as object)).toBe(false);
  });

  it("returns undefined for tools outside the scope family", () => {
    const out = pruneWorkspaceSourcePaths(
      "read",
      { sourcePaths: ["C:\\Other\\x.md"] },
      workspace,
    );
    expect(out).toBeUndefined();
  });

  it("ignores a missing sourcePaths array", () => {
    expect(pruneWorkspaceSourcePaths("mnemon_document_create", {}, workspace)).toBeUndefined();
  });
});
