/**
 * Unwrapping of quote-wrapped path arguments.
 *
 * Candidate evidence (tool-healer history, 2026-11-10): a `read` call carried
 * a `file_path` whose value was itself quote-wrapped — JSON
 * `"\"C:\\dir\\f.txt\""` — so the tool received literal quote characters and
 * failed with `cannot read "\"C:\dir\f.txt\"": not found`, or worse, the
 * quoting made the value look relative and the host joined it onto the session
 * cwd. This is an argument-emission artifact of some models, not user intent:
 * no file name on Windows starts or ends with a quote character, so stripping
 * one matched pair of wrapping quotes is semantics-preserving whenever the
 * inner text is an absolute path.
 *
 * Scope discipline:
 *  - Only PATH-shaped parameters (`file_path`, `path`) on file and image-read
 *    tools are touched; content fields may legitimately contain edge quotes and
 *    are never rewritten. Image readers joined the set on 2026-11-14 after the
 *    candidate ledger recorded a quote-wrapped `read_image` path passing
 *    through unrepaired — same emission artifact, same strict gate.
 *  - Only one outer pair of IDENTICAL quote characters (double, single or
 *    backtick) is stripped, and only when the unwrapped text is an absolute
 *    path (drive letter, UNC, or unix root). Anything else passes through — a
 *    false heal costs a second failed call, so the gate stays strict.
 *  - Returns a shallow copy when something changed, undefined otherwise.
 *
 * @module dsh-tool-doctor/repair/path-arg-quotes
 */

/** File tools whose path parameters take a plain absolute-path string. */
const PATH_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "read_image",
  "modlens_read_image",
]);

/** Parameter names on those tools that are file/directory paths. */
const PATH_PARAMS = ["file_path", "path"] as const;

/** Absolute-path shapes: C:\ or C:/, \\UNC, or unix root. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** One pair of identical wrapping quotes with optional outer whitespace. */
const WRAPPED = /^\s*(["'`])(.*?)\1\s*$/;

/**
 * Strip quote-wrapping from absolute-path arguments on file tools.
 * @param toolName - The dispatched tool name.
 * @param rawArgs - Raw model arguments.
 * @returns A corrected copy when a path argument was unwrapped, else undefined.
 */
export function dequotePathArgs(
  toolName: string,
  rawArgs: unknown,
): Record<string, unknown> | undefined {
  if (!PATH_TOOLS.has(toolName)) return undefined;
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return undefined;
  }

  const source = rawArgs as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  for (const param of PATH_PARAMS) {
    const value = source[param];
    if (typeof value !== "string") continue;
    const unwrapped = unwrapQuotedPath(value);
    if (unwrapped !== undefined) {
      copy ??= { ...source };
      copy[param] = unwrapped;
    }
  }
  return copy;
}

/**
 * The single heal: one matched outer quote pair whose inner text is an
 * absolute path. Empty inner text ("\"\"") is NOT unwrapped — an empty path
 * stays an explicit empty path.
 */
export function unwrapQuotedPath(value: string): string | undefined {
  const match = WRAPPED.exec(value);
  if (!match) return undefined;
  const inner = match[2] ?? "";
  if (inner.length === 0) return undefined;
  return ABSOLUTE_PATH.test(inner) ? inner : undefined;
}
