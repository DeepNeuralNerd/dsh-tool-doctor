/**
 * Range and index normalization for editor and paging tools.
 *
 * Three distinct repairs, one module:
 *  - view_range flip fix: when [start, end] has both finite numbers, end !== -1,
 *    and end < start → swap them (models emit a flipped pair).
 *  - view_range clamping for editor tools (1-based floor, end >= start,
 *    optional ceiling from a known line count; `-1` means "to end" on
 *    str_replace_editor only).
 *  - Off-by-one index fixes (`offset: 0` → `1`, `limit: 0` → `1`) for the
 *    read/glob/grep family, which reject zero-based indices.
 *
 * Relative-path resolution applies to `str_replace_editor` alone — it rejects
 * relative paths outright. The edit/read/write family resolves relatives
 * against the session workspace itself, so rewriting them here would duplicate
 * host logic with a host-local resolve that is wrong for remote worlds.
 *
 * @module dsh-tool-doctor/repair/range-clamper
 */

import { isAbsolute, resolve } from "node:path";

/**
 * Normalize editor arguments: optional relative-path resolution plus
 * structurally valid `view_range`. The line count is used by the retry path
 * after a real host response reports file length; pre-dispatch cannot know it.
 *
 * @param toolName - Editor tool name.
 * @param rawArgs - Raw model arguments.
 * @param cwd - Resolution root for relative paths.
 * @param maxLines - Known file line count, when available.
 * @param resolveRelativePaths - Resolve relative paths against `cwd`.
 */
export function normalizeEditorArguments(
  toolName: string,
  rawArgs: unknown,
  cwd: string = process.cwd(),
  maxLines?: number,
  resolveRelativePaths = true,
): Record<string, unknown> {
  if (!rawArgs || typeof rawArgs !== "object") return {};

  const args: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };

  // Normalize path / file_path / TargetFile.
  const pathKey = (["path", "file_path", "TargetFile"] as const).find(
    (key) => typeof args[key] === "string",
  );
  if (resolveRelativePaths && pathKey !== undefined) {
    const rawPath = String(args[pathKey]).trim();
    if (rawPath.length > 0 && !isAbsolute(rawPath)) {
      args[pathKey] = resolve(cwd, rawPath);
    }
  }

  // Normalize view_range when present and numeric.
  const range = args["view_range"];
  if (Array.isArray(range) && range.length === 2) {
    const [start, end] = range;
    if (typeof start === "number" && Number.isFinite(start) &&
        typeof end === "number" && Number.isFinite(end)) {
      // Models emit a flipped pair: [start, end] with end !== -1 and end < start
      // means the intended span is [end, start] — swap before clamping so the
      // ordinary 1-based floor and line-count ceiling still apply.
      const flipped = end !== -1 && end < start;
      const pairStart = flipped ? end : start;
      const pairEnd = flipped ? start : end;
      let validStart = Math.max(1, Math.floor(pairStart));
      const isToEnd = toolName === "str_replace_editor" && pairEnd === -1;
      let validEnd = isToEnd ? -1 : Math.max(validStart, Math.floor(pairEnd));
      if (maxLines !== undefined && Number.isSafeInteger(maxLines) && maxLines > 0) {
        validStart = Math.min(validStart, maxLines);
        validEnd = isToEnd ? -1 : Math.min(validEnd, maxLines);
        if (!isToEnd) validEnd = Math.max(validStart, validEnd);
      }
      args["view_range"] = [validStart, validEnd];
    }
  }

  return args;
}

/** Tools whose offset/limit/start parameters are 1-based. */
const OFFSET_TOOLS: ReadonlySet<string> = new Set(["read", "glob", "grep"]);

/**
 * Clamp zero/negative index parameters to the tool-required minimum of 1.
 * @param toolName - The dispatched tool name.
 * @param rawArgs - Raw model arguments.
 * @returns A corrected copy when something changed, else undefined (no-op).
 */
export function normalizeReadArguments(
  toolName: string,
  rawArgs: unknown,
): Record<string, unknown> | undefined {
  if (!rawArgs || typeof rawArgs !== "object") return undefined;
  if (!OFFSET_TOOLS.has(toolName)) return undefined;

  const args: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };
  let changed = false;

  // Clamp offset / start (offset wins when both are present).
  const offsetKey = "offset" in args ? "offset" : "start" in args ? "start" : undefined;
  if (offsetKey !== undefined) {
    const value = args[offsetKey];
    if (typeof value === "number" && Number.isFinite(value)) {
      const clamped = Math.max(1, Math.floor(value));
      if (clamped !== value) {
        args[offsetKey] = clamped;
        changed = true;
      }
    }
  }

  // Clamp limit to the minimum of 1.
  if ("limit" in args) {
    const value = args["limit"];
    if (typeof value === "number" && Number.isFinite(value)) {
      const clamped = Math.max(1, Math.floor(value));
      if (clamped !== value) {
        args["limit"] = clamped;
        changed = true;
      }
    }
  }

  return changed ? args : undefined;
}
