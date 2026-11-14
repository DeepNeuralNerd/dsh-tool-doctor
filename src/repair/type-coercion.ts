/**
 * Schema-aware argument type coercion for the ARGS_TYPE rule (rule 9, family 1).
 *
 * Models emit the right value in the wrong JSON type. The LiteLLM `"123"`
 * regression is the standing warning: coerce ONLY when the WHOLE value parses
 * to the declared type — never re-interpret a string the schema actually
 * wanted. The declared type is read from the tool definition the host exposes
 * (`inputSchema`/`parameters`, JSON-Schema-shaped); without a usable schema
 * this module is a no-op by design.
 *
 * Supported coercions (each whole-value-guarded):
 *  - string → number        ("42", "3.5", "-1"; NOT "42px", "", "1,000")
 *  - string → boolean       ("true"/"false", case-insensitive)
 *  - string → array/object  (the string must JSON.parse to that shape)
 *  - number/boolean → string (only when schema declares string and the value
 *    came in as a bare primitive AND the tool is known to require strings —
 *    deliberately NOT applied by default; see tests)
 *  - "null"/"undefined" sentinel strings → null, only for nullable fields
 *
 * @module dsh-tool-doctor/repair/type-coercion
 */

/** Outcome of a successful coercion pass. */
export interface TypeCoercionResult {
  args: Record<string, unknown>;
  changes: string[];
}

/**
 * Coerce argument values toward the types the tool's JSON schema declares.
 * @param toolName - The dispatched tool name.
 * @param rawArgs - Raw model arguments (already a plain object).
 * @param toolDefinition - The host tool definition, when available; the
 *   schema may sit under `inputSchema` or `parameters` (JSON Schema). A
 *   definition without either makes this a no-op.
 * @returns A corrected copy when something changed, else undefined (no-op).
 */
export function coerceArgTypes(
  _toolName: string,
  _rawArgs: unknown,
  _toolDefinition: unknown,
): TypeCoercionResult | undefined {
  // SCAFFOLD STUB — real implementation + tests delivered by the schema-args
  // work package. Inert here: every call passes through untouched.
  return undefined;
}
