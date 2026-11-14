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
 * Extract the usable JSON schema from an unknown tool definition.
 * Tries inputSchema first, then parameters, then falls back to the object itself.
 * @param def - The tool definition (unknown).
 * @returns A JSON Schema-like object with properties, or undefined if unusable.
 */
function extractSchema(def: unknown): { type?: string; properties?: Record<string, unknown> } | undefined {
  // Try inputSchema first
  if (typeof def === "object" && def !== null) {
    const schema = (def as any).inputSchema ?? (def as any).parameters;
    if (schema && typeof schema === "object" && schema !== null) {
      return schema as { type?: string; properties?: Record<string, unknown> };
    }
  }

  // Fallback: use the definition itself if it looks like a JSON Schema object
  if (typeof def === "object" && def !== null) {
    const d = def as any;
    if (d.type === "object" && d.properties && typeof d.properties === "object") {
      return d as { type?: string; properties?: Record<string, unknown> };
    }
  }

  return undefined;
}

/**
 * Check if a value is a plain object (not array, not null).
 */
function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce a single argument value according to its declared schema type.
 * @param declaredType - The JSON Schema type declaration.
 * @param propSchema - The full property schema object (for enum lookup).
 * @param rawValue - The raw value from the model call.
 * @returns A tuple of [coercedValue, changedFlag].
 */
function coerceProperty(
  declaredType: unknown,
  propSchema: Record<string, unknown>,
  rawValue: unknown,
): [unknown, boolean] {
  // Only coerce when rawArgs has that key holding a STRING.
  // Numbers/booleans/objects/arrays are never touched; keys not in schema are never touched.
  if (typeof rawValue !== "string") {
    return [rawValue, false];
  }

  const trimmed = rawValue.trim();
  let coerced: unknown = rawValue;
  let changed = false;

  // Handle union types (ARRAY of types containing "string" or "number")
  if (Array.isArray(declaredType)) {
    for (const t of declaredType) {
      const [result, isChanged] = coercePropertyForType(t as string, propSchema, trimmed);
      if (isChanged && coerced === rawValue) {
        // First successful coercion wins; don't overwrite with unchanged result
        coerced = result;
        changed = true;
      } else if (!changed && !isChanged) {
        // If we haven't changed yet and this type didn't match, keep trying
        continue;
      }
      // If a coercion succeeded but returned the same value (no-op), don't override
    }
  } else if (typeof declaredType === "string") {
    const [result, isChanged] = coercePropertyForType(declaredType as string, propSchema, trimmed);
    coerced = result;
    changed = isChanged;
  }

  return [coerced, changed];
}

/**
 * Coerce a single property based on its specific type declaration.
 */
