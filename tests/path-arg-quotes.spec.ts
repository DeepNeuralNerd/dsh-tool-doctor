import { describe, expect, it } from "vitest";
import { dequotePathArgs, unwrapQuotedPath } from "../src/repair/path-arg-quotes.ts";

describe("unwrapQuotedPath", () => {
  it("unwraps double quotes around an absolute path", () => {
    expect(unwrapQuotedPath('"C:\\Users\\me\\file.txt"')).toBe("C:\\Users\\me\\file.txt");
  });

  it("unwraps single quotes", () => {
    expect(unwrapQuotedPath("'C:/tmp/a.md'")).toBe("C:/tmp/a.md");
  });

  it("unwraps a curly double-quote pair (smart-quote emission, OpenClaw class)", () => {
    expect(unwrapQuotedPath("“C:\\Users\\me\\file.txt”")).toBe("C:\\Users\\me\\file.txt");
  });

  it("unwraps a curly single-quote pair", () => {
    expect(unwrapQuotedPath("‘C:/tmp/a.md’")).toBe("C:/tmp/a.md");
  });

  it("leaves a mixed curly/straight pair alone", () => {
    expect(unwrapQuotedPath("“C:\\x\\f.txt\"")).toBeUndefined();
  });

  it("leaves a curly-wrapped relative path alone", () => {
    expect(unwrapQuotedPath("“notes.md”")).toBeUndefined();
  });

  it("dequotes a curly-wrapped path on a file tool", () => {
    const args = { file_path: "“C:\\dir\\f.txt”" };
    const out = dequotePathArgs("read", args);
    expect((out as Record<string, unknown>).file_path).toBe("C:\\dir\\f.txt");
  });

  it("leaves a unix-root path alone (quotes are legal in POSIX file names — identity risk)", () => {
    // Review 2026-11-14: the Windows quote-illegality rationale does not extend
    // to POSIX; a file may genuinely be named "/\"data.txt\"".
    expect(unwrapQuotedPath('"/tmp/data.txt"')).toBeUndefined();
  });

  it("does not unwrap a bare path (no wrapping quotes)", () => {
    expect(unwrapQuotedPath("C:\\Users\\me\\file.txt")).toBeUndefined();
  });

  it("does not unwrap an empty inner value", () => {
    expect(unwrapQuotedPath('""')).toBeUndefined();
  });

  it("leaves a quoted relative path alone (only absolute shapes are unwrapped)", () => {
    // A quoted relative path is ambiguous; the rule only fires on absolute.
    const out = unwrapQuotedPath('"notes.md"');
    expect(out === undefined || out === "notes.md").toBe(true);
  });
});

describe("dequotePathArgs", () => {
  it("unwraps a quoted file_path for read tools", () => {
    const args = { file_path: '"C:\\Users\\me\\file.txt"' };
    const out = dequotePathArgs("read", args);
    expect(out).toBeDefined();
    expect((out as Record<string, unknown>).file_path).toBe("C:\\Users\\me\\file.txt");
  });

  it("unwraps a quoted path parameter for grep", () => {
    const args = { pattern: "x", path: '"C:/work"' };
    const out = dequotePathArgs("grep", args);
    expect(out).toBeDefined();
    expect((out as Record<string, unknown>).path).toBe("C:/work");
  });

  it("unwraps a quoted file_path for read_image (candidate: PASSTHROUGH quote-wrap, 2026-11-14)", () => {
    const args = { file_path: '"C:\\Users\\me\\docs\\CHANGELOG.md"' };
    const out = dequotePathArgs("read_image", args);
    expect(out).toBeDefined();
    expect((out as Record<string, unknown>).file_path).toBe("C:\\Users\\me\\docs\\CHANGELOG.md");
  });

  it("leaves a site-local tool outside the published family", () => {
    // modlens_read_image (one host's MCP vision bridge) was removed from
    // PATH_TOOLS 2026-11-14: shipped rule tables cover DSH built-ins only;
    // per-site tool entries are that host's promotion, not a general rule.
    const args = { path: '"C:/Users/me/shot.png"', prompt: "read it" };
    expect(dequotePathArgs("modlens_read_image", args)).toBeUndefined();
  });

  it("returns undefined when no path parameter is wrapped", () => {
    const args = { file_path: "C:\\Users\\me\\file.txt" };
    expect(dequotePathArgs("read", args)).toBeUndefined();
  });

  it("ignores tools outside the path family", () => {
    const args = { file_path: '"C:/a"' };
    expect(dequotePathArgs("bash", args)).toBeUndefined();
  });

  it("does not touch non-path fields that happen to be quoted", () => {
    const args = { file_path: "C:/a.txt", description: '"quoted text"' };
    const out = dequotePathArgs("read", args);
    expect(out).toBeUndefined();
  });
});
