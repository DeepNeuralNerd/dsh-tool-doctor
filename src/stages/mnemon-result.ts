/**
 * Stage 6 — mnemon result schema repair (MNEMON_RESULT).
 *
 * `mnemon_subagent_result` validates a per-request inner `result` schema, and
 * models keep expressing required fields under sibling names: a suggestion's
 * single `text` string where an array of step strings is expected, or work
 * reported as `steps`/`summary` with the top-level `answer` left empty. The
 * repair only moves content that already exists into the demanded shape — it
 * never invents text; see src/repair/mnemon-result-schema.ts for the exact
 * fills and their change labels.
 *
 * @module dsh-tool-doctor/stages/mnemon-result
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import { repairMnemonResultArgs } from "../repair/mnemon-result-schema.ts";

export const mnemonResultStage: PreStage = {
  phase: "pre",
  id: "mnemon-result",
  label: "mnemon result schema repair (MNEMON_RESULT)",
  ruleNumber: 1,
  category: "MNEMON_RESULT",
  roundTrips: 1,
  matchesError: (code, text) =>
    code === "INVALID_ARGS" || /is required|required property|must be an array/i.test(text ?? ""),
  run(toolName, args, env): StageOutcome | undefined {
    if (!env.config.autoClampRanges) return undefined;
    const repaired = repairMnemonResultArgs(toolName, args);
    if (repaired === undefined) return undefined;
    return repaired;
  },
};
