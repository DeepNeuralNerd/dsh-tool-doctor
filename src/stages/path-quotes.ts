/**
 * Stage 5 — quoted path unwrap (PATH_QUOTES).
 *
 * Some models emit path arguments with a literal wrapping quote pair
 * (`"C:\dir\f.txt"` inside the JSON string), which fails as not-found or gets
 * joined onto the session cwd. The repair strips one matched outer pair of
 * identical quotes — and only when the inner text is an absolute path, so a
 * false heal can never cost a second failed call. Content fields are never
 * touched; see src/repair/path-arg-quotes.ts for the full scope discipline.
 *
 * @module dsh-tool-doctor/stages/path-quotes
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import { dequotePathArgs } from "../repair/path-arg-quotes.ts";

export const pathQuotesStage: PreStage = {
  phase: "pre",
  id: "path-quotes",
  label: "Quoted path unwrap (PATH_QUOTES)",
  ruleNumber: 3,
  category: "PATH_QUOTES",
  roundTrips: 1,
  matchesError: (_code, text) => /not found|cannot read|does not exist/i.test(text ?? ""),
  run(toolName, args, env): StageOutcome | undefined {
    if (!env.config.autoClampRanges) return undefined;
    const dequoted = dequotePathArgs(toolName, args);
    if (dequoted === undefined) return undefined;
    return { args: dequoted, changes: ["Stripped wrapping quotes from a path"] };
  },
};
