/**
 * Tests for the cut-off-arguments shape heuristic (truncation hint source).
 */
import { describe, expect, it } from "vitest";
import { looksTruncatedArgs } from "../src/support/truncation.ts";

describe("looksTruncatedArgs", () => {
  it("flags a payload cut inside a string value", () => {
    expect(looksTruncatedArgs('{"content": "console.log(1')).toBe(true);
  });

  it("flags a payload cut inside an object", () => {
    expect(looksTruncatedArgs('{"code": "console.log(1)')).toBe(true);
  });

  it("accepts a complete JSON object string", () => {
    expect(looksTruncatedArgs('{"file_path":"/a.txt"}')).toBe(false);
  });

  it("rejects non-string payloads", () => {
    expect(looksTruncatedArgs(42)).toBe(false);
    expect(looksTruncatedArgs({ file_path: "/a.txt" })).toBe(false);
    expect(looksTruncatedArgs(undefined)).toBe(false);
  });

  it("flags a trailing backslash (cut inside an escape)", () => {
    expect(looksTruncatedArgs("C:\\Users\\x\\")).toBe(true);
  });

  it("rejects empty and whitespace-only payloads", () => {
    expect(looksTruncatedArgs("")).toBe(false);
    expect(looksTruncatedArgs("   \n ")).toBe(false);
  });

  it("flags an unclosed code fence", () => {
    expect(looksTruncatedArgs('{"code": "```python\nprint(1)')).toBe(true);
  });

  it("accepts a closed fence", () => {
    expect(looksTruncatedArgs('```python\nprint(1)\n```')).toBe(false);
  });

  it("flags a key left without its value", () => {
    expect(looksTruncatedArgs('{"file_path":')).toBe(true);
    expect(looksTruncatedArgs('{"file_path":   ')).toBe(true);
  });

  it("does not count braces inside quoted spans", () => {
    expect(looksTruncatedArgs('{"note": "a } brace in text"}')).toBe(false);
  });

  it("does not miscount escaped quotes", () => {
    // Even number of UNESCAPED quotes (\" pairs do not flip the string state).
    expect(looksTruncatedArgs('{"say": "he said \\"hi\\" now"}')).toBe(false);
  });
});
