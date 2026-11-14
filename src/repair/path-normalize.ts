/**
 * Path-shape normalization for the PATH_SEPARATORS rule (rule 3, path family).
 *
 * Two lossless rewrites, no I/O:
 *  - Tilde expansion: a leading `~` (or `~/` / `~\`) expands to os.homedir()
 *    (remainder in native separators) — but only when the session cwd IS or
 *    sits UNDER that home, positive evidence the session shares it. Any
 *    other session world (remote same-OS included, cwd unknown included)
 *    keeps its `~`: the plugin machine's home would be the wrong answer.
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

/** Is `candidate` equal to, or below, `base` as a path (separator boundary, not a string prefix)? */
function pathWithin(base: string, candidate: string, caseInsensitive: boolean): boolean {
  let b = base.replace(/[\\/]+$/, "");
  let c = candidate;
  if (caseInsensitive) {
    b = b.toLowerCase().replace(/\//g, "\\");
    c = c.toLowerCase().replace(/\//g, "\\");
  }
  if (c === b) return true;
  if (!c.startsWith(b)) return false;
  const next = c[b.length];
  return next === "\\" || next === "/";
}

/**
 * The home directory to expand `~` against — but only on POSITIVE evidence
 * that the session can resolve it: the session cwd must be the home itself
 * or sit below it. A same-OS REMOTE session (cwd `/home/other/work`, or on
 * another machine entirely) shares nothing with this process's home, so the
 * session's home is unknown and `~` must stay untouched — the tool, running
 * in the session world, resolves or rejects it honestly. Matching path
 * STYLE was the first bar (cross-platform case); living under the home is
 * the evidence that actually implies a shared home directory.
 */
function trustedHome(cwd: string | undefined, isWindowsHost: boolean): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined;
  let home: string;
  try {
    home = os.homedir();
  } catch {
    return undefined;
  }
  if (typeof home !== "string" || home.length === 0) return undefined;
  const homeIsWindows = /^[a-zA-Z]:[\\/]/.test(home) || home.startsWith("\\\\");
  // Style mismatch can never sit within the home, but check it first so a
  // POSIX cwd is never prefix-compared against a Windows home.
  if (homeIsWindows !== isWindowsHost) return undefined;
  return pathWithin(home, cwd, homeIsWindows) ? home : undefined;
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
      // Tilde expansion — only over a home trusted for this session world
      // (see trustedHome); otherwise the value passes through unchanged.
      const home = trustedHome(cwd, isWindowsHost);
      if (home !== undefined) {
        const rest = nativeSeparators(out.slice(1), isWindowsHost);
        out = `${home}${rest}`;
        label = CHANGE_TILDE;
      }
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
