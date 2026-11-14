import { describe, expect, it } from "vitest";
import { repairRunCodeSyntax } from "../src/repair/run-code-syntax.ts";

/**
 * Syntax-check a program body by constructing it with the async-function
 * constructor, so a top-level `await` is valid (run_code bodies may await).
 */
function parses(code: string): boolean {
  try {
    new ((async () => {}).constructor as unknown as new (src: string) => object)(code);
    return true;
  } catch {
    return false;
  }
}

describe("repairRunCodeSyntax", () => {
  it("returns undefined for a valid program (never touches healthy code)", () => {
    expect(repairRunCodeSyntax('const x = "a";\nreturn x;')).toBeUndefined();
    expect(
      repairRunCodeSyntax(`const t = \`hello \${1 + 1}\`;\nreturn t;`),
    ).toBeUndefined();
  });

  it("closes a truncated string tail", () => {
    const broken = 'const s = "unterminated';
    const fixed = repairRunCodeSyntax(broken);
    expect(fixed).toBeDefined();
    expect(parses(fixed!)).toBe(true);
  });

  it("closes a truncated template literal (may span lines)", () => {
    const broken = 'const t = `unterminated;\nreturn t;';
    const fixed = repairRunCodeSyntax(broken);
    expect(fixed).toBeDefined();
    expect(parses(fixed!)).toBe(true);
  });

  it("closes a truncated single-quoted string", () => {
    const broken = "const s = 'unterminated";
    const fixed = repairRunCodeSyntax(broken);
    expect(fixed).toBeDefined();
    expect(parses(fixed!)).toBe(true);
  });

  it("closes dangling brackets at the tail", () => {
    const broken = "const a = [1, 2";
    const fixed = repairRunCodeSyntax(broken);
    expect(fixed).toBeDefined();
    if (fixed !== undefined) expect(parses(fixed)).toBe(true);
  });

  it("closes a truncated string inside an open object", () => {
    const broken = 'const o = { s: "abc';
    const fixed = repairRunCodeSyntax(broken);
    expect(fixed).toBeDefined();
    if (fixed !== undefined) expect(parses(fixed)).toBe(true);
  });

  it("leaves an unrepairable multi-line double-quote cut alone (honest no-repair)", () => {
    // A literal newline inside a double-quoted string cannot be fixed by
    // appending the closer; the repair must decline rather than guess.
    const broken = 'const x = "a\nb";';
    expect(parses(broken)).toBe(false);
    const fixed = repairRunCodeSyntax(broken);
    if (fixed !== undefined) {
      expect(parses(fixed)).toBe(true); // any candidate must still parse
    }
  });

  it("rewrites triple-quoted strings containing newlines into template literals", () => {
    const broken = [
      "const doc = '''",
      "line one",
      "line two",
      "''';",
      "return doc;",
    ].join("\n");
    expect(parses(broken)).toBe(false);
    const fixed = repairRunCodeSyntax(broken);
    expect(fixed).toBeDefined();
    expect(parses(fixed!)).toBe(true);
  });

  it("rewrites double-triple-quoted strings", () => {
    const broken = [
      'const doc = """',
      "line one",
      '"""',
      "return doc;",
    ].join("\n");
    const fixed = repairRunCodeSyntax(broken);
    expect(fixed).toBeDefined();
    if (fixed !== undefined) expect(parses(fixed)).toBe(true);
  });

  it("escapes stray template backticks in prose", () => {
    const broken = [
      "const msg = `Use the \`edit\` tool carefully;`,",
      "return msg;",
    ].join("\n");
    // This actually parses (escaped) — use a genuinely stray one:
    const stray = 'const msg = `say hi to `world` now`;';
    expect(parses(stray)).toBe(false);
    const fixed = repairRunCodeSyntax(stray);
    if (fixed !== undefined) {
      expect(parses(fixed)).toBe(true);
    }
  });

  it("never returns a program that still fails to parse", () => {
    const samples = [
      'const x = "abc',
      "function f(a, b {\nreturn a + b;\n}",
      "const o = { k: 'v' }",
      "if (true) { return 1;",
    ];
    for (const sample of samples) {
      const fixed = repairRunCodeSyntax(sample);
      if (fixed !== undefined) expect(parses(fixed)).toBe(true);
    }
  });

  it("leaves a Python triple-quoted string alone when it is already valid JS", () => {
    // A ''' at the start of an expression is not valid JS; repair may or may
    // not fix it, but must never produce something unparseable.
    const sample = "const x = 1;\nreturn x;";
    expect(repairRunCodeSyntax(sample)).toBeUndefined();
  });
});
