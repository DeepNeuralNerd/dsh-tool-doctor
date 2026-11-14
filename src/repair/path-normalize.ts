/**
 * Path-shape normalization for the PATH_SEPARATORS rule (rule 3, path family).
 *
 * Two lossless rewrites, no I/O:
 *  - Tilde expansion: a leading `~` (or `~/` / `~\`) expands to os.homedir(),
 *    with the remainder converted to the host's native separators.
 *  - Separator normalization: on a POSIX session only, backslashes in a path
 *    value are rewritten to "/" (backslash drift from a Windows-trained model
 *    is the common case; POSIX filenames virtually never contain one).
 *
 * Host style follows the SESSION world, not the plugin process: the session
 * cwd is the authority (a DSH harness may drive a tool world of the other
 * platform); process.platform is consulted only as a fallback without a cwd.
 * On Windows separators are never rewritten (backslash is already native).
 * Only recognized path parameters at the TOP LEVEL are touched; the caller's
 * arguments object is never mutated.
 *
 * @module dsh-tool-doctor/repair/path-normalize
 */

import os from "node:os";

/** Outcome of a successful path-shape normalization. */
export interface PathShapeResult {
  args: Record<string, unknown>;
  changes: string[];
}

const PATH_PARAM_KEYS = ["path", "file_path", "file", "TargetFile", "target_file"] as const;

const CHANGE_TILDE = "expanded ~ to home directory";
const CHANGE_SEPARATORS = "normalized path separators to host style";

/** Does the session world use backslash separators? Cwd is the authority. */
function hostPrefersBackslash(cwd: string | undefined): boolean {
  if (cwd !== undefined && cwd.length > 0) {
    return /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\") || cwd.includes("\\");
  }
  return process.platform === "win32";
}

/** Convert a path remainder to the host's native separator style. */
function nativeSeparators(rest: string, isWindowsHost: boolean): string {
  return isWindowsHost ? rest.replace(/\//g, "\\") : rest.replace(/\\/g, "/");
}

/**
 * Normalize separator style and `~` prefixes in path arguments.
 * @param toolName - The dispatched tool name (reserved; shape rules are tool-agnostic).
 * @param rawArgs - Raw model arguments.
 * @param cwd - Session working directory — authoritative host-style hint.
 * @returns A corrected copy when something changed, else undefined (no-op).
 */
export function normalizePathShapes(
  _toolName: string,
  rawArgs: unknown,
  cwd: string | undefined,
): PathShapeResult | undefined {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return undefined;

  const isWindowsHost = hostPrefersBackslash(cwd);
  const args: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };
  const changes: string[] = [];
  let changed = false;

  for (const key of PATH_PARAM_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || value.length === 0) continue;

    let out = value;
    let label: string | undefined;

    if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
      // Tilde expansion; the remainder joins the home directory in native form.
      const rest = nativeSeparators(out.slice(1), isWindowsHost);
      out = `${os.homedir()}${rest}`;
      label = CHANGE_TILDE;
    } else if (!isWindowsHost && out.includes("\\")) {
      // POSIX session: backslashes in a path are separator drift.
      out = out.replace(/\\/g, "/");
      label = CHANGE_SEPARATORS;
    }

    if (label !== undefined && out !== value) {
      args[key] = out;
      changed = true;
      if (!changes.includes(label)) changes.push(label);
    }
  }

  return changed ? { args, changes } : undefined;
}
