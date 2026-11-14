import { describe, expect, it } from "vitest";
import { injectInnerDescriptions } from "../src/repair/inner-description.ts";

describe("injectInnerDescriptions", () => {
  const requires = (): boolean => true;

  it("injects a description into a bare tools.bash call", () => {
    const code = "const r = await tools.bash({ command: 'ls' });\nreturn r;";
    const out = injectInnerDescriptions(code, "List files", requires);
    expect(out.injected).toBe(1);
    expect(out.code).toContain("description:");
    expect(out.code).toContain("List files");
  });

  it("does not duplicate a description that already exists at depth 0", () => {
    const code = "const r = await tools.bash({ command: 'ls', description: 'already' });\nreturn r;";
    const out = injectInnerDescriptions(code, "List files", requires);
    expect(out.injected).toBe(0);
  });

  it("skips the whole pass when no tools. call is present (fast path)", () => {
    const code = "const x = 1;\nreturn x;";
    const out = injectInnerDescriptions(code, "noop", requires);
    expect(out.injected).toBe(0);
    expect(out.code).toBe(code);
  });

  it("respects a tool that does not require description", () => {
    const code = "const r = await tools.read({ file_path: '/a.txt' });\nreturn r;";
    const out = injectInnerDescriptions(code, "Read a", (tool) => tool !== "read");
    expect(out.injected).toBe(0);
  });

  it("handles multiple calls in one program", () => {
    const code = [
      "const a = await tools.bash({ command: 'ls' });",
      "const b = await tools.grep({ pattern: 'x', path: '/w' });",
      "return [a, b];",
    ].join("\n");
    const out = injectInnerDescriptions(code, "Two calls", requires);
    expect(out.injected).toBe(2);
  });

  it("does not break a call whose arguments span multiple lines", () => {
    const code = [
      "const r = await tools.bash({",
      "  command: 'ls -la',",
      "});",
      "return r;",
    ].join("\n");
    const out = injectInnerDescriptions(code, "Long form", requires);
    expect(out.injected).toBe(1);
    // The injected program must still parse. Use the async-function constructor
    // so a top-level `await` in the body is valid (run_code bodies may await).
    try {
      new ((async () => {}).constructor as unknown as new (src: string) => object)(out.code);
    } catch (e) {
      throw new Error(`injected code does not parse: ${String(e)}\n${out.code}`);
    }
  });

  it("leaves untrusted/unclear shapes untouched", () => {
    // A spread makes the property set unknown → no injection.
    const code = "const r = await tools.bash({ ...defaults, command: 'ls' });\nreturn r;";
    const out = injectInnerDescriptions(code, "Spread", requires);
    expect(out.injected).toBe(0);
  });
});
