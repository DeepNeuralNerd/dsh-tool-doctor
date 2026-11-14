/**
 * Stage 13 — path normalization (PATH_SEPARATORS). Rule 3, path family.
 *
 * Complements the existing path-scope/quotes rules with the two remaining
 * path-shape failures from the field research:
 *  - Windows separator drift (`C:\dir\file` handed to a forward-slash tool, or
 *    the reverse) — canonicalized to the host's native form, and
 *  - an unexpanded `~` home prefix.
 * On Windows the backslash→slash rewrite is lossless (backslash is not a legal
 * filename character); on POSIX the rewrite is applied only for the `~` prefix,
 * never a blind separator swap. Pure pre-dispatch normalization — no I/O.
 *
 * @module dsh-tool-doctor/stages/path-normalizer
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import { normalizePathShapes } from "../repair/path-normalize.ts";

export const pathNormalizerStage: PreStage = {
  phase: "pre",
  id: "path-normalizer",
  label: "Path separator & tilde normalization (PATH_SEPARATORS)",
  ruleNumber: 3,
  enabledBy: "autoNormalizePaths",
  category: "PATH_SEPARATORS",
  roundTrips: 1,
  matchesError: (code, text) =>
    code === "INVALID_ARGS" || /no such file|path|separator|~\b/i.test(text ?? ""),
  run(toolName, args, env: StageEnv): StageOutcome | undefined {
    if (!env.config.autoNormalizePaths) return undefined;
    const normalized = normalizePathShapes(toolName, args, env.cwd());
    if (normalized === undefined) return undefined;
    return {
      args: normalized.args,
      changes: normalized.changes,
      category: "PATH_SEPARATORS",
    };
  },
};
