/**
 * Stage 12 — structural argument unwrap (ARGS_TYPE). Rule 9, family 2.
 *
 * Two shapes the host's own parser rejects but a gateway sees constantly:
 *  - the whole `arguments` payload arrives double-encoded (a JSON string of a
 *    JSON string), and
 *  - the payload is wrapped one level too deep: `{"arguments":{…}}` or
 *    `{"tool":…,"args":{…}}` when the tool wants the inner object directly.
 * Unwrapping is lossless and verified by re-parse; ambiguous shapes are left
 * untouched. Runs before type coercion so coerced values see the real object.
 *
 * @module dsh-tool-doctor/stages/arg-unwrap
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import { repairArgsPayload } from "../repair/args-json.ts";

export const argUnwrapStage: PreStage = {
  phase: "pre",
  id: "arg-unwrap",
  label: "Double-encoded / wrapped arguments unwrap (ARGS_UNWRAP)",
  ruleNumber: 9,
  enabledBy: "autoSchemaArgs",
  category: "ARGS_UNWRAP",
  roundTrips: 1,
  matchesError: (code, text) =>
    code === "INVALID_ARGS" || /expected object|should be a json object|input should be/i.test(text ?? ""),
  run(_toolName, args, env: StageEnv): StageOutcome | undefined {
    if (!env.config.autoSchemaArgs) return undefined;
    const repaired = repairArgsPayload(args);
    if (repaired === undefined) return undefined;
    return {
      args: repaired.args,
      changes: repaired.changes,
      category: "ARGS_UNWRAP",
    };
  },
};
