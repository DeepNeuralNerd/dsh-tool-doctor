/**
 * Workspace-scoped reference-path pruning.
 *
 * Mnemon document tools validate `sourcePaths` against the session workspace
 * and reject the whole call when any reference lives outside it (e.g. a skill
 * directory under the user's home). `sourcePaths` is an optional annotation:
 * a rejected call loses the document, while a dropped reference only trims
 * metadata. Pruning out-of-scope entries before dispatch turns a hard
 * validation failure into a successful document with honest, slightly
 * narrower provenance.
 *
 * @module dsh-tool-doctor/repair/source-path-scope
 */

import { resolve, sep } from "node:path";

/** Tools whose `sourcePaths` field is workspace-validated by the host. */
const SCOPE_TOOLS: ReadonlySet<string> = new Set([
  "mnemon_document_create",
  "mnemon_document_manage",
]);

/**
 * Drop `sourcePaths` entries the host would reject for living outside the
 * session workspace; remove the property entirely when nothing survives.
 * @param toolName - The dispatched tool name.
 * @param rawArgs - Raw model arguments.
 * @param workspace - Session workspace root; undefined disables the repair.
 * @returns A pruned copy, or undefined when nothing changed (no-op).
 */
export function pruneWorkspaceSourcePaths(
  toolName: string,
  rawArgs: unknown,
  workspace?: string,
): Record<string, unknown> | undefined {
  if (workspace === undefined || workspace.trim().length === 0) return undefined;
  if (!SCOPE_TOOLS.has(toolName)) return undefined;
  if (!rawArgs || typeof rawArgs !== "object") return undefined;

  const args: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };
  if (!Array.isArray(args["sourcePaths"])) return undefined;

  const root = resolve(workspace);
  const loweredRoot = root.toLowerCase();
  const kept: unknown[] = [];
  let dropped = 0;
  for (const entry of args["sourcePaths"] as unknown[]) {
    if (typeof entry === "string" && isInsideWorkspace(entry, root, loweredRoot)) {
      kept.push(entry);
    } else {
      dropped += 1;
    }
  }
  if (dropped === 0) return undefined;

  args["sourcePaths"] = kept.length > 0 ? kept : undefined;
  if (kept.length === 0) delete args["sourcePaths"];
  return args;
}

/**
 * Case-insensitive containment check: Windows workspaces are case-insensitive,
 * and lowercasing is harmless on case-sensitive platforms. Relative entries
 * resolve against the workspace, matching how the tools interpret them.
 */
function isInsideWorkspace(
  entry: string,
  root: string,
  loweredRoot: string,
): boolean {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return false;
  const lowered = resolve(root, trimmed).toLowerCase();
  return (
    lowered === loweredRoot ||
    lowered.startsWith(loweredRoot + sep.toLowerCase())
  );
}
