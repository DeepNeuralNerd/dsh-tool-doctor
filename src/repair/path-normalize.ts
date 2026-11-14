/**
 * Path-shape normalization for the PATH_SEPARATORS rule (rule 3, path family).
 *
 * Two lossless rewrites, no I/O:
 *  - Windows separator drift: a path using `\` separators dispatched on a
 *    host whose native separator is `/` (WSL/POSIX tool servers over a Windows
 *    model) becomes `/`-separated; backslash is not legal in POSIX filenames,
 *    so the rewrite cannot change meaning. Never swap on Windows.
 *  - Tilde expansion: a leading `~` (or `~\` / `~/`) expands to the home
 *    directory the host expects, using the provided resolveBase's drive root
 *    on Windows or os.homedir() otherwise.
 * Only recognized path parameters are touched (path/file_path/file/TargetFile).
 *
 * @module dsh-tool-doctor/repair/path-normalize
 */

/** Outcome of a successful path-shape normalization. */
export interface PathShapeResult {
  args: Record<string, unknown>;
  changes: string[];
}

/**
 * Normalize separator style and `~` prefixes in path arguments.
 * @param toolName - The dispatched tool name.
 * @param rawArgs - Raw model arguments.
 * @param cwd - Session working directory (host-native form; hints the OS).
 * @returns A corrected copy when something changed, else undefined (no-op).
 */
export function normalizePathShapes(
  _toolName: string,
  _rawArgs: unknown,
  _cwd: string | undefined,
): PathShapeResult | undefined {
  // SCAFFOLD STUB — real implementation + tests delivered by the path-corrections
  // work package. Inert here: every call passes through untouched.
  return undefined;
}
