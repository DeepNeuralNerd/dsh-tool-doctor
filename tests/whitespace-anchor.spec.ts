import { describe, expect, it } from "vitest";
import { editAnchorVariants } from "../src/repair/whitespace-anchor.ts";

describe("editAnchorVariants", () => {
  it("LF multi-line anchor → one CRLF variant", () => {
    const needle = "line1\nline2\nline3";
    const variants = editAnchorVariants(needle);
    expect(variants.length).toBeGreaterThanOrEqual(1);
    // Should contain a CRLF variant.
    expect(variants.some((v) => v.includes("\r\n") && !v.includes("\n\r"))).toBe(true);
  });

  it("CRLF anchor → LF variant", () => {
    const needle = "line1\r\nline2\r\nline3";
    const variants = editAnchorVariants(needle);
    expect(variants.length).toBeGreaterThanOrEqual(1);
    // Should contain an LF variant.
    expect(variants.some((v) => v.includes("\n") && !v.includes("\r\n"))).toBe(true);
  });

  it("tab-indented anchor → space variant", () => {
    const needle = "\tline1\n\tline2";
    const variants = editAnchorVariants(needle);
    expect(variants.length).toBeGreaterThanOrEqual(1);
    // Should contain a variant with leading spaces instead of tabs.
    expect(variants.some((v) => v.startsWith("    ") && !v.includes("\t"))).toBe(true);
  });

  it("4-space anchor → tab variant", () => {
    const needle = "    line1\n    line2";
    const variants = editAnchorVariants(needle);
    expect(variants.length).toBeGreaterThanOrEqual(1);
    // Should contain a variant with leading tabs.
    expect(variants.some((v) => v.startsWith("\t") && !v.startsWith("    "))).toBe(true);
  });

  it("single-line 'abc' → []", () => {
    const variants = editAnchorVariants("abc");
    expect(variants).toEqual([]); // Nothing to flip on single line without leading ws.
  });

  it("variants never contain the original", () => {
    const needle = "line1\nline2";
    const variants = editAnchorVariants(needle);
    for (const v of variants) {
      expect(v).not.toBe(needle);
    }
  });

  it("at most 2 returned", () => {
    const needle = "line1\r\nline2";
    const variants = editAnchorVariants(needle);
    expect(variants.length).toBeLessThanOrEqual(2);
  });

  it("handles mixed line endings with indentation", () => {
    const needle = "\tline1\r\n    line2\nline3";
    const variants = editAnchorVariants(needle);
    // Should produce at least one variant (CRLF→LF or indentation flip).
    expect(variants.length).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates identical variants", () => {
    const needle = "line1\nline2";
    const variants = editAnchorVariants(needle);
    // No duplicates in the result.
    const unique = new Set(variants);
    expect(unique.size).toBe(variants.length);
  });
});