function coercePropertyForType(
  declaredType: string,
  propSchema: Record<string, unknown>,
  trimmedValue: string,
): [unknown, boolean] {
  let coerced: unknown = trimmedValue;
  let changed = false;

  switch (declaredType) {
    case "number":
      // Trimmed string matches /^-?\d+(\.\d+)?$/ → Number(value). Reject "", "42px", "1,000".
      if (/^-?\d+(\.\d+)?$/.test(trimmedValue)) {
        const num = Number(trimmedValue);
        coerced = num;
        changed = true;
      }
      break;

    case "integer":
      // Trimmed string matches /^-?\d+$/ → Number(value).
      if (/^-?\d+$/.test(trimmedValue)) {
        const int = Number(trimmedValue);
        coerced = int;
        changed = true;
      }
      break;

    case "boolean":
      // Trimmed lowercase "true"/"false" → real boolean (case-insensitive).
      if (trimmedValue.toLowerCase() === "true") {
        coerced = true;
        changed = true;
      } else if (trimmedValue.toLowerCase() === "false") {
        coerced = false;
        changed = true;
      }
      break;

    case "array":
      // Option 1: trimmed string starts with "[" and JSON.parse yields an Array → parsed array.
      if (trimmedValue.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmedValue);
          if (Array.isArray(parsed)) {
            coerced = parsed;
            changed = true;
            break;
          }
        } catch {
          // Fall through to comma-list parsing
        }
      }

      // Option 2: string contains no brackets/braces, does not parse as JSON number, and contains "," → split on "," + trim each part.
      if (trimmedValue.includes(",") && !/[{}\[\]]/.test(trimmedValue)) {
        try {
          const parts = trimmedValue.split(",").map((p) => p.trim());
          // Filter out empty strings that might result from trailing commas
          coerced = parts.filter((p) => p.length > 0);
          changed = true;
        } catch {
          // Ignore parse errors (shouldn't happen with simple comma split)
        }
      }
      break;

    case "object":
      // Trimmed string starts with "{" and JSON.parse yields a plain object → parsed object.
      if (trimmedValue.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmedValue);
          if (isPlainObject(parsed)) {
            coerced = parsed;
            changed = true;
            break;
          }
        } catch {
          // Fall through to enum handling
        }
      }
      break;

    case "string": {
      // Handle enum: if the string does not equal any enum member, compare case-insensitively
      // after removing "-" and "_"; replace ONLY when exactly one enum member matches.
      const schema = propSchema as Record<string, unknown>;
      if (schema.enum && Array.isArray(schema.enum)) {
        const exactMatch = schema.enum.find((e) => String(e).toLowerCase() === trimmedValue.toLowerCase());
        if (exactMatch !== undefined) {
          // Exact match found; no change needed
          return [coerced as string, false];
        }

        // No exact match: normalize and find matches
        const normalized = trimmedValue.replace(/[-_]/g, "").toLowerCase();
        const matches = schema.enum.filter((e) => String(e).replace(/[-_]/g, "").toLowerCase() === normalized);

        if (matches.length === 1) {
          // Exactly one match: replace with that enum member
          coerced = matches[0];
          changed = true;
        } else {
          // Ambiguous or no match → leave untouched
          return [coerced as string, false];
        }
      }
      break;
    }

    case "null": {
      // Nullable field: a "null"/"undefined" sentinel string becomes real null.
      const lower = trimmedValue.toLowerCase();
      if (lower === "null" || lower === "undefined") {
        coerced = null;
        changed = true;
      }
      break;
    }

    default:
      // Unknown type: leave as-is
      break;
  }

  return [coerced, changed];
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
  toolName: string,
  rawArgs: unknown,
  toolDefinition: unknown,
): TypeCoercionResult | undefined {
  // Defensive checks everywhere
  if (typeof toolName !== "string") {
    return undefined;
  }

  if (!isPlainObject(rawArgs)) {
    return undefined;
  }

  const schema = extractSchema(toolDefinition);
  if (!schema || !schema.properties) {
    // No usable schema or no properties → return undefined.
    return undefined;
  }

  // Defensive cast: we already validated rawArgs is a plain object above
  const args: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };
  const changes: string[] = [];

  for (const [name, propSchema] of Object.entries(schema.properties)) {
    if (!isPlainObject(propSchema)) continue;

    const rawValue = args[name];
    if (rawValue === undefined || rawValue === null) continue;

    // Extract the actual type declaration from the property schema
    const declaredType = (propSchema as Record<string, unknown>).type;
    const [coerced, changed] = coerceProperty(declaredType, propSchema as Record<string, unknown>, rawValue);

    if (changed && coerced !== rawValue) {
      args[name] = coerced;
      changes.push(`field ${name} coerced to ${getTargetType(propSchema as Record<string, unknown>)}`);
    }
  }

  // When nothing changed → return undefined. When something changed → result object.
  if (changes.length === 0) {
    return undefined;
  }

  return { args, changes };
}

/**
 * Helper to get a human-readable target type for change messages.
 */
function getTargetType(propSchema: Record<string, unknown>): string {
  const t = propSchema.type;
  if (Array.isArray(t)) {
    // For union types containing "string" or "number", return the first non-string/number type
    const nonBasic = t.find((type) => type !== "string" && type !== "number");
    return nonBasic ?? "union";
  }
  if (typeof t === "string") {
    return t;
  }
  return "unknown";
}
