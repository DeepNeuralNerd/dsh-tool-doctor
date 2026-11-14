/**
 * Whitespace-equivalent anchor variants for the EDIT_WHITESPACE rule (rule 4).
 *
 * The largest recurring edit-failure complaint in the wild: `old_string`
 * matches the model's memory of the file but not its bytes — the file uses
 * CRLF while the anchor uses LF (or the reverse), or tabs where the anchor
 * re-indented with spaces. This module generates the small, deterministic set
 * of whitespace-equivalent variants of an anchor; the retry stage dispatches
 * them and lets the HOST adjudicate (a variant matching multiple times is
 * rejected by the host's own ambiguity guard — we never guess).
 *
 * @module dsh-tool-doctor/repair/whitespace-anchor
 */

/**
 * Generate whitespace-equivalent variants of an `old_string` anchor, most
 * likely first, capped and excluding the original. Rules:
 *  1. Line-ending flip: contains `\r\n` → all become `\n`; else contains
 *     `\n` → all become `\r\n`.
 *  2. Indentation flip on the anchor's OWNED leading whitespace per line:
 *     every line's leading run of tabs → four spaces per tab; else every
 *     line's leading run of spaces (multiple of 4) → one tab per 4 spaces.
 * A variant is skipped when it equals the original or the anchor is a
 * single line without leading whitespace (nothing to flip).
 */
export function editAnchorVariants(needle: string): string[] {
  // SCAFFOLD STUB — real implementation + tests delivered by the
  // whitespace-edit work package. Inert here: no variants, no retry.
  void needle;
  return [];
}
