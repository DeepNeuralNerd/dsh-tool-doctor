/**
 * Stage 17 — canonical parameter rename (PARAM_ALIAS). Rule 9 family.
 *
 * Models sometimes emit a well-known parameter under an invented name
 * (`filename` for `file_path`, `regex` for `pattern`); the host's schema
 * validation rejects the call outright. This stage renames a single
 * unambiguous alias to the canonical name — confirmed against the tool's
 * own schema — before dispatch. Ambiguity abstains; see
 * src/repair/param-alias.ts for the full scope discipline.
 *
 * Shares the `autoSchemaArgs` flag and rule-9 card with the other
 * schema-aware repairs (unwrap, type coercion): all three read a tool's own
 * schema to reshape arguments, so one toggle governs the family.
 *
 * @module dsh-tool-doctor/stages/param-alias
 */

import type { PreStage, StageOutcome } from "../core/stage.ts";
import { renameAliasArgs } from "../repair/param-alias.ts";

export const paramAliasStage: PreStage = {
  phase: "pre",
  id: "param-alias",
  label: "Canonical parameter rename (PARAM_ALIAS)",
  ruleNumber: 9,
  enabledBy: "autoSchemaArgs",
  category: "PARAM_ALIAS",
  roundTrips: 1,
  matchesError: (_code, text) =>
    /required|unexpected|unrecognized|invalid arguments|property/i.test(text ?? ""),
  run(toolName, args, env): StageOutcome | undefined {
    if (!env.config.autoSchemaArgs) return undefined;
    const renamed = renameAliasArgs(toolName, args, env.tools?.get(toolName));
    if (renamed === undefined) return undefined;
    return { args: renamed.args, changes: renamed.changes, category: "PARAM_ALIAS" };
  },
};
