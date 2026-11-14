/**
 * Tests for repairArgsPayload (ARGS_UNWRAP rule).
 *
 * @module dsh-tool-doctor/tests/args-json
 */

import { describe, it, expect } from "vitest";
import { repairArgsPayload } from "../src/repair/args-json.ts";

describe("repairArgsPayload", () => {
  // Rule 1: plain healthy object → undefined (already usable)
  it("returns undefined for a plain healthy object", () => {
    const input = { path: "x", mode: "r" };
    expect(repairArgsPayload(input)).toBeUndefined();
  });

  // Wrapper unwrap: single recognized key with plain object value
  it("unwraps one-key envelope with 'arguments'", () => {
    const input = { arguments: { path: "x", mode: "r" } };
    const result = repairArgsPayload(input);
    expect(result).toBeDefined();
    expect(result?.args).toEqual({ path: "x", mode: "r" });
    expect(result?.changes).toEqual(["Unwrapped one-level arguments envelope"]);
  });

  it("unwraps single-key {'params':{...}}", () => {
    const input = { params: { a: 1 } };
    const result = repairArgsPayload(input);
    expect(result).toBeDefined();
    expect(result?.args).toEqual({ a: 1 });
    expect(result?.changes.length).toBeGreaterThan(0);
  });

  // Two-key object → undefined (ambiguous envelope)
  it("returns undefined for two-key object containing 'arguments'", () => {
    const input = { a: 1, arguments: { b: 2 } };
    expect(repairArgsPayload(input)).toBeUndefined();
  });

  // Rule 2: string repairs — fenced markdown JSON
  it("unwraps fenced ```json ... ``` string", () => {
    const input = "```json\n{\"a\":1}\n```";
    const result = repairArgsPayload(input);
    expect(result).toBeDefined();
    expect(result?.args).toEqual({ a: 1 });
    expect(result?.changes.length).toBeGreaterThan(0);
  });

  it("unwraps fenced ``` ... ``` string (no language tag)", () => {
    const input = "```\n{\"a\":2}\n```";
    const result = repairArgsPayload(input);
    expect(result).toBeDefined();
    expect(result?.args).toEqual({ a: 2 });
    expect(result?.changes.length).toBeGreaterThan(0);
  });

  // Double-encoded JSON string
  it("unwraps double-encoded JSON string", () => {
    const input = JSON.stringify(JSON.stringify({ x: 9 }));
    const result = repairArgsPayload(input);
    expect(result).toBeDefined();
    expect(result?.args).toEqual({ x: 9 });
    expect(result?.changes.length).toBeGreaterThan(0);
  });

  // Prose around braces
  it("unwraps JSON from prose with leading/trailing text", () => {
    const input = 'Sure! {"path":"x"}';
    const result = repairArgsPayload(input);
    expect(result).toBeDefined();
    expect(result?.args).toEqual({ path: "x" });
    expect(result?.changes.length).toBeGreaterThan(0);
  });

  // Trailing comma removal
  it("unwraps JSON with trailing comma", () => {
    const input = '{"a":1,}';
    const result = repairArgsPayload(input);
    expect(result).toBeDefined();
    expect(result?.args).toEqual({ a: 1 });
    expect(result?.changes.length).toBeGreaterThan(0);
  });

  // Rule 3: other types → undefined
  it("returns undefined for string '42'", () => {
    expect(repairArgsPayload("42")).toBeUndefined();
  });

  it("returns undefined for string '[1,2]' (array JSON)", () => {
    expect(repairArgsPayload("[1,2]")).toBeUndefined();
  });

  it("returns undefined for garbage 'not json'", () => {
    expect(repairArgsPayload("not json")).toBeUndefined();
  });

  // Additional edge cases to ensure robustness:
  it("returns undefined for null input", () => {
    expect(repairArgsPayload(null)).toBeUndefined();
  });

  it("returns undefined for array input", () => {
    expect(repairArgsPayload([1, 2, 3])).toBeUndefined();
  });

  it("returns undefined for boolean input", () => {
    expect(repairArgsPayload(true)).toBeUndefined();
  });

  it("returns undefined for number input", () => {
    expect(repairArgsPayload(42)).toBeUndefined();
  });

  // Verify changes array is non-empty for every success case:
  it("ensures changes array is non-empty on unwrap success", () => {
    const result = repairArgsPayload({ arguments: { x: 1 } });
    expect(result?.changes).not.toBeNull();
    expect(result?.changes.length).toBeGreaterThan(0);
  });

  it("ensures changes array is non-empty on JSON repair success", () => {
    const result = repairArgsPayload('{"a":1,}');
    expect(result?.changes).not.toBeNull();
    expect(result?.changes.length).toBeGreaterThan(0);
  });
});
