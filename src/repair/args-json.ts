/**
 * Structural argument repair for the ARGS_UNWRAP rule (rule 9, family 2).
 *
 * Two shapes, one module:
 *  - A plain-object envelope with a single recognized wrapper key
 *    (`arguments`/`args`/`input`/…) is unwrapped one level.
 *  - A STRING payload is recovered through ordered stages (plain parse,
 *    markdown-fence strip, prose slice, trailing-comma strip, double-decode);
 *    the rewrite is adopted only when the final parse yields a plain object.
 *
 * @module dsh-tool-doctor/repair/args-json
 */

export interface ArgUnwrapResult {
  args: Record<string, unknown>;
  changes: string[];
}

const SINGLE_KEY_WRAPPERS = new Set([
  "arguments", "args", "input", "parameters", "tool_input", "params", "payload"
]);

function isPlainObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp)
  );
}

function isWrapperKey(key: string): boolean {
  return SINGLE_KEY_WRAPPERS.has(key.toLowerCase());
}

/**
 * Drop commas that only precede a closing `}`/`]`. STRING-AWARE: a scanner
 * walks the text and never edits inside a quoted string (escape-respecting),
 * so `{"text":"x,}","count":1,}` loses only the structural comma — the naive
 * regex also matched `,"`-free commas inside strings and corrupted content.
 */
function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === "}" || input[j] === "]") continue; // structural comma: drop
    }
    out += ch;
  }
  return out;
}

function stripMarkdownFences(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.startsWith("```json") && trimmed.endsWith("```")) {
    return trimmed.slice(7, -3);
  }
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.slice(3, -3);
  }
  return undefined;
}

function extractJsonObjectFromProse(input: string): string | undefined {
  const startIdx = input.indexOf("{");
  if (startIdx === -1) return undefined;
  const endIdx = input.lastIndexOf("}");
  if (endIdx <= startIdx || endIdx === -1) return undefined;
  return input.slice(startIdx, endIdx + 1);
}

function parseWithRecovery(raw: string): { value: Record<string, unknown>; changes: string[] } | null {
  // Step a: plain JSON.parse
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) {
      return { value: parsed as Record<string, unknown>, changes: ["plain JSON.parse"] };
    }
  } catch {}

  // Step b: strip markdown fences then parse
  const withFencesStripped = stripMarkdownFences(raw);
  if (withFencesStripped !== undefined) {
    try {
      const parsed = JSON.parse(withFencesStripped);
      if (isPlainObject(parsed)) {
        return { value: parsed as Record<string, unknown>, changes: ["strip markdown fences", "JSON.parse"] };
      }
    } catch {}
  }

  // Step c: slice from first "{" to last "}" then parse
  const withProseStripped = extractJsonObjectFromProse(raw);
  if (withProseStripped !== undefined) {
    try {
      const parsed = JSON.parse(withProseStripped);
      if (isPlainObject(parsed)) {
        return { value: parsed as Record<string, unknown>, changes: ["extract from prose", "JSON.parse"] };
      }
    } catch {}
  }

  // Step d: remove trailing commas then parse
  const withTrailingCommasStripped = stripTrailingCommas(raw);
  if (withTrailingCommasStripped !== raw) {
    try {
      const parsed = JSON.parse(withTrailingCommasStripped);
      if (isPlainObject(parsed)) {
        return { value: parsed as Record<string, unknown>, changes: ["strip trailing commas", "JSON.parse"] };
      }
    } catch {}
  }

  // Step e: double-encoded JSON
  try {
    const firstParse = JSON.parse(raw);
    if (typeof firstParse === "string") {
      try {
        const parsed = JSON.parse(firstParse);
        if (isPlainObject(parsed)) {
          return { value: parsed as Record<string, unknown>, changes: ["double-encoded JSON", "JSON.parse"] };
        }
      } catch {}
    }
  } catch {}

  return null;
}

export function repairArgsPayload(rawArgs: unknown): ArgUnwrapResult | undefined {
  // Rule 1: rawArgs is a plain object → check for wrapper unwrap or already usable
  if (isPlainObject(rawArgs)) {
    const argsObj = rawArgs as Record<string, unknown>;
    const keys = Object.keys(argsObj);

    // Wrapper unwrap — EXACTLY ONE key that is a recognized wrapper name
    if (keys.length === 1 && isWrapperKey(keys[0]) && isPlainObject(argsObj[keys[0]])) {
      return {
        args: argsObj[keys[0]] as Record<string, unknown>,
        changes: ["Unwrapped one-level arguments envelope"],
      };
    }

    // Already a usable plain object → return undefined (per spec)
    return undefined;
  }

  // Rule 2: rawArgs is a string → try repair stages in order
  if (typeof rawArgs === "string") {
    const result = parseWithRecovery(rawArgs);
    if (result && isPlainObject(result.value)) {
      return {
        args: result.value,
        changes: [result.changes.join(", ")],
      };
    }
  }

  // Rule 3: Any other type → undefined
  return undefined;
}
