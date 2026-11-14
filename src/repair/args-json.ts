/**
 * Structural argument repair for the ARGS_UNWRAP rule (rule 9, family 2).
 *
 * Two shapes, one module:
 *  - A plain-object envelope with a single recognized wrapper key
 *    (`arguments`/`args`/`input`/…) is unwrapped one level.
 *  - A STRING payload is recovered through ordered stages (plain parse,
 *    markdown-fence strip, prose slice, trailing-comma strip, double-decode);
 *    the rewrite is adopted only when the final parse yields a plain object.
 *  - Ambiguity guard (RFC 8259 §4, reviewer pass 2026-11-14): a payload whose
 *    JSON text repeats a member name at any object level is NEVER adopted —
 *    JSON.parse resolves duplicates silently (last value wins), which for tool
 *    arguments means a possibly different target than the model intended.
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

/**
 * RFC 8259 §4: member names within an object SHOULD be unique — but JSON.parse
 * resolves a duplicate silently (last value wins). For tool arguments that is
 * a silent target swap: {"file_path":"safe.txt","file_path":"other.txt"} reads
 * the second file while the model may have meant the first. Doctor never
 * adopts a string payload whose JSON text carries a duplicate member name at
 * any object level; such payloads pass through unrepaired.
 *
 * Scanner contract: runs only on text that just strict-parsed, so it may
 * assume well-formed JSON. Strings are skipped wholesale (escape-respecting);
 * a string inside an OBJECT scope counts as a member name iff the next
 * non-whitespace character is ':'. Raw-name comparison is conservative — two
 * differently-escaped spellings of one name are a MISSED duplicate, never a
 * false alarm. Exported for reuse by the type-coercion $ref path (same RFC
 * 8259 bar on any adopted JSON text).
 */
export function hasDuplicateMemberNames(input: string): boolean {
  const scopes: Array<Set<string>> = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < n) {
        const c = input[j];
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') break;
        j++;
      }
      const scope = scopes[scopes.length - 1];
      if (scope) {
        let k = j + 1;
        while (k < n && /\s/.test(input[k])) k++;
        if (input[k] === ":") {
          const raw = input.slice(i, j + 1);
          if (scope.has(raw)) return true;
          scope.add(raw);
        }
      }
      i = j + 1;
      continue;
    }
    if (ch === "{" || ch === "[") scopes.push(new Set());
    else if (ch === "}" || ch === "]") scopes.pop();
    i++;
  }
  return false;
}

/** Strict parse → plain object, AND unambiguous (no duplicate member names). */
function parseUnambiguousObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return null;
    if (hasDuplicateMemberNames(text)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseWithRecovery(raw: string): { value: Record<string, unknown>; changes: string[] } | null {
  // Step a: plain JSON.parse (adopted only when unambiguous)
  const plain = parseUnambiguousObject(raw);
  if (plain) {
    return { value: plain, changes: ["plain JSON.parse"] };
  }

  // Step b: strip markdown fences then parse
  const withFencesStripped = stripMarkdownFences(raw);
  if (withFencesStripped !== undefined) {
    const parsed = parseUnambiguousObject(withFencesStripped);
    if (parsed) {
      return { value: parsed, changes: ["strip markdown fences", "JSON.parse"] };
    }
  }

  // Step c: slice from first "{" to last "}" then parse
  const withProseStripped = extractJsonObjectFromProse(raw);
  if (withProseStripped !== undefined) {
    const parsed = parseUnambiguousObject(withProseStripped);
    if (parsed) {
      return { value: parsed, changes: ["extract from prose", "JSON.parse"] };
    }
  }

  // Step d: remove trailing commas then parse
  const withTrailingCommasStripped = stripTrailingCommas(raw);
  if (withTrailingCommasStripped !== raw) {
    const parsed = parseUnambiguousObject(withTrailingCommasStripped);
    if (parsed) {
      return { value: parsed, changes: ["strip trailing commas", "JSON.parse"] };
    }
  }

  // Step e: double-encoded JSON
  try {
    const firstParse = JSON.parse(raw);
    if (typeof firstParse === "string") {
      const parsed = parseUnambiguousObject(firstParse);
      if (parsed) {
        return { value: parsed, changes: ["double-encoded JSON", "JSON.parse"] };
      }
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
