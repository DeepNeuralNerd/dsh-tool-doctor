/**
 * Tool-name canonicalization — the TOOL_NAME rule (rule 2 family: routing).
 *
 * Models drift on tool NAMES, not only values: they lose case ("Read" for
 * "read") or drop/swap an MCP-style namespace separator ("bash" for
 * "mcp__shell__bash", "mcp__shell__bash" for "bash"). A name may be
 * corrected ONLY when the registered plane yields exactly one candidate —
 * two candidates would make this helper a guesser, so it stays silent.
 *
 * Match rules (all comparisons on lowercased strings, in this order):
 *  1. Case-insensitive exact match: candidate === called.
 *     Adopted immediately (nothing else can outrank it).
 *  2. Separator-affix match: the candidate ENDS WITH a separator plus the
 *     called name, or the called name ends with a separator plus the
 *     candidate — separators are "__", "_", ":", "." (checked longest-first
 *     so "__" beats its "_" prefix). A correction is returned only when
 *     EXACTLY ONE distinct candidate matches; zero or many → undefined.
 *  - A match equal to `called` itself is not a correction → undefined.
 *  - Empty/whitespace `called` or no registered names → undefined.
 *  - Never dispatches, never throws, no I/O — pure string logic.
 *
 * @module dsh-tool-doctor/repair/tool-name
 */

/** Separator affixes, longest first so "__" is checked before "_". */
const AFFIXES = ["__", ":", ".", "_"] as const;

/**
 * The canonical registered name for a mis-named tool call, or undefined
 * when no unique correction exists.
 *
 * @param called - The name the model actually used.
 * @param registeredNames - Names callable in the call's scope (from the
 *   host `tools.schemas()` enumeration; the stage filters to that list).
 */
export function canonicalToolName(
  called: string,
  registeredNames: readonly string[],
): string | undefined {
  const needle = called.trim().toLowerCase();
  if (needle === "" || registeredNames.length === 0) return undefined;

  // Rule 1: a case-insensitive exact match always wins.
  for (const candidate of registeredNames) {
    if (candidate.toLowerCase() === needle && candidate !== called) return candidate;
  }

  // Rule 2: exactly one affix-related candidate may be adopted.
  let found: string | undefined;
  let ambiguous = false;
  for (const candidate of registeredNames) {
    const hay = candidate.toLowerCase();
    if (hay === needle || candidate === called) continue;
    const related = AFFIXES.some(
      (sep) => hay.endsWith(sep + needle) || needle.endsWith(sep + hay),
    );
    if (!related) continue;
    if (found !== undefined && found !== candidate) {
      ambiguous = true;
      break;
    }
    found = candidate;
  }
  return ambiguous ? undefined : found;
}
