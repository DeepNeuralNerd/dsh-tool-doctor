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

  // Reviewer round (2026-11-14): trailing-comma stripping must never touch
  // string CONTENT — the old regex rewrote "x,}" to "x}".
  describe("string-aware trailing-comma stripping", () => {
    it("keeps a string containing ,} while dropping the structural comma", () => {
      const result = repairArgsPayload('{"text":"x,}","count":1,}');
      const args = result!.args as Record<string, unknown>;
      expect(args.text).toBe("x,}");
      expect(args.count).toBe(1);
    });

    it("keeps commas inside strings beside a trailing-comma array", () => {
      const result = repairArgsPayload('{"list":[1,2,],"note":"a, b, c,"}');
      const args = result!.args as Record<string, unknown>;
      expect(args.list).toEqual([1, 2]);
      expect(args.note).toBe("a, b, c,");
    });

    it("respects escaped quotes inside the string while scanning", () => {
      const result = repairArgsPayload('{"q":"say \\"hi,}\\" end",}');
      expect((result!.args as Record<string, unknown>).q).toBe('say "hi,}" end');
    });
  });

  // Reviewer round (2026-11-14): RFC 8259 §4 duplicate member names — JSON.parse
  // keeps one value silently, so Doctor must never adopt an ambiguous payload.
  describe("duplicate member-name guard (RFC 8259)", () => {
    it("refuses a payload whose top-level name repeats (silent last-wins target swap)", () => {
      expect(repairArgsPayload('{"file_path":"safe.txt","file_path":"other.txt"}')).toBeUndefined();
    });

    it("refuses even when both values are identical (ambiguity is the signal)", () => {
      expect(repairArgsPayload('{"a":1,"a":1}')).toBeUndefined();
    });

    it("refuses a duplicate nested inside a value object", () => {
      expect(repairArgsPayload('{"meta":{"k":1,"k":2}}')).toBeUndefined();
    });

    it("refuses duplicates behind every recovery step: fenced, prose, double-encoded", () => {
      expect(repairArgsPayload('```json\n{"a":1,"a":2}\n```')).toBeUndefined();
      expect(repairArgsPayload('Sure! {"a":1,"a":2}')).toBeUndefined();
      expect(repairArgsPayload(JSON.stringify('{"a":1,"a":2}'))).toBeUndefined();
    });

    it("does not mistake quoted text for a repeated name", () => {
      const result = repairArgsPayload('{"a":"has \\"quoted\\": colon","b":2}');
      expect(result).toBeDefined();
      expect((result!.args as Record<string, unknown>).a).toBe('has "quoted": colon');
    });

    it("handles an escaped-quote member name without flagging it", () => {
      const result = repairArgsPayload('{"he said \\"hi\\"":1,"plain":2}');
      expect(result).toBeDefined();
      expect((result!.args as Record<string, unknown>).plain).toBe(2);
    });
  });

  describe("brace completion (REC-1 ladder step)", () => {
    it("adopts a payload missing exactly one closing brace", () => {
      const result = repairArgsPayload('{"file_path":"C:\\\\tmp\\\\a.txt","limit":10');
      expect(result).toBeDefined();
      expect(result!.args).toEqual({ file_path: "C:\\tmp\\a.txt", limit: 10 });
    });

    it("adopts a payload missing a nested closer pair", () => {
      const result = repairArgsPayload('{"items":[1,2,{"x":3');
      expect(result).toBeDefined();
      expect(result!.args).toEqual({ items: [1, 2, { x: 3 }] });
    });

    it("never completes a brace that sits inside a quoted string", () => {
      // The brace is inside the value and the object is already closed: the
      // payload strict-parses at the plain step, so no completion is claimed.
      const result = repairArgsPayload('{"note":"a { brace stays"}');
      expect(result?.changes).toContain("plain JSON.parse");
    });

    it("completes braces demanded outside strings but keeps string braces", () => {
      // The value's inner brace is balanced and quoted; only the outer object
      // is missing its closer.
      const result = repairArgsPayload('{"note":"a { brace inside"');
      expect(result).toBeDefined();
      expect(result!.args).toEqual({ note: "a { brace inside" });
    });

    it("abstains when completion cannot produce valid JSON", () => {
      expect(repairArgsPayload('{"a":')).toBeUndefined();
    });

    it("abstains on text that is not an object at all", () => {
      expect(repairArgsPayload('hello world')).toBeUndefined();
    });
  });

  describe("python-literal payload (REC-2 ladder step)", () => {
    it("adopts a gateway-wrapped repr payload", () => {
      const result = repairArgsPayload("\"{'file_path': 'C:\\\\\\\\tmp\\\\\\\\x', 'limit': 5, 'force': True}\"");
      expect(result).toBeDefined();
      expect(result!.args).toEqual({ file_path: "C:\\tmp\\x", limit: 5, force: true });
    });

    it("adopts an unwrapped repr payload", () => {
      const result = repairArgsPayload("{'offset': None, 'limit': 10}");
      expect(result).toBeDefined();
      expect(result!.args).toEqual({ offset: null, limit: 10 });
    });

    it("abstains on an apostrophe inside a value (ambiguous quoting)", () => {
      expect(repairArgsPayload("\"{'note': it's fine'}\"")).toBeUndefined();
    });

    it("never touches a valid JSON payload (strict steps run first)", () => {
      // Any payload that already strict-parses must not reach the conversion.
      expect(repairArgsPayload({ ok: true })).toBeUndefined();
      const valid = repairArgsPayload('"{\\"ok\\": true}"');
      expect(valid?.changes).not.toContain("python-literal payload");
    });

    it("abstains on a python-looking list payload", () => {
      expect(repairArgsPayload("[1, 2, 3]")).toBeUndefined();
    });

    it("abstains on a quoted string that holds no object", () => {
      expect(repairArgsPayload("\"just a string\"")).toBeUndefined();
    });
  });
});
