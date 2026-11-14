import { describe, expect, it } from "vitest";
import { normalizeRunCodeArguments, stripMarkdownFences } from "../src/repair/run-code.ts";

describe("stripMarkdownFences", () => {
  it("strips a fenced block with a language tag", () => {
    const code = "```js\nconst x = 1;\nreturn x;\n```\n";
    expect(stripMarkdownFences(code)).toBe("const x = 1;\nreturn x;");
  });

  it("leaves unfenced code untouched", () => {
    const code = "const x = 1;\nreturn x;";
    expect(stripMarkdownFences(code)).toBe(code);
  });

  it("does not strip a fence that is only part of the body", () => {
    const code = 'console.log("```");\nreturn 1;';
    expect(stripMarkdownFences(code)).toBe(code);
  });
});

describe("normalizeRunCodeArguments", () => {
  it("passes through a healthy object unchanged (same fields)", () => {
    const args = { code: "return 1;", description: "one" };
    const out = normalizeRunCodeArguments(args);
    expect(out.code).toBe("return 1;");
    expect(out.description).toBe("one");
  });

  it("synthesizes a bash dispatch from command", () => {
    const out = normalizeRunCodeArguments({ command: "ls -la" });
    expect(out.code).toContain('tools.bash');
    expect(out.code).toContain('"command"');
    expect(out.code).toContain("ls -la");
    expect(out.description.length).toBeGreaterThan(0);
  });

  it("synthesizes from cmd as well", () => {
    const out = normalizeRunCodeArguments({ cmd: "dir" });
    expect(out.code).toContain('tools.bash');
  });

  it("keeps an existing code body even when command is present", () => {
    const out = normalizeRunCodeArguments({ command: "ls", code: "return 42;" });
    expect(out.code).toBe("return 42;");
  });

  it("leaves an empty program empty (host rejects loudly)", () => {
    const out = normalizeRunCodeArguments({ code: "", description: "" });
    expect(out.code.trim()).toBe("");
  });

  it("fills a missing description from a leading comment", () => {
    const out = normalizeRunCodeArguments("// Count files\nreturn 1;");
    expect(out.description).toContain("Count files");
  });

  it("accepts a raw JSON string body", () => {
    const out = normalizeRunCodeArguments('{"code":"return 2;","description":"two"}');
    expect(out.code).toBe("return 2;");
    expect(out.description).toBe("two");
  });

  it("strips markdown fences from the code body", () => {
    const out = normalizeRunCodeArguments({
      code: "```js\nreturn 3;\n```\n",
      description: "three",
    });
    expect(out.code).toBe("return 3;");
  });

  it("defaults the description to a generic label when none is derivable", () => {
    const out = normalizeRunCodeArguments({ code: "return 1;" });
    expect(out.description.length).toBeGreaterThan(0);
  });
});
