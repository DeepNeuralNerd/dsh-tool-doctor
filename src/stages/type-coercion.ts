/**
 * Stage 11 — schema-aware argument repair (ARGS_TYPE). Rule 9, family 1.
 *
 * Models frequently emit the right value in the wrong JSON type: a number as
 * `"42"`, a boolean as `"true"`, an array as an escaped JSON string `"[1,2]"`
 * or a comma-joined `"a,b"`, and `"null"`/`"undefined"` where the field wants
 * a value or an omission. This pre-dispatch stage coerces those back to the
 * declared type ONLY when the whole value parses unambiguously to it (the
 * LiteLLM `"123"` lesson: never re-parse a string that was already valid).
 *
 * @module dsh-tool-doctor/stages/type-coercion
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import { coerceArgTypes } from "../repair/type-coercion.ts";

export const typeCoercionStage: PreStage = {
  phase: "pre",
  id: "type-coercion",
  label: "Schema-aware type coercion (ARGS_TYPE)",
  ruleNumber: 9,
  enabledBy: "autoSchemaArgs",
  category: "ARGS_TYPE",
  roundTrips: 1,
  matchesError: (code, text) =>
    code === "INVALID_ARGS" ||
    /expected (?:a |an )?(?:number|boolean|array|string)|must be (?:a |an )?(?:number|boolean|array)|invalid (?:type|value)/i.test(
      text ?? "",
    ),
  run(toolName, args, env: StageEnv): StageOutcome | undefined {
    if (!env.config.autoSchemaArgs) return undefined;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
    const coerced = coerceArgTypes(toolName, args, env.tools?.get(toolName));
    if (coerced === undefined) return undefined;
    return {
      args: coerced.args,
      changes: coerced.changes,
      category: "ARGS_TYPE",
    };
  },
};
