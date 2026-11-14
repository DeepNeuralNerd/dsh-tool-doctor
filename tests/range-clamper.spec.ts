import { describe, expect, it } from "vitest";
import { normalizeEditorArguments, normalizeReadArguments } from "../src/repair/range-clamper.ts";

describe("normalizeEditorArguments (edit)", () => {
  const cwd = "/workspace";

  it("clamps a view_range end past the file length", () => {
    const out = normalizeEditorArguments(
      "edit",
      { file_path: "/a.txt", view_range: [1, 999] },
      cwd,
      40,
    );
    expect(out).toBeDefined();
    expect((out as Record<string, unknown>).view_range).toEqual([1, 40]);
  });

  it("floors a zero-based start to 1", () => {
    const out = normalizeEditorArguments(
      "edit",
      { file_path: "/a.txt", view_range: [0, 5] },
      cwd,
      undefined,
    );
    expect(out).toBeDefined();
    expect((out as Record<string, unknown>).view_range).toEqual([1, 5]);
  });

  it("swaps an inverted range [9,3] → [3,9]", () => {
    const out = normalizeEditorArguments(
      "edit",
      { file_path: "/a.txt", view_range: [9, 3] },
      cwd,
      undefined,
    );
    expect(out).toBeDefined();
    // The swap preserves the model's intended range.
    expect((out as Record<string, unknown>).view_range).toEqual([3, 9]);
  });

  it("resolves a relative file_path against the session cwd", () => {
    const out = normalizeEditorArguments(
      "edit",
      { file_path: "notes.md" },
      cwd,
      undefined,
    );
    expect(out).toBeDefined();
    const path = (out as Record<string, unknown>).file_path;
    expect(typeof path === "string").toBe(true);
    expect((path as string).endsWith("notes.md")).toBe(true);
  });

  it("returns a value-equal copy when nothing changed", () => {
    const args = { file_path: "/a.txt", view_range: [2, 10] };
    const out = normalizeEditorArguments("edit", args, cwd);
    expect(out).toEqual(args); // the stage's JSON equality check turns this into a no-op
  });
});

describe("normalizeEditorArguments (str_replace_editor)", () => {
  it("keeps relative paths untouched when resolution is disabled for the tool", () => {
    const out = normalizeEditorArguments(
      "str_replace_editor",
      { path: "notes.md" },
      "/workspace",
      undefined,
      false, // the stage passes false: str_replace_editor rejects relatives explicitly
    );
    expect((out as Record<string, unknown>).path).toBe("notes.md");
  });

  it("keeps end === -1 as to-end even with a known line count", () => {
    const out = normalizeEditorArguments(
      "str_replace_editor",
      { path: "/a.txt", view_range: [1, -1] },
      "/workspace",
      25,
    );
    expect(out).toBeDefined();
    // The host knows the file length; to-end stays to-end.
    expect((out as Record<string, unknown>).view_range).toEqual([1, -1]);
  });

  it("clamps end to maxLines when given", () => {
    const out = normalizeEditorArguments(
      "str_replace_editor",
      { path: "/a.txt", view_range: [1, 500] },
      "/workspace",
      30,
    );
    expect(out).toBeDefined();
    expect((out as Record<string, unknown>).view_range).toEqual([1, 30]);
  });
});

describe("normalizeReadArguments", () => {
  it("corrects a zero-based offset to 1", () => {
    const out = normalizeReadArguments("read", { file_path: "/a.txt", offset: 0 });
    expect(out).toBeDefined();
    expect((out as Record<string, unknown>).offset).toBe(1);
  });

  it("clamps a negative limit to 1", () => {
    const out = normalizeReadArguments("read", { file_path: "/a.txt", limit: -5 });
    expect(out).toBeDefined();
    expect((out as Record<string, unknown>).limit).toBe(1);
  });

  it("prefers offset over start when both are present", () => {
    const out = normalizeReadArguments("read", { file_path: "/a.txt", offset: 0, start: 7 });
    expect(out).toBeDefined();
    expect((out as Record<string, unknown>).offset).toBe(1);
  });

  it("returns undefined for a healthy read call", () => {
    const args = { file_path: "/a.txt", offset: 3, limit: 20 };
    expect(normalizeReadArguments("read", args)).toBeUndefined();
  });

  it("ignores tools outside the offset family", () => {
    expect(normalizeReadArguments("edit", { offset: 0 })).toBeUndefined();
  });
});

describe("view_range flip fix (new test)", () => {
  it("swaps flipped view_range [120, 20] → [20, 120]", () => {
    const out = normalizeEditorArguments(
      "edit",
      { file_path: "/a.txt", view_range: [120, 20] },
      "/workspace",
      undefined,
    );
    expect(out).toBeDefined();
    // The flip fix swaps them before clamping.
    expect((out as Record<string, unknown>).view_range).toEqual([20, 120]);
  });

  it("keeps [5, -1] with end -1 for str_replace_editor (no swap)", () => {
    const out = normalizeEditorArguments(
      "str_replace_editor",
      { path: "/a.txt", view_range: [5, -1] },
      "/workspace",
      undefined,
    );
    expect(out).toBeDefined();
    // end === -1 means "to end" — no swap should happen.
    expect((out as Record<string, unknown>).view_range).toEqual([5, -1]);
  });
});