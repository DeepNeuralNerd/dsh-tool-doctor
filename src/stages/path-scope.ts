/**
 * Stage 4 — workspace path scope (PATH_SCOPE).
 *
 * Mnemon document tools reject the whole call when any `sourcePaths` entry
 * lives outside the session workspace. The field is an optional annotation, so
 * pruning out-of-scope entries turns a hard validation failure into a
 * successful document with honest, slightly narrower provenance. Requires the
 * session cwd; without it the stage stays off (never guesses a root).
 *
 * @module dsh-tool-doctor/stages/path-scope
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import { pruneWorkspaceSourcePaths } from "../repair/source-path-scope.ts";

export const pathScopeStage: PreStage = {
  phase: "pre",
  id: "path-scope",
  label: "Workspace path scope (PATH_SCOPE)",
  ruleNumber: 3,
  category: "PATH_SCOPE",
  roundTrips: 1,
  matchesError: (_code, text) =>
    /stay inside the workspace|source path|sourcePaths/i.test(text ?? ""),
  run(toolName, args, env): StageOutcome | undefined {
    if (!env.config.autoClampRanges) return undefined;
    const pruned = pruneWorkspaceSourcePaths(toolName, args, env.cwd());
    if (pruned === undefined) return undefined;
    return {
      args: pruned,
      changes: ["Dropped sourcePaths outside the workspace"],
      category: "PATH_SCOPE",
    };
  },
};
