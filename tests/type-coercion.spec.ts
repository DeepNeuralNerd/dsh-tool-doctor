/**
 * Vitest test suite for type-coercion.ts.
 *
 * Covers all coercion rules per the schema:
 * - number, integer, boolean, array, object types
 * - enum case-insensitive matching with ambiguity detection
 * - union types (ARRAY of types containing "string" or "number")
 * - defensive edge cases and no-op scenarios
 */

import { describe, it, expect } from "vitest";
import { coerceArgTypes, TypeCoercionResult } from "../src/repair/type-coercion.ts";

describe("type-coercion", () => {
  const fakeToolDefinition = {
    name: "t",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number" },
        count: { type: "integer" },
        flag: { type: "boolean" },
        items: { type: "array" },
        meta: { type: "object" },
        mode: { type: "string", enum: ["fast-mode", "slow_mode"] } as const,
      },
    },
  };

  describe("number coercion", () => {
    it('coerces "42" to number 42', () => {
      const result = coerceArgTypes("t", { limit: "42" }, fakeToolDefinition);
      expect(result).toBeDefined();
      expect(result?.args.limit).toBe(42);
      expect(result?.changes).toContain("field limit coerced to number");
    });

    it('coerces "3.5" to float 3.5', () => {
      const result = coerceArgTypes("t", { limit: "3.5" }, fakeToolDefinition);
      expect(result?.args.limit).toBe(3.5);
      expect(result?.changes).toContain("field limit coerced to number");
    });

    it('coerces "-12.9" to negative float (number type)', () => {
      const result = coerceArgTypes("t", { limit: "-12.9" }, fakeToolDefinition);
      // Number type accepts decimals, so this should be coerced
      expect(result?.args.limit).toBe(-12.9);
      expect(result?.changes).toContain("field limit coerced to number");
    });

    it('leaves "42px" untouched (invalid number)', () => {
      const result = coerceArgTypes("t", { limit: "42px" }, fakeToolDefinition);
      expect(result).toBeUndefined(); // No coercion attempted, no change → undefined
    });

    it('rejects empty string for number', () => {
      const result = coerceArgTypes("t", { limit: "" }, fakeToolDefinition);
      expect(result).toBeUndefined();
    });

    it('rejects "1,000" (contains comma)', () => {
      const result = coerceArgTypes("t", { count: "1,000" }, fakeToolDefinition);
      expect(result).toBeUndefined();
    });
  });

  describe("integer coercion", () => {
    it('coerces "42" to integer', () => {
      const result = coerceArgTypes("t", { count: "42" }, fakeToolDefinition);
      expect(result?.args.count).toBe(42);
      expect(result?.changes).toContain("field count coerced to integer");
    });

    it('leaves "1.5" untouched for integer (decimal)', () => {
      const result = coerceArgTypes("t", { count: "1.5" }, fakeToolDefinition);
      // Integer rule requires /^-?\d+$/, so "1.5" fails → no coercion
      expect(result).toBeUndefined();
    });

    it('coerces "-7" to negative integer', () => {
      const result = coerceArgTypes("t", { count: "-7" }, fakeToolDefinition);
      expect(result?.args.count).toBe(-7);
      expect(result?.changes).toContain("field count coerced to integer");
    });
  });

  describe("boolean coercion", () => {
    it('coerces "TRUE" to true (case-insensitive)', () => {
      const result = coerceArgTypes("t", { flag: "TRUE" }, fakeToolDefinition);
      expect(result?.args.flag).toBe(true);
      expect(result?.changes).toContain("field flag coerced to boolean");
    });

    it('coerces "FALSE" to false (case-insensitive)', () => {
      const result = coerceArgTypes("t", { flag: "FALSE" }, fakeToolDefinition);
      expect(result?.args.flag).toBe(false);
      expect(result?.changes).toContain("field flag coerced to boolean");
    });

    it('coerces "true"/"false" lowercase', () => {
      const result = coerceArgTypes("t", { flag: "true" }, fakeToolDefinition);
      expect(result?.args.flag).toBe(true);
    });

    it('leaves "maybe" untouched (invalid boolean)', () => {
      const result = coerceArgTypes("t", { flag: "maybe" }, fakeToolDefinition);
      expect(result).toBeUndefined();
    });
  });

  describe("array coercion", () => {
    it('coerces "[1,2]" to array via JSON.parse', () => {
      const result = coerceArgTypes("t", { items: "[1,2]" }, fakeToolDefinition);
      expect(result?.args.items).toEqual([1, 2]);
      expect(result?.changes).toContain("field items coerced to array");
    });

    it('coerces "a,b" to ["a","b"] via comma-list split', () => {
      const result = coerceArgTypes("t", { items: "a,b" }, fakeToolDefinition);
      expect(result?.args.items).toEqual(["a", "b"]);
      expect(result?.changes).toContain("field items coerced to array");
    });

    it('coerces "[ 1 , 2 ]" with spaces via JSON.parse', () => {
      const result = coerceArgTypes("t", { items: "[ 1 , 2 ]" }, fakeToolDefinition);
      expect(result?.args.items).toEqual([1, 2]);
    });

    it('leaves "not-an-array" untouched (no brackets)', () => {
      const result = coerceArgTypes("t", { items: "not-an-array" }, fakeToolDefinition);
      expect(result).toBeUndefined();
    });

    it('handles empty array string "[ ]"', () => {
      const result = coerceArgTypes("t", { items: "[ ]" }, fakeToolDefinition);
      expect(result?.args.items).toEqual([]);
      expect(result?.changes).toContain("field items coerced to array");
    });

    it('handles comma-list with trailing space "a, b"', () => {
      const result = coerceArgTypes("t", { items: "a, b" }, fakeToolDefinition);
      expect(result?.args.items).toEqual(["a", "b"]);
    });
  });

  describe("object coercion", () => {
    it('coerces "{\\"k\\":1}" to object via JSON.parse', () => {
      const result = coerceArgTypes("t", { meta: '{"k":1}' }, fakeToolDefinition);
      expect(result?.args.meta).toEqual({ k: 1 });
      expect(result?.changes).toContain("field meta coerced to object");
    });

    it('coerces nested JSON object', () => {
      const result = coerceArgTypes(
        "t",
        { meta: '{"nested": {"a": 1}}' },
        fakeToolDefinition,
      );
      expect(result?.args.meta).toEqual({ nested: { a: 1 } });
    });

    it('leaves "not-json" untouched (invalid object)', () => {
      const result = coerceArgTypes("t", { meta: 'not-json' }, fakeToolDefinition);
      expect(result).toBeUndefined();
    });
  });

  describe("enum coercion", () => {
    it('leaves exact match "fast-mode" untouched', () => {
      const result = coerceArgTypes("t", { mode: "fast-mode" }, fakeToolDefinition);
      // Exact match → no coercion needed, returns undefined (no change)
      expect(result).toBeUndefined();
    });

    it('coerces "FAST-MODE" to "fast-mode" (case-insensitive exact match, no change)', () => {
      const result = coerceArgTypes("t", { mode: "FAST-MODE" }, fakeToolDefinition);
      // Exact case-insensitive match → no coercion needed, returns undefined (no change)
      expect(result).toBeUndefined();
    });

    it('coerces ambiguous case-insensitive "FAST_MODE" when only one enum member matches', () => {
      const altDef = {
        name: "alt",
        inputSchema: {
          type: "object" as const,
          properties: {
            mode: {
              type: "string" as const,
              enum: ["fast-mode", "slow_mode"] as const,
            },
          },
        },
      };

      // "FAST_MODE" normalizes to "fastmode" → matches only "fast-mode" (after removing -_)
      const result = coerceArgTypes("t", { mode: "FAST_MODE" }, altDef);
      expect(result?.args.mode).toBe("fast-mode");
    });

    it('leaves ambiguous enum untouched when multiple members match', () => {
      // Create a definition with two enum members that would both match after normalization
      const ambiguousDef = {
        name: "ambig",
        inputSchema: {
          type: "object" as const,
          properties: {
            mode: {
              type: "string" as const,
              // Both "fast-mode" and "fast_mode" normalize to "fastmode"
              enum: ["fast-mode", "fast_mode"] as const,
            },
          },
        },
      };

      // Input is exact match for "fast-mode", so no coercion needed anyway
      const result = coerceArgTypes("ambig", { mode: "fast-mode" }, ambiguousDef);
      expect(result).toBeUndefined();

      // Now test with a case where ambiguity would occur but input is already exact
      const result2 = coerceArgTypes(
        "ambig",
        { mode: "FAST_MODE" },
        ambiguousDef,
      );
      // "FAST_MODE" normalizes to "fastmode" → matches BOTH enum members → ambiguous → untouched
      expect(result).toBeUndefined();
    });

    it('leaves non-matching enum value untouched', () => {
      const result = coerceArgTypes("t", { mode: "unknown-mode" }, fakeToolDefinition);
      // No match at all → undefined (no change)
      expect(result).toBeUndefined();
    });
  });

  describe("union types (ARRAY of types)", () => {
    it('applies coercion rules for union type ["string","null"] in order', () => {
      const unionDef = {
        name: "union",
        inputSchema: {
          type: "object" as const,
          properties: {
            field: {
              type: ["string", "null"] as const,
            },
          },
        },
      };

      // String rule applies first and succeeds → no further attempts
      const result = coerceArgTypes("union", { field: "hello" }, unionDef);
      expect(result).toBeUndefined(); // Exact string match, no coercion needed

      // Test with a value that needs enum-style matching in union context
      const enumUnionDef = {
        name: "enum-union",
        inputSchema: {
          type: "object" as const,
          properties: {
            field: {
              type: ["string", "null"] as const,
              enum: ["active", "inactive"] as const,
            },
          },
        },
      };

      // "ACTIVE" should match exactly (case-insensitive) → no coercion needed
      const result2 = coerceArgTypes("enum-union", { field: "ACTIVE" }, enumUnionDef);
      expect(result2).toBeUndefined(); // Exact case-insensitive match, no change
    });

    it('handles number type first in union ["number","string"]', () => {
      const numStringUnionDef = {
        name: "num-str-union",
        inputSchema: {
          type: "object" as const,
          properties: {
            field: {
              type: ["number", "string"] as const,
            },
          },
        },
      };

      // Reviewer round correction: member ORDER no longer decides — a string
      // value already satisfies the union, so it is preserved untouched.
      const result = coerceArgTypes("numStringUnionDef", { field: "42" }, numStringUnionDef);
      expect(result).toBeUndefined();
    });
  });

  describe("defensive edge cases", () => {
    it('leaves number input untouched (never coerces non-strings)', () => {
      const result = coerceArgTypes("t", { limit: 42 }, fakeToolDefinition);
      expect(result).toBeUndefined(); // Already a number, no coercion needed
    });

    it('leaves boolean input untouched', () => {
      const result = coerceArgTypes("t", { flag: true }, fakeToolDefinition);
      expect(result).toBeUndefined();
    });

    it('leaves object input untouched', () => {
      const result = coerceArgTypes("t", { meta: { key: "value" } }, fakeToolDefinition);
      expect(result).toBeUndefined();
    });

    it('leaves array input untouched', () => {
      const result = coerceArgTypes("t", { items: [1, 2, 3] }, fakeToolDefinition);
      expect(result).toBeUndefined();
    });

    it('leaves keys not in schema untouched (no coercion attempted)', () => {
      const extraDef = {
        name: "extra",
        inputSchema: {
          type: "object" as const,
          properties: {
            limit: { type: "number" },
          },
        },
      };

      // "unknownField" is not in schema → never touched
      const result = coerceArgTypes("extra", { unknownField: "42" }, extraDef);
      expect(result).toBeUndefined();
    });

    it('returns undefined when toolDefinition has no usable schema', () => {
      const noSchemaDef = { name: "no-schema" }; // No inputSchema, parameters, or properties
      const result = coerceArgTypes("t", { limit: "42" }, noSchemaDef);
      expect(result).toBeUndefined();
    });

    it('returns undefined when schema has no properties', () => {
      const emptyPropsDef = {
        name: "empty-props",
        inputSchema: { type: "object" as const, properties: {} },
      };
      const result = coerceArgTypes("t", { limit: "42" }, emptyPropsDef);
      expect(result).toBeUndefined();
    });

    it('returns undefined when rawArgs is not a plain object', () => {
      const result1 = coerceArgTypes("t", null as any, fakeToolDefinition);
      const result2 = coerceArgTypes("t", "string" as any, fakeToolDefinition);
      const result3 = coerceArgTypes("t", 42 as any, fakeToolDefinition);
      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();
      expect(result3).toBeUndefined();
    });

    it('returns undefined when toolName is not a string', () => {
      const result = coerceArgTypes(42 as any, {}, fakeToolDefinition);
      expect(result).toBeUndefined();
    });

    it('handles null/undefined values in rawArgs gracefully (skips them)', () => {
      const result = coerceArgTypes("t", { limit: "42", flag: null }, fakeToolDefinition);
      // null value is skipped, but "limit" gets coerced → changes list has one entry
      expect(result).toBeDefined();
      expect(result?.args.limit).toBe(42);
      expect(result?.changes.length).toBe(1);
    });

    it('returns changes list with correct field names', () => {
      const result = coerceArgTypes("t", { limit: "42", flag: "TRUE" }, fakeToolDefinition);
      expect(result?.changes.length).toBe(2);
      expect(result?.changes[0]).toContain("field limit coerced to number");
      expect(result?.changes[1]).toContain("field flag coerced to boolean");
    });

    it('returns undefined when nothing changed', () => {
      const result = coerceArgTypes("t", { limit: 42, flag: true }, fakeToolDefinition);
      // All values already correct types → no coercion attempted → undefined
      expect(result).toBeUndefined();
    });
  });

  describe("TypeCoercionResult interface compliance", () => {
    it('returns object with exactly args and changes properties', () => {
      const result = coerceArgTypes("t", { limit: "42" }, fakeToolDefinition);
      expect(result).toBeDefined();
      expect(typeof (result as TypeCoercionResult).args).toBe("object");
      expect(Array.isArray((result as TypeCoercionResult).changes)).toBe(true);
    });

    it('args is a copy, not the original rawArgs', () => {
      const result = coerceArgTypes("t", { limit: "42" }, fakeToolDefinition);
      // Modify the returned args; should not affect future calls (though we can't mutate primitives)
      expect(result?.args.limit).toBe(42);
    });

    it('changes is a non-empty array when coercion occurs', () => {
      const result = coerceArgTypes("t", { limit: "42" }, fakeToolDefinition);
      expect(Array.isArray(result?.changes)).toBe(true);
      expect(result?.changes.length).toBeGreaterThan(0);
    });
  });

  describe("top-level properties only (no recursion)", () => {
    it('does not recurse into nested objects', () => {
      const nestedDef = {
        name: "nested",
        inputSchema: {
          type: "object" as const,
          properties: {
            meta: {
              type: "object" as const,
              // Even if this had properties, we should NOT recurse into it
            },
          },
        },
      };

      const result = coerceArgTypes("nested", { meta: '{"inner": "value"}' }, nestedDef);
      expect(result?.args.meta).toEqual({ inner: "value" });
      // Only top-level "meta" was coerced; no recursion into its contents
    });
  });

  describe("null sentinel (nullable fields)", () => {
    const nullableDef = {
      name: "t",
      inputSchema: {
        type: "object" as const,
        properties: {
          note: { type: ["string", "null"] as const },
          label: { type: "string" as const },
        },
      },
    };

    it('converts "null" to real null for a nullable union field', () => {
      const result = coerceArgTypes("t", { note: "null" }, nullableDef);
      expect(result?.args.note).toBeNull();
      expect(result?.changes).toContain("field note coerced to null");
    });

    it('converts "Undefined" (case-insensitive) to real null', () => {
      const result = coerceArgTypes("t", { note: "Undefined" }, nullableDef);
      expect(result?.args.note).toBeNull();
    });

    it('leaves "null" untouched for a plain (non-nullable) string field', () => {
      expect(coerceArgTypes("t", { label: "null" }, nullableDef)).toBeUndefined();
    });
  });

  // Reviewer round (2026-11-14): a value that already satisfies the schema
  // must never be rewritten, and a coercion must not lose precision silently.
  describe("union-string preservation and precision guards", () => {
    const unionDef = (type: unknown) => ({ inputSchema: { properties: { v: { type } } } });

    it('keeps "42" for a ["string","number"] union — the string is already valid', () => {
      expect(coerceArgTypes("t", { v: "42" }, unionDef(["string", "number"]))).toBeUndefined();
    });

    it("keeps it regardless of union member order", () => {
      expect(coerceArgTypes("t", { v: "42" }, unionDef(["number", "string"]))).toBeUndefined();
    });

    it("still coerces when the union does NOT admit string", () => {
      const result = coerceArgTypes("t", { v: "42" }, unionDef(["number", "boolean"]));
      expect((result!.args as Record<string, unknown>).v).toBe(42);
    });

    it("rejects an integer coercion that would lose precision", () => {
      expect(coerceArgTypes("t", { v: "9007199254740993" }, unionDef("integer"))).toBeUndefined();
    });

    it("still coerces an exactly representable large integer", () => {
      // Number.MAX_SAFE_INTEGER (2^53 − 1) is the last exact double integer.
      const result = coerceArgTypes("t", { v: "9007199254740991" }, unionDef("integer"));
      expect((result!.args as Record<string, unknown>).v).toBe(9007199254740991);
    });

    it("also rejects 2^53 itself (not a safe integer)", () => {
      expect(coerceArgTypes("t", { v: "9007199254740992" }, unionDef("integer"))).toBeUndefined();
    });

    it("applies the same precision bar to number-typed integral literals", () => {
      expect(coerceArgTypes("t", { v: "9007199254740993" }, unionDef("number"))).toBeUndefined();
      const result = coerceArgTypes("t", { v: "3.5" }, unionDef("number"));
      expect((result!.args as Record<string, unknown>).v).toBe(3.5);
    });
  });
});
